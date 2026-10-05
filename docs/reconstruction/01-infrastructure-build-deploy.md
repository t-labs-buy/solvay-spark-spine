# 01 — Infrastructure, Build, Configuration, Deployment

Scope: everything needed to build, configure, run and deploy Solvay Spark Spine AI.
Notation: **[F]** = FACT, cited `file:line` (paths relative to the repo root); **[I]** = INFERRED (reasoned from evidence, not stated).
Secrets: only variable *names* appear here. No values from `.env` were copied.
Current as of commit `1d37131` (2026-10-05) plus the uncommitted ownership and start-up fixes in the working tree. Line numbers are at that working tree.

---

## 0. One-paragraph picture

[F] There is one Python 3.12 FastAPI process (`backend.api.app:app`, port 8000). It serves the REST/SSE API and the pre-built React SPA from `static/dist/` (`backend/api/app.py:51-58,174-186,3459`). Every page and every `/api/*` route except a few sign-in/health routes needs a signed-in account; accounts are rows in the main Postgres database (`backend/auth/middleware.py:35-41,111-127`, `backend/auth/store.py:1-18`). It calls these services:
- PostgreSQL 18 + pgvector (`DATABASE_URL`)
- Ollama `bge-m3` embeddings (`OLLAMA_HOST`, default `http://127.0.0.1:11434`)
- Neo4j 5 Community + APOC (`NEO4J_URI`, default `bolt://127.0.0.1:7687`), optional
- the Hindsight memory server (`HINDSIGHT_URL`, default `http://127.0.0.1:8888`), optional
- the Anthropic Claude API
- Langfuse Cloud (optional)
- the OpenAI API (optional vision only)

[F] Local system binaries: LibreOffice (`soffice`), Poppler (`pdftoppm`), Tesseract, and Pango/Cairo/gdk-pixbuf for WeasyPrint (`Dockerfile:56-66`, `README.md:61-69`).

[F] Two deployment modes:
- **local dev on macOS:** `scripts/run.sh`, Homebrew Postgres on :5433, Ollama app, Neo4j via `compose.neo4j.yml` under Podman/Docker, Hindsight in `hindsight-venv`.
- **server:** `compose.yml` on the external Docker network `ivolve-network`, with images in `reg.ivolve.cloud/ivolve/*`.

---

## 1. Tech stack with versions

### 1.1 Runtimes
| Item | Version | Evidence |
|---|---|---|
| Python (app) | 3.12 (`python:3.12-slim-bookworm`); local venv is 3.12.13 | [F] `Dockerfile:21,35,50`; [F] `README.md:63` ("Python 3.12 … torch, tesserocr lag behind"); [F] `.venv/bin/python --version` → 3.12.13 |
| Python (Hindsight server) | 3.13 (`python:3.13-slim-bookworm`); local `uv venv --python 3.13 hindsight-venv` | [F] `Dockerfile.hindsight:14,21`; [F] `docs/running-the-app.md:43` |
| Node (UI build) | `node:22-slim` in the image. README says "Node.js 20+". The dev machine has v24.15.0 | [F] `Dockerfile:10`; [F] `README.md:69`; [F] `node --version` |
| PyTorch | CPU-only `torch==2.14.0`, `torchvision==0.29.0`, from `https://download.pytorch.org/whl/cpu` | [F] `Dockerfile:22,29-30,40,43-44`; Hindsight: `torch==2.14.0` only, `Dockerfile.hindsight:24,33` |
| PostgreSQL | 18 + pgvector (`pgvector/pgvector:pg18`; locally `brew install postgresql@18`, which "ships pgvector") | [F] `compose.yml:57`; [F] `docs/running-the-app.md:32` |
| Neo4j | `neo4j:5-community` + APOC plugin | [F] `compose.yml:146,150`; `compose.neo4j.yml:12,21` |
| Ollama | `ollama/ollama:latest` (unpinned); model `bge-m3` (1024-d) | [F] `compose.yml:126,138`; `.env.example:22-23` |
| Hindsight server | `hindsight-api==0.10.1` (build arg `HINDSIGHT_VERSION`) | [F] `Dockerfile.hindsight:23,34` |
| Hindsight client | `hindsight-client==0.10.1` | [F] `constraints.txt:60` |
| Locust (load tests only) | `locust>=2.32`, unpinned, in its own venv `.venv-loadtest` because Locust brings gevent, which `constraints.txt` was never resolved against. Not in the image | [F] `loadtest/requirements.txt:1-3`; `loadtest/README.md:36-37`; `.gitignore:22-23` |

### 1.2 Python direct dependencies (`requirements.txt`, unpinned) with the pins from `constraints.txt`
`requirements.txt` is unpinned for local dev. The Docker build installs it with `-c constraints.txt` to fix exact versions (`constraints.txt:1-11`, `Dockerfile:46-47`). torch/torchvision are deliberately left out of constraints because the CPU index adds a `+cpu` suffix (`constraints.txt:6-7`).

| requirements.txt line | Pinned (constraints) | Why it is needed (FACT from comment/usage) |
|---|---|---|
| `docling[tesserocr]` (1) | docling 2.130.0, docling-core 2.99.0, docling-ibm-models 4.0.3, docling-parse 7.22.0, docling-slim 2.130.0, tesserocr 2.11.0 | Document → Markdown conversion (layout, tables); Tesseract OCR binding. `pptx_ocr.py` imports `tesserocr` (`backend/ingestion/pptx_ocr.py:35-36`) |
| `fastapi` (2) | 0.141.1 (starlette 1.7.0) | HTTP API |
| `uvicorn[standard]` (3) | 0.54.0 (uvloop 0.22.1, httptools 0.8.0, watchfiles 1.3.0, websockets 16.1.1) | ASGI server; `--reload` uses watchfiles |
| `python-multipart` (4) | 0.0.32 | `UploadFile` form uploads |
| `opencv-python` (6) | 5.0.0.93 | `table_cv` / `flow_cv` (`requirements.txt:5`) |
| `numpy` (7) | 2.5.2 | CV + vector math (`rag.py` imports numpy) |
| `python-dotenv` (9) | 1.2.3 | Loads `ROOT/.env` with `override=False` (`backend/rag/rag.py:64`, `backend/core/tracing.py:57`, `backend/ingestion/vlm_api.py:39`, `backend/rag/evaluation.py:94`, `backend/rag/consolidate.py:52`) |
| `cohere` (11) | 7.1.1 | **Unused leftover**: embeddings moved to Ollama bge-m3 (`docs/technical-architecture.md:57`; `docs/ARCHITECTURE-CONTEXT.md:122-123`) |
| `psycopg[binary]` (12) | psycopg 3.3.6 + psycopg-binary 3.3.6 | Postgres driver |
| `pgvector` (13) | 0.5.0 | pgvector adapter for psycopg |
| `anthropic` (14) | 1.8.0 (uses httpx2 2.13.1 per `scripts/hindsight.sh:36-38`) | Claude Messages API: answers, agents, Cypher, scope guard, web search |
| `openpyxl` (18) | 3.1.5 | BPML XLSX reader, fit-gap XLSX export (`requirements.txt:15-17`) |
| `pydantic` (19) | 2.13.5 (pydantic_core 2.46.5, pydantic-settings 2.15.0) | Schemas |
| `langfuse` (24) | 4.15.6 | Optional tracing. It is inert without both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (`backend/core/tracing.py:64`) |
| `opentelemetry-instrumentation-anthropic` (25) | 0.62.3 | Records every Claude call into Langfuse |
| `opentelemetry-instrumentation-threading` (26) | 0.66b0 | Propagates trace context into worker threads |
| `hindsight-client` (33) | 0.10.1 | Client for agent memory. The server is in its own env because `hindsight-api` pulls about 115 packages and downgrades Docling's transformers/tokenizers (`requirements.txt:28-32`) |
| `ragas` (46) | 0.4.3 (instructor 1.3.2, langchain 1.4.2, langchain-core 1.6.5, langchain-openai 1.1.9, openai 1.109.1, datasets 5.0.1) | Ask-RAG answer scoring; Claude is the judge, via Ragas' instructor adapter (`requirements.txt:35-41`) |
| `langchain-community<0.4` (47) | 0.3.31 | **Required pin**: Ragas 0.4.3 imports `langchain_community.chat_models.vertexai`, which 0.4.0 removed (`requirements.txt:42-45`) |
| `weasyprint` (55) | 70.0 (pydyf 0.12.1, tinycss2 1.5.1, cssselect2 0.10.1, pyphen 0.18.1) | Workshop pack HTML→PDF in `rollout/pdf.py`. Needs system pango/cairo/gdk-pixbuf; without them the page falls back to Markdown (`requirements.txt:49-55`) |
| `python-docx` (58) | 1.2.0 | Workshop outcome export as Word |
| `neo4j>=5.20` (60) | 6.3.1 | Bolt driver for the Neo4j copy of the graph |

Other notable transitive pins:
- transformers 5.17.0, tokenizers 0.23.2, huggingface_hub 1.33.0, accelerate 1.15.0
- rapidocr 3.9.2, pypdfium2 5.13.0, pillow 12.3.0
- python-pptx 1.0.2, pandas 3.0.6, scipy 1.18.1, SQLAlchemy 2.1.1
- httpx 0.28.1, markdown-it-py 4.2.0, semchunk 3.2.5, tiktoken 0.14.0
- opentelemetry-sdk 1.45.0, langgraph 1.2.12
- protobuf 7.36.2, lxml 6.1.3

[F] The full list is in `constraints.txt:12-210` (199 pins).

[F] **Optional, not in requirements:** `mlx-vlm` for the local vision model `mlx-community/Qwen3-VL-8B-Instruct-4bit` on Apple silicon (`backend/ingestion/vlm_ocr.py:39,119,129`; `docs/technical-architecture.md:53`). It is not available in the container (`docs/deployment.md:19`).

### 1.3 Frontend (npm) — `frontend/package.json`
[F] Package metadata: name `solvay-spark-spine`, private, `"type": "module"`, version 1.0.0 (`frontend/package.json:1-5`).

[F] Scripts (`frontend/package.json:7-9`):
- `dev` = `vite`
- `build` = `tsc --noEmit && vite build`
- `typecheck` = `tsc --noEmit`

[F] The table below gives each declared range and the version actually installed, read from `frontend/node_modules/.package-lock.json`.

| Package | Declared | Installed | Role |
|---|---|---|---|
| react / react-dom | ^19.3.0 | 19.3.0 | UI |
| @mui/material | ^9.4.0 | 9.4.0 | Components |
| @emotion/react / @emotion/styled | ^11.14.0 / ^11.14.1 | 11.14.0 / 11.14.1 | MUI styling engine |
| d3 / @types/d3 | ^7.9.0 / ^7.4.3 | 7.9.0 / 7.4.3 | Graph canvas, charts |
| mermaid | **10.9.1 (exact)** | 10.9.1 | Diagrams in Markdown |
| marked | ^12.0.2 | 12.0.2 | Markdown → HTML |
| dompurify | ^3.4.15 | 3.4.15 | Sanitising rendered Markdown |
| framer-motion | ^13.4.0 | 13.4.0 | Animation |
| lucide-react | ^1.46.0 | 1.46.0 | Icons |
| react-resizable-panels | ^4.12.4 | 4.12.4 | Draggable split panes |
| dev: typescript | **5.9** | 5.9.3 | Typecheck |
| dev: vite | ^8.3.0 | 8.3.0 | Bundler |
| dev: @vitejs/plugin-react | ^6.1.1 | 6.1.1 | React plugin |
| dev: @types/react, @types/react-dom | ^19.3.0 | 19.3.0 | Types |

[F] `frontend/package-lock.json` exists and is used by `npm ci` (`Dockerfile:12-13`).

[F] **Vite config** (`frontend/vite.config.ts:6-18`):
- plugins: `[react()]`
- `build.outDir: "../static/dist"`, `emptyOutDir: true`, `chunkSizeWarningLimit: 2000`
- three Rollup inputs: `main: index.html`, `demo: demo.html`, `login: login.html`
- dev server proxy: `/api` → `http://localhost:8000` with `changeOrigin: true`
- default Vite dev port 5173 (`README.md:97`, `docs/running-the-app.md:19`)

[F] **tsconfig** (`frontend/tsconfig.json`):
- target ES2022; lib ES2023, DOM, DOM.Iterable
- module ESNext, moduleResolution `bundler`, jsx `react-jsx`
- `strict`, `noUnusedLocals`, `noUnusedParameters`, `skipLibCheck`, `isolatedModules`, `noEmit`
- types `["vite/client"]`; include `src`, `vite.config.ts`

[F] **HTML entry points.** All three files share the same shell: `<div id="root">`, viewport meta, and a 📄 emoji SVG favicon as a data URI.

| File | `<title>` | Module script |
|---|---|---|
| `frontend/index.html` | "Spark AI Spine" | `/src/main.tsx` |
| `frontend/demo.html` | "Spark AI Spine — Demo" | `/src/demo/main.tsx` |
| `frontend/login.html` | "Spark AI Spine — Sign in" | `/src/login/main.tsx` |

[F] Frontend tests are plain Node scripts in `frontend/test/*.mjs`, run as `node test/<name>.mjs` (`frontend/test/pages-mount.mjs:3`):
- agent-memory, agent-trace, frappe-palette, pages-mount, quality-page, quote-highlight, rag-quality, rollout-export, rollout-steps, rollout-tabs, rollout-timing, run-history, surface-contrast
- `quote-highlight-fixture.py` builds a 4 MB fixture from Postgres; it is git-ignored (`.gitignore:13-15`)

### 1.4 System binaries / OS packages
| Binary / lib | Used by | Local install (macOS) | Container apt package |
|---|---|---|---|
| LibreOffice `soffice` | `backend/ingestion/preview.py`: renders the original document to PDF for the left preview pane. Discovery: `shutil.which("soffice")` or `which("libreoffice")`, then `/Applications/LibreOffice.app/Contents/MacOS/soffice`, `/usr/bin/soffice`, `/usr/local/bin/soffice` (`preview.py:20-22,35-36`). Settings: `CONVERT_TIMEOUT=300`s, `PREVIEW_DPI=90` (`preview.py:24-25`) | `brew install --cask libreoffice` | `libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress` (`Dockerfile:60`) |
| Poppler `pdftoppm` | Splits the PDF render into `page-N.png` (`preview.py:42-43`) | `brew install poppler` | `poppler-utils` (`Dockerfile:61`) |
| Tesseract + eng data | `pptx_ocr.py`, `table_cv.py`. The tessdata lookup order is: `TESSDATA_PREFIX`, `/opt/homebrew/share/tessdata`, `/usr/local/share/tessdata`, `/usr/share/tesseract-ocr/5/tessdata`, `/usr/share/tessdata` (`pptx_ocr.py:40-57`) | `brew install tesseract` | `tesseract-ocr tesseract-ocr-eng` (`Dockerfile:62`); build stage adds `libtesseract-dev libleptonica-dev` for compiling tesserocr (`Dockerfile:37`) |
| Pango / Cairo / gdk-pixbuf | WeasyPrint | `brew install pango cairo gdk-pixbuf` (`requirements.txt:52`) | `libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0` (`Dockerfile:63`) |
| libGL / glib / xcb | OpenCV, RapidOCR | — | `libgl1 libglib2.0-0 libxcb1` (`Dockerfile:26,64`) |
| Fonts | Rendering | — | `fonts-dejavu` (`Dockerfile:65`) |
| curl | HEALTHCHECK; `run.sh` probes | — | `curl` (`Dockerfile:65`, `Dockerfile.hindsight:29`) |
| `pg_dump` | `scripts/db-export.sh:14` | ships with postgresql@18 | not in image |
| `uv` | venv creation (`README.md:77-78`, `docs/running-the-app.md:43-44`) | assumed installed [I] | not in image |
| Podman or Docker (+compose plugin), optionally `buildx` | Neo4j locally; image build | `brew install podman; podman machine init` (`docs/running-the-app.md:35`) | — |
| ngrok | `scripts/ngrok.sh` | assumed installed [I] | — |
| Ollama | Embeddings | ollama.com app, then `ollama pull bge-m3` | `ollama/ollama` container |

---

## 2. Docker images

### 2.1 App image — `Dockerfile` (4 stages)
Header: one image holds the backend, the built UI, and LibreOffice/Poppler/Tesseract. Postgres, Ollama and Neo4j run beside it (`Dockerfile:1-5`).

**Stage `ui`**: `FROM --platform=$BUILDPLATFORM node:22-slim AS ui` (`Dockerfile:10`). It builds on the host's native platform because the output is platform-neutral (`:8-9`).
1. `WORKDIR /src/frontend`
2. `COPY frontend/package.json frontend/package-lock.json ./`, then `RUN npm ci`
3. `COPY frontend/ ./`, then `RUN npm run build` (tsc typecheck, then vite). Output lands in `/src/static/dist`, because outDir is `../static/dist`.

**Stage `models`**: `FROM --platform=$BUILDPLATFORM python:3.12-slim-bookworm AS models` (`:21`). Docling's model weights are fetched natively because torch under amd64 qemu emulation crashes (`:17-20`).
1. `ARG TORCH_VERSION=2.14.0 TORCHVISION_VERSION=0.29.0`
2. `ENV PIP_NO_CACHE_DIR=1 PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10`
3. apt: `libgl1 libglib2.0-0 libxcb1`. These are needed because the RapidOCR download imports cv2.
4. `COPY constraints.txt .`
5. `pip install --index-url https://download.pytorch.org/whl/cpu torch==… torchvision==…`, then `pip install -c constraints.txt docling`
6. `RUN docling-tools models download -o /opt/docling-models` (`:32`)

**Stage `deps`**: `FROM python:3.12-slim-bookworm AS deps` (`:35`). This stage runs on the target platform.
1. apt: `build-essential pkg-config libtesseract-dev libleptonica-dev`, so tesserocr compiles.
2. `python -m venv /opt/venv`
3. Same torch ARGs. `ENV PATH=/opt/venv/bin:$PATH` plus the same PIP_* variables.
4. Install CPU torch/torchvision first. The default Linux wheel is the multi-GB CUDA build (`:42-44`).
5. `COPY requirements.txt constraints.txt ./`, then `pip install -r requirements.txt -c constraints.txt` (`:46-47`)

**Final stage**: `FROM python:3.12-slim-bookworm` (`:50`).
- `ARG GIT_SHA=unknown`
- OCI labels (`:52-54`): `org.opencontainers.image.title="solvay-spark-spine"`, `description="Solvay Spark Spine AI"`, `revision="${GIT_SHA}"`
- apt runtime packages (`:59-66`): `libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils tesseract-ocr tesseract-ocr-eng libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libgl1 libglib2.0-0 libxcb1 fonts-dejavu curl`, installed with `--no-install-recommends`; the apt lists are removed afterwards
- `COPY --from=deps /opt/venv /opt/venv`
- `COPY --from=models /opt/docling-models /opt/docling-models`
- `ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 DOCLING_ARTIFACTS_PATH=/opt/docling-models` (`:70-72`). With this, the first conversion on the server downloads nothing.
- `RUN useradd --create-home --uid 1000 app`, then `WORKDIR /app`
- Copies: `backend/` → `backend/`, `docs/` → `docs/`, `data/` → `data/`, and `--from=ui /src/static/dist` → `static/dist/` (`:76-79`). `docs/` is needed at runtime because `evaluation.py` reads `docs/langfuse-rag-quality-dashboard.json` and `docs/three-engine-eval-questions.md` (`backend/rag/evaluation.py:870,913`).
- `RUN mkdir -p .workdir knowledge_base solvay-spark && chown -R app:app .workdir knowledge_base data` (`:81-82`)
- `USER app` (uid 1000)
- `EXPOSE 8000`
- `HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1` (`:86-87`)
- `CMD ["uvicorn","backend.api.app:app","--host","0.0.0.0","--port","8000","--proxy-headers","--forwarded-allow-ips","*"]` (`:88`)

Notes:
- There is no ENTRYPOINT.
- The image is about 3–4 GB (`docs/deployment.md:29`).
- An amd64 build on Apple silicon takes 20–40 minutes the first time (`scripts/docker-publish.sh:11-12`).
- `/api/health` returns `{"ok": true, "preview_available", "soffice": <path|null>, "pdftoppm": <path|null>}` (`backend/api/app.py:253-261`).

**`.dockerignore`** (`.dockerignore:1-22`) excludes:
- `.git/`, `.env`, `.env.*` (but re-includes `.env.example`)
- `.venv/`, `hindsight-venv/`, `.workdir/`, `knowledge_base/`, `solvay-spark/`, `backup/`, `out/`, `tmp/`
- `*.log`, `.DS_Store`, `__pycache__/`, `*.pyc`
- `frontend/node_modules/`, `frontend/test/quote-highlight.fixture.json`
- `static/dist/` (it is rebuilt in the `ui` stage)

### 2.2 Hindsight image — `Dockerfile.hindsight` (2 stages)
Purpose: the memory server, kept in its own image because `hindsight-api` conflicts with Docling's dependencies. It stores data in the stack's Postgres (database `hindsight`), not in the embedded pg0 used on a Mac (`Dockerfile.hindsight:1-9`).

**Stage `models`**: `FROM --platform=$BUILDPLATFORM python:3.13-slim-bookworm AS models` (`:14`).
- `ENV PIP_NO_CACHE_DIR=1 PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10 HF_HOME=/opt/hf`
- `pip install huggingface_hub`, then `snapshot_download('BAAI/bge-small-en-v1.5')` and `snapshot_download('cross-encoder/ms-marco-MiniLM-L-6-v2')` (`:16-18`). These are the in-process embedding and reranker models.

**Final stage**: `FROM python:3.13-slim-bookworm` (`:21`).
- `ARG GIT_SHA=unknown HINDSIGHT_VERSION=0.10.1 TORCH_VERSION=2.14.0`
- Labels: title `solvay-spark-spine-hindsight`, description "Hindsight memory server for Solvay Spark Spine AI", revision
- apt: `curl`; the same PIP_* variables
- `pip install --index-url …/whl/cpu torch==2.14.0`, then `pip install hindsight-api==0.10.1` (`:33-34`)
- `COPY --from=models /opt/hf /opt/hf`, then `chmod -R a+rX /opt/hf`, then `useradd --create-home --uid 1000 app`
- `ENV HF_HOME=/opt/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1` (`:39`)
- `USER app`
- `EXPOSE 8888`
- `HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 CMD curl -fsS http://127.0.0.1:8888/health || exit 1`
- `CMD ["hindsight-api","--host","0.0.0.0","--port","8888","--log-level","info"]` (`:45`)

---

## 3. Compose stacks

### 3.1 `compose.yml` (server stack)
[F] Global rules:
- `docker compose up -d` reads `.env` from the same directory (`compose.yml:5-7`).
- Every service joins the **external** network `ivolve-network`, which is shared with other teams (`:9-15,175-180`).
- Every service that is called by name has a `solvay-` prefix, to avoid DNS clashes such as another stack's `postgres`.
- There are no explicit `container_name`s. The app's container is therefore `solvay-spark-spine-app-1`, and the reverse proxy reaches it by that name (`:44-45`). [I] The compose project name is the directory name, `solvay-spark-spine`. The deployment doc creates `~/solvay-spark-spine` (`docs/deployment.md:44`).

| Service | Image | Ports | Volumes | Env | depends_on | Healthcheck | restart |
|---|---|---|---|---|---|---|---|
| `app` (`:18-54`) | `reg.ivolve.cloud/ivolve/solvay-spark-spine:${TAG:-latest}` | `"${APP_PORT:-8000}:8000"`, the only published port | `workdir:/app/.workdir`; `graph-data:/app/data` (seeded from the image on first start); `./solvay-spark:/app/solvay-spark:ro`; `./knowledge_base:/app/knowledge_base` (rw; host folder must be writable by uid 1000) | `env_file: .env`, plus overrides: `DATABASE_URL=postgresql://spark:${POSTGRES_PASSWORD:?…}@solvay-postgres:5432/solvay`, `OLLAMA_HOST=http://solvay-ollama:11434`, `NEO4J_URI=bolt://solvay-neo4j:7687`, `HINDSIGHT_URL=http://solvay-hindsight:8888` (setting it empty turns memory off) | solvay-postgres: healthy; solvay-ollama: started; solvay-neo4j: healthy | from the image (`/api/health`) | unless-stopped |
| `solvay-postgres` (`:56-74`) | `docker.io/pgvector/pgvector:pg18` | none | `pgdata:/var/lib/postgresql` (pg18 keeps data under `/var/lib/postgresql/<major>/`) | `POSTGRES_USER=spark` (a superuser, because the app runs `CREATE EXTENSION vector` and creates the `solvay_session` DB), `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?}`, `POSTGRES_DB=solvay` | — | `pg_isready -U spark -d solvay`, every 10s, timeout 5s, 10 retries | unless-stopped |
| `solvay-hindsight-db` (`:79-101`) one-shot | `pgvector/pgvector:pg18` | — | — | `PGHOST=solvay-postgres PGUSER=spark PGPASSWORD=${POSTGRES_PASSWORD}` | solvay-postgres: healthy | — | `"no"` |
| `solvay-hindsight` (`:106-123`) | `reg.ivolve.cloud/ivolve/solvay-spark-spine-hindsight:${HINDSIGHT_TAG:-latest}` | none (port 8888 is internal) | — | `HINDSIGHT_API_DATABASE_URL=postgresql://spark:${POSTGRES_PASSWORD}@solvay-postgres:5432/hindsight`, `HINDSIGHT_API_LLM_PROVIDER=litellm`, `HINDSIGHT_API_LLM_MODEL=${HINDSIGHT_MODEL:-anthropic/claude-opus-5}`, `HINDSIGHT_API_LLM_API_KEY=${ANTHROPIC_API_KEY:?}`, `HINDSIGHT_API_REFLECT_LLM_MODEL=${HINDSIGHT_REFLECT_MODEL:-anthropic/claude-sonnet-5}`, `HINDSIGHT_API_REFLECT_LLM_TIMEOUT=${HINDSIGHT_REFLECT_TIMEOUT:-60}`, `HINDSIGHT_API_EMBEDDINGS_PROVIDER=local` | solvay-hindsight-db: completed_successfully | from the image (`/health`) | unless-stopped |
| `solvay-ollama` (`:125-131`) | `docker.io/ollama/ollama:latest` | none (11434 internal) | `ollama:/root/.ollama` | — | — | none | unless-stopped |
| `solvay-ollama-pull` (`:134-143`) one-shot | `ollama/ollama:latest` | — | — | `OLLAMA_HOST=http://solvay-ollama:11434`; entrypoint `["ollama","pull","bge-m3"]` | solvay-ollama | — | `"no"` |
| `solvay-neo4j` (`:145-164`) | `docker.io/library/neo4j:5-community` | none (7474/7687 internal) | `neo4j-data:/data` | `NEO4J_AUTH=neo4j/${NEO4J_PASSWORD:?}`, `NEO4J_PLUGINS='["apoc"]'`, heap initial/max `512m`, pagecache `256m`, `NEO4J_db_tx__log_rotation_retention__policy=100M size`, `NEO4J_db_tx__log_rotation_size=32M` | — | `wget -qO- http://localhost:7474`, every 10s, timeout 5s, 20 retries | unless-stopped |

[F] The `solvay-hindsight-db` entrypoint script (`compose.yml:87-95`):
1. Retry `psql -d solvay -tAc "select 1"` up to 30 times, 2s apart. A new Postgres can report healthy while its first-start setup still refuses TCP.
2. If `select 1 from pg_database where datname='hindsight'` returns nothing, run `createdb hindsight`.

[F] Named volumes: `workdir`, `graph-data`, `pgdata`, `ollama`, `neo4j-data` (`compose.yml:168-173`). They are named by key so that renaming a service keeps its data (for example `solvay-spark-spine_pgdata`).

[F] Required compose interpolation variables: `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY`, `NEO4J_PASSWORD`, each written as `:?`, so compose fails if one is missing. Optional: `TAG`, `APP_PORT`, `HINDSIGHT_TAG`, `HINDSIGHT_MODEL`, `HINDSIGHT_REFLECT_MODEL`, `HINDSIGHT_REFLECT_TIMEOUT`.

### 3.2 `compose.neo4j.yml` (local dev, Neo4j only)
[F] Single service `neo4j` (`compose.neo4j.yml:10-41`):
- image `docker.io/library/neo4j:5-community`
- **`container_name: docling-neo4j`**
- restart `unless-stopped`
- ports `127.0.0.1:7474:7474` (Browser) and `127.0.0.1:7687:7687` (Bolt), loopback only
- env: the same AUTH, APOC, memory and tx-log settings as the server stack. Comments: memory is sized for a 2 GB VM, and the graph is about 11k nodes / 21k relationships.
- volume `neo4j-data:/data`
- healthcheck: `wget` on 7474, 10s interval, **30 retries**

There is no network declaration, so it uses the default network. The header refers to loading via `.venv/bin/python kg_neo4j_load.py`; the module is now `backend/graph/kg_neo4j_load.py`, and [I] would be run as `python -m backend.graph.kg_neo4j_load`.

---

## 4. Local development run procedure (`scripts/run.sh`)

### 4.1 Prerequisites, done once
These come from `README.md:59-98` and `docs/running-the-app.md:30-52`.
1. `uv venv --python 3.12 .venv`, then `VIRTUAL_ENV=.venv uv pip install -r requirements.txt` (unpinned).
2. `brew install postgresql@18`, then set `DATABASE_URL` in `.env`. The README example is `postgresql://user:password@localhost:5433/docling`, so local Postgres listens on **5433** with database **`docling`**.
3. Install Ollama, then `ollama pull bge-m3`.
4. Optional: Podman (`brew install podman && podman machine init`) or Docker Desktop, and `NEO4J_PASSWORD=` in `.env`.
5. Optional: Hindsight: `uv venv --python 3.13 hindsight-venv && uv pip install --python hindsight-venv/bin/python hindsight-api`.
6. Frontend: `cd frontend && npm install && npm run build`. Alternatively `npm run dev` gives :5173 with the API proxied to :8000.

### 4.2 Every boot
1. `brew services start postgresql@18`
2. `ollama serve &`
3. `./scripts/run.sh` (`README.md:102-106`)

### 4.3 What `scripts/run.sh` does, in order
The script runs under bash with `set -euo pipefail` and `cd`s to the repo root first (`run.sh:4-6`).

1. **Hindsight** (`:13-24`):
   - If `HINDSIGHT_URL` is set and empty, print "memory is off" and do not start it.
   - Else, if `curl -sf -m 2 http://127.0.0.1:8888/health` succeeds, it is already running.
   - Else, if `./hindsight-venv/bin/hindsight-api` is executable and `./scripts/hindsight.sh` exists, run `nohup sh ./scripts/hindsight.sh >> hindsight.log 2>&1 &` in the background. It keeps running after run.sh exits, and the UI does not wait for it; the page re-checks every 30s.
   - Otherwise print "not installed".
2. **Neo4j** (`:30-44`):
   - If `curl -sf -m 2 http://127.0.0.1:7474` succeeds, it is already running.
   - Else, if `.env` has no non-empty line `^NEO4J_PASSWORD=.`, Cypher is off.
   - Else, if `docker` exists, `start_podman_machine` runs: when `podman` exists and `podman info` fails, it runs `podman machine start`. Then `docker compose -f compose.neo4j.yml up -d`.
   - If that fails, print a warning and continue.
3. **Backend** (`:46`): `exec .venv/bin/uvicorn backend.api.app:app --port "${PORT:-8000}" --reload --reload-dir backend`. It binds 127.0.0.1, uvicorn's default.

[F] App lifespan at startup (`backend/api/app.py:74-97`), in order:
1. `print(tracing.start())`, which logs whether Langfuse is on.
2. `print(auth_store.bootstrap_admin())` (`app.py:86`). It creates the `users` and `activity_events` tables and the `legacy` account. If there is no active Admin and both `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set, it creates that Admin, or, if the username already exists, makes it an active Admin with that password and bumps its `session_version`. With no active Admin and either variable unset, it logs `auth: WARNING -- there is no active Admin account…` and the app still starts. A refused setting also only logs a line and the app starts: an `ADMIN_PASSWORD` under 8 characters gives `auth: WARNING -- ADMIN_PASSWORD was not used: … No Admin account was created.`, and an `ADMIN_USERNAME` that is empty, contains spaces or `|`, is over 64 characters or is the reserved `legacy` gives `auth: WARNING -- ADMIN_USERNAME was not used: … No Admin account was created.` Both checks run before the existing-account lookup, so re-enabling an existing account is also refused for a short password, and `ADMIN_USERNAME=legacy` can never turn the built-in `legacy` account into an Admin (`backend/auth/store.py:297-335`).
3. `_ensure_run_tables()`: brings the ask, evidence, fitgap and rollout run tables up to date (owner column, hand-over of older runs to `legacy`). A failure is printed, not fatal (`app.py:215-226`).
4. `kg_neo4j_load.sync_in_background()`: a daemon thread loads `data/knowledge_graph.json` into Neo4j, retries for up to 120s while Neo4j starts, and gives up quietly if it is not configured (`backend/graph/kg_neo4j_load.py:249-261`).

[F] App lifespan at shutdown: `tracing.shutdown()` and `agent_memory.close()` (`app.py:99-105`).

[F] Stopping (`docs/running-the-app.md:54-62`). Ctrl+C stops only uvicorn. Stop the rest with:
- `docker compose -f compose.neo4j.yml down`
- `pkill -f hindsight-api` (memories stay in `~/.pg0`)
- `podman machine stop`
- `brew services stop postgresql@18`

### 4.4 `scripts/hindsight.sh` (local memory server)
1. POSIX `sh` with `set -e`, run from the repo root (`:18-20`).
2. Reads `ANTHROPIC_API_KEY` from `.env` with `sed`, strips quotes, and exports it. It exits 1 if the key is missing (`:23-30`).
3. Exports:
   - `HINDSIGHT_API_LLM_PROVIDER=litellm`
   - `HINDSIGHT_API_LLM_MODEL=${HINDSIGHT_MODEL:-anthropic/claude-opus-5}`
   - `HINDSIGHT_API_LLM_API_KEY=$ANTHROPIC_API_KEY`
   - `HINDSIGHT_API_REFLECT_LLM_MODEL=${HINDSIGHT_REFLECT_MODEL:-anthropic/claude-sonnet-5}`
   - `HINDSIGHT_API_REFLECT_LLM_TIMEOUT=${HINDSIGHT_REFLECT_TIMEOUT:-60}`
   - `HINDSIGHT_API_EMBEDDINGS_PROVIDER=local` (`:47-71`)
4. `exec ./hindsight-venv/bin/hindsight-api --host 127.0.0.1 --port 8888 --log-level info` (`:75`).

Why LiteLLM (`:32-46`):
- Hindsight's own `anthropic` provider breaks because anthropic 1.x uses httpx2.
- The `openai` provider against Anthropic's OpenAI-compatible endpoint fails: it returns 400 on `response_format: json_object`.

Why a separate reflect model: reflect is interactive, each call has a 30s per-call deadline, and Opus times out (`:51-67`).

Storage: embedded pg0 at `~/.pg0` (`docs/running-the-app.md:59`).

### 4.5 Port map
| Port | Service | Local | Compose |
|---|---|---|---|
| 8000 | FastAPI app + SPA | 127.0.0.1 (uvicorn default), override with `PORT` | 0.0.0.0 inside the container, published as `${APP_PORT:-8000}` |
| 5173 | Vite dev server | `npm run dev` | — |
| 5433 | Postgres (local Homebrew) | per README `.env` example | — |
| 5432 | Postgres | — | internal `solvay-postgres:5432` |
| 11434 | Ollama | 127.0.0.1 | internal `solvay-ollama:11434` |
| 7474 / 7687 | Neo4j HTTP / Bolt | 127.0.0.1 via `compose.neo4j.yml` | internal `solvay-neo4j` |
| 8888 | Hindsight | 127.0.0.1 | internal `solvay-hindsight:8888` |

---

## 5. Environment variables (complete)

[F] **Loading.** `python-dotenv` loads `ROOT/.env` with `override=False`, so real environment variables win. This happens at import in:
- `backend/rag/rag.py:64`
- `backend/core/tracing.py:57`
- `backend/ingestion/vlm_api.py:39`
- `backend/rag/evaluation.py:94`
- `backend/rag/consolidate.py:52`
- `backend/auth/store.py:430`, only when the module runs as the account CLI (`__main__`)

[F] `kg_neo4j_load.py:44` imports `rag` specifically so that `.env` is loaded before `NEO4J_*` are read.

[I] Modules that read `os.environ` at import, such as guardrails, agents and memory, depend on `.env` having been loaded first by an earlier import (`rag`/`tracing`). A rebuild should call `load_dotenv` once at the very start of the app.

### 5.1 Read by the backend (`os.environ.get`)
| Variable | Default | file:line | Purpose |
|---|---|---|---|
| `DATABASE_URL` | none (required; exits with "DATABASE_URL is not set") | `backend/rag/rag.py:259-261`; `backend/rag/consolidate.py:92`; checked in `backend/api/app.py:1146,1480,1631` | Main Postgres DB. The session DB is derived as `<db>_session`, for example `docling_session` or `solvay_session` (`rag.py:265-277`, `ensure_sibling` at `:328-343` creates it through the `/postgres` maintenance DB). If the URL has no path, the base defaults to `docling` |
| `ANTHROPIC_API_KEY` | none | `backend/agents/rollout/agent.py:332`; `backend/rag/evaluation.py:247`; `backend/api/app.py:1630,1915,2482,2874`; `vlm_api.py` claude provider `key_env`; also read implicitly by the `anthropic` SDK [I] | All Claude calls |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | `backend/rag/rag.py:66` | Embeddings (`/api/embed`, falling back to `/api/embeddings` per ARCHITECTURE-CONTEXT §5.2) |
| `RAG_EMBED_MODEL` | `bge-m3` | `rag.py:67` | Ollama embedding model |
| `RAG_EMBED_DIMENSION` | `1024` | `rag.py:68`; `backend/rag/consolidate.py:64` | Vector dimension. If it changes, the table is rebuilt |
| `RAG_ANSWER_MODEL` | `claude-opus-5` | `rag.py:69`; also the fallback for the agents (below) | Ask-RAG answer model |
| `RAG_EMBED_BATCH` | `32` | `rag.py:70` | Embedding batch size |
| `RAG_HNSW_EF_SEARCH` | `800` | `rag.py:95` | pgvector `hnsw.ef_search` |
| `RAG_EVAL` | `on` (off = `off`/`0`/`false`) | `backend/rag/evaluation.py:100` | Ragas scoring on/off |
| `RAG_EVAL_MODEL` | `claude-sonnet-5` | `evaluation.py:105` | Ragas judge |
| `RAG_EVAL_SAMPLE` | `1.0` | `evaluation.py:111` | Fraction of answers that are judged |
| `RAG_EVAL_TIMEOUT` | `180` (s) | `evaluation.py:115` | Wall-clock limit for the whole judge set |
| `RAG_EVAL_MAX_TOKENS` | `16000` | `evaluation.py:123` | Judge max tokens |
| `RAG_EVAL_OPTIONAL_METRICS` | `""` (CSV; e.g. toxicity, bias) | `evaluation.py:131` | Extra metrics |
| `RAG_EVAL_DATASET` | `spark-l2c-eval` | `evaluation.py:914` | Langfuse dataset name |
| `ASK_HISTORY_LIMIT` | `500` | `backend/rag/ask_store.py:55` | Ask history retention |
| `ASK_LOW_QUALITY` | `0.7` | `ask_store.py:67` | Low-quality score threshold |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | none. Tracing is on only when both are set | `backend/core/tracing.py:65`; `evaluation.py:804-805` | Langfuse auth |
| `LANGFUSE_BASE_URL` | `tracing.py:205` uses `'cloud'` (log label only), `tracing.py:450` uses `""`, `evaluation.py:803,890` use `https://cloud.langfuse.com` | as listed | Langfuse host (also read by the Langfuse SDK [I]) |
| `LANGFUSE_TRACING_ENVIRONMENT` | `development` (`.env.example` sets `production`) | `tracing.py:70` | Environment tag |
| `LANGFUSE_RELEASE` | None | `tracing.py:150` | Release tag |
| `NEO4J_URI` | `bolt://127.0.0.1:7687` | `backend/graph/kg_neo4j_load.py:46` | Bolt endpoint |
| `NEO4J_USER` | `neo4j` | `kg_neo4j_load.py:47` | — |
| `NEO4J_PASSWORD` | `""`. Empty means Neo4j/Cypher is disabled ("NEO4J_PASSWORD is not set in .env", `:114`) | `kg_neo4j_load.py:48` | — |
| `NEO4J_DATABASE` | `neo4j` | `kg_neo4j_load.py:49` | — |
| `NEO4J_BROWSER_URL` | `http://localhost:7474/browser/` | `kg_neo4j_load.py:50` | Link shown in the UI |
| `CYPHER_MODEL` | `claude-opus-5` | `backend/graph/kg_nl2cypher.py:44` | NL→Cypher |
| `CYPHER_EFFORT` | `medium` | `kg_nl2cypher.py:48` | Reasoning effort parameter |
| `HINDSIGHT_URL` | `http://127.0.0.1:8888`. Empty means memory is off (also checked by `run.sh:13`) | `backend/agents/fitgap/memory.py:63` | Memory server |
| `HINDSIGHT_API_KEY` | None | `memory.py:64` | Optional auth |
| `HINDSIGHT_BANK` | `spark-evidence` | `memory.py:65` | Memory bank id |
| `HINDSIGHT_TIMEOUT` | `8` (s) | `memory.py:66` | recall/retain deadline |
| `HINDSIGHT_RECALL_TOKENS` | `1200` | `memory.py:67` | Recall budget |
| `HINDSIGHT_REFLECT_TIMEOUT` | `120` (s) client side. Note: the same name feeds the server's per-call `HINDSIGHT_API_REFLECT_LLM_TIMEOUT` (default 60) in `hindsight.sh:67` / `compose.yml:115` | `memory.py:73` | "Ask memory" deadline |
| `EVIDENCE_MODEL` | then `RAG_ANSWER_MODEL`, then `claude-opus-5` | `backend/agents/evidence/agent.py:35` | Evidence Agent |
| `EVIDENCE_MAX_TOOL_CALLS` | `14` | `evidence/agent.py:36` | — |
| `EVIDENCE_MAX_INPUT_TOKENS` | `60000` | `evidence/agent.py:37` | — |
| `EVIDENCE_HISTORY_LIMIT` | `200` | `backend/agents/evidence/store.py:294` | Run retention |
| `EVIDENCE_DUPLICATE_AT` | `0.93` | `backend/agents/evidence/independence.py:31` | Centroid-cosine near-duplicate threshold |
| `EVIDENCE_HUB_DEGREE` | `40` | `backend/agents/evidence/paths.py:31` | Graph hub cut-off |
| `FITGAP_MODEL` | then `RAG_ANSWER_MODEL`, then `claude-opus-5` | `backend/agents/fitgap/agent.py:24` | InsightLens |
| `FITGAP_MAX_TOOL_CALLS` | `12` | `fitgap/agent.py:25` | — |
| `FITGAP_MAX_INPUT_TOKENS` | `40000` | `fitgap/agent.py:31` | — |
| `FITGAP_COPILOT_MODEL` | then `RAG_ANSWER_MODEL`, then `claude-opus-5` | `backend/agents/rollout/agent.py:41` | Fit-Gap Copilot. Read once at import, so a change needs the process (container) recreated; see §7.7 |
| `ROLLOUT_MAX_TOOL_CALLS_ASIS` | `20` | `rollout/agent.py:44` | As-Is pass |
| `ROLLOUT_MAX_TOOL_CALLS` | `30` | `rollout/agent.py:45` | Compare pass |
| `ROLLOUT_MAX_INPUT_TOKENS` | `150000` | `rollout/agent.py:59` | — |
| `ROLLOUT_MAX_BILLED_TOKENS` | `220000` | `rollout/agent.py:60` | Total input-token budget |
| `ROLLOUT_MAX_TOKENS_OUT` | `64000` | `rollout/agent.py:66` | `max_tokens` per Copilot response. Sized so a full deviation register fits; a pass gives up after `MAX_CUT_OFFS = 2` responses that hit it (`:67-69`) |
| `FITGAP_UPLOAD_TTL_HOURS` | `12` | `backend/core/uploads.py:96` | Session-attachment expiry |
| `FITGAP_UPLOAD_MAX_FILES` | `12` | `uploads.py:99` | Files per session |
| `AGENT_SCOPE_GUARD` | `on` | `backend/agents/guardrails/scope.py:39` | Scope classifier on/off |
| `AGENT_SCOPE_MODEL` | `claude-haiku-4-5-20251001` | `scope.py:40` | — |
| `AGENT_SCOPE_TIMEOUT` | `15` | `scope.py:41` | — |
| `AGENT_WEB_SEARCH` | `on` | `backend/agents/guardrails/web.py:42` | Anthropic server-side web search on/off |
| `AGENT_WEB_MODEL` | `claude-sonnet-5` | `web.py:43` | — |
| `AGENT_WEB_MAX_SEARCHES` | `2` | `web.py:44` | — |
| `AGENT_WEB_DOMAINS` | `sap.com,europa.eu` | `web.py:48-49` | Allow-list |
| `AGENT_WEB_TIMEOUT` | `90` | `web.py:50` | — |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | none | `backend/auth/store.py:307-308` | The first Admin, created or re-enabled at start-up only when there is no active Admin (§4.3). Ignored once an active Admin exists. Also read by `loadtest/seed_users.py:51` |
| `AUTH_SECRET` | then `APP_SECRET`, then random `secrets.token_hex(32)` per process, so every restart signs everyone out | `backend/auth/sessions.py:22-23` | HMAC-SHA256 key for the `spark_session` cookie, shared by the app and Demo Mode. `APP_SECRET` is kept only as a fallback so an older installation keeps its sessions |
| `AUTH_SESSION_HOURS` | then `APP_SESSION_HOURS`, then `12` | `sessions.py:24-25` | Cookie lifetime and token expiry |
| `OPENAI_API_KEY` | none | `backend/ingestion/vlm_api.py:63-70` (`key_env`), read at `:93,117` | Optional GPT vision |
| `OPENAI_VLM_MODEL` | `gpt-5` | `vlm_api.py:68-69`, read at `:89` | — |
| `CLAUDE_VLM_MODEL` | `claude-opus-5` | `vlm_api.py:76-77` | Claude vision via the OpenAI-compatible endpoint |
| `TESSDATA_PREFIX` | auto-detected (see §1.4) | `backend/ingestion/pptx_ocr.py:52` | Tesseract language data |

[F] **Removed since the first version of this spec:** `APP_LOGIN`, `APP_USERNAME`, `APP_PASSWORD`, `DEMO_USERNAME`, `DEMO_PASSWORD`, `DEMO_SECRET`, `DEMO_SESSION_HOURS`. Sign-in is now per account in Postgres, and Demo Mode uses the same accounts and cookie (`backend/api/demo_mode.py:8-11`). `APP_SECRET` and `APP_SESSION_HOURS` survive only as fallbacks (above).

### 5.2 Read by scripts, compose, images and libraries
| Variable | Where | Default / meaning |
|---|---|---|
| `PORT` | `scripts/run.sh:46` | 8000 |
| `HINDSIGHT_URL` (empty check) | `run.sh:13` | unset → start Hindsight |
| `HINDSIGHT_MODEL`, `HINDSIGHT_REFLECT_MODEL`, `HINDSIGHT_REFLECT_TIMEOUT` | `scripts/hindsight.sh:48,66-67`; `compose.yml:112-115` | `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `60` |
| `HINDSIGHT_API_*` (LLM_PROVIDER, LLM_MODEL, LLM_API_KEY, REFLECT_LLM_MODEL, REFLECT_LLM_TIMEOUT, EMBEDDINGS_PROVIDER, DATABASE_URL) | consumed by the hindsight-api server | see §3.1 / §4.4 |
| `TAG`, `IMAGE`, `PLATFORM` | `scripts/docker-publish.sh:21-24`; `TAG` also `compose.yml:19` | TAG = short git SHA (publish) / `latest` (compose); IMAGE = `reg.ivolve.cloud/ivolve/<name>`; PLATFORM = `linux/amd64` |
| `HINDSIGHT_TAG` | `compose.yml:107` | `latest` |
| `APP_PORT` | `compose.yml:32` | `8000` (may be `127.0.0.1:8000`, `docs/deployment.md:108`) |
| `POSTGRES_PASSWORD` | `compose.yml:23,63,84,110` | required |
| `DATABASE_URL` | `scripts/db-export.sh:9` | from the shell, or grepped from `.env` |
| `DOCLING_ARTIFACTS_PATH` | `Dockerfile:72` | `/opt/docling-models`; read by Docling [I] |
| `PYTHONUNBUFFERED`, `PATH` | `Dockerfile:70-71` | — |
| `HF_HOME`, `HF_HUB_OFFLINE` | `Dockerfile.hindsight:39` | `/opt/hf`, `1` |
| `PIP_NO_CACHE_DIR`, `PIP_DEFAULT_TIMEOUT`, `PIP_RETRIES` | build stages | 1, 120, 10 |
| `GIT_SHA`, `TORCH_VERSION`, `TORCHVISION_VERSION`, `HINDSIGHT_VERSION` | build args | unknown, 2.14.0, 0.29.0, 0.10.1 |
| `PGHOST`, `PGUSER`, `PGPASSWORD` | `solvay-hindsight-db` | — |
| `NEO4J_AUTH`, `NEO4J_PLUGINS`, `NEO4J_server_memory_*`, `NEO4J_db_tx__log_rotation_*` | Neo4j container | §3 |
| `ANTHROPIC_BASE_URL` | read by the `anthropic` SDK [I]; set only by the load-test recipe | Points the app at `loadtest/mock_anthropic.py` (`http://localhost:8099`) for a cost-free streaming test (`loadtest/README.md:66-76`) |
| `LOADTEST_USERNAME`, `LOADTEST_PASSWORD` | `loadtest/locustfile.py:42-43`; password also `loadtest/seed_users.py:50` | none. `LOADTEST_USERNAME` must start with `loadtest-`; when empty, simulated users rotate over `loadtest-01..N`. The password must meet the app's 8-character minimum (`backend/auth/passwords.py:22`) |
| `LOADTEST_ACCOUNTS` | `locustfile.py:44`; `seed_users.py:45` | `20` |
| `LOADTEST_ALLOWED_HOSTS` | `locustfile.py:45-47` | `localhost,127.0.0.1`; Locust refuses any other host |
| `LOADTEST_LLM`, `LOADTEST_HEAVY` | `locustfile.py:48-49` | off unless `1`. `LLM` enables Ask and Evidence calls; `HEAVY` enables Fit-Gap and Fit-Gap Copilot runs |
| `LOADTEST_ROLLOUT_SESSION`, `LOADTEST_ROLLOUT_SUBJECT`, `LOADTEST_ROLLOUT_SCOPE` | `locustfile.py:52,260-261` | `""` (Copilot runs skipped), `sap_best_practice`, `4.1` |
| `LOADTEST_FITGAP_STEPS` | `locustfile.py:219` | `2` |
| `MOCK_FIRST_TOKEN_MS`, `MOCK_TOKENS_PER_SEC`, `MOCK_ANSWER_TOKENS` | `loadtest/mock_anthropic.py:32-34` | `800`, `60`, `300` |
| `COHERE_API_KEY` | not read by the code (leftover per `ARCHITECTURE-CONTEXT.md:123,317`) | — |

### 5.3 `.env.example` contents (variable names and comments)
[F] `.env.example:1-46`:
- **Required:** `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD`, `NEO4J_PASSWORD` (empty switches Cypher off).
- **Accounts** (`:11-19`): `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `AUTH_SECRET`; `AUTH_SESSION_HOURS=12` commented out. The comment says the first Admin is created at start-up when there is no active Admin, everyone else's account is created from the Admin tab, the Admin changes this password from the account menu, and `AUTH_SECRET` should come from `openssl rand -hex 32`.
- **Models:** `RAG_EMBED_MODEL=bge-m3`, `RAG_EMBED_DIMENSION=1024`. Commented out: `RAG_ANSWER_MODEL`, `FITGAP_COPILOT_MODEL`, `CLAUDE_VLM_MODEL`, `OPENAI_API_KEY`, `OPENAI_VLM_MODEL`.
- **Langfuse:** `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL=https://cloud.langfuse.com`, `LANGFUSE_TRACING_ENVIRONMENT=production`.
- **Hindsight (commented):** `HINDSIGHT_MODEL`, `HINDSIGHT_REFLECT_MODEL`, `HINDSIGHT_TAG`.
- **Compose (commented):** `TAG`, `APP_PORT`.

[F] The developer's local `.env` defines (names only): `ANTHROPIC_API_KEY`, `CLAUDE_VLM_MODEL`, `DATABASE_URL`, `OLLAMA_HOST`, `RAG_EMBED_MODEL`, `RAG_EMBED_DIMENSION`, `RAG_ANSWER_MODEL`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL`, `FITGAP_COPILOT_MODEL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `AUTH_SECRET`. It no longer sets `NEO4J_*`, so [I] Cypher is off on that machine unless they are exported.

### 5.4 External endpoints and model IDs (defaults)
| What | Default | file:line |
|---|---|---|
| Ollama | `http://127.0.0.1:11434` (compose: `http://solvay-ollama:11434`) | `rag.py:66`; `compose.yml:24` |
| Postgres | no code default. Local: `localhost:5433/docling`. Compose: `solvay-postgres:5432/solvay`, user `spark` | `README.md:84`; `compose.yml:23` |
| Neo4j Bolt | `bolt://127.0.0.1:7687` (compose: `bolt://solvay-neo4j:7687`) | `kg_neo4j_load.py:46`; `compose.yml:25` |
| Neo4j Browser | `http://localhost:7474/browser/` | `kg_neo4j_load.py:50` |
| Hindsight | `http://127.0.0.1:8888` (compose: `http://solvay-hindsight:8888`) | `memory.py:63`; `compose.yml:28` |
| Langfuse | `https://cloud.langfuse.com` | `evaluation.py:803`; `.env.example:33` |
| OpenAI vision | `https://api.openai.com/v1/chat/completions`, model `gpt-5`, param `max_completion_tokens` | `vlm_api.py:63-70` |
| Claude vision | `https://api.anthropic.com/v1/chat/completions` (OpenAI-compat), model `claude-opus-5`, param `max_tokens`. `MAX_EDGE=2000`, `MAX_OUTPUT_TOKENS=16000`, `TIMEOUT_SECONDS=300` | `vlm_api.py:44-80` |
| Local vision (MLX) | `mlx-community/Qwen3-VL-8B-Instruct-4bit`, Apple silicon only | `vlm_ocr.py:39` |
| Claude models | Opus `claude-opus-5` (answers, agents, Cypher, VLM); Sonnet `claude-sonnet-5` (Ragas judge, web search); Haiku `claude-haiku-4-5-20251001` (scope guard) | §5.1 |
| Hindsight LLM (via LiteLLM) | `anthropic/claude-opus-5` (retain), `anthropic/claude-sonnet-5` (reflect) | `hindsight.sh:48,66` |
| Hindsight local models | `BAAI/bge-small-en-v1.5` (embeddings), `cross-encoder/ms-marco-MiniLM-L-6-v2` (rerank) | `Dockerfile.hindsight:18` |
| Embedding model | `bge-m3`, 1024-d | `rag.py:67-68` |
| Anthropic web search tool | `web_search_20250305` | `docs/technical-architecture.md:37` |
| Registry | `reg.ivolve.cloud/ivolve/solvay-spark-spine[-hindsight]` | `docker-publish.sh:17-21` |
| ngrok public URL | `https://scuttle-bagel-tyke.ngrok-free.dev` → local 8000 | `scripts/ngrok.sh:1` |

---

## 6. Filesystem layout of runtime state

[F] `backend/core/paths.py:10-12` defines:
- `ROOT = Path(__file__).resolve().parents[2]` (the repo root)
- `DATA = ROOT/"data"`
- `KNOWLEDGE_GRAPH = DATA/"knowledge_graph.json"`

Every module resolves paths from `ROOT`, often aliased as `BASE`. In the container `ROOT=/app`.

| Path | Contents / writer | Evidence |
|---|---|---|
| `.env` | Config (git- and docker-ignored) | `.gitignore:6`, `.dockerignore:4` |
| `.env.bak*` | Backups of `.env` (for example from `sed -i.bak`); git-ignored | `.gitignore:20` |
| `.workdir/` | Per-upload scratch; never garbage-collected (about 20 MB per 144-slide deck) | `backend/api/app.py:51`; `README.md:164` |
| `.workdir/<12-hex uuid>/` | `source.<ext>`, `name.txt` (original filename), `owner.txt` (the uploader's user id), `preview/page-N.png` (LibreOffice→PDF→pdftoppm @90 DPI), `output.md`, media | `app.py:273-281`; observed |
| `.workdir/kb<10-hex sha256(path)>/` | Preview jobs for originals of already-indexed corpus/KB files (`source.<ext>`, `name.txt`, `preview/`, and an empty `shared` marker; no `owner.txt`, so any signed-in user may read its pages and nobody can convert, embed or delete it through the API) | `app.py:876-884` |
| `.workdir/batches/<batch_id>/` | Batch convert: `owner.txt` (the uploader's user id), `sources/`, `markdown/`, `batch_<id>_markdown.zip` | `app.py:1269-1274`; observed |
| `.workdir/uploads/<12-hex session>/` | Per-session agent attachments. The DB side is `<db>_session`, one schema `u_<sid>` per session, plus tables `upload_sessions` and `upload_files` | `backend/core/uploads.py:59,106-114,187-198` |
| `.workdir/app.log` | Observed log file. [I] Writer not found by grep. Possibly a redirect from an earlier run script | observed |
| `knowledge_base/` | Markdown added from the UI (`<stem>_<ext>.md`), plus `BPML_Process.xlsx` → `BPML_Process_xlsx.md` (`backend/ingestion/bpml_markdown.py:35-36`). Category `UNFILED`. Mounted rw in compose; git-ignored | `app.py:58,370`; `rag.py:133-137` |
| `solvay-spark/<cat>/` and `solvay-spark/<cat>/markdown/*.md` | The client corpus. Source docs are in `<cat>/`; converted Markdown is in `<cat>/markdown`. The folder name gives the category: `pkg`→PKG, `dr`→DR, also `sap`. Other dirs observed: `sample-data`, `markdown docling`, `markdown unstructured io`. Mounted read-only in compose; not in the image | `rag.py:121-137`; `knowledge_graph.py:33-37` |
| `data/knowledge_graph.json` | Cached graph, rewritten by `POST /api/graph/rebuild`. Volume `graph-data` | `paths.py:12`; `compose.yml:35-36` |
| `data/graph_eval_questions.json`, `data/spark_target_model.json` | Graph eval set; target model | `backend/graph/graph_eval.py:59`; observed |
| `static/dist/` | Built SPA: `index.html`, `demo.html`, `login.html`, `assets/` (hashed). `/assets` is served with `Cache-Control: public, max-age=31536000, immutable`; HTML is served with `no-cache`. If not built, `/` returns 503 with build instructions | `app.py:174-186,3440-3459`; `app_login.py:51-55`; `demo_mode.py:29-34` |
| `docs/` | Needed at runtime for eval questions and the Langfuse dashboard JSON | `evaluation.py:870,913`; `backend/graph/kg_neo4j_export.py:39` |
| `backup/` | `db-export.sh` dumps (`spark-YYYY-MM-DD.dump`); `backup/baseline.json` used by `consolidate.py:63` | git-ignored |
| `hindsight-venv/`, `hindsight.log` | Local memory server environment and log | `.gitignore:17-19` |
| `.venv-loadtest/` | Locust's own venv (§7.8) | `.gitignore:22-23` |
| Postgres main DB: `users`, `activity_events` | Accounts and the usage log. In the main `DATABASE_URL` database, not the session DB; on the server, database `solvay` in `solvay-postgres`. Every run table also gains a `user_id` owner column | `backend/auth/store.py:1-18,42-48,340-341` |
| `~/.pg0` | Local Hindsight embedded Postgres | `docs/running-the-app.md:59` |
| `out/`, `tmp/` | CLI output / scratch, ignored | `.gitignore:3`, `.dockerignore:13-14` |

---

## 7. Build, registry and deployment

### 7.1 `scripts/docker-publish.sh [app|hindsight]`
1. bash with `set -euo pipefail`, run from the repo root.
2. `app` maps to `Dockerfile` with name `solvay-spark-spine`; `hindsight` maps to `Dockerfile.hindsight` with name `solvay-spark-spine-hindsight` (`:16-20`).
3. `IMAGE=${IMAGE:-reg.ivolve.cloud/ivolve/$NAME}`, `SHA=$(git rev-parse --short HEAD)`, `TAG=${TAG:-$SHA}`, `PLATFORM=${PLATFORM:-linux/amd64}`.
4. If the git tree is dirty, print a warning that uncommitted changes are included.
5. If `docker buildx` exists: `docker buildx build -f $DOCKERFILE --platform $PLATFORM --build-arg GIT_SHA=$SHA -t $IMAGE:$TAG -t $IMAGE:latest --push .`
6. Else, if `podman` exists: `podman build --format docker …` (the docker format keeps HEALTHCHECK, which OCI format drops), then `podman push` both tags.
7. Otherwise exit 1.

Log in first with `docker login reg.ivolve.cloud`, using a GitLab token with `write_registry`. The server needs only `read_registry`.

### 7.2 `scripts/db-export.sh`
`DATABASE_URL` comes from the environment, or else from `grep ^DATABASE_URL= .env`. The script runs `mkdir -p backup`, then `pg_dump --format=custom --no-owner --no-acl --dbname=$DATABASE_URL --file=backup/spark-$(date +%F).dump`, then prints the size. The dump holds the RAG index (embeddings) and run history.

### 7.3 Server deployment procedure (`docs/deployment.md:21-111`)
1. **On the dev machine:**
   - `./scripts/docker-publish.sh`
   - `./scripts/docker-publish.sh hindsight`, only when `Dockerfile.hindsight` changes
   - `./scripts/db-export.sh`
2. **Server prerequisites:** Docker with the compose plugin, and the external network `ivolve-network` must already exist.
3. Copy files to `~/solvay-spark-spine/`:
   - `scp compose.yml .env.example`
   - `rsync -a solvay-spark/`
   - `rsync -a knowledge_base/`
   - `scp backup/spark-<date>.dump`
4. `cp .env.example .env` and fill it in, including `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `AUTH_SECRET` before the first start (`docs/deployment.md:50,109`).
5. `docker login reg.ivolve.cloud`, then `docker compose pull`.
6. `docker compose up -d solvay-postgres solvay-ollama solvay-ollama-pull solvay-neo4j`
7. Restore: `docker compose exec -T solvay-postgres pg_restore -U spark -d solvay --no-owner --no-acl < spark-<date>.dump`. A warning that the vector extension already exists is harmless.
8. `docker compose up -d solvay-hindsight-db solvay-hindsight app`
9. `docker compose logs -f app` and wait for "Application startup complete". Then `curl -s localhost:8000/api/health`; `soffice` and `pdftoppm` must both be non-null.
10. Open `http://<server>:8000` and sign in with `ADMIN_USERNAME`/`ADMIN_PASSWORD`. Create everyone else's account from the **Admin** tab (`docs/deployment.md:74`).

**Updating:**
- `./scripts/docker-publish.sh`, then on the server `docker compose pull app && docker compose up -d app`.
- To pin a version, set `TAG=<commit>` in `.env`.
- When the corpus changes, rsync again, then rebuild the graph. The API needs a session, so sign in first and reuse the cookie: `curl -s -c /tmp/spark.cookie -H 'content-type: application/json' -d '{"username":"<admin>","password":"<password>"}' localhost:8000/api/auth/login`, then `curl -s -b /tmp/spark.cookie -X POST localhost:8000/api/graph/rebuild`, then delete the cookie file. Or press the rebuild button on the Knowledge Graph page (`docs/deployment.md:85-97`).
- When an image update changes `data/`, remove the `graph-data` volume so the new seed is taken.

**Security notes** (`docs/deployment.md:104-111`):
- Accounts guard the pages and the API. A request to `/api/*` without a valid session gets `401 {"detail": "Sign in first."}`; only `/api/health` and the `login`/`logout`/`session` routes under `/api/auth`, `/api/app` and `/api/demo` are exempt (`backend/auth/middleware.py:35-41,111-117`).
- The cookie `spark_session` is `HttpOnly`, `SameSite=Lax`, path `/`, and **not** `Secure` (`backend/auth/routes.py:45-46`). Cookie and passwords travel in clear over plain HTTP, so put a TLS reverse proxy, VPN or allowlist in front, or set `APP_PORT=127.0.0.1:8000` (`compose.yml:30-31`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `AUTH_SECRET` before the first start; then change the Admin password from the account menu.
- Postgres, Ollama, Neo4j and Hindsight publish no ports.
- Questions and excerpts are sent to Anthropic.

### 7.4 `scripts/ngrok.sh`
One line, no shebang: `ngrok http 8000 --url https://scuttle-bagel-tyke.ngrok-free.dev`. It exposes the local app for demos.

### 7.5 `scripts/gen-architecture-diagram.py`
A standalone generator (217 lines, stdlib only) that writes a hand-laid-out 1800×1340 SVG architecture diagram to `sys.argv[1]`. Its docstring says the target is `docs/system-architecture.svg`, but that file does not exist in the repo. It is not part of the build.

### 7.6 Tests and CLIs
- Backend tests: `.venv/bin/python backend/tests/test_<name>.py`. These are plain scripts, not pytest-required [I] (`README.md:149-153`). There are 23 test files (agent_eval, app_login, ask_store, auth, bpml_markdown, category_durability, converter, coverage, evaluation, evidence, fitgap, formats, graph_determinism, graph_eval, guardrails, knowledge_graph, neo4j, originals, ownership, quality, rag, rollout, tracing). `test_demo_mode.py` was removed; `test_auth.py` and `test_ownership.py` are new.
- CLIs run as modules from the root, for example:
  - `python -m backend.rag.rag index|search|ask|chunks|clear|reset|categories`
  - `python -m backend.ingestion.pptx_to_md`
  - `python -m backend.ingestion.folder_to_md` (`README.md:56-57,127-132`)
  - `python -m backend.auth.store create-admin <username>` (prompts twice for the password), `… list` (id, username, role, active/inactive), `… reassign-legacy <username> [table ...]` (`backend/auth/store.py:20-25,389-419`). The CLI loads `.env` itself (`:426-430`).

### 7.7 Operating the deployed server
All commands run in `~/solvay-spark-spine` on the server (`docs/deployment-guide.html`).

**Accounts.**
- [F] A first Admin comes from `ADMIN_USERNAME`/`ADMIN_PASSWORD` at start-up (§4.3). If that is not set, create one inside the container: `docker compose exec app python -m backend.auth.store create-admin <name>` [I] (the command is the CLI above; `-it` may be needed for the password prompt).
- [F] Usernames are 1–64 characters with no whitespace and no `|`, unique case-insensitively; `legacy` is reserved. Passwords need at least 8 characters and are stored as stdlib `scrypt` hashes, `scrypt$<n>$<r>$<p>$<salt hex>$<hash hex>` (`backend/auth/store.py:171-198`; `backend/auth/passwords.py:1-28`).
- [F] `bootstrap_admin` checks `ADMIN_PASSWORD` (at least 8 characters) and `ADMIN_USERNAME` (`_clean_username`: 1–64 characters, no whitespace or `|`, not `legacy`) before it looks for an existing account. A refused value is not an error: it returns an `auth: WARNING -- ADMIN_PASSWORD was not used: …` or `auth: WARNING -- ADMIN_USERNAME was not used: …` line ending `No Admin account was created.`, the lifespan prints it and the app starts without an Admin (`store.py:312-334`). Fix the setting and restart, or use `create-admin`. [I] An unreachable database still stops the app from starting, because the lifespan does not catch that.
- [F] Accounts are never deleted, only deactivated. Resetting a password or deactivating an account bumps `session_version`, which signs that user out everywhere; the middleware caches each account lookup for 30 s and clears the cache when an Admin changes an account (`backend/auth/sessions.py:1-9`; `backend/auth/middleware.py:15-19,43`).
- [F] View accounts: `docker compose exec solvay-postgres psql -U spark -d solvay -c "SELECT id, username, role, active, created_at, last_login_at, last_seen_at FROM users ORDER BY id;"`. Recent activity: `SELECT at, username, action, tool, run_id FROM activity_events ORDER BY at DESC LIMIT 30;`. Without SQL: the Admin tab, or `docker compose exec app python -m backend.auth.store list`. `password_hash` cannot be read back; reset passwords from the Admin tab (`docs/deployment-guide.html`, "View the user accounts in the database").
- [F] Runs recorded before accounts existed belong to the inactive `legacy` account and are visible to Admins only. Hand them to a real account with `docker compose exec app python -m backend.auth.store reassign-legacy <username> [table ...]`. Allowed tables: `fitgap_runs`, `fitgap_reviews`, `rollout_runs`, `workshop_sessions`, `workshop_decisions`, `evidence_runs`, `ask_runs`, `ask_reviews`; default all; a table that does not exist yet is skipped; it prints rows moved per table and is idempotent (`store.py:340-365,410-418`). It needs an image from commit `a52964c` or later; an older image prints the usage text.

**Switching the Fit-Gap Copilot model.** [F] The model is a `.env` setting, not part of the image: set `FITGAP_COPILOT_MODEL` (falls back to `RAG_ANSWER_MODEL`, then `claude-opus-5`; `backend/agents/rollout/agent.py:41`). Procedure from the guide:
1. `grep -n "FITGAP_COPILOT_MODEL\|RAG_ANSWER_MODEL" .env`
2. `sed -i 's/^FITGAP_COPILOT_MODEL=.*/FITGAP_COPILOT_MODEL=claude-opus-5/' .env`, and append the line if it is missing.
3. `docker compose up -d app`. Not `docker compose restart app`, which keeps the old container and its old environment; `up -d app` recreates only the app container.
4. Check with `docker compose exec app printenv FITGAP_COPILOT_MODEL`. `GET /api/rollout/status` also returns the model in use (`backend/api/app.py:2465,2479`).

The guide warns that scores from different models are not comparable (Opus and Sonnet differed by 8 points of GT alignment on the same India returns document; `docs/model-comparison.html`), so one model should be used for every country comparison.

**Checking the network.** [F] `docker network inspect ivolve-network --format '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | grep solvay-spark-spine` should list five containers: `solvay-spark-spine-app-1`, `-solvay-postgres-1`, `-solvay-neo4j-1`, `-solvay-ollama-1`, `-solvay-hindsight-1`. The one-shot helpers have exited and do not appear (`docs/deployment-guide.html`).

**Admin usage dashboard and estimated cost.** [F] The Admin tab (`/api/admin/users`, `/usage`, `/activity`, `/runs`; `backend/api/admin.py:25,91-300`) prices each run's recorded tokens with a hard-coded table in `backend/core/pricing.py:23-35`, in USD per million input/output tokens. There is **no environment variable** for prices. A model id matches exactly, or by its longest listed stem followed by `-` or `@`, after stripping an `anthropic.` prefix; an unlisted model is reported as unpriced (`pricing.py:38-51`). It is an over-estimate: cache reads are priced at the full input rate, and calls no run row records (scope guard, Ragas judge, Hindsight, embeddings) are not counted (`pricing.py:1-17`).

| Model stem | Input $/M | Output $/M |
|---|---|---|
| `claude-fable-5-1`, `claude-fable-5` | 10.00 | 50.00 |
| `claude-opus-5-5` | 4.00 | 20.00 |
| `claude-opus-5`, `claude-opus-4-8`, `-4-7`, `-4-6` | 5.00 | 25.00 |
| `claude-sonnet-5-5`, `claude-sonnet-5` | 2.00 | 10.00 |
| `claude-sonnet-4-6` | 3.00 | 15.00 |
| `claude-haiku-4-5` | 1.00 | 5.00 |

[F] Each trace a request opens is tagged with the signed-in username, set by the auth middleware through the context variable `tracing.USER` (`backend/core/tracing.py:376-382,402`; `middleware.py:107-108`).

### 7.8 Load tests (`loadtest/`)
[F] Locust drives the app over HTTP and signs in like the browser, keeping the `spark_session` cookie (`loadtest/README.md:1-12`). Files: `locustfile.py` (simulated users), `sse.py` (times an SSE endpoint to its `done` event), `seed_users.py` (creates accounts through `/api/admin/users`; stdlib only), `mock_anthropic.py` (a FastAPI stand-in answering `POST /v1/messages`).

Rules enforced in code:
- Only `loadtest-*` accounts. `PREFIX = "loadtest-"` is fixed; Locust exits if `LOADTEST_USERNAME` is not a test account, and a user stops if its account is not one (`loadtest/locustfile.py:38-39,77-87,110-111`).
- Only allowed hosts: `LOADTEST_ALLOWED_HOSTS`, default `localhost,127.0.0.1` (`locustfile.py:45-47,90-99`).
- Claude calls are off by default: Ask and Evidence need `LOADTEST_LLM=1`; Fit-Gap and Copilot runs need `LOADTEST_HEAVY=1` (Copilot also `LOADTEST_ROLLOUT_SESSION`).

Setup (`loadtest/README.md:33-46`):
1. `python3 -m venv .venv-loadtest && .venv-loadtest/bin/pip install -r loadtest/requirements.txt`
2. The app needs a fixed `AUTH_SECRET`, or a restart signs every test user out.
3. `LOADTEST_PASSWORD=… ADMIN_USERNAME=… ADMIN_PASSWORD=… .venv/bin/python loadtest/seed_users.py --host http://localhost:8000 --count 20 --admin` creates `loadtest-01..20` (role user) and, with `--admin`, `loadtest-admin` (needed by `QualityUser`). Re-running resets passwords and reactivates.

Profiles, run from `loadtest/` (`README.md:56-101`): reads only (`-u 200 -r 20`); Ask against the mock (`uvicorn mock_anthropic:app --port 8099`, then a second app on :8001 with `ANTHROPIC_BASE_URL=http://localhost:8099 ANTHROPIC_API_KEY=mock RAG_EVAL_SAMPLE=0`); a 1-user Fit-Gap smoke test against the real API; Copilot runs with an upload session id copied from the browser. Test the server as deployed, one uvicorn process without `--reload`. [F] The README notes each open stream holds one of Starlette's 40 threadpool threads, which is the app's practical limit on concurrent agent runs (`loadtest/README.md:113`).

---

## 8. Discrepancies between docs and code (rebuild against the code)
1. `docs/technical-architecture.md:30,44` says Hindsight is "not in compose", uses embedded PostgreSQL, and that the services are called `postgres`/`ollama`/`neo4j`. **The code** (`compose.yml`) has `solvay-hindsight` on the stack Postgres and `solvay-` prefixed names. Use `compose.yml`.
2. `docs/technical-architecture.md:46` says "scripts/run.sh (Uvicorn + Vite)". **run.sh** does not start Vite.
3. `docs/system-diagram.md:119` labels Postgres as `:5433`. That is local only; compose uses 5432.
4. The README asks for Node 20+, the Dockerfile uses Node 22, and the dev machine runs Node 24.
5. `compose.neo4j.yml:4` references the root-level `kg_neo4j_load.py`. The module now lives in `backend/graph/`. `docs/ARCHITECTURE-CONTEXT.md` §3 also uses root-level module names (`app.py`, `rag.py`), which are stale.
6. `cohere` is still installed and `COHERE_API_KEY` is a leftover; neither is used.
7. `LANGFUSE_BASE_URL` falls back inconsistently across `tracing.py` and `evaluation.py`.
8. The Langfuse tracing environment defaults to `development` in code and is set to `production` in `.env.example`.
9. `docs/deployment.md:50` still says "change every sign-in value". The only sign-in values left are `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `AUTH_SECRET`; every other account is created in the app.
10. The old names `APP_SECRET` and `APP_SESSION_HOURS` are still honoured as fallbacks (`backend/auth/sessions.py:20-25`) though no doc mentions them. A rebuild can drop them unless it must keep sessions from an older installation.

## 9. Gaps (not determinable from the repo)
- The actual values of all secrets, and the real server hostname, TLS and reverse-proxy configuration. The proxy is only referenced by container name, `compose.yml:44-45`.
- How `ivolve-network` is created or configured; it is managed outside this stack.
- The Postgres schema bootstrap order when starting from an **empty** DB without a dump. [I] The modules use `CREATE TABLE IF NOT EXISTS` and `create_schema()`, which suggests self-initialisation. See the data-layer spec.
- The exact `ollama/ollama:latest` version, and the APOC version downloaded at Neo4j first start; both are unpinned.
- The macOS Homebrew Postgres configuration that puts it on port 5433. This is not scripted; [I] it is a manual `postgresql.conf` change.
- The writer of `.workdir/app.log`.
- No CI pipeline config (no `.github/`, `.gitlab-ci.yml`) was seen. [I] Builds are manual via `docker-publish.sh`.
- Resource sizing (CPU/RAM) for the app container is unspecified. Only Neo4j's memory is set.
- The `solvay-spark/` corpus content is client data, not in git, and must be supplied separately.
- The model IDs (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `gpt-5`) are taken as written. Whether they are currently served depends on the provider.
