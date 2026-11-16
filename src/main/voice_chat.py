#!/usr/bin/env python3
"""
TerminAI's voice conversation worker: speech to text with Parakeet v3 (the model LocalFlow uses, same Hugging Face
cache, so a Mac with LocalFlow downloads nothing) and text to speech with Kokoro, both on Apple MLX, on this Mac,
free. One process keeps both models loaded while a conversation is on, so a reply takes about a second instead of
the half minute a cold start costs; the app ends it when the conversation ends, which gives the memory back.

Protocol, one JSON object per line on stdin and stdout:
  {"id": 1, "stt": "/path/audio.f32"}             raw float32 mono 16 kHz  ->  {"id": 1, "text": "..."}
  {"id": 2, "tts": "text", "out": "/path.wav", "voice": "af_heart"}        ->  {"id": 2, "ok": true}
  errors                                                                     ->  {"id": n, "error": "..."}
A line {"ready": true} is printed once the models are warm.
"""

import json
import sys

STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
TTS_MODEL = "prince-canuma/Kokoro-82M"


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    import numpy as np
    import mlx.core as mx

    stt = None
    tts = None
    try:
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel

        stt = from_pretrained(STT_MODEL)
        stt.generate(get_logmel(mx.zeros(16000), stt.preprocessor_config))  # compiles the Metal kernels once
    except Exception as e:  # noqa: BLE001
        say({"warn": f"speech to text unavailable: {e}"})
    try:
        from mlx_audio.tts.utils import load_model

        tts = load_model(TTS_MODEL)
    except Exception as e:  # noqa: BLE001
        say({"warn": f"local voice unavailable: {e}"})
    mx.clear_cache()
    say({"ready": True, "stt": stt is not None, "tts": tts is not None})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        try:
            if "stt" in req:
                if stt is None:
                    raise RuntimeError("speech to text is not installed")
                samples = np.fromfile(req["stt"], dtype=np.float32)
                if len(samples) < 16000:
                    samples = np.pad(samples, (0, 16000 - len(samples)))
                result = stt.generate(get_logmel(mx.array(samples), stt.preprocessor_config))
                text = result[0].text if isinstance(result, list) else result.text
                say({"id": rid, "text": text.strip()})
            elif "tts" in req:
                if tts is None:
                    raise RuntimeError("the local voice is not installed")
                import soundfile as sf

                chunks = [np.array(r.audio) for r in tts.generate(text=req["tts"], voice=req.get("voice") or "af_heart", speed=1.0, lang_code="a")]
                audio = np.concatenate(chunks) if chunks else np.zeros(2400, dtype=np.float32)
                sf.write(req["out"], audio, 24000)
                say({"id": rid, "ok": True})
            mx.clear_cache()
        except Exception as e:  # noqa: BLE001
            say({"id": rid, "error": str(e)[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
