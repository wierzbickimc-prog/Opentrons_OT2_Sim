"""End-to-end simulations on the real OT-2 engine.

Skipped unless the simulator virtualenv exists (scripts/setup_simulator.sh).
Each fixture protocol must produce its expected safety finding.
"""

import json
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from worklists import mfg_template, pcr_amp  # noqa: E402
from tests.test_pcr_amp import full_four_plate_sheet  # noqa: E402
SIM_PYTHON = ROOT / ".venv-sim" / "bin" / "python"
FIXTURES = ROOT / "tests" / "fixtures"


def simulate(protocol: Path) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "result.json"
        subprocess.run(
            [str(SIM_PYTHON), str(ROOT / "simulation" / "worker.py"), str(protocol), str(output)],
            cwd=tmp, env={"PATH": "/usr/bin:/bin", "HOME": tmp}, capture_output=True, timeout=240, check=True,
        )
        return json.loads(output.read_text())


@unittest.skipUnless(SIM_PYTHON.exists(), "OT-2 simulator is not installed; run scripts/setup_simulator.sh")
class EngineSimulationTests(unittest.TestCase):
    def codes(self, result, severity):
        return {f["code"] for f in result["safety"]["findings"] if f["severity"] == severity}

    def test_sample_protocol_is_clean_and_fully_attributed(self):
        result = simulate(ROOT / "sample_protocol.py")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(len(result["commands"]), 212)
        self.assertEqual(result["safety"]["status"], "pass")
        self.assertEqual(result["safety"]["findings"], [])
        # Every G-code line belongs to a protocol command, except the engine's
        # end-of-run reset and homing after the last command.
        gcode = result["gcode"]
        last_attributed = max(i for i, row in enumerate(gcode) if row[0] is not None)
        self.assertTrue(all(row[0] is not None for row in gcode[:last_attributed + 1]))
        self.assertIn("M999", {row[2] for row in gcode[last_attributed + 1:]})
        aspirate = next(c for c in result["commands"] if c["type"] == "aspirate")
        self.assertEqual(aspirate["result"]["position"], {"x": 146.88, "y": 164.74, "z": 2.05})

    def test_generated_mfg_protocol_notes_air_channels_only(self):
        result = simulate(FIXTURES / "mfg_13_constructs.py")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["safety"]["status"], "pass")
        self.assertEqual(self.codes(result, "info"), {"air-aspirate-empty-well"})

    def test_generated_mfg_hybrid_protocol_tops_every_spot_to_10_ul(self):
        result = simulate(FIXTURES / "mfg_hybrid_13_constructs.py")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["safety"]["status"], "pass")
        self.assertEqual(self.codes(result, "info"), {"air-aspirate-empty-well"})
        # One water tip column for the whole run, then one per source column.
        pickups = [c for c in result["commands"] if c["type"] == "pickUpTip"]
        self.assertEqual([c["params"]["wellName"] for c in pickups], ["A1", "A2", "A3"])
        # Constructs 1-13 fill agar columns 1-4 (A-H) and 5-8 (A-E) with 10 uL
        # spots. Rows F-H of the partial column get only water in spots 3 and 4.
        spots = self.dispensed(result, "corning_96_wellplate_360ul_flat")
        expected = {f"{row}{column}": 10 for row in "ABCDEFGH" for column in range(1, 5)}
        expected.update({f"{row}{column}": 10 for row in "ABCDE" for column in range(5, 9)})
        expected.update({f"{row}{column}": water for row in "FGH" for column, water in ((7, 7), (8, 9))})
        self.assertEqual(spots, expected)

    def dispensed(self, result, load_name):
        labware = next(lw["id"] for lw in result["labware"] if lw["loadName"] == load_name)
        wells = {}
        for event in result["safety"]["liquid"]["events"]:
            for change in event["wells"]:
                if change["labware"] == labware:
                    wells[change["well"]] = wells.get(change["well"], 0) + change["delta"]
        return wells

    def echo_dispensed(self, result):
        return self.dispensed(result, "labcyte_echo_384pp")

    def test_pcr_amp_sample_sheet_fills_the_mapped_echo_wells(self):
        result = simulate(FIXTURES / "pcr_amp_LAB2446.py")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["safety"]["status"], "pass")
        self.assertEqual(self.codes(result, "info"), {"aspirate-overdraw", "air-aspirate-empty-well"})
        plan = pcr_amp.plan_transfer((FIXTURES / "LAB2446_pcr_plan.csv").read_text())
        expected = {well for transfer in plan["transfers"] for well in transfer["destinations"]}
        dispensed = self.echo_dispensed(result)
        self.assertEqual(set(dispensed), expected)
        self.assertTrue(all(abs(volume - 65) < 1e-6 for volume in dispensed.values()))

    def test_pcr_amp_four_full_plates_use_every_echo_well_and_tip(self):
        plan = pcr_amp.plan_transfer(full_four_plate_sheet(), transfer_volume=65, starting_volume=65)
        with tempfile.TemporaryDirectory() as tmp:
            protocol = Path(tmp) / "four_plates.py"
            protocol.write_text(plan["protocol"])
            result = simulate(protocol)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["safety"]["status"], "pass")
        self.assertEqual(result["safety"]["findings"], [])
        self.assertEqual(len(self.echo_dispensed(result)), 384)
        self.assertEqual(sum(1 for c in result["commands"] if c["type"] == "pickUpTip"), 48)

    def test_mfg_template_spots_water_then_culture_on_the_named_plates(self):
        csv_lines = (FIXTURES / "LAB2456_plating_template.csv").read_text().splitlines()
        # B1 asks for conc spots 2 and 3, so column 1 gets the 3 + 7 spot in both.
        csv_lines[2] = csv_lines[2].replace("conc,dil,dil,dil", "conc,conc,conc,dil")
        plan = mfg_template.plan_plating("\n".join(csv_lines))
        with tempfile.TemporaryDirectory() as tmp:
            protocol = Path(tmp) / "template.py"
            protocol.write_text(plan["protocol"])
            result = simulate(protocol)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["safety"]["status"], "pass")
        self.assertEqual(self.codes(result, "info"), {"air-aspirate-empty-well"})
        self.assertEqual([c["params"]["message"] for c in result["commands"] if c["type"] == "comment"], plan["notices"])
        self.assertEqual({lw["slot"]: lw["label"] for lw in result["labware"] if lw["loadName"] == "built_agar_omnitray_96_spots"},
                         {"1": "LAB0000_XFRMS_1 (Kanamycin)", "2": "LAB0000_XFRMS_2 (Carbenicillin)"})
        # One water tip column for the whole run, then one per source column.
        self.assertEqual(sum(1 for c in result["commands"] if c["type"] == "pickUpTip"), 5)
        first_drop = next(i for i, c in enumerate(result["commands"]) if c["type"].startswith("dropTip"))
        water, culture = {}, {}
        slots = {lw["id"]: lw["slot"] for lw in result["labware"]}
        for event in result["safety"]["liquid"]["events"]:
            for change in event["wells"]:
                if slots[change["labware"]] in ("1", "2") and change["delta"] > 0:
                    target = water if event["command"] < first_drop else culture
                    key = (slots[change["labware"]], change["well"])
                    target[key] = target.get(key, 0) + change["delta"]
        expected_culture = {}
        for slot, column, rows, spots in (("1", 1, "ABCDEFGH", (10, 3, 3, 1)), ("1", 5, "ABCDEFGH", (10, 1, 1, 1)),
                                          ("2", 1, "ABCDEFGH", (10, 1, 1, 1)), ("2", 5, "ABCD", (10, 1, 1, 1))):
            for offset, volume in enumerate(spots):
                expected_culture.update({(slot, f"{row}{column + offset}"): volume for row in rows})
        self.assertEqual({k: round(v, 6) for k, v in culture.items()}, expected_culture)
        # Water tops every occupied spot up to 10 uL; rows E-H of the partial column get water only.
        for key, volume in culture.items():
            self.assertAlmostEqual(volume + water.get(key, 0), 10, msg=str(key))
        self.assertEqual({key for key in water if key not in culture}, {("2", f"{row}{c}") for row in "EFGH" for c in (6, 7, 8)})

    def test_fixtures_report_expected_findings(self):
        expected = {
            "out_of_tips.py": ("error", "engine-error"),
            "travel_collision.py": ("error", "tip-collision-travel"),
            "descent_collision.py": ("error", "tip-collision-descent"),
            "well_bottom.py": ("error", "well-bottom-strike"),
            "liquid_volumes.py": ("warning", "dispense-overflow"),
        }
        for name, (severity, code) in expected.items():
            with self.subTest(fixture=name):
                result = simulate(FIXTURES / name)
                self.assertIn(code, self.codes(result, severity))
        liquid = simulate(FIXTURES / "liquid_volumes.py")
        self.assertEqual(self.codes(liquid, "warning"), {"aspirate-insufficient", "aspirate-above-liquid", "dispense-overflow"})


if __name__ == "__main__":
    unittest.main()
