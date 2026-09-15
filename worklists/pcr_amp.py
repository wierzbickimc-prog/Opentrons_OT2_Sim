"""PCR->AMP plate transfer: 96-well PCR plates into one 384-well Echo plate.

Each PCR plate occupies one quadrant of the Echo 384PP plate. A quadrant is a
row offset (A or B) and a column offset (odd or even), so 96-well row r and
column c land at 384 row 2r-1 (+1) and column 2c-1 (+1). At that spacing the
P300 eight-channel's 9 mm nozzle pitch reaches a whole 96 column in one move:
source column 1 channels A-H dispense into 384 rows A, C, ... O (or B, D, ... P).

The sheet decides where each plate goes (column S); planning checks that every
plate keeps to one quadrant and that no two plates share one.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import Any, Dict, List, Optional, Tuple

MAX_SOURCE_PLATES = 4
MAX_ERRORS = 25
SOURCE_SLOTS = {1: 1, 2: 2, 3: 3, 4: 4}  # PCR plate number -> deck slot
DESTINATION_SLOT = 5
TIP_SLOTS = [7, 8, 10, 11]
TIPS_PER_RACK = 96
CHANNELS = 8
DEFAULT_TRANSFER_UL = 66.0
DEFAULT_STARTING_UL = 65.0
ECHO_WORKING_MAX_UL = 65.0
P300_MIN_UL, TIP_MAX_UL = 20.0, 200.0
PCR_WELL_MAX_UL = 200.0

# Column headers, with the spreadsheet letter used when a sheet has no header row names.
COLUMNS = {
    "source_plate": ("dest_pcr_plate", "Q"),
    "destination_well": ("dest_well_384", "S"),
    "source_well": ("dest_well_96", "T"),
    "destination_plate": ("dest_plate", "AI"),
}
QUADRANTS = {(0, 0): "A1", (1, 0): "B1", (0, 1): "A2", (1, 1): "B2"}
PLATE_SUFFIX = re.compile(r"^(.*)_(\d+)$")
WELL = re.compile(r"^([A-Z])(\d{1,2})$")


class PlanError(ValueError):
    """The sheet or settings cannot produce a protocol; `errors` lists every reason."""

    def __init__(self, errors: List[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def plan_transfer(csv_text: str, identifier: str = "", transfer_volume: float = DEFAULT_TRANSFER_UL,
                  starting_volume: float = DEFAULT_STARTING_UL) -> Dict[str, Any]:
    rows = read_rows(csv_text)
    errors: List[str] = []
    warnings: List[str] = []
    check_volumes(transfer_volume, starting_volume, errors, warnings)

    plates: Dict[int, Dict[str, Any]] = {}
    bases, destinations = set(), set()
    used_destinations: Dict[str, str] = {}
    for line, row in rows:
        where = f"Row {line}"
        plate_name, source_well, destination_well = row["source_plate"], row["source_well"].upper(), row["destination_well"].upper()
        if row["destination_plate"]:
            destinations.add(row["destination_plate"])
        match = PLATE_SUFFIX.match(plate_name)
        if not match:
            errors.append(f"{where}: source plate '{plate_name}' must end in a plate number such as _1.")
            continue
        base, number = match.group(1), int(match.group(2))
        bases.add(base)
        if not 1 <= number <= MAX_SOURCE_PLATES:
            errors.append(f"{where}: {plate_name} is plate {number}; only plates 1-{MAX_SOURCE_PLATES} fit one Echo plate.")
            continue
        source = parse_well(source_well, rows=8, columns=12)
        destination = parse_well(destination_well, rows=16, columns=24)
        if source is None:
            errors.append(f"{where}: '{source_well}' is not a 96-well position.")
        if destination is None:
            errors.append(f"{where}: '{destination_well}' is not a 384-well position.")
        if source is None or destination is None:
            continue
        offset = (destination[0] - 2 * source[0], destination[1] - 2 * source[1])
        if offset not in QUADRANTS:
            errors.append(f"{where}: {plate_name} {source_well} cannot go to {destination_well}; "
                          f"{source_well} belongs at {', '.join(well_name(2 * source[0] + r, 2 * source[1] + c) for (r, c) in QUADRANTS)}.")
            continue
        plate = plates.setdefault(number, {"number": number, "name": plate_name, "offset": offset, "wells": {}, "line": line})
        if plate["name"] != plate_name:
            errors.append(f"{where}: plate {number} is named both {plate['name']} and {plate_name}.")
            continue
        if offset != plate["offset"]:
            errors.append(f"{where}: {plate_name} {source_well} → {destination_well} is in quadrant {QUADRANTS[offset]}, "
                          f"but row {plate['line']} put {plate_name} in quadrant {QUADRANTS[plate['offset']]}.")
            continue
        if source_well in plate["wells"]:
            errors.append(f"{where}: {plate_name} {source_well} is listed more than once.")
            continue
        if destination_well in used_destinations:
            errors.append(f"{where}: destination {destination_well} is already used by {used_destinations[destination_well]}.")
            continue
        plate["wells"][source_well] = destination_well
        used_destinations[destination_well] = f"{plate_name} {source_well}"

    if len(bases) > 1:
        errors.append(f"Source plates come from more than one run: {', '.join(sorted(bases))}.")
    if len(destinations) > 1:
        errors.append(f"The sheet names more than one destination plate: {', '.join(sorted(destinations))}.")
    by_quadrant: Dict[Tuple[int, int], int] = {}
    for number, plate in sorted(plates.items()):
        if plate["offset"] in by_quadrant:
            errors.append(f"{plate['name']} and {plates[by_quadrant[plate['offset']]]['name']} "
                          f"both use quadrant {QUADRANTS[plate['offset']]} of the Echo plate.")
        by_quadrant.setdefault(plate["offset"], number)
    if not plates and not errors:
        errors.append("The sheet has no transfer rows.")
    if errors:
        raise PlanError(errors[:MAX_ERRORS] + ([f"…and {len(errors) - MAX_ERRORS} more."] if len(errors) > MAX_ERRORS else []))

    destination_name = next(iter(destinations), "")
    identifier = (identifier or destination_name or "PCR_AMP_Transfer").strip()[:80]
    transfers = []
    for number, plate in sorted(plates.items()):
        row_offset, column_offset = plate["offset"]
        columns = sorted({parse_well(well, 8, 12)[1] for well in plate["wells"]})
        for column in columns:
            wells = [well_name(r, column) for r in range(8) if well_name(r, column) in plate["wells"]]
            transfers.append({
                "plate": number,
                "column": column + 1,
                "destination": well_name(row_offset, 2 * column + column_offset),
                "wells": wells,
                "destinations": [plate["wells"][well] for well in wells],
            })
        empty = sum(CHANNELS - len(t["wells"]) for t in transfers if t["plate"] == number)
        if empty:
            warnings.append(f"{plate['name']} has {empty} empty well(s) in partially filled columns; those channels aspirate air.")

    tip_racks = math.ceil(len(transfers) * CHANNELS / TIPS_PER_RACK)
    plan = {
        "identifier": identifier,
        "destinationPlate": destination_name,
        "transferVolume": transfer_volume,
        "startingVolume": starting_volume,
        "sampleCount": sum(len(p["wells"]) for p in plates.values()),
        "sourcePlates": [
            {"number": n, "name": p["name"], "slot": SOURCE_SLOTS[n], "quadrant": QUADRANTS[p["offset"]], "samples": len(p["wells"])}
            for n, p in sorted(plates.items())
        ],
        "destinationSlot": DESTINATION_SLOT,
        "tipSlots": TIP_SLOTS[:tip_racks],
        "transfers": transfers,
        "warnings": warnings,
    }
    plan["protocol"] = generate_protocol(plan)
    plan["filename"] = safe_filename(identifier)
    return plan


def check_volumes(transfer: float, starting: float, errors: List[str], warnings: List[str]) -> None:
    for label, value in (("Transfer volume", transfer), ("Starting volume", starting)):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            errors.append(f"{label} must be a number.")
            return
    if not P300_MIN_UL <= transfer <= TIP_MAX_UL:
        errors.append(f"Transfer volume must be {P300_MIN_UL:g}-{TIP_MAX_UL:g} µL for a P300 GEN2 with 200 µL filter tips.")
    if not 0 < starting <= PCR_WELL_MAX_UL:
        errors.append(f"Starting volume must be above 0 and at most {PCR_WELL_MAX_UL:g} µL.")
    if transfer > ECHO_WORKING_MAX_UL:
        warnings.append(f"{transfer:g} µL is above the Echo 384PP working maximum of {ECHO_WORKING_MAX_UL:g} µL; "
                        f"each well receives at most the {min(transfer, starting):g} µL the PCR well holds.")
    if starting > ECHO_WORKING_MAX_UL and transfer >= starting:
        warnings.append(f"Emptying {starting:g} µL PCR wells overfills the Echo 384PP working maximum of {ECHO_WORKING_MAX_UL:g} µL.")
    if transfer < starting:
        warnings.append(f"{starting - transfer:g} µL is left behind in each PCR well.")


def read_rows(csv_text: str) -> List[Tuple[int, Dict[str, str]]]:
    reader = csv.reader(io.StringIO(csv_text.lstrip("﻿")))
    try:
        header = [cell.strip().lower() for cell in next(reader)]
    except StopIteration as exc:
        raise PlanError(["The CSV file is empty."]) from exc
    indexes, missing = {}, []
    for key, (name, letter) in COLUMNS.items():
        if name in header:
            indexes[key] = header.index(name)
        elif key == "destination_plate":
            indexes[key] = None  # optional: only used to name the work list
        else:
            missing.append(f"{name} (column {letter})")
    if missing:
        raise PlanError([f"The CSV is missing required column(s): {', '.join(missing)}."])
    rows = []
    for line, cells in enumerate(reader, start=2):
        if not any(cell.strip() for cell in cells):
            continue
        rows.append((line, {key: (cells[i].strip() if i is not None and i < len(cells) else "") for key, i in indexes.items()}))
    return rows


def parse_well(name: str, rows: int, columns: int) -> Optional[Tuple[int, int]]:
    match = WELL.match(name)
    if not match:
        return None
    row, column = ord(match.group(1)) - ord("A"), int(match.group(2)) - 1
    return (row, column) if 0 <= row < rows and 0 <= column < columns else None


def well_name(row: int, column: int) -> str:
    return f"{chr(ord('A') + row)}{column + 1}"


def safe_filename(identifier: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", identifier.strip()).strip("_.")
    return f"{cleaned or 'PCR_AMP_Transfer'}.py"


def py(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def generate_protocol(plan: Dict[str, Any]) -> str:
    plates = plan["sourcePlates"]
    transfer_lines = "\n".join(
        f'    ({t["plate"]}, {t["column"]}, {py(t["destination"])}),  # {", ".join(t["wells"])}' for t in plan["transfers"]
    )
    sample_wells = {p["number"]: [] for p in plates}
    for t in plan["transfers"]:
        sample_wells[t["plate"]].extend(t["wells"])
    sample_lines = "\n".join(f"    {n}: {py(wells)}," for n, wells in sample_wells.items())
    return f'''from opentrons import protocol_api

metadata = {{
    "protocolName": {py("PCR->AMP plate transfer - " + plan["identifier"])},
    "author": "OT-2 Manufacturing Tools",
    "description": {py(f'{plan["sampleCount"]} PCR wells from {len(plates)} 96-well plate(s) into one Echo 384PP plate')},
    "worklistId": {py(plan["identifier"])},
}}

requirements = {{"robotType": "OT-2", "apiLevel": "2.28"}}

WORKLIST_ID = {py(plan["identifier"])}
DESTINATION_PLATE = {py(plan["destinationPlate"] or plan["identifier"])}
TRANSFER_VOLUME = {plan["transferVolume"]:g}
STARTING_VOLUME = {plan["startingVolume"]:g}
# Dispense this far below the top of the 384 well, near the final liquid surface.
DISPENSE_DEPTH_MM = 4
SOURCE_PLATES = {{
{chr(10).join(f"    {p['number']}: ({py(p['name'])}, {p['slot']}),  # quadrant {p['quadrant']}" for p in plates)}
}}
DESTINATION_SLOT = {plan["destinationSlot"]}
TIP_SLOTS = {py(plan["tipSlots"])}

# (PCR plate number, source column, Echo well under channel 1). Channels 1-8
# cover rows A-H of the source column and every other 384 row from that well.
TRANSFERS = [
{transfer_lines}
]
SAMPLE_WELLS = {{
{sample_lines}
}}


def echo_384pp_definition():
    """Labcyte Echo Qualified 384-Well Polypropylene (384PP) plate.

    Nominal SLAS 384-well geometry: verify against a physical plate and
    calibrate labware offsets in the OT-2 App before the first run.
    """
    rows, columns = "ABCDEFGHIJKLMNOP", range(1, 25)
    height, depth, side = 14.4, 11.5, 3.7
    wells = {{
        f"{{row}}{{column}}": {{
            "shape": "rectangular", "depth": depth, "xDimension": side, "yDimension": side,
            "totalLiquidVolume": 65, "x": round(12.13 + 4.5 * (column - 1), 2),
            "y": round(76.49 - 4.5 * index, 2), "z": round(height - depth, 2),
        }}
        for index, row in enumerate(rows)
        for column in columns
    }}
    return {{
        "schemaVersion": 2, "version": 1, "namespace": "custom_beta",
        "metadata": {{"displayName": "Labcyte Echo 384PP (nominal)", "displayCategory": "wellPlate", "displayVolumeUnits": "µL", "tags": []}},
        "brand": {{"brand": "Labcyte", "brandId": ["PP-0200"]}},
        "parameters": {{"format": "384Standard", "isTiprack": False, "isMagneticModuleCompatible": False, "loadName": "labcyte_echo_384pp"}},
        "dimensions": {{"xDimension": 127.76, "yDimension": 85.48, "zDimension": height}},
        "cornerOffsetFromSlot": {{"x": 0, "y": 0, "z": 0}},
        "ordering": [[f"{{row}}{{column}}" for row in rows] for column in columns],
        "wells": wells,
        "groups": [{{"wells": list(wells), "metadata": {{"wellBottomShape": "flat"}}}}],
    }}


def run(protocol: protocol_api.ProtocolContext):
    source_plates = {{
        number: protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", slot, label=name)
        for number, (name, slot) in SOURCE_PLATES.items()
    }}
    echo_plate = protocol.load_labware_from_definition(echo_384pp_definition(), DESTINATION_SLOT, label=DESTINATION_PLATE)
    tip_racks = [protocol.load_labware("opentrons_96_filtertiprack_200ul", slot) for slot in TIP_SLOTS]
    p300_multi = protocol.load_instrument("p300_multi_gen2", "left", tip_racks=tip_racks)

    pcr_product = protocol.define_liquid(name="PCR product", description=WORKLIST_ID, display_color="#F000DC")
    for number, wells in SAMPLE_WELLS.items():
        source_plates[number].load_liquid(wells=wells, volume=STARTING_VOLUME, liquid=pcr_product)

    # A partially filled column still uses all eight tips; channels over empty
    # source wells aspirate air. Tips are discarded after every transfer.
    for plate_number, column, destination_well in TRANSFERS:
        source = source_plates[plate_number].columns_by_name()[str(column)][0]
        destination = echo_plate[destination_well]
        p300_multi.pick_up_tip()
        p300_multi.aspirate(TRANSFER_VOLUME, source)
        p300_multi.dispense(TRANSFER_VOLUME, destination.top(z=-DISPENSE_DEPTH_MM))
        p300_multi.drop_tip()
'''
