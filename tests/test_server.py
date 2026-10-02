import json
import os
import urllib.error
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import server


class ServerSecurityTests(unittest.TestCase):
    def test_private_and_tailscale_addresses_are_allowed(self):
        self.assertTrue(server.is_allowed_robot_ip("192.168.1.42"))
        self.assertTrue(server.is_allowed_robot_ip("10.0.0.8"))
        self.assertTrue(server.is_allowed_robot_ip("100.79.20.44"))

    def test_public_and_special_addresses_are_rejected(self):
        self.assertFalse(server.is_allowed_robot_ip("8.8.8.8"))
        self.assertFalse(server.is_allowed_robot_ip("127.0.0.1"))
        self.assertFalse(server.is_allowed_robot_ip("169.254.169.254"))
        self.assertFalse(server.is_allowed_robot_ip("fe80::1"))

    def test_a_robot_cabled_to_this_computer_is_allowed(self):
        # USB-to-Ethernet gives the OT-2 an IPv4 link-local address.
        self.assertTrue(server.is_allowed_robot_ip("169.254.43.120"))

    def test_current_and_legacy_multipart_field_names(self):
        for field_name in ("files", "protocolFile"):
            body, boundary = server.multipart_body(
                field_name,
                "MFG-1.py",
                b"from opentrons import protocol_api\n",
                "MFG-1",
            )
            self.assertIn(f'name="{field_name}"'.encode(), body)
            self.assertIn(boundary.encode(), body)


class SimulationPinTests(unittest.TestCase):
    def test_simulation_is_open_unless_pin_is_required(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OT2_SIM_REQUIRE_PIN", None)
            self.assertFalse(server.simulation_pin_required())
        with mock.patch.dict(os.environ, {"OT2_SIM_REQUIRE_PIN": "1"}):
            self.assertTrue(server.simulation_pin_required())


class SiteLoginTests(unittest.TestCase):
    """Runs the real handler on an ephemeral port with a site password set."""

    @classmethod
    def setUpClass(cls):
        import http.server
        import threading
        cls.env = mock.patch.dict(os.environ, {"OT2_SITE_PASSWORD": "0000"})
        cls.env.start()
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.ApplicationHandler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.env.stop()

    def setUp(self):
        server.LOGIN_FAILURES.clear()

    def request(self, path, data=None, cookie=None, forwarded=None):
        import urllib.request

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if forwarded:
            headers["X-Forwarded-For"] = forwarded
        body = json.dumps(data).encode() if data is not None else None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(urllib.request.Request(self.base + path, data=body, headers=headers), timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def sign_in(self):
        status, headers, _ = self.request("/api/login", {"password": "0000"})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        return headers["Set-Cookie"].split(";")[0]

    def test_everything_requires_sign_in(self):
        status, _, body = self.request("/")
        self.assertEqual(status, 401)
        self.assertIn(b"Enter the password", body)
        self.assertNotIn(b"OT-2 Manufacturing Tools</title>\n  <script>", body)
        self.assertEqual(self.request("/app.js")[0], 401)
        self.assertEqual(self.request("/index.html")[0], 401)
        self.assertEqual(self.request("/api/health")[0], 401)
        self.assertEqual(self.request("/api/simulate", {"sample": True})[0], 401)
        status, _, body = self.request("/login")
        self.assertEqual(status, 200)
        self.assertIn(b"Enter the password", body)

    def test_correct_password_opens_the_app(self):
        cookie = self.sign_in()
        status, _, body = self.request("/", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn(b"OT-2 Manufacturing Tools", body)
        self.assertEqual(json.loads(self.request("/api/health", cookie=cookie)[2])["siteLogin"], True)

    def test_wrong_or_forged_credentials_are_rejected(self):
        self.assertEqual(self.request("/api/login", {"password": "1234"})[0], 401)
        forged = f"{server.SESSION_COOKIE}={int(__import__('time').time()) + 3600}.deadbeef"
        self.assertEqual(self.request("/api/health", cookie=forged)[0], 401)
        self.assertFalse(server.valid_session(server.issue_session(now=0), now=server.SESSION_SECONDS + 1))

    def test_lockout_is_per_visitor_behind_a_proxy(self):
        for _ in range(server.LOGIN_MAX_FAILURES):
            self.request("/api/login", {"password": "9999"}, forwarded="203.0.113.7")
        self.assertEqual(self.request("/api/login", {"password": "0000"}, forwarded="203.0.113.7")[0], 429)
        self.assertEqual(self.request("/api/login", {"password": "0000"}, forwarded="198.51.100.4")[0], 200)

    def test_pcr_amp_plan_returns_protocol_or_every_sheet_error(self):
        cookie = self.sign_in()
        self.assertEqual(self.request("/api/pcr-amp/plan", {"csv": "x"})[0], 401)
        csv_text = (Path(__file__).parent / "fixtures" / "LAB2446_pcr_plan.csv").read_text()
        status, _, body = self.request("/api/pcr-amp/plan", {"csv": csv_text, "transferVolume": 66, "startingVolume": 65}, cookie=cookie)
        self.assertEqual(status, 200)
        plan = json.loads(body)
        self.assertEqual((plan["identifier"], plan["filename"], len(plan["transfers"])), ("LAB2446_AMP", "LAB2446_AMP.py", 15))
        self.assertTrue(plan["protocol"].startswith("from opentrons import protocol_api"))
        bad = "dest_pcr_plate,dest_well_384,dest_well_96\nRUN_PCR_1,A1,A1\nRUN_PCR_9,A1,A1\n"
        status, _, body = self.request("/api/pcr-amp/plan", {"csv": bad, "transferVolume": 5}, cookie=cookie)
        self.assertEqual(status, 422)
        self.assertEqual(len(json.loads(body)["errors"]), 2)
        self.assertEqual(self.request("/api/pcr-amp/plan", {"csv": ""}, cookie=cookie)[0], 400)

    def test_mfg_template_plan_returns_protocol_or_every_sheet_error(self):
        cookie = self.sign_in()
        self.assertEqual(self.request("/api/mfg-template/plan", {"csv": "x"})[0], 401)
        csv_text = (Path(__file__).parent / "fixtures" / "LAB2456_plating_template.csv").read_text()
        status, _, body = self.request("/api/mfg-template/plan", {"csv": csv_text}, cookie=cookie)
        self.assertEqual(status, 200)
        plan = json.loads(body)
        self.assertEqual((plan["identifier"], plan["filename"], len(plan["agarPlates"])), ("LAB0000_XFRMS", "LAB0000_XFRMS.py", 2))
        self.assertTrue(plan["protocol"].startswith("from opentrons import protocol_api"))
        bad = csv_text.replace("C4,Carbenicillin", "I4,Carbenicillin").replace("D4,Carbenicillin,NEB Stable,LAB0000_XFRMS_2,1,conc", "D4,Carbenicillin,NEB Stable,LAB0000_XFRMS_2,1,dil")
        status, _, body = self.request("/api/mfg-template/plan", {"csv": bad}, cookie=cookie)
        self.assertEqual(status, 422)
        self.assertEqual(len(json.loads(body)["errors"]), 2)
        self.assertEqual(self.request("/api/mfg-template/plan", {"csv": ""}, cookie=cookie)[0], 400)

    def test_repeated_failures_are_rate_limited(self):
        for _ in range(server.LOGIN_MAX_FAILURES):
            self.assertEqual(self.request("/api/login", {"password": "9999"})[0], 401)
        self.assertEqual(self.request("/api/login", {"password": "0000"})[0], 429)


class StaticFileTests(unittest.TestCase):
    def test_only_top_level_web_files_are_public(self):
        for path in ("/index.html", "/app.js", "/simulator.js", "/brand.css"):
            self.assertTrue(server.STATIC_FILE_PATTERN.fullmatch(path), path)
        for path in ("/server.py", "/.sim-cache/abc.json", "/.git/HEAD", "/simulation/worker.py", "/.venv-sim/bin/python", "/../etc/passwd"):
            self.assertFalse(server.STATIC_FILE_PATTERN.fullmatch(path), path)


STUB_WORKER = """#!/usr/bin/env python3
import json, os, sys, time
protocol, output = sys.argv[2], sys.argv[3]
text = open(protocol).read()
mode = "sleep" if "# stub: sleep" in text else "rejected" if "# stub: rejected" in text else "ok"
if mode == "sleep":
    time.sleep(30)
if mode == "rejected":
    result = {"status": "rejected", "rejection": "Not an OT-2 protocol."}
else:
    result = {"status": "succeeded", "protocolName": os.path.basename(protocol), "home": os.environ.get("HOME")}
open(output, "w").write(json.dumps(result))
"""


class SimulationEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        venv = root / "venv"
        (venv / "bin").mkdir(parents=True)
        self.python = venv / "bin" / "python"
        self.python.write_text(STUB_WORKER)
        self.python.chmod(self.python.stat().st_mode | stat.S_IEXEC)
        (venv / "ENGINE_VERSION").write_text("26.6.0\n")
        self.patches = [
            mock.patch.dict(os.environ, {"OT2_SIM_PYTHON": str(self.python), "OT2_SIM_TIMEOUT": "2"}),
            mock.patch.object(server, "SIM_CACHE_DIR", root / "cache"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_successful_simulation_is_returned_and_cached(self):
        status, body = server.simulate_protocol("plate.py", "from opentrons import protocol_api\n")
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["protocolName"], "plate.py")
        self.assertNotEqual(result["home"], os.environ.get("HOME"))  # worker runs with a private HOME
        self.assertEqual(len(list(server.SIM_CACHE_DIR.glob("*.json"))), 1)
        # A second request for the same protocol is served from the cache without the worker.
        self.python.write_text("#!/bin/sh\nexit 1\n")
        self.assertEqual(server.simulate_protocol("plate.py", "from opentrons import protocol_api\n"), (200, body))

    def test_rejected_protocols_return_the_reason(self):
        status, body = server.simulate_protocol("plate.py", "from opentrons import protocol_api\n# stub: rejected\n")
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(body), {"error": "Not an OT-2 protocol."})
        self.assertFalse(server.SIM_CACHE_DIR.exists())

    def test_timeouts_stop_the_worker(self):
        with self.assertRaises(server.RequestError) as raised:
            server.simulate_protocol("slow.py", "from opentrons import protocol_api\n# stub: sleep\n")
        self.assertEqual(raised.exception.status, 504)

    def test_missing_simulator_reports_setup_instructions(self):
        with mock.patch.dict(os.environ, {"OT2_SIM_PYTHON": str(Path(self.tmp.name) / "missing" / "python")}):
            with self.assertRaises(server.RequestError) as raised:
                server.simulate_protocol("plate.py", "from opentrons import protocol_api\n")
        self.assertEqual(raised.exception.status, 503)
        self.assertIn("setup_simulator.sh", raised.exception.message)

    def test_only_one_simulation_runs_at_a_time(self):
        self.assertTrue(server.SIMULATION_SLOT.acquire(blocking=False))
        try:
            with self.assertRaises(server.RequestError) as raised:
                server.simulate_protocol("busy.py", "from opentrons import protocol_api\n")
            self.assertEqual(raised.exception.status, 429)
        finally:
            server.SIMULATION_SLOT.release()


if __name__ == "__main__":
    unittest.main()


class LiveCalibrationProxyTests(unittest.TestCase):
    """The live-calibration proxy against a fake robot-server that records every request."""

    SESSION = "5cf76890-f47b-443b-9fc2-3e41de7cb279"

    @classmethod
    def setUpClass(cls):
        import http.server
        import threading
        calls = cls.calls = []
        session = cls.SESSION

        class FakeRobot(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, value):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def handle_any(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                calls.append((self.command, self.path, body, self.headers.get("Opentrons-Version")))
                if self.path.endswith("/commands/execute") and body["data"]["command"] == "calibration.pickUpTip":
                    self.reply(409, {"errors": [{"title": "Illegal State Transition", "detail": "The action calibration.pickUpTip may not occur in the state sessionStarted"}]})
                elif self.path == "/sessions" and self.command == "POST":
                    self.reply(201, {"data": {"id": session, "sessionType": body["data"]["sessionType"], "details": {"currentStep": "sessionStarted"}}})
                elif self.path == "/sessions":
                    self.reply(200, {"data": [{"id": session, "sessionType": "deckCalibration", "details": {}}]})
                elif self.path.startswith("/sessions/"):
                    self.reply(200, {"data": {"id": session, "details": {"currentStep": "labwareLoaded"}}})
                elif self.path in ("/calibration/pipette_offset", "/calibration/tip_length"):
                    self.reply(200, {"data": []})
                else:
                    self.reply(200, {"name": "fake"})

            do_GET = do_POST = do_DELETE = handle_any

        cls.robot = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeRobot)
        threading.Thread(target=cls.robot.serve_forever, daemon=True).start()
        cls.app = http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.ApplicationHandler)
        threading.Thread(target=cls.app.serve_forever, daemon=True).start()
        cls.patches = [
            mock.patch.dict(os.environ, {"OT2_UPLOAD_PIN": "4321"}),
            mock.patch.object(server, "ROBOT_PORT", cls.robot.server_address[1]),
            mock.patch.object(server.ApplicationHandler, "validate_robot", lambda self, address: "127.0.0.1"),
        ]
        for patch in cls.patches:
            patch.start()
        os.environ.pop("OT2_SITE_PASSWORD", None)

    @classmethod
    def tearDownClass(cls):
        for patch in reversed(cls.patches):
            patch.stop()
        for httpd in (cls.app, cls.robot):
            httpd.shutdown()
            httpd.server_close()

    def setUp(self):
        self.calls.clear()

    def post(self, **fields):
        import urllib.request
        body = json.dumps({"robotAddress": "192.168.1.42", "pin": "4321", **fields}).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{self.app.server_address[1]}/api/ot2/calibration", data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_wrong_pin_never_reaches_the_robot(self):
        status, body = self.post(op="status", pin="0000")
        self.assertEqual((status, body["error"]), (403, "Incorrect PIN."))
        self.assertEqual(self.calls, [])

    def test_only_calibration_sessions_commands_and_small_jogs_are_relayed(self):
        for fields in (
            {"op": "create", "sessionType": "protocol"},
            {"op": "create", "sessionType": "tipLengthCalibration", "createParams": {"mount": "middle"}},
            {"op": "command", "sessionId": self.SESSION, "command": "robot.homeAllMotors"},
            {"op": "command", "sessionId": self.SESSION, "command": "calibration.jog", "data": {"vector": [0, 0, -10.5]}},
            {"op": "command", "sessionId": self.SESSION, "command": "calibration.jog", "data": {"vector": [0, True, 0]}},
            {"op": "command", "sessionId": "../../robot/home", "command": "calibration.saveOffset"},
            {"op": "reboot"},
        ):
            status, _body = self.post(**fields)
            self.assertEqual(status, 400, fields)
        self.assertEqual(self.calls, [])

    def test_jog_is_relayed_and_returns_the_new_session_state(self):
        status, body = self.post(op="command", sessionId=self.SESSION, command="calibration.jog", data={"vector": [0, 0, -0.1], "extra": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["details"]["currentStep"], "labwareLoaded")
        method, path, sent, version = self.calls[0]
        self.assertEqual((method, path, version), ("POST", f"/sessions/{self.SESSION}/commands/execute", "*"))
        self.assertEqual(sent, {"data": {"command": "calibration.jog", "data": {"vector": [0.0, 0.0, -0.1]}}})
        self.assertEqual(self.calls[1][:2], ("GET", f"/sessions/{self.SESSION}"))

    def test_exit_returns_the_tip_then_deletes_the_session(self):
        status, body = self.post(op="command", sessionId=self.SESSION, command="calibration.exitSession")
        self.assertEqual((status, body["details"]["currentStep"]), (200, "sessionExited"))
        self.assertEqual([call[:2] for call in self.calls], [("POST", f"/sessions/{self.SESSION}/commands/execute"), ("DELETE", f"/sessions/{self.SESSION}")])

    def test_robot_refusals_keep_their_status_and_reason(self):
        status, body = self.post(op="command", sessionId=self.SESSION, command="calibration.pickUpTip")
        self.assertEqual(status, 409)
        self.assertIn("may not occur in the state sessionStarted", body["error"])

    def test_create_sends_only_the_settings_each_flow_takes(self):
        self.post(op="create", sessionType="deckCalibration", createParams={"mount": "left", "hasCalibrationBlock": True})
        self.post(op="create", sessionType="pipetteOffsetCalibration", createParams={"mount": "right", "hasCalibrationBlock": "yes", "tipRackDefinition": {}})
        self.assertEqual(self.calls[0][2], {"data": {"sessionType": "deckCalibration"}})
        self.assertEqual(self.calls[1][2], {"data": {"sessionType": "pipetteOffsetCalibration", "createParams": {"hasCalibrationBlock": False, "mount": "right", "shouldRecalibrateTipLength": False}}})

    def test_status_collects_pipettes_calibrations_and_open_sessions(self):
        status, body = self.post(op="status")
        self.assertEqual(status, 200)
        self.assertEqual(body["sessions"], [{"id": self.SESSION, "sessionType": "deckCalibration"}])
        self.assertEqual(sorted(call[1] for call in self.calls), ["/calibration/pipette_offset", "/calibration/status", "/calibration/tip_length", "/health", "/pipettes", "/sessions"])
