"""Inspection helpers that run in the TTS environment (used by check.py).

    echo '{"transcribe": ["a.wav", ...]}'          | python tts_inspect.py   → {"a.wav": "text", ...}
    echo '{"phonemes": ["SAP", "L2C"], "lang": "a"}' | python tts_inspect.py → {"SAP": "sˈæp", ...}
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")


def main():
    job = json.load(sys.stdin)
    out = {}
    if job.get("transcribe"):
        import mlx_whisper
        for f in job["transcribe"]:
            r = mlx_whisper.transcribe(f, path_or_hf_repo=job.get("model", "mlx-community/whisper-small-mlx"),
                                       language="en", initial_prompt=job.get("prompt"))
            out[f] = r["text"].strip()
    if job.get("phonemes"):
        from misaki import en
        g = en.G2P(trf=False, british=job.get("lang") == "b", fallback=None)
        for w in job["phonemes"]:
            out[w] = g(w)[0]
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
