from opentrons import protocol_api

metadata = {
    "protocolName": "MFG_Plating - MFG-TEST-13",
    "author": "OT-2 Manufacturing Tools",
    "description": "Four 10 uL destination replicates for 13 constructs",
    "worklistId": "MFG-TEST-13",
}

requirements = {"robotType": "OT-2", "apiLevel": "2.28"}

WORKLIST_ID = "MFG-TEST-13"
CONSTRUCT_COUNT = 13
STARTING_VOLUME = 130
SOURCE_SLOTS = [7]
TIP_SLOTS = [10]
DESTINATION_SLOTS = [1]


def run(protocol: protocol_api.ProtocolContext):
    source_plates = [
        protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", slot)
        for slot in SOURCE_SLOTS
    ]
    destination_plates = [
        protocol.load_labware("corning_96_wellplate_360ul_flat", slot)
        for slot in DESTINATION_SLOTS
    ]
    tip_racks = [
        protocol.load_labware("opentrons_96_tiprack_20ul", slot)
        for slot in TIP_SLOTS
    ]
    p20_multi = protocol.load_instrument("p20_multi_gen2", "left", tip_racks=tip_racks)

    culture = protocol.define_liquid(
        name="E. coli culture", description=WORKLIST_ID, display_color="#F000DC"
    )
    # wells() follows column-major order: A1-H1, then A2-H2.
    for construct_index in range(CONSTRUCT_COUNT):
        plate_index = construct_index // 96
        local_well_index = construct_index % 96
        source_plates[plate_index].wells()[local_well_index].load_liquid(
            liquid=culture, volume=STARTING_VOLUME
        )

    source_column_count = (CONSTRUCT_COUNT + 7) // 8
    for global_source_column in range(source_column_count):
        source_plate_index = global_source_column // 12
        local_source_column = global_source_column % 12
        source_well = source_plates[source_plate_index].columns()[local_source_column][0]

        destination_plate_index = global_source_column // 3
        first_destination_column = (global_source_column % 3) * 4
        destination_columns = destination_plates[destination_plate_index].columns()[
            first_destination_column:first_destination_column + 4
        ]
        destination_targets = [column[0] for column in destination_columns]

        # A partial final column intentionally uses all eight tips. Channels
        # aligned with unoccupied source wells will aspirate air.
        p20_multi.pick_up_tip()
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, destination_targets[0])
        p20_multi.dispense(10, destination_targets[1])
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, destination_targets[2])
        p20_multi.dispense(10, destination_targets[3])
        p20_multi.drop_tip()
