# Solvay Spark Spine AI — Application Reconstruction Specification

**Purpose.** This specification lets an AI agent or engineer rebuild a functionally equivalent Solvay Spark Spine AI from scratch, without access to the original source. It was first reverse-engineered from the repository at commit `65b38f5` (2026-10-02) and is current as of commit `1d37131` (2026-10-05) plus the uncommitted ownership and start-up fixes in the working tree. Line numbers cited are at that working tree.

**How the spec is organised.** This file is the master spec. It covers architecture, build order and acceptance, and summarises every area. Six detailed sections back it up with exact formulas, DDL, prompts, thresholds and endpoint tables:

| § | File | Covers |
|---|---|---|
| 01 | [01-infrastructure-build-deploy.md](01-infrastructure-build-deploy.md) | Stack and pinned versions, Dockerfiles, compose, `run.sh`, every env var (accounts and load-test variables included), filesystem state, registry/deploy, operating the deployed server (accounts, model switch, Admin cost table), Locust load tests |
| 02 | [02-http-api-and-core.md](02-http-api-and-core.md) | FastAPI app, all 126 routes, accounts and roles, the `spark_session` cookie, the `RequireUser` gate, run ownership, the Admin API and cost estimate, Demo Mode, session attachments, Langfuse tracing |
| 03 | [03-ingestion.md](03-ingestion.md) | Document → Markdown: Docling, Tesseract, OpenCV table/flow detection, vision models (verbatim prompts), chunker |
| 04 | [04-rag-database-evaluation.md](04-rag-database-evaluation.md) | **Complete Postgres DDL** (accounts, activity log and run-owner columns included), embeddings, BM25 + vector + RRF retrieval, answer prompt, Ragas judging, quality analytics |
| 05 | [05-agents-and-knowledge-graph.md](05-agents-and-knowledge-graph.md) | Evidence Agent, InsightLens, Fit-Gap Copilot (all scoring formulas and quality gates; cut-off refusal and `amend_analysis`), run ownership, guardrails, knowledge-graph extraction, Neo4j, NL→Cypher |
| 06 | [06-frontend-and-tests.md](06-frontend-and-tests.md) | React app, 13 tabs (12 + an Admin button for Admins, 11 for Users), account menu, Admin dashboard, every API client call, theme, Demo app, all tests, Locust load tests, acceptance checklist |

**Notation used throughout.**
- **FACT** / **[F]**: stated in the repository, cited as `file:line` (paths relative to the repository root).
- **INFERRED** / **[I]**: reasoned from evidence and not stated anywhere. Treat it as an assumption to verify.
- Where the docs and the code disagree, **the code is authoritative**. Known disagreements are listed in §11.3.

---

## 1. Architecture

### 1.1 What the system is
[F] Solvay's SPARK programme is moving SAP ECC to S/4HANA. Solvay Spark Spine AI is a single-tenant knowledge platform built on that programme's documents: workshop decks and transcripts, functional specs, process spreadsheets, interface designs and BPML process maps. It does four things:

1. Converts documents (PPTX/DOCX/XLSX/PDF/images/mail/XML/CSV…) to clean Markdown, with OCR and diagram/table recovery from embedded images.
2. Indexes the Markdown in Postgres/pgvector for hybrid search, and answers questions with Claude, with citations (**Ask RAG**).
3. Builds a deterministic, rule-based **knowledge graph** of streams, processes, systems, specs and documents (the "Spine"), and copies it into Neo4j for Cypher queries.
4. Runs three tool-using **Claude agents** that share one set of guardrails:
   - **Evidence Agent**: scored claims, each backed by quotes checked word for word.
   - **InsightLens**: a draft Fit/Gap register for each BPML step.
   - **Fit-Gap Copilot**: SAP Fit-to-Standard analysis of a country rollout, with a deviation register, scores, quality gates, a workshop agenda, decisions and PDF/DOCX/XLSX exports.

[F] Every answer is evaluated: Ragas judges score Ask answers, code-only metrics score agent runs, and all traces go to Langfuse.

### 1.2 Component diagram

```
                    Browser (React 19 SPA: index / login / demo bundles)
                                     │  HTTP + SSE (text/event-stream over POST)
                                     ▼
┌───────────────────── FastAPI app  (one uvicorn process, :8000) ─────────────────────┐
│ RequireUser gate (cookie spark_session; accounts in Postgres) · /login · /demo       │
│ ContactRedaction ASGI middleware on /api/{evidence,fitgap,rollout,ask,quality}       │
│                                                                                      │
│  ingestion/        rag/                  agents/                     graph/          │
│  converter ──────▶ md_chunker ─▶ rag ──▶ evidence  fitgap  rollout   knowledge_graph │
│  pptx_ocr          (index, search,       guardrails (scope/web/      kg_neo4j_load   │
│  table_cv/flow_cv   answer)              contact)  agent_eval        kg_nl2cypher    │
│  vlm_api/vlm_ocr   ask_store evaluation  memory (Hindsight client)   graph_eval      │
│  preview           quality coverage                                                  │
│  auth/: store · passwords · sessions · middleware · deps · routes   api/admin        │
│  core/: paths · uploads (per-session schemas) · tracing (Langfuse/OTel) · pricing    │
└──────┬──────────┬──────────────┬──────────────┬─────────────┬───────────┬────────────┘
       │          │              │              │             │           │
  LibreOffice  Postgres 18    Ollama        Anthropic      Neo4j 5      Hindsight 0.10.1
  pdftoppm     + pgvector     bge-m3        Claude API     + APOC       memory server
  Tesseract    (main DB +     (1024-d       (opus/sonnet/  (optional)   (optional; own
  (local bins) <db>_session)  embeddings)   haiku; web)                  `hindsight` DB)
                                             OpenAI (opt. vision)  Langfuse Cloud (opt.)
```

### 1.3 Components and responsibilities
| Component | Responsibility | Detail |
|---|---|---|
| `backend/api/app.py` | 106 of the HTTP routes, the SPA shell, lifespan (start tracing; bootstrap the accounts and the first Admin; bring the run tables' owner columns up to date; sync the graph to Neo4j in the background) | §02 |
| `backend/auth/` | Accounts (`users`, `activity_events`), scrypt passwords, the HMAC-signed `spark_session` cookie, the `RequireUser` gate, ownership helpers (`list_owner`/`read_owner`/`write_owner`), sign-in routes, account CLI | §02 §3 |
| `backend/api/app_login.py`, `demo_mode.py` | `/login` page and the `RequireUser` install; Demo Mode pages on the same accounts and cookie | §02 §3e |
| `backend/api/admin.py` | Admin API `/api/admin/*`: accounts, usage with estimated cost, activity log, everyone's runs | §02 §4m |
| `backend/core/` | `paths` (ROOT, DATA), `uploads` (per-session attachment stores, each owned by one account), `tracing` (Langfuse, no-op without keys; traces tagged with the username), `pricing` (hard-coded list prices for the Admin cost estimate) | §02 §4m, §5–6 |
| `backend/ingestion/` | Document → Markdown pipeline, preview rendering, chunking, BPML spreadsheet rendering | §03 |
| `backend/rag/` | Corpus schema, embedding, BM25+vector+RRF retrieval, Claude answers, Ask history, Ragas evaluation, quality and coverage analytics, experiments | §04 |
| `backend/agents/evidence` | Evidence Agent: claims scored by a fixed formula; Hindsight memory | §05 §2 |
| `backend/agents/fitgap` | InsightLens: map-reduce over BPML steps; verifier; arithmetic synthesis; XLSX export | §05 §3 |
| `backend/agents/rollout` | Fit-Gap Copilot: two passes (As-Is, then compare), gates QG1–QG7, scores A–D, decisions, workshop exports | §05 §4 |
| `backend/agents/guardrails` | Policy text, scope classifier (Haiku), gated web search (Sonnet), contact redaction | §05 §1 |
| `backend/graph` | Rule-based graph extraction (no LLM), Neo4j load, NL→Cypher, graph evaluation | §05 §6 |
| `frontend/` | Vite multi-page React/MUI app, built into `static/dist/` and served by FastAPI | §06 |

### 1.4 Interaction patterns
- [F] **Concurrency.** Heavy endpoints are plain `def` handlers running in Starlette's threadpool. Deferred work runs on daemon threads: Ragas judging after each answer, the upload pipeline stages, the Neo4j sync. There is **no job queue and no Celery**.
- [F] **Streaming.** Long operations (convert batch, embed, ask, agents) return `text/event-stream` with `event:`/`data:` lines in response to a **POST**. The client parses the stream manually (`fetch` + reader), not with `EventSource`.
- [F] **Accounts and ownership.** Every page and every `/api/*` route except `/api/health` and the login/logout/session routes needs a signed-in account (401 `Sign in first.` for `/api/*`, 303 to `/login?next=…` for pages). Every run (Ask, Evidence, InsightLens, Fit-Gap Copilot, including workshop sessions and decisions, and reviews) records its owner `user_id`. Users see only their own; someone else's run or upload session answers 404, as if missing. Admins read everyone's runs with `scope=all` but write only their own. Conversions (single uploads and batches) belong to the uploader alone, Admins included. Workshop decisions are shared by design: organisational memory readable by every signed-in user; each row records who decided it. Details in §02 §3.
- [F] **Persistence.** All state lives in Postgres: accounts, activity log, corpus, history, every agent run, decisions. The graph is cached in `data/knowledge_graph.json`. Scratch files go under `.workdir/`.
- [F] **Migrations.** There is no migration tool. Every store runs `CREATE … IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` lazily on first use. An empty database therefore bootstraps itself, apart from the corpus, which must be indexed.

---

## 2. Technology stack (summary; full pins in §01 §1)

| Layer | Choice and version [F] |
|---|---|
| Backend language | Python **3.12** (`python:3.12-slim-bookworm`); Hindsight server on Python 3.13 |
| Web | FastAPI 0.141.1 / Starlette 1.7.0, uvicorn[standard] 0.54.0, python-multipart |
| Documents | docling 2.130.0 (+ docling-core 2.99.0, ibm-models 4.0.3, parse 7.22.0), tesserocr 2.11.0, opencv-python 5.0.0.93, numpy 2.5.2, openpyxl 3.1.5, python-pptx 1.0.2, torch 2.14.0 / torchvision 0.29.0 **CPU wheels** |
| DB | psycopg 3.3.6 (binary), pgvector 0.5.0; PostgreSQL 18 + pgvector (`pgvector/pgvector:pg18`) |
| LLM | anthropic 1.8.0; models `claude-opus-5` (answers, agents, Cypher, cloud vision), `claude-sonnet-5` (Ragas judge, web search, Hindsight reflect), `claude-haiku-4-5-20251001` (scope guard); optional OpenAI `gpt-5` for vision; optional local MLX `mlx-community/Qwen3-VL-8B-Instruct-4bit` (Apple silicon only, not in requirements) |
| Embeddings | Ollama `bge-m3`, 1024 dimensions |
| Evaluation | ragas 0.4.3 (+ **`langchain-community<0.4`, a required pin**), instructor; langfuse 4.15.6 + OTel anthropic/threading instrumentation |
| Graph | neo4j driver 6.3.1; Neo4j `5-community` + APOC |
| Memory | hindsight-client 0.10.1 ↔ hindsight-api 0.10.1 (LLM through LiteLLM) |
| Exports | weasyprint 70.0 (needs pango/cairo/gdk-pixbuf), python-docx 1.2.0, openpyxl |
| Load tests | Locust `>=2.32` (unpinned) in its own venv `.venv-loadtest`; not in the image |
| Frontend | Node 22 (build image), React 19.3, @mui/material 9.4, emotion 11.14, d3 7.9, **mermaid 10.9.1 (exact)**, marked 12, dompurify 3.4, framer-motion 13.4, lucide-react 1.46, react-resizable-panels 4.12; dev: **typescript 5.9**, vite 8.3, @vitejs/plugin-react 6.1 |
| System binaries | LibreOffice (`soffice`), Poppler (`pdftoppm`), Tesseract + `eng` data, Pango/Cairo/gdk-pixbuf, libGL/glib/xcb, DejaVu fonts, curl |

[F] `requirements.txt` is unpinned. `constraints.txt` (199 pins) fixes the exact versions for the Docker build (`pip install -r requirements.txt -c constraints.txt`). torch is deliberately left out of the constraints because the CPU index adds a `+cpu` suffix. `cohere` is still installed but unused, so a rebuild can drop it.

---

## 3. Dependencies and why each is needed

| Dependency | Required? | Why | Behaviour if absent [F] |
|---|---|---|---|
| PostgreSQL 18 + pgvector | **Required** | Accounts and activity log, corpus, vectors, BM25 statistics, all run history, session attachments (`<db>_session`) | Nobody can sign in, so nothing but `/api/health` and the sign-in pages is served [I]. The DB role must be able to `CREATE EXTENSION vector` and `CREATE DATABASE` |
| Ollama + `bge-m3` | **Required** for indexing and for hybrid/vector search | Query and chunk embeddings | Keyword-only mode still works [I] |
| Anthropic API key | **Required** for answers, agents, Cypher generation and judges | All LLM work | Endpoints error. Tests stub it |
| LibreOffice + pdftoppm | Strongly recommended | Left-pane preview of the original document | Preview is unavailable. `/api/health` reports `soffice`/`pdftoppm` as null |
| Tesseract | Strongly recommended | OCR of images embedded in Office docs, which Docling leaves empty | Image text is lost |
| Neo4j + APOC | Optional | Cypher view; a copy of the JSON graph | Cypher tab disabled when `NEO4J_PASSWORD` is empty |
| Hindsight | Optional | Evidence Agent long-term memory (bank `spark-evidence`) | Memory off when `HINDSIGHT_URL` is empty or unreachable |
| Langfuse | Optional | Traces and scores | Silent no-op unless both keys are set |
| OpenAI key / MLX | Optional | Alternative vision models for images | Provider choice unavailable |
| WeasyPrint system libs | Optional | Copilot and workshop PDF export | PDF button hidden; Markdown fallback |
| Corpus `solvay-spark/` | **Required data, not in git** | Client documents, with category from folder (`pkg`→PKG, `dr`→DR, `sap`→SAP) | Empty index and empty graph |

---

## 4. Data and state

### 4.1 Postgres (full verbatim DDL in §04 §2)
[F] One main database (`docling` locally, `solvay` in compose) holds:

| Area | Tables (owner module) |
|---|---|
| Corpus | `rag_categories`, `rag_documents` (UNIQUE `source`), `rag_chunks` (`embedding vector(1024)` HNSW cosine; `tsv tsvector` GIN, `english`; composite FK `(document_id, category)` `ON UPDATE CASCADE`) — `rag/rag.py` |
| Ask | `ask_*` runs, excerpts, evaluations (retention 500 runs; abandoned after 5 min) — `rag/ask_store.py` |
| Experiments | `eval_*` — `rag/experiment_store.py` |
| Agents | `evidence_runs`; `fitgap_*`; `rollout_*` + workshop tables (decisions append-only) — `agents/*/store.py` |
| Graph | `graph_quality_runs` — `graph/graph_eval.py` |
| Accounts | `users` (unique on `lower(username)`, role `admin`/`user`, `active`, `session_version`), `activity_events` (usage log); the built-in inactive `legacy` row — `auth/store.py` |

[F] Every run, review, workshop session and workshop decision table (`fitgap_runs`, `fitgap_reviews`, `rollout_runs`, `workshop_sessions`, `workshop_decisions`, `evidence_runs`, `ask_runs`, `ask_reviews`) gains `user_id bigint REFERENCES users(id)` plus an index, and rows recorded before accounts existed are handed to `legacy` (`auth/store.py:125-137,340-341`). Evidence retention (200) is per owner.

[F] The sibling database `<main>_session` (always the main DB name plus `_session`, auto-created) holds the tables `upload_sessions` (with an owner `user_id` and no foreign key, because `users` is in the other database) and `upload_files`, plus **one schema `u_<12hex>` per upload session**, each with its own `rag_documents`/`rag_chunks`. The TTL is 12 h, extended on every use; the cap is 12 files per session. Expired sessions are cleaned up lazily when certain endpoints are called.

[F] Hindsight owns a separate `hindsight` database (compose) or the embedded `~/.pg0` (local).

[F] Each connection sets `hnsw.ef_search=800` and `hnsw.iterative_scan=relaxed_order`. **Destructive rule:** if the stored vector dimension differs from `RAG_EMBED_DIMENSION`, `rag_chunks` and `rag_documents` are dropped and recreated.

### 4.2 Files
| Path | Content |
|---|---|
| `solvay-spark/<cat>/` and `solvay-spark/<cat>/markdown/*.md` | Client corpus: originals and converted Markdown (read-only in compose) |
| `knowledge_base/` | Markdown added from the UI (`<stem>_<ext>.md`, category UNFILED unless chosen; the category is persisted as front matter), plus `BPML_Process.xlsx` → `BPML_Process_xlsx.md` |
| `data/knowledge_graph.json` | Cached graph (currently 2,376 nodes / 4,752 edges / 8,368 chunks; depends on the corpus). Also `graph_eval_questions.json`; `spark_target_model.json` is unused |
| `.workdir/<12hex>/` | Per-conversion job: `source.<ext>`, `name.txt`, `owner.txt` (uploader's user id), `preview/page-NNNN.png`, `output.md`. Never garbage-collected |
| `.workdir/batches/<id>/`, `.workdir/uploads/<sid>/`, `.workdir/kb<hash>/` | Batch convert (with `owner.txt`), session attachment Markdown, previews of indexed originals (no `owner.txt`; a `shared` marker makes their pages readable by every signed-in user) |
| `static/dist/` | Built SPA (committed to git, and rebuilt in the image) |
| `docs/` | Read at runtime: eval questions, Langfuse dashboard JSON |
| `.venv-loadtest/` | Locust's own venv (load tests only; git-ignored) |

### 4.3 Caches
[F] There is no persistent content cache in ingestion. Embedding is skipped when the document **fingerprint** is unchanged: a hash of the embedding and chunking settings plus the body without front matter. Changing a category therefore never re-embeds.

---

## 5. Configuration

### 5.1 Environment variables (complete table in §01 §5)
[F] Configuration is read from the process environment, and `.env` at the repository root is loaded with `override=False`.

| Group | Variables |
|---|---|
| Required | `DATABASE_URL`, `ANTHROPIC_API_KEY`; compose also requires `POSTGRES_PASSWORD`, `NEO4J_PASSWORD` |
| Accounts | `ADMIN_USERNAME`/`ADMIN_PASSWORD` (the first Admin, created or re-enabled at start-up only when there is no active Admin), `AUTH_SECRET` (falls back to `APP_SECRET`, then a random per-process secret, so a restart signs everyone out), `AUTH_SESSION_HOURS` (falls back to `APP_SESSION_HOURS`, then 12). Every other account is created in the Admin tab |
| Services | `OLLAMA_HOST` (`http://127.0.0.1:11434`), `NEO4J_URI` (`bolt://127.0.0.1:7687`), `NEO4J_USER`, `NEO4J_PASSWORD` (empty = Cypher off), `HINDSIGHT_URL` (`http://127.0.0.1:8888`; empty = memory off) |
| Models | `RAG_EMBED_MODEL=bge-m3`, `RAG_EMBED_DIMENSION=1024`, `RAG_EMBED_BATCH`, `RAG_HNSW_EF_SEARCH` (800), `RAG_ANSWER_MODEL` (`claude-opus-5`), `FITGAP_COPILOT_MODEL` (falls back to `RAG_ANSWER_MODEL`; read at import, so a change needs the container recreated), `CLAUDE_VLM_MODEL`, `OPENAI_API_KEY`, `OPENAI_VLM_MODEL` |
| Copilot budgets | `ROLLOUT_MAX_TOOL_CALLS_ASIS` (20), `ROLLOUT_MAX_TOOL_CALLS` (30), `ROLLOUT_MAX_INPUT_TOKENS` (150000), `ROLLOUT_MAX_BILLED_TOKENS` (220000), `ROLLOUT_MAX_TOKENS_OUT` (64000, `max_tokens` per Copilot response) |
| Langfuse | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (`https://cloud.langfuse.com`), `LANGFUSE_TRACING_ENVIRONMENT` |
| Hindsight server | `HINDSIGHT_MODEL` (`anthropic/claude-opus-5`), `HINDSIGHT_REFLECT_MODEL` (`anthropic/claude-sonnet-5`), `HINDSIGHT_REFLECT_TIMEOUT` (60) |
| Compose / scripts | `TAG`, `APP_PORT`, `HINDSIGHT_TAG`, `PORT` (run.sh), `IMAGE`/`PLATFORM` (publish) |
| Load tests only | `LOADTEST_USERNAME` (must start `loadtest-`), `LOADTEST_PASSWORD`, `LOADTEST_ACCOUNTS` (20), `LOADTEST_ALLOWED_HOSTS` (`localhost,127.0.0.1`), `LOADTEST_LLM`, `LOADTEST_HEAVY`, `LOADTEST_ROLLOUT_SESSION`/`_SUBJECT`/`_SCOPE`, `LOADTEST_FITGAP_STEPS`; `MOCK_FIRST_TOKEN_MS`, `MOCK_TOKENS_PER_SEC`, `MOCK_ANSWER_TOKENS`; `ANTHROPIC_BASE_URL` to point a second app at the mock |

[F] **Removed** since `65b38f5`: `APP_LOGIN`, `APP_USERNAME`, `APP_PASSWORD`, `DEMO_USERNAME`, `DEMO_PASSWORD`, `DEMO_SECRET`, `DEMO_SESSION_HOURS`. There is no way to switch the sign-in off, and there are no demo credentials: Demo Mode uses the same accounts and cookie. Model prices for the Admin cost estimate are hard-coded in `backend/core/pricing.py`, with no environment variable.

### 5.2 Secrets and external accounts needed
- An Anthropic API key with access to the three Claude model IDs above.
- A Postgres superuser-capable role.
- A first Admin's username and password (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, at least 8 characters) and a fixed `AUTH_SECRET` (`openssl rand -hex 32`).
- Optional: Langfuse project keys, an OpenAI key, a Neo4j password.
- Optional: registry credentials for `reg.ivolve.cloud` (a GitLab token with `write_registry`/`read_registry`).
- Optional: an ngrok account (the demo URL is in `scripts/ngrok.sh`).

---

## 6. Build instructions

### 6.1 Local (macOS, as in the repository)
```bash
brew install python@3.12 postgresql@18 poppler tesseract pango cairo gdk-pixbuf node
brew install --cask libreoffice
# Ollama from https://ollama.com, then:
ollama pull bge-m3
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt   # add  -c constraints.txt  for exact pins
cd frontend && npm ci && npm run build && cd ..        # tsc --noEmit && vite build → static/dist
# optional memory server:
uv venv --python 3.13 hindsight-venv && uv pip install --python hindsight-venv/bin/python hindsight-api==0.10.1
```
Then create `.env` from `.env.example` with at least `DATABASE_URL=postgresql://<user>:<pw>@localhost:5433/docling`, `ANTHROPIC_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `AUTH_SECRET`.

[I] Port 5433 is a manual Homebrew Postgres configuration change and is not scripted.

### 6.2 Container image (`Dockerfile`, 4 stages; detail in §01 §2.1)
1. **`ui`**: `node:22-slim` on `$BUILDPLATFORM`, `npm ci`, `npm run build`.
2. **`models`**: `docling-tools models download -o /opt/docling-models` so the runtime downloads nothing.
3. **`deps`**: `python:3.12-slim-bookworm`, build deps `libtesseract-dev libleptonica-dev`, CPU torch from `download.pytorch.org/whl/cpu`, then `pip install -r requirements.txt -c constraints.txt`.
4. **`runtime`**:
   - apt packages: `libreoffice-core/-writer/-calc/-impress poppler-utils tesseract-ocr tesseract-ocr-eng libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libgl1 libglib2.0-0 libxcb1 fonts-dejavu curl`
   - copy `backend/ data/ docs/` plus the built `static/dist`
   - run as user `app` (uid 1000), `EXPOSE 8000`
   - command: `uvicorn backend.api.app:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips *`
   - healthcheck: `curl -fsS http://127.0.0.1:8000/api/health`, every 30 s, start period 60 s

`Dockerfile.hindsight` has 2 stages on Python 3.13. It installs `hindsight-api==0.10.1` with CPU torch, bakes in `BAAI/bge-small-en-v1.5` and `cross-encoder/ms-marco-MiniLM-L-6-v2`, runs offline, and listens on 8888.

Publish: `scripts/docker-publish.sh [app|hindsight]` runs buildx (or podman `--format docker`) for `linux/amd64`, tags `:<git sha>` and `:latest`, and pushes to `reg.ivolve.cloud/ivolve/solvay-spark-spine[-hindsight]`.

---

## 7. Runtime instructions

### 7.1 Local
```bash
brew services start postgresql@18
ollama serve &
./scripts/run.sh            # http://localhost:8000 ; sign in as ADMIN_USERNAME / ADMIN_PASSWORD
```
`run.sh` runs these steps in order:
1. Starts Hindsight (`scripts/hindsight.sh`, LiteLLM provider, 127.0.0.1:8888) if it is installed and `HINDSIGHT_URL` is not set empty.
2. If `NEO4J_PASSWORD` is set: `podman machine start`, then `docker compose -f compose.neo4j.yml up -d` (container `docling-neo4j`, 127.0.0.1:7474/7687).
3. `exec uvicorn backend.api.app:app --port ${PORT:-8000} --reload --reload-dir backend`.

On startup the app, in order (`backend/api/app.py:74-97`):
1. logs the Langfuse status;
2. runs `bootstrap_admin()` (`app.py:86`): creates `users`, `activity_events` and the `legacy` account, and, if there is no active Admin and both `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set, creates that Admin (or re-enables an existing account of that name as an Admin). With either unset it logs `auth: WARNING -- there is no active Admin account…` and still starts. A password under 8 characters or a refused username (empty, spaces, `|`, over 64 characters, or `legacy`) also only logs `auth: WARNING -- ADMIN_PASSWORD/ADMIN_USERNAME was not used: … No Admin account was created.` and the app starts (`backend/auth/store.py:312-334`);
3. runs `_ensure_run_tables()`, which adds the owner column to the ask, evidence, fitgap and rollout run tables and hands older runs to `legacy` (a failure is logged, not fatal);
4. spawns a thread that loads `data/knowledge_graph.json` into Neo4j, retrying for up to 120 s.

### 7.2 First-time data load (empty database)
[I] The order is derived from the code paths:
1. Convert the corpus:
   `python -m backend.ingestion.folder_to_md solvay-spark/<cat> [-r]`
   The converted files go to `solvay-spark/<cat>/markdown/`.
2. Index it with `python -m backend.rag.rag …` (see §04 §8.1 for the CLI subcommands), or use the UI's Batch Convert → embed, or Add to knowledge base.
3. Build the graph with `POST /api/graph/rebuild` (or the Spine → Rebuild button). This writes `data/knowledge_graph.json` and resyncs Neo4j. The API needs a session: sign in with `POST /api/auth/login` and send the `spark_session` cookie.

**Alternative:** `pg_restore` a dump made by `scripts/db-export.sh`.

### 7.3 Operating
- Health: `GET /api/health`.
- Stop: Ctrl+C stops uvicorn only. Stop the rest with `docker compose -f compose.neo4j.yml down`, `pkill -f hindsight-api`, `podman machine stop`.
- Back up: `scripts/db-export.sh` writes `backup/spark-YYYY-MM-DD.dump` (custom format; holds the accounts, the embeddings and history).
- Accounts (§01 §7.7): `python -m backend.auth.store create-admin <username>` (prompts for the password), `… list`, `… reassign-legacy <username> [table ...]` (hands runs recorded before accounts existed from `legacy` to a real account). In compose, prefix with `docker compose exec app`. Everyone else's account is created, reset or deactivated in the Admin tab; accounts are never deleted.
- Switching the Fit-Gap Copilot model: set `FITGAP_COPILOT_MODEL` in `.env`, then `docker compose up -d app`. `docker compose restart app` is not enough, because it keeps the old container and its environment, and the model is read at import. `GET /api/rollout/status` reports the model in use.
- Load tests (§01 §7.8, §06 §8.4): Locust in `loadtest/` runs only as `loadtest-*` accounts (created by `loadtest/seed_users.py`), only against `LOADTEST_ALLOWED_HOSTS`, and makes no Claude calls unless `LOADTEST_LLM=1` or `LOADTEST_HEAVY=1`. The app needs a fixed `AUTH_SECRET` for it.

---

## 8. Infrastructure and deployment (detail in §01 §3, §7)

[F] `compose.yml` defines the server stack. All services join the **external** Docker network `ivolve-network`, and every service called by name carries a `solvay-` prefix.

| Service | Image | Notes |
|---|---|---|
| `app` | `reg.ivolve.cloud/ivolve/solvay-spark-spine:${TAG:-latest}` | Only published port `${APP_PORT:-8000}:8000`. Volumes: `workdir`→`/app/.workdir`, `graph-data`→`/app/data`, `./solvay-spark` (ro), `./knowledge_base` (rw, uid 1000). Env overrides point to the `solvay-*` hosts |
| `solvay-postgres` | `pgvector/pgvector:pg18` | User `spark` (superuser), DB `solvay`, volume `pgdata`, healthcheck `pg_isready` |
| `solvay-hindsight-db` | pg18 (one-shot) | Waits for Postgres, then `createdb hindsight` |
| `solvay-hindsight` | `…-hindsight:${HINDSIGHT_TAG}` | Port 8888 internal; LiteLLM with Anthropic |
| `solvay-ollama` + `solvay-ollama-pull` | `ollama/ollama:latest` | The one-shot service pulls `bge-m3` |
| `solvay-neo4j` | `neo4j:5-community` | APOC; heap 512m, pagecache 256m |

**Deploy sequence** (`docs/deployment.md`):
1. On the dev machine, publish the images and export the database.
2. On the server, copy `compose.yml`, `.env` (with `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `AUTH_SECRET` set before the first start), `solvay-spark/`, `knowledge_base/` and the dump.
3. `docker compose up -d solvay-postgres solvay-ollama solvay-ollama-pull solvay-neo4j`.
4. `pg_restore`.
5. `up -d solvay-hindsight-db solvay-hindsight app`.
6. Check `curl localhost:8000/api/health`.
7. Sign in as `ADMIN_USERNAME` and create everyone else's account from the **Admin** tab.

**Security posture** [F]: accounts guard the pages and the API; a signed-out `/api/*` call gets 401 and only `/api/health` and the login/logout/session routes are exempt. Runs, upload sessions and conversions (single and batch) are owned, but workshop decisions, the corpus, knowledge base, graph (rebuild, Neo4j sync) and Cypher tools are shared by design, as the programme's common knowledge: any signed-in User can use them, including deleting knowledge-base files. The `spark_session` cookie is `HttpOnly`, `SameSite=Lax`, and **not** `Secure`, so the cookie and passwords travel in clear over plain HTTP. There is no CSRF token, no rate limiting (on sign-in either) and no upload size cap. [I] FastAPI's `/docs`, `/redoc` and `/openapi.json` are left on and, not being under `/api/`, are not gated. Production relies on a TLS reverse proxy, VPN or allowlist, which lives outside this repository.

---

## 9. Behaviour

### 9.1 Key workflows
0. **Sign in and accounts** (§02 §3, §06 §2.1, §3.15):
   - `/login` (or `/demo/login`) posts to `/api/auth/login`; scrypt-checked against `users`; success sets the `spark_session` cookie, a signed token `uid|session_version|expires|HMAC-SHA256`. A new password or deactivation bumps `session_version`, which signs that account out everywhere; the gate caches account lookups for 30 s per process.
   - Two roles, `admin` and `user`. The first Admin comes from `ADMIN_USERNAME`/`ADMIN_PASSWORD` at start-up or from the CLI; every other account is created by an Admin (always as `user`, then promoted if wanted). The last active Admin cannot be demoted or deactivated, and nobody can demote or deactivate themselves.
   - Every run is owned. Reviewer, facilitator and decision-maker names come from the account; typed names in the request are ignored. A User sees only their own runs and upload sessions; another's is 404. An Admin's history lists take `scope=mine|all` (a switch in the account menu); with `all` they show every owner, but an Admin writes (delete, review, decide, re-score) only their own runs. Runs from before accounts belong to the inactive `legacy` account until handed over with `reassign-legacy`. `/api/rollout/decisions` lists every account's decisions to every signed-in user: they are organisational memory, and each row records who decided it.
   - A conversion belongs to its uploader: `/api/upload` and `/api/batch/upload` write `owner.txt` into the job folder, and every follow-up (`/api/convert/{id}`, `/api/docs/{id}/…`, `DELETE /api/docs/{id}`, `/api/batch/convert|download|embed`) answers 404 "Document/Batch not found" for anyone else, an Admin included, and for a job with no owner. The exception is a job that `POST /api/kb/files/open` returned for Doc vs MD (a `kb<hash>` copy, or an upload job whose original is in the knowledge base): it carries a `shared` marker, so every signed-in user can read its preview pages, media and Markdown, while only its uploader can convert, embed or delete it. Shared by design: workshop decisions (organisational memory; each row records who decided it), the corpus, the knowledge-base files (`/api/kb/*`), the graph and the Cypher tools.
   - Every sign-in, failed sign-in, run, review, decision, workshop, export, delete and account change is logged to `activity_events`.
1. **Convert** (`/convert`; §03):
   - Upload a file; LibreOffice → PDF → `pdftoppm -r 90` renders the preview pages.
   - "Convert to Markdown" routes by extension: openpyxl tables for xlsx; mail reader for msg/eml; ElementTree for xml; Docling for everything else.
   - Each embedded picture then goes through a fixed cascade: **Tesseract** (PSM 11, 3× upscale) → optional **vision model** (≥20 words, ≥200×150 px) → **flow_cv** (Mermaid) → **table_cv** (Markdown table) → plain OCR text.
   - Each result is wrapped in an HTML provenance comment. Keep that wording verbatim: the Evidence Agent's `provenance.py` parses it.
   - PowerPoint connector shapes become exact Mermaid flowcharts.
2. **Add to knowledge base / Batch Convert**: stream progress, then chunk the Markdown:
   - target 500 / max 1000 / min 120 "tokens" (chars ÷ 4), no overlap; tables are split by row with the header repeated
   - embedding text is prefixed with `Document: <title>` / `Section: <heading path>`
   - embed in batches of 32 through Ollama `/api/embed`, falling back to `/api/embeddings`
   - upsert by `source`
3. **Ask RAG** (§04 §5–6):
   - Embed the query; vector top 40 and **SQL BM25** top 40 (k1 1.2, b 0.75, english tsvector; SAP codes like `M-090-030` are indexed as single words along with their parent codes).
   - Fuse with **RRF k=60**, keep the top 8 (API cap 20). No threshold, no reranker.
   - Claude `claude-opus-5` answers via streaming (max_tokens 16000), using `<excerpt>` blocks and citing `[n]`.
   - SSE events cover the stepper stages (embed → vector → keyword → fuse → answer), with sources sent before the tokens.
   - After the answer, 9 Ragas judges (`claude-sonnet-5`) run on a daemon thread. They produce a weighted overall score with a 0.25 safety cap, and the scores go to Langfuse. The UI polls every 2.5 s until the evaluation is terminal.
4. **Evidence Agent** (§05 §2):
   - Claude tool loop with a 14-call budget over the corpus, graph and BPML tools, plus optional memory recall/retain/reflect.
   - Quotes are verified word for word, and failing quotes are dropped.
   - **The model's scores are discarded and recomputed:** base 0.50, +0.15 per independent source, caps 0.40/0.35/0.30, clamp [0.05, 0.95].
   - Answer confidence is the weakest supporting claim. There are six answer states.
   - Results persist to `evidence_runs`; lineage can be downloaded as md/json.
5. **InsightLens** (§05 §3):
   - Resolve a BPML scope (default 4.5.1), then run one agent per step (12 calls each, concurrent).
   - A verifier repairs the output; pure-arithmetic synthesis produces Reuse, Gaps, Decisions, Integrations and Agenda.
   - Workshop weight = Σ materiality × (1 − confidence).
   - Entry review accepts, rejects or refines entries. Export to md/json/7-sheet XLSX.
6. **Fit-Gap Copilot** (§05 §4):
   - Upload subject documents with roles (`as_is`, `sap_bp`, template) into a session.
   - **Pass 1** reads the As-Is (≤20 tool calls). **Pass 2** compares against the Global Template and SAP Best Practice (≤30 calls). The output is a deviation register on 16 deviation types, 10 dispositions and 7 weighted dimensions.
   - **Quality gates** QG1, QG2, QG4–QG7 repair the output; QG3 is deliberately absent because it is human judgement.
   - **Scores**:
     - A = GT alignment: Σ (rating ÷ 4 × 100) × w over rated dimensions, weights 25/20/15/10/10/10/10
     - B = SAP BP alignment
     - C = localization-adjusted = GT + (100 − GT) × the confirmed-localization materiality share
     - D = harmonization potential: disposition base + 5 × (fit − 2), capped at 15/25/50 by localization state
     - Divergence = 100 − alignment
   - The five-level standardisation outlook is computed **in the frontend** (`outlook.ts`).
   - Decisions are stored append-only. Facilitator mode keeps drafts.
   - Output limits: each response may use up to `ROLLOUT_MAX_TOKENS_OUT` (64000) tokens, streamed. A submission in a response cut off at that limit is refused, never accepted, and the model is asked to resubmit more tightly; after 2 cut-offs the pass stops and the run fails rather than keeping a truncated register.
   - A sent-back pass-2 submission is corrected with the **`amend_analysis`** tool, which sends only what changes and is merged into the held submission, then checked again like a full one. The full submission is replaced by an outline in the history to save tokens.
   - Before pass 2's first turn the harness itself runs `list_sources`, `get_scope` (when a scope is named) and `compare_entities`, outside the tool budget. Quotes over 400 characters are shortened at a word boundary; list fields sent as text are parsed back into lists.
   - The model comes from `FITGAP_COPILOT_MODEL` (falling back to `RAG_ANSWER_MODEL`, then `claude-opus-5`), read at import. The UI shows each run's duration (total and per pass), computed from the stored log in `timing.ts`.
   - Exports: Markdown pack, WeasyPrint PDF, workshop outcomes as md/pdf/docx/xlsx.
7. **Spine / knowledge graph** (§05 §6):
   - Deterministic extraction (**no LLM**) from the Markdown and the BPML hierarchy: 4 streams and 17 systems are hard-coded (the former `M3` "Infor M3" system was removed: "M3" in the corpus is an order type or a cubic metre); regexes find process codes and tickets; the L1–L4 register adds structure.
   - Cleanup rules: an OCR-misread process code (`O0-160-070`, `Q-130-…`) is repaired to its `O-` form only if that code is known, else dropped; a step inside a section headed by a lettered process (`T-050-050`) is filed under that process when its code extends it; process names stop at markup. The current graph has 2,376 nodes and 4,752 edges.
   - Builds are byte-identical across hash seeds (enforced by a test).
   - The canvas shows nodes by type, an NL query highlights paths, and there are 5 presets.
   - The Cypher view generates queries with `claude-opus-5` using structured output, checks them with EXPLAIN in a read-only transaction (up to 3 attempts), and rejects writes.
   - Graph quality: 15 structural checks plus a 28-question check.
8. **Guardrails** (all agents, §05 §1):
   - Policy text is appended to every agent system prompt.
   - A Haiku scope classifier refuses off-scope questions.
   - Web search is gated: Sonnet with `web_search_20250305`, sap.com and europa.eu only, at most 2 searches.
   - Phone numbers and e-mail addresses are redacted, both in the ASGI middleware and before every store write and export.
9. **Coverage, Doc vs MD, MD Viewer, RAG Metrics**: inspection and analytics pages (§06 §3). RAG Metrics and the `/api/quality*` endpoints, and Evidence memory reflect, are Admin-only.
10. **Admin dashboard** (`/admin`; §02 §4m, §06 §3.15): KPI strip (runs, active accounts, tokens, estimated LLM cost), then Usage (runs per day, by account), Run history (open any run in its tool), Users (create, change role, activate/deactivate, reset password), Activity log, and a User × tool matrix (runs, tokens, run time or cost). Cost is an over-estimate at hard-coded list prices from `backend/core/pricing.py` (cache reads at the full input rate; scope guard, judges, memory and embeddings not counted); an unlisted model is reported as unpriced.

### 9.2 API
[F] There are 126 routes in total, plus 1 static mount (`/assets`):
- 106 in `app.py` (24 of them SPA pages, including `/admin`)
- 10 in `backend/auth/routes.py`: login, logout and session under `/api/auth`, with `/api/app` and `/api/demo` as aliases, plus `POST /api/auth/password`
- 1 in `app_login.py` (`/login`)
- 3 Demo Mode routes (`/demo/login`, `/demo`, `/demo/{rest:path}`)
- 6 Admin routes under `/api/admin` (`users` GET/POST, `users/{uid}` PATCH, `usage`, `activity`, `runs`)

The route groups are:
- SPA pages
- `/api/auth*`, `/api/admin*`
- `/api/convert*`, `/api/preview*`
- `/api/graph*` and `/api/neo4j*`
- `/api/kb*`, `/api/coverage`
- `/api/batch*`
- `/api/ask*`, `/api/quality*`
- `/api/fitgap*`, `/api/uploads*`, `/api/rollout*`, `/api/evidence*`
- `/api/health`

The full method/path/body/response/side-effect table is in **§02 §4**. The matching client functions are in **§06 §4**.

### 9.3 UI
[F] There are 13 tabs defined, in 5 colour groups. An Admin sees 12 tabs plus an **Admin** button beside the account menu; a User sees 11 (no RAG Metrics) and no Admin button:

| Group | Tabs (path) |
|---|---|
| engine | Ask RAG `/ask`, RAG Metrics `/quality` (Admin only), Spine `/graph`, Agent `/evidence`, InsightLens `/fit-gap`, Fit-Gap Copilot `/rollout` |
| convert | Convert `/convert`, Batch Convert `/batch` |
| index | Add to knowledge base `/add-kb` |
| inspect | Coverage `/coverage`, Doc vs MD `/review`, MD Viewer `/md-viewer` |
| admin | Admin `/admin` (Admin only; a header button, never in the tab bar) |

There is also a landing page at `/`. The account menu shows the username and role, the Admin's "my runs / everyone's runs" history switch, Change password and Sign out. A 401 from any `/api/*` call sends the browser to the sign-in page with `next`. Every page stays mounted, so state survives tab switches. Light theme plus a dark Catppuccin Frappé theme (`localStorage.theme`).

Demo Mode at `/demo` uses the same accounts and cookie. It shows only Spine and Fit-Gap Copilot as tabs, with Ask RAG and Agent in a sidebar, and the Admin page at `/demo/admin` for Admins. It hides model names, and Copilot downloads are marked `client=1`.

---

## 10. Testing and validation

### 10.1 Existing suites (detail in §06 §8)
- **Backend:** 23 self-running scripts with 592 tests (`test_auth` and `test_ownership` are new; `test_demo_mode` was removed):
  `for f in backend/tests/test_*.py; do .venv/bin/python "$f" || echo FAIL $f; done`
  - None of them need a live Anthropic key or Ollama; those are stubbed.
  - The Postgres tests (including `test_auth` and `test_ownership`) need `DATABASE_URL` and a role with CREATEDB; they create and drop `docling_test_*` databases.
  - The live part of `test_neo4j` skips when Neo4j is absent.
  - `test_evidence`, `test_knowledge_graph` and `test_graph_determinism` need the real corpus.
- **Frontend:** 13 static source-consistency checks (`rollout-tabs` and `rollout-timing` are new): `cd frontend && for f in test/*.mjs; do node "$f"; done`.
  `quote-highlight.fixture.json` is empty in git; regenerate it first with `.venv/bin/python frontend/test/quote-highlight-fixture.py`.
- **Load tests:** Locust in `loadtest/` (own venv `.venv-loadtest`). They sign in only as `loadtest-*` accounts, refuse any host outside `LOADTEST_ALLOWED_HOSTS` (default `localhost,127.0.0.1`), and make no Claude calls unless `LOADTEST_LLM=1` (Ask, Evidence) or `LOADTEST_HEAVY=1` (InsightLens, Copilot). `loadtest/mock_anthropic.py` stands in for Claude for a cost-free Ask test. Detail in §06 §8.4.
- [F] There is no CI configuration, pytest config or npm test script.

**These suites were not executed while this spec was written, so their current pass/fail state is unverified.**

### 10.2 Equivalence criteria for a rebuild
A rebuilt system is functionally equivalent when all of the following hold:
1. **Contract tests port and pass.** Port the backend tests' assertions; they encode the exact contracts: BPML round-trip, txt/csv passthrough, BM25 per-category statistics, recategorisation atomicity, judge arithmetic, Evidence scoring, Copilot scoring, gates, cut-off refusal and amend merging (115 tests), graph determinism and cleanup rules, guardrail behaviour, account gating, session revocation, and run, conversion and decision ownership.
2. **Deterministic outputs match.** Run these on the same corpus:
   - the graph JSON is byte-identical to `data/knowledge_graph.json`
   - for each chunk, the chunker output has the same text, heading path and token count
   - BM25 rankings and RRF fusion order are identical for a fixed query set
   - Copilot `scoring.score()` gives identical results for a fixed analysis JSON; the same holds for Evidence `finalise()` and InsightLens synthesis
3. **Behaviour under LLM variance matches** (outputs differ from run to run):
   - For the 27 questions in `frontend/src/data/evalQuestions.ts` / `docs/three-engine-eval-questions.md`, Ask answers cite valid `[n]` sources.
   - Ragas overall score stays within the original's range, using the 27 hand-checked experiment answers as the baseline.
   - The Evidence Agent's quotes all pass verbatim verification.
   - Copilot runs pass the hard quality gates, using `docs/spark-fitgap-eval-golden-set.xlsx` as the reference.
4. **API surface matches.** Every route in §02 §4 exists with the same method, path, SSE event names and response field names, because the frontend depends on them.
5. **The UI acceptance checklist passes:** all 29 items in §06 §9.
6. **Operational checks pass:**
   - `/api/health` reports the binaries.
   - A fresh database with `ADMIN_USERNAME`/`ADMIN_PASSWORD` set starts with that Admin and the `legacy` account; a dump from before accounts restores with its runs owned by `legacy`. A too-short `ADMIN_PASSWORD` or `ADMIN_USERNAME=legacy` logs a WARNING, creates no Admin and the app still starts.
   - The container passes its HEALTHCHECK.
   - `pg_restore` of a dump from the original works against the rebuilt schema, which proves schema compatibility.

---

## 11. Reconstruction gaps

### 11.1 Not determinable from the repository
| Gap | What is needed |
|---|---|
| **Corpus** (`solvay-spark/`, `knowledge_base/`): client documents, git-ignored | The source documents themselves, or a `pg_dump` plus the `data/knowledge_graph.json` built from them. Without them, the graph, the eval baselines and several tests cannot be reproduced |
| Secret values; real server hostname, TLS and reverse-proxy configuration | Operator input |
| How `ivolve-network` is created; registry access | Infrastructure owner |
| Unpinned versions: `ollama/ollama:latest`, the APOC plugin downloaded at first start, the Neo4j 5.x minor version | Pin them at rebuild time |
| Homebrew Postgres on port 5433 | Manual configuration; any port works if `DATABASE_URL` matches |
| Model availability: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `gpt-5`; NL→Cypher uses beta `server-side-fallback-2026-07-01` and adaptive thinking | A provider account with access, or substitutes. Outputs will differ |
| Docling pipeline options are never set, so behaviour is Docling 2.130's defaults (OCR engine, TableFormer mode) | Keep docling 2.130.0 exactly for identical Markdown |
| Resource sizing (CPU/RAM) for the app container | Not specified; only Neo4j memory is set |
| CI/CD pipeline | None exists; builds are manual |
| The writer of `.workdir/app.log` | Unknown; probably an earlier script |
| Exact visual layout and copy text of the largest components (graph canvas, rollout views) | Read `frontend/src` directly or use the `docs/demo-video/captures/*.png` screenshots |
| Purpose of `docs/spark-fitgap-eval-golden-set.xlsx` | [I] Golden set for Copilot/InsightLens evaluation; not opened |
| Current model list prices | `backend/core/pricing.py` hard-codes USD per million tokens; check them against the provider's price list when rebuilding |
| The real accounts and their roles | Live data in the `users` table; not in git. A rebuild starts with one Admin from `ADMIN_USERNAME`/`ADMIN_PASSWORD` |
| Load-test results | The tests were not run for this spec; the 40-thread limit and run times are as stated in `loadtest/README.md` |

### 11.2 Present in the design but not implemented
- [F] InsightLens eval harness E1–E4 (`docs/insightlens-handover.md`) does not exist. `asis_dir` is accepted but never read.
- [F] Hindsight memory is wired into the Evidence Agent only. [I] Extending it to all agents is planned.
- [F] `data/spark_target_model.json` (15 labels, 25 relationship types) is not referenced by any code. [I] It is a planned target schema.
- [F] Expired upload sessions have no timed cleanup, and `.workdir/` is never garbage-collected.

### 11.3 Documentation that disagrees with the code (rebuild against the code)
- `docs/rag.md` and the `rag.py` docstring describe Cohere `embed-v4.0` at 1536 dimensions. The code uses Ollama `bge-m3` at 1024. The doc shows `ef_search` 200; the code uses 800.
- `docs/technical-architecture.md` says Hindsight is not in compose and uses old service names. It also says run.sh starts Vite, which it does not.
- `docs/conversion.md` says `folder_to_md` skips .doc/.ppt/.xls and is top-level only. The code includes them and has `-r`. Separately, `folder_to_md` omits .txt/.csv/.json/.msg/.eml even though the converter supports them.
- `compose.neo4j.yml` references a root-level `kg_neo4j_load.py`. The module is now `backend/graph/kg_neo4j_load.py` (run it as `python -m backend.graph.kg_neo4j_load`). Its container name `docling-neo4j` is local-only; the server stack uses `solvay-neo4j`.
- `fitgap/NOTES.md` relation names and the graph counts quoted in the docs are stale.
- Node: the README says 20+, the image uses 22, and the dev machine runs 24. Use 22.
- `docs/deployment.md:50` still says "change every sign-in value". The only sign-in values left are `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `AUTH_SECRET`; every other account is created in the app.
- The `backend/api/app.py` docstring (`:4-6`) still says "no auth". Every `/api/*` route except health and sign-in now needs a session.
- `APP_SECRET` and `APP_SESSION_HOURS` are still honoured as fallbacks for `AUTH_SECRET` and `AUTH_SESSION_HOURS` (`backend/auth/sessions.py:20-25`), though no doc mentions them. A rebuild can drop them unless it must keep sessions from an older installation.
- `docs/fitgap/NOTES.md` and `entity-relationships.md` quote graph counts (2,390 / 4,789 / 8,867, and older "6 systems") that differ from the current file (2,376 / 4,752 / 8,368, 17 systems).

### 11.4 Quirks a faithful rebuild should reproduce or deliberately change
- Batch convert defaults to the `claude` vision provider; single convert defaults to `qwen`.
- The Qwen flow prompt asks for `flowchart TD`, while the CV and connector flows emit `flowchart LR`.
- On PDFs, only the first picture on a page receives the page render, so page text can appear twice.
- `md_chunker`'s title regex knows only pptx/docx/xlsx/pdf/png/jpg; other formats keep the raw stem as the title.
- The contact redactor works per streamed chunk, so an e-mail address split across two SSE chunks can leak [I].
- The template graph answerer says "integration route", which contradicts the Evidence Agent's rule that "co-membership is not integration".
- A dimension mismatch silently drops the whole corpus index.
- Someone else's run, upload session, conversion or batch answers 404, never 403, so a guessed id does not confirm that it exists. `POST /api/uploads` with someone else's session id silently starts a new session instead.
- Ask single-run deletion is not written to `activity_events` [I], while every other delete is.

### 11.5 Known risks found in the code
- [I] An unreachable database at start-up still stops the app: the lifespan calls `bootstrap_admin()` without catching connection errors (`backend/api/app.py:86`). A refused `ADMIN_USERNAME`/`ADMIN_PASSWORD` no longer does (§9.1).
- [I] The account cache is per process (30 s). With more than one process, a deactivated account or a changed role could still be honoured for up to 30 s elsewhere. Today there is one process.
- [F] `upload_sessions.user_id` has no foreign key, because `users` is in the main database and the sessions are in `<db>_session` (`backend/core/uploads.py:219-222`).
- [F] Any signed-in User can rebuild the graph, resync Neo4j and delete knowledge-base files; these are shared by design. Runs, upload sessions and conversions are owned; workshop decisions are shared organisational memory that records who decided each.
- [I] Copilot amend merges are not re-checked against the outline the model saw; schema validation and the quality gates are the only guard.
- [I] The graph quality check re-detects process mentions without the known-code list, so a passage that names a process only through an OCR-misread code (repaired at build time) counts as a miss in `graph_evidence_validity`.

---

## 12. Recommended reconstruction order (for an executing agent)

1. **Infrastructure.** Postgres 18 + pgvector, Ollama `bge-m3`, the system binaries, Python 3.12 venv with `requirements.txt -c constraints.txt`. Done when `import docling, tesserocr, cv2, ragas` succeeds.
2. **`backend/core`.** paths, then tracing as a no-op wrapper, then uploads (with the session owner column), then pricing.
3. **`backend/auth`** (§02 §3, §04 §2.10). It comes this early because every run store's `create_schema` calls `own_table`, which needs the `users` table and the `legacy` row: store (DDL, `legacy`, `bootstrap_admin`, `own_table`, `reassign_legacy`, CLI) → passwords → sessions → middleware → deps → routes. Port `test_auth` (the parts that need no app routes).
4. **`backend/ingestion`** (§03). Port `test_converter`, `test_formats`, `test_bpml_markdown`, `test_originals`.
5. **`backend/rag`.** Schema → index → search → answer → ask_store → evaluation → quality/coverage (§04). Port `test_rag`, `test_ask_store`, `test_evaluation`, `test_quality`, `test_coverage`, `test_category_durability`.
6. **`backend/graph`.** Extraction, then Neo4j load, then NL→Cypher, then eval (§05 §6). Port `test_knowledge_graph`, `test_graph_determinism`, `test_graph_eval`, `test_neo4j`.
7. **`backend/agents`.** Guardrails → shared fitgap tools → Evidence → InsightLens → Copilot (gates, scoring, cut-off refusal, `amend_analysis`, exports) → agent_eval (§05). Every store takes an `owner`. Port `test_guardrails`, `test_evidence`, `test_fitgap`, `test_rollout`, `test_agent_eval`.
8. **`backend/api`.** All routes per §02 §4 with their ownership rules (§02 §3d), the `RequireUser` gate, `/login` and Demo Mode, the Admin API (`admin.py`), the lifespan (`bootstrap_admin`, `_ensure_run_tables`), the redaction middleware, and the SPA fallback. Port `test_app_login`, `test_auth`, `test_ownership`, `test_tracing`.
9. **Frontend.** Vite multi-page app per §06, including the account menu, session guard and Admin page. Port the `frontend/test/*.mjs` checks.
10. **Packaging.** Dockerfiles and compose per §01. Verify against §10.2. Optionally port the Locust load tests (§01 §7.8) and run them as `loadtest-*` accounts only.
