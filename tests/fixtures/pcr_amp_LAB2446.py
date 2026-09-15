from opentrons import protocol_api

metadata = {
    "protocolName": "PCR->AMP plate transfer - LAB2446_AMP",
    "author": "OT-2 Manufacturing Tools",
    "description": "113 PCR wells from 2 96-well plate(s) into one Echo 384PP plate",
    "worklistId": "LAB2446_AMP",
}

requirements = {"robotType": "OT-2", "apiLevel": "2.28"}

WORKLIST_ID = "LAB2446_AMP"
DESTINATION_PLATE = "LAB2446_AMP"
TRANSFER_VOLUME = 66
STARTING_VOLUME = 65
# Dispense this far below the top of the 384 well, near the final liquid surface.
DISPENSE_DEPTH_MM = 4
SOURCE_PLATES = {
    1: ("LAB2446_PCR_1", 1),  # quadrant A1
    2: ("LAB2446_PCR_2", 2),  # quadrant A2
}
DESTINATION_SLOT = 5
TIP_SLOTS = [7, 8]

# (PCR plate number, source column, Echo well under channel 1). Channels 1-8
# cover rows A-H of the source column and every other 384 row from that well.
TRANSFERS = [
    (1, 1, "A1"),  # A1, B1, C1, D1, E1, F1, G1, H1
    (1, 2, "A3"),  # A2, B2, C2, D2, E2, F2, G2, H2
    (1, 3, "A5"),  # A3, B3, C3, D3, E3, F3, G3, H3
    (1, 4, "A7"),  # A4, B4, C4, D4, E4, F4, G4, H4
    (1, 5, "A9"),  # A5, B5, C5, D5, E5, F5, G5, H5
    (1, 6, "A11"),  # A6, B6, C6, D6, E6, F6, G6, H6
    (1, 7, "A13"),  # A7, B7, C7, D7, E7, F7, G7, H7
    (1, 8, "A15"),  # A8, B8, C8, D8, E8, F8, G8, H8
    (1, 9, "A17"),  # A9, B9, C9, D9, E9, F9, G9, H9
    (1, 10, "A19"),  # A10, B10, C10, D10, E10, F10, G10, H10
    (1, 11, "A21"),  # A11, B11, C11, D11, E11, F11, G11, H11
    (1, 12, "A23"),  # A12, B12, C12, D12, E12, F12
    (2, 1, "A2"),  # A1, B1, C1, D1, E1, F1, G1, H1
    (2, 2, "A4"),  # A2, B2, C2, D2, E2, F2, G2, H2
    (2, 3, "A6"),  # A3, B3, C3
]
SAMPLE_WELLS = {
    1: ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "A2", "B2", "C2", "D2", "E2", "F2", "G2", "H2", "A3", "B3", "C3", "D3", "E3", "F3", "G3", "H3", "A4", "B4", "C4", "D4", "E4", "F4", "G4", "H4", "A5", "B5", "C5", "D5", "E5", "F5", "G5", "H5", "A6", "B6", "C6", "D6", "E6", "F6", "G6", "H6", "A7", "B7", "C7", "D7", "E7", "F7", "G7", "H7", "A8", "B8", "C8", "D8", "E8", "F8", "G8", "H8", "A9", "B9", "C9", "D9", "E9", "F9", "G9", "H9", "A10", "B10", "C10", "D10", "E10", "F10", "G10", "H10", "A11", "B11", "C11", "D11", "E11", "F11", "G11", "H11", "A12", "B12", "C12", "D12", "E12", "F12"],
    2: ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "A2", "B2", "C2", "D2", "E2", "F2", "G2", "H2", "A3", "B3", "C3"],
}


def echo_384pp_definition():
    """Labcyte Echo Qualified 384-Well Polypropylene (384PP) plate.

    Nominal SLAS 384-well geometry: verify against a physical plate and
    calibrate labware offsets in the OT-2 App before the first run.
    """
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
        "parameters": {"format": "384Standard", "isTiprack": False, "isMagneticModuleCompatible": False, "loadName": "labcyte_echo_384pp"},
        "dimensions": {"xDimension": 127.76, "yDimension": 85.48, "zDimension": height},
        "cornerOffsetFromSlot": {"x": 0, "y": 0, "z": 0},
        "ordering": [[f"{row}{column}" for row in rows] for column in columns],
        "wells": wells,
        "groups": [{"wells": list(wells), "metadata": {"wellBottomShape": "flat"}}],
    }


def run(protocol: protocol_api.ProtocolContext):
    source_plates = {
        number: protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", slot, label=name)
        for number, (name, slot) in SOURCE_PLATES.items()
    }
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
