"""One Fit-Gap Copilot run, streamed as events.

The run is two agent passes with a deterministic middle and end: read the
As-Is, compare it, then run the quality gates and the arithmetic. Events are
emitted as they happen so the page can show the As-Is model filling in while
the comparison is still running -- the first pass is the slow one, and a
spinner over both would hide the part the analyst most wants to check.
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from typing import Callable, Iterator

from backend.agents import agent_eval
from backend.rag import rag
from backend.core import tracing
from backend.core import uploads
from backend.agents.guardrails import REFUSAL, scope as scope_guard

from backend.agents.fitgap import bpml, tools as ftools

from . import agent, gates, scoring, sources as sources_index, store, tools
from .schemas import SUBJECTS, RunRequest

Event = tuple[str, dict]


def _resolve(text: str) -> tuple[object | None, str]:
    """(process, error). Naming no Global Template process is allowed and
    gives (None, ""); naming one that does not resolve is not.

    The distinction matters: an unresolvable code is almost always a typo, and
    treating it as "no scope" would silently analyse against a different
    template process than the one the analyst asked for."""
    text = (text or "").strip()
    if not text:
        return None, ""
    found = bpml.get(text) or bpml.resolve_scope(text)
    if not found:
        return None, (f"'{text}' does not resolve to a BPML process. Clear the field to let "
                      "the agent identify the template process itself.")
    return found, ""


def preview(req: RunRequest) -> dict:
    """What a run would do, before it is paid for."""
    subject = SUBJECTS[req.subject]
    scope, bad = _resolve(req.scope_bpml)
    if bad:
        return {"error": bad}
    try:
        attached = uploads.files(req.upload_session) if req.upload_session else []
    except ValueError:
        # A session id the page still holds after the store was swept.
        attached = []
    by_role: dict[str, int] = {}
    for f in attached:
        by_role[f["role"]] = by_role.get(f["role"], 0) + 1
    ready = by_role.get(subject.role, 0) > 0
    return {
        "scope": scope.full() if scope else None,
        "scope_label": f"{scope.code} {scope.name}" if scope else "",
        "ancestry": [a.brief() for a in ftools._ancestry(scope)] if scope else [],
        "steps_total": len(bpml.steps_in_scope(scope.code)) if scope else 0,
        "attached": [{"name": f["name"], "role": f["role"], "role_label": f["role_label"],
                      "chunks": f["chunks"]} for f in attached],
        "by_role": by_role,
        "ready": ready,
        "subject": subject.key,
        "subject_label": subject.label,
        "required_role": subject.role,
        "blocker": "" if ready else
                   (f"Attach the {subject.label} documentation and tag it "
                    f"\"{subject.label}\" — there is nothing to analyse without it."),
        # Attached, or indexed in the corpus: either gives the SAP side a source.
        "sap_bp_available": subject.score_b and (by_role.get("sap_bp", 0) > 0 or tools.sap_bp_indexed(
            ftools.Session(categories=tuple(c.strip().upper() for c in (req.categories or []) if c.strip()))) > 0),
        "model": agent.MODEL,
        "max_tool_calls": agent.MAX_TOOL_CALLS,
        # Two passes, and the comparison pass re-reads the corpus; measured
        # runs land near this and it is labelled an estimate in the UI.
        "estimated_input_tokens": 120000,
        "estimated_minutes": 4.0,
    }


def run(req: RunRequest) -> Iterator[Event]:
    """Yields ('scope'|'stage'|'tool_call'|'asis'|'analysis'|'gate'|'scores'|
    'done'|'error', payload)."""
    started = time.time()
    subject = SUBJECTS[req.subject]
    # The scope guardrail, on the one thing here a person types freely. A run
    # asked to answer something outside the programme is refused before it
    # reads a document, with the same words the Evidence Agent uses.
    verdict = scope_guard.check(req.question)
    if not verdict.allowed:
        yield "error", {"message": f"{REFUSAL} {scope_guard.refusal_detail(verdict)}",
                        "refused": True, "guardrail": verdict.to_dict()}
        return
    scope, bad = _resolve(req.scope_bpml)
    if bad:
        yield "error", {"message": bad}
        return

    session_id = (req.upload_session or "").strip()
    if not session_id:
        yield "error", {"message": f"Attach the {subject.label} documentation before running."}
        return
    try:
        if not uploads.exists(session_id):
            yield "error", {"message": "The attached documents have expired; upload them again."}
            return
    except ValueError as exc:
        yield "error", {"message": str(exc)}
        return

    attached = uploads.files(session_id)
    roles = {f["role"] for f in attached}
    if subject.role not in roles:
        yield "error", {"message": (f"No attached document is tagged \"{subject.label}\". "
                                    "The agent has nothing to analyse against the template.")}
        return
    uploads.touch(session_id)

    categories = tuple(sorted({c.strip().upper() for c in (req.categories or []) if c.strip()}))
    run_id = f"ro_{uuid.uuid4().hex[:10]}"
    # Enforced on the session, so neither pass can read outside what was chosen
    # -- and so the tools that read "the subject" read this run's subject.
    sess = ftools.Session(categories=categories, uploads=session_id,
                          subject_role=subject.role)
    # SAP Best Practice is read from an attachment or from the SAP documents
    # already indexed in the corpus; either one is a source the gates accept.
    sap_bp_source = "sap_bp" in roles or tools.sap_bp_indexed(sess) > 0

    conn = store.connect()
    # Bound before the try so the error path below can always close it.
    run = tracing.Run(None, {})
    try:
        store.create_schema(conn)
        record = {
            "id": run_id, "subject": subject.key,
            "scope_bpml": scope.code if scope else "",
            # Empty until the analysis lands, when the agent's own match fills
            # it in -- see finish_run.
            "scope_label": f"{scope.code} {scope.name}" if scope else "",
            "country": req.country, "country_context": req.country_context,
            "sap_release": req.sap_release, "gt_version": req.gt_version,
            "question": req.question or "", "model": agent.MODEL,
            "prompt_hash": agent.prompt_hash(subject),
            "categories": list(categories),
            "uploads": {"session": session_id, "schema": uploads.schema_name(session_id),
                        "documents": [{"name": f["name"], "role": f["role"]} for f in attached]},
            "corpus_fingerprint": _fingerprint(categories),
            "user_id": req.user_id,
        }
        store.start_run(conn, record)

        # One trace for the whole run. The upload session is the Langfuse
        # session: it is what ties several analyses of the same attached
        # documents together, including the ones InsightLens ran. The user is
        # the signed-in account, which tracing.start_run reads for itself.
        run = tracing.start_run(
            "analyse-rollout",
            input={
                "subject": subject.label,
                "country": req.country,
                "template_process": record["scope_label"] or "(for the agent to identify)",
                "question": req.question or "",
                "attached": [f"{f['name']} ({f['role']})" for f in attached],
                "country_context": req.country_context,
            },
            metadata={
                "run_id": run_id, "model": agent.MODEL,
                "prompt_hash": record["prompt_hash"],
                "corpus_fingerprint": record["corpus_fingerprint"],
                "categories": list(categories) or "all",
                "upload_schema": record["uploads"]["schema"],
                "max_tool_calls": agent.MAX_TOOL_CALLS,
            },
            session_id=session_id,
            tags=["rollout-agent",
                  f"subject-{subject.key.replace('_', '-')}",
                  (req.country or "no-country").lower(),
                  "scoped" if scope else "unscoped"],
        )
        # Read now: end() lets go of the trace, and the scores are written after it.
        trace_id, trace_url = run.trace_id, run.url()

        yield "scope", {
            "run_id": run_id,
            "scope": scope.full() if scope else None,
            "scope_label": record["scope_label"],
            "ancestry": [a.brief() for a in ftools._ancestry(scope)] if scope else [],
            "country": req.country, "model": agent.MODEL,
            "subject": subject.key, "subject_label": subject.label,
            "prompt_hash": record["prompt_hash"],
            "corpus_fingerprint": record["corpus_fingerprint"],
            "categories": list(categories), "uploads": record["uploads"],
            "sap_bp_available": sap_bp_source,
        }

        # Every tool call, kept as it happens rather than at the end: a run
        # whose stream is dropped -- the tab closed, the browser gone -- still
        # leaves behind what it had found by then, which is usually the reason
        # anyone reopens it.
        calls_log: list[dict] = []
        # The investigation as a story, in the order it happened: the same
        # entry shapes as the Evidence Agent's log, so the same console reads
        # it. Tool calls point into `calls_log` by index rather than carrying
        # a second copy of every passage.
        log: list[dict] = []

        def entry(kind: str, data: dict) -> dict:
            e = _log_entry(len(log), kind, data, len(calls_log) - 1)
            log.append(e)
            try:
                store.save_log(conn, run_id, log)
            except Exception:
                pass  # bookkeeping must never become the run's error
            return e

        def recorded(events):
            for name, payload in events:
                if name == "tool_call":
                    calls_log.append(payload)
                    try:
                        store.save_calls(conn, run_id, calls_log)
                    except Exception:
                        pass  # bookkeeping must never become the run's error
                    yield name, payload
                    yield "log", entry("tool_call", payload)
                elif name in ("thinking", "note"):
                    yield "log", entry(name, payload)
                else:
                    yield name, payload

        yield "log", entry("question", {"text": (
            (req.question or "").strip()
            or f"Compare the {subject.label} with the Global Template"
               + (f" for {req.country}" if req.country else "")
               + (f", process {record['scope_label']}" if record["scope_label"] else "")),
            "detail": {"subject": subject.label, "country": req.country,
                       "template_process": record["scope_label"] or "(for the agent to identify)",
                       "attached": [f"{f['name']} ({f['role']})" for f in attached],
                       "categories": list(categories) or "all"}})

        # --- pass one: understand the As-Is (§21 stage 2) -------------------
        yield "stage", {"stage": "asis", "status": "running",
                        "detail": "Reading the country As-Is documentation"}
        yield "log", entry("note", {"kind": "stage", "title": f"Pass 1 of 2: reading the {subject.label}"})
        box: dict = {}
        yield from recorded(_pass(lambda cb, nb: agent.read_asis(req, scope, sess, cb, nb), box, run,
                         "read-as-is", lambda m: {"steps": len(m.steps),
                                                  "evidence_gaps": len(m.evidence_gaps)}))
        if box.get("error"):
            raise box["error"]
        asis, asis_cost = box["result"]
        if asis is None:
            yield "log", entry("error", {"message": "The agent did not submit an As-Is model."})
            store.fail_run(conn, run_id, "the agent did not submit an As-Is model")
            run.update(level="WARNING", status_message="no As-Is model was submitted")
            run.end(output={"error": "the agent did not submit an As-Is model"})
            scored = agent_eval.evaluate(agent_eval.rollout_incomplete, verdict=verdict.to_dict(),
                                         calls=list(calls_log), why="no As-Is model was submitted")
            agent_eval.push(trace_id, scored)
            evaluation = agent_eval.report(scored, trace_url)
            _try(store.save_evaluation, conn, run_id, evaluation)
            yield "evaluation", evaluation
            yield "error", {"message": ("The agent did not produce an As-Is model. The attached "
                                        "documentation may not describe a process.")}
            return
        asis.country = asis.country or req.country
        store.save_asis(conn, run_id, asis.model_dump())
        yield "stage", {"stage": "asis", "status": "done",
                        "detail": f"{len(asis.steps)} atomic steps", **asis_cost}
        yield "asis", asis.model_dump()

        # --- pass two: the three-way comparison (§21 stages 4-6) ------------
        yield "stage", {"stage": "compare", "status": "running",
                        "detail": "Comparing against the Global Template"}
        yield "log", entry("note", {"kind": "stage",
                                    "title": "Pass 2 of 2: comparing with the Global Template",
                                    "text": f"{len(asis.steps)} steps carried over from pass 1.",
                                    "detail": asis_cost})
        box = {}
        yield from recorded(_pass(lambda cb, nb: agent.compare(req, scope, asis, sess, cb, nb), box, run,
                         "compare-to-template",
                         lambda a: {"deviations": len(a.deviations),
                                    "fit_areas": len(a.fit_areas),
                                    "template_process": a.template_process[:120]}))
        if box.get("error"):
            raise box["error"]
        analysis, cmp_cost = box["result"]
        if analysis is None:
            yield "log", entry("error", {"message": "The agent did not submit an analysis."})
            store.fail_run(conn, run_id, "the agent did not submit an analysis")
            run.update(level="WARNING", status_message="no analysis was submitted")
            run.end(output={"error": "the agent did not submit an analysis"})
            scored = agent_eval.evaluate(agent_eval.rollout_incomplete, verdict=verdict.to_dict(),
                                         calls=list(calls_log), why="no analysis was submitted")
            agent_eval.push(trace_id, scored)
            evaluation = agent_eval.report(scored, trace_url)
            _try(store.save_evaluation, conn, run_id, evaluation)
            yield "evaluation", evaluation
            yield "error", {"message": "The agent did not submit an analysis."}
            return
        yield "stage", {"stage": "compare", "status": "done",
                        "detail": f"{len(analysis.deviations)} deviations", **cmp_cost}

        # --- the deterministic end (§25, §12) -------------------------------
        yield "stage", {"stage": "gates", "status": "running", "detail": "Quality gates"}
        # `evaluator` rather than `span`: the gates assess the analysis and
        # repair it, which is what that observation type is for, and it makes
        # them countable against the runs they rejected.
        with run.step("check-quality-gates", as_type="evaluator",
                      input={"deviations": len(analysis.deviations)}) as gate_span:
            analysis, issues = gates.check(analysis, asis, sess,
                                           has_sap_bp_source=sap_bp_source,
                                           scope_named=scope is not None,
                                           subject=subject)
            gate_summary = {**gates.summarise(issues),
                            "items": [i.model_dump() for i in issues]}
            gate_span.update(output={k: v for k, v in gate_summary.items() if k != "items"})
        yield "gate", gate_summary
        yield "log", entry("note", {
            "kind": "gates",
            "title": (f"Quality gates: {gate_summary['hard']} hard, {gate_summary['soft']} soft"
                      + (" — the analysis was repaired" if issues else "")),
            "text": "\n".join(f"[{i.severity}] {i.gate}{f' · {i.gap_id}' if i.gap_id else ''}: {i.detail}"
                              for i in issues),
            "detail": {k: v for k, v in gate_summary.items() if k != "items"}})
        yield "stage", {"stage": "gates", "status": "done",
                        "detail": f"{gate_summary['hard']} hard, {gate_summary['soft']} soft"}

        analysis = scoring.apply_harmonization(analysis)
        scores = scoring.score(analysis, subject)
        scores["heatmap"] = scoring.heatmap(analysis)
        scores["agenda"] = scoring.agenda(analysis)
        tokens = (asis_cost["input_tokens"] + cmp_cost["input_tokens"],
                  asis_cost["output_tokens"] + cmp_cost["output_tokens"])
        # Built from the retrieval log, which dies with the session -- so it
        # has to happen here, before the generator returns.
        trace = sources_index.index(
            analysis.model_dump(), asis.model_dump(), sess.retrieved,
            upload_names={f["name"] for f in attached},
        )
        store.finish_run(conn, run_id, analysis.model_dump(), scores, gate_summary, tokens,
                         sources=trace)
        # The attachments are swept hours from now; the citations that point
        # into them are kept for good, so keep what they point into as well.
        _try(store.save_attachments, conn, run_id, {
            uploads.md_name(f["name"]): {"name": f["name"], "markdown": md}
            for f in attached if (md := uploads.markdown(session_id, f["name"])) is not None
        })

        run.end(output=_headline(analysis, scores, gate_summary, record["scope_label"]))
        # The run as the store now holds it, so the scores are computed from
        # exactly what the lineage page will later show.
        scored = agent_eval.evaluate(
            agent_eval.rollout_run, verdict=verdict.to_dict(),
            min_sap=lambda: agent.min_sap_searches(subject, asis, sess),
            run={**record, "calls": list(calls_log), "log": list(log),
                 "asis": asis.model_dump(), "analysis": analysis.model_dump(),
                 "gates": gate_summary, "sources": trace})
        agent_eval.push(trace_id, scored)
        evaluation = agent_eval.report(scored, trace_url)
        _try(store.save_evaluation, conn, run_id, evaluation)

        counts = scores.get("counts") or {}
        yield "log", entry("answer", {
            "title": (f"Analysis complete: alignment {scores.get('gt_alignment')}/100"
                      f" · {len(analysis.deviations)} deviations"
                      f" · {len(scores.get('agenda') or [])} decisions for the workshop"),
            "state": "done", "text": analysis.headline,
            "detail": {"tool_calls": asis_cost["tool_calls"] + cmp_cost["tool_calls"],
                       "input_tokens": tokens[0], "output_tokens": tokens[1],
                       "seconds": round(time.time() - started, 1),
                       "workshop_minutes": counts.get("workshop_minutes")}})

        yield "analysis", analysis.model_dump()
        yield "scores", scores
        yield "sources", trace
        yield "evaluation", evaluation
        yield "done", {
            "run_id": run_id,
            "seconds": round(time.time() - started, 1),
            "input_tokens": tokens[0], "output_tokens": tokens[1],
            "tool_calls": asis_cost["tool_calls"] + cmp_cost["tool_calls"],
        }
    except Exception as exc:
        try:
            if "entry" in locals():
                yield "log", entry("error", {"message": f"{type(exc).__name__}: {exc}"})
            store.fail_run(conn, run_id, f"{type(exc).__name__}: {exc}")
        except Exception:
            pass
        run.fail(exc)
        run.end()
        yield "error", {"message": f"{type(exc).__name__}: {exc}"}
    finally:
        # A run abandoned by the browser leaves the generator un-closed at the
        # last yield, so this is also where a half-finished trace is pushed.
        run.end()
        uploads.close()
    # `conn` is shared and cached per thread, so it is deliberately left open.


def _pass(work: Callable, out: dict, run: tracing.Run, name: str,
          summarise: Callable) -> Iterator[Event]:
    """Run one agent pass on a worker thread, yielding its tool calls as they
    happen. The pass's `(result, cost)` lands in `out["result"]`.

    This used to collect the calls and emit them after the pass returned, on
    the reasoning that a pass was a few quick tool calls inside one long model
    turn. Measurement said otherwise: the comparison pass runs for about nine
    minutes and makes seventeen calls, so the progress panel showed a spinner
    for the whole run and then seventeen lines at once -- the opposite of what
    a progress panel is for.

    The worker closes its own database connections. They are thread-local, so
    the generator's thread cannot close them and they would otherwise leak one
    set per pass.

    The trace's observation for the pass is opened here, on the worker thread,
    for the same reason: OpenTelemetry nests by a context variable, and the
    thread that runs the model calls is the one whose context has to hold the
    pass. `run.step` parents it explicitly, so it lands under the run even
    though this thread inherited nothing."""
    events: queue.Queue = queue.Queue()

    def run_pass() -> None:
        try:
            with run.step(name, as_type="agent") as span:
                out["result"] = work(
                    lambda call, stage: events.put(("tool_call", _call_event(stage, call))),
                    lambda kind, data: events.put((kind, data)))
                model, cost = out["result"]
                span.update(output=summarise(model) if model is not None else None,
                            metadata=cost)
                if model is None:
                    span.update(level="WARNING",
                                status_message="the pass ended without submitting")
        except BaseException as exc:  # re-raised on the generator's thread
            out["error"] = exc
        finally:
            rag.close()
            uploads.close()
            events.put(("__end__", {}))

    threading.Thread(target=run_pass, name="rollout-pass", daemon=True).start()
    while True:
        name, payload = events.get()
        if name == "__end__":
            return
        yield name, payload


def _try(fn, *args) -> None:
    """Bookkeeping that must never become the run's error."""
    try:
        fn(*args)
    except Exception:
        pass


def _headline(analysis, scores: dict, gates_summary: dict, scope_label: str) -> dict:
    """What a run says about itself in one line of a trace list.

    The counts are taken as whole sub-dictionaries rather than by picking
    individual keys out of them. Picking is how the first version of this
    reported `must_discuss: 0` on a run with nine must-discuss deviations: it
    looked for a key named `must` and `scoring.counts` calls it `MUST_DISCUSS`,
    so the mistake was invisible -- a plausible number, quietly wrong. A trace
    that misreports is worse than one that says nothing, so there is a test on
    this function using a real scoring payload."""
    counts = scores.get("counts") or {}
    return {
        "gt_alignment": scores.get("gt_alignment"),
        "gt_band": scores.get("gt_band"),
        "localization_adjusted": scores.get("localization_adjusted"),
        "pattern": scores.get("pattern"),
        "deviations": len(analysis.deviations),
        "workshop": counts.get("workshop"),
        "workshop_minutes": counts.get("workshop_minutes"),
        "by_materiality": counts.get("by_materiality"),
        "open_questions": len(analysis.open_questions),
        "hard_gate_failures": gates_summary.get("hard"),
        "soft_gate_findings": gates_summary.get("soft"),
        "template_process": (analysis.template_process[:200] or scope_label),
    }


def _log_entry(seq: int, kind: str, data: dict, call_index: int) -> dict:
    """One line of the investigation log, capped: a reasoning block is
    unbounded, and a log nobody can load is a log nobody reads."""
    from datetime import datetime, timezone

    e: dict = {"seq": seq, "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
               "kind": kind}
    if data.get("stage"):
        e["stage"] = data["stage"]
    if kind == "tool_call":
        e.update({"tool": data.get("tool"), "engine": data.get("engine"),
                  "summary": data.get("summary"), "ms": data.get("ms"),
                  "error": data.get("error"), "arguments": data.get("arguments"),
                  "call": call_index})
    elif kind == "thinking":
        e.update({"text": (data.get("text") or "")[:6000], "turn": data.get("turn")})
    elif kind == "note":
        e.update({"note": data.get("kind"), "title": data.get("title"),
                  "text": (data.get("text") or "")[:6000], "detail": data.get("detail") or {}})
    elif kind in ("question", "answer"):
        e.update({"text": (data.get("text") or "")[:6000], "title": data.get("title"),
                  "state": data.get("state"), "detail": data.get("detail") or {}})
    elif kind == "error":
        e.update({"text": str(data.get("message", ""))[:2000]})
    return e


def _call_event(stage: str, call) -> dict:
    return {"stage": stage, "tool": call.name,
            "engine": tools.ENGINE_OF.get(call.name, "other"),
            "arguments": call.arguments,
            "summary": call.summary, "ms": call.ms, "error": call.error,
            "sources": call.sources, "trace": call.trace}


def _fingerprint(categories) -> str:
    """Scoped to what this run could read, like InsightLens's."""
    import hashlib

    h = hashlib.sha256()
    try:
        codes = [rag.check_category(c) for c in (categories or []) if c]
        conn = rag.connection()
        rows = (conn.execute("SELECT source, fingerprint FROM rag_documents"
                             " WHERE category = ANY(%s)", (codes,)).fetchall()
                if codes else
                conn.execute("SELECT source, fingerprint FROM rag_documents").fetchall())
        for _, fp in sorted(rows):
            h.update(fp.encode())
    except Exception:
        return ""
    return h.hexdigest()[:16]
