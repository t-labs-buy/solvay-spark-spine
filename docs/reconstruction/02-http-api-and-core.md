# 02 — HTTP API Layer and Core Services

Current as of commit fd5a375 (2026-10-06). Line numbers for what changed after `1d37131` (live agent runs, forced password change, corpus paths from another machine) are at `fd5a375`; older citations were taken at `1d37131` plus the ownership fixes, and `app.py` line numbers after ~line 800 have since moved down by roughly 40–160 lines.
Scope: `backend/api/app.py` (3574 lines at fd5a375), `backend/api/{app_login,demo_mode,admin}.py`, `backend/auth/{store,passwords,sessions,middleware,deps,routes}.py`, `backend/core/{tracing,uploads,paths,pricing,live}.py`, `backend/agents/guardrails/middleware.py` (read because app.py installs it), docs `sign-in-and-demo-mode.md`, `tracing-and-evaluation.md`.
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

Per-upload job dir layout (FACT app.py:273-280, 320, 401-424): `.workdir/<doc_id>/source.<ext>`, `name.txt` (original filename), `owner.txt` (the uploader's user id, app.py:281), `preview/page-N.png` (via `preview.render` / `preview.page_path`), `media/` (extracted images), `output.md`. `doc_id = uuid4().hex[:12]` (app.py:273); KB-opened originals use `doc_id = "kb" + sha256(str(original))[:10]` and get no `owner.txt` but an empty `shared` marker file (FACT app.py:876-884).
Batch layout (FACT app.py:1269-1274, 1449): `.workdir/batches/<batch_id>/owner.txt`, `sources/`, `markdown/<stem>_<ext>.md`, `batch_<id>_markdown.zip`.
Path-traversal and owner guard `_job_dir(doc_id, user)`: resolve and require `WORKDIR.resolve()` in `job.parents`, else 404 "Document not found"; then `_owned(job, user, "Document", read)` (FACT app.py:151-157). `_batch_dir(batch_id, user)` does the same for `.workdir/batches/<id>` with "Batch not found" (app.py:160-164). `_owned(folder, user, what, read=False)` first lets the caller through when `read` is true and the folder holds the `shared` marker (`_SHARED_FILE = "shared"`); otherwise it reads `owner.txt` and raises 404 "<what> not found" unless it equals `str(user["id"])`, so a missing `owner.txt` (a job from before this check) is nobody's (app.py:141-148). `_mark_owner(folder, user)` writes `owner.txt` (app.py:133-134); `_mark_shared(folder)` touches `shared` (app.py:137-138). Only the read-only routes (`GET /api/docs/{id}/preview/{n}`, `/media/{name}`, `/download`) pass `read=True` (app.py:403, 411, 419); `_batch_dir` never does.

---

## 2. App construction

- `app = FastAPI(title="Docling Extraction UI", lifespan=lifespan)` (FACT app.py:108). FastAPI's default `/docs`, `/redoc`, `/openapi.json` are left on (no `docs_url=None`). Launched by `uvicorn backend.api.app:app` — dev: `scripts/run.sh` → `.venv/bin/uvicorn backend.api.app:app --port ${PORT:-8000} --reload --reload-dir backend` (FACT scripts/run.sh:46); container: `uvicorn backend.api.app:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips *`, `HEALTHCHECK curl -fsS http://127.0.0.1:8000/api/health` (FACT Dockerfile:85-88). Single process, no `--workers` (FACT). run.sh also best-effort starts Hindsight (127.0.0.1:8888) and Neo4j via `compose.neo4j.yml` before uvicorn (FACT run.sh).
- **Lifespan** (FACT app.py:74-105), in order on startup:
  1. `print(tracing.start())` (eager Langfuse auth check, one log line).
  2. `print(auth_store.bootstrap_admin())` — creates the `users`/`activity_events` tables and the `legacy` account, and a first Admin from `ADMIN_USERNAME`/`ADMIN_PASSWORD` if there is no active Admin (§3a) (app.py:82-86).
  3. `_ensure_run_tables()` — calls `create_schema(connect())` on `ask_store`, evidence, fitgap and rollout stores so each gets its `user_id` owner column and legacy backfill before the usage dashboard reads them; a failure prints `auth: could not prepare the <name> run table: …` and is not fatal; then `rag.close()` (app.py:87-91, 215-226).
  4. `kg_neo4j_load.sync_in_background()` (daemon thread loading the KG into Neo4j, retrying on `ServiceUnavailable` every 5 s up to 120 s; no-op if Neo4j not configured — FACT backend/graph/kg_neo4j_load.py:249-274).
  On shutdown: `tracing.shutdown()`, then `backend.agents.fitgap.memory.close()` in try/except.
- No `@app.on_event`, no CORS middleware, no SessionMiddleware, no exception handlers registered (FACT — grep of app.py found none). INFERRED: SPA served same-origin so CORS not needed.
- **Middleware stack** (registration order):
  1. `app.add_middleware(RedactContactDetails)` (FACT app.py:115) — pure ASGI class (FACT guardrails/middleware.py). Applies only to paths starting with `/api/evidence`, `/api/fitgap`, `/api/rollout`, `/api/ask`, `/api/quality`. For responses whose content-type (before `;`) is in `application/json, text/event-stream, text/markdown, text/plain, text/csv`, it holds the `http.response.start` message until the first body chunk, runs `contact.redact(body.decode("utf-8", errors="replace"))` on **each body chunk** independently, drops `content-length`, re-adds it only if `more_body` is false. Binary responses (PDF/XLSX/DOCX) pass through unchanged — hence endpoints call `contact.redact_obj(run)` before rendering binaries (FACT app.py:2736, 2777, 2826, 3145). `contact.py` redacts e-mails (regex `EMAIL`) and phone numbers (candidate + cue words, excludes dates/time ranges/dotted version numbers) (FACT guardrails/contact.py:40-58, details owned by another section).
  2. `app_login.install(app)` called at the very end, after every page route is declared (FACT app.py:3457) → `app.add_middleware(RequireUser, pages=frozenset(page_paths(app)))` (FACT app_login.py:42-44). `RequireUser` is a pure ASGI class (backend/auth/middleware.py:95-129), not `@app.middleware("http")`, so streamed responses stay streamed. INFERRED: as the last-added middleware it is the outermost layer, so a signed-out `/api/*` call is refused before redaction runs.
- **Routers** (FACT app.py:195-212), all included before `/` is declared: `demo_mode.router` (195), `auth_routes.router` from `backend/auth/routes.py` (207), `app_login.router` (208), `admin_api.router` from `backend/api/admin.py`, prefix `/api/admin` (212).
- **Static**: `app.mount("/assets", _ImmutableAssets(directory=DIST/"assets", check_dir=False), name="assets")` — `StaticFiles` subclass overriding `file_response` to set `Cache-Control: public, max-age=31536000, immutable` (FACT app.py:3442-3459). `check_dir=False` so API starts before first frontend build.
- **HTML entry points**: three Vite inputs `main: index.html`, `demo: demo.html`, `login: login.html` (FACT frontend/vite.config:13) → built to `static/dist/{index,demo,login}.html`.
  - `_spa()` returns `static/dist/index.html` with `Cache-Control: no-cache`; if missing returns 503 HTML "The web UI has not been built. Run `cd frontend && npm install && npm run build`, then reload." (FACT app.py:174-187). The SPA reads `location.pathname` to choose the screen (FACT comment app.py:247).
  - login page → `static/dist/login.html` (FACT app_login.py:23); demo → `static/dist/demo.html` (FACT demo_mode.py:24). Both 503 with a "not been built" message when missing, both served with `Cache-Control: no-cache` (app_login.py:51-55, demo_mode.py:29-34).

### Concurrency model
- All heavy endpoints are plain `def` → FastAPI runs them in the Starlette threadpool (FACT comment app.py:117-119). SSE endpoints return `StreamingResponse` over **sync generators**, which Starlette iterates in the threadpool (FACT app.py:1802-1803). The three **agent** streams (InsightLens, Fit-Gap Copilot, Evidence Agent) are the exception: their run is not driven by the response at all but by a live-run thread (next bullet and §2a).
- No `BackgroundTasks`, no job queue, no Celery (FACT comment app.py:1687-1695). Deferred work = **daemon `threading.Thread`**:
  - Ask answer judging: `threading.Thread(target=_judge, args=(run_id, force), name=f"ask-eval-{run_id}", daemon=True)` (FACT app.py:1759-1760).
  - Session upload: per file a worker thread runs `uploads.add_file`, forwarding stage events via a `queue.Queue` to the generator (FACT app.py:2130-2155). Sentinel `("__end__", {})`.
  - Neo4j sync: daemon thread (FACT kg_neo4j_load.py:249).
  - Graph question-check: `graph_eval.start_questions()` returns an id, runs in background (FACT app.py:594-606; internals elsewhere).
  - INFERRED: Fit-Gap/Rollout orchestrators spawn their own worker threads (comment app.py:1691 references rollout/orchestrator.py).
  - **Live agent runs** (`backend/core/live.py`, FACT at fd5a375): `/api/fitgap/run`, `/api/rollout/run` and `/api/evidence/ask` hand their event generator to `live.start(...)`, which drains it on a daemon thread named `<kind>-live` into an in-memory event log. The thread runs inside `contextvars.copy_context()` of the request, so `tracing.USER` (the signed-in username) still reaches the Langfuse trace (live.py:104-109). See §2a.
- The signed-in user is never read from ambient context by a run: endpoints take `user` via `Depends` and pass `user["id"]` into the store row or `RunRequest` explicitly (FACT backend/auth/deps.py:8-10; app.py:1836, 2029, 2456, 3007).
- DB connections: thread-local psycopg connections; workers must close their own (`rag.close()` in `_judge` finally, app.py:1740; `fg_uploads.close()` in upload worker, app.py:2147). `fg_store.connect()` / `ro_store.connect()` / `auth_store.connect()` are shared and cached per thread — "not ours to close" (FACT comments app.py:1922, 2268; auth/store.py:46-48).

### SSE format
Every SSE helper: `f"event: {event}\ndata: {json.dumps(data)}\n\n"` (agent streams use `json.dumps(data, default=str)`, and also send the comment line `: ping\n\n` as a keep-alive — §2a). Headers on most streams: `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `media_type="text/event-stream"` (FACT e.g. app.py:1431-1434). `/api/kb/batch-insert` omits the extra headers (FACT app.py:1258). Errors inside a stream are emitted as `event: error` with `{"message": ...}` rather than HTTP errors (validation errors before the stream starts are raised as HTTPException).

### 2a. Live agent runs (`backend/core/live.py`, 127 lines) — FACT at fd5a375
Why (module docstring, live.py:1-17): an agent run used to be driven by its HTTP response. Closing the tab left the generator suspended at its last `yield`, so the run never finished and could not be reopened; and while the model spent minutes writing one long turn nothing crossed the wire, so the reverse proxy in front of the deployed app closed the idle connection and the page showed "network error" for a run that was fine.

- Constants: `KEEP_SECONDS = 15*60` (a finished run's log is kept this long for a late reader; after that the stored record is what the history opens); `PING_SECONDS = 15` (a follower with nothing new wakes this often to send a keep-alive); sentinel `PING = "__ping__"` (live.py:26-32).
- Registry: module-level `_runs: dict[(kind, run_id), LiveRun]` behind `threading.Lock`; kinds `"fitgap"` (InsightLens), `"rollout"` (Fit-Gap Copilot), `"evidence"` (Evidence Agent). One uvicorn process serves the app, so the module dict is the whole store (INFERRED consequence: a second worker process, or a restart, loses every live log; the page then falls back to the stored run).
- `LiveRun(owner, stop)`: `owner` (user id), `run_id`, `events: list[(event, data)]`, `finished_at`, `stop: threading.Event` (read by the orchestrator), a `threading.Condition`. `follow()` yields **every event so far, then each new one** until the run has finished and the reader has caught up; while there is nothing new it waits up to `PING_SECONDS` and yields `(PING, None)`.
- `start(kind, events, owner, stop, run_id=None)`: prunes logs finished more than `KEEP_SECONDS` ago; registers the run under `run_id` at once when the caller already has it (Evidence Agent mints `ev_<hex10>` before streaming), otherwise when the first `scope` event carrying `run_id` arrives (InsightLens, Copilot). The drain loop appends each event; an exception becomes a final `error{message:"<Type>: <msg>"}`; `finally` marks it finished. The thread runs in a copy of the request's `contextvars` context.
- `get(kind, run_id, owner=None)`: the live run if it exists and `owner` is None (an Admin) or equals the run's owner; else None.
- `_live_stream(live)` in app.py (app.py:2088-2104): a sync generator over `live.follow()` that emits `: ping\n\n` for `PING` and `event: …\ndata: …\n\n` otherwise, with `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- Each engine has three routes: the run/ask POST (starts the run and streams it), `GET …/runs/{id}/stream` (`read_owner`; replays from the first event and follows; **404 "run <id> is not running"** once the run is only in the store) and `POST …/runs/{id}/stop` (`write_owner`; sets `stop`, returns `{stopping:true, run_id}`; 404 likewise). Stop semantics differ per engine (§4i, §4k, §4l).
- Tests: `test_fitgap.py` (`test_a_late_reader_replays_the_run_from_its_first_event`, `test_someone_elses_live_run_is_not_found_but_an_admin_sees_it`, `test_a_run_that_raises_ends_its_stream_with_an_error`, `test_a_quiet_run_sends_keepalives_so_a_proxy_keeps_the_stream_open`, `test_a_live_run_sees_the_signed_in_user`); `test_rollout.py::test_a_stopped_pass_makes_no_further_model_call`; `test_evidence.py::test_a_stopped_investigation_makes_no_model_call`.

---

## 3. Authentication, accounts and ownership

Replaces the earlier static sign-ins (`APP_USERNAME`/`APP_PASSWORD`, `DEMO_USERNAME`/`DEMO_PASSWORD`, `APP_LOGIN=off`, cookies `app_session`/`demo_session`), none of which is read any more (FACT — grep of backend/ finds none; docs/sign-in-and-demo-mode.md). Accounts are Postgres rows; one cookie opens both the application and Demo Mode.

### 3a. Accounts and roles (`backend/auth/store.py`) — FACT throughout
- Tables live in the main database: `connect()` = `rag.connection(schema=False)`, `database_url()` = `rag.base_url()` (store.py:42-48). DDL runs once per process per database URL behind a lock (`_ready`, store.py:54-67), for the deadlock reason given in ask_store.

**DDL (verbatim, store.py:73-111):**
```sql
CREATE TABLE IF NOT EXISTS users (
    id              bigserial PRIMARY KEY,
    username        text NOT NULL,
    password_hash   text NOT NULL DEFAULT '',
    role            text NOT NULL DEFAULT 'user'
                    CHECK (role IN ('admin', 'user')),
    active          boolean NOT NULL DEFAULT true,
    session_version int NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_login_at   timestamptz,
    last_seen_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));
-- added after accounts shipped (fd5a375): existing accounts are not forced to change
ALTER TABLE users ADD COLUMN IF NOT EXISTS
    must_change_password boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS activity_events (
    id        bigserial PRIMARY KEY,
    at        timestamptz NOT NULL DEFAULT now(),
    user_id   bigint REFERENCES users(id),
    username  text NOT NULL DEFAULT '',
    action    text NOT NULL,
    tool      text,
    run_id    text,
    detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS activity_events_at_idx ON activity_events (at DESC);
CREATE INDEX IF NOT EXISTS activity_events_user_idx ON activity_events (user_id, at DESC);
INSERT INTO users (username, password_hash, role, active)
  VALUES ('legacy', '', 'user', false) ON CONFLICT (lower(username)) DO NOTHING;
```
- Roles: `ROLES = ("admin", "user")` (store.py:38). Usernames are case-insensitively unique; `_clean_username`: stripped, 1-64 chars, no whitespace, no `|`, not `legacy` (store.py:171-177).
- **`legacy` account** (store.py:16-18, 39, 108-111, 114-122): inactive, empty password hash (so `verify_password` returns False), owns every run recorded before accounts existed. Excluded from `list_users` (store.py:225-231). Its id is cached per database (`legacy_id`).
- **Accounts are never deleted**; `active=false` replaces deletion so runs keep an owner (store.py:12-14).
- `create_user(conn, username, password, role="user", must_change=False)`: validates name, role, `passwords.check_strength`; `INSERT … (username, password_hash, role, must_change_password) … ON CONFLICT (lower(username)) DO NOTHING RETURNING`; duplicate → `AccountError('There is already an account called "<name>".')` (store.py:187-206 at fd5a375). The Admin API passes `must_change=True` by default (§4m).
- **Forced password change** (fd5a375): `must_change_password` is true while the account's password is one an Admin chose — a new account or an Admin reset — and is cleared when its owner chooses their own. `_USER_COLUMNS` and the user dict include it (store.py:159-171).
- `authenticate(conn, username, password)`: case-insensitive lookup on stripped username; unknown name still runs scrypt against `DUMMY_HASH` (equal timing); wrong password or inactive → None; success sets `last_login_at = last_seen_at = now()` (store.py:205-222).
- `update_user(conn, uid, *, role, active, password, acting, must_change=True)` (store.py:249-296 at fd5a375): a new password also sets `must_change_password = must_change` (default true: a password set here is an Admin's reset). refuses `legacy`/unknown ("No such account."); an Admin losing Admin status (demotion or deactivation) is refused if `acting == uid` ("You cannot demote or deactivate your own account.") or if they are the last active Admin ("This is the last active Admin; make another Admin first."). Deactivation or a new password **bumps `session_version`** (signs the account out everywhere); a role change does not (the middleware reads the role fresh).
- `change_own_password(conn, uid, current, new)`: verifies current ("The current password is not right."); refuses a new password equal to the current one ("Choose a password different from the current one." — otherwise a forced change could be "made" by typing the Admin's password back in); then `update_user(password=new, must_change=False)` (store.py:298-306 at fd5a375).
- `touch_seen`: `last_seen_at = now()` at most once a minute (store.py:290-294).
- `bootstrap_admin()` (store.py:297-335): if an active Admin exists → "auth: accounts ready"; if `ADMIN_USERNAME` or `ADMIN_PASSWORD` is unset → a WARNING line naming the env vars and the CLI. Otherwise, in this order and never raising for a bad setting: `passwords.check_strength(password)` fails → `auth: WARNING -- ADMIN_PASSWORD was not used: <why> No Admin account was created.` (store.py:314-316); `_clean_username(name)` raises → `auth: WARNING -- ADMIN_USERNAME was not used: <why> No Admin account was created.` (store.py:319-322). Only then the case-insensitive lookup: if the name exists, make it an active Admin with that password, `must_change_password = false`, and bump `session_version`; else `create_user(…, "admin")`, whose `AccountError` is turned into the same ADMIN_USERNAME warning (store.py:323-334). Validating the name before the lookup is what stops `ADMIN_USERNAME=legacy` from promoting the built-in `legacy` account; the existing-account branch is also subject to the strength check. The lifespan prints the line and the app starts either way.
- `log_event(user, action, *, tool, run_id, detail, username)` inserts one `activity_events` row; never raises (prints `auth: could not log …`) (store.py:371-386). Actions written in this scope: `login`, `login_failed` (user_id NULL, username = typed name ≤64), `logout`, `password_changed` (auth/routes.py); `run` (tool ask/evidence/fitgap/rollout), `review`, `decision`, `workshop`, `export` (fitgap), `delete` (rollout/evidence), `clear_history` (ask) (app.py); `user_created`, `user_updated` (admin.py:107, 123). INFERRED: Ask single-run deletion is not logged (app.py:3421-3427 has no `log_event`).
- **CLI** (store.py:20-25, 389-431; run as `python -m backend.auth.store`, loads `ROOT/.env` with `override=False`): `create-admin <username>` (prompts twice via getpass), `list` (id, username, role, active/inactive), `reassign-legacy <username> [table ...]`.

**Password hashing (`backend/auth/passwords.py`)** — FACT: stdlib `hashlib.scrypt`, `N=2**14, r=8, p=1, dklen=32`, 16-byte random salt; stored as `scrypt$<n>$<r>$<p>$<salt hex>$<hash hex>` (passwords.py:17-28). `verify_password` parses parameters from the stored string, compares with `hmac.compare_digest`, returns False (never raises) for anything not a scrypt hash (31-43). `MIN_LENGTH = 8`, enforced only when a password is set (20-22, 51-55). `DUMMY_HASH` computed at import (48).

### 3b. Session cookie (`backend/auth/sessions.py`) — FACT throughout
- Env: `AUTH_SECRET` (falls back to `APP_SECRET`, then `secrets.token_hex(32)` per process → restart signs everyone out); `AUTH_SESSION_HOURS` (falls back to `APP_SESSION_HOURS`, default 12; `int(float(h)*3600)` seconds) (sessions.py:22-25).
- Cookie `spark_session`, shared by the application and Demo Mode (sessions.py:9, 26). `LOGIN_PATH = "/login"` (27).
- Token `"{uid}|{session_version}|{expires_epoch_int}|{hexsig}"`, `sig = HMAC-SHA256(SECRET, f"spark|{uid}|{version}|{expires}")` (sessions.py:30-39). `read_token`: exactly 4 `|`-parts, ints, `hmac.compare_digest`, reject if `expires < now`; returns `(uid, version)` (42-56). No server-side session table: revocation works by comparing `version` with `users.session_version` on each request (§3c).
- Cookie set on login and password change: `max_age=SESSION_SECONDS, httponly=True, samesite="lax", path="/"`; no `secure` flag (auth/routes.py:45-46, 83-84).
- `safe_next(target, default="/")`: only paths starting `/`, not `//`, no `\`, not starting with `/login` or `/demo/login`; else default (sessions.py:59-67).

### 3c. Request gate (`backend/auth/middleware.py`) — FACT throughout
For every HTTP request `RequireUser` (middleware.py:95-129):
1. Reads `spark_session` from the raw `cookie` header (quotes stripped) (85-92).
2. `resolve(token)` on a worker thread (`anyio.to_thread.run_sync`): `read_token`, then `_load(uid)` → `store.get_user`, cached per uid for `CACHE_SECONDS = 30` (43, 57-69); an active user also gets `touch_seen`. Returns None unless the user exists, is `active`, and `session_version` matches the token (72-82).
3. Stores the user dict (or None) in `scope["state"]["user"]` (read as `request.state.user`), and sets `tracing.USER` to the username (106-108).
4. Signed out + path starts `/api/` + path not in `EXEMPT` → **401** JSON `{"detail":"Sign in first."}` (111-117). `EXEMPT` = `/api/health`, and login/logout/session under `/api/auth`, `/api/app`, `/api/demo` (35-41).
4b. **Held for a password change** (fd5a375, middleware.py:51-52, 130-138): a signed-in user with `must_change_password` and a path under `/api/` not in `PASSWORD_CHANGE_OPEN = EXEMPT | {"/api/auth/password"}` → **403** JSON `{"detail":"Change your password first.","code":"password_change_required"}`. The check is on the server because a browser-only check would leave the API open to anyone holding the handed-over password.
5. Signed out **or held** + `GET` + path in `pages` → **303** to `/login?next=<quote(path[?query])>` (119-127; `/login` then asks for the new password). `pages` = `page_paths(app)`: every `APIRoute` with GET, `response_class is HTMLResponse`, path not starting `/demo` and not `/login` (app_login.py:28-39) — the 24 SPA paths of §4b, including `/admin`.
- Not gated by this middleware: `/assets/*`, `/login`, `/demo*` (they redirect themselves, §3e), FastAPI's `/docs`, `/redoc`, `/openapi.json` (INFERRED from the rules above: not under `/api/`, not an `APIRoute`).
- `middleware.forget(uid=None)` clears the cache; called on login, password change and every Admin account change, so a change applies on the next request in this process (middleware.py:48-54; auth/routes.py:42, 78; admin.py:119). INFERRED: with several processes, another process may serve a stale account for up to 30 s.

### 3d. Dependencies and ownership rules (`backend/auth/deps.py`) — FACT throughout
| Helper | Returns | Src |
|---|---|---|
| `optional_user(request)` | `request.state.user` or None | deps.py:18-19 |
| `current_user` | user, else 401 "Sign in first." | 22-26 |
| `require_admin` | user, else 403 "Only an Admin can do that." | 29-32 |
| `list_owner(user, scope="mine")` | `None` (everyone) only for an Admin with `scope=all`; otherwise `user["id"]` — a User's `scope=all` is ignored | 39-45 |
| `read_owner(user)` | `None` (any run) for an Admin, else own id | 48-52 |
| `write_owner(user)` | always own id, Admin or not | 55-58 |

Rules as applied in app.py:
- **Someone else's run is "not found"** (404, same message as a missing id), never 403, so a guessed id does not confirm existence (deps.py:49-51). Store functions take `owner` and append `store.owned(owner)` = `" AND user_id = %s"` (or nothing for None) (store.py:140-148).
- **Admin reads all, writes only own**: list endpoints take `scope=mine|all` (→ `list_owner`); open/export/lineage/evaluation-read use `read_owner`; delete, review, decision, workshop submit, Ask re-score and clear use `write_owner`.
- Reviewer, facilitator and decision-maker names come from the signed-in `username`; the request fields `reviewer`/`facilitator` are kept optional (default `""`) and ignored (app.py:1790-1796, 2433-2443, 2686-2690, 3293-3296).
- **Conversions are owned by the uploader** (app.py:122-164): `/api/upload` and `/api/batch/upload` write `owner.txt` into the new job/batch folder (`_mark_owner`, app.py:281, 1274). Every follow-up resolves the folder through `_job_dir(doc_id, user)` / `_batch_dir(batch_id, user)`: `/api/convert/{doc_id}`, `/api/docs/{doc_id}/embed|preview/{n}|media/{name}|download`, `DELETE /api/docs/{doc_id}`, `/api/batch/convert/{id}`, `/api/batch/{id}/download`, `/api/batch/{id}/embed`. Someone else's job, an Admin's request for another user's job (there is no Admin override here), and a job without `owner.txt` all answer 404 "Document not found" / "Batch not found". The one exception is a job marked `shared` (below): its `preview`, `media` and `download` are open to every signed-in user, while convert, embed and delete stay with the owner.
- **Shared by design, not owned**: workshop decisions — organisational memory readable by every signed-in user; each row records who decided it (`decided_by` from the account, plus `user_id`). `GET /api/rollout/decisions` has no `view` or owner filter: every signed-in user, User or Admin, gets every account's decisions (the current one per gap unless `history=1`) via `ro_store.list_decisions(…)`, which takes no `owner` (app.py:2785-2802; rollout/store.py:625-640). Writing a decision still needs `write_owner` on the run. Also shared: the corpus, KB files (`/api/kb/*`, including delete), the knowledge graph (rebuild, Neo4j sync) and the Cypher tools — the programme's shared knowledge, readable by every signed-in user — and the status endpoints. `POST /api/kb/files/open` marks every job it returns as `shared`: the `kb<hash>` preview job it creates (no `owner.txt`), and a reused upload job whose source is the original (its Markdown is already in the knowledge base). So `/api/docs/{id}/preview/{n}` for it answers every signed-in user, while only the uploader can convert, embed or delete an upload job, and nobody can change a `kb<hash>` job through the API (FACT app.py:850-902, 141-157).
- **Owner column**: `own_table(conn, table, column="started_at")` adds `user_id bigint REFERENCES users(id)`, index `<table>_user_idx (user_id, <column> DESC)`, and backfills `user_id IS NULL` rows to `legacy`; called from each store's own `create_schema` (store.py:125-137). `OWNED_TABLES = ("fitgap_runs","fitgap_reviews","rollout_runs","workshop_sessions","workshop_decisions","evidence_runs","ask_runs","ask_reviews")` (store.py:340-341).
- `reassign_legacy(conn, username, tables=None)`: every listed table must be in `OWNED_TABLES` (else `AccountError`); target must exist and not be `legacy`; in one transaction `UPDATE <t> SET user_id = <target> WHERE user_id = <legacy>`, skipping tables that do not exist (`to_regclass`); returns rows moved per table (store.py:344-365). Until reassigned, legacy runs are visible only to Admins (via `scope=all` / `read_owner`).
- **Upload sessions are owned** (§5): `_own_upload(session, user)` → if the session exists and `uploads.owner(session) != user["id"]` → 404 "This upload session has expired" (as if missing); bad id → 400 (app.py:229-244). Called by every `/api/uploads/{session}…` route and by fitgap/rollout preview and run for `upload_session`. A pre-account session (`user_id` NULL) therefore belongs to nobody. `POST /api/uploads` with someone else's `session` silently starts a new session instead of adding to it (app.py:2112-2115).

### 3e. Sign-in routes, `/login`, and Demo Mode — FACT throughout
- `backend/auth/routes.py` registers the same three handlers under `/api/auth`, `/api/app` and `/api/demo` (the latter two are aliases the existing bundles call) (routes.py:66-69), plus `POST /api/auth/password` (72-85). `public(user)` = `{id, user, username, role, must_change_password}` (routes.py:35-37 at fd5a375); login, session and the password change all return it, so the sign-in page knows to ask for a new password.
- `login`: `store.authenticate`; failure → `log_event(None, "login_failed", username=…)` and 401 `{"detail":"Incorrect username or password."}`; success → `forget(uid)`, `log_event("login")`, body `public(user)` + Set-Cookie (35-47).
- `GET /login` (`app_login.py:47-55`): signed in **and not held** → 303 `safe_next(next)`; else `login.html` (a held account gets the page, which shows the change-password step) (app_login.py:49-53 at fd5a375).
- Demo Mode (`demo_mode.py`): same accounts, same cookie; no separate env vars or secret (demo_mode.py:8-11). `GET /demo/login`: signed in and not held → 303 `/demo`; else `demo.html` (37-45). `GET /demo` and `/demo/{rest:path}`: signed out **or held** → 303 `/demo/login?next=<quote("/demo"+("/"+rest))>`; else `demo.html` (46-52). The demo login GET does not consume `next` server-side (INFERRED: the demo frontend reads it).
- Demo UI behaviour (FACT docs/sign-in-and-demo-mode.md:101-113 at fd5a375): opens on Spark AI Spine landing page; header tabs only **Knowledge Graph** and **Fit-Gap Copilot**; **Ask RAG** and the **Agent** sit in a sidebar that **only an Admin sees** (since df034c9): it starts hidden, the menu button opens it, minimizes it to icons and expands it again, state remembered in the browser. Anyone else has no menu button, the landing page shows only the first two steps, and `/demo/ask` or `/demo/agent` lands on the introduction. This is a front-end rule only: the Ask and Evidence APIs are still open to every signed-in user. Excluded from Demo: Convert, Batch Convert, Add to knowledge base, Coverage, Doc vs MD, MD Viewer, InsightLens, RAG Metrics — their `/demo/...` URLs land on the introduction. Bundle `frontend/demo.html` + `frontend/src/demo/`, reusing app page components. Rollout exports use `client=1` from Demo to omit model name (FACT app.py:2813-2814).

---

## 4. Endpoint inventory

Auth column: **Open** = in the middleware's `EXEMPT` set or not under `/api/`; **User** = any signed-in active account (middleware 401 otherwise; endpoints that need the account also `Depends(current_user)`); **Admin** = `Depends(require_admin)` (403 for a User); **own** / **read** / **write** = ownership rule of §3d (`list_owner` / `read_owner` / `write_owner`; not-owned → 404); **Page** = 303 to `/login` when signed out; **Demo** = 303 to `/demo/login`. Every `/api/*` row not marked otherwise is **User**. Redact = RedactContactDetails applies (prefix match).

### 4a. Auth routers

| Method | Path | Auth | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|---|
| GET | `/login` | Open | query `next="/"` | signed-in and not held → 303 safe_next(next); else login.html (503 if unbuilt) | — | app_login.py:47 |
| POST | `/api/auth/login` (+ aliases `/api/app/login`, `/api/demo/login`) | Open | JSON `Login{username:str,password:str}` | 200 `{id,user,username,role,must_change_password}` + Set-Cookie `spark_session`; 401 `{"detail":"Incorrect username or password."}` | `authenticate`; activity `login` / `login_failed` | auth/routes.py:35, 66-69 |
| POST | `/api/auth/logout` (+ `/api/app/logout`, `/api/demo/logout`) | Open | cookie | `{ok:true}`, delete cookie | activity `logout` if signed in | :50 |
| GET | `/api/auth/session` (+ `/api/app/session`, `/api/demo/session`) | Open | cookie | `{id,user,username,role,must_change_password,enabled:true}` or 401 `{user:null, enabled:true}` | — | :59 |
| POST | `/api/auth/password` | User | JSON `PasswordChange{current:str,new:str}` | `{ok:true, …public(user)}` (so `must_change_password:false`) + fresh Set-Cookie (new session_version); 400 `AccountError` text (wrong current password, too short, same as current) | `change_own_password` (clears `must_change_password`, bumps version → other sessions signed out), `forget`, activity `password_changed`. Reachable while held | :72 |
| GET | `/demo/login` | Open | cookie | 303 `/demo` or demo.html | — | demo_mode.py:37 |
| GET | `/demo`, `/demo/{rest:path}` | Demo | — | demo.html or 303 to `/demo/login?next=` | — | :46-47 |

### 4b. SPA page routes (all GET, `response_class=HTMLResponse`, return `_spa()`, Page)
`/` (248), `/convert` + `/extract` (436-437), `/quality` (442), `/ask` (447), `/md-viewer` + `/viewer` (452-453), `/batch` (458), `/coverage` (463), `/review` + `/doc-md-viewer` (468-469), `/about` + `/landing` (474-475), `/admin` (482), `/add-kb` + `/add-to-knowledge-base` (487-488), `/graph` + `/knowledge-graph` (493-494), `/fit-gap` + `/fitgap` (1897-1898), `/rollout` + `/fit-to-standard` (2459-2460), `/evidence` + `/investigate` (2860-2861). (FACT, line numbers in app.py.) `/admin` is served to any signed-in user; only its data (`/api/admin/*`) needs an Admin (FACT comment app.py:480-481). Static: `/assets/*` (3459).

### 4c. Document conversion (single document)

Every `{doc_id}` route below is owner-checked through `_job_dir(doc_id, user)`: only the uploader (the `owner.txt` written by `/api/upload`) reaches the job; anyone else, an Admin included, and a job with no `owner.txt` get 404 "Document not found" (§3d). The three GET routes pass `read=True`, so they also answer any signed-in user for a job marked `shared` by `/api/kb/files/open`; POST convert/embed and DELETE never do.

| Method | Path | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/health` (**Open**) | — | `{ok:true, preview_available:bool, soffice:path|null, pdftoppm:path|null}` | `preview.available/find_soffice/find_pdftoppm` | 253 |
| POST | `/api/upload` | multipart `file` | `{id, filename, format, size, pages, warning}` ; 400 unsupported suffix | writes `.workdir/<id>/source.<ext>`, `name.txt`, `owner.txt` (caller's id); `preview.render(src, job/"preview")` (failure → `warning`, not error) | 264 |
| POST | `/api/convert/{doc_id}` | query `vlm:bool=false`, `provider:str="qwen"` (must be in `converter.VLM_PROVIDERS`, else 400) | `{markdown, vlm_notice, pages, unit, pictures, skipped_images, vlm_images, flows, flow_images, table_images, cv_flow_images, elapsed(2dp), ocr:[{page,image,confidence(1dp),chars}]}`; 500 "Conversion failed: …" | `converter.convert(src, media_dir=job/"media", use_vlm, vlm_provider, title=stem(name.txt))`; writes `output.md`. `vlm_notice` = "`<KEY_ENV>` is not set on the server…" when vlm and provider≠qwen and `vlm_api.available(provider)` false | 301 |
| POST | `/api/docs/{doc_id}/embed` | query `category:str?` | `rag.index_path` result + `duplicates:[path]`, `documents`, `total_chunks`, `seconds`(1dp), `file` (relative); 409 "Convert the document first"; 400 on SystemExit (missing setting); 500 "Embedding failed" | copies to `knowledge_base/<stem>_<ext>.md` (with `rag.declare_category` front matter if category); `rag.index_path(dest, category)` → Postgres insert; `rag.duplicate_sources`, `rag.counts` | 356 |
| GET | `/api/docs/{doc_id}/preview/{number:int}` | — | PNG FileResponse; 404 | `preview.page_path` | 401 |
| GET | `/api/docs/{doc_id}/media/{name}` | — | FileResponse (basename only); 404 | — | 409 |
| GET | `/api/docs/{doc_id}/download` | — | `output.md` as `text/markdown`, filename `<stem>.md`; 404 | — | 417 |
| DELETE | `/api/docs/{doc_id}` | — | `{ok:true}` | `rmtree` job dir | 427 |

### 4d. Knowledge graph & Neo4j

| Method | Path | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/graph/data` | query `categories: list[str]?` (repeatable) | graph dict minus `passages` key | `knowledge_graph.extract_graph(force=False)` → `filter_by_categories` | 499 |
| POST | `/api/graph/rebuild` | query `categories?` | same shape | `extract_graph(force=True)` (rewrites `data/knowledge_graph.json` — INFERRED), `kg_neo4j_load.sync_in_background()` | 515 |
| POST | `/api/graph/cypher/generate` | JSON `CypherQuestion{question: str 3..2000}` | `kg_nl2cypher.generate(q)` result (Cypher text, EXPLAIN-checked, not executed); 503 if Neo4j not configured or `anthropic.AuthenticationError` ("…ANTHROPIC_API_KEY in .env"); 502 RuntimeError / APIStatusError | Claude call | 539 |
| GET | `/api/graph/neo4j/status` | — | `{**kg_neo4j_load.status(), questions: kg_nl2cypher.QUESTIONS}` | — | 562 |
| GET | `/api/graph/quality` | — | `{structure: graph_eval.latest("structure"), questions: latest("questions"), reviewed: bool}`; 503 on exception | — | 572 |
| POST | `/api/graph/quality/structure` | — | `graph_eval.run_structure()` (no model call) | writes eval result (INFERRED) | 586 |
| POST | `/api/graph/quality/questions` | — | `{id}`; 503 not configured; 409 RuntimeError (already running) | `graph_eval.start_questions()` background | 594 |
| POST | `/api/graph/neo4j/sync` | query `force:bool=false` | `kg_neo4j_load.load(force)`; 503 | replaces Neo4j contents | 609 |
| POST | `/api/graph/cypher` | JSON `CypherRequest{query:str 1..20000, params:dict={}, limit:int=200}` | `kg_neo4j_load.query(...)` (READ txn, row cap, timeout); 503 not configured / driver missing / `ServiceUnavailable` ("Start it with: docker compose -f compose.neo4j.yml up -d"); 400 `{code,message}` on `Neo4jError` | — | 623 |
| GET | `/api/graph/model` | query `categories?` | `graph_model.load_model(filtered_graph)` (Neo4j Data Importer model); 404 FileNotFound; 500 | — | 650 |
| POST | `/api/graph/query` | JSON `GraphQueryRequest{query:str="", source_id?:str, target_id?:str}` | `knowledge_graph.query_graph(...)` | — | 682 |

All graph routes are User; none is Admin-only (FACT — no `require_admin` on them).

### 4e. Knowledge-base files & coverage

| Method | Path | Request | Response | Calls / side effects | Src |
|---|---|---|---|---|---|
| POST | `/api/kb/files/open` | query `source:str` (path rel. to BASE or abs) | `{id, filename, format, size, pages, warning, markdown_source, from_upload?:true}`; 400 outside project; 404 no such doc / no original (`detail:{message}`) | Resolves `source` with `_in_this_project` (§8), so a path indexed on another machine is found under this one's corpus; finds original via `_original_of` (see §8); if original is an upload job's `source.*`, reuses that job id; else creates `.workdir/kb<hash10>/source.<ext>` (re-copies if source mtime newer, clearing preview), writes `name.txt`, marks the job `shared` (both branches), renders preview if not already | 816 |
| GET | `/api/coverage` | query `documents:bool=true` | `rag.coverage.collect(include_documents=…)` (read-only) | — | 907 |
| GET | `/api/kb/files` | — | `list[{name,title,source(rel),full_path,size,category,chunks,tokens,is_indexed,indexed_at(iso|null)}]` sorted indexed-first then title | `rag.documents()` (DB, errors swallowed) + unindexed `*.md` in `knowledge_base/` and `solvay-spark/pkg/markdown/` (skip names starting `.`/`~$`; category via `rag.category_for`). Since bd153f1 an indexed row's `size` and relative `source` come from `_in_this_project(stored) or stored`, while `full_path` (and the dedup key) stays the **stored** path, because a delete matches it exactly; a file found on disk whose resolved path is an indexed file's is not listed again as "not indexed" | 954 |
| GET | `/api/kb/files/{filename}` | query `source?` | Markdown FileResponse; 404 | Lookup order: explicit `source` through `_in_this_project` (abs, else BASE-relative) → `knowledge_base/<name>` → each `rag.CATEGORIES[*].folder` → **every** `solvay-spark/*/<rag.MARKDOWN_FOLDER>/` (sorted; `sap/` as well as `pkg/` and `dr/`, since bd153f1) → `rag.find_document(name)` / `name+".md"`, its stored path again through `_in_this_project` | 1045 |
| DELETE | `/api/kb/files/{filename}` | query `category?`, `source?` | `{status:"deleted", filename, deleted_from_db, documents_deleted, category, remaining, file_removed}`; 409 `{message, matches:[{category,title,source}]}` if >1 match and no disambiguator; 400 bad category; 404 `{message,matches}` / "Nothing to delete…"; 500 DB error | `rag.delete_document(name, category, source)`; unlinks `knowledge_base/<name>` only if no indexed doc of that name remains. Any signed-in user may delete (no Admin check — FACT) | 1053 |
| POST | `/api/kb/batch-insert` | multipart `files: list[UploadFile]`, form `category?` | **SSE**: `progress{type:"start",index,total,filename}`, `file_done{type:"done",index,total,filename,title,status,category,chunks,tokens,duplicates}`, `file_error{type:"error",…,error}`, `complete{total,succeeded,failed,total_chunks,total_tokens,total_documents_in_db,total_chunks_in_db,seconds}`, `error{message}`. Pre-stream 400s: no files, bad category, missing `DATABASE_URL`, no `.md/.markdown/.txt` | writes `knowledge_base/<name>` (no category front matter here — FACT, unlike batch embed), `rag.index_path(dest, category)` | 1127 |

### 4f. Batch conversion

Every `{batch_id}` route below is owner-checked through `_batch_dir(batch_id, user)`: only the uploader reaches the batch; anyone else, an Admin included, and a batch with no `owner.txt` get 404 "Batch not found" (§3d).

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| POST | `/api/batch/upload` | multipart `files` | `{batch_id, total, files:[{name,format,size}]}`; 400 none/no supported (silently skips unsupported/hidden) | writes `.workdir/batches/<id>/sources/<name>` and `owner.txt` (caller's id); creates `markdown/` | 1264 |
| POST | `/api/batch/convert/{batch_id}` | JSON `BatchConvertRequest{vlm:bool=false, provider:str="claude"}` | **SSE**: `progress{type:start,index,total,filename}`, `file_done{type:done,index,total,filename,dest_name,markdown,tools:{primary_engine,format,vlm_used,vlm_provider,claude_vlm_images,vlm_images,tesseract_ocr_images,table_cv_tables,flowcharts,skipped_images,total_pictures,pages_or_sheets,unit,elapsed,markdown_length}}`, `file_error{…,error}`, `batch_done{type,total,converted,failed,download_url:"/api/batch/<id>/download"}`; 404 batch/sources missing | `convert()` per file with temp media dir; writes `markdown/<stem>_<ext>.md`. `primary_engine` strings by suffix: xlsx/xlsm/xls "openpyxl (xlsx_tables.py)", xml "xml.etree.ElementTree (xml_tables.py)", html/htm "Docling Native Engine (HTML)", pdf "Docling Native Engine (PDF)", docx/doc "Docling Native Engine (OOXML Word)", pptx/ppt "Docling Native Engine (OOXML PPT) + pptx_flow", else "PIL / Image Processor" | 1308 |
| GET | `/api/batch/{batch_id}/download` | — | zip FileResponse `converted_markdown_<id>.zip`; 404s | writes `batch_<id>_markdown.zip` (ZIP_DEFLATED) | 1437 |
| POST | `/api/batch/{batch_id}/embed` | query `category?` | **SSE**: `progress`, `file_done` (as kb batch-insert), `file_error`, `batch_done{type,total,succeeded,failed,total_chunks,total_tokens,db_documents,db_chunks,seconds}`, `error{type:"error",error}`; 404s; 400 missing DATABASE_URL / bad category | copies each md to `knowledge_base/` with `declare_category` front matter if category; `rag.index_path` | 1461 |

### 4g. RAG / Ask

| Method | Path | Auth | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| GET | `/api/rag/chunk/{chunk_id}` | User | chunk id like `PKG:412` | `{n:0,title,section,content,category,score:0,similarity:null,bm25:null,vector_rank:null,keyword_rank:null,file,source_path,tokens}`; 404 | `rag.chunk(id)` | 1595 |
| GET | `/api/rag/status` | User | — | `{missing:[ANTHROPIC_API_KEY?,DATABASE_URL?], embed_model, embed_provider:"ollama", embed_dimension, answer_model, default_k, documents, chunks, categories:[{…describe(code), documents, chunks}], ingest_categories:[…all registered + held], prompt_hash, tracing:tracing.status(), evaluation:evaluation.status()|{enabled:false,available:false,detail}, error}` | read-only | 1624 |
| POST | `/api/ask` | User | JSON `Question{question:str 1..2000, k:int=rag.DEFAULT_K (1..20), mode:str="hybrid" (∈rag.MODES else 400), categories:list[str]=[]}` (1767) | **SSE** (Redact): first `run{id}` or `run{id, not_saved}`; then pass-through of `rag.ask_events` events: `stage` (may carry `terms`), `trace{id}`, `sources`, `token` (string), `done` (may carry `refused`), and `error{message}` | `ask_store.connect/create_schema/start_run({id:"ask_<hex10>",question,mode,k,categories,answer_model,embed_model,corpus_fingerprint,prompt_hash,user_id})`; activity `run`/`ask`; `save_trace` on `trace`; `save_sources(conn,id,data,terms)` on `sources`; `finish_run(conn,id,answer,data)` on `done`; if `refused` → `_record_unscored` (status skipped, "Not scored: the question was outside this assistant's scope…"), else `_start_judging(run_id)` daemon thread; on exception `fail_run`. All bookkeeping wrapped by `_try` (swallow) | 1799 |
| GET | `/api/ask/runs` | own | query `limit=50` (clamped 1..200), `search=""`, `quality=""` (∈ `ask_store.QUALITY_FILTERS`: low, unfaithful, unsafe, unscored), `scope="mine"` | `{runs, retention: ask_store.RETENTION, filters, low_quality_below: ask_store.LOW_QUALITY}` | — | 3204 |
| GET | `/api/ask/runs/{run_id}/evaluation` | read | — | stored evaluation or `{run_id,status:"none",error:""|why,metrics:{},overall:null,safety:null,terms:{}}`; statuses none/running/done/failed/skipped/abandoned; 404 | — | 3224 |
| POST | `/api/ask/runs/{run_id}/evaluation` | write | — | `{status:"running", run_id, judge_model}`; 404; 409 not done / already running; 503 unavailable / could not start | `_start_judging(run_id, force=True)` | 3244 |
| GET | `/api/ask/runs/{run_id}` | read | — | run + `corpus_changed:bool` (fingerprint differs now), `evaluation`, `review`; 404 | — | 3270 |
| POST | `/api/ask/runs/{run_id}/review` | write | JSON `Review{verdict:str, reviewer:str≤120="" (ignored), note:str≤2000=""}` (3293) | `{status:"saved", run_id, **review}`; 404; 400 bad verdict (ValueError from store) | `ask_store.save_review(conn, id, verdict, user.username, note, user_id)`; if run has `trace_id` and Langfuse on → `lf.create_score(name="human_grounded", value=verdict, trace_id, data_type="CATEGORICAL", comment=note|None, score_id=evaluation.score_id(run_id,"human_grounded"))` + flush | 3299 |
| DELETE | `/api/ask/runs/{run_id}` | write | — | `{status:"deleted", id}`; 404 | `ask_store.delete_run(owner=…)` | 3421 |
| DELETE | `/api/ask/runs` | write | — | `{status:"cleared", removed:int}` — only the caller's own history, Admin or not | `ask_store.clear(owner=…)`; activity `clear_history` | 3430 |

**Judging thread `_judge(run_id, force)`** (FACT app.py:1698-1740): new `ask_store.connect()`, `create_schema`, `get_run`; `start_evaluation(conn, id, evaluation.MODEL)`; if not force and `not evaluation.wanted()` (sampling) → `finish_evaluation` status `skipped`, error `"Not scored: sampling is at {SAMPLE:g}."`; else contexts = `[s.content for s in run.sources]` (rank order preserved), `evaluation.evaluate(question, contexts, answer)`, `push_scores(trace_id, run_id, result)` (errors swallowed), `finish_evaluation(conn, id, result, pushed)`; on exception `fail_evaluation(conn,id,"Type: msg")`; finally `rag.close()`. `_start_judging` (1751) returns False if `evaluation.available()` is false. The thread reads the run without an owner filter (FACT app.py:1710, `get_run(conn, run_id)`); ownership was already checked by the endpoint that started it.

### 4h. Answer Quality workspace (all **Admin**, Redact; `days` clamped 1..365 by `_window`)

| Method | Path | Request | Response | Src |
|---|---|---|---|---|
| GET | `/api/quality/overview` | `days=28, half="", mode=""` | `quality.overview(ask_store.connect(), days, half_, mode)` | 3342 |
| GET | `/api/quality/explorer` | same | `quality.explorer(...)` | 3349 |
| GET | `/api/quality/judge` | — | `quality.judge(conn)` | 3356 |
| GET | `/api/quality/experiments` | — | `{experiments: experiment_store.list_experiments(conn)}` | 3363 |
| GET | `/api/quality/experiments/compare` | `base`, `cand` (required) | `quality.compare(b,c)`; 404 | 3372 |
| GET | `/api/quality/experiments/{experiment_id}/items/{item_id}` | — | `{**item, experiment:{id,name,config}}`; 404 | 3385 |
| POST | `/api/quality/experiments/{experiment_id}/baseline` | — | `{status:"baseline", id}`; 404 | 3399 |
| DELETE | `/api/quality/experiments/{experiment_id}` | — | `{status:"deleted", id}`; 404 | 3410 |

INFERRED: quality aggregates read every user's Ask runs (no owner passed to `quality.*`).

### 4i. InsightLens (`/api/fitgap`, Redact)

Body model `FitGapRun` (FACT 1762-1774): `mode:str="A"`, `scope_bpml:str="4.0"`, `country_profile:dict?`, `asis_dir:str?`, `holdout:bool=false`, `max_steps:int=6 (1..60)`, `concurrency:int=3 (1..8)`, `question:str?`, `categories:list[str]=[]`, `upload_session:str?`. Converted to `backend.agents.fitgap.schemas.RunRequest` with categories validated by `rag.check_category` (400 on ValueError) and, for `run`, `user_id = user["id"]` (app.py:2027-2029).
`FitGapReview` (1790-1796): `reviewer:str≤120=""` (ignored), `verdict:str`, `corrected_classification:str?`, `comment:str=""`.

| Method | Path | Auth | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| GET | `/api/fitgap/status` | User | — | `{bpml: bpml.stats(), model, prompt_hash, max_tool_calls, anthropic_key:bool, runs, entries, reviews, error, documents, chunks, categories:[{code,documents,chunks}], corpus_error?, graph: stats|null, uploads:{ttl_hours,max_files,accepted,database}}` | `fg_store.create_schema`; **sweeps expired upload sessions** (everyone's) if session DB live | 1903 |
| GET | `/api/fitgap/scope` | User | query `q=""`, `code=""` | code → `{process, ancestry:[brief], children:[full], steps:int}` (404 if not BPML); q → `{query, matches:[{…full, steps}]}` (limit 10); neither → `{roots:[{…full, steps}]}` | — | 1960 |
| POST | `/api/fitgap/preview` | User | `FitGapRun` | `orchestrator.preview(RunRequest)`; 400 if `error`; 404 if `upload_session` is someone else's | `_own_upload` | 1999 |
| POST | `/api/fitgap/run` | User | `FitGapRun` | **SSE** (live run, §2a): events from `orchestrator.run(request, stop=stop)`: `scope`, `step_start`, `tool_call`, `entry`, `verify_fail`, `synthesis`, `done` (now with `stopped:bool`); `error{message}`; `: ping` keep-alives; 404 pre-stream for a foreign `upload_session` | `_own_upload`; run owned by the caller; activity `run`/`fitgap` on the first `scope` event carrying `run_id`; `live_runs.start("fitgap", …)` | 2056 |
| GET | `/api/fitgap/runs/{run_id}/stream` | read | — | SSE replay from the first event, then follow; 404 "run <id> is not running" once it is only in the store | — | 2108 |
| POST | `/api/fitgap/runs/{run_id}/stop` | write | — | `{stopping:true, run_id}`; 404 if not live | sets `stop`: steps not yet started are cancelled, steps in flight finish and are still saved, the register is synthesised from what finished and the run is stored with `status='stopped'` | 2119 |
| GET | `/api/fitgap/runs` | own | `limit=40`, `scope="mine"` | `fg_store.list_runs(conn, limit, owner)` | — | 2263 |
| GET | `/api/fitgap/runs/{run_id}` | read | — | run dict incl. `entries`; 404 | — | 2273 |
| GET | `/api/fitgap/runs/{run_id}/export` | read | `format=md|json|xlsx` (else 400) | json: `{run(sans entries), entries, synthesis}` attachment `fitgap_<id>.json`; md: `synthesis.to_markdown(run, results, synth)` `fitgap_<id>.md`; xlsx: workbook (sheets Register, Reuse, Gaps, Decisions, Integrations, Agenda, Review; bold header, frozen row 1, wrap/top alignment, col width 12..60) `fitgap_<id>.xlsx` | synth = stored `run.synthesis` or `synthesis.synthesise(results)`; activity `export` | 2285, 2320 |
| POST | `/api/fitgap/entries/{entry_id:int}/review` | write | `FitGapReview` | `fg_store.add_review(...)`; 404 if no entry or the entry's run is not the caller's | `fg_store.entry_owner(conn, id)` → `(run_id, run user_id)` (fitgap/store.py:310-315); reviewer = caller's username; `add_review(..., user_id)`; activity `review` | 2385 |

XLSX column specs (FACT 2332-2360): Register `[BPML, Step, Class, Confidence, Materiality, Status, Rationale, Tickets, SAP objects, Evidence(count), Docs(sorted set), Verified(yes/no)]`; Reuse `[Process, Steps, Fit, Gap, Unknown, Reuse %, Avg confidence]` from `synth.reuse.by_process`; Gaps `[BPML, Step, Class, Confidence, Materiality, Tickets, Rationale]`; Decisions `[Process, Question, Options, Consequence, Raised by, Weight]`; Integrations `[System, Steps, Impacts("kxv"), Interfaces]`; Agenda `[#, Process, Minutes, Weight, Steps, Gaps, Unresolved, Decisions, Pre-read]`; Review `[Entry id, BPML, Step, Proposed class, Confidence, Reviewer, Verdict (accept/reject/refine), Corrected class, Comment]` (last 4 blank). List cells joined with `\n`.

### 4j. Session attachments (`/api/uploads` — NOT in Redact prefixes; all owner-checked by `_own_upload`, §3d)

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| POST | `/api/uploads` | multipart `files`, form `session=""`, form `role=""` (→ `check_role`, default `other`; 400 invalid) | **SSE**: `session{session}`, per file `start{index,total,filename}`, `stage{index,total,filename,stage:"converting"|"embedding"|"graph",name}`, `done_file{index,total,name,title,role,format,pages,unit,chunks,tokens,seconds,graph}` or `file_error{index,total,filename,message}`, final `done{added,total,**uploads.info(sid)}`, `error{message}`. Pre-stream 400: no files, any unsupported suffix (whole request rejected), none accepted | `uploads.sweep()`; reuse `session` only if it `exists()` **and** `owner(session) == user.id`, else `new_session(user.id)`; copies to `tempfile.mkdtemp()/name`; worker thread `add_file(...)`; tmp dir removed | 2068 |
| GET | `/api/uploads/{session}` | — | `uploads.info(sid)` (§5); 400 bad id; 404 someone else's; 500 | `sweep()` first | 2179 |
| GET | `/api/uploads/{session}/files/{name}/markdown` | — | `text/markdown` body; 400; 404 | reads `upload_files.markdown` | 2192 |
| GET | `/api/uploads/{session}/entities` | query `roles: list[str]?` | `uploads.compare(sid, roles)` → `{documents:[{node_id,label}], entities:[{node_id,type,label,code,ticket,in_corpus,corpus_documents(≤6),corpus_mentions}], shared, new, scope}`; 404 expired / someone else's; 400 | — | 2208 |
| DELETE | `/api/uploads/{session}` | — | `{dropped:true, session}`; 400; 404 someone else's | `uploads.drop` | 2223 |
| PATCH | `/api/uploads/{session}/files/{name}` | query `role` (required) | `{updated,name,role, **info}`; 400; 404 | `UPDATE upload_files SET role` (no re-embed) | 2234 |
| DELETE | `/api/uploads/{session}/files/{name}` | — | `{removed:true, graph, **info}`; 400; 404 | `uploads.remove_file` | 2250 |

### 4k. Fit-Gap Copilot (`/api/rollout`, Redact)

`RolloutRun` (FACT 2404-2417): `scope_bpml:str=""` (empty → agent identifies process), `subject:str="country_as_is"` (must be in `rollout.schemas.SUBJECTS`, else 400), `country:str≤80=""`, `country_context:str≤4000=""`, `sap_release:str≤200=""`, `gt_version:str≤120=""`, `question:str?`, `upload_session:str=""`, `categories:list[str]=[]` → `rollout.schemas.RunRequest` with `user_id = user["id"]`, after `_own_upload` (`_rollout_request`, app.py:2446-2456).
`RolloutDecision` (2433-2443): `gap_id:str 1..40`, `reviewer:str≤120=""` (ignored), `verdict:str` (accept|reject|defer), `disposition:str=""`, `comment:str≤2000=""`, `option_index:int≥0?`, `rationale:str≤2000=""`, `session_id:str≤40?`.
`WorkshopAnswer` (2679): `gap_id:str 1..40, verdict:str, option_index:int≥0?, rationale:str≤2000=""`. `WorkshopSubmit` (2686): `facilitator:str≤120=""` (ignored), `attendees:list[str] (≤60)`, `answers:list[WorkshopAnswer] (1..200)`.

| Method | Path | Auth | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| GET | `/api/rollout/status` | User | — | `{bpml, model, prompt_hash, max_tool_calls, anthropic_key, runs, decisions, pdf:{available,detail}, error, vocabulary:{deviation_types, dispositions, localization_states, dimensions:{k:{label, weight(%int)}}, ratings:{str(k):v}}, subjects:[{value,label,role,localization,score_b}], uploads:{ttl_hours,max_files,accepted,database,roles:[{value,label}]}, documents, chunks, categories, corpus_error?}` (+ `ro_store.stats()`) | — | 2465 |
| POST | `/api/rollout/preview` | User | `RolloutRun` | `orchestrator.preview(req)`; 400 if `error`; 404 foreign upload session | — | 2530 |
| POST | `/api/rollout/run` | User | `RolloutRun` | **SSE** (live run, §2a): `scope`, `stage`, `tool_call`, `asis`, `gate`, `analysis`, `scores`, `done`; `error{message}`; `: ping` keep-alives | orchestrator persists, owned by caller (INFERRED); activity `run`/`rollout` on first `scope` with `run_id`; `live_runs.start("rollout", …)` | 2618 |
| GET | `/api/rollout/runs/{run_id}/stream` | read | — | SSE replay + follow; 404 "run <id> is not running" | — | 2645 |
| POST | `/api/rollout/runs/{run_id}/stop` | write | — | `{stopping:true, run_id}`; 404 if not live | sets `stop`; checked **between model turns** (the turn in flight is not interrupted), the pass raises `agent.Stopped("stopped before it finished")` and the run is recorded as failed | 2656 |
| GET | `/api/rollout/runs` | own | `limit=40`, `scope="mine"` | `ro_store.list_runs(owner)` | — | 2569 |
| GET | `/api/rollout/runs/{run_id}` | read | — | run with `evaluation = agent_eval.refresh(run.evaluation)`; 404 | — | 2579 |
| GET | `/api/rollout/runs/{run_id}/attachments/{file}` | read | `file` = citation md name (e.g. `…Sample_txt.md`) | `text/markdown; charset=utf-8` from kept copy (`ro_store.get_attachment(owner)` → `(kept, upload)`), else from live upload session (matching `uploads.md_name(doc.name)==file`; no upload-session owner check here — FACT 2569-2580); 410 if session swept ("…deleted after N hours unused…"); 404 | — | 2593 |
| DELETE | `/api/rollout/runs/{run_id}` | write | — | `{status:"deleted", id}`; 404 | activity `delete` | 2631 |
| POST | `/api/rollout/runs/{run_id}/decisions` | write | `RolloutDecision` | `ro_store.save_decision(...)`; 400 bad verdict / non-accept without rationale-or-comment ("Say why…") / gap_id not in `run.analysis.deviations` / session_id not a workshop session of run / store ValueError; 404 | append-only decision row (never overwrites proposal), `decided_by` = caller's username, `user_id`; activity `decision` | 2645 |
| POST | `/api/rollout/runs/{run_id}/workshop` | write | `WorkshopSubmit` | `ro_store.submit_workshop(conn, run_id, user.username, attendees, answers, user_id)` (atomic); 404 not the caller's run / LookupError; 400 ValueError (with `conn.rollback()`) | inserts session + decisions; activity `workshop` | 2693 |
| GET | `/api/rollout/runs/{run_id}/workshop/export` | read | `format="pdf"` (∈ `workshop_export.FORMATS`: md/pdf/docx/xlsx per doc — INFERRED from "Markdown, PDF, Word or Excel"), `session=""` | binary/text attachment, filename `wx.filename(run, format, session)`; 400 format; 404 run/session; 503 PDF unavailable; 500 | `contact.redact_obj(run)` first | 2718 |
| GET | `/api/rollout/runs/{run_id}/lineage` | read | `format=""|md|json` | no format → `lineage.build(run)` JSON; else attachment `audit-trail-<id>.<fmt>`; 400 | redact before download | 2756 |
| GET | `/api/rollout/decisions` | User, shared | `country, scope` (BPML), `type, verdict` (all ""), `history:bool=false`, `limit=200` (1..1000) | `{decisions, count}`: every account's decisions (shared organisational memory; each row carries `decided_by` and `user_id`) | `ro_store.list_decisions(current_only=not history)` | 2785 |
| GET | `/api/rollout/runs/{run_id}/export` | read | `format=md|pdf|json` (default md; anything else → md), `client:bool=false` | pdf `application/pdf` filename `ro_pdf.filename(run)` (503 if renderer unavailable; 500 render fail); json `<id>.json`; md `<id>.md` | `redact_obj`, `client_copy(run)` if client; PDF rendered from `export.to_markdown(run)` | 2806 |

### 4l. Evidence Agent (`/api/evidence`, Redact)

`EvidenceQuestion` (2921): `question:str 3..2000`, `holdout:bool=false`, `categories:list[str]=[]`, `memory:bool=false`. `MemoryReflection` (3165): `question:str 3..500`.

| Method | Path | Auth | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| GET | `/api/evidence/status` | User | — | `{model, prompt_hash, max_tool_calls, anthropic_key, tools:[names], categories:[{code,documents,chunks}], error, memory: agent_memory.describe()|{configured:false,available:false,detail}, history: ev_store.stats()|{runs:0,answered:0,error}, duplicate_groups:[[…]], duplicate_threshold, hubs:[{label,degree}] (desc), hub_degree, graph: stats}` | — | 2866 |
| POST | `/api/evidence/ask` | User | `EvidenceQuestion` | **SSE** (live run, §2a, registered under its `ev_` id up front; `: ping` keep-alives): `run{id:"ev_<hex10>"}` / `run{id,not_saved}`; `log{seq,at,kind:"question",text,holdout,scope,memory}`; per agent event: `log` entry then the event itself (except `thinking`/`note`, which emit only `log`); events include `tool_call`, `memory`, `answer`, `error`; `evaluation` events sent without a log line | `ev_store.start_run({id,question,holdout,categories,model,prompt_hash,corpus_fingerprint,user_id})`; activity `run`/`evidence`; on memory → `save_memory`; tool_call → `save_calls(all calls)`; answer → `finish_run(data, calls)`; error → `fail_run`; after each → `save_log(log)`; evaluation → `save_evaluation`. A store failure sets `conn=None` (stops writing; stream continues). Memory facts retained are tagged `user:<username>` (backend/agents/evidence/agent.py:749-750) | 3029 |
| GET | `/api/evidence/runs/{run_id}/stream` | read | — | SSE replay + follow; 404 "run <id> is not running" | — | 3167 |
| POST | `/api/evidence/runs/{run_id}/stop` | write | — | `{stopping:true, run_id}`; 404 if not live | sets `stop`; checked before each model turn, the agent raises `Stopped`, the run is recorded through `fail_run` and the stream ends with `error` | 3178 |
| GET | `/api/evidence/runs` | own | `limit=50` (1..200), `scope="mine"` | `ev_store.list_runs(owner)` | — | 3096 |
| GET | `/api/evidence/runs/{run_id}` | read | — | run with refreshed `evaluation`; 404 | — | 3109 |
| GET | `/api/evidence/runs/{run_id}/lineage` | read | `format=""|md|json` | as rollout lineage | — | 3124 |
| DELETE | `/api/evidence/runs/{run_id}` | write | — | `{status:"deleted", id}`; 404 | activity `delete` | 3153 |
| POST | `/api/evidence/memory/reflect` | **Admin** | `MemoryReflection` | `agent_memory.reflect(question, context="The Evidence Agent's memory of its own investigations of the Solvay SPARK L2C corpus. Answer only from those memories.")`; 503 memory unavailable; 502 if result.error | Hindsight LLM call | 3169 |

Evidence log entry shapes (FACT 2948-2985): base `{seq, at (UTC ISO ms), kind}`; `tool_call` adds `tool, engine, summary, ms, error, warning, arguments, call(index into calls)`; `thinking` → `text[:6000], turn`; `note` → `note(kind), title, text[:6000], detail`; `memory` → `used, recalled, suppressed_by_holdout, memories:[text[:600]]`; `answer` → `state, claims(count), text[:2000], detail:{tool_calls,input_tokens,output_tokens,seconds}`; `error` → `text[:2000]`.

### 4m. Admin API (`backend/api/admin.py`, prefix `/api/admin`, all **Admin**) — FACT throughout

Run rows are read from the four run tables through one `UNION ALL` (`_runs_sql`, admin.py:41-58) with columns `tool, id, user_id, started_at, status, seconds, input_tokens, output_tokens, model`; tables that do not exist yet are left out (`information_schema.tables` check). Per tool (admin.py:32-37): `evidence` → `evidence_runs`, `seconds`, `model`; `ask` → `ask_runs`, `seconds`, `answer_model`; `fitgap` → `fitgap_runs`, `EXTRACT(EPOCH FROM finished_at - started_at)`, `model`; `rollout` → `rollout_runs`, same span, `model`. `TOOLS = ("evidence","ask","fitgap","rollout")`. Usage is not stored separately; sign-ins come from `activity_events`.

`_window(start, end)` (admin.py:61-73): UTC `[start 00:00, end+1 day)`; defaults to the last 30 days ending today; 400 "`from` is after `to`"; 400 "Ask for a year or less at a time" if span > 366 days.

| Method | Path | Request | Response | Side effects | Src |
|---|---|---|---|---|---|
| GET | `/api/admin/users` | — | `{users:[{id,username,role,active,session_version,created_at,last_login_at,last_seen_at,must_change_password,runs}]}` (excludes `legacy`; `runs` = all-time count across tools) | — | admin.py:91 |
| POST | `/api/admin/users` | JSON `NewUser{username:str 1..64, password:str 1..200, role:str="user", must_change_password:bool=true}` | the user dict; 400 `AccountError` text (bad name, role, short password, duplicate) | `store.create_user(must_change=…)` — the owner must choose their own password at first sign-in unless the caller opts out (only `loadtest/seed_users.py` does); activity `user_created` `{user, role}` | :101 |
| PATCH | `/api/admin/users/{uid}` | JSON `UserChange{role?:str, active?:bool, password?:str≤200, must_change_password:bool=true}` (applies only with a new password) | updated user dict; 400 `AccountError` (no such account, self-demotion/deactivation, last active Admin, short password) | `store.update_user(acting=admin.id)` (password/deactivation bump `session_version`); `middleware.forget(uid)`; activity `user_updated` with changed fields, password shown as `"reset"`, `must_change_password` never logged | :111 |
| GET | `/api/admin/usage` | query `start?:date`, `end?:date` (YYYY-MM-DD, both inclusive), `user_id?:int` | `{from, to, tools, totals:{runs, failed, seconds, input_tokens, output_tokens, cost_usd, cost_by_tool:{tool:usd}, unpriced_runs, unpriced_models:[…], logins, failed_logins, active_users, by_tool:{tool:runs}}, users:[{user_id, username, role, active, last_login_at, last_seen_at, tools:{tool:{runs,failed,seconds,input_tokens,output_tokens,cost_usd,unpriced_runs}}, runs, failed, seconds, input_tokens, output_tokens, cost_usd, unpriced_runs, logins, failed_logins}], daily:[{day, evidence, ask, fitgap, rollout}]}` | read-only | :130 |
| GET | `/api/admin/activity` | `limit=100` (1..500), `before?:int` (id), `user_id?:int`, `action=""` | `{events:[{id,at,user_id,username,action,tool,run_id,detail}], more:bool, actions:[distinct action names]}` newest first, paged by id | — | :260 |
| GET | `/api/admin/runs` | `user_id?:int`, `tool=""` (∈ TOOLS else 400), `limit=50` (1..200), `before=""` (ISO `started_at`) | `{runs:[{tool,id,user_id,username,started_at,status,title(≤240),seconds(1dp),tokens(in+out)}], more:bool}` newest first; without `user_id`, everyone's | titles: `question` (evidence, ask), `COALESCE(NULLIF(question,''), scope_label)` (fitgap), `concat_ws(' · ', country, scope_label, question)` (rollout) (admin.py:291-297). The run itself opens through its tool's own endpoint (Admin = `read_owner` None) | :300 |

**Usage computation** (admin.py:138-257): groups runs by `(user_id, tool, model)` in the window (optional `user_id` filter), counting `status = 'failed'`; logins and failed logins per user from `activity_events` (`action = 'login'` / `'login_failed'`), plus failed logins with no user (unknown username) added to `totals.failed_logins`. Rows for `uid` not in `list_users` are labelled `legacy` (if the legacy id) or `#<uid>`. Every account gets a row even with no activity unless `user_id` narrows the view. Cost per `(user, tool, model)` cell = `pricing.cost(model, tin, tout)`; a model with no price and non-zero tokens adds to `unpriced_runs` and `unpriced_models`. Cents are rounded once per tool cell; user and period totals are sums of rounded cells (so columns add up to the cent). `active_users` counts rows with runs or logins, excluding `legacy`. Rows sorted by runs desc, then username. `daily` has one entry per day in the window with zero-filled counts per tool (UTC date).

**Cost estimate (`backend/core/pricing.py`)** — FACT: `PRICES` = USD per million tokens `(input, output)`: `claude-fable-5-1` and `claude-fable-5` (10, 50); `claude-opus-5-5` (4, 20); `claude-opus-5`, `-4-8`, `-4-7`, `-4-6` (5, 25); `claude-sonnet-5-5`, `claude-sonnet-5` (2, 10); `claude-sonnet-4-6` (3, 15); `claude-haiku-4-5` (1, 5) (pricing.py:23-35). `price(model)`: lower-cased, `anthropic.` prefix removed, exact match, else longest listed stem followed by `-` or `@` (dated or provider ids); None if unlisted (38-51). `cost = (in·p_in + out·p_out)/1e6` or None (54-59). Documented as an over-estimate: run tables record input tokens as one number including cache reads/writes, all priced at full input rate; calls with no run row (scope guard, Ragas judge, Hindsight, embeddings) are not counted (pricing.py:3-14).

**Route count** (FACT, counted from the routers and app.py decorators at fd5a375): **132 routes** + 1 static mount (`/assets`). app.py: 112 decorators (the 106 of `1d37131` plus `/stream` and `/stop` for each of fitgap, rollout and evidence), 24 of them HTML SPA pages; `backend/auth/routes.py`: 10 (3 handlers × 3 prefixes + `/api/auth/password`); `app_login.py`: 1 (`/login`); `demo_mode.py`: 3 (`/demo/login`, `/demo`, `/demo/{rest:path}`); `admin.py`: 6. FastAPI's own `/docs`, `/docs/oauth2-redirect`, `/redoc`, `/openapi.json` are not counted.

---

## 5. Session attachments model (`backend/core/uploads.py`) — FACT unless noted

- Purpose: per-session documents for InsightLens and Fit-Gap Copilot, isolated from the corpus by a **separate database** `<base>_session` (e.g. `DATABASE_URL=.../docling` → `.../docling_session`, via `rag.sibling_database("SESSION")` lower-cased; FACT rag.py:265-277) with **one Postgres schema per session** `u_<sid>` containing the same `rag_documents`/`rag_chunks` tables as the corpus (created by `rag.create_schema(scoped_conn)`).
- DB created lazily on first write: `rag.ensure_sibling` connects to `/postgres` maintenance DB with autocommit and creates it (rag.py:328+). `live()` = cached `database_live` check, so read-only callers don't create it.
- `sid` = `uuid4().hex[:12]`, validated by regex `[0-9a-f]{12}` (fullmatch, lower-cased) because it is interpolated into identifiers.
- **Ownership**: `upload_sessions.user_id bigint`, no foreign key (accounts live in the main database); sessions from before accounts have NULL and belong to nobody (uploads.py:219-222). `new_session(user_id=None)` records it (234-252). `owner(sid)` → `user_id` of a live (unexpired) session, else None; None also when the DB is not live (268-277). Enforcement is in app.py (`_own_upload`, §3d), not in uploads.py.
- Connections: `threading.local` cache, one psycopg conn per (thread, schema); `SET search_path TO "<schema>", public` (public for `vector` type). `close()` closes this thread's conns.
- Env: `FITGAP_UPLOAD_TTL_HOURS` (default 12; interval `max(TTL,0.1) hours`), `FITGAP_UPLOAD_MAX_FILES` (default 12).
- Roles: `ROLES = ("as_is","template","sap_bp","localization","other")`, default `other`; labels `Country As-Is, Global Template, SAP Best Practice, Localization source, Reference`. Category on chunks: `UPLOAD` (reserved in rag.py).
- Files on disk: `.workdir/uploads/<sid>/<stem>_<ext>.md` (`md_name`: suffix lower, `.`→`_`), plus `media/`. Markdown also stored in DB and restored to disk if missing when rebuilding graph.

**DDL (verbatim, public schema of session DB, uploads.py:175-224, run once per process inside a transaction):**
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
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS user_id bigint;
```
`_meta_ready` flag set only after success (guarded by lock).

**Lifecycle functions:**
- `new_session(user_id=None)`: insert row `(id, expires_at = now() + ttl, user_id)`, `CREATE SCHEMA IF NOT EXISTS "u_<sid>"`, `rag.create_schema(scoped)`, mkdir.
- `exists(sid)`: false if DB not live; row with `expires_at > now()`.
- `owner(sid)`: see Ownership above.
- `touch(sid)`: `used_at=now(), expires_at=now()+ttl` (sliding expiry) — called at end of `add_file`.
- `drop(sid)`: `DROP SCHEMA … CASCADE`, delete row, rmtree dir, close cached conn.
- `sweep()`: drop expired sessions (any owner); drop orphan schemas matching `u_[0-9a-f]{12}` not in table (query `pg_namespace WHERE nspname LIKE 'u\_%'`); remove dirs in `.workdir/uploads` not in table. Triggered by `/api/fitgap/status`, `POST /api/uploads`, `GET /api/uploads/{s}` — no timer (FACT; INFERRED: no scheduled sweep exists).
- `add_file(sid, src, name, role, on_event)`: requires session exists; count < MAX_FILES else ValueError; Langfuse run `ingest-document` (as_type `chain`, input `{name,role,bytes}`, metadata `{session,schema,category}`, `session_id=sid`, tags `["upload", "role-<role>"]`) (uploads.py:390-397); stage `converting` → step `convert-to-markdown` (`converter.convert(src, media_dir=folder/"media", title=stem)`), write md; stage `embedding` → step `chunk-and-embed` (as_type `embedding`, model `rag.EMBED_MODEL`) `rag.index_file(session_connect(sid), md, category="UPLOAD")` (not forced; unchanged fingerprint costs nothing); upsert `upload_files` (ON CONFLICT (session_id,name) DO UPDATE all cols + `added_at=now()`); stage `graph` → step `extract-graph` `rebuild_graph(sid)`; `touch`; returns `{name,title,role,format,pages,unit,chunks,tokens,seconds,graph}`. On convert/embed failure `run.fail`, `run.end`, re-raise.
- `remove_file`: delete row RETURNING, `DELETE FROM rag_documents WHERE source = <abs md path>` in session schema (INFERRED: chunks cascade), unlink md, rebuild graph.
- `rebuild_graph(sid)`: `knowledge_graph.extract_graph(files=[(path, "upload/<name>", "UPLOAD")], cache=False)` (cache=False mandatory so it doesn't overwrite global knowledge_graph.json); empty → `{"nodes":[],"edges":[],"stats":{"total_nodes":0,"total_edges":0,"types":{}}}`; stored in `upload_sessions.graph` jsonb; returns stats subset.
- `compare(sid, roles, categories)`: upload document nodes (`doc:<md file>`) + one-hop neighbours vs main graph (optionally category-filtered), with which corpus documents mention each entity; sorted (in_corpus first, type, label).
- `search(sid, query, k=8, mode="hybrid", roles)`: `rag.search(..., conn=session_connect(sid))`, overfetch ×4 and filter by role via `roles_by_source`.
- `chunk(sid, chunk_id:int)`: SELECT join `rag_chunks c JOIN rag_documents d` → `{chunk_id,title,source,heading_path,content,tokens,category:"UPLOAD"}`.
- `info(sid)`: `{session, exists, created_at, used_at, expires_at, ttl_hours, max_files, database, schema, files:[{name,role,role_label,format,bytes,pages,unit,chunks,tokens,seconds,added_at}], documents, chunks, tokens, graph:{total_nodes,total_edges,entities,documents}}` or `{session,exists:false,files:[],documents:0,chunks:0}`. Does not include `user_id`.
- `titles(sid, roles)`: titles from session `rag_documents`.

---

## 6. Tracing (`backend/core/tracing.py`) — FACT unless noted

- Loads `ROOT/.env` with `load_dotenv(override=False)` at import (58).
- `ENABLED = bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)`; half-configured = off. `ENVIRONMENT = LANGFUSE_TRACING_ENVIRONMENT or "development"`. Also `LANGFUSE_RELEASE` (client release), `LANGFUSE_BASE_URL` (read by SDK; shown in status/start line, default text "cloud").
- `client()`: lazy, double-checked lock; `Langfuse(environment, release, mask_otel_spans=_mask_otel_spans)`; `_instrument()` → `AnthropicInstrumentor().instrument()` + `ThreadingInstrumentor().instrument()` (opentelemetry), exceptions swallowed (uvicorn --reload); `atexit.register(shutdown)`. Failure → warning, `_client=None`; `_started=True` either way.
- Masking at export (`_mask_otel_spans`, applies to all OTEL span string attributes incl. Anthropic spans): `_SECRETS` regex → `[REDACTED]` (`sk-ant-…{8,}`, `(pk|sk)-lf-…{8,}`, `postgres(ql)?://user:pass@`, JWT-like three 20+ segments) and `_EMAIL` → `[EMAIL]`. Document text not masked.
- `start()` (called in lifespan): returns/prints one of: "Langfuse tracing is off: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to turn it on." / "…configured but the client failed to start; see the log." / "Langfuse rejected these credentials; nothing will be traced." (`auth_check()` false) / "Langfuse could not be reached (<exc>); traces will be dropped." / "Langfuse tracing is on (<BASE_URL|cloud>, environment=<env>)."
- `flush()`, `shutdown()` safe no-ops when off.
- `_Null` / `NULL`: accepts `update/end/score/start_observation/start_as_current_observation` and does nothing.
- `Run(span, attrs)`: `__bool__`, `trace_id` ("" when off), `url()` via `client().get_trace_url`, `current()` (context manager: `otel.use_span(span._otel_span, end_on_exit=False)` + `langfuse.propagate_attributes(**attrs)` — used around single model calls inside generators), `step(name, as_type="span", **kw)` (child via `self._span.start_as_current_observation` under `propagate_attributes`; yields NULL on failure/off), `update`, `fail(exc)` → `level="ERROR", status_message`, `end(**kw)` (update, end, set None, flush; idempotent).
- **Trace user**: `USER: ContextVar[str | None]` (`"trace_user"`, default None) (tracing.py:376-382), set to the signed-in **username** by the auth middleware on every request (auth/middleware.py:107-108). `start_run` uses `user_id = user_id or USER.get()` (tracing.py:402), so every trace a request opens carries the username as Langfuse `user_id` without threading it through agent signatures. Context variables follow the request into Starlette's threadpool; a thread an agent starts itself does not inherit them and must pass `user_id` explicitly (comment tracing.py:376-381). The live-run thread (§2a) runs in a copy of the request context for exactly this reason; for one commit (ae1e4eb) it did not, and InsightLens and Copilot traces reached Langfuse with no user. INFERRED: the upload worker (`threading.Thread`, app.py:2150) passes none, so `ingest-document` traces carry no user.
- `start_run(name, *, input, metadata, session_id, user_id, tags, as_type="agent")` (tracing.py:385) → attrs `{trace_name, session_id?, user_id?, tags?, metadata?}`; root via `lf.start_observation(name, as_type, input, metadata)` inside `propagate_attributes`. Returns `Run(None, {})` when off.
- `observation(name, as_type, **kw)`: child of ambient current observation (`lf.start_as_current_observation`).
- `status()` → `{enabled, environment, host}` (used by `/api/rag/status`).
- Design: explicit parenting because generators are resumed on arbitrary threadpool threads (doc string 25-34). Model calls traced automatically by the Anthropic OTEL instrumentor (not by hand).
- What is traced (FACT docs/tracing-and-evaluation.md): one trace per run for Fit-Gap Copilot (`rollout-analysis` with `read-as-is`, `compare-to-template`, `quality-gates` children), InsightLens, Evidence Agent, `/ask`; plus `ingest-document` per attachment (uploads.py:390). Langfuse session = upload session id; Langfuse user = username (above).
- Scores pushed: Ask — `evaluation.push_scores` writes each Ragas metric value (NUMERIC, or BOOLEAN for names in `evaluation.BOOLEAN`), `overall_quality`, `safety`, comments ≤1000 chars, deterministic `score_id(run_id, name)` (FACT backend/rag/evaluation.py:755-786); human review `human_grounded` CATEGORICAL (app.py:3322-3325). Agents (Evidence, Rollout) — `agent_eval.py` scores listed in doc: `citation_validity, claims_unsupported, tool_error_rate, redundant_tool_calls, required_tools_met, submitted_first_try, budget_exhausted, tool_calls, task_completed, gate_hard_issues, gate_soft_issues, topic_adherence, web_query_on_topic, scope_refused, scope_guard_fail_open, contact_in_output, contact_leak, web_gate_blocks, web_query_leak_attempts`; trace tags `evidence-agent`, `rollout-agent`.
- Evaluation env (doc): `RAG_EVAL=off` disables; off automatically without Ragas or `ANTHROPIC_API_KEY`; judge default `claude-sonnet-5`; sampling (`evaluation.SAMPLE`, `wanted()`) — env name not in my files (gap).

---

## 7. Error-handling conventions

- `HTTPException(status, detail)` with string detail; structured detail dicts for KB delete/open (`{message, matches}`) and Cypher (`{code, message}`). Status semantics used: 400 validation/bad input (incl. `AccountError` sentences), 401 not signed in ("Sign in first." from middleware or `current_user`; "Incorrect username or password." from login), 403 signed in but not an Admin ("Only an Admin can do that."), 404 missing **or not owned by the caller** (run, entry, upload session, conversion job, batch), 409 conflict/precondition (not converted, already scoring, ambiguous name, job running), 410 gone (swept attachment), 500 unexpected, 502 upstream model error, 503 dependency unavailable (Neo4j, Claude key, PDF renderer, memory server, unbuilt UI).
- `SystemExit` from `rag.py` (missing settings) is caught and turned into 400 or an SSE `error` (app.py:392, 1873, 2040).
- `_try(fn, *args)` swallows bookkeeping errors so history writes never replace the answer (app.py:3079-3085). Stream start emits `run{id, not_saved}` when the DB is unavailable. `auth_store.log_event` likewise never raises (store.py:371-386).
- Error message format for unexpected exceptions: `f"{type(exc).__name__}: {exc}"`.
- Observability/scoring failures logged at debug and ignored ("an observability tool may not break the tool").
- Progress mechanisms: SSE event streams (per-file `progress/start` → `file_done|file_error` → summary); upload stages via queue from worker thread; Ask evaluation status polled via `GET /api/ask/runs/{id}/evaluation` (statuses none/running/done/failed/skipped/abandoned); graph question-check via returned id + `GET /api/graph/quality`.

---

## 8. Original-file resolution for review (`/api/kb/files/open`) — FACT app.py:691-813
- `_original_name(md)`: `stem.rpartition("_")` → `"<stem>.<suffix>"` (e.g. `Pricing_xlsx.md` → `Pricing.xlsx`).
- `_original_folders(md)`: `[md.parent.parent, md.parent]`.
- `_beside_markdown`: try converter name in each folder (must be file with ACCEPTED suffix); then glob `<glob.escape(md.stem)>.*` (sorted, excluding md itself).
- `_upload_job_holding`: scan `.workdir/*/name.txt` (sorted) for matching name (case-insensitive) or same stem; return first ACCEPTED `source.*`.
- `_original_of = _beside_markdown or _upload_job_holding`.
- **`_in_this_project(path)`** (bd153f1, app.py:818-843 at fd5a375): `path` as it lies under BASE on this machine, or None. `rag_documents.source` holds the absolute path a document was indexed from, and a database restored from a dump keeps the indexing machine's paths (`/Users/<dev>/…/solvay-spark/sap/markdown/BKP1_CRM.md`), which the container (rooted at `/app`) does not have. Rule: if `path.resolve()` is a file under BASE, return it; else find the first path part in `_CORPUS_ROOTS = ("solvay-spark", "knowledge_base")` and try `BASE.joinpath(*parts[i:])`, accepted only if it is a file under BASE. Used by `POST /api/kb/files/open` (400 "That path is outside the project." only when nothing is found **and** the path is outside BASE; else 404), `GET /api/kb/files/{filename}` and `GET /api/kb/files` (§4e).

---

## 9. DB tables touched directly in these files
- Main database (`rag.base_url()`): `users`, `activity_events` (DDL §3a). `own_table` adds `user_id` + `<table>_user_idx` to each of `OWNED_TABLES` (§3d); `reassign_legacy` updates them.
- Session DB public schema: `upload_sessions` (now with `user_id`), `upload_files` (DDL §5); per-session schemas `u_<sid>` with `rag_documents`, `rag_chunks` (DDL owned by `rag.create_schema`, other section).
- Direct SQL in app.py: none any more — the old `SELECT 1 FROM fitgap_entries` is replaced by `fg_store.entry_owner` (app.py:2392). Direct SQL in admin.py: `information_schema.tables` probes and read-only `SELECT`s over `UNION ALL` of `evidence_runs`, `ask_runs`, `fitgap_runs`, `rollout_runs` (columns `id, user_id, started_at, finished_at, status, seconds, input_tokens, output_tokens, model/answer_model, question, scope_label, country`), joined to `users`, and over `activity_events` (admin.py:41-58, 147-165, 275-283, 313-338).
- All other persistence via stores: `ask_store`, `backend.agents.fitgap.store`, `backend.agents.rollout.store`, `backend.agents.evidence.store`, `backend.rag.experiment_store`, `graph_eval` (each `create_schema(conn)` called lazily per request and, for the four run stores, once at startup — DDL in those modules, not here). Evidence table name `evidence_runs` mentioned (app.py:2937).

---

## 10. Gaps / not determined from these files
- Exact event payloads of `rag.ask_events`, fitgap/rollout orchestrators, evidence agent (only event names known here).
- DDL for ask_store, fitgap/rollout/evidence stores, experiment_store, rag tables — owned by other modules (each now also calls `own_table`).
- `ask_store.RETENTION`, `LOW_QUALITY`, `evaluation.SAMPLE`/its env var, `rag.MODES`, `rag.DEFAULT_K`, `rag.CATEGORIES`, `VLM_PROVIDERS`, `preview.IMAGE_FORMATS`, `workshop_export.FORMATS` values not read here.
- `contact.redact` full regexes (phone heuristics) only skimmed.
- Per-chunk redaction in the ASGI middleware can miss an e-mail split across two SSE chunks (INFERRED risk).
- No rate limiting (including on login), no upload size cap, no CSRF protection (cookie is `SameSite=Lax`), cookie lacks `secure` (FACT by absence). `/api/*` now requires a session; runs, upload sessions and conversions are owned, but any signed-in User can still use the shared endpoints, including KB deletion, graph rebuild/Neo4j sync and reading every workshop decision (shared by design).
- The app docstring still says "no auth, no upload cap" (app.py:4-6) — stale for auth.
- Account cache is per process (30 s); behaviour with multiple workers is not addressed (single process today).
