"""Render lines of narration with Kokoro-82M. Runs in the TTS environment, not the project's.

Reads JSON on stdin and writes one 24 kHz WAV per item:
    {"voice": "af_heart", "speed": 1.0, "items": [{"text": "...", "out": "/path/a.wav"}, ...]}

Setup (once):
    bash setup_tts.sh   (in this folder)
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np          # noqa: E402
import soundfile as sf      # noqa: E402
from kokoro import KPipeline  # noqa: E402

RATE = 24000


def main():
    job = json.load(sys.stdin)
    voice = job["voice"]
    # The voice name's first letter is its language: a = American English, b = British English.
    pipe = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
    for item in job["items"]:
        chunks = [a.numpy() if hasattr(a, "numpy") else np.asarray(a)
                  for _, _, a in pipe(item["text"], voice=voice, speed=job.get("speed", 1.0))]
        audio = np.concatenate(chunks) if chunks else np.zeros(RATE // 4, dtype=np.float32)
        sf.write(item["out"], audio, RATE)
        print(item["out"], flush=True)


if __name__ == "__main__":
    main()
