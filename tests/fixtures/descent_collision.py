"""Fixture: descending between wells drives the tip into the plate surface."""
from opentrons import protocol_api
from opentrons.types import Point

metadata = {"protocolName": "Fixture - descent collision"}
requirements = {"robotType": "OT-2", "apiLevel": "2.28"}


def run(protocol: protocol_api.ProtocolContext):
    tiprack = protocol.load_labware("opentrons_96_tiprack_300ul", 6)
    plate = protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", 1)
    pipette = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tiprack])
    pipette.pick_up_tip()
    pipette.move_to(plate["A1"].top(-5).move(Point(x=4.5)))
    pipette.drop_tip()
