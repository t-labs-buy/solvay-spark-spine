"""Postgres persistence for Ask RAG questions.

Ask used to be ask-and-forget: the answer streamed to the browser and, once the
box was retyped, there was nothing left of it. That is fine for a throwaway
question and wrong for the rest -- someone asks the same thing three days apart
and has no way to see that the corpus answered differently, and a good answer
found on a Tuesday cannot be handed to anyone.

So the run is written down. One row per question, in the main database beside
the corpus it read, holding:

  * what was asked and how -- the question, the search mode, k, the categories
    in scope, the two models and a fingerprint of the corpus;
  * what came back -- the answer, and the excerpts it was written from.

Two decisions worth stating, because they are the reason this is not simply
`evidence_runs` with the columns renamed.

The excerpt TEXT is stored, not the chunk ids. Storing ids would be a quarter
of the bytes and would be wrong: re-indexing renumbers chunks, so a reopened
answer would show today's chunk under yesterday's citation and quietly
misattribute it. A history you cannot trust is worse than none, so a run keeps
the excerpts it actually read.

Since answers started being scored there is a second table here,
`ask_evaluations`, holding one judged evaluation per question. It is a table
rather than more columns because an evaluation has a life of its own: it begins
after the answer has finished, it can fail without the answer failing, and it
can be asked for again without the question being asked again. It is tied to
the question with ON DELETE CASCADE, so the retention rule below governs both
and there is only ever one sweeper.

And the history is CAPPED. An investigation is minutes long and deliberate;
a question is ten seconds and casual, so these rows accumulate far faster than
the Evidence Agent's ever will. The oldest are trimmed past RETENTION so a
year of asking cannot quietly grow the database the corpus lives in.
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

# How many questions to keep. Older rows are trimmed as new ones arrive.
# Measured at about 7 KB a run -- eight excerpts plus the answer, TOASTed --
# so 500 is roughly 3 MB, which is noise beside a 126 MB corpus.
RETENTION = int(os.environ.get("ASK_HISTORY_LIMIT", "500"))

# A question whose SSE stream was dropped -- tab closed, browser quit -- never
# reaches finish_run. Reported as abandoned rather than mutated, so the row
# keeps the fact that it was interrupted. Far shorter than the Evidence
# Agent's thirty minutes: a question that has not finished in five is gone.
STALE_AFTER_MINUTES = 5

# The line the history panel's "low quality" filter draws. Not a claim that
# 0.69 is bad and 0.71 is fine -- it is the threshold the request named, and a
# filter has to draw its line somewhere. Overridable because a corpus where
# every answer scores 0.6 needs a different line to be useful.
LOW_QUALITY = float(os.environ.get("ASK_LOW_QUALITY", "0.7"))

# An evaluation that never reported. Judging takes ten to fifteen seconds, so
# anything still 'running' after this was a server restart or a crashed thread.
EVAL_STALE_AFTER_MINUTES = 10


def database_url() -> str:
    """The main database, beside the corpus the question read."""
    return rag.base_url()


def connect():
    """Shared and cached per thread, so callers must not close it;
    rag.close() releases a thread's connection."""
    return rag.connection(schema=False)


# Which databases this process has already brought up to date.
#
# create_schema is called at the top of every endpoint that touches these
# tables, and it used to do its work every time. That was harmless while it was
# only CREATE TABLE IF NOT EXISTS, which returns without locking a table that
# exists. It stopped being harmless when the ALTER TABLE ... ADD COLUMN IF NOT
# EXISTS statements arrived: those take an ACCESS EXCLUSIVE lock on the table
# *before* discovering the column is already there, so two requests arriving
# together -- the quality dashboard loading two views, or a question starting
# while another answer's judging thread starts -- each held one table and
# waited for the other, and Postgres killed one with "deadlock detected".
#
# Once per process per database, under a lock, is all the DDL ever needed.
# Keyed by URL rather than a single flag because the tests point the same
# process at a throwaway database.
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
            CREATE TABLE IF NOT EXISTS ask_runs (
                id            text PRIMARY KEY,
                question      text NOT NULL,
                mode          text NOT NULL DEFAULT 'hybrid',
                k             int  NOT NULL DEFAULT 8,
                categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
                answer_model  text NOT NULL DEFAULT '',
                embed_model   text NOT NULL DEFAULT '',
                corpus_fingerprint text NOT NULL DEFAULT '',
                started_at    timestamptz NOT NULL DEFAULT now(),
                finished_at   timestamptz,
                status        text NOT NULL DEFAULT 'running',
                seconds       real NOT NULL DEFAULT 0,
                input_tokens  int NOT NULL DEFAULT 0,
                output_tokens int NOT NULL DEFAULT 0,
                answer        text NOT NULL DEFAULT '',
                sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
                terms         jsonb NOT NULL DEFAULT '[]'::jsonb,
                error         text NOT NULL DEFAULT ''
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ask_runs_started_idx"
                     " ON ask_runs (started_at DESC)")

        # CREATE TABLE IF NOT EXISTS does not add a column to a table that
        # already exists, and this one does. Both of these were added when
        # answers started being scored.
        #
        # The Langfuse trace id, because without it a row here and the trace of
        # the same question could not be connected at all -- and a score has to
        # be attached to a trace, not to a question.
        conn.execute("ALTER TABLE ask_runs ADD COLUMN IF NOT EXISTS"
                     " trace_id text NOT NULL DEFAULT ''")
        # A fingerprint of the system prompt the answer was written under.
        # Two scores either side of a prompt edit are not comparable, and
        # nothing recorded that they weren't; the corpus fingerprint beside it
        # has done the same job for the corpus since the day it was added.
        conn.execute("ALTER TABLE ask_runs ADD COLUMN IF NOT EXISTS"
                     " prompt_hash text NOT NULL DEFAULT ''")

        # One evaluation per run, replaced when a run is scored again.
        #
        # A table of its own rather than columns on ask_runs, because an
        # evaluation has its own lifecycle: it starts after the answer has
        # finished, can fail on its own, and can be asked for a second time
        # without the answer being asked again.
        #
        # ON DELETE CASCADE is load-bearing. trim() drops the oldest questions
        # past RETENTION and delete_run() drops one; with the cascade their
        # evaluations go with them and there is no second sweeper to write, to
        # schedule, or to forget to run.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ask_evaluations (
                run_id        text PRIMARY KEY
                              REFERENCES ask_runs(id) ON DELETE CASCADE,
                status        text NOT NULL DEFAULT 'running',
                judge_model   text NOT NULL DEFAULT '',
                ragas_version text NOT NULL DEFAULT '',
                started_at    timestamptz NOT NULL DEFAULT now(),
                finished_at   timestamptz,
                seconds       real NOT NULL DEFAULT 0,
                metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
                overall       real,
                safety        real,
                terms         jsonb NOT NULL DEFAULT '{}'::jsonb,
                scores_pushed int  NOT NULL DEFAULT 0,
                error         text NOT NULL DEFAULT ''
            )"""
        )
        # The history panel's quality filters sort by the question's time and
        # select on the evaluation, so the join wants both ends indexed.
        conn.execute("CREATE INDEX IF NOT EXISTS ask_evaluations_overall_idx"
                     " ON ask_evaluations (overall)")

        # Every finished evaluation, kept. ask_evaluations holds only the
        # latest verdict per question, which is right for the page and useless
        # for asking whether the judge is stable -- that needs the verdict
        # before this one. The judge runs at the model's default sampling
        # (this Anthropic SDK exposes no temperature), so "would it say the
        # same thing twice?" is a question with a measurable answer, and this
        # is where the answer comes from. Only the numbers are kept; the
        # working stays with the current evaluation.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ask_evaluation_history (
                id          bigserial PRIMARY KEY,
                run_id      text NOT NULL REFERENCES ask_runs(id) ON DELETE CASCADE,
                finished_at timestamptz NOT NULL DEFAULT now(),
                judge_model text NOT NULL DEFAULT '',
                overall     real,
                safety      real,
                scores      jsonb NOT NULL DEFAULT '{}'::jsonb
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ask_evaluation_history_run_idx"
                     " ON ask_evaluation_history (run_id, finished_at)")

        # A person's verdict on whether an answer is grounded. The only
        # evidence there will ever be that the judge agrees with people, which
        # every other number on the quality dashboard silently depends on.
        # One per question: a second review replaces the first, because the
        # question being answered is "what does a reviewer think now".
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ask_reviews (
                run_id     text PRIMARY KEY REFERENCES ask_runs(id) ON DELETE CASCADE,
                verdict    text NOT NULL,
                reviewer   text NOT NULL DEFAULT '',
                note       text NOT NULL DEFAULT '',
                created_at timestamptz NOT NULL DEFAULT now()
            )"""
        )
        # Who asked, and who reviewed. Rows from before accounts belong to
        # `legacy`.
        auth_store.own_table(conn, "ask_runs")
        auth_store.own_table(conn, "ask_reviews", "created_at")


def start_run(conn, run: dict) -> None:
    conn.execute(
        """INSERT INTO ask_runs
           (id, question, mode, k, categories, answer_model, embed_model,
            corpus_fingerprint, prompt_hash, user_id)
           VALUES (%(id)s, %(question)s, %(mode)s, %(k)s, %(categories)s,
                   %(answer_model)s, %(embed_model)s, %(corpus_fingerprint)s,
                   %(prompt_hash)s, %(user_id)s)
           ON CONFLICT (id) DO NOTHING""",
        {"prompt_hash": "", "user_id": None, **run,
         "categories": json.dumps(run.get("categories") or [])},
    )
    conn.commit()


def save_trace(conn, run_id: str, trace_id: str) -> None:
    """The Langfuse trace this question opened.

    Written separately from start_run because the trace is opened inside
    rag.ask_events, one step after the row exists."""
    conn.execute("UPDATE ask_runs SET trace_id = %s WHERE id = %s",
                 (trace_id, run_id))
    conn.commit()


def save_sources(conn, run_id: str, sources: list[dict], terms: list[str]) -> None:
    """Written as soon as retrieval finishes, before the model writes a word.

    A question that is abandoned mid-answer still leaves behind what the
    search found, which is the half people actually go back for."""
    conn.execute("UPDATE ask_runs SET sources = %s, terms = %s WHERE id = %s",
                 (json.dumps(sources, default=str), json.dumps(terms), run_id))
    conn.commit()


def finish_run(conn, run_id: str, answer: str, done: dict) -> None:
    conn.execute(
        """UPDATE ask_runs
           SET answer = %s, status = 'done', finished_at = now(),
               seconds = %s, input_tokens = %s, output_tokens = %s
           WHERE id = %s""",
        (answer, done.get("seconds", 0), done.get("input_tokens", 0),
         done.get("output_tokens", 0), run_id),
    )
    conn.commit()
    owner = conn.execute("SELECT user_id FROM ask_runs WHERE id = %s", (run_id,)).fetchone()
    trim(conn, owner=owner[0] if owner else None)


def fail_run(conn, run_id: str, message: str, answer: str = "") -> None:
    """A failed question is kept, not dropped -- including whatever the model
    had written before it failed. 'It stopped halfway through' is a fact about
    the run, and throwing the row away loses it."""
    conn.execute(
        "UPDATE ask_runs SET status = 'failed', finished_at = now(),"
        " error = %s, answer = %s WHERE id = %s",
        (message[:2000], answer, run_id),
    )
    conn.commit()


def trim(conn, keep: int | None = None, owner: int | None = None) -> int:
    """Drop everything past `owner`'s newest `keep` runs. Called after each
    finished question rather than on a timer, so there is no sweeper to forget
    to run. Per owner, so one busy user cannot push everyone else's out."""
    keep = RETENTION if keep is None else keep
    removed = conn.execute(
        """DELETE FROM ask_runs WHERE id IN (
               SELECT id FROM ask_runs WHERE user_id IS NOT DISTINCT FROM %s
               ORDER BY started_at DESC OFFSET %s)
           RETURNING id""",
        (owner, keep),
    ).fetchall()
    conn.commit()
    return len(removed)


def _status(status: str, started_at) -> str:
    from datetime import datetime, timedelta, timezone

    if status == "running" and started_at and (
            datetime.now(timezone.utc) - started_at > timedelta(minutes=STALE_AFTER_MINUTES)):
        return "abandoned"
    return status


_COLUMNS = ("id, question, mode, k, categories, answer_model, embed_model,"
            " corpus_fingerprint, started_at, finished_at, status, seconds,"
            " input_tokens, output_tokens, answer, sources, terms, error,"
            " trace_id, prompt_hash, user_id")


def _row(r) -> dict:
    return {
        "id": r[0], "question": r[1], "mode": r[2], "k": r[3],
        "categories": r[4] or [], "answer_model": r[5], "embed_model": r[6],
        "corpus_fingerprint": r[7],
        "started_at": r[8].isoformat() if r[8] else None,
        "finished_at": r[9].isoformat() if r[9] else None,
        "status": _status(r[10], r[8]), "seconds": r[11],
        "input_tokens": r[12], "output_tokens": r[13],
        "answer": r[14], "sources": r[15] or [], "terms": r[16] or [],
        "error": r[17], "trace_id": r[18] or "", "prompt_hash": r[19] or "",
        "user_id": r[20],
    }


# --- the evaluation -----------------------------------------------------------
#
# The row is written when judging starts, not when it finishes, for the same
# reason save_sources is: a server that dies mid-evaluation should leave behind
# the fact that it was judging, rather than a run that looks as though nobody
# ever tried.


def start_evaluation(conn, run_id: str, judge_model: str = "") -> None:
    conn.execute(
        """INSERT INTO ask_evaluations (run_id, status, judge_model)
           VALUES (%s, 'running', %s)
           ON CONFLICT (run_id) DO UPDATE
           SET status = 'running', judge_model = EXCLUDED.judge_model,
               started_at = now(), finished_at = NULL, seconds = 0,
               metrics = '{}'::jsonb, overall = NULL, safety = NULL,
               terms = '{}'::jsonb, scores_pushed = 0, error = ''""",
        (run_id, judge_model),
    )
    conn.commit()


def finish_evaluation(conn, run_id: str, result: dict, pushed: int = 0) -> None:
    """Store whatever the judges produced, including a partial result.

    `status` comes from the result rather than being forced to 'done': a run
    that was sampled out is 'skipped', which is a different fact from 'failed'
    and has to stay different in the history."""
    conn.execute(
        """UPDATE ask_evaluations
           SET status = %s, judge_model = %s, ragas_version = %s,
               finished_at = now(), seconds = %s, metrics = %s,
               overall = %s, safety = %s, terms = %s, scores_pushed = %s,
               error = %s
           WHERE run_id = %s""",
        (result.get("status") or "failed", result.get("judge_model") or "",
         result.get("ragas_version") or "", result.get("seconds") or 0,
         json.dumps(result.get("metrics") or {}),
         result.get("overall"), result.get("safety"),
         json.dumps(result.get("terms") or {}), pushed,
         (result.get("error") or "")[:2000], run_id),
    )
    if result.get("status") == "done":
        conn.execute(
            """INSERT INTO ask_evaluation_history
               (run_id, judge_model, overall, safety, scores)
               VALUES (%s, %s, %s, %s, %s)""",
            (run_id, result.get("judge_model") or "", result.get("overall"),
             result.get("safety"),
             json.dumps({name: (m or {}).get("value")
                         for name, m in (result.get("metrics") or {}).items()})),
        )
    conn.commit()


# The three verdicts a reviewer can give. Three rather than two because the
# judge's faithfulness is a fraction, and "partly" is where most of the
# interesting disagreements live.
VERDICTS = ("grounded", "partly", "not")


def save_review(conn, run_id: str, verdict: str, reviewer: str = "", note: str = "",
                user_id: int | None = None) -> None:
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {VERDICTS}")
    conn.execute(
        """INSERT INTO ask_reviews (run_id, verdict, reviewer, note, user_id)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (run_id) DO UPDATE
           SET verdict = EXCLUDED.verdict, reviewer = EXCLUDED.reviewer,
               note = EXCLUDED.note, user_id = EXCLUDED.user_id, created_at = now()""",
        (run_id, verdict, reviewer[:120], note[:2000], user_id),
    )
    conn.commit()


def get_review(conn, run_id: str) -> dict | None:
    r = conn.execute(
        "SELECT verdict, reviewer, note, created_at FROM ask_reviews WHERE run_id = %s",
        (run_id,)).fetchone()
    return ({"verdict": r[0], "reviewer": r[1], "note": r[2],
             "created_at": r[3].isoformat() if r[3] else None} if r else None)


def fail_evaluation(conn, run_id: str, message: str) -> None:
    conn.execute(
        "UPDATE ask_evaluations SET status = 'failed', finished_at = now(),"
        " error = %s WHERE run_id = %s",
        (message[:2000], run_id),
    )
    conn.commit()


_EVAL_COLUMNS = ("run_id, status, judge_model, ragas_version, started_at,"
                 " finished_at, seconds, metrics, overall, safety, terms,"
                 " scores_pushed, error")


def _eval_row(r) -> dict:
    from datetime import datetime, timedelta, timezone

    status = r[1]
    if status == "running" and r[4] and (
            datetime.now(timezone.utc) - r[4]
            > timedelta(minutes=EVAL_STALE_AFTER_MINUTES)):
        # Same treatment as an abandoned question: reported, not mutated, so
        # the row still says when it started and a re-score can overwrite it.
        status = "abandoned"
    return {
        "run_id": r[0], "status": status, "judge_model": r[2],
        "ragas_version": r[3],
        "started_at": r[4].isoformat() if r[4] else None,
        "finished_at": r[5].isoformat() if r[5] else None,
        "seconds": r[6], "metrics": r[7] or {}, "overall": r[8],
        "safety": r[9], "terms": r[10] or {}, "scores_pushed": r[11],
        "error": r[12],
    }


def get_evaluation(conn, run_id: str) -> dict | None:
    r = conn.execute(f"SELECT {_EVAL_COLUMNS} FROM ask_evaluations WHERE run_id = %s",
                     (run_id,)).fetchone()
    return _eval_row(r) if r else None


def get_run(conn, run_id: str, owner: int | None = None) -> dict | None:
    """The run, or None if it does not exist or is not `owner`'s (None: any)."""
    where, args = auth_owned(owner)
    r = conn.execute(f"SELECT {_COLUMNS} FROM ask_runs WHERE id = %s{where}",
                     (run_id, *args)).fetchone()
    return _row(r) if r else None


# The quality segments the history panel offers, as SQL. Each one answers a
# question the request asked to be answerable -- "show me the hallucinations",
# "show me the unsafe answers" -- and they are written here rather than
# assembled in the endpoint so that the set of legal values is one list.
QUALITY_FILTERS: dict[str, str] = {
    "low": "e.status = 'done' AND e.overall IS NOT NULL AND e.overall < %(low)s",
    "unfaithful": ("e.status = 'done'"
                   " AND (e.metrics -> 'faithfulness' ->> 'value') IS NOT NULL"
                   " AND (e.metrics -> 'faithfulness' ->> 'value')::real < %(low)s"),
    "unsafe": "e.status = 'done' AND e.safety IS NOT NULL AND e.safety < 1",
    # Includes a run that has no evaluation row at all, which is why the join
    # is LEFT and this reads for NULL rather than for a status.
    "unscored": "e.run_id IS NULL OR e.status <> 'done'",
}


def list_runs(conn, limit: int = 50, search: str = "", quality: str = "",
              owner: int | None = None) -> list[dict]:
    """The history panel: enough to recognise a question and decide whether to
    reopen it. Deliberately does not select `sources` or `answer` -- they are
    most of the row, and fifty of them is a megabyte nobody asked for.

    `quality` segments on the evaluation; see QUALITY_FILTERS. An unknown value
    is ignored rather than rejected, because a filter is a view and a browser
    sending a stale one should get the whole list back, not a 400."""
    clauses, params = [], {"low": LOW_QUALITY, "limit": limit}
    if search.strip():
        clauses.append("r.question ILIKE %(search)s")
        params["search"] = f"%{search.strip()}%"
    if quality in QUALITY_FILTERS:
        clauses.append(f"({QUALITY_FILTERS[quality]})")
    if owner is not None:
        clauses.append("r.user_id = %(owner)s")
        params["owner"] = owner
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"""SELECT r.id, r.question, r.mode, r.k, r.categories, r.status,
                   r.started_at, r.finished_at, r.seconds, r.answer_model,
                   jsonb_array_length(r.sources), left(r.answer, 180),
                   r.input_tokens, r.output_tokens, r.error,
                   e.status, e.overall, e.safety, r.user_id, u.username
            FROM ask_runs r
            LEFT JOIN ask_evaluations e ON e.run_id = r.id
            LEFT JOIN users u ON u.id = r.user_id
            {where} ORDER BY r.started_at DESC LIMIT %(limit)s""",
        params,
    ).fetchall()
    return [
        {
            "id": r[0], "question": r[1], "mode": r[2], "k": r[3],
            "categories": r[4] or [], "status": _status(r[5], r[6]),
            "started_at": r[6].isoformat() if r[6] else None,
            "finished_at": r[7].isoformat() if r[7] else None,
            "seconds": r[8], "answer_model": r[9], "sources": r[10] or 0,
            # The opening of the answer, so the panel is scannable without
            # opening anything. Truncated in SQL rather than in the browser:
            # there is no reason to send 1,400 characters fifty times over.
            "summary": r[11] or "",
            "input_tokens": r[12], "output_tokens": r[13], "error": r[14],
            # Enough of the evaluation to put a badge on the row. "" rather
            # than None for the status, so the browser has one empty value to
            # test rather than two.
            "eval_status": r[15] or "", "overall": r[16], "safety": r[17],
            "user_id": r[18], "owner": r[19],
        }
        for r in rows
    ]


def delete_run(conn, run_id: str, owner: int | None = None) -> bool:
    where, args = auth_owned(owner)
    removed = conn.execute(
        f"DELETE FROM ask_runs WHERE id = %s{where} RETURNING id", (run_id, *args)).fetchall()
    conn.commit()
    return bool(removed)


def clear(conn, owner: int | None = None) -> int:
    """Delete every question, or only `owner`'s."""
    where, args = auth_owned(owner)
    removed = conn.execute(f"DELETE FROM ask_runs WHERE true{where} RETURNING id",
                           args).fetchall()
    conn.commit()
    return len(removed)


def stats(conn=None) -> dict[str, Any]:
    conn = conn or connect()
    create_schema(conn)
    runs, answered = conn.execute(
        "SELECT count(*), count(*) FILTER (WHERE status = 'done') FROM ask_runs"
    ).fetchone()
    scored, low, unsafe, mean = conn.execute(
        """SELECT count(*) FILTER (WHERE status = 'done'),
                  count(*) FILTER (WHERE status = 'done' AND overall < %s),
                  count(*) FILTER (WHERE status = 'done' AND safety < 1),
                  avg(overall) FILTER (WHERE status = 'done')
           FROM ask_evaluations""",
        (LOW_QUALITY,),
    ).fetchone()
    return {"runs": runs, "answered": answered, "retention": RETENTION,
            "database": rag.database_name(database_url()),
            "scored": scored, "low_quality": low, "unsafe": unsafe,
            "mean_overall": round(float(mean), 4) if mean is not None else None,
            "low_quality_below": LOW_QUALITY}
