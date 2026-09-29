# InsightLens: build handover

**Programme:** Solvay SPARK S/4HANA rollout, Tarento Wave Factory
**Scope of this build:** Lead-to-Cash (L2C) slice, on top of the existing Solvay Spark Spine AI stack
**Handover date:** 21 Sept 2026
**Status:** ready to build. Section 12 is the kickoff prompt; paste it into a new Claude Code session opened at the repo root.

---

## 1. Why this exists

The Wave Factory proposal promises that country workshops start about 70% prepared. InsightLens is the service that delivers that. For a scope of BPML process steps it produces a **draft fit-gap register**, where every entry has evidence, a confidence score and a named human who decides.

This build has two jobs, and both matter equally:

1. **Build InsightLens**: an agent that reads the corpus through the two existing engines and proposes fit-gap entries.
2. **Evaluate what has been built**: measure how good the RAG engine, the graph engine and InsightLens actually are, using wave-1 material Solvay has already classified as ground truth.

Non-negotiable principle from the proposal: **AI proposes, humans decide.** Every output has `status = proposed` until a named reviewer accepts it. InsightLens never makes a decision.

---

## 2. What already exists (do not rebuild it)

The **Solvay Spark Spine AI** stack, from `system-diagram.md` and `system-workflow.puml`:

| Component | File | What it does |
|---|---|---|
| API | `app.py` (FastAPI, :8000) | `/api/upload`, `/api/convert/{doc_id}`, `/api/docs/{doc_id}/embed`, `/api/ask` (SSE), `/api/graph/query` |
| Converter | `converter.py` + Docling | Office/PDF to Markdown; connector flows to Mermaid; Tesseract, table_cv, flow_cv, optional Qwen3-VL |
| Corpus | `solvay-spark/pkg/markdown/`, `knowledge_base/` | Converted Markdown, the substrate both engines read |
| Chunker | `md_chunker.py` | Heading-aware chunks (~500 tokens, heading path kept) |
| RAG engine | `rag.py` | SHA-256 fingerprinting; Ollama `bge-m3` embeddings (1024-d, local); Postgres `rag_chunks` with pgvector HNSW + `tsvector` BM25; reciprocal rank fusion; top-k to Claude (`claude-opus-5`); `ask_events(question, k=8)` streams the answer |
| Graph engine | `knowledge_graph.py` | Regex + ontology extraction from the same `.md` files; `knowledge_graph.json` (720 nodes, 842 edges: streams, systems, BPML codes, SPARK tickets); BFS shortest path + 2-hop bridge expansion; templated answers, no LLM |
| UI | React 19 SPA | Extract, Ask and Graph (D3 force canvas) pages |

**Constraints to preserve:**
- The two engines never call each other. InsightLens is a **new third component** that calls both; it does not merge them.
- Embeddings stay local (Ollama). Only the top-k chunk excerpts go to Claude, and that stays true.
- Exact codes must survive retrieval: BPML codes like `7.1.12.3`, tickets like `SPARK-33997`, migration objects like `DM035`, and codes like `M-090-030`. BM25 is what protects them; don't bypass it.

**Corpus facts from the L2C inventory** (`claude/spark-l2c-inventory-findings.md` in the SPARK project):
- `BPML_ProcessesHierarchyExtended.xlsx` is the authoritative process hierarchy and InsightLens's scope backbone.
- The fit registers are `L2C - Fits.xlsx`, `Reports listed as FITs and GAPs L2C.xlsx` and `L2C FITs with missing description.xlsx`. **These are the ground truth for evaluation.**
- Folder conventions encode the answer: `2. FITs - Config/` and `3. GAPs - Development/` (FUT, TUT and CRC material per SPARK ticket). **This is a leakage risk** (see §8.3).
- There is no SDD or BRD layer. Design intent lives in configuration specs, FUT documents and 32 workshop transcripts.
- Country AS-IS material is thin: legacy partner functions, ECC interim structures, order and payment-term extracts. EXT is nearly empty (Italian statutory registers only).

---

## 3. Two operating modes

Because country AS-IS data is thin today, build both modes behind one interface.

| Mode | Question it answers | Inputs | Output classes |
|---|---|---|---|
| **A. Template baseline** (build first) | "For each BPML step in scope, does the template meet it with SAP standard, configuration, or custom development, and how sure are we?" | BPML subtree + corpus | `FIT_STANDARD`, `FIT_CONFIG`, `GAP_DEVELOPMENT`, `UNKNOWN` |
| **B. Country delta** | "For a new country, what carries over, what changes and what must be challenged?" | Mode A result + a country profile (YAML) + optional AS-IS Markdown folder | `REUSE`, `ADAPT`, `CHALLENGE`, `SIMPLIFY`, `REPLACE`, `RETIRE`, `UNKNOWN` |

Mode A can be scored directly against the wave-1 fit registers. Mode B has no ground truth yet; it is evaluated by human review (§8.4).

Class definitions for Mode B (from the Wave Factory POV):

- **REUSE**: the template step carries over unchanged.
- **ADAPT**: reuse with a deliberate country change (configuration, org values, output variant).
- **CHALLENGE**: question it before it travels. The template choice may not fit the country, or the evidence conflicts.
- **SIMPLIFY**: same intent with fewer moving parts.
- **REPLACE**: SAP standard (or a localization) beats the template's custom element.
- **RETIRE**: the step or extension doesn't earn a place in the next wave.
- **UNKNOWN**: the evidence runs out. This is a valid, first-class answer, never a guess in disguise.

---

## 4. Target architecture

```
                    ┌────────────────────────── fitgap/ (new) ─────────────────────────┐
 UI "Fit-Gap" page ─► /api/fitgap/* ─► orchestrator.py                                 │
                    │     1 scope    → bpml.py        (BPML subtree, IDs, parents)     │
                    │     2 gather   → tools.py ──► rag.search_only()  (no answer)     │
                    │                         └──► knowledge_graph lookup/neighbours   │
                    │     3 classify → agent.py (Claude tool-use, JSON schema out)     │
                    │     4 verify   → verifier.py (quote-in-chunk, ID-exists checks)  │
                    │     5 reduce   → synthesis.py (reuse %, decisions, impacts,      │
                    │                                agenda)                            │
                    │     6 persist  → Postgres fitgap_* tables, status = proposed     │
                    │  eval/ → harness.py (E1–E4) → reports/eval_<date>.md + .json     │
                    └──────────────────────────────────────────────────────────────────┘
```

**Map-reduce over steps:** one bounded agent run per BPML step (level 4, or level 3 if level 4 is missing), then a synthesis pass over all entries. This keeps each context small and each run auditable, and lets you re-run just the steps that failed.

### 4.1 Tools the agent may call (Claude tool-use)

The agent only sees the corpus through these tools. Wrap existing functions; refactor `rag.py` to expose retrieval without answer generation.

| Tool | Backed by | Returns |
|---|---|---|
| `get_scope(bpml_code)` | `bpml.py` reading the BPML sheet | Subtree: code, name, level, parent, children |
| `search_corpus(query, k=8, filters)` | `rag.py` hybrid retrieval only (vector + BM25 + RRF) | `[{chunk_id, doc, heading_path, text, score}]`; filters: doc include/exclude globs, holdout flag |
| `get_chunk(chunk_id)` | Postgres `rag_chunks` | Full chunk text + metadata |
| `graph_entity(text_or_code)` | `knowledge_graph.py` entity resolution | Node id, type, label, aliases |
| `graph_neighbors(node_id, hops=1..2)` | `knowledge_graph.py` | Adjacent nodes/edges: tickets, systems, streams, BPML codes |
| `graph_path(a, b)` | `knowledge_graph.py` BFS | Hop-by-hop path |
| `submit_entry(entry)` | `backend/agents/fitgap/agent.py` | Validates against the Pydantic schema (§5); rejects malformed output with the error so the agent can fix it |

Tool budget per step: at most 12 calls, and at most 40k input tokens. On budget exhaustion the agent must submit `UNKNOWN` with a reason, not a guess.

### 4.2 Evidence strategy per step

1. **Graph first, for identity.** Resolve the BPML code, then pull linked SPARK tickets, systems, streams and DM objects. A step with linked `GAPs - Development` tickets is a strong development signal, **but in holdout mode those path-derived signals are masked** (§8.3).
2. **RAG second, for substance.** Query with the code, the step name, and any ticket IDs and system names found in step 1. Always include the exact code in one query so BM25 can match it.
3. **Read before claiming.** Every claim in an entry must quote text from a chunk the agent actually retrieved.

---

## 5. Data contracts

Use Pydantic models in `backend/agents/fitgap/schemas.py`; generate the JSON Schema for the tool definition from them.

```python
class Evidence(BaseModel):
    chunk_id: str
    doc: str                    # file name
    heading_path: str
    quote: str                  # verbatim, <= 300 chars, must appear in the chunk text
    supports: Literal["for", "against", "context"]

class IntegrationImpact(BaseModel):
    system: str                 # as named in the graph (Esker, Elemica, Nexus, Salesforce, Sovos, ...)
    interface_ref: str | None
    impact: Literal["none", "reuse", "variant", "new"]
    evidence: list[Evidence]

class DecisionPoint(BaseModel):
    question: str               # something only Solvay can answer
    options: list[str]          # 2-4 options
    consequence_note: str
    evidence: list[Evidence]

class FitGapEntry(BaseModel):
    run_id: str
    mode: Literal["A", "B"]
    bpml_code: str              # must exist in the BPML sheet
    step_name: str
    classification: Literal["FIT_STANDARD", "FIT_CONFIG", "GAP_DEVELOPMENT",
                            "REUSE", "ADAPT", "CHALLENGE", "SIMPLIFY",
                            "REPLACE", "RETIRE", "UNKNOWN"]
    rationale: str              # <= 120 words, plain language
    confidence: float           # 0-1, per the rubric in §6
    materiality: Literal["low", "medium", "high"]
    linked_tickets: list[str]   # SPARK-xxxxx that exist in the graph
    sap_objects: list[str]      # doc types, condition types, output types... quoted from evidence
    evidence: list[Evidence]    # at least 1 for any non-UNKNOWN class; at least 2 for confidence >= 0.7
    integration_impacts: list[IntegrationImpact]
    decision_points: list[DecisionPoint]
    open_questions: list[str]
    status: Literal["proposed"] = "proposed"
```

Postgres tables: `fitgap_runs` (id, mode, scope, country, model, params, holdout, started/finished, cost), `fitgap_entries` (JSONB entry + flattened columns for filtering), `fitgap_reviews` (entry_id, reviewer, verdict `accept|reject|refine`, corrected_classification, comment, ts). Reviews never overwrite entries; they sit alongside them.

---

## 6. Classification rubric (put this verbatim in the system prompt)

**Mode A signals:**
- `FIT_STANDARD`: evidence says SAP standard, best-practice scope item or "no change", with no configuration or development specific to this step.
- `FIT_CONFIG`: evidence names configuration (document types, pricing procedures, output determination, customizing tables) with no custom code.
- `GAP_DEVELOPMENT`: evidence names an enhancement, custom report, form, interface build, BAdI or user exit, a CRC/TUT artefact, or a ticket described as development.
- `UNKNOWN`: no chunk addresses the step, or the evidence conflicts and neither side dominates.

**Confidence (compute, don't vibe):**
- Start at 0.5 when there is one independent supporting source.
- Add 0.15 per additional independent document agreeing (different file, not a copy), up to 0.9.
- Subtract 0.2 if any evidence marked `against` exists.
- Subtract 0.1 if the step code never appears verbatim, so the match was by name only.
- Cap at 0.4 when the only evidence is a transcript or a meeting note (it records discussion, not the implemented state).

**Materiality:** high = touches pricing, credit, billing, tax/legal output or an external interface; medium = changes a user-facing document or form; low = otherwise.

**Hard rules:**
- Never cite a chunk you didn't retrieve in this run.
- Never output a ticket, BPML code or system name that isn't returned by a tool.
- Prefer `UNKNOWN` over a low-evidence guess.
- The rationale states evidence, not opinion.
- Do not recommend what Solvay should decide; frame it as a DecisionPoint.

---

## 7. Synthesis outputs (the reduce pass)

From all entries in a run, produce:

1. **Reuse assessment**: counts and percentages per class, per L2 or L3 process, with the confidence distribution. This turns "~80% reuse" from a hope into a number.
2. **Draft gap register**: all non-FIT and non-REUSE entries, sorted by materiality then confidence.
3. **Decision pack**: deduplicated DecisionPoints, grouped by process, each linked back to its entries.
4. **Integration impact list**: grouped by system, with the steps affected.
5. **Workshop agenda**: sessions ordered by decision weight (sum of materiality × (1 − confidence) over their entries), 60–90-minute blocks, with pre-read evidence links.

Export as Markdown and XLSX (one sheet per output) and as JSON.

---

## 8. Evaluation harness (`fitgap/eval/`)

Run with `python -m fitgap.eval --suite all --scope L2C`. Write `reports/eval_<date>.md` plus a machine-readable `.json`, so results can be tracked across runs.

### E1: RAG retrieval quality
- **Golden set, generated then checked by a person:** for every BPML code and SPARK ticket that appears in the corpus, auto-generate "Which document describes `<code>`?" with the gold chunk IDs being the chunks containing the code. Add 25 hand-written questions from the process lead (paraphrased, no codes).
- **Metrics:** recall@5, recall@8, MRR, exact-code hit rate.
- **Ablation:** vector only vs BM25 only vs fused. This tells you whether RRF is earning its keep.
- **Failure list:** questions with no gold chunk in the top 8, with the chunks returned instead.

### E2: Graph quality
- **Coverage:** % of BPML codes in the BPML sheet present as graph nodes; % of SPARK tickets in the corpus present as nodes; % of ticket nodes linked to at least one BPML node.
- **Structure:** orphan rate, degree distribution, top-20 hub nodes (hubs that are artefacts of regex over-matching are a finding).
- **Precision sample:** 40 random edges exported to CSV with their source line, for human marking as correct or incorrect.
- **Path Q&A:** 15 curated "how does X connect to Y" questions with expected paths; exact match and partial overlap.

### E3: InsightLens Mode A against the wave-1 ground truth
- **Ground truth:** parse the three fit registers into `{bpml_code or item → FIT|GAP}`. Map predictions: FIT = `FIT_STANDARD | FIT_CONFIG`, GAP = `GAP_DEVELOPMENT`. Report `UNKNOWN` separately; never count it as correct.
- **Metrics:** accuracy, per-class precision, recall and F1, confusion matrix, coverage (non-UNKNOWN rate), and calibration (reliability table of confidence bins against observed accuracy).
- **Evidence validity (automatic, must be 100%):** every quote is a verbatim substring of its chunk, every chunk ID exists, every ticket and BPML code exists.
- **Citation faithfulness:** an LLM judge checks whether each quote supports the rationale; a human checks 20 of those judgements.

### E3 leakage control: essential
The corpus contains the answer key. In holdout mode, all of the following apply:
- Exclude the fit-register files from `search_corpus` (doc exclude globs).
- Strip `FIT`, `GAP`, `Fits`, `GAPs - Development` and `FITs - Config` path tokens from doc names and heading paths shown to the agent. Store the originals for later scoring.
- Disable graph edges derived purely from folder names, if `knowledge_graph.py` creates any. Check this first.

Report scores **with and without** holdout. A large gap between the two means InsightLens was reading labels, not reasoning.

### E4: human review sheet
Export 30 entries, stratified by class and confidence, to XLSX with columns for the reviewer's verdict and comment. Load reviewed sheets back into `fitgap_reviews` and report agreement. This is the only evaluation for Mode B until a second country exists.

### Suggested bars for the pilot readout (agree them with the Spark PMO before quoting them)
- Evidence validity: 100%.
- Mode A accuracy on non-UNKNOWN entries: ≥ 80%.
- Coverage: ≥ 70%.
- Retrieval recall@8 on code questions: ≥ 90%.
- Human agreement on the review sheet: ≥ 75%.

---

## 9. API and UI

- `POST /api/fitgap/run` with body `{mode, scope_bpml, country_profile?, asis_dir?, holdout, max_steps}`. Streams SSE progress events: `scope`, `step_start`, `tool_call`, `entry`, `verify_fail`, `synthesis`, `done`.
- `GET /api/fitgap/runs/{id}`, `GET /api/fitgap/runs/{id}/export?format=xlsx|md|json`.
- `POST /api/fitgap/entries/{id}/review` with body `{reviewer, verdict, corrected_classification?, comment}`.
- **New "Fit-Gap" page in the React app:**
  - scope picker (BPML tree);
  - run button with live progress;
  - register table with filters (class, confidence, materiality, process);
  - evidence drawer showing the quotes, each opening its chunk;
  - a "show in graph" link that reuses the Graph page and highlights the entry's ticket and system node IDs;
  - accept / reject / refine buttons.
- **Eval page (simple):** latest report, rendered.

---

## 10. Guardrails and operations

- **Model:** read from env (`FITGAP_MODEL`, default the same Claude model `rag.py` uses). Set temperature 0 for classification.
- **Data:** only chunk excerpts go to Claude; embeddings stay on Ollama. Log every outbound payload size per run.
- **Cost:** a per-run token and cost cap, with steps queued; print an estimate before a full-scope run.
- **Reproducibility:** store the prompt version hash, model id, retrieval params and corpus fingerprint (the hash of all chunk SHA-256s) on each run.
- **Idempotency:** re-running a scope creates a new run; nothing is overwritten.
- **Tests:** unit tests for the verifier, rubric math, BPML parsing and leakage masking; one end-to-end test on a 3-step scope with a fixed fixture corpus.

---

## 11. Milestones and acceptance

| # | Deliverable | Accept when |
|---|---|---|
| M0 | Repo read-through note: actual function names and signatures in `rag.py` and `knowledge_graph.py`, graph node and edge types, BPML sheet location and columns, fit-register columns | A short `backend/agents/fitgap/NOTES.md` exists and is confirmed with the user |
| M1 | `bpml.py`, `schemas.py`, `tools.py` (retrieval-only refactor of `rag.py` with no behaviour change to `/api/ask`) | Existing Ask and Graph flows still work; tool unit tests pass |
| M2 | Mode A agent + verifier on a 10-step L2C subtree | 100% evidence validity; entries viewable as JSON |
| M3 | Evaluation harness E1–E3 with holdout | `reports/eval_*.md` produced with both holdout and non-holdout numbers |
| M4 | Synthesis outputs + XLSX export + API | All five outputs generated for full L2C scope |
| M5 | Fit-Gap UI page + review loop + E4 | A reviewer can accept or reject in the UI; reviews reported in eval |
| M6 | Mode B with country profile YAML | A run on a sample profile produces a Mode B register with decision points |

---

## 12. Kickoff prompt (paste into the new session)

```
You are joining an existing repository called Solvay Spark Spine AI (FastAPI + React) that
indexes a Markdown corpus of Solvay SPARK S/4HANA Lead-to-Cash documents. Read
docs/insightlens-handover.md in full before doing anything else. It is the
specification for what you will build: the InsightLens agent and an evaluation
harness, in a new package fitgap/, reusing rag.py and knowledge_graph.py without
merging them.

Ground rules:
- Do not rewrite or change the behaviour of existing endpoints (/api/ask,
  /api/graph/query, upload/convert/embed). Refactor only to expose retrieval without
  answer generation, and prove the Ask flow is unchanged.
- Embeddings stay on local Ollama; only top-k chunk excerpts may be sent to Claude.
- AI proposes, humans decide: every entry is status "proposed"; never invent BPML
  codes, SPARK tickets, systems or quotes; prefer UNKNOWN over weak guesses.
- Evaluation must run in holdout mode that hides the fit registers and FIT/GAP folder
  tokens from the agent, and must report scores with and without holdout.

Work in milestones M0 to M6 from section 11. Start with M0 only:
1. Map the repo: list the public functions in rag.py, md_chunker.py and
   knowledge_graph.py with signatures; the Postgres schema of rag_documents and
   rag_chunks; the node and edge types in knowledge_graph.json with counts; and
   whether any graph edges are derived from folder or file names.
2. Locate BPML_ProcessesHierarchyExtended (xlsx or its .md conversion) and the three
   fit registers; show their columns and 5 sample rows each, and how FIT/GAP is encoded.
3. Write backend/agents/fitgap/NOTES.md with these findings, any mismatch with the handover spec,
   and a proposed 10-step L2C subtree for M2 (steps that have both FIT and GAP labels
   in the registers).
Then stop and show me NOTES.md. Do not start M1 until I confirm.

After each milestone: run the tests, summarise what changed in under 200 words, list
open questions, and wait for my go-ahead.
```

---

## 13. Open questions for the product owner (answer before M3)

1. **Scoring unit:** do the fit registers key on BPML codes, ticket IDs or free-text item names? This decides how E3 joins predictions to ground truth.
2. **Excluded material:** should workshop transcripts (32) be in the RAG index for InsightLens, or only in the Decision Registry later? They raise recall but carry personal data (see the Step 0 data-handling item).
3. **Mode B target:** which pilot country will provide the first country profile, and who fills it in?
4. **Named reviewers:** who are the 2–3 process leads for the E4 review sheet, and by what date?
5. **The RAG answer model:** is `claude-opus-5` also approved for InsightLens's volume of calls, or should classification use a cheaper model, with opus reserved for synthesis?
