"""Per-session document uploads, shared by the agents that take attachments.

An analyst drops a PDF, Word, Excel or PowerPoint file into an agent, and for
the length of that session the agent can read it alongside the permanent
corpus -- to compare a new specification, or a country's As-Is process, against
what the project already decided, without that file becoming part of what
everyone else searches.

It sits beside rag.py rather than inside one agent's package because it is a
store, not an agent: InsightLens and the Fit-Gap Copilot both own
sessions in it, and each tags its documents with the role they play (see
ROLES).

Keeping it out is the whole point, so it is kept out in the strongest way the
storage allows:

  * a database of its own, `<base>_session`, next to the corpus database;
  * one Postgres *schema* per session inside it, `u_<id>`, holding the same
    rag_documents / rag_chunks tables the corpus uses;
  * UPLOAD is a reserved code in rag.py, so nothing can be filed under the
    category an attachment's chunks carry.

The isolation is the database boundary, not a filter: a corpus search runs
against the corpus database and these rows are not in it, so there is no WHERE
clause that could be got wrong.

A schema rather than a database per session because the isolation is the same
and the cost is not: a session holds tens of chunks, and CREATE DATABASE plus
an extension and an index for each of them buys nothing. `SET search_path` is
what makes this work -- the tables resolve inside the session's schema, so
rag.index_file and rag.search run against it unchanged, with no parallel
copy of the chunking, embedding or retrieval code to keep in step.

Everything expires. A session that is not used for UPLOAD_TTL_HOURS is swept:
the schema is dropped, the rows go with it, and the extracted Markdown on disk
is deleted.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

from backend.core.paths import ROOT
from typing import Callable, Sequence

from backend.graph import knowledge_graph
from backend.rag import rag
from backend.core import tracing

BASE = ROOT
# Outside knowledge_base/ and solvay-spark/, so neither the indexer nor the
# knowledge graph's source_folders() can pick these files up.
UPLOAD_DIR = BASE / ".workdir" / "uploads"

# What a document is in the analysis, which decides how an agent may use it.
# The Fit-Gap Copilot's whole method is a three-way comparison, so it has to be
# able to tell a country's As-Is apart from the Global Template and from SAP
# Best Practice content; InsightLens takes a plain attachment and
# leaves the role at "other".
ROLES = ("as_is", "template", "sap_bp", "localization", "other")
DEFAULT_ROLE = "other"

ROLE_LABEL = {
    "as_is": "Country As-Is",
    "template": "Global Template",
    "sap_bp": "SAP Best Practice",
    "localization": "Localization source",
    "other": "Reference",
}


def check_role(role: str | None) -> str:
    role = (role or DEFAULT_ROLE).strip().lower()
    if role not in ROLES:
        raise ValueError(f"not a document role: {role!r} (one of {', '.join(ROLES)})")
    return role


# The database holding every session's schema: docling_session, beside the
# corpus database rather than inside it. That is the isolation an analyst is
# promised when they attach a draft -- a corpus search cannot reach it, because
# it is not in the corpus database at all, and no WHERE clause is standing
# between the two.
SESSION_DATABASE = "SESSION"
# The category the chunks carry inside a session schema. It never appears in a
# corpus search: these rows are in another database, and UPLOAD is reserved so
# that nothing can be filed under it either.
CATEGORY = "UPLOAD"

TTL_HOURS = float(os.environ.get("FITGAP_UPLOAD_TTL_HOURS", "12"))
# Uploading is a conversion plus an embedding pass; a cap keeps one session
# from turning into a second corpus.
MAX_FILES = int(os.environ.get("FITGAP_UPLOAD_MAX_FILES", "12"))

# A session id reaches SQL as part of an identifier (CREATE SCHEMA "u_<id>"),
# which cannot be a bind parameter, so the form is fixed and checked.
_SESSION_ID = re.compile(r"[0-9a-f]{12}")


def check_session(sid: str) -> str:
    sid = (sid or "").strip().lower()
    if not _SESSION_ID.fullmatch(sid):
        raise ValueError(f"not an upload session id: {sid!r}")
    return sid


def schema_name(sid: str) -> str:
    return f"u_{check_session(sid)}"


# --- connections --------------------------------------------------------------

_local = threading.local()
_meta_ready = False
_meta_lock = threading.Lock()


def database_url() -> str:
    return rag.sibling_database(SESSION_DATABASE)


def live() -> bool:
    """Whether the session database has been created yet.

    A database is earned by a write: an installation where nobody ever attaches
    a document should not grow a docling_session for it. Callers that only want
    to tidy up or report should check this first rather than call connect(),
    which creates it."""
    return rag.database_live(database_url())


def connect():
    """A connection to the session database, on the public schema, where the
    two tables that outlive any one session live."""
    return _conn("public")


def session_connect(sid: str):
    """A connection whose search_path puts the session's schema first, so
    `rag_documents` and `rag_chunks` mean that session's tables and nothing
    else. `public` stays on the path for the `vector` type."""
    return _conn(schema_name(sid))


def _conn(schema: str):
    """One connection per schema per thread. psycopg connections are not
    thread safe, and the search_path is per connection, so these are never
    shared between threads or between schemas."""
    cache = getattr(_local, "conns", None)
    if cache is None:
        cache = _local.conns = {}
    conn = cache.get(schema)
    if conn is None or conn.closed:
        conn = cache[schema] = rag.connect(url=rag.ensure_sibling(SESSION_DATABASE))
        conn.execute(f'SET search_path TO "{schema}", public')
    return conn


def close() -> None:
    """Release this thread's connections to the session database."""
    for conn in getattr(_local, "conns", {}).values():
        try:
            conn.close()
        except Exception:
            pass
    _local.conns = {}


def create_schema(conn=None) -> None:
    """The two tables that outlive any one session. Done once per process --
    but only once it has actually succeeded, or a failed first attempt would
    mark it done and leave every later call querying a table that is not
    there."""
    global _meta_ready
    if _meta_ready:
        return
    conn = conn or connect()
    with conn.transaction():
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_sessions (
                id         text PRIMARY KEY,
                created_at timestamptz NOT NULL DEFAULT now(),
                used_at    timestamptz NOT NULL DEFAULT now(),
                expires_at timestamptz NOT NULL,
                graph      jsonb
            )"""
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_files (
                session_id text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
                name       text NOT NULL,
                role       text NOT NULL DEFAULT 'other',
                format     text NOT NULL DEFAULT '',
                bytes      bigint NOT NULL DEFAULT 0,
                pages      int NOT NULL DEFAULT 0,
                unit       text NOT NULL DEFAULT 'pages',
                chunks     int NOT NULL DEFAULT 0,
                tokens     int NOT NULL DEFAULT 0,
                seconds    real NOT NULL DEFAULT 0,
                markdown   text NOT NULL DEFAULT '',
                added_at   timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (session_id, name)
            )"""
        )
        # Added with ALTER so a session store created before roles existed
        # gains the column instead of failing on every insert. Everything in
        # it predates the Fit-Gap Copilot, so "other" is the honest default.
        conn.execute(
            "ALTER TABLE upload_files ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'other'"
        )
        # Whose session this is. No foreign key: the accounts are in the main
        # database and this is a database of its own. A session from before
        # accounts has none, belongs to nobody and expires within hours.
        conn.execute("ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS user_id bigint")
    with _meta_lock:
        _meta_ready = True


# --- the session lifecycle ----------------------------------------------------


def _ttl() -> str:
    return f"{max(TTL_HOURS, 0.1)} hours"


def new_session(user_id: int | None = None) -> str:
    """Create a session, owned by `user_id`: a row, a schema, and the rag
    tables inside it."""
    import uuid

    conn = connect()
    create_schema(conn)
    sid = uuid.uuid4().hex[:12]
    conn.execute(
        "INSERT INTO upload_sessions (id, expires_at, user_id)"
        " VALUES (%s, now() + %s::interval, %s)",
        (sid, _ttl(), user_id),
    )
    scoped = session_connect(sid)
    scoped.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema_name(sid)}"')
    rag.create_schema(scoped)
    _dir(sid).mkdir(parents=True, exist_ok=True)
    return sid


def exists(sid: str) -> bool:
    check_session(sid)
    if not live():
        return False
    conn = connect()
    create_schema(conn)
    return bool(
        conn.execute(
            "SELECT 1 FROM upload_sessions WHERE id = %s AND expires_at > now()",
            (check_session(sid),),
        ).fetchone()
    )


def owner(sid: str) -> int | None:
    """The account a live session belongs to, or None (no such session, or
    one from before accounts)."""
    if not live():
        return None
    conn = connect()
    create_schema(conn)
    r = conn.execute("SELECT user_id FROM upload_sessions WHERE id = %s AND expires_at > now()",
                     (check_session(sid),)).fetchone()
    return r[0] if r else None


def touch(sid: str) -> None:
    """Push the expiry out. Called whenever a session is read or written, so a
    InsightLens run in progress cannot have its own uploads swept out from under
    it."""
    connect().execute(
        "UPDATE upload_sessions SET used_at = now(), expires_at = now() + %s::interval"
        " WHERE id = %s",
        (_ttl(), check_session(sid)),
    )


def drop(sid: str) -> None:
    """Delete a session now: its schema, its rows and its extracted Markdown."""
    sid = check_session(sid)
    conn = connect()
    create_schema(conn)
    conn.execute(f'DROP SCHEMA IF EXISTS "{schema_name(sid)}" CASCADE')
    conn.execute("DELETE FROM upload_sessions WHERE id = %s", (sid,))
    shutil.rmtree(_dir(sid), ignore_errors=True)
    for key in (schema_name(sid),):
        c = getattr(_local, "conns", {}).pop(key, None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass


def sweep() -> int:
    """Drop every expired session, and any schema left behind by one.

    The orphan pass matters because a schema and its row are dropped in two
    statements: a crash between them would otherwise leave a session's chunks
    on disk for good, which is exactly what the retention rule forbids."""
    if not live():
        return 0
    conn = connect()
    create_schema(conn)
    expired = [
        r[0] for r in conn.execute(
            "SELECT id FROM upload_sessions WHERE expires_at < now()"
        ).fetchall()
    ]
    for sid in expired:
        try:
            drop(sid)
        except Exception:
            pass
    known = {
        schema_name(r[0])
        for r in conn.execute("SELECT id FROM upload_sessions").fetchall()
    }
    orphans = [
        r[0] for r in conn.execute(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'u\\_%'"
        ).fetchall()
        if r[0] not in known
    ]
    for name in orphans:
        if re.fullmatch(r"u_[0-9a-f]{12}", name):
            conn.execute(f'DROP SCHEMA IF EXISTS "{name}" CASCADE')
    # Directories for sessions the database no longer knows about.
    if UPLOAD_DIR.is_dir():
        current = {r[0] for r in conn.execute("SELECT id FROM upload_sessions").fetchall()}
        for path in UPLOAD_DIR.iterdir():
            if path.is_dir() and path.name not in current:
                shutil.rmtree(path, ignore_errors=True)
    return len(expired) + len(orphans)


def _dir(sid: str) -> Path:
    return UPLOAD_DIR / check_session(sid)


# --- adding a document --------------------------------------------------------


def add_file(sid: str, src: Path, name: str, role: str | None = None,
             on_event: Callable[[str, dict], None] | None = None) -> dict:
    """Convert one uploaded document to Markdown, chunk it, embed it into the
    session's schema, and rebuild the session's graph.

    `on_event(stage, detail)` is called as each stage starts, so the UI can
    show conversion and embedding separately -- conversion of a large deck is
    much the slower of the two and a single spinner hides that."""
    from backend.ingestion.converter import convert

    sid = check_session(sid)
    role = check_role(role)
    if not exists(sid):
        raise ValueError("this upload session has expired")
    conn = connect()
    n = conn.execute("SELECT count(*) FROM upload_files WHERE session_id = %s", (sid,)).fetchone()[0]
    if n >= MAX_FILES:
        raise ValueError(
            f"an upload session holds at most {MAX_FILES} "
            f"document{'' if MAX_FILES == 1 else 's'}"
        )

    say = on_event or (lambda *a: None)
    folder = _dir(sid)
    folder.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    # Ingestion is a trace of its own -- a document comes in, is converted,
    # chunked, embedded and graphed. It is the other thing in this application
    # that takes minutes, and the three stages are wildly uneven: converting a
    # large deck dwarfs the rest, which is exactly the kind of thing a flat
    # timing in the UI cannot show and a trace can. The session id ties it to
    # the analyses that later read it.
    run = tracing.start_run(
        "ingest-document",
        as_type="chain",
        input={"name": name, "role": role, "bytes": src.stat().st_size},
        metadata={"session": sid, "schema": schema_name(sid), "category": CATEGORY},
        session_id=sid,
        tags=["upload", f"role-{role}"],
    )
    try:
        say("converting", {"name": name})
        with run.step("convert-to-markdown", input={"name": name}) as span:
            result = convert(src, media_dir=folder / "media", title=Path(name).stem)
            span.update(output={"pages": result.pages, "unit": result.unit,
                                "characters": len(result.markdown)})

        md = _md_path(sid, name)
        md.write_text(result.markdown, encoding="utf-8")

        say("embedding", {"name": name})
        # Not force=True: a re-upload of a byte-identical file should cost no
        # embedding call, and one that really changed has a different fingerprint
        # and is re-embedded without being told to.
        with run.step("chunk-and-embed", as_type="embedding", model=rag.EMBED_MODEL,
                      input={"markdown": md.name}) as span:
            indexed = rag.index_file(session_connect(sid), md, category=CATEGORY)
            span.update(output={k: indexed.get(k) for k in ("title", "chunks", "tokens")})
    except Exception as exc:
        run.fail(exc)
        run.end()
        raise

    conn.execute(
        """
        INSERT INTO upload_files (session_id, name, role, format, bytes, pages, unit, chunks,
                                  tokens, seconds, markdown)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (session_id, name) DO UPDATE SET
            role = EXCLUDED.role, format = EXCLUDED.format, bytes = EXCLUDED.bytes,
            pages = EXCLUDED.pages, unit = EXCLUDED.unit, chunks = EXCLUDED.chunks,
            tokens = EXCLUDED.tokens, seconds = EXCLUDED.seconds,
            markdown = EXCLUDED.markdown, added_at = now()
        """,
        (sid, name, role, Path(name).suffix.lstrip(".").lower(), src.stat().st_size,
         result.pages, result.unit, indexed["chunks"], indexed["tokens"],
         round(time.perf_counter() - started, 2), result.markdown),
    )

    say("graph", {"name": name})
    with run.step("extract-graph") as span:
        graph_stats = rebuild_graph(sid)
        span.update(output=graph_stats)
    touch(sid)
    run.end(output={"title": indexed["title"], "chunks": indexed["chunks"],
                    "tokens": indexed["tokens"], "pages": result.pages,
                    "graph": graph_stats,
                    "seconds": round(time.perf_counter() - started, 2)})
    return {
        "name": name,
        "title": indexed["title"],
        "role": role,
        "format": Path(name).suffix.lstrip(".").lower(),
        "pages": result.pages,
        "unit": result.unit,
        "chunks": indexed["chunks"],
        "tokens": indexed["tokens"],
        "seconds": round(time.perf_counter() - started, 2),
        "graph": graph_stats,
    }


def remove_file(sid: str, name: str) -> dict:
    """Drop one document from a session: its chunks, its row and its Markdown."""
    sid = check_session(sid)
    conn = connect()
    row = conn.execute(
        "DELETE FROM upload_files WHERE session_id = %s AND name = %s RETURNING name",
        (sid, name),
    ).fetchone()
    if not row:
        return {"removed": False}
    md = _md_path(sid, name)
    session_connect(sid).execute("DELETE FROM rag_documents WHERE source = %s", (str(md.resolve()),))
    md.unlink(missing_ok=True)
    return {"removed": True, "graph": rebuild_graph(sid)}


# --- the session's own knowledge graph ----------------------------------------


def md_name(name: str) -> str:
    """The Markdown file name an attachment is indexed under -- the `source`
    its chunks carry, so a citation can be traced back to its attachment."""
    stem, suffix = Path(name).stem, Path(name).suffix.lower().replace(".", "_")
    return f"{stem}{suffix}.md"


def _md_path(sid: str, name: str) -> Path:
    return _dir(sid) / md_name(name)


def markdown(sid: str, name: str) -> str | None:
    """One attached document's Markdown, as it was indexed.

    For the traceability view: a citation from an attachment has to be
    openable in the same way a citation from the corpus is, and the converted
    Markdown is what the agent actually read -- the original file may be a
    deck nobody can render here."""
    sid = check_session(sid)
    row = connect().execute(
        "SELECT markdown FROM upload_files WHERE session_id = %s AND name = %s",
        (sid, name),
    ).fetchone()
    return row[0] if row else None


def _markdown_files(sid: str) -> list[tuple[Path, str, str]]:
    """(path, label, category) for extract_graph, restoring any file whose
    Markdown is in the database but no longer on disk -- a restart, or a
    cleared .workdir, must not silently shrink the graph."""
    sid = check_session(sid)
    _dir(sid).mkdir(parents=True, exist_ok=True)
    out = []
    for name, markdown in connect().execute(
        "SELECT name, markdown FROM upload_files WHERE session_id = %s ORDER BY name", (sid,)
    ).fetchall():
        path = _md_path(sid, name)
        if not path.exists():
            path.write_text(markdown, encoding="utf-8")
        out.append((path, f"upload/{name}", CATEGORY))
    return out


def roles_by_source(sid: str) -> dict[str, str]:
    """{absolute .md path: role}. Retrieval filters on this rather than on a
    column of its own: the role belongs to the document, rag_chunks has no
    place to put it, and a session is small enough that over-fetching and
    filtering costs nothing."""
    return {
        str(_md_path(sid, name).resolve()): role
        for name, role in connect().execute(
            "SELECT name, role FROM upload_files WHERE session_id = %s", (check_session(sid),)
        ).fetchall()
    }


def set_role(sid: str, name: str, role: str) -> dict:
    """Re-tag a document without re-converting or re-embedding it."""
    role = check_role(role)
    row = connect().execute(
        "UPDATE upload_files SET role = %s WHERE session_id = %s AND name = %s RETURNING name",
        (role, check_session(sid), name),
    ).fetchone()
    return {"updated": bool(row), "name": name, "role": role}


def rebuild_graph(sid: str) -> dict:
    """Extract a graph from the session's documents alone and store it.

    `cache=False` is not optional: extract_graph writes knowledge_graph.json
    when it caches, and one analyst's upload must not become the graph every
    other page of the UI reads."""
    sid = check_session(sid)
    files = _markdown_files(sid)
    graph = knowledge_graph.extract_graph(files=files, cache=False) if files else {
        "nodes": [], "edges": [], "stats": {"total_nodes": 0, "total_edges": 0, "types": {}}
    }
    connect().execute(
        "UPDATE upload_sessions SET graph = %s WHERE id = %s", (json.dumps(graph), sid)
    )
    return {k: v for k, v in graph["stats"].items() if k in ("total_nodes", "total_edges", "types")}


def graph(sid: str) -> dict:
    """The session's stored graph, extracted now if it has not been yet."""
    sid = check_session(sid)
    row = connect().execute("SELECT graph FROM upload_sessions WHERE id = %s", (sid,)).fetchone()
    if row and row[0]:
        return row[0]
    rebuild_graph(sid)
    row = connect().execute("SELECT graph FROM upload_sessions WHERE id = %s", (sid,)).fetchone()
    return (row[0] if row and row[0] else {"nodes": [], "edges": [], "stats": {}})


def _documents_for(sid: str, roles: Sequence[str] | None) -> set[str] | None:
    """The graph document-node ids belonging to a set of roles, or None for
    every one of them. A document node is `doc:<markdown file name>`."""
    if not roles:
        return None
    wanted = {check_role(r) for r in roles}
    return {
        f"doc:{Path(src).name}"
        for src, role in roles_by_source(sid).items()
        if role in wanted
    }


def _upload_subgraph(sid: str, roles: Sequence[str] | None = None) -> tuple[list[dict], dict[str, dict]]:
    """The uploaded documents and everything one hop from them.

    A session graph carries the whole scaffolding -- every stream, system and
    BPML process -- because it is built by the same extractor as the corpus
    graph, so that the two can be compared. Only what the upload actually
    touches is interesting, and that is its documents plus their neighbours."""
    g = graph(sid)
    nodes = {n["id"]: n for n in g.get("nodes", [])}
    keep = _documents_for(sid, roles)
    docs = [n for n in nodes.values()
            if n.get("type") == "document" and (keep is None or n["id"] in keep)]
    doc_ids = {n["id"] for n in docs}
    touched: dict[str, dict] = {}
    for e in g.get("edges", []):
        for near, far in ((e["source"], e["target"]), (e["target"], e["source"])):
            if near in doc_ids and far not in doc_ids and far in nodes:
                touched.setdefault(far, nodes[far])
    return docs, touched


def compare(sid: str, roles: Sequence[str] | None = None,
            categories: Sequence[str] | None = None) -> dict:
    """What the uploaded documents have in common with the corpus, and what is
    only in them.

    This is the comparison the upload exists for: an entity the corpus already
    knows is a thread to pull -- search it and find what the project decided --
    and one it does not is either genuinely new or named differently here.

    `categories` is the run's scope, and it belongs here for the same reason it
    belongs on the graph tools: "the corpus already knows this ticket" is a
    claim about the corpus the run may READ. Answered against the whole graph
    it sent a PKG-scoped run to pull a thread that only exists in DR, and named
    the DR documents to look in -- documents its own retrieval would then
    return nothing for."""
    docs, touched = _upload_subgraph(sid, roles)
    main = knowledge_graph.extract_graph()
    codes = [c.strip().upper() for c in (categories or []) if c and c.strip()]
    if codes:
        main = knowledge_graph.filter_by_categories(main, codes)
    main_nodes = {n["id"]: n for n in main["nodes"]}
    # Which corpus documents mention each shared entity, so the agent knows
    # where to look rather than having to search blind.
    mentions: dict[str, list[str]] = {}
    for e in main["edges"]:
        for near, far in ((e["source"], e["target"]), (e["target"], e["source"])):
            n = main_nodes.get(near)
            if n and n.get("type") == "document" and far in touched:
                mentions.setdefault(far, []).append(n["label"])

    entities = []
    for nid, n in touched.items():
        in_corpus = nid in main_nodes
        entities.append({
            "node_id": nid,
            "type": n.get("type", ""),
            "label": n.get("label", ""),
            "code": n.get("code"),
            "ticket": n.get("ticket"),
            "in_corpus": in_corpus,
            # Capped, with the real count beside it: a system every document
            # mentions would otherwise look as specific as a ticket one does.
            "corpus_documents": sorted(set(mentions.get(nid, [])))[:6],
            "corpus_mentions": len(set(mentions.get(nid, []))),
        })
    entities.sort(key=lambda e: (not e["in_corpus"], e["type"], e["label"]))
    shared = [e for e in entities if e["in_corpus"]]
    return {
        "documents": [{"node_id": d["id"], "label": d.get("label", "")} for d in docs],
        "entities": entities,
        "shared": len(shared),
        "new": len(entities) - len(shared),
        # "New" means new to what this run may read, not new to the corpus.
        "scope": codes,
    }


# --- reading it back ----------------------------------------------------------


def search(sid: str, query: str, k: int = 8, mode: str = "hybrid",
           roles: Sequence[str] | None = None) -> list[rag.Hit]:
    """Hybrid retrieval over one session's uploads and nothing else.

    `conn` keeps rag.search inside this one connection, whose search_path is
    the session's schema -- so there is no filter to get wrong and no way for
    the query to reach a corpus database.

    `roles` narrows it further, to the As-Is documents or the Global Template
    ones. Over-fetch and filter, because the role is not a column rag.search
    knows about; a session holds tens of chunks, so the cost is nothing."""
    if not exists(sid):
        return []
    wanted = {check_role(r) for r in roles} if roles else None
    hits = rag.search(query, k=k * 4 if wanted else k, conn=session_connect(sid), mode=mode)
    if not wanted:
        return hits
    by_source = roles_by_source(sid)
    kept = [h for h in hits if by_source.get(str(Path(h.source).resolve()), DEFAULT_ROLE) in wanted]
    return kept[:k]


def chunk(sid: str, chunk_id: int) -> dict | None:
    """One chunk of an uploaded document, by row id.

    rag.chunk cannot serve these: it routes on the category in the key, and
    UPLOAD names no database of its own -- deliberately."""
    if not exists(sid):
        return None
    try:
        chunk_id = int(chunk_id)
    except (TypeError, ValueError):
        return None
    row = session_connect(sid).execute(
        "SELECT c.id, d.title, d.source, c.heading_path, c.content, c.tokens"
        " FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.id = %s",
        (int(chunk_id),),
    ).fetchone()
    if not row:
        return None
    return {"chunk_id": row[0], "title": row[1], "source": row[2],
            "heading_path": row[3], "content": row[4], "tokens": row[5],
            "category": CATEGORY}


def files(sid: str) -> list[dict]:
    rows = connect().execute(
        "SELECT name, role, format, bytes, pages, unit, chunks, tokens, seconds, added_at"
        " FROM upload_files WHERE session_id = %s ORDER BY added_at",
        (check_session(sid),),
    ).fetchall()
    return [
        {"name": r[0], "role": r[1], "role_label": ROLE_LABEL.get(r[1], r[1]),
         "format": r[2], "bytes": r[3], "pages": r[4], "unit": r[5],
         "chunks": r[6], "tokens": r[7], "seconds": r[8],
         "added_at": r[9].isoformat() if r[9] else None}
        for r in rows
    ]


def info(sid: str) -> dict:
    """Everything the UI needs to show a session, or `{"exists": False}`."""
    check_session(sid)
    if not live():
        return {"session": sid, "exists": False, "files": [], "documents": 0, "chunks": 0}
    conn = connect()
    create_schema(conn)
    row = conn.execute(
        "SELECT created_at, used_at, expires_at FROM upload_sessions"
        " WHERE id = %s AND expires_at > now()",
        (check_session(sid),),
    ).fetchone()
    if not row:
        return {"session": sid, "exists": False, "files": [], "documents": 0, "chunks": 0}
    listed = files(sid)
    g = graph(sid)
    stats = g.get("stats", {}) if isinstance(g, dict) else {}
    docs, touched = _upload_subgraph(sid)
    return {
        "session": sid,
        "exists": True,
        "created_at": row[0].isoformat(),
        "used_at": row[1].isoformat(),
        "expires_at": row[2].isoformat(),
        "ttl_hours": TTL_HOURS,
        "max_files": MAX_FILES,
        "database": rag.database_name(database_url()),
        "schema": schema_name(sid),
        "files": listed,
        "documents": len(listed),
        "chunks": sum(f["chunks"] for f in listed),
        "tokens": sum(f["tokens"] for f in listed),
        "graph": {
            "total_nodes": stats.get("total_nodes", 0),
            "total_edges": stats.get("total_edges", 0),
            # The scaffolding is in every session graph; what the upload itself
            # put there is its documents and their neighbours.
            "entities": len(touched),
            "documents": len(docs),
        },
    }


def titles(sid: str, roles: Sequence[str] | None = None) -> list[str]:
    """The document titles in a session, for the agent's scope note."""
    if not exists(sid):
        return []
    rows = session_connect(sid).execute(
        "SELECT title, source FROM rag_documents ORDER BY title").fetchall()
    if not roles:
        return [r[0] for r in rows]
    wanted = {check_role(r) for r in roles}
    by_source = roles_by_source(sid)
    return [t for t, src in rows if by_source.get(str(Path(src).resolve()), DEFAULT_ROLE) in wanted]
