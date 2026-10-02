"""Postgres persistence for Evidence Agent investigations.

An investigation used to be ask-and-forget: the answer streamed to the browser,
the tab was closed, and there was nothing left of it. That is fine for a
throwaway question and wrong for everything else -- the agent's whole claim is
that an answer carries its evidence and the arithmetic behind its score, and a
claim you cannot go back and look at is a claim nobody can check.

So the run is written down. One row per investigation, in the main database
beside the corpus it read, holding three things:

  * what was asked, and under what settings -- the question, the holdout flag,
    the categories, the model and the prompt hash;
  * what the agent did -- every tool call, in order, with the summary, the
    source label the page shows, and the evidence that call returned. This is
    the investigation, and without it a reopened run is an answer with no
    working. The trace is what makes it checkable rather than merely visible:
    the summary says retrieval ran, the trace says which passages came back
    and at what rank;
  * what came back -- the whole verified Answer, claims, sources, scores and
    all.

Nothing here is per-category, so there is no category column: a run reads
whatever it was pointed at and records one result. The corpus fingerprint says
what it could have read, the same way InsightLens's and the Fit-Gap Copilot's
records do.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from typing import Any


from backend.auth.store import owned as auth_owned  # noqa: E402
from backend.rag import rag  # noqa: E402


def database_url() -> str:
    """The main database, beside the corpus the investigation read."""
    return rag.base_url()


def connect():
    """Shared and cached per thread, so callers must not close it;
    rag.close() releases a thread's connection."""
    return rag.connection(schema=False)


# Once per process per database: see ask_store.py for the deadlock that
# running ALTER TABLE on every request caused.
_ready: set[str] = set()
_ready_lock = threading.Lock()


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
    from backend.auth import store as auth_store

    with conn.transaction():
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS evidence_runs (
                id            text PRIMARY KEY,
                question      text NOT NULL,
                holdout       boolean NOT NULL DEFAULT false,
                categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
                model         text NOT NULL DEFAULT '',
                prompt_hash   text NOT NULL DEFAULT '',
                corpus_fingerprint text NOT NULL DEFAULT '',
                started_at    timestamptz NOT NULL DEFAULT now(),
                finished_at   timestamptz,
                status        text NOT NULL DEFAULT 'running',
                state         text NOT NULL DEFAULT '',
                input_tokens  int NOT NULL DEFAULT 0,
                output_tokens int NOT NULL DEFAULT 0,
                seconds       real NOT NULL DEFAULT 0,
                answer        jsonb,
                calls         jsonb NOT NULL DEFAULT '[]'::jsonb,
                error         text NOT NULL DEFAULT ''
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS evidence_runs_started_idx"
                     " ON evidence_runs (started_at DESC)")
        # Added after the table existed. What the run remembered, and whether
        # it was allowed to: a reopened answer that was steered by memory read
        # something this corpus does not contain, and the row has to say so or
        # the run cannot be reproduced.
        conn.execute("ALTER TABLE evidence_runs ADD COLUMN IF NOT EXISTS"
                     " memory jsonb NOT NULL DEFAULT '{}'::jsonb")
        # Everything that happened, in order, with timestamps. `calls` holds
        # what each tool RETURNED; this holds the run as a sequence -- the
        # assembled prompt, the reasoning between calls, the budget notice, a
        # rejected submission. Those were only ever visible to whoever was
        # watching the stream, which meant a reopened investigation could show
        # what the agent did and never why.
        conn.execute("ALTER TABLE evidence_runs ADD COLUMN IF NOT EXISTS"
                     " log jsonb NOT NULL DEFAULT '[]'::jsonb")
        # The run's own quality scores (agent_eval.py), as the Evaluation tab
        # shows them. Runs recorded before it have an empty object.
        conn.execute("ALTER TABLE evidence_runs ADD COLUMN IF NOT EXISTS"
                     " evaluation jsonb NOT NULL DEFAULT '{}'::jsonb")
        # Who ran it. Runs from before accounts belong to `legacy`.
        auth_store.own_table(conn, "evidence_runs")


def start_run(conn, run: dict) -> None:
    conn.execute(
        """INSERT INTO evidence_runs
           (id, question, holdout, categories, model, prompt_hash, corpus_fingerprint, user_id)
           VALUES (%(id)s, %(question)s, %(holdout)s, %(categories)s, %(model)s,
                   %(prompt_hash)s, %(corpus_fingerprint)s, %(user_id)s)
           ON CONFLICT (id) DO NOTHING""",
        {**run, "categories": json.dumps(run.get("categories") or []),
         "user_id": run.get("user_id")},
    )
    conn.commit()


def save_calls(conn, run_id: str, calls: list[dict]) -> None:
    """The investigation log, rewritten in full after each call.

    Whole-list rather than append-one because a dropped connection should
    still leave the row holding everything that happened up to the drop, and
    because twelve calls of a few hundred bytes is not worth a second table."""
    conn.execute("UPDATE evidence_runs SET calls = %s WHERE id = %s",
                 (json.dumps(calls, default=str), run_id))
    conn.commit()


def save_memory(conn, run_id: str, memory: dict) -> None:
    """What memory contributed, recorded before the first tool call.

    Written on its own rather than folded into finish_run because a run that
    is abandoned half way still read those memories, and the reason its
    reasoning looks the way it does is in them."""
    conn.execute("UPDATE evidence_runs SET memory = %s WHERE id = %s",
                 (json.dumps(memory, default=str), run_id))
    conn.commit()


def save_log(conn, run_id: str, log: list[dict]) -> None:
    """The session log, rewritten in full as it grows.

    Whole-list for the same reason as save_calls: a dropped connection should
    leave the row holding everything up to the drop. Entries are small -- the
    heavy traces stay in `calls` and the log points at them by index."""
    conn.execute("UPDATE evidence_runs SET log = %s WHERE id = %s",
                 (json.dumps(log, default=str), run_id))
    conn.commit()


def finish_run(conn, run_id: str, answer: dict, calls: list[dict]) -> None:
    conn.execute(
        """UPDATE evidence_runs
           SET answer = %s, calls = %s, state = %s, status = 'done', finished_at = now(),
               input_tokens = %s, output_tokens = %s, seconds = %s
           WHERE id = %s""",
        (json.dumps(answer, default=str), json.dumps(calls, default=str),
         answer.get("state", ""), answer.get("input_tokens", 0),
         answer.get("output_tokens", 0), answer.get("seconds", 0), run_id),
    )
    conn.commit()
    trim(conn, owner=_owner_of(conn, run_id))


def save_evaluation(conn, run_id: str, evaluation: dict) -> None:
    conn.execute("UPDATE evidence_runs SET evaluation = %s WHERE id = %s",
                 (json.dumps(evaluation, default=str), run_id))
    conn.commit()


def fail_run(conn, run_id: str, message: str, calls: list[dict] | None = None) -> None:
    """A failed investigation is kept, not dropped. What the agent managed to
    read before it failed is often the whole point of looking again."""
    conn.execute(
        "UPDATE evidence_runs SET status = 'failed', finished_at = now(),"
        " error = %s, calls = %s WHERE id = %s",
        (message[:2000], json.dumps(calls or [], default=str), run_id),
    )
    conn.commit()


# A run whose SSE stream was dropped -- the browser closed, the tab abandoned --
# never reaches finish_run and would sit at "running" for ever. Reported as
# abandoned rather than mutated, so the row keeps the fact that it was
# interrupted rather than finished.
STALE_AFTER_MINUTES = 30


def _status(status: str, started_at) -> str:
    from datetime import datetime, timedelta, timezone

    if status == "running" and started_at and (
            datetime.now(timezone.utc) - started_at > timedelta(minutes=STALE_AFTER_MINUTES)):
        return "abandoned"
    return status


_COLUMNS = ("id, question, holdout, categories, model, prompt_hash, corpus_fingerprint,"
            " started_at, finished_at, status, state, input_tokens, output_tokens,"
            " seconds, answer, calls, error, memory, log, evaluation, user_id")


def _row(r) -> dict:
    return {
        "id": r[0], "question": r[1], "holdout": r[2], "categories": r[3] or [],
        "model": r[4], "prompt_hash": r[5], "corpus_fingerprint": r[6],
        "started_at": r[7].isoformat() if r[7] else None,
        "finished_at": r[8].isoformat() if r[8] else None,
        "status": _status(r[9], r[7]), "state": r[10],
        "input_tokens": r[11], "output_tokens": r[12], "seconds": r[13],
        "answer": r[14], "calls": r[15] or [], "error": r[16],
        "memory": r[17] or {},
        "log": r[18] or [],
        "evaluation": r[19] or {},
        "user_id": r[20],
    }


def _owner_of(conn, run_id: str) -> int | None:
    r = conn.execute("SELECT user_id FROM evidence_runs WHERE id = %s", (run_id,)).fetchone()
    return r[0] if r else None


def get_run(conn, run_id: str, owner: int | None = None) -> dict | None:
    """The run, or None if it does not exist or is not `owner`'s (None: any)."""
    where, args = auth_owned(owner)
    r = conn.execute(f"SELECT {_COLUMNS} FROM evidence_runs WHERE id = %s{where}",
                     (run_id, *args)).fetchone()
    return _row(r) if r else None


def list_runs(conn, limit: int = 50, owner: int | None = None) -> list[dict]:
    """The history strip: enough to recognise a question and decide whether to
    reopen it, without carrying every claim and quote of fifty runs."""
    where, args = auth_owned(owner, "r")
    rows = conn.execute(
        """SELECT r.id, r.question, r.holdout, r.status, r.state, r.started_at,
                  r.finished_at, r.seconds, r.model, r.answer,
                  jsonb_array_length(r.calls), r.categories, r.memory,
                  r.user_id, u.username
           FROM evidence_runs r LEFT JOIN users u ON u.id = r.user_id
           WHERE true""" + where + """
           ORDER BY r.started_at DESC LIMIT %s""",
        (*args, limit),
    ).fetchall()
    out = []
    for r in rows:
        answer = r[9] or {}
        claims = answer.get("claims") or []
        sources = sum(len(c.get("sources") or []) for c in claims)
        out.append({
            "id": r[0], "question": r[1], "holdout": r[2],
            "status": _status(r[3], r[5]), "state": r[4],
            "started_at": r[5].isoformat() if r[5] else None,
            "finished_at": r[6].isoformat() if r[6] else None,
            "seconds": r[7], "model": r[8],
            "claims": len(claims), "sources": sources,
            # Counted in SQL. Selecting `calls` to take its length pulled
            # every trace of fifty runs across the wire to produce a number --
            # cheap when a call was a summary line, not once it carries the
            # passages that call returned.
            "tool_calls": r[10] or 0,
            "categories": r[11] or [],
            "memory": r[12] or {},
            # The one-line answer, so the strip is scannable without opening
            # anything. Truncated here rather than in the browser: there is no
            # reason to send 1,400 characters fifty times over.
            "summary": (answer.get("answer") or "")[:180],
            "user_id": r[13], "owner": r[14],
        })
    return out


# How many investigations are kept. A run now records the evidence behind every
# call, not just that the call happened, so a row is kilobytes rather than
# bytes and the table no longer grows slowly enough to ignore. Trimmed oldest
# first after each run finishes.
RETENTION = int(os.environ.get("EVIDENCE_HISTORY_LIMIT", "200"))


def trim(conn, keep: int = RETENTION, owner: int | None = None) -> int:
    """Drop `owner`'s oldest runs beyond `keep`. Returns how many went.

    Per owner, so one busy user cannot push everyone else's history out."""
    if keep <= 0:
        return 0
    removed = conn.execute(
        """DELETE FROM evidence_runs WHERE id IN (
               SELECT id FROM evidence_runs WHERE user_id IS NOT DISTINCT FROM %s
               ORDER BY started_at DESC OFFSET %s
           ) RETURNING id""",
        (owner, keep),
    ).fetchall()
    conn.commit()
    return len(removed)


def delete_run(conn, run_id: str, owner: int | None = None) -> bool:
    where, args = auth_owned(owner)
    removed = conn.execute(
        f"DELETE FROM evidence_runs WHERE id = %s{where} RETURNING id",
        (run_id, *args)).fetchall()
    conn.commit()
    return bool(removed)


def stats(conn=None) -> dict[str, Any]:
    conn = conn or connect()
    create_schema(conn)
    runs, answered = conn.execute(
        "SELECT count(*), count(*) FILTER (WHERE status = 'done') FROM evidence_runs"
    ).fetchone()
    return {"runs": runs, "answered": answered,
            "database": rag.database_name(database_url())}
