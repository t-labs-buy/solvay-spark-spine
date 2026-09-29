"""The only window InsightLens has onto the corpus (handover §4.1).

Every tool wraps something that already exists -- rag.search for retrieval,
knowledge_graph for identity, bpml for scope -- and adds two things the agent
needs and the existing code has no reason to provide: a retrieval log, so the
verifier can prove a cited chunk was actually returned in this run, and
holdout masking, so an evaluation run cannot read the answer key off a file
path (§8.3).
"""

from __future__ import annotations

import fnmatch
import re
import sys
import threading
from urllib.parse import urlparse
from dataclasses import dataclass, field
from pathlib import Path


from backend.graph import knowledge_graph  # noqa: E402
from backend.rag import rag  # noqa: E402
from backend.core import uploads  # noqa: E402
from backend.agents.guardrails import web  # noqa: E402

from . import bpml  # noqa: E402

# --- holdout (§8.3) -----------------------------------------------------------
# The corpus contains the answer key: a fit register names the verdict, and a
# path like "3. GAPs - Development/..." gives it away without being read. In
# holdout mode the registers are excluded and the tell-tale tokens are stripped
# from everything the agent sees. Originals are kept for scoring.

HOLDOUT_DOC_GLOBS = (
    "*L2C - Fits*", "*Reports listed as FITs and GAPs*", "*FITs with missing description*",
    "*- Fits.*", "*Fit-Gap*", "*FitGap*",
)
HOLDOUT_PATH_GLOBS = ("*FITs - Config*", "*GAPs - Development*", "*/2. FIT*", "*/3. GAP*")
_LABEL_TOKEN = re.compile(r"\b(FITs?|GAPs?|Fits?|Gaps?)\b")


def _matches(text: str, globs: tuple[str, ...]) -> bool:
    low = text.lower()
    return any(fnmatch.fnmatch(low, g.lower()) for g in globs)


def is_held_out(doc: str, source: str = "") -> bool:
    return _matches(doc, HOLDOUT_DOC_GLOBS) or _matches(source or doc, HOLDOUT_PATH_GLOBS)


def mask_label(text: str) -> str:
    """Blank the FIT/GAP tokens that encode the verdict, leaving the rest of
    the name legible so the agent can still tell two documents apart."""
    return _LABEL_TOKEN.sub("•••", text or "")


# --- the retrieval log --------------------------------------------------------


@dataclass
class ToolCall:
    name: str
    arguments: dict
    summary: str
    ms: int = 0
    error: str | None = None
    # Which store the call read; see describe_sources.
    sources: dict = field(default_factory=dict)
    # What the call returned, bounded and in a shape the page can render.
    # See backend/agents/fitgap/trace.py. None for a failed call, and for the tools that
    # return an inventory rather than evidence.
    trace: dict | None = None


@dataclass
class Session:
    """One agent run over one BPML step. Not shared between steps: the
    'cite only what you retrieved' rule is scoped to a single register entry."""

    holdout: bool = False
    doc_exclude: tuple[str, ...] = ()
    # Document categories this run may read. Empty means every one of them.
    # It is a property of the session, not of a tool call, so the model cannot
    # widen it by asking for a category the person did not choose.
    categories: tuple[str, ...] = ()
    # An upload session id, when the analyst attached documents of their own to
    # this InsightLens session. Like `categories` it belongs to the session, not to
    # a tool call: the model cannot reach another analyst's upload by asking.
    uploads: str = ""
    # Which attached role is the SUBJECT of this run -- "as_is" for a country
    # run, "sap_bp" for a Best Practice one. Empty means the caller has only
    # one kind of subject and the tool's own default applies. It is a property
    # of the session for the same reason the two above are: the run decides
    # what it is about, not the model mid-conversation. The role is stored
    # rather than the subject key, so this module needs no rollout import.
    subject_role: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    # chunk id -> the record the agent was shown, for the verifier
    retrieved: dict[str, dict] = field(default_factory=dict)
    # For the web-search gate (backend/agents/guardrails/web.py): the web is a fallback for a
    # gap the corpus left, so it opens only once the corpus has been searched,
    # and only a few times per run.
    corpus_searches: int = 0
    web_searches: int = 0
    web_log: list[dict] = field(default_factory=list)
    masked_docs: set[str] = field(default_factory=set)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def close(self) -> None:
        """Release this thread's database connections.

        A session used to hold one connection of its own. Retrieval now goes
        through rag.search, which keeps one per thread, so there is nothing
        session-specific left to close -- but a worker thread finishing with a
        session should still let go of what it has."""
        rag.close()
        uploads.close()

    def excluded(self, doc: str, source: str = "") -> bool:
        if self.doc_exclude and _matches(doc, tuple(self.doc_exclude)):
            return True
        return self.holdout and is_held_out(doc, source)

    def present(self, doc: str) -> str:
        if not self.holdout:
            return doc
        shown = mask_label(doc)
        if shown != doc:
            self.masked_docs.add(doc)
        return shown

    def record(self, call: ToolCall) -> None:
        with self._lock:
            self.calls.append(call)


# --- the tools ----------------------------------------------------------------

MAX_CHUNK_CHARS = 2400


def get_scope(session: Session, bpml_code: str) -> dict:
    p = bpml.get(bpml_code)
    if not p:
        near = [x.brief() for x in bpml.search(bpml_code, limit=5)]
        return {"error": f"'{bpml_code}' is not a code in the BPML sheet", "did_you_mean": near}
    return {
        "process": p.full(),
        "parent": bpml.get(p.parent).brief() if p.parent and bpml.get(p.parent) else None,
        "children": [c.brief() for c in bpml.children(p.code)],
        "ancestry": [a.brief() for a in _ancestry(p)],
    }


def _ancestry(p: bpml.Process) -> list[bpml.Process]:
    out: list[bpml.Process] = []
    cur = p.parent
    while cur:
        q = bpml.get(cur)
        if not q:
            break
        out.append(q)
        cur = q.parent
    return list(reversed(out))


def search_corpus(session: Session, query: str, k: int = 8, filters: dict | None = None) -> dict:
    """Hybrid retrieval only -- vector + BM25 + RRF, no answer generation.
    Over-fetches when a filter is active so a held-out document does not
    silently cost the agent a slot."""
    session.corpus_searches += 1
    filters = filters or {}
    include = tuple(filters.get("doc_include") or ())
    exclude = tuple(filters.get("doc_exclude") or ())
    k = max(1, min(int(k or 8), 12))
    want = k * 3 if (include or exclude or session.holdout or session.doc_exclude) else k

    # No `conn`: retrieval covers every category the session allows.
    # The session's scope wins over anything in `filters` -- a filter may
    # narrow it further but never reach outside it.
    asked = filters.get("categories") or []
    scope = [c for c in asked if not session.categories or c.upper() in session.categories]
    if session.categories and not scope:
        scope = list(session.categories)
    hits = rag.search(query, k=want, mode=filters.get("mode", "hybrid"), categories=scope or None)
    results = []
    dropped = 0
    for h in hits:
        if session.excluded(h.title, h.source) or (exclude and _matches(h.title, exclude)):
            dropped += 1
            continue
        if include and not _matches(h.title, include):
            continue
        cid = h.key  # "PKG:412": the row id, and the category it is filed under
        rec = {
            "chunk_id": cid,
            "doc": session.present(h.title),
            "heading_path": session.present(h.heading_path),
            "text": h.content[:MAX_CHUNK_CHARS],
            "score": round(h.score, 5),
            "vector_rank": h.vector_rank,
            "keyword_rank": h.keyword_rank,
        }
        session.retrieved[cid] = {**rec, "full_text": h.content, "true_doc": h.title,
                                  "true_heading_path": h.heading_path, "source": h.source,
                                  "category": h.category}
        results.append(rec)
        if len(results) >= k:
            break
    out: dict = {"query": query, "results": results}
    if dropped:
        out["note"] = f"{dropped} result(s) withheld by the evaluation holdout"
    return out


def search_uploads(session: Session, query: str, k: int = 8, filters: dict | None = None) -> dict:
    """Hybrid retrieval over the documents the analyst attached to THIS session.

    Deliberately a separate tool from search_corpus rather than another
    category of it. The upload is not part of the corpus -- it is the thing
    being compared against the corpus -- and one ranked list mixing the two
    would let an uploaded sentence be cited as what the project decided."""
    session.corpus_searches += 1
    if not session.uploads:
        return {"error": "no documents were attached to this session"}
    filters = filters or {}
    exclude = tuple(filters.get("doc_exclude") or ())
    k = max(1, min(int(k or 8), 12))
    hits = uploads.search(session.uploads, query, k=k * 2 if exclude else k,
                          mode=filters.get("mode", "hybrid"))
    results = []
    dropped = 0
    for h in hits:
        # An evaluation run masks the corpus's answer key; a document attached
        # to that run is no more exempt from it than a corpus document is.
        if session.excluded(h.title, h.source):
            dropped += 1
            continue
        if exclude and _matches(h.title, exclude):
            continue
        rec = {
            "chunk_id": h.key,
            "doc": session.present(h.title),
            "heading_path": session.present(h.heading_path),
            "text": h.content[:MAX_CHUNK_CHARS],
            "score": round(h.score, 5),
            "vector_rank": h.vector_rank,
            "keyword_rank": h.keyword_rank,
            "uploaded": True,
        }
        session.retrieved[h.key] = {**rec, "full_text": h.content, "true_doc": h.title,
                                    "true_heading_path": h.heading_path, "source": h.source,
                                    "category": h.category}
        results.append(rec)
        if len(results) >= k:
            break
    out: dict = {"query": query, "results": results, "scope": "uploaded documents"}
    if dropped:
        out["note"] = f"{dropped} result(s) withheld by the evaluation holdout"
    if not results:
        out["note"] = ("the uploaded documents contain nothing matching this query; "
                       "they are one analyst's attachment, not the corpus")
    return out


def upload_entities(session: Session, only: str | None = None) -> dict:
    """The entities the uploaded documents mention, each marked according to
    whether the corpus already knows it.

    This is what an upload is for. An entity the corpus knows is a thread to
    pull -- search_corpus for it and read what the project decided about it --
    and one it does not is either genuinely new or called something else here,
    which is itself worth saying in the entry."""
    if not session.uploads:
        return {"error": "no documents were attached to this session"}
    cmp = uploads.compare(session.uploads, categories=session.categories)
    want = (only or "").strip().lower()
    items = cmp["entities"]
    if want == "shared":
        items = [e for e in items if e["in_corpus"]]
    elif want == "new":
        items = [e for e in items if not e["in_corpus"]]
    return {
        "documents": [session.present(d["label"]) for d in cmp["documents"]],
        "shared": cmp["shared"],
        "new": cmp["new"],
        "entities": [{**e, "label": session.present(e["label"]),
                      "corpus_documents": [session.present(d) for d in e["corpus_documents"]]}
                     for e in items[:60]],
        "truncated": len(items) > 60,
        # "New" is relative to the scope, so the scope has to be stated.
        "note": (f"'In corpus' means the {', '.join(session.categories)} corpus this run may "
                 "read; an entity elsewhere in the corpus counts as new here."
                 if session.categories else ""),
    }


def get_chunk(session: Session, chunk_id: str) -> dict:
    # An uploaded chunk is keyed "UPLOAD:12" and lives in the session's own
    # schema, which rag.chunk cannot reach -- UPLOAD names no database.
    if str(chunk_id).upper().startswith(uploads.CATEGORY + ":"):
        if not session.uploads:
            return {"error": "no documents were attached to this session"}
        row = uploads.chunk(session.uploads, str(chunk_id).split(":", 1)[1])
        if not row:
            return {"error": f"chunk {chunk_id} is not in this session's uploads"}
        if session.excluded(row["title"], row["source"]):
            return {"error": f"chunk {chunk_id} is in a document withheld by the evaluation holdout"}
        cid = f"{uploads.CATEGORY}:{row['chunk_id']}"
        rec = {"chunk_id": cid, "doc": session.present(row["title"]),
               "heading_path": session.present(row["heading_path"]),
               "text": row["content"][:MAX_CHUNK_CHARS], "tokens": row["tokens"],
               "uploaded": True}
        session.retrieved[cid] = {**rec, "full_text": row["content"], "true_doc": row["title"],
                                  "true_heading_path": row["heading_path"], "source": row["source"],
                                  "category": uploads.CATEGORY,
                                  "score": None, "vector_rank": None, "keyword_rank": None}
        return rec
    # The id carries its category ("PKG:412"), so it reaches the right database.
    row = rag.chunk(chunk_id)
    if not row:
        return {"error": f"chunk {chunk_id} does not exist"}
    if session.categories and row["category"].upper() not in session.categories:
        return {"error": f"chunk {chunk_id} is outside the categories this run may read"}
    title, source, heading, content = row["title"], row["source"], row["heading_path"], row["content"]
    if session.excluded(title, source):
        return {"error": f"chunk {chunk_id} is in a document withheld by the evaluation holdout"}
    cid = row["chunk_id"]
    rec = {
        "chunk_id": cid, "doc": session.present(title),
        "heading_path": session.present(heading), "text": content[:MAX_CHUNK_CHARS],
        "tokens": row["tokens"],
    }
    session.retrieved[cid] = {**rec, "full_text": content, "true_doc": title,
                              "true_heading_path": heading, "source": source, "score": None,
                              "category": row["category"],
                              "vector_rank": None, "keyword_rank": None}
    return rec


# Scoped subgraphs, keyed by the source fingerprint of the graph they were cut
# from and the categories they were cut to. Rebuilt when the corpus changes,
# because the fingerprint changes with it.
_scoped_graphs: dict[tuple, dict] = {}


def _graph(session: "Session | None" = None):
    """The knowledge graph this session may see.

    Retrieval is scoped to `session.categories` -- a run over PKG cannot read a
    DR chunk. The graph used not to be: traversal walked the whole graph and
    filtered only on hold-out, so a PKG-scoped run's two-hop neighbourhood came
    back 29 DR nodes to 11 PKG ones. Nothing could be cited from them (evidence
    comes from `session.retrieved`, which only the retrieval tools write), but
    the agent was being shown documents its own retrieval would then refuse to
    open, and told to search for what it found there.

    Only documents belong to a category; streams, systems, processes and specs
    are entities documents refer to, and filter_by_categories keeps those that
    a kept document refers to, plus process ancestors. So scoping removes other
    categories' documents without cutting the taxonomy out from under the run."""
    graph = knowledge_graph.extract_graph()
    categories = tuple(sorted(getattr(session, "categories", ()) or ()))
    if not categories:
        return graph
    fingerprint = graph.get("stats", {}).get("sources")
    key = (fingerprint, categories)
    scoped = _scoped_graphs.get(key)
    if scoped is None:
        cut = knowledge_graph.filter_by_categories(graph, list(categories))
        # filter_by_categories sorts its nodes by (type, id) for the graph
        # page. graph_entity takes the first eight matches, so that sort would
        # quietly re-rank every lookup: "SAP" came back as three documents
        # whose titles contain the word before the SAP S/4HANA system node.
        # Keeping the source graph's order -- hubs first, documents after --
        # means scoping removes nodes without reordering the rest.
        position = {n["id"]: i for i, n in enumerate(graph["nodes"])}
        cut = {**cut, "nodes": sorted(cut["nodes"],
                                      key=lambda n: position.get(n["id"], len(position)))}
        # One corpus fingerprint at a time: a rebuilt graph makes every earlier
        # subgraph wrong as well as unreachable.
        for stale in [k for k in _scoped_graphs if k[0] != fingerprint]:
            _scoped_graphs.pop(stale, None)
        _scoped_graphs[key] = scoped = cut
    return scoped


def graph_entity(session: Session, text_or_code: str) -> dict:
    """Resolve a name or code to a graph node: dotted BPML codes (4.7.1.3),
    dash codes (O-050-030), streams, systems, documents and SPARK tickets.

    Dotted codes used to resolve to nothing and this returned a note saying
    the graph did not model them. It does now -- the BPML hierarchy and the
    process register put 149 of them in as process nodes -- so the note was
    telling the agent to stop using the graph for exactly the codes it holds."""
    q = (text_or_code or "").strip().lower()
    g = _graph(session)
    exact, partial = [], []
    for n in g["nodes"]:
        if session.excluded(n.get("label", ""), n.get("source", "")):
            continue
        label, nid = n["label"].lower(), n["id"].lower()
        code = (n.get("code") or "").lower()
        ticket = (n.get("ticket") or "").lower()
        if q in (label, nid, code, ticket):
            exact.append(n)
        elif len(q) > 2 and (q in label or q in nid or (code and q in code) or (ticket and q in ticket)):
            partial.append(n)
    picked = (exact or partial)[:8]
    note = ""
    if not picked:
        note = f"no graph entity matches '{text_or_code}'"
        if session.categories:
            note += f" within this run's categories ({', '.join(session.categories)})"
        if re.fullmatch(r"\d+(\.\d+)+", q):
            note += ("; the graph holds the BPML codes that a document or the register mentions, "
                     "so this step may exist in the sheet without being in the graph -- try its "
                     "name, or a SPARK ticket or system it involves")
    return {"matches": [_node(session, n) for n in picked], "note": note}


def _node(session: Session, n: dict) -> dict:
    return {"node_id": n["id"], "type": n["type"], "label": session.present(n["label"]),
            "code": n.get("code"), "ticket": n.get("ticket"), "degree": n.get("degree"),
            "description": (n.get("description") or "")[:240]}


def graph_neighbors(session: Session, node_id: str, hops: int = 1) -> dict:
    """Adjacent nodes out to `hops`. Two hops is the useful default for a
    platform: a system reaches a ticket only through its specification."""
    g = _graph(session)
    nodes = {n["id"]: n for n in g["nodes"]}
    if node_id not in nodes:
        # Out of scope reads as "broken graph" unless it is named as scope.
        if any(n["id"] == node_id for n in knowledge_graph.extract_graph()["nodes"]):
            return {"error": (f"node '{node_id}' is outside this run's categories "
                              f"({', '.join(session.categories)}); it exists in the corpus "
                              "graph but no document in scope refers to it")}
        return {"error": f"node '{node_id}' is not in the graph"}
    hops = 1 if hops is None else max(1, min(int(hops), 2))
    adjacency: dict[str, list[tuple[str, dict]]] = {}
    for e in g["edges"]:
        adjacency.setdefault(e["source"], []).append((e["target"], e))
        adjacency.setdefault(e["target"], []).append((e["source"], e))

    seen = {node_id: 0}
    frontier = [node_id]
    edges_used: list[dict] = []
    for depth in range(1, hops + 1):
        nxt = []
        for cur in frontier:
            for other, e in adjacency.get(cur, []):
                if other not in seen:
                    seen[other] = depth
                    nxt.append(other)
                    edges_used.append(e)
        frontier = nxt

    out = []
    for nid, depth in seen.items():
        if depth == 0:
            continue
        n = nodes[nid]
        if session.excluded(n.get("label", ""), n.get("source", "")):
            continue
        out.append({**_node(session, n), "hops": depth})
    out.sort(key=lambda n: (n["hops"], -(n.get("degree") or 0)))
    return {
        "node": _node(session, nodes[node_id]),
        "neighbors": out[:40],
        "edges": [_edge(session, nodes, e) for e in edges_used[:60]],
        "truncated": len(out) > 40,
    }


def _edge(session: Session, nodes: dict, e: dict) -> dict:
    """A relationship as the agent sees it. A link from a document says how
    often the document names the target and in which chunks -- ids get_chunk
    opens, so a graph fact can be checked against the passage it came from."""
    out = {"edge_id": e["id"], "source": e["source"], "target": e["target"],
           "relation": e["relation"], "label": e["label"]}
    doc = nodes.get(e["source"]) or {}
    if doc.get("type") == "document" and not session.excluded(doc.get("label", ""), doc.get("source", "")):
        if e.get("mentions"):
            out["mentions"] = e["mentions"]
        if e.get("chunks"):
            out["chunks"] = list(e["chunks"])
    return out


def graph_path(session: Session, a: str, b: str) -> dict:
    g = _graph(session)
    nodes = {n["id"]: n for n in g["nodes"]}
    src = a if a in nodes else _best_node(g, a)
    tgt = b if b in nodes else _best_node(g, b)
    if not src or not tgt:
        return {"error": f"could not resolve {'a' if not src else 'b'} to a graph node"}
    path = knowledge_graph.find_shortest_path(g, src, tgt)
    if not path:
        return {"path": None, "note": f"no path connects {src} and {tgt}"}
    edges = {e["id"]: e for e in g["edges"]}
    steps = []
    for eid in path["edges"]:
        e = edges.get(eid)
        if e:
            step = {"from": session.present(nodes[e["source"]]["label"]),
                    "relation": e["relation"],
                    "to": session.present(nodes[e["target"]]["label"])}
            if "chunks" in (ev := _edge(session, nodes, e)):
                step["chunks"] = ev["chunks"]
            steps.append(step)
    return {"hops": path["hops"], "node_ids": path["nodes"], "edge_ids": path["edges"], "steps": steps}


def _best_node(g: dict, term: str) -> str | None:
    t = (term or "").strip().lower()
    if not t:
        return None
    for n in g["nodes"]:
        if t in (n["label"].lower(), n["id"].lower(), (n.get("code") or "").lower()):
            return n["id"]
    for n in g["nodes"]:
        if len(t) > 2 and t in n["label"].lower():
            return n["id"]
    return None


# --- the schema the agent sees ------------------------------------------------

def _entry_schema() -> dict:
    from .schemas import FitGapEntry

    schema = FitGapEntry.model_json_schema()
    schema.pop("$defs", None) or None
    return FitGapEntry.model_json_schema()


def definitions(mode: str = "A", has_uploads: bool = False) -> list[dict]:
    """The Claude tool definitions. `submit_entry` advertises the Pydantic
    schema itself, so the contract in schemas.py is the only source of truth.

    The upload tools are advertised only when documents were actually
    attached: a tool the model can see is a tool it will try, and one that can
    only ever answer "nothing was attached" costs a call out of its budget."""
    tools = [
        {
            "name": "get_scope",
            "description": "Look up a BPML process by code: its name, description, parent, children and ancestry.",
            "input_schema": {
                "type": "object",
                "properties": {"bpml_code": {"type": "string", "description": "e.g. 4.5.1.4"}},
                "required": ["bpml_code"],
            },
        },
        {
            "name": "search_corpus",
            "description": (
                "Hybrid search over the Solvay SPARK Markdown corpus: vector similarity plus BM25 "
                "keyword search, fused. Returns chunk excerpts only -- no answer is generated. "
                "Always run one query containing the exact BPML code, so BM25 can match it verbatim."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "description": "1-12, default 8"},
                    "filters": {
                        "type": "object",
                        "properties": {
                            "doc_include": {"type": "array", "items": {"type": "string"},
                                            "description": "only documents whose name matches one of these globs"},
                            "doc_exclude": {"type": "array", "items": {"type": "string"}},
                            "mode": {"type": "string", "enum": ["hybrid", "vector", "keyword"]},
                        },
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "get_chunk",
            "description": "The full text and metadata of one chunk, by id.",
            "input_schema": {
                "type": "object",
                "properties": {"chunk_id": {"type": "string"}},
                "required": ["chunk_id"],
            },
        },
        {
            "name": "graph_entity",
            "description": (
                "Resolve a name, system, BPML code (4.7.1.3), dash-code (O-050-030) or SPARK "
                "ticket to a knowledge-graph node. The graph holds streams, systems, documents, "
                "processes by BPML code, dash codes and tickets."
            ),
            "input_schema": {
                "type": "object",
                "properties": {"text_or_code": {"type": "string"}},
                "required": ["text_or_code"],
            },
        },
        {
            "name": "graph_neighbors",
            "description": ("Nodes adjacent to a graph node, out to 1 or 2 hops: tickets, systems, streams, "
                            "documents. A relationship from a document lists the chunks it was extracted "
                            "from; open one with get_chunk to quote it."),
            "input_schema": {
                "type": "object",
                "properties": {"node_id": {"type": "string"}, "hops": {"type": "integer", "description": "1 or 2"}},
                "required": ["node_id"],
            },
        },
        {
            "name": "graph_path",
            "description": "Shortest hop-by-hop path between two graph entities (BFS).",
            "input_schema": {
                "type": "object",
                "properties": {"a": {"type": "string"}, "b": {"type": "string"}},
                "required": ["a", "b"],
            },
        },
        {
            "name": "submit_entry",
            "description": (
                "Submit the finished fit-gap entry for this step. Validated against the register "
                "schema; a malformed entry comes back with the error so you can correct and resubmit. "
                "Call this exactly once, at the end."
            ),
            "input_schema": _entry_schema(),
        },
    ]
    if not has_uploads:
        return tools
    # Inserted before submit_entry so the last tool in the list stays the one
    # that ends the turn.
    return tools[:-1] + [
        {
            "name": "search_uploads",
            "description": (
                "Hybrid search over the documents the analyst attached to THIS session only. "
                "These are NOT part of the SPARK corpus: they are the material being compared "
                "against it. Never cite an uploaded chunk as what the project decided -- cite it "
                "as what the attached document proposes or records, and use search_corpus to "
                "find what the project already says about the same thing."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "description": "1-12, default 8"},
                    "filters": {
                        "type": "object",
                        "properties": {
                            "doc_exclude": {"type": "array", "items": {"type": "string"}},
                            "mode": {"type": "string", "enum": ["hybrid", "vector", "keyword"]},
                        },
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "upload_entities",
            "description": (
                "The systems, BPML codes, dash codes, SPARK tickets and specifications the "
                "attached documents mention, each marked according to whether the corpus already "
                "knows it. Start here: a shared entity tells you exactly what to search the "
                "corpus for, and an entity only the upload has is worth reporting as such."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "only": {"type": "string", "enum": ["shared", "new"],
                             "description": "omit for both"},
                },
            },
        },
        tools[-1],
    ]


# How each tool is typed in a Langfuse trace, shared by all three engines
# because a tool name means the same thing in each of them. Nearly everything
# here reads from a knowledge source without changing it, which is what
# `retriever` is for; typing those as plain tools would throw away the one
# distinction that makes a trace's retrieval countable. The two exceptions
# neither search nor read a corpus: `list_sources` reports what is attached to
# the session, and `compare_entities` computes over two graphs already loaded.
OBSERVATION_TYPE = {
    "web_search": "retriever",
    "get_scope": "retriever",
    "search_corpus": "retriever",
    "search_uploads": "retriever",
    "read_sources": "retriever",
    # The Fit-Gap Copilot's search over the SAP Best Practice category: hybrid
    # retrieval like search_corpus, so it counts as retrieval in a trace.
    "search_sap_best_practice": "retriever",
    "get_chunk": "retriever",
    "graph_entity": "retriever",
    "graph_neighbors": "retriever",
    "graph_path": "retriever",
    "graph_enumerate": "retriever",
    "upload_entities": "retriever",
    "list_sources": "tool",
    "compare_entities": "tool",
}

DISPATCH = {
    "get_scope": get_scope,
    "search_corpus": search_corpus,
    "search_uploads": search_uploads,
    "upload_entities": upload_entities,
    "get_chunk": get_chunk,
    "graph_entity": graph_entity,
    "graph_neighbors": graph_neighbors,
    "graph_path": graph_path,
    # Gated in backend/agents/guardrails/web.py; only offered when switched on.
    "web_search": web.search,
}


def describe_sources(name: str, args: dict, result: dict, session: Session | None = None) -> dict:
    """Which store a tool call actually read, for the investigation log.

    The three engines sit in different places, and saying so is what lets the
    log answer "did it look in DR?": retrieval hits the corpus table in
    Postgres and reports which categories it came back with, the knowledge
    graph is held in memory and built from the Markdown of every category, and
    the BPML hierarchy is read from a spreadsheet. An attachment is somewhere
    else again -- another database entirely -- and says so."""
    sid = session.uploads if session else ""
    if name == "search_uploads" or (name == "get_chunk"
                                    and str(result.get("chunk_id", "")).startswith(uploads.CATEGORY + ":")):
        n = len(result.get("results") or []) if name == "search_uploads" else int(bool(result.get("chunk_id")))
        where = f"{uploads.schema_name(sid)}" if sid else "session schema"
        return {
            "kind": "session",
            "categories": [uploads.CATEGORY],
            "databases": {f"{rag.database_name(uploads.database_url())}.{where}": n},
            "searched": [uploads.CATEGORY],
            "label": f"uploaded documents ({where}) · {n} chunk(s)",
        }
    if name == "upload_entities":
        where = uploads.schema_name(sid) if sid else "session schema"
        return {
            "kind": "session-graph",
            "categories": [uploads.CATEGORY],
            "built_from": [uploads.CATEGORY],
            "label": (f"session graph ({where}) · {result.get('shared', 0)} shared, "
                      f"{result.get('new', 0)} new"),
        }
    if name in ("search_corpus", "get_chunk"):
        # Chunk ids carry the category the chunk is filed under ("PKG:412").
        ids = (
            [r.get("chunk_id") for r in result.get("results") or []]
            if name == "search_corpus"
            else [result.get("chunk_id")]
        )
        hits: dict[str, int] = {}
        for cid in ids:
            code = str(cid or "").split(":")[0]
            if code:
                hits[code] = hits.get(code, 0) + 1
        # What the call was allowed to cover, narrowest first: the filter it
        # passed, then the run's own scope, then the categories that actually
        # hold something. Falling back to every *registered* category would
        # claim the search covered one that has never had a document in it --
        # which the shard version could not do, because a category with no
        # documents had no database to list.
        asked = [c for c in (args.get("filters", {}).get("categories") or []) if c]
        scope = sorted(getattr(session, "categories", ()) or ())
        searched = sorted(asked) if asked else (
            scope or [code for code, docs, _ in rag.totals() if docs])
        return {
            "kind": "postgres",
            "categories": sorted(hits),
            "databases": {code: n for code, n in sorted(hits.items())},
            "searched": searched,
            "label": " · ".join(f"{code} {n}" for code, n in sorted(hits.items())) or "no match",
        }
    if name.startswith("graph_"):
        # Graph nodes are in memory; document nodes carry the category they
        # came from, which is the closest thing to "which database".
        g = _graph(session)
        cats = sorted({n.get("category") for n in g["nodes"]
                       if n["type"] == "document" and n.get("category")})
        touched = sorted({
            n.get("category") for n in _graph_nodes_in(result, session)
            if n and n.get("type") == "document" and n.get("category")
        })
        built = ", ".join(cats) or "no documents"
        return {
            "kind": "graph",
            # Only document nodes belong to a category. A result made entirely
            # of processes, systems or tickets touches none, and saying it came
            # from "DR, PKG" would overstate what was read.
            "categories": touched,
            "built_from": cats,
            "label": (
                f"knowledge graph · {', '.join(touched)} document node(s)"
                if touched else f"knowledge graph (built from {built}) · no document nodes"
            ),
        }
    if name == "get_scope":
        # The hierarchy is parsed from the process house document in the corpus.
        return {"kind": "postgres", "label": f"corpus · BPML process house ({bpml.DOCUMENT})"}
    if name == "web_search":
        hosts = sorted({urlparse(r.get("url", "")).hostname or "" for r in result.get("results") or []})
        return {"kind": "web", "categories": ["WEB"],
                "label": (f"web · {', '.join(h for h in hosts if h)}" if hosts
                          else "web · nothing on the allowed sites")}
    return {"kind": "other", "label": ""}


def _graph_nodes_in(result: dict, session: "Session | None" = None) -> list[dict]:
    """The graph nodes a graph tool's result refers to, by node_id."""
    ids: list[str] = []
    for key in ("matches", "neighbors", "items"):
        for item in result.get(key) or []:
            if isinstance(item, dict) and item.get("node_id"):
                ids.append(item["node_id"])
    if isinstance(result.get("node"), dict) and result["node"].get("node_id"):
        ids.append(result["node"]["node_id"])
    ids += [i for i in (result.get("node_ids") or []) if isinstance(i, str)]
    by_id = {n["id"]: n for n in _graph(session)["nodes"]}
    return [by_id.get(i) for i in ids]


def summarise(name: str, args: dict, result: dict) -> str:
    """One line per tool call for the UI's live log."""
    if result.get("error"):
        return result["error"][:120]
    if name in ("search_corpus", "search_uploads"):
        n = len(result.get("results", []))
        where = " in uploads" if name == "search_uploads" else ""
        return f'"{str(args.get("query", ""))[:58]}"{where} → {n} chunk{"s" if n != 1 else ""}'
    if name == "get_chunk":
        return f'chunk {args.get("chunk_id")} → {result.get("doc", "")[:48]}'
    if name == "get_scope":
        p = result.get("process", {})
        return f'{p.get("code", "")} {str(p.get("name", ""))[:46]}'
    if name == "graph_entity":
        m = result.get("matches", [])
        return f'"{str(args.get("text_or_code", ""))[:34]}" → {len(m)} node{"s" if len(m) != 1 else ""}'
    if name == "graph_neighbors":
        return f'{args.get("node_id", "")[:30]} → {len(result.get("neighbors", []))} neighbours'
    if name == "graph_path":
        return f'{result.get("hops", "no")} hop(s)' if result.get("path") is not False else "no path"
    if name == "upload_entities":
        return f'{result.get("shared", 0)} shared, {result.get("new", 0)} new entities'
    if name == "web_search":
        n = len(result.get("results", []))
        return f'web "{str(args.get("query", ""))[:52]}" → {n} page{"s" if n != 1 else ""}'
    return ""
