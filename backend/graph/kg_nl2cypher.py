"""Plain English to Cypher, for the knowledge graph's Neo4j copy.

A reader describes what they want -- "which documents talk about both SOVOS
and CPI, and where?" -- and Claude writes the Cypher. Three things keep the
query honest:

  grounded     The prompt carries the graph's real schema: every label and its
               properties, every relationship pattern with its count and
               properties, and the actual values a query would filter on (the
               system code is 'S4HANA', not 'S/4HANA'; a document's category is
               'PKG', not 'Package'). A model that has to guess a value writes
               a query that runs and returns nothing, which looks like an answer.
  checked      Before anything runs, Neo4j plans the query with EXPLAIN inside
               a READ transaction. A syntax error, an unknown function, or a
               plan that would write is sent back to the model with the
               database's own message, and it tries again -- twice at most.
  explained    The model returns the query with a sentence saying what it
               does and any assumption it made about the question, and says so
               plainly when the graph cannot answer it (the graph knows which
               documents mention what; it does not hold their text).

The generated query is shown in the editor before or as it runs, so the reader
can see and change exactly what was asked of the database. Running it goes
through kg_neo4j_load.query, read-only like any other query from the page.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


from backend.graph import kg_neo4j_load as n4  # noqa: E402  (also loads .env)
from backend.core import tracing  # noqa: E402

MODEL = os.environ.get("CYPHER_MODEL", "claude-opus-5")
# How hard the model thinks. Writing one query over a known schema is a bounded
# task; `medium` keeps an answer to a few seconds without skimping on the
# joins. Raise it with CYPHER_EFFORT if questions get harder.
EFFORT = os.environ.get("CYPHER_EFFORT", "medium")
MAX_ATTEMPTS = 3
# Refused requests are re-run on a fallback model chosen by refusal category,
# inside the same call (Claude API only).
FALLBACK_BETA = "server-side-fallback-2026-07-01"


# Questions offered in the Cypher view, grouped. Plain English -- clicking one
# asks the generator, so they exercise the whole path, not a stored query. The
# last group is deliberately questions the graph cannot fully answer, to show
# what the generator says then.
QUESTIONS: list[dict[str, Any]] = [
    {"group": "Systems and integrations", "questions": [
        "Which systems are mentioned most often, and in how many documents?",
        "Which documents mention both SOVOS and SAP CPI, and in which passages?",
        "Which third-party systems appear in the DR documents?",
        "Which documents mention Salesforce but not SAP S/4HANA?",
        "Which passages mention SAP S/4HANA and Salesforce together?",
        "How many documents mention each legacy ERP system (ECC, WP1, PF1, M3)?",
    ]},
    {"group": "Specifications and tickets", "questions": [
        "Which specifications implement a SPARK ticket, and which systems do they name?",
        "Which documents reference SPARK-22234?",
        "Which SPARK tickets are referenced by more than three documents?",
        "Which interface specifications mention SAP CPI?",
    ]},
    {"group": "Business processes (BPML)", "questions": [
        "Show the process hierarchy from 4.10.2.2 up to its value chain.",
        "What are the child steps of 4.10.2 Process Returns?",
        "Which process steps under Lead to Cash are specified by the most documents?",
        "Which process codes do documents cite that are not in the BPML hierarchy?",
        "Which documents specify process O-020-090?",
    ]},
    {"group": "Streams and categories", "questions": [
        "How many documents belong to each business stream?",
        "Which documents belong to both Lead to Cash and Record to Report?",
        "Which systems are mentioned in Procure to Pay documents?",
        "How many documents are in each category and format?",
    ]},
    {"group": "Paths and connections", "questions": [
        "What is the shortest route between Solvay@eCommerce and SAP S/4HANA?",
        "Which documents connect SAP GTS and SAP EWM?",
        "Show me the graph around the SOVOS system.",
    ]},
    {"group": "Traceability — which passages to read", "questions": [
        "Which passages in the SOVOS specification mention the digital signature?",
        "Which chunks mention both a SPARK ticket and SAP CPI?",
        "For each system, which document mentions it most, and where?",
    ]},
    {"group": "The graph itself", "questions": [
        "How many unique relationships are present in the knowledge graph and list each relationship name?",
    ]},
    {"group": "Beyond what the graph holds", "questions": [
        "What does the SOVOS specification say about the digital signature?",
        "Who approved the returns process?",
    ]},
]


class CypherDraft(BaseModel):
    """What the model returns."""

    answerable: bool = Field(description="False when the graph cannot answer the question at all.")
    cypher: str = Field(description="One read-only Cypher query. Empty when not answerable.")
    explanation: str = Field(description="One or two plain sentences: what the query finds and how.")
    assumptions: list[str] = Field(
        default_factory=list,
        description="Interpretations of the question the query depends on, e.g. which system code "
                    "a name was taken to mean. Empty when there were none.")


# --- the schema the model is given --------------------------------------------

_schema_cache: dict[str, str] = {}


def schema_text(graph: dict[str, Any] | None = None) -> str:
    """The graph described for the model, from the same batches Neo4j was
    loaded from -- so the description is of exactly what is in the database.
    Cached per build of the graph: it is also the cached prompt prefix."""
    from backend.graph import knowledge_graph as kg

    graph = graph or kg.extract_graph()
    key = graph.get("stats", {}).get("sources", "")
    if key in _schema_cache:
        return _schema_cache[key]

    by_label, by_type = n4.rows(graph)
    lines = ["# Node labels (count) and properties"]
    for label, batch in sorted(by_label.items(), key=lambda kv: -len(kv[1])):
        props: dict[str, str] = {}
        for r in batch:
            for k, v in r.items():
                props.setdefault(k, type(v).__name__)
        unique = f"; unique: id, {n4.KEY[label]}" if label in n4.KEY else ""
        lines.append(f"(:{label}) {len(batch)} — " + ", ".join(f"{k}: {t}" for k, t in sorted(props.items())) + unique)

    lines.append("\n# Relationship patterns (count) and their properties")
    for (src, rel, tgt), batch in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
        props = sorted({k for r in batch for k in r["p"]} - {"label"})
        lines.append(f"(:{src})-[:{rel}]->(:{tgt}) {len(batch)}" + (f" — {', '.join(props)}" if props else ""))

    systems = sorted(by_label.get("System", []), key=lambda r: r["code"])
    lines.append("\n# Values to filter on (use these exactly)")
    lines.append("System code / label / kind: " + "; ".join(f"{s['code']} = {s['label']} ({s.get('kind', '')})"
                                                           for s in systems))
    lines.append("Stream code / label: " + "; ".join(f"{s['code']} = {s['label']}"
                                                    for s in by_label.get("Stream", [])))
    cats = Counter(d.get("category") for d in by_label.get("Document", []))
    fmts = Counter(d.get("format") for d in by_label.get("Document", []))
    lines.append("Document.category: " + ", ".join(f"{c} ({n})" for c, n in cats.most_common()))
    lines.append("Document.format: " + ", ".join(f"{c} ({n})" for c, n in fmts.most_common()))
    methods = Counter(r["p"].get("method") for b in by_type.values() for r in b if r["p"].get("method"))
    lines.append("Relationship.method: " + ", ".join(sorted(m for m in methods)))
    procs = by_label.get("Process", [])
    dotted = [p["code"] for p in procs if p["code"][:1].isdigit()][:6]
    dashed = [p["code"] for p in procs if not p["code"][:1].isdigit()][:6]
    lines.append(f"Process.code comes in two forms: BPML numbers like {', '.join(dotted)} "
                 f"and dash codes like {', '.join(dashed)}. Process.description is the step's name.")
    lines.append("Spec.ticket looks like SPARK-22234. Chunk.chunk_key looks like PKG:10003882 "
                 "(category:row id); Chunk.heading_path is the section.")
    text = "\n".join(lines)
    _schema_cache.clear()
    _schema_cache[key] = text
    return text


SYSTEM = """You write Cypher for a Neo4j 5 graph of the Solvay SPARK SAP programme: its \
documents, the business streams and systems they mention, the BPML process hierarchy, \
SPARK tickets, and the passages (chunks) each document is split into.

How the graph was built, which decides what a query can mean:
- A document is linked to a stream, system, process or ticket when its text names it. \
MENTIONS_SYSTEM means "the document names the system", not that the system runs or \
integrates anything. The relationship's `mentions` counts how often; `chunks` lists up \
to five chunk keys that name it.
- A chunk MENTIONS an entity when that passage names it, so two entities named in the \
same chunk are discussed together; named in the same document only, they may not be.
- SUBPROCESS_OF points from a process step to its parent, up to a value chain like 4.0.
- The graph does not hold document text. A question about what a document *says* can \
only be answered as far as which documents and passages mention which entities; say so \
in the explanation, and return the chunk keys so the passages can be read.
- Ignore the bookkeeping label :_GraphMeta.

Write one query that is:
- read-only (MATCH, OPTIONAL MATCH, WITH, UNWIND, RETURN, ORDER BY, LIMIT, CALL {} \
subqueries, shortestPath) — never CREATE, MERGE, SET, DELETE, REMOVE, LOAD CSV or \
procedures that write;
- valid Neo4j 5 Cypher: COUNT { pattern } / EXISTS { pattern } rather than size() on a \
pattern; no deprecated syntax;
- exact about values: use the codes and categories listed in the schema. Match a name \
the user gives loosely with toLower(x.label) CONTAINS toLower('...') only when it does \
not correspond to a listed code;
- readable: RETURN named columns of properties (filename, code, label, ticket, \
chunk_key, heading_path) rather than whole nodes, unless the user asks to see the graph \
or a path — then return the path;
- bounded: add LIMIT 100 unless the query aggregates to a small result or the user asks \
for everything.

Put interpretations you had to make in `assumptions`. If the graph cannot answer the \
question at all, set answerable to false, leave cypher empty and explain why."""


def _examples() -> str:
    return "\n\n".join(f"// {ex['title']}\n{ex['query']}" for ex in n4.EXAMPLES)


# --- checking a query without running it ----------------------------------------


def check(cypher: str) -> str:
    """Plan the query with EXPLAIN in a READ transaction. Returns "" when it
    is valid and read-only, otherwise the reason, in the database's words."""
    from neo4j.exceptions import Neo4jError

    text = cypher.strip().rstrip(";")
    if not text:
        return "the query is empty"
    if text.upper().startswith(("EXPLAIN", "PROFILE")):
        return "return the query itself, without EXPLAIN or PROFILE"

    def work(tx):
        return tx.run("EXPLAIN " + text).consume().query_type

    try:
        with n4.driver().session(database=n4.DATABASE, default_access_mode="READ") as s:
            kind = s.execute_read(work)
    except Neo4jError as exc:
        return f"{exc.code}: {exc.message}"
    # 'r' read, 'rw' read-write, 'w' write, 's' schema. Only 'r' may run here.
    if kind != "r":
        return f"the query would modify the database (query type '{kind}'); it must be read-only"
    return ""


# --- generation -------------------------------------------------------------------


def _client():
    import anthropic

    return anthropic.Anthropic()


def generate(question: str) -> dict[str, Any]:
    """Write a Cypher query for `question`, checked against the database.

    Returns the draft, whether it passed the check, and each attempt's error --
    a failed final attempt is returned rather than raised, so the page can show
    the query and the reason and let the reader fix it by hand."""
    import anthropic

    question = question.strip()
    started = time.time()
    schema = schema_text()
    system = [{
        "type": "text",
        # Stable per build of the graph, so it is served from the prompt cache
        # after the first question.
        "text": f"{SYSTEM}\n\n{schema}\n\n# Queries known to work on this graph\n{_examples()}",
        "cache_control": {"type": "ephemeral"},
    }]
    messages: list[dict[str, Any]] = [{"role": "user", "content": question}]
    attempts: list[dict[str, Any]] = []
    draft: CypherDraft | None = None
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0}
    served_by = MODEL

    run = tracing.start_run("graph-nl-to-cypher", input={"question": question}, as_type="chain",
                            metadata={"model": MODEL, "effort": EFFORT,
                                      "schema_hash": hashlib.sha256(schema.encode()).hexdigest()[:12]},
                            tags=["cypher"])
    # Read before end(), which lets go of the trace. The question check
    # (graph_eval.py) scores each generation on its own trace.
    trace_id = run.trace_id
    try:
        with run.current():
            client = _client()
            for attempt in range(1, MAX_ATTEMPTS + 1):
                try:
                    response = client.beta.messages.parse(
                        model=MODEL,
                        max_tokens=16000,
                        thinking={"type": "adaptive"},
                        output_config={"effort": EFFORT},
                        system=system,
                        messages=messages,
                        output_format=CypherDraft,
                        betas=[FALLBACK_BETA],
                        fallbacks="default",
                    )
                except anthropic.RateLimitError:
                    raise RuntimeError("Claude is rate-limited right now; try again in a minute") from None
                except anthropic.APIConnectionError:
                    raise RuntimeError("could not reach the Claude API") from None
                for k in usage:
                    usage[k] += getattr(response.usage, k, 0) or 0
                served_by = response.model or served_by
                if response.stop_reason == "refusal":
                    raise RuntimeError("Claude declined to write a query for this question")
                if response.stop_reason == "max_tokens" or response.parsed_output is None:
                    raise RuntimeError("Claude's answer was cut off before it finished the query")
                draft = response.parsed_output
                if not draft.answerable:
                    attempts.append({"cypher": "", "error": ""})
                    break
                error = check(draft.cypher)
                attempts.append({"cypher": draft.cypher, "error": error})
                if not error:
                    break
                # Send the database's own complaint back, in the same
                # conversation, so the fix is to this query rather than a
                # fresh guess. The full content goes back, thinking included.
                messages += [
                    {"role": "assistant", "content": response.content},
                    {"role": "user", "content": (
                        f"Neo4j rejected that query when planning it:\n{error}\n\n"
                        "Correct it and return the whole query again.")},
                ]
    except Exception as exc:
        run.fail(exc)
        run.end()
        raise
    ok = bool(draft and (not draft.answerable or not attempts[-1]["error"]))
    out = {
        "question": question,
        "answerable": bool(draft and draft.answerable),
        "cypher": draft.cypher.strip().rstrip(";") if draft else "",
        "explanation": draft.explanation if draft else "",
        "assumptions": draft.assumptions if draft else [],
        "valid": ok,
        "error": "" if ok else (attempts[-1]["error"] if attempts else "no query was produced"),
        "attempts": len(attempts),
        "corrections": [a["error"] for a in attempts if a["error"]],
        "seconds": round(time.time() - started, 1),
        "usage": usage,
        "trace_id": trace_id,
    }
    run.end(output={**{k: out[k] for k in ("cypher", "valid", "attempts", "answerable")}, "model": served_by})
    return out


def main() -> None:
    q = " ".join(sys.argv[1:]) or "Which documents mention both SOVOS and SAP CPI?"
    print(json.dumps(generate(q), indent=2))


if __name__ == "__main__":
    main()
