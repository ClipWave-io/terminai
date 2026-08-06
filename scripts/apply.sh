#!/bin/bash
# Build the app, install it over the copy in /Applications, and relaunch it.
#
# Intended to be run from a tab *inside* the app itself, which means the process
# running this script is about to be killed. The swap-and-relaunch therefore
# happens in a detached child that outlives its parent.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="Clipwave Term.app"
BUILT="$REPO/release/mac-arm64/$APP"
INSTALLED="/Applications/$APP"

cd "$REPO"

echo "→ typechecking"
npx tsc --noEmit -p tsconfig.json

echo "→ building"
npx electron-vite build
npx electron-builder --mac --dir

[ -d "$BUILT" ] || { echo "build produced no app at $BUILT" >&2; exit 1; }

echo "→ swapping in the new build and relaunching (this window will close)"

# Detached so it survives the app — and this shell — being killed a moment from
# now. setsid is unavailable on macOS, so nohup + & + disown is the equivalent.
nohup bash -c "
  sleep 1
  pkill -f '$APP/Contents/MacOS' 2>/dev/null || true
  sleep 1
  rm -rf '$INSTALLED'
  cp -R '$BUILT' /Applications/
  touch '$INSTALLED'
  sleep 1
  open -a '$INSTALLED'
" >/tmp/clipwave-term-apply.log 2>&1 &
disown

echo "✓ relaunching…"
