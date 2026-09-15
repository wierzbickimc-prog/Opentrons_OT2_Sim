"""Safety checks over a simulation result.

Pure Python with no Opentrons dependency, so it runs in the simulator worker
and in the server's unit tests alike. Inputs are the deck geometry, pipette
geometry, recorded moves, and engine commands produced by worker.py.

Coordinates are OT-2 deck coordinates in millimeters. Carriage axes use the
engine's names: X, Y, Z_L/Z_R (mount heights) and P_L/P_R (plungers). A move's carriage
position plus the pipette's mount offset and nozzle offset gives the starting
nozzle's end; other channels are offset from it in X/Y, and an attached tip
extends the end downward by the tip's effective length.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

TOLERANCE_MM = 0.1
SAMPLE_SPACING_MM = 2.0
MAX_FINDINGS = 400
# Aspirating slightly more than a well holds is a deliberate way to empty it
# (PCR->AMP transfer draws 66 µL from 65 µL wells), so it is not a warning.
SMALL_OVERDRAW_UL = 2.0

LIMITATIONS = [
    "Uses default deck calibration and nominal labware definitions; a calibrated robot differs by a few millimeters.",
    "Collision checks cover tip and nozzle ends against labware and module tops, not the full pipette body.",
    "Module walls are approximated by their labware seat height; thermocycler lid position is not modeled.",
    "Liquid checks use volumes declared with load_liquid; wells without declared liquid are tracked from dispenses only.",
]


def evaluate(result: Dict[str, Any]) -> Dict[str, Any]:
    checker = SafetyChecker(result)
    checker.check_engine_errors()
    checker.check_motion()
    liquid = checker.track_liquid()
    findings = checker.findings()
    counts = {level: sum(1 for f in findings if f["severity"] == level) for level in ("error", "warning", "info")}
    status = "fail" if counts["error"] else "warn" if counts["warning"] else "pass"
    return {
        "status": status,
        "counts": counts,
        "findings": findings,
        "truncated": checker.truncated,
        "liquid": liquid,
        "limitations": LIMITATIONS,
    }


class SafetyChecker:
    def __init__(self, result: Dict[str, Any]) -> None:
        self.result = result
        self.labware = result.get("labware", [])
        self.labware_by_id = {lw["id"]: lw for lw in self.labware}
        self.modules = result.get("modules", [])
        self.pipettes = {p["mount"]: p for p in result.get("pipettes", [])}
        self.commands = result.get("commands", [])
        self.moves = result.get("moves", [])
        tops = [lw["top"] for lw in self.labware] + [m["labwareSeatZ"] for m in self.modules]
        self.highest_obstacle = max(tops) if tops else -math.inf
        self._findings: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        self.truncated = False

    # ------------------------------------------------------------------ output
    def add(self, severity: str, code: str, message: str, command: Optional[int], *,
            mount: Optional[str] = None, labware: Optional[str] = None, well: Optional[str] = None,
            channel: Optional[str] = None, point: Optional[Dict[str, float]] = None,
            extra_well: Optional[str] = None) -> None:
        key = (code, command, mount, labware, well)
        existing = self._findings.get(key)
        if existing:
            if channel and channel not in existing["channels"]:
                existing["channels"].append(channel)
            if extra_well and extra_well not in existing["wells"]:
                existing["wells"].append(extra_well)
            return
        if len(self._findings) >= MAX_FINDINGS:
            self.truncated = True
            return
        self._findings[key] = {
            "severity": severity,
            "code": code,
            "message": message,
            "command": command,
            "mount": mount,
            "labware": labware,
            "well": well,
            "channels": [channel] if channel else [],
            "wells": [extra_well] if extra_well else [],
            "point": point,
        }

    def findings(self) -> List[Dict[str, Any]]:
        order = {"error": 0, "warning": 1, "info": 2}
        rows = sorted(self._findings.values(), key=lambda f: (order[f["severity"]], f["command"] if f["command"] is not None else -1))
        for row in rows:
            if row["wells"]:
                row["message"] = f"{row['message']} Wells: {', '.join(row['wells'])}."
            numbers = self.channel_numbers(row["mount"], row["channels"])
            if numbers:
                noun = "Channel" if len(numbers) == 1 else "Channels"
                total = self.pipettes[row["mount"]]["channels"]
                row["message"] = f"{row['message']} {noun} {', '.join(numbers)} of {total}."
            row["channels"] = numbers
        return rows

    def channel_numbers(self, mount: Optional[str], names: List[str]) -> List[str]:
        """Channel names (nozzle IDs such as H1) as 1-based numbers, back to front."""
        pipette = self.pipettes.get(mount or "")
        if not pipette or pipette["channels"] < 2:
            return []
        order = [channel["name"] for channel in pipette["channelOffsets"]]
        return [str(order.index(name) + 1) for name in names if name in order]

    # ------------------------------------------------------------ engine errors
    def check_engine_errors(self) -> None:
        attributed = False
        for command in self.commands:
            error = command.get("error")
            if error:
                attributed = True
                self.add("error", "engine-error", f"Opentrons engine error: {error_text(error)}", command["index"])
        if not attributed:
            # Python API errors (e.g. running out of tips) are raised before the
            # engine issues a command; anchor them to the last command that ran.
            last = self.commands[-1]["index"] if self.commands else None
            for error in self.result.get("errors", []):
                self.add("error", "engine-error", f"Opentrons engine error: {error_text(error)}", last)

    # ------------------------------------------------------------------ motion
    def nozzle_ends(self, mount: str, carriage: Dict[str, float], tip: Optional[float]) -> List[Tuple[str, float, float, float]]:
        pipette = self.pipettes[mount]
        z_axis = "Z_L" if mount == "left" else "Z_R"
        if z_axis not in carriage or "X" not in carriage or "Y" not in carriage:
            return []
        mo, no = pipette["mountOffset"], pipette["nozzleOffset"]
        x = carriage["X"] + mo[0] + no[0]
        y = carriage["Y"] + mo[1] + no[1]
        z = carriage[z_axis] + mo[2] + no[2] - (tip or 0.0)
        return [(ch["name"], x + ch["dx"], y + ch["dy"], z) for ch in pipette["channelOffsets"]]

    def check_motion(self) -> None:
        for move in self.moves:
            if move.get("error"):
                continue  # already reported as an engine error
            start, end = move.get("start") or {}, move.get("end") or {}
            xy_distance = math.hypot(end.get("X", 0) - start.get("X", 0), end.get("Y", 0) - start.get("Y", 0))
            travel = xy_distance > TOLERANCE_MM
            steps = max(1, int(math.ceil(xy_distance / SAMPLE_SPACING_MM))) if travel else 1
            for mount in self.pipettes:
                tip = (move.get("tips") or {}).get(mount)
                ends_start = self.nozzle_ends(mount, start, tip) if start else []
                ends_end = self.nozzle_ends(mount, end, tip)
                if not ends_end:
                    continue
                lowest = min(z for *_rest, z in ends_end + ends_start)
                if lowest >= self.highest_obstacle - TOLERANCE_MM:
                    continue
                previous_wells: Dict[str, Optional[Tuple[str, str]]] = {}
                for step in range(1, steps + 1):
                    fraction = step / steps
                    carriage = {axis: start.get(axis, end[axis]) + (end[axis] - start.get(axis, end[axis])) * fraction for axis in end}
                    for channel, x, y, z in self.nozzle_ends(mount, carriage, tip):
                        self.check_point(move, mount, channel, x, y, z, travel, tip is not None, previous_wells)

    def check_point(self, move: Dict[str, Any], mount: str, channel: str, x: float, y: float, z: float,
                    travel: bool, has_tip: bool, previous_wells: Dict[str, Optional[Tuple[str, str]]]) -> None:
        command = move.get("command")
        end_name = "tip" if has_tip else "nozzle"
        point = {"x": round(x, 2), "y": round(y, 2), "z": round(z, 2)}
        inside_any = False
        for lw in self.labware_at(x, y):
            inside_any = True
            if z >= lw["top"] - TOLERANCE_MM:
                continue
            found = well_at(lw, x, y)
            if found is None:
                code = "tip-collision-travel" if travel else "tip-collision-descent"
                action = "while traveling" if travel else "on descent"
                self.add("error", code,
                         f"The {mount} pipette {end_name} would strike {label(lw)} outside any well {action} "
                         f"({end_name} end {z:.1f} mm, labware top {lw['top']:.1f} mm).",
                         command, mount=mount, labware=lw["id"], channel=channel, point=point)
                previous_wells[channel] = None
                continue
            name, well = found
            prior = previous_wells.get(channel)
            if travel and prior is not None and prior != (lw["id"], name):
                self.add("error", "tip-collision-travel",
                         f"The {mount} pipette {end_name} would drag from well {prior[1]} to {name} of {label(lw)} "
                         f"below the labware top ({z:.1f} mm < {lw['top']:.1f} mm).",
                         command, mount=mount, labware=lw["id"], channel=channel, point=point)
            previous_wells[channel] = (lw["id"], name)
            if z < well["z"] - TOLERANCE_MM:
                self.add("error", "well-bottom-strike",
                         f"The {mount} pipette {end_name} would go {well['z'] - z:.1f} mm below the bottom of "
                         f"{name} in {label(lw)}.",
                         command, mount=mount, labware=lw["id"], well=name, channel=channel, point=point)
        if not inside_any:
            for module in self.modules_at(x, y):
                if z < module["labwareSeatZ"] - TOLERANCE_MM:
                    self.add("error", "tip-collision-travel" if travel else "tip-collision-descent",
                             f"The {mount} pipette {end_name} would strike the {module.get('displayName', 'module')} "
                             f"in slot {module.get('slot')} ({z:.1f} mm < {module['labwareSeatZ']:.1f} mm).",
                             command, mount=mount, labware=module["id"], channel=channel, point=point)

    def labware_at(self, x: float, y: float) -> Iterable[Dict[str, Any]]:
        for lw in self.labware:
            o, d = lw["origin"], lw["dimensions"]
            if o["x"] - TOLERANCE_MM <= x <= o["x"] + d["x"] + TOLERANCE_MM and o["y"] - TOLERANCE_MM <= y <= o["y"] + d["y"] + TOLERANCE_MM:
                yield lw

    def modules_at(self, x: float, y: float) -> Iterable[Dict[str, Any]]:
        for module in self.modules:
            o, d = module["origin"], module["dimensions"]
            if o["x"] <= x <= o["x"] + d["x"] and o["y"] <= y <= o["y"] + d["y"]:
                yield module

    # ------------------------------------------------------------------ liquid
    def track_liquid(self) -> Dict[str, Any]:
        mounts_by_pipette_id: Dict[str, str] = {}
        volumes: Dict[Tuple[str, str], float] = {}
        loaded_labware = set()
        initial: Dict[str, Dict[str, float]] = {}
        tips: Dict[str, List[float]] = {m: [0.0] * p["channels"] for m, p in self.pipettes.items()}
        carriage: Dict[str, float] = {}
        tip_lengths: Dict[str, Optional[float]] = {}
        moves_by_command: Dict[int, List[Dict[str, Any]]] = {}
        for move in self.moves:
            if move.get("command") is not None:
                moves_by_command.setdefault(move["command"], []).append(move)
        events = []
        declared_any = False

        for command in self.commands:
            index, kind, params = command["index"], command["type"], command.get("params", {})
            for move in moves_by_command.get(index, []):
                carriage.update(move.get("end") or {})
                tip_lengths.update(move.get("tips") or {})
            if kind == "loadPipette":
                pipette_id = (command.get("result") or {}).get("pipetteId")
                if pipette_id:
                    mounts_by_pipette_id[pipette_id] = params.get("mount")
                continue
            if kind == "loadLiquid":
                labware_id = params.get("labwareId")
                loaded_labware.add(labware_id)
                declared_any = True
                for well, volume in (params.get("volumeByWell") or {}).items():
                    volumes[(labware_id, well)] = float(volume)
                    initial.setdefault(labware_id, {})[well] = float(volume)
                continue
            mount = mounts_by_pipette_id.get(params.get("pipetteId", ""))
            if mount not in self.pipettes or command.get("error"):
                continue
            channel_ends = self.nozzle_ends(mount, carriage, tip_lengths.get(mount))
            if not channel_ends:
                continue
            deltas: Dict[Tuple[str, str], float] = {}
            volume = float(params.get("volume") or 0.0)

            if kind in ("aspirate", "aspirateInPlace", "airGapInPlace"):
                for position, (channel, x, y, z) in enumerate(channel_ends):
                    # Tip volumes track liquid only; air drawn by empty channels is not counted.
                    if kind == "airGapInPlace":
                        continue
                    location = self.liquid_location(x, y)
                    if location is None:
                        continue
                    lw, name, well = location
                    key = (lw["id"], name)
                    known = volumes.get(key, 0.0 if lw["id"] in loaded_labware else None)
                    if known is None:
                        tips[mount][position] += volume
                        continue
                    if known <= 1e-6:
                        self.add("info", "air-aspirate-empty-well",
                                 f"Some channels aspirate from wells of {label(lw)} with no declared liquid and draw air.",
                                 index, mount=mount, labware=lw["id"], channel=channel, extra_well=name)
                    else:
                        if known + 1e-6 < volume <= known + SMALL_OVERDRAW_UL + 1e-6:
                            self.add("info", "aspirate-overdraw",
                                     f"Aspirating {volume:g} µL draws up to {SMALL_OVERDRAW_UL:g} µL more than wells of "
                                     f"{label(lw)} hold, emptying them.",
                                     index, mount=mount, labware=lw["id"], channel=channel, extra_well=name)
                        elif known + 1e-6 < volume:
                            self.add("warning", "aspirate-insufficient",
                                     f"{name} of {label(lw)} holds {known:.1f} µL but {volume:g} µL is aspirated.",
                                     index, mount=mount, labware=lw["id"], well=name, channel=channel)
                        surface = well["z"] + height_at_volume(well, known)
                        if z > surface + TOLERANCE_MM:
                            self.add("warning", "aspirate-above-liquid",
                                     f"Tip end is {z - surface:.1f} mm above the liquid in {name} of {label(lw)} "
                                     f"({known:.1f} µL); it would aspirate air.",
                                     index, mount=mount, labware=lw["id"], well=name, channel=channel)
                    removed = min(known, volume)
                    tips[mount][position] += removed
                    volumes[key] = known - removed
                    deltas[key] = deltas.get(key, 0.0) - removed

            elif kind in ("dispense", "dispenseInPlace", "blowout", "blowOutInPlace"):
                for position, (channel, x, y, z) in enumerate(channel_ends):
                    held = tips[mount][position]
                    amount = held if kind in ("blowout", "blowOutInPlace") else min(volume, held)
                    tips[mount][position] = max(0.0, held - amount)
                    location = self.liquid_location(x, y)
                    if location is None or amount <= 0:
                        continue
                    lw, name, well = location
                    if lw.get("isTiprack"):
                        continue
                    key = (lw["id"], name)
                    new_volume = volumes.get(key, 0.0) + amount
                    volumes[key] = new_volume
                    deltas[key] = deltas.get(key, 0.0) + amount
                    capacity = well.get("volume")
                    if capacity and new_volume > capacity + 1e-6:
                        self.add("warning", "dispense-overflow",
                                 f"{name} of {label(lw)} would hold {new_volume:.1f} µL, above its {capacity:g} µL capacity.",
                                 index, mount=mount, labware=lw["id"], well=name, channel=channel)

            elif kind in ("pickUpTip", "dropTip", "dropTipInPlace"):
                tips[mount] = [0.0] * len(tips[mount])
            else:
                continue

            events.append({
                "command": index,
                "mount": mount,
                "wells": [{"labware": k[0], "well": k[1], "delta": round(v, 4)} for k, v in deltas.items() if abs(v) > 1e-9],
                "tips": [round(v, 4) for v in tips[mount]],
            })

        if not declared_any and any(c["type"].startswith("aspirate") for c in self.commands):
            self.add("info", "no-declared-liquids",
                     "The protocol does not declare starting liquids with load_liquid, so volume checks are limited.", None)
        return {"initial": initial, "events": events}

    def liquid_location(self, x: float, y: float) -> Optional[Tuple[Dict[str, Any], str, Dict[str, Any]]]:
        for lw in self.labware_at(x, y):
            found = well_at(lw, x, y)
            if found:
                return lw, found[0], found[1]
        return None


def well_at(lw: Dict[str, Any], x: float, y: float) -> Optional[Tuple[str, Dict[str, Any]]]:
    for name, well in lw["wells"].items():
        dx, dy = x - well["x"], y - well["y"]
        if well.get("shape") == "circular":
            if math.hypot(dx, dy) <= well["diameter"] / 2 + TOLERANCE_MM:
                return name, well
        elif abs(dx) <= well["xDim"] / 2 + TOLERANCE_MM and abs(dy) <= well["yDim"] / 2 + TOLERANCE_MM:
            return name, well
    return None


def height_at_volume(well: Dict[str, Any], volume: float) -> float:
    """Liquid height above the well bottom, from the labware's geometry table when available."""
    table = well.get("heights")
    if table:
        if volume <= table[0][0]:
            return table[0][1]
        for (v0, h0), (v1, h1) in zip(table, table[1:]):
            if v0 <= volume <= v1:
                return h0 + (h1 - h0) * (volume - v0) / (v1 - v0) if v1 > v0 else h1
        return table[-1][1]
    if well.get("shape") == "circular":
        area = math.pi * (well["diameter"] / 2) ** 2
    else:
        area = well["xDim"] * well["yDim"]
    return min(well["depth"], volume / area) if area > 0 else 0.0


def label(lw: Dict[str, Any]) -> str:
    return f"{lw.get('displayName', lw.get('loadName', 'labware'))} (slot {lw.get('slot', '?')})"


ERROR_HINTS = {
    "OutOfTipsError": "no unused tips remain in the pipette's assigned tip racks",
}


def error_text(error: Dict[str, Any]) -> str:
    """One readable line from an engine error and the errors it wraps."""
    parts: List[str] = []
    node: Optional[Dict[str, Any]] = error
    while node:
        detail = " ".join(str(node.get("detail") or "").split()).rstrip(": ")
        if detail and not any(detail in part for part in parts):
            parts.append(detail)
        name = (node.get("errorInfo") or {}).get("class")
        if name in ERROR_HINTS:
            parts = [parts[0], ERROR_HINTS[name]] if parts else [ERROR_HINTS[name]]
            break  # the wrapped Python internals add nothing for known errors
        wrapped = node.get("wrappedErrors") or []
        node = wrapped[0] if wrapped else None
    return (" — ".join(parts) or str(error.get("errorType") or "unknown error"))[:500]
