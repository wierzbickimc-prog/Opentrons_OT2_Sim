#!/usr/bin/env python3
"""Run an OT-2 protocol on Opentrons' engine against an emulated Smoothie.

Usage: worker.py PROTOCOL.py OUTPUT.json

This runs inside the simulator virtualenv built by scripts/setup_simulator.sh.
The protocol executes on the real Opentrons protocol engine and hardware
controller; only the motor controller and modules are emulated. Every serial
write (G-code) and every gantry/plunger move is recorded and attributed to the
protocol command that caused it.

The emulator startup follows g-code-testing/g_code_parsing/g_code_engine.py in
the Opentrons repository (Apache-2.0).
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from multiprocessing import Process
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import safety  # noqa: E402  (pure Python; shared with the unit tests)

SMOOTHIE_POLLING = {"M400", "M114.2", "G4"}
MODULE_POLLING = {"M105", "M119", "M141", "M123", "M115", "M241.D", "M242.D", "M243.D"}
SETUP_COMMANDS = {
    "loadLabware", "loadPipette", "loadModule", "loadLiquid", "loadLiquidClass",
    "defineLiquid", "loadLid", "loadLidStack",
}
PIPETTE_MOUNTS = ("left", "right")
# Engine axis names -> Smoothie axis letters used by the robot config limits.
SMOOTHIE_AXIS = {"Z_L": "Z", "Z_R": "A", "P_L": "B", "P_R": "C"}
MODULE_EMULATOR_TYPES = {
    "magneticModuleType": "magdeck",
    "temperatureModuleType": "tempdeck",
    "thermocyclerModuleType": "thermocycler",
    "heaterShakerModuleType": "heatershaker",
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def pipette_model_for(name: str) -> str:
    """Map a load name such as p20_multi_gen2 to the newest matching model."""
    from opentrons_shared_data import get_shared_data_root

    parts = name.split("_")
    volume, kind = parts[0], parts[1]
    major = 2 if name.endswith("_gen2") else 1
    channel_dir = {"single": "single_channel", "multi": "eight_channel"}[kind]
    root = get_shared_data_root() / "pipette" / "definitions" / "2" / "general" / channel_dir / volume
    versions = sorted(
        (tuple(int(v) for v in path.stem.split("_")) for path in root.glob(f"{major}_*.json")),
        reverse=True,
    )
    if not versions:
        raise ValueError(f"No OT-2 pipette definition found for {name}")
    return f"{volume}_{kind}_v{versions[0][0]}.{versions[0][1]}"


def run_analysis(protocol: Path) -> Dict[str, Any]:
    """Opentrons' own analysis: validates the protocol and lists the hardware it needs."""
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "analysis.json"
        completed = subprocess.run(
            [sys.executable, "-m", "opentrons.cli", "analyze", str(protocol), "--json-output", str(output)],
            capture_output=True, text=True, timeout=120,
        )
        if not output.exists():
            message = (completed.stderr or completed.stdout).strip().splitlines()
            raise ProtocolRejected(message[-1] if message else "Opentrons analysis failed.")
        return json.loads(output.read_text())


class ProtocolRejected(Exception):
    pass


def configure_emulator(analysis: Dict[str, Any]) -> List[str]:
    """Point every emulator at free localhost ports and attach the protocol's hardware.

    The hardware controller reads the same OT_EMULATOR_* variables, so this has
    to happen before any emulator Settings object is built.
    """
    pipettes = {p["mount"]: pipette_model_for(p["pipetteName"]) for p in analysis.get("pipettes", [])}
    smoothie: Dict[str, Any] = {"host": "127.0.0.1", "port": free_port()}
    for mount in PIPETTE_MOUNTS:
        model = pipettes.get(mount)
        smoothie[mount] = {"model": model or "", "id": f"SIM{mount[0].upper()}{abs(hash(model)) % 10**10:010d}" if model else ""}
    os.environ["OT_EMULATOR_SMOOTHIE"] = json.dumps(smoothie)
    os.environ["OT_EMULATOR_MODULE_SERVER"] = json.dumps({"host": "127.0.0.1", "port": free_port()})
    for proxy in ("heatershaker_proxy", "thermocycler_proxy", "temperature_proxy", "magdeck_proxy"):
        os.environ[f"OT_EMULATOR_{proxy.upper()}"] = json.dumps(
            {"host": "127.0.0.1", "emulator_port": free_port(), "driver_port": free_port()}
        )
    # Modules reach their targets immediately instead of in real time.
    fast = {"degrees_per_tick": 1000.0}
    os.environ["OT_EMULATOR_TEMPDECK"] = json.dumps(
        {"serial_number": "temperature_emulator", "model": "temp_deck_v20", "version": "v2.0.1", "temperature": {**fast, "starting": 23.0}}
    )
    os.environ["OT_EMULATOR_THERMOCYCLER"] = json.dumps(
        {"serial_number": "thermocycler_emulator", "model": "thermocyclerModuleV2", "version": "v1.1.0",
         "lid_temperature": {**fast, "starting": 23.0}, "plate_temperature": {**fast, "starting": 23.0}}
    )
    os.environ["OT_EMULATOR_HEATERSHAKER"] = json.dumps(
        {"serial_number": "heater_shaker_emulator", "model": "v01", "version": "v0.0.1",
         "temperature": {**fast, "starting": 23.0}, "rpm": {"rpm_per_tick": 100000.0, "starting": 0.0}, "home_delay_time": 0}
    )
    module_types = []
    for module in analysis.get("modules", []):
        definition_type = module.get("moduleType") or _module_type_from_model(module.get("model", ""))
        name = MODULE_EMULATOR_TYPES.get(definition_type)
        if name is None:
            raise ProtocolRejected(f"Module {module.get('model')} cannot be emulated.")
        if name in module_types:
            raise ProtocolRejected("The emulator supports one module of each type per protocol.")
        module_types.append(name)
    os.environ["OT_EMULATOR_MODULES"] = json.dumps(module_types)
    return module_types


def _module_type_from_model(model: str) -> str:
    lowered = model.lower()
    for key, name in (("magnetic", "magneticModuleType"), ("temperature", "temperatureModuleType"),
                      ("thermocycler", "thermocyclerModuleType"), ("heatershaker", "heaterShakerModuleType")):
        if key in lowered:
            return name
    return ""


def _run_emulators() -> None:
    from opentrons.hardware_control.emulation.scripts import run_app, run_smoothie
    from opentrons.hardware_control.emulation.settings import Settings

    settings = Settings()

    async def entry() -> None:
        await asyncio.gather(
            run_smoothie.run(settings),
            run_app.run(settings, modules=[m.value for m in settings.modules]),
        )

    asyncio.run(entry())


def _wait_for_emulators() -> None:
    from opentrons.hardware_control.emulation.module_server.helpers import ModuleStatusClient, wait_emulators
    from opentrons.hardware_control.emulation.settings import Settings

    settings = Settings()

    async def wait() -> None:
        client = await ModuleStatusClient.connect(host=settings.module_server.host, port=settings.module_server.port)
        await wait_emulators(client=client, modules=settings.modules, timeout=15)
        client.close()

    asyncio.run(wait())


class Recorder:
    """Collects G-code and moves while the protocol runs."""

    def __init__(self, engine: Any, port_devices: Dict[int, str]) -> None:
        self.engine = engine
        self.port_devices = port_devices
        self.gcode: List[Dict[str, Any]] = []
        self.moves: List[Dict[str, Any]] = []
        self.pipettes: Dict[str, Dict[str, Any]] = {}

    def running_command_id(self) -> Optional[str]:
        try:
            return self.engine.state_view.commands.get_running_command_id()
        except Exception:
            return None

    def record_serial(self, port: str, data: str, response: str) -> None:
        device = self.port_devices.get(int(port[port.rfind(":") + 1:]), "device")
        command_id = self.running_command_id()
        codes = split_gcode(data)
        for index, code in enumerate(codes):
            polling = code.split()[0] in (SMOOTHIE_POLLING if device == "smoothie" else MODULE_POLLING)
            if device != "smoothie" and polling and command_id is None:
                continue  # background module status polling
            self.gcode.append({
                "device": device,
                "code": code,
                "response": clean_response(response) if index == len(codes) - 1 else "",
                "polling": polling,
                "commandId": command_id,
            })

    def record_move(self, api: Any, before: Dict[str, float], after: Dict[str, float], target: Dict[str, float],
                    speed: Optional[float], max_speeds: Optional[Dict[str, float]], first_gcode: int, error: Optional[str]) -> None:
        from opentrons.types import Mount

        tips = {}
        for mount_name, mount in (("left", Mount.LEFT), ("right", Mount.RIGHT)):
            pipette = api.hardware_instruments.get(mount)
            tips[mount_name] = round(pipette.current_tip_length, 3) if pipette is not None and pipette.has_tip else None
            if pipette is not None and mount_name not in self.pipettes:
                self.pipettes[mount_name] = describe_hardware_pipette(api, mount, mount_name)
        moved = sorted(axis for axis in target)
        mount = "right" if ("Z_R" in moved or "P_R" in moved) else "left"
        self.moves.append({
            "commandId": self.running_command_id(),
            "mount": mount,
            "axes": moved,
            "start": {k: round(v, 3) for k, v in before.items()},
            "end": {k: round(v, 3) for k, v in after.items()},
            "speed": speed,
            "maxSpeeds": max_speeds,
            "tips": tips,
            "gcode": [first_gcode, len(self.gcode)],
            "error": error,
        })


GCODE_TOKEN = re.compile(r"([GM]\d+(?:\.\d+)?(?:\s+[A-FH-LN-Z][^\sGM]*)*)")


def split_gcode(data: str) -> List[str]:
    """Split a batched serial write such as 'M907 A0.1 G4 P0.005 G0 X1' into codes."""
    text = data.strip()
    if not text:
        return []
    codes = [match.group(1).strip() for match in GCODE_TOKEN.finditer(text)]
    return codes or [text]


def clean_response(response: str) -> str:
    text = re.sub(r"\s+", " ", (response or "").replace("ok", " ")).strip()
    return text[:200]


def describe_hardware_pipette(api: Any, mount: Any, mount_name: str) -> Dict[str, Any]:
    from opentrons.hardware_control.types import CriticalPoint

    pipette = api.hardware_instruments[mount]
    nozzle_map = pipette.nozzle_manager.current_configuration
    starting = nozzle_map.starting_nozzle
    origin = nozzle_map.map_store[starting]
    mount_offset = api.config.left_mount_offset if mount_name == "left" else (0.0, 0.0, 0.0)
    cp = api.critical_point_for(mount, CriticalPoint.NOZZLE)
    return {
        "mount": mount_name,
        "model": str(pipette.model),
        "name": str(pipette.name),
        "channels": len(nozzle_map.map_store),
        "maxVolume": pipette.working_volume,
        "mountOffset": [round(float(v), 3) for v in mount_offset],
        "nozzleOffset": [round(cp.x, 3), round(cp.y, 3), round(cp.z, 3)],
        "channelOffsets": [
            {"name": name, "dx": round(point.x - origin.x, 3), "dy": round(point.y - origin.y, 3)}
            for name, point in nozzle_map.map_store.items()
        ],
    }


def install_hooks(recorder: Recorder) -> None:
    from opentrons.drivers.asyncio.communication import SerialConnection
    from opentrons.hardware_control.api import API

    original_send = SerialConnection.send_data

    async def send_data(self: Any, data: str, retries: int = 0, timeout: Optional[float] = None) -> str:
        response = await original_send(self, data, retries, timeout)
        recorder.record_serial(self.port, data, response)
        return response

    SerialConnection.send_data = send_data  # type: ignore[method-assign]

    original_move = API._move

    async def move(self: Any, target_position: Any, speed: Optional[float] = None, *args: Any, **kwargs: Any) -> None:
        before = {axis.name: value for axis, value in self._current_position.items()}
        first_gcode = len(recorder.gcode)
        max_speeds = kwargs.get("max_speeds") if "max_speeds" in kwargs else (args[1] if len(args) > 1 else None)
        target = {axis.name: value for axis, value in target_position.items()}
        error = None
        try:
            await original_move(self, target_position, speed, *args, **kwargs)
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            after = {axis.name: value for axis, value in self._current_position.items()} or {**before, **target}
            recorder.record_move(
                self, before, after, target, speed,
                {axis.name: value for axis, value in max_speeds.items()} if max_speeds else None,
                first_gcode, error,
            )

    API._move = move  # type: ignore[method-assign]


async def emulate(protocol: Path, analysis: Dict[str, Any], module_types: List[str]) -> Dict[str, Any]:
    from opentrons.config.robot_configs import build_config
    from opentrons.hardware_control import API, ThreadManager
    from opentrons.hardware_control.emulation.settings import Settings
    from opentrons.hardware_control.types import HardwareFeatureFlags
    from opentrons.protocol_engine import Config, DeckType, create_protocol_engine, error_recovery_policy
    from opentrons.protocol_reader import ProtocolReader
    from opentrons.protocol_runner import RunOrchestrator
    from opentrons.protocols.api_support import deck_type

    settings = Settings()
    emulators = Process(target=_run_emulators, daemon=True)
    emulators.start()
    try:
        waiter = Process(target=_wait_for_emulators, daemon=True)
        waiter.start()
        waiter.join(30)
        if waiter.exitcode != 0:
            raise RuntimeError("The OT-2 emulator did not start.")

        hardware = ThreadManager(
            API.build_hardware_controller,
            build_config({}),
            f"socket://127.0.0.1:{settings.smoothie.port}",
            feature_flags=HardwareFeatureFlags.build_from_ff(),
        )
        deadline = time.monotonic() + 30
        while len(hardware.attached_modules) != len(module_types):
            if time.monotonic() > deadline:
                raise RuntimeError("Emulated modules did not attach.")
            await asyncio.sleep(0.1)

        source = await ProtocolReader().read_saved(files=[protocol], directory=None)
        robot_type = "OT-2 Standard"
        engine = await create_protocol_engine.create_protocol_engine(
            hardware_api=hardware,
            config=Config(
                robot_type=robot_type,
                deck_type=DeckType(deck_type.for_simulation(robot_type=robot_type)),
                use_simulated_deck_config=True,
                ignore_pause=True,
            ),
            error_recovery_policy=error_recovery_policy.never_recover,
            load_fixed_trash=deck_type.should_load_fixed_trash(source.config),
        )
        orchestrator = RunOrchestrator.build_orchestrator(
            hardware_api=hardware, protocol_engine=engine, protocol_config=source.config
        )
        port_devices = {
            settings.smoothie.port: "smoothie",
            settings.temperature_proxy.driver_port: "tempdeck",
            settings.thermocycler_proxy.driver_port: "thermocycler",
            settings.magdeck_proxy.driver_port: "magdeck",
            settings.heatershaker_proxy.driver_port: "heatershaker",
        }
        recorder = Recorder(engine, port_devices)
        install_hooks(recorder)
        started = time.monotonic()
        run_result = await orchestrator.run(deck_configuration=[], protocol_source=source)
        wall_seconds = time.monotonic() - started
        result = collect(engine, run_result, recorder, hardware, analysis)
        result["engine"]["emulationSeconds"] = round(wall_seconds, 2)
        try:
            hardware.clean_up()
        except Exception:
            pass
        return result
    finally:
        emulators.kill()
        emulators.join(5)


def dump(model: Any) -> Any:
    if model is None:
        return None
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json", exclude_none=True)
    return model


def dump_error(error: Any) -> Any:
    """Engine error without tracebacks, which expose server paths."""
    data = dump(error)
    if not isinstance(data, dict):
        return data

    def scrub(node: Dict[str, Any]) -> Dict[str, Any]:
        info = {k: v for k, v in (node.get("errorInfo") or {}).items() if k not in ("traceback", "args")}
        return {
            "errorType": node.get("errorType"),
            "errorCode": node.get("errorCode"),
            "detail": node.get("detail"),
            "errorInfo": info,
            "wrappedErrors": [scrub(child) for child in node.get("wrappedErrors") or []],
        }

    return scrub(data)


def collect(engine: Any, run_result: Any, recorder: Recorder, hardware: Any, analysis: Dict[str, Any]) -> Dict[str, Any]:
    import opentrons

    view = engine.state_view
    commands = view.commands.get_all()
    index_by_id = {command.id: index for index, command in enumerate(commands)}
    labware_names: Dict[str, str] = {}

    labware = []
    for item in view.labware.get_all():
        try:
            origin = view.geometry.get_labware_origin_position(item.id)
        except Exception:
            continue  # off-deck labware
        definition = view.labware.get_definition(item.id)
        labware_names[item.id] = definition.metadata.displayName
        labware.append(describe_labware(view, item, definition, origin))

    modules = [describe_module(view, module) for module in view.modules.get_all()]
    command_rows = []
    for index, command in enumerate(commands):
        params = dump(command.params) or {}
        result = dump(command.result) or {}
        result.pop("definition", None)
        command_rows.append({
            "index": index,
            "id": command.id,
            "type": command.commandType,
            "setup": command.commandType in SETUP_COMMANDS,
            "label": command_label(command.commandType, params, result, labware_names, view),
            "params": params,
            "result": result,
            "status": str(getattr(command.status, "value", command.status)),
            "error": dump_error(command.error),
        })

    # Compact rows keep large protocols small: [command, device, code, response, polling].
    gcode = [
        [index_by_id.get(line["commandId"]), line["device"], line["code"], line["response"], 1 if line["polling"] else 0]
        for line in recorder.gcode
    ]

    config = hardware.config
    moves = []
    for move in recorder.moves:
        moves.append({
            **{k: v for k, v in move.items() if k != "commandId"},
            "command": index_by_id.get(move["commandId"]),
            "seconds": round(move_seconds(move, config), 4),
        })

    summary = run_result.state_summary
    run_errors = [dump_error(error) for error in summary.errors]
    result = {
        "schema": 1,
        "engine": {
            "opentronsVersion": opentrons.__version__,
            "robotType": "OT-2 Standard",
            "apiLevel": str(analysis.get("config", {}).get("apiVersion", ["?", "?"])[0]) + "." + str(analysis.get("config", {}).get("apiVersion", ["?", "?"])[1])
            if isinstance(analysis.get("config", {}).get("apiVersion"), list) else str(analysis.get("config", {}).get("apiVersion", "")),
            "calibration": "Default deck calibration; no labware offsets applied.",
        },
        "metadata": analysis.get("metadata", {}),
        "status": str(getattr(summary.status, "value", summary.status)),
        "errors": run_errors,
        "deck": describe_deck(view),
        "labware": labware,
        "modules": modules,
        "pipettes": [recorder.pipettes[m] for m in PIPETTE_MOUNTS if m in recorder.pipettes],
        "liquids": [dump(liquid) for liquid in summary.liquids],
        "commands": command_rows,
        "moves": moves,
        "gcode": gcode,
    }
    result["safety"] = safety.evaluate(result)
    result["timing"] = {"estimatedSeconds": round(sum(m["seconds"] for m in moves) + sum(
        c["params"].get("seconds", 0) for c in command_rows if c["type"] == "waitForDuration"), 1)}
    return result


def move_seconds(move: Dict[str, Any], config: Any) -> float:
    """Trapezoidal duration using the robot's axis speed and acceleration limits."""
    start, end = move["start"], move["end"]
    deltas = {
        SMOOTHIE_AXIS.get(axis, axis): abs(end.get(axis, start.get(axis, 0.0)) - start.get(axis, end.get(axis, 0.0)))
        for axis in set(start) | set(end)
    }
    deltas = {axis: d for axis, d in deltas.items() if d > 1e-6}
    if not deltas:
        return 0.0
    length = math.sqrt(sum(d * d for d in deltas.values()))
    max_speeds = dict(config.default_max_speed)
    if move.get("maxSpeeds"):
        max_speeds.update({SMOOTHIE_AXIS.get(axis, axis): value for axis, value in move["maxSpeeds"].items()})
    speed = move.get("speed") or 400.0
    for axis, d in deltas.items():
        axis_limit = max_speeds.get(axis)
        if axis_limit and speed * d / length > axis_limit:
            speed = axis_limit * length / d
    acceleration = min(config.acceleration.get(axis, 1000.0) * length / d for axis, d in deltas.items())
    ramp = speed * speed / acceleration
    if length <= ramp:
        return 2 * math.sqrt(length / acceleration)
    return 2 * speed / acceleration + (length - ramp) / speed


def describe_deck(view: Any) -> Dict[str, Any]:
    slots = []
    for name in [str(n) for n in range(1, 12)]:
        try:
            position = view.addressable_areas.get_addressable_area_position(name, do_compatibility_check=False)
            box = view.addressable_areas.get_addressable_area_bounding_box(name, do_compatibility_check=False)
        except Exception:
            continue
        slots.append({"name": name, "x": position.x, "y": position.y, "z": position.z, "xDim": box.x, "yDim": box.y})
    trash = None
    try:
        position = view.addressable_areas.get_addressable_area_position("fixedTrash", do_compatibility_check=False)
        box = view.addressable_areas.get_addressable_area_bounding_box("fixedTrash", do_compatibility_check=False)
        trash = {"x": position.x, "y": position.y, "z": position.z, "xDim": box.x, "yDim": box.y, "zDim": box.z}
    except Exception:
        pass
    return {"slots": slots, "fixedTrash": trash}


def describe_labware(view: Any, item: Any, definition: Any, origin: Any) -> Dict[str, Any]:
    dims = definition.dimensions
    wells = {}
    for name, well in definition.wells.items():
        entry = {
            "x": round(origin.x + well.x, 3),
            "y": round(origin.y + well.y, 3),
            "z": round(origin.z + well.z, 3),
            "depth": well.depth,
            "shape": well.shape,
            "volume": well.totalLiquidVolume,
        }
        if well.shape == "circular":
            entry["diameter"] = well.diameter
        else:
            entry["xDim"] = well.xDimension
            entry["yDim"] = well.yDimension
        wells[name] = entry
    is_tiprack = bool(definition.parameters.isTiprack)
    add_height_tables(view, item.id, definition, wells, is_tiprack)
    location = dump(item.location)
    return {
        "id": item.id,
        "loadName": definition.parameters.loadName,
        "namespace": definition.namespace,
        "version": definition.version,
        "displayName": definition.metadata.displayName,
        "category": str(definition.metadata.displayCategory),
        "isTiprack": is_tiprack,
        "slot": view.geometry.get_ancestor_slot_name(item.id).id if hasattr(view.geometry.get_ancestor_slot_name(item.id), "id") else str(view.geometry.get_ancestor_slot_name(item.id)),
        "location": location,
        "origin": {"x": round(origin.x, 3), "y": round(origin.y, 3), "z": round(origin.z, 3)},
        "dimensions": {"x": dims.xDimension, "y": dims.yDimension, "z": dims.zDimension},
        "top": round(origin.z + dims.zDimension, 3),
        "ordering": definition.ordering,
        "wells": wells,
    }


def add_height_tables(view: Any, labware_id: str, definition: Any, wells: Dict[str, Dict[str, Any]], is_tiprack: bool) -> None:
    """Attach liquid height-vs-volume samples from the labware's inner geometry, where defined."""
    if is_tiprack:
        return
    cache: Dict[Any, Optional[List[List[float]]]] = {}
    for name, well in wells.items():
        source = definition.wells[name]
        key = getattr(source, "geometryDefinitionId", None) or (well["shape"], well["depth"], well.get("diameter"), well.get("xDim"), well.get("yDim"))
        if key not in cache:
            table: Optional[List[List[float]]] = []
            try:
                for step in range(0, 11):
                    height = well["depth"] * step / 10
                    volume = float(view.geometry.get_well_volume_at_height(labware_id, name, height))
                    table.append([round(volume, 3), round(height, 3)])
            except Exception:
                table = None
            cache[key] = table
        if cache[key]:
            well["heights"] = cache[key]


def describe_module(view: Any, module: Any) -> Dict[str, Any]:
    definition = view.modules.get_definition(module.id)
    location = view.modules.get_location(module.id)
    slot = location.slotName.id if hasattr(location.slotName, "id") else str(location.slotName)
    position = view.addressable_areas.get_addressable_area_position(slot, do_compatibility_check=False)
    corner = definition.cornerOffsetFromSlot
    dims = definition.dimensions
    return {
        "id": module.id,
        "model": str(getattr(module.model, "value", module.model)),
        "displayName": definition.displayName,
        "slot": slot,
        "origin": {"x": round(position.x + corner.x, 3), "y": round(position.y + corner.y, 3), "z": round(position.z + corner.z, 3)},
        "dimensions": {
            "x": getattr(dims, "xDimension", None) or 127.76,
            "y": getattr(dims, "yDimension", None) or 85.48,
            "z": dims.bareOverallHeight,
        },
        "labwareSeatZ": round(position.z + definition.labwareOffset.z, 3),
    }


def command_label(kind: str, params: Dict[str, Any], result: Dict[str, Any], names: Dict[str, str], view: Any) -> str:
    def where() -> str:
        labware_id = params.get("labwareId")
        well = params.get("wellName")
        if not labware_id:
            return ""
        slot = ""
        try:
            slot_name = view.geometry.get_ancestor_slot_name(labware_id)
            slot = f" (slot {getattr(slot_name, 'id', slot_name)})"
        except Exception:
            pass
        return f"{well + ' of ' if well else ''}{names.get(labware_id, 'labware')}{slot}"

    volume = params.get("volume")
    amount = f"{volume:g} µL" if isinstance(volume, (int, float)) else ""
    labels = {
        "home": lambda: "Home robot",
        "loadLabware": lambda: f"Load {params.get('loadName', 'labware')} in slot {params.get('location', {}).get('slotName', '?')}",
        "loadPipette": lambda: f"Load {params.get('pipetteName')} on {params.get('mount')} mount",
        "loadModule": lambda: f"Load {params.get('model')} in slot {params.get('location', {}).get('slotName', '?')}",
        "loadLiquid": lambda: f"Load liquid into {len(params.get('volumeByWell', {}))} well(s) of {names.get(params.get('labwareId'), 'labware')}",
        "pickUpTip": lambda: f"Pick up tip from {where()}",
        "dropTip": lambda: f"Drop tip into {where() or 'trash'}",
        "dropTipInPlace": lambda: "Drop tip in place",
        "moveToAddressableAreaForDropTip": lambda: f"Move to {params.get('addressableAreaName', 'trash')} to drop tip",
        "moveToAddressableArea": lambda: f"Move to {params.get('addressableAreaName')}",
        "aspirate": lambda: f"Aspirate {amount} from {where()}",
        "aspirateInPlace": lambda: f"Aspirate {amount} in place",
        "dispense": lambda: f"Dispense {amount} into {where()}",
        "dispenseInPlace": lambda: f"Dispense {amount} in place",
        "blowout": lambda: f"Blow out into {where()}",
        "blowOutInPlace": lambda: "Blow out in place",
        "touchTip": lambda: f"Touch tip in {where()}",
        "moveToWell": lambda: f"Move to {where()}",
        "moveToCoordinates": lambda: "Move to coordinates",
        "moveRelative": lambda: f"Move {params.get('distance')} mm along {params.get('axis')}",
        "waitForDuration": lambda: f"Delay {params.get('seconds', 0):g} s" + (f" · {params['message']}" if params.get("message") else ""),
        "waitForResume": lambda: f"Pause · {params.get('message') or 'resume in app'}",
        "comment": lambda: f"Comment · {params.get('message', '')}",
        "prepareToAspirate": lambda: "Prepare plunger to aspirate",
        "airGapInPlace": lambda: f"Air gap {amount}",
        "configureForVolume": lambda: f"Configure for {amount}",
        "retractAxis": lambda: f"Retract {params.get('axis')} axis",
    }
    try:
        return labels[kind]() if kind in labels else re.sub(r"([a-z])([A-Z])", r"\1 \2", kind.split("/")[-1]).capitalize()
    except Exception:
        return kind


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    protocol, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    try:
        analysis = run_analysis(protocol)
        robot_type = analysis.get("robotType", "OT-2 Standard")
        if robot_type != "OT-2 Standard":
            raise ProtocolRejected(f"This simulator supports OT-2 protocols only (protocol targets {robot_type}).")
        module_types = configure_emulator(analysis)
        result = asyncio.run(emulate(protocol, analysis, module_types))
    except ProtocolRejected as exc:
        result = {"schema": 1, "status": "rejected", "rejection": str(exc)}
    except Exception as exc:
        traceback.print_exc()
        result = {"schema": 1, "status": "crashed", "rejection": f"Simulation failed: {exc}"}
    output.write_text(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
