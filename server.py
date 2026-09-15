#!/usr/bin/env python3
"""Static server, PIN-protected OT-2 upload proxy, and protocol simulation endpoint."""

from __future__ import annotations

import gzip
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from http.cookies import SimpleCookie
from urllib.parse import unquote, urlparse

from worklists import pcr_amp


ROOT = Path(__file__).resolve().parent
MAX_REQUEST_BYTES = 2_000_000
HOST_PATTERN = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,120}\.py$")
MAX_PROTOCOL_BYTES = 500_000
# Only the app's own top-level web files are served; project internals such as
# .sim-cache (other users' results), .venv-sim, .git, and server code are not.
STATIC_FILE_PATTERN = re.compile(r"^/[A-Za-z0-9_-]+\.(?:html|js|css|png|svg|ico)$")

SIM_WORKER = ROOT / "simulation" / "worker.py"
SIM_CACHE_DIR = ROOT / ".sim-cache"
SIM_CACHE_LIMIT = 50
SIMULATION_SLOT = threading.BoundedSemaphore(1)

SESSION_COOKIE = "ot2_session"
SESSION_SECONDS = 12 * 60 * 60
# Sessions are signed with a per-process secret, so restarting the server signs everyone out.
SESSION_SECRET = secrets.token_bytes(32)
LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_FAILURES = 5
LOGIN_FAILURES: dict[str, list[float]] = {}
LOGIN_LOCK = threading.Lock()


class ApplicationHandler(SimpleHTTPRequestHandler):
    server_version = "OT2Visualizer/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path.endswith("/login"):
            self.send_login_page()
            return
        if path.endswith("/logout"):
            self.send_response(302)
            self.send_header("Location", "./")
            self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not self.require_session(path):
            return
        if path.endswith("/api/health"):
            self.send_json(200, {
                "status": "ok",
                "directUpload": bool(os.environ.get("OT2_UPLOAD_PIN")),
                "siteLogin": bool(site_password()),
                "simulator": {
                    "installed": simulator_python().exists(),
                    "engineVersion": engine_version(),
                    "pinRequired": simulation_pin_required(),
                },
            })
            return
        if path != "/" and not STATIC_FILE_PATTERN.fullmatch(unquote(path)):
            self.send_error(404, "Not found")
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        path = urlparse(self.path).path
        if not self.require_session(path):
            return
        if path != "/" and not STATIC_FILE_PATTERN.fullmatch(unquote(path)):
            self.send_error(404, "Not found")
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path.endswith("/api/login"):
            self.handle_login()
            return
        if not self.require_session(path):
            return
        if path.endswith("/api/simulate"):
            self.handle_simulate()
            return
        if path.endswith("/api/pcr-amp/plan"):
            self.handle_pcr_amp_plan()
            return
        if not path.endswith("/api/ot2/upload"):
            self.send_json(404, {"error": "Not found"})
            return
        try:
            request = self.read_json_request()
            self.authorize(request.get("pin", ""))
            host = self.validate_robot(request.get("robotAddress", ""))
            filename = request.get("filename", "")
            protocol = request.get("protocol", "")
            worklist_id = str(request.get("worklistId", ""))[:100]
            if not FILENAME_PATTERN.fullmatch(filename):
                raise RequestError(400, "Invalid protocol filename.")
            if not isinstance(protocol, str) or not protocol.startswith("from opentrons import protocol_api"):
                raise RequestError(400, "Generated protocol content is invalid.")
            if len(protocol.encode("utf-8")) > MAX_PROTOCOL_BYTES:
                raise RequestError(413, "Protocol is too large.")
            response = upload_protocol(host, filename, protocol.encode("utf-8"), worklist_id)
            protocol_id = response.get("data", {}).get("id")
            self.send_json(200, {"status": "uploaded", "protocolId": protocol_id, "robot": host})
        except RequestError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except Exception as exc:  # Keep internal details out of the public response.
            self.log_error("OT-2 upload failed: %s", exc)
            self.send_json(502, {"error": "The OT-2 did not accept the protocol. Verify its address, software version, and connectivity."})

    def require_session(self, path: str) -> bool:
        """Every page, asset, and API needs a signed-in session when a site password is set."""
        if not site_password() or valid_session(self.session_token()):
            return True
        if "/api/" in path:
            self.send_json(401, {"error": "Sign in to continue.", "login": True})
        elif path.endswith("/") or path.endswith(".html"):
            # Serve the form in place rather than redirecting: behind a path-prefix
            # proxy (e.g. /ot2 without a trailing slash) a relative redirect would
            # leave the app. The page works out its base path in the browser.
            self.send_login_page(status=401)
        else:
            self.send_error(401, "Sign in required")
        return False

    def session_token(self) -> str:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else ""

    def client_ip(self) -> str:
        """Visitor address; behind a local reverse proxy (Tailscale Serve/Funnel) use X-Forwarded-For."""
        address = self.client_address[0]
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded and ipaddress.ip_address(address).is_loopback:
            return forwarded.split(",")[0].strip()[:64] or address
        return address

    def handle_login(self) -> None:
        client = self.client_ip()
        try:
            if not site_password():
                raise RequestError(404, "Sign-in is not enabled on this server.")
            if login_blocked(client):
                raise RequestError(429, "Too many incorrect attempts. Wait a few minutes and try again.")
            request = self.read_json_request()
            if not hmac.compare_digest(str(request.get("password", "")), site_password()):
                record_login_failure(client)
                raise RequestError(401, "Incorrect password.")
            clear_login_failures(client)
            body = json.dumps({"status": "ok"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Set-Cookie", f"{SESSION_COOKIE}={issue_session()}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Strict")
            self.end_headers()
            self.wfile.write(body)
        except RequestError as exc:
            self.send_json(exc.status, {"error": exc.message})

    def send_login_page(self, status: int = 200) -> None:
        if status == 200 and (not site_password() or valid_session(self.session_token())):
            self.send_response(302)
            self.send_header("Location", "./")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = LOGIN_PAGE.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def handle_simulate(self) -> None:
        try:
            request = self.read_json_request()
            if simulation_pin_required():
                self.authorize(request.get("pin", ""), purpose="Protocol simulation")
            if request.get("sample") is True:
                filename, protocol = "sample_protocol.py", (ROOT / "sample_protocol.py").read_text()
            else:
                filename, protocol = request.get("filename", ""), request.get("protocol", "")
            if not isinstance(filename, str) or not FILENAME_PATTERN.fullmatch(filename):
                raise RequestError(400, "Protocol filenames may contain letters, numbers, dots, dashes, and underscores, and must end in .py.")
            if not isinstance(protocol, str) or "opentrons" not in protocol:
                raise RequestError(400, "This file does not look like an Opentrons Python protocol.")
            if len(protocol.encode("utf-8")) > MAX_PROTOCOL_BYTES:
                raise RequestError(413, "Protocol is too large.")
            status, body = simulate_protocol(filename, protocol)
            self.send_json_bytes(status, body)
        except RequestError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except Exception as exc:
            self.log_error("Simulation failed: %s", exc)
            self.send_json(500, {"error": "The simulator failed unexpectedly. Check the server log."})

    def handle_pcr_amp_plan(self) -> None:
        try:
            request = self.read_json_request()
            csv_text = request.get("csv", "")
            if not isinstance(csv_text, str) or not csv_text.strip():
                raise RequestError(400, "Upload a PCR plan CSV.")
            identifier = request.get("identifier", "")
            plan = pcr_amp.plan_transfer(
                csv_text,
                identifier=identifier if isinstance(identifier, str) else "",
                transfer_volume=request.get("transferVolume", pcr_amp.DEFAULT_TRANSFER_UL),
                starting_volume=request.get("startingVolume", pcr_amp.DEFAULT_STARTING_UL),
            )
            self.send_json(200, plan)
        except pcr_amp.PlanError as exc:
            self.send_json(422, {"error": "The PCR plan cannot be transferred.", "errors": exc.errors})
        except RequestError as exc:
            self.send_json(exc.status, {"error": exc.message})

    def read_json_request(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise RequestError(400, "Invalid request length.") from exc
        if length < 1 or length > MAX_REQUEST_BYTES:
            raise RequestError(413, "Request is empty or too large.")
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RequestError(400, "Request must contain valid JSON.") from exc
        if not isinstance(value, dict):
            raise RequestError(400, "Request must be a JSON object.")
        return value

    def authorize(self, supplied_pin: str, purpose: str = "Direct OT-2 upload") -> None:
        expected_pin = os.environ.get("OT2_UPLOAD_PIN", "")
        if not expected_pin:
            raise RequestError(503, f"{purpose} is not configured on this server. Set OT2_UPLOAD_PIN and restart it.")
        if not hmac.compare_digest(str(supplied_pin), expected_pin):
            raise RequestError(403, "Incorrect PIN.")

    def validate_robot(self, raw_host: str) -> str:
        host = str(raw_host).strip().rstrip(".")
        if not HOST_PATTERN.fullmatch(host):
            raise RequestError(400, "Enter only the OT-2 IP address or local hostname.")
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(host, 31950, type=socket.SOCK_STREAM)}
        except socket.gaierror as exc:
            raise RequestError(400, "The robot address could not be resolved from the server.") from exc
        if not addresses or not all(is_allowed_robot_ip(address) for address in addresses):
            raise RequestError(400, "The robot must resolve to a private LAN or Tailscale address.")
        ipv4_addresses = sorted(address for address in addresses if ipaddress.ip_address(address).version == 4)
        if not ipv4_addresses:
            raise RequestError(400, "The robot address must resolve to an IPv4 address.")
        # Connect to the validated address itself to prevent DNS rebinding between
        # validation and upload.
        return ipv4_addresses[0]

    def send_json(self, status: int, value: dict) -> None:
        self.send_json_bytes(status, json.dumps(value).encode("utf-8"))

    def send_json_bytes(self, status: int, body: bytes) -> None:
        encoding = None
        if len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body, encoding = gzip.compress(body, compresslevel=6), "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(body)


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def is_allowed_robot_ip(raw_address: str) -> bool:
    address = ipaddress.ip_address(raw_address.split("%", 1)[0])
    tailscale = address.version == 4 and address in ipaddress.ip_network("100.64.0.0/10")
    return (address.is_private or tailscale) and not (
        address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified
    )


def multipart_body(field_name: str, filename: str, protocol: bytes, key: str) -> tuple[bytes, str]:
    boundary = f"----ot2-visualizer-{uuid.uuid4().hex}"
    chunks = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\nContent-Type: text/x-python\r\n\r\n".encode(),
        protocol,
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\n{key}\r\n--{boundary}--\r\n".encode(),
    ]
    return b"".join(chunks), boundary


def upload_protocol(host: str, filename: str, protocol: bytes, key: str) -> dict:
    last_error: Exception | None = None
    # `files` is current; `protocolFile` supports older OT-2 robot software.
    for field_name in ("files", "protocolFile"):
        body, boundary = multipart_body(field_name, filename, protocol, key)
        request = urllib.request.Request(
            f"http://{host}:31950/protocols",
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Opentrons-Version": "2",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read(2_000_000))
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in (400, 404, 422):
                break
    raise last_error or RuntimeError("OT-2 upload failed")


def site_password() -> str:
    """Password for entering the app; the gate is off when OT2_SITE_PASSWORD is unset."""
    return os.environ.get("OT2_SITE_PASSWORD", "")


def issue_session(now: float | None = None) -> str:
    expires = int((now if now is not None else time.time()) + SESSION_SECONDS)
    signature = hmac.new(SESSION_SECRET, str(expires).encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{signature}"


def valid_session(token: str, now: float | None = None) -> bool:
    expires, _, signature = token.partition(".")
    if not expires.isdigit() or not signature:
        return False
    expected = hmac.new(SESSION_SECRET, expires.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected) and int(expires) > (now if now is not None else time.time())


def login_blocked(client: str, now: float | None = None) -> bool:
    now = now if now is not None else time.time()
    with LOGIN_LOCK:
        recent = [t for t in LOGIN_FAILURES.get(client, []) if now - t < LOGIN_WINDOW_SECONDS]
        LOGIN_FAILURES[client] = recent
        return len(recent) >= LOGIN_MAX_FAILURES


def record_login_failure(client: str, now: float | None = None) -> None:
    with LOGIN_LOCK:
        LOGIN_FAILURES.setdefault(client, []).append(now if now is not None else time.time())


def clear_login_failures(client: str) -> None:
    with LOGIN_LOCK:
        LOGIN_FAILURES.pop(client, None)


LOGIN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · OT-2 Manufacturing Tools</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(circle at 78% 12%, rgba(125,47,150,.22), transparent 35%), linear-gradient(145deg,#1d0c23,#0f0713);
    color: #fbf7fc; font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: min(360px, 100%); display: grid; gap: 14px; padding: 28px; border: 1px solid #684073; border-radius: 12px;
    background: linear-gradient(145deg,rgba(55,28,64,.92),rgba(30,14,37,.95)); box-shadow: 0 24px 70px rgba(0,0,0,.35); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .mark { width: 26px; height: 32px; display: grid; grid-template-columns: repeat(2,1fr); grid-template-rows: repeat(3,1fr); gap: 1px; }
  .mark i { background: #f000dc; clip-path: polygon(0 0,100% 50%,0 100%); }
  .mark i:nth-child(even) { transform: scaleX(-1); }
  .brand strong { display: block; font-size: 20px; letter-spacing: .09em; line-height: 1; }
  .brand small { display: block; margin-top: 3px; font-size: 7px; letter-spacing: .15em; }
  h1 { margin: 0; font-size: 18px; }
  p { margin: 0; color: #b49eb9; font-size: 12px; }
  label { display: grid; gap: 6px; color: #d5c6d9; font-size: 11px; font-weight: 700; }
  input { width: 100%; padding: 11px 12px; color: #fbf7fc; font: inherit; font-size: 16px; letter-spacing: .2em;
    border: 1px solid #694675; border-radius: 6px; outline: none; background: #25112c; }
  input:focus { border-color: #f000dc; box-shadow: 0 0 0 3px rgba(240,0,220,.14); }
  button { min-height: 42px; color: white; font: inherit; font-weight: 750; border: 1px solid #ff3be9; border-radius: 6px;
    background: linear-gradient(135deg,#f000dc,#a633df); cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  .error { min-height: 16px; color: #ffb6be; font-size: 12px; }
</style>
</head>
<body>
<form id="login">
  <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span><span><strong>BUILT</strong><small>BIOTECHNOLOGIES</small></span></div>
  <h1>OT-2 Manufacturing Tools</h1>
  <p>Enter the password to continue.</p>
  <label>Password<input id="password" type="password" inputmode="numeric" autocomplete="current-password" required autofocus></label>
  <div id="error" class="error" role="alert"></div>
  <button id="submit" type="submit">Sign in</button>
</form>
<script>
// The app may be mounted under a path prefix (/ot2); resolve its base from this URL.
var base = window.location.pathname.replace(/\/(login|index\.html)$/, "/").replace(/([^/])$/, "$1/");
document.getElementById("login").addEventListener("submit", async function (event) {
  event.preventDefault();
  var button = document.getElementById("submit"), error = document.getElementById("error");
  button.disabled = true; error.textContent = "";
  try {
    var response = await fetch(base + "api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("password").value }) });
    if (response.ok) { window.location.replace(base); return; }
    var result = await response.json().catch(function () { return {}; });
    error.textContent = result.error || "Sign-in failed.";
    document.getElementById("password").select();
  } catch (e) {
    error.textContent = "The server could not be reached.";
  } finally {
    button.disabled = false;
  }
});
</script>
</body>
</html>
"""


def simulation_pin_required() -> bool:
    """Simulation is open by default; set OT2_SIM_REQUIRE_PIN=1 to gate it behind OT2_UPLOAD_PIN."""
    return os.environ.get("OT2_SIM_REQUIRE_PIN", "") == "1"


def simulator_python() -> Path:
    return Path(os.environ.get("OT2_SIM_PYTHON", str(ROOT / ".venv-sim" / "bin" / "python")))


def engine_version() -> str | None:
    marker = simulator_python().parent.parent / "ENGINE_VERSION"
    try:
        return marker.read_text().strip() or None
    except OSError:
        return None


def limit_worker_resources() -> None:
    """Basic isolation for uploaded protocol code (applied in the worker process)."""
    try:
        import resource
    except ImportError:
        return
    limits = (
        ("RLIMIT_AS", 4 * 1024**3),
        ("RLIMIT_CPU", 300),
        ("RLIMIT_FSIZE", 200 * 1024**2),
        ("RLIMIT_NOFILE", 512),
    )
    for name, value in limits:
        limit = getattr(resource, name, None)
        if limit is None:
            continue
        try:
            resource.setrlimit(limit, (value, value))
        except (ValueError, OSError):
            pass  # macOS does not enforce every limit


def simulate_protocol(filename: str, protocol: str) -> tuple[int, bytes]:
    """Run the protocol in the simulator worker; returns (HTTP status, JSON body)."""
    python = simulator_python()
    version = engine_version()
    if not python.exists():
        raise RequestError(503, "The OT-2 simulator is not installed on this server. Run scripts/setup_simulator.sh, then restart the server.")
    key = hashlib.sha256(f"{version}\0{filename}\0{protocol}".encode("utf-8")).hexdigest()
    cached = SIM_CACHE_DIR / f"{key}.json"
    if cached.exists():
        os.utime(cached)
        return 200, cached.read_bytes()
    if not SIMULATION_SLOT.acquire(blocking=False):
        raise RequestError(429, "Another simulation is running. Try again in a few seconds.")
    try:
        with tempfile.TemporaryDirectory(prefix="ot2-sim-") as tmp:
            workdir = Path(tmp)
            protocol_path = workdir / filename
            output_path = workdir / "result.json"
            protocol_path.write_text(protocol, encoding="utf-8")
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": str(workdir),
                "TMPDIR": str(workdir),
                "LANG": "C.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            timeout = float(os.environ.get("OT2_SIM_TIMEOUT", "180"))
            with open(workdir / "worker.log", "wb") as log:
                process = subprocess.Popen(
                    [str(python), str(SIM_WORKER), str(protocol_path), str(output_path)],
                    cwd=workdir, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True, preexec_fn=limit_worker_resources,
                )
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    raise RequestError(504, f"The simulation exceeded {timeout:.0f} seconds and was stopped.")
                finally:
                    kill_process_group(process)
            if not output_path.exists():
                tail = (workdir / "worker.log").read_bytes()[-2000:].decode("utf-8", "replace")
                raise RuntimeError(f"worker exited {process.returncode} without a result: {tail}")
            body = output_path.read_bytes()
        result = json.loads(body)
        if result.get("status") in ("rejected", "crashed"):
            status = 422 if result["status"] == "rejected" else 500
            return status, json.dumps({"error": result.get("rejection", "Simulation failed.")}).encode("utf-8")
        store_cached_result(cached, body)
        return 200, body
    finally:
        SIMULATION_SLOT.release()


def kill_process_group(process: subprocess.Popen) -> None:
    """Stop the worker and the emulator processes it started."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait()


def store_cached_result(path: Path, body: bytes) -> None:
    SIM_CACHE_DIR.mkdir(exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)
    entries = sorted(SIM_CACHE_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    for stale in entries[SIM_CACHE_LIMIT:]:
        stale.unlink(missing_ok=True)


def main() -> None:
    mimetypes.add_type("text/javascript", ".js")
    host = os.environ.get("OT2_VISUALIZER_HOST", "127.0.0.1")
    port = int(os.environ.get("OT2_VISUALIZER_PORT", "8766"))
    server = ThreadingHTTPServer((host, port), ApplicationHandler)
    print(f"OT-2 visualizer listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
