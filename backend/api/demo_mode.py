"""Demo Mode: a client-presentation front door beside the application.

`/demo` is a second page over the same API: two primary tabs (Knowledge
Graph, Fit-Gap Copilot) with every other module in a sidebar that starts
hidden. It is a separate bundle (`frontend/demo.html`), so nothing about the
main application -- its routes, its tab bar, its pages -- changes.

Sign-in is the application's own: an account (backend/auth/) opens both
`/` and `/demo`, with the same cookie. Demo Mode keeps its own sign-in page at
`/demo/login` so a presenter never sees the application's, and its pages
redirect there rather than to `/login`.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from backend.auth.deps import optional_user
from backend.core.paths import ROOT

PAGE = ROOT / "static" / "dist" / "demo.html"

router = APIRouter()


def _page() -> HTMLResponse:
    if not PAGE.exists():
        return HTMLResponse(
            "<p>The demo page has not been built. Run <code>cd frontend &amp;&amp; npm run build"
            "</code>, then reload.</p>", status_code=503)
    return HTMLResponse(PAGE.read_text(), headers={"Cache-Control": "no-cache"})


@router.get("/demo/login", response_class=HTMLResponse)
def login_page(request: Request):
    # Already signed in: straight through, rather than a login form that
    # looks like the session was lost -- unless the password must be changed
    # first, which this page asks for.
    user = optional_user(request)
    if user and not user["must_change_password"]:
        return RedirectResponse("/demo", status_code=303)
    return _page()


@router.get("/demo", response_class=HTMLResponse)
@router.get("/demo/{rest:path}", response_class=HTMLResponse)
def demo_page(request: Request, rest: str = ""):
    user = optional_user(request)
    if not user or user["must_change_password"]:
        target = "/demo" + (f"/{rest}" if rest else "")
        return RedirectResponse(f"/demo/login?next={quote(target)}", status_code=303)
    return _page()
