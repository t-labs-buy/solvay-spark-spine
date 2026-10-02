"""The session cookie: who is signed in, signed so it cannot be forged.

The token is `uid|version|expires|sig`. It names the user by id and carries the
user's session_version at the time of sign-in; the middleware compares that
with the row on every request, so resetting a password or deactivating an
account signs that user out everywhere at once, without a server-side session
table.

One cookie for the application and for Demo Mode: an account opens both.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time

# APP_SECRET is still read so an installation that set it keeps its sessions
# signed by the same key across the upgrade.
SECRET = (os.environ.get("AUTH_SECRET") or os.environ.get("APP_SECRET")
          or secrets.token_hex(32)).encode()
SESSION_SECONDS = int(float(os.environ.get("AUTH_SESSION_HOURS")
                            or os.environ.get("APP_SESSION_HOURS") or "12") * 3600)
COOKIE = "spark_session"
LOGIN_PATH = "/login"


def _sign(uid: int, version: int, expires: int) -> str:
    # The purpose is part of what is signed, so a token minted for something
    # else with the same secret could not be replayed here.
    return hmac.new(SECRET, f"spark|{uid}|{version}|{expires}".encode(),
                    hashlib.sha256).hexdigest()


def make_token(uid: int, version: int, now: float | None = None) -> str:
    expires = int((now if now is not None else time.time()) + SESSION_SECONDS)
    return f"{uid}|{version}|{expires}|{_sign(uid, version, expires)}"


def read_token(token: str | None, now: float | None = None) -> tuple[int, int] | None:
    """(user id, session version), or None for a missing, forged or expired
    token. Whether that user still exists and is active is the caller's check."""
    if not token:
        return None
    try:
        uid_s, version_s, expires_s, sig = token.split("|")
        uid, version, expires = int(uid_s), int(version_s), int(expires_s)
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(uid, version, expires)):
        return None
    if expires < (now if now is not None else time.time()):
        return None
    return uid, version


def safe_next(target: str | None, default: str = "/") -> str:
    """Only a path on this site, and never a sign-in page itself: `next` comes
    from the address bar, and an open redirect would make the sign-in page a
    way to bounce people elsewhere."""
    t = target or default
    if (not t.startswith("/") or t.startswith("//") or "\\" in t
            or t.startswith(LOGIN_PATH) or t.startswith("/demo/login")):
        return default
    return t
