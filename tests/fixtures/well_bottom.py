"""Fixture: aspirating 3 mm below the well bottom strikes the plate."""
from opentrons import protocol_api

metadata = {"protocolName": "Fixture - well bottom strike"}
requirements = {"robotType": "OT-2", "apiLevel": "2.28"}


def run(protocol: protocol_api.ProtocolContext):
    tiprack = protocol.load_labware("opentrons_96_tiprack_300ul", 6)
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 1)
    pipette = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tiprack])
    water = protocol.define_liquid(name="Water", description="", display_color="#41D8F2")
    plate["A1"].load_liquid(liquid=water, volume=200)
    pipette.pick_up_tip()
    pipette.aspirate(50, plate["A1"].bottom(-3))
    pipette.drop_tip()
