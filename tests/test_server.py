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
        self.assertFalse(server.is_allowed_robot_ip("169.254.1.2"))

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
        status, headers, _ = self.request("/")
        self.assertEqual((status, headers.get("Location")), (302, "login"))
        self.assertEqual(self.request("/app.js")[0], 302)
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
