# 02 — HTTP API Layer and Core Services

Scope: `backend/api/app.py` (3288 lines), `backend/api/app_login.py`, `backend/api/demo_mode.py`, `backend/core/{tracing,uploads,paths}.py`, `backend/agents/guardrails/middleware.py` (read because app.py installs it), docs `sign-in-and-demo-mode.md`, `tracing-and-evaluation.md`.
Convention: **FACT (file:line)** = read in source; **INFERRED** = deduced, not literally stated. Paths below are relative to repo root; `app.py` = `backend/api/app.py`.

---

## 1. Paths and constants

| Name | Value | Source |
|---|---|---|
| `ROOT` | `Path(__file__).resolve().parents[2]` (repo root) | FACT core/paths.py:10 |
| `DATA` | `ROOT/"data"` | FACT paths.py:11 |
| `KNOWLEDGE_GRAPH` | `ROOT/"data"/"knowledge_graph.json"` | FACT paths.py:12 |
| `BASE` | `ROOT` | FACT app.py:50 |
| `WORKDIR` | `ROOT/".workdir"` — per-upload jobs `<doc_id>/`, batches `batches/<batch_id>/`, attachments `uploads/<sid>/` | FACT app.py:51, uploads.py:59 |
| `STATIC` / `DIST` | `ROOT/"static"`, `ROOT/"static"/"dist"` (Vite build output) | FACT app.py:52-54 |
| `KNOWLEDGE_BASE` | `ROOT/"knowledge_base"` — Markdown added from the UI (kept outside .workdir) | FACT app.py:58 |
| `ACCEPTED` | `{.pptx,.ppt,.docx,.doc,.xlsx,.xlsm,.xls,.pdf,.html,.htm,.xml,.txt,.csv,.json,.msg,.eml} ∪ preview.IMAGE_FORMATS` | FACT app.py:70-72 |

Per-upload job dir layout (FACT app.py:183-190, 228, 310-331): `.workdir/<doc_id>/source.<ext>`, `name.txt` (original filename), `preview/page-N.png` (via `preview.render` / `preview.page_path`), `media/` (extracted images), `output.md`. `doc_id = uuid4().hex[:12]`; KB-opened originals use `doc_id = "kb" + sha256(str(original))[:10]` (FACT app.py:774).
Batch layout (FACT app.py:1166-1170, 1348): `.workdir/batches/<batch_id>/sources/`, `markdown/<stem>_<ext>.md`, `batch_<id>_markdown.zip`.
Path-traversal guard `_job_dir`: resolve and require `WORKDIR.resolve()` in `job.parents`, else 404 "Document not found" (FACT app.py:112-117). Same pattern for batches (1206-1208).

---

## 2. App construction

- `app = FastAPI(title="Docling Extraction UI", lifespan=lifespan)` (FACT app.py:98). Launched by `uvicorn backend.api.app:app` — dev: `scripts/run.sh` → `.venv/bin/uvicorn backend.api.app:app --port ${PORT:-8000} --reload --reload-dir backend` (FACT scripts/run.sh:46); container: `uvicorn backend.api.app:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips *`, `HEALTHCHECK curl -fsS http://127.0.0.1:8000/api/health` (FACT Dockerfile:85-88). Single process, no `--workers` (FACT). run.sh also best-effort starts Hindsight (127.0.0.1:8888) and Neo4j via `compose.neo4j.yml` before uvicorn (FACT run.sh).
- **Lifespan** (FACT app.py:74-95): on startup `print(tracing.start())` (eager Langfuse auth check, one log line), then `kg_neo4j_load.sync_in_background()` (daemon thread loading the KG into Neo4j, retrying on `ServiceUnavailable` every 5 s up to 120 s; no-op if Neo4j not configured — FACT backend/graph/kg_neo4j_load.py:249-274). On shutdown: `tracing.shutdown()`, then `backend.agents.fitgap.memory.close()` in try/except.
- No `@app.on_event`, no CORS middleware, no SessionMiddleware, no exception handlers registered (FACT — grep of app.py found none). INFERRED: SPA served same-origin so CORS not needed.
- **Middleware stack** (registration order):
  1. `app.add_middleware(RedactContactDetails)` (FACT app.py:103-105) — pure ASGI class (FACT guardrails/middleware.py). Applies only to paths starting with `/api/evidence`, `/api/fitgap`, `/api/rollout`, `/api/ask`, `/api/quality`. For responses whose content-type (before `;`) is in `application/json, text/event-stream, text/markdown, text/plain, text/csv`, it holds the `http.response.start` message until the first body chunk, runs `contact.redact(body.decode("utf-8", errors="replace"))` on **each body chunk** independently, drops `content-length`, re-adds it only if `more_body` is false. Binary responses (PDF/XLSX/DOCX) pass through unchanged — hence endpoints call `contact.redact_obj(run)` before rendering binaries (FACT app.py:2582-2584, 2622-2624, 2665-2668, 2979-2981). `contact.py` redacts e-mails (regex `EMAIL`) and phone numbers (candidate + cue words, excludes dates/time ranges/dotted version numbers) (FACT guardrails/contact.py:40-58, details owned by another section).
  2. `app_login.install(app)` called at the very end, after every page route is declared (FACT app.py:3286) → adds `@app.middleware("http") require_sign_in` (FACT app_login.py:122-133). INFERRED: as the last-added middleware it is the outermost layer.
- **Routers**: `app.include_router(demo_mode.router)` (FACT app.py:146-148), `app.include_router(app_login.router)` (FACT app.py:152-154). Both included before `/` is declared.
- **Static**: `app.mount("/assets", _ImmutableAssets(directory=DIST/"assets", check_dir=False), name="assets")` — `StaticFiles` subclass overriding `file_response` to set `Cache-Control: public, max-age=31536000, immutable` (FACT app.py:3271-3288). `check_dir=False` so API starts before first frontend build.
- **HTML entry points**: three Vite inputs `main: index.html`, `demo: demo.html`, `login: login.html` (FACT frontend/vite.config:13) → built to `static/dist/{index,demo,login}.html`.
  - `_spa()` returns `static/dist/index.html` with `Cache-Control: no-cache`; if missing returns 503 HTML "The web UI has not been built. Run `cd frontend && npm install && npm run build`, then reload." (FACT app.py:127-140). The SPA reads `location.pathname` to choose the screen (FACT comment app.py:157).
  - login page → `static/dist/login.html` (FACT app_login.py:54); demo → `static/dist/demo.html` (FACT demo_mode.py:53). Both 503 with a "not been built" message when missing, both served with `Cache-Control: no-cache`.

### Concurrency model
- All heavy endpoints are plain `def` → FastAPI runs them in the Starlette threadpool (FACT comment app.py:107-109). SSE endpoints return `StreamingResponse` over **sync generators**, which Starlette iterates in the threadpool (FACT app.py:1700-1701).
- No `BackgroundTasks`, no job queue, no Celery (FACT comment app.py:1588-1595). Deferred work = **daemon `threading.Thread`**:
  - Ask answer judging: `threading.Thread(target=_judge, args=(run_id, force), name=f"ask-eval-{run_id}", daemon=True)` (FACT app.py:1659-1660).
  - Session upload: per file a worker thread runs `uploads.add_file`, forwarding stage events via a `queue.Queue` to the generator (FACT app.py:2021-2043). Sentinel `("__end__", {})`.
  - Neo4j sync: daemon thread (FACT kg_neo4j_load.py:249).
  - Graph question-check: `graph_eval.start_questions()` returns an id, runs in background (FACT app.py:494-506; internals elsewhere).
  - INFERRED: Fit-Gap/Rollout orchestrators spawn their own worker threads (comment app.py:1591 references rollout/orchestrator.py).
- DB connections: thread-local psycopg connections; workers must close their own (`rag.close()` in `_judge` finally, app.py:1640; `fg_uploads.close()` in upload worker, app.py:2035). `fg_store.connect()` / `ro_store.connect()` are "shared; not ours to close" (FACT comments app.py:1818, 2146).

### SSE format
Every SSE helper: `f"event: {event}\ndata: {json.dumps(data)}\n\n"` (agent streams use `json.dumps(data, default=str)`). Headers on most streams: `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `media_type="text/event-stream"` (FACT e.g. app.py:1327-1331). `/api/kb/batch-insert` omits the extra headers (FACT app.py:1155). Errors inside a stream are emitted as `event: error` with `{"message": ...}` rather than HTTP errors (validation errors before the stream starts are raised as HTTPException).

---

## 3. Authentication

### 3a. Application sign-in (`app_login.py`) — FACT throughout
- Env: `APP_LOGIN` (default `"on"`; `off`/`0`/`false` disables), `APP_USERNAME` (default `test`), `APP_PASSWORD` (default `test`), `APP_SECRET` (default `secrets.token_hex(32)` per process → restart signs everyone out), `APP_SESSION_HOURS` (default 12; `int(float(h)*3600)` seconds) (app_login.py:46-50).
- Cookie `app_session` (app_login.py:51). Token format `"{user}|{expires_epoch_int}|{hexsig}"`, `sig = HMAC-SHA256(SECRET, f"app|{user}|{expires}")` — purpose prefix `app|` prevents replay of demo tokens (app_login.py:59-67). Validation: split on `|` into exactly 3, `hmac.compare_digest`, reject if `expires < now` (70-83). No server-side session store; stateless.
- `check()` compares both username and password with `hmac.compare_digest` always (86-91). Login strips username whitespace (154).
- Cookie set: `max_age=SESSION_SECONDS, httponly=True, samesite="lax", path="/"`; no `secure` flag (157-158).
- **Gate**: `page_paths(app)` = every `APIRoute` with GET, `response_class is HTMLResponse`, path not starting with `/demo` and not `/login` (108-119). Middleware: if `GET` and path ∈ gated and not signed in → `303` to `/login?next=<quote(path?query)>` (128-133). **`/api/*` is NOT gated** (doc + 9-14). `/assets` not gated.
- `safe_next`: only paths starting `/`, not `//`, not starting with `/login`, no `\`; else `/` (98-105).
- Disabled mode: `signed_in()` always true; `/api/app/session` returns `{"user": null, "enabled": false}` 200.

### 3b. Demo Mode (`demo_mode.py`) — FACT throughout
- Env: `DEMO_USERNAME`/`DEMO_PASSWORD` default `solvay`/`solvay`, `DEMO_SECRET` random per process, `DEMO_SESSION_HOURS` 12 (47-50). Cookie `demo_session` (51). Signature `HMAC-SHA256(SECRET, f"{user}|{expires}")` (no purpose prefix) (58-59). Same token format/validation/cookie attributes as app login. Cannot be disabled (no flag).
- `GET /demo/login`: signed in → 303 `/demo`; else serve `demo.html` (104-110). `GET /demo` and `/demo/{rest:path}`: not signed in → 303 `/demo/login?next=<quote("/demo"+("/"+rest))>`; else serve `demo.html` (113-119). Note: demo login GET does not consume `next` server-side (INFERRED: the demo frontend reads `next`).
- Independence: a demo session does not sign in to `/` and vice versa (app_login.py:3-5). Demo pages call the same open `/api/*`.
- Demo UI behaviour (FACT docs/sign-in-and-demo-mode.md): opens on Spark AI Spine landing page; header tabs only **Knowledge Graph** and **Fit-Gap Copilot**; **Ask RAG** and the **Agent** in a sidebar minimized to icons (menu button expands/minimizes; can be hidden entirely; state remembered in browser). Excluded from Demo: Convert, Batch Convert, Add to knowledge base, Coverage, Doc vs MD, MD Viewer, InsightLens, RAG Metrics — their `/demo/...` URLs land on the introduction. Bundle `frontend/demo.html` + `frontend/src/demo/`, reusing app page components. Rollout exports use `client=1` from Demo to omit model name (FACT app.py:2655-2656).

---

## 4. Endpoint inventory

Auth column: **Page-gated** = app_login cookie gate (when `APP_LOGIN` on); **Demo-gated** = demo cookie; **Open** = no auth. All `/api/*` are Open. Redact = RedactContactDetails applies (prefix match).

### 4a. Auth routers

| Method | Path | Auth | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|---|
| GET | `/login` | Open | query `next="/"` | signed-in → 303 safe_next(next); else login.html (503 if unbuilt) | — | app_login.py:141 |
| POST | `/api/app/login` | Open | JSON `{username:str,password:str}` | 200 `{user}` + Set-Cookie `app_session`; 401 `{"detail":"Incorrect username or password."}` | — | :152 |
| POST | `/api/app/logout` | Open | — | `{ok:true}`, delete cookie | — | :162 |
| GET | `/api/app/session` | Open | cookie | `{user, enabled:true}` or 401 `{user:null, enabled:true}`; disabled → `{user:null, enabled:false}` | — | :169 |
| GET | `/demo/login` | Open | cookie | 303 `/demo` or demo.html | — | demo_mode.py:104 |
| GET | `/demo`, `/demo/{rest:path}` | Demo-gated | — | demo.html or 303 to `/demo/login?next=` | — | :113-114 |
| POST | `/api/demo/login` | Open | JSON `{username,password}` | `{user}` + Set-Cookie `demo_session`; 401 detail | — | :122 |
| POST | `/api/demo/logout` | Open | — | `{ok:true}`, delete cookie | — | :132 |
| GET | `/api/demo/session` | Open | cookie | `{user}` or 401 `{user:null}` | — | :139 |

### 4b. SPA page routes (all GET, `response_class=HTMLResponse`, return `_spa()`, Page-gated)
`/` (158), `/convert` + `/extract` (343-344), `/quality` (349), `/ask` (354), `/md-viewer` + `/viewer` (359-360), `/batch` (365), `/coverage` (370), `/review` + `/doc-md-viewer` (375-376), `/about` + `/landing` (381-382), `/add-kb` + `/add-to-knowledge-base` (387-388), `/graph` + `/knowledge-graph` (393-394), `/fit-gap` + `/fitgap` (1793-1794), `/rollout` + `/fit-to-standard` (2326-2327), `/evidence` + `/investigate` (2702-2703). (FACT, line numbers in app.py.) Static: `/assets/*` (3288).

### 4c. Document conversion (single document)

| Method | Path | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/health` | — | `{ok:true, preview_available:bool, soffice:path|null, pdftoppm:path|null}` | `preview.available/find_soffice/find_pdftoppm` | 163 |
| POST | `/api/upload` | multipart `file` | `{id, filename, format, size, pages, warning}` ; 400 unsupported suffix | writes `.workdir/<id>/source.<ext>`, `name.txt`; `preview.render(src, job/"preview")` (failure → `warning`, not error) | 174 |
| POST | `/api/convert/{doc_id}` | query `vlm:bool=false`, `provider:str="qwen"` (must be in `converter.VLM_PROVIDERS`, else 400) | `{markdown, vlm_notice, pages, unit, pictures, skipped_images, vlm_images, flows, flow_images, table_images, cv_flow_images, elapsed(2dp), ocr:[{page,image,confidence(1dp),chars}]}`; 500 "Conversion failed: …" | `converter.convert(src, media_dir=job/"media", use_vlm, vlm_provider, title=stem(name.txt))`; writes `output.md`. `vlm_notice` = "`<KEY_ENV>` is not set on the server…" when vlm and provider≠qwen and `vlm_api.available(provider)` false | 210 |
| POST | `/api/docs/{doc_id}/embed` | query `category:str?` | `rag.index_path` result + `duplicates:[path]`, `documents`, `total_chunks`, `seconds`(1dp), `file` (relative); 409 "Convert the document first"; 400 on SystemExit (missing setting); 500 "Embedding failed" | copies to `knowledge_base/<stem>_<ext>.md` (with `rag.declare_category` front matter if category); `rag.index_path(dest, category)` → Postgres insert; `rag.duplicate_sources`, `rag.counts` | 264 |
| GET | `/api/docs/{doc_id}/preview/{number:int}` | — | PNG FileResponse; 404 | `preview.page_path` | 308 |
| GET | `/api/docs/{doc_id}/media/{name}` | — | FileResponse (basename only); 404 | — | 316 |
| GET | `/api/docs/{doc_id}/download` | — | `output.md` as `text/markdown`, filename `<stem>.md`; 404 | — | 324 |
| DELETE | `/api/docs/{doc_id}` | — | `{ok:true}` | `rmtree` job dir | 334 |

### 4d. Knowledge graph & Neo4j

| Method | Path | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/graph/data` | query `categories: list[str]?` (repeatable) | graph dict minus `passages` key | `knowledge_graph.extract_graph(force=False)` → `filter_by_categories` | 399 |
| POST | `/api/graph/rebuild` | query `categories?` | same shape | `extract_graph(force=True)` (rewrites `data/knowledge_graph.json` — INFERRED), `kg_neo4j_load.sync_in_background()` | 415 |
| POST | `/api/graph/cypher/generate` | JSON `CypherQuestion{question: str 3..2000}` | `kg_nl2cypher.generate(q)` result (Cypher text, EXPLAIN-checked, not executed); 503 if Neo4j not configured or `anthropic.AuthenticationError` ("…ANTHROPIC_API_KEY in .env"); 502 RuntimeError / APIStatusError | Claude call | 439 |
| GET | `/api/graph/neo4j/status` | — | `{**kg_neo4j_load.status(), questions: kg_nl2cypher.QUESTIONS}` | — | 462 |
| GET | `/api/graph/quality` | — | `{structure: graph_eval.latest("structure"), questions: latest("questions"), reviewed: bool}`; 503 on exception | — | 472 |
| POST | `/api/graph/quality/structure` | — | `graph_eval.run_structure()` (no model call) | writes eval result (INFERRED) | 486 |
| POST | `/api/graph/quality/questions` | — | `{id}`; 503 not configured; 409 RuntimeError (already running) | `graph_eval.start_questions()` background | 494 |
| POST | `/api/graph/neo4j/sync` | query `force:bool=false` | `kg_neo4j_load.load(force)`; 503 | replaces Neo4j contents | 509 |
| POST | `/api/graph/cypher` | JSON `CypherRequest{query:str 1..20000, params:dict={}, limit:int=200}` | `kg_neo4j_load.query(...)` (READ txn, row cap, timeout); 503 not configured / driver missing / `ServiceUnavailable` ("Start it with: docker compose -f compose.neo4j.yml up -d"); 400 `{code,message}` on `Neo4jError` | — | 523 |
| GET | `/api/graph/model` | query `categories?` | `graph_model.load_model(filtered_graph)` (Neo4j Data Importer model); 404 FileNotFound; 500 | — | 550 |
| POST | `/api/graph/query` | JSON `GraphQueryRequest{query:str="", source_id?:str, target_id?:str}` | `knowledge_graph.query_graph(...)` | — | 582 |

### 4e. Knowledge-base files & coverage

| Method | Path | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|
| POST | `/api/kb/files/open` | query `source:str` (path rel. to BASE or abs) | `{id, filename, format, size, pages, warning, markdown_source, from_upload?:true}`; 400 outside project; 404 no such doc / no original (`detail:{message}`) | Finds original via `_original_of` (see §8); if original is an upload job's `source.*`, reuses that job id; else creates `.workdir/kb<hash10>/source.<ext>` (re-copies if source mtime newer, clearing preview), writes `name.txt`, renders preview if not already | 716 |
| GET | `/api/coverage` | query `documents:bool=true` | `rag.coverage.collect(include_documents=…)` (read-only) | — | 804 |
| GET | `/api/kb/files` | — | `list[{name,title,source(rel),full_path,size,category,chunks,tokens,is_indexed,indexed_at(iso|null)}]` sorted indexed-first then title | `rag.documents()` (DB, errors swallowed) + unindexed `*.md` in `knowledge_base/` and `solvay-spark/pkg/markdown/` (skip names starting `.`/`~$`; category via `rag.category_for`) | 818 |
| GET | `/api/kb/files/{filename}` | query `source?` | Markdown FileResponse; 404 | Lookup order: explicit `source` (abs then BASE-relative, must be under BASE) → `knowledge_base/<name>` → each `rag.CATEGORIES[*].folder` → `solvay-spark/{pkg,dr}/markdown/` → `rag.find_document(name)` / `name+".md"` | 900 |
| DELETE | `/api/kb/files/{filename}` | query `category?`, `source?` | `{status:"deleted", filename, deleted_from_db, documents_deleted, category, remaining, file_removed}`; 409 `{message, matches:[{category,title,source}]}` if >1 match and no disambiguator; 400 bad category; 404 `{message,matches}` / "Nothing to delete…"; 500 DB error | `rag.delete_document(name, category, source)`; unlinks `knowledge_base/<name>` only if no indexed doc of that name remains | 950 |
| POST | `/api/kb/batch-insert` | multipart `files: list[UploadFile]`, form `category?` | **SSE**: `progress{type:"start",index,total,filename}`, `file_done{type:"done",index,total,filename,title,status,category,chunks,tokens,duplicates}`, `file_error{type:"error",…,error}`, `complete{total,succeeded,failed,total_chunks,total_tokens,total_documents_in_db,total_chunks_in_db,seconds}`, `error{message}`. Pre-stream 400s: no files, bad category, missing `DATABASE_URL`, no `.md/.markdown/.txt` | writes `knowledge_base/<name>` (no category front matter here — FACT, unlike batch embed), `rag.index_path(dest, category)` | 1024 |

### 4f. Batch conversion

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| POST | `/api/batch/upload` | multipart `files` | `{batch_id, total, files:[{name,format,size}]}`; 400 none/no supported (silently skips unsupported/hidden) | writes `.workdir/batches/<id>/sources/<name>`; creates `markdown/` | 1161 |
| POST | `/api/batch/convert/{batch_id}` | JSON `BatchConvertRequest{vlm:bool=false, provider:str="claude"}` | **SSE**: `progress{type:start,index,total,filename}`, `file_done{type:done,index,total,filename,dest_name,markdown,tools:{primary_engine,format,vlm_used,vlm_provider,claude_vlm_images,vlm_images,tesseract_ocr_images,table_cv_tables,flowcharts,skipped_images,total_pictures,pages_or_sheets,unit,elapsed,markdown_length}}`, `file_error{…,error}`, `batch_done{type,total,converted,failed,download_url:"/api/batch/<id>/download"}`; 404 batch/sources missing | `convert()` per file with temp media dir; writes `markdown/<stem>_<ext>.md`. `primary_engine` strings by suffix: xlsx/xlsm/xls "openpyxl (xlsx_tables.py)", xml "xml.etree.ElementTree (xml_tables.py)", html/htm "Docling Native Engine (HTML)", pdf "Docling Native Engine (PDF)", docx/doc "Docling Native Engine (OOXML Word)", pptx/ppt "Docling Native Engine (OOXML PPT) + pptx_flow", else "PIL / Image Processor" | 1204 |
| GET | `/api/batch/{batch_id}/download` | — | zip FileResponse `converted_markdown_<id>.zip`; 404s | writes `batch_<id>_markdown.zip` (ZIP_DEFLATED) | 1334 |
| POST | `/api/batch/{batch_id}/embed` | query `category?` | **SSE**: `progress`, `file_done` (as kb batch-insert), `file_error`, `batch_done{type,total,succeeded,failed,total_chunks,total_tokens,db_documents,db_chunks,seconds}`, `error{type:"error",error}`; 404s; 400 missing DATABASE_URL / bad category | copies each md to `knowledge_base/` with `declare_category` front matter if category; `rag.index_path` | 1360 |

### 4g. RAG / Ask

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/rag/chunk/{chunk_id}` | chunk id like `PKG:412` | `{n:0,title,section,content,category,score:0,similarity:null,bm25:null,vector_rank:null,keyword_rank:null,file,source_path,tokens}`; 404 | `rag.chunk(id)` | 1495 |
| GET | `/api/rag/status` | — | `{missing:[ANTHROPIC_API_KEY?,DATABASE_URL?], embed_model, embed_provider:"ollama", embed_dimension, answer_model, default_k, documents, chunks, categories:[{…describe(code), documents, chunks}], ingest_categories:[…all registered + held], prompt_hash, tracing:tracing.status(), evaluation:evaluation.status()|{enabled:false,available:false,detail}, error}` | read-only | 1524 |
| POST | `/api/ask` | JSON `Question{question:str 1..2000, k:int=rag.DEFAULT_K (1..20), mode:str="hybrid" (∈rag.MODES else 400), categories:list[str]=[]}` | **SSE** (Redact): first `run{id}` or `run{id, not_saved}`; then pass-through of `rag.ask_events` events: `stage` (may carry `terms`), `trace{id}`, `sources`, `token` (string), `done` (may carry `refused`), and `error{message}` | `ask_store.connect/create_schema/start_run({id:"ask_<hex10>",question,mode,k,categories,answer_model,embed_model,corpus_fingerprint,prompt_hash})`; `save_trace` on `trace`; `save_sources(conn,id,data,terms)` on `sources`; `finish_run(conn,id,answer,data)` on `done`; if `refused` → `_record_unscored` (status skipped, "Not scored: the question was outside this assistant's scope…"), else `_start_judging(run_id)` daemon thread; on exception `fail_run`. All bookkeeping wrapped by `_try` (swallow) | 1697 |
| GET | `/api/ask/runs` | query `limit=50` (clamped 1..200), `search=""`, `quality=""` (∈ `ask_store.QUALITY_FILTERS`: low, unfaithful, unsafe, unscored) | `{runs, retention: ask_store.RETENTION, filters, low_quality_below: ask_store.LOW_QUALITY}` | — | 3039 |
| GET | `/api/ask/runs/{run_id}/evaluation` | — | stored evaluation or `{run_id,status:"none",error:""|why,metrics:{},overall:null,safety:null,terms:{}}`; statuses none/running/done/failed/skipped/abandoned; 404 | — | 3057 |
| POST | `/api/ask/runs/{run_id}/evaluation` | — | `{status:"running", run_id, judge_model}`; 404; 409 not done / already running; 503 unavailable / could not start | `_start_judging(run_id, force=True)` | 3077 |
| GET | `/api/ask/runs/{run_id}` | — | run + `corpus_changed:bool` (fingerprint differs now), `evaluation`, `review`; 404 | — | 3103 |
| POST | `/api/ask/runs/{run_id}/review` | JSON `Review{verdict:str, reviewer:str≤120="", note:str≤2000=""}` | `{status:"saved", run_id, **review}`; 404; 400 bad verdict (ValueError from store) | `ask_store.save_review`; if run has `trace_id` and Langfuse on → `lf.create_score(name="human_grounded", value=verdict, trace_id, data_type="CATEGORICAL", comment=note|None, score_id=evaluation.score_id(run_id,"human_grounded"))` + flush | 3132 |
| DELETE | `/api/ask/runs/{run_id}` | — | `{status:"deleted", id}`; 404 | `ask_store.delete_run` | 3253 |
| DELETE | `/api/ask/runs` | — | `{status:"cleared", removed:int}` | `ask_store.clear` | 3262 |

**Judging thread `_judge(run_id, force)`** (FACT app.py:1598-1640): new `ask_store.connect()`, `create_schema`, `get_run`; `start_evaluation(conn, id, evaluation.MODEL)`; if not force and `not evaluation.wanted()` (sampling) → `finish_evaluation` status `skipped`, error `"Not scored: sampling is at {SAMPLE:g}."`; else contexts = `[s.content for s in run.sources]` (rank order preserved), `evaluation.evaluate(question, contexts, answer)`, `push_scores(trace_id, run_id, result)` (errors swallowed), `finish_evaluation(conn, id, result, pushed)`; on exception `fail_evaluation(conn,id,"Type: msg")`; finally `rag.close()`. `_start_judging` returns False if `evaluation.available()` is false.

### 4h. Answer Quality workspace (all Redact; `days` clamped 1..365 by `_window`)

| Method | Path | Request | Response | Src |
|---|---|---|---|---|
| GET | `/api/quality/overview` | `days=28, half="", mode=""` | `quality.overview(ask_store.connect(), days, half_, mode)` | 3174 |
| GET | `/api/quality/explorer` | same | `quality.explorer(...)` | 3181 |
| GET | `/api/quality/judge` | — | `quality.judge(conn)` | 3188 |
| GET | `/api/quality/experiments` | — | `{experiments: experiment_store.list_experiments(conn)}` | 3195 |
| GET | `/api/quality/experiments/compare` | `base`, `cand` (required) | `quality.compare(b,c)`; 404 | 3204 |
| GET | `/api/quality/experiments/{experiment_id}/items/{item_id}` | — | `{**item, experiment:{id,name,config}}`; 404 | 3217 |
| POST | `/api/quality/experiments/{experiment_id}/baseline` | — | `{status:"baseline", id}`; 404 | 3231 |
| DELETE | `/api/quality/experiments/{experiment_id}` | — | `{status:"deleted", id}`; 404 | 3242 |

### 4i. InsightLens (`/api/fitgap`, Redact)

Body model `FitGapRun` (FACT 1675-1687): `mode:str="A"`, `scope_bpml:str="4.0"`, `country_profile:dict?`, `asis_dir:str?`, `holdout:bool=false`, `max_steps:int=6 (1..60)`, `concurrency:int=3 (1..8)`, `question:str?`, `categories:list[str]=[]`, `upload_session:str?`. Converted to `backend.agents.fitgap.schemas.RunRequest` with categories validated by `rag.check_category` (400 on ValueError).
`FitGapReview`: `reviewer:str 1..120`, `verdict:str`, `corrected_classification:str?`, `comment:str=""`.

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/fitgap/status` | — | `{bpml: bpml.stats(), model, prompt_hash, max_tool_calls, anthropic_key:bool, runs, entries, reviews, error, documents, chunks, categories:[{code,documents,chunks}], corpus_error?, graph: stats|null, uploads:{ttl_hours,max_files,accepted,database}}` | `fg_store.create_schema`; **sweeps expired upload sessions** if session DB live | 1799 |
| GET | `/api/fitgap/scope` | query `q=""`, `code=""` | code → `{process, ancestry:[brief], children:[full], steps:int}` (404 if not BPML); q → `{query, matches:[{…full, steps}]}` (limit 10); neither → `{roots:[{…full, steps}]}` | — | 1856 |
| POST | `/api/fitgap/preview` | `FitGapRun` | `orchestrator.preview(RunRequest)`; 400 if `error` | — | 1895 |
| POST | `/api/fitgap/run` | `FitGapRun` | **SSE**: events from `orchestrator.run`: `scope`, `step_start`, `tool_call`, `entry`, `verify_fail`, `synthesis`, `done`; `error{message}` | persists run (in orchestrator — INFERRED) | 1910 |
| GET | `/api/fitgap/runs` | `limit=40` | `fg_store.list_runs(conn, limit)` | — | 2142 |
| GET | `/api/fitgap/runs/{run_id}` | — | run dict incl. `entries`; 404 | — | 2151 |
| GET | `/api/fitgap/runs/{run_id}/export` | `format=md|json|xlsx` (else 400) | json: `{run(sans entries), entries, synthesis}` attachment `fitgap_<id>.json`; md: `synthesis.to_markdown(run, results, synth)` `fitgap_<id>.md`; xlsx: workbook (sheets Register, Reuse, Gaps, Decisions, Integrations, Agenda, Review; bold header, frozen row 1, wrap/top alignment, col width 12..60) `fitgap_<id>.xlsx` | synth = stored `run.synthesis` or `synthesis.synthesise(results)` | 2162, 2195 |
| POST | `/api/fitgap/entries/{entry_id:int}/review` | `FitGapReview` | `fg_store.add_review(...)`; 404 | **direct SQL** `SELECT 1 FROM fitgap_entries WHERE id = %s`; insert review | 2260 |

XLSX column specs (FACT 2220-2248): Register `[BPML, Step, Class, Confidence, Materiality, Status, Rationale, Tickets, SAP objects, Evidence(count), Docs(sorted set), Verified(yes/no)]`; Reuse `[Process, Steps, Fit, Gap, Unknown, Reuse %, Avg confidence]` from `synth.reuse.by_process`; Gaps `[BPML, Step, Class, Confidence, Materiality, Tickets, Rationale]`; Decisions `[Process, Question, Options, Consequence, Raised by, Weight]`; Integrations `[System, Steps, Impacts("kxv"), Interfaces]`; Agenda `[#, Process, Minutes, Weight, Steps, Gaps, Unresolved, Decisions, Pre-read]`; Review `[Entry id, BPML, Step, Proposed class, Confidence, Reviewer, Verdict (accept/reject/refine), Corrected class, Comment]` (last 4 blank). List cells joined with `\n`.

### 4j. Session attachments (`/api/uploads` — NOT in Redact prefixes)

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| POST | `/api/uploads` | multipart `files`, form `session=""`, form `role=""` (→ `check_role`, default `other`; 400 invalid) | **SSE**: `session{session}`, per file `start{index,total,filename}`, `stage{index,total,filename,stage:"converting"|"embedding"|"graph",name}`, `done_file{index,total,name,title,role,format,pages,unit,chunks,tokens,seconds,graph}` or `file_error{index,total,filename,message}`, final `done{added,total,**uploads.info(sid)}`, `error{message}`. Pre-stream 400: no files, any unsupported suffix (whole request rejected), none accepted | `uploads.sweep()`; reuse `session` if it `exists()`, else `new_session()`; copies to `tempfile.mkdtemp()/name`; worker thread `add_file(...)`; tmp dir removed | 1959 |
| GET | `/api/uploads/{session}` | — | `uploads.info(sid)` (§5); 400 bad id; 500 | `sweep()` first | 2067 |
| GET | `/api/uploads/{session}/files/{name}/markdown` | — | `text/markdown` body; 400; 404 | reads `upload_files.markdown` | 2079 |
| GET | `/api/uploads/{session}/entities` | query `roles: list[str]?` | `uploads.compare(sid, roles)` → `{documents:[{node_id,label}], entities:[{node_id,type,label,code,ticket,in_corpus,corpus_documents(≤6),corpus_mentions}], shared, new, scope}`; 404 expired; 400 | — | 2093 |
| DELETE | `/api/uploads/{session}` | — | `{dropped:true, session}`; 400 | `uploads.drop` | 2106 |
| PATCH | `/api/uploads/{session}/files/{name}` | query `role` (required) | `{updated,name,role, **info}`; 400; 404 | `UPDATE upload_files SET role` (no re-embed) | 2116 |
| DELETE | `/api/uploads/{session}/files/{name}` | — | `{removed:true, graph, **info}`; 400; 404 | `uploads.remove_file` | 2130 |

### 4k. Fit-Gap Copilot (`/api/rollout`, Redact)

`RolloutRun` (FACT 2286-2299): `scope_bpml:str=""` (empty → agent identifies process), `subject:str="country_as_is"` (must be in `rollout.schemas.SUBJECTS`, else 400), `country:str≤80=""`, `country_context:str≤4000=""`, `sap_release:str≤200=""`, `gt_version:str≤120=""`, `question:str?`, `upload_session:str=""`, `categories:list[str]=[]` → `rollout.schemas.RunRequest`.
`RolloutDecision` (2302-2311): `gap_id:str 1..40`, `reviewer:str 1..120`, `verdict:str` (accept|reject|defer), `disposition:str=""`, `comment:str≤2000=""`, `option_index:int≥0?`, `rationale:str≤2000=""`, `session_id:str≤40?`.
`WorkshopAnswer` (2536): `gap_id:str 1..40, verdict:str, option_index:int≥0?, rationale:str≤2000=""`. `WorkshopSubmit` (2543): `facilitator:str 1..120, attendees:list[str] (≤60), answers:list[WorkshopAnswer] (1..200)`.

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/rollout/status` | — | `{bpml, model, prompt_hash, max_tool_calls, anthropic_key, runs, decisions, pdf:{available,detail}, error, vocabulary:{deviation_types, dispositions, localization_states, dimensions:{k:{label, weight(%int)}}, ratings:{str(k):v}}, subjects:[{value,label,role,localization,score_b}], uploads:{ttl_hours,max_files,accepted,database,roles:[{value,label}]}, documents, chunks, categories, corpus_error?}` (+ `ro_store.stats()`) | — | 2332 |
| POST | `/api/rollout/preview` | `RolloutRun` | `orchestrator.preview(req)`; 400 if `error` | — | 2397 |
| POST | `/api/rollout/run` | `RolloutRun` | **SSE**: `scope`, `stage`, `tool_call`, `asis`, `gate`, `analysis`, `scores`, `done`; `error{message}` | orchestrator persists (INFERRED) | 2407 |
| GET | `/api/rollout/runs` | `limit=40` | `ro_store.list_runs` | — | 2434 |
| GET | `/api/rollout/runs/{run_id}` | — | run with `evaluation = agent_eval.refresh(run.evaluation)`; 404 | — | 2443 |
| GET | `/api/rollout/runs/{run_id}/attachments/{file}` | `file` = citation md name (e.g. `…Sample_txt.md`) | `text/markdown; charset=utf-8` from kept copy (`ro_store.get_attachment` → `(kept, upload)`), else from live upload session (matching `uploads.md_name(doc.name)==file`); 410 if session swept ("…deleted after N hours unused…"); 404 | — | 2457 |
| DELETE | `/api/rollout/runs/{run_id}` | — | `{status:"deleted", id}`; 404 | — | 2494 |
| POST | `/api/rollout/runs/{run_id}/decisions` | `RolloutDecision` | `ro_store.save_decision(...)`; 400 bad verdict / non-accept without rationale-or-comment ("Say why…") / gap_id not in `run.analysis.deviations` / session_id not a workshop session of run / store ValueError; 404 | append-only decision row (never overwrites proposal) | 2507 |
| POST | `/api/rollout/runs/{run_id}/workshop` | `WorkshopSubmit` | `ro_store.submit_workshop(conn, run_id, facilitator.strip(), attendees, answers)` (atomic); 404 LookupError; 400 ValueError (with `conn.rollback()`) | inserts session + decisions | 2549 |
| GET | `/api/rollout/runs/{run_id}/workshop/export` | `format="pdf"` (∈ `workshop_export.FORMATS`: md/pdf/docx/xlsx per doc — INFERRED from "Markdown, PDF, Word or Excel"), `session=""` | binary/text attachment, filename `wx.filename(run, format, session)`; 400 format; 404 run/session; 503 PDF unavailable; 500 | `contact.redact_obj(run)` first | 2567 |
| GET | `/api/rollout/runs/{run_id}/lineage` | `format=""|md|json` | no format → `lineage.build(run)` JSON; else attachment `audit-trail-<id>.<fmt>`; 400 | redact before download | 2604 |
| GET | `/api/rollout/decisions` | `country, scope, type, verdict` (all ""), `history:bool=false`, `limit=200` (1..1000) | `{decisions, count}` | `ro_store.list_decisions(current_only=not history)` | 2633 |
| GET | `/api/rollout/runs/{run_id}/export` | `format=md|pdf|json` (default md; anything else → md), `client:bool=false` | pdf `application/pdf` filename `ro_pdf.filename(run)` (503 if renderer unavailable; 500 render fail); json `<id>.json`; md `<id>.md` | `redact_obj`, `client_copy(run)` if client; PDF rendered from `export.to_markdown(run)` | 2649 |

### 4l. Evidence Agent (`/api/evidence`, Redact)

`EvidenceQuestion` (2763): `question:str 3..2000`, `holdout:bool=false`, `categories:list[str]=[]`, `memory:bool=false`. `MemoryReflection`: `question:str 3..500`.

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/evidence/status` | — | `{model, prompt_hash, max_tool_calls, anthropic_key, tools:[names], categories:[{code,documents,chunks}], error, memory: agent_memory.describe()|{configured:false,available:false,detail}, history: ev_store.stats()|{runs:0,answered:0,error}, duplicate_groups:[[…]], duplicate_threshold, hubs:[{label,degree}] (desc), hub_degree, graph: stats}` | — | 2708 |
| POST | `/api/evidence/ask` | `EvidenceQuestion` | **SSE**: `run{id:"ev_<hex10>"}` / `run{id,not_saved}`; `log{seq,at,kind:"question",text,holdout,scope,memory}`; per agent event: `log` entry then the event itself (except `thinking`/`note`, which emit only `log`); events include `tool_call`, `memory`, `answer`, `error`; `evaluation` events sent without a log line | `ev_store.start_run({id,question,holdout,categories,model,prompt_hash,corpus_fingerprint})`; on memory → `save_memory`; tool_call → `save_calls(all calls)`; answer → `finish_run(data, calls)`; error → `fail_run`; after each → `save_log(log)`; evaluation → `save_evaluation`. A store failure sets `conn=None` (stops writing; stream continues) | 2773 |
| GET | `/api/evidence/runs` | `limit=50` (1..200) | `ev_store.list_runs` | — | 2936 |
| GET | `/api/evidence/runs/{run_id}` | — | run with refreshed `evaluation`; 404 | — | 2946 |
| GET | `/api/evidence/runs/{run_id}/lineage` | `format=""|md|json` | as rollout lineage | — | 2961 |
| DELETE | `/api/evidence/runs/{run_id}` | — | `{status:"deleted", id}`; 404 | — | 2989 |
| POST | `/api/evidence/memory/reflect` | `MemoryReflection` | `agent_memory.reflect(question, context="The Evidence Agent's memory of its own investigations of the Solvay SPARK L2C corpus. Answer only from those memories.")`; 503 memory unavailable; 502 if result.error | Hindsight LLM call | 3004 |

Evidence log entry shapes (FACT 2802-2839): base `{seq, at (UTC ISO ms), kind}`; `tool_call` adds `tool, engine, summary, ms, error, warning, arguments, call(index into calls)`; `thinking` → `text[:6000], turn`; `note` → `note(kind), title, text[:6000], detail`; `memory` → `used, recalled, suppressed_by_holdout, memories:[text[:600]]`; `answer` → `state, claims(count), text[:2000], detail:{tool_calls,input_tokens,output_tokens,seconds}`; `error` → `text[:2000]`.

**Route count**: app.py 105 route decorators (23 of them HTML SPA page decorators, i.e. 23 page paths) + 1 static mount; app_login 4; demo_mode 6 decorators (FACT, grep).

---

## 5. Session attachments model (`backend/core/uploads.py`) — FACT unless noted

- Purpose: per-session documents for InsightLens and Fit-Gap Copilot, isolated from the corpus by a **separate database** `<base>_session` (e.g. `DATABASE_URL=.../docling` → `.../docling_session`, via `rag.sibling_database("SESSION")` lower-cased; FACT rag.py:265-277) with **one Postgres schema per session** `u_<sid>` containing the same `rag_documents`/`rag_chunks` tables as the corpus (created by `rag.create_schema(scoped_conn)`).
- DB created lazily on first write: `rag.ensure_sibling` connects to `/postgres` maintenance DB with autocommit and creates it (rag.py:328+). `live()` = cached `database_live` check, so read-only callers don't create it.
- `sid` = `uuid4().hex[:12]`, validated by regex `[0-9a-f]{12}` (fullmatch, lower-cased) because it is interpolated into identifiers.
- Connections: `threading.local` cache, one psycopg conn per (thread, schema); `SET search_path TO "<schema>", public` (public for `vector` type). `close()` closes this thread's conns.
- Env: `FITGAP_UPLOAD_TTL_HOURS` (default 12; interval `max(TTL,0.1) hours`), `FITGAP_UPLOAD_MAX_FILES` (default 12).
- Roles: `ROLES = ("as_is","template","sap_bp","localization","other")`, default `other`; labels `Country As-Is, Global Template, SAP Best Practice, Localization source, Reference`. Category on chunks: `UPLOAD` (reserved in rag.py).
- Files on disk: `.workdir/uploads/<sid>/<stem>_<ext>.md` (`md_name`: suffix lower, `.`→`_`), plus `media/`. Markdown also stored in DB and restored to disk if missing when rebuilding graph.

**DDL (verbatim, public schema of session DB, uploads.py:184-218, run once per process inside a transaction):**
```sql
CREATE TABLE IF NOT EXISTS upload_sessions (
    id         text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    graph      jsonb
);
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
);
ALTER TABLE upload_files ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'other';
```
`_meta_ready` flag set only after success (guarded by lock).

**Lifecycle functions:**
- `new_session()`: insert row with `expires_at = now() + ttl`, `CREATE SCHEMA IF NOT EXISTS "u_<sid>"`, `rag.create_schema(scoped)`, mkdir.
- `exists(sid)`: false if DB not live; row with `expires_at > now()`.
- `touch(sid)`: `used_at=now(), expires_at=now()+ttl` (sliding expiry) — called at end of `add_file`.
- `drop(sid)`: `DROP SCHEMA … CASCADE`, delete row, rmtree dir, close cached conn.
- `sweep()`: drop expired sessions; drop orphan schemas matching `u_[0-9a-f]{12}` not in table (query `pg_namespace WHERE nspname LIKE 'u\_%'`); remove dirs in `.workdir/uploads` not in table. Triggered by `/api/fitgap/status`, `POST /api/uploads`, `GET /api/uploads/{s}` — no timer (FACT; INFERRED: no scheduled sweep exists).
- `add_file(sid, src, name, role, on_event)`: requires session exists; count < MAX_FILES else ValueError; Langfuse run `ingest-document` (as_type `chain`, input `{name,role,bytes}`, metadata `{session,schema,category}`, `session_id=sid`, tags `["upload", "role-<role>"]`); stage `converting` → step `convert-to-markdown` (`converter.convert(src, media_dir=folder/"media", title=stem)`), write md; stage `embedding` → step `chunk-and-embed` (as_type `embedding`, model `rag.EMBED_MODEL`) `rag.index_file(session_connect(sid), md, category="UPLOAD")` (not forced; unchanged fingerprint costs nothing); upsert `upload_files` (ON CONFLICT (session_id,name) DO UPDATE all cols + `added_at=now()`); stage `graph` → step `extract-graph` `rebuild_graph(sid)`; `touch`; returns `{name,title,role,format,pages,unit,chunks,tokens,seconds,graph}`. On convert/embed failure `run.fail`, `run.end`, re-raise.
- `remove_file`: delete row RETURNING, `DELETE FROM rag_documents WHERE source = <abs md path>` in session schema (INFERRED: chunks cascade), unlink md, rebuild graph.
- `rebuild_graph(sid)`: `knowledge_graph.extract_graph(files=[(path, "upload/<name>", "UPLOAD")], cache=False)` (cache=False mandatory so it doesn't overwrite global knowledge_graph.json); empty → `{"nodes":[],"edges":[],"stats":{"total_nodes":0,"total_edges":0,"types":{}}}`; stored in `upload_sessions.graph` jsonb; returns stats subset.
- `compare(sid, roles, categories)`: upload document nodes (`doc:<md file>`) + one-hop neighbours vs main graph (optionally category-filtered), with which corpus documents mention each entity; sorted (in_corpus first, type, label).
- `search(sid, query, k=8, mode="hybrid", roles)`: `rag.search(..., conn=session_connect(sid))`, overfetch ×4 and filter by role via `roles_by_source`.
- `chunk(sid, chunk_id:int)`: SELECT join `rag_chunks c JOIN rag_documents d` → `{chunk_id,title,source,heading_path,content,tokens,category:"UPLOAD"}`.
- `info(sid)`: `{session, exists, created_at, used_at, expires_at, ttl_hours, max_files, database, schema, files:[{name,role,role_label,format,bytes,pages,unit,chunks,tokens,seconds,added_at}], documents, chunks, tokens, graph:{total_nodes,total_edges,entities,documents}}` or `{session,exists:false,files:[],documents:0,chunks:0}`.
- `titles(sid, roles)`: titles from session `rag_documents`.

---

## 6. Tracing (`backend/core/tracing.py`) — FACT unless noted

- Loads `ROOT/.env` with `load_dotenv(override=False)` at import (57).
- `ENABLED = bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)`; half-configured = off. `ENVIRONMENT = LANGFUSE_TRACING_ENVIRONMENT or "development"`. Also `LANGFUSE_RELEASE` (client release), `LANGFUSE_BASE_URL` (read by SDK; shown in status/start line, default text "cloud").
- `client()`: lazy, double-checked lock; `Langfuse(environment, release, mask_otel_spans=_mask_otel_spans)`; `_instrument()` → `AnthropicInstrumentor().instrument()` + `ThreadingInstrumentor().instrument()` (opentelemetry), exceptions swallowed (uvicorn --reload); `atexit.register(shutdown)`. Failure → warning, `_client=None`; `_started=True` either way.
- Masking at export (`_mask_otel_spans`, applies to all OTEL span string attributes incl. Anthropic spans): `_SECRETS` regex → `[REDACTED]` (`sk-ant-…{8,}`, `(pk|sk)-lf-…{8,}`, `postgres(ql)?://user:pass@`, JWT-like three 20+ segments) and `_EMAIL` → `[EMAIL]`. Document text not masked.
- `start()` (called in lifespan): returns/prints one of: "Langfuse tracing is off: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to turn it on." / "…configured but the client failed to start; see the log." / "Langfuse rejected these credentials; nothing will be traced." (`auth_check()` false) / "Langfuse could not be reached (<exc>); traces will be dropped." / "Langfuse tracing is on (<BASE_URL|cloud>, environment=<env>)."
- `flush()`, `shutdown()` safe no-ops when off.
- `_Null` / `NULL`: accepts `update/end/score/start_observation/start_as_current_observation` and does nothing.
- `Run(span, attrs)`: `__bool__`, `trace_id` ("" when off), `url()` via `client().get_trace_url`, `current()` (context manager: `otel.use_span(span._otel_span, end_on_exit=False)` + `langfuse.propagate_attributes(**attrs)` — used around single model calls inside generators), `step(name, as_type="span", **kw)` (child via `self._span.start_as_current_observation` under `propagate_attributes`; yields NULL on failure/off), `update`, `fail(exc)` → `level="ERROR", status_message`, `end(**kw)` (update, end, set None, flush; idempotent).
- `start_run(name, *, input, metadata, session_id, user_id, tags, as_type="agent")` → attrs `{trace_name, session_id?, user_id?, tags?, metadata?}`; root via `lf.start_observation(name, as_type, input, metadata)` inside `propagate_attributes`. Returns `Run(None, {})` when off.
- `observation(name, as_type, **kw)`: child of ambient current observation (`lf.start_as_current_observation`).
- `status()` → `{enabled, environment, host}` (used by `/api/rag/status`).
- Design: explicit parenting because generators are resumed on arbitrary threadpool threads (doc string 25-34). Model calls traced automatically by the Anthropic OTEL instrumentor (not by hand).
- What is traced (FACT docs/tracing-and-evaluation.md): one trace per run for Fit-Gap Copilot (`rollout-analysis` with `read-as-is`, `compare-to-template`, `quality-gates` children), InsightLens, Evidence Agent, `/ask`; plus `ingest-document` per attachment (uploads.py:372). Langfuse session = upload session id; no user_id.
- Scores pushed: Ask — `evaluation.push_scores` writes each Ragas metric value (NUMERIC, or BOOLEAN for names in `evaluation.BOOLEAN`), `overall_quality`, `safety`, comments ≤1000 chars, deterministic `score_id(run_id, name)` (FACT backend/rag/evaluation.py:755-786); human review `human_grounded` CATEGORICAL (app.py:3154). Agents (Evidence, Rollout) — `agent_eval.py` scores listed in doc: `citation_validity, claims_unsupported, tool_error_rate, redundant_tool_calls, required_tools_met, submitted_first_try, budget_exhausted, tool_calls, task_completed, gate_hard_issues, gate_soft_issues, topic_adherence, web_query_on_topic, scope_refused, scope_guard_fail_open, contact_in_output, contact_leak, web_gate_blocks, web_query_leak_attempts`; trace tags `evidence-agent`, `rollout-agent`.
- Evaluation env (doc): `RAG_EVAL=off` disables; off automatically without Ragas or `ANTHROPIC_API_KEY`; judge default `claude-sonnet-5`; sampling (`evaluation.SAMPLE`, `wanted()`) — env name not in my files (gap).

---

## 7. Error-handling conventions

- `HTTPException(status, detail)` with string detail; structured detail dicts for KB delete/open (`{message, matches}`) and Cypher (`{code, message}`). Status semantics used: 400 validation/bad input, 404 missing, 409 conflict/precondition (not converted, already scoring, ambiguous name, job running), 410 gone (swept attachment), 500 unexpected, 502 upstream model error, 503 dependency unavailable (Neo4j, Claude key, PDF renderer, memory server, unbuilt UI).
- `SystemExit` from `rag.py` (missing settings) is caught and turned into 400 or an SSE `error` (app.py:299, 1769, 1931).
- `_try(fn, *args)` swallows bookkeeping errors so history writes never replace the answer (app.py:2919-2925). Stream start emits `run{id, not_saved}` when the DB is unavailable.
- Error message format for unexpected exceptions: `f"{type(exc).__name__}: {exc}"`.
- Observability/scoring failures logged at debug and ignored ("an observability tool may not break the tool").
- Progress mechanisms: SSE event streams (per-file `progress/start` → `file_done|file_error` → summary); upload stages via queue from worker thread; Ask evaluation status polled via `GET /api/ask/runs/{id}/evaluation` (statuses none/running/done/failed/skipped/abandoned); graph question-check via returned id + `GET /api/graph/quality`.

---

## 8. Original-file resolution for review (`/api/kb/files/open`) — FACT app.py:591-713
- `_original_name(md)`: `stem.rpartition("_")` → `"<stem>.<suffix>"` (e.g. `Pricing_xlsx.md` → `Pricing.xlsx`).
- `_original_folders(md)`: `[md.parent.parent, md.parent]`.
- `_beside_markdown`: try converter name in each folder (must be file with ACCEPTED suffix); then glob `<glob.escape(md.stem)>.*` (sorted, excluding md itself).
- `_upload_job_holding`: scan `.workdir/*/name.txt` (sorted) for matching name (case-insensitive) or same stem; return first ACCEPTED `source.*`.
- `_original_of = _beside_markdown or _upload_job_holding`.

---

## 9. DB tables touched directly in these files
- Session DB public schema: `upload_sessions`, `upload_files` (DDL §5); per-session schemas `u_<sid>` with `rag_documents`, `rag_chunks` (DDL owned by `rag.create_schema`, other section).
- Direct SQL in app.py: only `SELECT 1 FROM fitgap_entries WHERE id = %s` (2266). All other persistence via stores: `ask_store`, `backend.agents.fitgap.store`, `backend.agents.rollout.store`, `backend.agents.evidence.store`, `backend.rag.experiment_store`, `graph_eval` (each `create_schema(conn)` called lazily per request — DDL in those modules, not here). Evidence table name `evidence_runs` mentioned (app.py:2779).

---

## 10. Gaps / not determined from these files
- Exact event payloads of `rag.ask_events`, fitgap/rollout orchestrators, evidence agent (only event names known here).
- DDL for ask_store, fitgap/rollout/evidence stores, experiment_store, rag tables — owned by other modules.
- `ask_store.RETENTION`, `LOW_QUALITY`, `evaluation.SAMPLE`/its env var, `rag.MODES`, `rag.DEFAULT_K`, `rag.CATEGORIES`, `VLM_PROVIDERS`, `preview.IMAGE_FORMATS`, `workshop_export.FORMATS` values not read here.
- `contact.redact` full regexes (phone heuristics) only skimmed.
- Per-chunk redaction in the ASGI middleware can miss an e-mail split across two SSE chunks (INFERRED risk).
- No rate limiting, no upload size cap, no CSRF protection, `/api/*` fully open; cookies lack `secure` (FACT by absence). App docstring says "no auth, no upload cap" (app.py:4-6).
- Starlette version behaviour of `@app.middleware` registered after routes at import time is fine (INFERRED; app not yet started).
