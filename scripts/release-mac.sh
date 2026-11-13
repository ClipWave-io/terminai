#!/bin/zsh
# Publish a Mac release: bump "version" in package.json first, then run this.
# Builds, signs with the Developer ID, notarizes with the App Store Connect key, and uploads to GitHub releases;
# every installed TerminAI picks it up within a few hours (or with TerminAI › Check for Updates…).
# Needs: ASC_ISSUER_ID, and the key file at $ASC_KEY_PATH (default: ~/Private/Developer Credentials/AuthKey_$ASC_KEY_ID.p8).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID}"
export APPLE_API_KEY_ID="${ASC_KEY_ID:-R6T7FDVQB8}" APPLE_API_ISSUER="$ASC_ISSUER_ID"
export APPLE_API_KEY="${ASC_KEY_PATH:-$HOME/Private/Developer Credentials/AuthKey_$APPLE_API_KEY_ID.p8}"
version=$(node -p "require('./package.json').version")
gh release view "v$version" --repo ClipWave-io/terminai >/dev/null 2>&1 && { echo "v$version is already released: bump the version."; exit 1; }
./scripts/build-notify.sh
rm -rf release && npm run dist:dmg
# The notification module must be in the signed app, outside the asar.
[ -f release/mac-arm64/TerminAI.app/Contents/Resources/app.asar.unpacked/resources/notify.node ] || { echo "notify.node missing from the app"; exit 1; }
spctl -a -t exec release/mac-arm64/TerminAI.app
# The disk image itself signed, notarized and stapled too: a download whose DMG carries no ticket made macOS say
# "Apple could not verify TerminAI is free of malware" on a friend's Mac (13/11), even with the app inside notarized.
dmg="release/TerminAI-$version-arm64.dmg"
codesign --sign "Developer ID Application" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$dmg"
spctl -a -t open --context context:primary-signature "$dmg"
gh release create "v$version" --repo ClipWave-io/terminai --target "$(git rev-parse HEAD)" --title "TerminAI $version" --generate-notes \
  release/TerminAI-$version-arm64.dmg release/TerminAI-$version-arm64-mac.zip release/*.blockmap release/latest-mac.yml
