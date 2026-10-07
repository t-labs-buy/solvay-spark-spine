"""Narration shared by record.py, build.py and check.py.

A scene's voice-over is split at its cue phrases (scenes.json "cues") and each
part is spoken separately — by Kokoro-82M (kokoro_say.py, open source, runs
locally) or macOS `say` — so the time at which every cue starts is known
exactly. record.py waits for those times before doing the matching screen
action; build.py lays the same audio under the recording.

Env:
  TTS          kokoro | say      (default: kokoro if its environment exists)
  VOICE        Kokoro: af_heart (default), af_bella, am_michael, bf_emma, bm_george, …
               say: Daniel (default), Samantha, …     ""  = silent cut
  VOICE_SPEED  Kokoro pace, default 1.0
  VOICE_RATE   say words per minute, default 155
  KOKORO_PYTHON  python of the TTS environment (default ~/.cache/demo-video-tts/bin/python)
"""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SPEC = json.loads((HERE / "scenes.json").read_text())
CACHE = HERE / "clips" / "_voice"

KOKORO_PY = Path(os.environ.get("KOKORO_PYTHON", Path.home() / ".cache" / "demo-video-tts" / "bin" / "python"))
ENGINE = os.environ.get("TTS", "kokoro" if KOKORO_PY.exists() else "say")
VOICE = os.environ.get("VOICE", SPEC.get("voice", {}).get(ENGINE) or ("af_heart" if ENGINE == "kokoro" else "Daniel"))
RATE = os.environ.get("VOICE_RATE", "155")
SPEED = float(os.environ.get("VOICE_SPEED", SPEC.get("voice", {}).get("speed", 1.0)))
LEAD, TAIL = 0.6, 1.2                           # silence before / after each scene's voice

# How the voice should say what the script writes for the eye — per project, per engine:
#   "pronounce": {"kokoro": [["\\bSAP\\b", "S-A-P"]], "say": [["\\bSAP\\b", "S A P"]]}
# Kokoro spells most capitalised acronyms by itself; check.py shows what it got wrong.
PRONOUNCE = [tuple(r) for r in SPEC.get("pronounce", {}).get(ENGINE, [])]


MARKUP = re.compile(r"\[[^\]]*\]\(/[^)]*/\)")     # Kokoro phoneme markup: [word](/phonemes/)


def spoken(text):
    """The voice-over as it is sent to the voice: pronounce rules applied in order, never inside
    a [word](/phonemes/) span an earlier rule produced."""
    for pat, rep in PRONOUNCE:
        plain, marks = MARKUP.split(text), MARKUP.findall(text)
        plain = [re.sub(pat, rep, p) for p in plain]
        text = "".join(p + (marks[i] if i < len(marks) else "") for i, p in enumerate(plain))
    return text


def secs(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                                capture_output=True, text=True, check=True).stdout)


def parts(scene):
    """The voice-over cut at each cue phrase: [(cue or None, text), ...]."""
    vo, out, pos = scene["vo"], [], 0
    for cue in scene.get("cues", []):
        i = vo.find(cue, pos)
        if i < 0:
            raise ValueError(f"{scene['id']}: cue not in voice-over, or out of order: {cue!r}")
        out.append(vo[pos:i].strip())
        pos = i
    out.append(vo[pos:].strip())
    cues = [None] + list(scene.get("cues", []))
    return [(c, t) for c, t in zip(cues, out) if t or c]


def voice_key(scene):
    """Identifies everything that shapes a scene's narration; record.py stores it, build.py checks it."""
    if not VOICE or not scene.get("vo"):
        return "silent"
    return hashlib.sha1(json.dumps([ENGINE, VOICE, RATE, SPEED, PRONOUNCE, scene["vo"], scene.get("cues", []),
                                   scene.get("pauses", {})])
                        .encode()).hexdigest()[:12]


def synth(scene):
    """(audio file, voice length, {cue: seconds from scene start}) — cached on everything that affects it."""
    if not VOICE or not scene.get("vo"):
        return None, 0.0, {c: 0.0 for c in scene.get("cues", [])}
    CACHE.mkdir(parents=True, exist_ok=True)
    key = voice_key(scene)
    wav, meta = CACHE / f"{scene['id']}-{key}.wav", CACHE / f"{scene['id']}-{key}.json"
    if wav.exists() and meta.exists():
        m = json.loads(meta.read_text())
        return wav, m["total"], m["cues"]
    todo = [(cue, text, CACHE / f"{scene['id']}-{key}-{n}.{'wav' if ENGINE == 'kokoro' else 'aiff'}")
            for n, (cue, text) in enumerate(parts(scene))]
    said = [(t, f) for _, t, f in todo if t]
    if ENGINE == "kokoro":
        job = {"voice": VOICE, "speed": SPEED, "items": [{"text": spoken(t), "out": str(f)} for t, f in said]}
        r = subprocess.run([str(KOKORO_PY), str(Path(__file__).with_name("kokoro_say.py"))],
                           input=json.dumps(job), text=True, capture_output=True)
        if r.returncode:
            raise RuntimeError(f"Kokoro failed for {scene['id']}:\n{r.stderr[-2000:]}")
    else:
        for t, f in said:
            subprocess.run(["say", "-v", VOICE, "-r", RATE, "-o", str(f), spoken(t)], check=True)
    # "pauses": {"<cue>": seconds} in a scene puts that much silence before the cue is spoken.
    pauses = scene.get("pauses", {})
    rate = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
                           "-of", "csv=p=0", str(said[0][1])], capture_output=True, text=True).stdout.strip() or "24000"
    files, cues, t = [], {}, 0.0
    for n, (cue, text, f) in enumerate(todo):
        if cue in pauses:
            gap = CACHE / f"{scene['id']}-{key}-{n}-pause.wav"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-t", str(pauses[cue]),
                            "-i", f"anullsrc=r={rate}:cl=mono", str(gap)], check=True)
            files.append(gap)
            t += float(pauses[cue])
        if cue:
            cues[cue] = round(LEAD + t, 2)
        if text:
            files.append(f)
            t += secs(f)
    ins = sum((["-i", str(f)] for f in files), [])
    graph = "".join(f"[{i}:a]" for i in range(len(files))) + f"concat=n={len(files)}:v=0:a=1,aresample=48000[a]"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *ins, "-filter_complex", graph, "-map", "[a]", str(wav)], check=True)
    for f in files:
        f.unlink()
    total = secs(wav)
    meta.write_text(json.dumps({"total": total, "cues": cues}))
    return wav, total, cues


def scene_length(scene):
    """Seconds the scene lasts: its voice plus breathing room, or scenes.json dur when silent."""
    _, total, _ = synth(scene)
    return round(LEAD + total + TAIL, 1) if total else scene.get("dur", 8)


if __name__ == "__main__":
    # Render (or reuse) every scene's narration and print its length and cue times.
    tot = 0
    for s in SPEC["scenes"]:
        n = scene_length(s)
        tot += n
        _, _, c = synth(s)
        print(f"{s['id']:22} {n:6.1f}s  " + "  ".join(f"{k[:18]}@{v:.1f}" for k, v in c.items()))
    print(f"total {int(tot // 60)}:{int(tot % 60):02d}  ({ENGINE}, {VOICE})")
