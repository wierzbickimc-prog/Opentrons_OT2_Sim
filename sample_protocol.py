from opentrons import protocol_api

metadata = {
    "protocolName": "E. coli Colony Rearray - PCR Plate to Omnitrays",
    "author": "OpentronsAI",
    "description": "Rearray 12 source columns into four destination plates.",
}

requirements = {"robotType": "OT-2", "apiLevel": "2.28"}


def run(protocol: protocol_api.ProtocolContext):
    source_plate = protocol.load_labware(
        "opentrons_96_wellplate_200ul_pcr_full_skirt", 5
    )
    destination_plates = [
        protocol.load_labware("corning_96_wellplate_360ul_flat", slot)
        for slot in [1, 2, 3, 4]
    ]
    tiprack = protocol.load_labware("opentrons_96_tiprack_20ul", 6)
    p20_multi = protocol.load_instrument(
        "p20_multi_gen2", "left", tip_racks=[tiprack]
    )

    sample = protocol.define_liquid(
        name="E. coli culture", description="Source culture", display_color="#FFC247"
    )
    for well in source_plate.wells():
        well.load_liquid(liquid=sample, volume=130)

    for source_index, source_col in enumerate(source_plate.columns()):
        source_well = source_col[0]
        destination_plate = destination_plates[source_index // 3]
        start_col = (source_index % 3) * 4
        destination_columns = destination_plate.columns()[start_col : start_col + 4]
        destination_targets = [column[0] for column in destination_columns]

        p20_multi.pick_up_tip()
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, destination_targets[0])
        p20_multi.dispense(10, destination_targets[1])
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, destination_targets[2])
        p20_multi.dispense(10, destination_targets[3])
        p20_multi.drop_tip()
