#!/bin/bash
# Installs MacGuard for this user, next to TerminAI:
#   ~/Library/Application Support/MacGuard/macguard.py   the guardian (its state.json, config.json and log stay here)
#   ~/Library/LaunchAgents/com.terminai.macguard.plist   starts it at login and keeps it running
#   ~/.local/bin/macguard                                the command: macguard status | gate [N] | resume [ID...] | selftest
# Run it again to update: the previous script is kept as macguard.py.bak-<time>.
#   macguard/install.sh             install or update, then wait for the first sample
#   macguard/install.sh --uninstall stop it and remove the LaunchAgent and the command (its folder stays)
#   macguard/install.sh --no-load   write the files without starting it (tests)
# Thresholds: config.json in its folder overrides the defaults at the top of macguard.py, re-read on every sample.
set -euo pipefail
LABEL=com.terminai.macguard
DIR="$HOME/Library/Application Support/MacGuard"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
BIN="$HOME/.local/bin/macguard"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$BIN"
  echo "MacGuard stopped; its folder is still in $DIR"
  exit 0
fi

SRC="$(cd "$(dirname "$0")" && pwd)/macguard.py"
[ -f "$SRC" ] || { echo "macguard.py not found next to install.sh" >&2; exit 1; }
/usr/bin/python3 -I "$SRC" --home "$(mktemp -d)" selftest >/dev/null || { echo "selftest failed: nothing installed" >&2; exit 1; }

mkdir -p "$DIR" "$AGENTS" "$(dirname "$BIN")"
[ -f "$DIR/macguard.py" ] && cp -p "$DIR/macguard.py" "$DIR/macguard.py.bak-$(date +%Y%m%d%H%M%S)"
cp "$SRC" "$DIR/macguard.py"

cat > "$BIN" <<'EOF'
#!/bin/sh
exec /usr/bin/python3 -I "$HOME/Library/Application Support/MacGuard/macguard.py" "$@"
EOF
chmod 755 "$BIN"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/python3</string>
		<string>-I</string>
		<string>$DIR/macguard.py</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardErrorPath</key><string>$DIR/launchd.err</string>
</dict>
</plist>
EOF
plutil -lint -s "$PLIST"

[ "${1:-}" = "--no-load" ] && { echo "MacGuard written, not started (--no-load)"; exit 0; }

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
before=$(stat -f %m "$DIR/state.json" 2>/dev/null || echo 0)
launchctl bootstrap "$DOMAIN" "$PLIST"
for _ in $(seq 1 30); do
  now=$(stat -f %m "$DIR/state.json" 2>/dev/null || echo 0)
  if [ "$now" -gt "$before" ]; then "$BIN" status || true; echo "MacGuard is running ($LABEL)"; exit 0; fi
  sleep 1
done
echo "MacGuard did not write its state within 30 s: see $DIR/launchd.err" >&2
exit 1
