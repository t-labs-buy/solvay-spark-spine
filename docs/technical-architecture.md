# Technical architecture

The technologies and libraries behind every component of Solvay Spark Spine AI.
The diagram is [component-architecture-technical.png](component-architecture-technical.png)
(source: `component-architecture-technical.spec.json`); the same components, without
technology detail, are in [component-architecture.png](component-architecture.png).

Sources for this page: `requirements.txt`, `constraints.txt`, `frontend/package.json`,
`Dockerfile`, `compose.yml`, `scripts/hindsight.sh`, and the model defaults in the code.
Model names are defaults; each can be overridden by the environment variable shown.

## Components

| Layer | Component | Technologies & libraries | Runtime · port | Talks to |
|---|---|---|---|---|
| 1 · Presentation | **Web UI** (app + Demo Mode) | React 19, TypeScript 5.9, Vite 8 (`@vitejs/plugin-react`), MUI 9 + Emotion, D3 7 (graph canvas, model view, quality charts), Mermaid 10.9 (diagrams in Markdown), marked + DOMPurify (sanitized Markdown), framer-motion, lucide-react, react-resizable-panels | Static bundle built on Node 22, served by the backend | Backend API over REST; long runs stream over SSE (`fetch` + stream reader) |
| 2 · API & cross-cutting | **Backend API** | FastAPI, Uvicorn (`uvicorn[standard]`), Pydantic, python-multipart (uploads), python-dotenv | Python 3.12 · :8000 | Every service below |
| | **Sign-in** | FastAPI router; Python `hmac` / `secrets` — HMAC-signed, HttpOnly session cookie; separate Demo Mode sign-in | in-process | Guards the pages only; `/api/*` stays open |
| | **Guardrails** | ASGI middleware for contact-detail redaction (pure Python, regex); scope check on **Claude Haiku 4.5** (`AGENT_SCOPE_MODEL`); web-search gate and domain allow-list (`AGENT_WEB_DOMAINS`) | in-process | Anthropic API (scope check) |
| 3 · AI agents | **Evidence Agent** | Anthropic Python SDK, tool use on **Claude Opus 5** (`EVIDENCE_MODEL` / `RAG_ANSWER_MODEL`); quote verification, computed claim scores; run store in PostgreSQL | in-process · SSE | Agent Runtime, Hindsight |
| | **InsightLens** | Anthropic SDK on **Claude Opus 5** (`FITGAP_MODEL`); one run per BPML step, verifier and synthesis passes; openpyxl for the XLSX export | in-process · SSE | Agent Runtime |
| | **Fit-Gap Copilot** | Anthropic SDK (streaming) on **Claude Opus 5** (`FITGAP_COPILOT_MODEL`); two passes, quality gates, computed scores; exports: WeasyPrint (PDF, needs pango / cairo / gdk-pixbuf), python-docx (Word), openpyxl (Excel), Markdown / JSON | in-process · SSE | Agent Runtime |
| | **Agent Runtime** (shared) | Anthropic Messages API tool-use loop; tools over psycopg (corpus and upload search), the in-memory knowledge graph and BPML hierarchy, `hindsight-client`, and Anthropic's server-side `web_search` tool (**Claude Sonnet 5**, `AGENT_WEB_MODEL`); Pydantic schemas | in-process | RAG Engine, Knowledge Graph, Hindsight, Anthropic API, Web |
| 4 · Application services | **Document Ingestion** | Docling (layout, tables), Tesseract via `tesserocr`, OpenCV + NumPy (table and flow-diagram CV), LibreOffice + Poppler (page previews), Pillow; optional vision model: Qwen3-VL-8B 4-bit via MLX (Apple silicon) or Claude / OpenAI through Docling's VLM pipeline; CPU PyTorch 2.14 under Docling | in-process | Writes Markdown to the Document Corpus; session uploads into PostgreSQL |
| | **Knowledge Graph** | Pure Python: rule- and ontology-based extraction (regex, BPML hierarchy via openpyxl) into a JSON graph; `neo4j` Python driver (≥ 5.20) to load the Neo4j copy; NL → Cypher on **Claude Opus 5** (`CYPHER_MODEL`), checked with `EXPLAIN` in a read transaction | in-process | Document Corpus, Neo4j, Anthropic API |
| | **RAG Engine** | Heading-aware Markdown chunker; embeddings from Ollama (HTTP); psycopg 3 + `pgvector` — HNSW cosine index and PostgreSQL `tsvector` full-text, fused with reciprocal rank fusion; answers streamed from **Claude Opus 5** (`RAG_ANSWER_MODEL`) | in-process | Document Corpus, PostgreSQL, Ollama, Anthropic API |
| 5 · Data & memory | **Document Corpus** | Markdown files on disk (`solvay-spark/*/markdown`, `knowledge_base/`) plus the graph JSON (`data/knowledge_graph.json`) | filesystem / Docker volumes | — |
| | **PostgreSQL + pgvector** | PostgreSQL 18 with the `vector` extension (`pgvector/pgvector:pg18` image); databases `docling` (chunks, vectors, keyword index, run history, evaluation runs) and `docling_session` (one schema per upload) | :5433 locally, :5432 in compose | — |
| | **Neo4j** | Neo4j 5 Community with APOC; read-only copy of the graph | Bolt :7687 · Browser :7474 | — |
| | **Hindsight** (agent memory) | Hindsight API server in its own Python environment, embedded PostgreSQL for storage; its LLM reached through LiteLLM (default `anthropic/claude-opus-5`) | HTTP :8888 · not in compose | Anthropic API via LiteLLM |
| 6 · Evaluation | **RAG Evaluation** | Ragas + `langchain-community` (< 0.4, pinned for Ragas), 12 metrics with **Claude Sonnet 5** as judge (`RAG_EVAL_MODEL`) and bge-m3 embeddings; background thread; 27-question ground-truth experiments | in-process | Anthropic API, PostgreSQL, Langfuse |
| | **Agent Evaluation** | Pure Python, no model call — scores computed from quote checks, quality gates, tool log and guardrails | in-process | Langfuse (scores API) |
| | **Knowledge Graph Evaluation** | Pure-Python structure checks; NL → Cypher execution accuracy (Claude writes, Neo4j runs, rows compared with reference queries) | in-process | Neo4j, Anthropic API, PostgreSQL, Langfuse |
| 7 · Model serving | **Anthropic Claude** | Anthropic Messages API: Opus 5 (answers, agents, Cypher), Sonnet 5 (evaluation judge, web search), Haiku 4.5 (scope check) | HTTPS, cloud | — |
| | **Ollama** | Ollama server running **bge-m3** (1024-dimension embeddings); `ollama-pull` one-shot service fetches the model | HTTP :11434, local | — |
| 8 · External | **Langfuse Cloud** | `langfuse` SDK, `opentelemetry-instrumentation-anthropic` (records every model call), `opentelemetry-instrumentation-threading`; off without `LANGFUSE_*` keys | HTTPS, cloud | — |
| | **Web (allow-listed)** | Anthropic `web_search_20250305` server tool; SAP and EU domains by default | HTTPS, cloud | — |

## Runtime and deployment

| Piece | Technology |
|---|---|
| Container image | Multi-stage Docker build: UI on `node:22-slim`, Docling models on `python:3.12-slim-bookworm`, runtime `python:3.12-slim-bookworm` with LibreOffice, Poppler, Tesseract, Pango/Cairo; CPU PyTorch; runs as a non-root user; health check on `/api/health` |
| Orchestration | Docker Compose: `app`, `postgres` (`pgvector/pgvector:pg18`), `ollama` + `ollama-pull`, `neo4j` (`neo4j:5-community`, APOC) |
| Registry | `reg.ivolve.cloud/ivolve/solvay-spark-spine` (`scripts/docker-publish.sh`, linux/amd64) |
| Local development | `scripts/run.sh` (Uvicorn + Vite), `compose.neo4j.yml` for Neo4j only, `scripts/hindsight.sh` for agent memory |
| Dependency pinning | `constraints.txt` fixes exact Python versions for reproducible builds; `package-lock.json` for the UI |

## Libraries by language

| Language | Libraries |
|---|---|
| Python (backend) | fastapi, uvicorn, pydantic, python-multipart, python-dotenv, docling (+ tesserocr), opencv-python, numpy, pillow, psycopg, pgvector, anthropic, neo4j, openpyxl, python-docx, weasyprint, hindsight-client, ragas, langchain-community, langfuse, opentelemetry-instrumentation-anthropic, opentelemetry-instrumentation-threading, httpx; optional: mlx-vlm |
| TypeScript (UI) | react, react-dom, @mui/material, @emotion/react, @emotion/styled, d3, mermaid, marked, dompurify, framer-motion, lucide-react, react-resizable-panels; build: vite, @vitejs/plugin-react, typescript |
| System packages | LibreOffice, Poppler, Tesseract (+ English data), Pango, Cairo, gdk-pixbuf, libGL (OpenCV) |

`cohere` is still listed in `requirements.txt` but is no longer used: embeddings moved to bge-m3 on Ollama.
