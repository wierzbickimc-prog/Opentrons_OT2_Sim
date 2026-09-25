#!/bin/bash
# OT-2 Manufacturing Tools launcher, run by the app bundle.
#
#   launcher.sh start        set up on first run, start the server, print its URL
#   launcher.sh stop         stop the server
#   launcher.sh needs-setup  exit 0 when this version has not been set up yet
#   launcher.sh pin-asked    exit 0 once the robot PIN question has been answered
#   launcher.sh set-pin      read a robot PIN on stdin and save it (empty: no PIN)
#
# Everything the tools need ships in the bundle: a Python runtime for each Mac
# architecture and every package as a wheel, so setup needs no network, no
# Python, and no developer tools. Setup unpacks them into Application Support,
# because the bundle itself may be read-only (App Translocation).
set -euo pipefail

RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$RESOURCES/VERSION")"
DATA="${OT2_TOOLS_HOME:-$HOME/Library/Application Support/OT-2 Manufacturing Tools}"
INSTALL="$DATA/$VERSION"
PYTHON="$INSTALL/python/bin/python3"
CONFIG="$DATA/config.env"
PIDFILE="$DATA/server.pid"
PORTFILE="$DATA/server.port"
LOG="$DATA/logs/server.log"

# Apple silicon runs the arm64 runtime even when this script runs under Rosetta.
architecture() {
  if [ -n "${OT2_TOOLS_ARCH:-}" ]; then echo "$OT2_TOOLS_ARCH"; return; fi  # testing only
  if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    echo arm64
  else
    echo x86_64
  fi
}

setup() {
  [ -f "$INSTALL/.ready" ] && return 0
  local arch partial
  arch="$(architecture)"
  partial="$INSTALL.partial"
  mkdir -p "$DATA/logs"
  rm -rf "$partial"
  mkdir -p "$partial"
  {
    echo "== setting up $VERSION ($arch) $(date)"
    tar -xzf "$RESOURCES/runtime/python-$arch.tar.gz" -C "$partial"
    cp -R "$RESOURCES/app" "$partial/app"
    # Copies of a downloaded app inherit its quarantine; the user approved the app itself.
    xattr -dr com.apple.quarantine "$partial" 2>/dev/null || true
    "$partial/python/bin/python3" -m pip install --quiet --no-index --disable-pip-version-check \
      --find-links "$RESOURCES/wheels/any" --find-links "$RESOURCES/wheels/$arch" \
      opentrons opentrons_shared_data
    "$partial/python/bin/python3" -c 'import opentrons; print(opentrons.__version__)' > "$partial/python/ENGINE_VERSION"
  } >> "$DATA/logs/setup.log" 2>&1 || { echo "Setup failed; see $DATA/logs/setup.log" >&2; return 1; }
  rm -rf "$INSTALL"
  mv "$partial" "$INSTALL"
  touch "$INSTALL/.ready"
  # Earlier versions are no longer needed; settings in config.env are kept.
  find "$DATA" -mindepth 1 -maxdepth 1 -type d ! -name logs ! -name "$VERSION" -exec rm -rf {} + 2>/dev/null || true
}

running_url() {
  [ -f "$PIDFILE" ] && [ -f "$PORTFILE" ] || return 1
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || return 1
  local url="http://127.0.0.1:$(cat "$PORTFILE")/"
  curl -fs -o /dev/null --max-time 2 "${url}api/health" || return 1
  echo "$url"
}

free_port() {
  "$PYTHON" - <<'PY'
import socket
# The server sets SO_REUSEADDR, so a port a stopped server just released is reusable.
for port in range(8766, 8800):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        break
else:
    raise SystemExit("No free port between 8766 and 8799.")
PY
}

start() {
  if running_url; then return 0; fi
  setup
  local port pid
  port="$(free_port)"
  mkdir -p "$(dirname "$LOG")"
  (
    set -a
    [ -f "$CONFIG" ] && . "$CONFIG"
    set +a
    cd "$INSTALL/app"
    # Only this Mac can reach the server, so there is no site password.
    OT2_VISUALIZER_HOST=127.0.0.1 OT2_VISUALIZER_PORT="$port" OT2_SIM_PYTHON="$PYTHON" \
      nohup "$PYTHON" server.py >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
  )
  echo "$port" > "$PORTFILE"
  pid="$(cat "$PIDFILE")"
  for _ in $(seq 1 60); do
    if running_url; then return 0; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  echo "The server did not start; see $LOG" >&2
  return 1
}

stop() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE" "$PORTFILE"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  needs-setup) [ ! -f "$INSTALL/.ready" ] ;;
  pin-asked) [ -f "$CONFIG" ] ;;
  set-pin)
    mkdir -p "$DATA"
    pin="$(cat)"
    umask 077
    # The PIN enables direct robot upload and live calibration from this Mac.
    if [ -z "$pin" ]; then
      echo "# No robot PIN: direct upload and live calibration are off." > "$CONFIG"
    else
      printf 'OT2_UPLOAD_PIN=%q\n' "$pin" > "$CONFIG"
    fi
    ;;
  *) echo "usage: $0 start|stop|needs-setup|pin-asked|set-pin" >&2; exit 2 ;;
esac
