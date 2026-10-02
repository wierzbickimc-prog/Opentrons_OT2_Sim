"""MFG_plating_template: plate constructs from a plating template CSV.

Each source column is spotted by the P20 eight-channel onto one third of an
agar OmniTray: channel A-H into agar rows A-H, spots 1-4 in four consecutive
agar columns. The sheet names the agar plate for every construct (r_agar, the
_n suffix is the plate number), so a plate may hold fewer than three columns.

Every spot ends at 10 uL. A conc spot is 10 uL culture; a dil spot is 9 uL
water laid down first, then 1 uL culture into the drop. One column moves as a
unit, so when its constructs ask for different spot 2 or 3 types the whole
column gets 7 uL water + 3 uL culture and the operator is told.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import Any, Dict, List, Optional, Tuple

from worklists import labware

MAX_ERRORS = 25
MAX_SOURCE_PLATES = 2
MAX_AGAR_PLATES = 6
COLUMNS_PER_AGAR_PLATE = 3
SOURCE_SLOTS = [7, 8]
AGAR_SLOTS = [1, 2, 3, 4, 5, 6]
RESERVOIR_SLOT = 9
TIP_SLOTS = [10, 11]
CHANNELS = 8
STARTING_UL = 130
WATER_OVERDRAW_UL = 2

# Culture and water per spot type; every spot ends at 10 uL.
CULTURE_UL = {"conc": 10, "mixed": 3, "dil": 1}
WATER_UL = {"conc": 0, "mixed": 7, "dil": 9}
SPOT_LABELS = {"conc": "10 µL", "mixed": "3 + 7 water", "dil": "1 + 9 water"}

COLUMNS = {
    "id": "r_id",
    "well": "r_well",
    "antibiotic": "r_abx",
    "agar": "r_agar",
    "spot_1": "spot_1",
    "spot_2": "spot_2",
    "spot_3": "spot_3",
    "spot_4": "spot_4",
}
NUMBER_SUFFIX = re.compile(r"^(.*)_(\d+)$")
WELL = re.compile(r"^([A-H])(\d{1,2})$")


class PlanError(ValueError):
    """The sheet cannot produce a protocol; `errors` lists every reason."""

    def __init__(self, errors: List[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def plan_plating(csv_text: str, identifier: str = "") -> Dict[str, Any]:
    rows = read_rows(csv_text)
    errors: List[str] = []
    prefixes = set()
    wells: Dict[Tuple[int, str], Dict[str, Any]] = {}
    for line, row in rows:
        where = f"Row {line} ({row['id'] or 'no r_id'})"
        id_match = NUMBER_SUFFIX.match(row["id"])
        agar_match = NUMBER_SUFFIX.match(row["agar"])
        well = row["well"].upper()
        spots = [row[f"spot_{n}"].lower() for n in range(1, 5)]
        problems = []
        if not id_match:
            problems.append(f"r_id '{row['id']}' must end in a construct number such as _1.")
        elif int(id_match.group(2)) < 1:
            problems.append(f"r_id '{row['id']}' must number constructs from _1.")
        if not WELL.match(well) or not 1 <= int(WELL.match(well).group(2)) <= 12:
            problems.append(f"'{row['well']}' is not a 96-well position.")
        if not agar_match:
            problems.append(f"r_agar '{row['agar']}' must end in a plate number such as _1.")
        if not row["antibiotic"]:
            problems.append("r_abx is empty.")
        bad = [f"Spot_{n} '{value}'" for n, value in enumerate(spots, start=1) if value not in ("conc", "dil")]
        if bad:
            problems.append(f"{', '.join(bad)} must be conc or dil.")
        else:
            if spots[0] != "conc":
                problems.append("Spot_1 must be conc.")
            if spots[3] != "dil":
                problems.append("Spot_4 must be dil.")
            if spots[1] == "dil" and spots[2] != "dil":
                problems.append("Spot_3 must be dil when Spot_2 is dil.")
        if problems:
            errors.extend(f"{where}: {problem}" for problem in problems)
            continue
        # Constructs _97 and up are on the next source plate.
        source = (int(id_match.group(2)) - 1) // 96 + 1
        if source > MAX_SOURCE_PLATES:
            errors.append(f"{where}: construct {id_match.group(2)} would be on source plate {source}; only {MAX_SOURCE_PLATES} fit the deck.")
            continue
        if (source, well) in wells:
            errors.append(f"{where}: source plate {source} {well} is already used by {wells[(source, well)]['id']}.")
            continue
        prefixes.add(agar_match.group(1))
        wells[(source, well)] = {
            "id": row["id"], "line": line, "source": source, "well": well,
            "row": ord(well[0]) - ord("A"), "column": int(well[1:]),
            "agar": int(agar_match.group(2)), "agarName": row["agar"], "antibiotic": row["antibiotic"], "spots": spots,
        }

    if len(prefixes) > 1:
        errors.append(f"r_agar names come from more than one experiment: {', '.join(sorted(prefixes))}.")
    if not wells and not errors:
        errors.append("The sheet has no construct rows.")
    if errors:
        raise_errors(errors)

    columns = group_columns(wells, errors)
    agar_plates = place_agar_plates(columns, wells, errors)
    if errors:
        raise_errors(errors)
    definition = labware.agar_definition()
    if definition is None:
        raise PlanError(["The agar OmniTray has no definition yet. Measure a filled plate (see Labware Warehouse)."])

    notices, warnings = [], []
    for column in columns:
        members = [wells[(column["source"], name)] for name in column["wells"]]
        column["spots"] = []
        for spot in range(4):
            by_type = {kind: [m["well"] for m in members if m["spots"][spot] == kind] for kind in ("conc", "dil")}
            kinds = [kind for kind, names in by_type.items() if names]
            column["spots"].append(kinds[0] if len(kinds) == 1 else "mixed")
            if len(kinds) > 1:
                notices.append(f"{column['label']}, Spot {spot + 1}: {', '.join(by_type['conc'])} conc; {', '.join(by_type['dil'])} dil. "
                               f"Every well in the column gets 3 µL culture + 7 µL water (30%).")
        if len(members) < CHANNELS:
            warnings.append(f"{column['label']} has {CHANNELS - len(members)} empty well(s); those channels aspirate air and spot nothing.")
    numbers = [plate["number"] for plate in agar_plates]
    missing = sorted(set(range(1, max(numbers) + 1)) - set(numbers))
    if missing:
        prefix = next(iter(prefixes))
        warnings.append(f"The sheet has no {', '.join(f'{prefix}_{n}' for n in missing)}; the plates are loaded in slots 1-{len(agar_plates)} in order.")

    prefix = next(iter(prefixes))
    identifier = (identifier or prefix or "MFG_plating_template").strip()[:80]
    source_numbers = sorted({column["source"] for column in columns})
    tip_columns = len(columns) + 1
    water_ul = sum(WATER_UL[kind] for column in columns for kind in column["spots"]) * CHANNELS
    plan = {
        "identifier": identifier,
        "experiment": prefix,
        "constructCount": len(wells),
        "sourcePlates": [
            {"number": n, "slot": SOURCE_SLOTS[n - 1], "constructs": sum(1 for w in wells.values() if w["source"] == n)}
            for n in source_numbers
        ],
        "agarPlates": agar_plates,
        "columns": columns,
        "reservoirSlot": RESERVOIR_SLOT,
        "tipColumns": tip_columns,
        "tipSlots": TIP_SLOTS[:math.ceil(tip_columns / 12)],
        "waterMl": round(water_ul / 1000, 1),
        "notices": notices,
        "warnings": warnings,
    }
    agar_load_name = labware.agar_plate()["loadName"]
    plan["labware"] = [
        {"role": "Tip rack", "slots": plan["tipSlots"], "loadName": "opentrons_96_tiprack_20ul"},
        {"role": "Source PCR plate", "slots": [p["slot"] for p in plan["sourcePlates"]], "loadName": "opentrons_96_wellplate_200ul_pcr_full_skirt"},
        *[{"role": f"{p['name']}, {p['antibiotic']} agar", "slots": [p["slot"]], "loadName": agar_load_name} for p in agar_plates],
        {"role": "Water reservoir", "slots": [RESERVOIR_SLOT], "loadName": "nest_1_reservoir_195ml"},
        {"role": "Fixed trash", "slots": [12], "loadName": "opentrons_1_trash_1100ml_fixed"},
    ]
    plan["pipettes"] = [{"name": "p20_multi_gen2", "label": "P20 8-Channel GEN2", "mount": "left"}]
    plan["protocol"] = generate_protocol(plan, wells)
    plan["filename"] = safe_filename(identifier)
    return plan


def group_columns(wells: Dict[Tuple[int, str], Dict[str, Any]], errors: List[str]) -> List[Dict[str, Any]]:
    """One entry per occupied source column, in source order; a column must belong to one agar plate."""
    columns: Dict[Tuple[int, int], List[Dict[str, Any]]] = {}
    for member in wells.values():
        columns.setdefault((member["source"], member["column"]), []).append(member)
    two_sources = any(source > 1 for source, _ in columns)
    result = []
    for (source, number), members in sorted(columns.items()):
        members.sort(key=lambda m: m["row"])
        label = f"Source {source} column {number}" if two_sources else f"Source column {number}"
        names = sorted({m["agarName"] for m in members}, key=lambda name: next(m["agar"] for m in members if m["agarName"] == name))
        if len(names) > 1:
            parts = [f"{name} ({', '.join(m['well'] for m in members if m['agarName'] == name)})" for name in names]
            errors.append(f"{label} holds constructs for more than one agar plate: {'; '.join(parts)}. "
                          f"The eight-channel spots a whole column onto one plate, so a plate change must start a new column: "
                          f"leave the rest of column {number} empty and move the later constructs to the next column.")
            continue
        result.append({"source": source, "column": number, "label": label, "wells": [m["well"] for m in members],
                       "agar": members[0]["agar"], "agarName": names[0]})
    return result


def place_agar_plates(columns: List[Dict[str, Any]], wells: Dict[Tuple[int, str], Dict[str, Any]], errors: List[str]) -> List[Dict[str, Any]]:
    """Agar plates in plate-number order; each fills left, middle, right in source column order."""
    plates: Dict[int, Dict[str, Any]] = {}
    for member in wells.values():
        plate = plates.setdefault(member["agar"], {"number": member["agar"], "name": member["agarName"], "antibiotics": {}, "constructs": 0})
        plate["antibiotics"].setdefault(member["antibiotic"], []).append(member["well"])
        plate["constructs"] += 1
    for plate in plates.values():
        if len(plate["antibiotics"]) > 1:
            listed = "; ".join(f"{abx} ({len(found)} construct{'s' if len(found) > 1 else ''})" for abx, found in plate["antibiotics"].items())
            errors.append(f"{plate['name']} lists more than one antibiotic: {listed}. One agar plate has one antibiotic.")
    if len(plates) > MAX_AGAR_PLATES:
        errors.append(f"The sheet needs {len(plates)} agar plates; the deck holds {MAX_AGAR_PLATES} (slots 1-6). Split it into two runs.")
    previous = None
    for column in columns:
        if previous and column["agar"] < previous["agar"]:
            errors.append(f"{column['label']} goes to {column['agarName']} after {previous['label']} went to {previous['agarName']}; "
                          f"agar plates must follow source column order.")
        previous = column
    result = []
    for slot_index, (number, plate) in enumerate(sorted(plates.items())):
        on_plate = [c for c in columns if c["agar"] == number]
        if len(on_plate) > COLUMNS_PER_AGAR_PLATE:
            errors.append(f"{plate['name']} gets {len(on_plate)} source columns ({', '.join(str(c['column']) for c in on_plate)}); "
                          f"an agar plate holds {COLUMNS_PER_AGAR_PLATE} (24 constructs).")
            continue
        for position, column in enumerate(on_plate):
            column["position"] = position
            column["agarColumns"] = [position * 4 + n for n in range(1, 5)]
        result.append({
            "number": number, "name": plate["name"], "antibiotic": next(iter(plate["antibiotics"])),
            "slot": AGAR_SLOTS[slot_index] if slot_index < len(AGAR_SLOTS) else None,
            "constructs": plate["constructs"], "sourceColumns": len(on_plate),
        })
    return result


def raise_errors(errors: List[str]) -> None:
    raise PlanError(errors[:MAX_ERRORS] + ([f"…and {len(errors) - MAX_ERRORS} more."] if len(errors) > MAX_ERRORS else []))


def read_rows(csv_text: str) -> List[Tuple[int, Dict[str, str]]]:
    reader = csv.reader(io.StringIO(csv_text.lstrip("﻿")))
    try:
        header = [cell.strip().lower() for cell in next(reader)]
    except StopIteration as exc:
        raise PlanError(["The CSV file is empty."]) from exc
    missing = [name for name in COLUMNS.values() if name not in header]
    if missing:
        raise PlanError([f"The CSV is missing required column(s): {', '.join(missing)}."])
    indexes = {key: header.index(name) for key, name in COLUMNS.items()}
    rows = []
    for line, cells in enumerate(reader, start=2):
        if not any(cell.strip() for cell in cells):
            continue
        rows.append((line, {key: (cells[i].strip() if i < len(cells) else "") for key, i in indexes.items()}))
    return rows


def safe_filename(identifier: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", identifier.strip()).strip("_.")
    return f"{cleaned or 'MFG_plating_template'}.py"


def py(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def generate_protocol(plan: Dict[str, Any], wells: Dict[Tuple[int, str], Dict[str, Any]]) -> str:
    agar_lines = "\n".join(f"    {p['number']}: ({py(p['name'])}, {py(p['antibiotic'])}, {p['slot']})," for p in plan["agarPlates"])
    column_lines = "\n".join(
        f"    ({c['source']}, {c['column']}, {c['agar']}, {c['agarColumns'][0]}, ({', '.join(py(s) for s in c['spots'])})),  # {', '.join(c['wells'])}"
        for c in plan["columns"]
    )
    sample_lines = "\n".join(
        f"    {p['number']}: {py([w['well'] for w in sorted(wells.values(), key=lambda w: (w['column'], w['row'])) if w['source'] == p['number']])},"
        for p in plan["sourcePlates"]
    )
    notice_lines = "".join(f"\n    {py(notice)}," for notice in plan["notices"]) + ("\n" if plan["notices"] else "")
    agar = labware.agar_definition_python(labware.AGAR_PLATE_HEIGHT_MM, labware.AGAR_SURFACE_HEIGHT_MM)
    return f'''from opentrons import protocol_api

metadata = {{
    "protocolName": {py("MFG_plating_template - " + plan["identifier"])},
    "author": "OT-2 Manufacturing Tools",
    "description": {py(f'{plan["constructCount"]} constructs onto {len(plan["agarPlates"])} agar plate(s), four 10 uL spots each')},
    "worklistId": {py(plan["identifier"])},
}}

requirements = {{"robotType": "OT-2", "apiLevel": "2.28"}}

WORKLIST_ID = {py(plan["identifier"])}
STARTING_VOLUME = {STARTING_UL}
SOURCE_SLOTS = {{{", ".join(f"{p['number']}: {p['slot']}" for p in plan["sourcePlates"])}}}
# Agar plate number: (name, antibiotic, deck slot).
AGAR_PLATES = {{
{agar_lines}
}}
TIP_SLOTS = {py(plan["tipSlots"])}
RESERVOIR_SLOT = {RESERVOIR_SLOT}
# The operator fills the reservoir to its line; this volume only drives liquid tracking.
RESERVOIR_VOLUME = 100000
# Every spot ends at 10 uL. Water goes down first; culture follows into the drop.
CULTURE_UL = {{"conc": {CULTURE_UL["conc"]}, "mixed": {CULTURE_UL["mixed"]}, "dil": {CULTURE_UL["dil"]}}}
WATER_UL = {{"conc": {WATER_UL["conc"]}, "mixed": {WATER_UL["mixed"]}, "dil": {WATER_UL["dil"]}}}
# Water is drawn with a little extra that is blown back into the reservoir.
WATER_OVERDRAW = {WATER_OVERDRAW_UL}
TIP_MAX = 20
# Spots are dispensed this far above the agar, with no blow-out.
SPOT_HEIGHT_MM = 1

# (source plate, source column, agar plate, first agar column, spot 1-4 types).
# Channels A-H of the source column spot rows A-H of four agar columns.
COLUMNS = [
{column_lines}
]
SAMPLE_WELLS = {{
{sample_lines}
}}
# Columns whose constructs asked for different spot types: the whole column gets the 30% spot.
NOTICES = [{notice_lines}]


{agar}

def draws(dispenses, capacity):
    """Group (target, volume) dispenses, in order, into aspirations of at most `capacity` uL."""
    groups = []
    for target, volume in dispenses:
        if not groups or sum(v for _, v in groups[-1]) + volume > capacity:
            groups.append([])
        groups[-1].append((target, volume))
    return groups


def run(protocol: protocol_api.ProtocolContext):
    for notice in NOTICES:
        protocol.comment(notice)
    source_plates = {{
        number: protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", slot, label=f"Source plate {{number}}")
        for number, slot in SOURCE_SLOTS.items()
    }}
    agar_plates = {{
        number: protocol.load_labware_from_definition(agar_definition(), slot, label=f"{{name}} ({{antibiotic}})")
        for number, (name, antibiotic, slot) in AGAR_PLATES.items()
    }}
    tip_racks = [protocol.load_labware("opentrons_96_tiprack_20ul", slot) for slot in TIP_SLOTS]
    reservoir = protocol.load_labware("nest_1_reservoir_195ml", RESERVOIR_SLOT)
    p20_multi = protocol.load_instrument("p20_multi_gen2", "left", tip_racks=tip_racks)

    culture = protocol.define_liquid(name="E. coli culture", description=WORKLIST_ID, display_color="#F000DC")
    water = protocol.define_liquid(name="Water", description="Fill to the reservoir line", display_color="#41D8F2")
    for number, wells in SAMPLE_WELLS.items():
        source_plates[number].load_liquid(wells=wells, volume=STARTING_VOLUME, liquid=culture)
    reservoir["A1"].load_liquid(liquid=water, volume=RESERVOIR_VOLUME)

    def spots(agar_plate, first_agar_column):
        columns = agar_plates[agar_plate].columns()[first_agar_column - 1:first_agar_column + 3]
        return [column[0].bottom(SPOT_HEIGHT_MM) for column in columns]

    # All water first. These tips only touch the reservoir and clean agar, so
    # one set serves every column.
    p20_multi.pick_up_tip()
    for _source, _column, agar_plate, first_agar_column, spot_types in COLUMNS:
        targets = spots(agar_plate, first_agar_column)
        water_spots = [(target, WATER_UL[kind]) for target, kind in zip(targets, spot_types) if WATER_UL[kind]]
        for group in draws(water_spots, TIP_MAX - WATER_OVERDRAW):
            p20_multi.aspirate(sum(volume for _, volume in group) + WATER_OVERDRAW, reservoir["A1"])
            for target, volume in group:
                p20_multi.dispense(volume, target)
            p20_multi.blow_out(reservoir["A1"].top())
    p20_multi.drop_tip()

    # Culture follows the water's column order, so the oldest drops are filled
    # first. A partial column still uses all eight tips; channels over empty
    # source wells aspirate air.
    for source, column, agar_plate, first_agar_column, spot_types in COLUMNS:
        source_well = source_plates[source].columns_by_name()[str(column)][0]
        targets = spots(agar_plate, first_agar_column)
        p20_multi.pick_up_tip()
        for group in draws([(target, CULTURE_UL[kind]) for target, kind in zip(targets, spot_types)], TIP_MAX):
            p20_multi.aspirate(sum(volume for _, volume in group), source_well)
            for target, volume in group:
                p20_multi.dispense(volume, target)
        p20_multi.drop_tip()
'''
