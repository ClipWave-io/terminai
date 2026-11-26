#!/bin/sh
# Started by the LocalFlow.app launcher: the bundled Python runs LocalFlow from Contents/Resources/app.
R="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/share/localflow"
export LOCALFLOW_FOLLOW_PARENT=1 PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONPATH="$R/app"
cd "$R/app"
exec "$R/python/bin/python3" -m localflow >> "$HOME/.local/share/localflow/localflow.log" 2>&1
