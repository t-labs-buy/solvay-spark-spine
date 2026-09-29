# Running the app and its services

How to start, set up and stop everything Solvay Spark Spine AI depends on. The short version is in the [README](../README.md#run).

## Starting the services

The app is one process, but it leans on several services. `./scripts/run.sh`
starts the ones marked **auto** before the backend, and skips any that are
already running. The rest you start yourself, once per boot.

| Service | Needed for | Started by | Check it is up |
|---|---|---|---|
| Backend (FastAPI) | everything; also serves the built UI | **auto** (`run.sh` itself) | <http://localhost:8000> |
| Postgres + pgvector | Ask RAG, the agents, run history | you | `brew services list` shows it `started` |
| Ollama (`bge-m3`) | embedding questions and documents | you | `curl -s localhost:11434/api/tags` |
| Podman machine | the Neo4j container (Docker works too) | **auto**, if Podman is installed | `podman info` |
| Neo4j | the Cypher view | **auto**, if `NEO4J_PASSWORD` is in `.env` | <http://localhost:7474> |
| Hindsight | Evidence Agent memory (optional) | **auto**, if installed | `curl -s localhost:8888/health` |
| Frontend dev server | only while changing the UI | you | <http://localhost:5173> |
| Langfuse | tracing and scores (optional) | nothing to start: cloud | keys in `.env` |

**Every boot:**

```bash
brew services start postgresql@18
ollama serve &                 # or open the Ollama app; skip if it runs at login
./scripts/run.sh
```

**One-time setup** for each service:

- **Postgres:** `brew install postgresql@18` (it ships pgvector), then set
  `DATABASE_URL` in `.env`. See [Ask RAG](rag.md).
- **Ollama:** install from <https://ollama.com>, then `ollama pull bge-m3`.
- **Neo4j:** install Podman (`brew install podman`, then `podman machine init`)
  or Docker Desktop, and put `NEO4J_PASSWORD=<your choice>` in `.env`. The first
  `run.sh` pulls the image and loads the graph. By hand:
  `docker compose -f compose.neo4j.yml up -d`. See [docs/neo4j.md](neo4j.md).
- **Hindsight:** a separate Python environment in the repository root (git
  ignores it), because its dependencies conflict with Docling's:

  ```bash
  uv venv --python 3.13 hindsight-venv
  uv pip install --python hindsight-venv/bin/python hindsight-api
  ```

  It reads `ANTHROPIC_API_KEY` from `.env`. `run.sh` starts it in the background
  and logs to `hindsight.log`. To run it in the foreground: `./scripts/hindsight.sh`.
  To run without memory: `HINDSIGHT_URL= ./scripts/run.sh`, which neither starts
  the server nor uses it. See [docs/agent-memory.md](agent-memory.md).
- **Frontend:** only to change the UI. See [Setup](../README.md#setup):
  `cd frontend && npm install`, then `npm run dev` or `npm run build`.

**Stopping.** `run.sh` stops only the backend (Ctrl+C). The rest keep running
on purpose, so a backend restart does not take them down:

```bash
docker compose -f compose.neo4j.yml down   # Neo4j; data stays in its volume
pkill -f hindsight-api                     # Hindsight; memories stay in ~/.pg0
podman machine stop
brew services stop postgresql@18
```

## Using the Extract page

Then: **Open document** (or drop a file on the page) → wait for the preview →
**Convert to Markdown**. A timer shows how long the server has been working.
Use **Raw** to see literal Markdown, the copy and download icons to take the
`.md`, and **Add to knowledge base** to make it searchable from the **Ask** tab.
The divider between the panes can be dragged.

The **Extract** and **Ask** tabs keep their state when you switch between them.
The sun/moon button switches between light and dark; it follows your OS setting
on first load and remembers your choice after that. Animations are turned off
when the OS asks for reduced motion.
