# Tracing and evaluation

Langfuse tracing for every model-calling path, the agents' quality scores, and the Ragas judges that score Ask RAG answers. The weights and reasoning behind the answer score are in [rag-evaluation.md](rag-evaluation.md).

## Tracing the agents (Langfuse)

Off unless configured. The four things that call a model -- the Fit-Gap Copilot,
InsightLens, the Evidence Agent and `/ask` -- each record one
[Langfuse](https://langfuse.com) trace per run: the retrieval it did, every
tool call with what it returned, every model turn with its prompt and token
usage, and the run's result. Without `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` nothing is sent, nothing is imported beyond
`tracing.py`, and the engines behave exactly as they do now.

Add to `.env`:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or eu/us/self-hosted
# Optional:
LANGFUSE_TRACING_ENVIRONMENT=development       # default; tags every trace
LANGFUSE_RELEASE=                              # a version string, if you keep one
```

Keys come from the Langfuse project under Settings -> API Keys. `./scripts/run.sh`
prints one line at start-up saying whether tracing is on, and says so plainly
if the credentials are refused -- a wrong key is a line in the log rather than
a run that quietly produces nothing.

What a trace looks like, using a Rollout run as the example:

```
rollout-analysis                     agent      the whole run
  read-as-is                         agent      pass one
    anthropic.chat                   generation one model turn (prompt, tokens, cost)
    read_sources                     retriever  what it read, and what came back
    ...
  compare-to-template                agent      pass two
    search_corpus                    retriever
    get_scope                        retriever
    ...
  quality-gates                      evaluator  what the gates rejected or repaired
```

Two things worth knowing:

- **The session is the upload session.** Attaching documents and then running
  the Fit-Gap Copilot and InsightLens over them gives three traces in one
  Langfuse session, which is how they read as one piece of work. There is no
  `user_id`: this application has no accounts.
- **What is masked.** API keys, database passwords, JWTs and email addresses
  are redacted on the way out. Document text is not -- it is the reason the
  trace is worth keeping. Point this at a Langfuse project you would be
  willing to show the corpus to.

### Agent quality scores

Every Evidence Agent and Fit-Gap Copilot run also writes a set of scores onto
its trace (`agent_eval.py`). They are counted from what the run already
checked -- quote verification, the quality gates, the claim lineage, the
guardrails -- so they cost no model call and need no labelled data:

| Metric | Scores |
|---|---|
| Groundedness | `citation_validity`, `claims_unsupported` |
| Tool use | `tool_error_rate`, `redundant_tool_calls`, `required_tools_met`, `submitted_first_try`, `budget_exhausted`, `tool_calls` |
| Task | `task_completed`; Fit-Gap Copilot also `gate_hard_issues`, `gate_soft_issues` |
| Topic adherence | `topic_adherence` (Fit-Gap Copilot), `web_query_on_topic` |
| Guardrails | `scope_refused`, `scope_guard_fail_open`, `contact_in_output`, `contact_leak`, `web_gate_blocks`, `web_query_leak_attempts` |

The names are the same for both agents; filter on the trace tag
(`evidence-agent`, `rollout-agent`) to separate them. Goal accuracy against a
reference answer and whether a quote really supports its claim need a dataset
or a judge, and are not scored yet.

```bash
python -m backend.agents.agent_eval configs           # declare the score names in Langfuse, once
.venv/bin/python backend/tests/test_agent_eval.py
```

## Scoring the answers (Ragas)

Every Ask RAG answer is judged automatically. Twelve judges run against the
excerpts the answer was written from -- faithfulness, answer relevancy, the
three context metrics, coherence, conciseness and a safety pair -- and the
verdict is stored beside the question, pushed into Langfuse as scores, and
drawn on the Ask page as a scorecard between the answer and the sources.

Judging happens on a background thread after the answer has streamed, so it
never delays a reader: the panel opens as "Scoring..." and fills in about
thirty seconds later. Closing the tab in between costs nothing -- the result is
written either way and is there when the question is reopened.

```bash
python -m backend.rag.evaluation status      # what scoring is configured to do
python -m backend.rag.evaluation selftest    # score one good and one bad answer, print the gap
python -m backend.rag.evaluation configs     # declare the score names and ranges in Langfuse
python -m backend.rag.evaluation dashboard   # upload the quality dashboard
```

Off with `RAG_EVAL=off`, and off by itself if Ragas is not installed or there is
no `ANTHROPIC_API_KEY` -- in which case the panel says which, rather than
showing an empty card. The judge defaults to `claude-sonnet-5` rather than the
answering model: grading an answer on Opus costs more than writing it did.

**Two of the metrics the usual RAG metric list includes are missing here, on
purpose.** Correctness and Context Recall both need a reference answer, and a
live question has none. They are measured instead over the 27 ground-truthed
questions in `docs/three-engine-eval-questions.md`:

```bash
python -m backend.rag.evaluation dataset                            # push them to Langfuse
python -m backend.rag.evaluation experiment --mode hybrid --k 8     # answer and score them
python -m backend.rag.evaluation experiment --mode vector --k 8     # then compare the runs
```

That is also the only honest way to compare two retrieval settings, since live
traffic asks different questions in each mode.

Clicking a metric opens the judge's own working beside the page: for
faithfulness, every claim the answer made with a verdict and a reason for each;
for the retrieval metrics, a verdict per excerpt named by its document. Ragas
discards all of that, so it is intercepted at the judge and kept — at no extra
model calls and no extra time.

The history drawer gains a score badge per row and four segments -- low
quality, unfaithful, unsafe, unscored -- so "show me the hallucinations" is one
click rather than a query. In Langfuse the same thing is a filter on the traces
table, because these are Langfuse *scores* and not trace metadata.

The **RAG Metrics** tab, beside Ask RAG, is laid out as an analytical list page:
a KPI strip against the 0.70 threshold, a filter bar, and six tabs. **Answers**
is a sortable table of every judged answer under small charts that act as
filters; **Metric matrix** shows every answer against every metric as a heatmap,
with a pane giving the judge's findings for the selected one; **Source
documents** flags documents retrieved often and rarely useful; **Failure
analysis** groups bad answers by cause and subject; **Experiments** compares two
runs over the evaluation set question by question; and **Judge calibration** is
where people review answers so the judge itself can be checked. Until twenty
answers have a reviewer's verdict, every tab says so.

`docs/rag-evaluation.md` has the weights behind the overall score and the
argument for them, the three Ragas/Anthropic incompatibilities this had to work
around, and what to fix before the evaluation set becomes a regression gate
rather than a diagnostic.
