#!/bin/bash
# Archive the TerminAI To-do iPhone app and upload it to TestFlight, the way the ManyMotions app ships:
# xcodebuild archive with automatic signing, then exportArchive with destination=upload.
# Needs: Xcode signed in to the ClipWave Apple account (team 99PQ34696X); the App Store Connect key below;
# the app record com.clipwave.terminai.todo in App Store Connect. Bump CURRENT_PROJECT_VERSION in project.yml first.
set -euo pipefail
cd "$(dirname "$0")"
KEY_ID="${ASC_KEY_ID:-R6T7FDVQB8}"
KEY_PATH="${ASC_KEY_PATH:-$HOME/Private/Developer Credentials/AuthKey_$KEY_ID.p8}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect issuer id)}"
OUT="${OUT:-/tmp/terminai-todo-release}"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

command -v xcodegen >/dev/null && xcodegen generate --quiet
rm -rf "$OUT" && mkdir -p "$OUT"
xcodebuild -project TerminAITodo.xcodeproj -scheme TerminAITodo -configuration Release -destination generic/platform=iOS \
  -archivePath "$OUT/TerminAITodo.xcarchive" "${AUTH[@]}" COMPILER_INDEX_STORE_ENABLE=NO archive | grep -E "error:|ARCHIVE" || true
[ -d "$OUT/TerminAITodo.xcarchive" ] || { echo "archive failed" >&2; exit 1; }
# Export signs with the Apple account in Xcode: the API key alone has no distribution certificate.
xcodebuild -exportArchive -archivePath "$OUT/TerminAITodo.xcarchive" -exportOptionsPlist ExportOptions.plist -exportPath "$OUT/export" -allowProvisioningUpdates
echo "Uploaded. It shows in TestFlight once Apple has processed it (5-15 minutes)."
