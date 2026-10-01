# Deploying on a server

How to build the container image, push it to the registry and run the whole
stack on a Linux server. For running on a Mac, see [running-the-app.md](running-the-app.md).

## What runs where

| Piece | Comes from | Notes |
|---|---|---|
| App (backend + UI + LibreOffice, Poppler, Tesseract) | `reg.ivolve.cloud/ivolve/solvay-spark-spine`, built from `Dockerfile` | port 8000 |
| Postgres 18 + pgvector | `pgvector/pgvector:pg18` | data restored from a dump of the local database |
| Ollama + `bge-m3` | `ollama/ollama` | the `solvay-ollama-pull` service fetches the model once |
| Neo4j | `neo4j:5-community` | the app loads the graph into it at start |
| Hindsight (Evidence Agent memory) | `reg.ivolve.cloud/ivolve/solvay-spark-spine-hindsight`, built from `Dockerfile.hindsight` | its own image: its dependencies conflict with Docling's; stores memories in the `hindsight` database |
| SPARK corpus `solvay-spark/` | copied to the server, mounted read-only | not in the image: it is client data |
| `knowledge_base/` | copied to the server, mounted writable | the BPML hierarchy (`BPML_Process_xlsx.md`) and documents added from the UI; without it the graph has a fraction of its processes |

`compose.yml` wires them together. Every container joins the server's shared `ivolve-network`, which must already exist (`docker network ls | grep ivolve-network`). Other teams' stacks share that network, so every service called by name has a `solvay-` prefix (`solvay-postgres`, `solvay-ollama`, `solvay-neo4j`, `solvay-hindsight`), and the URLs use those names; a generic `postgres` could resolve to another stack's database. Not included:
- **The local MLX vision model.** It runs only on Apple silicon. The Claude and OpenAI vision providers and Tesseract still work.

## 1. Build and push the image (on your machine)

```bash
docker login reg.ivolve.cloud          # GitLab token with write_registry
./scripts/docker-publish.sh            # builds linux/amd64, pushes :<commit> and :latest
./scripts/docker-publish.sh hindsight  # the memory server's image; only when Dockerfile.hindsight changes
```

The image is about 3–4 GB. On an Apple-silicon Mac the amd64 build runs under
emulation and takes 20–40 minutes the first time. `.dockerignore` keeps `.env`,
`backup/`, `solvay-spark/`, `.workdir/` and the virtualenvs out of the image.

## 2. Export the database (on your machine)

```bash
./scripts/db-export.sh                 # writes backup/spark-<date>.dump
```

## 3. Set up the server

The server needs Docker with the compose plugin.

```bash
mkdir -p ~/solvay-spark-spine && cd ~/solvay-spark-spine
# from your machine:
#   scp compose.yml .env.example server:~/solvay-spark-spine/
#   rsync -a solvay-spark/ server:~/solvay-spark-spine/solvay-spark/
#   rsync -a knowledge_base/ server:~/solvay-spark-spine/knowledge_base/
#   scp backup/spark-<date>.dump server:~/solvay-spark-spine/
cp .env.example .env                   # fill it in; change every sign-in value
docker login reg.ivolve.cloud          # a token with read_registry is enough here
docker compose pull
docker compose up -d solvay-postgres solvay-ollama solvay-ollama-pull solvay-neo4j
```

## 4. Restore the database

The dump holds the Ask RAG index (the `bge-m3` embeddings) and run history. Restore it before the app first starts:

```bash
docker compose exec -T solvay-postgres pg_restore -U spark -d solvay --no-owner --no-acl < spark-<date>.dump
```

`pg_restore` may warn that the `vector` extension already exists. That is harmless.

## 5. Start the app

```bash
docker compose up -d solvay-hindsight-db solvay-hindsight app
docker compose logs -f app             # wait for "Application startup complete"
curl -s localhost:8000/api/health      # soffice and pdftoppm should both be set
```

Then open `http://<server>:8000` and sign in with the `APP_USERNAME` / `APP_PASSWORD` from `.env`.

## Updating

```bash
./scripts/docker-publish.sh            # on your machine
docker compose pull app && docker compose up -d app    # on the server
```

To pin a version, set `TAG=<commit>` in the server's `.env`.

When the corpus or `knowledge_base/` changes on your machine, copy it again
with the `rsync` lines from step 3 and rebuild the graph:

```bash
curl -s -X POST localhost:8000/api/graph/rebuild >/dev/null    # on the server (use your APP_PORT)
```

The graph's counts on the Knowledge Graph page should then match your
machine's. If they do not, compare the two folders first: the graph is built
from `solvay-spark/*/markdown`, `knowledge_base/` and the database's index,
and a file missing from any of them changes the counts.

## Security

- **The API is open.** The sign-in guards the pages only. Every `/api/*` endpoint answers without it (see `backend/api/app_login.py`). Do not publish port 8000 to the internet as it is:
  - Put it behind a reverse proxy with TLS and real authentication, or a VPN or IP allowlist.
  - Or set `APP_PORT=127.0.0.1:8000` and reach it through the proxy only.
- **Set sign-in secrets.** Set `APP_SECRET` and `DEMO_SECRET`, and replace the default passwords.
- **Data leaves the server** as it does locally. Questions and retrieved excerpts go to Anthropic, and so do documents converted with a cloud vision provider.
- **Nothing is published except the app.** Postgres, Ollama, Neo4j and Hindsight publish no ports; they are reachable only from containers on `ivolve-network`.

## Volumes

| Volume | Holds |
|---|---|
| `pgdata` | the database |
| `ollama` | the `bge-m3` model |
| `neo4j-data` | the Neo4j copy of the graph |
| `workdir` | uploads and renders (`.workdir/`, about 20 MB per large deck, never cleaned automatically) |
| `graph-data` | `data/`. It is seeded from the image on first start, and graph rebuilds rewrite `knowledge_graph.json`. After an image update that changes `data/`, remove this volume to take the new files. |
