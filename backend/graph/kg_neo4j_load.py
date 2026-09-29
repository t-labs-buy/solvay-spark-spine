"""Load the knowledge graph into Neo4j, and query it with Cypher.

knowledge_graph.json is the source of truth; Neo4j holds a copy of it so it can
be queried with Cypher and explored in Neo4j Browser. The copy is rebuilt from
the JSON whole, never edited in place, so the two cannot drift: a load deletes
what is there and writes the current graph, and records which build it wrote
(the graph's `stats.sources` fingerprint) so a stale copy can be recognised.

What goes in is `knowledge_graph.property_graph()` -- the entity layer and the
passage layer together:

  (:Stream) (:System) (:Document) (:Process) (:Spec) (:Chunk)
  (:Document)-[:BELONGS_TO|MENTIONS_SYSTEM|SPECIFIES_PROCESS|
               IMPLEMENTS_TICKET|REFERENCES_TICKET|HAS_CHUNK]->(...)
  (:Process)-[:SUBPROCESS_OF]->(:Process)
  (:Chunk)-[:MENTIONS {count}]->(:Stream|:System|:Process|:Spec)

Every node keeps the graph's own `id` ("system:SOVOS", "chunk:PKG:10003882"),
unique per label, so a Cypher result can be matched back to the page, the
agents' tool calls and the traceability view. Presentation (`color`, `size`,
`degree`) is not loaded: Neo4j computes degree itself, e.g.
`COUNT { (n)--() }`.

One bookkeeping node, (:_GraphMeta), records the load. It is prefixed so it
sorts apart from the data labels and is easy to exclude.

Usage:
  .venv/bin/python -m backend.graph.kg_neo4j_load            load if the copy is stale
  .venv/bin/python -m backend.graph.kg_neo4j_load --force    reload regardless
  .venv/bin/python -m backend.graph.kg_neo4j_load --status
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any


from backend.rag import rag  # noqa: E402,F401  -- loads .env, which carries the NEO4J_* settings

URI = os.environ.get("NEO4J_URI", "bolt://127.0.0.1:7687")
USER = os.environ.get("NEO4J_USER", "neo4j")
PASSWORD = os.environ.get("NEO4J_PASSWORD", "")
DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")
BROWSER_URL = os.environ.get("NEO4J_BROWSER_URL", "http://localhost:7474/browser/")

LABEL = {"stream": "Stream", "system": "System", "document": "Document",
         "process": "Process", "spec": "Spec", "chunk": "Chunk"}
# The property that identifies a node of each label, besides its `id`.
KEY = {"Stream": "code", "System": "code", "Document": "filename",
       "Process": "code", "Spec": "ticket", "Chunk": "chunk_key"}
# Drawn by the page, derived by Neo4j, or already a relationship.
SKIP_NODE = {"type", "color", "size", "degree"}
SKIP_REL = {"id", "source", "target", "relation"}
BATCH = 2000

# What a Cypher query from the page may do. Queries run in READ transactions,
# which the server refuses to write in; these bound the rest.
MAX_ROWS = 1000
QUERY_TIMEOUT = 20.0

# Starting points for the Cypher view, served by status(). Each one is run by
# test_neo4j.py against the loaded graph, so a rename in the model cannot leave
# an example that returns nothing or fails.
EXAMPLES: list[dict[str, str]] = [
    {"title": "What is in the graph",
     "query": "MATCH (n) WHERE NOT n:_GraphMeta\nRETURN labels(n)[0] AS label, count(*) AS nodes\nORDER BY nodes DESC"},
    {"title": "Relationship types and counts",
     "query": "MATCH (a)-[r]->(b)\nRETURN labels(a)[0] AS from, type(r) AS relationship, labels(b)[0] AS to, count(*) AS n\nORDER BY n DESC"},
    {"title": "Unique relationship types",
     "query": "MATCH ()-[r]->()\nRETURN type(r) AS relationship, count(*) AS relationships\nORDER BY relationships DESC"},
    {"title": "Most-mentioned systems",
     "query": "MATCH (d:Document)-[r:MENTIONS_SYSTEM]->(s:System)\n"
              "RETURN s.label AS system, s.kind AS kind, count(d) AS documents, sum(r.mentions) AS mentions\n"
              "ORDER BY documents DESC"},
    {"title": "Documents naming SOVOS and CPI, with the passages",
     "query": "MATCH (d:Document)-[:MENTIONS_SYSTEM]->(:System {code: 'SOVOS'}),\n"
              "      (d)-[:MENTIONS_SYSTEM]->(:System {code: 'CPI'}),\n"
              "      (d)-[:HAS_CHUNK]->(c:Chunk)-[:MENTIONS]->(:System {code: 'SOVOS'})\n"
              "RETURN d.filename AS document, collect(c.chunk_key) AS chunks"},
    {"title": "Passages naming S/4HANA and Salesforce together",
     "query": "MATCH (d:Document)-[:HAS_CHUNK]->(c:Chunk),\n"
              "      (c)-[:MENTIONS]->(:System {code: 'S4HANA'}),\n"
              "      (c)-[:MENTIONS]->(:System {code: 'Salesforce'})\n"
              "RETURN d.filename AS document, c.chunk_key AS chunk, c.heading_path AS section\nLIMIT 25"},
    {"title": "A process step up to its value chain",
     "query": "MATCH p = (:Process {code: '4.10.2.2'})-[:SUBPROCESS_OF*]->(top:Process)\n"
              "WHERE NOT (top)-[:SUBPROCESS_OF]->()\n"
              "RETURN [n IN nodes(p) | n.code + ' ' + n.description] AS chain"},
    {"title": "Primary specifications and the systems they name",
     "query": "MATCH (d:Document)-[:IMPLEMENTS_TICKET]->(t:Spec)\n"
              "OPTIONAL MATCH (d)-[:MENTIONS_SYSTEM]->(s:System)\n"
              "RETURN t.ticket AS ticket, d.filename AS document, collect(s.code) AS systems\nORDER BY ticket"},
    {"title": "Process codes documents cite that BPML does not hold",
     "query": "MATCH (d:Document)-[:SPECIFIES_PROCESS]->(p:Process {in_bpml: false})\n"
              "RETURN p.code AS code, p.description AS description, count(d) AS documents\n"
              "ORDER BY documents DESC LIMIT 25"},
    {"title": "Shortest route between two systems",
     "query": "MATCH p = shortestPath((a:System {code: 'eCommerce'})-[:MENTIONS_SYSTEM*..4]-(b:System {code: 'S4HANA'}))\n"
              "RETURN p"},
]

_driver = None
_lock = threading.Lock()


def configured() -> tuple[bool, str]:
    if not PASSWORD:
        return False, "NEO4J_PASSWORD is not set in .env"
    try:
        import neo4j  # noqa: F401
    except ImportError:
        return False, "the neo4j Python driver is not installed (pip install neo4j)"
    return True, ""


def driver():
    global _driver
    with _lock:
        if _driver is None:
            import logging

            from neo4j import GraphDatabase

            # A query's notifications are returned with its result; they need
            # not also be logged on every call.
            logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)

            _driver = GraphDatabase.driver(URI, auth=(USER, PASSWORD),
                                           connection_timeout=5, max_transaction_retry_time=5)
        return _driver


# --- building the rows --------------------------------------------------------


def rows(graph: dict[str, Any]) -> tuple[dict[str, list[dict]], dict[tuple[str, str, str], list[dict]]]:
    """The property graph as Neo4j write batches: nodes by label, and
    relationships by (source label, TYPE, target label) so each batch can
    MATCH both ends through a label's `id` constraint."""
    from backend.graph import knowledge_graph as kg

    nodes, edges = kg.property_graph(graph)
    label_of: dict[str, str] = {}
    by_label: dict[str, list[dict]] = defaultdict(list)
    for n in nodes:
        label = LABEL[n["type"]]
        label_of[n["id"]] = label
        by_label[label].append({k: v for k, v in n.items()
                                if k not in SKIP_NODE and v is not None and not isinstance(v, dict)})
    by_type: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for e in edges:
        src, tgt = label_of.get(e["source"]), label_of.get(e["target"])
        if not src or not tgt:
            continue  # an edge to a node that is not in the graph is not loaded
        props = {k: v for k, v in e.items() if k not in SKIP_REL and v is not None}
        by_type[(src, e["relation"].upper(), tgt)].append({"s": e["source"], "t": e["target"], "p": props})
    return dict(by_label), dict(by_type)


# --- loading ------------------------------------------------------------------


def loaded(session=None) -> dict[str, Any] | None:
    """What the database holds, from its bookkeeping node."""
    def read(tx):
        rec = tx.run("MATCH (m:_GraphMeta) RETURN m LIMIT 1").single()
        return dict(rec["m"]) if rec else None
    if session is not None:
        return session.execute_read(read)
    with driver().session(database=DATABASE) as s:
        return s.execute_read(read)


def load(graph: dict[str, Any] | None = None, force: bool = False) -> dict[str, Any]:
    """Write the graph into Neo4j, replacing what is there. Skipped when the
    database already holds this build, unless `force`."""
    from backend.graph import knowledge_graph as kg

    graph = graph or kg.extract_graph()
    fingerprint = graph.get("stats", {}).get("sources", "")
    started = time.time()
    with driver().session(database=DATABASE) as s:
        meta = loaded(s)
        if meta and meta.get("sources") == fingerprint and not force:
            return {"status": "current", **meta}

        by_label, by_type = rows(graph)
        # Constraints first: they are also the indexes the relationship
        # MATCHes below go through. Community edition has uniqueness
        # constraints (node keys are Enterprise).
        for label, key in KEY.items():
            s.run(f"CREATE CONSTRAINT {label.lower()}_id IF NOT EXISTS "
                  f"FOR (n:{label}) REQUIRE n.id IS UNIQUE").consume()
            s.run(f"CREATE CONSTRAINT {label.lower()}_{key} IF NOT EXISTS "
                  f"FOR (n:{label}) REQUIRE n.{key} IS UNIQUE").consume()

        # Replace, never merge: a node deleted from the graph must not linger.
        s.run("MATCH (n) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS").consume()

        for label, batch in sorted(by_label.items()):
            for i in range(0, len(batch), BATCH):
                s.run(f"UNWIND $rows AS r CREATE (n:{label}) SET n = r",
                      rows=batch[i:i + BATCH]).consume()
        for (src, rel, tgt), batch in sorted(by_type.items()):
            for i in range(0, len(batch), BATCH):
                s.run(f"UNWIND $rows AS r "
                      f"MATCH (a:{src} {{id: r.s}}) MATCH (b:{tgt} {{id: r.t}}) "
                      f"CREATE (a)-[x:{rel}]->(b) SET x = r.p",
                      rows=batch[i:i + BATCH]).consume()

        n_nodes = sum(len(b) for b in by_label.values())
        n_rels = sum(len(b) for b in by_type.values())
        meta = {"sources": fingerprint, "nodes": n_nodes, "relationships": n_rels,
                "loaded_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "seconds": round(time.time() - started, 1)}
        s.run("CREATE (m:_GraphMeta) SET m = $meta", meta=meta).consume()
    return {"status": "loaded", **meta}


def status() -> dict[str, Any]:
    """Whether Neo4j is reachable, what it holds, and whether that is the
    current build of the graph."""
    ok, why = configured()
    out: dict[str, Any] = {"configured": ok, "uri": URI, "browser": BROWSER_URL, "examples": EXAMPLES,
                           "max_rows": MAX_ROWS, "timeout": QUERY_TIMEOUT}
    if not ok:
        return {**out, "reachable": False, "detail": why}
    try:
        driver().verify_connectivity()
        meta = loaded()
    except Exception as exc:
        return {**out, "reachable": False,
                "detail": f"Neo4j is not reachable at {URI} ({type(exc).__name__}). "
                          "Start it with: docker compose -f compose.neo4j.yml up -d"}
    from backend.graph import knowledge_graph as kg

    current = kg.extract_graph().get("stats", {}).get("sources", "")
    return {**out, "reachable": True, "loaded": meta,
            "current": bool(meta) and meta.get("sources") == current,
            "detail": "" if meta else "Neo4j is running but the graph has not been loaded yet."}


def sync_in_background(force: bool = False, wait: float = 120.0) -> None:
    """Load on a daemon thread, logging rather than raising: a rebuild of the
    graph must not wait for, or fail because of, its Neo4j copy.

    Retries while Neo4j is still starting -- run.sh starts the container and
    the app together, and Neo4j takes a while longer to take connections --
    and gives up after `wait` seconds."""
    import logging

    def run():
        log = logging.getLogger("solvay_spark_spine.neo4j")
        if not configured()[0]:
            return
        deadline = time.time() + wait
        while True:
            try:
                r = load(force=force)
                log.info("Neo4j copy of the graph: %s", r.get("status"))
                return
            except Exception as exc:
                from neo4j.exceptions import ServiceUnavailable

                if isinstance(exc, ServiceUnavailable) and time.time() < deadline:
                    time.sleep(5)
                    continue
                log.info("Neo4j copy of the graph not refreshed: %s", exc)
                return

    threading.Thread(target=run, name="neo4j-sync", daemon=True).start()


# --- querying -----------------------------------------------------------------


def _value(v: Any) -> Any:
    """A Cypher value as JSON: nodes and relationships keep their labels, type
    and the graph's own ids, so a row can be traced back into the app."""
    from neo4j.graph import Node, Path, Relationship

    if isinstance(v, Node):
        return {"_kind": "node", "_labels": sorted(v.labels), **dict(v)}
    if isinstance(v, Relationship):
        return {"_kind": "relationship", "_type": v.type,
                "_start": (v.start_node or {}).get("id") if v.start_node else None,
                "_end": (v.end_node or {}).get("id") if v.end_node else None, **dict(v)}
    if isinstance(v, Path):
        return {"_kind": "path", "nodes": [_value(n) for n in v.nodes],
                "relationships": [_value(r) for r in v.relationships]}
    if isinstance(v, list):
        return [_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _value(x) for k, x in v.items()}
    if hasattr(v, "iso_format"):
        return v.iso_format()
    return v


def query(text: str, params: dict[str, Any] | None = None, limit: int = MAX_ROWS) -> dict[str, Any]:
    """Run one Cypher query in a READ transaction and return its rows.

    Read-only is enforced by the server, not by inspecting the text: a write
    in a read transaction is refused with Neo.ClientError.Statement.AccessMode.
    Rows beyond `limit` are not fetched, and the query is cancelled after
    QUERY_TIMEOUT seconds, so a runaway pattern cannot hold the database."""
    from neo4j import unit_of_work

    limit = max(1, min(int(limit or MAX_ROWS), MAX_ROWS))
    started = time.time()

    @unit_of_work(timeout=QUERY_TIMEOUT)
    def work(tx):
        result = tx.run(text, params or {})
        keys = list(result.keys())
        out, truncated = [], False
        for rec in result:
            if len(out) >= limit:
                truncated = True
                break
            out.append([_value(rec[k]) for k in keys])
        summary = result.consume()
        return keys, out, truncated, summary

    with driver().session(database=DATABASE, default_access_mode="READ") as s:
        keys, out, truncated, summary = s.execute_read(work)
    return {
        "columns": keys, "rows": out, "truncated": truncated, "limit": limit,
        "ms": round((time.time() - started) * 1000),
        "notifications": [getattr(n, "description", str(n)) for n in (summary.summary_notifications or [])][:5],
    }


def main() -> None:
    import json

    ok, why = configured()
    if not ok:
        sys.exit(why)
    if "--status" in sys.argv:
        print(json.dumps(status(), indent=2, default=str))
        return
    r = load(force="--force" in sys.argv)
    print(json.dumps(r, indent=2, default=str))


if __name__ == "__main__":
    main()
