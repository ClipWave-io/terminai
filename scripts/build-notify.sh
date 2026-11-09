#!/bin/sh
# Builds native/notify.mm (TerminAI's notification permission) into resources/notify.node for this Electron.
set -e
cd "$(dirname "$0")/.."
V=$(node -p "require('./node_modules/electron/package.json').version")
clang++ -std=c++17 -fobjc-arc -O2 -arch arm64 -mmacosx-version-min=12.0 -bundle -undefined dynamic_lookup \
  -DNODE_GYP_MODULE_NAME=notify -I"$HOME/.electron-gyp/$V/include/node" \
  -framework Foundation -framework UserNotifications native/notify.mm -o resources/notify.node
echo built resources/notify.node
