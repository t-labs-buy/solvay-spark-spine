# 06 — Frontend UI and Test Suite

Scope: `frontend/` (React SPA, three Vite bundles), `frontend/test/*`, `backend/tests/*`, `docs/dark-theme.md`, `docs/demo-video/`.
Notation: **FACT (file:line)** = read directly; **INFERRED** = deduced from names/comments, not verified line by line. Paths are relative to repo root; `src/` = `frontend/src/`.

---

## 1. Frontend build

| Item | Value | Source |
|---|---|---|
| Package | `solvay-spark-spine` v1.0.0, `"type": "module"`, private | FACT frontend/package.json:1-5 |
| Scripts | `dev` = `vite`; `build` = `tsc --noEmit && vite build`; `typecheck` = `tsc --noEmit` | FACT package.json:6-10 |
| No test script | Frontend tests are run directly with `node test/<name>.mjs` | FACT package.json (no `test` key) |
| Entry pages (multi-page) | `main: index.html` → `/src/main.tsx` (the app); `demo: demo.html` → `/src/demo/main.tsx`; `login: login.html` → `/src/login/main.tsx` | FACT vite.config.ts:12; index.html, demo.html, login.html |
| Output dir | `../static/dist` (i.e. repo `static/dist`), `emptyOutDir: true`, `chunkSizeWarningLimit: 2000` | FACT vite.config.ts:8-10 |
| Served by | FastAPI serves `static/dist` at `/` and `/ask`; `demo_mode.py` serves demo at `/demo`; `/login` served by app_login | FACT comments vite.config.ts:4,11; login/main.tsx:1-3; demo/main.tsx:1-2 |
| Dev server | `:5173`, proxy `/api` → `http://localhost:8000` (`changeOrigin: true`) | FACT vite.config.ts:5,15-17 |
| HTML titles | `Spark AI Spine`, `Spark AI Spine — Sign in`, `Spark AI Spine — Demo`; favicon = inline SVG 📄 emoji | FACT index/login/demo.html |
| TS config | target ES2022, lib ES2023+DOM, module ESNext, `moduleResolution: bundler`, `jsx: react-jsx`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, `noEmit`, `types: ["vite/client"]`, include `src`, `vite.config.ts` | FACT tsconfig.json |
| `*.png` module decl | `src/assets.d.ts` declares `*.png` → string URL | FACT |
| Branding asset | `src/assets/logo.png` (teal + dark navy mark, transparent bg) | FACT BrandLogo.tsx:1-6 |

**Dependencies (FACT package.json:11-30)**
- runtime: `react ^19.3.0`, `react-dom ^19.3.0`, `@mui/material ^9.4.0`, `@emotion/react ^11.14.0`, `@emotion/styled ^11.14.1`, `framer-motion ^13.4.0`, `lucide-react ^1.46.0` (icons), `d3 ^7.9.0` + `@types/d3 ^7.4.3` (graph canvas/force sim), `marked ^12.0.2` (Markdown), `dompurify ^3.4.15` (sanitise), `mermaid 10.9.1` (pinned, diagrams in Markdown), `react-resizable-panels ^4.12.4` (split panes: `Group/Panel/Separator`).
- dev: `typescript 5.9`, `vite ^8.3.0`, `@vitejs/plugin-react ^6.1.1`, `@types/react ^19.3.0`, `@types/react-dom ^19.3.0`.
- No router library: routing is hand-rolled with `history.pushState` + `popstate` (FACT App.tsx:121-136,172-196).

**Source layout (FACT, `ls`)**
```
src/main.tsx            createRoot(#root) <StrictMode><App/></StrictMode>
src/App.tsx             shell: AppBar, tab bar, routing, theme toggle, sign-out
src/api.ts              ALL typed API calls (2430 lines)
src/theme.ts            MUI theme + Catppuccin Frappé palette
src/pages/*             13 pages (see §3)
src/components/*        drawers & views; subdirs ask/, evidence/, quality/, rollout/
src/data/               askSamples.ts (8+ samples), evidenceSamples.ts (8), evalQuestions.ts (27 eval Qs)
src/demo/               Demo Mode bundle: main, DemoApp, DemoShell, DemoLanding, DemoLogin
src/login/main.tsx      /login bundle
src/assets/logo.png
```
Largest files (lines): KnowledgeGraphPage 2974, api.ts 2430, RolloutPage 2306, FitGapPage 2153, EvidencePage 1399, BatchConvertPage 1386, AddToKnowledgeBasePage 1310, AskPage 1057, DocMdViewerPage 1040, AgentTraceDrawer 1018 (FACT wc -l).

---

## 2. Shell, navigation and routing (App.tsx)

- Product name constant `PRODUCT = "Spark AI Spine"`; `document.title = "Spark AI Spine — <tab label>"` or `"… — Enterprise Document Intelligence"` on landing (FACT App.tsx:32,185-190).
- Header: dense `AppBar` (minHeight 52) → clickable brand (BrandLogo 30px + "Spark AI **Spine**", tooltip "Home / About Spark AI Spine", goes to landing) → scrollable `Tabs` → theme toggle (Sun/Moon, animated rotate) → sign-out button only if `/api/app/session` returns a `user` (FACT App.tsx:155-157,218-336).
- Sign out: `POST /api/app/logout` then `location.replace("/login")` (FACT App.tsx:328-331).
- **All pages stay mounted** (absolute-positioned boxes, `display:none` when inactive, framer-motion fade/slide 0.2s) so state survives tab switches; `MOUNTED` is derived from `TABS` + `"landing"` (FACT App.tsx:56-63,339-380). Pages receive `active` to trigger loads only when visible.
- `MotionConfig reducedMotion="user"` honours OS reduce-motion (FACT App.tsx:216).
- Global `.pane-separator` styles for resizable panels (width 6, divider colour, primary on hover/active) (FACT App.tsx:207-214).
- Cross-page handoff: InsightLens "show in graph" → `setGraphQuery({text, nonce: Date.now()})` + navigate to graph; KG page runs the query once per nonce (FACT App.tsx:159-161,198-201; KnowledgeGraphPage.tsx:1150-1155).

**Tabs, groups, paths (FACT App.tsx:34-51,105-136)**

| # | Page key | Tab label | Icon (lucide) | Group (accent) | Canonical path | Aliases accepted |
|---|---|---|---|---|---|---|
| 1 | ask | Ask RAG | MessageSquareText | engine (primary) | /ask | |
| 2 | quality | RAG Metrics | Gauge | engine | /quality | |
| 3 | graph | Spine | Network | engine | /graph | /knowledge-graph |
| 4 | evidence | Agent | FlaskConical | engine | /evidence | /investigate |
| 5 | fitgap | InsightLens | Scale | engine | /fit-gap | /fitgap |
| 6 | rollout | Fit-Gap Copilot | Globe2 | engine | /rollout | /fit-to-standard |
| 7 | extract | Convert | FileText | convert (warning) | /convert | /extract |
| 8 | batch | Batch Convert | FolderArchive | convert | /batch | |
| 9 | add-kb | Add to knowledge base | DatabaseZap | index (success) | /add-kb | /add-to-knowledge-base |
| 10 | coverage | Coverage | ListChecks | inspect (purple = searchColors.keyword) | /coverage | |
| 11 | review | Doc vs MD | ScanEye | inspect | /review | /doc-md-viewer |
| 12 | viewer | MD Viewer | Columns2 | inspect | /md-viewer | /viewer |
| — | landing | (no tab) | — | — | / | /about, /landing, anything unknown |

- Tab styling: each tab tinted with `alpha(groupAccent, TINT[group])` (engine .055, convert .05, index .05, inspect .06), selected +0.05; label opacity `LABEL_ALPHA` light all 0.82, dark engine .8/convert .62/index .62/inspect .76; a left border + `ml .75` where a new group starts; indicator takes the active group's accent (FACT App.tsx:65-103,261-309).
- Theme mode: `localStorage["theme"]` ∈ {light,dark}, else `prefers-color-scheme`; written back + `document.documentElement.dataset.theme` (FACT App.tsx:138-146,163-170). Same logic in demo and login bundles (FACT DemoApp.tsx:15-35, login/main.tsx:10-34).
- INFERRED: the backend must serve `index.html` for every SPA path above (deep links), which is the backend's job (see app.py spec).

---

## 3. Pages

Conventions used across pages (FACT, multiple files):
- Streaming endpoints are POST + `fetch` + hand-parsed SSE (`event:`/`data:` lines split on `\n\n`), never `EventSource` ("EventSource can only GET and reconnects → would re-bill") (FACT api.ts:672-715, 946-990, 1046-1070).
- Errors: `json<T>()` throws `detail` (string) or `detail.message` or `Request failed (<status>)` (FACT api.ts:186-198).
- History panels for Agent / Fit-Gap Copilot / InsightLens share `RunHistoryDrawer`; Ask RAG uses `AskHistoryDrawer` (FACT imports; test run-history.mjs).
- `showTechDetails` prop (default true) hides model names / technical stage text in Demo Mode (FACT AskPage.tsx:48-51,85; EvidencePage.tsx:575; RolloutPage.tsx:857).

### 3.1 Landing (`LandingPage.tsx`, 602 lines)
- Purpose: product introduction/"How it works"; hero with CTA buttons to Convert, Batch Convert, Ask (FACT LandingPage.tsx:144-167); service cards; exports `ArchitectureSection`, `SERVICE_HUES`, `ServiceCard` reused by DemoLanding (FACT DemoLanding.tsx:10).
- Prop `reachable?: Page[]` hides links to pages a host can't open (FACT :33-42). No API calls.

### 3.2 Ask RAG (`AskPage.tsx`, 1057 lines)
- UI: question box (clear adornment), **search mode** toggle `hybrid` ("Vector and keyword search, merged") / `vector` / `keyword` (FACT :554-560), `k` default 8 (FACT :98), category filter (INFERRED from `categories` in body), sample-questions drawer (`ASK_SAMPLES`), pipeline stepper (`embed → vector → keyword → fuse → answer`, StepKey FACT api.ts:74), streamed answer with clickable `[n]` citations + hover card, KPI strip ("Answer quality", "Faithfulness", "Sources", "Time") (FACT :475-484), tabs **Answer / Evaluation (score) / Sources (n)** (FACT :444-448), history drawer, Document inspector drawer for a source, QualityScorecard.
- API: `api.ragStatus()` → GET /api/rag/status; `ask()` → POST /api/ask SSE events `run, trace, stage, sources, token, done, error` (FACT api.ts:675-715); `askHistory.run(id)` reopen; `askHistory.evaluation(id)` poll; `askHistory.rescore(id)` POST; AskHistoryDrawer uses `askHistory.runs(50, search, quality)` and `deleteRun`.
- **Polling**: after answer, if evaluation `status === "running"`, poll GET /api/ask/runs/{id}/evaluation every **2500 ms** until terminal status (FACT AskPage.tsx:304-331).
- Replay of a past run shows "corpus changed" flag (`corpus_changed`) (FACT api.ts:1617-1620; AskPage.tsx:124).

### 3.3 RAG Metrics / Answer Quality (`QualityPage.tsx`, 346 lines)
- Fiori-like analytical list page: header + KPIs vs targets; tabs **Answers · Metric matrix · Source documents · Failure analysis · Experiments · Judge calibration** (FACT :1-14,39-44); filter bar `{days: 28, half: "", mode: ""}` for first four tabs (FACT :109); metric switcher default `faithfulness` (FACT :118).
- View remembered in `localStorage["quality.view"]` (legacy values `overview`→answers, `explorer`→analysis) (FACT :77-83,122).
- API: GET /api/quality/overview?days&half&mode; GET /api/quality/explorer?…; GET /api/quality/judge; drill-down opens `askHistory.run(runId)` or `experimentItem(expId, itemId)` (FACT :142,171) in `MetricDetailDrawer`; ExperimentsView: GET /api/quality/experiments, GET /api/quality/experiments/compare?base&cand, POST …/{id}/baseline; parts.tsx: POST /api/ask/runs/{id}/review `{verdict: grounded|partly|not, note, reviewer}`.
- Score bands 0.7 / 0.4 (FACT test quality-page.mjs header §2).

### 3.4 Spine / Knowledge Graph (`KnowledgeGraphPage.tsx`, 2974 lines)
- View modes: `graph | model | process | cypher | quality` (FACT :184).
  - **graph**: d3 force simulation drawn on `<canvas>` (SimNode/SimLink, FACT :73-80), zoom (default 0.85), pan, focus-neighbourhood mode, fullscreen (Escape exits), collapsible sidebar and legend (legend starts minimized), node type filters: stream "Business Streams", system "Core Systems", document "Markdown Documents", process "BPML Processes" (all visible), spec "SPARK Specifications" (hidden by default) (FACT :94-108,185-206). Node colour keyed by type from `nodeHues` (FACT :124-126). Text search box. Node detail drawer. "Rebuild" forces `api.rebuildGraph()` (FACT :259).
  - Natural-language query: `api.queryGraph({query})` → POST /api/graph/query → `GraphQueryResult {mode: path|subgraph, summary, answer?, node_ids, edge_ids, path?}`; highlights path (sky) / related (pink) / matches (peach) (FACT :155-158,1123); answer drawer with copy. 5 preset queries (FACT :128-134): Salesforce specs, eCommerce→S/4HANA, BPML O-020-090, specs in L2C, ECC vs S/4HANA.
  - **model**: `ModelView` of ontology from GET /api/graph/model, fetched lazily on first open (FACT :190-196).
  - **process**: `ProcessFlowView({graph, onFocusNode})` built from loaded graph data (FACT ProcessFlowView.tsx:52) — no extra API.
  - **cypher**: `CypherView` → GET /api/graph/neo4j/status, POST /api/graph/neo4j/sync?force=true, POST /api/graph/cypher/generate `{question}`, POST /api/graph/cypher `{query, limit=200, params}` (FACT CypherView.tsx:169,210; api.ts:323-340).
  - **quality**: `GraphQualityView` → GET /api/graph/quality, POST /api/graph/quality/structure, POST /api/graph/quality/questions (background); **polls GET /api/graph/quality every 3000 ms while `questions.status === "running"`** (FACT GraphQualityView.tsx:143-148).
- `onNavigate(page)` lets the graph page link to other app pages.

### 3.5 Agent / Evidence Agent (`EvidencePage.tsx`, 1399 lines)
- UI: question box + `EVIDENCE_SAMPLES` picker, `holdout` toggle, **memory** toggle (`useMemory`, default off) with memory panel open state persisted in `localStorage["evidence.memoryOpen"]` (FACT :586-600,789); KPI strip Claims / Weakest claim / Evidence / Investigation / Time (FACT :971-975); answer state badge (supported, conflicted, documented_unknown, not_in_corpus, false_premise, unrepresentable) (FACT :39-50); tabs **Answer · Claims (n) · Traceability (calls) · Memory (n) · Evaluation**, shown conditionally (FACT :920-927); live log drawer (`AgentLogDrawer`), tool-call trace drawer (`AgentTraceDrawer`, renders rag/graph/bpml traces), document inspector (fetches chunk via `api.chunk`), `MemoryReflectDrawer` (POST /api/evidence/memory/reflect `{question}`), `RunHistoryDrawer`, `AgentEvaluationView`.
- API: GET /api/evidence/status; `askEvidence()` POST /api/evidence/ask `{question, holdout?, categories?, memory?}` SSE events `run, log, memory, tool_call, answer, evaluation, error` (FACT api.ts:1548-1591); GET /api/evidence/runs?limit=50; GET /api/evidence/runs/{id}; DELETE /api/evidence/runs/{id}; GET /api/evidence/runs/{id}/lineage (+ `?format=md|json` download); GET /api/rag/chunk/{chunkId}.

### 3.6 InsightLens (`FitGapPage.tsx`, 2153 lines)
- Purpose: per-BPML-step fit/gap register. Classes FIT_STANDARD, FIT_CONFIG, GAP_DEVELOPMENT, REUSE, ADAPT, CHALLENGE, SIMPLIFY, REPLACE, RETIRE, UNKNOWN with labels/hues (FACT :249-258); materiality high/medium/low weights 3/2/1 (FACT :271-273).
- Form: question (+ `QuestionPicker` over the 27 `evalQuestions.ts` items, which sets question and scope), scope text default `"4.5.1"` resolved via debounced (220 ms) `fitgap.search` (FACT :1469,1540-1548), mode toggle **A · Template baseline / B · Country delta** (FACT :1975-1976), holdout, country profile JSON (validated, only in mode B), `maxSteps` 4, `concurrency` 3 (FACT :1476-1484); preview card from POST /api/fitgap/preview recomputed on change (FACT :1549-1554). Attachments panel (session uploads, stored in `localStorage["fitgap.uploads"]`) with entity comparison vs corpus. Reviewer name in `localStorage["fitgap.reviewer"]`.
- Run: `runFitGap` POST /api/fitgap/run SSE `scope, step_start, tool_call, entry, verify_fail, step_error, synthesis, done, error` (FACT api.ts:948-990); live StepCards per step (waiting/running/done/failed). Results tabs: **Reuse assessment · Gap register (n) · Decisions (n) · Integrations (n) · Agenda (n)** (FACT :2101-2105). Entry detail with evidence, issues, review (accept/reject/refine + corrected class) → POST /api/fitgap/entries/{id}/review. Exports: `/api/fitgap/runs/{id}/export?format=md|json|xlsx`. "Show in graph" → KG page.
- Other API: GET /api/fitgap/status, GET /api/fitgap/runs, GET /api/fitgap/runs/{id}, session uploads (§4).

### 3.7 Fit-Gap Copilot / Rollout (`RolloutPage.tsx`, 2306 lines; components/rollout/*)
- Purpose: Fit-to-Standard analysis: subject documents (country As-Is or SAP Best Practice) vs Global Template; three-way comparison with roles `as_is | template | sap_bp | localization | other` (FACT api.ts:994; RolloutPage.tsx:150-156).
- Setup ("New analysis" composer, 3-step indicator: attach → ready → run, FACT :1329): subject select (`country_as_is` default, follows uploaded roles until touched), scope (optional; debounced `fitgap.search`), country, country context, SAP release, GT version, question; upload panel → `uploadSessionDocuments` POST /api/uploads SSE (`session, start, stage, done_file, file_error, done, error`), retag PATCH, remove DELETE, clear DELETE session; session id in `localStorage["rollout.uploads"]` (FACT :861-1055). Preview POST /api/rollout/preview recomputed on change.
- Run: `runRollout` POST /api/rollout/run SSE `scope, stage, tool_call, asis, gate, analysis, scores, sources, evaluation, done, error, log` (FACT api.ts:1997-2018). Live stages + log auto-scroll unless user scrolled up (FACT :940-948).
- Workspace tabs (FACT :1311-1326): **Summary · Brief · Workshop agenda (n, ✓ when every MUST_DISCUSS item decided) · Deviations (n) · Process alignment (n, if As-Is) · Localization (n | "— n/a") · Dimensions · Backlog (n) · `<subject>` model (n) · Sources (n docs) · Quality gates · Traceability (calls) · Evaluation**. Components: SummaryView, BriefView, ScoreCards (+FormulaTooltip), WorkshopAgendaView, DeviationRegisterView, DeviationRiskView, ProcessAlignmentView, FacilitatorView (1 s countdown timer, FACT FacilitatorView.tsx:111), ObjectHeader, OutcomeDownloads, MaterialityPill.
- Decisions: `rollout.decide(runId, {gap_id, reviewer, verdict: accept|reject|defer, disposition?, comment?, option_index?, rationale?, session_id?})` → POST /api/rollout/runs/{id}/decisions; append-only log. Facilitator mode collects drafts (persisted per run in `localStorage["fitgap.drafts.<runId>"]`, FACT :1207-1232) then `submitWorkshop` POST /api/rollout/runs/{id}/workshop `{facilitator, attendees[], answers[]}`.
- Downloads: `/api/rollout/runs/{id}/export?format=md|json|pdf[&client=1]` (PDF button only if `status.pdf.available !== false`, FACT :862-865); `/api/rollout/runs/{id}/workshop/export?format=md|pdf|docx|xlsx[&session=]`; lineage `/api/rollout/runs/{id}/lineage[?format=md|json]`; cited source open: `/api/rollout/runs/{id}/attachments/{file}` for uploads (kind upload or category UPLOAD) else `/api/kb/files/{file}` (FACT api.ts:2050-2054).
- History: GET /api/rollout/runs, GET /api/rollout/runs/{id}, DELETE /api/rollout/runs/{id}. GET /api/rollout/status on activation (vocabulary, subjects, upload roles, pdf availability).
- Look: "premium" style — navy band `#101c2e` light / Frappé crust dark, teal accent `#1b7c77`/frappe.teal, MONO + SERIF fonts, radius 4px (FACT components/rollout/premium.ts:12-30).

### 3.8 Convert (`ExtractPage.tsx`, 508 lines)
- Single-document flow: Open document / drag-drop → `api.upload(file)` POST /api/upload (multipart `file`) → page previews `/api/docs/{id}/preview/{page}` → **Convert** `POST /api/convert/{id}?vlm=<bool>&provider=claude|openai|qwen` → Markdown rendered/raw toggle, copy, download `/api/docs/{id}/download` → **Add to knowledge base** POST /api/docs/{id}/embed (`EmbedResult` status added/updated/unchanged, duplicates warning, "Ask" action navigates to Ask) (FACT :26-140).
- Accepted extensions: `.pptx,.ppt,.docx,.doc,.xlsx,.xlsm,.xls,.pdf,.html,.htm,.xml,.csv,.txt,.json,.msg,.eml,.png,.jpg,.jpeg,.webp,.bmp,.tiff,.tif` (FACT :16). "Read images with AI" switch (VLM, default off) + provider select (FACT :18-20,34-35). Live elapsed-seconds counter (250 ms interval) while busy (FACT :55-59). `api.health()` → `preview_available` warning.

### 3.9 Batch Convert (`BatchConvertPage.tsx`, 1386 lines)
- Queue of files (Add Files / Add Folder / drag-drop; skips `~$*`, dotfiles, unsupported ext; same ACCEPT list) (FACT :53,131-160). VLM default **on**, provider default claude (FACT :105-106).
- Direct fetches (not in api.ts): POST /api/batch/upload (multipart `files`) → `{batch_id}`; POST /api/batch/convert/{batchId} `{vlm, provider}` SSE `progress, file_done {index, filename, dest_name, markdown, tools}, file_error, batch_done {converted, failed}`; POST /api/batch/{batchId}/embed SSE `progress, file_done, file_error, …`; download zip link `/api/batch/{batchId}/download` (FACT :210-330,575). Per-file ToolBreakdown (engine, VLM counts, OCR, tables, flowcharts…) (FACT :60-76). Elapsed timer 500 ms.

### 3.10 Add to knowledge base (`AddToKnowledgeBasePage.tsx`, 1310 lines)
- Stage `.md/.markdown/.txt` files (token estimate size/4), category picker from `ragStatus.ingest_categories` (INFERRED from api.ts:65-67 + batchInsertKb `category`), **Insert** → `batchInsertKb` POST /api/kb/batch-insert (multipart `files`, `category`) SSE `progress, file_done, file_error, complete, error` (FACT api.ts:595-654); abortable.
- KB table: GET /api/kb/files (name, title, size, category, source, chunks, tokens, is_indexed), filter text + extension filter, indexed vs total counter, delete → DELETE /api/kb/files/{filename}?source=… (FACT :187,381,419-443). Refreshes `ragStatus` on window focus/visibility (FACT :200-214).

### 3.11 Coverage (`CoveragePage.tsx`, 263 lines)
- GET /api/coverage?documents=true; summary counters (on_disk, indexed, in_graph, documents, clean + issue kinds), issue kinds worst-first: file_missing "File gone", not_indexed "Not retrievable", not_in_graph "Not in graph", shadowed "Shadowed by a twin", category_mismatch "Category disagreement", no_original "No original" (FACT :15-24); toggle **Needs a look / Every document**, text filter; table Document/Corpus/Graph/Chunks/Findings (FACT :52-80,167-168).

### 3.12 Doc vs MD (`DocMdViewerPage.tsx`, 1040 lines)
- Two resizable panels (react-resizable-panels): left original document page images (continuous/single, zoom, page), right Markdown (rendered/raw), sync-scroll (FACT :99-126,387-621). Sources: pick indexed KB file (GET /api/kb/files → GET /api/kb/files/{name}?source= text → POST /api/kb/files/open?source= to open original, previews via `/api/docs/{id}/preview/{n}`), or upload a doc (POST /api/upload) and convert (POST /api/convert/{id}?vlm=false&provider=claude) (FACT :139-238). Has built-in demo sample markdown incl. mermaid (FACT :55-69).

### 3.13 MD Viewer (`MdViewerPage.tsx`, 860 lines)
- Pure client: two editable-title panes loading local `.md,.markdown,.mdown,.mkd,.txt` via FileReader/drag-drop, rendered/raw, sync scroll, copy (FACT :118-170,523). No API.

### 3.14 Shared components (INFERRED from names/imports unless noted)
`Markdown.tsx` (marked + DOMPurify + optional mermaid; `<mark>` highlights, `[n]` citation linking; quote-locate regex shared with test — FACT :1-30), `DocumentInspectorDrawer` (source chunk in its document with quote highlight), `AskHistoryDrawer`, `RunHistoryDrawer` (shared history), `SampleQuestionsDrawer`, `QualityScorecard`, `MetricDetailDrawer` (judge working: claims/excerpts/questions/ratings), `AgentLogDrawer`, `AgentTraceDrawer`, `InvestigationView` (lineage), `AgentEvaluationView`, `MemoryReflectDrawer`, `ModelView`, `CypherView`, `GraphQualityView`, `ProcessFlowView`, `ClearAdornment`, `ScrollRunway`, `SignInForm`, `BrandLogo`.

---

## 4. API client (`src/api.ts`) — complete inventory

`GET` unless stated. `cat` = `?categories=a&categories=b` built by `categoryQuery` (FACT api.ts:181-184). All FACT api.ts line refs.

### 4.1 `api` object (:260-349)
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

GraphNode `type ∈ stream|system|document|process|spec` + optional `code, ticket, filename, source, format, chars, is_primary, in_bpml, jira_key, category, degree, description` (:487-509).

### 4.2 Streaming functions
| Fn | Path | Body | SSE events |
|---|---|---|---|
| batchInsertKb(files, handlers, signal?, category?) (:595) | POST /api/kb/batch-insert | multipart `files[]`, `category` | progress, file_done, file_error, complete, error |
| ask(body, on, signal) (:675) | POST /api/ask | `{question, mode: hybrid|vector|keyword, k, categories[]}` | run `{id, not_saved?}`, trace `{id,url}`, stage `StageEvent{key,status,detail,ms?,terms?}`, sources `Source[]`, token `string`, done `{seconds,input_tokens,output_tokens}`, error `{message}` |
| runFitGap(body, on, signal) (:948) | POST /api/fitgap/run | `FitGapRunBody {mode?, scope_bpml, country_profile?, holdout?, max_steps?, concurrency?, question?, categories?, upload_session?}` | scope, step_start, tool_call, entry (`FitGapEntry`), verify_fail, step_error, synthesis (`FitGapSynthesis`), done, error |
| uploadSessionDocuments(files, session, role, on, signal?) (:1075) | POST /api/uploads | multipart `files[]`, `session` ("" = new), `role` | session, start, stage, done_file, file_error, done (`UploadSession & {added,total}`), error |
| askEvidence(body, on, signal) (:1548) | POST /api/evidence/ask | `{question, holdout?, categories?, memory?}` | run, log, memory, tool_call, answer (`EvidenceAnswer`), evaluation (`AgentEvaluation`), error |
| runRollout(body, on, signal) (:1997) | POST /api/rollout/run | `RolloutRunBody {scope_bpml?, subject?, country?, country_context?, sap_release?, gt_version?, question?, upload_session, categories?}` | scope, stage, tool_call, asis, gate, analysis, scores, sources, evaluation, done, error, log |
| (BatchConvertPage, direct) | POST /api/batch/upload; POST /api/batch/convert/{id}; POST /api/batch/{id}/embed; GET /api/batch/{id}/download | see §3.9 | progress, file_done, file_error, batch_done |

### 4.3 `sessionUploads` (also `fitgap.uploads`) (:1100-1116)
status GET /api/uploads/{s} → `UploadSession {session, exists, created_at?, used_at?, expires_at?, ttl_hours?, max_files?, database?, schema?, files: UploadedFile[], documents, chunks, tokens?, graph?}`; entities GET /api/uploads/{s}/entities[?roles=…] → `UploadComparison {documents[], entities: UploadEntity[], shared, new}`; retag PATCH /api/uploads/{s}/files/{name}?role=; remove DELETE /api/uploads/{s}/files/{name}; drop DELETE /api/uploads/{s} → `{dropped}`.

### 4.4 `fitgap` (:1118-1142)
status GET /api/fitgap/status → `FitGapStatus`; roots GET /api/fitgap/scope → `{roots}`; search GET /api/fitgap/scope?q= → `{query, matches: BpmlProcess[]}`; node GET /api/fitgap/scope?code= → `{process, ancestry, children, steps}`; preview POST /api/fitgap/preview (FitGapRunBody) → `FitGapPreview`; runs GET /api/fitgap/runs; run GET /api/fitgap/runs/{id} → `FitGapRunDetail`; exportUrl /api/fitgap/runs/{id}/export?format=md|json|xlsx; review POST /api/fitgap/entries/{entryId}/review `{reviewer, verdict, corrected_classification?, comment?}`.

### 4.5 `askHistory` (:1637-1661)
runs GET /api/ask/runs?limit=&search=&quality= (quality ∈ "", low, unfaithful, unsafe, unscored) → `{runs: AskRunSummary[], retention, filters, low_quality_below}`; evaluation GET /api/ask/runs/{id}/evaluation → `AskEvaluation {status none|running|done|failed|skipped|abandoned, metrics: Record<string, MetricScore>, overall, safety, terms, …}`; rescore POST same → `{status, run_id, judge_model}`; run GET /api/ask/runs/{id} → `AskRunDetail` (answer, sources, terms, corpus_changed, evaluation?, review?); deleteRun DELETE /api/ask/runs/{id}; clear DELETE /api/ask/runs → `{status, removed}`.

### 4.6 `evidence` (:1684-1707)
status GET /api/evidence/status → `EvidenceStatus` (model, prompt_hash, max_tool_calls, anthropic_key, tools, categories, duplicate_groups, hubs, graph, history?, memory?: MemoryStatus); runs GET /api/evidence/runs?limit=; run GET /api/evidence/runs/{id}; lineage GET /api/evidence/runs/{id}/lineage → `Lineage`; lineageExportUrl …/lineage?format=md|json; deleteRun DELETE; reflect POST /api/evidence/memory/reflect `{question}` → `MemoryReflection {text, based_on[], searched[], usage, error}`.

### 4.7 `rollout` (:2025-2082) + `clientExports(on)` (:2023)
status GET /api/rollout/status → `RolloutStatus` (pdf?, bpml, model, prompt_hash, max_tool_calls, anthropic_key, runs, decisions, vocabulary{deviation_types, dispositions, localization_states, dimensions{label,weight}, ratings}, subjects: RolloutSubject[], uploads{ttl_hours,max_files,accepted,database,roles}); preview POST /api/rollout/preview → `RolloutPreview`; runs GET /api/rollout/runs; run GET /api/rollout/runs/{id} → `RolloutRunDetail`; deleteRun DELETE; exportUrl /api/rollout/runs/{id}/export?format=md|json|pdf[&client=1]; sourceUrl (see §3.7); decide POST …/decisions → `RolloutDecision`; lineage GET …/lineage; lineageExportUrl; workshopExportUrl …/workshop/export?format=&session=; submitWorkshop POST …/workshop → `{session: WorkshopSession, decisions[]}`.
Enumerations (FACT :1716-1732): DeviationType PF BR AP RO LC CT DT IN RP UX EX TM TC SEC VOL POL; Disposition ADOPT_GT CONFIGURE_STANDARD USE_SAP_LOCALIZATION ADOPT_SAP_BP EXTEND_STANDARD RETAIN_LOCAL_EXCEPTION REDESIGN_GT RETIRE_LEGACY REQUIRES_DECISION OUT_OF_SCOPE; LocalizationState CONFIRMED_STATUTORY SAP_DELIVERED CORPORATE_POLICY LOCAL_PREFERENCE SUSPECTED NOT_LOCALIZATION; Materiality Critical/High/Medium/Low/Informational; WorkshopBucket MUST_DISCUSS/CONFIRM/NO_WORKSHOP_TIME; Dimension flow/rules/governance/data/integration/controls/reporting; evidence_class E1–E4; side as_is/template/sap_bp/localization.

### 4.8 `quality` (:2299-2322) + `experimentItem` (:2338)
overview GET /api/quality/overview?days=&half=&mode= → `QualityOverview`; explorer GET /api/quality/explorer?… → `QualityExplorer`; judge GET /api/quality/judge → `JudgeTrust`; experiments GET /api/quality/experiments → `{experiments}`; compare GET /api/quality/experiments/compare?base=&cand= → `ExperimentComparison`; setBaseline POST /api/quality/experiments/{id}/baseline; deleteExperiment DELETE /api/quality/experiments/{id}; review POST /api/ask/runs/{runId}/review `{verdict, note, reviewer}`; experimentItem GET /api/quality/experiments/{expId}/items/{itemId} → `ExperimentItem`.
FailureType keys: safety, wrong_sources, buried, ignored, invented, off_question (FACT :2132-2134).

### 4.9 Non-api.ts fetches
GET /api/app/session (`{user}`), POST /api/app/logout (App.tsx); POST /api/app/login and POST /api/demo/login `{username, password}` → 200 sets HttpOnly cookie, else `{detail}` (SignInForm.tsx:41-52); GET /api/demo/session (401 → redirect `/demo/login?next=`), POST /api/demo/logout (DemoShell.tsx:146-170); batch endpoints (§3.9).

**Defined but not called from UI (FACT grep):** `askHistory.clear`, `fitgap.roots`, `fitgap.node`, `quality.deleteExperiment`. `graphData/rebuildGraph/graphModel` are always called without categories.

### 4.10 localStorage keys (FACT grep)
`theme`, `quality.view`, `evidence.memoryOpen`, `fitgap.reviewer` (shared by InsightLens & Copilot), `fitgap.uploads`, `rollout.uploads`, `fitgap.drafts.<runId>`, `demo-sidebar-v2`. All wrapped in try/catch ("private mode").

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
- Brand: "Spark AI **Spine**" (Spine in text.secondary weight 400), `logo.png`; in dark mode the logo sits on a 92% white tile, never recoloured (FACT BrandLogo.tsx).

---

## 6. Login and Demo Mode bundles

- **/login** (`login/main.tsx`): `SignInForm` posting to `/api/app/login`; `next` param accepted only if it starts with `/`, not `//`, not `/login`, no backslash; default `/` (FACT login/main.tsx:20-26). Theme toggle on form.
- **SignInForm**: username + password (show/hide), empty → "Enter a username and a password.", POST JSON, on success `location.replace(nextTarget())`, error shows server `detail` or `Sign-in failed (<status>).` (FACT SignInForm.tsx:31-56). Credentials never in the bundle.
- **/demo** (`demo/main.tsx` → DemoApp): calls `clientExports()` so every Copilot export URL gets `&client=1` (model name omitted) (FACT demo/main.tsx:8-9, api.ts:2020-2041). DemoApp chooses `DemoLogin` if path starts `/demo/login`, else `DemoShell` (server redirects unauthenticated `/demo` → `/demo/login`) (FACT DemoApp.tsx:1-7,28). DemoLogin posts `/api/demo/login`, `next` must match `^/demo(/[\w-]*)?$` and not `/demo/login`, default `/demo` (FACT DemoLogin.tsx:7-11).
- **DemoShell** (FACT DemoShell.tsx:1-180):
  - Header tabs only: **Spine** (`/demo/graph`) and **Fit-Gap Copilot** (`/demo/fit-gap-copilot`). Sidebar "Answer engines": **Ask RAG** (`/demo/ask`), **Agent** (`/demo/agent`). Landing `/demo/home` (default after sign-in, HOME = landing). Any other slug → landing (Convert, Batch, Add-KB, Coverage, Doc vs MD, MD Viewer, InsightLens, RAG Metrics are unroutable in demo).
  - Address bar canonicalised with `replaceState` on arrival; `pushState` on navigation; popstate supported.
  - Pages mount lazily on first visit (`visited` set) then stay mounted; rendered with `showTechDetails={false}` (Rollout, Ask, Evidence) and KG with `incomingQuery={null}`.
  - Sidebar states `rail` (60px, default) / `expanded` (240px) / `hidden`, persisted `localStorage["demo-sidebar-v2"]`.
  - On mount GET /api/demo/session; 401 → `/demo/login?next=<path>`; account menu with user + sign out (POST /api/demo/logout → `/demo/login`).
  - DemoLanding: 4 story steps (Knowledge Graph, Fit-Gap Copilot, Ask RAG, Evidence Agent) with buttons to those pages, plus LandingPage's `ArchitectureSection` (FACT DemoLanding.tsx:1-40).
- Known leak: Demo Mode still shows model name on Copilot Traceability tab (FACT docs/demo-video/README.md "Things to know").

---

## 7. Demo video pipeline (docs/demo-video/, skim)

- Output `fitgap-demo-rough.mp4` (~6.5 min) for Copilot run `ro_879e0497a4` (India customer returns); `scenes.json` (single source: captions, VO, cue phrases, cards, pronunciation, masks), `scenes.py` (one function per scene, `at("phrase")` actions), `script.md`, `captures/` 1920×1080 stills, `clips/` webm per scene, `tools/` vendored demo-video skill engine (voice.py, record.py, build.py, check.py, kokoro_say.py, setup_tts.sh, explore.py, demo.py) (FACT README.md).
- TTS Kokoro-82M local voice `af_heart` (`VOICE`, `VOICE_SPEED`, `TTS=say` alt); Playwright recording against app on :8000 using Demo Mode creds `DEMO_USERNAME/DEMO_PASSWORD`; `check.py` Whisper transcript diff. Commands: `python3 docs/demo-video/tools/{voice,record,build,check}.py`; setup `bash docs/demo-video/tools/setup_tts.sh` (~1.5 GB cache). Not needed to rebuild the app — optional.

---

## 8. Tests

### 8.1 How tests are run
- **No pytest config, no conftest, no package.json test script, no CI file found** (FACT ls: no pytest.ini/pyproject/setup.cfg/conftest). Each backend test file is a self-running script: `main()` collects `test_*` globals, prints pass/fail/skip, exits non-zero on failure (FACT test_rag.py:218-238; test_neo4j.py:258-270). Some state pytest also works (test_fitgap.py:4, test_rollout.py:5).
- README "Tests" (FACT README.md:149-153): `.venv/bin/python backend/tests/test_<name>.py   # e.g. test_rollout, test_guardrails, test_graph_eval`.
- Frontend: `cd frontend && node test/<name>.mjs` (each file's header "Run:"). They are **static source-consistency checks** (read .ts/.tsx/.py text with `node:fs`), not browser tests; `rollout-steps.mjs` needs `typescript` and `quote-highlight.mjs` needs `marked` from `frontend/node_modules` (FACT).
- Postgres-backed tests read `DATABASE_URL` (loaded from repo `.env` by `backend/rag/rag.py:57-64,256-262`), connect to the `/postgres` admin DB and CREATE/DROP throwaway DBs (`docling_test_ask`, `docling_test_category`, `docling_test_evaluation`, `docling_test_rag`, `docling_test_quality`, `docling_test_ev_<uuid>`, `docling_test_ro_<uuid>`) — role needs CREATEDB (INFERRED) (FACT test_ask_store.py:34-60; test_rollout.py:820-840; test_evidence.py:370-390).
- Whole suite (INFERRED, no runner exists):
  ```bash
  for f in backend/tests/test_*.py; do .venv/bin/python "$f" || echo "FAIL $f"; done
  (cd frontend && for f in test/*.mjs; do node "$f" || echo "FAIL $f"; done)
  ```
- Not executed during this survey (running was blocked); pass/fail status unknown.

### 8.2 Backend tests (`backend/tests/`, FACT docstrings + `ast` count of test functions)

| File | #tests | Covers | Needs |
|---|---|---|---|
| test_agent_eval.py | 29 | Code-only agent scores count what they claim; `push` to stub Langfuse, asserts nothing reaches real client | nothing |
| test_app_login.py | 10 | app_login.py: credentials, signed session, page gate, what stays open (TestClient on bare FastAPI) | nothing |
| test_ask_store.py | 9 | Ask history: recorded before answer, excerpts survive abandon, partial answer on fail, abandoned status, list excludes excerpts, retention trims oldest, delete one | Postgres |
| test_bpml_markdown.py | 8 | BPML process-house doc render()↔parse() round-trip incl. after chunk/join | nothing |
| test_category_durability.py | 7 | UI-chosen category persisted to disk (front matter) so graph + re-index respect it; embedding stubbed | Postgres |
| test_converter.py | 22 | `.txt` passes through unchanged (no Docling escaping), csv handling (runs Docling) | Docling installed; no network/DB |
| test_coverage.py | 9 | Coverage report: not-indexed, category mismatch, no original, clean corpus reports clean (stores stubbed) | nothing |
| test_demo_mode.py | 8 | demo_mode.py login/session/gate; default creds in test `solvay/solvay` (test-local stub) | nothing |
| test_evaluation.py | 47 | RAG judge arithmetic, weights, skipped vs failed, row persistence; judges stubbed and asserted stubbed | Postgres |
| test_evidence.py | 81 | Evidence Agent provenance, independence, hub filtering, scoring; store bookkeeping in throwaway DB; fake Anthropic | Postgres + the indexed corpus (`solvay-spark/pkg/markdown/`) |
| test_fitgap.py | 41 | InsightLens verifier, rubric arithmetic, BPML parsing, holdout masking | nothing (no Claude, no DB) |
| test_formats.py | 14 | Accepted vs convertible extensions agree (.xlsm,.json,.msg,.eml); preview stand-ins | optional LibreOffice/pdftoppm and `tests/fixtures/sample.msg` (absent → skipped) |
| test_graph_determinism.py | 5 | Byte-identical graph builds across hash seeds; cached graph == fresh build; BPML fingerprint | corpus files + cached graph (skip if built from different files) |
| test_graph_eval.py | 14 | Graph quality checks on hand-made faulty graph; question comparison | nothing |
| test_guardrails.py | 27 | Scope classifier, gated web search, no contact details; stubs asserted | nothing |
| test_knowledge_graph.py | 35 | Extraction rules: BPML-backed hierarchy, bounded system keyword matching, filename-only entities | corpus + BPML process-house doc |
| test_neo4j.py | 16 | Write batches from graph (offline); live: DB matches build, writes refused, row cap, examples return rows, endpoint 400s; Cypher generator with fake Claude | offline part none; live part Neo4j running with current build (else explicit skip) |
| test_originals.py | 18 | Locating original doc beside markdown/ or in `.workdir/<id>/` | nothing (temp tree) |
| test_quality.py | 38 | Quality workspace arithmetic: failure-rule order, 0.0 below line, periods, percentiles; embedder replaced by bag-of-words; TestClient for endpoints | Postgres |
| test_rag.py | 10 | Corpus schema: UNIQUE(source), recategorise atomic, scoped search isolation, BM25 corpus_stats per category | Postgres (no Ollama) |
| test_rollout.py | 107 | Copilot scoring, quality gates, alignment-vs-empty-register invariant, store via throwaway DB, some skipped conditions | mostly nothing; store tests need Postgres |
| test_tracing.py | 7 | Call sites work with tracing off; span wrapper exposes OTel span | nothing |

None of the backend tests require a live Anthropic key or Ollama (all stub them — FACT docstrings of test_evaluation, test_guardrails, test_quality, test_category_durability, test_rag).

### 8.3 Frontend tests (`frontend/test/`)

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
| quote-highlight.mjs | Every stored Evidence-Agent quote highlights in rendered chunk/doc text nodes (pipes treated as cuts); locate regex copied from Markdown.tsx | quote-highlight.fixture.json (+ `marked`) |
| quote-highlight-fixture.py | Regenerates the fixture from Postgres `evidence_runs` (status done) + `rag.chunk()`; warns if regex drifted. Run `.venv/bin/python frontend/test/quote-highlight-fixture.py` | Postgres + corpus files |

**Golden / fixture data**
- `frontend/test/quote-highlight.fixture.json` is **0 bytes** in the working tree (FACT wc) → must be regenerated before `quote-highlight.mjs` is meaningful.
- `src/data/evalQuestions.ts`: 27 evaluation questions Q1–Q16 (PKG), D1–D6 (DR), C1–C5 (PKG+DR) with BPML scope, axis, per-engine expectations (strong/partial/weak/blind) — source `docs/three-engine-eval-questions.md` (FACT evalQuestions.ts:1-24).
- `docs/spark-fitgap-eval-golden-set.xlsx` (golden set; not opened — INFERRED purpose).
- `src/data/askSamples.ts`, `evidenceSamples.ts`: curated sample questions with "what to look for".
- No `backend/tests/fixtures/` directory (FACT); test_formats expects optional `tests/fixtures/sample.msg`.

---

## 9. Acceptance checklist for a rebuilt version

Build & static
1. `npm run build` type-checks and writes three HTML entries (index, demo, login) + assets to `static/dist`; `npm run dev` proxies `/api` to :8000.
2. All 11 frontend `node test/*.mjs` pass (after regenerating the quote fixture) and all 22 backend test scripts pass with Postgres available (Neo4j-live tests may skip with a message).

Shell
3. Header shows 12 tabs in order/labels/groups of §2; each path and alias deep-links to the right page; unknown path → landing; browser back/forward work; tab title reads `Spark AI Spine — <label>`.
4. Switching tabs preserves page state (a typed question, a conversion, a graph query remain).
5. Theme toggle persists across reload (`localStorage.theme`); dark mode uses only Frappé colours; tooltips/scrollbars themed; `<mark>` highlight legible.
6. With APP_LOGIN on: `/` redirects to `/login`; bad creds show server message; good creds land on `next`; sign-out icon appears, POSTs logout, returns to `/login`. With it off, no sign-out button.

Convert / index / inspect
7. Convert: upload each accepted extension, see page previews, convert with and without "Read images with AI" (provider claude/openai/qwen), toggle rendered/raw, copy, download, Add to knowledge base reports added/updated/unchanged + duplicates; "Ask" jumps to Ask tab.
8. Batch Convert: add files/folder (skips `~$`, dotfiles, unsupported), stream per-file progress/done/error, tool breakdown, download zip, embed batch with streamed progress and summary.
9. Add to KB: stage .md/.txt, choose category, insert with streamed progress; table lists files with indexed flag; delete removes (with `source` disambiguation); counters refresh on window focus.
10. Coverage: summary counts, issue chips worst-first, "Needs a look" vs "Every document", text filter.
11. Doc vs MD: pick an indexed file → original pages left, Markdown right, sync scroll; "no original" message for UI-added docs; upload+convert path works. MD Viewer: two local Markdown files side by side.

Engines
12. Ask RAG: stepper advances embed→vector→keyword→fuse→answer (keyword/vector modes skip steps), sources arrive before tokens, citations `[n]` open the document inspector at the passage; evaluation shows "scoring…" then a score (poll every 2.5 s stops when terminal); rescore works; history drawer filters by search and quality segment, reopen and delete work; aborting a question does not re-run it.
13. RAG Metrics: six tabs, filters (days/half/mode), drill into an answer opens the metric drawer with judge working; human review verdict saves; experiments compare and set baseline; view remembered.
14. Spine: graph renders with type legend (specs hidden by default), filters, search, zoom/fullscreen, node drawer; NL query highlights path/subgraph and shows answer; 5 presets work; Rebuild works; Model, Process, Cypher (status, sync, generate, run read-only query; writes rejected) and Quality (structure check, background question check polled every 3 s) views work; InsightLens "show in graph" runs the query on arrival.
15. Agent: ask with/without memory and holdout; live log; answer state badge, claims with scores and stance-tagged sources, Traceability lineage, Memory tab only when used, Evaluation; open a quote in its document highlighted; reflect drawer; history drawer open/delete; lineage md/json download.
16. InsightLens: scope search resolves (default 4.5.1), preview updates with mode/steps/concurrency/holdout, eval-question picker sets question+scope, mode B validates country JSON, run streams step cards and synthesis tabs (Reuse/Gaps/Decisions/Integrations/Agenda), entry review accept/reject/refine persists, exports md/json/xlsx, attachments upload/remove with corpus comparison; session persists across reload until expiry.
17. Fit-Gap Copilot: upload documents with roles (retag/remove/clear), subject auto-follows roles, preview shows readiness/blocker/estimate, run streams stages + log, all 13 workspace tabs populate, decisions (accept/reject/defer with option + rationale) append, facilitator mode drafts survive reload and submit atomically, agenda tab gets ✓ when all MUST_DISCUSS decided, exports md/json/pdf (pdf hidden when server says unavailable), workshop export md/pdf/docx/xlsx, cited sources open (attachments served from the run), history open/delete.

Demo
18. `/demo` without session → `/demo/login`; demo creds sign in to `/demo/home`; only Spine & Fit-Gap Copilot tabs + Ask RAG/Agent in sidebar; other slugs land on home; sidebar rail/expanded/hidden persists; model names hidden (except known Traceability leak); Copilot downloads carry `client=1`; session expiry redirects to login; sign out works.

---

## 10. Gaps / uncertainties
- Tests were **not executed** (blocked by sandbox policy); current pass/fail state unknown.
- `quote-highlight.fixture.json` is empty in the tree; frontend quote test likely fails or is vacuous until regenerated (INFERRED).
- No unified test runner/CI; whole-suite command in §8.1 is INFERRED.
- Large components (KnowledgeGraphPage canvas drawing details, AgentTraceDrawer, rollout views, quality sub-views, DocumentInspectorDrawer, Markdown citation logic) were skimmed for structure only; exact visual layout, copy text and chart forms not captured.
- Server-side SPA fallback routes (which paths serve index.html) and `/login`, `/demo/*` gating live in backend (app.py, app_login.py, demo_mode.py) — see backend spec.
- Exact SSE payload shapes for batch endpoints (`/api/batch/*`) are typed only inline in BatchConvertPage, not in api.ts.
- `docs/spark-fitgap-eval-golden-set.xlsx` not opened; its relation to `evalQuestions.ts` is INFERRED.
- Whether `static/dist` is committed (prebuilt) was not checked.
