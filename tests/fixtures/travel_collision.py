"""Fixture: a direct move between plates drags the tips through labware."""
from opentrons import protocol_api

metadata = {"protocolName": "Fixture - travel collision"}
requirements = {"robotType": "OT-2", "apiLevel": "2.28"}


def run(protocol: protocol_api.ProtocolContext):
    tiprack = protocol.load_labware("opentrons_96_tiprack_300ul", 6)
    plate_1 = protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", 1)
    plate_2 = protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", 2)
    pipette = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tiprack])
    pipette.pick_up_tip()
    pipette.move_to(plate_1["A1"].bottom(2))
    pipette.move_to(plate_2["A1"].bottom(2), force_direct=True)
    pipette.drop_tip()
