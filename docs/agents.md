# The agents

The Fit-Gap Copilot, the Evidence Agent and InsightLens, the documents they can be given, and the guardrails they share. Scoring and tracing are in [tracing-and-evaluation.md](tracing-and-evaluation.md).

## The Fit-Gap Copilot

A second agent, on its own tab, does SAP Activate **Fit-to-Standard analysis
for a country rollout**. An analyst attaches the country's As-Is process
documentation — an SOP, a work instruction, a workshop transcript — and the
agent compares it against the Global Template in the corpus and, where a source
for it is attached, against SAP Best Practice.

Attachments carry a **role**: `Country As-Is`, `Global Template`, `SAP Best
Practice`, `Localization source` or `Reference`. That is what makes it a
three-way comparison rather than a two-document diff — without the role the
agent cannot tell a country SOP from a template extract. Roles are metadata, so
re-tagging a document costs nothing.

### What the run analyses

A run reads one document set as its **subject** and compares it against the
Global Template. There are two:

| Subject | Requires | Asks |
|---|---|---|
| `Country As-Is` (default) | a `Country As-Is` document | How far is the country's current process from the template? |
| `SAP Best Practice` | a `SAP Best Practice` document | How far has the template drifted from SAP's delivered standard? |

The second exists because "our template has diverged from SAP standard" is a
real finding with an owner — §19 of the specification maps it to *template
improvement / design review* — and it was previously only reachable by tagging
a Best Practice document `Country As-Is`, which made the agent report SAP's
process as a country's own.

Two things follow from the subject rather than from anything the agent
decides, so they are enforced rather than left to the prompt:

* **Localization does not apply** to a Best Practice run. There is no country
  in it, so a statutory-localization claim would be a legal assertion about
  nobody. Any the model produces are reset to *Not localization-related* and
  the localization register is dropped, with both reported as quality-gate
  findings.
* **Score B is not reported.** It rates the subject against SAP Best Practice,
  and here the Best Practice content *is* the subject. Score C
  (localization-adjusted) is `null` rather than equal to Score A — a number
  that happens to match reads as a second measurement agreeing with the first.

Each subject has its own prompt hash, because a run recorded against a hash
that does not describe its instructions cannot be reproduced from the record.

Naming the Global Template process is **optional**. Give it a BPML code and
the comparison is anchored there; leave it empty and the agent works out which
template process corresponds to the As-Is and records what it settled on. A
code that is typed but does not resolve is still an error — a typo must not
quietly become "no scope", or the run analyses against a different process
than the one that was asked for. A run that names none and identifies none is
reported as having no stated baseline, so the scores are never shown as if the
question had not arisen.

It runs in two passes, because §21 of the specification puts "understand the
As-Is before comparing it" first: a model given the comparison tools while it
is still reading starts diffing paragraphs.

1. **Read** — only the attachments are visible. The agent produces a normalised
   process model: atomic steps with trigger, actor, action, system, business
   rule, decision, control, output, exception and integration, plus what it
   normalised and what the documents never said.
2. **Compare** — the As-Is model is handed back as text, now with the corpus,
   the knowledge graph and the BPML hierarchy. Out comes a deviation register
   on the 16-code taxonomy, a localization advisory, dimension ratings, a
   workshop agenda and backlog candidates.

**The scores are computed, not generated.** The agent rates seven dimensions
0–4 and gives each deviation a harmonization potential; `backend/agents/rollout/scoring.py`
does the arithmetic. A score a model writes can be argued into a better number;
a score derived from a rated register cannot move without changing a finding a
reviewer can see. The localization-adjusted score publishes its own formula,
and only a *confirmed* statutory or SAP-delivered localization lifts it — a
suspicion does not, because that is the assumption the guardrails forbid.

**Quality gates** (`backend/agents/rollout/gates.py`) run before anything is shown, and they
repair rather than merely report:

| Gate | What it enforces |
|---|---|
| QG1 | Every As-Is step is mapped, or named as unmapped |
| QG2 | Every quote is verbatim, in a chunk this run actually retrieved |
| QG4 | "Confirmed statutory" without an explicit source is demoted to "suspected" |
| QG5 | An extension proposed without recording the standard options considered becomes a decision; an SAP Best Practice rating with no SAP source is removed |
| QG6 | A Must Discuss item without a decision question is flagged |
| QG7 | A backlog candidate that names no gap is dropped; a run that named no template process must say which one it used |

QG3 (semantic accuracy) is deliberately absent and says so: whether the agent
compared meaning rather than wording is a human judgement, and a gate that
always passes would only make the report look better than it is.

One invariant is enforced at submission rather than afterwards: a dimension
rated 2 or below ("moderate deviation" or worse) must name at least one
deviation on that dimension. Without it a run can produce a measured-looking
alignment score over a register saying the process matched — which is exactly
what the first real run did before the check existed.

```bash
.venv/bin/python backend/tests/test_rollout.py   # the scoring and the gates
```

Runs are kept beside the corpus in `DATABASE_URL`, and the workshop pack
exports as Markdown or JSON from the page.

## The Evidence Agent

One question, both engines, and an answer that is a set of claims rather than a
paragraph — each claim carrying the passages that support it and the arithmetic
behind its score. Every quote is checked character-for-character against the
chunk it names; one that is not found is discarded rather than shown.

**Investigations are kept.** Each run is written to `evidence_runs` as it
happens — the question and its settings, every tool call in order, and the
verified answer — so a past investigation can be reopened with its working
intact. Nothing is re-run and nothing is re-billed when you open one.

The history button in the header opens a panel on the right. Selecting a run
shows it *there*, beside whatever is on the page, rather than replacing it:
loading a run overwrites a dozen pieces of page state, so looking at an old one
used to cost you the one you were reading. "Load into page" still does that,
when it is what you want. The Fit-Gap Copilot and InsightLens have the same
panel, and Ask RAG's history is where its design came from.

Written *as it happens* rather than at the end, which is what makes an
interrupted run useful: close the tab mid-investigation and the row keeps the
calls it had made. Such a run reads `abandoned` after 30 minutes rather than
sitting at `running` for ever, and the row is not rewritten — it still records
that it was interrupted rather than finished. A failed run is kept too; what
the agent managed to read before it failed is usually the reason to look again.

```
GET    /api/evidence/runs          past investigations, newest first
GET    /api/evidence/runs/{id}     one in full: question, calls, answer
DELETE /api/evidence/runs/{id}     remove one
```

If the history cannot be written — no database, no table — the investigation
still runs and still answers; the page says it is not being recorded rather
than refusing the question.

## Documents attached to an agent session

InsightLens and the Fit-Gap Copilot both take uploads of their own — a
draft specification, a set of minutes, a country's As-Is SOP — and read them
*beside* the corpus without them joining it. Drop a PDF, Word, Excel,
PowerPoint, HTML, XML, `.csv` or plain `.txt` file into either page and it is
converted, chunked, embedded and given a knowledge graph of its own.

`.txt` takes a path of its own rather than going through Docling. Docling
accepts a text file but parses it *as Markdown*, which rewrites the characters
in it: `->` becomes `-&gt;`, `5_000` becomes `5\_000`, and a line of `=====`
promotes the line above it to a heading. The agents quote their evidence
verbatim and the verifier checks every quote character-for-character against
the chunk it came from, so an escaped copy turns a correctly quoted threshold
— "Above INR 5,00,000 -> credit committee" — into evidence that cannot be
verified and is dropped. A `.txt` file is already text, so it is passed
through with only a title added.

`.csv` does go through Docling, whose CSV backend reads it as a table rather
than as text — it sniffs the delimiter (comma, the semicolon a European Excel
writes, or tab) and emits one Markdown table with the header intact, leaving
the cells verbatim. Two things are done around it. Docling requires UTF-8 and
refuses anything else outright, so a CSV exported from Excel on Windows —
cp1252, the common case — would simply fail to convert; the file is decoded
first (UTF-8, BOM, then cp1252) and handed to Docling as UTF-8. And the title
is added as a heading, so the rows are chunked under one like every other
source. The document's size is reported in rows.

It is kept out of the corpus in the strongest way the storage allows:

* a database of its own, `docling_session`, beside the corpus database;
* one Postgres **schema** per session inside it, `u_<id>`, holding the same
  `rag_documents` / `rag_chunks` tables the corpus uses;
* `UPLOAD` is a reserved code, so nothing can be filed under the category the
  chunks carry either.

The isolation is the database boundary, not a filter: a corpus search runs
against the corpus database and these rows are not in it, so there is no `WHERE`
clause that could be got wrong. This is the one thing the consolidation did not
touch, and deliberately so.

A schema rather than a database per session because the isolation is the same
and the cost is not: a session holds tens of chunks, and `CREATE DATABASE` plus
an extension and an index for each buys nothing. `SET search_path` is what makes
it work — the tables resolve inside the session's schema, so `rag.index_file`
and `rag.search` run against it unchanged, with no second copy of the chunking,
embedding or retrieval code to keep in step.

An agent reaches an attachment through tools of its own, never through
`search_corpus`: `search_uploads` (`read_sources` in the Fit-Gap Copilot, which
filters by role) for its text, and `upload_entities` for the
systems, BPML codes and tickets it mentions, each marked according to whether
the corpus already knows it. That marking is the point — a shared entity tells
the agent exactly what to search the corpus for, and one only the attachment
has is worth reporting as new. InsightLens is told to report a disagreement
between an attachment and the corpus rather than pick a winner.

Everything expires. A session unused for `FITGAP_UPLOAD_TTL_HOURS` (12) is
swept: the schema is dropped, the rows go with it, and the extracted Markdown
is deleted. The sweep also drops any schema left behind by a crash between the
two statements. The run record keeps the document names, because by the time a
register is reopened the attachment itself is long gone.

```bash
# Optional overrides (defaults shown):
FITGAP_UPLOAD_TTL_HOURS=12     # how long an unused attachment is kept
FITGAP_UPLOAD_MAX_FILES=12     # documents per session
# The session store is docling_session, derived from DATABASE_URL; it is the
# only database beside the corpus one.
```

## Agent guardrails

The Evidence Agent, InsightLens, the Fit-Gap Copilot and Ask RAG share these
guardrails (`guardrails/`). Each is enforced in code; the same rules are also written into
every agent's prompt, as a second line rather than the mechanism.

**Scope.** The agents answer questions about this programme -- its processes,
SAP, the systems, specifications and rollouts in the corpus -- and nothing a
general chatbot would answer. What a person types (the Evidence Agent's
question, the optional note on an InsightLens or Fit-Gap Copilot run) is
checked before any agent starts. A BPML code, a ticket, a known system or a
domain term passes at once; anything else goes to a small, fast model
(`claude-haiku-4-5`) that answers only "in or out". Out of scope, the answer is
**"I don't have the information."** and nothing else runs -- in Ask RAG nothing
is searched and the answer is recorded as not scored, rather than sending nine
judges to grade a refusal. If that model cannot
be reached the question goes through and the log says so -- an outage of the
filter must not become an outage of every agent.

**Web search, gated.** The agents may ask for `web_search`; the code decides.
It runs only after the corpus has been searched in that run, at most twice per
run, on an allow-list of sites (SAP's and the EU's by default), for a query
that is itself about the programme's subject and contains no ticket numbers,
BPML codes or contact details. Only the cited passages come back, under `WEB:`
chunk ids, so a web quote is verified like any other and one the model
paraphrased is dropped. A claim resting on web pages alone is capped at 0.35 --
a web page says what SAP does in general, not what this programme decided.
The log shows web calls in amber, as `WEB`. Ask RAG has no tools and stays
corpus-only: it answers from the excerpts it retrieved and nothing else.

**No contact details.** E-mail addresses and phone numbers are removed from
everything the agents return: after quote verification inside the agent, and
again on every response under `/api/evidence`, `/api/fitgap`, `/api/rollout`,
`/api/ask` and `/api/quality`, so runs recorded before the rule existed are clean when
reopened or exported. Measured on the corpus: 116 e-mail addresses and 21
phone numbers are removed, and none of the order numbers, BPML codes, dates or
amounts that looser rules mistook for phone numbers. Ask RAG's answer streams
token by token, so it is held back to the end of each line or sentence and
redacted there -- an address split across two tokens is still caught.

```bash
# Optional overrides (defaults shown):
AGENT_SCOPE_GUARD=on
AGENT_SCOPE_MODEL=claude-haiku-4-5-20251001
AGENT_WEB_SEARCH=on
AGENT_WEB_DOMAINS=sap.com,europa.eu     # subdomains included; add a tax authority per country
AGENT_WEB_MAX_SEARCHES=2                # per run
AGENT_WEB_MODEL=claude-sonnet-5
```

```bash
.venv/bin/python backend/tests/test_guardrails.py
```
