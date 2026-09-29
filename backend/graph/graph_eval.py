"""Quality checks for the knowledge graph, shown on its Quality view.

    python -m backend.graph.graph_eval structure    # check the graph now, print the scores
    python -m backend.graph.graph_eval questions    # run the plain-English question check
    python -m backend.graph.graph_eval rescore      # re-compare the last check's queries, no model calls
    python -m backend.graph.graph_eval configs      # declare the score names to the tracing project

Two checks, run separately because they cost very different amounts.

THE GRAPH ITSELF (`structure`). Free, a few seconds, no model involved. The
graph is built by rules -- patterns and fixed lists -- so it cannot invent a
fact; what it can do is match wrongly, miss things, or drift out of date.

  Accuracy      every passage an edge cites really names the edge's target,
                read from the text retrieval serves rather than the graph's
                own bookkeeping
  Completeness  indexed documents that are in the graph; process codes that
                resolve against the BPML hierarchy; hierarchy parent links that
                are present as edges
  Consistency   edges between the right kinds of node; none dangling or
                duplicated; no loop in the process hierarchy; no process with
                two parents; no spec node whose "primary" flag contradicts its
                edges
  Structure     isolated nodes, the share in the largest connected part, and
                the hubs the Evidence Agent treats as weak links
  Freshness     whether the graph, and its Neo4j copy, were built from the
                corpus as it is now

PLAIN-ENGLISH QUESTIONS (`questions`). Claude writes a Cypher query for each
question in data/graph_eval_questions.json; the query is run and its rows are
compared with those of the reference query stored beside the question. This is
execution accuracy -- the standard way text-to-query systems are scored -- so
two differently written queries that return the same rows both count as right.
It makes one model call per question, so it runs only when asked.

Scores go to the tracing project the same way the agents' do (agent_eval.py),
under names prefixed `graph_` and `cypher_`, and every run is kept in Postgres
so the page can show the latest and what changed.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agents.agent_eval import Score, Spec, report
from backend.core.paths import DATA

logger = logging.getLogger(__name__)

QUESTIONS_FILE = DATA / "graph_eval_questions.json"

ACCURACY, COMPLETENESS, CONSISTENCY, STRUCTURE, FRESHNESS, QUESTIONS = (
    "Accuracy", "Completeness", "Consistency", "Structure", "Freshness",
    "Plain-English questions")
METRICS = (ACCURACY, COMPLETENESS, CONSISTENCY, STRUCTURE, FRESHNESS, QUESTIONS)

SCORES: dict[str, Spec] = {
    # --- accuracy
    "graph_evidence_validity": Spec(
        ACCURACY, "Cited passages name their target",
        "Of every passage an edge cites as its evidence, the share whose text -- as retrieval "
        "serves it -- really names the edge's target.", good="min", target=1.0, watch=0.98),
    # --- completeness
    "graph_documents_in_graph": Spec(
        COMPLETENESS, "Indexed documents in the graph",
        "Share of the documents in the retrieval index that also have a node in the graph.",
        good="min", target=1.0, watch=0.95),
    "graph_codes_resolved": Spec(
        COMPLETENESS, "Process codes found in BPML",
        "Share of the process codes documents cite that exist in the BPML hierarchy. The rest "
        "are kept, marked as not in BPML, and have no place in the hierarchy.",
        good="min", target=0.95, watch=0.85),
    "graph_hierarchy_complete": Spec(
        COMPLETENESS, "Hierarchy links present",
        "Of the processes whose parent the BPML hierarchy names, the share that have that "
        "parent link in the graph.", good="min", target=1.0),
    # --- consistency
    "graph_schema_conformance": Spec(
        CONSISTENCY, "Edges between the right kinds of node",
        "Share of edges whose relation connects the node types the model allows, e.g. "
        "Document -specifies process-> Process.", good="min", target=1.0),
    "graph_dangling_edges": Spec(
        CONSISTENCY, "Edges to a missing node", "Edges whose source or target node does not exist.",
        good="max", target=0),
    "graph_duplicate_edges": Spec(
        CONSISTENCY, "Duplicate edges", "The same relation between the same two nodes, recorded twice.",
        good="max", target=0),
    "graph_hierarchy_cycles": Spec(
        CONSISTENCY, "Loops in the process hierarchy",
        "Processes that are, through their parents, their own ancestor.", good="max", target=0),
    "graph_multiple_parents": Spec(
        CONSISTENCY, "Processes with two parents",
        "Processes with more than one parent in the hierarchy, which should be a tree.",
        good="max", target=0),
    "graph_property_conflicts": Spec(
        CONSISTENCY, "Contradicting properties",
        "Spec nodes whose 'primary' flag disagrees with their edges: flagged primary with no "
        "document implementing them, or implemented by a document but not flagged.",
        good="max", target=0),
    # --- structure
    "graph_isolated_nodes": Spec(
        STRUCTURE, "Unconnected nodes",
        "Nodes with no edge at all -- usually a document in which no known system, stream, "
        "ticket or process code was found, such as a template.", good="max", target=0, watch=20),
    "graph_largest_component": Spec(
        STRUCTURE, "Nodes in the main connected part",
        "Share of nodes that can reach one another through edges. A low share means the graph "
        "has broken into islands.", good="min", target=0.9, watch=0.8),
    "graph_hubs": Spec(
        STRUCTURE, "Hub nodes",
        "Nodes connected to so many others that a route through them says little. The Evidence "
        "Agent warns when a path passes through one."),
    # --- freshness
    "graph_current": Spec(
        FRESHNESS, "Graph built from the current corpus",
        "The graph's recorded inputs match the documents, BPML hierarchy and retrieval index as "
        "they are now.", boolean=True, good="min", target=1),
    "graph_neo4j_current": Spec(
        FRESHNESS, "Cypher copy is current",
        "The Neo4j copy used by the Cypher view holds this build of the graph.",
        boolean=True, good="min", target=1),
    # --- plain-English questions (aggregates, on the check's own trace)
    "cypher_execution_accuracy": Spec(
        QUESTIONS, "Right answer",
        "Of the questions the graph can answer, the share where the query Claude wrote returned "
        "the same rows as the reference query.", good="min", target=0.8, watch=0.6),
    "cypher_answerability_accuracy": Spec(
        QUESTIONS, "Knew what it could answer",
        "Share of questions where Claude correctly judged whether the graph can answer them at all.",
        good="min", target=0.95, watch=0.85),
    "cypher_valid_rate": Spec(
        QUESTIONS, "Queries that run",
        "Share of answerable questions where Claude produced a query Neo4j accepted.",
        good="min", target=1.0, watch=0.9),
    "cypher_first_try_rate": Spec(
        QUESTIONS, "Right first time",
        "Share of answerable questions where the first query written was accepted without "
        "correction.", good="min", target=0.9, watch=0.75),
    "cypher_empty_result_rate": Spec(
        QUESTIONS, "Queries that found nothing",
        "Share of accepted queries that returned no rows where the reference returned some -- "
        "usually a misspelt name or value.", good="max", target=0.05, watch=0.15),
    # --- per question, on each generation's own trace
    "cypher_execution_match": Spec(
        QUESTIONS, "Answer matched the reference", "Per question: same rows as the reference.",
        boolean=True, good="min", target=1),
    "cypher_answerability_correct": Spec(
        QUESTIONS, "Answerability judged right", "Per question: answerable judged correctly.",
        boolean=True, good="min", target=1),
}
SHARES = frozenset({"graph_evidence_validity", "graph_documents_in_graph", "graph_codes_resolved",
                    "graph_hierarchy_complete", "graph_schema_conformance",
                    "graph_largest_component", "cypher_execution_accuracy",
                    "cypher_answerability_accuracy", "cypher_valid_rate", "cypher_first_try_rate",
                    "cypher_empty_result_rate"})
PER_QUESTION = ("cypher_execution_match", "cypher_answerability_correct")

# Which node types each relation may connect.
SCHEMA = {
    "specifies_process": ("document", "process"),
    "subprocess_of": ("process", "process"),
    "mentions_system": ("document", "system"),
    "belongs_to": ("document", "stream"),
    "references_ticket": ("document", "spec"),
    "implements_ticket": ("document", "spec"),
}


def _report(scores: list[Score], trace_url: str = "") -> dict:
    return report(scores, trace_url, specs=SCORES, shares=SHARES, metrics=METRICS)


def _rate(name: str, part: int, whole: int, comment: str = "") -> list[Score]:
    if whole <= 0:
        return []
    return [Score(name, round(part / whole, 4), comment or f"{part} of {whole}")]


def _flag(name: str, ok: bool, comment: str = "") -> Score:
    return Score(name, 1.0 if ok else 0.0, comment)


# --- the graph itself -------------------------------------------------------------


def _chunk_texts(keys: set[str]) -> dict[str, str]:
    """Passage text by chunk key ("PKG:123"), as retrieval serves it."""
    from backend.rag import rag

    ids = sorted({int(k.rpartition(":")[2]) for k in keys if k.rpartition(":")[2].isdigit()})
    out: dict[str, str] = {}
    for i in range(0, len(ids), 2000):
        rows = rag.connection().execute(
            "SELECT id, category, content FROM rag_chunks WHERE id = ANY(%s)", (ids[i:i + 2000],)
        ).fetchall()
        out.update({f"{cat}:{cid}": content or "" for cid, cat, content in rows})
    return out


def _evidence(edges: list[dict]) -> list[Score]:
    from backend.graph import knowledge_graph as kg

    cited = [(e, k) for e in edges if e["source"].startswith("doc:") for k in e.get("chunks") or []]
    filename_only = sum(1 for e in edges if e.get("in_filename_only"))
    try:
        texts = _chunk_texts({k for _, k in cited})
    except Exception as exc:
        logger.warning("graph_eval: passage text unavailable: %s", exc)
        return []
    good = 0
    missing: Counter = Counter()
    for e, key in cited:
        text = texts.get(key)
        if text is None:
            missing["passage no longer in the index"] += 1
            continue
        found = kg._chunk_mentions([{"key": key, "content": text}], set())[1].get(key, {})
        code = e["target"].split(":", 1)[1]
        if e["target"] in found or (e["target"].startswith("proc:") and code in text):
            good += 1
        else:
            missing[e["relation"]] += 1
    detail = f"{good} of {len(cited)} cited passages name their target"
    if missing:
        detail += "; misses: " + ", ".join(f"{k} {v}" for k, v in missing.most_common())
    if filename_only:
        detail += f"; {filename_only} edges rest on the filename alone and cite no passage"
    return _rate("graph_evidence_validity", good, len(cited), detail)


def _completeness(nodes: dict[str, dict], edges: list[dict]) -> list[Score]:
    from backend.graph import knowledge_graph as kg

    out: list[Score] = []
    try:
        from backend.rag import coverage

        summary = coverage.collect(include_documents=False)["summary"]
        indexed, absent = summary["indexed"], summary.get("not_in_graph", 0)
        out += _rate("graph_documents_in_graph", indexed - absent, indexed,
                     f"{indexed - absent} of {indexed} indexed documents are in the graph")
    except Exception as exc:
        logger.warning("graph_eval: document coverage unavailable: %s", exc)

    procs = [n for n in nodes.values() if n["type"] == "process"]
    resolved = sum(1 for n in procs if n.get("in_bpml"))
    out += _rate("graph_codes_resolved", resolved, len(procs),
                 f"{resolved} of {len(procs)} process codes are in the BPML hierarchy; "
                 f"{len(procs) - resolved} are not")

    parents = kg.load_bpml_hierarchy().get("parent") or {}
    have = {(e["source"], e["target"]) for e in edges if e["relation"] == "subprocess_of"}
    expected = [(f"proc:{c}", f"proc:{parents[c]}") for c in (n["code"] for n in procs if n.get("in_bpml"))
                if parents.get(c)]
    present = sum(1 for pair in expected if pair in have)
    out += _rate("graph_hierarchy_complete", present, len(expected),
                 f"{present} of {len(expected)} parent links the BPML hierarchy names are in the graph")
    return out


def _consistency(nodes: dict[str, dict], edges: list[dict]) -> list[Score]:
    typed = [e for e in edges if e["source"] in nodes and e["target"] in nodes]
    dangling = len(edges) - len(typed)
    conform = sum(1 for e in typed if SCHEMA.get(e["relation"]) ==
                  (nodes[e["source"]]["type"], nodes[e["target"]]["type"]))
    pairs = Counter((e["source"], e["target"], e["relation"]) for e in edges)
    duplicates = sum(n - 1 for n in pairs.values() if n > 1)

    parent: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if e["relation"] == "subprocess_of":
            parent[e["source"]].append(e["target"])
    multi = sorted(p for p, ps in parent.items() if len(set(ps)) > 1)
    cyclic = set()
    for start in parent:
        seen, node = set(), start
        while node in parent and node not in seen:
            seen.add(node)
            node = parent[node][0]
        if node == start:
            cyclic.add(start)

    implemented = {e["target"] for e in edges if e["relation"] == "implements_ticket"}
    conflicts = sorted(n["ticket"] for n in nodes.values() if n["type"] == "spec"
                       and bool(n.get("is_primary")) != (n["id"] in implemented))
    return [
        *_rate("graph_schema_conformance", conform, len(typed),
               f"{conform} of {len(typed)} edges connect the node types their relation allows"),
        Score("graph_dangling_edges", float(dangling)),
        Score("graph_duplicate_edges", float(duplicates)),
        Score("graph_hierarchy_cycles", float(len(cyclic)),
              ", ".join(sorted(c.split(":", 1)[1] for c in cyclic))[:500]),
        Score("graph_multiple_parents", float(len(multi)),
              ", ".join(m.split(":", 1)[1] for m in multi)[:500]),
        Score("graph_property_conflicts", float(len(conflicts)),
              ("Primary flag disagrees with the edges for " + ", ".join(conflicts))[:500]
              if conflicts else ""),
    ]


def _structure(nodes: dict[str, dict], edges: list[dict]) -> list[Score]:
    from backend.agents.evidence.paths import HUB_DEGREE

    adj: dict[str, set[str]] = {n: set() for n in nodes}
    for e in edges:
        if e["source"] in adj and e["target"] in adj:
            adj[e["source"]].add(e["target"])
            adj[e["target"]].add(e["source"])
    isolated = sorted(n for n, a in adj.items() if not a)
    best, seen = 0, set()
    for n in adj:
        if n in seen:
            continue
        stack, size = [n], 0
        seen.add(n)
        while stack:
            cur = stack.pop()
            size += 1
            for nxt in adj[cur] - seen:
                seen.add(nxt)
                stack.append(nxt)
        best = max(best, size)
    degree = Counter({e: 0 for e in nodes})
    for e in edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    hubs = [(n, d) for n, d in degree.most_common() if d >= HUB_DEGREE]
    return [
        Score("graph_isolated_nodes", float(len(isolated)),
              ", ".join(nodes[n].get("label", n) for n in isolated[:15])),
        *_rate("graph_largest_component", best, len(nodes),
               f"{best} of {len(nodes)} nodes are connected to one another"),
        Score("graph_hubs", float(len(hubs)),
              (f"{HUB_DEGREE}+ connections: " + ", ".join(
                  f"{nodes[n].get('label', n)} ({d})" for n, d in hubs[:8])) if hubs else ""),
    ]


def _freshness(graph: dict) -> list[Score]:
    from backend.graph import knowledge_graph as kg

    out: list[Score] = []
    try:
        current = kg.current_fingerprint() == graph.get("stats", {}).get("sources")
        out.append(_flag("graph_current", current,
                         "" if current else "Rebuild the graph: its inputs have changed since it was built."))
    except Exception as exc:
        logger.warning("graph_eval: freshness unavailable: %s", exc)
    try:
        from backend.graph import kg_neo4j_load

        st = kg_neo4j_load.status()
        if st.get("reachable"):
            out.append(_flag("graph_neo4j_current", bool(st.get("current")),
                             "" if st.get("current") else "The Cypher copy holds an older build."))
    except Exception as exc:
        logger.warning("graph_eval: Neo4j status unavailable: %s", exc)
    return out


def check_structure(graph: dict | None = None) -> list[Score]:
    """Every graph-itself score for the corpus graph as it is served."""
    from backend.graph import knowledge_graph as kg

    graph = graph or kg.extract_graph()
    nodes = {n["id"]: n for n in graph["nodes"]}
    edges = graph["edges"]
    scores: list[Score] = []
    for part in (lambda: _evidence(edges), lambda: _completeness(nodes, edges),
                 lambda: _consistency(nodes, edges), lambda: _structure(nodes, edges),
                 lambda: _freshness(graph)):
        try:
            scores += part()
        except Exception as exc:  # one part failing must not hide the rest
            logger.warning("graph_eval: a structure check failed: %s", exc)
    return scores


# --- plain-English questions ------------------------------------------------------


def load_questions() -> dict:
    return json.loads(QUESTIONS_FILE.read_text())


def _norm(v: Any) -> frozenset[str]:
    """A result cell as the set of strings it can be recognised by. A node
    matches on any of its identifying properties, so a query returning the
    System node and one returning its code or label both count."""
    if v is None:
        return frozenset({"null"})
    if isinstance(v, bool):
        return frozenset({str(v).lower()})
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, dict):
        if v.get("_kind") == "node":
            return frozenset(str(v[k]).lower() for k in ("id", "code", "ticket", "filename", "label",
                                                        "chunk_key", "description") if v.get(k))
        if v.get("_kind") == "relationship":
            return frozenset({str(v.get("_type", "")).lower()})
        if v.get("_kind") == "path":
            return frozenset().union(*(_norm(n) for n in v.get("nodes", [])))
        return frozenset().union(*(_norm(x) for x in v.values())) if v else frozenset({"{}"})
    if isinstance(v, list):
        return frozenset().union(*(_norm(x) for x in v)) if v else frozenset({"[]"})
    return frozenset({str(v).strip().lower()})


def _within(cell: frozenset[str], pool: frozenset[str]) -> bool:
    """A reference value found as a whole word inside a longer answer value --
    "4.10.2.2" inside "4.10.2.2 Create & Save Return Order". Only for the
    open-ended questions ("values"): an answer is free to present a code with
    its name, and that is still the code."""
    import re

    for v in cell:
        if len(v) < 3:
            continue
        rx = re.compile(r"(?<![\w.-])" + re.escape(v) + r"(?![\w.-])")
        if any(rx.search(p) for p in pool if len(p) > len(v)):
            return True
    return False


def _hops(rows: list[list[Any]]) -> int | None:
    for row in rows:
        for cell in row:
            if isinstance(cell, dict) and cell.get("_kind") == "path":
                return len(cell.get("relationships", []))
            if isinstance(cell, list) and cell and all(isinstance(x, dict) and x.get("_kind") == "relationship"
                                                       for x in cell):
                return len(cell)
    return None


def compare(ref: list[list[Any]], got: list[list[Any]], mode: str) -> tuple[bool, float, str]:
    """(matched, share of reference rows found, a one-line reason)."""
    if mode == "length":
        a, b = _hops(ref), _hops(got)
        return (a is not None and a == b, 1.0 if a == b else 0.0,
                f"reference route {a} hops, answer {b if b is not None else 'no route'}")
    if not ref:
        return (not got, 1.0 if not got else 0.0,
                "reference is empty" + ("" if not got else f"; the answer returned {len(got)} rows"))
    if not got:
        return False, 0.0, f"the answer returned no rows; the reference has {len(ref)}"
    ref_rows = [[_norm(c) for c in r] for r in ref]
    got_rows = [[_norm(c) for c in r] for r in got]
    if mode == "values":
        pool = frozenset().union(*(c for r in got_rows for c in r))
        found = sum(1 for r in ref_rows if all(c & pool or _within(c, pool) for c in r))
        return (found == len(ref_rows), found / len(ref_rows),
                f"{found} of {len(ref_rows)} reference rows appear in the answer")
    used: set[int] = set()
    found = 0
    for r in ref_rows:
        for i, g in enumerate(got_rows):
            if i not in used and all(any(c & gc for gc in g) for c in r):
                used.add(i)
                found += 1
                break
    same = found == len(ref_rows) and len(got_rows) == len(ref_rows)
    return (same, found / len(ref_rows),
            f"{found} of {len(ref_rows)} reference rows matched; answer has {len(got_rows)} rows")


def ask_one(q: dict) -> dict:
    """Generate, run and compare one question. Never raises."""
    from backend.graph import kg_neo4j_load as n4
    from backend.graph import kg_nl2cypher

    out: dict[str, Any] = {"id": q["id"], "question": q["question"],
                           "expected_answerable": q["answerable"], "reference": q.get("cypher", ""),
                           "compare": q.get("compare", ""), "note": q.get("note", "")}
    started = time.time()
    try:
        gen = kg_nl2cypher.generate(q["question"])
    except Exception as exc:
        out.update(error=f"{type(exc).__name__}: {exc}", answerable=None, valid=False, attempts=0,
                   matched=False, answerability_correct=False, seconds=round(time.time() - started, 1))
        return out
    out.update(answerable=gen["answerable"], cypher=gen["cypher"], valid=gen["valid"],
               attempts=gen["attempts"], error=gen["error"], trace_id=gen.get("trace_id", ""),
               explanation=gen.get("explanation", ""))
    out["answerability_correct"] = gen["answerable"] == q["answerable"]
    if q["answerable"] and gen["answerable"] and gen["valid"]:
        try:
            ref = n4.query(q["cypher"])["rows"]
            got = n4.query(gen["cypher"])["rows"]
            matched, recall, why = compare(ref, got, q.get("compare", "rows"))
            out.update(reference_rows=len(ref), answer_rows=len(got), matched=matched,
                       recall=round(recall, 3), why=why)
        except Exception as exc:
            out.update(matched=False, why=f"could not run: {type(exc).__name__}: {exc}")
    else:
        out["matched"] = False if q["answerable"] else None
        out["why"] = ("correctly said the graph cannot answer this" if not q["answerable"] and not gen["answerable"]
                      else "wrote a query for a question the graph cannot answer" if not q["answerable"]
                      else "said the graph cannot answer this" if not gen["answerable"]
                      else f"no query Neo4j would accept: {gen['error']}")
    out["seconds"] = round(time.time() - started, 1)
    return out


def question_scores(results: list[dict]) -> list[Score]:
    answerable = [r for r in results if r["expected_answerable"]]
    tried = [r for r in answerable if r.get("answerable")]
    valid = [r for r in answerable if r.get("valid") and r.get("answerable")]
    first = [r for r in valid if r.get("attempts") == 1]
    matched = [r for r in answerable if r.get("matched")]
    right = [r for r in results if r.get("answerability_correct")]
    empty = [r for r in valid if r.get("answer_rows") == 0 and r.get("reference_rows")]
    return [
        *_rate("cypher_execution_accuracy", len(matched), len(answerable),
               f"{len(matched)} of {len(answerable)} answerable questions got the reference rows"),
        *_rate("cypher_answerability_accuracy", len(right), len(results),
               f"{len(right)} of {len(results)} judged answerable or not correctly"),
        *_rate("cypher_valid_rate", len(valid), len(answerable),
               f"{len(valid)} of {len(answerable)} produced a query Neo4j accepted"
               + (f" ({len(answerable) - len(tried)} were judged unanswerable)" if len(tried) < len(answerable) else "")),
        *_rate("cypher_first_try_rate", len(first), len(answerable),
               f"{len(first)} of {len(answerable)} accepted without a correction"),
        *_rate("cypher_empty_result_rate", len(empty), len(valid),
               f"{len(empty)} of {len(valid)} accepted queries returned nothing"),
    ]


# --- runs, storage and scores -----------------------------------------------------


def _conn():
    from backend.rag import rag

    conn = rag.connection()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS graph_quality_runs (
               id          text PRIMARY KEY,
               kind        text NOT NULL,
               status      text NOT NULL DEFAULT 'running',
               started_at  timestamptz NOT NULL DEFAULT now(),
               finished_at timestamptz,
               result      jsonb NOT NULL DEFAULT '{}'::jsonb,
               error       text NOT NULL DEFAULT ''
           )""")
    conn.execute("CREATE INDEX IF NOT EXISTS graph_quality_runs_kind_idx"
                 " ON graph_quality_runs (kind, started_at DESC)")
    conn.commit()
    return conn


def _save(run_id: str, kind: str, status: str, result: dict, error: str = "") -> None:
    conn = _conn()
    conn.execute(
        """INSERT INTO graph_quality_runs (id, kind, status, result, error, finished_at)
           VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result,
               error = EXCLUDED.error, finished_at = EXCLUDED.finished_at""",
        (run_id, kind, status, json.dumps(result, default=str), error,
         None if status == "running" else datetime.now(timezone.utc)))
    conn.commit()


# A question check whose process died is reported as abandoned, not running for ever.
STALE_AFTER = 1800


def latest(kind: str) -> dict | None:
    row = _conn().execute(
        "SELECT id, status, started_at, finished_at, result, error FROM graph_quality_runs"
        " WHERE kind = %s ORDER BY started_at DESC LIMIT 1", (kind,)).fetchone()
    if not row:
        return None
    status = row[1]
    if status == "running" and (datetime.now(timezone.utc) - row[2]).total_seconds() > STALE_AFTER:
        status = "abandoned"
    result = row[4] or {}
    if result.get("report", {}).get("scores"):   # re-read against today's targets
        result["report"] = _report([Score(r["name"], r["value"], r.get("comment") or "")
                                    for r in result["report"]["scores"] if r["name"] in SCORES],
                                   result["report"].get("trace_url", ""))
    return {"id": row[0], "status": status, "started_at": row[2].isoformat(),
            "finished_at": row[3].isoformat() if row[3] else None, "error": row[5], **result}


def _trace(name: str, output: dict) -> tuple[str, str]:
    from backend.core import tracing

    run = tracing.start_run(name, as_type="evaluator", tags=["graph-quality"])
    trace_id, url = run.trace_id, run.url()
    run.end(output=output)
    return trace_id, url


def _push(trace_id: str, scores: list[Score]) -> None:
    from backend.agents import agent_eval

    agent_eval.push(trace_id, scores, SCORES)


def run_structure() -> dict:
    """Check the graph now; store and return the result."""
    run_id = f"gq_{uuid.uuid4().hex[:10]}"
    started = time.time()
    scores = check_structure()
    trace_id, url = _trace("graph-quality-check", {s.name: s.value for s in scores})
    _push(trace_id, scores)
    result = {"report": _report(scores, url), "seconds": round(time.time() - started, 1)}
    _save(run_id, "structure", "done", result)
    return latest("structure") or result


_lock = threading.Lock()


def start_questions() -> str:
    """Start the question check in the background; returns its run id. Raises
    RuntimeError when one is already running."""
    with _lock:
        now = latest("questions")
        if now and now["status"] == "running":
            raise RuntimeError("a question check is already running")
        run_id = f"gq_{uuid.uuid4().hex[:10]}"
        data = load_questions()
        _save(run_id, "questions", "running",
              {"total": len(data["questions"]), "results": [], "reviewed": data.get("reviewed", False)})
    threading.Thread(target=_run_questions, args=(run_id, data), name="graph-question-check",
                     daemon=True).start()
    return run_id


def _run_questions(run_id: str, data: dict) -> dict:
    started = time.time()
    results: list[dict] = []
    base = {"total": len(data["questions"]), "reviewed": data.get("reviewed", False)}
    try:
        for q in data["questions"]:
            results.append(ask_one(q))
            _save(run_id, "questions", "running", {**base, "results": results})
        for r in results:   # per question, on the generation's own trace
            if r.get("trace_id"):
                per = [_flag("cypher_answerability_correct", bool(r.get("answerability_correct")))]
                if r["expected_answerable"]:
                    per.append(_flag("cypher_execution_match", bool(r.get("matched")), r.get("why", "")))
                _push(r["trace_id"], per)
        scores = question_scores(results)
        trace_id, url = _trace("graph-question-check", {s.name: s.value for s in scores})
        _push(trace_id, scores)
        out = {**base, "results": results, "report": _report(scores, url),
               "seconds": round(time.time() - started, 1)}
        _save(run_id, "questions", "done", out)
        return out
    except Exception as exc:
        logger.exception("graph question check failed")
        _save(run_id, "questions", "failed", {**base, "results": results},
              f"{type(exc).__name__}: {exc}")
        return {"error": str(exc)}


def rescore() -> dict | None:
    """Compare the latest question check's queries again, against today's
    reference file and comparison rules, without asking Claude anything. For
    when a reference is corrected or the comparison is improved."""
    from backend.graph import kg_neo4j_load as n4

    run = latest("questions")
    if not run or run["status"] != "done":
        return None
    refs = {q["id"]: q for q in load_questions()["questions"]}
    results = []
    for r in run["results"]:
        q = refs.get(r["id"])
        if q is None:
            continue
        r = {**r, "expected_answerable": q["answerable"], "reference": q.get("cypher", ""),
             "compare": q.get("compare", ""), "note": q.get("note", "")}
        r["answerability_correct"] = r.get("answerable") == q["answerable"]
        if q["answerable"] and r.get("answerable") and r.get("valid") and r.get("cypher"):
            ref = n4.query(q["cypher"])["rows"]
            got = n4.query(r["cypher"])["rows"]
            matched, recall, why = compare(ref, got, q.get("compare", "rows"))
            r.update(reference_rows=len(ref), answer_rows=len(got), matched=matched,
                     recall=round(recall, 3), why=why)
        results.append(r)
    scores = question_scores(results)
    trace_id, url = _trace("graph-question-check", {s.name: s.value for s in scores})
    _push(trace_id, scores)
    out = {"total": len(results), "reviewed": load_questions().get("reviewed", False),
           "results": results, "report": _report(scores, url), "seconds": run.get("seconds"),
           "rescored_from": run["id"]}
    _save(f"gq_{uuid.uuid4().hex[:10]}", "questions", "done", out)
    return out


def main() -> None:
    cmd = sys.argv[1:2]
    if cmd == ["structure"]:
        r = run_structure()
        for s in r["report"]["scores"]:
            print(f"  {(s['status'] or 'info'):6} {s['label']:42} {s['value']:<8g} {s['comment'][:90]}")
    elif cmd == ["questions"]:
        data = load_questions()
        run_id = f"gq_{uuid.uuid4().hex[:10]}"
        _save(run_id, "questions", "running", {"total": len(data["questions"]), "results": []})
        out = _run_questions(run_id, data)
        for r in out.get("results", []):
            print(f"  {r['id']:4} {'match' if r.get('matched') else '-':6} {r.get('why', '')[:90]}")
        for s in out.get("report", {}).get("scores", []):
            print(f"  {s['label']:30} {s['value']:<8g} {s['comment']}")
    elif cmd == ["rescore"]:
        out = rescore()
        if not out:
            print("No finished question check to rescore.")
            sys.exit(1)
        for s in out["report"]["scores"]:
            print(f"  {s['label']:30} {s['value']:<8g} {s['comment']}")
    elif cmd == ["configs"]:
        from backend.agents.agent_eval import push_configs

        print(f"{push_configs(SCORES, SHARES)} score config(s) created.")
    else:
        print(__doc__.split("\n\n")[1])
        sys.exit(2)


if __name__ == "__main__":
    main()
