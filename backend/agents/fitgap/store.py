"""Postgres persistence for runs, entries and reviews (handover §5, §10).

Reviews sit alongside entries and never overwrite them: the register has to
keep showing what InsightLens proposed next to what the human decided, or the
next evaluation has nothing to measure.

These tables are not per-category -- a run reads every category it is pointed
at and records one result -- so they carry no category column. They live in the
main database beside the corpus they were written from; they had a database of
their own while each category did, and came back with them.
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any


from backend.auth.store import owned as auth_owned  # noqa: E402
from backend.rag import rag  # noqa: E402

from .schemas import FitGapEntry, Review, VerifiedEntry  # noqa: E402


def database_url() -> str:
    """Where the runs, entries and reviews live: the main database, beside the
    corpus they were written from."""
    return rag.base_url()


def connect():
    """A connection to the database holding the tables below.

    It is the same database the corpus is in, and the same connection
    rag.search uses; `schema=False` only says that this caller does not need
    the corpus schema checked on its account.

    The connection is shared and cached per thread, so callers must not close
    it; rag.close() releases a thread's connection when it is done."""
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
            CREATE TABLE IF NOT EXISTS fitgap_runs (
                id            text PRIMARY KEY,
                mode          text NOT NULL,
                scope_bpml    text NOT NULL,
                scope_label   text NOT NULL DEFAULT '',
                question      text NOT NULL DEFAULT '',
                country       jsonb,
                model         text NOT NULL DEFAULT '',
                prompt_hash   text NOT NULL DEFAULT '',
                params        jsonb NOT NULL DEFAULT '{}'::jsonb,
                holdout       boolean NOT NULL DEFAULT false,
                corpus_fingerprint text NOT NULL DEFAULT '',
                started_at    timestamptz NOT NULL DEFAULT now(),
                finished_at   timestamptz,
                status        text NOT NULL DEFAULT 'running',
                input_tokens  int NOT NULL DEFAULT 0,
                output_tokens int NOT NULL DEFAULT 0,
                synthesis     jsonb
            )"""
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fitgap_entries (
                id             bigserial PRIMARY KEY,
                run_id         text NOT NULL REFERENCES fitgap_runs(id) ON DELETE CASCADE,
                bpml_code      text NOT NULL,
                step_name      text NOT NULL DEFAULT '',
                classification text NOT NULL,
                confidence     real NOT NULL DEFAULT 0,
                materiality    text NOT NULL DEFAULT 'low',
                status         text NOT NULL DEFAULT 'proposed',
                evidence_valid boolean NOT NULL DEFAULT true,
                entry          jsonb NOT NULL,
                issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
                tool_calls     int NOT NULL DEFAULT 0,
                seconds        real NOT NULL DEFAULT 0,
                created_at     timestamptz NOT NULL DEFAULT now(),
                UNIQUE (run_id, bpml_code)
            )"""
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fitgap_reviews (
                id         bigserial PRIMARY KEY,
                entry_id   bigint NOT NULL REFERENCES fitgap_entries(id) ON DELETE CASCADE,
                reviewer   text NOT NULL,
                verdict    text NOT NULL,
                corrected_classification text,
                comment    text NOT NULL DEFAULT '',
                created_at timestamptz NOT NULL DEFAULT now()
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS fitgap_entries_run_idx ON fitgap_entries (run_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS fitgap_reviews_entry_idx ON fitgap_reviews (entry_id)")
        # Added with ALTER so a register built before categories existed keeps
        # its runs; they were unscoped, which is what the default says.
        conn.execute(
            "ALTER TABLE fitgap_runs ADD COLUMN IF NOT EXISTS categories jsonb NOT NULL DEFAULT '[]'::jsonb"
        )
        # What the analyst attached to the session, if anything: the session id
        # and the document names. Recorded because the attachment changes what
        # the run could read, and a register entry that cites an upload is only
        # reproducible if the run says which one -- the upload itself is gone
        # within hours, so the names are the whole record.
        conn.execute(
            "ALTER TABLE fitgap_runs ADD COLUMN IF NOT EXISTS uploads jsonb NOT NULL DEFAULT '{}'::jsonb"
        )
        # Who ran it, and who reviewed. Rows from before accounts belong to
        # `legacy`; a review's free-text reviewer name stays as it was typed.
        auth_store.own_table(conn, "fitgap_runs")
        auth_store.own_table(conn, "fitgap_reviews", "created_at")


def corpus_fingerprint(conn=None, categories: list[str] | None = None) -> str:
    """The hash of the material a run could read, so it can be reproduced
    against exactly that material (§10).

    It covers what the run was allowed to reach -- not the whole corpus when the
    run was scoped to part of it, or the fingerprint would claim the run saw
    documents it could never retrieve. `conn` is ignored; it remains in the
    signature for callers that still pass one.

    It hashes (source, fingerprint) and never a row id, which is why the
    consolidation that renumbered the chunks did not move it."""
    import hashlib

    codes = [rag.check_category(c) for c in (categories or []) if c]
    conn_ = rag.connection()
    if codes:
        rows = conn_.execute(
            "SELECT source, fingerprint FROM rag_documents WHERE category = ANY(%s)", (codes,)
        ).fetchall()
    else:
        rows = conn_.execute("SELECT source, fingerprint FROM rag_documents").fetchall()
    h = hashlib.sha256()
    for _, fingerprint in sorted(rows):
        h.update(fingerprint.encode())
    return h.hexdigest()[:16]


def start_run(conn, run: dict) -> None:
    conn.execute(
        """INSERT INTO fitgap_runs
           (id, mode, scope_bpml, scope_label, question, country, model, prompt_hash,
            params, holdout, corpus_fingerprint, categories, uploads, user_id)
           VALUES (%(id)s, %(mode)s, %(scope_bpml)s, %(scope_label)s, %(question)s, %(country)s,
                   %(model)s, %(prompt_hash)s, %(params)s, %(holdout)s, %(corpus_fingerprint)s,
                   %(categories)s, %(uploads)s, %(user_id)s)
           ON CONFLICT (id) DO NOTHING""",
        {**run,
         "country": json.dumps(run.get("country")) if run.get("country") else None,
         "params": json.dumps(run.get("params", {})),
         "categories": json.dumps(run.get("categories") or []),
         "uploads": json.dumps(run.get("uploads") or {}),
         "user_id": run.get("user_id")},
    )
    conn.commit()


def save_entry(conn, run_id: str, result: VerifiedEntry) -> int:
    e = result.entry
    row = conn.execute(
        """INSERT INTO fitgap_entries
           (run_id, bpml_code, step_name, classification, confidence, materiality, status,
            evidence_valid, entry, issues, tool_calls, seconds)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (run_id, bpml_code) DO UPDATE SET
             classification = EXCLUDED.classification, confidence = EXCLUDED.confidence,
             materiality = EXCLUDED.materiality, entry = EXCLUDED.entry,
             issues = EXCLUDED.issues, evidence_valid = EXCLUDED.evidence_valid
           RETURNING id""",
        (run_id, e.bpml_code, e.step_name, e.classification, e.confidence, e.materiality,
         e.status, result.evidence_valid, json.dumps(e.model_dump()),
         json.dumps([i.model_dump() for i in result.issues]), result.tool_calls, result.seconds),
    ).fetchone()
    conn.commit()
    return int(row[0])


def finish_run(conn, run_id: str, synthesis: dict, tokens: tuple[int, int], status: str = "done") -> None:
    conn.execute(
        """UPDATE fitgap_runs SET finished_at = now(), status = %s, synthesis = %s,
           input_tokens = %s, output_tokens = %s WHERE id = %s""",
        (status, json.dumps(synthesis), tokens[0], tokens[1], run_id),
    )
    conn.commit()


def list_runs(conn, limit: int = 40, owner: int | None = None) -> list[dict]:
    where, args = auth_owned(owner, "r")
    rows = conn.execute(
        """SELECT r.id, r.mode, r.scope_bpml, r.scope_label, r.question, r.holdout, r.status,
                  r.started_at, r.finished_at, r.model,
                  (SELECT count(*) FROM fitgap_entries e WHERE e.run_id = r.id) AS entries,
                  r.synthesis, r.categories, r.uploads, r.user_id, u.username
           FROM fitgap_runs r LEFT JOIN users u ON u.id = r.user_id
           WHERE true""" + where + """
           ORDER BY r.started_at DESC LIMIT %s""",
        (*args, limit),
    ).fetchall()
    out = []
    for r in rows:
        synth = r[11] or {}
        # A run whose SSE stream was dropped (the browser closed, the tab was
        # abandoned) never reaches finish_run and would sit at "running" for
        # ever. Report it as abandoned rather than mutating the row, which
        # would lose the fact that it was interrupted rather than finished.
        status = r[6]
        if status == "running" and r[7] and _stale(r[7]):
            status = "abandoned"
        out.append({
            "id": r[0], "mode": r[1], "scope_bpml": r[2], "scope_label": r[3], "question": r[4],
            "holdout": r[5], "status": status, "categories": r[12] or [],
            "uploads": r[13] or {},
            "started_at": r[7].isoformat() if r[7] else None,
            "finished_at": r[8].isoformat() if r[8] else None,
            "model": r[9], "entries": r[10],
            "reuse_pct": (synth.get("reuse") or {}).get("reuse_pct"),
            "coverage_pct": (synth.get("reuse") or {}).get("coverage_pct"),
            "user_id": r[14], "owner": r[15],
        })
    return out


STALE_AFTER_MINUTES = 30


def _stale(started_at) -> bool:
    from datetime import datetime, timedelta, timezone

    return datetime.now(timezone.utc) - started_at > timedelta(minutes=STALE_AFTER_MINUTES)


def get_run(conn, run_id: str, owner: int | None = None) -> dict | None:
    """The run, or None if it does not exist or is not `owner`'s (None: any)."""
    where, args = auth_owned(owner)
    r = conn.execute(
        """SELECT id, mode, scope_bpml, scope_label, question, country, model, prompt_hash,
                  params, holdout, corpus_fingerprint, started_at, finished_at, status,
                  input_tokens, output_tokens, synthesis, categories, uploads, user_id
           FROM fitgap_runs WHERE id = %s""" + where,
        (run_id, *args),
    ).fetchone()
    if not r:
        return None
    run = {
        "id": r[0], "mode": r[1], "scope_bpml": r[2], "scope_label": r[3], "question": r[4],
        "country": r[5], "model": r[6], "prompt_hash": r[7], "params": r[8], "holdout": r[9],
        "corpus_fingerprint": r[10], "categories": r[17] or [], "uploads": r[18] or {},
        "started_at": r[11].isoformat() if r[11] else None,
        "finished_at": r[12].isoformat() if r[12] else None,
        "status": r[13], "input_tokens": r[14], "output_tokens": r[15],
        "synthesis": r[16] or {},
        "user_id": r[19],
    }
    run["entries"] = get_entries(conn, run_id)
    return run


def get_entries(conn, run_id: str) -> list[dict]:
    rows = conn.execute(
        """SELECT e.id, e.entry, e.issues, e.evidence_valid, e.tool_calls, e.seconds,
                  COALESCE(json_agg(json_build_object(
                      'id', v.id, 'reviewer', v.reviewer, 'verdict', v.verdict,
                      'corrected_classification', v.corrected_classification,
                      'comment', v.comment, 'created_at', v.created_at
                  ) ORDER BY v.created_at) FILTER (WHERE v.id IS NOT NULL), '[]')
           FROM fitgap_entries e
           LEFT JOIN fitgap_reviews v ON v.entry_id = e.id
           WHERE e.run_id = %s
           GROUP BY e.id ORDER BY e.bpml_code""",
        (run_id,),
    ).fetchall()
    out = []
    for r in rows:
        out.append({"id": r[0], **r[1], "issues": r[2], "evidence_valid": r[3],
                    "tool_calls": r[4], "seconds": r[5], "reviews": r[6]})
    out.sort(key=lambda e: tuple(int(x) if x.isdigit() else 0 for x in e["bpml_code"].split(".")))
    return out


def entry_owner(conn, entry_id: int) -> tuple[str, int | None] | None:
    """(run id, run owner) for an entry, or None if there is no such entry."""
    r = conn.execute(
        "SELECT e.run_id, r.user_id FROM fitgap_entries e JOIN fitgap_runs r ON r.id = e.run_id"
        " WHERE e.id = %s", (entry_id,)).fetchone()
    return (r[0], r[1]) if r else None


def add_review(conn, entry_id: int, review: Review, user_id: int | None = None) -> dict:
    row = conn.execute(
        """INSERT INTO fitgap_reviews
           (entry_id, reviewer, verdict, corrected_classification, comment, user_id)
           VALUES (%s,%s,%s,%s,%s,%s) RETURNING id, created_at""",
        (entry_id, review.reviewer, review.verdict, review.corrected_classification,
         review.comment, user_id),
    ).fetchone()
    conn.commit()
    return {"id": int(row[0]), "created_at": row[1].isoformat(), **review.model_dump()}


def entry_json(row: dict) -> FitGapEntry:
    return FitGapEntry(**{k: v for k, v in row.items()
                          if k in FitGapEntry.model_fields})


def to_results(entries: list[dict]) -> list[VerifiedEntry]:
    """Rehydrate stored rows into what synthesis.py expects."""
    from .schemas import VerifyIssue

    out = []
    for row in entries:
        out.append(VerifiedEntry(
            entry=entry_json(row),
            issues=[VerifyIssue(**i) for i in (row.get("issues") or [])],
            tool_calls=row.get("tool_calls", 0), seconds=row.get("seconds", 0.0),
        ))
    return out


def stats(conn) -> dict[str, Any]:
    runs = conn.execute("SELECT count(*) FROM fitgap_runs").fetchone()[0]
    entries = conn.execute("SELECT count(*) FROM fitgap_entries").fetchone()[0]
    reviews = conn.execute("SELECT count(*) FROM fitgap_reviews").fetchone()[0]
    return {"runs": runs, "entries": entries, "reviews": reviews}
