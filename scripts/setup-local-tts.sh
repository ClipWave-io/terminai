#!/bin/bash
# Install the free, on-device TTS engine (Kokoro-82M on Apple MLX).
#
# Everything lands in ~/.clipwave-term/tts so it never pollutes the system
# Python and can be removed with a single `rm -rf`. Roughly 2 GB with the model.
#
#   bash scripts/setup-local-tts.sh
#
# Apple Silicon only — MLX has no Intel build.

set -euo pipefail

VENV="$HOME/.clipwave-term/tts"

command -v uv >/dev/null 2>&1 || {
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
}

echo "→ creating $VENV"
uv venv "$VENV" --python 3.11

echo "→ installing mlx-audio + misaki"
# misaki does the grapheme-to-phoneme work Kokoro needs; without it the model
# loads and then silently produces nothing.
uv pip install --python "$VENV/bin/python" mlx-audio "misaki[en]"

echo "→ warming the model (first run downloads ~350 MB)"
# misaki shells out to `uv pip install` for its spaCy model at first use and
# fails if it cannot see an active virtualenv, so hand it one explicitly.
VIRTUAL_ENV="$VENV" PATH="$VENV/bin:$PATH" "$VENV/bin/python" \
  "$(dirname "$0")/tts_local.py" /tmp/clipwave-tts-warmup.wav af_heart <<<"Local voice ready."

rm -f /tmp/clipwave-tts-warmup.wav
echo "✓ done — pick 'Local (Kokoro)' in Settings → Engine"
