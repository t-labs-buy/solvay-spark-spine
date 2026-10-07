"""Assemble the narrated video and the script from scenes.json and the recorded clips.

Writes (in the video folder):
  <output>       captioned MP4 with voice-over — scenes.json "output", default demo-video.mp4
  script.md      timed narration script, generated from scenes.json

    python3 <dir>/tools/build.py
"""
import html
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright  # noqa: E402

import voice  # noqa: E402

HERE = voice.HERE
SPEC = voice.SPEC
CLIPS = HERE / "clips"
WORK = CLIPS / "_build"
OUT = HERE / SPEC.get("output", "demo-video.mp4")
W, H = SPEC.get("viewport") or [1920, 1080]
FPS = 30
FADE = 0.4
THEME = {
    "bg": "#0f1a2b", "accent": "#1d8a7e", "accent_light": "#6fd3c4", "text_dim": "#8ea0b8",
    "caption_bg": "rgba(12,22,38,.86)", "font": "'Inter','Helvetica Neue',Helvetica,Arial,sans-serif",
    **SPEC.get("theme", {}),
}
FONT = f"font-family:{THEME['font']};"


def card_html(c):
    e = html.escape
    bullets = "".join(f"<li>{e(b)}</li>" for b in c.get("bullets", []))
    sub = f"<p class=sub>{e(c['sub'])}</p>" if c.get("sub") else ""
    return f"""<html><body style="margin:0;width:{W}px;height:{H}px;background:{THEME['bg']};color:#fff;{FONT}">
<div style="position:absolute;inset:0;padding:150px 160px;box-sizing:border-box">
  <div style="color:{THEME['accent_light']};font-size:30px;letter-spacing:.14em;text-transform:uppercase">{e(c.get('kicker', ''))}</div>
  <h1 style="font-size:92px;line-height:1.08;margin:28px 0 36px;font-weight:700">{e(c.get('title', ''))}</h1>
  <style>.sub{{font-size:40px;line-height:1.35;color:#c9d4e3;max-width:1400px;margin:0}}
  li{{font-size:42px;line-height:1.3;margin:0 0 26px;color:#e6edf6}} li::marker{{color:{THEME['accent_light']}}}</style>
  {sub}<ul style="padding-left:44px;margin:10px 0 0">{bullets}</ul>
  <div style="position:absolute;left:160px;bottom:110px;font-size:26px;color:{THEME['text_dim']}">{e(c.get('foot', ''))}</div>
  <div style="position:absolute;left:160px;right:160px;bottom:170px;height:4px;background:{THEME['accent']};opacity:.7"></div>
</div></body></html>"""


def caption_html(text):
    return f"""<html><body style="margin:0;background:transparent;width:{W}px;height:{H}px;{FONT}">
<div style="position:absolute;left:0;right:0;bottom:0;height:92px;background:{THEME['caption_bg']};
  display:flex;align-items:center;padding:0 60px;box-sizing:border-box;border-top:4px solid {THEME['accent']}">
  <span style="color:#fff;font-size:34px;font-weight:600;letter-spacing:.005em">{html.escape(text)}</span>
</div></body></html>"""


def render_pngs():
    WORK.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": W, "height": H})
        for s in SPEC["scenes"]:
            if s.get("kind") == "card":
                pg.set_content(card_html(SPEC.get("cards", {}).get(s["id"], {})))
                pg.screenshot(path=str(WORK / f"{s['id']}_card.png"))
            else:
                pg.set_content(caption_html(s.get("caption", "")) if s.get("caption") else
                               f"<html><body style='margin:0;background:transparent;width:{W}px;height:{H}px'></body></html>")
                pg.screenshot(path=str(WORK / f"{s['id']}_cap.png"), omit_background=True)
        b.close()


def ff(*args):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


def segment(s, marks):
    audio, _, _ = voice.synth(s)
    dur = voice.scene_length(s)                 # with a voice: LEAD + voice + TAIL
    # A recording made against this voice (record.py) plays at 1x. One recorded without
    # it is sped up to fit; a short recording holds its last frame.
    m = marks.get(s["id"], 0)
    start = m["t"] if isinstance(m, dict) else m
    speed = 1.0
    if s.get("kind", "app") == "app":
        if not isinstance(m, dict) or m.get("voice") != voice.voice_key(s):
            if "--allow-stale" not in sys.argv:
                sys.exit(f"{s['id']}: its recording was not made against the current voice-over — "
                         f"run tools/record.py {s['id']} (or build with --allow-stale for a rough cut)")
            if audio:   # stale rough cut: squeeze the old recording to the new voice
                speed = max(1.0, (voice.secs(CLIPS / f"{s['id']}.webm") - start) / dur)
    s["_dur"], s["_speed"] = dur, speed
    out = WORK / f"{s['id']}.mp4"
    # Scenes are joined with straight cuts: no fade to or from black, not even at the start and end
    # (users see a dip to black as a flicker). Only the audio gets a short fade-out, against clicks.
    fades = "null"
    enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS)]
    # Audio: the voice (or silence) delayed by LEAD and padded to the scene length, so every
    # segment carries an identical AAC stream and the concat can copy.
    a_in = ["-i", str(audio)] if audio else ["-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo"]
    a_graph = (f"aresample=48000,aformat=channel_layouts=stereo,adelay={int(voice.LEAD * 1000)}:all=1,"
               f"apad,atrim=duration={dur},afade=t=out:st={dur - FADE}:d={FADE}")
    aenc = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000"]
    if s.get("kind") == "card":
        ff("-loop", "1", "-t", str(dur), "-i", str(WORK / f"{s['id']}_card.png"), *a_in,
           "-filter_complex", f"[0:v]fps={FPS},format=yuv420p,{fades}[o];[1:a]{a_graph}[a]",
           "-map", "[o]", "-map", "[a]", "-t", str(dur), *enc, *aenc, str(out))
    else:
        clip = CLIPS / f"{s['id']}.webm"
        if not clip.exists():
            sys.exit(f"missing {clip.name} — run tools/record.py {s['id']} first")
        graph = (f"[0:v]setpts=(PTS-STARTPTS)/{speed:.4f},fps={FPS},scale={W}:{H},"
                 f"tpad=stop_mode=clone:stop_duration={dur},trim=duration={dur},setpts=PTS-STARTPTS[v];"
                 f"[v][1:v]overlay=0:0,{fades}[o];[2:a]{a_graph}[a]")
        ff("-ss", str(start), "-i", str(clip), "-loop", "1", "-i", str(WORK / f"{s['id']}_cap.png"), *a_in,
           "-filter_complex", graph, "-map", "[o]", "-map", "[a]", "-t", str(dur), *enc, *aenc, str(out))
    return out


def build_video():
    marks_file = CLIPS / "marks.json"
    marks = json.loads(marks_file.read_text()) if marks_file.exists() else {}
    render_pngs()
    segs = [segment(s, marks) for s in SPEC["scenes"]]
    for s in SPEC["scenes"]:
        print(f"  {s['id']:22} {s['_dur']:6.1f}s" + (f"  recording x{s['_speed']:.2f}" if s["_speed"] != 1 else ""))
    lst = WORK / "concat.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in segs))
    ff("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(OUT))


def ts(sec):
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def build_script():
    t = 0
    rows, body = [], []
    for i, s in enumerate(SPEC["scenes"]):
        d = s.get("_dur", s.get("dur", 0))
        start, end = t, t + d
        t = end
        name = s["id"].split("_", 1)[-1].replace("_", " ")
        cap = s.get("caption") or "(card)"
        rows.append(f"| {i} | {ts(start)}–{ts(end)} | {name} | {cap} |")
        body.append(
            f"### {i}. {ts(start)}–{ts(end)} · {name}\n\n"
            + (f"**Screen:** {s['screen']}\n\n" if s.get("screen") else "")
            + (f"**Caption:** {s['caption']}\n\n" if s.get("caption") else "")
            + f"**Voice-over** ({len(s.get('vo', '').split())} words, {d:g} s):\n\n> {s.get('vo', '')}\n")
    engine = {"kokoro": f"Kokoro-82M (open source), voice `{voice.VOICE}`",
              "say": f"macOS `say`, voice `{voice.VOICE}`"}[voice.ENGINE] if voice.VOICE else "no voice (silent cut)"
    sub = f"{SPEC['subtitle']}. " if SPEC.get("subtitle") else ""
    md = f"""# {SPEC.get('title', 'Demo video')} — script

{sub}Total running time: **{ts(t)}**.

Generated from `scenes.json` by `tools/build.py`; edit `scenes.json`, not this file.
Narration: {engine}. Each screen action is timed to a cue phrase in the voice-over.

| # | Time | Scene | On-screen caption |
|---|---|---|---|
{chr(10).join(rows)}

{chr(10).join(body)}"""
    (HERE / "script.md").write_text(md)


if __name__ == "__main__":
    build_video()
    build_script()
    print(OUT)
