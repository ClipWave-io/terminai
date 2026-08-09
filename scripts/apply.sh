#!/bin/bash
# Build the app, install it over the copy in /Applications, and relaunch it.
#
# Intended to be run from a tab *inside* the app itself, which means the process
# running this script is about to be killed. The swap-and-relaunch therefore
# happens in a detached child that outlives its parent.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Read the app name from package.json rather than hardcoding it. Hardcoding is
# what broke this once already: the app was renamed, productName changed, and
# the script went on deleting and re-opening a bundle name that no longer
# existed — so it uninstalled the app and never put anything back.
APP_NAME="$(node -p "require('./package.json').build.productName")"
APP="$APP_NAME.app"
BUILT="$REPO/release/mac-arm64/$APP"
INSTALLED="/Applications/$APP"

echo "→ typechecking"
npx tsc --noEmit -p tsconfig.json

echo "→ building $APP"
npx electron-vite build
npx electron-builder --mac --dir

[ -d "$BUILT" ] || {
  echo "build produced no app at $BUILT" >&2
  echo "(build.productName is '$APP_NAME' — does that match what electron-builder emitted?)" >&2
  ls -1d "$REPO"/release/*/*.app 2>/dev/null >&2 || true
  exit 1
}

echo "→ swapping in the new build and relaunching (this window will close)"

# Detached so it survives the app — and this shell — being killed a moment from
# now. setsid is unavailable on macOS, so nohup + & + disown is the equivalent.
#
# The new bundle is staged beside the target and only swapped in once the copy
# has fully succeeded, so a failure here can never leave /Applications empty.
nohup bash -c "
  set -e
  sleep 1
  pkill -f '$APP/Contents/MacOS' 2>/dev/null || true
  sleep 1

  STAGE='/Applications/.$APP_NAME.incoming'
  rm -rf \"\$STAGE\"
  cp -R '$BUILT' \"\$STAGE\"

  rm -rf '$INSTALLED'
  mv \"\$STAGE\" '$INSTALLED'
  touch '$INSTALLED'

  sleep 1
  open -a '$INSTALLED'
" >/tmp/terminai-apply.log 2>&1 &
disown

echo "✓ relaunching… (log: /tmp/terminai-apply.log)"
