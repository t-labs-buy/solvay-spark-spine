"""Verify a built demo video: narration, timing, picture and leaks.

    python3 <dir>/tools/check.py              # everything
    python3 <dir>/tools/check.py --no-asr     # skip the speech-to-text pass (faster)

Writes clips/_check/report.md and one contact sheet per scene,
clips/_check/<scene>.png: a frame 1.5 s after every cue, labelled with the cue,
so you can see whether the screen shows what the words say.

Checks
  1. Narration — each scene's voice is transcribed (Whisper, local) and compared
     with the script; differing words are listed. Known transcription confusions
     can be listed in scenes.json "check_ignore": [["gst", "gsd"]].
     Capitalised acronyms are printed with the phonemes Kokoro will use, so a
     word spoken as a word ("sap") instead of letters shows up.
  2. Timing — cues the recorder reached late (from clips/marks.json).
  3. Picture — the contact sheets.
  4. Media — total length, silences over 3 s, black stretches over 0.2 s (there are no fades, so any is a fault),
     and any scenes.json "mask" pattern still present in the recorded pages' text.
"""
import difflib
import html
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import voice  # noqa: E402

HERE, SPEC = voice.HERE, voice.SPEC
CLIPS = HERE / "clips"
WORK = CLIPS / "_build"
OUT_DIR = CLIPS / "_check"
VIDEO = HERE / SPEC.get("output", "demo-video.mp4")

NUM = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                  "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
NUM.update({w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())})
SCALE = {"hundred": 100, "thousand": 1000, "million": 1_000_000}


def words_to_digits(tokens):
    out, cur, total, inside = [], 0, 0, False
    tokens = tokens + ["<end>"]
    for i, t in enumerate(tokens):
        if t in NUM:
            cur += NUM[t]
            inside = True
        elif t in SCALE and inside:
            if SCALE[t] == 100:
                cur *= 100
            else:
                total += cur * SCALE[t]
                cur = 0
        elif t == "and" and inside and tokens[i + 1] in NUM:
            continue
        else:
            if inside:
                out.append(str(total + cur))
                cur, total, inside = 0, 0, False
            if t != "<end>":
                out.append(t)
    return out


def norm(text):
    t = voice.MARKUP.sub(lambda m: m.group(0)[1:m.group(0).index("]")], text)       # [Solvay](/…/) → Solvay
    t = t.lower().replace("%", " percent ")
    t = re.sub(r"\b([a-z0-9])(?:-([a-z0-9]))+\b", lambda m: m.group(0).replace("-", ""), t)   # s-a-p → sap
    t = re.sub(r"(?<=\d),(?=\d{3})", "", t)                                                 # 100,000 → 100000
    toks = re.findall(r"\d+(?:\.\d+)?|[a-z0-9']+", t)
    toks = [x.replace("'", "") for x in toks]
    toks = [re.sub(r"is(e|ed|es|ing|ation)$", r"iz\1", x) if len(x) > 6 else x for x in words_to_digits(toks) if x]
    return toks


STOP = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "is", "it", "end", "so"}


def run_tts(job):
    r = subprocess.run([str(voice.KOKORO_PY), str(Path(__file__).with_name("tts_inspect.py"))],
                       input=json.dumps(job), text=True, capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-1500:])
    return json.loads(r.stdout)


def check_narration(lines, asr):
    lines.append("## 1. Narration\n")
    if not voice.VOICE:
        lines.append("Silent cut — nothing to check.\n")
        return 0
    issues = 0
    ignore = {tuple(p) for p in SPEC.get("check_ignore", [])}
    scenes = [s for s in SPEC["scenes"] if s.get("vo")]
    wavs = {s["id"]: str(voice.synth(s)[0]) for s in scenes}
    heard = {}
    if asr:
        if not voice.KOKORO_PY.exists():
            lines.append("Speech-to-text skipped: the TTS environment is missing (run setup_tts.sh).\n")
        else:
            # Tell Whisper the script's names and acronyms, so it can spell what it hears; otherwise
            # an unfamiliar name is "heard" as the nearest common word whatever the voice said.
            vocab = sorted({w for s in scenes for w in re.findall(r"(?<![.!?]\s)(?<!^)\b[A-Z][\w-]*[A-Z0-9a-z]\b", s["vo"])})
            heard = run_tts({"transcribe": list(wavs.values()), "prompt": "Vocabulary: " + ", ".join(vocab) + "."})
    for s in scenes:
        said = norm(voice.spoken(s["vo"]))
        got = norm(heard.get(wavs[s["id"]], "")) if heard else None
        if got is None:
            continue
        diffs = []
        for op, a1, a2, b1, b2 in difflib.SequenceMatcher(a=said, b=got, autojunk=False).get_opcodes():
            if op == "equal":
                continue
            exp, hrd = " ".join(said[a1:a2]), " ".join(got[b1:b2])
            if (exp, hrd) in ignore or exp.replace(" ", "") == hrd.replace(" ", ""):
                continue
            if set(said[a1:a2] + got[b1:b2]) <= STOP:      # Whisper adds/drops small words freely
                continue
            ctx = " ".join(said[max(0, a1 - 4):a1])
            diffs.append(f"  - …{ctx} **{exp or '∅'}** → heard **{hrd or '∅'}**")
        if diffs:
            issues += len(diffs)
            lines.append(f"**{s['id']}** — {len(diffs)} difference(s):")
            lines += diffs
            lines.append("")
    if heard and not issues:
        lines.append("Transcripts match the script.\n")
    if voice.ENGINE == "kokoro" and voice.KOKORO_PY.exists():
        text = " ".join(voice.spoken(s["vo"]) for s in scenes)
        plain = voice.MARKUP.sub(" ", text)                               # skip words that already have phonemes
        vocab = sorted({w for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", plain)})
        ph = run_tts({"phonemes": vocab, "lang": voice.VOICE[:1]})
        unknown = [w for w in vocab if "❓" in ph.get(w, "")]
        if unknown:
            issues += len(unknown)
            lines.append("\n**Words Kokoro cannot pronounce** — they are dropped or garbled. Add a phonetic rule to "
                         "`pronounce.kokoro`, e.g. `[\"\\\\bSolvay\\\\b\", \"[Solvay](/sˈɑlvA/)\"]` "
                         "(misaki IPA: A = 'ay', I = 'eye', O = 'oh'):\n")
            lines += [f"  - {w}" for w in unknown]
            lines.append("")
    acr = sorted({w for s in scenes for w in re.findall(r"\b[A-Z][A-Z0-9]{1,6}(?:'s)?\b", voice.spoken(s["vo"]))})
    if acr and voice.ENGINE == "kokoro" and voice.KOKORO_PY.exists():
        ph = run_tts({"phonemes": acr, "lang": voice.VOICE[:1]})
        lines.append("\nAcronyms and their phonemes — a word-like reading (e.g. `sˈæp` for SAP) means it is said as a "
                     "word; add a `pronounce` rule such as `[\"\\\\bSAP\\\\b\", \"S-A-P\"]` if letters were meant:\n")
        lines += [f"  - {a}: `{ph.get(a, '?')}`" for a in acr]
        lines.append("")
    return issues


def check_timing(lines):
    lines.append("## 2. Timing\n")
    marks_file = CLIPS / "marks.json"
    marks = json.loads(marks_file.read_text()) if marks_file.exists() else {}
    app = [s for s in SPEC["scenes"] if s.get("kind", "app") == "app"]
    marks = {s["id"]: marks.get(s["id"]) for s in app}
    late = [(k, c, d) for k, m in marks.items() if isinstance(m, dict) for c, d in m.get("late", [])]
    unsynced = [s["id"] for s in app if not (isinstance(marks[s["id"]], dict)
                and marks[s["id"]].get("voice") == voice.voice_key(s))]
    lines += [f"  - {k}: {d}s late for “{c}”" for k, c, d in late] or ["All cues on time.\n"]
    if unsynced:
        lines.append(f"  - not recorded against the current voice-over (re-record): {', '.join(unsynced)}")
    lines.append("")
    return len(late) + len(unsynced)


def contact_sheets(lines):
    from playwright.sync_api import sync_playwright
    lines.append("## 3. Picture — contact sheets\n")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    W, H = SPEC.get("viewport") or [1920, 1080]
    sheets = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1920, "height": 1080})
        for s in SPEC["scenes"]:
            seg = WORK / f"{s['id']}.mp4"
            if s.get("kind") == "card" or not seg.exists():
                continue
            _, _, cues = voice.synth(s)
            shots = [("start", 1.0)] + [(c, t + 1.5) for c, t in cues.items()]
            cells = []
            for n, (label, t) in enumerate(shots):
                f = OUT_DIR / f"{s['id']}_{n:02d}.jpg"
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(seg), "-ss", f"{t:.2f}", "-frames:v", "1",
                                "-vf", "scale=640:-2", "-q:v", "4", str(f)], check=True)
                cells.append(f"<figure><img src='{f.name}'><figcaption>{t:5.1f}s · {html.escape(label)}"
                             f"</figcaption></figure>")
            cols = 3
            rows = (len(cells) + cols - 1) // cols
            page = (f"<html><body style='margin:0;padding:12px;background:#111;color:#eee;font:15px -apple-system,sans-serif'>"
                    f"<h3 style='margin:4px 4px 10px'>{html.escape(s['id'])}</h3>"
                    f"<div style='display:grid;grid-template-columns:repeat({cols},640px);gap:10px'>{''.join(cells)}</div>"
                    "<style>figure{margin:0}img{width:640px;display:block;border:1px solid #333}"
                    "figcaption{padding:4px 2px;color:#9fd}</style></body></html>")
            pg.set_viewport_size({"width": cols * 650 + 24, "height": rows * (360 + 34) + 60})
            sheet_html = OUT_DIR / f"{s['id']}.html"          # a file page, so the frames next to it can load
            sheet_html.write_text(page)
            pg.goto(sheet_html.as_uri())
            pg.wait_for_load_state("load")
            out = OUT_DIR / f"{s['id']}.png"
            pg.screenshot(path=str(out), full_page=True)
            sheets.append(out)
        b.close()
    lines += [f"  - `{p.relative_to(HERE)}`" for p in sheets]
    lines.append("\nOpen each sheet and confirm every frame shows what its cue says.\n")


def check_media(lines):
    lines.append("## 4. Media\n")
    issues = 0
    if not VIDEO.exists():
        lines.append(f"{VIDEO.name} not built yet.\n")
        return 1
    dur = voice.secs(VIDEO)
    lines.append(f"  - {VIDEO.name}: {int(dur // 60)}:{int(dur % 60):02d}, {VIDEO.stat().st_size / 1e6:.0f} MB")
    log = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(VIDEO), "-af", "silencedetect=n=-45dB:d=3",
                          "-vf", "blackdetect=d=0.2:pix_th=0.05", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    sil = re.findall(r"silence_start: ([\d.]+)", log)
    blk = re.findall(r"black_start:([\d.]+)", log)
    if voice.VOICE and sil:
        issues += len(sil)
        lines.append(f"  - silences over 3 s at: {', '.join(f'{float(x):.0f}s' for x in sil)}")
    if blk:
        issues += len(blk)
        lines.append(f"  - black over 0.2 s at: {', '.join(f'{float(x):.0f}s' for x in blk)}")
    masks = [re.compile(m, re.I) for m in SPEC.get("mask", [])]
    for f in sorted((CLIPS / "_text").glob("*.txt")):
        for m in masks:
            hit = m.search(f.read_text())
            if hit:
                issues += 1
                lines.append(f"  - mask pattern still visible in {f.stem}: “{hit.group(0)}”")
    email = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
    allowed = {a.lower() for a in SPEC.get("allow_emails", [])}
    for f in sorted((CLIPS / "_text").glob("*.txt")):
        for hit in sorted({h for h in email.findall(f.read_text()) if h.lower() not in allowed}):
            issues += 1
            lines.append(f"  - e-mail address visible in {f.stem}: “{hit}” — hide it (CSS on the field, "
                         f"or a \"mask\" pattern), or list it in \"allow_emails\" if approved")
    if not issues:
        lines.append("  - no long silences, no black stretches, no masked text or e-mail addresses visible")
    lines.append("")
    return issues


def main():
    asr = "--no-asr" not in sys.argv
    lines = [f"# Check — {SPEC.get('title', 'demo video')}\n"]
    n = check_narration(lines, asr)
    n += check_timing(lines)
    contact_sheets(lines)
    n += check_media(lines)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report = OUT_DIR / "report.md"
    report.write_text("\n".join(lines))
    print("\n".join(lines))
    print(f"\n{n} issue(s) flagged · report: {report.relative_to(HERE)}")


if __name__ == "__main__":
    main()
