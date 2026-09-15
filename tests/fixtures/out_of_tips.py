"""Fixture: a 13th eight-channel pickup from a single 96-tip rack runs out of tips."""
from opentrons import protocol_api

metadata = {"protocolName": "Fixture - out of tips"}
requirements = {"robotType": "OT-2", "apiLevel": "2.28"}


def run(protocol: protocol_api.ProtocolContext):
    tiprack = protocol.load_labware("opentrons_96_tiprack_20ul", 6)
    pipette = protocol.load_instrument("p20_multi_gen2", "left", tip_racks=[tiprack])
    for _ in range(13):
        pipette.pick_up_tip()
        pipette.drop_tip()
