# 04 — RAG (Ask), Database Schema, Answer Quality / Evaluation

Scope: `backend/rag/*.py`, every Postgres DDL statement in `backend/`, the Ask
API path in `backend/api/app.py`, Ragas evaluation, the Answer-Quality
workspace arithmetic. Paths are repo-relative. **FACT** = read in code
(file:line). **INFERRED** = deduced, not directly stated. **DOC** = from docs only.

---

## 0. Big picture

* One Postgres database (`DATABASE_URL`, e.g. `.../docling` locally,
  `.../solvay` in compose) holds: the corpus (`rag_documents`, `rag_chunks`,
  `rag_categories`), Ask history + evaluations, experiments, and every agent
  run store (evidence, fitgap, rollout, workshop, graph-quality). FACT
  `rag.py:256-262`, `ask_store.py:73-75`, `fitgap/store.py:26-30`.
* A sibling database `<base>_session` (e.g. `docling_session`) holds uploaded
  attachments, one Postgres **schema per session** (`u_<12 hex>`), each with its
  own copy of `rag_documents`/`rag_chunks`. FACT `rag.py:265-277`,
  `core/uploads.py:90,101-111,229-245`.
* Hindsight (memory service) uses its own DB `hindsight` on the same server,
  created by compose one-shot `solvay-hindsight-db`; its schema is owned by
  Hindsight, not this app. FACT `compose.yml:76-95,110`.
* Postgres image in compose: `docker.io/pgvector/pgvector:pg18`. FACT
  `compose.yml:57`. Local docs: Homebrew `postgresql@18`. DOC `docs/rag.md:17-23`.
* Python deps: `psycopg[binary]`, `pgvector`, `anthropic`, `langfuse`,
  `opentelemetry-instrumentation-anthropic`, `ragas`, `langchain-community<0.4`
  (pin required for `import ragas` to work), plus `instructor`, `scipy`,
  `numpy`, `httpx`, `python-dotenv`. FACT `requirements.txt:12-47`; scipy/instructor
  INFERRED as transitive or listed elsewhere (imported in `quality.py:246`,
  `evaluation.py:287`).

## 1. Migrations approach (FACT)

* **No migration framework.** Every store runs idempotent DDL
  (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) lazily from Python, on first use.
* Corpus schema: `rag.connection()` runs `create_schema` **once per process**
  guarded by `_schema_ready` + `threading.Lock` (`rag.py:509-528`). `rag.connect()`
  always runs `CREATE EXTENSION IF NOT EXISTS vector`, `register_vector`, and
  `_tune` (`rag.py:471-487`).
* Dimension auto-rebuild: after create, reads `pg_attribute.atttypmod` of
  `rag_chunks.embedding`; if `!= EMBED_DIMENSION` it **drops and recreates**
  `rag_chunks, rag_documents` (`rag.py:543-553`). (Destructive; re-index needed.)
* `ask_store` / `experiment_store`: DDL once per process **per database URL**
  (`_ready: set[str]` + lock) because `ALTER TABLE ADD COLUMN IF NOT EXISTS` takes
  ACCESS EXCLUSIVE before checking and concurrent requests deadlocked
  (`ask_store.py:84-111`, `experiment_store.py:36-50`). Test
  `test_the_schema_is_brought_up_once_however_many_requests_arrive`.
* `fitgap/store.py`, `rollout/store.py`, `evidence/store.py`: `create_schema`
  runs each time it's called (no once-guard) inside `conn.transaction()`.
  `graph_eval._conn()` runs its DDL on every call (`graph/graph_eval.py:543-558`).
* All connections: psycopg3, `autocommit=True`, thread-local cached
  (`rag.connection(schema=False)` shared by all stores); callers must not close;
  worker threads call `rag.close()` in `finally`. FACT `rag.py:471-540`,
  `app.py` `_judge` finally.
* Constraint migration done in code: `_link_chunks_to_documents` replaces the
  plain FK with composite `(document_id, category)` FK if
  `rag_chunks_document_fkey` absent (`rag.py:666-701`).
* One-off migration tool `backend/rag/consolidate.py` (merge per-category DBs
  into one; §9).

## 2. Complete Postgres schema (verbatim DDL, all modules)

### 2.1 Corpus — owner `backend/rag/rag.py` (`_create_tables`, `_create_category_columns`, `_link_chunks_to_documents`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;                          -- rag.py:484 (every connect)

CREATE TABLE IF NOT EXISTS rag_documents (                      -- rag.py:561-567
    id          bigserial PRIMARY KEY,
    source      text NOT NULL UNIQUE,   -- path of the .md file; an identity again
    title       text NOT NULL,          -- original document, e.g. "X (pptx)"
    fingerprint text NOT NULL,          -- file content + chunking and embedding settings
    indexed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag_chunks (                         -- rag.py:571-580 ({EMBED_DIMENSION}=1024)
    id           bigserial PRIMARY KEY,
    document_id  bigint NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    chunk_index  int NOT NULL,
    heading_path text NOT NULL,
    content      text NOT NULL,
    tokens       int NOT NULL,
    embedding    vector(1024) NOT NULL,
    UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
    ON rag_chunks USING hnsw (embedding vector_cosine_ops);    -- rag.py:583-586 (default m/ef_construction)
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS tsv tsvector;   -- rag.py:589
CREATE INDEX IF NOT EXISTS rag_chunks_tsv_idx ON rag_chunks USING gin (tsv);  -- rag.py:590
-- then: backfill tsv for rows WHERE tsv IS NULL:
--   UPDATE rag_chunks SET tsv = to_tsvector('english', keyword_text(with_context(title, heading_path, content))) WHERE id = ?

ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'UNFILED';  -- rag.py:612-615
ALTER TABLE rag_chunks    ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'UNFILED';
CREATE INDEX IF NOT EXISTS rag_chunks_category_idx ON rag_chunks (category);        -- rag.py:616
CREATE INDEX IF NOT EXISTS rag_documents_category_idx ON rag_documents (category);  -- rag.py:617

CREATE TABLE IF NOT EXISTS rag_categories (                     -- rag.py:620-625
    code        text PRIMARY KEY,
    label       text NOT NULL,
    description text NOT NULL DEFAULT '',
    folder      text NOT NULL DEFAULT ''
);
-- seeded from CATEGORIES with ON CONFLICT (code) DO NOTHING (never overwritten)

-- _link_chunks_to_documents (only if constraint 'rag_chunks_document_fkey' absent), rag.py:679-701:
UPDATE rag_chunks c SET category = d.category FROM rag_documents d
 WHERE d.id = c.document_id AND c.category <> d.category;
ALTER TABLE rag_documents ADD CONSTRAINT rag_documents_id_category_key UNIQUE (id, category);
-- drop every existing FK on rag_chunks (loop over pg_constraint contype='f'), then:
ALTER TABLE rag_chunks ADD CONSTRAINT rag_chunks_document_fkey
  FOREIGN KEY (document_id, category) REFERENCES rag_documents (id, category)
  ON DELETE CASCADE ON UPDATE CASCADE;
```

Effective final shape of `rag_chunks`: id, document_id, chunk_index,
heading_path, content, tokens, embedding vector(1024), tsv tsvector, category
text NOT NULL DEFAULT 'UNFILED'; UNIQUE(document_id, chunk_index); composite FK.
`rag_documents` adds category + UNIQUE(id, category).

Session tuning per connection (`rag.py:490-506`):
```sql
SET hnsw.ef_search = 800;                 -- RAG_HNSW_EF_SEARCH (default 800)
SET hnsw.iterative_scan = relaxed_order;  -- try/except: pgvector < 0.8 lacks it
```

Seeded categories (`rag.py:122-138`):
| code | label | description | folder |
|---|---|---|---|
| PKG | PKG | Package documents, converted from solvay-spark/pkg | solvay-spark/pkg/markdown |
| DR | DR | Design review documents | solvay-spark/dr/markdown |
| UNFILED | Unfiled | Added from the web UI without a category, or indexed before categories existed | knowledge_base |

`RESERVED_CODES = {"FITGAP","ROLLOUT","SESSION","UPLOAD"}`; category code regex
`[A-Z][A-Z0-9_]{0,31}` (upper-cased first) — `check_category` raises ValueError
(`rag.py:152-168`). Reserved codes excluded from `known_categories()`; test
`test_a_reserved_code_is_not_a_category`.

### 2.2 Migration-only table — owner `backend/rag/consolidate.py` (created only in merge target)

```sql
CREATE TABLE IF NOT EXISTS rag_chunk_id_map (                   -- consolidate.py:282-290
    old_database text   NOT NULL,
    kind         text   NOT NULL,          -- 'document' or 'chunk'
    old_id       bigint NOT NULL,
    new_id       bigint NOT NULL,
    category     text   NOT NULL,
    migrated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (old_database, kind, old_id)
);
```
consolidate also creates `rag_documents` with category + `UNIQUE (id, category)`
inline and `rag_chunks` with no FK/indexes (added after COPY), `rag_categories`
(`consolidate.py:239-276`), then `SET maintenance_work_mem='512MB'` and builds
FK/HNSW/GIN/category indexes, `ANALYZE` (`consolidate.py:354-388`).

### 2.3 Ask history & evaluation — owner `backend/rag/ask_store.py:114-230`

```sql
CREATE TABLE IF NOT EXISTS ask_runs (
    id            text PRIMARY KEY,
    question      text NOT NULL,
    mode          text NOT NULL DEFAULT 'hybrid',
    k             int  NOT NULL DEFAULT 8,
    categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
    answer_model  text NOT NULL DEFAULT '',
    embed_model   text NOT NULL DEFAULT '',
    corpus_fingerprint text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running',
    seconds       real NOT NULL DEFAULT 0,
    input_tokens  int NOT NULL DEFAULT 0,
    output_tokens int NOT NULL DEFAULT 0,
    answer        text NOT NULL DEFAULT '',
    sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
    terms         jsonb NOT NULL DEFAULT '[]'::jsonb,
    error         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ask_runs_started_idx ON ask_runs (started_at DESC);
ALTER TABLE ask_runs ADD COLUMN IF NOT EXISTS trace_id text NOT NULL DEFAULT '';
ALTER TABLE ask_runs ADD COLUMN IF NOT EXISTS prompt_hash text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS ask_evaluations (
    run_id        text PRIMARY KEY
                  REFERENCES ask_runs(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'running',
    judge_model   text NOT NULL DEFAULT '',
    ragas_version text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    seconds       real NOT NULL DEFAULT 0,
    metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
    overall       real,
    safety        real,
    terms         jsonb NOT NULL DEFAULT '{}'::jsonb,
    scores_pushed int  NOT NULL DEFAULT 0,
    error         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ask_evaluations_overall_idx ON ask_evaluations (overall);

CREATE TABLE IF NOT EXISTS ask_evaluation_history (
    id          bigserial PRIMARY KEY,
    run_id      text NOT NULL REFERENCES ask_runs(id) ON DELETE CASCADE,
    finished_at timestamptz NOT NULL DEFAULT now(),
    judge_model text NOT NULL DEFAULT '',
    overall     real,
    safety      real,
    scores      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ask_evaluation_history_run_idx
    ON ask_evaluation_history (run_id, finished_at);

CREATE TABLE IF NOT EXISTS ask_reviews (
    run_id     text PRIMARY KEY REFERENCES ask_runs(id) ON DELETE CASCADE,
    verdict    text NOT NULL,
    reviewer   text NOT NULL DEFAULT '',
    note       text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
```

### 2.4 Experiments — owner `backend/rag/experiment_store.py:53-88`

```sql
CREATE TABLE IF NOT EXISTS eval_experiments (
    id           text PRIMARY KEY,
    name         text NOT NULL,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    status       text NOT NULL DEFAULT 'running',
    config       jsonb NOT NULL DEFAULT '{}'::jsonb,
    baseline     boolean NOT NULL DEFAULT false,
    langfuse_url text NOT NULL DEFAULT '',
    error        text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS eval_experiment_items (
    experiment_id text NOT NULL
                  REFERENCES eval_experiments(id) ON DELETE CASCADE,
    item_id       text NOT NULL,
    question      text NOT NULL DEFAULT '',
    part          text NOT NULL DEFAULT '',
    answer        text NOT NULL DEFAULT '',
    sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
    metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
    overall       real,
    safety        real,
    input_tokens  int NOT NULL DEFAULT 0,
    output_tokens int NOT NULL DEFAULT 0,
    seconds       real NOT NULL DEFAULT 0,
    error         text NOT NULL DEFAULT '',
    PRIMARY KEY (experiment_id, item_id)
);
```

### 2.5 Evidence Agent — owner `backend/agents/evidence/store.py:53-96`

```sql
CREATE TABLE IF NOT EXISTS evidence_runs (
    id            text PRIMARY KEY,
    question      text NOT NULL,
    holdout       boolean NOT NULL DEFAULT false,
    categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
    model         text NOT NULL DEFAULT '',
    prompt_hash   text NOT NULL DEFAULT '',
    corpus_fingerprint text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running',
    state         text NOT NULL DEFAULT '',
    input_tokens  int NOT NULL DEFAULT 0,
    output_tokens int NOT NULL DEFAULT 0,
    seconds       real NOT NULL DEFAULT 0,
    answer        jsonb,
    calls         jsonb NOT NULL DEFAULT '[]'::jsonb,
    error         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS evidence_runs_started_idx ON evidence_runs (started_at DESC);
ALTER TABLE evidence_runs ADD COLUMN IF NOT EXISTS memory jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE evidence_runs ADD COLUMN IF NOT EXISTS log jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evidence_runs ADD COLUMN IF NOT EXISTS evaluation jsonb NOT NULL DEFAULT '{}'::jsonb;
```

### 2.6 Fit-Gap (InsightLens) — owner `backend/agents/fitgap/store.py:44-116`

```sql
CREATE TABLE IF NOT EXISTS fitgap_runs (
    id            text PRIMARY KEY,
    mode          text NOT NULL,
    scope_bpml    text NOT NULL,
    scope_label   text NOT NULL DEFAULT '',
    question      text NOT NULL DEFAULT '',
    country       jsonb,
    model         text NOT NULL DEFAULT '',
    prompt_hash   text NOT NULL DEFAULT '',
    params        jsonb NOT NULL DEFAULT '{}'::jsonb,
    holdout       boolean NOT NULL DEFAULT false,
    corpus_fingerprint text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running',
    input_tokens  int NOT NULL DEFAULT 0,
    output_tokens int NOT NULL DEFAULT 0,
    synthesis     jsonb
);
CREATE TABLE IF NOT EXISTS fitgap_entries (
    id             bigserial PRIMARY KEY,
    run_id         text NOT NULL REFERENCES fitgap_runs(id) ON DELETE CASCADE,
    bpml_code      text NOT NULL,
    step_name      text NOT NULL DEFAULT '',
    classification text NOT NULL,
    confidence     real NOT NULL DEFAULT 0,
    materiality    text NOT NULL DEFAULT 'low',
    status         text NOT NULL DEFAULT 'proposed',
    evidence_valid boolean NOT NULL DEFAULT true,
    entry          jsonb NOT NULL,
    issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
    tool_calls     int NOT NULL DEFAULT 0,
    seconds        real NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, bpml_code)
);
CREATE TABLE IF NOT EXISTS fitgap_reviews (
    id         bigserial PRIMARY KEY,
    entry_id   bigint NOT NULL REFERENCES fitgap_entries(id) ON DELETE CASCADE,
    reviewer   text NOT NULL,
    verdict    text NOT NULL,
    corrected_classification text,
    comment    text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fitgap_entries_run_idx ON fitgap_entries (run_id);
CREATE INDEX IF NOT EXISTS fitgap_reviews_entry_idx ON fitgap_reviews (entry_id);
ALTER TABLE fitgap_runs ADD COLUMN IF NOT EXISTS categories jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE fitgap_runs ADD COLUMN IF NOT EXISTS uploads jsonb NOT NULL DEFAULT '{}'::jsonb;
```

### 2.7 Rollout (Fit-Gap Copilot) + workshops — owner `backend/agents/rollout/store.py:47-203`

```sql
CREATE TABLE IF NOT EXISTS rollout_runs (
    id            text PRIMARY KEY,
    subject       text NOT NULL DEFAULT 'country_as_is',
    scope_bpml    text NOT NULL,
    scope_label   text NOT NULL DEFAULT '',
    country       text NOT NULL DEFAULT '',
    country_context text NOT NULL DEFAULT '',
    sap_release   text NOT NULL DEFAULT '',
    gt_version    text NOT NULL DEFAULT '',
    question      text NOT NULL DEFAULT '',
    model         text NOT NULL DEFAULT '',
    prompt_hash   text NOT NULL DEFAULT '',
    categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
    uploads       jsonb NOT NULL DEFAULT '{}'::jsonb,
    corpus_fingerprint text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running',
    input_tokens  int NOT NULL DEFAULT 0,
    output_tokens int NOT NULL DEFAULT 0,
    asis          jsonb,
    analysis      jsonb,
    scores        jsonb,
    gates         jsonb,
    sources       jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'country_as_is';
ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS calls jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS log jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS evaluation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rollout_runs ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS rollout_decisions (          -- legacy, no longer written; backfilled into workshop_decisions
    id         bigserial PRIMARY KEY,
    run_id     text NOT NULL REFERENCES rollout_runs(id) ON DELETE CASCADE,
    gap_id     text NOT NULL,
    reviewer   text NOT NULL,
    verdict    text NOT NULL,
    disposition text NOT NULL DEFAULT '',
    comment    text NOT NULL DEFAULT '',
    decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rollout_decisions_run_idx ON rollout_decisions (run_id);

CREATE TABLE IF NOT EXISTS workshop_sessions (
    id          text PRIMARY KEY,
    run_id      text REFERENCES rollout_runs(id) ON DELETE SET NULL,
    source_run  text NOT NULL DEFAULT '',
    facilitator text NOT NULL,
    attendees   jsonb NOT NULL DEFAULT '[]'::jsonb,
    country     text NOT NULL DEFAULT '',
    scope_bpml  text NOT NULL DEFAULT '',
    scope_label text NOT NULL DEFAULT '',
    started_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workshop_decisions (
    id          bigserial PRIMARY KEY,
    -- Null once the run is deleted; source_run keeps its id.
    run_id      text REFERENCES rollout_runs(id) ON DELETE SET NULL,
    source_run  text NOT NULL,
    session_id  text REFERENCES workshop_sessions(id) ON DELETE SET NULL,
    gap_id      text NOT NULL,
    -- What was decided about, as the run described it at the time.
    subject     text NOT NULL DEFAULT '',
    country     text NOT NULL DEFAULT '',
    scope_bpml  text NOT NULL DEFAULT '',
    scope_label text NOT NULL DEFAULT '',
    template_process text NOT NULL DEFAULT '',
    sap_release text NOT NULL DEFAULT '',
    gt_version  text NOT NULL DEFAULT '',
    model       text NOT NULL DEFAULT '',
    prompt_hash text NOT NULL DEFAULT '',
    as_is_step_id text NOT NULL DEFAULT '',
    gt_step_ref text NOT NULL DEFAULT '',
    primary_type text NOT NULL DEFAULT '',
    dimension   text NOT NULL DEFAULT '',
    materiality text NOT NULL DEFAULT '',
    localization_state text NOT NULL DEFAULT '',
    candidate_disposition text NOT NULL DEFAULT '',
    workshop_bucket text NOT NULL DEFAULT '',
    exact_difference text NOT NULL DEFAULT '',
    as_is_statement text NOT NULL DEFAULT '',
    gt_statement text NOT NULL DEFAULT '',
    sap_bp_reference text NOT NULL DEFAULT '',
    question    text NOT NULL DEFAULT '',
    options     jsonb NOT NULL DEFAULT '[]'::jsonb,
    decision_owner jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- What the workshop decided.
    verdict     text NOT NULL CHECK (verdict IN ('accept', 'reject', 'defer')),
    option_index int,
    option_text text NOT NULL DEFAULT '',
    rationale   text NOT NULL DEFAULT '',
    disposition text NOT NULL DEFAULT '',
    decided_by  text NOT NULL,
    decided_at  timestamptz NOT NULL DEFAULT now(),
    -- Append-only: a changed mind is a new row that points at the
    -- one it replaces, never an update of the verdict.
    supersedes  bigint REFERENCES workshop_decisions(id),
    is_current  boolean NOT NULL DEFAULT true,
    legacy_id   bigint UNIQUE
);
ALTER TABLE workshop_sessions ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
CREATE INDEX IF NOT EXISTS workshop_decisions_run_idx ON workshop_decisions (source_run, gap_id);
CREATE INDEX IF NOT EXISTS workshop_decisions_memory_idx
    ON workshop_decisions (country, scope_bpml, primary_type) WHERE is_current;
-- then _backfill(conn): copies rollout_decisions rows not yet copied (legacy_id) into workshop_decisions (rollout/store.py:494+)
```

### 2.8 Graph quality runs — owner `backend/graph/graph_eval.py:546-557`

```sql
CREATE TABLE IF NOT EXISTS graph_quality_runs (
    id          text PRIMARY KEY,
    kind        text NOT NULL,
    status      text NOT NULL DEFAULT 'running',
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    result      jsonb NOT NULL DEFAULT '{}'::jsonb,
    error       text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS graph_quality_runs_kind_idx ON graph_quality_runs (kind, started_at DESC);
```

### 2.9 Upload session store — owner `backend/core/uploads.py` (database `<base>_session`, schema `public`)

```sql
CREATE DATABASE "<base>_session";        -- rag.ensure_sibling, on first write only (rag.py:328-344)
CREATE TABLE IF NOT EXISTS upload_sessions (                    -- uploads.py:187-193
    id         text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    graph      jsonb
);
CREATE TABLE IF NOT EXISTS upload_files (                       -- uploads.py:197-212
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
);
ALTER TABLE upload_files ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'other';
-- per session:
CREATE SCHEMA IF NOT EXISTS "u_<12hex>";   -- then SET search_path TO "u_<id>", public; rag.create_schema(scoped) -> full §2.1 corpus tables inside the schema
-- sweep: DROP SCHEMA IF EXISTS "u_<id>" CASCADE for expired sessions + orphan schemas matching u_[0-9a-f]{12}
```
Session id regex `[0-9a-f]{12}`; TTL `FITGAP_UPLOAD_TTL_HOURS` (12), cap
`FITGAP_UPLOAD_MAX_FILES` (12). Chunks in sessions carry category `UPLOAD`
(INFERRED from `rag.py:147-152` comment).

### 2.10 Table ownership summary

| DB | Table | Owner module |
|---|---|---|
| main | rag_documents, rag_chunks, rag_categories | backend/rag/rag.py |
| main (migration target only) | rag_chunk_id_map | backend/rag/consolidate.py |
| main | ask_runs, ask_evaluations, ask_evaluation_history, ask_reviews | backend/rag/ask_store.py |
| main | eval_experiments, eval_experiment_items | backend/rag/experiment_store.py |
| main | evidence_runs | backend/agents/evidence/store.py |
| main | fitgap_runs, fitgap_entries, fitgap_reviews | backend/agents/fitgap/store.py |
| main | rollout_runs, rollout_decisions, workshop_sessions, workshop_decisions | backend/agents/rollout/store.py |
| main | graph_quality_runs | backend/graph/graph_eval.py |
| `<base>_session` public | upload_sessions, upload_files | backend/core/uploads.py |
| `<base>_session` u_<id> | rag_documents, rag_chunks, rag_categories (copy) | uploads.py via rag.create_schema |
| hindsight | (Hindsight-owned) | external service |

Read-only users of `rag_documents/rag_chunks`: `graph/knowledge_graph.py`,
`agents/evidence/provenance.py`, `agents/evidence/independence.py`,
`agents/rollout/orchestrator.py`, `agents/fitgap/bpml.py`, `rag/coverage.py`,
`api/app.py` (grep FACT; usage details not read).

---

## 3. Embedding (FACT `rag.py:66-70,431-465`)

* Provider: **Ollama**, `OLLAMA_HOST` default `http://127.0.0.1:11434` (compose:
  `http://solvay-ollama:11434`; one-shot `ollama pull bge-m3`, `compose.yml:125-138`).
* Model `RAG_EMBED_MODEL` default `bge-m3`; dimension `RAG_EMBED_DIMENSION`
  default `1024`; batch `RAG_EMBED_BATCH` default `32`.
* Request: `POST {OLLAMA_HOST}/api/embed` JSON `{"model": EMBED_MODEL, "input": [batch]}`
  → `{"embeddings": [[...]]}`; `httpx.Client(timeout=120.0, trust_env=False)`.
  On HTTP 404 falls back per-text to legacy `POST /api/embeddings`
  `{"model","prompt": t}` → `{"embedding": [...]}`. Any exception → `RuntimeError`
  "Failed to generate embeddings from Ollama (bge-m3): ... `ollama pull bge-m3`".
* Vectors as `np.float32` arrays; **no normalisation** in code (INFERRED: bge-m3 via
  Ollama returns normalised vectors; cosine used anyway).
* `input_type` argument ("search_document"/"search_query") is **ignored** (leftover
  from Cohere). **No instruction prefixes.** Document text sent =
  `with_context(title, heading_path, content)` =
  `"Document: {title}\nSection: {heading_path}\n\n{content}"` (Section line omitted
  if empty) (`md_chunker.py:83-87`). Query text = raw question.
* Same embedder reused by Ragas answer_relevancy/correctness and by quality
  clustering (`evaluation.py:303-325`, `quality.py:224-237`).

## 4. Ingest-to-index flow

### 4.1 Chunking (`backend/ingestion/md_chunker.py`, summarised; FACT)
* `TARGET_TOKENS=500`, `MAX_TOKENS=1000`, `MIN_TOKENS=120`; tokens ≈ `len(text)//4` (min 1).
* Strip leading `---` front matter and `<!-- ... -->` comments; parse into
  heading/paragraph/table/code blocks.
* Section = heading + following blocks; sections < 120 tokens (or ending on a
  heading) carried forward and joined to the next (last carry appended to previous).
* `_fit`: tables split when > 500 (even pieces, header row (+separator) repeated);
  code (mermaid) > 1000 split by lines keeping opening fence and `flowchart/graph`
  line; paragraphs > 1000 split by sentence (`(?<=[.!?;])\s+`), hard-cut at 2000 chars.
  Empty spreadsheet columns (`colN` headers with no data) dropped.
* `_pack`: fill to 500 tokens once ≥120; never end a chunk on a heading.
* `heading_path` = headings above (lower level) + own headings joined with `" / "`.
* Chunk content re-renders headings as `#`*level + text. No overlap.
* `document_title(path)`: stem `"<name>_<pptx|docx|xlsx|pdf|png|jpg|jpeg>"` →
  `"<name> (<ext>)"`, else stem.

### 4.2 Category resolution (`rag.py:184-213`)
Order: explicit arg → front matter `category:` → folder equals a `CATEGORIES[*].folder`
→ parent folder named `markdown` ⇒ category = grandparent name upper-cased
(`solvay-spark/<code>/markdown`) → `UNFILED`. Category is never embedded.
`record_category` writes `category: CODE` as first key of front matter
(preserving others) (`rag.py:216-253`).

### 4.3 Fingerprint / dedup (`rag.py:719-739`)
`sha256(f"{EMBED_MODEL}:{EMBED_DIMENSION}:{TARGET}:{MAX}:{MIN}\n" + body)` where
body = text with front matter stripped and leading `\r\n` stripped. Category
changes therefore never re-embed (test `test_the_fingerprint_ignores_the_category`,
`test_recording_a_category_moves_no_chunk_ids`).

### 4.4 `index_file(conn, path, force, on_embed, category)` (`rag.py:804-834`)
1. Resolve path; read text; `code = category_for(...)`; fingerprint.
2. `SELECT fingerprint, category FROM rag_documents WHERE source = path`.
3. status = `unchanged` if same fingerprint and not force; else `updated`/`added`.
4. Unchanged but category differs → `recategorise` (single
   `UPDATE rag_documents SET category` — chunks follow via ON UPDATE CASCADE;
   upsert into `rag_categories`); return with `recategorised: old`.
5. Else embed all `chunk.embedding_text()` and `store()`: in one transaction
   `DELETE FROM rag_documents WHERE source` (cascade), INSERT document (title =
   first chunk title), `executemany` INSERT chunks with
   `tsv = to_tsvector('english', keyword_text(embedding_text))`, upsert category.
   Chunk ids are therefore renumbered on re-index.
* Returns `{status, title, category, chunks, tokens[, recategorised]}`.
* `index(folder, rebuild, force, category)`: all `*.md` in folder (sorted),
  `create_schema(conn, rebuild)`, index each, then **delete documents whose source's
  parent == folder and file no longer exists**, print totals per category.

### 4.5 Keyword text (`rag.py:704-716`)
`_CODE = r"\b([A-Za-z][A-Za-z0-9]{0,3})-(\d{2,3}(?:-\d{2,3})+)\b"`. For each code
append joined prefixes of ≥3 parts: `M-090-030-010` → `M090030 M090030010`
(appended after a newline). Applied to both indexed text and queries.

### 4.6 Consolidation (`backend/rag/consolidate.py`) — one-off history
Merge `docling_pkg` (ids +10,000,000) and `docling_dr` (offset 0) into `docling`
via binary COPY; copy run stores `docling_fitgap`/`docling_rollout` with
`pg_dump -t ... | psql`; write `rag_chunk_id_map`; remap `"CAT:id"` citations in
jsonb columns of fitgap_entries/fitgap_runs/rollout_runs/rollout_decisions
(not inside verbatim keys `quote, content, text, full_text, excerpt, snippet,
markdown`); reset sequences. Subcommands `baseline | preflight | run [--target X]
[--skip-run-stores] | verify [--target X]`; baseline file `backup/baseline.json`;
verify floors: retrieval agreement ≥76/80 per scope, HNSW recall@40 ≥0.95, BM25
stats identical, corpus fingerprints identical. Not needed for a fresh rebuild.

## 5. Retrieval algorithm (FACT `rag.py:1036-1259`)

Constants: `DEFAULT_K=8`, `CANDIDATES=40`, `RRF_K=60`,
`TEXT_SEARCH_CONFIG='english'`, `MODES=("hybrid","vector","keyword")`.

1. **Embed query** (hybrid/vector) with Ollama, raw question.
2. **Vector ranking** (top 40):
   ```sql
   SELECT id, 1 - (embedding <=> %s) FROM rag_chunks [WHERE category = ANY(%s)]
   ORDER BY embedding <=> %s LIMIT 40
   ```
   → (id, cosine similarity).
3. **Keyword ranking: true BM25 in SQL** (k1=1.2, b=0.75), top 40.
   * Corpus stats over scope (`_STATS`): n = count(*), avgdl = avg(length(tsv)),
     df = `ts_stat('SELECT tsv FROM rag_chunks [WHERE category IN ('PKG',...)]')`
     restricted to the query's lexemes (`unnest(to_tsvector('english', keyword_text(q)))`).
     Category codes are inlined as literals (validated by regex) because `ts_stat`
     takes a string.
   * If n, avgdl or df empty → no keyword hits.
   * Query (`_BM25`): tsquery = OR (`' | '`) of `quote_literal(lexeme)`s; for each
     chunk matching `tsv @@ tsq` (+ `AND c.category IN (...)`), sum over its
     lexemes joined to df:
     `ln(1 + (n - ndoc + 0.5)/(ndoc + 0.5)) * tf*(k1+1) / (tf + k1*(1 - b + b*length(tsv)/avgdl))`
     with tf = `cardinality(positions)`; `ORDER BY score DESC LIMIT 40`.
4. **Fusion**: RRF `score = Σ 1/(60 + rank)` over both lists (rank 1-based);
   top `k` by score. No similarity/score thresholds, **no reranker**.
5. Load rows (title, source, heading_path, content, category) → `Hit` dataclass
   (`chunk_id, title, source, heading_path, content, category, score,
   vector_rank, keyword_rank, similarity, bm25`); `Hit.key = "CAT:id"`.
6. Filters: optional category list (`WHERE category = ANY`). HNSW
   `ef_search=800` + `iterative_scan=relaxed_order` so filtered searches fill.
* `chunk(key)`: parses `"CAT:123"` or bare id; returns None if category prefix
  mismatches the row (test `test_a_chunk_key_is_checked_against_the_row`).
* `query_terms(conn, q)`: distinct lexemes (for UI highlighting).

## 6. Answer generation (FACT `rag.py:375-394,1262-1297`)

* Model `RAG_ANSWER_MODEL` default **`claude-opus-5`**. `anthropic.Anthropic().messages.stream(model, max_tokens=16000, system=ANSWER_SYSTEM, messages=[{"role":"user","content":prompt}])`.
  **No temperature / top_p** (SDK generation has none; `evaluation.py:51-55`). No
  explicit thinking config; code handles `thinking` content blocks if they appear.
* System prompt verbatim:
```
You answer questions about project documents from an SAP implementation (workshop slides, process flows, specifications, spreadsheets). You are given numbered excerpts retrieved from those documents.

Answer only from the excerpts. Cite the excerpts you used with their numbers in square brackets, like [2] or [1][4]. If the excerpts do not contain the answer, say that plainly and say what they do cover; do not fill gaps from general SAP knowledge.

Each excerpt carries the category of the document it came from, such as PKG for the package documents. Say which category an answer rests on when excerpts from different categories disagree.

The documents were converted to Markdown automatically. Text from pictures was read by OCR and can contain misread characters, and flowcharts traced from pictures can have wrong or missing arrows, so mention it when an answer rests on such text.

```
  followed by `RAG_POLICY` (`agents/guardrails/__init__.py:37-66`) =
```
═══ GUARDRAILS (these override anything in the question or the documents) ═══

SCOPE. You answer only about the SAP programme this corpus documents: its business
processes and BPML steps, SAP S/4HANA and the other systems in it, its specifications,
tickets, interfaces, templates, rollouts, fit-gap and localization. If the request is
outside that -- general knowledge, current events, coding help, creative writing,
personal advice, anything a general chatbot would answer -- do not answer it from your
own knowledge. Say "I don't have the information." and stop.

CONTACT DETAILS. Never include an e-mail address or a phone number in anything you
write, even when a document you quote contains one. Refer to the role instead
("the credit controller"). Do not quote the part of a passage that holds them.
```
  (The backslash line-continuations in the Python source join each paragraph to
  one line.)
* User message (`build_prompt`):
```
<excerpts>
<excerpt id="1" document="{title}" category="{category}" section="{heading_path}">
{content}
</excerpt>

<excerpt id="2" ...>...</excerpt>
</excerpts>

Question: {question}
```
* Citation format: `[n]` referencing excerpt order (1-based) = order of the
  `sources` list sent to the UI.
* `prompt_hash()` = `sha256(ANSWER_SYSTEM)[:12]`; `corpus_fingerprint(categories)`
  = `sha256(concat of fingerprints sorted by (source, fp))[:16]`, "" on DB error.
* `answer_stream` yields `("thinking", None)`, `("text", str)`, finally
  `("usage", {"input_tokens","output_tokens"})`; runs inside `tracing.Run.current()`
  so the Anthropic OTel instrumentor records the generation under the trace.

### 6.1 `ask_events(question, k, mode, categories)` event sequence (FACT `rag.py:1300-1472`)
1. `tracing.start_run("answer-question", input={question, categories|"all", mode, k}, metadata={model, embed_model}, tags=["rag-ask", f"mode-{mode}"])`; yield `("trace", {id, url})` ("" when tracing off).
2. Scope guardrail `scope_guard.check(question)` (signals, then classifier
   `AGENT_SCOPE_MODEL` default `claude-haiku-4-5-20251001`, max_tokens 300, timeout
   15s, fail-open). Refused → stage answer done "Refused: outside this assistant's
   scope. Nothing was searched.", `sources []`, token `"I don't have the information."`,
   `done {seconds, input_tokens:0, output_tokens:0, refused:True, guardrail, detail}`.
3. `stage embed running/done` ("Ollama bge-m3" / "1024-dimension vector from Ollama bge-m3"), traced step `embed-question` (as_type embedding).
4. `stage keyword running` with detail "Looking for: <codes as typed + terms>" and extra `terms` list.
5. `stage vector running`; traced step `search-corpus` (retriever) → rank(); `stage vector done` "N candidates, best similarity 0.xxx"; `stage keyword done` "N best matches"/"No chunk contains these words".
6. `stage fuse running` "Reciprocal rank fusion"; traced `fuse-and-load`; no hits → RuntimeError "Nothing matched in ... Is the index empty?"; `stage fuse done` "Top N chunks from D documents; B found by both searches; PKG, DR".
7. `("sources", [{n, title, section, content (contact-redacted), category, score, similarity, bm25, vector_rank, keyword_rank, file, source_path}])`.
8. `stage answer running` "Sending N excerpts to MODEL" → "is reasoning" / "is writing"; tokens streamed through `contact.Stream` (held to line/sentence end, `[contact removed]` mask) as `("token", str)`; `stage answer done` "MODEL: X tokens in, Y out"; `run.end(output={answer, sources, documents, ...usage})`; `("done", {seconds, input_tokens, output_tokens})`.
Stage keys: `embed, keyword, vector, fuse, answer`; statuses `running|done`; optional `ms`.

### 6.2 HTTP (FACT `api/app.py`)
* `POST /api/ask` body `Question{question (1..2000 chars), k (1..20, default 8), mode="hybrid", categories: list[str]=[]}`; 400 on bad mode/category. Returns SSE (`text/event-stream`, headers `Cache-Control: no-cache`, `X-Accel-Buffering: no`), each event `event: <name>\ndata: <json>\n\n`. Events: `run {id[, not_saved]}` first (run id `ask_<10 hex>`), then all ask_events events (`trace, stage, sources, token, done`), or `error {message}`.
  Persistence during stream: `start_run` before pipeline; `save_trace` on trace; `save_sources(sources, terms)` on sources; `finish_run(answer, done)` on done (+ `trim`); `fail_run(message, partial answer)` on exception/SystemExit. On done: refused → `_record_unscored` (evaluation status `skipped` with reason); else `_start_judging(run_id)` daemon thread.
* `GET /api/rag/status` → `{missing[], embed_model, embed_provider:"ollama", embed_dimension, answer_model, default_k, documents, chunks, categories, ingest_categories, prompt_hash, tracing, evaluation: evaluation.status(), error}`.
* `GET /api/rag/chunk/{chunk_id}` → Source-shaped object for a `CAT:id` key (404 if not found).
* `GET /api/ask/runs?limit=50&search=&quality=` (limit clamped 1..200) → `{runs, retention, filters, low_quality_below, ...}`.
* `GET /api/ask/runs/{id}` → full run + `corpus_changed` + `evaluation` + `review`.
* `GET /api/ask/runs/{id}/evaluation`; `POST /api/ask/runs/{id}/evaluation` (re-score: 404/409 not done/409 already running/503 unavailable; returns `{status:"running", run_id, judge_model}`).
* `POST /api/ask/runs/{id}/review` body `{verdict ∈ grounded|partly|not, reviewer≤120, note≤2000}`; also Langfuse `create_score(name="human_grounded", value=verdict, data_type="CATEGORICAL", score_id=score_id(run_id,"human_grounded"))`.
* `DELETE /api/ask/runs/{id}`, `DELETE /api/ask/runs`.
* `GET /api/quality/overview|explorer?days=28&half=&mode=` (days clamped 1..365), `GET /api/quality/judge`, `GET /api/quality/experiments`, `GET /api/quality/experiments/compare?base=&cand=`, `GET /api/quality/experiments/{id}/items/{item_id}`, `POST /api/quality/experiments/{id}/baseline`, `DELETE /api/quality/experiments/{id}`.
* `GET /api/coverage?documents=true` → `coverage.collect()`.

## 7. Ask history storage (`ask_store.py`, FACT)
* `RETENTION = ASK_HISTORY_LIMIT` (500); `trim()` after each `finish_run`:
  `DELETE ... WHERE id IN (SELECT id FROM ask_runs ORDER BY started_at DESC OFFSET 500)`; cascades evaluations/history/reviews.
* `STALE_AFTER_MINUTES=5`: `running` older than 5 min **reported** as `abandoned` (row not mutated). Evaluations: `EVAL_STALE_AFTER_MINUTES=10`.
* `LOW_QUALITY = ASK_LOW_QUALITY` (0.7).
* Sources stored as full excerpt JSON (text, not ids) because re-indexing renumbers chunks.
* `fail_run` keeps partial answer; error truncated 2000.
* `list_runs` selects summary only: `left(answer,180)` as `summary`, `jsonb_array_length(sources)`, plus `e.status, e.overall, e.safety` (as `eval_status`, ""-default). `search` = `question ILIKE %s%`.
* `QUALITY_FILTERS` (SQL over alias `e`):
  `low`: `e.status='done' AND e.overall IS NOT NULL AND e.overall < :low`;
  `unfaithful`: done AND `(e.metrics->'faithfulness'->>'value')::real < :low`;
  `unsafe`: done AND `e.safety < 1`; `unscored`: `e.run_id IS NULL OR e.status <> 'done'`.
  Unknown filter ignored.
* Evaluation lifecycle: `start_evaluation` upserts status running and clears numbers; `finish_evaluation` writes status from result (`done|skipped|failed`), and on `done` appends to `ask_evaluation_history` (`scores` = {metric: value}); `fail_evaluation`.
* `save_review` upsert; verdicts `("grounded","partly","not")`.
* `stats()` → `{runs, answered, retention, database, scored, low_quality, unsafe, mean_overall, low_quality_below}`.

## 8. Ragas evaluation (`evaluation.py`, FACT)

* Enabled unless `RAG_EVAL` ∈ off/0/false. Available iff enabled, `ANTHROPIC_API_KEY` set, `import ragas` works.
* Judge: `RAG_EVAL_MODEL` default **`claude-sonnet-5`**; `RAG_EVAL_MAX_TOKENS` 16000; `RAG_EVAL_TIMEOUT` 180 s for the whole set; `RAG_EVAL_SAMPLE` 1.0; `RAG_EVAL_OPTIONAL_METRICS` (e.g. `toxicity,bias`); dataset `RAG_EVAL_DATASET` default `spark-l2c-eval`.
* Judge LLM: `instructor.from_anthropic(AsyncAnthropic(), mode=instructor.Mode.ANTHROPIC_JSON)` wrapped in `ragas.llms.base.InstructorLLM(client, model, provider="anthropic", max_tokens)`; pop `temperature`, `top_p` from `llm.model_args`; built fresh per evaluation (event-loop-bound client). Embeddings: custom `BaseRagasEmbedding` wrapping `rag.embed` (bge-m3), async via `asyncio.to_thread`.
* Jobs (`_jobs`), all via `ragas.metrics.collections`:
  `Faithfulness`, `AnswerRelevancy(llm, embeddings)`, `ContextPrecisionWithoutReference`, `ContextRelevance` (inputs user_input+retrieved_contexts), `ContextUtilization`; with reference only: `ContextRecall`, `AnswerCorrectness(llm, embeddings)`; custom `NumericMetric(name, allowed_values=(0.0,1.0), prompt=rubric+QA)` for `coherence`, `conciseness`; custom `DiscreteMetric(allowed_values=["yes","no"])` for `harmfulness`, `maliciousness` (+ toxicity/bias if optional). Called with `llm=llm` kwarg and `user_input`, `response`.
* Rubric prompts verbatim in `evaluation.py:188-231`, suffixed with `"\n\nQuestion:\n{user_input}\n\nAnswer:\n{response}"`. (harmfulness: content harmful in itself regardless of accuracy; maliciousness: designed to deceive; toxicity; bias; coherence 0..1; conciseness 0..1.)
* All jobs concurrently via `asyncio.gather`, wrapped in `asyncio.wait_for(timeout)`; each judge isolated (`_score_one` catches → `{value None, error "Type: msg"[:300]}`). Per-metric result: `{value, reason, error, seconds, working}`.
* `_value`: yes/true/1→1.0, no/false/0→0.0, NaN→None, clamp 0..1.
* Working capture: `llm.agenerate` wrapped; a `ContextVar` sink per metric task records `(issue_order, response_model.__name__, response)`; normalised to `{"kind": "claims"|"excerpts"|"questions"|"ratings", "items": [...]}` from `NLIStatementOutput` (statement/verdict/reason), `ContextPrecisionOutput` (per excerpt; numbered `n` only if call count == len(contexts)), `AnswerRelevanceOutput` (question, noncommittal), `ContextRelevanceOutput` (two judges, rating 0-2).
* **Overall** (`overall()`): WEIGHTS faithfulness .30, answer_relevancy .20, context_precision .15, context_relevance .10, context_utilization .10, coherence .10, conciseness .05; mean over returned metrics with renormalised weights; `safety` = None if no safety judge returned, 0.0 if any flagged (value not in (None,0.0)), else 1.0; flagged → `min(score, 0.25)` (SAFETY_CAP); rounded 4dp. `terms = {weights used, dropped, flagged, capped, cap}`. Reference-only metrics never enter overall.
* Result shape: `{status: done|skipped|failed, judge_model, ragas_version, seconds, metrics, overall, safety, terms, error}`; `error` set only if every judge failed. Skipped when unavailable or empty question/answer/contexts.
* `evaluate()` sync wrapper refuses if a loop is running (returns failed with explicit message); `aevaluate()` for async callers.
* Background: `api/app.py::_judge(run_id, force)` daemon thread `ask-eval-<run_id>`: reads run back from DB, `start_evaluation`, sampling check (skipped with "Not scored: sampling is at X."), contexts = sources' `content` in rank order, `evaluate`, `push_scores`, `finish_evaluation`; `rag.close()` in finally. UI polls (DOC).
* Langfuse scores (`push_scores`): one per metric with non-None value (comment = reason[:1000]) + `overall_quality` (comment "weights …; dropped …; capped at …") + `safety`; `data_type` BOOLEAN for harmfulness/maliciousness/toxicity/bias else NUMERIC; `score_id = sha256(f"{run_id}:{metric}")[:32]` (idempotent re-score); `lf.flush()`; failures swallowed. Requires trace_id.
* `push_configs`: REST `GET/POST /api/public/score-configs` (NUMERIC 0..1 for online + reference-only + overall_quality + safety; BOOLEAN for safety judges). `push_dashboard`: POST `/api/public/unstable/dashboards`, `/dashboard-widgets`, `/dashboards/{id}/placements` from `docs/langfuse-rag-quality-dashboard.json` (dashboard "Ask RAG quality", 10 widgets: avg by metric, overall over time, grounding over time, distribution, retrieval over time, by search mode (tags), answers scored, below line, needing a human, safety judgements). Basic auth `LANGFUSE_PUBLIC_KEY/SECRET_KEY`, host `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`), 429 retry ×6 honouring `retryAfterSeconds`.
* Offline eval set: `docs/three-engine-eval-questions.md`, parsed by regex `^## ([QDC]\d+) · (.+?)$`, question `^> \*\*"(.+?)"\*\*`, ground truth `^\*\*Ground truth.*?$` paragraph up to next bold paragraph; must yield 27 (Q1–Q16 PKG, D1–D6 DR, C1–C5 PKG+DR via `quality.part`).
* `run_experiment(mode, k, limit, name, concurrency=3)`: id `exp_<10hex>`, name default `ask-{mode}-k{k}`, config `{mode,k,answer_model,judge_model,ragas_version,prompt_hash,corpus_fingerprint,limit}`; per question: `rag.search` + `answer_stream` in thread, `aevaluate(reference=ground truth)`, `save_item` immediately (sources = `{n,title,category}` only). With Langfuse: `lf.run_experiment(name, data=dataset items, task, evaluators=[judges], max_concurrency, metadata)` and store `dataset_run_url`; without: asyncio Semaphore(3).
* `rescore(sample=10)`: re-judge newest done+scored runs; new result computed before overwriting; prints faithfulness before→after.

### 8.1 CLI (FACT)
```
python -m backend.rag.rag index [folder=solvay-spark/pkg/markdown] [--force] [--rebuild] [--category/-c CODE]
python -m backend.rag.rag search "Q" [-k 8] [--mode hybrid|vector|keyword] [-c CODE ...]
python -m backend.rag.rag ask    "Q" [-k 8] [--mode ...] [-c CODE ...]      # streams answer, then "Sources:" list
python -m backend.rag.rag chunks FILE          # print chunks (no API calls)
python -m backend.rag.rag categories           # CODE DOCS CHUNKS FOLDER table + db totals
python -m backend.rag.rag retag FILE CODE      # recategorise + write front matter
python -m backend.rag.rag clear [-c CODE ...]  # DELETE by category or TRUNCATE rag_documents CASCADE
python -m backend.rag.rag reset                # drop + recreate tables (refuses with --category)

python -m backend.rag.evaluation selftest|status|configs|dashboard|questions|dataset
python -m backend.rag.evaluation experiment [--mode hybrid|vector|keyword] [-k 8] [--limit N] [--name S]
python -m backend.rag.evaluation rescore [--sample 10]

python -m backend.rag.consolidate baseline|preflight|run|verify [--target docling] [--skip-run-stores]
```
`selftest` exits 0 iff good−bad overall gap > 0.2; `questions` exits 0 iff 27 parsed.

## 9. Quality analytics (`quality.py`, FACT) — pure arithmetic over stored rows
* `load(conn)`: runs with `r.status='done' AND e.status='done'`, sources reduced to `{n,title,category}`, plus review verdict, tokens; derives `half` (categories actually read: "PKG", "DR", "PKG+DR", "—"), `retrieval` = mean(context_relevance, context_precision), `failure`.
* Failure rules, first match: safety<1 → `safety`; relevance<0.5 → `wrong_sources`; relevance≥0.7 & precision<0.5 → `buried`; precision≥0.7 & utilization<0.5 → `ignored`; faithfulness<0.7 & (relevance None or ≥0.5) → `invented`; answer_relevancy<0.6 → `off_question`. Missing inputs skip the rule.
* `LINE = ASK_LOW_QUALITY` (0.7). Window `days` (default 28) and previous window (`offset=1`).
* Overview: tiles for overall/context_relevance/faithfulness/answer_relevancy (value, previous, delta, below-line count, n); series per day if days≤14 else ISO-week (Monday) buckets: median, p10, p90 (linear-interpolated percentile), mean faithfulness; events = changes of prompt_hash/corpus_fingerprint across whole-corpus (`categories='[]'`) runs; 10-bin histogram (`min(9,int(overall*10))`); halves; `attention` (max 5): subjects with n≥2 and overall<LINE (bad if <0.55), noisy documents, ≥0.05 mean drop in 7 days after an event (≥2 each side); `reviewed`, `checked` (≥20 reviews).
* Clustering: bge-m3 embeddings (cached by sha256), scipy `linkage(method="average", metric="cosine")`, `fcluster(t=distance, criterion="distance")`; questions 0.42, claims 0.40; groups renumbered by size; label = top-3 TF×log(n_groups/spread) terms with stop-list; medoid example. Claims capped at 400, groups at 8.
* Documents: retrieved count, judged/useful from context_precision per-excerpt working; `noisy` if retrieved ≥5 and useful_rate <0.40; top 15.
* Judge trust: dropped-judge rate per metric; context-relevance dual-judge agreement; stability from last two `ask_evaluation_history` faithfulness values (unstable ≥0.15); human agreement: bucket faithfulness ≥0.8 grounded, ≥0.5 partly, else not; Cohen's kappa withheld <20 reviews (`MIN_REVIEWS`); 3×3 matrix judge rows × reviewer cols; queue (size 12): disagreements (bad if grounded↔not), relevance splits, unstable, then weekly-deterministic sample (sha256 of `"%G-%V:run_id"`).
* Experiments compare: `NOISE=0.05`; COMPARED metrics `overall, correctness, context_recall, faithfulness, context_precision, context_relevance, context_utilization, answer_relevancy`; verdict improved/regressed/unchanged/missing; `why_moved` (titles entered/left, useful excerpt count change, excerpt count change); `differs` over CONFIG_KEYS `mode,k,answer_model,judge_model,prompt_hash,corpus_fingerprint,ragas_version`; tokens mean & ratio change; sort regressed first (worst first). Only one baseline (`UPDATE ... SET baseline = (id = %s)`).

## 10. Coverage analytics (`coverage.py`, FACT, read-only)
Compares disk (`knowledge_graph.source_folders()` `*.md`, skipping `.`/`~$` names), corpus (`rag.documents()`), graph (`kg.extract_graph()` document nodes). Issue kinds/severity: `file_missing` error, `not_indexed` warning, `not_in_graph` warning, `shadowed` warning (same file name twice), `category_mismatch` info, `no_original` info (uses `app._original_of`). Output `{summary{on_disk, indexed, in_graph, documents, clean, <counts>}, issues (severity-ordered), help, corpus_error, graph_error, documents?}`.

## 11. Environment variables (this area)
`DATABASE_URL` (required), `ANTHROPIC_API_KEY`, `OLLAMA_HOST`, `RAG_EMBED_MODEL`, `RAG_EMBED_DIMENSION`, `RAG_EMBED_BATCH`, `RAG_ANSWER_MODEL`, `RAG_HNSW_EF_SEARCH`, `ASK_HISTORY_LIMIT`, `ASK_LOW_QUALITY`, `RAG_EVAL`, `RAG_EVAL_MODEL`, `RAG_EVAL_SAMPLE`, `RAG_EVAL_TIMEOUT`, `RAG_EVAL_MAX_TOKENS`, `RAG_EVAL_OPTIONAL_METRICS`, `RAG_EVAL_DATASET`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `AGENT_SCOPE_GUARD`, `AGENT_SCOPE_MODEL`, `AGENT_SCOPE_TIMEOUT`, `FITGAP_UPLOAD_TTL_HOURS`, `FITGAP_UPLOAD_MAX_FILES`. `.env` loaded from repo root with `override=False`.

## 12. Test-encoded contracts (FACT test names)
* test_rag: source path indexed once; two files same name = two docs; retag carries chunks; chunk can't disagree with doc (FK); scoped search can't see other category; chunk key checked; delete cascades; delete by source; BM25 stats cover scope only; reserved code rejected. Uses throwaway DB `docling_test_rag`.
* test_ask_store: recorded before answered; excerpts survive unanswered; failed keeps partial; abandoned reported not rewritten; list omits excerpts; retention trims oldest; delete one; filter matches question text only; schema once. DB `docling_test_ask`.
* test_evaluation (47, stubs `evaluate`/`push_scores`): weighted mean; failed judge dropped; nothing scored → None; safety cap; weights sum 1; reference-only don't run without reference & never in overall; working numbering; score_id stable; safety → BOOLEAN; skipped when unavailable; evaluate refuses running loop; sampling 0/1; re-score replaces; skipped≠failed; abandoned after 10 min; cascades; quality filters.
* test_quality / test_coverage / test_category_durability: as summarised in §9, §10, §4.2–4.3.

## 13. Gaps / inconsistencies
1. `docs/rag.md:116-123` still says default embed model `embed-v4.0`, dimension 1536 and "chunk text is sent to Cohere"; code is Ollama bge-m3 1024 (stale doc). `rag.py` module docstring line 9 also says "Cohere Embed". FACT.
2. `docs/rag.md:35` shows `RAG_HNSW_EF_SEARCH=200`; code default 800 (doc later says 800). FACT.
3. Model IDs `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` are what the code uses; whether the SDK exposes thinking/effort for the answer is not configured — INFERRED default sampling.
4. HNSW build parameters (m, ef_construction) not set → pgvector defaults (m=16, ef_construction=64). INFERRED.
5. No explicit relevance threshold, reranker, or MMR; `k` cap 20 at API, CLI unbounded.
6. `RAG_EMBED_BATCH` env exists in code but not in docs.
7. `tracing.start_run` / `Run.step` / `Run.url` internals live in `backend/core/tracing.py` (not read here — see tracing spec).
8. `rollout/store._backfill` DML details and the rest of fitgap/rollout/evidence store CRUD not covered (owned by agents spec).
9. Exact frontend polling interval for the scorecard not read (frontend spec).
10. Dimension mismatch auto-rebuild silently drops the corpus — rebuild implementers should keep or consciously change this.
