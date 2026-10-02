"""One bounded agent run per BPML step (handover §4, §6).

The run is a map step: small context, fixed tool budget, one entry out. It
never decides anything -- the entry it produces is `status = "proposed"` and
waits for a named reviewer.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Callable

import pydantic

from backend.core import tracing
from backend.agents.guardrails import POLICY, web

from . import bpml, tools
from .schemas import FitGapEntry, VerifiedEntry

MODEL = os.environ.get("FITGAP_MODEL") or os.environ.get("RAG_ANSWER_MODEL", "claude-opus-5")
MAX_TOOL_CALLS = int(os.environ.get("FITGAP_MAX_TOOL_CALLS", "12"))
# §4.1's "at most 40k input tokens" is read as context size, not as billed
# tokens summed over the turns: a five-turn run re-sends its prefix each time,
# so the cumulative figure would stop the agent at roughly its third search
# while its actual context was still small. The cumulative total is capped too,
# four times higher, to stop a pathological loop.
MAX_INPUT_TOKENS = int(os.environ.get("FITGAP_MAX_INPUT_TOKENS", "40000"))
MAX_TOTAL_INPUT_TOKENS = MAX_INPUT_TOKENS * 4
MAX_TOKENS_OUT = 8000

# §6, verbatim. Changing the wording changes the scores, so the hash of this
# string is stored on every run (§10, reproducibility).
RUBRIC = """\
Mode A signals:
- FIT_STANDARD: evidence says SAP standard, best-practice scope item or "no change", with no configuration or development specific to this step.
- FIT_CONFIG: evidence names configuration (document types, pricing procedures, output determination, customizing tables) with no custom code.
- GAP_DEVELOPMENT: evidence names an enhancement, custom report, form, interface build, BAdI or user exit, a CRC/TUT artefact, or a ticket described as development.
- UNKNOWN: no chunk addresses the step, or the evidence conflicts and neither side dominates.

Confidence (compute, don't vibe):
- Start at 0.5 when there is one independent supporting source.
- Add 0.15 per additional independent document agreeing (different file, not a copy), up to 0.9.
- Subtract 0.2 if any evidence marked `against` exists.
- Subtract 0.1 if the step code never appears verbatim, so the match was by name only.
- Cap at 0.4 when the only evidence is a transcript or a meeting note (it records discussion, not the implemented state).

Materiality: high = touches pricing, credit, billing, tax/legal output or an external interface; medium = changes a user-facing document or form; low = otherwise.

Hard rules:
- Never cite a chunk you didn't retrieve in this run.
- Never output a ticket, BPML code or system name that isn't returned by a tool.
- Prefer UNKNOWN over a low-evidence guess.
- The rationale states evidence, not opinion.
- Do not recommend what Solvay should decide; frame it as a DecisionPoint.
"""

MODE_B_CLASSES = """\
Mode B classes (a country decision about a template step that Mode A has already classified):
- REUSE: the template step carries over unchanged.
- ADAPT: reuse with a deliberate country change (configuration, org values, output variant).
- CHALLENGE: question it before it travels. The template choice may not fit the country, or the evidence conflicts.
- SIMPLIFY: same intent with fewer moving parts.
- REPLACE: SAP standard (or a localization) beats the template's custom element.
- RETIRE: the step or extension doesn't earn a place in the next wave.
- UNKNOWN: the evidence runs out. This is a valid, first-class answer, never a guess in disguise.
"""

SYSTEM_A = f"""\
You are InsightLens for the Solvay SPARK S/4HANA rollout (Lead-to-Cash).

For ONE BPML process step you decide whether the S/4HANA template meets it with SAP \
standard, with configuration, or only with custom development -- and you say how sure \
you are and why. You produce a DRAFT for a human reviewer. You never decide anything: \
every entry is proposed, and a named Solvay process lead accepts or rejects it.

You see the corpus only through your tools. Work in this order:

1. get_scope on the step's code, to read its name, description and place in the hierarchy.
2. graph_entity / graph_neighbors for identity: resolve the step's own BPML code, or its \
SUBJECT (a system, a SPARK ticket, a dash code), and pull what is linked to it. The graph \
holds the BPML codes the register and the documents mention, so the step's code is worth \
one call; a step the graph does not hold returns no match and says so.
3. search_corpus for substance. Run at least two queries: one containing the exact BPML \
code verbatim (BM25 matches codes that meaning-based search misses), and one on the step \
name plus any ticket IDs or system names step 2 found.
4. submit_entry, once, when you can support every claim with a quote.

Read before claiming: every quote in your evidence must be copied verbatim, character for \
character, from the text of a chunk a tool returned to you in THIS run. Quotes are checked \
automatically against the chunk text; an invented or paraphrased quote is discarded and \
can force your entry to UNKNOWN.

{RUBRIC}
Answer in British English. The rationale is at most 120 words of plain language a business \
analyst can read.
"""

SYSTEM_B = SYSTEM_A + f"""

THIS IS A MODE B RUN. Mode A has already classified the template. Your job is the country \
delta: what carries over to the new country, what changes, what must be challenged. Use \
the country profile in the user message as the country's stated position, and weigh it \
against the corpus evidence for the template.

{MODE_B_CLASSES}
"""

# The guardrails, last, so they read as overriding what came before them.
SYSTEM_A = SYSTEM_A + "\n" + POLICY
SYSTEM_B = SYSTEM_B + "\n" + POLICY


def prompt_hash() -> str:
    return hashlib.sha256((SYSTEM_A + SYSTEM_B + RUBRIC).encode()).hexdigest()[:12]


def _client():
    import anthropic

    return anthropic.Anthropic()


def _user_message(step: bpml.Process, mode: str, country: dict | None, question: str | None,
                  categories: tuple[str, ...] = (), upload_session: str = "") -> str:
    ancestry = " › ".join(f"{a.code} {a.name}" for a in tools._ancestry(step))
    parts = [
        f"BPML step: {step.code} — {step.name}",
        f"Hierarchy: {ancestry}" if ancestry else "",
        f"Level: {step.level} · status: {step.status or 'unknown'} · type: {step.process_type or 'unknown'}",
        f"Description from the BPML sheet:\n{step.description}" if step.description else
        "The BPML sheet gives no description for this step.",
    ]
    if mode == "B" and country:
        parts.append("Country profile:\n" + json.dumps(country, indent=2)[:3000])
    if question:
        parts.append(
            f"The analyst who started this run asked: \"{question}\"\n"
            "Keep it in view when you choose what to search for and what to put in "
            "open_questions, but still classify the step against the rubric."
        )
    if categories:
        # Without this the model reads an out-of-scope specification as a
        # missing one, and reports GAP where the truth is "not in this scope".
        parts.append(
            f"Retrieval for this run is limited to the {', '.join(categories)} document "
            f"{'categories' if len(categories) > 1 else 'category'}. Anything outside it "
            "cannot be searched, so absence of evidence here is not evidence that the "
            "project lacks a design: classify UNKNOWN and say in open_questions which "
            "category would have to be searched, rather than calling it a GAP."
        )
    if upload_session:
        from backend.core import uploads

        names = uploads.titles(upload_session)
        if names:
            parts.append(
                "The analyst attached "
                + (f"{len(names)} documents" if len(names) > 1 else "one document")
                + " to this session:\n"
                + "\n".join(f"  - {n}" for n in names[:12])
                + "\n\nRead "
                + ("them" if len(names) > 1 else "it")
                + " with search_uploads and start from upload_entities. "
                + ("They are" if len(names) > 1 else "It is")
                + " NOT part of the corpus and carry no authority over it: treat "
                + ("them" if len(names) > 1 else "it")
                + " as what one analyst brought to the table, and say so when you cite "
                + ("them" if len(names) > 1 else "it")
                + ". Where the upload and the corpus disagree, report the disagreement in "
                "open_questions rather than picking a winner."
            )
    parts.append(
        f"Classify this step and submit one register entry. bpml_code must be exactly "
        f"\"{step.code}\". Budget: {MAX_TOOL_CALLS} tool calls."
    )
    return "\n\n".join(p for p in parts if p)


def run_step(
    step: bpml.Process,
    run_id: str,
    mode: str = "A",
    holdout: bool = False,
    country: dict | None = None,
    question: str | None = None,
    doc_exclude: tuple[str, ...] = (),
    on_tool: Callable[[tools.ToolCall], None] | None = None,
    session: tools.Session | None = None,
) -> tuple[VerifiedEntry, tools.Session]:
    """Classify one step. Returns the entry (unverified -- verifier.py runs
    next) and the session, whose retrieval log the verifier needs."""
    started = time.time()
    sess = session or tools.Session(holdout=holdout, doc_exclude=doc_exclude)
    client = _client()
    system = SYSTEM_B if mode == "B" else SYSTEM_A
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": _user_message(step, mode, country, question, sess.categories,
                                                  sess.uploads)}
    ]
    tool_defs = tools.definitions(mode, has_uploads=bool(sess.uploads)) + web.definitions(sess)

    calls = 0
    in_tokens = out_tokens = last_in_tokens = 0
    submitted: FitGapEntry | None = None
    fallback_reason = ""

    while submitted is None:
        over_budget = (calls >= MAX_TOOL_CALLS
                       or last_in_tokens >= MAX_INPUT_TOKENS
                       or in_tokens >= MAX_TOTAL_INPUT_TOKENS)
        if over_budget:
            # §4.1: on budget exhaustion submit UNKNOWN with a reason, never a
            # guess. Asked for, not assumed, so the model still writes the
            # rationale from what it actually found.
            fallback_reason = (
                f"tool budget exhausted after {calls} calls and {in_tokens} input tokens"
            )
            messages.append({
                "role": "user",
                "content": (
                    "Your tool budget is exhausted. Call submit_entry now. If you cannot "
                    "support a classification with verbatim quotes from chunks you already "
                    "retrieved, submit UNKNOWN with confidence 0 and say in the rationale "
                    "what you were still missing. Do not guess."
                ),
            })

        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS_OUT,
            # §10 asks for temperature 0. The Anthropic SDK no longer exposes
            # temperature for this model family (anthropic 1.6.0 drops the
            # parameter), so determinism rests on the rubric being arithmetic
            # and on the verifier recomputing the confidence it produces.
            system=system,
            tools=tool_defs,
            messages=messages,
            # The system prompt, the rubric and the tool definitions are
            # identical on every turn of every step; caching them is the
            # difference between paying for the prefix once and paying for it
            # five times per step.
            cache_control={"type": "ephemeral"},
        )
        # With prompt caching on, usage.input_tokens counts only the tokens
        # that were NOT served from the cache -- typically a couple of dozen.
        # Budgeting on that number would disable the budget, so the cached
        # prefix is added back in.
        last_in_tokens = _input_tokens(response.usage)
        in_tokens += last_in_tokens
        out_tokens += response.usage.output_tokens
        messages.append({"role": "assistant", "content": response.content})
        cut_off = getattr(response, "stop_reason", None) == "max_tokens"

        uses = [b for b in response.content if b.type == "tool_use"]
        if not uses:
            messages.append({
                "role": "user",
                "content": "You did not call a tool. Call submit_entry with your entry now.",
            })
            if over_budget:
                break
            calls += 1  # a turn that spends tokens and returns nothing still costs budget
            continue

        results = []
        for use in uses:
            if use.name == "submit_entry":
                # Stopped at max_tokens, the call is incomplete -- and the SDK
                # still returns what it has as if it were whole.
                if cut_off:
                    results.append({
                        "type": "tool_result", "tool_use_id": use.id, "is_error": True,
                        "content": "Not received: your response reached the output limit before "
                                   "the entry was complete. Call submit_entry again, more briefly.",
                    })
                    calls += 1
                    continue
                try:
                    payload = dict(use.input)
                    payload["run_id"] = run_id
                    payload["mode"] = mode
                    payload["bpml_code"] = step.code
                    payload.setdefault("step_name", step.name)
                    payload["status"] = "proposed"
                    submitted = FitGapEntry(**payload)
                    results.append({"type": "tool_result", "tool_use_id": use.id,
                                    "content": "Entry accepted."})
                except pydantic.ValidationError as exc:
                    results.append({
                        "type": "tool_result", "tool_use_id": use.id, "is_error": True,
                        "content": "The entry was rejected:\n" + _errors(exc) +
                                   "\nCorrect it and call submit_entry again.",
                    })
                    calls += 1
                continue

            calls += 1
            t0 = time.time()
            fn = tools.DISPATCH.get(use.name)
            args = dict(use.input)
            with tracing.observation(use.name,
                                     as_type=tools.OBSERVATION_TYPE.get(use.name, "tool"),
                                     input=args) as observed:
                if fn is None:
                    result: dict = {"error": f"unknown tool {use.name}"}
                else:
                    try:
                        result = fn(sess, **args)
                    except TypeError as exc:
                        result = {"error": f"bad arguments: {exc}"}
                    except Exception as exc:
                        result = {"error": f"{type(exc).__name__}: {exc}"}
                call = tools.ToolCall(
                    name=use.name, arguments=args,
                    summary=tools.summarise(use.name, args, result),
                    ms=int((time.time() - t0) * 1000), error=result.get("error"),
                    sources=tools.describe_sources(use.name, args, result, sess),
                )
                observed.update(output=result,
                                metadata={"summary": call.summary, "sources": call.sources})
                if call.error:
                    observed.update(level="ERROR", status_message=call.error)
            sess.record(call)
            if on_tool:
                on_tool(call)
            results.append({"type": "tool_result", "tool_use_id": use.id,
                            "content": json.dumps(result, default=str)[:24000]})

        messages.append({"role": "user", "content": results})

        # Over budget, a cut-off submission is not retried: it ends the pass.
        if submitted is None and over_budget and (
                cut_off or not any(r.get("is_error") for r in results)):
            break

    if submitted is None:
        submitted = FitGapEntry(
            run_id=run_id, mode=mode, bpml_code=step.code, step_name=step.name,
            classification="UNKNOWN", confidence=0.0, materiality="low",
            rationale=("No entry was submitted for this step: " +
                       (fallback_reason or "the agent stopped without calling submit_entry") + "."),
            open_questions=["Re-run this step; the agent did not complete a submission."],
        )

    return VerifiedEntry(
        entry=submitted, tool_calls=calls, input_tokens=in_tokens,
        output_tokens=out_tokens, seconds=round(time.time() - started, 2),
    ), sess


def _input_tokens(usage) -> int:
    """Everything the model read this turn, cached or not."""
    return (
        (usage.input_tokens or 0)
        + (getattr(usage, "cache_read_input_tokens", 0) or 0)
        + (getattr(usage, "cache_creation_input_tokens", 0) or 0)
    )


def _errors(exc: pydantic.ValidationError) -> str:
    lines = []
    for e in exc.errors()[:8]:
        loc = ".".join(str(p) for p in e["loc"]) or "entry"
        lines.append(f"- {loc}: {e['msg']}")
    return "\n".join(lines)
