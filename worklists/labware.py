"""Labware Warehouse: every labware definition the system uses.

Standard Opentrons definitions are vendored in labware/definitions/ (from the
engine's shared-data). Custom definitions are built here and embedded in the
protocols that use them. Each entry adds what the definition does not say:
its status, what the operator checks on the physical item, and which tools
use it. Status is "standard" (Opentrons), "custom" (built here; check it
against a real item), or "placeholder" (stands in for labware with no
definition yet; protocols using one cannot be generated).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DEFINITIONS_DIR = Path(__file__).resolve().parent.parent / "labware" / "definitions"

AGAR_LOAD_NAME = "built_agar_omnitray_96_spots"
AGAR_PLACEHOLDER = "corning_96_wellplate_360ul_flat"
ECHO_LOAD_NAME = "labcyte_echo_384pp"

# Nunc OmniTray single-well agar plate, measured on a filled plate (mm above
# the deck). The height is to the top of the lid; the robot runs lid off, so
# this overstates the tray slightly, which only raises travel clearance. The
# agar surface sets the dispense height. Set either to None to block the
# plating tools until the plate is measured again.
AGAR_PLATE_HEIGHT_MM: float | None = 14.2
AGAR_SURFACE_HEIGHT_MM: float | None = 7.7
AGAR_MEASURED_ON = "2026-09-25"

PLATING = ["MFG_Plating", "MFG_Hybrid_Plating"]

CATALOG: dict[str, dict] = {
    "opentrons_96_tiprack_20ul": {
        "status": "standard", "kind": "Tip rack", "usedBy": PLATING + ["Calibration (P20)"],
        "checks": ["Opentrons 20 µL tips, not filter tips", "Rack full, seated flat, lid off"],
    },
    "opentrons_96_filtertiprack_200ul": {
        "status": "standard", "kind": "Tip rack", "usedBy": ["PCR->AMP"],
        "checks": ["Opentrons 200 µL filter tips", "Rack full, seated flat, lid off"],
    },
    "opentrons_96_tiprack_300ul": {
        "status": "standard", "kind": "Tip rack", "usedBy": ["Calibration (P300)", "Sample protocol"],
        "checks": ["Opentrons 300 µL tips, not filter tips", "Rack full, seated flat, lid off"],
    },
    "opentrons_96_tiprack_1000ul": {
        "status": "standard", "kind": "Tip rack", "usedBy": ["Calibration (P1000)"],
        "checks": ["Opentrons 1000 µL tips", "Rack full, seated flat, lid off"],
    },
    "opentrons_96_wellplate_200ul_pcr_full_skirt": {
        "status": "standard", "kind": "Plate", "usedBy": PLATING + ["PCR->AMP"],
        "checks": ["Full-skirted PCR plate, not semi-skirted or unskirted", "Seated flat, seal removed"],
    },
    "nest_1_reservoir_195ml": {
        "status": "standard", "kind": "Reservoir", "usedBy": ["MFG_Hybrid_Plating"],
        "checks": ["NEST 1-well 195 mL reservoir", "Water filled to the line"],
    },
    ECHO_LOAD_NAME: {
        "status": "custom", "kind": "Plate", "usedBy": ["PCR->AMP"],
        "source": "Built from nominal SLAS 384-well dimensions; not yet checked against a real plate.",
        "checks": ["Labcyte Echo 384PP polypropylene plate (PP-0200)", "Seated flat, A1 at the back left"],
        "verify": "Measure a real plate: 14.4 mm tall with wells 11.5 mm deep. If it differs, update the definition before running.",
    },
    AGAR_LOAD_NAME: {
        "status": "custom", "kind": "Agar plate", "usedBy": PLATING,
        "checks": ["Nunc OmniTray single-well agar plate, lid off", "Seated flat, A1 corner at the back left"],
    },
    AGAR_PLACEHOLDER: {
        "status": "placeholder", "kind": "Plate", "usedBy": ["Sample protocol", "Protocols built before the agar definition"],
        "placeholderFor": "Agar OmniTray",
        "source": "A real Corning plate definition, but the plating tools used it for agar OmniTrays. Its well bottom (3.55 mm) is not the agar surface, so spots dispensed 1 mm above it can drive tips into the agar.",
        "checks": ["Corning 96-well flat-bottom plate"],
    },
    "opentrons_calibrationblock_short_side_left": {
        "status": "standard", "kind": "Calibration", "usedBy": ["Calibration (right mount)"],
        "checks": ["Opentrons Calibration Block, tall side to the right"],
    },
    "opentrons_calibrationblock_short_side_right": {
        "status": "standard", "kind": "Calibration", "usedBy": ["Calibration (left mount, health check)"],
        "checks": ["Opentrons Calibration Block, tall side to the left"],
    },
    "opentrons_1_trash_1100ml_fixed": {
        "status": "standard", "kind": "Trash", "usedBy": ["Every protocol (slot 12)", "Calibration without a block"],
        "checks": ["Fixed trash in slot 12, emptied"],
    },
}


def echo_384pp_definition() -> dict:
    """Labcyte Echo 384PP from nominal SLAS 384-well geometry (same formula as PCR->AMP protocols embed)."""
    rows, columns = "ABCDEFGHIJKLMNOP", range(1, 25)
    height, depth, side = 14.4, 11.5, 3.7
    wells = {
        f"{row}{column}": {
            "shape": "rectangular", "depth": depth, "xDimension": side, "yDimension": side,
            "totalLiquidVolume": 65, "x": round(12.13 + 4.5 * (column - 1), 2),
            "y": round(76.49 - 4.5 * index, 2), "z": round(height - depth, 2),
        }
        for index, row in enumerate(rows)
        for column in columns
    }
    return {
        "schemaVersion": 2, "version": 1, "namespace": "custom_beta",
        "metadata": {"displayName": "Labcyte Echo 384PP (nominal)", "displayCategory": "wellPlate", "displayVolumeUnits": "µL", "tags": []},
        "brand": {"brand": "Labcyte", "brandId": ["PP-0200"]},
        "parameters": {"format": "384Standard", "isTiprack": False, "isMagneticModuleCompatible": False, "loadName": ECHO_LOAD_NAME},
        "dimensions": {"xDimension": 127.76, "yDimension": 85.48, "zDimension": height},
        "cornerOffsetFromSlot": {"x": 0, "y": 0, "z": 0},
        "ordering": [[f"{row}{column}" for row in rows] for column in columns],
        "wells": wells,
        "groups": [{"wells": list(wells), "metadata": {"wellBottomShape": "flat"}}],
    }


def agar_definition(plate_height: float | None = None, agar_surface: float | None = None) -> dict | None:
    """OmniTray agar with 96 spot positions on the agar surface; None until it is measured."""
    height = AGAR_PLATE_HEIGHT_MM if plate_height is None else plate_height
    surface = AGAR_SURFACE_HEIGHT_MM if agar_surface is None else agar_surface
    if height is None or surface is None:
        return None
    rows, columns = "ABCDEFGH", range(1, 13)
    wells = {
        f"{row}{column}": {
            "shape": "rectangular", "xDimension": 8.0, "yDimension": 8.0,
            "depth": round(height - surface, 2), "totalLiquidVolume": 50,
            "x": round(14.38 + 9 * (column - 1), 2), "y": round(74.24 - 9 * index, 2), "z": surface,
        }
        for index, row in enumerate(rows)
        for column in columns
    }
    return {
        "schemaVersion": 2, "version": 1, "namespace": "custom_beta",
        "metadata": {"displayName": "Nunc OmniTray agar, 96 spots", "displayCategory": "wellPlate", "displayVolumeUnits": "µL", "tags": []},
        "brand": {"brand": "Thermo Scientific Nunc", "brandId": ["OmniTray"]},
        "parameters": {"format": "96Standard", "isTiprack": False, "isMagneticModuleCompatible": False, "loadName": AGAR_LOAD_NAME},
        "dimensions": {"xDimension": 127.76, "yDimension": 85.48, "zDimension": height},
        "cornerOffsetFromSlot": {"x": 0, "y": 0, "z": 0},
        "ordering": [[f"{row}{column}" for row in rows] for column in columns],
        "wells": wells,
        "groups": [{"wells": list(wells), "metadata": {"wellBottomShape": "flat"}}],
    }


@lru_cache(maxsize=None)
def _vendored(load_name: str) -> dict | None:
    path = DEFINITIONS_DIR / f"{load_name}.json"
    return json.loads(path.read_text()) if path.exists() else None


def definition(load_name: str) -> dict | None:
    """The full definition for a load name, or None (unknown, or the agar plate before it is measured)."""
    if load_name == ECHO_LOAD_NAME:
        return echo_384pp_definition()
    if load_name == AGAR_LOAD_NAME:
        return agar_definition()
    return _vendored(load_name)


def summarize(load_name: str, definition_: dict) -> dict:
    """The dimensions the robot relies on, read from the definition (mm above the labware's base)."""
    first = definition_["wells"][definition_["ordering"][0][0]]
    parameters = definition_["parameters"]
    summary = {
        "displayName": definition_["metadata"]["displayName"],
        "namespace": definition_["namespace"],
        "version": definition_["version"],
        "height": definition_["dimensions"]["zDimension"],
        "footprint": [definition_["dimensions"]["xDimension"], definition_["dimensions"]["yDimension"]],
        "wells": len(definition_["wells"]),
        "wellBottom": round(first["z"], 2),
        "wellDepth": first["depth"],
    }
    if parameters.get("isTiprack"):
        summary["tipLength"] = parameters.get("tipLength")
        summary["tipOverlap"] = parameters.get("tipOverlap")
    return summary


def entry(load_name: str) -> dict:
    """Catalog entry with its dimensions; unmeasured agar reports as pending."""
    info = {"loadName": load_name, **CATALOG.get(load_name, {"status": "unknown", "kind": "Labware", "usedBy": [], "checks": []})}
    found = definition(load_name)
    if found:
        info.update(summarize(load_name, found))
    if load_name == AGAR_LOAD_NAME:
        if found:
            info["source"] = f"Built from a filled OmniTray measured {AGAR_MEASURED_ON or 'on site'}: {AGAR_PLATE_HEIGHT_MM} mm tall, agar surface {AGAR_SURFACE_HEIGHT_MM} mm above the base."
            info["verify"] = f"Pour to the same volume: the agar surface must be {AGAR_SURFACE_HEIGHT_MM} mm above the tray's base. A higher surface drives tips into the agar."
        else:
            info.update(status="pending", displayName="Nunc OmniTray agar, 96 spots",
                        source="Waiting for measurements of a filled OmniTray (plate height and agar surface height). Until then the plating tools cannot generate protocols.")
    return info


def agar_plate() -> dict:
    """What the plating tools put in the agar slots: the measured OmniTray, or the placeholder."""
    return entry(AGAR_LOAD_NAME if agar_definition() else AGAR_PLACEHOLDER)


def warehouse() -> dict:
    """Every catalog entry, plus the agar measurements the plating protocols embed."""
    return {
        "labware": [entry(name) for name in CATALOG],
        "agar": {"plate": agar_plate(), "plateHeight": AGAR_PLATE_HEIGHT_MM, "surfaceHeight": AGAR_SURFACE_HEIGHT_MM},
    }
