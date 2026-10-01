"""Helpers for writing scenes — imported by the project's scenes.py.

    from demo import *

    def s01_overview(pg, mark, at):
        pg.goto(BASE_URL + "/dashboard"); settle(pg)
        mark()                         # content is on screen; the voice starts LEAD s later
        at("Revenue is up")            # wait until the narration reaches this cue phrase
        point(pg, "Revenue")           # glide the cursor to the element whose text starts so
        at("Open the report")
        click(pg, pg.locator("text=Open report"))
        reveal(pg, "Breakdown")        # smooth-scroll it into view, whatever pane it lives in

Everything finds elements by their visible text, so scenes survive layout
changes better than pixel coordinates do.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent        # the video folder: scenes.json, scenes.py, outputs
SPEC = json.loads((HERE / "scenes.json").read_text())
W, H = (SPEC.get("viewport") or [1920, 1080])
STILLS = HERE / "captures"

__all__ = ["HERE", "SPEC", "W", "H", "hold", "settle", "glide", "click", "wheel", "tab", "still",
           "find", "reveal", "point", "hover_text"]


def hold(pg, s):
    """Pause for s seconds (the recording keeps running)."""
    if s > 0:
        pg.wait_for_timeout(int(s * 1000))


def settle(pg, s=1.0):
    """Wait for the network to go quiet, then a little longer for animations."""
    try:
        pg.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    hold(pg, s)


def glide(pg, x, y, steps=25):
    """Move the (visible) cursor smoothly to x, y."""
    pg.mouse.move(x, y, steps=steps)


def click(pg, locator, pause=0.6):
    """Glide to an element, then click it. Only for navigation — never for save/submit/accept/delete."""
    box = locator.bounding_box()
    glide(pg, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    hold(pg, 0.25)
    locator.click()
    hold(pg, pause)


def wheel(pg, x, y, dy, seconds):
    """Smooth scroll of dy pixels over `seconds` with the pointer at (x, y)."""
    glide(pg, x, y, steps=10)
    n = max(1, int(seconds * 20))
    for _ in range(n):
        pg.mouse.wheel(0, dy / n)
        pg.wait_for_timeout(50)


def tab(pg, label, pause=1.5):
    """Click an ARIA tab by its label."""
    click(pg, pg.locator("[role=tab]", has_text=label).first, pause)
    settle(pg, 0)


def still(pg, name):
    """Save a full-resolution screenshot to captures/<name>.png (for slides and the README)."""
    STILLS.mkdir(parents=True, exist_ok=True)
    pg.screenshot(path=str(STILLS / f"{name}.png"))


# --- finding things by their text ------------------------------------------

FIND_JS = """([text, minX, maxX]) => {
  const want = text.toLowerCase();
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (!t.startsWith(want)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.left < minX || r.left > maxX) continue;
    if (!best || t.length < best.t.length) best = { el, t };
  }
  if (!best) return null;
  document.querySelectorAll('[data-find]').forEach(e => e.removeAttribute('data-find'));
  best.el.setAttribute('data-find', '1');
  return true;
}"""

REVEAL_JS = """(offset) => {
  const el = document.querySelector('[data-find]');
  let p = el.parentElement;
  while (p && !(/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 4)) p = p.parentElement;
  p = p || document.scrollingElement;
  const top = el.getBoundingClientRect().top - (p === document.scrollingElement ? 0 : p.getBoundingClientRect().top);
  p.scrollBy({ top: top - offset, behavior: 'smooth' });
}"""


def _missing(text):
    print(f"  warning: not on screen: {text!r} — skipped", flush=True)


def find(pg, text, min_x=0, max_x=None):
    """Locator for the smallest visible element whose text starts with `text` (case-insensitive),
    with its left edge between min_x and max_x — use min_x to target a side panel. None if absent."""
    if not pg.evaluate(FIND_JS, [text, min_x, W if max_x is None else max_x]):
        return None
    return pg.locator("[data-find]")


def reveal(pg, text, min_x=0, max_x=None, offset=140, settle_s=1.0):
    """Smooth-scroll that element to `offset` px below the top of whichever pane scrolls it."""
    if find(pg, text, min_x, max_x) is None:
        return _missing(text)
    pg.evaluate(REVEAL_JS, offset)
    hold(pg, settle_s)


def point(pg, text, min_x=0, max_x=None, dx=0, dy=0, steps=30):
    """Glide the cursor onto that element (its left part for long text), offset by dx, dy."""
    loc = find(pg, text, min_x, max_x)
    if loc is None:
        return _missing(text)
    box = loc.bounding_box()
    glide(pg, box["x"] + min(box["width"] / 2, 160) + dx, box["y"] + box["height"] / 2 + dy, steps=steps)


def hover_text(pg, text, min_x=0, max_x=None):
    """Real hover (opens tooltips) on that element."""
    loc = find(pg, text, min_x, max_x)
    if loc is None:
        return _missing(text)
    loc.hover()
