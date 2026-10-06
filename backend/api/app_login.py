"""The sign-in page for the application at `/`, and the gate on its pages.

Accounts live in Postgres (backend/auth/): who may sign in, with which role,
and whether they are still active. This module only serves `/login` and puts
the gate in front of the application's pages. The `/api/*` endpoints are
gated as well, by the same middleware -- unlike the static sign-in this
replaced, the API does not stay open.

The sign-in API itself is backend/auth/routes.py; `/api/app/login`,
`/api/app/logout` and `/api/app/session` remain there as aliases.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from backend.auth.deps import optional_user
from backend.auth.middleware import RequireUser
from backend.auth.sessions import LOGIN_PATH, safe_next
from backend.core.paths import ROOT

PAGE = ROOT / "static" / "dist" / "login.html"

router = APIRouter()


def page_paths(app) -> set[str]:
    """The application's own pages: every HTML route outside Demo Mode and the
    sign-in page. Read from the app rather than listed, so a page added later
    is gated without anyone remembering to add it here."""
    from fastapi.routing import APIRoute

    out: set[str] = set()
    for r in app.routes:
        if (isinstance(r, APIRoute) and "GET" in r.methods and r.response_class is HTMLResponse
                and not r.path.startswith("/demo") and r.path != LOGIN_PATH):
            out.add(r.path)
    return out


def install(app) -> None:
    """Gate the pages and the API. Call after every page route is declared."""
    app.add_middleware(RequireUser, pages=frozenset(page_paths(app)))


@router.get(LOGIN_PATH, response_class=HTMLResponse)
def login_page(request: Request, next: str = "/"):
    # Signed in already: straight on -- unless the password must be changed
    # first, which is this page's job too.
    user = optional_user(request)
    if user and not user["must_change_password"]:
        return RedirectResponse(safe_next(next), status_code=303)
    if not PAGE.exists():
        return HTMLResponse(
            "<p>The sign-in page has not been built. Run <code>cd frontend &amp;&amp; npm run build"
            "</code>, then reload.</p>", status_code=503)
    return HTMLResponse(PAGE.read_text(), headers={"Cache-Control": "no-cache"})
