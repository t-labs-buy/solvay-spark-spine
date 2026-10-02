"""The page gates in front of the application and Demo Mode.

Run: python backend/tests/test_app_login.py

No Postgres, no network, no model: the routers are mounted on a bare FastAPI
app behind the auth middleware, and every request here is signed out, so the
middleware never needs to look an account up. Signing in, roles and sessions
are tested against a real database in test_auth.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.api import app_login, demo_mode  # noqa: E402
from backend.auth import sessions  # noqa: E402

app = FastAPI()
app.include_router(demo_mode.router)
app.include_router(app_login.router)


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse("<p>app</p>")


@app.get("/rollout", response_class=HTMLResponse)
def rollout():
    return HTMLResponse("<p>rollout</p>")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/evidence/runs")
def runs():
    return []


app_login.install(app)


def client() -> TestClient:
    return TestClient(app, follow_redirects=False)


def test_a_page_redirects_to_sign_in_and_remembers_where_it_was_going():
    res = client().get("/rollout?run=ro_1")
    assert res.status_code == 303
    assert res.headers["location"] == "/login?next=/rollout%3Frun%3Dro_1"


def test_a_demo_page_redirects_to_the_demos_own_sign_in():
    res = client().get("/demo/fit-gap-copilot")
    assert res.status_code == 303
    assert res.headers["location"] == "/demo/login?next=/demo/fit-gap-copilot"


def test_the_api_is_closed_too():
    c = client()
    assert c.get("/api/evidence/runs").status_code == 401
    assert c.get("/api/health").status_code == 200


def test_a_forged_cookie_opens_nothing():
    c = client()
    c.cookies.set(sessions.COOKIE, "1|1|99999999999|deadbeef")
    assert c.get("/api/evidence/runs").status_code == 401
    assert c.get("/rollout").status_code == 303


def test_the_sign_in_pages_are_reachable_signed_out():
    c = client()
    # 503 is "not built yet"; either way it was not a redirect.
    assert c.get("/login").status_code in (200, 503)
    assert c.get("/demo/login").status_code in (200, 503)


def test_page_paths_finds_the_pages_and_not_the_sign_in_or_demo():
    paths = app_login.page_paths(app)
    assert {"/", "/rollout"} <= paths
    assert "/login" not in paths and not any(p.startswith("/demo") for p in paths)


def test_next_never_leaves_the_site():
    for bad in ("https://evil.example", "//evil.example", "/\\evil", "/login", "/demo/login", ""):
        assert sessions.safe_next(bad) == "/", bad
    assert sessions.safe_next("/rollout?x=1") == "/rollout?x=1"


def test_the_demo_router_claims_only_demo_paths():
    for r in demo_mode.router.routes:
        assert r.path.startswith("/demo"), r.path


TESTS = [v for k, v in dict(globals()).items() if k.startswith("test_")]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
