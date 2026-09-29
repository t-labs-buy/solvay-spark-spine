"""The BPML process hierarchy: the scope backbone of InsightLens and the
Fit-Gap Copilot (handover §2).

It is read from the corpus, not from a workbook: the BPML process house
document (`knowledge_base/BPML_Process_xlsx.md`, written by
backend/ingestion/bpml_markdown.py from Signavio's `BPML_Process.xlsx`) is
indexed like any other document, one section per process, and its chunks are
joined back together and parsed here. So the agents scope with exactly what
retrieval and the graph can see, and a process added to the house reaches them
by re-indexing that one document.

This used to parse `BPML_ProcessesHierarchyExtended.xlsx` directly, because
that workbook's own Markdown conversion was a stub (9,096 rows x 50 columns is
"too wide to render as a table"). The workbook has since been removed. See
backend/agents/fitgap/NOTES.md.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field

from backend.ingestion.bpml_markdown import level_of, parent_of, parse, sort_key

# The indexed document the hierarchy is read from, by file name.
DOCUMENT = "BPML_Process_xlsx.md"
# How long a loaded hierarchy is trusted before the document's fingerprint is
# checked again. get() is called per step and per tool call; a query each time
# would be wasted, and a re-index is picked up within a minute.
RECHECK_SECONDS = 60

STREAM_OF_ROOT = {
    "1": "H2R", "2": "A2D", "4": "L2C", "5": "F2S",
    "6": "P2P", "7": "P2P", "8": "I2D", "9": "R2R",
}


@dataclass
class Process:
    code: str
    name: str
    level: int
    parent: str | None
    description: str = ""
    process_type: str = ""
    status: str = ""
    children: list[str] = field(default_factory=list)

    @property
    def stream(self) -> str | None:
        return STREAM_OF_ROOT.get(self.code.split(".")[0])

    def brief(self) -> dict:
        return {"code": self.code, "name": self.name, "level": self.level, "parent": self.parent}

    def full(self) -> dict:
        return {**self.brief(), "description": self.description, "process_type": self.process_type,
                "status": self.status, "children": self.children, "stream": self.stream}


_lock = threading.Lock()
_cache: dict[str, Process] | None = None
_cache_key: str | None = None
_checked_at = 0.0
_load_error: str | None = None
_source: str | None = None


def _document() -> tuple[int, str, str]:
    """(id, source, fingerprint) of the indexed process house document. If a
    copy of the file is indexed from another folder too, the knowledge_base/
    one is the one this module is about."""
    from backend.rag import rag

    docs = rag.documents_named(DOCUMENT)
    if not docs:
        raise LookupError(f"{DOCUMENT} is not indexed; run "
                          "`python -m backend.ingestion.bpml_markdown --index`")
    doc = next((d for d in docs if "/knowledge_base/" in d["source"]), docs[0])
    row = rag.connection().execute(
        "SELECT fingerprint FROM rag_documents WHERE id = %s", (doc["id"],)).fetchone()
    return doc["id"], doc["source"], row[0] if row else ""


def _read(doc_id: int) -> dict[str, Process]:
    """The document's chunks, in order, joined back into its text and parsed.
    Later duplicate codes are dropped, as the document itself already does."""
    from backend.rag import rag

    rows = rag.connection().execute(
        "SELECT content FROM rag_chunks WHERE document_id = %s ORDER BY chunk_index",
        (doc_id,)).fetchall()
    procs: dict[str, Process] = {}
    for rec in parse("\n\n".join(r[0] for r in rows)):
        code = rec["code"]
        if code in procs:
            continue
        procs[code] = Process(
            code=code, name=rec["name"], level=level_of(code), parent=parent_of(code),
            description=rec.get("description", "")[:1500],
            process_type=rec.get("process_type", ""), status=rec.get("status", ""),
        )
    return procs


def load(force: bool = False) -> dict[str, Process]:
    """The hierarchy, parsed once per version of the indexed document."""
    global _cache, _cache_key, _checked_at, _load_error, _source
    with _lock:
        if _cache is not None and not force and time.monotonic() - _checked_at < RECHECK_SECONDS:
            return _cache
        procs: dict[str, Process] = {}
        try:
            doc_id, source, key = _document()
            _checked_at = time.monotonic()
            if _cache is not None and not force and key == _cache_key:
                return _cache
            procs = _read(doc_id)
            if not procs:
                raise ValueError(f"{DOCUMENT} is indexed but holds no numbered BPML process")
            _cache_key, _source, _load_error = key, source, None
        except Exception as exc:  # a missing document must not take the API down
            _load_error = f"{type(exc).__name__}: {exc}"
            _checked_at = time.monotonic()
            if _cache is not None:
                # Keep serving the last good hierarchy through a database blip.
                return _cache

        for code, p in procs.items():
            if p.parent and p.parent in procs:
                procs[p.parent].children.append(code)
        for p in procs.values():
            p.children.sort(key=sort_key)

        _cache = procs
        return _cache


def load_error() -> str | None:
    load()
    return _load_error


def get(code: str) -> Process | None:
    return load().get(code.strip())


def exists(code: str) -> bool:
    return code.strip() in load()


def roots() -> list[Process]:
    return [p for p in sorted(load().values(), key=lambda p: sort_key(p.code)) if p.level == 1]


def children(code: str) -> list[Process]:
    p = get(code)
    procs = load()
    return [procs[c] for c in p.children] if p else []


def subtree(code: str, max_depth: int | None = None) -> list[Process]:
    """`code` first, then every descendant, depth first, in code order."""
    root = get(code)
    if not root:
        return []
    out: list[Process] = []
    stack = [root]
    while stack:
        p = stack.pop(0)
        out.append(p)
        if max_depth is not None and p.level - root.level >= max_depth:
            continue
        stack = children(p.code) + stack
    return out


def steps_in_scope(code: str, max_steps: int | None = None) -> list[Process]:
    """The units InsightLens classifies: level-4 steps under `code`, falling
    back to level 3 (then the node itself) where level 4 does not exist.

    The fallback is per branch, not per scope: 4.5 may detail some of its
    level-3 steps down to level 4 and leave others at level 3, and dropping
    the latter would silently shrink the register.
    """
    root = get(code)
    if not root:
        return []
    picked: list[Process] = []

    def walk(p: Process) -> None:
        kids = children(p.code)
        if p.level >= 4 or not kids:
            picked.append(p)
            return
        for k in kids:
            walk(k)

    walk(root)
    picked.sort(key=lambda p: sort_key(p.code))
    return picked[:max_steps] if max_steps else picked


def search(text: str, limit: int = 12) -> list[Process]:
    """Resolve what the user typed to processes: a code, a code prefix, or
    words from a name. Ordered best match first."""
    q = (text or "").strip().lower()
    if not q:
        return []
    procs = load()
    if q in procs:
        return [procs[q]]

    scored: list[tuple[float, Process]] = []
    words = [w for w in re.split(r"[^a-z0-9.]+", q) if len(w) > 2]
    for p in procs.values():
        name = p.name.lower()
        score = 0.0
        if p.code.startswith(q):
            score += 6.0
        if q in name:
            score += 5.0
        hits = sum(1 for w in words if w in name or w in p.code)
        if hits:
            score += 2.0 * hits / max(len(words), 1) + 0.6 * hits
        if score:
            # Prefer the shallower, more quotable process when two tie.
            score -= 0.15 * p.level
            scored.append((score, p))
    scored.sort(key=lambda s: (-s[0], sort_key(s[1].code)))
    return [p for _, p in scored[:limit]]


def resolve_scope(text: str) -> Process | None:
    """One process to run a register over, from a code or a free-text phrase."""
    hits = search(text)
    return hits[0] if hits else None


def stats() -> dict:
    procs = load()
    by_level: dict[int, int] = {}
    for p in procs.values():
        by_level[p.level] = by_level.get(p.level, 0) + 1
    return {
        "document": DOCUMENT,
        "source": _source,
        "available": bool(procs) and not _load_error,
        "error": _load_error,
        "processes": len(procs),
        "by_level": dict(sorted(by_level.items())),
        "roots": [p.brief() for p in roots()],
    }
