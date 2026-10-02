"""Accounts, roles and the session.

Run: python backend/tests/test_auth.py

Needs Postgres, but not the corpus, not Ollama and not an Anthropic key:
everything happens in a throwaway database created and dropped here. What is
tested is what the sign-in promises:

  * passwords are stored hashed, and checked in constant time;
  * the API, not only the pages, refuses a request with no session;
  * a page sends a signed-out visitor to sign in and back again;
  * a forged, expired or revoked cookie is refused -- and resetting a
    password or deactivating an account revokes it at once;
  * the `legacy` owner of pre-account runs can never sign in;
  * only an Admin reaches the Admin API, and nobody can remove the last Admin
    or demote themselves;
  * one account opens both the application and Demo Mode.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

from fastapi.testclient import TestClient

from backend.auth import middleware, passwords, sessions, store
from backend.rag import rag

TEST_DATABASE = "docling_test_auth"
_original_base_url = rag.base_url


def _url(name: str) -> str:
    p = urlsplit(_original_base_url())
    return urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, p.fragment))


def _admin_conn():
    import psycopg

    return psycopg.connect(_url("postgres"), autocommit=True)


def setup() -> None:
    with _admin_conn() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{TEST_DATABASE}" WITH (FORCE)')
        c.execute(f'CREATE DATABASE "{TEST_DATABASE}"')
    rag.base_url = lambda: _url(TEST_DATABASE)
    rag.close()
    rag._schema_ready = False
    middleware.forget()
    os.environ["ADMIN_USERNAME"] = "root"
    os.environ["ADMIN_PASSWORD"] = "root-password"


def teardown() -> None:
    rag.close()
    rag.base_url = _original_base_url
    with _admin_conn() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{TEST_DATABASE}" WITH (FORCE)')


def client() -> TestClient:
    from backend.api.app import app

    return TestClient(app, follow_redirects=False)


def sign_in(c: TestClient, username: str, password: str) -> dict:
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


# --- tests --------------------------------------------------------------------


def test_password_hashing() -> None:
    h = passwords.hash_password("correct horse")
    assert h.startswith("scrypt$") and "correct horse" not in h
    assert passwords.verify_password("correct horse", h)
    assert not passwords.verify_password("wrong horse", h)
    assert h != passwords.hash_password("correct horse"), "each hash has its own salt"
    assert not passwords.verify_password("", "")
    assert not passwords.verify_password("x", "garbage")


def test_bootstrap_admin() -> None:
    line = store.bootstrap_admin()
    assert "created" in line, line
    assert store.bootstrap_admin() == "auth: accounts ready", "only when there is no Admin"
    root = store.authenticate(store.connect(), "ROOT", "root-password")
    assert root and root["role"] == "admin", "usernames are case-insensitive"


def test_api_and_pages_need_a_session() -> None:
    c = client()
    assert c.get("/api/health").status_code == 200
    for path in ("/api/evidence/runs", "/api/ask/runs", "/api/rollout/runs",
                 "/api/fitgap/runs", "/api/kb/files", "/api/admin/users"):
        assert c.get(path).status_code == 401, path
    r = c.get("/rollout?x=1")
    assert r.status_code == 303 and r.headers["location"] == "/login?next=/rollout%3Fx%3D1"
    r = c.get("/demo/graph")
    assert r.status_code == 303 and r.headers["location"].startswith("/demo/login?next=")
    assert c.get("/api/auth/session").status_code == 401


def test_sign_in_and_out() -> None:
    c = client()
    r = c.post("/api/auth/login", json={"username": "root", "password": "nope"})
    assert r.status_code == 401
    me = sign_in(c, "root", "root-password")
    assert me["role"] == "admin" and me["username"] == "root"
    cookie = c.cookies.get(sessions.COOKIE)
    assert cookie and "root-password" not in cookie
    assert c.get("/api/auth/session").json()["username"] == "root"
    assert c.get("/api/evidence/runs").status_code == 200
    # The same account opens Demo Mode, through the old alias too.
    assert c.get("/api/demo/session").status_code == 200
    assert c.get("/demo/login").status_code == 303
    c.post("/api/auth/logout")
    assert c.get("/api/evidence/runs").status_code == 401


def test_old_static_credentials_are_gone() -> None:
    c = client()
    for u, p in (("test", "test"), ("solvay", "solvay")):
        assert c.post("/api/app/login", json={"username": u, "password": p}).status_code == 401
        assert c.post("/api/demo/login", json={"username": u, "password": p}).status_code == 401


def test_legacy_cannot_sign_in() -> None:
    c = client()
    assert c.post("/api/auth/login", json={"username": "legacy", "password": ""}).status_code == 401
    try:
        store.create_user(store.connect(), "Legacy", "whatever-123")
        raise AssertionError("legacy is reserved")
    except store.AccountError:
        pass


def test_forged_and_expired_tokens() -> None:
    root = store.authenticate(store.connect(), "root", "root-password")
    good = sessions.make_token(root["id"], root["session_version"])
    assert middleware.resolve(good)["username"] == "root"
    uid, ver, exp, sig = good.split("|")
    assert middleware.resolve(f"{uid}|{ver}|{int(exp) + 999}|{sig}") is None
    assert middleware.resolve(f"{int(uid) + 1}|{ver}|{exp}|{sig}") is None
    old = sessions.make_token(root["id"], root["session_version"],
                              now=time.time() - sessions.SESSION_SECONDS - 5)
    assert middleware.resolve(old) is None


def test_roles_and_account_management() -> None:
    admin = client()
    sign_in(admin, "root", "root-password")
    r = admin.post("/api/admin/users", json={"username": "alice", "password": "alice-pass",
                                             "role": "user"})
    assert r.status_code == 200, r.text
    alice_id = r.json()["id"]
    assert admin.post("/api/admin/users", json={"username": "ALICE", "password": "x-password",
                                                 "role": "user"}).status_code == 400
    assert admin.post("/api/admin/users", json={"username": "bob", "password": "short",
                                                "role": "user"}).status_code == 400

    alice = client()
    sign_in(alice, "alice", "alice-pass")
    assert alice.get("/api/admin/users").status_code == 403
    assert alice.get("/api/quality/judge").status_code == 403
    assert alice.post("/api/evidence/memory/reflect", json={"question": "what?"}).status_code == 403

    # Promote: applies on the next request, without signing alice out.
    assert admin.patch(f"/api/admin/users/{alice_id}", json={"role": "admin"}).status_code == 200
    assert alice.get("/api/admin/users").status_code == 200
    assert admin.patch(f"/api/admin/users/{alice_id}", json={"role": "user"}).status_code == 200

    # Reset the password: every existing session of alice's is dead.
    assert admin.patch(f"/api/admin/users/{alice_id}",
                       json={"password": "alice-new-pass"}).status_code == 200
    assert alice.get("/api/evidence/runs").status_code == 401
    sign_in(alice, "alice", "alice-new-pass")

    # Deactivate: refused at once, and cannot sign in again.
    assert admin.patch(f"/api/admin/users/{alice_id}", json={"active": False}).status_code == 200
    assert alice.get("/api/evidence/runs").status_code == 401
    assert alice.post("/api/auth/login", json={"username": "alice",
                                               "password": "alice-new-pass"}).status_code == 401
    assert admin.patch(f"/api/admin/users/{alice_id}", json={"active": True}).status_code == 200

    # Nobody demotes themselves, and the last Admin stays an Admin.
    root_id = admin.get("/api/auth/session").json()["id"]
    r = admin.patch(f"/api/admin/users/{root_id}", json={"role": "user"})
    assert r.status_code == 400 and "own" in r.json()["detail"]
    try:
        store.update_user(store.connect(), root_id, active=False, acting=None)
        raise AssertionError("the last Admin was deactivated")
    except store.AccountError as exc:
        assert "last" in str(exc)

    names = [u["username"] for u in admin.get("/api/admin/users").json()["users"]]
    assert "legacy" not in names and {"root", "alice"} <= set(names)


def test_change_own_password() -> None:
    c = client()
    sign_in(c, "alice", "alice-new-pass")
    assert c.post("/api/auth/password", json={"current": "wrong", "new": "x" * 10}).status_code == 400
    r = c.post("/api/auth/password", json={"current": "alice-new-pass", "new": "alice-third-pass"})
    assert r.status_code == 200
    # The caller keeps a fresh cookie; the old one is dead elsewhere.
    assert c.get("/api/evidence/runs").status_code == 200
    sign_in(client(), "alice", "alice-third-pass")


def test_the_user_reaches_traces_opened_while_streaming() -> None:
    """Agents open their Langfuse trace inside a streamed generator, which
    Starlette runs on its threadpool; the user has to arrive there."""
    from fastapi.responses import StreamingResponse

    from backend.api.app import app
    from backend.core import tracing

    if not any(getattr(r, "path", "") == "/api/_test/trace-user" for r in app.routes):
        @app.get("/api/_test/trace-user")
        def _trace_user():
            def gen():
                yield str(tracing.USER.get())
            return StreamingResponse(gen(), media_type="text/plain")

    c = client()
    sign_in(c, "root", "root-password")
    assert c.get("/api/_test/trace-user").text == "root"


def test_activity_is_logged() -> None:
    admin = client()
    sign_in(admin, "root", "root-password")
    body = admin.get("/api/admin/activity?limit=500").json()
    actions = {e["action"] for e in body["events"]}
    assert {"login", "login_failed", "logout", "user_created", "user_updated",
            "password_changed"} <= actions, actions
    failed = [e for e in body["events"] if e["action"] == "login_failed"]
    assert all("password" not in str(e["detail"]) for e in failed)


TESTS = [
    test_password_hashing,
    test_bootstrap_admin,
    test_api_and_pages_need_a_session,
    test_sign_in_and_out,
    test_old_static_credentials_are_gone,
    test_legacy_cannot_sign_in,
    test_forged_and_expired_tokens,
    test_roles_and_account_management,
    test_change_own_password,
    test_the_user_reaches_traces_opened_while_streaming,
    test_activity_is_logged,
]


def main() -> int:
    setup()
    failed = 0
    try:
        for t in TESTS:
            try:
                t()
                print(f"ok    {t.__name__}")
            except Exception as exc:
                failed += 1
                print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
    finally:
        teardown()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
