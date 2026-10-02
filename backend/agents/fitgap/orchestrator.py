"""Map-reduce over a BPML scope, streamed as events (handover §4, §9).

One bounded agent run per step, several in flight at once, then a single
synthesis pass. Events are emitted as they happen rather than at the end, so
the UI can show a register filling in instead of a spinner.
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Iterator

from backend.core import tracing
from backend.core import uploads
from backend.agents.guardrails import REFUSAL, scope as scope_guard

from . import agent, bpml, store, synthesis, tools, verifier
from .schemas import RunRequest, VerifiedEntry

Event = tuple[str, dict]


def preview(req: RunRequest) -> dict:
    """What a run would do, without doing it -- so the UI can show the cost
    of the button before it is pressed (§10)."""
    scope = bpml.get(req.scope_bpml) or bpml.resolve_scope(req.scope_bpml)
    if not scope:
        return {"error": f"'{req.scope_bpml}' does not resolve to a BPML process"}
    steps = bpml.steps_in_scope(scope.code)
    capped = steps[: req.max_steps]
    return {
        "scope": scope.full(),
        "scope_label": f"{scope.code} {scope.name}",
        "ancestry": [a.brief() for a in tools._ancestry(scope)],
        "steps_total": len(steps),
        "steps_planned": len(capped),
        "steps": [s.brief() for s in capped],
        "model": agent.MODEL,
        "max_tool_calls": agent.MAX_TOOL_CALLS,
        # Rough, and labelled as such: ~5 tool calls and ~25k input tokens is
        # what a typical step costs once the corpus excerpts are counted.
        "estimated_input_tokens": len(capped) * 25000,
        "estimated_minutes": round(len(capped) * 0.75 / max(req.concurrency, 1), 1),
    }


def run(req: RunRequest) -> Iterator[Event]:
    """Yields ('scope'|'step_start'|'tool_call'|'entry'|'verify_fail'|
    'synthesis'|'done'|'error', payload)."""
    started = time.time()
    # The scope guardrail, on the one thing here a person types freely. A run
    # asked to answer something outside the programme is refused before it
    # reads a document, with the same words the Evidence Agent uses.
    verdict = scope_guard.check(req.question)
    if not verdict.allowed:
        yield "error", {"message": f"{REFUSAL} {scope_guard.refusal_detail(verdict)}",
                        "refused": True, "guardrail": verdict.to_dict()}
        return
    scope = bpml.get(req.scope_bpml) or bpml.resolve_scope(req.scope_bpml)
    if not scope:
        yield "error", {"message": f"'{req.scope_bpml}' does not resolve to a BPML process"}
        return

    steps = bpml.steps_in_scope(scope.code)[: req.max_steps]
    if not steps:
        yield "error", {"message": f"{scope.code} has no steps to classify"}
        return

    run_id = f"fg_{uuid.uuid4().hex[:10]}"
    # Enforced on every worker session rather than passed per tool call, so no
    # step in the run can read outside what was chosen.
    scope_categories = tuple(sorted({c.strip().upper() for c in (req.categories or []) if c.strip()}))
    # Attached documents, if any. Resolved once, here, rather than per worker:
    # an expired session must fail the run outright instead of quietly giving
    # every step a smaller world to read than the analyst thinks it has.
    upload_session = (req.upload_session or "").strip()
    upload_record: dict = {}
    if upload_session:
        try:
            if not uploads.exists(upload_session):
                yield "error", {"message": "the attached documents have expired; upload them again"}
                return
            names = uploads.titles(upload_session)
        except ValueError as exc:
            yield "error", {"message": str(exc)}
            return
        uploads.touch(upload_session)
        upload_record = {"session": upload_session, "documents": names,
                         "schema": uploads.schema_name(upload_session)}

    conn = store.connect()
    # Bound before the try so the error path below can always close it.
    run = tracing.Run(None, {})
    try:
        store.create_schema(conn)
        record = {
            "id": run_id, "mode": req.mode, "scope_bpml": scope.code,
            "scope_label": f"{scope.code} {scope.name}", "question": req.question or "",
            "country": req.country_profile, "model": agent.MODEL,
            "prompt_hash": agent.prompt_hash(), "holdout": req.holdout,
            "categories": list(scope_categories),
            "uploads": upload_record,
            "user_id": req.user_id,
            # Scoped to what this run could read: a fingerprint over the whole
            # corpus would claim it saw documents it could never retrieve.
            "corpus_fingerprint": store.corpus_fingerprint(categories=list(scope_categories)),
            "params": {"max_steps": req.max_steps, "concurrency": req.concurrency,
                       "max_tool_calls": agent.MAX_TOOL_CALLS, "asis_dir": req.asis_dir},
        }
        store.start_run(conn, record)

        # One trace per run, not per step: a run is what the analyst starts
        # and waits for, and the steps are only meaningful next to their
        # siblings. The upload session, when there is one, is the Langfuse
        # session -- the same id the Fit-Gap Copilot uses, so attaching a
        # document and analysing it from both engines reads as one thread of
        # work.
        run = tracing.start_run(
            "classify-scope",
            input={"scope": record["scope_label"], "mode": req.mode,
                   "question": req.question or "",
                   "steps": [f"{s.code} {s.name}" for s in steps],
                   "attached": upload_record.get("documents", [])},
            metadata={"run_id": run_id, "model": agent.MODEL,
                      "prompt_hash": record["prompt_hash"],
                      "corpus_fingerprint": record["corpus_fingerprint"],
                      "categories": list(scope_categories) or "all",
                      "holdout": req.holdout, "concurrency": req.concurrency},
            session_id=upload_session or None,
            tags=["fitgap-copilot", f"mode-{req.mode}"] + (["holdout"] if req.holdout else []),
        )

        yield "scope", {
            "run_id": run_id, "scope": scope.full(),
            "scope_label": record["scope_label"],
            "ancestry": [a.brief() for a in tools._ancestry(scope)],
            "steps": [s.brief() for s in steps],
            "mode": req.mode, "holdout": req.holdout, "model": agent.MODEL,
            "prompt_hash": record["prompt_hash"],
            "corpus_fingerprint": record["corpus_fingerprint"],
            "categories": list(scope_categories),
            "uploads": upload_record,
            "user_id": req.user_id,
        }

        events: queue.Queue = queue.Queue()
        results: dict[str, VerifiedEntry] = {}
        lock = threading.Lock()

        def work(step: bpml.Process) -> None:
            events.put(("step_start", {"bpml_code": step.code, "step_name": step.name,
                                       "level": step.level}))
            session = tools.Session(holdout=req.holdout, categories=scope_categories,
                                    uploads=upload_session)
            # Opened on the pool thread that does the work, and parented
            # explicitly: the steps run concurrently, so there is no ambient
            # context here to inherit from.
            #
            # The name is the same for every step. Putting the BPML code in it
            # -- "classify-4.3.3.1" -- would read better in one trace and
            # ruin every aggregate over many, because a name is what Langfuse
            # groups by; the code goes in the input, where it is filterable
            # without fragmenting the group.
            with run.step("classify-step", as_type="agent",
                          input={"bpml_code": step.code, "step_name": step.name,
                                 "level": step.level},
                          metadata={"mode": req.mode}) as step_span:
                _work(step, session, step_span)

        def _work(step: bpml.Process, session: tools.Session, step_span) -> None:
            try:
                def on_tool(call: tools.ToolCall) -> None:
                    events.put(("tool_call", {
                        "bpml_code": step.code, "tool": call.name,
                        "summary": call.summary, "ms": call.ms, "error": call.error,
                        "sources": call.sources,
                    }))

                result, session = agent.run_step(
                    step, run_id, mode=req.mode, holdout=req.holdout,
                    country=req.country_profile, question=req.question,
                    on_tool=on_tool, session=session,
                )
                result = verifier.verify(result, session, mode=req.mode)
                hard = [i for i in result.issues if i.severity == "hard"]
                if hard:
                    events.put(("verify_fail", {
                        "bpml_code": step.code,
                        "issues": [i.model_dump() for i in hard],
                        "repaired": result.repaired,
                    }))
                with lock:
                    results[step.code] = result
                step_span.update(
                    output={"classification": result.entry.classification,
                            "confidence": result.entry.confidence,
                            "materiality": result.entry.materiality,
                            "rationale": result.entry.rationale,
                            "evidence": len(result.entry.evidence),
                            "evidence_valid": result.evidence_valid},
                    metadata={"tool_calls": result.tool_calls,
                              "input_tokens": result.input_tokens,
                              "output_tokens": result.output_tokens,
                              "repaired": result.repaired})
                if hard:
                    step_span.update(level="WARNING",
                                     status_message="; ".join(i.detail for i in hard)[:300])
                entry_id = store.save_entry(conn, run_id, result)
                events.put(("entry", {
                    "id": entry_id, **result.entry.model_dump(),
                    "issues": [i.model_dump() for i in result.issues],
                    "evidence_valid": result.evidence_valid,
                    "tool_calls": result.tool_calls, "seconds": result.seconds,
                    "input_tokens": result.input_tokens, "output_tokens": result.output_tokens,
                }))
            except Exception as exc:
                step_span.update(level="ERROR",
                                 status_message=f"{type(exc).__name__}: {exc}")
                events.put(("step_error", {
                    "bpml_code": step.code, "step_name": step.name,
                    "message": f"{type(exc).__name__}: {exc}",
                }))
            finally:
                session.close()

        pool = ThreadPoolExecutor(max_workers=req.concurrency, thread_name_prefix="fitgap")
        futures = [pool.submit(work, s) for s in steps]

        def close_pool() -> None:
            for f in futures:
                f.exception()
            pool.shutdown(wait=True)
            events.put(("__done__", {}))

        threading.Thread(target=close_pool, daemon=True).start()

        while True:
            name, payload = events.get()
            if name == "__done__":
                break
            yield name, payload

        ordered = [results[s.code] for s in steps if s.code in results]
        synth = synthesis.synthesise(ordered)
        tokens = (sum(r.input_tokens for r in ordered), sum(r.output_tokens for r in ordered))
        store.finish_run(conn, run_id, synth, tokens)

        reuse = synth.get("reuse", {})
        run.end(output={
            "steps": len(steps), "entries": len(ordered),
            "failed": len(steps) - len(ordered),
            "reuse_pct": reuse.get("reuse_pct"),
            "coverage_pct": reuse.get("coverage_pct"),
            "by_class": reuse.get("by_class"),
            "avg_confidence": reuse.get("avg_confidence"),
            "gaps": len(synth.get("gaps", [])),
            "decisions": len(synth.get("decisions", [])),
            "verification": verifier.summarise(ordered),
        })

        yield "synthesis", synth
        yield "done", {
            "run_id": run_id,
            "steps": len(steps),
            "entries": len(ordered),
            "failed": len(steps) - len(ordered),
            "seconds": round(time.time() - started, 1),
            "input_tokens": tokens[0], "output_tokens": tokens[1],
            "verification": verifier.summarise(ordered),
        }
    except Exception as exc:
        run.fail(exc)
        yield "error", {"message": f"{type(exc).__name__}: {exc}"}
    finally:
        # Also covers a run the browser walked away from, which leaves this
        # generator suspended at its last yield.
        run.end()
    # `conn` comes from store.connect(), which is shared and cached per thread,
    # so it is deliberately left open here.
