"""What the analysis was built from, kept with the analysis.

Every finding the agent submits carries evidence, and every piece of evidence
names the chunk it came from. That is enough for the verifier, which only has
to prove the quote was really returned this run -- but it is not enough for a
reader, who gets a document title and a quote and no way to ask "where in the
document, how did it come up, and what else was on that page".

Everything needed to answer that is gathered during the run and then thrown
away: `Session.retrieved` holds the title, the heading path, the category, the
retrieval score and the full chunk text for every chunk the agent was shown,
and it dies with the session. This module turns that log into a record that is
stored with the run, so the traceability survives the process that produced it.

Two deliberate choices:

  - The index is keyed by chunk, and findings reference chunks, rather than
    each finding carrying a copy of its sources. A chunk cited by six
    deviations is stored once and the six agree about it by construction.
  - Chunks that were retrieved but never cited are counted, not stored. What
    the agent read and did not use is a real signal -- it is the difference
    between "the corpus does not say" and "the agent did not look" -- but
    keeping the text of everything read would multiply the size of a run
    record for something no reader opens.
"""

from __future__ import annotations

from pathlib import Path

# A snippet, not the chunk. Long enough to place the quote in its paragraph;
# short enough that a run with sixty cited chunks is still a sane row.
SNIPPET_CHARS = 1200


def _kind(category: str, uploaded: bool) -> str:
    """How a reader should think about where this came from.

    UPLOAD is a reserved category nothing in the corpus can carry, so it alone
    marks an attachment. The name check is not enough on its own: the run
    records the file name ("…Sample.txt") while the chunk carries its indexed
    title ("…Sample_txt"), and they never matched -- every attachment was
    filed as corpus and its link pointed at a knowledge-base file that does
    not exist."""
    if uploaded or category.upper() == "UPLOAD":
        return "upload"
    return "corpus"


def index(analysis: dict, asis: dict, retrieved: dict[str, dict],
          upload_names: set[str] | None = None) -> dict:
    """Build the run's source record from its retrieval log.

    `analysis` and `asis` are the submitted models as dictionaries; `retrieved`
    is `Session.retrieved`. Returns a dict safe to store as JSON."""
    upload_names = upload_names or set()
    cited: dict[str, dict] = {}
    # chunk id -> the findings that cite it, so the Sources view can answer
    # "what did this document actually support?" and not merely list titles.
    used_by: dict[str, list[dict]] = {}

    for where, items in _findings(analysis, asis):
        for item in items:
            label, ref = item["label"], item["ref"]
            for ev in item.get("evidence") or []:
                cid = str(ev.get("chunk_id") or "")
                if not cid:
                    continue
                used_by.setdefault(cid, []).append(
                    {"kind": where, "ref": ref, "label": label,
                     "side": ev.get("side", ""), "evidence_class": ev.get("evidence_class", ""),
                     "quote": ev.get("quote", "")})

    for cid, uses in used_by.items():
        rec = retrieved.get(cid) or {}
        title = rec.get("true_doc") or rec.get("doc") or ""
        uploaded = bool(rec.get("uploaded")) or title in upload_names
        text = rec.get("full_text") or rec.get("text") or ""
        cited[cid] = {
            "chunk_id": cid,
            "document": title,
            "category": (rec.get("category") or "").upper(),
            "kind": _kind(rec.get("category") or "", uploaded),
            "heading_path": rec.get("true_heading_path") or rec.get("heading_path") or "",
            "score": rec.get("score"),
            "vector_rank": rec.get("vector_rank"),
            "keyword_rank": rec.get("keyword_rank"),
            "snippet": text[:SNIPPET_CHARS],
            "truncated": len(text) > SNIPPET_CHARS,
            "file": Path(rec.get("source") or "").name,
            "used_by": uses,
            # A chunk cited by a finding but absent from the log was pruned by
            # the quote gate; saying so is better than showing a blank row.
            "known": bool(rec),
        }

    documents: dict[str, dict] = {}
    for rec in cited.values():
        doc = documents.setdefault(rec["document"], {
            "document": rec["document"], "category": rec["category"], "kind": rec["kind"],
            "file": rec["file"], "chunks": 0, "citations": 0,
            "best_score": None, "headings": [],
        })
        doc["chunks"] += 1
        doc["citations"] += len(rec["used_by"])
        if rec["score"] is not None:
            doc["best_score"] = max(doc["best_score"] or 0.0, rec["score"])
        if rec["heading_path"] and rec["heading_path"] not in doc["headings"]:
            doc["headings"].append(rec["heading_path"])

    return {
        "chunks": cited,
        "documents": sorted(documents.values(),
                            key=lambda d: (-d["citations"], d["document"])),
        "retrieved_total": len(retrieved),
        "cited_total": len(cited),
        # Read and not used. The gap between these two is the honest measure
        # of how much of the corpus the run touched but did not rely on.
        "unused_total": max(0, len(retrieved) - len(cited)),
    }


def _findings(analysis: dict, asis: dict):
    """Every part of the analysis that carries evidence, with a stable
    reference a reader can be sent to."""
    devs = analysis.get("deviations") or []
    fits = analysis.get("fit_areas") or []
    locs = analysis.get("localization") or []
    yield "deviation", [
        {"ref": d.get("gap_id", ""), "label": d.get("exact_difference", "")[:120],
         "evidence": d.get("evidence")} for d in devs
    ]
    yield "fit_area", [
        {"ref": f.get("as_is_step_id") or f.get("gt_step_ref") or "",
         "label": f.get("statement", "")[:120], "evidence": f.get("evidence")} for f in fits
    ]
    yield "localization", [
        {"ref": item.get("topic", "")[:60], "label": item.get("topic", "")[:120],
         "evidence": item.get("evidence")} for item in locs
    ]
