#!/usr/bin/env python3
"""Static server plus a PIN-protected, upload-only OT-2 protocol proxy."""

from __future__ import annotations

import hmac
import ipaddress
import json
import mimetypes
import os
import re
import socket
import urllib.error
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
MAX_REQUEST_BYTES = 2_000_000
HOST_PATTERN = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,120}\.py$")


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
        if urlparse(self.path).path.endswith("/api/health"):
            self.send_json(200, {"status": "ok", "directUpload": bool(os.environ.get("OT2_UPLOAD_PIN"))})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if not urlparse(self.path).path.endswith("/api/ot2/upload"):
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
            if len(protocol.encode("utf-8")) > 500_000:
                raise RequestError(413, "Protocol is too large.")
            response = upload_protocol(host, filename, protocol.encode("utf-8"), worklist_id)
            protocol_id = response.get("data", {}).get("id")
            self.send_json(200, {"status": "uploaded", "protocolId": protocol_id, "robot": host})
        except RequestError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except Exception as exc:  # Keep internal details out of the public response.
            self.log_error("OT-2 upload failed: %s", exc)
            self.send_json(502, {"error": "The OT-2 did not accept the protocol. Verify its address, software version, and connectivity."})

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

    def authorize(self, supplied_pin: str) -> None:
        expected_pin = os.environ.get("OT2_UPLOAD_PIN", "")
        if not expected_pin:
            raise RequestError(503, "Direct OT-2 upload is not configured on this server.")
        if not hmac.compare_digest(str(supplied_pin), expected_pin):
            raise RequestError(403, "Incorrect upload PIN.")

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
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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


def main() -> None:
    mimetypes.add_type("text/javascript", ".js")
    host = os.environ.get("OT2_VISUALIZER_HOST", "127.0.0.1")
    port = int(os.environ.get("OT2_VISUALIZER_PORT", "8766"))
    server = ThreadingHTTPServer((host, port), ApplicationHandler)
    print(f"OT-2 visualizer listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
