# Solvay Spark Spine AI — Architecture Context Prompt

**Purpose of this file.** Paste or `@`-mention this file at the start of a new Claude Code
session to give it the full picture of what we are building before it touches any code.
It describes the *current, verified* state of the repo (read from source on 2026-09-21),
not the aspirational design. Where the older docs in `docs/` disagree with the code, this
file says so explicitly.

Repo root: `/Users/senthilpalanivelu/Programme/solvay-spark-spine` (git, branch `main`).

---

## 1. What the system is, in one paragraph

Solvay Spark Spine AI is a **local, single-user document-intelligence workbench for the Solvay
SPARK programme** (an SAP ECC → S/4HANA transformation). Heterogeneous project artefacts
(PPTX workshop decks, DOCX functional specs, XLSX master-data sheets, PDFs, screenshots)
are converted to Markdown by a document-extraction pipeline, and that Markdown corpus then
feeds **two independent answering engines over the same files**, with **two agents layered
over both of them**:

1. **RAG** — chunk → embed → PostgreSQL/pgvector → hybrid (vector + BM25) retrieval →
   Claude writes a cited answer. Unstructured, "what does the document say" questions.
2. **Knowledge Graph** — regex/ontology entity extraction → in-memory graph (720 nodes,
   842 edges) → BFS pathfinding and 2-hop neighbourhood traversal → templated structured
   answer. Structural, "how does X connect to Y / what specs touch Salesforce" questions.

Everything is served by one FastAPI process (`app.py`, port 8000) with a React SPA
front end. No auth, no multi-tenancy, localhost only.

---

## 2. The corpus (the shared substrate)

- **`solvay-spark/pkg/`** — 85 original source files (the raw Solvay artefacts).
- **`solvay-spark/pkg/markdown/*.md`** — 84 converted Markdown files. **This is the
  canonical corpus.** Both the vector index and the knowledge graph are built from it.
- **`knowledge_base/*.md`** — Markdown added through the web UI (one-off uploads promoted
  into the index). Also read by the graph builder.
- Naming convention, produced by the converter: `<original stem>_<ext>.md`
  (e.g. `Commissions_pptx.md`). `md_chunker.document_title()` turns that back into
  `Commissions (pptx)` for display and citation.
- Content is SAP-programme material: BPML process hierarchies, functional specs
  (`SPARK-21999`), interface designs, pricing/master-data spreadsheets, process flows.

**Live index state (verified against Postgres):** 83 documents / 4257 chunks —
82 from `solvay-spark/pkg/markdown`, 1 from `knowledge_base`.

---

## 3. Repository map

| Path | Role |
|---|---|
| `app.py` | FastAPI: all HTTP routes, SSE streaming, serves the built SPA |
| `converter.py` | Document → Markdown core (Docling + OCR + CV + optional VLM) |
| `preview.py` | LibreOffice → PDF → `pdftoppm` page PNGs (preview pane only) |
| `pptx_ocr.py`, `table_cv.py`, `flow_cv.py`, `pptx_flow.py` | Image/OCR/CV readers |
| `vlm_ocr.py` (local Qwen3-VL via MLX), `vlm_api.py` (GPT/Claude vision) | Optional AI image reading |
| `xlsx_tables.py`, `xml_tables.py` | Spreadsheet/XML → Markdown tables |
| `md_chunker.py` | Heading-aware Markdown chunking for RAG |
| `rag.py` | **RAG engine**: index, hybrid search, answer. Also a CLI |
| `knowledge_graph.py` | **Graph engine**: extraction, BFS, query, answer synthesis |
| `knowledge_graph.json` | Cached extracted graph (~410 KB), rebuilt on demand |
| `fitgap/` | **InsightLens**: one bounded agent run per BPML step → a proposed register entry. Calls both engines through `backend/agents/fitgap/tools.py`; never merges them |
| `evidence/` | **Evidence Agent**: any question, both engines, answered as scored claims. Reuses `backend/agents/fitgap/tools.py`; adds provenance, near-duplicate and hub-artefact judgement |
| `folder_to_md.py`, `pptx_to_md.py` | Batch CLI wrappers |
| `frontend/src/pages/*.tsx` | React SPA pages (10 pages) |
| `frontend/src/data/evalQuestions.ts` | The 16 corpus-grounded evaluation questions, shared by the Fit-Gap and Evidence pages |
| `static/dist/` | Built SPA that `app.py` serves |
| `.workdir/<doc_id>/` | Per-upload scratch: `source.<ext>`, `output.md`, previews, media |
| `docs/` | Diagrams and walkthroughs (**partly stale — see §9**) |

---

## 4. Pipeline A — Document → Markdown (`converter.py`)

Routing by file type:

- `.xlsx/.xlsm` → `xlsx_tables.py` (openpyxl). Bypasses Docling because Docling splits a
  sheet on blank rows and orphans the header row.
- `.png/.jpg` → normalised (EXIF rotation, flattened onto white) and read as a single image.
- `.pptx/.docx/.pdf/.html/.xml` → Docling `DocumentConverter.export_to_markdown()`.
  Docling's Office backends emit bare `<!-- image -->` placeholders for embedded raster
  media, so the converter unzips the OOXML package (`ppt/media/`, `word/media/`,
  `xl/media/`), reads each picture, and **splices the recovered text back at the matching
  placeholder**. Scanned PDFs have no embedded media, so pages are rendered at 150 DPI and
  read the same way.
- PPTX only: `pptx_flow.py` reconstructs flowcharts from real connector shapes and appends
  them as exact Mermaid under a "Process flows" heading.

Image reading ladder (per picture): Tesseract (3× upscale, sparse-text mode, always on)
→ `table_cv.py` (OpenCV border detection + per-cell OCR for ruled tables/SAP grids, always
on) → `flow_cv.py` (shape/arrowhead tracing → DRAFT Mermaid, always on) → **optional VLM**
(`qwen` local MLX 4-bit, or `openai`/`claude` cloud) only when the AI toggle / `--vlm` is set.

Consequence that matters for every downstream answer: **the Markdown contains OCR noise and
possibly wrong flowchart arrows.** The RAG system prompt explicitly instructs Claude to flag
answers that rest on OCR'd or traced content.

---

## 5. Pipeline B — RAG (`md_chunker.py` + `rag.py`)

### 5.1 Chunking (`md_chunker.py`)
Structure-aware, not fixed-width:
1. Parse into blocks (heading / paragraph / table / code fence); drop HTML provenance comments.
2. A heading starts a new chunk → one chunk ≈ one slide, sheet or section. Sections under
   `MIN_TOKENS = 120` are joined to the next section.
3. Cut between blocks at `TARGET_TOKENS = 500`, hard ceiling `MAX_TOKENS = 1000`. Oversized
   blocks split on their own boundaries: tables between rows **with the header repeated**,
   Mermaid between lines inside the fence, paragraphs between sentences.
4. Each chunk carries `title` + `heading_path`, prefixed onto the text at embed time
   (`embedding_text()` → `Document: …\nSection: …\n\n<content>`), so a bare table row like
   `OK | Lorenzo Zabala` is still retrievable.
5. **No overlap** — deliberate; structural boundaries plus heading context replace it.

Tokens are estimated as `len(text) // 4`.

### 5.2 Embedding
**Ollama `bge-m3`, 1024-d, local** (`OLLAMA_HOST=http://127.0.0.1:11434`, `/api/embed`,
batches of 32, falls back to `/api/embeddings` on 404). The Cohere path was replaced;
`cohere` is still in `requirements.txt` and `COHERE_API_KEY` still in `.env` as leftovers.

### 5.3 Storage (PostgreSQL + pgvector, `localhost:5433/docling`)
```
rag_documents(id, source UNIQUE, title, fingerprint, indexed_at)
rag_chunks(id, document_id → CASCADE, chunk_index, heading_path, content, tokens,
           embedding vector(1024), tsv tsvector, UNIQUE(document_id, chunk_index))
  rag_chunks_embedding_idx  HNSW (vector_cosine_ops)
  rag_chunks_tsv_idx        GIN (tsvector, 'english')
```
- `fingerprint` = SHA-256 of (embed model + dimension + chunk settings + file text) →
  re-indexing an unchanged file costs **zero** embedding calls.
- `create_schema()` auto-rebuilds if the stored vector dimension ≠ configured dimension
  (that is how the 1536→1024 migration is handled).
- **Code expansion for keyword search** (`keyword_text()`): Postgres would split
  `M-090-030-010` into `m`, `-090`, `-030`. So each code is re-appended as single words
  *plus its parent codes* (`m090030`, `m090030010`), making `M-090-030` match its children.

### 5.4 Retrieval — hybrid, fused
Modes: `hybrid` (default) / `vector` / `keyword`.
- **Vector**: question embedded (`search_query`), `ORDER BY embedding <=> q`, top `CANDIDATES = 40`.
- **Keyword**: hand-written **BM25 in SQL** (`_BM25` CTE: `ts_stat` for document frequency,
  `unnest(tsv)` for term positions, k1=1.2, b=0.75), top 40. Postgres `ts_rank` was rejected
  because it ignores IDF — a rare code like `7.1.12.3` must outweigh a common word.
- **Reciprocal Rank Fusion**: `score = Σ 1/(60 + rank)` over both rankings, keep top `k`
  (default `DEFAULT_K = 8`, UI allows 1–20).

### 5.5 Answering
`ANSWER_MODEL = claude-opus-5` via `anthropic.messages.stream`, max_tokens 16000.
Prompt = numbered `<excerpt id=n document=… section=…>` blocks + the question. System prompt
enforces: answer **only** from excerpts, cite `[n]`, say plainly when the answer is absent,
and warn when relying on OCR/traced content.

`ask_events()` yields a UI-grade event stream: `stage` (embed → vector → keyword → fuse →
answer, each with timings and detail strings), `sources`, `token`, `done`. `app.py` wraps
these as **SSE**. Each `Hit` carries `vector_rank`, `keyword_rank`, `similarity`, `bm25` and
the fused score, so the Ask page can show *why* a chunk was retrieved.

### 5.6 CLI
```
python -m backend.rag.rag index solvay-spark/pkg/markdown [--force] [--rebuild]
python -m backend.rag.rag search "Who validated 7.1.12.3?" [-k N] [--mode hybrid|vector|keyword]
python -m backend.rag.rag ask    "…"
python -m backend.rag.rag chunks <file.md>      # inspect chunking, no API calls
python -m backend.rag.rag clear | reset
```

---

## 6. Pipeline C — Knowledge Graph (`knowledge_graph.py`)

Built from the **same** `.md` files, but by deterministic regex + a hand-written ontology.
**No LLM and no database are involved in graph construction or graph querying.**

### 6.1 Ontology and extraction rules
Seeded hub nodes:
- **4 streams**: L2C (Lead to Cash), I2D (Idea to Delivery), R2R (Record to Report),
  P2P (Procure to Pay).
- **6 systems**: SAP S/4HANA, SAP ECC, Salesforce, SOVOS (tax), SAP Fiori, Solvay@eCommerce.

Per Markdown file:
- A `document` node (filename, source path, detected format, size, char count).
- `belongs_to` a stream when the stream code appears in the filename or first 600 chars.
- `mentions_system` to each of the 18 systems whose word-bounded pattern appears
  (one relationship type; the system's `kind` -- sap, legacy_erp, middleware, ... --
  is a property of the System node). Every document relationship carries its
  evidence: `method`, `mentions`, `chunk_count` and up to five `chunks` (retrieval
  chunk keys).
- **BPML process codes** via `CODE_RE = \b([A-Za-z][A-Za-z0-9]{0,3})-(\d{2,3}(?:-\d{2,3})+)\b`
  → `process` nodes, `specifies_process` edges, plus a synthesised parent code and a
  `subprocess_of` edge (hierarchy is derived from the code itself).
- **SPARK tickets** via `TICKET_RE = \bSPARK[-_ ]?(\d{4,6})\b` → `spec` nodes;
  `implements_ticket` when the ticket appears in the filename (primary spec), otherwise
  `references_ticket`.
- A passage layer: every indexed chunk as a `chunk` node, `has_chunk` from its
  document and `mentions` to the entities it names (stored under `passages`,
  expanded by `property_graph()`).
- `degree`, display `size` and `color` are computed on load (`decorate`), not stored.

Current graph: **2,390 entity nodes** (1,985 process, 218 document, 165 spec, 18 system,
4 stream) and **4,789 relationships** (specifies_process 1,947, subprocess_of 1,846,
mentions_system 556, belongs_to 237, references_ticket 190, implements_ticket 13), plus
8,867 chunks with 8,867 has_chunk and 7,237 mentions relationships. Cached to `knowledge_graph.json`; `force=True`
re-extracts.

### 6.2 Query engine (`query_graph`)
1. **Intent parsing** by regex over the natural-language question:
   *path* intent (`how does X connect to Y`, `path/link/integration/difference between X and Y`,
   `X -> Y`) vs *neighbourhood* intent. A `target_type_filter` is inferred from words like
   "spec"/"ticket", "process"/"bpml", "doc"/"file".
2. **Entity resolution**: exact then substring match against node `label`, `id`, `code`, `ticket`.
3. **Path mode**: `find_shortest_path()` — queue-based BFS over an undirected adjacency
   list, returning hop count, node sequence and per-step relation labels.
4. **Neighbourhood mode**: top-5 anchors by degree, 1-hop expansion; with a type filter it
   does a **2-hop bridge expansion** (anchor → document/system bridge → target type), because
   a platform like Salesforce is usually separated from a concrete ticket by a spec document.
5. **Answer synthesis** (`generate_graph_answer`): a *templated* Markdown answer — direct
   answer header, numbered integration path, systems & streams with descriptions, SPARK
   specs (capped at 10), BPML processes (capped at 8), and source document citations.
   **This is string formatting, not generation — there is no LLM call anywhere in this path.**

### 6.3 Graph UI
`frontend/src/pages/KnowledgeGraphPage.tsx` (~2.3k lines): a **D3 force simulation rendered
to HTML canvas** with zoom/pan/drag, type filters, subgraph isolation (matched nodes glow,
the rest dim to opacity 0.12) and an automatic bounding-box pan/zoom onto the answer.

---

## 6b. The two agents over the two engines

Added after the sections above. Neither is a fourth store: both read the corpus
only through `backend/agents/fitgap/tools.py`, which wraps `rag.search()` and
`knowledge_graph` as Claude tool-use tools. **The two engines still never call
each other** — an agent is the only thing that sees both.

### InsightLens (`fitgap/`, `/fit-gap`, `/api/fitgap/*`)

One bounded agent run per BPML step (12 tool calls, 40k context), producing a
`FitGapEntry` with `status = "proposed"` and a verbatim quote behind every
claim. `verifier.py` checks each quote against the chunk it names and discards
what it cannot find; an entry left with no evidence is downgraded to `UNKNOWN`.
`synthesis.py` reduces a run to five outputs (reuse %, gap register, decision
pack, integration impacts, workshop agenda). Persisted in `fitgap_runs`,
`fitgap_entries`, `fitgap_reviews`.

### Evidence Agent (`evidence/`, `/evidence`, `/api/evidence/ask`)

Any question, answered as **claims**, each with its own sources and score, under
one of six explicit states: `supported`, `conflicted`, `documented_unknown`,
`not_in_corpus`, `false_premise`, `unrepresentable`. Four judgements the other
components do not make:

| Module | Decides |
|---|---|
| `provenance.py` | whether a document was typed or transcribed from pictures, and whether it is an email, a template or a sparse sheet. `md_chunker` strips the OCR/VLM comments, so this reads the file named in `rag_documents.source` — no re-indexing |
| `independence.py` | whether two documents are genuinely two sources. Document centroids from the embeddings already in pgvector, cosine ≥ 0.93, **plus** a shared ticket or title — cosine alone groups four different specs written from one FS template |
| `paths.py` | whether a BFS route means anything. A path through a stream node, or over a `belongs_to` edge, is an artefact of the ontology, not an integration |
| `scoring.py` | the support score, as arithmetic: base 0.50, +0.15 per independent document, +0.10 graph corroboration, −0.25 contradicted, −0.15 machine-read, −0.10 identifier absent; capped at 0.40 for discussion material and 0.30 for boilerplate; clamped to [0.05, 0.95] |

The model proposes a score; the server recomputes it and keeps its own.

**Evaluation.** `docs/three-engine-eval-questions.md` holds 16 corpus-grounded
questions with verified ground truth, loaded into both agent pages as a picker
(`frontend/src/data/evalQuestions.ts`). `backend/tests/test_fitgap.py` (32 tests) and
`backend/tests/test_evidence.py` (30 tests) cover the verifier, the rubric
arithmetic, BPML parsing, holdout masking, provenance, duplicates and hubs.

---

## 7. Web application (`app.py`, FastAPI on :8000)

All heavy endpoints are declared `def` (not `async def`) so FastAPI runs them in the
threadpool — Docling and LibreOffice are blocking and would otherwise freeze the event loop.

| Endpoint | Purpose |
|---|---|
| `POST /api/upload` | Save to `.workdir/<doc_id>/source.<ext>`, kick off LibreOffice preview |
| `POST /api/convert/{doc_id}?vlm=&provider=` | Convert to `output.md` |
| `POST /api/docs/{doc_id}/embed` | Copy to `knowledge_base/`, chunk, embed, store; reports duplicates |
| `GET /api/docs/{doc_id}/preview/{n}` · `/media/{name}` · `/download` · `DELETE` | Artefacts |
| `POST /api/batch/upload` · `/batch/convert/{id}` · `/batch/{id}/embed` · `/download` | Batch flows (SSE progress) |
| `GET/DELETE /api/kb/files[/{filename}]` · `POST /api/kb/batch-insert` | Knowledge-base management |
| `GET /api/rag/status` | Models, dimension, default k, document/chunk counts, config errors |
| `POST /api/ask` | **SSE** stream of `rag.ask_events` |
| `GET /fit-gap`, `POST /api/fitgap/run` (SSE) | **InsightLens** — map-reduce over a BPML scope; events `scope`, `step_start`, `tool_call`, `entry`, `verify_fail`, `synthesis`, `done` |
| `GET /api/fitgap/scope`, `/runs`, `/runs/{id}/export?format=md\|json\|xlsx`, `POST /api/fitgap/entries/{id}/review` | Scope picker, run history, exports, the human review loop |
| `GET /evidence`, `POST /api/evidence/ask` (SSE) | **Evidence Agent** — one question, both engines; events `tool_call` then `answer` |
| `GET /api/evidence/status` | Model, tools, the graph hubs being filtered, the near-duplicate groups |
| `GET /api/graph/data` · `POST /api/graph/rebuild` · `POST /api/graph/query` | Graph |
| `GET /api/health` | LibreOffice/pdftoppm availability |

SPA routes (all serve the same `static/dist/index.html`): `/`, `/extract` (`/convert`),
`/batch`, `/add-kb`, `/graph` (`/knowledge-graph`), `/review` (`/doc-md-viewer`),
`/viewer` (`/md-viewer`), `/ask`, `/about` (`/landing`).

**Front end**: React 19 + MUI 9 + Vite 8 + TypeScript, D3 (graph), Mermaid (flowcharts),
marked + DOMPurify (Markdown), Framer Motion, Lucide. Build with
`cd frontend && npm install && npm run build` → `static/dist/`. Client types live in
`frontend/src/api.ts` and mirror the FastAPI response shapes — **keep them in sync**.

---

## 8. Configuration & running

`.env` at the repo root (loaded by `rag.py` and `vlm_api.py`; shell exports win):

| Variable | Current value / default |
|---|---|
| `DATABASE_URL` | `postgresql://senthilpalanivelu@localhost:5433/docling` |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` |
| `RAG_EMBED_MODEL` / `RAG_EMBED_DIMENSION` | `bge-m3` / `1024` |
| `RAG_ANSWER_MODEL` | `claude-opus-5` |
| `ANTHROPIC_API_KEY` | set (answering + optional cloud VLM) |
| `CLAUDE_VLM_MODEL`, `OPENAI_API_KEY`, `OPENAI_VLM_MODEL` | optional vision overrides |
| `COHERE_API_KEY` | **unused leftover** |

Run: `./scripts/run.sh` → `.venv/bin/uvicorn backend.api.app:app --port 8000 --reload`.
External runtime dependencies: PostgreSQL 5433 with the `vector` extension, Ollama serving
`bge-m3`, Tesseract, LibreOffice + `pdftoppm`, and (optionally) MLX/Qwen3-VL locally.

---

## 9. Known gaps, drift and open opportunities

1. **The ArchFlow diagrams are current; the pipeline docs are not.** `system-diagram.md`,
   all four `.puml`/`.png` pairs and the `demo/` ArchFlow demo (`SparkDemoFlow`) were
   regenerated on 2026-09-28 with every subsystem drawn separately — ingestion, the RAG
   system, Ragas, the knowledge graph, Neo4j Community, the three agents, Hindsight,
   PostgreSQL and Langfuse. The workflow diagrams walk all eight flows: upload →
   chunk/embed/store → graph + Neo4j → Ask RAG + Ragas → Evidence Agent → InsightLens →
   Fit-Gap Copilot → Cypher in Neo4j; the client demo walks the same flows without
   InsightLens. `pipeline.md`,
   `solvay-kb-pipeline.md` and `solvay-kb-pipeline-ad.md` still describe only the two
   engines and the ingest pipeline. Also still there: **`docs/system-workflow-ad.png`**,
   an orphan from an earlier run with no `.puml` source — it shows Cohere and no graph,
   and nothing links to it.
2. **RAG and the knowledge graph do not talk to each other.** They read the same files and
   answer in the same UI, but there is no shared identifier, no graph-guided retrieval and
   no vector-guided graph expansion. The obvious next step is GraphRAG: use graph
   traversal to select or re-rank chunks, and use retrieved chunks to ground graph answers.
3. **Graph answers are templates, not language.** `generate_graph_answer` never calls an
   LLM, so answers are structurally correct but rigid, and any question outside the
   path/neighbourhood patterns degrades to substring matching.
4. **Graph extraction is regex-only.** Entities are found by literal keyword presence
   (`"ECC" in content`), which over-links (any mention creates an edge) and cannot capture
   semantics such as *direction* of an interface or the meaning of a relationship.
   `references_ticket` alone is 65% of all edges.
5. **Duplicate-document risk in RAG.** `source` is the primary key, so the same document
   indexed from both `solvay-spark/pkg/markdown` and `knowledge_base` is retrieved twice.
   `POST /api/docs/{id}/embed` detects this and returns a `duplicates` list; nothing resolves it.
6. **Not production-hardened.** No auth, no upload limits, no parser sandboxing, `.workdir/`
   is never garbage-collected (~20 MB per 144-slide deck). Localhost only, by design.
7. **Quality ceiling is set by extraction, not retrieval.** OCR misreads and traced-arrow
   errors propagate into both engines. Improvements to answer quality usually belong in
   `converter.py`, not in `rag.py`.

**Regenerating the diagrams.** All of `docs/` is produced by the `archflow` skill from
`system-diagram.md`: it writes the Mermaid diagram, translates it into the four PlantUML
diagrams (`plantuml -tpng *.puml`), and builds `demo/index.html`. Re-run it after any
architectural change rather than hand-editing the `.png` files.

---

## 10. Conventions to respect when changing code

- **Comments explain *why*, never *what*.** The existing code documents rejected
  alternatives (why not `ts_rank`, why no chunk overlap, why `def` instead of `async def`,
  why spreadsheets bypass Docling). Match that register; do not add narration.
- Module docstrings double as CLI help — keep the first paragraph usable as `--help` text.
- Every heavy FastAPI endpoint stays synchronous `def`.
- Changing chunking or embedding settings changes the fingerprint and therefore forces a
  full re-embed — say so when proposing such a change.
- Changing the vector dimension triggers an automatic table rebuild in `create_schema()`.
- Keep `frontend/src/api.ts` types aligned with `app.py` response shapes.
- Long-running endpoints stream progress as SSE; follow the existing
  `stage`/`sources`/`token`/`done` event vocabulary.

---

## 11. Domain glossary

| Term | Meaning |
|---|---|
| **SPARK** | Solvay's SAP ECC → S/4HANA transformation programme |
| **L2C / I2D / R2R / P2P** | Business streams: Lead to Cash, Idea to Delivery, Record to Report, Procure to Pay |
| **BPML** | Business Process Master List — the process hierarchy; codes like `O-020-090`, `M-090-030`, `L-110-140-010` |
| **L2…L5** | BPML hierarchy levels (L4/L5 are the signed-off detailed process steps) |
| **SPARK-nnnnn** | Functional specification / enhancement / gap ticket |
| **FS / GAP** | Functional Specification / identified gap requiring an enhancement |
| **SOVOS** | External tax determination and e-invoicing engine |
| **Fiori** | SAP's role-based UX layer |
| **Solvay@eCommerce** | Customer-facing ordering portal |
| **CMIR** | Customer Material Info Record |
| **OTIF** | On Time In Full (delivery performance) |
