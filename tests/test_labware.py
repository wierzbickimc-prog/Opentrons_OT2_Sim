import json
import re
import shutil
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from worklists import labware, pcr_amp  # noqa: E402

SIM_PYTHON = ROOT / ".venv-sim" / "bin" / "python"
NODE = shutil.which("node")
SAMPLE_CSV = (ROOT / "tests" / "fixtures" / "LAB2446_pcr_plan.csv").read_text()


def run_protocol_function(protocol: str, name: str):
    """Run a function from a generated protocol without the opentrons package."""
    fake = types.ModuleType("opentrons")
    fake.protocol_api = types.SimpleNamespace(ProtocolContext=object)
    namespace: dict = {}
    with mock.patch.dict(sys.modules, {"opentrons": fake}):
        exec(compile(protocol, "protocol.py", "exec"), namespace)
    return namespace[name]()


class WarehouseCatalogTests(unittest.TestCase):
    def test_every_labware_the_builders_load_is_in_the_warehouse(self):
        sources = (ROOT / "app.js").read_text() + (ROOT / "worklists" / "pcr_amp.py").read_text()
        loaded = set(re.findall(r'load_labware\("([a-z0-9_]+)"', sources))
        loaded |= {item["loadName"] for item in pcr_amp.plan_transfer(SAMPLE_CSV)["labware"]}
        self.assertTrue(loaded)
        self.assertEqual(loaded - set(labware.CATALOG), set())

    def test_vendored_definitions_exist_for_every_standard_entry(self):
        for name, info in labware.CATALOG.items():
            if info["status"] in ("standard", "placeholder"):
                self.assertIsNotNone(labware.definition(name), name)

    def test_agar_is_a_blocking_placeholder_until_measured(self):
        with mock.patch.multiple(labware, AGAR_PLATE_HEIGHT_MM=None, AGAR_SURFACE_HEIGHT_MM=None):
            self.assertEqual(labware.agar_plate()["status"], "placeholder")
            self.assertEqual(labware.entry(labware.AGAR_LOAD_NAME)["status"], "pending")
        with mock.patch.multiple(labware, AGAR_PLATE_HEIGHT_MM=15.2, AGAR_SURFACE_HEIGHT_MM=9.1):
            plate = labware.agar_plate()
            self.assertEqual((plate["loadName"], plate["status"], plate["wellBottom"], plate["height"]), (labware.AGAR_LOAD_NAME, "custom", 9.1, 15.2))

    def test_measured_agar_spots_sit_on_the_agar_surface(self):
        definition = labware.agar_definition(15.2, 9.1)
        self.assertEqual(len(definition["wells"]), 96)
        a1, h12 = definition["wells"]["A1"], definition["wells"]["H12"]
        self.assertEqual((a1["x"], a1["y"], a1["z"]), (14.38, 74.24, 9.1))
        self.assertEqual((h12["x"], h12["y"]), (113.38, 11.24))
        self.assertAlmostEqual(a1["z"] + a1["depth"], 15.2)

    def test_pcr_amp_protocols_embed_the_warehouse_echo_definition(self):
        protocol = pcr_amp.plan_transfer(SAMPLE_CSV)["protocol"]
        self.assertEqual(run_protocol_function(protocol, "echo_384pp_definition"), labware.echo_384pp_definition())

    @unittest.skipUnless(NODE, "Node.js is not installed")
    def test_plating_protocols_embed_the_warehouse_agar_definition(self):
        script = "const { agarDefinitionPython } = require(process.argv[1]); process.stdout.write(agarDefinitionPython(15.2, 9.1));"
        snippet = subprocess.run([NODE, "-e", script, str(ROOT / "labware.js")], capture_output=True, text=True, check=True).stdout
        self.assertEqual(run_protocol_function(snippet, "agar_definition"), labware.agar_definition(15.2, 9.1))


@unittest.skipUnless(SIM_PYTHON.exists(), "OT-2 simulator is not installed; run scripts/setup_simulator.sh")
class VendoredDefinitionTests(unittest.TestCase):
    def test_vendored_definitions_match_the_engine(self):
        # The fixed trash is built into the deck rather than loaded by name.
        names = [path.stem for path in labware.DEFINITIONS_DIR.glob("*.json") if path.stem != "opentrons_1_trash_1100ml_fixed"]
        # Load each the way a protocol at the builders' API level does, so the versions match.
        script = (
            "import json, sys, contextlib, io\n"
            "with contextlib.redirect_stdout(io.StringIO()):\n"
            "    from opentrons import simulate\n"
            "    ctx = simulate.get_protocol_api('2.28')\n"
            "    found = {n: ctx.load_labware(n, i + 1)._core.get_definition() for i, n in enumerate(sys.argv[1:])}\n"
            "print(json.dumps(found))\n"
        )
        result = subprocess.run([str(SIM_PYTHON), "-c", script, *names], capture_output=True, text=True, check=True)
        engine = json.loads(result.stdout)
        for name in names:
            self.assertEqual(labware.definition(name), engine[name], f"{name} differs from the engine's default definition")


class WarehouseEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import http.server
        import os
        import threading
        import server
        cls.env = mock.patch.dict(os.environ, {}, clear=False)
        cls.env.start()
        os.environ.pop("OT2_SITE_PASSWORD", None)
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.ApplicationHandler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.env.stop()

    def get(self, path):
        import urllib.error
        import urllib.request
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_catalog_and_definitions_are_served(self):
        status, body = self.get("/api/labware")
        self.assertEqual(status, 200)
        self.assertIn("opentrons_96_tiprack_20ul", {entry["loadName"] for entry in body["labware"]})
        status, body = self.get("/api/labware/labcyte_echo_384pp")
        self.assertEqual((status, len(body["wells"])), (200, 384))

    def test_unknown_and_malformed_names_are_not_found(self):
        for name in ("not_a_labware", "..%2F..%2Fserver", "UPPER"):
            self.assertEqual(self.get(f"/api/labware/{name}")[0], 404, name)


if __name__ == "__main__":
    unittest.main()
