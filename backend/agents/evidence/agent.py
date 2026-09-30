"""The Evidence Agent: one bounded run that answers a question from both engines.

It reuses `backend/agents/fitgap/tools.py` unchanged for retrieval and traversal, and adds
three things on top: provenance and duplicate flags on every result, a hub
filter on graph paths, and `graph_enumerate` for the counting questions that
retrieval answers badly.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterator

import pydantic


from backend.agents import agent_eval  # noqa: E402
from backend.graph import knowledge_graph  # noqa: E402
from backend.core import tracing  # noqa: E402
from backend.agents.fitgap import tools as ftools  # noqa: E402
from backend.agents.fitgap import verifier as fverify  # noqa: E402

from backend.agents.fitgap import memory as agent_memory  # noqa: E402
from backend.agents.fitgap import trace  # noqa: E402
from backend.agents.guardrails import POLICY, REFUSAL, contact, scope as scope_guard, web  # noqa: E402
from . import independence, paths, provenance, scoring  # noqa: E402
from .schemas import Answer, Claim, Source  # noqa: E402

MODEL = os.environ.get("EVIDENCE_MODEL") or os.environ.get("RAG_ANSWER_MODEL", "claude-opus-5")
MAX_TOOL_CALLS = int(os.environ.get("EVIDENCE_MAX_TOOL_CALLS", "14"))
MAX_INPUT_TOKENS = int(os.environ.get("EVIDENCE_MAX_INPUT_TOKENS", "60000"))
MAX_TOTAL_INPUT_TOKENS = MAX_INPUT_TOKENS * 4
MAX_TOKENS_OUT = 8000

SYSTEM = """\
You are the Evidence Agent for the Solvay SPARK S/4HANA programme (Lead-to-Cash).

You answer questions from a Markdown corpus you can only see through your tools.
You do not write essays. You produce CLAIMS, each carried by evidence you
actually retrieved, each scored by a rule you apply — not a feeling.

═══ HOW TO WORK ═══

1. Decide what kind of question this is before searching.
   - An identity or counting question ("which tickets", "how many", "what is
     linked to X") → the graph first. It enumerates exactly; retrieval guesses.
   - A substance question ("what does it require", "how does it work") → the
     corpus first.
   - A connection question → the graph, but read the WARNING below.

2. Always run one search containing any exact code verbatim (4.5.1.3,
   SPARK-22234, M-090-030, DM035). BM25 matches codes that meaning-based
   search misses.

3. SAY WHAT YOU ARE DOING, in one sentence, before each tool call. Name what
   you are looking for and why that tool. One line, no preamble: "The graph
   should say which tickets this document covers, so enumerating from it." This
   is for the person watching the investigation, not for your answer, and it
   does not change what the answer may contain — a claim still needs a quote.

4. Read before claiming. Every quote must be copied character-for-character
   from a chunk a tool returned to you IN THIS RUN. Quotes are checked
   automatically. An invented or paraphrased quote is discarded and its claim
   falls to the floor.

5. Stop when the evidence stops. Do not extend a pattern across blank cells,
   do not complete a list the document leaves incomplete, do not correct a
   typo in an identifier — reproduce it as written and say it looks wrong.

═══ WHAT YOU MUST NOT DO ═══

CO-MEMBERSHIP IS NOT INTEGRATION. Two documents both belonging to the "Lead to
Cash" stream does not connect the systems they mention. If a graph path runs
through a stream node, or through any node with a very high degree, it is an
artefact. Your tools tell you when this has happened — believe them, say so,
and look for a real interface in the corpus instead.

A COPY IS NOT A SECOND SOURCE. Two files may be versions of one document, or
two fills of one template. If your sources are near-identical, you have ONE
source. Your tools flag this. Check dates and authors; prefer the later one and
say a requirement changed if it did.

THE ONTOLOGY IS NOT AN INVENTORY. The graph models the systems that are
hard-coded in the extractor, and the BPML codes that the register or a document
mentions. The corpus names more systems than the graph holds, and the BPML
sheet holds more steps. Never present the graph's list as the complete
landscape -- but do resolve a BPML code, a system or a ticket through it first,
because it says what is connected to what, which search cannot.

A FILENAME IS NOT AN IDENTIFIER. A document named ...21999... may say 21199
inside. When they disagree, report BOTH and flag the mismatch.

DO NOT RESOLVE A CONTRADICTION. If two sources disagree, your answer is that
they disagree — quote both, name both documents, stop. Choosing a side is the
reader's job, not yours.

DO NOT ACCEPT A FALSE PREMISE. If the corpus says something is out of scope,
say so, even when the question assumes otherwise.

═══ SCORING — COMPUTE IT, DON'T FEEL IT ═══

Per claim, start at 0.50 with one supporting passage, then:
  + 0.15  each additional INDEPENDENT document that agrees
          (independent = different file AND not flagged a near-duplicate)
  + 0.10  the graph independently corroborates it
  − 0.25  any retrieved passage contradicts it
  − 0.15  the only support is a document that is mostly machine-read
  − 0.10  an identifier you name appears verbatim in none of your chunks
  cap 0.40 the only support is an email, minutes or a transcript
           (those record discussion, not the implemented state)
  cap 0.30 the only support is a blank template or unfilled boilerplate
Clamp to [0.05, 0.95]. Never claim certainty.

Your tools tell you which documents are near-duplicates, which are mostly
machine-read, and which are discussion. Use those flags; do not guess at them.
The server recomputes every score from the same rule, so a score you invent
will simply be replaced — put your effort into the evidence instead.

═══ ANSWER STATE — pick exactly one ═══

supported           claims stand, sources agree
conflicted          sources disagree; report both sides, resolve neither
documented_unknown  the corpus records this as open ("??", "TBC")
not_in_corpus       nothing addresses it
false_premise       the corpus contradicts what the question assumes
unrepresentable     answering needs something no engine models — say which

documented_unknown and not_in_corpus are DIFFERENT answers. The first means
somebody wrote down that it is undecided. Say which one you mean.

═══ HOW TO WRITE IT ═══

Your reader is a technical person who does not know this corpus. They should be
able to read your answer once, understand it, and know what to do next. Write
for them, not for yourself.

1. ONE IDEA PER SENTENCE. Keep sentences short. If a sentence needs a comma
   splice, a semicolon or a second bracket, it is two sentences.

2. SPELL OUT A SHORT CODE THE FIRST TIME YOU USE IT, then use it freely:
   "the FC (Forecast Check) block", "table TVLS (the delivery-block
   configuration table)". Never open with a bare abbreviation.

3. WRITE ABOUT THE BUSINESS, NOT ABOUT YOUR TOOLS. The reader does not care
   which tool you called or what it returned. State what is true of the
   documents.
      Bad:  "The graph, enumerating ticket references in
             '20250209_SPARK_L2C_FS_Interface_Ecommerce and SAP updated
             (docx)', returns exactly 19 distinct SPARK tickets."
      Good: "The eCommerce interface specification covers 19 SPARK tickets."

4. NAME DOCUMENTS IN PROSE THE WAY A PERSON WOULD. Use a short, recognisable
   description. The exact filename belongs in the evidence, where it already
   appears — do not repeat it in the sentence.
      Bad:  "20250209_SPARK_L2C_FS_Interface_Ecommerce and SAP updated (docx)
             states that..."
      Good: "The eCommerce interface specification states that..."

5. NO LATIN, NO PADDING. Do not write "i.e.", "e.g.", "viz.", "per", "thereof",
   "utilise", "leverage", "in order to", "it should be noted that". Say
   "that is", "for example", "use", "to".

6. ACTIVE VOICE, PRESENT TENSE. "The specification excludes M3", not "M3 is
   understood to have been excluded".

7. NO STACKED BRACKETS. One parenthetical per sentence at most.

Worked example — the same finding, badly and well:

  Bad:  "The corpus disagrees. Three sources (the Delivery Blocks workbook's
         'Feuil1' sheet, the Item Line Delivery Block FS showing table TVLS,
         and the Lisbon intro deck) mark FC – Forecast check with a Purchase
         Requisition block, i.e. no PR is created."

  Good: "The documents disagree about the Forecast Check block. Three of them
         say it stops a purchase requisition being created. The business
         sheet of the Delivery Blocks workbook is one. Two other documents say
         the opposite. One of them is the configuration sheet of that same
         workbook, so the workbook contradicts itself."

Apply the same rules to every claim. A claim is a sentence a reader could
repeat in a meeting and be understood.

═══ OUTPUT ═══

Call submit_answer once, with:

  state    one of the six above.
  answer   the direct answer, at most 120 words. Lead with the answer itself,
           not with what you did to find it. If the reader needs a warning
           before the answer makes sense, give the warning in the first
           sentence.
  claims   each with its text, its score, the rule terms behind that score,
           and its evidence: chunk id, document, heading, the verbatim quote,
           and whether that quote supports the claim, opposes it, or only
           gives context.
  open_questions
           what a person should check next, phrased so they can act on it.
           Name who or what could settle it where you can. Not "the scope is
           ambiguous" but "ask the process lead which of the two figures is
           the agreed scope".
  limits   what stopped you going further — the tool budget, an unreadable
           picture, something the graph cannot model. Plain sentences.

British English. If you find yourself writing a sentence you would not say out
loud to a colleague, rewrite it.
""" + "\n" + POLICY


def prompt_hash() -> str:
    return hashlib.sha256(SYSTEM.encode()).hexdigest()[:12]


# --- tools ---------------------------------------------------------------------
# The six read tools come from backend/agents/fitgap/tools.py untouched. These wrappers add the
# flags the prompt tells the agent to trust, so the judgement is made on the
# server and the model only has to read it.


def _enrich(session: ftools.Session, results: list[dict]) -> list[dict]:
    dupes = independence.load()
    titles = []
    for r in results:
        rec = session.retrieved.get(r["chunk_id"], {})
        src = rec.get("source")
        if src:
            p = provenance.of(src, rec.get("true_doc") or r["doc"])
            flags = p.flags()
            if flags:
                r["provenance"] = flags
                r["provenance_note"] = p.summary()
        titles.append(rec.get("true_doc") or r["doc"])
    note = dupes.note_for(titles)
    return results, note


def search_corpus(session: ftools.Session, query: str, k: int = 8, filters: dict | None = None) -> dict:
    out = ftools.search_corpus(session, query, k, filters)
    if out.get("results"):
        out["results"], dupe_note = _enrich(session, out["results"])
        if dupe_note:
            out["duplicate_warning"] = dupe_note
    return out


def get_chunk(session: ftools.Session, chunk_id: str) -> dict:
    out = ftools.get_chunk(session, chunk_id)
    if not out.get("error"):
        enriched, _ = _enrich(session, [out])
        out = enriched[0]
    return out


def graph_path(session: ftools.Session, a: str, b: str) -> dict:
    """BFS, then a verdict on whether the route means anything.

    The graph is the run's, not the corpus's: `_graph` cuts it to the
    categories this session may read, so a route cannot be built out of
    documents the same run's retrieval would refuse to open. Hub degree is
    recomputed for that subgraph, so "this path only goes through a hub" is
    judged on what the run can see."""
    g = ftools._graph(session)
    nodes = {n["id"]: n for n in g["nodes"]}
    src = a if a in nodes else ftools._best_node(g, a)
    tgt = b if b in nodes else ftools._best_node(g, b)
    if not src or not tgt:
        unresolved = a if not src else b
        if session.categories:
            corpus = {n["id"] for n in knowledge_graph.extract_graph()["nodes"]}
            if unresolved in corpus:
                return {"error": (f"'{unresolved}' is outside this run's categories "
                                  f"({', '.join(session.categories)}), so no path to it can be "
                                  "drawn from what this run may read")}
        return {"error": f"could not resolve {'a' if not src else 'b'} to a graph node"}
    verdict = paths.shortest(g, src, tgt)
    if verdict is None:
        return {"path": None,
                "note": f"no path connects {nodes[src]['label']} and {nodes[tgt]['label']}"}
    return verdict.as_dict()


def graph_enumerate(session: ftools.Session, node_id: str, type: str = "") -> dict:
    """Every node of one type adjacent to `node_id`, counted exactly.

    Retrieval answers "how many" by reading whatever eight chunks it found.
    The graph knows, so this asks it directly.
    """
    # Scoped like every other read this run makes. This one counts, so an
    # unscoped graph here would not merely show the agent a document it cannot
    # open -- it would put it in an exact figure the answer then quotes.
    g = ftools._graph(session)
    nodes = {n["id"]: n for n in g["nodes"]}
    if node_id not in nodes:
        near = [n["id"] for n in g["nodes"]
                if node_id.lower() in n["label"].lower() or node_id.lower() in n["id"].lower()][:6]
        if session.categories and any(n["id"] == node_id
                                      for n in knowledge_graph.extract_graph()["nodes"]):
            return {"error": (f"'{node_id}' is outside this run's categories "
                              f"({', '.join(session.categories)})"), "did_you_mean": near}
        return {"error": f"'{node_id}' is not a graph node", "did_you_mean": near}
    wanted = (type or "").strip().lower()
    out = []
    for e in g["edges"]:
        other = (e["target"] if e["source"] == node_id
                 else e["source"] if e["target"] == node_id else None)
        if other is None or other not in nodes:
            continue
        n = nodes[other]
        if wanted and n["type"] != wanted:
            continue
        if session.excluded(n.get("label", ""), n.get("source", "")):
            continue
        out.append({"node_id": n["id"], "label": session.present(n["label"]),
                    "type": n["type"], "relation": e["relation"]})
    out.sort(key=lambda n: n["label"])
    return {
        "node": {"node_id": node_id, "label": nodes[node_id]["label"], "type": nodes[node_id]["type"]},
        "type_filter": wanted or "any",
        "count": len(out),
        "items": out[:200],
        # A count is quoted in answers, so it has to say what it counted over.
        "note": (("This count is exact for the graph, which is built by pattern matching over the "
                  "same Markdown files. A thing the patterns miss is absent here but may still be "
                  "in the corpus.")
                 + (f" It counts only what {', '.join(session.categories)} accounts for, which is "
                    "the scope of this run." if session.categories else "")),
    }


DISPATCH: dict[str, Callable[..., dict]] = {
    "get_scope": ftools.get_scope,
    "search_corpus": search_corpus,
    "get_chunk": get_chunk,
    "graph_entity": ftools.graph_entity,
    "graph_neighbors": ftools.graph_neighbors,
    "graph_path": graph_path,
    "graph_enumerate": graph_enumerate,
    # Gated in backend/agents/guardrails/web.py; only offered when switched on.
    "web_search": web.search,
}

ENGINE_OF = {
    "search_corpus": "rag", "get_chunk": "rag",
    "graph_entity": "graph", "graph_neighbors": "graph",
    "graph_path": "graph", "graph_enumerate": "graph",
    "get_scope": "bpml",
    "web_search": "web",
}


def tool_definitions() -> list[dict]:
    base = {d["name"]: d for d in ftools.definitions()}
    defs = [base[n] for n in ("get_scope", "search_corpus", "get_chunk",
                              "graph_entity", "graph_neighbors")]
    defs.append({
        "name": "graph_path",
        "description": (
            "Shortest path between two graph entities, WITH a verdict on whether the route is "
            "real. Check `meaningful`: when it is false the route is an artefact of the graph's "
            "shape (usually both ends merely belonging to the same stream) and must not be "
            "reported as an integration."),
        "input_schema": {"type": "object",
                         "properties": {"a": {"type": "string"}, "b": {"type": "string"}},
                         "required": ["a", "b"]},
    })
    defs.append({
        "name": "graph_enumerate",
        "description": (
            "Count and list every node of a given type adjacent to a graph node — the exact answer "
            "to 'which tickets does this document cover' or 'what is linked to this system'. Use "
            "this instead of retrieval for any counting question. type: spec, document, process, "
            "system or stream."),
        "input_schema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"},
                           "type": {"type": "string",
                                    "enum": ["spec", "document", "process", "system", "stream", ""]}},
            "required": ["node_id"]},
    })
    defs.append({
        "name": "submit_answer",
        "description": ("Submit the finished answer. Call exactly once, at the end. Rejected "
                        "submissions come back with the reason so you can correct them."),
        "input_schema": Answer.model_json_schema(),
    })
    return defs


# --- memory --------------------------------------------------------------------
# What earlier runs worked out, and what this one is worth writing down. The
# transport and the policy live in backend/agents/fitgap/memory.py; what an INVESTIGATION is
# worth remembering is here, because it is a judgement about evidence.

MEMORY_PREFACE = """\
═══ WHAT EARLIER INVESTIGATIONS FOUND ═══

These are notes from your own past runs over this corpus. They are NOT
EVIDENCE. Nothing below is retrievable, and nothing below may be quoted or
cited: a quote that is not in a chunk a tool returned to you in THIS run is
discarded automatically and its claim falls to the floor.

Use them for one thing only -- deciding where to look first. Then prove it from
the corpus. If what you retrieve contradicts a note, the corpus wins; say so in
your answer, and do not repeat the note.
"""


def memory_note(memories: list[dict]) -> str:
    """The recalled memories, as the block that goes in front of the question."""
    lines = [MEMORY_PREFACE]
    for i, m in enumerate(memories, 1):
        lines.append(f"{i}. {m['text'].strip()}")
    return "\n".join(lines)


def worth_remembering(answer: Answer) -> str:
    """What this investigation established, in the words a later run needs.

    Only claims that still carry a source survive: finalise() has already
    dropped every quote that was not found in the chunk it named, so a claim
    with no sources left is one whose evidence did not hold up. Writing that
    into memory would be worse than forgetting it -- nothing downstream
    re-checks a memory, so it would be believed forever.

    An answer that found nothing is still worth keeping. "We looked for this
    and the corpus does not address it" is exactly the note that stops the next
    run spending its whole budget re-discovering the same absence.
    """
    kept = [c for c in answer.claims if c.sources]
    lines = [f"Question: {answer.question}",
             f"Answer ({answer.state}): {answer.answer}"]
    if kept:
        lines.append("Established:")
        for c in kept:
            docs = sorted({s.doc for s in c.sources if s.doc})
            carried = f"; carried by {', '.join(docs)}" if docs else ""
            lines.append(f"- {c.text} [confidence {c.score:.2f}{carried}]")
    if answer.open_questions:
        lines.append("Still open:")
        lines.extend(f"- {q}" for q in answer.open_questions)
    return "\n".join(lines)


# --- the run -------------------------------------------------------------------

_ID = re.compile(r"\b(?:SPARK-\d{4,6}|[A-Z]-\d{2,3}(?:-\d{2,3})+|\d+(?:\.\d+){2,})\b")


def run(question: str, holdout: bool = False,
        on_event: Callable[[str, dict], None] | None = None,
        categories: list[str] | None = None,
        memory: bool = False) -> Iterator[tuple[str, dict]]:
    """Answer one question. Yields ('tool_call'|'memory'|'answer'|'error', payload).

    `categories` restricts which document categories the run may read. It is
    enforced in the session rather than left to the model, and the model is
    told about it so it does not report a gap that is really the filter.

    `memory` lets the run read what earlier runs concluded, and writes down what
    this one concludes. It is ignored under holdout: holdout hides the fit
    registers to measure the agent against a corpus it cannot look the answer up
    in, and a previous run's answer arriving through memory would hand it back.
    """
    import anthropic

    started = time.time()

    # The scope guardrail, before anything is spent. A question a general
    # chatbot would answer is refused here rather than handed to an agent
    # that might answer it from its own knowledge anyway.
    verdict = scope_guard.check(question)
    if not verdict.allowed:
        yield "note", {"kind": "guardrail", "title": "Refused: outside this assistant's scope",
                       "text": verdict.reason or verdict.category, "detail": verdict.to_dict()}
        refused = tracing.start_run("investigate-question", input={"question": question},
                                    metadata={"guardrail": verdict.to_dict()},
                                    tags=["evidence-agent", "guardrail-refused"])
        # Read before end(), which lets go of the trace.
        trace_id, trace_url = refused.trace_id, refused.url()
        answer = Answer(question=question, state="not_in_corpus", answer=REFUSAL,
                        limits=[scope_guard.refusal_detail(verdict)],
                        seconds=round(time.time() - started, 2))
        refused.end(output={"state": "refused", "category": verdict.category})
        scores = agent_eval.evaluate(agent_eval.refused, verdict=verdict.to_dict())
        agent_eval.push(trace_id, scores)
        yield "answer", answer.model_dump()
        yield "evaluation", agent_eval.report(scores, trace_url)
        return

    scope = tuple(sorted({c.strip().upper() for c in (categories or []) if c.strip()}))
    session = ftools.Session(holdout=holdout, categories=scope)
    client = anthropic.Anthropic()
    # One trace per investigation. No session id: an investigation is a single
    # question with no attached documents and nothing to group it with.
    run = tracing.start_run(
        "investigate-question",
        input={"question": question, "categories": list(scope) or "all"},
        metadata={"model": MODEL, "prompt_hash": prompt_hash(), "holdout": holdout},
        tags=["evidence-agent"] + (["holdout"] if holdout else []),
    )
    # Read now: end() lets go of the trace, and the scores are written after it.
    trace_id, trace_url = run.trace_id, run.url()
    prompt = question
    if scope:
        prompt = (
            f"{question}\n\n[Only the {', '.join(scope)} document "
            f"{'categories are' if len(scope) > 1 else 'category is'} in scope for this "
            "question. Everything else is out of reach, so say what these documents do "
            "and do not show rather than treating the rest of the corpus as missing.]"
        )
    # Memory goes in front of the question rather than into a tool, for two
    # reasons. The tool budget is 14 calls and every one spent on memory is one
    # not spent on evidence -- and memory cannot be cited, so it can never repay
    # that call the way a retrieval can. And a note is only useful before the
    # first search, which is exactly where a preface sits.
    remembered: list[dict] = []
    use_memory = agent_memory.allowed(memory, holdout)
    if use_memory:
        remembered = agent_memory.recall(question)
        if remembered:
            prompt = f"{memory_note(remembered)}\n\n═══ THE QUESTION ═══\n\n{prompt}"
    event = {"enabled": bool(memory), "used": use_memory,
             "suppressed_by_holdout": bool(memory) and holdout,
             "recalled": len(remembered), "memories": remembered}
    if on_event:
        on_event("memory", event)
    yield "memory", event

    # The prompt as ASSEMBLED, not as typed. Between the question and what the
    # model reads sit a scope note and, when memory is on, a page of notes from
    # earlier runs. A reader who only sees the question cannot tell why the
    # agent went where it went, so the log carries the real thing.
    yield "note", {"kind": "prompt", "title": "Context handed to the agent",
                   "text": prompt,
                   "detail": {"question": question,
                              # Why this question was let through, and how that
                              # was decided (a signal, the classifier, or the
                              # classifier being unreachable).
                              "guardrail": verdict.to_dict(),
                              "scope": list(scope) or ["all categories"],
                              "memory_notes": len(remembered),
                              "characters": len(prompt)}}

    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    defs = tool_definitions() + web.definitions(session)

    calls = turns = 0
    in_tokens = out_tokens = last_in = 0
    engines: dict[str, int] = {}
    submitted: Answer | None = None
    # For agent_eval: every call as it happened, and the loop's own troubles.
    call_log: list[dict] = []
    rejections = 0
    budget_hit = False

    try:
        while submitted is None:
            over = (calls >= MAX_TOOL_CALLS or last_in >= MAX_INPUT_TOKENS
                    or in_tokens >= MAX_TOTAL_INPUT_TOKENS)
            if over:
                budget_hit = True
                why = ("tool budget" if calls >= MAX_TOOL_CALLS else
                       "one turn's input" if last_in >= MAX_INPUT_TOKENS else "total input")
                yield "note", {"kind": "budget",
                               "title": f"Stopped by the {why} limit",
                               "text": (f"{calls} of {MAX_TOOL_CALLS} calls, {in_tokens:,} input "
                                        f"tokens. The agent is told to answer from what it has "
                                        f"already retrieved rather than guess."),
                               "detail": {"calls": calls, "max_calls": MAX_TOOL_CALLS,
                                          "input_tokens": in_tokens, "last_turn": last_in}}
                messages.append({"role": "user", "content": (
                    "Your tool budget is exhausted. Call submit_answer now with what you can "
                    "support from the chunks you already retrieved. If that is nothing, use state "
                    "'not_in_corpus' and say in open_questions what you were still missing. "
                    "Do not guess.")})

            with run.current():
                response = client.messages.create(
                    model=MODEL, max_tokens=MAX_TOKENS_OUT, system=SYSTEM,
                    tools=defs, messages=messages, cache_control={"type": "ephemeral"},
                )
            last_in = _input_tokens(response.usage)
            in_tokens += last_in
            out_tokens += response.usage.output_tokens
            messages.append({"role": "assistant", "content": response.content})

            # The model reasons out loud between tool calls. Those blocks went
            # back into `messages` -- the model has always seen them -- and were
            # dropped on the floor everywhere else, which is why the page could
            # show WHAT was called and never WHY.
            # The model's own account of what it is doing, which it writes
            # beside its tool calls because rule 5 below asks it to.
            #
            # Not extended thinking: `thinking: enabled` is rejected outright by
            # this model, and `adaptive` returns a block whose `thinking` field
            # is empty and whose `signature` is encrypted -- there is no
            # plaintext reasoning to show, whatever is asked for. A `thinking`
            # block is still read here, so a model that does return one is
            # shown rather than silently dropped.
            for block in response.content:
                text = (getattr(block, "thinking", "") if block.type == "thinking"
                        else getattr(block, "text", "") if block.type == "text" else "")
                if text and text.strip():
                    yield "thinking", {"turn": turns, "kind": block.type,
                                       "text": text.strip()}
            turns += 1

            uses = [b for b in response.content if b.type == "tool_use"]
            if not uses:
                if over:
                    break
                calls += 1
                messages.append({"role": "user",
                                 "content": "You did not call a tool. Call submit_answer now."})
                continue

            results = []
            for use in uses:
                if use.name == "submit_answer":
                    try:
                        payload = dict(use.input)
                        payload["question"] = question
                        submitted = Answer(**payload)
                        results.append({"type": "tool_result", "tool_use_id": use.id,
                                        "content": "Answer accepted."})
                    except pydantic.ValidationError as exc:
                        results.append({"type": "tool_result", "tool_use_id": use.id,
                                        "is_error": True,
                                        "content": "Rejected:\n" + _errors(exc)
                                                   + "\nCorrect it and call submit_answer again."})
                        yield "note", {"kind": "rejected",
                                       "title": "Answer rejected, sent back for correction",
                                       "text": _errors(exc),
                                       "detail": {"errors": len(exc.errors())}}
                        calls += 1
                        rejections += 1
                    continue

                calls += 1
                t0 = time.time()
                fn = DISPATCH.get(use.name)
                args = dict(use.input)
                engine = ENGINE_OF.get(use.name, "other")
                with run.step(use.name,
                              as_type=ftools.OBSERVATION_TYPE.get(use.name, "tool"),
                              input=args) as observed:
                    if fn is None:
                        result: dict = {"error": f"unknown tool {use.name}"}
                    else:
                        try:
                            result = fn(session, **args)
                        except TypeError as exc:
                            result = {"error": f"bad arguments: {exc}"}
                        except Exception as exc:
                            result = {"error": f"{type(exc).__name__}: {exc}"}
                    observed.update(output=result, metadata={"engine": engine})
                    if result.get("error"):
                        observed.update(level="ERROR", status_message=result["error"])
                engines[engine] = engines.get(engine, 0) + 1
                event = {
                    "tool": use.name, "engine": engine,
                    "arguments": args,
                    "summary": _summarise(use.name, args, result),
                    # What this call actually returned, bounded and in a shape
                    # the page can render. The summary says a search ran; the
                    # trace says which passages came back and at what rank,
                    # which is the difference between a log and evidence.
                    "trace": trace.of(use.name, args, result, session),
                    # Which store this call actually read: the per-category
                    # Postgres databases, the in-memory graph, or the sheet.
                    "sources": ftools.describe_sources(use.name, args, result),
                    "ms": int((time.time() - t0) * 1000),
                    "error": result.get("error"),
                    "warning": result.get("duplicate_warning") or (
                        result.get("warning") if result.get("meaningful") is False else None),
                }
                call_log.append(event)
                if on_event:
                    on_event("tool_call", event)
                yield "tool_call", event
                results.append({"type": "tool_result", "tool_use_id": use.id,
                                "content": json.dumps(result, default=str)[:24000]})

            messages.append({"role": "user", "content": results})
            if submitted is None and over and not any(r.get("is_error") for r in results):
                break

        raw = submitted.model_dump() if submitted is not None else None
        if submitted is None:
            submitted = Answer(
                question=question, state="not_in_corpus",
                answer="No answer was produced: the agent stopped without submitting one.",
                open_questions=["Re-run this question."])

        final = finalise(submitted, session, engines, calls, in_tokens, out_tokens, started)
        as_written = final.model_dump()
        # After verification, which checks each quote against the document as
        # written; before anything leaves -- the page, the history, memory.
        final = Answer.model_validate(contact.redact_obj(as_written))
        scores = agent_eval.evaluate(
            agent_eval.evidence,
            question=question, verdict=verdict.to_dict(), submitted=raw,
            final=as_written, redacted=final.model_dump(), calls=call_log,
            rejections=rejections, budget_hit=budget_hit)
        agent_eval.push(trace_id, scores)
        if use_memory:
            # After finalise, so only verified evidence can be written down, and
            # best-effort, so a memory server that has gone away cannot turn an
            # answer that exists into an error.
            written = worth_remembering(final)
            yield "note", {"kind": "retained",
                           "title": "Written back to memory",
                           "text": written,
                           "detail": {"claims": len([c for c in final.claims if c.sources]),
                                      "state": final.state}}
            agent_memory.retain(
                written,
                context=f"Evidence Agent investigation of the Solvay SPARK L2C corpus"
                        f"{' (' + ', '.join(scope) + ' only)' if scope else ''}",
                # No model name: the filing LLM copies metadata into the facts,
                # and which model answered is not something a later run needs.
                metadata={"state": final.state,
                          "prompt_hash": prompt_hash(),
                          "categories": ",".join(scope) or "all",
                          "claims": str(len([c for c in final.claims if c.sources]))},
                tags=["evidence", final.state] + [c.lower() for c in scope],
            )
        run.end(output={"state": final.state, "answer": final.answer,
                        "claims": len(final.claims),
                        "open_questions": len(final.open_questions),
                        "limits": len(final.limits),
                        "engines": engines, "tool_calls": calls})
        yield "answer", final.model_dump()
        yield "evaluation", agent_eval.report(scores, trace_url)
    except Exception as exc:
        run.fail(exc)
        yield "error", {"message": f"{type(exc).__name__}: {exc}"}
    finally:
        run.end()
        session.close()


def finalise(answer: Answer, session: ftools.Session, engines: dict, calls: int,
             in_tokens: int, out_tokens: int, started: float) -> Answer:
    """Verify every quote, attach retrieval and provenance metadata, rescore.

    The model's own score is discarded here. It proposed; the arithmetic decides.
    """
    dupes = independence.load()
    claims = []
    for claim in answer.claims:
        sources = []
        for s in claim.sources:
            rec = session.retrieved.get(str(s.chunk_id))
            if rec is None:
                sources.append(s.model_copy(update={
                    "verified": False,
                    "provenance_note": "this chunk was never returned by a tool in this run",
                }))
                continue
            verified = fverify.quote_in_chunk(s.quote, rec.get("full_text", ""))
            p = provenance.of(rec["source"], rec.get("true_doc") or s.doc) if rec.get("source") else None
            sources.append(s.model_copy(update={
                "verified": verified,
                "doc": rec.get("true_doc") or s.doc,
                "heading_path": rec.get("true_heading_path") or s.heading_path,
                "score": rec.get("score"),
                "vector_rank": rec.get("vector_rank"),
                "keyword_rank": rec.get("keyword_rank"),
                "provenance": p.flags() if p else [],
                "provenance_note": p.summary() if p else "",
            }))
        # A quote that is not in the chunk it names supports nothing.
        kept = [s for s in sources if s.verified]
        dropped = [s for s in sources if not s.verified]
        claim = claim.model_copy(update={"sources": kept})
        ids = _ID.findall(claim.text)
        claim = scoring.score(claim, session.retrieved, dupes, ids)
        if dropped:
            claim = claim.model_copy(update={
                "note": (claim.note + " " if claim.note else "")
                        + f"{len(dropped)} quote(s) could not be found in the chunk they named "
                          "and were discarded."})
        claims.append(claim)

    return answer.model_copy(update={
        "claims": claims, "engines": engines, "tool_calls": calls,
        "input_tokens": in_tokens, "output_tokens": out_tokens,
        "seconds": round(time.time() - started, 2), "model": MODEL,
    })


def _input_tokens(usage) -> int:
    return ((usage.input_tokens or 0)
            + (getattr(usage, "cache_read_input_tokens", 0) or 0)
            + (getattr(usage, "cache_creation_input_tokens", 0) or 0))


def _summarise(name: str, args: dict, result: dict) -> str:
    if result.get("error"):
        return str(result["error"])[:120]
    if name == "graph_enumerate":
        return f'{result.get("count", 0)} {args.get("type") or "node"}(s) linked to {args.get("node_id", "")[:34]}'
    if name == "graph_path":
        if result.get("path") is None:
            return "no path"
        return f'{result.get("hops")} hop(s)' + ("" if result.get("meaningful") else " — ARTEFACT")
    return ftools.summarise(name, args, result)


def _errors(exc: pydantic.ValidationError) -> str:
    return "\n".join(
        f"- {'.'.join(str(p) for p in e['loc']) or 'answer'}: {e['msg']}"
        for e in exc.errors()[:8])
