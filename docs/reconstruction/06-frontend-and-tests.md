# 06 — Frontend UI and Test Suite

Scope: `frontend/` (React SPA, three Vite bundles), `frontend/test/*`, `backend/tests/*`, `loadtest/*`, `docs/dark-theme.md`, `docs/demo-video/`.
Notation: **FACT (file:line)** = read directly; **INFERRED** = deduced from names/comments, not verified line by line. Paths are relative to repo root; `src/` = `frontend/src/`.
Current as of commit 1d37131 (2026-10-05) plus the uncommitted ownership and start-up fixes in the working tree; backend line numbers are at that working tree.

---

## 1. Frontend build

| Item | Value | Source |
|---|---|---|
| Package | `solvay-spark-spine` v1.0.0, `"type": "module"`, private | FACT frontend/package.json:1-5 |
| Scripts | `dev` = `vite`; `build` = `tsc --noEmit && vite build`; `typecheck` = `tsc --noEmit` | FACT package.json:6-10 |
| No test script | Frontend tests are run directly with `node test/<name>.mjs` | FACT package.json (no `test` key) |
| Entry pages (multi-page) | `main: index.html` → `/src/main.tsx` (the app); `demo: demo.html` → `/src/demo/main.tsx`; `login: login.html` → `/src/login/main.tsx` | FACT vite.config.ts:12; index.html, demo.html, login.html |
| Output dir | `../static/dist` (i.e. repo `static/dist`), `emptyOutDir: true`, `chunkSizeWarningLimit: 2000` | FACT vite.config.ts:8-10 |
| Served by | FastAPI serves `static/dist` at `/` and `/ask`; `demo_mode.py` serves demo at `/demo`; `/login` served by app_login. Accounts live in Postgres (`backend/auth/`) | FACT comments vite.config.ts:4,11; login/main.tsx:1-3; demo/main.tsx:1-2 |
| Session guard | `src/main.tsx` and `src/demo/main.tsx` call `installSessionGuard(loginPath)` before rendering (see §2.2) | FACT main.tsx:4-8; demo/main.tsx:7-9 |
| Dev server | `:5173`, proxy `/api` → `http://localhost:8000` (`changeOrigin: true`) | FACT vite.config.ts:5,15-17 |
| HTML titles | `Spark AI Spine`, `Spark AI Spine — Sign in`, `Spark AI Spine — Demo`; favicon = inline SVG 📄 emoji | FACT index/login/demo.html |
| TS config | target ES2022, lib ES2023+DOM, module ESNext, `moduleResolution: bundler`, `jsx: react-jsx`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, `noEmit`, `types: ["vite/client"]`, include `src`, `vite.config.ts` | FACT tsconfig.json |
| `*.png` module decl | `src/assets.d.ts` declares `*.png` → string URL | FACT |
| Branding asset | `src/assets/logo.png` (teal + dark navy mark, transparent bg) | FACT BrandLogo.tsx:1-6 |

**Dependencies (FACT package.json:11-30)**
- runtime: `react ^19.3.0`, `react-dom ^19.3.0`, `@mui/material ^9.4.0`, `@emotion/react ^11.14.0`, `@emotion/styled ^11.14.1`, `framer-motion ^13.4.0`, `lucide-react ^1.46.0` (icons), `d3 ^7.9.0` + `@types/d3 ^7.4.3` (graph canvas/force sim, Admin daily bars), `marked ^12.0.2` (Markdown), `dompurify ^3.4.15` (sanitise), `mermaid 10.9.1` (pinned, diagrams in Markdown), `react-resizable-panels ^4.12.4` (split panes: `Group/Panel/Separator`).
- dev: `typescript 5.9`, `vite ^8.3.0`, `@vitejs/plugin-react ^6.1.1`, `@types/react ^19.3.0`, `@types/react-dom ^19.3.0`.
- No router library: routing is hand-rolled with `history.pushState` + `popstate` (FACT App.tsx:134-150,193-217).

**Source layout (FACT, `ls`)**
```
src/main.tsx            installSessionGuard("/login"); createRoot(#root) <StrictMode><App/></StrictMode>
src/App.tsx             shell: AppBar, tab bar, Admin button, account menu, routing, theme toggle
src/api.ts              ALL typed API calls (2550 lines)
src/auth.ts             signed-in account, session guard, sign-out, password change, history scope
src/useHistoryScope.ts  React hook over the history scope (useSyncExternalStore)
src/runRequest.ts       RunRequest {id, nonce}: "open this run" handed from Admin to a tool page
src/theme.ts            MUI theme + Catppuccin Frappé palette
src/pages/*             14 pages (see §3)
src/components/*        drawers & views (incl. AccountMenu, SignInForm); subdirs ask/, evidence/, quality/, rollout/
src/data/               askSamples.ts (8+ samples), evidenceSamples.ts (8), evalQuestions.ts (27 eval Qs)
src/demo/               Demo Mode bundle: main, DemoApp, DemoShell, DemoLanding, DemoLogin
src/login/main.tsx      /login bundle
src/assets/logo.png
```
Largest files (lines): KnowledgeGraphPage 2974, api.ts 2550, RolloutPage 2329, FitGapPage 2164, EvidencePage 1412, BatchConvertPage 1386, AddToKnowledgeBasePage 1310, AdminPage 1068, AskPage 1066, DocMdViewerPage 1040 (FACT wc -l).

---

## 2. Shell, navigation and routing (App.tsx)

- Product name constant `PRODUCT = "Spark AI Spine"`; `document.title = "Spark AI Spine — <tab label>"` or `"… — Enterprise Document Intelligence"` on landing (FACT App.tsx:37,206-211).
- Header: dense `AppBar` (minHeight 52) → clickable brand (BrandLogo 30px + "Spark AI **Spine**", tooltip "Home / About Spark AI Spine", goes to landing) → scrollable `Tabs` → theme toggle (Sun/Moon, animated rotate) → **Admin** button (Admins only) → **account menu** (FACT App.tsx:246-364).
- On mount the shell reads the account with `currentAccount()` (GET /api/auth/session); until it resolves, Admin-only tabs stay hidden (FACT App.tsx:166-172).
- Sign out is in the account menu, not a header icon (§2.1).
- **All pages stay mounted** (absolute-positioned boxes, `display:none` when inactive, framer-motion fade/slide 0.2s) so state survives tab switches; `MOUNTED` is derived from `TABS` + `"landing"`, so it includes `admin` (FACT App.tsx:66-73,367-410). Pages receive `active` to trigger loads only when visible.
- `MotionConfig reducedMotion="user"` honours OS reduce-motion (FACT App.tsx:244).
- Global `.pane-separator` styles for resizable panels (width 6, divider colour, primary on hover/active) (FACT App.tsx:235-242).
- Cross-page handoff: InsightLens "show in graph" → `setGraphQuery({text, nonce: Date.now()})` + navigate to graph; KG page runs the query once per nonce (FACT App.tsx:180,226-229; KnowledgeGraphPage.tsx:1150-1155).
- Admin → tool handoff: `openRunIn(tool, id)` maps `UsageTool` (ask/evidence/fitgap/rollout) to its page, stores `runRequests[page] = {id, nonce: Date.now()}` and navigates; Ask, Agent, InsightLens and Fit-Gap Copilot receive it as `openRun` and load that run (FACT App.tsx:182,219-224,388-406; runRequest.ts:1-7).

**Tabs, groups, paths (FACT App.tsx:42-61,117-150)**

| # | Page key | Tab label | Icon (lucide) | Group (accent) | Canonical path | Aliases accepted | Who sees it |
|---|---|---|---|---|---|---|---|
| 1 | ask | Ask RAG | MessageSquareText | engine (primary) | /ask | | all |
| 2 | quality | RAG Metrics | Gauge | engine | /quality | | **Admin only** (`adminOnly`) |
| 3 | graph | Spine | Network | engine | /graph | /knowledge-graph | all |
| 4 | evidence | Agent | FlaskConical | engine | /evidence | /investigate | all |
| 5 | fitgap | InsightLens | Scale | engine | /fit-gap | /fitgap | all |
| 6 | rollout | Fit-Gap Copilot | Globe2 | engine | /rollout | /fit-to-standard | all |
| 7 | extract | Convert | FileText | convert (warning) | /convert | /extract | all |
| 8 | batch | Batch Convert | FolderArchive | convert | /batch | | all |
| 9 | add-kb | Add to knowledge base | DatabaseZap | index (success) | /add-kb | /add-to-knowledge-base | all |
| 10 | coverage | Coverage | ListChecks | inspect (purple = searchColors.keyword) | /coverage | | all |
| 11 | review | Doc vs MD | ScanEye | inspect | /review | /doc-md-viewer | all |
| 12 | viewer | MD Viewer | Columns2 | inspect | /md-viewer | /viewer | all |
| 13 | admin | Admin | ShieldCheck | admin (text.secondary) | /admin | | **Admin only**; a header button, never in the tab bar |
| — | landing | (no tab) | — | — | / | /about, /landing, anything unknown | all |

- The tab bar renders `TABS` minus the `admin` group and minus `adminOnly` tabs for a non-Admin: **12 tabs for an Admin, 11 for a User** (FACT App.tsx:173-176). The Admin page has its own outlined/contained button beside the account menu (tooltip "Usage dashboard, accounts and the activity log") because as the last tab it sat off-screen (FACT App.tsx:354-362). The server also refuses Admin-only data to a User (INFERRED from comment App.tsx:39-41; see backend spec).
- A User who types `/admin` gets the mounted AdminPage, which shows "The Admin area is for Admins. Ask an Admin if you need access." (FACT AdminPage.tsx:127-133). `/quality` for a User mounts QualityPage with no tab highlighted (INFERRED: `Tabs value` is `false` when the page is not in `tabs`, App.tsx:290).
- Tab styling: each tab tinted with `alpha(groupAccent, TINT[group])` (engine .055, convert .05, index .05, inspect .06, admin .05), selected +0.05; label opacity `LABEL_ALPHA` light 0.82 (admin 0.9), dark engine .8/convert .62/index .62/inspect .76/admin .9; a left border + `ml .75` where a new group starts; indicator takes the active group's accent (FACT App.tsx:78-115,289-337).
- Theme mode: `localStorage["theme"]` ∈ {light,dark}, else `prefers-color-scheme`; written back + `document.documentElement.dataset.theme` (FACT App.tsx:152-160,184-191). Same logic in demo and login bundles (FACT DemoApp.tsx:15-37, login/main.tsx:10-34).
- INFERRED: the backend must serve `index.html` for every SPA path above, including `/admin` (deep links), which is the backend's job (see app.py spec).

### 2.1 Account menu (`components/AccountMenu.tsx`, 127 lines)
Shared by the app and Demo Mode, which use the same accounts (FACT AccountMenu.tsx:1-3).
- Icon button (CircleUserRound), tooltip `Signed in as <username>` (FACT :26-30).
- Menu header: "Signed in as", username, role chip **Admin** (primary) or **User** (FACT :34-44).
- Items (FACT :46-68):
  - **Admin: usage, accounts, activity** — only when `onAdmin` is passed (Admins).
  - **History: my runs / everyone's runs** with a switch — Admins only; toggles `setHistoryScope("mine"|"all")` (§2.2).
  - **Change password** → dialog: current, new (helper "At least 8 characters"), new again; client check "The new passwords differ."; POST /api/auth/password `{current, new}`; success says "Password changed. Other browsers signed in to this account have been signed out."; failure shows server `detail` or `Request failed (<status>)` (FACT :75-127; auth.ts:62-71).
  - **Sign out** → POST /api/auth/logout, then `location.replace(loginPath)` (`/login` or `/demo/login`) (FACT :65-68; auth.ts:56-59).

### 2.2 Session guard and history scope (`auth.ts`, `useHistoryScope.ts`)
- `Account {id, username, role: "admin"|"user"}`; `currentAccount()` GETs /api/auth/session, returns `null` on non-2xx or network error, and reads `username ?? user` (FACT auth.ts:8-14,45-54).
- `installSessionGuard(loginPath)` wraps `window.fetch` once per bundle: a 401 from a same-origin `/api/*` path that is not an auth route (`/api/(auth|app|demo)/(login|logout|session|password)`) sends the browser to `<loginPath>?next=<path+search>`, once (`leaving` flag) (FACT auth.ts:18,26-43).
- History scope: `"mine"` (default) or `"all"`, persisted in `localStorage["history-scope"]`, broadcast to listeners (FACT auth.ts:80-100). `useHistoryScope()` subscribes via `useSyncExternalStore` (FACT useHistoryScope.ts:7-9). History lists re-fetch when it changes (AskHistoryDrawer, EvidencePage, FitGapPage, RolloutPage).
- `ownerLabel(owner)` returns `"by <owner>"` only when scope is `all` and the run has an owner; shown in history rows of all four tools (FACT auth.ts:103-105; AskHistoryDrawer.tsx:338; EvidencePage.tsx:865; FitGapPage.tsx:1727; RolloutPage.tsx:1180).
- The scope is only a request parameter; a User's lists are restricted by the server regardless (FACT comment auth.ts:73-78).

---

## 3. Pages

Conventions used across pages (FACT, multiple files):
- Streaming endpoints are POST + `fetch` + hand-parsed SSE (`event:`/`data:` lines split on `\n\n`), never `EventSource` ("EventSource can only GET and reconnects → would re-bill") (FACT api.ts:677-720, 952-995, 1050-1075).
- Errors: `json<T>()` throws `detail` (string) or `detail.message` or `Request failed (<status>)` (FACT api.ts:188-200).
- History panels for Agent / Fit-Gap Copilot / InsightLens share `RunHistoryDrawer`; Ask RAG uses `AskHistoryDrawer` (FACT imports; test run-history.mjs). All four honour the history scope and show `by <owner>` in "everyone's" mode (§2.2).
- `openRun?: RunRequest | null` on Ask, Agent, InsightLens and Fit-Gap Copilot: a new request (new nonce) opens that recorded run in the page (FACT AskPage.tsx:86-89,307-311; EvidencePage.tsx:578-581,878-881).
- `showTechDetails` prop (default true) hides model names / technical stage text in Demo Mode (FACT AskPage.tsx:86; EvidencePage.tsx:578; RolloutPage.tsx:868).
- Reviewer identity: InsightLens and Copilot no longer take a typed reviewer name. The field is read-only, labelled "Reviewing as", filled from `currentAccount().username`; the server records the signed-in account and ignores any name sent (FACT FitGapPage.tsx:872; RolloutPage.tsx:1415; comments at the `reviewer` state in both pages).

### 3.1 Landing (`LandingPage.tsx`, 602 lines)
- Purpose: product introduction/"How it works"; hero with CTA buttons to Convert, Batch Convert, Ask (FACT LandingPage.tsx:144-167); service cards; exports `ArchitectureSection`, `SERVICE_HUES`, `ServiceCard` reused by DemoLanding (FACT DemoLanding.tsx:10).
- Prop `reachable?: Page[]` hides links to pages a host can't open (FACT :33-42). No API calls.

### 3.2 Ask RAG (`AskPage.tsx`, 1066 lines)
- UI: question box (clear adornment), **search mode** toggle `hybrid` ("Vector and keyword search, merged") / `vector` / `keyword` (FACT :563), `k` default 8 (FACT :101), category filter (INFERRED from `categories` in body), sample-questions drawer (`ASK_SAMPLES`), pipeline stepper (`embed → vector → keyword → fuse → answer`, StepKey FACT api.ts:76), streamed answer with clickable `[n]` citations + hover card, KPI strip ("Answer quality", "Faithfulness", "Sources", "Time") (FACT :484), tabs **Answer / Evaluation (score) / Sources (n)**, history drawer, Document inspector drawer for a source, QualityScorecard.
- API: `api.ragStatus()` → GET /api/rag/status; `ask()` → POST /api/ask SSE events `run, trace, stage, sources, token, done, error` (FACT api.ts:677-720); `askHistory.run(id)` reopen; `askHistory.evaluation(id)` poll; `askHistory.rescore(id)` POST; AskHistoryDrawer uses `askHistory.runs(50, search, quality)` (now with `scope`) and `deleteRun`.
- **Polling**: after answer, if evaluation `status === "running"`, poll GET /api/ask/runs/{id}/evaluation every **2500 ms** until terminal status (FACT AskPage.tsx:313-337).
- Replay of a past run shows "corpus changed" flag (`corpus_changed`) (FACT api.ts AskRunDetail).

### 3.3 RAG Metrics / Answer Quality (`QualityPage.tsx`, 329 lines) — Admin only
- Tab shown to Admins only: its dashboards add up every user's questions (FACT App.tsx:46-49).
- Fiori-like analytical list page: header + KPIs vs targets; tabs **Answers · Metric matrix · Source documents · Failure analysis · Experiments · Judge calibration** (FACT :38-44); filter bar `{days: 28, half: "", mode: ""}` for first four tabs; metric switcher default `faithfulness`.
- `Kpi` and `MONO` moved to `components/quality/parts.tsx` and are shared with AdminPage; AnswersView re-exports `MONO` (FACT parts.tsx:16-36; AnswersView.tsx:18-22).
- View remembered in `localStorage["quality.view"]` (legacy values `overview`→answers, `explorer`→analysis) (FACT :77-86,105).
- API: GET /api/quality/overview?days&half&mode; GET /api/quality/explorer?…; GET /api/quality/judge; drill-down opens `askHistory.run(runId)` or `experimentItem(expId, itemId)` in `MetricDetailDrawer`; ExperimentsView: GET /api/quality/experiments, GET /api/quality/experiments/compare?base&cand, POST …/{id}/baseline; parts.tsx: POST /api/ask/runs/{id}/review `{verdict: grounded|partly|not, note, reviewer}`.
- Score bands 0.7 / 0.4 (FACT test quality-page.mjs header §2).

### 3.4 Spine / Knowledge Graph (`KnowledgeGraphPage.tsx`, 2974 lines)
- View modes: `graph | model | process | cypher | quality` (FACT :184).
  - **graph**: d3 force simulation drawn on `<canvas>` (SimNode/SimLink, FACT :73-80), zoom (default 0.85), pan, focus-neighbourhood mode, fullscreen (Escape exits), collapsible sidebar and legend (legend starts minimized), node type filters: stream "Business Streams", system "Core Systems", document "Markdown Documents", process "BPML Processes" (all visible), spec "SPARK Specifications" (hidden by default) (FACT :94-108,185-206). Node colour keyed by type from `nodeHues` (FACT :124-126). Text search box. Node detail drawer. "Rebuild" forces `api.rebuildGraph()` (FACT :259).
  - Natural-language query: `api.queryGraph({query})` → POST /api/graph/query → `GraphQueryResult {mode: path|subgraph, summary, answer?, node_ids, edge_ids, path?}`; highlights path (sky) / related (pink) / matches (peach) (FACT :155-158,1123); answer drawer with copy. 5 preset queries (FACT :128-134): Salesforce specs, eCommerce→S/4HANA, BPML O-020-090, specs in L2C, ECC vs S/4HANA.
  - **model**: `ModelView` of ontology from GET /api/graph/model, fetched lazily on first open (FACT :190-196).
  - **process**: `ProcessFlowView({graph, onFocusNode})` built from loaded graph data (FACT ProcessFlowView.tsx:52) — no extra API.
  - **cypher**: `CypherView` → GET /api/graph/neo4j/status, POST /api/graph/neo4j/sync?force=true, POST /api/graph/cypher/generate `{question}`, POST /api/graph/cypher `{query, limit=200, params}` (FACT CypherView.tsx:169,210; api.ts `api` object).
  - **quality**: `GraphQualityView` → GET /api/graph/quality, POST /api/graph/quality/structure, POST /api/graph/quality/questions (background); **polls GET /api/graph/quality every 3000 ms while `questions.status === "running"`** (FACT GraphQualityView.tsx:143-148).
- `onNavigate(page)` lets the graph page link to other app pages.

### 3.5 Agent / Evidence Agent (`EvidencePage.tsx`, 1412 lines)
- UI: question box + `EVIDENCE_SAMPLES` picker, `holdout` toggle, **memory** toggle (`useMemory`, default off) with memory panel open state persisted in `localStorage["evidence.memoryOpen"]` (FACT :604,796); KPI strip Claims / Weakest claim / Evidence / Investigation / Time (FACT :984-988); answer state badge (supported, conflicted, documented_unknown, not_in_corpus, false_premise, unrepresentable) (FACT :42-53); tabs **Answer · Claims (n) · Traceability (calls) · Memory (n) · Evaluation**, shown conditionally; live log drawer (`AgentLogDrawer`), tool-call trace drawer (`AgentTraceDrawer`, renders rag/graph/bpml traces), document inspector (fetches chunk via `api.chunk`), `MemoryReflectDrawer` (POST /api/evidence/memory/reflect `{question}`), `RunHistoryDrawer`, `AgentEvaluationView`.
- API: GET /api/evidence/status; `askEvidence()` POST /api/evidence/ask `{question, holdout?, categories?, memory?}` SSE events `run, log, memory, tool_call, answer, evaluation, error` (FACT api.ts:1554-1597); GET /api/evidence/runs?limit=50&scope=; GET /api/evidence/runs/{id}; DELETE /api/evidence/runs/{id}; GET /api/evidence/runs/{id}/lineage (+ `?format=md|json` download); GET /api/rag/chunk/{chunkId}.
- History reloads when the scope changes (FACT :623,772-775).

### 3.6 InsightLens (`FitGapPage.tsx`, 2164 lines)
- Purpose: per-BPML-step fit/gap register. Classes FIT_STANDARD, FIT_CONFIG, GAP_DEVELOPMENT, REUSE, ADAPT, CHALLENGE, SIMPLIFY, REPLACE, RETIRE, UNKNOWN with labels/hues; materiality high/medium/low weights 3/2/1.
- Form: question (+ `QuestionPicker` over the 27 `evalQuestions.ts` items, which sets question and scope), scope text default `"4.5.1"` resolved via debounced (220 ms) `fitgap.search` (FACT :1475,1571-1574), mode toggle **A · Template baseline / B · Country delta** (FACT :1987-1988), holdout, country profile JSON (validated, only in mode B), `maxSteps` 4 (slider 1–20), `concurrency` 3 (FACT :1491-1492,1998); preview card from POST /api/fitgap/preview recomputed on change (FACT :1580-1583). Attachments panel (session uploads, stored in `localStorage["fitgap.uploads"]`) with entity comparison vs corpus. Reviewer = signed-in account (read-only "Reviewing as") (FACT :872).
- Run: `runFitGap` POST /api/fitgap/run SSE `scope, step_start, tool_call, entry, verify_fail, step_error, synthesis, done, error` (FACT api.ts:952-995); live StepCards per step (waiting/running/done/failed). Results tabs: **Reuse assessment · Gap register (n) · Decisions (n) · Integrations (n) · Agenda (n)** (FACT :2113ff). Entry detail with evidence, issues, review (accept/reject/refine + corrected class) → POST /api/fitgap/entries/{id}/review. Exports: `/api/fitgap/runs/{id}/export?format=md|json|xlsx`. "Show in graph" → KG page.
- Other API: GET /api/fitgap/status, GET /api/fitgap/runs?scope=, GET /api/fitgap/runs/{id}, session uploads (§4). History reloads when the scope changes.

### 3.7 Fit-Gap Copilot / Rollout (`RolloutPage.tsx`, 2329 lines; components/rollout/*)
- Purpose: Fit-to-Standard analysis: subject documents (country As-Is or SAP Best Practice) vs Global Template; three-way comparison with roles `as_is | template | sap_bp | localization | other` (FACT api.ts RolloutRole; RolloutPage.tsx role labels).
- Setup ("New analysis" composer, 3-step indicator: attach → ready → run, FACT :1351): subject select (`country_as_is` default, follows uploaded roles until touched), scope (optional; debounced `fitgap.search`), country, country context, SAP release, GT version, question; upload panel → `uploadSessionDocuments` POST /api/uploads SSE (`session, start, stage, done_file, file_error, done, error`), retag PATCH, remove DELETE, clear DELETE session; session id in `localStorage["rollout.uploads"]` (FACT :898,994-995). Preview POST /api/rollout/preview recomputed on change.
- Run: `runRollout` POST /api/rollout/run SSE `scope, stage, tool_call, asis, gate, analysis, scores, sources, evaluation, done, error, log` (FACT api.ts:2008-2030). Live stages + log auto-scroll unless user scrolled up.
- **Run timing**: the header line ends "· Completed in <d> (reading <d>, comparing <d>)", computed by `runTiming(log)` from the log's `stage` notes (one per pass) and the `gates` note; returns `null` (no duration shown) for a run that is still going, failed, or has no gates note (FACT RolloutPage.tsx:1371-1373; components/rollout/timing.ts:1-49). History rows of finished runs add "took <d>" from `started_at`/`finished_at` (FACT RolloutPage.tsx:1185-1186).
- Workspace tabs (FACT :1333-1347): **Summary · Brief · Workshop agenda (n, ✓ when every MUST_DISCUSS item decided) · Deviations (n) · Process alignment (n, if As-Is) · Localization (n | "— n/a") · Dimensions · Backlog (n) · `<subject>` model (n) · Sources (n docs) · Quality gates · Traceability (calls) · Evaluation** (13). `PANEL_TABS = [localization, dimensions, backlog, asis, gates, sources, evaluation]` lists the tabs drawn inside the shared outlined panel; a panel tab missing from it renders blank (the Evaluation tab did, before the fix) (FACT :862-866). Components: SummaryView, BriefView, ScoreCards (+FormulaTooltip), WorkshopAgendaView, DeviationRegisterView, DeviationRiskView, ProcessAlignmentView, FacilitatorView (1 s countdown timer, FACT FacilitatorView.tsx:111), ObjectHeader, OutcomeDownloads, MaterialityPill.
- Decisions: `rollout.decide(runId, {gap_id, reviewer, verdict: accept|reject|defer, disposition?, comment?, option_index?, rationale?, session_id?})` → POST /api/rollout/runs/{id}/decisions; append-only log; reviewer field read-only, filled from the account (FACT :1415). Facilitator mode collects drafts (persisted per run in `localStorage["fitgap.drafts.<runId>"]`, FACT :1228-1253) then `submitWorkshop` POST /api/rollout/runs/{id}/workshop `{facilitator, attendees[], answers[]}`.
- Downloads: `/api/rollout/runs/{id}/export?format=md|json|pdf[&client=1]` (PDF button only if `status.pdf.available !== false`); `/api/rollout/runs/{id}/workshop/export?format=md|pdf|docx|xlsx[&session=]`; lineage `/api/rollout/runs/{id}/lineage[?format=md|json]`; cited source open: `/api/rollout/runs/{id}/attachments/{file}` for uploads (kind upload or category UPLOAD) else `/api/kb/files/{file}` (FACT api.ts `rollout.sourceUrl`).
- History: GET /api/rollout/runs?scope=, GET /api/rollout/runs/{id}, DELETE /api/rollout/runs/{id}. GET /api/rollout/status on activation (vocabulary, subjects, upload roles, pdf availability). History reloads when the scope changes.
- Look: "premium" style — navy band `#101c2e` light / Frappé crust dark, teal accent `#1b7c77`/frappe.teal, MONO + SERIF fonts, radius 4px (FACT components/rollout/premium.ts:12-30).

### 3.8 Convert (`ExtractPage.tsx`, 508 lines)
- Single-document flow: Open document / drag-drop → `api.upload(file)` POST /api/upload (multipart `file`) → page previews `/api/docs/{id}/preview/{page}` → **Convert** `POST /api/convert/{id}?vlm=<bool>&provider=claude|openai|qwen` → Markdown rendered/raw toggle, copy, download `/api/docs/{id}/download` → **Add to knowledge base** POST /api/docs/{id}/embed (`EmbedResult` status added/updated/unchanged, duplicates warning, "Ask" action navigates to Ask) (FACT :26-140).
- Accepted extensions: `.pptx,.ppt,.docx,.doc,.xlsx,.xlsm,.xls,.pdf,.html,.htm,.xml,.csv,.txt,.json,.msg,.eml,.png,.jpg,.jpeg,.webp,.bmp,.tiff,.tif` (FACT :16). "Read images with AI" switch (VLM, default off) + provider select (FACT :18-20,34-35). Live elapsed-seconds counter (250 ms interval) while busy (FACT :55-59). `api.health()` → `preview_available` warning.

### 3.9 Batch Convert (`BatchConvertPage.tsx`, 1386 lines)
- Queue of files (Add Files / Add Folder / drag-drop; skips `~$*`, dotfiles, unsupported ext; same ACCEPT list) (FACT :53,131-160). VLM default **on**, provider default claude (FACT :105-106).
- Direct fetches (not in api.ts): POST /api/batch/upload (multipart `files`) → `{batch_id}`; POST /api/batch/convert/{batchId} `{vlm, provider}` SSE `progress, file_done {index, filename, dest_name, markdown, tools}, file_error, batch_done {converted, failed}`; POST /api/batch/{batchId}/embed SSE `progress, file_done, file_error, …`; download zip link `/api/batch/{batchId}/download` (FACT :210-330,575). Per-file ToolBreakdown (engine, VLM counts, OCR, tables, flowcharts…) (FACT :60-76). Elapsed timer 500 ms.

### 3.10 Add to knowledge base (`AddToKnowledgeBasePage.tsx`, 1310 lines)
- Stage `.md/.markdown/.txt` files (token estimate size/4), category picker from `ragStatus.ingest_categories` (INFERRED from api.ts RagStatus + batchInsertKb `category`), **Insert** → `batchInsertKb` POST /api/kb/batch-insert (multipart `files`, `category`) SSE `progress, file_done, file_error, complete, error` (FACT api.ts:597-656); abortable.
- KB table: GET /api/kb/files (name, title, size, category, source, chunks, tokens, is_indexed), filter text + extension filter, indexed vs total counter, delete → DELETE /api/kb/files/{filename}?source=… (FACT :187,381,419-443). Refreshes `ragStatus` on window focus/visibility (FACT :200-214).

### 3.11 Coverage (`CoveragePage.tsx`, 263 lines)
- GET /api/coverage?documents=true; summary counters (on_disk, indexed, in_graph, documents, clean + issue kinds), issue kinds worst-first: file_missing "File gone", not_indexed "Not retrievable", not_in_graph "Not in graph", shadowed "Shadowed by a twin", category_mismatch "Category disagreement", no_original "No original" (FACT :15-24); toggle **Needs a look / Every document**, text filter; table Document/Corpus/Graph/Chunks/Findings (FACT :52-80,167-168).

### 3.12 Doc vs MD (`DocMdViewerPage.tsx`, 1040 lines)
- Two resizable panels (react-resizable-panels): left original document page images (continuous/single, zoom, page), right Markdown (rendered/raw), sync-scroll (FACT :99-126,387-621). Sources: pick indexed KB file (GET /api/kb/files → GET /api/kb/files/{name}?source= text → POST /api/kb/files/open?source= to open original, previews via `/api/docs/{id}/preview/{n}`), or upload a doc (POST /api/upload) and convert (POST /api/convert/{id}?vlm=false&provider=claude) (FACT :139-238). Has built-in demo sample markdown incl. mermaid (FACT :55-69).
- Conversions are owned (§02 §3d), but `/api/kb/files/open` marks the job it returns (the `kb<hash>` copy, or a reused upload job) as `shared`, so its `/api/docs/{id}/preview/{n}` images load for every signed-in account; converting, embedding or deleting it stays with the uploader (FACT DocMdViewerPage.tsx:218,567,576; backend/api/app.py:850-902,141-157).

### 3.13 MD Viewer (`MdViewerPage.tsx`, 860 lines)
- Pure client: two editable-title panes loading local `.md,.markdown,.mdown,.mkd,.txt` via FileReader/drag-drop, rendered/raw, sync scroll, copy (FACT :118-170,523). No API.

### 3.14 Shared components (INFERRED from names/imports unless noted)
`Markdown.tsx` (marked + DOMPurify + optional mermaid; `<mark>` highlights, `[n]` citation linking; quote-locate regex shared with test — FACT :1-30), `DocumentInspectorDrawer` (source chunk in its document with quote highlight), `AskHistoryDrawer`, `RunHistoryDrawer` (shared history; exports `when()` relative time, reused by AdminPage), `SampleQuestionsDrawer`, `QualityScorecard`, `MetricDetailDrawer` (judge working: claims/excerpts/questions/ratings), `AgentLogDrawer`, `AgentTraceDrawer`, `InvestigationView` (lineage), `AgentEvaluationView`, `MemoryReflectDrawer`, `ModelView`, `CypherView`, `GraphQualityView`, `ProcessFlowView`, `ClearAdornment`, `ScrollRunway`, `SignInForm`, `AccountMenu` (§2.1), `BrandLogo`, `quality/charts.tsx` `DailyBars` (§3.15).

### 3.15 Admin (`AdminPage.tsx`, 1068 lines) — Admin only
Mounted in both the app (`/admin`) and Demo Mode (`/demo/admin`). Props: `active`, `account`, `onOpenRun(tool, id)`, `canOpen(tool)` (default all; Demo passes `t in DEMO_TOOL`, which has no InsightLens) (FACT AdminPage.tsx:80-87; DemoShell.tsx:184,199-200). Laid out like RAG Metrics: header with KPI strip, sub-tabs, filter bar, tables (FACT :1-16). Data loads only when `active` and the account is an Admin (FACT :109-118); a non-Admin sees an info alert instead (FACT :127-133).

- **Header**: title "Admin", "Accounts and usage · <from> – <to>", spinner, **Refresh** (bumps `tick`, re-fetching everything) (FACT :140-152).
- **KPI strip** (shared `Kpi`) (FACT :153-167):
  - Runs — total; status "<n> failed" (warn) or "none failed"; sub per tool counts.
  - Active accounts — `active_users / users.length`, "signed in or ran something", "in the period".
  - Tokens — in+out total (k/M), status "<in> in · <out> out", sub run time.
  - **Est. LLM cost** — `usd(cost_usd)` formatted `$1,234.56` in any locale; status "at list prices · see note below", or warn "<n> runs on <models> not priced"; sub per-tool cost (FACT :65-67,162-166).
- **Sub-tabs** (order): **Usage · Run history · Users · Activity · User × tool**; last one remembered in `localStorage["admin.view"]`, default `usage` (FACT :34-41,72-78,98-101).
- **Filter bar** (hidden on Users): period select **Last 7 days / Last 30 days (default) / Last 90 days / Last 12 months** (Usage and User × tool only); account select "Every account" + each account + any usage-only owner such as `legacy`, labelled "<name> (runs before accounts)" (FACT :53-58,90,176-195).
- **Usage view** (FACT :221-306): "Runs per day" stacked bar chart (`DailyBars`) with legend in tool colours (ask=primary, evidence=info, fitgap=warning, rollout=success, FACT :120-125); "By account" table — Account (clickable → that account's Run history; Admin and "inactive" chips), one column per tool (tooltip runs/failed/tokens/time), Runs, Failed, Tokens, Run time, Est. cost, Last seen; footnote "Runs made before accounts existed are counted under **legacy**. Est. cost: …" with `COST_NOTE` (list prices; cached input priced at full rate; scope guard, judge, memory and embeddings excluded; the bill is in the Anthropic Console) (FACT :68-70,301-303).
- **DailyBars** (`components/quality/charts.tsx:261ff`): d3 band/linear scales, SVG 720×160, gridlines, at most ~10 date labels; hovering or tabbing to a day highlights its column, dims other days and opens an HTML card (date, total runs, per-tool rows busiest first with share bars and %, "No runs: …" footer); each column is focusable with an `aria-label`.
- **User × tool view** ("Who uses what", `MatrixView`, FACT :308-682): measure toggle **Runs · Tokens · Run time · Cost**, remembered in `localStorage["admin.matrix.measure"]` (FACT :318-335,365-376). Values are exact (run time as `Hh MMm SSs`, cost held in whole cents) so totals add up by eye. Rows = accounts with a non-zero total, sorted by total desc then name; idle accounts are counted in the legend note, not shown (FACT :379-387,668). Three insight cards: Top account, Most used tool, In the period (FACT :495-508). Columns: #, Account (avatar initials, run-history link), one per tool (plain numbers with a grey length bar), **Total** (the only heat-mapped column, one colour from 0.08 to 0.9 alpha of primary), **Share** (% to one decimal, `<0.1%`/`>99.9%`); footer row "All accounts" with per-tool sums, grand total, 100% (FACT :341-345,393-400,523-648). Interactions: hovering a cell lights its row and column (crosshair); hovering an account's Total **outlines the cells that add up to it** (and the Total itself) and fades the rest; hovering a footer total outlines its column; tooltips spell out the sum (`<whole> = a + b + … (names)`) (FACT :413-440). Legend under the table: colour scale for the Total column (FACT :658-678).
- **Run history view** (`RunsView`, FACT :697-805): GET /api/admin/runs (50 per page, `user_id`, `tool`, keyset `before=<started_at>`), tool filter "Every tool"; columns When, Account, Tool (colour dot), Question or scope, Status chip, Time, Tokens, and **Open** — calls `onOpenRun(tool, id)`; if the front end has no page for that tool, shows "<tool> is not part of this view"; **Load older** while `more`.
- **Users view** (`UsersView`, FACT :807-891): "Accounts" table with **New account** button; per row: username ("(you)" for self), role select (disabled for self: "You cannot change your own role"), Active switch (disabled for self; "Deactivate: signs them out and stops sign-in" / "Reactivate"), last sign-in, created, **Reset password**. New account dialog: Username ("No spaces. Not case-sensitive."), Temporary password ("At least 8 characters. They can change it from the account menu."), always created with role `user` (FACT :893-938, :905). Reset password dialog (FACT :940-980). All via `admin.createUser` / `admin.updateUser`.
- **Activity view** (`ActivityView`, FACT :983-1068): GET /api/admin/activity (100 per page, `before=<id>`, `user_id`, `action`), action filter from server-provided `actions`; labels: login "Signed in", login_failed "Sign-in failed" (warning colour), logout, run "Started a run", review, decision, workshop, export, delete, clear_history, password_changed, user_created, user_updated; detail column = tool · run id · details; **Load older**.
- Legacy runs: the UI only displays the `legacy` owner. Handing its runs to a real account is a backend CLI, `python -m backend.auth.store reassign-legacy <username> [table ...]`; there is no button for it (FACT backend/auth/store.py:24,344,410).

---

## 4. API client (`src/api.ts`) — complete inventory

`GET` unless stated. `cat` = `?categories=a&categories=b` built by `categoryQuery` (FACT api.ts:183-186). All FACT api.ts line refs. `scope` = `historyScope()` from auth.ts (`mine`|`all`) (FACT api.ts:3).

### 4.1 `api` object (:262-351)
| Fn | Method + path | Request | Response type |
|---|---|---|---|
| health | /api/health | – | `{preview_available: boolean}` |
| upload(file) | POST /api/upload | multipart `file` | `Upload {id, filename, format, size, pages, warning}` |
| convert(id, vlm, provider) | POST /api/convert/{id}?vlm=&provider= | – | `Conversion {markdown, vlm_notice, pages, unit?, pictures, skipped_images, vlm_images, flows, flow_images, table_images, cv_flow_images, elapsed, ocr[]}` |
| embed(id, category?) | POST /api/docs/{id}/embed[?category=] | – | `EmbedResult {status added|updated|unchanged, title, chunks, tokens, duplicates[], documents, total_chunks, seconds, file}` |
| ragStatus | /api/rag/status | – | `RagStatus {missing[], embed_model, embed_provider?, embed_dimension?, answer_model, default_k, documents, chunks, categories: CategoryInfo[], ingest_categories?, prompt_hash?, tracing?{enabled,environment,host}, evaluation?: EvaluationStatus, error}` |
| chunk(chunkId) | /api/rag/chunk/{chunkId} | – | `Source` |
| previewUrl(id,page) | URL /api/docs/{id}/preview/{page} | – | image |
| downloadUrl(id) | URL /api/docs/{id}/download | – | file |
| kbFiles | /api/kb/files | – | `KbFileItem[] {name,title,size,category?,source?,full_path?,chunks?,tokens?,is_indexed?}` |
| coverage(documents=true) | /api/coverage?documents= | – | `CoverageReport {summary, issues[], help, corpus_error, graph_error, documents?: CoverageDocument[]}` |
| openKbOriginal(source) | POST /api/kb/files/open?source= | – | `Upload & {markdown_source}` |
| kbFileContent(name, source?) | /api/kb/files/{name}[?source=] | – | text |
| deleteKbFile(name, source?) | DELETE /api/kb/files/{name}[?source=] | – | `{status, deleted_from_db, remaining, file_removed}` |
| graphData(cats) | /api/graph/data{cat} | – | `GraphData {nodes: GraphNode[], edges: GraphEdge[], stats{total_nodes,total_edges,types,streams,systems,categories?,filtered_to?}}` |
| rebuildGraph(cats) | POST /api/graph/rebuild{cat} | – | `GraphData` |
| queryGraph | POST /api/graph/query | JSON `{query?, source_id?, target_id?}` | `GraphQueryResult` |
| graphModel(cats) | /api/graph/model{cat} | – | `GraphModel {version, nodes: ModelNode[], relationships[], stats}` |
| neo4jStatus | /api/graph/neo4j/status | – | `Neo4jStatus {configured, reachable, uri, browser, detail, current?, loaded?, examples[], questions?, max_rows, timeout}` |
| neo4jSync(force) | POST /api/graph/neo4j/sync[?force=true] | – | `Record<string,unknown>` |
| generateCypher(q) | POST /api/graph/cypher/generate | `{question}` | `GeneratedCypher {question, answerable, cypher, explanation, assumptions[], valid, error, attempts, corrections[], seconds}` |
| cypher(q, limit=200, params={}) | POST /api/graph/cypher | `{query, limit, params}` | `CypherResult {columns, rows, truncated, limit, ms, notifications}` |
| graphQuality | /api/graph/quality | – | `GraphQuality {structure, questions: GraphQualityRun|null, reviewed}` |
| checkGraphStructure | POST /api/graph/quality/structure | – | `GraphQualityRun` |
| startGraphQuestions | POST /api/graph/quality/questions | – | `{id}` |

GraphNode `type ∈ stream|system|document|process|spec` + optional `code, ticket, filename, source, format, chars, is_primary, in_bpml, jira_key, category, degree, description`.

### 4.2 Streaming functions
| Fn | Path | Body | SSE events |
|---|---|---|---|
| batchInsertKb(files, handlers, signal?, category?) (:597) | POST /api/kb/batch-insert | multipart `files[]`, `category` | progress, file_done, file_error, complete, error |
| ask(body, on, signal) (:677) | POST /api/ask | `{question, mode: hybrid|vector|keyword, k, categories[]}` | run `{id, not_saved?}`, trace `{id,url}`, stage `StageEvent{key,status,detail,ms?,terms?}`, sources `Source[]`, token `string`, done `{seconds,input_tokens,output_tokens}`, error `{message}` |
| runFitGap(body, on, signal) (:952) | POST /api/fitgap/run | `FitGapRunBody {mode?, scope_bpml, country_profile?, holdout?, max_steps?, concurrency?, question?, categories?, upload_session?}` | scope, step_start, tool_call, entry (`FitGapEntry`), verify_fail, step_error, synthesis (`FitGapSynthesis`), done, error |
| uploadSessionDocuments(files, session, role, on, signal?) (:1079) | POST /api/uploads | multipart `files[]`, `session` ("" = new), `role` | session, start, stage, done_file, file_error, done (`UploadSession & {added,total}`), error |
| askEvidence(body, on, signal) (:1554) | POST /api/evidence/ask | `{question, holdout?, categories?, memory?}` | run, log, memory, tool_call, answer (`EvidenceAnswer`), evaluation (`AgentEvaluation`), error |
| runRollout(body, on, signal) (:2008) | POST /api/rollout/run | `RolloutRunBody {scope_bpml?, subject?, country?, country_context?, sap_release?, gt_version?, question?, upload_session, categories?}` | scope, stage, tool_call, asis, gate, analysis, scores, sources, evaluation, done, error, log |
| (BatchConvertPage, direct) | POST /api/batch/upload; POST /api/batch/convert/{id}; POST /api/batch/{id}/embed; GET /api/batch/{id}/download | see §3.9 | progress, file_done, file_error, batch_done |

### 4.3 `sessionUploads` (also `fitgap.uploads`) (:1104-1120)
status GET /api/uploads/{s} → `UploadSession {session, exists, created_at?, used_at?, expires_at?, ttl_hours?, max_files?, database?, schema?, files: UploadedFile[], documents, chunks, tokens?, graph?}`; entities GET /api/uploads/{s}/entities[?roles=…] → `UploadComparison {documents[], entities: UploadEntity[], shared, new}`; retag PATCH /api/uploads/{s}/files/{name}?role=; remove DELETE /api/uploads/{s}/files/{name}; drop DELETE /api/uploads/{s} → `{dropped}`.

### 4.4 `fitgap` (:1122-1146)
status GET /api/fitgap/status → `FitGapStatus`; roots GET /api/fitgap/scope → `{roots}`; search GET /api/fitgap/scope?q= → `{query, matches: BpmlProcess[]}`; node GET /api/fitgap/scope?code= → `{process, ancestry, children, steps}`; preview POST /api/fitgap/preview (FitGapRunBody) → `FitGapPreview`; runs GET /api/fitgap/runs?scope= → `FitGapRunSummary[]` (each with optional `owner`); run GET /api/fitgap/runs/{id} → `FitGapRunDetail`; exportUrl /api/fitgap/runs/{id}/export?format=md|json|xlsx; review POST /api/fitgap/entries/{entryId}/review `{reviewer, verdict, corrected_classification?, comment?}` (server signs it with the account).

### 4.5 `askHistory` (:1645-1669)
runs GET /api/ask/runs?limit=&scope=&search=&quality= (quality ∈ "", low, unfaithful, unsafe, unscored) → `{runs: AskRunSummary[] (optional owner), retention, filters, low_quality_below}`; evaluation GET /api/ask/runs/{id}/evaluation → `AskEvaluation {status none|running|done|failed|skipped|abandoned, metrics: Record<string, MetricScore>, overall, safety, terms, …}`; rescore POST same → `{status, run_id, judge_model}`; run GET /api/ask/runs/{id} → `AskRunDetail` (answer, sources, terms, corpus_changed, evaluation?, review?); deleteRun DELETE /api/ask/runs/{id}; clear DELETE /api/ask/runs → `{status, removed}`.

### 4.6 `evidence` (:1692-1716)
status GET /api/evidence/status → `EvidenceStatus` (model, prompt_hash, max_tool_calls, anthropic_key, tools, categories, duplicate_groups, hubs, graph, history?, memory?: MemoryStatus); runs GET /api/evidence/runs?limit=&scope= (optional `owner` per row); run GET /api/evidence/runs/{id}; lineage GET /api/evidence/runs/{id}/lineage → `Lineage`; lineageExportUrl …/lineage?format=md|json; deleteRun DELETE; reflect POST /api/evidence/memory/reflect `{question}` → `MemoryReflection {text, based_on[], searched[], usage, error}`.

### 4.7 `rollout` (:2036-2093) + `clientExports(on)` (:2034)
status GET /api/rollout/status → `RolloutStatus` (pdf?, bpml, model, prompt_hash, max_tool_calls, anthropic_key, runs, decisions, vocabulary{deviation_types, dispositions, localization_states, dimensions{label,weight}, ratings}, subjects: RolloutSubject[], uploads{ttl_hours,max_files,accepted,database,roles}); preview POST /api/rollout/preview → `RolloutPreview`; runs GET /api/rollout/runs?scope= (optional `owner` per row); run GET /api/rollout/runs/{id} → `RolloutRunDetail`; deleteRun DELETE; exportUrl /api/rollout/runs/{id}/export?format=md|json|pdf[&client=1]; sourceUrl (see §3.7); decide POST …/decisions → `RolloutDecision`; lineage GET …/lineage; lineageExportUrl; workshopExportUrl …/workshop/export?format=&session=; submitWorkshop POST …/workshop → `{session: WorkshopSession, decisions[]}`.
Enumerations (FACT :1725-1745): DeviationType PF BR AP RO LC CT DT IN RP UX EX TM TC SEC VOL POL; Disposition ADOPT_GT CONFIGURE_STANDARD USE_SAP_LOCALIZATION ADOPT_SAP_BP EXTEND_STANDARD RETAIN_LOCAL_EXCEPTION REDESIGN_GT RETIRE_LEGACY REQUIRES_DECISION OUT_OF_SCOPE; LocalizationState CONFIRMED_STATUTORY SAP_DELIVERED CORPORATE_POLICY LOCAL_PREFERENCE SUSPECTED NOT_LOCALIZATION; Materiality Critical/High/Medium/Low/Informational; WorkshopBucket MUST_DISCUSS/CONFIRM/NO_WORKSHOP_TIME; Dimension flow/rules/governance/data/integration/controls/reporting; evidence_class E1–E4; side as_is/template/sap_bp/localization.

### 4.8 `quality` (:2310-2333) + `experimentItem` (:2349)
overview GET /api/quality/overview?days=&half=&mode= → `QualityOverview`; explorer GET /api/quality/explorer?… → `QualityExplorer`; judge GET /api/quality/judge → `JudgeTrust`; experiments GET /api/quality/experiments → `{experiments}`; compare GET /api/quality/experiments/compare?base=&cand= → `ExperimentComparison`; setBaseline POST /api/quality/experiments/{id}/baseline; deleteExperiment DELETE /api/quality/experiments/{id}; review POST /api/ask/runs/{runId}/review `{verdict, note, reviewer}`; experimentItem GET /api/quality/experiments/{expId}/items/{itemId} → `ExperimentItem`.
FailureType keys: safety, wrong_sources, buried, ignored, invented, off_question.

### 4.9 `admin` (:2446-2550)
| Fn | Method + path | Request | Response |
|---|---|---|---|
| runs({userId?, tool?, before?, limit=50}) | /api/admin/runs?limit=&user_id=&tool=&before= | – | `{runs: AdminRun[] {tool, id, user_id, username, started_at, status, title, seconds, tokens}, more}` |
| users() | /api/admin/users | – | `{users: AdminUser[] {id, username, role, active, created_at, last_login_at, last_seen_at, runs}}` |
| createUser(username, password, role) | POST /api/admin/users | `{username, password, role}` | `AdminUser` |
| updateUser(id, change) | PATCH /api/admin/users/{id} | `{role?, active?, password?}` | `AdminUser` |
| usage(from, to, userId?) | /api/admin/usage?start=&end=[&user_id=] | – | `UsageReport {from, to, tools, totals{runs, failed, seconds, input_tokens, output_tokens, cost_usd, unpriced_runs, logins, failed_logins, active_users, by_tool, cost_by_tool, unpriced_models[]}, users: UsageRow[], daily: {day, ask, evidence, fitgap, rollout}[]}` |
| activity({before?, userId?, action?, limit=100}) | /api/admin/activity?limit=&before=&user_id=&action= | – | `{events: ActivityEvent[] {id, at, user_id, username, action, tool, run_id, detail}, more, actions[]}` |

`UsageTool = "evidence" | "ask" | "fitgap" | "rollout"`; `UsageNumbers {runs, failed, seconds, input_tokens, output_tokens, cost_usd, unpriced_runs}`; `UsageRow` adds `user_id, username, role, active, last_login_at, last_seen_at, tools: Record<UsageTool, UsageNumbers>, logins, failed_logins` (FACT :2457-2496).

### 4.10 Non-api.ts fetches
- `auth.ts`: GET /api/auth/session (`{id, username|user, role}`), POST /api/auth/logout, POST /api/auth/password `{current, new}` (FACT auth.ts:45-71).
- `SignInForm`: POST `endpoint` `{username, password}` → 200 sets HttpOnly cookie, else `{detail}`; both `/login` and `/demo/login` now post to **/api/auth/login** (FACT SignInForm.tsx:41-52; login/main.tsx:39; DemoLogin.tsx:15).
- DemoShell: GET /api/auth/session on mount (401 → `/demo/login?next=`) (FACT DemoShell.tsx:155-165).
- Batch endpoints (§3.9).
- The old `/api/app/session`, `/api/app/logout`, `/api/demo/login`, `/api/demo/session`, `/api/demo/logout` are no longer called by the frontend (FACT grep `src/`). The session guard still exempts `/api/(app|demo)/…` auth paths (FACT auth.ts:18).

**Defined but not called from UI (FACT grep):** `askHistory.clear`, `fitgap.roots`, `fitgap.node`, `quality.deleteExperiment`. `graphData/rebuildGraph/graphModel` are always called without categories. Every `admin.*` function is used by AdminPage.

### 4.11 localStorage keys (FACT grep)
`theme`, `quality.view`, `evidence.memoryOpen`, `fitgap.uploads`, `rollout.uploads`, `fitgap.drafts.<runId>`, `demo-sidebar-v2`, `history-scope` (auth.ts:81), `admin.view`, `admin.matrix.measure`. `fitgap.reviewer` is gone: the reviewer is the signed-in account. All wrapped in try/catch ("private mode").

---

## 5. Theme and branding (`src/theme.ts`, docs/dark-theme.md)

- `makeTheme(mode)` via MUI `createTheme` (FACT theme.ts:122-199):
  - Light: primary `#2563eb`, secondary `#7c3aed`, info `#0284c7`, success `#15803d`, warning `#b45309`, error `#b91c1c`, background default `#f4f6f9` / paper `#ffffff`, divider `#e3e6ea`, text `#16191d` / `#5f6773`.
  - Dark (Catppuccin **Frappé**, 26 named values `frappe.*` FACT :15-42): primary blue `#8caaee`, secondary mauve `#ca9ee6`, info sapphire `#85c1dc`, success green `#a6d189`, warning yellow `#e5c890`, error red `#e78284`, background default mantle `#292c3c` / paper base `#303446`, divider surface0 `#414559`, text `#c6d0f5` / subtext1 `#b5bfe2`; action.disabled overlay0, disabledBackground alpha(surface1,.5).
  - shape.borderRadius 10; system font stack; buttons no text-transform, weight 600; overline 700/.06em.
  - Overrides: Paper elevation 0, no bg image, 1px divider border; Button disableElevation; Tooltip arrow (dark: surface0 bg, text, surface1 border); ToggleButton no transform; CssBaseline `::selection` alpha(primary,.25), `mark` uses `searchColors[mode].mark` (light `#fde68a` on `#16191d`; dark yellow on crust), dark custom scrollbars (surface1/surface2 on mantle).
- `searchColors` combined/vector/keyword: light `#2563eb/#0f766e/#7c3aed`, dark blue/teal/mauve (FACT :54-62).
- `nodeHues` per KG type: light stream `#8b5cf6`, system `#0284c7`, process `#10b981`, document `#64748b`, spec `#f97316`; dark mauve/sapphire/green/overlay2/peach; `unknownHue` overlay1 / `#64748b` (FACT :72-90).
- `well(mode)` recessed surface: crust / `#f1f3f7`; `surface(theme, strength)` = alpha(white .08×s) dark, alpha(black .045×s) light — never `alpha(action.hover, x)` (FACT :95-120).
- Rule: no raw dark-mode hex outside `frappe` table; page images stay white in both themes (FACT dark-theme.md).
- Admin tool colours come from the theme (primary/info/warning/success). The one raw light-mode exception is the User × tool "platinum" table ground (`#f2f3f5 → #e8eaed`, head `#c9ccd1` at .35); dark mode uses white alphas (FACT AdminPage.tsx:405-409).
- Brand: "Spark AI **Spine**" (Spine in text.secondary weight 400), `logo.png`; in dark mode the logo sits on a 92% white tile, never recoloured (FACT BrandLogo.tsx).

---

## 6. Login and Demo Mode bundles

### 6.1 Sign-in flow
- One set of accounts (Postgres, `backend/auth/`) opens both the application and Demo Mode (FACT login/main.tsx:1-3; test_auth.py:17). Roles: `admin`, `user`.
- **/login** (`login/main.tsx`): `SignInForm` with `endpoint="/api/auth/login"`, subtitle "Sign in to continue"; `next` param accepted only if it starts with `/`, not `//`, not `/login`, no backslash; default `/` — same rule as server `app_login.safe_next` (FACT login/main.tsx:20-41). Theme toggle on form.
- **SignInForm**: username + password (show/hide), empty → "Enter a username and a password.", POST JSON, on success `location.replace(nextTarget())`, error shows server `detail` or `Sign-in failed (<status>).` (FACT SignInForm.tsx:31-56). No credentials in the bundle.
- After sign-in the app reads `/api/auth/session` for username and role (§2). A session ending mid-page (expiry, password reset, deactivation) triggers the session guard → `/login?next=…` (§2.2). Sign out and password change live in the account menu (§2.1).

### 6.2 Demo Mode
- **/demo** (`demo/main.tsx` → DemoApp): installs `installSessionGuard("/demo/login")`, then calls `clientExports()` so every Copilot export URL gets `&client=1` (model name omitted) (FACT demo/main.tsx:7-12, api.ts:2034-2052). DemoApp chooses `DemoLogin` if path starts `/demo/login`, else `DemoShell` (server redirects unauthenticated `/demo` → `/demo/login`) (FACT DemoApp.tsx:1-7,28). DemoLogin posts to **/api/auth/login** (same accounts), subtitle "Sign in to the client demo"; `next` must match `^/demo(/[\w-]*)?$` and not `/demo/login`, default `/demo` (FACT DemoLogin.tsx:8-16).
- **DemoShell** (FACT DemoShell.tsx):
  - Header tabs only: **Spine** (`/demo/graph`) and **Fit-Gap Copilot** (`/demo/fit-gap-copilot`). Sidebar "Answer engines": **Ask RAG** (`/demo/ask`), **Agent** (`/demo/agent`). Landing `/demo/home` (default after sign-in, HOME = landing). **Admin** (`/demo/admin`) reached from a button beside the account menu, shown to Admins only (FACT :46-87,275-285). Any other slug → landing (Convert, Batch, Add-KB, Coverage, Doc vs MD, MD Viewer, InsightLens, RAG Metrics are unroutable in demo) (FACT :57-62,91-94).
  - Address bar canonicalised with `replaceState` on arrival; `pushState` on navigation; popstate supported (FACT :122-172).
  - Pages mount lazily on first visit (`visited` set) then stay mounted; rendered with `showTechDetails={false}` (Rollout, Ask, Evidence) and KG with `incomingQuery={null}`; Ask/Evidence/Rollout accept `openRun` from the Admin page; `AdminPage` gets `canOpen={(t) => t in DEMO_TOOL}` so InsightLens runs are listed but not openable (FACT :181-202).
  - Sidebar states `rail` (60px, default) / `expanded` (240px) / `hidden`, persisted `localStorage["demo-sidebar-v2"]` (FACT :96-111).
  - On mount GET /api/auth/session; 401 → `/demo/login?next=<path>`; otherwise sets the account for the shared `AccountMenu` (`loginPath="/demo/login"`) (FACT :153-165,284-285).
  - DemoLanding: 4 story steps (Knowledge Graph, Fit-Gap Copilot, Ask RAG, Evidence Agent) with buttons to those pages, plus LandingPage's `ArchitectureSection` (FACT DemoLanding.tsx:1-40).
- Known leak: Demo Mode still shows model name on Copilot Traceability tab (FACT docs/demo-video/README.md "Things to know").

---

## 7. Demo video pipeline (docs/demo-video/, skim)

- Output `fitgap-demo-rough.mp4` (~6.5 min) for Copilot run `ro_879e0497a4` (India customer returns); `scenes.json` (single source: captions, VO, cue phrases, cards, pronunciation, masks), `scenes.py` (one function per scene, `at("phrase")` actions), `script.md`, `captures/` 1920×1080 stills, `clips/` webm per scene, `tools/` vendored demo-video skill engine (voice.py, record.py, build.py, check.py, kokoro_say.py, setup_tts.sh, explore.py, demo.py) (FACT README.md).
- TTS Kokoro-82M local voice `af_heart` (`VOICE`, `VOICE_SPEED`, `TTS=say` alt); Playwright recording against app on :8000, signing in with the account in `DEMO_USERNAME/DEMO_PASSWORD` (script default `solvay`/`solvay`, which must now exist as a real account) (FACT scenes.py:8,17-18; README.md:76); `check.py` Whisper transcript diff. Commands: `python3 docs/demo-video/tools/{voice,record,build,check}.py`; setup `bash docs/demo-video/tools/setup_tts.sh` (~1.5 GB cache). Not needed to rebuild the app — optional.

---

## 8. Tests

### 8.1 How tests are run
- **No pytest config, no conftest, no package.json test script, no CI file found** (FACT ls: no pytest.ini/pyproject/setup.cfg/conftest). Each backend test file is a self-running script: `main()` collects `test_*` globals, prints pass/fail/skip, exits non-zero on failure (FACT test_rag.py:218-238; test_auth.py:272-290). Some state pytest also works (test_fitgap.py:4, test_rollout.py:5).
- README "Tests" (FACT README.md:149-153): `.venv/bin/python backend/tests/test_<name>.py   # e.g. test_rollout, test_guardrails, test_graph_eval`.
- Frontend: `cd frontend && node test/<name>.mjs` (each file's header "Run:"). They are **static source-consistency checks** (read .ts/.tsx/.py text with `node:fs`), not browser tests; `rollout-steps.mjs` and `rollout-timing.mjs` need `typescript`, `quote-highlight.mjs` needs `marked`, both from `frontend/node_modules` (FACT).
- Postgres-backed tests read `DATABASE_URL` (loaded from repo `.env`), connect to the `/postgres` admin DB and CREATE/DROP throwaway DBs (`docling_test_ask`, `docling_test_category`, `docling_test_evaluation`, `docling_test_rag`, `docling_test_quality`, `docling_test_auth`, `docling_test_ownership`, `docling_test_ev_<uuid>`, `docling_test_ro_<uuid>`) — role needs CREATEDB (INFERRED) (FACT test_ask_store.py:34-60; test_auth.py:39; test_ownership.py:43).
- Whole suite (INFERRED, no runner exists):
  ```bash
  for f in backend/tests/test_*.py; do .venv/bin/python "$f" || echo "FAIL $f"; done
  (cd frontend && for f in test/*.mjs; do node "$f" || echo "FAIL $f"; done)
  ```
- Not executed during this survey; pass/fail status unknown.

### 8.2 Backend tests (`backend/tests/`, FACT docstrings + `ast` count of test functions)

23 files, 592 test functions.

| File | #tests | Covers | Needs |
|---|---|---|---|
| test_agent_eval.py | 29 | Code-only agent scores count what they claim; `push` to stub Langfuse, asserts nothing reaches real client | nothing |
| test_app_login.py | 8 | Page gates in front of the app and Demo Mode, signed out only: page → sign-in with `next`, demo page → demo sign-in, API closed too, forged cookie opens nothing, sign-in pages reachable, `page_paths`, `next` never leaves the site, demo router claims only demo paths (bare FastAPI + auth middleware) | nothing |
| test_ask_store.py | 9 | Ask history: recorded before answer, excerpts survive abandon, partial answer on fail, abandoned status, list excludes excerpts, retention trims oldest, delete one | Postgres |
| test_auth.py | 12 | Accounts, roles and the session: hashed passwords, a short `ADMIN_PASSWORD`, `ADMIN_USERNAME=legacy` or a username with a space only logs a WARNING and creates no Admin (start-up goes on), bootstrap admin, API and pages need a session, sign in/out, old static credentials gone, `legacy` cannot sign in, forged/expired/revoked tokens (password reset and deactivation revoke at once), Admin-only Admin API, last Admin cannot be removed or self-demoted, change own password, traces opened while streaming, activity logged; one account opens app and demo | Postgres |
| test_bpml_markdown.py | 8 | BPML process-house doc render()↔parse() round-trip incl. after chunk/join | nothing |
| test_category_durability.py | 7 | UI-chosen category persisted to disk (front matter) so graph + re-index respect it; embedding stubbed | Postgres |
| test_converter.py | 22 | `.txt` passes through unchanged (no Docling escaping), csv handling (runs Docling) | Docling installed; no network/DB |
| test_coverage.py | 9 | Coverage report: not-indexed, category mismatch, no original, clean corpus reports clean (stores stubbed) | nothing |
| test_evaluation.py | 47 | RAG judge arithmetic, weights, skipped vs failed, row persistence; judges stubbed and asserted stubbed | Postgres |
| test_evidence.py | 81 | Evidence Agent provenance, independence, hub filtering, scoring; store bookkeeping in throwaway DB; fake Anthropic | Postgres + the indexed corpus (`solvay-spark/pkg/markdown/`) |
| test_fitgap.py | 41 | InsightLens verifier, rubric arithmetic, BPML parsing, holdout masking | nothing (no Claude, no DB) |
| test_formats.py | 14 | Accepted vs convertible extensions agree (.xlsm,.json,.msg,.eml); preview stand-ins | optional LibreOffice/pdftoppm and `tests/fixtures/sample.msg` (absent → skipped) |
| test_graph_determinism.py | 5 | Byte-identical graph builds across hash seeds; cached graph == fresh build; BPML fingerprint | corpus files + cached graph (skip if built from different files) |
| test_graph_eval.py | 14 | Graph quality checks on hand-made faulty graph; question comparison | nothing |
| test_guardrails.py | 27 | Scope classifier, gated web search, no contact details; stubs asserted | nothing |
| test_knowledge_graph.py | 42 | Extraction rules: BPML-backed hierarchy, bounded system keyword matching, filename-only entities; false-entity cleanup (steps under the right lettered process, OCR-misread codes repaired or dropped, PO-field ids not tickets, no markup in names, M3 is an order type, CPI Data Services is not CPI) | corpus + BPML process-house doc |
| test_neo4j.py | 16 | Write batches from graph (offline); live: DB matches build, writes refused, row cap, examples return rows, endpoint 400s; Cypher generator with fake Claude | offline part none; live part Neo4j running with current build (else explicit skip) |
| test_originals.py | 18 | Locating original doc beside markdown/ or in `.workdir/<id>/` | nothing (temp tree) |
| test_ownership.py | 13 | Every run belongs to its account: a User lists only their own; another's run is "not found" (read, delete, export, audit); reviews signed by the account; Admin reads everyone (`scope=all`) but changes only their own; pre-account runs go to `legacy` and can be handed to a real account (`reassign_legacy`, refuses unknown/`legacy`/non-owned tables); retention and clear history per account; usage counts per account; Admin lists one account's runs across tools; a conversion or batch belongs to its uploader (another User or an Admin gets 404 on download, delete, convert), and a job marked `shared` is readable by another User but still not deletable; `/api/rollout/decisions` is shared memory: a User and an Admin both see every account's decisions; decisions copied from the old `rollout_decisions` log get the run's owner | Postgres |
| test_quality.py | 38 | Quality workspace arithmetic: failure-rule order, 0.0 below line, periods, percentiles; embedder replaced by bag-of-words; TestClient for endpoints | Postgres |
| test_rag.py | 10 | Corpus schema: UNIQUE(source), recategorise atomic, scoped search isolation, BM25 corpus_stats per category | Postgres (no Ollama) |
| test_rollout.py | 115 | Copilot scoring, quality gates, alignment-vs-empty-register invariant, store via throwaway DB; output-limit cut-offs refused, combined send-backs, `amend` corrections changing only what they name, over-long quotes cut to a verbatim prefix, list-as-text parsing, fixed calls pre-made | mostly nothing; store tests need Postgres |
| test_tracing.py | 7 | Call sites work with tracing off; span wrapper exposes OTel span | nothing |

`test_demo_mode.py` was deleted: Demo Mode no longer has its own credentials; its gate is covered by test_app_login.py and test_auth.py.
None of the backend tests require a live Anthropic key or Ollama (all stub them — FACT docstrings of test_evaluation, test_guardrails, test_quality, test_category_durability, test_rag, test_auth).

### 8.3 Frontend tests (`frontend/test/`)

13 `.mjs` checks plus one fixture generator.

| File | Checks (FACT headers) | Reads |
|---|---|---|
| pages-mount.mjs | Every header tab has a mounted page; MOUNTED derived from TABS; each tab reaches a render branch | App.tsx |
| frappe-palette.mjs | 26 Frappé hexes match published palette; no raw hex on dark branches anywhere in src | theme.ts, all src |
| surface-contrast.mjs | `alpha(action.hover, x)` never reintroduced; `surface()` text contrast ≥ 4.5:1 at used strengths | src, theme.ts |
| rag-quality.mjs | Metric names agree across evaluation.py / ask_store.py / api.ts / QualityScorecard.tsx; filters; null ≠ 0.00; poll has terminal condition; reference-only metrics excluded from overall; no hardcoded colours | backend/rag/{evaluation,ask_store,rag}.py, backend/api/app.py, src |
| quality-page.mjs | Failure types, score bands 0.7/0.4, review verdicts, /api/quality endpoints exist in app.py, commands exist in evaluation.py, experiment verdict colours, tab routes | backend/rag/quality.py, ask_store.py, evaluation.py, api/app.py, QualityPage & quality/* |
| agent-memory.mjs | Memory toggle reaches request body; panel says "not evidence"; log wired; `memory` SSE event dispatched | EvidencePage, api.ts, MemoryReflectDrawer, backend/agents/evidence/agent.py, memory.py |
| agent-trace.mjs | Trace drawers reachable in both agents; trace kinds match evidence/fitgap `trace.py` | AgentTraceDrawer, AgentLogDrawer, pages, backend/agents/fitgap/trace.py |
| run-history.mjs | Four history panels share RunHistoryDrawer/AskHistoryDrawer; selecting opens in drawer not page | pages, components |
| rollout-export.mjs | Export buttons have hrefs; formats offered == formats app.py accepts; PDF gated on availability | RolloutPage, OutcomeDownloads, backend/api/app.py, backend/agents/rollout/pdf.py |
| rollout-steps.mjs | `stepsOf` (ProcessAlignmentView) matches step-id shapes like `AS-04`, `IN-RET-030` (transpiled with TypeScript) | ProcessAlignmentView.tsx, premium.ts |
| rollout-tabs.mjs | `PANEL_TABS` exists and matches the tabs the shared outlined panel actually draws (guards the blank Evaluation tab regression) | RolloutPage.tsx |
| rollout-timing.mjs | `runTiming`/`elapsed`/`duration` (transpiled with TypeScript): passes bounded by `stage` notes and the `gates` note; no duration for a run without a gates note | components/rollout/timing.ts |
| quote-highlight.mjs | Every stored Evidence-Agent quote highlights in rendered chunk/doc text nodes (pipes treated as cuts); locate regex copied from Markdown.tsx | quote-highlight.fixture.json (+ `marked`) |
| quote-highlight-fixture.py | Regenerates the fixture from Postgres `evidence_runs` (status done) + `rag.chunk()`; warns if regex drifted. Run `.venv/bin/python frontend/test/quote-highlight-fixture.py` | Postgres + corpus files |

**Golden / fixture data**
- `frontend/test/quote-highlight.fixture.json` is **gitignored** (FACT .gitignore:15) and generated locally; present in this working tree at ~4.1 MB. A fresh clone must regenerate it before `quote-highlight.mjs` is meaningful.
- `src/data/evalQuestions.ts`: 27 evaluation questions Q1–Q16 (PKG), D1–D6 (DR), C1–C5 (PKG+DR) with BPML scope, axis, per-engine expectations (strong/partial/weak/blind) — source `docs/three-engine-eval-questions.md` (FACT evalQuestions.ts:1-24).
- `docs/spark-fitgap-eval-golden-set.xlsx` (golden set; not opened — INFERRED purpose).
- `src/data/askSamples.ts`, `evidenceSamples.ts`: curated sample questions with "what to look for".
- No `backend/tests/fixtures/` directory (FACT); test_formats expects optional `tests/fixtures/sample.msg`.

### 8.4 Load tests (`loadtest/`, Locust)

Separate from the app's dependencies: own venv `.venv-loadtest`, `locust>=2.32` (gevent) (FACT loadtest/requirements.txt; README.md "Setup").

| File | What it is |
|---|---|
| `locustfile.py` | Simulated users; signs in through POST /api/auth/login and keeps the `spark_session` cookie |
| `sse.py` | `post_stream()` times a streamed endpoint: reports `<name> headers`, `<name> ttfe` (first event) and `<name> total` (to `done`); an `error` event, a missing `done` or a non-200 is a failure (FACT sse.py:1-89) |
| `seed_users.py` | Signs in as the real admin (`ADMIN_USERNAME`/`ADMIN_PASSWORD`), lists /api/admin/users, creates or resets/reactivates `loadtest-01..N` (role user) and, with `--admin`, `loadtest-admin` (role admin), all with `LOADTEST_PASSWORD`; touches only `loadtest-*`; stdlib only (FACT seed_users.py:1-15,42-80) |
| `mock_anthropic.py` | FastAPI stand-in for POST /v1/messages (streaming), pace `MOCK_FIRST_TOKEN_MS` 800, `MOCK_TOKENS_PER_SEC` 60, `MOCK_ANSWER_TOKENS` 300; plain text only, so good for Ask, not for agents (FACT mock_anthropic.py:7-34,57) |

Simulated users (FACT locustfile.py:130-324):

| User | Always (no Claude) | Only when enabled |
|---|---|---|
| BrowseUser (wait 1–5 s) | /api/health, fitgap status/scope/runs/preview, /api/ask/runs, /api/kb/files, /api/coverage, /api/rag/status, POST /api/graph/query, /api/graph/data | — |
| AskUser (5–15 s) | — | POST /api/ask stream, `LOADTEST_LLM=1` |
| FitGapUser (30–60 s) | — | POST /api/fitgap/run stream (timeout 1800 s), `LOADTEST_HEAVY=1` |
| EvidenceUser (5–15 s) | evidence status, newest run from history | POST /api/evidence/ask, `LOADTEST_LLM=1` |
| RolloutUser (5–15 s) | rollout status, newest run, decisions, preview | POST /api/rollout/run, `LOADTEST_HEAVY=1` + `LOADTEST_ROLLOUT_SESSION` |
| QualityUser (5–20 s) | quality overview, explorer, judge, experiments | — ; stops at once unless the signed-in role is `admin` (needs `loadtest-admin`) |

Safety rails (FACT locustfile.py:42-128):
- **Only `loadtest-*` accounts.** `PREFIX = "loadtest-"` is fixed. An `init` listener exits if `LOADTEST_USERNAME` is set to any other name; `SignedIn.on_start` re-checks and stops the user. Without `LOADTEST_USERNAME`, users cycle through `loadtest-01..LOADTEST_ACCOUNTS` (default 20).
- **Allowed hosts.** A `test_start` listener exits unless the target host is in `LOADTEST_ALLOWED_HOSTS` (default `localhost,127.0.0.1`), and exits if `LOADTEST_PASSWORD` is unset.
- **No Claude spend by default.** LLM calls only with `LOADTEST_LLM=1` / `LOADTEST_HEAVY=1`. Runs made under load are real runs and appear in the Admin dashboard under the `loadtest-*` accounts (FACT README.md "Read this first").
- Documented profiles: (1) reads, `-u 200 -r 20`; (2) Ask against the mock on a second app copy (`ANTHROPIC_BASE_URL=http://localhost:8099`, `RAG_EVAL_SAMPLE=0`); (3) Fit-Gap smoke test with 1–2 users; Rollout runs need an upload session made in the app by the same account. Watch item: each open stream holds one of Starlette's 40 threadpool threads in a single process (FACT README.md "Profiles", "Reading the results").

---

## 9. Acceptance checklist for a rebuilt version

Build & static
1. `npm run build` type-checks and writes three HTML entries (index, demo, login) + assets to `static/dist`; `npm run dev` proxies `/api` to :8000.
2. All 13 frontend `node test/*.mjs` pass (after regenerating the quote fixture) and all 23 backend test scripts pass with Postgres available (Neo4j-live tests may skip with a message).

Shell
3. Signed in as an Admin, the header shows 12 tabs in the order/labels/groups of §2 plus an **Admin** button; as a User, 11 tabs (no RAG Metrics) and no Admin button. Each path and alias deep-links to the right page; unknown path → landing; back/forward work; tab title reads `Spark AI Spine — <label>`.
4. Switching tabs preserves page state (a typed question, a conversion, a graph query remain).
5. Theme toggle persists across reload (`localStorage.theme`); dark mode uses only Frappé colours; tooltips/scrollbars themed; `<mark>` highlight legible.

Accounts and sign-in
6. Signed out, `/` (and any app page) redirects to `/login?next=…` and `/api/*` returns 401; bad creds show the server message; good creds land on `next` (only same-site paths). The same account signs in to `/demo/login`.
7. Account menu shows username and role chip; Change password validates the two new values, reports server errors and signs out other browsers; Sign out POSTs /api/auth/logout and returns to the right sign-in page.
8. Expiring the session, resetting the password or deactivating the account while a page is open sends the next API call's 401 to the sign-in page with `next`, once.

Ownership
9. A User's histories (Ask, Agent, InsightLens, Copilot) show only their runs; opening, deleting, exporting or reading the lineage of another account's run by id returns "not found". Another account's conversion or batch id (Convert, Batch Convert) is "not found" too, for an Admin as well, while `GET /api/rollout/decisions` returns every account's decisions to every signed-in user (shared organisational memory; each row shows who decided it).
10. An Admin's account menu has the History switch; "everyone's runs" re-fetches every history list, rows say `by <owner>`, and the choice survives reload (`history-scope`). An Admin can open but not delete or decide on another's run.
11. InsightLens reviews and Copilot decisions show "Reviewing as <account>" read-only and are recorded under the signed-in account. Runs from before accounts are owned by `legacy`, which cannot sign in; `python -m backend.auth.store reassign-legacy <user>` moves them.

Admin dashboard
12. Admin tab (app `/admin`, demo `/demo/admin`) is refused with an info message for a User. For an Admin: KPIs Runs/failed, Active accounts, Tokens, Est. LLM cost (with "not priced" warning when a model has no price); period 7/30/90/365 days and account filters (including `legacy`); Refresh; last sub-tab remembered.
13. Usage: stacked runs-per-day bars with a hover/focus card per day; By-account table with per-tool runs, failed, tokens, run time, est. cost, last seen; clicking an account opens its Run history.
14. User × tool: measure toggle Runs/Tokens/Run time/Cost (remembered); rows ranked by total; only Total is heat-mapped with a legend; hovering an account's Total outlines exactly the cells it sums, hovering a footer total outlines its column; tooltips spell the sum; numbers are exact so totals add up.
15. Run history: every account or one account, tool filter, Load older; Open jumps to the run in its tool page (in Demo, InsightLens rows are marked not openable).
16. Users: create (role user, ≥8-char temporary password), change role, activate/deactivate, reset password; own role and active switch disabled. Activity: newest first, action filter, Load older, failed sign-ins highlighted.

Convert / index / inspect
17. Convert: upload each accepted extension, see page previews, convert with and without "Read images with AI" (provider claude/openai/qwen), toggle rendered/raw, copy, download, Add to knowledge base reports added/updated/unchanged + duplicates; "Ask" jumps to Ask tab.
18. Batch Convert: add files/folder (skips `~$`, dotfiles, unsupported), stream per-file progress/done/error, tool breakdown, download zip, embed batch with streamed progress and summary.
19. Add to KB: stage .md/.txt, choose category, insert with streamed progress; table lists files with indexed flag; delete removes (with `source` disambiguation); counters refresh on window focus.
20. Coverage: summary counts, issue chips worst-first, "Needs a look" vs "Every document", text filter.
21. Doc vs MD: pick an indexed file → original pages left, Markdown right, sync scroll; "no original" message for UI-added docs; upload+convert path works. MD Viewer: two local Markdown files side by side.

Engines
22. Ask RAG: stepper advances embed→vector→keyword→fuse→answer (keyword/vector modes skip steps), sources arrive before tokens, citations `[n]` open the document inspector at the passage; evaluation shows "scoring…" then a score (poll every 2.5 s stops when terminal); rescore works; history drawer filters by search and quality segment, reopen and delete work; aborting a question does not re-run it.
23. RAG Metrics (Admin): six tabs, filters (days/half/mode), drill into an answer opens the metric drawer with judge working; human review verdict saves; experiments compare and set baseline; view remembered.
24. Spine: graph renders with type legend (specs hidden by default), filters, search, zoom/fullscreen, node drawer; NL query highlights path/subgraph and shows answer; 5 presets work; Rebuild works; Model, Process, Cypher (status, sync, generate, run read-only query; writes rejected) and Quality (structure check, background question check polled every 3 s) views work; InsightLens "show in graph" runs the query on arrival.
25. Agent: ask with/without memory and holdout; live log; answer state badge, claims with scores and stance-tagged sources, Traceability lineage, Memory tab only when used, Evaluation; open a quote in its document highlighted; reflect drawer; history drawer open/delete; lineage md/json download.
26. InsightLens: scope search resolves (default 4.5.1), preview updates with mode/steps/concurrency/holdout, eval-question picker sets question+scope, mode B validates country JSON, run streams step cards and synthesis tabs (Reuse/Gaps/Decisions/Integrations/Agenda), entry review accept/reject/refine persists, exports md/json/xlsx, attachments upload/remove with corpus comparison; session persists across reload until expiry.
27. Fit-Gap Copilot: upload documents with roles (retag/remove/clear), subject auto-follows roles, preview shows readiness/blocker/estimate, run streams stages + log, all 13 workspace tabs populate (Evaluation not blank), header shows "Completed in … (reading …, comparing …)" for a finished run and history rows "took …", decisions (accept/reject/defer with option + rationale) append, facilitator mode drafts survive reload and submit atomically, agenda tab gets ✓ when all MUST_DISCUSS decided, exports md/json/pdf (pdf hidden when server says unavailable), workshop export md/pdf/docx/xlsx, cited sources open (attachments served from the run), history open/delete.

Demo
28. `/demo` without session → `/demo/login`; an account signs in to `/demo/home`; only Spine & Fit-Gap Copilot tabs + Ask RAG/Agent in sidebar (+ Admin button for Admins); other slugs land on home; sidebar rail/expanded/hidden persists; model names hidden (except known Traceability leak); Copilot downloads carry `client=1`; session expiry redirects to `/demo/login`; account menu sign out returns to `/demo/login`.

Load tests
29. `seed_users.py --admin` creates/resets only `loadtest-*` accounts; Locust refuses a non-`loadtest-*` `LOADTEST_USERNAME`, an unlisted host and a missing password; a plain `locust` run makes no Claude calls; QualityUser stops for a non-admin account.

---

## 10. Gaps / uncertainties
- Tests were **not executed**; current pass/fail state unknown.
- `quote-highlight.fixture.json` is gitignored; a fresh clone has none and the frontend quote test is vacuous or fails until regenerated (INFERRED).
- No unified test runner/CI; whole-suite command in §8.1 is INFERRED.
- Large components (KnowledgeGraphPage canvas drawing details, AgentTraceDrawer, rollout views, quality sub-views, DocumentInspectorDrawer, Markdown citation logic, AdminPage table styling) were skimmed for structure only; exact visual layout, copy text and chart forms not fully captured.
- Server-side SPA fallback routes (which paths serve index.html, incl. `/admin`), `/login`, `/demo/*` gating, Admin API authorisation and cost pricing live in backend (app.py, app_login.py, demo_mode.py, backend/auth/, backend/api/admin.py, backend/core/pricing.py) — see backend spec.
- Exact SSE payload shapes for batch endpoints (`/api/batch/*`) are typed only inline in BatchConvertPage, not in api.ts.
- `docs/spark-fitgap-eval-golden-set.xlsx` not opened; its relation to `evalQuestions.ts` is INFERRED.
- Whether `static/dist` is committed (prebuilt) was not checked.
- Load tests were not run; their figures (40 threadpool threads, ~4 min per Rollout run) are as stated in loadtest/README.md.
