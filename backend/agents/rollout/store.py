"""Postgres persistence for Fit-Gap Copilot runs.

These tables are not per-category, for the same reason the Fit/Gap register's
are not -- a run reads every category it is pointed at and records one result --
so they carry no category column and sit in the main database beside the corpus
they were written from.

What a run could see is part of reproducing it, so the record keeps the corpus
fingerprint, the categories, the prompt hash and the names of the attached
documents. The attachments themselves are swept within hours; the names are
all a reopened analysis can honestly show.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import uuid
from pathlib import Path
from typing import Any


from backend.auth.store import owned as auth_owned  # noqa: E402
from backend.rag import rag  # noqa: E402
from backend.agents.guardrails.contact import redact, redact_obj as _clean  # noqa: E402
from backend.agents.rollout import decisions  # noqa: E402

# Every write below goes through `_clean`: no e-mail address or phone number
# is stored, whatever the attached documents contained. The HTTP boundary
# redacts too, but that only governs what leaves the server -- this governs
# what the database holds, as the Evidence Agent already does for its runs.
# Writing is after the quality gates, which check each quote against the
# text as written, so masking here cannot fail a quote.

def database_url() -> str:
    """Where the runs and decisions live: the main database, beside the corpus
    they were written from."""
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
            CREATE TABLE IF NOT EXISTS rollout_runs (
                id            text PRIMARY KEY,
                subject       text NOT NULL DEFAULT 'country_as_is',
                scope_bpml    text NOT NULL,
                scope_label   text NOT NULL DEFAULT '',
                country       text NOT NULL DEFAULT '',
                country_context text NOT NULL DEFAULT '',
                sap_release   text NOT NULL DEFAULT '',
                gt_version    text NOT NULL DEFAULT '',
                question      text NOT NULL DEFAULT '',
                model         text NOT NULL DEFAULT '',
                prompt_hash   text NOT NULL DEFAULT '',
                categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
                uploads       jsonb NOT NULL DEFAULT '{}'::jsonb,
                corpus_fingerprint text NOT NULL DEFAULT '',
                started_at    timestamptz NOT NULL DEFAULT now(),
                finished_at   timestamptz,
                status        text NOT NULL DEFAULT 'running',
                input_tokens  int NOT NULL DEFAULT 0,
                output_tokens int NOT NULL DEFAULT 0,
                asis          jsonb,
                analysis      jsonb,
                scores        jsonb,
                gates         jsonb,
                sources       jsonb NOT NULL DEFAULT '{}'::jsonb
            )"""
        )
        # CREATE TABLE IF NOT EXISTS does not add a column to a table that
        # already exists, so a database created before runs had a subject
        # needs this. The default is what every one of those runs was.
        conn.execute("ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS"
                     " subject text NOT NULL DEFAULT 'country_as_is'")
        # What the analysis was built from. Added late, so existing runs have
        # no record and the page shows the traceability as unavailable for
        # them rather than as empty.
        conn.execute("ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS"
                     " sources jsonb NOT NULL DEFAULT '{}'::jsonb")
        # The investigation log, with the evidence each call returned. Rollout
        # kept none of this: the log streamed to the browser and was gone on
        # reload, so a reopened run showed its conclusions with no working at
        # all. Runs recorded before this column have an empty list, and the
        # page says so rather than showing an empty log.
        conn.execute("ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS"
                     " calls jsonb NOT NULL DEFAULT '[]'::jsonb")
        # The rest of the investigation: the context each pass was handed, the
        # agent's reasoning between calls, rejected submissions, the gates.
        # Runs recorded before it have an empty list.
        conn.execute("ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS"
                     " log jsonb NOT NULL DEFAULT '[]'::jsonb")
        # The run's own quality scores (agent_eval.py), as the Evaluation tab
        # shows them. Runs recorded before it have an empty object.
        conn.execute("ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS"
                     " evaluation jsonb NOT NULL DEFAULT '{}'::jsonb")
        # The Markdown of each attached document, as the agent read it, keyed by
        # the file name its chunks carry. Attachments themselves are swept after
        # FITGAP_UPLOAD_TTL_HOURS, so without this a citation from one could not
        # be opened a day later. Runs recorded before it have an empty object.
        conn.execute("ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS"
                     " attachments jsonb NOT NULL DEFAULT '{}'::jsonb")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rollout_decisions (
                id         bigserial PRIMARY KEY,
                run_id     text NOT NULL REFERENCES rollout_runs(id) ON DELETE CASCADE,
                gap_id     text NOT NULL,
                reviewer   text NOT NULL,
                verdict    text NOT NULL,
                disposition text NOT NULL DEFAULT '',
                comment    text NOT NULL DEFAULT '',
                decided_at timestamptz NOT NULL DEFAULT now()
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS rollout_decisions_run_idx"
                     " ON rollout_decisions (run_id)")
        # rollout_decisions above is the old log: no longer written, kept so
        # nothing already recorded is lost, and copied into workshop_decisions
        # by _backfill. Its ON DELETE CASCADE was right for a run's working
        # notes and wrong for what an organization agreed, which is why the
        # tables below use SET NULL and copy the context onto every row.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_sessions (
                id          text PRIMARY KEY,
                run_id      text REFERENCES rollout_runs(id) ON DELETE SET NULL,
                source_run  text NOT NULL DEFAULT '',
                facilitator text NOT NULL,
                attendees   jsonb NOT NULL DEFAULT '[]'::jsonb,
                country     text NOT NULL DEFAULT '',
                scope_bpml  text NOT NULL DEFAULT '',
                scope_label text NOT NULL DEFAULT '',
                started_at  timestamptz NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_decisions (
                id          bigserial PRIMARY KEY,
                -- Null once the run is deleted; source_run keeps its id.
                run_id      text REFERENCES rollout_runs(id) ON DELETE SET NULL,
                source_run  text NOT NULL,
                session_id  text REFERENCES workshop_sessions(id) ON DELETE SET NULL,
                gap_id      text NOT NULL,

                -- What was decided about, as the run described it at the time.
                subject     text NOT NULL DEFAULT '',
                country     text NOT NULL DEFAULT '',
                scope_bpml  text NOT NULL DEFAULT '',
                scope_label text NOT NULL DEFAULT '',
                template_process text NOT NULL DEFAULT '',
                sap_release text NOT NULL DEFAULT '',
                gt_version  text NOT NULL DEFAULT '',
                model       text NOT NULL DEFAULT '',
                prompt_hash text NOT NULL DEFAULT '',
                as_is_step_id text NOT NULL DEFAULT '',
                gt_step_ref text NOT NULL DEFAULT '',
                primary_type text NOT NULL DEFAULT '',
                dimension   text NOT NULL DEFAULT '',
                materiality text NOT NULL DEFAULT '',
                localization_state text NOT NULL DEFAULT '',
                candidate_disposition text NOT NULL DEFAULT '',
                workshop_bucket text NOT NULL DEFAULT '',
                exact_difference text NOT NULL DEFAULT '',
                as_is_statement text NOT NULL DEFAULT '',
                gt_statement text NOT NULL DEFAULT '',
                sap_bp_reference text NOT NULL DEFAULT '',
                question    text NOT NULL DEFAULT '',
                options     jsonb NOT NULL DEFAULT '[]'::jsonb,
                decision_owner jsonb NOT NULL DEFAULT '[]'::jsonb,
                evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,

                -- What the workshop decided.
                verdict     text NOT NULL CHECK (verdict IN ('accept', 'reject', 'defer')),
                option_index int,
                option_text text NOT NULL DEFAULT '',
                rationale   text NOT NULL DEFAULT '',
                disposition text NOT NULL DEFAULT '',
                decided_by  text NOT NULL,
                decided_at  timestamptz NOT NULL DEFAULT now(),

                -- Append-only: a changed mind is a new row that points at the
                -- one it replaces, never an update of the verdict.
                supersedes  bigint REFERENCES workshop_decisions(id),
                is_current  boolean NOT NULL DEFAULT true,
                legacy_id   bigint UNIQUE
            )"""
        )
        # Set when facilitator mode submits the sitting's answers in one go.
        conn.execute("ALTER TABLE workshop_sessions ADD COLUMN IF NOT EXISTS submitted_at timestamptz")
        conn.execute("CREATE INDEX IF NOT EXISTS workshop_decisions_run_idx"
                     " ON workshop_decisions (source_run, gap_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS workshop_decisions_memory_idx"
                     " ON workshop_decisions (country, scope_bpml, primary_type) WHERE is_current")
        # Who ran it, who facilitated, who decided. Rows from before accounts
        # belong to `legacy`; the typed names stay as they were. Before the
        # backfill, which reads runs through _COLUMNS.
        auth_store.own_table(conn, "rollout_runs")
        auth_store.own_table(conn, "workshop_sessions")
        auth_store.own_table(conn, "workshop_decisions", "decided_at")
        _backfill(conn)


def start_run(conn, run: dict) -> None:
    conn.execute(
        """INSERT INTO rollout_runs
           (id, subject, scope_bpml, scope_label, country, country_context, sap_release,
            gt_version, question, model, prompt_hash, categories, uploads, corpus_fingerprint,
            user_id)
           VALUES (%(id)s, %(subject)s, %(scope_bpml)s, %(scope_label)s, %(country)s,
                   %(country_context)s, %(sap_release)s, %(gt_version)s, %(question)s,
                   %(model)s, %(prompt_hash)s,
                   %(categories)s, %(uploads)s, %(corpus_fingerprint)s, %(user_id)s)
           ON CONFLICT (id) DO NOTHING""",
        {"subject": "country_as_is", **_clean(run), "user_id": run.get("user_id"),
         "categories": json.dumps(run.get("categories") or []),
         "uploads": json.dumps(_clean(run.get("uploads") or {}))},
    )
    conn.commit()


def save_asis(conn, run_id: str, asis: dict) -> None:
    conn.execute("UPDATE rollout_runs SET asis = %s WHERE id = %s", (json.dumps(_clean(asis)), run_id))
    conn.commit()


def save_calls(conn, run_id: str, calls: list[dict]) -> None:
    """The log so far, rewritten in full after each call.

    Whole-list rather than append-one for the reason the Evidence Agent's is:
    a dropped connection should still leave the row holding everything that
    happened up to the drop."""
    conn.execute("UPDATE rollout_runs SET calls = %s WHERE id = %s",
                 (json.dumps(_clean(calls), default=str), run_id))
    conn.commit()


def save_log(conn, run_id: str, log: list[dict]) -> None:
    """The investigation log so far, rewritten in full, like `save_calls`."""
    conn.execute("UPDATE rollout_runs SET log = %s WHERE id = %s",
                 (json.dumps(_clean(log), default=str), run_id))
    conn.commit()


def _short_label(matched: str) -> str:
    """Condense the agent's template-process statement into a row label.

    `template_process` is a paragraph: the process, its ancestry, the dash
    codes either side of it and what the match rests on. That belongs in the
    export, where there is room for it -- but `scope_label` is what the run
    history menu puts on one line, so pasting the first 200 characters of a
    paragraph there turns every unscoped run into a wall of text.

    The cut is at the first bracket, which is where these statements reliably
    stop naming the process and start qualifying it. A statement that opens
    with a bracket, or has none, falls back to a word-boundary trim."""
    text = re.sub(r"[*`]", "", (matched or "").strip())
    head = text.split("(")[0].strip(" ,;:-")
    if len(head) < 12:
        head = text
    if len(head) > 90:
        head = head[:90].rsplit(" ", 1)[0] + "\u2026"
    return head


def finish_run(conn, run_id: str, analysis: dict, scores: dict, gates: dict,
               tokens: tuple[int, int], status: str = "done",
               sources: dict | None = None) -> None:
    """Store the result, and label a run that named no Global Template process
    with the one the agent matched.

    COALESCE on the empty string rather than an unconditional write: a run that
    named a process keeps the analyst's label, and only a run that did not
    borrows the agent's. Either way the row says what was compared against,
    which is what makes an unscoped run auditable at all."""
    analysis, scores, gates, sources = (_clean(analysis), _clean(scores), _clean(gates),
                                        _clean(sources or {}))
    matched = _short_label(analysis.get("template_process") or "")
    conn.execute(
        """UPDATE rollout_runs SET analysis = %s, scores = %s, gates = %s, status = %s,
                  finished_at = now(), input_tokens = %s, output_tokens = %s,
                  sources = %s,
                  scope_label = CASE WHEN scope_label = '' THEN %s ELSE scope_label END
           WHERE id = %s""",
        (json.dumps(analysis), json.dumps(scores), json.dumps(gates), status,
         tokens[0], tokens[1], json.dumps(sources or {}), matched, run_id),
    )
    conn.commit()


def fail_run(conn, run_id: str, message: str) -> None:
    conn.execute(
        "UPDATE rollout_runs SET status = 'failed', finished_at = now(),"
        " gates = %s WHERE id = %s",
        (json.dumps({"error": redact(message)}), run_id),
    )
    conn.commit()


_COLUMNS = ("id, subject, scope_bpml, scope_label, country, country_context,"
            " sap_release, gt_version,"
            " question, model, prompt_hash, categories, uploads, corpus_fingerprint,"
            " started_at, finished_at, status, input_tokens, output_tokens,"
            " asis, analysis, scores, gates, sources, calls, log, evaluation, user_id")


# A run whose SSE stream was dropped -- the browser closed, the tab was
# abandoned -- never reaches finish_run and would sit at "running" for ever.
# Reported as abandoned rather than mutated, so the row keeps the fact that it
# was interrupted rather than finished.
STALE_AFTER_MINUTES = 30


def _stale(started_at) -> bool:
    from datetime import datetime, timedelta, timezone

    return datetime.now(timezone.utc) - started_at > timedelta(minutes=STALE_AFTER_MINUTES)


def _status(status: str, started_at) -> str:
    if status == "running" and started_at and _stale(started_at):
        return "abandoned"
    return status


def _row(r) -> dict:
    return {
        "id": r[0], "subject": r[1], "scope_bpml": r[2], "scope_label": r[3], "country": r[4],
        "country_context": r[5], "sap_release": r[6], "gt_version": r[7], "question": r[8],
        "model": r[9], "prompt_hash": r[10], "categories": r[11] or [], "uploads": r[12] or {},
        "corpus_fingerprint": r[13],
        "started_at": r[14].isoformat() if r[14] else None,
        "finished_at": r[15].isoformat() if r[15] else None,
        "status": _status(r[16], r[14]), "input_tokens": r[17], "output_tokens": r[18],
        "asis": r[19] or {}, "analysis": r[20] or {}, "scores": r[21] or {}, "gates": r[22] or {},
        "sources": r[23] or {},
        "calls": r[24] or [],
        "log": r[25] or [],
        "evaluation": r[26] or {},
        "user_id": r[27],
    }


def save_evaluation(conn, run_id: str, evaluation: dict) -> None:
    conn.execute("UPDATE rollout_runs SET evaluation = %s WHERE id = %s",
                 (json.dumps(evaluation, default=str), run_id))
    conn.commit()


def save_attachments(conn, run_id: str, attachments: dict[str, dict]) -> None:
    """Keep each attached document's Markdown with the run:
    {md file name: {"name": original file name, "markdown": text}}."""
    conn.execute("UPDATE rollout_runs SET attachments = attachments || %s::jsonb WHERE id = %s",
                 (json.dumps(attachments), run_id))
    conn.commit()


def get_attachment(conn, run_id: str, file: str,
                   owner: int | None = None) -> tuple[dict | None, dict] | None:
    """(the kept copy of one attachment or None, the run's upload record), or
    None when there is no such run. The upload record names the session, so a
    run made within the last few hours can still be served from it."""
    where, args = auth_owned(owner)
    r = conn.execute("SELECT attachments -> %s, uploads FROM rollout_runs WHERE id = %s" + where,
                     (file, run_id, *args)).fetchone()
    if not r:
        return None
    return r[0], r[1] or {}


def get_run(conn, run_id: str, decisions_too: bool = True,
            owner: int | None = None) -> dict | None:
    """The run, or None if it does not exist or is not `owner`'s (None: any)."""
    where, args = auth_owned(owner)
    r = conn.execute(f"SELECT {_COLUMNS} FROM rollout_runs WHERE id = %s{where}",
                     (run_id, *args)).fetchone()
    if not r:
        return None
    run = _row(r)
    if decisions_too:
        run["decisions"] = get_decisions(conn, run_id)
        run["sessions"] = get_sessions(conn, run_id)
    return run


def list_runs(conn, limit: int = 40, owner: int | None = None) -> list[dict]:
    where, args = auth_owned(owner, "r")
    rows = conn.execute(
        """SELECT r.id, r.scope_bpml, r.scope_label, r.country, r.status, r.started_at,
                  r.finished_at, r.model, r.categories, r.uploads, r.scores, r.subject,
                  r.user_id, u.username
           FROM rollout_runs r LEFT JOIN users u ON u.id = r.user_id
           WHERE true""" + where + """
           ORDER BY r.started_at DESC LIMIT %s""",
        (*args, limit),
    ).fetchall()
    out = []
    for r in rows:
        scores = r[10] or {}
        out.append({
            "id": r[0], "scope_bpml": r[1], "scope_label": r[2], "country": r[3],
            "status": _status(r[4], r[5]),
            "started_at": r[5].isoformat() if r[5] else None,
            "finished_at": r[6].isoformat() if r[6] else None,
            "model": r[7], "categories": r[8] or [], "uploads": r[9] or {},
            "subject": r[11],
            "gt_alignment": scores.get("gt_alignment"),
            "harmonization_potential": scores.get("harmonization_potential"),
            "deviations": (scores.get("counts") or {}).get("deviations", 0),
            "must_discuss": ((scores.get("counts") or {}).get("workshop") or {}).get("MUST_DISCUSS", 0),
            "user_id": r[12], "owner": r[13],
        })
    return out


_DECISION_COLUMNS = (
    "id, run_id, source_run, session_id, gap_id, verdict, option_index, option_text, rationale,"
    " disposition, decided_by, decided_at, supersedes, is_current, question, options,"
    " decision_owner, country, scope_bpml, scope_label, template_process, primary_type,"
    " materiality, localization_state, exact_difference, as_is_step_id, legacy_id")


def _decision(r) -> dict:
    (id_, run_id, source_run, session_id, gap_id, verdict, option_index, option_text, rationale,
     disposition, decided_by, decided_at, supersedes, is_current, question, options, owner,
     country, scope_bpml, scope_label, template_process, primary_type, materiality,
     localization_state, exact_difference, as_is_step_id, legacy_id) = r
    label = decisions.option_label(option_index, option_text)
    return {
        "id": id_, "run_id": run_id, "source_run": source_run, "session_id": session_id,
        "gap_id": gap_id, "verdict": verdict,
        "option_index": option_index, "option_text": option_text, "rationale": rationale,
        "disposition": disposition,
        # The names the page and the exports have always read.
        "reviewer": decided_by,
        "comment": " — ".join(x for x in (label, rationale) if x),
        "decided_at": decided_at.isoformat() if decided_at else None,
        "supersedes": supersedes, "is_current": is_current, "legacy": legacy_id is not None,
        "question": question, "options": options or [], "decision_owner": owner or [],
        "country": country, "scope_bpml": scope_bpml, "scope_label": scope_label,
        "template_process": template_process, "primary_type": primary_type,
        "materiality": materiality, "localization_state": localization_state,
        "exact_difference": exact_difference, "as_is_step_id": as_is_step_id,
    }


def _insert_decision(conn, run_id: str | None, source_run: str, gap_id: str, ctx: dict, *,
                     verdict: str, option_index: int | None, option_text: str, rationale: str,
                     disposition: str, decided_by: str, session_id: str | None = None,
                     decided_at=None, legacy_id: int | None = None,
                     user_id: int | None = None) -> int:
    """One row, marking the verdict it replaces as no longer current."""
    prev = conn.execute(
        "UPDATE workshop_decisions SET is_current = false"
        " WHERE source_run = %s AND gap_id = %s AND is_current RETURNING id",
        (source_run, gap_id)).fetchone()
    cols = (["run_id", "source_run", "session_id", "gap_id", *decisions.RUN_FIELDS, "template_process",
             *decisions.DEVIATION_FIELDS, "question", "options", "decision_owner", "evidence",
             "verdict", "option_index", "option_text", "rationale", "disposition", "decided_by",
             "supersedes", "legacy_id", "user_id"])
    vals = [run_id, source_run, session_id, gap_id,
            *[ctx[k] for k in decisions.RUN_FIELDS], ctx["template_process"],
            *[ctx[k] for k in decisions.DEVIATION_FIELDS],
            ctx["question"], json.dumps(ctx["options"]), json.dumps(ctx["decision_owner"]),
            json.dumps(ctx["evidence"]),
            verdict, option_index, option_text, redact(rationale), disposition, decided_by,
            prev[0] if prev else None, legacy_id, user_id]
    if decided_at is not None:
        cols.append("decided_at"); vals.append(decided_at)
    row = conn.execute(
        f"INSERT INTO workshop_decisions ({', '.join(cols)})"
        f" VALUES ({', '.join(['%s'] * len(vals))}) RETURNING id", vals).fetchone()
    return row[0]


def save_decision(conn, run_id: str, gap_id: str, reviewer: str, verdict: str,
                  disposition: str = "", comment: str = "", *, option_index: int | None = None,
                  rationale: str = "", session_id: str | None = None,
                  user_id: int | None = None) -> dict:
    """Record one verdict, with the context it was made in copied beside it.

    `comment` is the old free-text field. A comment in the "Option B: ..."
    form the page used to send is split into the option and the rationale,
    so a caller that has not moved to `option_index` still records one."""
    run = get_run(conn, run_id, decisions_too=False)
    ctx = _clean(decisions.snapshot(run, gap_id))
    if option_index is None and comment:
        option_index, _, legacy_rationale = decisions.from_legacy_comment(comment, ctx["options"])
        rationale = rationale or legacy_rationale
    text = decisions.option_text(ctx["options"], option_index)
    with conn.transaction():
        new_id = _insert_decision(
            conn, run_id, run_id, gap_id, ctx, verdict=verdict, option_index=option_index,
            option_text=text, rationale=rationale.strip(), disposition=disposition,
            decided_by=reviewer, session_id=session_id, user_id=user_id)
    conn.commit()
    return get_decision(conn, new_id)


def get_decision(conn, decision_id: int) -> dict | None:
    r = conn.execute(f"SELECT {_DECISION_COLUMNS} FROM workshop_decisions WHERE id = %s",
                     (decision_id,)).fetchone()
    return _decision(r) if r else None


def _backfill(conn) -> int:
    """Copy decisions from the old log that have not been copied yet.

    Run from create_schema, so it happens once per database and then finds
    nothing. The context comes from the run as it stands, which is why this
    has to happen while those runs still exist."""
    rows = conn.execute(
        """SELECT d.id, d.run_id, d.gap_id, d.reviewer, d.verdict, d.disposition, d.comment, d.decided_at
           FROM rollout_decisions d
           WHERE NOT EXISTS (SELECT 1 FROM workshop_decisions w WHERE w.legacy_id = d.id)
           ORDER BY d.decided_at, d.id""").fetchall()
    runs: dict[str, dict | None] = {}
    for legacy_id, run_id, gap_id, reviewer, verdict, disposition, comment, decided_at in rows:
        if run_id not in runs:
            runs[run_id] = get_run(conn, run_id, decisions_too=False)
        ctx = _clean(decisions.snapshot(runs[run_id], gap_id))
        index, text, rationale = decisions.from_legacy_comment(comment, ctx["options"])
        _insert_decision(conn, run_id, run_id, gap_id, ctx, verdict=verdict, option_index=index,
                         option_text=text, rationale=rationale, disposition=disposition,
                         decided_by=reviewer, decided_at=decided_at, legacy_id=legacy_id)
    return len(rows)


def get_sessions(conn, run_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, facilitator, attendees, started_at, submitted_at FROM workshop_sessions"
        " WHERE source_run = %s ORDER BY started_at", (run_id,)).fetchall()
    return [{"id": r[0], "facilitator": r[1], "attendees": r[2] or [],
             "started_at": r[3].isoformat() if r[3] else None,
             "submitted_at": r[4].isoformat() if r[4] else None} for r in rows]


def submit_workshop(conn, run_id: str, facilitator: str, attendees: list[str],
                    answers: list[dict], user_id: int | None = None) -> dict:
    """Facilitator mode's Submit: the whole sitting in one transaction.

    Every answer is checked before anything is written, so a bad one refuses
    the lot with a reason instead of leaving half a workshop recorded. Each
    answer is {gap_id, verdict, option_index?, rationale?}."""
    run = get_run(conn, run_id, decisions_too=False)
    if not run:
        raise LookupError(run_id)
    if not answers:
        raise ValueError("Nothing to submit")
    known = {d.get("gap_id") for d in (run.get("analysis") or {}).get("deviations") or []}
    seen: set[str] = set()
    rows = []
    for a in answers:
        gap, verdict = a.get("gap_id", ""), a.get("verdict", "")
        rationale = (a.get("rationale") or "").strip()
        if gap not in known:
            raise ValueError(f"{gap} is not a deviation in this run")
        if gap in seen:
            raise ValueError(f"{gap} is answered twice")
        seen.add(gap)
        if verdict not in ("accept", "reject", "defer"):
            raise ValueError(f"{gap}: verdict must be accept, reject or defer")
        if verdict != "accept" and not rationale:
            raise ValueError(f"{gap}: a deferred or rejected decision needs a rationale")
        ctx = _clean(decisions.snapshot(run, gap))
        index = a.get("option_index")
        rows.append((gap, verdict, index, decisions.option_text(ctx["options"], index), rationale, ctx))

    people = _clean([x.strip() for x in attendees if x and x.strip()])
    session_id = "ws_" + uuid.uuid4().hex[:10]
    with conn.transaction():
        conn.execute(
            """INSERT INTO workshop_sessions (id, run_id, source_run, facilitator, attendees,
                                              country, scope_bpml, scope_label, submitted_at,
                                              user_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), %s)""",
            (session_id, run_id, run_id, redact(facilitator), json.dumps(people),
             run.get("country", ""), run.get("scope_bpml", ""), run.get("scope_label", ""),
             user_id))
        ids = [_insert_decision(conn, run_id, run_id, gap, ctx, verdict=verdict, option_index=index,
                                option_text=text, rationale=rationale, disposition="",
                                decided_by=facilitator, session_id=session_id,
                                user_id=user_id)
               for gap, verdict, index, text, rationale, ctx in rows]
    conn.commit()
    session = next(x for x in get_sessions(conn, run_id) if x["id"] == session_id)
    return {"session": session, "decisions": [get_decision(conn, i) for i in ids]}


def list_decisions(conn, *, country: str = "", scope_bpml: str = "", primary_type: str = "",
                   verdict: str = "", current_only: bool = True, limit: int = 200) -> list[dict]:
    """Decisions across every run: the query the decision memory will ask."""
    where, args = [], []
    if current_only:
        where.append("is_current")
    for col, val in (("country", country), ("primary_type", primary_type), ("verdict", verdict)):
        if val:
            where.append(f"lower({col}) = lower(%s)"); args.append(val)
    if scope_bpml:
        # A code and everything under it: 4.10 finds 4.10.2 and 4.10.2.2.
        where.append("(scope_bpml = %s OR scope_bpml LIKE %s)"); args += [scope_bpml, scope_bpml + ".%"]
    sql = (f"SELECT {_DECISION_COLUMNS} FROM workshop_decisions"
           + (f" WHERE {' AND '.join(where)}" if where else "")
           + " ORDER BY decided_at DESC LIMIT %s")
    return [_decision(r) for r in conn.execute(sql, (*args, limit)).fetchall()]


def delete_run(conn, run_id: str, owner: int | None = None) -> bool:
    """Remove one run. Its workshop decisions stay: they carry their own
    context, and what an organization agreed is not a run's working notes.
    Their run_id becomes null and source_run keeps the id."""
    where, args = auth_owned(owner)
    removed = conn.execute(
        f"DELETE FROM rollout_runs WHERE id = %s{where} RETURNING id", (run_id, *args)).fetchall()
    conn.commit()
    return bool(removed)


def get_decisions(conn, run_id: str) -> list[dict]:
    """Every verdict recorded against a run, oldest first. Read by source_run,
    so the log of a deleted run can still be asked for by its id."""
    rows = conn.execute(
        f"SELECT {_DECISION_COLUMNS} FROM workshop_decisions"
        " WHERE source_run = %s ORDER BY decided_at, id", (run_id,)).fetchall()
    return [_decision(r) for r in rows]


def stats(conn=None) -> dict[str, Any]:
    conn = conn or connect()
    create_schema(conn)
    runs = conn.execute("SELECT count(*) FROM rollout_runs").fetchone()[0]
    decisions = conn.execute("SELECT count(*) FROM workshop_decisions").fetchone()[0]
    return {"runs": runs, "decisions": decisions,
            "database": rag.database_name(database_url())}
