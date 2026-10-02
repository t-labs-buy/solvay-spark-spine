"""The Admin area's API: accounts, usage and the activity log.

Every route needs an Admin (deps.require_admin).

Usage is read from the run tables themselves, which already record the
tokens and the time each run took -- adding a second copy of those numbers
would only give them a way to disagree. Sign-ins and the other things a run
table does not hold come from activity_events. LLM cost is not stored here;
it is in Langfuse, per trace, under each user's username.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.auth import middleware, store
from backend.auth.deps import require_admin

router = APIRouter(prefix="/api/admin")

# One row per run, whatever the tool, in the shape the usage queries read.
# Fit-Gap and Rollout record no `seconds`, so their duration is the span.
# A table that does not exist yet (a fresh database where that tool has never
# run) is left out rather than failing the whole dashboard; see _runs_sql.
_RUN_TABLES = {
    "evidence": ("evidence_runs", "seconds"),
    "ask": ("ask_runs", "seconds"),
    "fitgap": ("fitgap_runs", "EXTRACT(EPOCH FROM (finished_at - started_at))"),
    "rollout": ("rollout_runs", "EXTRACT(EPOCH FROM (finished_at - started_at))"),
}
TOOLS = tuple(_RUN_TABLES)


def _runs_sql(conn) -> str:
    present = {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
        " AND table_name = ANY(%s)", ([t for t, _ in _RUN_TABLES.values()],)).fetchall()}
    parts = [
        f"SELECT '{tool}' AS tool, id, user_id, started_at, status,"
        f" COALESCE({secs}, 0)::float AS seconds,"
        f" COALESCE(input_tokens, 0)::bigint AS input_tokens,"
        f" COALESCE(output_tokens, 0)::bigint AS output_tokens FROM {table}"
        for tool, (table, secs) in _RUN_TABLES.items() if table in present
    ]
    if not parts:
        return ("SELECT NULL::text AS tool, NULL::text AS id, NULL::bigint AS user_id,"
                " NULL::timestamptz AS started_at, NULL::text AS status, 0::float AS seconds,"
                " 0::bigint AS input_tokens, 0::bigint AS output_tokens WHERE false")
    return " UNION ALL ".join(parts)


def _window(start: date | None, end: date | None) -> tuple[datetime, datetime]:
    """[from, to) in UTC. Defaults to the last 30 days; `to` is inclusive of
    its whole day."""
    today = datetime.now(timezone.utc).date()
    end = end or today
    start = start or (end - timedelta(days=29))
    if start > end:
        raise HTTPException(400, "`from` is after `to`")
    if (end - start).days > 366:
        raise HTTPException(400, "Ask for a year or less at a time")
    lo = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    hi = datetime(end.year, end.month, end.day, tzinfo=timezone.utc) + timedelta(days=1)
    return lo, hi


# --- accounts ----------------------------------------------------------------


class NewUser(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=200)
    role: str = "user"


class UserChange(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = Field(default=None, max_length=200)


@router.get("/users")
def users(_admin: dict = Depends(require_admin)) -> dict:
    """Every account, with how many runs each has made in all."""
    conn = store.connect()
    rows = store.list_users(conn)
    counts = {r[0]: r[1] for r in conn.execute(
        f"SELECT user_id, count(*) FROM ({_runs_sql(conn)}) runs GROUP BY user_id").fetchall()}
    return {"users": [{**u, "runs": counts.get(u["id"], 0)} for u in rows]}


@router.post("/users")
def create_user(body: NewUser, admin: dict = Depends(require_admin)) -> dict:
    try:
        user = store.create_user(store.connect(), body.username, body.password, body.role)
    except store.AccountError as exc:
        raise HTTPException(400, str(exc))
    store.log_event(admin, "user_created", detail={"user": user["username"], "role": user["role"]})
    return user


@router.patch("/users/{uid}")
def update_user(uid: int, body: UserChange, admin: dict = Depends(require_admin)) -> dict:
    try:
        user = store.update_user(store.connect(), uid, role=body.role, active=body.active,
                                 password=body.password or None, acting=admin["id"])
    except store.AccountError as exc:
        raise HTTPException(400, str(exc))
    # The change applies on this user's very next request, not in thirty seconds.
    middleware.forget(uid)
    changed = {k: v for k, v in body.model_dump().items() if v is not None and k != "password"}
    if body.password:
        changed["password"] = "reset"
    store.log_event(admin, "user_updated", detail={"user": user["username"], **changed})
    return user


# --- usage -------------------------------------------------------------------


@router.get("/usage")
def usage(start: date | None = None, end: date | None = None, user_id: int | None = None,
          _admin: dict = Depends(require_admin)) -> dict:
    """What each account did in a window: runs per tool with failures, time
    and tokens; sign-ins; and a day-by-day series for the chart.

    `start` and `end` are dates (YYYY-MM-DD), both inclusive; the query string
    names are `start` and `end` because `from` is a Python keyword."""
    lo, hi = _window(start, end)
    conn = store.connect()
    store.create_schema(conn)
    runs = _runs_sql(conn)
    who = " AND user_id = %s" if user_id is not None else ""
    args: list = [lo, hi] + ([user_id] if user_id is not None else [])

    per_tool = conn.execute(
        f"""SELECT user_id, tool, count(*),
                   count(*) FILTER (WHERE status = 'failed'),
                   COALESCE(sum(seconds), 0), COALESCE(sum(input_tokens), 0),
                   COALESCE(sum(output_tokens), 0)
            FROM ({runs}) r WHERE started_at >= %s AND started_at < %s{who}
            GROUP BY user_id, tool""", args).fetchall()
    logins = conn.execute(
        f"""SELECT user_id, count(*) FILTER (WHERE action = 'login'),
                   count(*) FILTER (WHERE action = 'login_failed')
            FROM activity_events WHERE at >= %s AND at < %s{who} GROUP BY user_id""",
        args).fetchall()
    failed_unknown = conn.execute(
        "SELECT count(*) FROM activity_events WHERE action = 'login_failed' AND user_id IS NULL"
        " AND at >= %s AND at < %s", (lo, hi)).fetchone()[0]
    daily = conn.execute(
        f"""SELECT (started_at AT TIME ZONE 'UTC')::date AS day, tool, count(*)
            FROM ({runs}) r WHERE started_at >= %s AND started_at < %s{who}
            GROUP BY day, tool ORDER BY day""", args).fetchall()

    accounts = {u["id"]: u for u in store.list_users(conn)}
    legacy = store.legacy_id(conn)
    by_user: dict[int, dict] = {}

    def row(uid: int) -> dict:
        if uid not in by_user:
            u = accounts.get(uid)
            by_user[uid] = {
                "user_id": uid,
                "username": u["username"] if u else (store.LEGACY if uid == legacy else f"#{uid}"),
                "role": u["role"] if u else "user",
                "active": u["active"] if u else False,
                "last_login_at": u["last_login_at"] if u else None,
                "last_seen_at": u["last_seen_at"] if u else None,
                "tools": {t: {"runs": 0, "failed": 0, "seconds": 0.0,
                              "input_tokens": 0, "output_tokens": 0} for t in TOOLS},
                "runs": 0, "failed": 0, "seconds": 0.0, "input_tokens": 0, "output_tokens": 0,
                "logins": 0, "failed_logins": 0,
            }
        return by_user[uid]

    for uid, tool, n, failed, secs, tin, tout in per_tool:
        if uid is None:
            continue
        r = row(uid)
        r["tools"][tool] = {"runs": n, "failed": failed, "seconds": round(float(secs), 1),
                            "input_tokens": int(tin), "output_tokens": int(tout)}
        r["runs"] += n
        r["failed"] += failed
        r["seconds"] = round(r["seconds"] + float(secs), 1)
        r["input_tokens"] += int(tin)
        r["output_tokens"] += int(tout)
    for uid, ok, bad in logins:
        if uid is None:
            continue
        r = row(uid)
        r["logins"], r["failed_logins"] = ok, bad
    # Accounts that did nothing in the window still get a row, so "who has not
    # used it" is answerable -- unless the view is narrowed to one account.
    if user_id is None:
        for uid in accounts:
            row(uid)
    elif user_id in accounts:
        row(user_id)

    series: dict[str, dict] = {}
    day = lo.date()
    while day < hi.date():
        series[day.isoformat()] = {"day": day.isoformat(), **{t: 0 for t in TOOLS}}
        day += timedelta(days=1)
    for d, tool, n in daily:
        if d.isoformat() in series:
            series[d.isoformat()][tool] = n

    rows = sorted(by_user.values(), key=lambda r: (-r["runs"], r["username"].lower()))
    totals = {
        "runs": sum(r["runs"] for r in rows),
        "failed": sum(r["failed"] for r in rows),
        "seconds": round(sum(r["seconds"] for r in rows), 1),
        "input_tokens": sum(r["input_tokens"] for r in rows),
        "output_tokens": sum(r["output_tokens"] for r in rows),
        "logins": sum(r["logins"] for r in rows),
        "failed_logins": sum(r["failed_logins"] for r in rows) + failed_unknown,
        # Real accounts only: `legacy` holds old runs, it is not somebody.
        "active_users": sum(1 for r in rows
                            if (r["runs"] or r["logins"]) and r["user_id"] != legacy),
        "by_tool": {t: sum(r["tools"][t]["runs"] for r in rows) for t in TOOLS},
    }
    return {"from": lo.date().isoformat(), "to": (hi - timedelta(days=1)).date().isoformat(),
            "tools": list(TOOLS), "totals": totals, "users": rows,
            "daily": list(series.values())}


@router.get("/activity")
def activity(limit: int = 100, before: int | None = None, user_id: int | None = None,
             action: str = "", _admin: dict = Depends(require_admin)) -> dict:
    """The activity log, newest first. Paged by id: pass the last id seen as
    `before` for the next page."""
    conn = store.connect()
    store.create_schema(conn)
    where, args = ["true"], []
    if before is not None:
        where.append("id < %s"); args.append(before)
    if user_id is not None:
        where.append("user_id = %s"); args.append(user_id)
    if action:
        where.append("action = %s"); args.append(action)
    limit = max(1, min(limit, 500))
    rows = conn.execute(
        f"""SELECT id, at, user_id, username, action, tool, run_id, detail
            FROM activity_events WHERE {' AND '.join(where)}
            ORDER BY id DESC LIMIT %s""", (*args, limit + 1)).fetchall()
    events = [{"id": r[0], "at": r[1].isoformat(), "user_id": r[2], "username": r[3],
               "action": r[4], "tool": r[5], "run_id": r[6], "detail": r[7] or {}}
              for r in rows[:limit]]
    actions = [r[0] for r in conn.execute(
        "SELECT DISTINCT action FROM activity_events ORDER BY action").fetchall()]
    return {"events": events, "more": len(rows) > limit, "actions": actions}


# --- one account's runs ------------------------------------------------------

# What a run is called in the list, per tool: the question for the two that
# answer questions, the scope for the two that analyse one.
_TITLES = {
    "evidence": ("evidence_runs", "question"),
    "ask": ("ask_runs", "question"),
    "fitgap": ("fitgap_runs", "COALESCE(NULLIF(question, ''), scope_label)"),
    "rollout": ("rollout_runs",
                "concat_ws(' · ', NULLIF(country, ''), NULLIF(scope_label, ''), NULLIF(question, ''))"),
}


@router.get("/runs")
def runs(user_id: int | None = None, tool: str = "", limit: int = 50, before: str = "",
         _admin: dict = Depends(require_admin)) -> dict:
    """Every run an account made, across the four tools, newest first -- the
    account's run history as an Admin reads it. Without `user_id`, everyone's.

    Paged by time: pass the last row's `started_at` as `before`. Each row is a
    summary; the run itself opens through its own tool's endpoint, which lets
    an Admin read any account's run."""
    conn = store.connect()
    store.create_schema(conn)
    if tool and tool not in _TITLES:
        raise HTTPException(400, f"tool must be one of {', '.join(_TITLES)}")
    present = {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
        " AND table_name = ANY(%s)", ([t for t, _ in _TITLES.values()],)).fetchall()}
    parts = []
    for name, (table, title) in _TITLES.items():
        if table not in present or (tool and tool != name):
            continue
        secs = _RUN_TABLES[name][1]
        parts.append(
            f"SELECT '{name}' AS tool, id, user_id, started_at, status, {title} AS title,"
            f" COALESCE({secs}, 0)::float AS seconds,"
            f" COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS tokens FROM {table}")
    if not parts:
        return {"runs": [], "more": False}
    where, args = ["true"], []
    if user_id is not None:
        where.append("r.user_id = %s"); args.append(user_id)
    if before:
        where.append("r.started_at < %s::timestamptz"); args.append(before)
    limit = max(1, min(limit, 200))
    rows = conn.execute(
        f"""SELECT r.tool, r.id, r.user_id, u.username, r.started_at, r.status, r.title,
                   r.seconds, r.tokens
            FROM ({' UNION ALL '.join(parts)}) r LEFT JOIN users u ON u.id = r.user_id
            WHERE {' AND '.join(where)}
            ORDER BY r.started_at DESC LIMIT %s""", (*args, limit + 1)).fetchall()
    out = [{"tool": r[0], "id": r[1], "user_id": r[2], "username": r[3] or "",
            "started_at": r[4].isoformat() if r[4] else None, "status": r[5],
            "title": (r[6] or "")[:240], "seconds": round(float(r[7] or 0), 1),
            "tokens": int(r[8] or 0)} for r in rows[:limit]]
    return {"runs": out, "more": len(rows) > limit}
