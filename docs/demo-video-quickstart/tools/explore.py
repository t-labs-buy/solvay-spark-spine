"""First pass over the app: stills and page text for every screen, before writing any scene.

    python3 <dir>/tools/explore.py /dashboard /reports            # paths after BASE_URL (or full URLs)
    python3 <dir>/tools/explore.py /analysis/42 --tabs            # also click every [role=tab]

Signs in with scenes.login(). Writes pass1/<nn>_<name>_<k>.png (one per
screen-height of scrolling) and pass1/<nn>_<name>.txt (the page's text) — read
the text files for the facts the script will quote, and look at the stills to
plan the scenes. Read-only: it clicks tabs and nothing else.
"""
import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path[:0] = [str(TOOLS), str(TOOLS.parent)]

from playwright.sync_api import sync_playwright  # noqa: E402

import demo  # noqa: E402

OUT = demo.HERE / "pass1"
SCROLLER_JS = """() => { let best=null,bh=0; for (const el of document.querySelectorAll('*')) { const s=getComputedStyle(el);
  if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight>el.clientHeight+20 && el.clientHeight>400 && el.clientWidth>600) {
    if (el.clientHeight*el.clientWidth>bh){bh=el.clientHeight*el.clientWidth;best=el;} } }
  const e = best || document.scrollingElement; e.setAttribute('data-cap','1'); return [e.scrollHeight, e.clientHeight]; }"""


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:40] or "page"


def capture(pg, name):
    h, ch = pg.evaluate(SCROLLER_JS)
    (OUT / f"{name}.txt").write_text(pg.evaluate("document.body.innerText"))
    y, k = 0, 0
    while True:
        pg.evaluate("y => document.querySelector('[data-cap]').scrollTo(0, y)", y)
        demo.hold(pg, 0.5)
        pg.screenshot(path=str(OUT / f"{name}_{k}.png"))
        k += 1
        if y + ch >= h or k >= 8:
            break
        y += int(ch * 0.85)
    pg.evaluate("() => document.querySelector('[data-cap]').scrollTo(0, 0)")
    print(f"  {name}: {k} still(s), {h}px tall")


def main():
    import scenes
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tabs = "--tabs" in sys.argv
    if not args:
        sys.exit(__doc__)
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_context(viewport={"width": demo.W, "height": demo.H}).new_page()
        if hasattr(scenes, "login"):
            scenes.login(pg)
        n = 0
        for a in args:
            url = a if a.startswith("http") else scenes.BASE_URL.rstrip("/") + a
            pg.goto(url)
            demo.settle(pg, 1.5)
            n += 1
            capture(pg, f"{n:02d}_{slug(a)}")
            if tabs:
                for label in [t.strip() for t in pg.locator("[role=tab]").all_inner_texts() if t.strip()]:
                    try:
                        pg.locator("[role=tab]", has_text=label).first.click()
                        demo.settle(pg, 1.2)
                    except Exception as e:  # a tab that is disabled or not clickable
                        print(f"  skip tab {label!r}: {e.__class__.__name__}")
                        continue
                    n += 1
                    capture(pg, f"{n:02d}_{slug(label)}")
        b.close()
    print(f"→ {OUT}")


if __name__ == "__main__":
    main()
