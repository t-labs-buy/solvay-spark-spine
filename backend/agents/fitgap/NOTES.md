# InsightLens — repo read-through (M0)

What the handover assumes, against what is actually in this repository. Written
before `fitgap/` was built, corrected against the running system afterwards.
Every number here was measured, not quoted from the README.

Date: 21 September 2026 · corpus fingerprint `86156d230c23199a` (83 documents,
4,257 chunks, all 1024-d `bge-m3`).

---

## 1. What InsightLens calls

### `rag.py`

No retrieval-only refactor was needed — `search()` has always returned hits
without generating an answer, and `ask_events()` is a separate layer on top.
`backend/agents/fitgap/tools.py` wraps it as-is, so `/api/ask` is untouched.

| Function | Signature | Used by InsightLens |
|---|---|---|
| `search` | `(question, k=8, conn=None, mode="hybrid", query_vector=None) -> list[Hit]` | `search_corpus` |
| `connect` | `() -> Connection` | every tool session |
| `embed` | `(texts, input_type="") -> list[ndarray]` | indirectly, via `search` |
| `index_file` | `(conn, path, force=False, on_embed=None) -> dict` | no |
| `ask_events` | `(question, k=8, mode="hybrid")` | **no — deliberately.** InsightLens must not get a pre-written answer |

`Hit` carries `chunk_id, title, source, heading_path, content, score,
vector_rank, keyword_rank, similarity, bm25`.

Retrieval constants: `DEFAULT_K=8`, `CANDIDATES=40`, `RRF_K=60`. BM25 is
hand-written SQL over `tsvector`; `keyword_text()` rewrites dash codes
(`M-090-030`) so Postgres does not split them at the hyphens. **Dotted BPML
codes (`4.5.1.3`) are indexed verbatim and BM25 matches them**, which is why
§4.2's "always include the exact code in one query" works here.

### `knowledge_graph.py`

| Function | Signature |
|---|---|
| `extract_graph` | `(force=False) -> {nodes, edges, stats}` — reads `knowledge_graph.json` unless forced |
| `find_shortest_path` | `(graph_data, start_id, end_id) -> {nodes, edges, hops} \| None` |
| `query_graph` | `(query="", source_id=None, target_id=None) -> dict` — used by `/api/graph/query`, **not** by InsightLens |

Graph contents: **354 nodes, 560 edges** (was 720/842 before the process
register's Lowest Level Key column stopped being read as spec nodes).

| Node type | Count | Id form |
|---|---|---|
| spec (SPARK ticket) | 548 | `spec:SPARK-24936` |
| document | 83 | `doc:<filename>.md` |
| process | 79 | `proc:O-050-030` |
| system | 6 | `system:S4HANA` |
| stream | 4 | `stream:L2C` |

| Relation | Count |
|---|---|
| `references_ticket` | 548 |
| `specifies_process` | 71 |
| `subprocess_of` | 61 |
| `belongs_to` (stream) | 46 |
| `runs_on` (S/4HANA) | 43 |
| `interacts_with` (ECC) | 28 |
| `uses_ui` (Fiori) | 28 |
| `connects_to` (eCommerce) | 6 |
| `implements_ticket` | 6 |
| `integrates_with` (Salesforce) | 4 |
| `interfaces_with` (SOVOS) | 1 |

---

## 2. Five places the repo does not match the handover

These are the findings that changed the build. Each was checked against the
data, not inferred.

### 2.1 The graph holds no dotted BPML codes — at all

§2 describes "BPML process codes — patterns like `O-020-090`", and §4.2 says to
"resolve the BPML code" in the graph first. Those are two different code
systems. `CODE_RE` is `[A-Za-z][A-Za-z0-9]{0,3}-\d{2,3}(-\d{2,3})+`, which
matches the Celonis-style dash codes and **cannot** match `4.5.1.3`. Measured:
**0 of 79 process nodes** is a dotted code.

So the §4.2 order does not survive first contact. `graph_entity` now detects a
dotted code and returns an explicit note telling the agent to resolve the step
by name, by a SPARK ticket or by a system instead, rather than handing back a
plausible-looking wrong node. The prompt says the same thing, so the agent does
not spend a call discovering it.

**Consequence for E2 coverage:** "% of BPML codes present as graph nodes" is 0%
by construction, and would be a misleading metric until the graph learns the
dotted hierarchy. The useful version is "% of BPML codes present in the
*corpus*", which retrieval can act on.

### 2.2 The BPML sheet is not usable through the corpus

`BPML_ProcessesHierarchyExtended.xlsx` converts to a **7-line Markdown stub**:

```
_9096 rows x 50 columns; too wide to render as a table._
```

The hierarchy is in the index as a heading and nothing else. `backend/agents/fitgap/bpml.py`
therefore read the `.xlsx` directly with openpyxl.

**Update:** it no longer does. The hierarchy now comes from the corpus: Signavio's
`BPML_Process.xlsx` export (the same 1,015 codes; `8.6.3` is only named in its
sub-processes' Root Paths) is written by `backend/ingestion/bpml_markdown.py` as
`knowledge_base/BPML_Process_xlsx.md`, one section per process, and `bpml.py`
joins that document's indexed chunks back together and parses them. Rebuild and
re-index it with `python -m backend.ingestion.bpml_markdown --index`. The
knowledge graph reads its hierarchy from the same document
(`bpml_markdown.hierarchy()`), and `BPML_ProcessesHierarchyExtended.xlsx` has
been removed. That workbook placed each lettered BPMN code inside one process;
the export only lists them as activities, often of several processes, so
~490 of those codes now sit under a different parent than they did.

Parsed: **1,015 processes** — 8 at level 1, 44 at level 2, 217 at level 3, 617
at level 4, 129 at level 5. Lead-to-Cash is **`4.0`**, with ten level-2
children (`4.1`–`4.10`).

Two quirks worth knowing:
- A level-1 process is written `4.0`, and its children drop the zero (`4.5`).
  `level_of()` special-cases this; naive segment counting puts `4.0` at level 2.
- The sheet contains a duplicate `2.0` ("Acquire to Dispose" and, later, "A2D").
  The first wins; later duplicates are dropped.

**`steps_in_scope()` falls back per branch, not per scope.** §4 says "level 4,
or level 3 if level 4 is missing". Some level-3 processes under `4.5` detail
down to level 4 and others stop at level 3; applying the fallback to the whole
scope would silently drop the latter from the register.

### 2.3 The wave-1 fit registers are not in this repository

§2 names `L2C - Fits.xlsx`, `Reports listed as FITs and GAPs L2C.xlsx` and
`L2C FITs with missing description.xlsx` as the ground truth, and §8.3 names
`2. FITs - Config/` and `3. GAPs - Development/` as the leakage risk. **None of
the three files exists here, and neither folder exists.** `solvay-spark/pkg/`
holds 84 source documents and no register.

So **E3 cannot be scored in this repository** — there is nothing to score
against. The holdout machinery is built and unit-tested anyway, because it
costs little and the registers will arrive:

- `HOLDOUT_DOC_GLOBS` excludes the three register names when they appear.
- `HOLDOUT_PATH_GLOBS` excludes the two folder conventions.
- `mask_label()` blanks `FIT`/`GAP`/`Fits`/`GAPs` tokens in document names and
  heading paths, and the originals are kept for scoring.

The masking is not theoretical even today: `SPARK_Interface__L2C_18542_Determine
Order Type - **FIT**.docx` is in the corpus, it is the top hit for step
`4.5.1.3`, and without masking the agent reads the verdict off the title.

### 2.4 Only six graph edges are folder-derived, but the stream edges are

§8.3 asks to "disable graph edges derived purely from folder names, **check
this first**". Checked:

- `implements_ticket` (6 edges) is filename-derived — a ticket in the filename
  marks that document as the ticket's primary spec.
- `belongs_to` (46 edges) is **partly** filename-derived: a stream is attached
  when its code appears in the filename *or* in the first 600 characters.
- Everything else is content-derived.

None of them encodes FIT/GAP, so nothing has to be disabled for holdout today.
If the `2. FITs - Config/` folders are ever ingested, `belongs_to` and the
`source` property become leaks and this needs revisiting.

### 2.5 The graph misses tickets spelled without `SPARK`

`TICKET_RE` is `SPARK[-_ ]?\d{4,6}`. Six documents name their ticket as
`L2C_21999`, `L2C-21208`, `L2C_18542`, `L2C_21930`, `L2C-21265`, `L2C-21266` —
the `SPARK` prefix is separated from the number by other words. Those tickets
are **absent from the graph**.

This is why the verifier treats "ticket not in graph" as a **soft** issue. A
hard failure would discard correct tickets the agent read verbatim out of a
document, punishing it for a gap in the extractor.

---

## 3. Two things the handover asks for that the platform no longer offers

- **`temperature=0` (§10).** The Anthropic SDK in this venv (1.6.0) does not
  accept a `temperature` argument for this model family — `Messages.create()`
  raises `TypeError`. Determinism instead rests on the rubric being arithmetic
  and on `verifier.expected_confidence()` recomputing every score from the
  evidence and flagging drift over 0.2.
- **The 40k input-token budget (§4.1)**, read literally as billed tokens summed
  over turns, stops a step after roughly its third search: each turn re-sends
  the prefix. It is applied to the **context of a single turn** instead, with a
  4× cumulative ceiling to catch a loop. Prompt caching is on, which meant the
  first implementation budgeted against `usage.input_tokens` — a number that
  counts only cache *misses* and reads ~32 for a whole run. `_input_tokens()`
  adds the cached prefix back.

---

## 4. Proposed 10-step L2C subtree for M2

§11 asks for steps "that have both FIT and GAP labels in the registers". Without
the registers (2.3) that cannot be honoured, so these were picked on the next
best signal: steps whose subject appears in a SPARK functional spec that is
actually in the corpus, spread across configuration, forms, interfaces and
enhancements so every rubric branch gets exercised.

| BPML | Step | Why it is in the set |
|---|---|---|
| `4.5.1.3` | Determine Order Type | SPARK-18542 spec present; the "- FIT" filename makes it the holdout canary |
| `4.5.1.4` | Create Standard Order | order type / item category configuration |
| `4.5.1.2` | Analyze PO Details | order intake via Esker / eCommerce |
| `4.5.1.1` | Receive Customer PO | thin evidence — should come back UNKNOWN, and does |
| `4.7.1.1` | Create Invoice | SPARK-21175 billing document form |
| `4.7.1.2` | Sales orders ready to be invoiced | billing split, SPARK-49618 |
| `4.3.1.1` | Set customer credit limit | credit management, high materiality |
| `4.8.1.1` | Process customer payment | SPARK-21256 customer statement |
| `4.9.2.1` | Track payment due dates | SPARK-21265 dunning form |
| `4.10.1.1` | Register customer complaint | SPARK-22877 Salesforce interface |

Verify each code against the sheet before running — level-4 numbering under
`4.7`–`4.10` was not exhaustively checked.

---

## 5. Measured behaviour of the first runs

A three-step run over `4.5.1` (`fg_5eb11cfaf8`, concurrency 3):

- 155 s wall clock, 3 entries, 0 failures.
- **Evidence validity 100%** — 19 quotes, every one found verbatim in the chunk
  it named, 0 discarded, 0 entries repaired.
- `4.5.1.3` → FIT_CONFIG 0.50, `4.5.1.2` → FIT_CONFIG 0.60, `4.5.1.1` →
  **UNKNOWN**, which is the right answer: nothing in the corpus describes how a
  customer PO is received, and the rubric prefers UNKNOWN to a guess.
- Coverage 66.7%, reuse 100% of classified steps — on two steps, so the number
  means very little yet. It is reported with its denominator for that reason.

The three soft issues raised were all `ticket_not_in_graph`, i.e. finding 2.5.

---

## 6. Open questions (§13) that this read-through can now answer

1. **Scoring unit.** Unanswerable until the registers arrive. InsightLens keys
   everything on the dotted BPML code, which is the only identifier shared by
   the sheet and the corpus text.
2. **Transcripts in the index.** They are already indexed. The rubric caps
   confidence at 0.4 when a transcript is the only source, so they raise recall
   without being able to carry a high-confidence entry on their own.
5. **Model.** `FITGAP_MODEL` falls back to `RAG_ANSWER_MODEL`, so classification
   can be pointed at a cheaper model without touching `/api/ask`. A step costs
   roughly 25k–85k input tokens and 5–9 tool calls; prompt caching is on.

Questions 3 and 4 (pilot country, named reviewers) are for the product owner.
