#!/usr/bin/env python3
"""
Local, free text-to-speech via Kokoro-82M on Apple MLX.

Invoked by the app as:  python tts_local.py <out.wav> <voice> <<< text

Runs entirely on-device — no API key, no network after the model is cached, no
per-character cost. Same spirit as LocalFlow, opposite direction (that one is
speech-to-text).

Setup lives in scripts/setup-local-tts.sh.
"""

import sys
from pathlib import Path

MODEL = "prince-canuma/Kokoro-82M"


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tts_local.py <out.wav> <voice>", file=sys.stderr)
        return 2

    out = Path(sys.argv[1])
    voice = sys.argv[2]
    text = sys.stdin.read().strip()
    if not text:
        print("no text on stdin", file=sys.stderr)
        return 2

    from mlx_audio.tts.generate import generate_audio

    # generate_audio appends its own extension to file_prefix.
    prefix = str(out.with_suffix(""))

    generate_audio(
        text=text,
        model=MODEL,
        voice=voice,
        lang_code="a",  # 'a' = American English
        file_prefix=prefix,
        audio_format="wav",
        join_audio=True,
        save=True,
        verbose=False,
    )

    if not out.exists():
        print(f"model ran but produced no file at {out}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
