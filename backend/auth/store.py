"""Accounts, and the activity log the usage dashboard reads.

Two tables in the main database:

  * `users` -- one row per account, with a role (admin or user), an active
    flag in place of deletion, a session_version that signs the account
    out everywhere when it is bumped (sessions.py), and must_change_password,
    set while the account's password is one an Admin chose (a new account, a
    reset) and cleared when its owner picks their own (middleware.py).
  * `activity_events` -- one row per thing worth counting: a sign-in, a run
    started, a review saved. The run tables already hold tokens and durations;
    this holds what they do not.

Accounts are never deleted. A run belongs to the user who made it, and a
deleted owner would leave a history nobody can account for, so an account
that should no longer sign in is deactivated instead.

One account is special: `legacy`, which owns every run recorded before there
were accounts. It is inactive and has no password, so it cannot sign in; its
runs are visible to Admins only. See own_table().

CLI:

    python -m backend.auth.store create-admin <username>    # prompts for the password
    python -m backend.auth.store list
    python -m backend.auth.store reassign-legacy <username> [table ...]
        # hand what `legacy` owns (default: every owned table) to an account
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

from backend.auth import passwords
from backend.rag import rag

ROLES = ("admin", "user")
LEGACY = "legacy"


def database_url() -> str:
    return rag.base_url()


def connect():
    """Shared and cached per thread, so callers must not close it."""
    return rag.connection(schema=False)


# Once per process per database, for the reason ask_store.py gives at length:
# ALTER TABLE ... IF NOT EXISTS takes its lock before it finds there is nothing
# to do, and two requests doing it together deadlock.
_ready: set[str] = set()
_ready_lock = threading.Lock()
_legacy_ids: dict[str, int] = {}


def create_schema(conn=None) -> None:
    key = database_url()
    if key in _ready:
        return
    with _ready_lock:
        if key in _ready:
            return
        _create_schema(conn or connect())
        _ready.add(key)


def _create_schema(conn) -> None:
    with conn.transaction():
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id              bigserial PRIMARY KEY,
                username        text NOT NULL,
                password_hash   text NOT NULL DEFAULT '',
                role            text NOT NULL DEFAULT 'user'
                                CHECK (role IN ('admin', 'user')),
                active          boolean NOT NULL DEFAULT true,
                session_version int NOT NULL DEFAULT 1,
                created_at      timestamptz NOT NULL DEFAULT now(),
                last_login_at   timestamptz,
                last_seen_at    timestamptz
            )"""
        )
        # Case-insensitive uniqueness without the citext extension: "Alice"
        # and "alice" are one account.
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx"
                     " ON users (lower(username))")
        # Added after accounts shipped: an existing account is not asked to
        # change a password it may already have changed.
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS"
                     " must_change_password boolean NOT NULL DEFAULT false")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS activity_events (
                id        bigserial PRIMARY KEY,
                at        timestamptz NOT NULL DEFAULT now(),
                user_id   bigint REFERENCES users(id),
                username  text NOT NULL DEFAULT '',
                action    text NOT NULL,
                tool      text,
                run_id    text,
                detail    jsonb NOT NULL DEFAULT '{}'::jsonb
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS activity_events_at_idx"
                     " ON activity_events (at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS activity_events_user_idx"
                     " ON activity_events (user_id, at DESC)")
        conn.execute(
            "INSERT INTO users (username, password_hash, role, active)"
            " VALUES (%s, '', 'user', false)"
            " ON CONFLICT (lower(username)) DO NOTHING", (LEGACY,))


def legacy_id(conn=None) -> int:
    key = database_url()
    if key not in _legacy_ids:
        conn = conn or connect()
        create_schema(conn)
        row = conn.execute("SELECT id FROM users WHERE lower(username) = %s",
                           (LEGACY,)).fetchone()
        _legacy_ids[key] = row[0]
    return _legacy_ids[key]


def own_table(conn, table: str, column: str = "started_at") -> None:
    """Give `table` an owner: a user_id column, an index for "this user's
    newest first", and every row that predates accounts handed to `legacy`.

    Called from inside each store's own create_schema, so it runs once per
    process with the rest of that store's DDL. The backfill is idempotent --
    it only touches rows with no owner."""
    create_schema()
    lid = legacy_id()
    conn.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS"
                 f" user_id bigint REFERENCES users(id)")
    conn.execute(f"CREATE INDEX IF NOT EXISTS {table}_user_idx ON {table} (user_id, {column} DESC)")
    conn.execute(f"UPDATE {table} SET user_id = %s WHERE user_id IS NULL", (lid,))


def owned(owner: int | None, alias: str = "") -> tuple[str, list]:
    """The WHERE fragment that limits a query to one owner's rows.

    `owner` None means no limit -- an Admin reading everyone's. Returned as
    "AND ..." so it appends to an existing WHERE."""
    if owner is None:
        return "", []
    col = f"{alias}.user_id" if alias else "user_id"
    return f" AND {col} = %s", [owner]


# --- accounts ----------------------------------------------------------------

_USER_COLUMNS = ("id, username, role, active, session_version, created_at,"
                 " last_login_at, last_seen_at, must_change_password")


def _user(r) -> dict[str, Any]:
    return {
        "id": r[0], "username": r[1], "role": r[2], "active": r[3],
        "session_version": r[4],
        "created_at": r[5].isoformat() if r[5] else None,
        "last_login_at": r[6].isoformat() if r[6] else None,
        "last_seen_at": r[7].isoformat() if r[7] else None,
        "must_change_password": r[8],
    }


class AccountError(ValueError):
    """A refused change, with the sentence to show the person who asked."""


def _clean_username(username: str) -> str:
    name = (username or "").strip()
    if not name or len(name) > 64 or any(c.isspace() for c in name) or "|" in name:
        raise AccountError("A username is 1-64 characters with no spaces.")
    if name.lower() == LEGACY:
        raise AccountError(f'"{LEGACY}" is reserved.')
    return name


def create_user(conn, username: str, password: str, role: str = "user",
                must_change: bool = False) -> dict:
    """`must_change` for an account an Admin makes: the password is one the
    Admin chose and handed over, so its owner replaces it at first sign-in."""
    create_schema(conn)
    name = _clean_username(username)
    if role not in ROLES:
        raise AccountError("The role must be admin or user.")
    if (why := passwords.check_strength(password)):
        raise AccountError(why)
    row = conn.execute(
        f"""INSERT INTO users (username, password_hash, role, must_change_password)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (lower(username)) DO NOTHING
            RETURNING {_USER_COLUMNS}""",
        (name, passwords.hash_password(password), role, must_change)).fetchone()
    conn.commit()
    if row is None:
        raise AccountError(f'There is already an account called "{name}".')
    return _user(row)


def get_user(conn, uid: int) -> dict | None:
    create_schema(conn)
    r = conn.execute(f"SELECT {_USER_COLUMNS} FROM users WHERE id = %s", (uid,)).fetchone()
    return _user(r) if r else None


def authenticate(conn, username: str, password: str) -> dict | None:
    """The account, if the username and password match an active one.

    A missing username is checked against a dummy hash so that it takes as
    long as a wrong password: the timing does not say which half was wrong."""
    create_schema(conn)
    r = conn.execute(
        f"SELECT {_USER_COLUMNS}, password_hash FROM users WHERE lower(username) = lower(%s)",
        ((username or "").strip(),)).fetchone()
    if r is None:
        passwords.verify_password(password, passwords.DUMMY_HASH)
        return None
    if not passwords.verify_password(password, r[9]) or not r[3]:
        return None
    conn.execute("UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = %s",
                 (r[0],))
    conn.commit()
    return _user(r)


def list_users(conn) -> list[dict]:
    """Every account but `legacy`, with how much each has run."""
    create_schema(conn)
    rows = conn.execute(
        f"SELECT {_USER_COLUMNS} FROM users WHERE lower(username) <> %s ORDER BY lower(username)",
        (LEGACY,)).fetchall()
    return [_user(r) for r in rows]


def active_admins(conn) -> int:
    return conn.execute(
        "SELECT count(*) FROM users WHERE role = 'admin' AND active").fetchone()[0]


def update_user(conn, uid: int, *, role: str | None = None, active: bool | None = None,
                password: str | None = None, acting: int | None = None,
                must_change: bool = True) -> dict:
    """Change an account. `acting` is the Admin making the change: nobody may
    demote or deactivate themselves, and the last active Admin may not be
    demoted or deactivated by anyone, so there is always someone who can fix
    things.

    A new password or deactivation bumps session_version, which signs the
    account out everywhere. A new password set here is an Admin's reset, so
    by default its owner must replace it at their next sign-in; their own
    change (change_own_password) passes must_change=False. A role change does not need to: the middleware
    reads the role fresh, so it applies on the next request."""
    create_schema(conn)
    user = get_user(conn, uid)
    if user is None or user["username"].lower() == LEGACY:
        raise AccountError("No such account.")
    if role is not None and role not in ROLES:
        raise AccountError("The role must be admin or user.")
    losing_admin = user["role"] == "admin" and user["active"] and (
        (role is not None and role != "admin") or active is False)
    if losing_admin and acting == uid:
        raise AccountError("You cannot demote or deactivate your own account.")
    if losing_admin and active_admins(conn) <= 1:
        raise AccountError("This is the last active Admin; make another Admin first.")
    sets, args, bump = [], [], False
    if role is not None:
        sets.append("role = %s")
        args.append(role)
    if active is not None:
        sets.append("active = %s")
        args.append(active)
        bump = bump or not active
    if password is not None:
        if (why := passwords.check_strength(password)):
            raise AccountError(why)
        sets.append("password_hash = %s")
        args.append(passwords.hash_password(password))
        sets.append("must_change_password = %s")
        args.append(must_change)
        bump = True
    if bump:
        sets.append("session_version = session_version + 1")
    if sets:
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = %s", (*args, uid))
        conn.commit()
    return get_user(conn, uid)


def change_own_password(conn, uid: int, current: str, new: str) -> dict:
    r = conn.execute("SELECT password_hash FROM users WHERE id = %s", (uid,)).fetchone()
    if r is None or not passwords.verify_password(current, r[0]):
        raise AccountError("The current password is not right.")
    # Otherwise a forced change could be "made" by typing the Admin's
    # password back in.
    if passwords.verify_password(new, r[0]):
        raise AccountError("Choose a password different from the current one.")
    return update_user(conn, uid, password=new, must_change=False)


def touch_seen(conn, uid: int) -> None:
    """Last seen, at most once a minute per account -- this runs on requests."""
    conn.execute("UPDATE users SET last_seen_at = now() WHERE id = %s AND"
                 " (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')", (uid,))
    conn.commit()


def bootstrap_admin(conn=None) -> str:
    """At start-up: make sure somebody can sign in and administer.

    If there is no active Admin and ADMIN_USERNAME / ADMIN_PASSWORD are set,
    that account is created (or, if it exists, made an active Admin with that
    password). Returns a line for the server log."""
    conn = conn or connect()
    create_schema(conn)
    if active_admins(conn):
        return "auth: accounts ready"
    name = (os.environ.get("ADMIN_USERNAME") or "").strip()
    password = os.environ.get("ADMIN_PASSWORD") or ""
    if not name or not password:
        return ("auth: WARNING -- there is no active Admin account. Set ADMIN_USERNAME and"
                " ADMIN_PASSWORD, or run: python -m backend.auth.store create-admin <name>")
    # A refused name or password is a line in the log, not a crash: raising
    # here would stop the whole app starting over one setting.
    why = passwords.check_strength(password)
    if why:
        return f"auth: WARNING -- ADMIN_PASSWORD was not used: {why} No Admin account was created."
    # Checked before looking the name up, or ADMIN_USERNAME=legacy would find
    # the built-in account and make it an Admin that can sign in.
    try:
        name = _clean_username(name)
    except AccountError as exc:
        return f"auth: WARNING -- ADMIN_USERNAME was not used: {exc} No Admin account was created."
    existing = conn.execute("SELECT id FROM users WHERE lower(username) = lower(%s)",
                            (name,)).fetchone()
    if existing:
        conn.execute("UPDATE users SET role = 'admin', active = true, password_hash = %s,"
                     " must_change_password = false,"
                     " session_version = session_version + 1 WHERE id = %s",
                     (passwords.hash_password(password), existing[0]))
        conn.commit()
    else:
        try:
            create_user(conn, name, password, "admin")
        except AccountError as exc:
            return f"auth: WARNING -- ADMIN_USERNAME was not used: {exc} No Admin account was created."
    return f"auth: created Admin account {name!r} from ADMIN_USERNAME"


# Every table own_table() is called on. A fixed list, because the name goes
# into the SQL.
OWNED_TABLES = ("fitgap_runs", "fitgap_reviews", "rollout_runs", "workshop_sessions",
                "workshop_decisions", "evidence_runs", "ask_runs", "ask_reviews")


def reassign_legacy(conn, username: str, tables: list[str] | None = None) -> dict[str, int]:
    """Give what `legacy` owns in `tables` (default: all of them) to
    `username`, so it shows in that account's history. Returns the rows moved
    per table; a table that does not exist yet is skipped."""
    tables = list(tables or OWNED_TABLES)
    unknown = [t for t in tables if t not in OWNED_TABLES]
    if unknown:
        raise AccountError(f"Not an owned table: {', '.join(unknown)}."
                           f" Choose from {', '.join(OWNED_TABLES)}.")
    name = (username or "").strip()
    r = conn.execute("SELECT id FROM users WHERE lower(username) = lower(%s)", (name,)).fetchone()
    if r is None or name.lower() == LEGACY:
        raise AccountError(f'There is no account called "{name}".')
    lid = legacy_id(conn)
    moved = {}
    with conn.transaction():
        for t in tables:
            if conn.execute("SELECT to_regclass(%s)", (t,)).fetchone()[0] is None:
                continue
            moved[t] = conn.execute(f"UPDATE {t} SET user_id = %s WHERE user_id = %s",
                                    (r[0], lid)).rowcount
    return moved


# --- activity ----------------------------------------------------------------


def log_event(user: dict | None, action: str, *, tool: str | None = None,
              run_id: str | None = None, detail: dict | None = None,
              username: str | None = None) -> None:
    """Record one thing a user did. Never raises: a usage counter that fails
    must not fail the run it was counting."""
    try:
        conn = connect()
        create_schema(conn)
        conn.execute(
            "INSERT INTO activity_events (user_id, username, action, tool, run_id, detail)"
            " VALUES (%s, %s, %s, %s, %s, %s)",
            ((user or {}).get("id"), username or (user or {}).get("username") or "",
             action, tool, run_id, json.dumps(detail or {}, default=str)))
        conn.commit()
    except Exception as exc:  # pragma: no cover - logged, not raised
        print(f"auth: could not log {action}: {exc}")


def _cli(argv: list[str]) -> int:
    import getpass

    if len(argv) >= 2 and argv[0] == "create-admin":
        password = getpass.getpass(f"Password for {argv[1]}: ")
        if password != getpass.getpass("Again: "):
            print("The passwords differ.")
            return 1
        conn = connect()
        try:
            user = create_user(conn, argv[1], password, "admin")
        except AccountError as exc:
            print(exc)
            return 1
        print(f"Created Admin {user['username']} (id {user['id']}).")
        return 0
    if argv[:1] == ["list"]:
        for u in list_users(connect()):
            print(f"{u['id']:>4}  {u['username']:<24} {u['role']:<6} "
                  f"{'active' if u['active'] else 'inactive'}")
        return 0
    if len(argv) >= 2 and argv[0] == "reassign-legacy":
        try:
            moved = reassign_legacy(connect(), argv[1], argv[2:])
        except AccountError as exc:
            print(exc)
            return 1
        for t, n in moved.items():
            print(f"{t:<20} {n:>4} moved from {LEGACY} to {argv[1]}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    import sys

    from dotenv import load_dotenv

    from backend.core.paths import ROOT

    load_dotenv(ROOT / ".env", override=False)
    sys.exit(_cli(sys.argv[1:]))
