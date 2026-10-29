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
rm -rf release && npm run dist:dmg
spctl -a -t exec release/mac-arm64/TerminAI.app
gh release create "v$version" --repo ClipWave-io/terminai --target "$(git rev-parse HEAD)" --title "TerminAI $version" --generate-notes \
  release/TerminAI-$version-arm64.dmg release/TerminAI-$version-arm64-mac.zip release/*.blockmap release/latest-mac.yml
