"""The Fit-Gap Copilot's two passes.

Stage 2 of the specification (understand the As-Is) is a separate agent run
from stages 4-7 (compare, classify, score). That is not an implementation
convenience -- §21 puts "understand the As-Is before comparing it" first
because a model given the comparison tools while it is still reading starts
diffing paragraphs, which is the two-document comparison §7 forbids.

So: pass one reads only the attachments and submits a normalised process
model. Pass two is handed that model as text and gets the corpus, the graph
and the BPML hierarchy to compare it against.

Nothing numeric comes out of the model except 0-4 ratings. Every score,
and each deviation's harmonization potential, is arithmetic over those
ratings and the model's classifications, done in scoring.py.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import time
import typing
from typing import Any, Callable

import pydantic

from backend.core import tracing

from backend.agents.guardrails import POLICY, web

from . import tools
from .schemas import SUBJECTS, Analysis, AsIsModel, Evidence, RunRequest, Subject, step_refs

QUOTE_MAX = next(m.max_length for m in Evidence.model_fields["quote"].metadata if hasattr(m, "max_length"))
HEADLINE_MAX = next(m.max_length for m in Analysis.model_fields["headline"].metadata if hasattr(m, "max_length"))

MODEL = os.environ.get("FITGAP_COPILOT_MODEL") or os.environ.get("RAG_ANSWER_MODEL", "claude-opus-5")
# The comparison reads two sides now -- the template and SAP Best Practice --
# so it is given room for the second side's searches.
MAX_TOOL_CALLS = {"asis": int(os.environ.get("ROLLOUT_MAX_TOOL_CALLS_ASIS", "20")),
                  "compare": int(os.environ.get("ROLLOUT_MAX_TOOL_CALLS", "30"))}
# Two different limits, because they guard two different things.
#
# MAX_INPUT_TOKENS is a limit on CONTEXT: how much the model is reading in one
# turn. Cached or not, it is all in the window, so the cached prefix counts.
#
# MAX_TOTAL_INPUT_TOKENS is a limit on COST, and there the cached prefix must
# not count: with prompt caching on, a fourteen-turn loop re-reads its prefix
# fourteen times and a cumulative budget over full context grows quadratically
# while the bill grows linearly. Counting cache reads here once cut this pass
# off at turn fourteen -- it submitted an empty deviation register while its
# own headline named three material divergences.
# Raised from 90k when the comparison began reading both the template and SAP
# Best Practice: a pass stopped at 19 of its 30 calls on this limit alone.
MAX_INPUT_TOKENS = int(os.environ.get("ROLLOUT_MAX_INPUT_TOKENS", "150000"))
MAX_TOTAL_INPUT_TOKENS = int(os.environ.get("ROLLOUT_MAX_BILLED_TOKENS", "220000"))
# The register is the output. A budget that leaves no room to write it out is
# not a budget, it is a way of producing a confident-looking empty analysis.
# 24k was not room: a fifteen-deviation register is ~20k tokens of JSON, and
# the model's thinking is drawn from the same allowance. Three submissions in
# a row stopped at it. The model allows 128k on a streamed request.
MAX_TOKENS_OUT = int(os.environ.get("ROLLOUT_MAX_TOKENS_OUT", "64000"))
# How many responses may end at that limit before the pass gives up. A run
# that cannot fit its register fails; it does not publish part of one.
MAX_CUT_OFFS = 2

# §26, verbatim in substance. These are the rules that make the output usable
# by a rollout team, so the hash of this text is stored on every run.
GUARDRAILS = """\
Guardrails, in force at all times:

- Do not invent SAP functionality, scope items, Fiori apps or localization content. \
If you have not read it in a source this run, you do not know it.
- Do not invent statutory obligations. Country-specific is NOT the same as legally required. \
A requirement is a confirmed statutory localization only when an explicit source says so; \
otherwise it is a suspected localization, a corporate policy or a local preference.
- Do not assume the As-Is is a requirement merely because it is what the country does today.
- Do not assume the Global Template is correct when SAP Best Practice or a valid country \
requirement suggests otherwise. A country closer to SAP standard than the template is a \
template finding, not a country failure.
- Do not propose an extension or custom development before you have considered standard \
configuration, SAP-delivered localization and an existing template variant, and recorded \
which you considered.
- Show uncertainty. Expose conflicting sources rather than choosing silently between them.
- Do not score on how thorough a document is. Absence of documentation is not proof that a \
control does not exist -- it is an evidence gap, and it belongs in open_questions.
- Distinguish business impact from implementation effort, and configuration from extension.
- A difference is not a gap, a gap is not a requirement, and a requirement is not a \
development. Never jump from "the country differs" to "custom development".
"""

EVIDENCE_RULES = """\
Evidence rules:

- Every quote must be copied verbatim, character for character, from the text of a chunk a \
tool returned to you in THIS run. Quotes are checked automatically against the chunk text; \
an invented or paraphrased quote is discarded and can force a finding to REQUIRES_DECISION.
- Every piece of evidence carries the side it came from: as_is, template, sap_bp or \
localization. A deviation claims a difference between two sides, so evidence for a material \
deviation should quote both of them.
- Mark each quote's evidence class: E1 explicit (the source states it), E2 derived (it follows \
from two or more explicit facts), E3 hypothesis (plausible, not established), E4 unknown \
(the information is needed and not available). Never present E3 as E1.
"""

# Shown to the analyst, not written into the analysis. The Evidence Agent has
# the same rule, and it is what lets the investigation log say WHY a call was
# made rather than only that it was.
# The schema's own limits, said up front. A submission over them is sent back,
# and every send-back re-sends the whole analysis: a turn and thousands of
# output tokens spent on a length the model could have kept to.
LIMITS = f"""\
Length limits, checked on submission: every evidence quote at most {QUOTE_MAX} characters -- \
quote the sentence that proves the point, not the paragraph -- and the headline at most \
{HEADLINE_MAX} characters.
"""

NARRATION = """\
Say what you are doing, in one sentence, before each tool call. Name what you are looking for \
and why that tool: "The template's returns guide should say who releases the billing block, so \
searching the workshop decks for it." One line, no preamble. This is for the person watching \
the investigation; it does not change what the submission may contain -- a finding still needs \
a quote.
"""

# --- the two passes, as templates -------------------------------------------
# The shared blocks are appended after formatting rather than interpolated
# into the template, so a brace appearing in the guardrails one day cannot
# turn into a format placeholder.


def system_subject(subject: Subject) -> str:
    """Pass one: read the subject and normalise it.

    Parameterised rather than written twice. The mechanics of reading a
    process out of a document do not change with whose process it is -- only
    the name of the thing being read and the role it is filed under -- and two
    copies of sixty lines of prompt would drift apart within a month."""
    body = SYSTEM_ASIS_TEMPLATE.format(reading=subject.reading, side=subject.side)
    return (
        f"{body}\n{EVIDENCE_RULES}\n{LIMITS}\n{GUARDRAILS}\n{NARRATION}\n"
        f'Answer in British English. The documents attached under the role "{subject.label}" '
        f"are the subject of this run.\n\n{POLICY}"
    )


def system_compare(subject: Subject) -> str:
    """Pass two: compare the subject against the Global Template."""
    if subject.localization:
        frame = (
            "    Country As-Is  \u2194  Global Template  \u2194  SAP Best Practice\n\n"
            "with country localization as a contextual lens. Every step of the country's "
            "process is checked against BOTH the Global Template and SAP Best Practice: the "
            "analysis is a Global Template comparison and an SAP Best Practice comparison of "
            "the same As-Is, side by side."
        )
        sources = (
            "1. list_sources, to see which sides you actually have a source for. SAP Best "
            "Practice content is already indexed in the corpus: read it with "
            "search_sap_best_practice, and with read_sources side=\"sap_bp\" if an SAP Best "
            "Practice document is also attached. Only if neither exists is the SAP Best Practice "
            "comparison not assessable -- then leave every sap_bp_fit_rating null and say why "
            "in sap_bp_note."
        )
        sap_side = (
            "\n   Then establish the SAP Best Practice side the same way: search_sap_best_practice "
            "for SAP's standard version of this process -- the scope item and its process steps, "
            "roles, approvals and documents. Do not stop at the process name: run "
            "search_sap_best_practice at least once for EACH stage of the As-Is (for a returns "
            "process, for example: the return request and order, approval, delivery and goods "
            "receipt, inspection, refund or replacement, credit memo), so that every deviation you "
            "rate against SAP has an SAP passage to quote. Say which SAP Best Practice process you "
            "compared against in sap_bp_note."
        )
        sap_check = (
            " Then ask the same questions of SAP Best Practice: does SAP's standard process "
            "have this step, at this point, done the same way? A step that matches the template "
            "but departs from SAP standard is still a fit_area; add a line to open_questions "
            "naming it as a template finding for design review."
        )
        sap_rating = (
            ", rate the template fit 0-4 AND the SAP Best Practice fit 0-4 (sap_bp_fit_rating). "
            "In sap_bp_reference say, in one sentence, what SAP standard does at this point and "
            "which SAP Best Practice document says so, and quote that document verbatim with "
            "side sap_bp. Give a sap_bp_fit_rating ONLY with that quote in the deviation's "
            "evidence -- a rating without one is removed. When the SAP documents do not cover the "
            "point, leave sap_bp_fit_rating null and say so in sap_bp_reference. Where the country follows SAP standard and the template departs from "
            "it, say so in exact_difference: that is a template finding, not a country failure"
        )
        sap_dims = ", and 0-4 against SAP Best Practice in sap_bp_rating"
        localization = (
            "decide the localization state honestly -- and for every deviation you mark "
            "CONFIRMED_STATUTORY, SAP_DELIVERED or SUSPECTED, add an item to the localization "
            "list for the topic it raises -- "
        )
    else:
        # No country in the run, so no localization and no third side. Said
        # explicitly because the vocabularies still offer both, and a model
        # given a CONFIRMED_STATUTORY option will eventually reach for it.
        frame = (
            "    SAP Best Practice  \u2194  Global Template\n\n"
            "There is no country in this run. Localization does not apply: set every "
            "deviation's localization_state to NOT_LOCALIZATION and leave the localization "
            "list empty. Neither does the SAP Best Practice score -- the Best Practice content "
            "is the subject here, not a third side to rate against -- so leave every "
            "sap_bp_fit_rating null."
        )
        sources = (
            "1. list_sources, to confirm which Best Practice documents are attached. They are "
            "the subject of this run; the Global Template is what you compare them against."
        )
        localization = ""
        sap_side = sap_check = sap_dims = ""
        sap_rating = ", and rate the template fit 0-4"
    body = SYSTEM_COMPARE_TEMPLATE.format(
        reading=subject.reading, subject_label=subject.label, noun=subject.noun,
        finding=subject.finding, frame=frame, sources=sources, localization=localization,
        sap_side=sap_side, sap_check=sap_check, sap_rating=sap_rating, sap_dims=sap_dims,
    )
    return (f"{body}\n{EVIDENCE_RULES}\n{LIMITS}\n{GUARDRAILS}\n{NARRATION}\n"
            "Answer in British English. Keep every statement short enough for a business "
            "analyst to read.\n\n" + POLICY)


SYSTEM_ASIS_TEMPLATE = """\
You are the SAP Rollout FitGap Agent, on your first pass.

Your only job on this pass is to understand {reading} precisely, from the \
documents attached to this session. You are NOT comparing anything yet, and you have no \
access to the Global Template on this pass.

Work like this:

1. list_sources, to see what is attached and in which role.
2. read_sources with side="{side}", several times, with different queries. Read the whole \
process, not the first chunk that matches. Use get_chunk when an excerpt is cut off.
3. Break the process into steps in the order they actually happen, following the document's \
own structure. When the document numbers or heads its process steps (5.1, 5.2 ... or Step 1, \
Step 2 ...), take exactly ONE step per numbered step: do not split one into several, do not \
merge several into one, and do not turn material from other sections -- systems, business \
rules, controls, reports, pain points -- into steps of their own; record it in the attributes \
of the step it belongs to. Only when the document does not structure its process, break it \
into atomic steps yourself. The same document must always give the same steps. For each step \
capture, where the document states it: trigger, actor/role, action, system, input, business \
rule (thresholds, tolerances, calculations), decision/branching, control (approval, \
segregation, audit), output, exception path, integration, timing/SLA and volume.
4. Normalise terminology as you go, and record what you normalised. "Credit hold", "credit \
block" and "delivery block due to credit" may be one control. "Regional CFO approval" and \
"Finance Director approval" are NOT the same role without evidence that they are.
5. submit_asis, once.

Leave an attribute empty when the document does not state it. An empty field is an honest \
answer; an invented one corrupts every comparison built on it. Put what you needed and could \
not find in evidence_gaps.
"""

SYSTEM_COMPARE_TEMPLATE = """\
You are the SAP Rollout FitGap Agent, on your second pass.

You have already read {reading} and it is given to you below as a normalised process \
model. Your job now is the comparison:

{frame}

Compare business MEANING, not document wording. Do not flag harmless differences in phrasing.

A deviation here is {finding}.

Work like this:

{sources}
2. Establish the template side. If the run named a Global Template process, get_scope on its \
BPML code for its name, description and place in the hierarchy. If it named none, identify the \
template's equivalent of this process yourself: search_corpus for what it actually does, \
graph_entity on the systems, dash codes and tickets it mentions, and get_scope on any BPML code \
that comes back. Either way, record what you settled on in `template_process` -- an analysis \
that does not say what it compared against cannot be audited. If you cannot identify one, say \
so there and keep every rating and finding to what you can actually evidence.{sap_side}
3. compare_entities, to see which systems, codes and tickets in the subject the corpus already \
knows. Each shared entity tells you what to search the corpus for.
4. search_corpus for the template's version of each part of the process. Run at least one \
query containing the exact BPML code verbatim. graph_entity and graph_neighbors resolve a \
system, ticket or dash code to what is linked to it.
5. For every step of the subject, ask: does an equivalent template step exist; at the same \
point in the process; with an equivalent actor, business rule, threshold, system capability, \
control, data and exception path?{sap_check} A step that matches the template is a \
fit_area -- name it, so the workshop can confirm it in one batch instead of walking through it.
6. For every material difference, write one deviation. Set its as_is_step_id to the step id(s) \
it concerns, exactly as written in the process model below -- that is what places it on the \
process. Classify it with the taxonomy, say exactly what the difference is in one sentence, {localization}assess materiality{sap_rating}. \
Put the deviation on ONE of the seven scored dimensions -- the one it mostly loads onto.
7. Decide the workshop bucket:
   - MUST_DISCUSS: the difference is material, or legal relevance is uncertain, or a business \
rule changes the outcome, or an approval or control differs, or development may be needed, or \
the template and SAP standard conflict, or you are not confident enough for an important \
decision. Every one of these needs an explicit DECISION QUESTION, two to four options, an \
owner and a realistic length in minutes.
   - CONFIRM: minor or configurable, or the design is equivalent and only a local value \
differs. A business owner should confirm it, but it does not need floor time.
   - NO_WORKSHOP_TIME: a clear semantic match with no decision left.
8. Rate all seven dimensions 0-4 for the template comparison{sap_dims}, with a one-line note \
for each saying what drove the rating.
9. Produce backlog candidates ONLY for findings you can evidence, and only where a validated \
need is visible. Every candidate names the gap it came from. A hypothesis is not scope.
10. submit_analysis, once.

You do not compute the scores. You supply the ratings and each deviation's disposition and \
localization state; the harmonization potential and every score are computed from them and \
published with the formula. So choose the disposition you would defend in the workshop.

The most important output is not the gap list -- it is the workshop focus list. A Must Discuss \
item without a decision question makes a workshop rediscover instead of decide.
"""


def prompt_hash(subject: Subject | None = None) -> str:
    """Identifies the prompts a run was produced by. Per subject, because two
    subjects are two different sets of instructions and a run compared against
    a hash that does not describe it is not reproducible."""
    s = subject or SUBJECTS["country_as_is"]
    return hashlib.sha256(
        (system_subject(s) + system_compare(s)).encode()).hexdigest()[:12]


def _client():
    import anthropic

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=key)


def _context(req: RunRequest, scope) -> str:
    """The run's framing, shared by both passes."""
    subject = SUBJECTS[req.subject]
    parts = [
        f"Subject of this run: {subject.label}",
        # Only said when there is one. A Best Practice run has no country, and
        # "Country: not stated" invites the model to go looking for one.
        (f"Country: {req.country or 'not stated'}" if subject.localization else ""),
        f"Global Template process: {scope.code} — {scope.name}" if scope else "",
        f"Template hierarchy: " + " › ".join(f"{a.code} {a.name}" for a in tools.ancestry(scope.code))
        if scope else "",
        f"Template description:\n{scope.description}" if scope and scope.description else "",
        f"Global Template version: {req.gt_version}" if req.gt_version else "",
        f"SAP target solution / release: {req.sap_release}" if req.sap_release else "",
        (f"Country context:\n{req.country_context}"
         if req.country_context and subject.localization else ""),
        # Said out loud rather than left as an absence: without it the model
        # tends to pick the first process the corpus mentions and never
        # records that the choice was its own.
        ("No Global Template process was named for this run. Work out which template process "
         f"corresponds to this {subject.label} from the corpus, and put what you settled on in "
         "`template_process` so the analysis says what it was compared against.")
        if not scope else "",
    ]
    if req.question:
        parts.append(f'The analyst who started this run asked: "{req.question}"\n'
                     "Keep it in view when you choose what to read and what to put in "
                     "open_questions, but still produce the full analysis.")
    return "\n\n".join(p for p in parts if p)


def _run(system: str, user: str, stage: str, sess: tools.Session,
         submit: str, model_cls, on_tool: Callable | None,
         on_note: Callable | None = None,
         step_ids: list[str] | None = None,
         need_advisory: bool = False,
         min_sap_searches: int = 0,
         amend: str | None = None) -> tuple[Any, dict]:
    """One bounded pass. Returns the submitted model (or None) and its cost.

    `on_note(kind, data)` receives what is not a tool call: the context the
    pass was handed, the model's reasoning between calls, a submission sent
    back for correction, the budget running out. The same kinds, with the same
    shapes, as the Evidence Agent's log -- so one console reads both."""
    def note(kind: str, data: dict) -> None:
        if on_note:
            try:
                on_note(kind, {**data, "stage": stage})
            except Exception:
                pass  # the log is for watching; it must not stop the pass
    client = _client()
    tool_defs = tools.definitions(stage) + web.definitions(sess)
    messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    budget = MAX_TOOL_CALLS[stage]

    calls = 0
    in_tokens = out_tokens = last_in = 0
    submitted = None
    sent_back = False
    cut_offs = 0
    # The last submission sent back, as received: what an amend call corrects.
    held: dict | None = None
    sap_searches = 0
    started = time.time()
    turns = 0
    warned = False
    note("note", {"kind": "prompt", "title": f"Context handed to the agent ({_PASS_NAME.get(stage, stage)})",
                  "text": user, "detail": {"model": MODEL, "tool_budget": budget,
                                           "tools": [t["name"] for t in tool_defs]}})

    while submitted is None:
        over = (calls >= budget or last_in >= MAX_INPUT_TOKENS
                or in_tokens >= MAX_TOTAL_INPUT_TOKENS)
        if over and not warned:
            warned = True
            note("note", {"kind": "budget", "title": "Budget reached — the agent must submit now",
                          "text": (f"{calls} of {budget} tool calls used; last turn read "
                                   f"{last_in:,} input tokens, {in_tokens:,} billed so far."),
                          "detail": {"calls": calls, "budget": budget, "last_input_tokens": last_in,
                                     "billed_input_tokens": in_tokens}})
        if over:
            messages.append({"role": "user", "content": (
                f"Your tool budget is exhausted. Call {submit} now with what you have actually "
                "read. Do not guess to fill a field: leave it empty, lower the confidence, and "
                "put what you were still missing in the open questions or evidence gaps. "
                "Write out every difference you have already found -- an empty register with a "
                "rated alignment score says the process matched, which is not what you saw.")})

        # Streamed, not because anything consumes the stream, but because the
        # SDK refuses a non-streamed request whose max_tokens could take it
        # past ten minutes -- and the register needs the output room. The
        # final message is assembled and used exactly as a create() result.
        with client.messages.stream(
            model=MODEL, max_tokens=MAX_TOKENS_OUT, system=system,
            tools=tool_defs, messages=messages,
            # The system prompt and the tool schemas are identical on every
            # turn; the submit schemas alone are several thousand tokens.
            cache_control={"type": "ephemeral"},
        ) as stream:
            response = stream.get_final_message()
        last_in = _input_tokens(response.usage)      # context this turn
        in_tokens += _billed_tokens(response.usage)  # cost, cached prefix excluded
        out_tokens += response.usage.output_tokens
        messages.append({"role": "assistant", "content": response.content})

        # What the model wrote beside its tool calls: the one line the
        # NARRATION rule asks for, or a thinking block if a model returns one.
        for block in response.content:
            text = (getattr(block, "thinking", "") if block.type == "thinking"
                    else getattr(block, "text", "") if block.type == "text" else "")
            if text and text.strip():
                note("thinking", {"turn": turns, "kind": block.type, "text": text.strip()})
        turns += 1

        uses = [b for b in response.content if b.type == "tool_use"]
        if not uses:
            note("note", {"kind": "nudged", "title": f"No tool called — told to call {submit}",
                          "text": "", "detail": {"turn": turns}})
            messages.append({"role": "user",
                             "content": f"You did not call a tool. Call {submit} now."})
            if over:
                break
            calls += 1
            continue

        # A response stopped at max_tokens ends in a tool call the model never
        # finished. The SDK still hands it over -- it assembles streamed tool
        # input with a partial-JSON parser -- so a register cut off after its
        # localization section arrived as a valid submission whose backlog
        # and open questions were simply absent, and the schema's defaults
        # filled them with nothing. Nothing in a cut-off response is acted on.
        cut_off = getattr(response, "stop_reason", None) == "max_tokens"
        if cut_off:
            cut_offs += 1
            calls += 1
            note("note", {"kind": "rejected",
                          "title": f"Cut off at the {MAX_TOKENS_OUT:,}-token output limit, sent back",
                          "text": "", "detail": {"turn": turns, "cut_offs": cut_offs}})

        results = []
        stubbed: dict[str, tuple[dict, bool]] = {}
        searched = False
        for use in uses:
            if cut_off:
                if use.name == submit:
                    stubbed[use.id] = (dict(use.input), False)
                results.append({"type": "tool_result", "tool_use_id": use.id, "is_error": True,
                                "content": _cut_off_text(use.name, submit)})
                continue
            if use.name == submit or (amend and use.name == amend):
                amending = use.name == amend
                if amending and held is None:
                    calls += 1
                    results.append({"type": "tool_result", "tool_use_id": use.id, "is_error": True,
                                    "content": (f"Nothing to amend: {amend} corrects a submission "
                                                f"that was sent back. Call {submit} first.")})
                    continue
                # A send-back used to cost a full rewrite of the register --
                # 20-35k tokens, three to four minutes -- for a fix as small as
                # one over-long headline. An amend call carries only the fix,
                # merged into the submission the harness kept; the result is
                # checked exactly like a full one.
                payload = dict(use.input)
                if amending:
                    payload = _merge(held, _repair_lists(model_cls, payload)[0])
                payload, repaired = _repair_lists(model_cls, payload)
                if repaired:
                    note("note", {"kind": "repaired",
                                  "title": f"Repaired {', '.join(repaired)}: sent as text, read as a list",
                                  "text": "", "detail": {"fields": repaired, "turn": turns}})
                payload, shortened = _shorten_quotes(payload)
                if shortened:
                    note("note", {"kind": "repaired",
                                  "title": (f"Shortened {shortened} quote(s) to {QUOTE_MAX} characters "
                                            "at a word boundary"),
                                  "text": "", "detail": {"quotes": shortened, "turn": turns}})
                candidate, exc = _validate(model_cls, payload)
                # The content checks run on what did validate, so a headline a
                # few characters over its limit no longer hides a missing SAP
                # search until the next submission: one send-back names both,
                # and every send-back costs a full rewrite of the register.
                # Once per pass, and only while there is budget to act on it.
                asks, titles, detail = ([], [], {})
                if candidate is not None and not sent_back and calls < MAX_TOOL_CALLS[stage]:
                    asks, titles, detail = _send_back_asks(
                        candidate, sess, step_ids, need_advisory, sap_searches,
                        min_sap_searches, calls, MAX_TOOL_CALLS[stage])
                if exc is None and not asks:
                    submitted = candidate
                    results.append({"type": "tool_result", "tool_use_id": use.id,
                                    "content": "Accepted."})
                    note("note", {"kind": "submitted",
                                  "title": _submitted_title(submitted) + (" (amended)" if amending else ""),
                                  "text": "", "detail": {"turn": turns, "tool_calls": calls,
                                                         "amended": amending}})
                    continue
                calls += 1
                if asks:
                    sent_back = True
                parts = []
                if exc is not None:
                    parts.append("Rejected:\n" + _errors(exc))
                    titles.insert(0, f"{len(exc.errors())} schema error(s)")
                    detail["errors"] = len(exc.errors())
                parts += asks
                text = "\n".join(parts) + (
                    f"\nCorrect it with {amend}: send only what changes, and the rest of your "
                    f"analysis is kept as submitted. Call {submit} again only to rewrite it in full."
                    if amend else f"\nCorrect it and call {submit} again.")
                results.append({"type": "tool_result", "tool_use_id": use.id, "is_error": True,
                                "content": text})
                note("note", {"kind": "rejected", "title": "Sent back: " + "; ".join(titles),
                              "text": text, "detail": {**detail, "amended": amending}})
                held = payload
                if not amending:
                    stubbed[use.id] = (payload, amend is not None)
                continue

            calls += 1
            if use.name == "search_sap_best_practice":
                sap_searches += 1
            result = _execute(sess, use.name, dict(use.input), stage, on_tool)
            results.append({"type": "tool_result", "tool_use_id": use.id,
                            "content": json.dumps(result, default=str)[:30000]})
            searched = True

        # Said while the pass is still reading, not after the register is
        # written: a run searched SAP Best Practice twice, wrote its register,
        # and was sent back to search four more times -- a full rewrite spent
        # on an instruction the prompt had already given. A text block after
        # the tool results, so the history stays append-only.
        # Only while the budget can still pay for the rest; past that, the
        # pass is being told to submit, and this would say the opposite.
        if (searched and sap_searches < min_sap_searches
                and calls + (min_sap_searches - sap_searches) <= MAX_TOOL_CALLS[stage]):
            results.append({"type": "text", "text": (
                f"SAP Best Practice searches so far: {sap_searches} of the {min_sap_searches} "
                "this process needs, one per stage of the As-Is. Run the rest before you "
                f"call {submit}.")})

        # A sent-back submission stays in the history only as an outline. The
        # register is rewritten in full either way, and two rejected copies
        # of it -- 50k tokens -- were what pushed one pass over its context
        # limit and forced it to submit before it had searched SAP. Replaced
        # before the next request, so no later turn ever saw the original.
        if stubbed:
            messages[-1] = {"role": "assistant", "content": [
                _outline(b, *stubbed[b.id]) if b.type == "tool_use" and b.id in stubbed else b
                for b in messages[-1]["content"]]}
        messages.append({"role": "user", "content": results})
        if submitted is None and cut_offs >= MAX_CUT_OFFS:
            note("note", {"kind": "budget", "title": "Submission cut off repeatedly — pass stopped",
                          "text": (f"{cut_offs} responses reached the {MAX_TOKENS_OUT:,}-token output "
                                   "limit; an incomplete analysis is not accepted."),
                          "detail": {"cut_offs": cut_offs}})
            break
        if submitted is None and over and not any(r.get("is_error") for r in results):
            break

    return submitted, {"tool_calls": calls, "input_tokens": in_tokens,
                       "output_tokens": out_tokens, "seconds": round(time.time() - started, 2)}


def _execute(sess: tools.Session, name: str, args: dict, stage: str,
             on_tool: Callable | None) -> dict:
    """Run one tool and record it -- in the trace, the session and the
    investigation log -- whether the model asked for it or the pass did."""
    from backend.agents.fitgap.tools import OBSERVATION_TYPE, ToolCall
    from backend.agents.fitgap import trace

    t0 = time.time()
    fn = tools.DISPATCH.get(name)
    # The observation records what the tool returned, not the truncated
    # copy handed to the model on the next turn; what the model read is
    # already visible in that turn's generation.
    with tracing.observation(name, as_type=OBSERVATION_TYPE.get(name, "tool"),
                             input=args) as observed:
        if fn is None:
            result: dict = {"error": f"unknown tool {name}"}
        else:
            try:
                result = fn(sess, **args)
            except TypeError as exc:
                result = {"error": f"bad arguments: {exc}"}
            except Exception as exc:
                result = {"error": f"{type(exc).__name__}: {exc}"}

        call = ToolCall(
            name=name, arguments=args,
            summary=tools.summarise(name, args, result),
            ms=int((time.time() - t0) * 1000), error=result.get("error"),
            sources=tools.describe_sources(name, args, result, sess),
            # The summary says a search ran; the trace says which
            # passages came back and at what rank. Without it a reader
            # can see the shape of the run and not check any of it.
            trace=trace.of(name, args, result, sess),
        )
        observed.update(output=result,
                        metadata={"summary": call.summary, "sources": call.sources,
                                  "stage": stage})
        if call.error:
            observed.update(level="ERROR", status_message=call.error)
    sess.record(call)
    if on_tool:
        on_tool(call, stage)
    return result


_PASS_NAME = {"asis": "reading the subject", "compare": "comparing with the template"}


def _submitted_title(model) -> str:
    if isinstance(model, AsIsModel):
        return f"As-Is model submitted: {len(model.steps)} steps, {len(model.evidence_gaps)} evidence gaps"
    if isinstance(model, Analysis):
        return (f"Analysis submitted: {len(model.deviations)} deviations, "
                f"{len(model.fit_areas)} fit areas")
    return "Submitted"


# A leaked tool-call tag at the start of a value, and its closing tag.
_PARAM_OPEN = re.compile(r'^\s*<parameter name="[^"]*">\s*')
_PARAM_CLOSE = re.compile(r'\s*</parameter>\s*$')


def _repair_lists(model_cls, payload: dict) -> tuple[dict, list[str]]:
    """List fields that arrived as text, parsed back into lists.

    A Sonnet run sent fit_areas as the string '<parameter name="fit_areas">[…]'
    -- its own tool-call markup leaked into the value, around a list that was
    otherwise valid -- and the whole register, 20k tokens, was sent back and
    rewritten for it. Only a value that parses to a list is replaced; anything
    else is left for validation to reject as before."""
    repaired = []
    out = dict(payload)
    for name, field in model_cls.model_fields.items():
        value = out.get(name)
        if not isinstance(value, str) or typing.get_origin(field.annotation) is not list:
            continue
        try:
            parsed = json.loads(_PARAM_CLOSE.sub("", _PARAM_OPEN.sub("", value)))
        except ValueError:
            continue
        if isinstance(parsed, list):
            out[name] = parsed
            repaired.append(name)
    return out, repaired


def _validate(model_cls, payload: dict):
    """The submission as a model, and the schema errors against it. On errors,
    the model is rebuilt without the top-level fields they name -- so the
    content checks can still read the rest -- or None if even that fails."""
    try:
        return model_cls(**payload), None
    except pydantic.ValidationError as exc:
        bad = {e["loc"][0] for e in exc.errors() if e["loc"]}
        try:
            return model_cls(**{k: v for k, v in payload.items() if k not in bad}), exc
        except pydantic.ValidationError:
            return None, exc


def _send_back_asks(candidate, sess: tools.Session, step_ids: list[str] | None,
                    need_advisory: bool, sap_searches: int, min_sap_searches: int,
                    calls: int, budget: int) -> tuple[list[str], list[str], dict]:
    """What a submission is sent back for beyond its schema: an SAP rating with
    no SAP quote behind it would be stripped by the gates, so the agent is
    asked to find the quote or clear the rating while it still can; and so on
    for each check. Returns the asks, their log titles and the log detail."""
    unquoted = _unquoted_sap_ratings(candidate, sess)
    unplaced = _unplaced_deviations(candidate, step_ids)
    unadvised = _unadvised_localization(candidate) if need_advisory else []
    sap_short = (isinstance(candidate, Analysis) and sap_searches < min_sap_searches
                 and calls + (min_sap_searches - sap_searches) <= budget)
    asks, titles = [], []
    if unquoted:
        asks.append(
            "These deviations carry an sap_bp_fit_rating with no SAP Best Practice "
            f"quote in their evidence: {', '.join(unquoted)}. A rating without a quote "
            "is removed automatically. For each one, either run "
            "search_sap_best_practice and add a verbatim quote with side sap_bp, or "
            "set sap_bp_fit_rating to null and say in sap_bp_reference that the SAP "
            "documents do not cover it.")
        titles.append(f"{len(unquoted)} SAP rating(s) without an SAP quote")
    if unplaced:
        asks.append(
            "These deviations name no As-Is step: "
            f"{', '.join(unplaced)}. Set as_is_step_id to the step id(s) each one "
            "concerns, exactly as written in the process model (for example "
            f"{step_ids[0]!r}); leave it empty only for a deviation that concerns "
            "no single step.")
        titles.append(f"{len(unplaced)} deviation(s) with no As-Is step")
    if unadvised:
        asks.append(
            "The localization list is empty, but these deviations are marked as a "
            f"possible or confirmed localization: {', '.join(unadvised)}. Add one "
            "localization item for each topic they raise -- status Confirmed only "
            "where an explicit statutory source says so, otherwise Candidate -- with "
            "the requirement, what SAP and the template offer, and an owner.")
        titles.append(f"{len(unadvised)} localization deviation(s) with no advisory")
    if sap_short:
        asks.append(
            f"You searched SAP Best Practice {sap_searches} time(s); this process needs "
            f"at least {min_sap_searches} -- one per stage of the As-Is (request and "
            "order, approval, delivery and receipt, inspection, refund or credit, "
            "closure). Run search_sap_best_practice for the stages you have not "
            "searched, and rate or quote SAP from what they return.")
        titles.append(f"only {sap_searches} SAP Best Practice search(es)")
    detail = {"gaps": unquoted, "unplaced": unplaced, "unadvised": unadvised,
              "sap_searches": sap_searches} if asks else {}
    return asks, titles, detail


def _cut_off_text(name: str, submit: str) -> str:
    if name != submit:
        return ("Not run: your response reached the output limit before it was complete, so "
                "none of its tool calls were acted on. Call it again.")
    return (f"Not received: your response reached the {MAX_TOKENS_OUT:,}-token output limit "
            f"before the {submit} call was complete, and an incomplete submission is not "
            f"accepted. Call {submit} again, written more tightly: one quote per point -- the "
            "sentence that proves it -- and each statement only as long as the workshop needs. "
            "Leave out nothing you found; shorten how you say it.")


def _outline(block, payload: dict, amendable: bool = False) -> dict:
    """A sent-back submission as it is kept in the history: its id and name,
    so the tool result still answers it, and what a correction refers to --
    each deviation's gap id, step, dimension and SAP rating, the dimension
    ratings, and how long each list was -- in place of the full text."""
    outline: dict[str, Any] = {"_omitted": (
        "Full submission removed from the history after it was sent back. The harness kept "
        "it: send corrections with amend_analysis." if amendable else
        "Full submission removed from the history; it was not complete, so submit it again "
        "in full.")}
    for key, value in payload.items():
        if isinstance(value, list):
            outline[key] = f"{len(value)} item(s)"
    if isinstance(payload.get("dimension_ratings"), list):
        outline["dimension_ratings"] = [
            {k: r.get(k) for k in ("dimension", "gt_rating", "sap_bp_rating")}
            for r in payload["dimension_ratings"] if isinstance(r, dict)]
    if isinstance(payload.get("deviations"), list):
        outline["deviations"] = [
            {"gap_id": d.get("gap_id"), "as_is_step_id": d.get("as_is_step_id"),
             "dimension": d.get("dimension"), "sap_bp_fit_rating": d.get("sap_bp_fit_rating"),
             "evidence": f"{len(d.get('evidence') or [])} quote(s)",
             "exact_difference": str(d.get("exact_difference", ""))[:160]}
            for d in payload["deviations"] if isinstance(d, dict)]
    return {"type": "tool_use", "id": block.id, "name": block.name, "input": outline}


# How an amend call changes a kept submission: these fields are replaced,
# these lists are added to, and deviations are matched by gap_id.
_REPLACED = ("headline", "template_process", "sap_bp_note", "dimension_ratings", "fit_areas")
_APPENDED = ("localization", "backlog", "open_questions")


def _merge(held: dict, patch: dict) -> dict:
    """The kept submission with an amend call's corrections applied. A
    deviation named by gap_id takes the patch's fields, except evidence,
    which is added to its quotes -- the agent sees only an outline of what it
    sent, so it cannot resend the full list. A gap_id not in the register is
    added as a new deviation; validation decides whether it is complete."""
    out = copy.deepcopy(held)
    patch = copy.deepcopy(patch)
    for key in _REPLACED:
        if key in patch:
            out[key] = patch[key]
    for key in _APPENDED:
        if key in patch:
            add = patch[key] if isinstance(patch[key], list) else [patch[key]]
            out[key] = list(out.get(key) or []) + add
    remove = set(patch.get("remove_deviations") or [])
    register = [d for d in out.get("deviations") or []
                if not (isinstance(d, dict) and d.get("gap_id") in remove)]
    by_id = {d.get("gap_id"): d for d in register if isinstance(d, dict)}
    for change in patch.get("deviations") or []:
        if not isinstance(change, dict):
            continue
        current = by_id.get(change.get("gap_id"))
        if current is None:
            register.append(change)
            by_id[change.get("gap_id")] = change
            continue
        for key, value in change.items():
            if key == "evidence":
                add = value if isinstance(value, list) else [value]
                current["evidence"] = list(current.get("evidence") or []) + add
            else:
                current[key] = value
    out["deviations"] = register
    return out


def _shorten_quotes(payload: dict) -> tuple[dict, int]:
    """Quotes over QUOTE_MAX cut back to a word boundary within it. The start
    of a verbatim quote is itself verbatim, so it still passes the quote check;
    sending it back instead cost a full rewrite of the register."""
    count = 0

    def cut(quote: str) -> str:
        head = quote[:QUOTE_MAX]
        space = head.rfind(" ")
        return (head[:space] if space > QUOTE_MAX // 2 else head).rstrip()

    def walk(value):
        nonlocal count
        if isinstance(value, dict):
            out = {}
            for key, item in value.items():
                if key == "quote" and isinstance(item, str) and len(item) > QUOTE_MAX:
                    out[key] = cut(item)
                    count += 1
                else:
                    out[key] = walk(item)
            return out
        if isinstance(value, list):
            return [walk(item) for item in value]
        return value

    return walk(payload), count


def _unplaced_deviations(model, step_ids: list[str] | None) -> list[str]:
    """Deviations whose as_is_step_id names none of the run's As-Is steps. The
    Process alignment tab places a finding by that id alone, and runs had
    left it empty on every deviation."""
    if not isinstance(model, Analysis) or not step_ids:
        return []
    known = {s.upper() for s in step_ids}
    return [d.gap_id for d in model.deviations if not step_refs(d.as_is_step_id) & known]


# Localization states that mean "this may be the law, or SAP delivers it" --
# each one belongs in the localization advisory, where it is given a status,
# a requirement and an owner. Runs marked five deviations SUSPECTED and left
# the advisory empty, so the Localization tab said there was nothing to see.
_LOCALIZATION_STATES = {"CONFIRMED_STATUTORY", "SAP_DELIVERED", "SUSPECTED"}


def _unadvised_localization(model) -> list[str]:
    """Localization-flagged deviations when the advisory is empty."""
    if not isinstance(model, Analysis) or model.localization:
        return []
    return [d.gap_id for d in model.deviations if d.localization_state in _LOCALIZATION_STATES]


def _unquoted_sap_ratings(model, sess: tools.Session) -> list[str]:
    """Deviations rated against SAP Best Practice with no quote from an SAP
    Best Practice chunk this run retrieved -- exactly what gates QG5 would
    strip, checked while the agent can still fix it."""
    if not isinstance(model, Analysis):
        return []
    out = []
    for d in model.deviations:
        if d.sap_bp_fit_rating is None:
            continue
        if not any(e.side == "sap_bp" and tools.is_sap_bp_chunk(sess.retrieved.get(e.chunk_id, {}))
                   for e in d.evidence):
            out.append(d.gap_id)
    return out


def read_asis(req: RunRequest, scope, sess: tools.Session,
              on_tool: Callable | None = None,
              on_note: Callable | None = None) -> tuple[AsIsModel | None, dict]:
    """Pass one. Named for the country case it was written for; it reads
    whatever the run's subject is."""
    subject = SUBJECTS[req.subject]
    user = (
        _context(req, scope)
        + f"\n\nRead the attached {subject.label} documentation and submit the normalised "
          "process. Do not compare it to anything yet. Read the whole of what is attached: "
          "the template process above, if one is named, says what the analysis is about -- it "
          "does not limit which parts of the document you may read."
    )
    return _run(system_subject(subject), user, "asis", sess, "submit_asis", AsIsModel, on_tool,
                on_note)


def compare(req: RunRequest, scope, asis: AsIsModel, sess: tools.Session,
            on_tool: Callable | None = None,
            on_note: Callable | None = None) -> tuple[Analysis | None, dict]:
    steps = "\n".join(_step_line(s) for s in asis.steps) or "(no steps were extracted)"
    notes = ""
    if asis.normalisation_notes:
        notes += "\n\nTerminology normalised while reading:\n" + "\n".join(
            f"  - {n}" for n in asis.normalisation_notes[:20])
    if asis.evidence_gaps:
        notes += "\n\nEvidence gaps recorded on the first pass:\n" + "\n".join(
            f"  - {g}" for g in asis.evidence_gaps[:20])
    subject = SUBJECTS[req.subject]
    user = (
        _context(req, scope)
        + f"\n\nThe {subject.label} process you read, as {len(asis.steps)} atomic steps:\n\n"
        + steps + notes
        + _prefetched(scope, sess, on_tool)
        + "\n\nNow run the comparison and submit the analysis. You can still call "
          f"read_sources to re-read any {subject.label} detail you need to quote."
    )
    return _run(system_compare(subject), user, "compare", sess, "submit_analysis",
                Analysis, on_tool, on_note, step_ids=[s.step_id for s in asis.steps],
                need_advisory=subject.localization,
                min_sap_searches=min_sap_searches(subject, asis, sess),
                amend="amend_analysis")


def _prefetched(scope, sess: tools.Session, on_tool: Callable | None) -> str:
    """The comparison's opening calls, made before its first turn. Every run
    spent its first turns on list_sources, get_scope on the named process and
    compare_entities -- the same calls with the same arguments, none of which
    depend on what the agent has read -- each a round trip of four to eight
    seconds. They are recorded like any other call, so the log and the trace
    still show them; the agent is handed their results rather than asking."""
    calls = [("list_sources", {})]
    if scope:
        calls.append(("get_scope", {"bpml_code": scope.code}))
    calls.append(("compare_entities", {}))
    out = []
    for name, args in calls:
        result = _execute(sess, name, args, "compare", on_tool)
        shown = ", ".join(f"{k}={v!r}" for k, v in args.items())
        out.append(f"{name}({shown}):\n{json.dumps(result, default=str)[:30000]}")
    return ("\n\nAlready run for you before this pass -- do not call these again with the same "
            "arguments: " + ", ".join(n for n, _ in calls) + ". Their results:\n\n"
            + "\n\n".join(out))


def min_sap_searches(subject, asis: AsIsModel, sess: tools.Session) -> int:
    """How many SAP Best Practice searches the comparison owes. One per stage of
    the process, capped: six covers the stages of a returns process and leaves
    the template its budget. Also read by agent_eval, which scores whether the
    run met it, so the rule lives in one place."""
    if not (subject.score_b and tools.sap_bp_indexed(sess)):
        return 0
    return min(6, max(3, len(asis.steps) // 2))


def _step_line(s) -> str:
    bits = [f"[{s.step_id}] {s.name}"]
    for label, value in (("actor", s.actor), ("system", s.system), ("rule", s.business_rule),
                         ("control", s.control), ("decision", s.decision), ("output", s.output),
                         ("exception", s.exception), ("integration", s.integration),
                         ("timing", s.timing)):
        if value:
            bits.append(f"{label}: {value}")
    return "  " + " | ".join(bits) + f" (confidence {s.confidence})"


def _input_tokens(usage) -> int:
    """Everything the model read this turn, cached or not -- its context size."""
    return ((usage.input_tokens or 0)
            + (getattr(usage, "cache_read_input_tokens", 0) or 0)
            + (getattr(usage, "cache_creation_input_tokens", 0) or 0))


def _billed_tokens(usage) -> int:
    """Input tokens charged at full rate. A cache read is a tenth of the price
    and re-reading the prefix is the point of caching, so it is not spending."""
    return ((usage.input_tokens or 0)
            + (getattr(usage, "cache_creation_input_tokens", 0) or 0))


def _errors(exc: pydantic.ValidationError) -> str:
    lines = []
    for e in exc.errors()[:10]:
        loc = ".".join(str(p) for p in e["loc"]) or "payload"
        lines.append(f"- {loc}: {e['msg']}")
    if len(exc.errors()) > 10:
        lines.append(f"- … and {len(exc.errors()) - 10} more")
    return "\n".join(lines)
