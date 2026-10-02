"""The Fit-Gap Copilot's window onto its three sources.

Retrieval, the graph and the BPML hierarchy (parsed from the process house
document in the corpus) are InsightLens's (backend/agents/fitgap/tools.py) and
are reused as they are -- same retrieval log, same holdout masking, same
source labelling in the investigation view. What is added here is the part the
InsightLens has no need for: telling the three sides of the comparison apart.

  read_sources   the attachments, filtered by the role they were given
  list_sources   what is attached, in which role, and what the corpus holds
  compare_entities  what the subject mentions that the corpus already knows
  search_sap_best_practice  the SAP Best Practice documents indexed in the corpus

Keeping the sides separate is not tidiness. A three-way comparison collapses
into a two-document diff the moment the agent cannot say which source a
sentence came from, and a deviation is a claim about a difference between two
named sides.
"""

from __future__ import annotations

import sys
from pathlib import Path


from backend.rag import rag  # noqa: E402
from backend.core import uploads  # noqa: E402
from backend.agents.guardrails import web  # noqa: E402
from backend.agents.fitgap import bpml, tools as ftools  # noqa: E402

from .schemas import (DEVIATION_TYPES, DIMENSIONS, DISPOSITIONS,  # noqa: E402
                      LOCALIZATION_STATES, RATING_MEANING, Analysis, AsIsModel)

Session = ftools.Session

# The roles an attachment can play, phrased for the model.
SIDES = {
    "as_is": "the country's As-Is process documentation",
    "template": "Global Template documentation attached to this session",
    "sap_bp": "SAP Best Practice / SAP standard process content",
    "localization": "a localization, statutory or tax source",
    "any": "every attached document, whatever its role",
}


# The corpus category SAP Best Practice content is indexed under. Quotes from
# it are the SAP side of a country comparison even when nothing is attached as
# SAP Best Practice -- the documents are already in the organizational memory.
SAP_BP_CATEGORY = "SAP"


def sap_bp_indexed(session: Session) -> int:
    """How many SAP Best Practice documents this run may read in the corpus.
    Zero when the run's categories leave the SAP category out."""
    if session.categories and SAP_BP_CATEGORY not in session.categories:
        return 0
    for code, docs, chunks in _corpus_totals(session):
        if code == SAP_BP_CATEGORY and chunks:
            return docs
    return 0


def is_sap_bp_chunk(rec: dict) -> bool:
    """Whether a retrieved chunk really is SAP Best Practice content: attached
    in that role, or indexed under the SAP category. The agent names a quote's
    side itself, and a template chunk quoted as SAP standard would give the
    template's answer twice under two names."""
    return rec.get("side") == "sap_bp" or str(rec.get("category") or "").upper() == SAP_BP_CATEGORY


def search_sap_best_practice(session: Session, query: str, k: int = 8) -> dict:
    """Hybrid search restricted to the SAP Best Practice documents in the
    corpus, each result marked as the sap_bp side."""
    if session.categories and SAP_BP_CATEGORY not in session.categories:
        return {"error": (f"this run may not read the {SAP_BP_CATEGORY} category, where SAP "
                          "Best Practice content is indexed")}
    out = ftools.search_corpus(session, query, k, {"categories": [SAP_BP_CATEGORY]})
    for r in out.get("results", []):
        r["side"] = "sap_bp"
        r["side_label"] = "SAP Best Practice (indexed)"
    if not out.get("results"):
        out["note"] = "no indexed SAP Best Practice document matches this query"
    return out


def list_sources(session: Session) -> dict:
    """What the agent has to work with, and what it does not.

    Answered from the store rather than left to the prompt, because the honest
    answer changes per run: a session with no SAP Best Practice document
    cannot produce Score B, and the agent needs to know that before it starts
    rather than invent one."""
    if not session.uploads:
        return {"error": "no documents were attached to this session"}
    listed = uploads.files(session.uploads)
    by_role: dict[str, list[dict]] = {}
    for f in listed:
        by_role.setdefault(f["role"], []).append(
            {"name": f["name"], "chunks": f["chunks"], "format": f["format"]})
    corpus = [
        {"category": code, "documents": docs, "chunks": chunks}
        for code, docs, chunks in _corpus_totals(session)
    ]
    missing = [r for r in ("as_is", "template", "sap_bp") if r not in by_role]
    return {
        "attached": {uploads.ROLE_LABEL[r]: v for r, v in by_role.items()},
        "corpus_categories": corpus,
        "missing_roles": [uploads.ROLE_LABEL[r] for r in missing],
        "sap_best_practice_indexed": sap_bp_indexed(session),
        "note": _source_note(by_role, corpus, sap_bp_indexed(session)),
    }


def _corpus_totals(session: Session) -> list[tuple[str, int, int]]:
    try:
        return rag.totals(list(session.categories) or None)
    except Exception:
        return []


def _source_note(by_role: dict, corpus: list, sap_bp_docs: int = 0) -> str:
    parts = []
    if "as_is" not in by_role:
        parts.append("No document is tagged as the country As-Is, so there is nothing to analyse "
                     "against the template — say so rather than analysing the corpus on its own.")
    if "template" not in by_role:
        parts.append("No Global Template document is attached; the template side comes from the "
                     "indexed corpus via search_corpus."
                     if corpus else
                     "No Global Template document is attached and no corpus category is in scope.")
    if "sap_bp" not in by_role and sap_bp_docs:
        parts.append(f"No SAP Best Practice document is attached, but {sap_bp_docs} SAP Best "
                     f"Practice document(s) are indexed in the corpus under {SAP_BP_CATEGORY}. "
                     "Read them with search_sap_best_practice, quote them with side sap_bp, and "
                     "rate the SAP Best Practice fit from what they say.")
    elif "sap_bp" not in by_role:
        parts.append("No SAP Best Practice source is attached or indexed. Do not rate the SAP Best Practice "
                     "score, and do not describe SAP standard behaviour you have not read. "
                     "Leave sap_bp_fit_rating null and explain this in sap_bp_note.")
    return " ".join(parts)


def read_sources(session: Session, query: str, k: int = 8, side: str = "as_is") -> dict:
    """Hybrid retrieval over the attachments, restricted to one role."""
    session.corpus_searches += 1
    if not session.uploads:
        return {"error": "no documents were attached to this session"}
    side = (side or "as_is").strip().lower()
    if side not in SIDES:
        return {"error": f"side must be one of {', '.join(SIDES)}"}
    k = max(1, min(int(k or 8), 12))
    roles = None if side == "any" else [side]
    hits = uploads.search(session.uploads, query, k=k, roles=roles)
    by_source = uploads.roles_by_source(session.uploads)
    results = []
    for h in hits:
        if session.excluded(h.title, h.source):
            continue
        role = by_source.get(str(Path(h.source).resolve()), uploads.DEFAULT_ROLE)
        rec = {
            "chunk_id": h.key,
            "doc": session.present(h.title),
            "heading_path": session.present(h.heading_path),
            "side": role,
            "side_label": uploads.ROLE_LABEL.get(role, role),
            "text": h.content[:ftools.MAX_CHUNK_CHARS],
            "score": round(h.score, 5),
        }
        session.retrieved[h.key] = {**rec, "full_text": h.content, "true_doc": h.title,
                                    "true_heading_path": h.heading_path, "source": h.source,
                                    "category": h.category,
                                    "vector_rank": h.vector_rank, "keyword_rank": h.keyword_rank}
        results.append(rec)
    out: dict = {"query": query, "side": side, "results": results}
    if not results:
        out["note"] = (f"nothing attached as {SIDES[side]} matches this query"
                       if roles else "no attachment matches this query")
    return out


def compare_entities(session: Session, only: str | None = None) -> dict:
    """The systems, BPML codes, dash codes and tickets the SUBJECT mentions,
    each marked according to whether the corpus already knows it.

    Restricted to the subject's own documents on purpose: an entity shared
    with the corpus is where the template's version of this process is
    written down, which is the fastest route from "here is the subject" to
    "here is what the template says about the same thing".

    The role comes from the run's subject, not from a constant. It used to be
    "as_is", which is right for a country run and blind for every other one:
    a Best Practice run attaches its document as `sap_bp`, so the filter
    matched nothing and this returned an empty comparison rather than an
    error -- the agent is told by the prompt to call this, and got nothing
    back with no way to tell "no shared entities" from "wrong role"."""
    if not session.uploads:
        return {"error": "no documents were attached to this session"}
    role = session.subject_role or "as_is"
    cmp_ = uploads.compare(session.uploads, roles=[role],
                           categories=session.categories)
    items = cmp_["entities"]
    want = (only or "").strip().lower()
    if want == "shared":
        items = [e for e in items if e["in_corpus"]]
    elif want == "new":
        items = [e for e in items if not e["in_corpus"]]
    return {
        "subject_role": role,
        "subject_documents": [session.present(d["label"]) for d in cmp_["documents"]],
        "shared": cmp_["shared"],
        "new": cmp_["new"],
        "entities": items[:60],
        "truncated": len(items) > 60,
        # "New" is relative to the scope, so the scope has to be stated.
        "note": (f"'In corpus' means the {', '.join(session.categories)} corpus this run may "
                 "read; an entity elsewhere in the corpus counts as new here."
                 if session.categories else ""),
    }


# --- the tool definitions the model sees --------------------------------------

def _enum_help(mapping: dict[str, str]) -> str:
    return "; ".join(f"{k} = {v}" for k, v in mapping.items())


def definitions(stage: str) -> list[dict]:
    """The tools for one stage. Two stages, two tool sets: understanding the
    As-Is and comparing it are different jobs, and a model given the compare
    tools while it is still reading will start comparing early (§21 Stage 2
    exists precisely to stop that)."""
    shared = [
        {
            "name": "list_sources",
            "description": ("What is attached to this session and in which role, and what the "
                            "corpus holds. Call this first: it tells you which of the three "
                            "sides you actually have a source for."),
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "read_sources",
            "description": (
                "Hybrid search over the attached documents, restricted to one side of the "
                "comparison. Sides: " + "; ".join(f"{k} = {v}" for k, v in SIDES.items()) + "."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "description": "1-12, default 8"},
                    "side": {"type": "string", "enum": list(SIDES)},
                },
                "required": ["query"],
            },
        },
        {
            "name": "get_chunk",
            "description": "The full text of one chunk, by id, from an attachment or the corpus.",
            "input_schema": {
                "type": "object",
                "properties": {"chunk_id": {"type": "string"}},
                "required": ["chunk_id"],
            },
        },
    ]

    if stage == "asis":
        return shared + [{
            "name": "submit_asis",
            "description": (
                "Submit the normalised country As-Is process: the atomic steps you read out of "
                "the As-Is documents, in order. Call this once, when you have read enough. "
                "Leave an attribute empty when the document does not state it — an empty field "
                "is an honest answer and an invented one corrupts the comparison."
            ),
            "input_schema": AsIsModel.model_json_schema(),
        }]

    return shared + [
        {
            "name": "get_scope",
            "description": ("Look up a Global Template process by BPML code: its name, "
                            "description, parent, children and ancestry."),
            "input_schema": {
                "type": "object",
                "properties": {"bpml_code": {"type": "string", "description": "e.g. 4.5.1.4"}},
                "required": ["bpml_code"],
            },
        },
        {
            "name": "search_corpus",
            "description": (
                "Hybrid search over the indexed project corpus — this is the Global Template "
                "side unless a template document is attached. Run at least one query containing "
                "the exact BPML code, so keyword search can match it verbatim."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "description": "1-12, default 8"},
                    "filters": {
                        "type": "object",
                        "properties": {
                            "doc_include": {"type": "array", "items": {"type": "string"}},
                            "mode": {"type": "string", "enum": ["hybrid", "vector", "keyword"]},
                        },
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "search_sap_best_practice",
            "description": (
                "Hybrid search over the SAP Best Practice documents indexed in the corpus -- "
                "SAP's delivered standard process, scope item by scope item. Every result is "
                "the sap_bp side. Use it to find what SAP standard does at each step of the "
                "process, and quote it with side sap_bp."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "description": "1-12, default 8"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "compare_entities",
            "description": ("The systems, BPML codes, dash codes and tickets the documents that "
                            "are the SUBJECT of this run mention, each marked according to "
                            "whether the corpus already knows it. A shared entity is where to "
                            "look for the template's version."),
            "input_schema": {
                "type": "object",
                "properties": {"only": {"type": "string", "enum": ["shared", "new"],
                                        "description": "omit for both"}},
            },
        },
        {
            "name": "graph_entity",
            "description": ("Resolve a name, system, BPML code, dash code or SPARK ticket to a "
                            "knowledge-graph node."),
            "input_schema": {
                "type": "object",
                "properties": {"text_or_code": {"type": "string"}},
                "required": ["text_or_code"],
            },
        },
        {
            "name": "graph_neighbors",
            "description": "Nodes adjacent to a graph node, out to 1 or 2 hops.",
            "input_schema": {
                "type": "object",
                "properties": {"node_id": {"type": "string"},
                               "hops": {"type": "integer", "description": "1 or 2"}},
                "required": ["node_id"],
            },
        },
        {
            "name": "submit_analysis",
            "description": (
                "Submit the finished three-way analysis: dimension ratings, fit areas, the "
                "deviation register, localization advisory, backlog candidates and open "
                "questions. Call this exactly once, at the end.\n\n"
                "Deviation types — " + _enum_help(DEVIATION_TYPES) + ".\n\n"
                "Dispositions — " + _enum_help(DISPOSITIONS) + ".\n\n"
                "Localization states — " + _enum_help(LOCALIZATION_STATES) + ".\n\n"
                "Dimension ratings 0-4 — " + "; ".join(f"{k} = {v}" for k, v in RATING_MEANING.items())
                + ". Rate all seven dimensions: "
                + "; ".join(f"{k} ({label})" for k, (label, _) in DIMENSIONS.items()) + "."
            ),
            "input_schema": Analysis.model_json_schema(),
        },
        {
            "name": "amend_analysis",
            "description": (
                "Correct an analysis that was sent back, without writing it out again. Send only "
                "what changes; everything else is kept as you submitted it, and the result is "
                "checked again exactly like a full submission. Use it only after a send-back.\n\n"
                "- headline, template_process, sap_bp_note: replace the text.\n"
                "- dimension_ratings, fit_areas: replace the whole list.\n"
                "- deviations: each item names a gap_id. For an existing gap, the fields you give "
                "replace that gap's fields, except evidence, which is ADDED to its quotes. A "
                "gap_id that does not exist yet is added as a new, complete deviation.\n"
                "- remove_deviations: gap_ids to delete from the register.\n"
                "- localization, backlog, open_questions: items are ADDED to the lists.\n"
                "Fields and allowed values are those of submit_analysis."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "headline": {"type": "string"},
                    "template_process": {"type": "string"},
                    "sap_bp_note": {"type": "string"},
                    "dimension_ratings": {"type": "array", "items": {"type": "object"}},
                    "fit_areas": {"type": "array", "items": {"type": "object"}},
                    "deviations": {
                        "type": "array",
                        "items": {"type": "object", "properties": {"gap_id": {"type": "string"}},
                                  "required": ["gap_id"]},
                    },
                    "remove_deviations": {"type": "array", "items": {"type": "string"}},
                    "localization": {"type": "array", "items": {"type": "object"}},
                    "backlog": {"type": "array", "items": {"type": "object"}},
                    "open_questions": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    ]


# Which engine answered, for the investigation log. read_sources is retrieval
# -- the same hybrid ranking as search_corpus, over the session's attachments
# rather than the corpus -- so it is filed under rag and its `sources` label
# says which database. list_sources returns an inventory of what is attached,
# which is not evidence and has no panel behind it.
ENGINE_OF = {
    "search_corpus": "rag", "search_sap_best_practice": "rag", "get_chunk": "rag", "read_sources": "rag",
    "graph_entity": "graph", "graph_neighbors": "graph", "compare_entities": "graph",
    "get_scope": "bpml",
    "list_sources": "session",
    "web_search": "web",
}


DISPATCH = {
    "list_sources": list_sources,
    "read_sources": read_sources,
    "compare_entities": compare_entities,
    "get_chunk": ftools.get_chunk,
    "get_scope": ftools.get_scope,
    "search_corpus": ftools.search_corpus,
    "search_sap_best_practice": search_sap_best_practice,
    "graph_entity": ftools.graph_entity,
    "graph_neighbors": ftools.graph_neighbors,
    # Gated in backend/agents/guardrails/web.py; only offered when switched on.
    "web_search": web.search,
}


def summarise(name: str, args: dict, result: dict) -> str:
    """One line per tool call for the live investigation log."""
    if result.get("error"):
        return result["error"][:120]
    if name == "read_sources":
        n = len(result.get("results", []))
        return f'"{str(args.get("query", ""))[:44]}" in {result.get("side", "")} → {n} chunk{"s" if n != 1 else ""}'
    if name == "search_sap_best_practice":
        n = len(result.get("results", []))
        return f'"{str(args.get("query", ""))[:44]}" in SAP Best Practice → {n} chunk{"s" if n != 1 else ""}'
    if name == "list_sources":
        attached = result.get("attached", {})
        return " · ".join(f"{k}: {len(v)}" for k, v in attached.items()) or "nothing attached"
    if name == "compare_entities":
        where = result.get("subject_role") or "subject"
        return (f'{where}: {result.get("shared", 0)} shared, '
                f'{result.get("new", 0)} new entities')
    return ftools.summarise(name, args, result)


def describe_sources(name: str, args: dict, result: dict, session: Session) -> dict:
    """Which store a call read, for the investigation log."""
    if name == "read_sources":
        where = uploads.schema_name(session.uploads) if session.uploads else "session schema"
        n = len(result.get("results", []))
        sides = sorted({r.get("side", "") for r in result.get("results", [])})
        return {
            "kind": "session",
            "categories": [uploads.CATEGORY],
            "databases": {f"{rag.database_name(uploads.database_url())}.{where}": n},
            "searched": sides or [args.get("side", "as_is")],
            "label": (f"attached {', '.join(uploads.ROLE_LABEL.get(s, s) for s in sides)} "
                      f"({where}) · {n} chunk(s)" if sides
                      else f"attachments ({where}) · no match"),
        }
    if name in ("list_sources", "compare_entities"):
        where = uploads.schema_name(session.uploads) if session.uploads else "session schema"
        return {"kind": "session-graph", "categories": [uploads.CATEGORY],
                "label": f"session store ({where})"}
    if name == "search_sap_best_practice":
        # Said as what it searched -- the SAP category -- not as the run's whole scope.
        return ftools.describe_sources(
            "search_corpus", {**args, "filters": {"categories": [SAP_BP_CATEGORY]}}, result, session)
    return ftools.describe_sources(name, args, result, session)


def ancestry(code: str):
    p = bpml.get(code)
    return ftools._ancestry(p) if p else []
