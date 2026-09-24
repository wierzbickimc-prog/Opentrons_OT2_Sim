import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "Node.js is not installed; the calibration flows are browser JavaScript")
class CalibrationFlows(unittest.TestCase):
    def test_practice_robot_flows(self):
        result = subprocess.run(
            [NODE, str(ROOT / "tests" / "calibration_flows.test.js")],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("not ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
