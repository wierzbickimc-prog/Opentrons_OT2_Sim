#!/bin/bash
# Build the double-click macOS release: dist/OT-2-Manufacturing-Tools-<version>-macOS.zip
#
#   packaging/macos/build_release.sh 1.0.0
#
# The app carries everything it needs: a standalone CPython for Apple silicon and
# Intel, the OT-2 engine built from the pinned opentrons-ot2 source, and every
# dependency as a wheel for both architectures. A target Mac needs no Python,
# git, developer tools, or network. Building needs this repository with
# scripts/setup_simulator.sh already run (it provides the engine source and a
# Python with pip), plus network access for the downloads.
set -euo pipefail

VERSION="${1:?usage: build_release.sh <version, e.g. 1.0.0>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/packaging/macos"
ENGINE_VERSION="${OT2_ENGINE_VERSION:-v26.6.0}"
SOURCE="$ROOT/.sim-build/opentrons-ot2-$ENGINE_VERSION"
BUILD_PYTHON="$ROOT/.venv-sim/bin/python"
# Standalone CPython (github.com/astral-sh/python-build-standalone); wheels are built for this version.
PBS_RELEASE="20260924"
PYTHON_VERSION="3.12.14"
PYTHON_TAG="312"
APP_NAME="OT-2 Manufacturing Tools"
WORK="$ROOT/build/macos"
DIST="$ROOT/dist"
APP="$WORK/$APP_NAME.app"
RES="$APP/Contents/Resources"

[ -d "$SOURCE/api" ] && [ -x "$BUILD_PYTHON" ] || { echo "Run scripts/setup_simulator.sh first." >&2; exit 1; }
rm -rf "$WORK"
mkdir -p "$WORK/downloads" "$DIST"

echo "== App shell"
osacompile -o "$APP" "$HERE/app.applescript"
cp "$HERE/AppIcon.icns" "$RES/applet.icns"
plutil -replace CFBundleIdentifier -string "com.builtdna.ot2-manufacturing-tools" "$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "$APP_NAME" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace LSMinimumSystemVersion -string "11.0" "$APP/Contents/Info.plist"
cp "$HERE/launcher.sh" "$RES/launcher.sh"
chmod +x "$RES/launcher.sh"
echo "$VERSION" > "$RES/VERSION"

echo "== Web app (tracked files only)"
mkdir -p "$RES/app"
(cd "$ROOT" && git ls-files -z -- server.py sample_protocol.py '*.html' '*.js' '*.css' worklists simulation labware \
  | grep -zv '^tests/' | xargs -0 -I{} rsync -R {} "$RES/app/")

echo "== OT-2 engine wheels ($ENGINE_VERSION)"
mkdir -p "$RES/wheels/any"
"$BUILD_PYTHON" -m pip wheel --quiet --no-deps --wheel-dir "$RES/wheels/any" "$SOURCE/shared-data" "$SOURCE/api"

echo "== Dependency wheels for arm64 and x86_64"
"$BUILD_PYTHON" -m pip freeze --exclude opentrons --exclude opentrons_shared_data --exclude pip > "$WORK/requirements.txt"
for arch in arm64 x86_64; do
  mkdir -p "$RES/wheels/$arch"
  "$BUILD_PYTHON" -m pip download --quiet --only-binary=:all: --no-deps --dest "$RES/wheels/$arch" \
    --platform "macosx_11_0_$arch" --python-version "$PYTHON_TAG" --implementation cp -r "$WORK/requirements.txt"
done
# Pure-Python wheels are identical for both architectures; keep one copy.
for wheel in "$RES/wheels/arm64"/*-none-any.whl; do
  mv "$wheel" "$RES/wheels/any/"
  rm -f "$RES/wheels/x86_64/$(basename "$wheel")"
done

echo "== Python $PYTHON_VERSION runtimes"
base="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE"
curl -fsSL "$base/SHA256SUMS" -o "$WORK/downloads/SHA256SUMS"
mkdir -p "$RES/runtime"
for pair in arm64:aarch64 x86_64:x86_64; do
  arch="${pair%%:*}"
  name="cpython-$PYTHON_VERSION+$PBS_RELEASE-${pair##*:}-apple-darwin-install_only_stripped.tar.gz"
  curl -fsSL "$base/${name/+/%2B}" -o "$WORK/downloads/$name"
  expected="$(awk -v n="$name" '$2 == n { print $1 }' "$WORK/downloads/SHA256SUMS")"
  actual="$(shasum -a 256 "$WORK/downloads/$name" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Checksum mismatch for $name" >&2; exit 1; }
  cp "$WORK/downloads/$name" "$RES/runtime/python-$arch.tar.gz"
done

echo "== Sign (ad hoc) and package"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
zip="$DIST/OT-2-Manufacturing-Tools-$VERSION-macOS.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$zip"
shasum -a 256 "$zip" | tee "$zip.sha256"
du -h "$zip"
