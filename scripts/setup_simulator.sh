#!/usr/bin/env bash
# Build the Opentrons OT-2 protocol engine used by WL Simulation.
#
# PyPI's `opentrons` package no longer supports OT-2 protocols at recent API
# levels, so the engine is installed from the OT-2 robot-stack source tag.
# Pin OT2_ENGINE_VERSION to the software version installed on your robots.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_VERSION="${OT2_ENGINE_VERSION:-v26.6.0}"
VENV="${OT2_SIM_VENV:-$ROOT/.venv-sim}"
SOURCE_DIR="$ROOT/.sim-build/opentrons-ot2-$ENGINE_VERSION"
REPOSITORY="https://github.com/Opentrons/opentrons-ot2.git"

find_python() {
  local candidate
  for candidate in "${OT2_SIM_BASE_PYTHON:-}" python3.12 python3.11 python3.10 python3; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

BASE_PYTHON="$(find_python)" || {
  echo "Python 3.10 or newer is required. On Ubuntu: sudo apt install python3 python3-venv" >&2
  exit 1
}
echo "Using $BASE_PYTHON ($("$BASE_PYTHON" --version))"

if [ ! -d "$SOURCE_DIR/api" ]; then
  echo "Fetching opentrons-ot2 $ENGINE_VERSION source…"
  rm -rf "$SOURCE_DIR"
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone --quiet --depth 1 --branch "$ENGINE_VERSION" --filter=blob:none --sparse \
    -c advice.detachedHead=false "$REPOSITORY" "$SOURCE_DIR"
  git -C "$SOURCE_DIR" sparse-checkout set api shared-data
fi

if [ ! -x "$VENV/bin/python" ]; then
  "$BASE_PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
echo "Installing the OT-2 engine into $VENV (this takes a minute)…"
"$VENV/bin/python" -m pip install --quiet "$SOURCE_DIR/shared-data" "$SOURCE_DIR/api"

INSTALLED="$("$VENV/bin/python" -c 'import opentrons; print(opentrons.__version__)')"
echo "$INSTALLED" > "$VENV/ENGINE_VERSION"
echo "OT-2 engine $INSTALLED ready. Restart server.py to enable WL Simulation."
