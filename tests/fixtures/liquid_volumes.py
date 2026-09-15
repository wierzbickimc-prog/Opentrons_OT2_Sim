"""Fixture: insufficient source volume, aspirating above the liquid, and overflow."""
from opentrons import protocol_api

metadata = {"protocolName": "Fixture - liquid volumes"}
requirements = {"robotType": "OT-2", "apiLevel": "2.28"}


def run(protocol: protocol_api.ProtocolContext):
    tiprack = protocol.load_labware("opentrons_96_tiprack_300ul", 6)
    source = protocol.load_labware("corning_96_wellplate_360ul_flat", 1)
    destination = protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", 2)
    pipette = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tiprack])
    water = protocol.define_liquid(name="Water", description="", display_color="#41D8F2")
    source["A1"].load_liquid(liquid=water, volume=100)
    source["A2"].load_liquid(liquid=water, volume=300)
    pipette.pick_up_tip()
    pipette.aspirate(150, source["A1"].bottom(1))
    pipette.dispense(150, destination["A1"])
    pipette.aspirate(20, source["A2"].top(-0.5))
    pipette.aspirate(260, source["A2"].bottom(1))
    pipette.dispense(280, destination["A1"])
    pipette.drop_tip()
