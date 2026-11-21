#!/bin/zsh
# Builds "TerminAI Browser": an open-source Chromium snapshot that matches the current Stable release, renamed to our
# own app ID (com.clipwave.term.browser), signed with our Developer ID, notarized and zipped. It runs every Chrome Web
# Store extension (Claude in Chrome, 1Password, ...), which TerminAI's Electron pane cannot.
#
#   scripts/build-browser.sh [snapshot-position]      → release-browser/TerminAI-Browser-<chromium version>-arm64.zip
#
# Publish the zip with scripts/release-browser.sh; TerminAI downloads it on first use (src/main/chromium.ts).
# Passkeys (iCloud Keychain): once Apple grants com.apple.developer.web-browser.public-key-credential to the App ID,
# put the Developer ID provisioning profile at build/browser.provisionprofile and the entitlement is signed in.
set -euo pipefail
cd "$(dirname "$0")/.."
IDENTITY="${BROWSER_SIGN_IDENTITY:-Developer ID Application: Ilai Bachrach (99PQ34696X)}"
BUNDLE_ID=com.clipwave.term.browser NAME="TerminAI Browser"
export APPLE_API_KEY_ID="${ASC_KEY_ID:-R6T7FDVQB8}"
APPLE_API_KEY="${ASC_KEY_PATH:-$HOME/Private/Developer Credentials/AuthKey_$APPLE_API_KEY_ID.p8}"
APPLE_API_ISSUER="${ASC_ISSUER_ID:-fd24451f-352b-4f7b-aac7-1191025a486b}"
BUCKET=https://storage.googleapis.com/chromium-browser-snapshots/Mac_Arm

position="${1:-}"
if [ -z "$position" ]; then
  # The first snapshot at or after the branch point of the current Stable release.
  target=$(curl -fsS "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['chromium_main_branch_position'])")
  position=$(python3 - "$target" <<'EOF'
import json,sys,urllib.request
t=int(sys.argv[1])
for digits in range(len(str(t))-1,2,-1):
    prefix=str(t)[:digits]
    u=f"https://storage.googleapis.com/storage/v1/b/chromium-browser-snapshots/o?prefix=Mac_Arm/{prefix}&delimiter=/&fields=prefixes"
    nums=sorted(int(p.split('/')[1]) for p in json.load(urllib.request.urlopen(u)).get('prefixes',[]))
    later=[n for n in nums if n>=t]
    if later: print(later[0]); break
EOF
)
fi
[[ "$position" =~ ^[0-9]+$ ]] || { echo "No Chromium snapshot found"; exit 1; }

work=build-browser-work; out=release-browser
rm -rf "$work"; mkdir -p "$work" "$out"
echo "Chromium snapshot $position"
curl -fL --progress-bar -o "$work/chrome-mac.zip" "$BUCKET/$position/chrome-mac.zip"
ditto -x -k "$work/chrome-mac.zip" "$work"
app="$work/$NAME.app"
mv "$work/chrome-mac/Chromium.app" "$app"
xattr -cr "$app"
version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist")

plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME" "$plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleDisplayName" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $NAME" "$plist"
# Chromium reads its update/keystone and crash settings from here; ours has none of Google's services.
/usr/libexec/PlistBuddy -c "Delete :KSProductID" "$plist" 2>/dev/null || true
icon=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$plist"); icon="${icon%.icns}.icns"
cp build/icon.icns "$app/Contents/Resources/$icon"
rm -f "$app/Contents/Resources/Assets.car"   # the asset catalog would override the icon file
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$plist" 2>/dev/null || true

entitlements="$work/browser.entitlements.plist"
cat > "$entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.device.camera</key><true/>
  <key>com.apple.security.device.bluetooth</key><true/>
  <key>com.apple.security.device.usb</key><true/>
  <key>com.apple.security.personal-information.location</key><true/>
  <key>com.apple.security.automation.apple-events</key><true/>
</dict></plist>
EOF
# The glue that puts the browser inside TerminAI's browser pane (native/browser-glue.m): TerminAI loads it into the
# browser process with DYLD_INSERT_LIBRARIES, which the hardened runtime only allows with this entitlement.
clang -dynamiclib -fobjc-arc -arch arm64 -mmacosx-version-min=12.0 -framework Cocoa -o "$app/Contents/Frameworks/TerminAIGlue.dylib" native/browser-glue.m
main_entitlements="$work/browser-main.entitlements.plist"; cp "$entitlements" "$main_entitlements"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.allow-dyld-environment-variables bool true" "$main_entitlements"
if [ -f build/browser.provisionprofile ]; then
  # Apple's managed passkey entitlement: only valid with the provisioning profile that grants it.
  cp build/browser.provisionprofile "$app/Contents/embedded.provisionprofile"
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.web-browser.public-key-credential bool true" "$main_entitlements"
  /usr/libexec/PlistBuddy -c "Add :com.apple.application-identifier string 99PQ34696X.$BUNDLE_ID" "$main_entitlements"
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.team-identifier string 99PQ34696X" "$main_entitlements"
  echo "Signing with the passkey entitlement"
fi

sign() { codesign --force --timestamp --options runtime --entitlements "$2" --sign "$IDENTITY" "$1"; }
# Inside out: loose Mach-O files, then helper apps, the framework, and the app last.
fw="$app/Contents/Frameworks"
find "$fw" -type f \( -name "*.dylib" -o -name "*.so" -o -perm -111 \) ! -path "$fw/*.app/*" ! -path "*/_CodeSignature/*" -print0 |
  while IFS= read -r -d '' f; do file -b "$f" | grep -q Mach-O && sign "$f" "$entitlements"; done
find "$fw" -name "*.app" -type d -prune -print0 | while IFS= read -r -d '' h; do sign "$h" "$entitlements"; done
find "$fw" -name "*.framework" -type d -prune -print0 | while IFS= read -r -d '' f; do sign "$f" "$entitlements"; done
sign "$app" "$main_entitlements"
codesign --verify --deep --strict "$app"

zip="$out/TerminAI-Browser-$version-arm64.zip"
ditto -c -k --keepParent "$app" "$zip"
if [ "${SKIP_NOTARIZE:-}" != 1 ]; then
  xcrun notarytool submit "$zip" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$app"
  rm "$zip"; ditto -c -k --keepParent "$app" "$zip"
  spctl -a -t exec -vv "$app"
fi
shasum -a 256 "$zip" | tee "$zip.sha256"
echo "{\"version\":\"$version\",\"position\":$position,\"file\":\"$(basename "$zip")\",\"sha256\":\"$(cut -d' ' -f1 "$zip.sha256")\"}" > "$out/browser.json"
cat "$out/browser.json"
