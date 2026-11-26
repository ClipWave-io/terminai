#!/bin/zsh
# Builds the LocalFlow.app that TerminAI's "Set up voice dictation" installs: LocalFlow with its own Python and
# packages inside the app (nothing outside it is needed), signed with the Developer ID, notarized and stapled, zipped.
#
#   localflow-dist/build.sh            build + notarize into $TMPDIR/localflow-build/
#   localflow-dist/build.sh --publish  also upload it as the GitHub release localflow-v<version> on ClipWave-io/terminai
#
# The LocalFlow source (default ~/Clipwave/LocalFlow-0.2) is only read, never changed; its .venv gives the exact
# package versions. The speech model is not in the app: TerminAI downloads it after installing.
# Notarizing needs ASC_ISSUER_ID (and the key at $ASC_KEY_PATH), like scripts/release-mac.sh. NOTARIZE=0 skips it.
set -euo pipefail; setopt null_glob
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${LOCALFLOW_SRC:-$HOME/Clipwave/LocalFlow-0.2}
OUT=${OUT:-${TMPDIR:-/tmp}/localflow-build}  # no spaces: uv cannot take an interpreter path with spaces
VERSION=${VERSION:-$(grep -m1 '^APP_VERSION' "$SRC/localflow/app.py" | cut -d'"' -f2)}
BUNDLE_ID=xyz.terminai.localflow
IDENTITY=${IDENTITY:-Developer ID Application}
APP="$OUT/LocalFlow.app"; RES="$APP/Contents/Resources"; PY="$RES/python"
ZIP="$OUT/LocalFlow-$VERSION-arm64.zip"

[ "$(uname -m)" = arm64 ] || { echo "Build on Apple Silicon."; exit 1; }
rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$RES/app/assets/sounds"

echo "› Python 3.12 (relocatable build from uv)"
uv python install cpython-3.12-macos-aarch64-none --managed-python --no-bin -i "$OUT/pyinstall" >/dev/null
cp -R "$(print -r -- "$OUT"/pyinstall/cpython-3.12*(/[1]))" "$PY"
rm -rf "$OUT/pyinstall" "$PY"/lib/python3.12/{test,idlelib,tkinter,turtledemo,ensurepip} "$PY"/lib/{tcl,tk,itcl,thread}* "$PY"/lib/libtcl* "$PY"/lib/libtk* "$PY"/include "$PY"/share
rm -f "$PY"/lib/python3.12/EXTERNALLY-MANAGED

echo "› Packages (the versions LocalFlow runs with today; mlx-whisper and torch left out: Parakeet only)"
uv pip freeze --python "$SRC/.venv/bin/python3" > "$OUT/constraints.txt"
uv pip install --quiet --python "$PY/bin/python3" -c "$OUT/constraints.txt" \
  parakeet-mlx sounddevice rumps pyobjc-core pyobjc-framework-Cocoa pyobjc-framework-Quartz numpy requests \
  pyobjc-framework-ApplicationServices pyobjc-framework-WebKit
SP="$PY/lib/python3.12/site-packages"
rm -rf "$SP"/PyObjCTest "$SP"/*/tests "$SP"/*/test "$SP"/pip* "$PY"/bin/pip* "$PY"/bin/idle* "$PY"/bin/pydoc*
find "$PY" -name __pycache__ -type d -prune -exec rm -rf {} +

echo "› LocalFlow $VERSION from $SRC"
rsync -a --exclude '__pycache__' --exclude '*.bak*' "$SRC/localflow" "$RES/app/"
cp "$SRC"/assets/sounds/soft-*.wav "$RES/app/assets/sounds/"
cp "$SRC/assets/AppIcon.icns" "$RES/AppIcon.icns"
# The login item points at wherever this copy is installed, not only /Applications.
sed -i '' 's|app_path = "/Applications/LocalFlow.app"|app_path = __import__("os").environ.get("LOCALFLOW_APP", "/Applications/LocalFlow.app")|' "$RES/app/localflow/app.py"
grep -q 'LOCALFLOW_APP' "$RES/app/localflow/app.py" || { echo "login item patch did not apply"; exit 1; }
cp "$HERE/run.sh" "$RES/run.sh"; chmod +x "$RES/run.sh"
"$PY/bin/python3" -m compileall -q -j0 "$RES/app" "$PY/lib/python3.12" >/dev/null || true
"$PY/bin/python3" -c "import sys; sys.path.insert(0, '$RES/app'); import parakeet_mlx, sounddevice, rumps, AppKit, Quartz, WebKit, ApplicationServices, localflow.engines" \
  || { echo "bundled Python cannot import LocalFlow's packages"; exit 1; }

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleName</key><string>LocalFlow</string>
    <key>CFBundleDisplayName</key><string>LocalFlow</string>
    <key>CFBundleExecutable</key><string>LocalFlow</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSArchitecturePriority</key><array><string>arm64</string></array>
    <key>NSMicrophoneUsageDescription</key>
    <string>LocalFlow needs the microphone to transcribe your dictation on-device.</string>
</dict>
</plist>
EOF
swiftc -O -target arm64-apple-macos13 -o "$APP/Contents/MacOS/LocalFlow" "$HERE/LocalFlowStub.swift" 2>&1 | grep -v warning | grep -E 'error' && exit 1 || true

echo "› Signing every binary (hardened runtime)"
sign() { codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@" >/dev/null 2>&1 || codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@"; }
find "$RES" -type f \( -name '*.so' -o -name '*.dylib' -o -perm +111 \) -print0 | while IFS= read -r -d '' f; do
  file -b "$f" | grep -q Mach-O && print -r -- "$f"; done > "$OUT/machos.txt"
grep -v "/bin/python3" "$OUT/machos.txt" | tr '\n' '\0' | xargs -0 -n 40 -P 6 codesign --force --timestamp --options runtime --sign "$IDENTITY"
grep "/bin/python3" "$OUT/machos.txt" | while read -r f; do sign --entitlements "$HERE/entitlements.plist" "$f"; done
sign --entitlements "$HERE/entitlements.plist" --identifier "$BUNDLE_ID" "$APP"
codesign --verify --deep --strict "$APP"
echo "  $(wc -l < "$OUT/machos.txt" | tr -d ' ') binaries signed, $(du -sh "$APP" | cut -f1) app"

if [ "${NOTARIZE:-1}" = 1 ]; then
  echo "› Notarizing"
  : "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID}"
  KEY_ID=${ASC_KEY_ID:-R6T7FDVQB8}; KEY=${ASC_KEY_PATH:-$HOME/Private/Developer Credentials/AuthKey_$KEY_ID.p8}
  ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
  xcrun notarytool submit "$OUT/notarize.zip" --key "$KEY" --key-id "$KEY_ID" --issuer "$ASC_ISSUER_ID" --wait | tee "$OUT/notary.log"
  grep -q 'status: Accepted' "$OUT/notary.log" || { echo "notarization failed"; exit 1; }
  xcrun stapler staple "$APP"; rm -f "$OUT/notarize.zip"
  spctl -a -vv -t exec "$APP"
fi
ditto -c -k --keepParent "$APP" "$ZIP"
SHA=$(shasum -a 256 "$ZIP" | cut -d' ' -f1); SIZE=$(stat -f %z "$ZIP")
print -r -- "{\"version\":\"$VERSION\",\"url\":\"https://github.com/ClipWave-io/terminai/releases/download/localflow-v$VERSION/LocalFlow-$VERSION-arm64.zip\",\"sha256\":\"$SHA\",\"size\":$SIZE}" > "$OUT/manifest.json"
echo "› $ZIP ($SIZE bytes, sha256 $SHA)"

if [ "${1:-}" = --publish ]; then
  gh release view "localflow-v$VERSION" --repo ClipWave-io/terminai >/dev/null 2>&1 && { echo "localflow-v$VERSION exists: bump VERSION."; exit 1; }
  gh release create "localflow-v$VERSION" "$ZIP" "$OUT/manifest.json" --repo ClipWave-io/terminai --latest=false \
    --title "LocalFlow $VERSION (voice dictation for TerminAI)" \
    --notes "LocalFlow, installed by TerminAI's Set up voice dictation. Hold fn, talk, and the words are typed. Signed and notarized; the speech model downloads separately."
fi
