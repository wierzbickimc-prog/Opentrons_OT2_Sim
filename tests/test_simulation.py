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
from worklists import pcr_amp  # noqa: E402
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

    def echo_dispensed(self, result):
        echo = next(lw["id"] for lw in result["labware"] if lw["loadName"] == "labcyte_echo_384pp")
        wells = {}
        for event in result["safety"]["liquid"]["events"]:
            for change in event["wells"]:
                if change["labware"] == echo:
                    wells[change["well"]] = wells.get(change["well"], 0) + change["delta"]
        return wells

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
