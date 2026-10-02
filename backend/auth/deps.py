"""FastAPI dependencies for the signed-in account.

The middleware has already decided who is asking; these read its answer.

    user: dict = Depends(current_user)     # 401 if nobody
    user: dict = Depends(require_admin)    # and 403 if not an Admin

A run executes in a generator, a thread pool or a thread of its own, none of
which can see the request -- so an endpoint reads the user here and passes
`user["id"]` into the run explicitly. Nothing below reads it from context.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request


def optional_user(request: Request) -> dict | None:
    return getattr(request.state, "user", None)


def current_user(request: Request) -> dict:
    user = optional_user(request)
    if user is None:
        raise HTTPException(401, "Sign in first.")
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Only an Admin can do that.")
    return user


def is_admin(user: dict | None) -> bool:
    return bool(user) and user["role"] == "admin"


def list_owner(user: dict, scope: str = "mine") -> int | None:
    """Whose rows a history list returns: None (everyone's) for an Admin who
    asked for scope=all, otherwise this user's own id. A User asking for "all"
    still gets only their own -- the parameter is a view choice, not a right."""
    if is_admin(user) and scope == "all":
        return None
    return user["id"]


def read_owner(user: dict) -> int | None:
    """Whose run may be opened by id: any for an Admin, otherwise only one's
    own. Someone else's comes back as not found, not forbidden, so a guessed
    id does not even confirm the run exists."""
    return None if is_admin(user) else user["id"]


def write_owner(user: dict) -> int:
    """Whose run may be changed or deleted: only one's own, Admin or not.
    An Admin's access to other people's runs is read-only."""
    return user["id"]
