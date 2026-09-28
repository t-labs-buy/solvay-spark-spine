# Solvay Spark Spine AI

Solvay's SPARK programme, its move from SAP ECC to S/4HANA, has built up a
large body of knowledge: workshop decks and transcripts, functional specs,
process spreadsheets, interface designs and BPML process maps. Solvay Spark
Spine AI turns that material into something the team can search, question and
reason over. It converts the documents to clean Markdown, indexes them for
question answering, links them into a knowledge graph of streams, processes,
systems and specs, and puts AI agents on top. The agents answer with citations,
gather evidence, and run SAP Fit-to-Standard analysis for country rollouts.

Everything runs locally. Documents stay on the machine unless you ask a
question or choose a cloud vision model (see [Notes](#notes)).

## What it does

It starts as a split-screen tool for checking document extraction quality. Load a
PPTX, DOCX, XLSX, PDF, or a PNG/JPEG image on the left, click **Convert to Markdown**, and see the
extracted Markdown on the right next to the original.

Built on [Docling](https://docling-project.github.io/docling/), with a Tesseract
OCR pass that Docling's Office backends don't provide on their own — embedded
screenshots (scanned tables, diagrams pasted as images) would otherwise come
through empty.

Around the converter sit:

- **Ask RAG** — hybrid (vector + keyword) search over the converted Markdown in
  Postgres/pgvector, with Claude answering from cited excerpts.
- **Agents** — the Evidence Agent, InsightLens and the Fit-Gap Copilot (SAP
  Fit-to-Standard analysis for a country rollout), with shared guardrails.
- **Knowledge Graph** — the Solvay SPARK graph, explorable on a canvas, by
  plain-English question, or with Cypher through Neo4j.
- **Evaluation** — Langfuse tracing, agent quality scores and Ragas judges on
  every Ask RAG answer.

## Project layout

```
backend/            the Python backend, one package per domain
  api/              FastAPI app (app.py), sign-in, Demo Mode
  core/             repository paths, Langfuse tracing, per-session uploads
  ingestion/        documents to Markdown: converter, OCR, vision models, tables, chunking
  rag/              Ask RAG: retrieval store, answer scoring, quality analytics
  graph/            knowledge graph extraction, Neo4j copy, Cypher
  agents/           Evidence Agent, InsightLens (fitgap), Fit-Gap Copilot (rollout),
                    guardrails, agent_eval.py
  tests/            test scripts: .venv/bin/python backend/tests/test_<name>.py
frontend/           React UI (Vite); builds into static/dist/
static/             the built UI the backend serves
data/               knowledge_graph.json and other generated data
docs/               design notes, explainers, eval question sets
scripts/            run.sh (start everything), hindsight.sh, ngrok.sh
```

Command-line tools run as modules from the repository root, e.g.
`.venv/bin/python -m backend.rag.rag categories`.

## Prerequisites

| Dependency | Why | Install |
|---|---|---|
| Python 3.12 | Docling allows 3.10+, but the heavy wheels (torch, tesserocr) lag behind the newest releases | `brew install python@3.12` |
| LibreOffice | Renders the original document for the left pane | `brew install --cask libreoffice` |
| Poppler | `pdftoppm`, splits the render into per-page images | `brew install poppler` |
| Tesseract | OCR for embedded images | `brew install tesseract` |
| Postgres 18 + pgvector | Ask RAG, the agents, run history | `brew install postgresql@18` (ships pgvector) |
| Ollama + `bge-m3` | Embedding questions and documents | <https://ollama.com>, then `ollama pull bge-m3` |
| Node.js 20+ | Only to change the web UI; the built UI in `static/dist/` is served as-is | `brew install node` |

Neo4j (the Cypher view) and Hindsight (Evidence Agent memory) are optional; see
[docs/running-the-app.md](docs/running-the-app.md).

## Setup

```bash
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt
```

Minimum `.env`:

```bash
DATABASE_URL=postgresql://user:password@localhost:5433/docling
ANTHROPIC_API_KEY=...
NEO4J_PASSWORD=...        # optional: enables the Cypher view
```

The web UI is a React app in `frontend/` (MUI components, Lucide icons, Framer
Motion animations). It is already built into `static/dist/`; after changing
anything under `frontend/src`, rebuild it:

```bash
cd frontend
npm install        # once
npm run build      # typecheck + build into ../static/dist
npm run dev        # or: live-reloading UI on http://localhost:5173, API calls go to ./scripts/run.sh on :8000
```

## Run

```bash
brew services start postgresql@18   # skip if it already runs
ollama serve &                      # or open the Ollama app; skip if it runs at login
./scripts/run.sh                    # http://localhost:8000  (PORT=9000 ./scripts/run.sh to change)
```

`run.sh` also starts Podman, Neo4j and Hindsight when they are installed and
configured, and skips anything already running. Sign in with **test** / **test**.

To start the backend services by hand instead, from the repository root:

```bash
podman machine start                               # only if Neo4j runs under Podman
docker compose -f compose.neo4j.yml up -d          # Neo4j (optional: the Cypher view)
nohup sh ./scripts/hindsight.sh >> hindsight.log 2>&1 &   # Hindsight (optional: Evidence Agent memory)
.venv/bin/uvicorn backend.api.app:app --port 8000 --reload --reload-dir backend   # the backend API + UI
```

Ctrl+C stops only the backend; Neo4j and Hindsight keep running. See
[docs/running-the-app.md](docs/running-the-app.md) for how to stop them.

Then: **Open document** (or drop a file on the page) → wait for the preview →
**Convert to Markdown**. Use **Add to knowledge base** to make it searchable
from the **Ask** tab.

From the command line, same engine, no browser:

```bash
.venv/bin/python -m backend.ingestion.pptx_to_md P2P.pptx -o out
.venv/bin/python -m backend.ingestion.folder_to_md solvay-spark          # a whole folder
```

## Documentation

| Topic | Doc |
|---|---|
| Services, one-time setup, stopping | [docs/running-the-app.md](docs/running-the-app.md) |
| Conversion: CLI options, vision models, which engine reads what, image handling, accuracy | [docs/conversion.md](docs/conversion.md) |
| Ask RAG: settings, retrieval, chunking, categories, resetting pgvector | [docs/rag.md](docs/rag.md) |
| Agents: Fit-Gap Copilot, Evidence Agent, session attachments, guardrails | [docs/agents.md](docs/agents.md) |
| Knowledge graph: quality checks, query algorithm | [docs/knowledge-graph.md](docs/knowledge-graph.md) |
| Cypher and Neo4j | [docs/neo4j.md](docs/neo4j.md) |
| Langfuse tracing, agent scores, Ragas answer scoring | [docs/tracing-and-evaluation.md](docs/tracing-and-evaluation.md), [docs/rag-evaluation.md](docs/rag-evaluation.md) |
| Sign-in and Demo Mode | [docs/sign-in-and-demo-mode.md](docs/sign-in-and-demo-mode.md) |
| Architecture and pipeline | [docs/system-diagram.md](docs/system-diagram.md), [docs/pipeline.md](docs/pipeline.md) |

## Tests

```bash
.venv/bin/python backend/tests/test_<name>.py   # e.g. test_rollout, test_guardrails, test_graph_eval
```

## Notes

- **Localhost only.** No auth, no upload limit, no sandboxing of the parsers.
  Add all three before putting this on a network. The sign-in pages are a
  presentation lock, not access control: every `/api/*` endpoint stays open.
- **Data leaves the machine** when asking (question and retrieved excerpts go
  to Anthropic), and when a cloud vision provider (`--vlm-provider openai` or
  `claude`) is chosen for conversion. The default local path sends nothing.
- Each upload leaves its renders in `.workdir/` (~20 MB for a 144-slide deck).
  `DELETE /api/docs/{id}` clears one; the UI doesn't call it, so clear the
  directory manually when it grows.
