"""Record each app scene with Playwright, timed to the narration.

The voice for each scene is generated first (voice.py); every at("cue") in
the project's scenes.py waits for the moment the narration reaches that cue
phrase, so picture and words stay in step. One .webm per scene goes to
clips/, with the moment the content was ready in clips/marks.json.

    python3 <dir>/tools/record.py               # all scenes in scenes.py order
    python3 <dir>/tools/record.py s03_summary   # just these

Re-record a scene after changing its voice-over, cues or the voice.
"""
import json
import shutil
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path[:0] = [str(TOOLS), str(TOOLS.parent)]

from playwright.sync_api import sync_playwright  # noqa: E402

import demo   # noqa: E402
import voice  # noqa: E402

HERE, SPEC, W, H = demo.HERE, demo.SPEC, demo.W, demo.H
CLIPS = HERE / "clips"
EARLY = 0.35   # act this much before the words, so the screen lands as they are spoken
THEME = {"accent_rgb": "20,120,110", **SPEC.get("theme", {})}


def init_js():
    """A visible cursor with a click ripple (headless video has none), plus the scenes.json
    "mask" patterns stripped from every text node as the page renders."""
    masks = json.dumps(SPEC.get("mask", []))
    rgb = THEME["accent_rgb"]
    return r"""
(() => {
  const MASKS = %s.map(p => new RegExp(p, 'gi'));
  const strip = (root) => {
    if (!MASKS.length || !root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) {
      let v = n.nodeValue;
      for (const m of MASKS) v = v.replace(m, '');
      if (v !== n.nodeValue) n.nodeValue = v;
    }
  };
  const boot = () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%%;' +
      'background:rgba(%s,.35);border:2px solid rgba(%s,.9);z-index:2147483647;pointer-events:none;' +
      'transition:left .12s linear, top .12s linear;';
    document.body.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', e => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:10px;height:10px;margin:-5px 0 0 -5px;` +
        'border-radius:50%%;border:3px solid rgba(%s,.9);z-index:2147483646;pointer-events:none;' +
        'transition:all .45s ease-out;opacity:1;';
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.width = r.style.height = '56px'; r.style.margin = '-28px 0 0 -28px'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 600);
    }, true);
    strip(document.body);
    new MutationObserver(ms => ms.forEach(m => {
      if (m.type === 'characterData') strip(m.target.parentNode);
      m.addedNodes.forEach(n => strip(n.nodeType === 3 ? n.parentNode : n));
    })).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) boot(); else addEventListener('DOMContentLoaded', boot);
})();
""" % (masks, rgb, rgb, rgb)


def login_state(p, scenes):
    """Sign in once (scenes.login) and reuse the cookies for every scene."""
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": W, "height": H})
    pg = ctx.new_page()
    if hasattr(scenes, "login"):
        try:
            scenes.login(pg)
        except Exception as e:
            b.close()
            if "ERR_CONNECTION_REFUSED" in str(e) or "ERR_NAME_NOT_RESOLVED" in str(e):
                sys.exit(f"The app is not reachable at {getattr(scenes, 'BASE_URL', '?')} — start it, then record again.")
            raise
    state = ctx.storage_state()
    b.close()
    return state


def record(p, state, scenes, scene):
    name = scene["id"]
    _, _, cues = voice.synth(scene)
    length = voice.scene_length(scene)
    tmp = CLIPS / f"_{name}"
    shutil.rmtree(tmp, ignore_errors=True)
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": W, "height": H}, storage_state=state,
                        record_video_dir=str(tmp), record_video_size={"width": W, "height": H})
    ctx.add_init_script(init_js())
    t0 = time.monotonic()
    pg = ctx.new_page()
    st, late = {}, []

    def mark():
        st.setdefault("t", time.monotonic())

    def at(cue):
        if cue not in cues:
            raise KeyError(f"{name}: {cue!r} is not one of this scene's cues in scenes.json")
        if "t" not in st:
            raise RuntimeError(f"{name}: at({cue!r}) before mark()")
        behind = time.monotonic() - (st["t"] + cues[cue] - EARLY)
        if behind > 0.5:
            late.append([cue, round(behind, 1)])
            print(f"  {name}: {behind:.1f}s late for {cue!r}", flush=True)
        else:
            demo.hold(pg, -behind)

    getattr(scenes, name)(pg, mark, at)
    mark()
    demo.hold(pg, st["t"] + length + 0.3 - time.monotonic())
    text_dir = CLIPS / "_text"
    text_dir.mkdir(parents=True, exist_ok=True)
    (text_dir / f"{name}.txt").write_text(pg.evaluate("document.body.innerText"))
    video = pg.video.path()
    ctx.close()
    b.close()
    shutil.move(video, CLIPS / f"{name}.webm")
    shutil.rmtree(tmp, ignore_errors=True)
    return {"t": round(st["t"] - t0, 2), "synced": bool(voice.VOICE), "voice": voice.voice_key(scene), "late": late}


def main():
    import scenes  # the project's scenes.py, next to scenes.json
    CLIPS.mkdir(parents=True, exist_ok=True)
    spec = {s["id"]: s for s in SPEC["scenes"]}
    app_scenes = [s["id"] for s in SPEC["scenes"] if s.get("kind", "app") == "app"]
    for sid in app_scenes:
        if not hasattr(scenes, sid):
            sys.exit(f"scenes.py has no function {sid}() for scene {sid} in scenes.json")
    marks_file = CLIPS / "marks.json"
    marks = json.loads(marks_file.read_text()) if marks_file.exists() else {}
    names = sys.argv[1:] or app_scenes
    with sync_playwright() as p:
        state = login_state(p, scenes)
        for n in names:
            print(f"recording {n} …", flush=True)
            marks[n] = record(p, state, scenes, spec[n])
            marks_file.write_text(json.dumps(marks, indent=2))
    total_late = sum(len(m.get("late", [])) for k, m in marks.items() if k in names)
    print("done" + (f" — {total_late} late cue(s); see above" if total_late else " — all cues on time"))


if __name__ == "__main__":
    main()
