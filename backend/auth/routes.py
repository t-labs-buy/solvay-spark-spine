"""Sign in, sign out, who am I, and change my password.

The same account opens the application at `/` and Demo Mode at `/demo`, so
there is one set of routes. The `/api/app/*` and `/api/demo/*` paths the
bundles were built against are kept as aliases of these.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.auth import middleware, sessions, store
from backend.auth.deps import current_user, optional_user

router = APIRouter()


class Login(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current: str
    new: str


def public(user: dict) -> dict:
    return {"id": user["id"], "user": user["username"], "username": user["username"],
            "role": user["role"]}


def login(body: Login, request: Request):
    conn = store.connect()
    user = store.authenticate(conn, body.username, body.password)
    if user is None:
        store.log_event(None, "login_failed", username=body.username.strip()[:64],
                        detail={"path": request.url.path})
        return JSONResponse({"detail": "Incorrect username or password."}, status_code=401)
    middleware.forget(user["id"])
    store.log_event(user, "login", detail={"path": request.url.path})
    res = JSONResponse(public(user))
    res.set_cookie(sessions.COOKIE, sessions.make_token(user["id"], user["session_version"]),
                   max_age=sessions.SESSION_SECONDS, httponly=True, samesite="lax", path="/")
    return res


def logout(request: Request):
    user = optional_user(request)
    if user:
        store.log_event(user, "logout")
    res = JSONResponse({"ok": True})
    res.delete_cookie(sessions.COOKIE, path="/")
    return res


def session(request: Request):
    user = optional_user(request)
    if user is None:
        return JSONResponse({"user": None, "enabled": True}, status_code=401)
    return {**public(user), "enabled": True}


for prefix in ("/api/auth", "/api/app", "/api/demo"):
    router.add_api_route(f"{prefix}/login", login, methods=["POST"])
    router.add_api_route(f"{prefix}/logout", logout, methods=["POST"])
    router.add_api_route(f"{prefix}/session", session, methods=["GET"])


@router.post("/api/auth/password")
def change_password(body: PasswordChange, user: dict = Depends(current_user)):
    try:
        updated = store.change_own_password(store.connect(), user["id"], body.current, body.new)
    except store.AccountError as exc:
        raise HTTPException(400, str(exc))
    middleware.forget(user["id"])
    store.log_event(user, "password_changed")
    # The version moved, so the old cookie is dead; hand over a new one rather
    # than signing out the person who just proved who they are.
    res = JSONResponse({"ok": True})
    res.set_cookie(sessions.COOKIE, sessions.make_token(updated["id"], updated["session_version"]),
                   max_age=sessions.SESSION_SECONDS, httponly=True, samesite="lax", path="/")
    return res
