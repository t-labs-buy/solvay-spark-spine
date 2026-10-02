"""Who is asking, for every request, and a door for those who are nobody.

Pure ASGI, like RedactContactDetails, so a streamed run stays streamed.

For each HTTP request the session cookie is read and the account looked up;
the result -- a user dict or None -- goes into scope["state"]["user"], where
`request.state.user` and deps.current_user find it. Then:

  * `/api/*` with no user is answered 401, except the few routes that have to
    work signed out (EXEMPT);
  * a GET of one of the application's pages with no user is sent to /login,
    keeping the page as `next`. Demo Mode's pages do their own redirect, to
    the demo's sign-in page.

The account is looked up rather than trusted from the cookie, because the
cookie cannot say that the account was deactivated or its password reset since
it was issued. The lookup is cached for CACHE_SECONDS per account, and the
cache is cleared whenever an Admin changes an account (forget()), so in this
process a change applies on the next request.
"""

from __future__ import annotations

import json
import threading
import time
from urllib.parse import quote

import anyio

from backend.auth import sessions
from backend.auth import store
from backend.core import tracing

EXEMPT = frozenset({
    "/api/health",
    "/api/auth/login", "/api/auth/logout", "/api/auth/session",
    # Aliases the existing bundles call (app_login.py, demo_mode.py).
    "/api/app/login", "/api/app/logout", "/api/app/session",
    "/api/demo/login", "/api/demo/logout", "/api/demo/session",
})

CACHE_SECONDS = 30
_cache: dict[int, tuple[float, dict | None]] = {}
_cache_lock = threading.Lock()


def forget(uid: int | None = None) -> None:
    """Drop a cached account, or all of them."""
    with _cache_lock:
        if uid is None:
            _cache.clear()
        else:
            _cache.pop(uid, None)


def _load(uid: int) -> dict | None:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(uid)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    conn = store.connect()
    user = store.get_user(conn, uid)
    if user and user["active"]:
        store.touch_seen(conn, uid)
    with _cache_lock:
        _cache[uid] = (now, user)
    return user


def resolve(token: str | None) -> dict | None:
    """The signed-in account for a cookie value, or None. Blocking (it may
    query Postgres), so the middleware runs it on a worker thread."""
    claim = sessions.read_token(token)
    if claim is None:
        return None
    uid, version = claim
    user = _load(uid)
    if not user or not user["active"] or user["session_version"] != version:
        return None
    return user


def _cookie(scope) -> str | None:
    for k, v in scope.get("headers") or []:
        if k == b"cookie":
            for part in v.decode("latin-1").split(";"):
                name, _, value = part.strip().partition("=")
                if name == sessions.COOKIE:
                    return value.strip('"')
    return None


class RequireUser:
    def __init__(self, app, pages: set[str] | frozenset[str] = frozenset()):
        self.app = app
        self.pages = pages

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        token = _cookie(scope)
        user = await anyio.to_thread.run_sync(resolve, token) if token else None
        scope.setdefault("state", {})["user"] = user
        if user is not None:
            tracing.USER.set(user["username"])
        path = scope.get("path", "")

        if user is None and path.startswith("/api/") and path not in EXEMPT:
            body = json.dumps({"detail": "Sign in first."}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return

        if user is None and scope.get("method") == "GET" and path in self.pages:
            qs = scope.get("query_string", b"").decode("latin-1")
            target = path + (f"?{qs}" if qs else "")
            location = f"{sessions.LOGIN_PATH}?next={quote(target)}"
            await send({"type": "http.response.start", "status": 303,
                        "headers": [(b"location", location.encode("latin-1")),
                                    (b"content-length", b"0")]})
            await send({"type": "http.response.body", "body": b""})
            return

        await self.app(scope, receive, send)
