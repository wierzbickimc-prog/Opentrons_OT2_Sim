from opentrons import protocol_api

metadata = {
    "protocolName": "MFG_Hybrid_Plating - MFG-HYBRID-TEST-13",
    "author": "OT-2 Manufacturing Tools",
    "description": "10, 10, 3 + 7 water and 1 + 9 water uL spots for 13 constructs",
    "worklistId": "MFG-HYBRID-TEST-13",
}

requirements = {"robotType": "OT-2", "apiLevel": "2.28"}

WORKLIST_ID = "MFG-HYBRID-TEST-13"
CONSTRUCT_COUNT = 13
STARTING_VOLUME = 130
SOURCE_SLOTS = [7]
TIP_SLOTS = [10]
DESTINATION_SLOTS = [1]
RESERVOIR_SLOT = 9
# The operator fills the reservoir to its line; this volume only drives liquid tracking.
RESERVOIR_VOLUME = 100000
# Water under spots 3 and 4, drawn with a little extra that is blown back into the reservoir.
WATER_SPOT_3 = 7
WATER_SPOT_4 = 9
WATER_OVERDRAW = 2
# Culture for spots 3 and 4 goes into the water drop, this far above the agar, with no blow-out.
SPOT_HEIGHT_MM = 1


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
    reservoir = protocol.load_labware("nest_1_reservoir_195ml", RESERVOIR_SLOT)
    p20_multi = protocol.load_instrument("p20_multi_gen2", "left", tip_racks=tip_racks)

    culture = protocol.define_liquid(
        name="E. coli culture", description=WORKLIST_ID, display_color="#F000DC"
    )
    water = protocol.define_liquid(
        name="Water", description="Fill to the reservoir line", display_color="#41D8F2"
    )
    # wells() follows column-major order: A1-H1, then A2-H2.
    for construct_index in range(CONSTRUCT_COUNT):
        plate_index = construct_index // 96
        local_well_index = construct_index % 96
        source_plates[plate_index].wells()[local_well_index].load_liquid(
            liquid=culture, volume=STARTING_VOLUME
        )
    reservoir["A1"].load_liquid(liquid=water, volume=RESERVOIR_VOLUME)

    source_column_count = (CONSTRUCT_COUNT + 7) // 8

    def spots(global_source_column):
        destination_plate_index = global_source_column // 3
        first_destination_column = (global_source_column % 3) * 4
        destination_columns = destination_plates[destination_plate_index].columns()[
            first_destination_column:first_destination_column + 4
        ]
        return [column[0] for column in destination_columns]

    # All water first. These tips only touch the reservoir and clean agar, so
    # one set serves every column.
    p20_multi.pick_up_tip()
    for global_source_column in range(source_column_count):
        targets = spots(global_source_column)
        p20_multi.aspirate(WATER_SPOT_3 + WATER_SPOT_4 + WATER_OVERDRAW, reservoir["A1"])
        p20_multi.dispense(WATER_SPOT_3, targets[2].bottom(SPOT_HEIGHT_MM))
        p20_multi.dispense(WATER_SPOT_4, targets[3].bottom(SPOT_HEIGHT_MM))
        p20_multi.blow_out(reservoir["A1"].top())
    p20_multi.drop_tip()

    # Culture follows the water's column order, so the oldest drops are filled first.
    for global_source_column in range(source_column_count):
        source_plate_index = global_source_column // 12
        local_source_column = global_source_column % 12
        source_well = source_plates[source_plate_index].columns()[local_source_column][0]
        targets = spots(global_source_column)

        # A partial final column intentionally uses all eight tips. Channels
        # aligned with unoccupied source wells will aspirate air.
        p20_multi.pick_up_tip()
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, targets[0])
        p20_multi.dispense(10, targets[1])
        p20_multi.aspirate(4, source_well)
        p20_multi.dispense(3, targets[2].bottom(SPOT_HEIGHT_MM))
        p20_multi.dispense(1, targets[3].bottom(SPOT_HEIGHT_MM))
        p20_multi.drop_tip()
