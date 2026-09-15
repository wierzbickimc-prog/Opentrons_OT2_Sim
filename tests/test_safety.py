import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "simulation"))
import safety  # noqa: E402

# A single-channel right-mount pipette with zero offsets: the carriage position
# is the nozzle end, so test moves read directly as deck coordinates.
PIPETTE = {
    "mount": "right", "name": "p300_single_gen2", "channels": 1, "maxVolume": 300,
    "mountOffset": [0, 0, 0], "nozzleOffset": [0, 0, 0], "channelOffsets": [{"name": "A1", "dx": 0, "dy": 0}],
}
PLATE = {
    "id": "plate", "displayName": "Plate", "slot": "1", "isTiprack": False,
    "origin": {"x": 0, "y": 0, "z": 0}, "dimensions": {"x": 127.76, "y": 85.48, "z": 15},
    "top": 15,
    "wells": {
        "A1": {"x": 14.4, "y": 74.2, "z": 2, "depth": 13, "shape": "circular", "diameter": 6, "volume": 200},
        "A2": {"x": 23.4, "y": 74.2, "z": 2, "depth": 13, "shape": "circular", "diameter": 6, "volume": 200},
    },
}
BASE = {
    "labware": [PLATE], "modules": [], "pipettes": [PIPETTE], "errors": [],
    "commands": [
        {"index": 0, "type": "loadPipette", "params": {"mount": "right"}, "result": {"pipetteId": "p"}, "error": None},
    ],
    "moves": [],
}
HIGH = 100.0


def carriage(x, y, z):
    return {"X": x, "Y": y, "Z_L": 218.0, "Z_R": z, "P_L": 0.0, "P_R": 0.0}


def move(command, start, end, tip=50.0):
    return {"command": command, "mount": "right", "start": carriage(*start), "end": carriage(*end), "tips": {"left": None, "right": tip}}


def result_with(moves=(), commands=(), errors=()):
    result = copy.deepcopy(BASE)
    result["moves"] = list(moves)
    result["commands"] += list(commands)
    result["errors"] = list(errors)
    return result


def codes(result):
    return [finding["code"] for finding in safety.evaluate(result)["findings"]]


class MotionChecks(unittest.TestCase):
    def test_travel_above_labware_passes(self):
        result = result_with([move(1, (14.4, 74.2, HIGH), (23.4, 74.2, HIGH))])
        self.assertEqual(safety.evaluate(result)["status"], "pass")

    def test_descent_into_well_passes(self):
        result = result_with([move(1, (14.4, 74.2, 70), (14.4, 74.2, 53))])  # tip end 3 mm, above 2 mm bottom
        self.assertEqual(codes(result), [])

    def test_descent_between_wells_is_a_collision(self):
        result = result_with([move(1, (18.9, 74.2, 70), (18.9, 74.2, 60))])  # tip end 10 mm, between wells
        self.assertEqual(codes(result), ["tip-collision-descent"])

    def test_travel_below_labware_top_is_a_collision(self):
        result = result_with([move(1, (14.4, 74.2, 55), (60, 20, 55))])  # tip end 5 mm across the plate
        self.assertIn("tip-collision-travel", codes(result))

    def test_tip_below_well_bottom_is_reported(self):
        result = result_with([move(1, (14.4, 74.2, 70), (14.4, 74.2, 49))])  # tip end -1 mm, bottom at 2 mm
        self.assertEqual(codes(result), ["well-bottom-strike"])

    def test_error_points_are_reported_for_markers(self):
        result = result_with([move(1, (18.9, 74.2, 70), (18.9, 74.2, 60))])
        finding = safety.evaluate(result)["findings"][0]
        self.assertEqual(finding["point"], {"x": 18.9, "y": 74.2, "z": 10.0})
        self.assertEqual(finding["severity"], "error")


class EngineErrors(unittest.TestCase):
    def test_command_error_is_attached_to_its_command(self):
        command = {"index": 1, "type": "aspirate", "params": {}, "result": {}, "error": {"detail": "Cannot aspirate more than 300 µL."}}
        findings = [f for f in safety.evaluate(result_with(commands=[command]))["findings"] if f["severity"] == "error"]
        self.assertEqual([(f["code"], f["command"]) for f in findings], [("engine-error", 1)])
        self.assertIn("300 µL", findings[0]["message"])

    def test_python_errors_are_anchored_to_the_last_command(self):
        error = {
            "detail": "OutOfTipsError [line 12]: ",
            "wrappedErrors": [{"detail": "opentrons.protocol_api.labware.OutOfTipsError", "errorInfo": {"class": "OutOfTipsError"}, "wrappedErrors": []}],
        }
        findings = safety.evaluate(result_with(errors=[error]))["findings"]
        self.assertEqual(findings[0]["command"], 0)
        self.assertIn("no unused tips remain", findings[0]["message"])
        self.assertNotIn("opentrons.protocol_api", findings[0]["message"])


class LiquidChecks(unittest.TestCase):
    def liquid_protocol(self, loaded, aspirate, tip_end_z=3.0, dispense=None):
        z = tip_end_z + 50
        commands = [
            {"index": 1, "type": "loadLiquid", "params": {"labwareId": "plate", "volumeByWell": loaded}, "result": {}, "error": None},
            {"index": 2, "type": "aspirate", "params": {"pipetteId": "p", "volume": aspirate}, "result": {}, "error": None},
        ]
        moves = [move(2, (14.4, 74.2, HIGH), (14.4, 74.2, z))]
        if dispense is not None:
            commands.append({"index": 3, "type": "dispense", "params": {"pipetteId": "p", "volume": dispense}, "result": {}, "error": None})
            moves.append(move(3, (14.4, 74.2, z), (23.4, 74.2, HIGH)))
            moves.append(move(3, (23.4, 74.2, HIGH), (23.4, 74.2, 55)))
        return result_with(moves, commands)

    def test_aspirating_more_than_the_well_holds_warns(self):
        self.assertEqual(codes(self.liquid_protocol({"A1": 50}, 100)), ["aspirate-insufficient"])

    def test_aspirating_above_the_liquid_surface_warns(self):
        # 50 µL in a 6 mm well is about 1.8 mm deep; the tip end is at 12 mm.
        self.assertEqual(codes(self.liquid_protocol({"A1": 50}, 20, tip_end_z=12)), ["aspirate-above-liquid"])

    def test_empty_well_in_loaded_labware_is_informational(self):
        findings = safety.evaluate(self.liquid_protocol({"A2": 100}, 20))["findings"]
        self.assertEqual([(f["severity"], f["code"]) for f in findings], [("info", "air-aspirate-empty-well")])
        self.assertIn("Wells: A1", findings[0]["message"])

    def test_dispense_overflow_warns_and_liquid_is_conserved(self):
        result = self.liquid_protocol({"A1": 200, "A2": 190}, 150, dispense=150)
        evaluation = safety.evaluate(result)
        self.assertEqual([f["code"] for f in evaluation["findings"]], ["dispense-overflow"])
        events = evaluation["liquid"]["events"]
        self.assertEqual(sum(change["delta"] for event in events for change in event["wells"]), 0)
        self.assertEqual(events[-1]["tips"], [0.0])

    def test_air_is_not_counted_as_tip_liquid(self):
        result = self.liquid_protocol({"A1": 30, "A2": 0}, 50, dispense=50)
        events = safety.evaluate(result)["liquid"]["events"]
        self.assertEqual(events[0]["tips"], [30.0])
        self.assertEqual(events[1]["wells"], [{"labware": "plate", "well": "A2", "delta": 30.0}])


class HeightTable(unittest.TestCase):
    def test_interpolates_geometry_table(self):
        well = {"heights": [[0, 0], [10, 2], [30, 4]], "shape": "circular", "diameter": 5, "depth": 4}
        self.assertAlmostEqual(safety.height_at_volume(well, 20), 3.0)

    def test_cylinder_fallback(self):
        well = {"shape": "rectangular", "xDim": 10, "yDim": 10, "depth": 40}
        self.assertAlmostEqual(safety.height_at_volume(well, 500), 5.0)


if __name__ == "__main__":
    unittest.main()
