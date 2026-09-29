"""
knowledge_graph.py — Entity & Relationship Extraction Engine for Solvay Spark Spine AI.

Extracts a semantic enterprise knowledge graph from the Markdown of every
category rag.py knows about -- solvay-spark/pkg/markdown (PKG),
solvay-spark/dr/markdown (DR), knowledge_base (UNFILED), and any other folder
following the <base>/<code>/markdown convention. Each document node carries the
category it came from, so the graph can be shown one category at a time.
Discovers:
- Business Streams (L2C, I2D, R2R, P2P)
- Core Enterprise Systems (SAP S/4HANA, SAP ECC, Salesforce, SOVOS, Fiori, eCommerce)
- BPML Process Codes & Subprocesses (O-xxx-xxx, M-xxx-xxx, L-xxx-xxx)
- SPARK Functional Specifications & Enhancements (SPARK-XXXXX)
- Source Documents with metadata & relationships
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections import Counter, defaultdict
from pathlib import Path

from backend.core.paths import ROOT
from backend.ingestion import bpml_markdown
from typing import Any

logger = logging.getLogger("solvay_spark_spine.graph")

BASE_DIR = ROOT
SOLVAY_DIR = BASE_DIR / "solvay-spark" / "pkg" / "markdown"
KB_DIR = BASE_DIR / "knowledge_base"
CACHE_FILE = BASE_DIR / "data" / "knowledge_graph.json"
# Where the per-category folders live, for the <base>/<code>/markdown convention.
CATEGORY_ROOT = BASE_DIR / "solvay-spark"


def source_folders() -> list[tuple[Path, str]]:
    """(folder, category) for every folder the graph reads.

    The categories rag.py has descriptions for come first, then any folder
    following the <base>/<code>/markdown convention -- so a category added by
    dropping Markdown in a new folder appears here for the same reason it
    appears in the vector index, with no list to keep in step."""
    from backend.rag import rag

    found: dict[Path, str] = {}
    for code, meta in rag.CATEGORIES.items():
        folder = meta.get("folder")
        if folder and (path := (BASE_DIR / folder)).is_dir():
            found[path.resolve()] = code
    if CATEGORY_ROOT.is_dir():
        for path in sorted(CATEGORY_ROOT.glob(f"*/{rag.MARKDOWN_FOLDER}")):
            if path.is_dir() and path.resolve() not in found:
                try:
                    found[path.resolve()] = rag.check_category(path.parent.name)
                except ValueError:
                    pass  # not a category code -- some other folder called markdown
    # Sorted by category so the same file appearing in two folders is always
    # resolved the same way (see the de-duplication in extract_graph).
    return sorted(found.items(), key=lambda pair: (pair[1], str(pair[0])))


def _content_signature(path: Path) -> str:
    """sha256 of a file the graph reads from outside the corpus.

    Content rather than size and mtime: `git checkout` and `cp` move mtime
    without changing anything, and a rebuild of this graph is several seconds,
    so a false positive is not free either. Well under a millisecond for the
    0.8 MB process house document, against a cache-hit path that already
    parses 1.5 MB of JSON."""
    import hashlib

    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""  # absent is a state too, and a different one from present


def _sources_fingerprint(files: list[tuple[Path, str, str]]) -> str:
    """Identifies everything the graph was built from, so a cache built before
    any of it changed is rebuilt rather than served.

    Every input, and by content. The BPML hierarchy is read from the process
    house document, which is one of `files` -- but `files` is fingerprinted by
    size, and correcting a process name can leave the size unchanged. While the
    hierarchy's source was not covered by content you could correct it,
    rebuild, and be served the graph built from the version you had just
    replaced. Nothing reported an error; the hierarchy was simply the old one.

    The L1-L4 register needs no special case: it lives in pkg/markdown and is
    already one of the corpus files."""
    import hashlib

    parts = sorted(f"{rel}:{cat}:{path.stat().st_size}" for path, rel, cat in files)
    parts.append(f"bpml:{_content_signature(BPML_MD)}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def current_fingerprint(files: list[tuple[Path, str, str]] | None = None) -> str:
    """The fingerprint the corpus graph would be built under right now: every
    input file, the BPML process house document's content, and the retrieval
    index. Chunk ids are the index's row ids, which a re-index renumbers, so a
    graph whose passage layer points at the old ids counts as out of date too. Compared with the cached
    graph's stats.sources, it says whether the graph is current."""
    import hashlib

    fingerprint = _sources_fingerprint(collect_files() if files is None else files)
    return hashlib.sha256(f"{fingerprint}\nindex:{_index_signature()}".encode()).hexdigest()


def _display_size(type_: str, degree: int) -> float:
    """Node radius, grown by how connected the node is within the graph shown."""
    if type_ == "stream":
        return 28 + min(degree * 0.4, 20)
    if type_ == "system":
        return 22 + min(degree * 0.3, 16)
    if type_ == "document":
        return 12 + min(degree * 0.5, 12)
    if type_ == "process":
        return 10 + min(degree * 0.5, 10)
    return 9 + min(degree * 0.5, 10)  # spec


def decorate(graph: dict[str, Any]) -> dict[str, Any]:
    """Add what the canvas and the traversal tools read but the data model
    does not hold: degree (over this graph's entity relationships), and the
    colour and radius a node is drawn with. New node dicts are returned; the
    input, which may be the cached copy, is left as it is."""
    degrees: dict[str, int] = defaultdict(int)
    for edge in graph["edges"]:
        degrees[edge["source"]] += 1
        degrees[edge["target"]] += 1
    nodes = []
    for node in graph["nodes"]:
        n = dict(node)
        n["degree"] = degrees[n["id"]]
        n["size"] = _display_size(n["type"], n["degree"])
        n["color"] = ("#fb923c" if n["type"] == "spec" and not n.get("is_primary")
                      else TYPE_COLOR.get(n["type"], "#94a3b8"))
        nodes.append(n)
    return {**graph, "nodes": nodes}


def passage_relationships(chunk: dict[str, Any]) -> list[dict[str, Any]]:
    """A stored chunk's relationships: (:Document)-[:HAS_CHUNK]->(:Chunk) and
    (:Chunk)-[:MENTIONS {count}]->(entity)."""
    cid = chunk["id"]
    rels = [{"id": f"{chunk['document']}->{cid}:has_chunk", "source": chunk["document"], "target": cid,
             "relation": "has_chunk", "label": "Has chunk"}]
    rels += [{"id": f"{cid}->{e}:mentions", "source": cid, "target": e, "relation": "mentions",
              "label": "Mentions", "count": n} for e, n in (chunk.get("mentions") or {}).items()]
    return rels


def property_graph(graph: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Every node and relationship, entity and passage layers together -- the
    graph as it would sit in Neo4j. The exporters read this."""
    chunks = (graph.get("passages") or {}).get("nodes") or []
    nodes = list(graph["nodes"]) + [
        # `mentions` and `document` become relationships; kept as properties
        # they would be foreign keys, which is what relationships are for.
        {**{k: v for k, v in c.items() if k not in ("mentions", "document")}, "label": _chunk_label(c)}
        for c in chunks]
    edges = list(graph["edges"]) + [r for c in chunks for r in passage_relationships(c)]
    return nodes, edges


def chunks_mentioning(graph: dict[str, Any], entity: str, document: str = "") -> list[str]:
    """Chunk keys that mention an entity, optionally within one document, in
    document order -- the passages a relationship to that entity rests on."""
    return [c["chunk_key"] for c in (graph.get("passages") or {}).get("nodes") or []
            if entity in (c.get("mentions") or {}) and (not document or c["document"] == document)]


# How many chunk keys a document relationship carries inline. The full list is
# the passage layer's `mentions` relationships; the edge keeps enough to open.
EDGE_CHUNKS = 5


def _index_signature() -> str:
    """What the retrieval index holds per document: first chunk id and count.
    It changes when a document is re-indexed, which is when chunk ids change."""
    import hashlib

    try:
        from backend.rag import rag

        rows = rag.connection().execute(
            "SELECT d.source, min(c.id), count(*) FROM rag_chunks c"
            " JOIN rag_documents d ON d.id = c.document_id GROUP BY d.source ORDER BY d.source"
        ).fetchall()
    except Exception:
        return ""
    return hashlib.sha256("\n".join(f"{s}:{a}:{n}" for s, a, n in rows).encode()).hexdigest()


def _index_chunks() -> tuple[dict[str, list[dict[str, Any]]], str]:
    """Every indexed chunk, keyed by the absolute path of its Markdown file."""
    try:
        from backend.rag import rag

        rows = rag.connection().execute(
            "SELECT d.source, c.id, c.chunk_index, c.heading_path, c.content, c.tokens, c.category"
            " FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id"
            " ORDER BY d.source, c.chunk_index"
        ).fetchall()
    except Exception as exc:  # the graph must still build without the index
        logger.warning("Passage layer skipped: the retrieval index is unavailable (%s)", exc)
        return {}, f"the retrieval index was unavailable: {type(exc).__name__}"
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source, cid, index, heading, content, tokens, category in rows:
        out[str(Path(source).resolve())].append({
            "key": f"{category}:{cid}", "index": index, "heading_path": heading or "",
            "content": content or "", "tokens": tokens, "category": category,
        })
    return dict(out), ""


def _chunk_mentions(chunks: list[dict[str, Any]], register_keys: set[str]
                    ) -> tuple[dict[str, list[str]], dict[str, dict[str, list[int]]]]:
    """Which chunks name which entity, by the patterns the document-level
    extraction uses. Returns entity -> chunk keys in document order, and
    chunk key -> entity -> match positions (whose length is the count)."""
    by_entity: dict[str, list[str]] = defaultdict(list)
    by_chunk: dict[str, dict[str, list[int]]] = {}
    for ch in chunks:
        text = ch["content"]
        opened = text.replace("_", " ")
        found: dict[str, list[int]] = defaultdict(list)
        for sid, pattern in STREAM_RE.items():
            found[f"stream:{sid}"] += [m.start() for m in pattern.finditer(opened)]
        for key, pattern in SYSTEM_RE.items():
            found[f"system:{key}"] += [m.start() for m in pattern.finditer(opened)]
        for m in CODE_RE.finditer(text):
            found[f"proc:{m.group(1)}-{m.group(2)}"].append(m.start())
        for m in TICKET_RE.finditer(opened):
            if f"SPARK-{m.group(1)}" not in register_keys:
                found[f"spec:SPARK-{m.group(1)}"].append(m.start())
        found = {k: v for k, v in found.items() if v}
        by_chunk[ch["key"]] = found
        for entity in found:
            by_entity[entity].append(ch["key"])
    return by_entity, by_chunk


def _chunk_label(ch: dict[str, Any]) -> str:
    tail = (ch.get("heading_path") or "").split(" / ")[-1].strip()
    return f"{ch.get('chunk_key') or ch.get('key')} {tail}".strip()[:80]


def _declared_category(path: Path) -> str | None:
    """The category a file declares in its own front matter, if it does.

    Only the head of the file is read: front matter is a leading block, and
    some of these documents are a megabyte of table."""
    from backend.rag import rag

    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            head = fh.read(2048)
    except OSError:
        return None
    declared = rag.front_matter(head).get("category")
    if not declared:
        return None
    try:
        return rag.check_category(declared)
    except ValueError:
        return None


def collect_files() -> list[tuple[Path, str, str]]:
    """(path, source path relative to the project, category) for every Markdown
    file in the graph's scope.

    A file's own front matter outranks the folder it sits in, matching
    rag.category_for so the graph and the corpus file a document the same way.
    They used not to: a category chosen in the UI was written to the database
    row and nowhere else, the graph could only see the folder, and the two
    disagreed about the same document."""
    files: list[tuple[Path, str, str]] = []
    seen: set[str] = set()
    for folder, code in source_folders():
        for path in sorted(folder.glob("*.md")):
            if path.name.startswith((".", "~$")) or path.name in seen:
                continue
            seen.add(path.name)
            try:
                rel = str(path.relative_to(BASE_DIR))
            except ValueError:
                rel = str(path)
            files.append((path, rel, _declared_category(path) or code))
    return files

# One colour per entity type, matching TYPE_CONFIG on the Knowledge Graph page.
# Each stream and system used to carry its own hue, which made the legend ("one
# swatch per type") disagree with the canvas, and put the L2C green on the same
# value as the BPML process green.
#
# Presentation, not data: colour, radius and degree are added when the graph is
# loaded (see `decorate`) and never written to knowledge_graph.json. Degree is
# derived from the relationships and goes stale the moment one is added; the
# radius used to be stored under `size`, where it overwrote the document's own
# file size.
STREAM_COLOR = "#8b5cf6"
SYSTEM_COLOR = "#0284c7"
TYPE_COLOR = {
    "stream": STREAM_COLOR, "system": SYSTEM_COLOR, "document": "#64748b",
    "process": "#10b981", "spec": "#f97316", "chunk": "#94a3b8",
}

# Core Enterprise Streams
STREAMS = {
    "L2C": {
        "label": "Lead to Cash (L2C)",
        "desc": "End-to-end sales order management, pricing, billing, logistics, and customer collections.",
    },
    "I2D": {
        "label": "Idea to Delivery (I2D)",
        "desc": "Transit times, shipping logistics, warehouse operations, and physical goods delivery.",
    },
    "R2R": {
        "label": "Record to Report (R2R)",
        "desc": "Financial accounting, commissions settlement, general ledger, and financial reporting.",
    },
    "P2P": {
        "label": "Procure to Pay (P2P)",
        "desc": "Procurement, vendor purchase orders, goods receipt, and invoice verification.",
    },
}

# Core Systems
SYSTEMS = {
    "S4HANA": {
        "label": "SAP S/4HANA",
        "desc": "Target ERP platform for global sales, billing, master data, and central finance.",
    },
    "ECC": {
        "label": "SAP ECC",
        "desc": "Legacy ERP environment being migrated to SAP S/4HANA under Solvay SPARK.",
    },
    "Salesforce": {
        "label": "Salesforce (CRM)",
        "desc": "Customer relationship management platform handling customer complaints, accounts, and order intake.",
    },
    "SOVOS": {
        "label": "SOVOS (Tax Engine)",
        "desc": "Global tax determination and automated electronic compliance engine integrated with billing.",
    },
    "Fiori": {
        "label": "SAP Fiori",
        "desc": "Modern UX role-based applications for custom enhancements and business user dashboards.",
    },
    "eCommerce": {
        "label": "Solvay@eCommerce",
        "desc": "Digital portal for customer direct ordering, product catalog, and invoice visibility.",
    },
    # The twelve below complete the system list the SPARK design brief names.
    # All were already mentioned throughout the corpus -- PF1 alone in 12
    # documents -- but had no node, so a document that only ever talks to a
    # legacy instance or a trading partner looked like it talked to nothing.
    "WP1": {
        "label": "WP1 (Legacy ERP)",
        "desc": "Legacy SAP instance being consolidated into S/4HANA under SPARK.",
    },
    "PF1": {
        "label": "PF1 (Legacy ERP)",
        "desc": "Legacy SAP instance carrying order and delivery flows ahead of migration.",
    },
    "M3": {
        "label": "M3 (Legacy ERP)",
        "desc": "Infor M3 ERP used by parts of the business, with order management being retired.",
    },
    "ESKER": {
        "label": "Esker",
        "desc": "Document delivery and order-intake automation partner.",
    },
    "Elemica": {
        "label": "Elemica",
        "desc": "Chemical industry supply-chain network used for customer EDI exchange.",
    },
    "Coface": {
        "label": "Coface",
        "desc": "Credit insurance provider feeding customer credit limits into the credit process.",
    },
    "CPI": {
        "label": "SAP CPI",
        "desc": "Cloud integration middleware brokering interfaces between SAP and third parties.",
    },
    "OMP": {
        "label": "OMP",
        "desc": "Supply chain planning system consulted for forecast and availability checks.",
    },
    "SAPTM": {
        "label": "SAP TM",
        "desc": "SAP Transportation Management for shipment planning and freight.",
    },
    "EWM": {
        "label": "SAP EWM",
        "desc": "Extended Warehouse Management for warehouse and outbound delivery execution.",
    },
    "GTS": {
        "label": "SAP GTS",
        "desc": "Global Trade Services for compliance screening and trade preference.",
    },
    "MDG": {
        "label": "SAP MDG",
        "desc": "Master Data Governance for customer and material master maintenance.",
    },
}

# Process codes are matched with a leading guard so that a longer prefix is not
# silently truncated: "INT-P-080-160" must not be read as "P-080-160".
CODE_RE = re.compile(r"(?<![A-Za-z0-9-])([A-Za-z][A-Za-z0-9]{0,3})-(\d{2,3}(?:-\d{2,3})+)\b")
TICKET_RE = re.compile(r"\bSPARK[-_ ]?(\d{4,6})\b", re.I)

# Word-bounded, case-insensitive system fingerprints. Bare substring tests used to
# link documents to systems via customer names ("ADECCO", "CECCHETTO"), acronyms
# ("ECCN" = Export Control Classification Number) and Salesforce record ids
# ("001d100000DpgS4"), while missing real mentions spelled "Sovos" or "E-commerce".
SYSTEM_RE = {
    "S4HANA": re.compile(r"\bS[/ ]?4[\s/-]?HANA\b|\bS/4\b|\bS4\b", re.I),
    "ECC": re.compile(r"\bECC\b", re.I),
    "Salesforce": re.compile(r"\bsalesforce\b", re.I),
    "SOVOS": re.compile(r"\bsovos\b", re.I),
    "Fiori": re.compile(r"\bfiori\b", re.I),
    "eCommerce": re.compile(r"\be[-\s]?commerce\b", re.I),
    # Short acronyms stay case-sensitive: "m3" is also a cubic metre and "gts"
    # turns up inside ordinary words once the case guard is dropped.
    "WP1": re.compile(r"\bWP1\b"),
    "PF1": re.compile(r"\bPF1\b"),
    "M3": re.compile(r"\bM3\b"),
    "CPI": re.compile(r"\bCPI\b"),
    "OMP": re.compile(r"\bOMP\b"),
    "EWM": re.compile(r"\bEWM\b"),
    "GTS": re.compile(r"\bGTS\b"),
    "MDG": re.compile(r"\bMDG\b"),
    "ESKER": re.compile(r"\besker\b", re.I),
    "Elemica": re.compile(r"\belemica\b", re.I),
    "Coface": re.compile(r"\bcoface\b", re.I),
    "SAPTM": re.compile(r"\bSAP\s*TM\b", re.I),
}
# What kind of system each one is. This used to be spelt out as six different
# relationship types -- every link to S/4HANA was `runs_on`, every link to SOVOS
# `interfaces_with` -- chosen by which system was named, never by what the
# document said. A relationship type should carry meaning, and all the
# extractor knows is that the document mentions the system; so there is one
# type, `mentions_system`, and the kind lives on the System node.
SYSTEM_KIND = {
    "S4HANA": "sap", "ECC": "legacy_erp", "Salesforce": "crm", "SOVOS": "third_party",
    "Fiori": "sap_ui", "eCommerce": "portal", "WP1": "legacy_erp", "PF1": "legacy_erp",
    "M3": "legacy_erp", "EWM": "sap", "GTS": "sap", "MDG": "sap", "SAPTM": "sap",
    "CPI": "middleware", "ESKER": "third_party", "Elemica": "third_party",
    "Coface": "third_party", "OMP": "third_party",
}
STREAM_RE = {sid: re.compile(r"\b" + sid + r"\b", re.I) for sid in STREAMS}

# Authoritative BPML process hierarchy: the process house document in the
# corpus (backend/ingestion/bpml_markdown.py writes it from Signavio's export),
# which names every numbered process and the lettered BPMN codes inside them.
BPML_MD = bpml_markdown.TARGET
# Keyed on the document's contents, not merely set once. A module-level cache
# that never checks its source is stale for the life of the process: the server
# runs for days, and `extract_graph(force=True)` rebuilt every node from a
# hierarchy loaded before the source was corrected. force=True could not fix
# it, which is what made it worth finding.
_bpml_cache: dict[str, Any] | None = None
_bpml_cache_key: str | None = None


def load_bpml_hierarchy() -> dict[str, Any]:
    """The real parent and name of every BPML code, from the process house document.

    A numbered process sits under the last numbered segment of its path; a
    lettered code under the process that performs it (see
    bpml_markdown.hierarchy for how a code listed in several processes is
    placed). Returns {"parent": {code: parent_code}, "name": {code: label}}.
    """
    global _bpml_cache, _bpml_cache_key
    key = _content_signature(BPML_MD)
    if _bpml_cache is not None and _bpml_cache_key == key:
        return _bpml_cache

    hierarchy: dict[str, Any] = {"parent": {}, "name": {}}
    try:
        hierarchy = bpml_markdown.hierarchy(BPML_MD.read_text(encoding="utf-8"))
    except Exception as e:  # pragma: no cover - the graph still builds without it
        logger.warning("Could not read the BPML hierarchy from %s: %s", BPML_MD, e)

    _bpml_cache = hierarchy
    _bpml_cache_key = key
    logger.info("BPML hierarchy: %d codes, %d with a parent",
                len(hierarchy["name"]), len(hierarchy["parent"]))
    return _bpml_cache



# The L1-L4 process register. Its "Lowest Level Key" column holds the Jira id of
# each lowest-level step. That key is a PROPERTY of the step, not an entity of
# its own: modelling it as a node turned one spreadsheet column into 502 of the
# graph's 549 spec nodes and 502 of its 556 ticket edges, all from this single
# file, which drowned the 47 genuine functional-spec tickets.
REGISTER_MD = SOLVAY_DIR / "SPARK L2C L1-L4 Processes _xlsx.md"
_REGISTER_ROW_RE = re.compile(
    r"\|\s*(\d{2})\.\s*([^|]+?)\s*"      # L1  "03. Lead to Cash"
    r"\|\s*([\d.]+)\s+([^|]+?)\s*"        # L2  "4.5 Manage Sales Orders"
    r"\|\s*([\d.]+)\s+([^|]+?)\s*"        # L3
    r"\|\s*([\d.]+)\s+([^|]+?)\s*"        # L4
    r"\|\s*(SPARK-\d+)\s*\|"              # Lowest Level Key
)
# Some rows carry a key but no dotted L4 code ("| 09. EH&S | 10.2 ... |  |
# SPARK-13454 |"), so the key column is scanned separately from the full row.
# "Lowest Level Key" is the only SPARK-bearing column in the file, across both
# of its sheets, which is what makes the loose cell match safe here.
_REGISTER_KEY_RE = re.compile(r"\|\s*(SPARK-\d+)\s*\|")
REGISTER_VALUE_CHAIN = "lead to cash"
_register_cache: dict[str, Any] | None = None
_register_cache_key: str | None = None


def load_process_register() -> dict[str, Any]:
    """Read the L1-L4 register.

    Returns `keys` -- every Lowest Level Key in the file, across all eleven
    value chains, so none of them can be mistaken for a functional spec -- and
    `steps`, the Lead-to-Cash L4 activities only, since that is the design this
    graph covers. Each step carries its name and its `jira_key`.
    """
    global _register_cache, _register_cache_key
    key = _content_signature(REGISTER_MD)
    if _register_cache is not None and _register_cache_key == key:
        return _register_cache

    keys: set[str] = set()
    steps: dict[str, dict[str, str]] = {}
    try:
        text = REGISTER_MD.read_text(encoding="utf-8", errors="ignore")
        keys.update(_REGISTER_KEY_RE.findall(text))
        for l1_num, l1_name, _l2, _l2n, _l3, _l3n, l4, l4_name, key in _REGISTER_ROW_RE.findall(text):
            if l1_name.strip().lower() != REGISTER_VALUE_CHAIN:
                continue
            # Rows repeat across sheets; the first spelling of a step wins.
            steps.setdefault(l4, {"name": l4_name.strip(), "jira_key": key})
    except FileNotFoundError:
        logger.warning("Process register not found at %s; Jira keys will be absent", REGISTER_MD)
    except Exception as e:  # a malformed table must not take the whole graph down
        logger.warning("Could not read the process register at %s: %s", REGISTER_MD, e)

    _register_cache = {"keys": keys, "steps": steps}
    _register_cache_key = key
    logger.info("Process register: %d keys, %d Lead-to-Cash steps", len(keys), len(steps))
    return _register_cache


def extract_graph(
    force: bool = False,
    files: list[tuple[Path, str, str]] | None = None,
    cache: bool = True,
) -> dict[str, Any]:
    """Every entity and relation in every category's Markdown.

    Categories are not filtered here: the whole graph is built and cached once,
    and filter_by_categories cuts it down for a caller that wants one. A cached
    graph is only used when it was built from the same set of files, so adding
    a category does not silently serve a graph that predates it.

    `files` builds the graph from a specific set of Markdown files instead of
    the corpus, which is how InsightLens gets a graph of a document
    somebody uploaded for one session. Pass `cache=False` with it: that graph
    is nobody else's, and writing it to the shared cache file would serve one
    session's upload to every other reader of the graph.

    The streams, systems and the BPML hierarchy are built either way, so a
    graph of one uploaded file lands in the same taxonomy as the corpus graph
    and the two can be compared node for node."""
    files_to_process = collect_files() if files is None else list(files)
    fingerprint = (current_fingerprint(files_to_process) if files is None
                   else _sources_fingerprint(files_to_process))
    if not force and cache and CACHE_FILE.is_file():
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("nodes") and data.get("edges"):
                    if data.get("stats", {}).get("sources") == fingerprint:
                        return decorate(data)
                    logger.info("Cached graph was built from a different set of files; rebuilding")
        except Exception as e:
            logger.warning("Failed to load cached graph: %s", e)

    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def add_node(id_: str, label: str, type_: str, **props):
        if id_ not in nodes:
            nodes[id_] = {"id": id_, "label": label, "type": type_, **props}

    def add_edge(src: str, tgt: str, relation: str, label: str = "", **props):
        key = (src, tgt, relation)
        if key not in seen_edges and src in nodes and tgt in nodes:
            seen_edges.add(key)
            edges.append(
                {
                    "id": f"{src}->{tgt}:{relation}",
                    "source": src,
                    "target": tgt,
                    "relation": relation,
                    "label": label or relation.replace("_", " "),
                    **props,
                }
            )

    # 1. Add Stream Hub Nodes
    for sid, sinfo in STREAMS.items():
        add_node(
            f"stream:{sid}",
            sinfo["label"],
            "stream",
            code=sid,
            description=sinfo["desc"],
        )

    # 2. Add System Nodes
    for sys_id, sys_info in SYSTEMS.items():
        add_node(
            f"system:{sys_id}",
            sys_info["label"],
            "system",
            code=sys_id,
            description=sys_info["desc"],
            kind=SYSTEM_KIND[sys_id],
        )

    # 3. Markdown files, gathered per category by collect_files above.

    # Real process hierarchy, read from the process house document rather than guessed.
    bpml = load_bpml_hierarchy()
    bpml_parent: dict[str, str] = bpml["parent"]
    bpml_name: dict[str, str] = bpml["name"]

    def link_ancestors(code: str) -> None:
        """Chain a process up to its value chain through the BPML hierarchy.

        Codes absent from the hierarchy are left without a parent rather than
        given a made-up one; the `walked` set stops a cycle in the source data
        from looping forever.
        """
        child_code = code
        walked = {code}
        while True:
            parent_code = bpml_parent.get(child_code)
            if not parent_code or parent_code in walked:
                break
            walked.add(parent_code)
            parent_id = f"proc:{parent_code}"
            add_node(
                parent_id,
                parent_code,
                "process",
                code=parent_code,
                description=bpml_name.get(parent_code, f"BPML Process {parent_code}"),
                in_bpml=True,
            )
            add_edge(f"proc:{child_code}", parent_id, "subprocess_of", "Subprocess of",
                     method="bpml_hierarchy")
            child_code = parent_code

    # 3b. Lead-to-Cash L4 steps, from the process register.
    #
    # The register is authoritative for the lowest level of the taxonomy the way
    # the BPML hierarchy is for the levels above it, so the steps are read from
    # it directly rather than waiting for a document to happen to cite one. Each
    # carries its Jira id as the `jira_key` property -- the register's own
    # "Lowest Level Key" -- instead of becoming a spec node of its own.
    register = load_process_register()
    register_keys: set[str] = register["keys"]
    for step_code, step in sorted(register["steps"].items()):
        add_node(
            f"proc:{step_code}",
            step_code,
            "process",
            code=step_code,
            description=bpml_name.get(step_code) or step["name"],
            in_bpml=step_code in bpml_name,
            jira_key=step["jira_key"],
        )
        link_ancestors(step_code)

    # 4. The passage layer. Chunks are read from the retrieval index rather
    # than re-chunked here, so a chunk node's key is exactly the id retrieval
    # hands the agents ("PKG:412") and a graph fact can be traced to the
    # passage it rests on. Corpus builds only: an uploaded document's chunks
    # live in its session, not in the index.
    indexed, index_note = _index_chunks() if files is None else ({}, "not built for uploaded documents")
    passage_docs: list[tuple[str, list[dict[str, Any]]]] = []

    for path, rel_source, category in files_to_process:
        doc_id = f"doc:{path.name}"
        title = path.stem
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        # Format detection
        m_title = re.search(r"\((\w+)\)$", title.strip())
        m_fmt = re.search(r"_([a-zA-Z0-9]+)\.md$", path.name)
        if m_title:
            fmt = m_title.group(1).upper()
        elif m_fmt and m_fmt.group(1).lower() not in ("md", "markdown"):
            fmt = m_fmt.group(1).upper()
        else:
            fmt = path.suffix.replace(".", "").upper() or "MD"

        add_node(
            doc_id,
            title,
            "document",
            filename=path.name,
            source=rel_source,
            category=category,
            format=fmt,
            bytes=path.stat().st_size,
            chars=len(content),
        )

        # The filename carries entities the body sometimes never repeats, so it is
        # searched alongside the text with its separators opened out into spaces.
        filename_text = re.sub(r"[_\-]+", " ", path.stem)
        # Underscores are word characters, so "ZZ1_L2C_SP21175_CODICECIG" would hide
        # the stream from a word-bounded search. Opening them out keeps SAP field and
        # column names readable without loosening the boundaries themselves.
        haystack = f"{filename_text}\n" + content.replace("_", " ")
        # The document's chunks as retrieval indexed them, and which of them
        # mention what -- so a relationship can say where it came from.
        doc_chunks = indexed.get(str(path.resolve()), [])
        chunk_hits, chunk_counts = _chunk_mentions(doc_chunks, register_keys)
        if doc_chunks:
            passage_docs.append((doc_id, [{**ch, "mentions": {e: len(v) for e, v in
                                                               chunk_counts.get(ch["key"], {}).items()}}
                                          for ch in doc_chunks]))

        def evidence(entity: str, mentions: int, method: str) -> dict[str, Any]:
            """Relationship properties: how often the entity is named, in which
            chunks, and by what rule the link was made."""
            keys = chunk_hits.get(entity, [])
            ev: dict[str, Any] = {"method": method, "mentions": mentions,
                                  "chunk_count": len(keys), "chunks": keys[:EDGE_CHUNKS]}
            if not keys and doc_chunks:
                # Named only in the filename, or in text the chunker dropped.
                ev["in_filename_only"] = True
            return ev

        # Connect Document to Stream. The whole document is searched: the old
        # 600-character window missed files such as billing_form_translations,
        # which names L2C 54 times but not in its opening table header.
        for sid, pattern in STREAM_RE.items():
            if pattern.search(haystack):
                add_edge(doc_id, f"stream:{sid}", "belongs_to", "Belongs to Stream",
                         **evidence(f"stream:{sid}", len(pattern.findall(haystack)), "name_match"))

        # Connect Document to Systems
        for sys_key, pattern in SYSTEM_RE.items():
            if pattern.search(haystack):
                add_edge(doc_id, f"system:{sys_key}", "mentions_system", "Mentions system",
                         **evidence(f"system:{sys_key}", len(pattern.findall(haystack)), "name_match"))

        # Extract BPML Process Codes.
        #
        # Sorted, not just de-duplicated. Iterating the set directly left the
        # order of node creation up to string hashing, which is seeded per
        # process, so two builds of an unchanged corpus produced the same
        # 2,386 nodes and 4,780 edges in a different order -- a 38,000-line
        # diff in a tracked file that said nothing. Rebuilding has to be a pure
        # function of the corpus, or you cannot diff two builds to see what a
        # change to an extraction rule actually did.
        code_counts = Counter(f"{a}-{b}" for a, b in CODE_RE.findall(content))
        found_codes = sorted(set(CODE_RE.findall(content)))
        for prefix, code_num in found_codes:
            full_code = f"{prefix}-{code_num}"
            proc_id = f"proc:{full_code}"

            # Prefer the official name. Otherwise take the text that follows the code
            # on its own line, matched on a boundary so that "DM-270-030" does not
            # pick up the row belonging to "DM-270-030-010".
            match_line = ""
            boundary = re.compile(rf"{re.escape(full_code)}(?!-?\d)")
            for line in content.splitlines():
                m = boundary.search(line)
                if m:
                    # Drop the separator that follows the code, then stop at the next
                    # table cell so a neighbouring column is not pulled in as the name.
                    tail = line[m.end():].lstrip(" \t|#*-–:")
                    tail = re.sub(r"\s*\|.*$", "", tail)
                    candidate = re.sub(r"\s+", " ", tail).strip()
                    if candidate and candidate.lower() != "[illegible]":
                        match_line = candidate
                        break

            add_node(
                proc_id,
                full_code,
                "process",
                code=full_code,
                description=bpml_name.get(full_code)
                or match_line
                or f"BPML Process Step {full_code}",
                in_bpml=full_code in bpml_name,
            )
            add_edge(doc_id, proc_id, "specifies_process", "Specifies Process",
                     **evidence(proc_id, code_counts[full_code], "code_match"))

            # Hierarchy: walk the real parent chain from the BPML hierarchy. Splitting
            # the code string used to invent parents ("O-030-010" -> "O-030") that do
            # not exist in the hierarchy at all; the true parent of O-030-010 is the
            # numbered process 4.5.2.4 Validate/Perform Order Readiness. Codes absent
            # from the hierarchy are left without a parent rather than given a made-up one.
            link_ancestors(full_code)

        # Extract Tickets / Functional Specifications. The filename is included
        # because some documents never repeat their own ticket in the body, e.g.
        # "SPARK-51136 - ATP and TRS check.docx".
        found_tickets = sorted(set(TICKET_RE.findall(haystack)))
        for t_num in found_tickets:
            ticket_id = f"SPARK-{t_num}"
            # A Lowest Level Key names a process step, not a functional spec.
            # It lives as `jira_key` on the step node and must never become an
            # entity here, or the register's key column swamps the real tickets.
            if ticket_id in register_keys:
                continue
            t_node = f"spec:{ticket_id}"

            # A document is the primary spec when its filename names the ticket.
            # Matching the full "SPARK-NNNNN" missed the common house styles
            # "SPARK_FS_L2C-21265-..." and "SPARK -22234-...", so the number is
            # matched on its own within the filename.
            is_primary = re.search(rf"\b{t_num}\b", filename_text) is not None

            add_node(
                t_node,
                ticket_id,
                "spec",
                ticket=ticket_id,
                is_primary=is_primary,
            )
            add_edge(
                doc_id,
                t_node,
                "implements_ticket" if is_primary else "references_ticket",
                "Primary Specification" if is_primary else "References Ticket",
                **evidence(t_node, len(re.findall(rf"\bSPARK[-_ ]?{t_num}\b", haystack, re.I)),
                           "ticket_in_filename" if is_primary else "ticket_match"),
            )

    # Chunk -> entity mentions, kept only where the document itself is linked
    # to the entity, so the passage layer never asserts a link the entity layer
    # does not have (the document rules drop some raw matches, e.g. register
    # keys that are not tickets).
    #
    # Stored compactly -- each chunk carries its document and its mentions --
    # and expanded into HAS_CHUNK and MENTIONS relationships by
    # `passage_relationships()`. Written out as relationship records, the
    # layer is 7 MB of repeated ids in a tracked file; the relationships are
    # the same either way.
    linked = {(e["source"], e["target"]) for e in edges if e["source"].startswith("doc:")}
    passage_nodes: list[dict[str, Any]] = []
    for doc_id, doc_chunks in passage_docs:
        for ch in doc_chunks:
            passage_nodes.append({
                "id": f"chunk:{ch['key']}", "type": "chunk", "chunk_key": ch["key"],
                "document": doc_id, "chunk_index": ch["index"], "heading_path": ch["heading_path"],
                "category": ch["category"], "tokens": ch["tokens"],
                "mentions": {e: n for e, n in sorted(ch["mentions"].items()) if (doc_id, e) in linked},
            })

    # Type counts
    by_type: dict[str, int] = defaultdict(int)
    for n in nodes.values():
        by_type[n["type"]] += 1
    by_category: dict[str, int] = defaultdict(int)
    for n in nodes.values():
        if n["type"] == "document":
            by_category[n.get("category", "")] += 1

    result = {
        "nodes": list(nodes.values()),
        "edges": edges,
        # Its own key rather than more nodes: 8,000-odd chunks among 2,400
        # entities would turn every neighbourhood, path and canvas into a list
        # of passages. Same property graph; `property_graph()` joins the two.
        "passages": {"nodes": passage_nodes, "note": index_note},
        "stats": {
            "total_nodes": len(nodes),
            "total_edges": len(edges),
            "types": dict(by_type),
            "streams": list(STREAMS.keys()),
            "systems": list(SYSTEMS.keys()),
            # Documents per category, and the file set this was built from.
            "categories": dict(sorted(by_category.items())),
            "sources": fingerprint,
            "passages": {"chunks": len(passage_nodes),
                         "mentions": sum(len(n["mentions"]) for n in passage_nodes)},
        },
    }

    # Cache to disk
    if cache:
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=1)
        except Exception as e:
            logger.warning("Failed to cache graph: %s", e)

    return decorate(result)


def filter_by_categories(graph: dict[str, Any], categories: list[str] | None) -> dict[str, Any]:
    """The part of the graph a set of categories accounts for.

    Only documents belong to a category; streams, systems, processes and specs
    are entities the documents refer to, so they are kept when a kept document
    refers to them. Process ancestors come along too -- a step whose value
    chain had been cut away would look unconnected, when the truth is only that
    no document in this category mentions the levels above it.

    An empty or missing list means the whole graph."""
    codes = {c.strip().upper() for c in (categories or []) if c and c.strip()}
    present = {c for c in graph.get("stats", {}).get("categories", {})}
    # Ticking every category has to mean the same as ticking none, or the
    # unfiltered view would show the parts of the BPML hierarchy that no
    # document mentions while "all of them" quietly dropped them.
    if not codes or present <= codes:
        return graph

    nodes = {n["id"]: n for n in graph["nodes"]}
    keep = {i for i, n in nodes.items() if n["type"] == "document" and n.get("category") in codes}
    for edge in graph["edges"]:
        if edge["source"] in keep and edge["target"] in nodes:
            keep.add(edge["target"])

    parent = {e["source"]: e["target"] for e in graph["edges"] if e["relation"] == "subprocess_of"}
    for node_id in [i for i in keep if nodes[i]["type"] == "process"]:
        current = parent.get(node_id)
        while current and current not in keep:
            keep.add(current)
            current = parent.get(current)

    edges = [e for e in graph["edges"] if e["source"] in keep and e["target"] in keep]

    kept_nodes = sorted((dict(nodes[i]) for i in keep), key=lambda n: (n["type"], n["id"]))
    passages = graph.get("passages") or {}
    kept_chunks = [n for n in passages.get("nodes") or [] if n["document"] in keep]

    by_type: dict[str, int] = defaultdict(int)
    for node in kept_nodes:
        by_type[node["type"]] += 1
    by_category: dict[str, int] = defaultdict(int)
    for node in kept_nodes:
        if node["type"] == "document":
            by_category[node.get("category", "")] += 1

    # Degree and display size describe this subgraph, not the whole one: a
    # document is not drawn as a hub because of edges that were filtered out.
    return decorate({
        "nodes": kept_nodes,
        "edges": edges,
        "passages": {**passages, "nodes": kept_chunks},
        "stats": {
            **graph.get("stats", {}),
            "total_nodes": len(kept_nodes),
            "total_edges": len(edges),
            "types": dict(by_type),
            "categories": dict(sorted(by_category.items())),
            "filtered_to": sorted(codes),
        },
    })


def find_shortest_path(
    graph_data: dict[str, Any], start_id: str, end_id: str
) -> dict[str, Any] | None:
    """Finds the shortest path between two nodes using Breadth-First Search (BFS)."""
    if start_id == end_id:
        return {"nodes": [start_id], "edges": [], "hops": 0}

    nodes_map = {n["id"]: n for n in graph_data["nodes"]}
    if start_id not in nodes_map or end_id not in nodes_map:
        return None

    # Build undirected adjacency
    adj = defaultdict(list)
    for e in graph_data["edges"]:
        adj[e["source"]].append((e["target"], e["id"], e["relation"]))
        adj[e["target"]].append((e["source"], e["id"], e["relation"]))

    queue = [(start_id, [start_id], [])]
    visited = {start_id}

    while queue:
        curr, path_nodes, path_edges = queue.pop(0)

        for neighbor, edge_id, rel in adj[curr]:
            if neighbor == end_id:
                final_nodes = path_nodes + [neighbor]
                final_edges = path_edges + [edge_id]
                return {
                    "nodes": final_nodes,
                    "edges": final_edges,
                    "hops": len(final_edges),
                    "steps": [
                        {
                            "from_id": final_nodes[i],
                            "from": nodes_map[final_nodes[i]]["label"],
                            "from_type": nodes_map[final_nodes[i]]["type"],
                            "to_id": final_nodes[i + 1],
                            "to": nodes_map[final_nodes[i + 1]]["label"],
                            "to_type": nodes_map[final_nodes[i + 1]]["type"],
                            "relation": rel,
                        }
                        for i in range(len(final_edges))
                    ],
                }

            if neighbor not in visited:
                visited.add(neighbor)
                queue.append((neighbor, path_nodes + [neighbor], path_edges + [edge_id]))

    return None


def generate_graph_answer(query: str, res: dict[str, Any], graph: dict[str, Any]) -> str:
    """Generates a structured, rich Markdown answer grounded in the knowledge graph."""
    nodes_map = {n["id"]: n for n in graph["nodes"]}
    node_ids = res.get("node_ids", [])
    edge_ids = res.get("edge_ids", [])
    mode = res.get("mode", "subgraph")
    path = res.get("path")

    matched_nodes = [nodes_map[nid] for nid in node_ids if nid in nodes_map]
    systems = [n for n in matched_nodes if n["type"] == "system"]
    streams = [n for n in matched_nodes if n["type"] == "stream"]
    processes = [n for n in matched_nodes if n["type"] == "process"]
    specs = [n for n in matched_nodes if n["type"] == "spec"]
    docs = [n for n in matched_nodes if n["type"] == "document"]

    parts: list[str] = []

    # Direct Answer Header
    parts.append(f"### Direct Answer: *\"{query}\"*\n")

    if mode == "path" and path and path.get("steps"):
        start_id = path["nodes"][0]
        end_id = path["nodes"][-1]
        s_name = nodes_map.get(start_id, {}).get("label", start_id)
        e_name = nodes_map.get(end_id, {}).get("label", end_id)
        hops = path["hops"]

        parts.append(
            f"In the Solvay SPARK enterprise architecture, **{s_name}** communicates with **{e_name}** through a **{hops}-hop integration route** "
            f"mediated by functional interface specifications and data conversion flows.\n"
        )

        parts.append("#### Multi-Hop Integration Path:")
        for idx, step in enumerate(path["steps"], 1):
            fr_lbl = step["from"]
            fr_type = step.get("from_type", "entity").upper()
            to_lbl = step["to"]
            to_type = step.get("to_type", "entity").upper()
            rel = step["relation"].replace("_", " ").title()
            parts.append(f"{idx}. `[{fr_type}]` **{fr_lbl}** ➔ *({rel})* ➔ `[{to_type}]` **{to_lbl}**")
        parts.append("")

    else:
        anchors = [n["label"] for n in matched_nodes if n["type"] in ("system", "stream")]
        anchor_txt = ", ".join(anchors[:3]) if anchors else "the Solvay SPARK architecture"
        parts.append(
            f"Based on the Solvay SPARK Knowledge Graph, your question relates to **{anchor_txt}**, "
            f"identifying **{len(matched_nodes)} connected entities** and **{len(edge_ids)} documented architectural relationships**.\n"
        )

    # Enterprise Systems & Business Streams
    if systems or streams:
        parts.append("#### Core Enterprise Systems & Streams:")
        for s in systems[:6]:
            desc = s.get("description") or "Core technical system in Solvay SPARK."
            code = s.get("code") or s["id"]
            lbl = s["label"]
            parts.append(f"- **{lbl}** (`{code}`): {desc}")
        for st in streams[:4]:
            desc = st.get("description") or "Business process stream."
            lbl = st["label"]
            parts.append(f"- **{lbl}** Stream: {desc}")
        parts.append("")

    # Specifications & JIRA Tickets
    if specs:
        parts.append(f"#### SPARK Functional Specifications ({len(specs)}):")
        for sp in specs[:10]:
            ticket = sp.get("ticket") or sp.get("code") or sp["label"]
            desc = sp.get("description")
            if not desc or desc == ticket:
                for e in graph["edges"]:
                    if (e["source"] == sp["id"] or e["target"] == sp["id"]) and "doc:" in (e["source"] + e["target"]):
                        doc_id = e["source"] if "doc:" in e["source"] else e["target"]
                        doc_node = nodes_map.get(doc_id)
                        if doc_node:
                            clean_doc = (
                                doc_node["label"]
                                .replace(".md", "")
                                .replace("_docx", "")
                                .replace("_xlsx", "")
                                .replace("_", " ")
                            )
                            desc = clean_doc
                            break
            desc_str = f" - *{desc}*" if desc and desc != ticket else ""
            parts.append(f"- **{ticket}**{desc_str}")
        if len(specs) > 10:
            parts.append(f"- *...and {len(specs) - 10} more specifications in this cluster.*")
        parts.append("")

    # BPML Processes
    if processes:
        parts.append(f"#### BPML Business Processes ({len(processes)}):")
        for p in processes[:8]:
            code = p.get("code") or p["label"]
            parts.append(f"- **{code}**: {p['label']}")
        if len(processes) > 8:
            parts.append(f"- *...and {len(processes) - 8} more processes.*")
        parts.append("")

    # Source Documents
    if docs:
        parts.append("#### Source Specification Documents:")
        for d in docs[:5]:
            fname = d.get("filename") or d["label"]
            chars = d.get("chars", 0)
            parts.append(f"- 📄 `{fname}` ({chars:,} chars)")
        if len(docs) > 5:
            parts.append(f"- *...and {len(docs) - 5} additional source documents.*")

    return "\n".join(parts)


def query_graph(
    query: str = "",
    source_id: str | None = None,
    target_id: str | None = None,
) -> dict[str, Any]:
    """Intelligently queries the knowledge graph via natural language, pathfinding, or entity matching."""
    graph = extract_graph()
    nodes_map = {n["id"]: n for n in graph["nodes"]}
    edges = graph["edges"]

    # Direct Pathfinding if source and target IDs given
    if source_id and target_id:
        path = find_shortest_path(graph, source_id, target_id)
        if path:
            s_label = nodes_map.get(source_id, {}).get("label", source_id)
            t_label = nodes_map.get(target_id, {}).get("label", target_id)
            res = {
                "query": f"Path from {s_label} to {t_label}",
                "mode": "path",
                "summary": f"Found shortest integration path between '{s_label}' and '{t_label}' ({path['hops']} hops).",
                "node_ids": path["nodes"],
                "edge_ids": path["edges"],
                "path": path,
                "stats": {"nodes_count": len(path["nodes"]), "edges_count": len(path["edges"])},
            }
            res["answer"] = generate_graph_answer(query or res["query"], res, graph)
            return res
        else:
            res = {
                "query": f"Path from {source_id} to {target_id}",
                "mode": "path",
                "summary": f"No direct or indirect path found connecting '{source_id}' and '{target_id}'.",
                "node_ids": [source_id, target_id],
                "edge_ids": [],
                "stats": {"nodes_count": 2, "edges_count": 0},
            }
            res["answer"] = f"No integration path was found in the Solvay SPARK Knowledge Graph between `{source_id}` and `{target_id}`."
            return res

    q = query.strip().lower()

    # Detect Natural Language Path query (e.g. "path between X and Y", "how does X connect to Y", "difference between X and Y")
    path_match = (
        re.search(
            r"(?:how does|how do)\s+([a-zA-Z0-9@_ /-]+?)\s+(?:connect|link|integrate|talk)\s+(?:to|with)\s+([a-zA-Z0-9@_ /?-]+)",
            q,
            re.I,
        )
        or re.search(
            r"(?:path|connection|link|integration|flow|difference|compare|relationship)\s+(?:between|from|of)\s+([a-zA-Z0-9@_ /-]+?)\s+(?:and|to|with|vs|versus)\s+([a-zA-Z0-9@_ /?-]+)",
            q,
            re.I,
        )
        or re.search(r"^([a-zA-Z0-9@_ /-]+?)\s+(?:to|->)\s+([a-zA-Z0-9@_ /-]+)$", q)
    )

    if path_match:
        from_str = path_match.group(1).strip().lower().rstrip("?").rstrip(".")
        to_str = path_match.group(2).strip().lower().rstrip("?").rstrip(".")

        # Find best matching node IDs
        def find_best_node(term: str) -> str | None:
            t = term.strip().lower().rstrip("?").rstrip(".")
            for n in graph["nodes"]:
                if t == n["label"].lower() or t == n["id"].lower() or (n.get("code") and t == n["code"].lower()):
                    return n["id"]
            for n in graph["nodes"]:
                if t in n["label"].lower() or t in n["id"].lower() or (n.get("code") and t in n["code"].lower()):
                    return n["id"]
            return None

        n1 = find_best_node(from_str)
        n2 = find_best_node(to_str)
        if n1 and n2 and n1 != n2:
            path = find_shortest_path(graph, n1, n2)
            if path:
                res = {
                    "query": query,
                    "mode": "path",
                    "summary": f"Discovered integration path between '{nodes_map[n1]['label']}' and '{nodes_map[n2]['label']}' ({path['hops']} hops).",
                    "node_ids": path["nodes"],
                    "edge_ids": path["edges"],
                    "path": path,
                    "stats": {"nodes_count": len(path["nodes"]), "edges_count": len(path["edges"])},
                }
                res["answer"] = generate_graph_answer(query, res, graph)
                return res

    # Entity neighborhood / pattern query
    matched_nodes_set: set[str] = set()
    matched_edges_set: set[str] = set()

    # Check for specific system or stream keywords
    target_type_filter: str | None = None
    if "spec" in q or "ticket" in q:
        target_type_filter = "spec"
    elif "process" in q or "bpml" in q:
        target_type_filter = "process"
    elif "doc" in q or "markdown" in q or "file" in q:
        target_type_filter = "document"

    # Find anchor nodes mentioned in the query
    anchor_nodes: list[dict[str, Any]] = []
    for n in graph["nodes"]:
        n_label = n["label"].lower()
        n_id = n["id"].lower()
        n_code = (n.get("code") or "").lower()
        n_ticket = (n.get("ticket") or "").lower()

        # Exact or strong partial match
        if (
            (len(q) > 2 and q in n_label)
            or (n_code and n_code in q)
            or (n_ticket and n_ticket in q)
            or (n_id in q)
        ):
            anchor_nodes.append(n)

    if not anchor_nodes:
        # Fallback: token matching
        tokens = [t for t in re.split(r"\W+", q) if len(t) > 2 and t not in ("all", "find", "show", "what", "with", "for", "the", "and", "path", "between", "from", "specs", "documents")]
        for n in graph["nodes"]:
            if any(t in n["label"].lower() for t in tokens):
                anchor_nodes.append(n)

    # If anchor nodes found, expand to 1-hop or 2-hop neighborhood
    if anchor_nodes:
        # Limit anchors to top 5 to keep visualization clean
        primary_anchors = sorted(anchor_nodes, key=lambda x: x.get("degree", 0), reverse=True)[:5]
        for a in primary_anchors:
            matched_nodes_set.add(a["id"])

        if target_type_filter:
            # 2-hop search: Find target entities via intermediate document/system bridges
            hop1_bridges: set[str] = set()
            for e in edges:
                src, tgt = e["source"], e["target"]
                if src in matched_nodes_set or tgt in matched_nodes_set:
                    other = tgt if src in matched_nodes_set else src
                    other_node = nodes_map.get(other)
                    if other_node:
                        if other_node["type"] == target_type_filter:
                            matched_nodes_set.add(other)
                            matched_edges_set.add(e["id"])
                        elif other_node["type"] in ("document", "system", "stream"):
                            hop1_bridges.add(other)

            # Hop 2 from bridges to target_type_filter
            target_hits: set[str] = set()
            for e in edges:
                src, tgt = e["source"], e["target"]
                if src in hop1_bridges or tgt in hop1_bridges:
                    bridge = src if src in hop1_bridges else tgt
                    other = tgt if src in hop1_bridges else src
                    other_node = nodes_map.get(other)
                    if other_node and other_node["type"] == target_type_filter:
                        matched_nodes_set.add(bridge)
                        matched_nodes_set.add(other)
                        target_hits.add(other)
                        matched_edges_set.add(e["id"])

            # Also add edges from anchors to the retained bridges
            for e in edges:
                if (e["source"] in matched_nodes_set and e["target"] in matched_nodes_set) and (
                    e["source"] in [a["id"] for a in primary_anchors] or e["target"] in [a["id"] for a in primary_anchors]
                ):
                    matched_edges_set.add(e["id"])

            anchor_labels = ", ".join(f"'{a['label']}'" for a in primary_anchors[:3])
            type_label = target_type_filter.capitalize() + "s"
            summary = f"Discovered {len(target_hits)} {type_label} connected to {anchor_labels} across {len(matched_nodes_set)} total entities."
        else:
            for e in edges:
                src, tgt = e["source"], e["target"]
                if src in matched_nodes_set or tgt in matched_nodes_set:
                    other = tgt if src in matched_nodes_set else src
                    other_node = nodes_map.get(other)
                    if other_node:
                        matched_nodes_set.add(other)
                        matched_edges_set.add(e["id"])

            anchor_labels = ", ".join(f"'{a['label']}'" for a in primary_anchors[:3])
            summary = f"Found {len(matched_nodes_set)} nodes and {len(matched_edges_set)} relationships connected to {anchor_labels}."
    else:
        # Fallback: global search across all nodes
        for n in graph["nodes"]:
            if q in n["label"].lower() or q in (n.get("description") or "").lower():
                matched_nodes_set.add(n["id"])

        # Include connecting edges between matched nodes
        for e in edges:
            if e["source"] in matched_nodes_set and e["target"] in matched_nodes_set:
                matched_edges_set.add(e["id"])

        summary = f"Matched {len(matched_nodes_set)} entities for '{query}'."

    res = {
        "query": query,
        "mode": "subgraph",
        "summary": summary,
        "node_ids": list(matched_nodes_set),
        "edge_ids": list(matched_edges_set),
        "stats": {
            "nodes_count": len(matched_nodes_set),
            "edges_count": len(matched_edges_set),
        },
    }
    res["answer"] = generate_graph_answer(query, res, graph)
    return res


if __name__ == "__main__":
    data = extract_graph(force=True)
    print(f"Extraction successful: {data['stats']['total_nodes']} nodes, {data['stats']['total_edges']} edges.")
    print("Types breakdown:", data["stats"]["types"])

    # Test query
    q1 = query_graph("specs linked to Salesforce")
    print("Query 'specs linked to Salesforce':", q1["summary"], len(q1["node_ids"]), "nodes")

    q2 = query_graph("path from eCommerce to S4HANA")
    print("Query path eCommerce -> S4HANA:", q2["summary"], len(q2["node_ids"]), "hops:", q2.get("path", {}).get("hops"))


