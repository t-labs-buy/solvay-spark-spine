# Ask RAG: questions over the Markdown

How the **Ask** tab indexes the converted Markdown in pgvector and answers questions from it.

`rag.py` answers questions from the converted `.md` files: it splits them into
chunks, embeds each chunk locally using **BGE-M3** via [Ollama](https://ollama.com)
(`1024` dimensions), stores text and vectors in Postgres with
[pgvector](https://github.com/pgvector/pgvector) next to a full-text index, and
has Claude answer from the best chunks, citing them.

Make sure **Ollama** is running with `bge-m3` pulled:

```bash
ollama pull bge-m3
```

Needs a Postgres with the `vector` extension available (Homebrew's
`postgresql@18` ships it). Start it before running the app, or searches fail
to connect:

```bash
brew services start postgresql@18
```

Settings in `.env`:

```bash
DATABASE_URL=postgresql://user:password@localhost:5433/docling
ANTHROPIC_API_KEY=...     # for Claude answer synthesis
# Optional overrides (defaults shown):
OLLAMA_HOST=http://127.0.0.1:11434
RAG_EMBED_MODEL=bge-m3
RAG_EMBED_DIMENSION=1024
RAG_ANSWER_MODEL=claude-opus-5
RAG_HNSW_EF_SEARCH=200
```

## Using it

**In the browser:** `./scripts/run.sh`, then open <http://localhost:8000/ask> (or the
**Ask** tab in the header). Type a question and the page shows each step as it
runs: embedding the question with Ollama, vector search, keyword search, merging the
rankings (with timings and what each step found), then Claude's answer as it
is written, with citations that jump to their source. The **Sources** section
at the bottom lists the excerpts Claude received, with the matched words
highlighted and three scores for each: combined (the order used), semantic
similarity and keyword score; the buttons re-sort by any of them, highest first.

**Adding documents to the knowledge base:**
- **From the Convert page:** After converting, click **Add to knowledge base** to chunk and embed that Markdown into PostgreSQL `pgvector`.
- **From the Batch Convert page:** Click **Insert into Knowledge Base** to queue and embed all converted documents in one go with real-time SSE progress.
- Files are stored in `knowledge_base/<name>_<ext>.md`.

**From the command line:**

```bash
createdb docling                                           # once
.venv/bin/python -m backend.rag.rag index solvay-spark/pkg/markdown    # chunk + embed with bge-m3 + store
.venv/bin/python -m backend.rag.rag search "Who owns 7.1.12.3 Production Declaration?"
.venv/bin/python -m backend.rag.rag ask "Who owns 7.1.12.3 Production Declaration?"
.venv/bin/python -m backend.rag.rag categories                         # what each category holds
.venv/bin/python -m backend.rag.rag retag knowledge_base/x.md DR       # re-file, no re-embedding
.venv/bin/python -m backend.rag.rag chunks "solvay-spark/pkg/markdown/deck_pptx.md"  # preview chunking, no API calls
```

## Retrieval

**Retrieval is hybrid.** Each question is looked up two ways, and the two
rankings are merged with reciprocal rank fusion (each chunk scores
`1 / (60 + rank)` in each list):

| Search | Finds | Misses |
|---|---|---|
| Vector (pgvector, cosine) | Chunks with the same meaning in other words ("who is responsible" → `Role = Quality Planner`) | Exact identifiers: embeddings treat `7.1.12.3` as noise |
| Keyword (Postgres full text, BM25) | Chunks containing the question's words, rare words such as a code weighted highest | Paraphrases |

Codes like `M-090-030-010` are also indexed as one word with their parents
(`m090030`, `m090030010`), because Postgres would otherwise split them at the
hyphens and match every `M-090-…` step. `--mode vector` or `--mode keyword` on
`search`/`ask` uses one method alone.

On 14 questions with checked answers (5 naming a code, 9 in plain words):

| Mode | Right chunk in top 8 | Ranked first | MRR |
|---|---|---|---|
| vector | 13/14 | 10/14 | 0.78 |
| keyword | 14/14 | 10/14 | 0.84 |
| **hybrid** (default) | **14/14** | **11/14** | **0.88** |

Hybrid matched vector on the plain-word questions and fixed the code ones:
"Who owns 7.1.12.3 Production Declaration?" had the answering row at #8 with
vector search and #2 with hybrid. The set is small and written by us, so treat
it as a sanity check rather than a benchmark.

Re-running `index` embeds only files whose content changed, and drops files
that were deleted from the folder. `--force` re-embeds everything; `--rebuild`
drops the tables first (needed after changing `RAG_EMBED_DIMENSION`).

## Chunking

**Chunking** (`md_chunker.py`) follows the Markdown the converter writes rather
than cutting every N characters:

| Step | What happens |
|---|---|
| Parse | Headings, paragraphs, tables and ```` ```mermaid ```` blocks become units; the `<!-- OCR of ... -->` provenance comments are dropped |
| Sections | Each heading starts a chunk: one slide, one sheet, one numbered chapter. A section under ~120 tokens (a slide title, `Role = ...`) is joined to the one after it, so a title never sits apart from its content |
| Size | Chunks are filled to ~500 tokens, never above 1000, and don't end on a heading (except a closing "Thank you" slide) |
| Big tables | Cut between rows into even pieces, the header row repeated on every piece; empty spreadsheet columns (`col10`, …) removed |
| Big flowcharts / paragraphs | Cut between lines / sentences, flowcharts staying inside a mermaid fence |
| Context | The document title and heading path are put in front of each chunk before embedding, so a bare table row is still found by a question about its sheet |

On `solvay-spark/markdown` that gives 438 chunks (median ~200 tokens for slide
decks, ~450 for spreadsheets). Token counts are estimated as characters / 4.

| Setting | Default |
|---|---|
| `RAG_EMBED_MODEL` | `embed-v4.0` |
| `RAG_EMBED_DIMENSION` | `1536` (also 256, 512, 1024) |
| `RAG_ANSWER_MODEL` | `claude-opus-5` |

**Data leaves the machine:** chunk text is sent to Cohere when indexing, and the
question plus the retrieved chunks are sent to Anthropic when asking.

## Categories

Every document belongs to a category, and **a category is a column, not a
database**: one `rag_documents` / `rag_chunks` pair in `DATABASE_URL`, one row
per chunk, and scoping a search is a `WHERE` clause. The Fit/Gap and Rollout run
stores sit beside them in the same database.

Each category had a database of its own for one release. It was merged back
because `rag_documents.source` is declared `UNIQUE` and could only be unique
*per* database, so the same file could be indexed twice and one delete removed
both. `docs/migration_plan.md` has the reasoning, the measurements and the migration;
`consolidate.py` is the migration itself.

A document's category is decided in this order:

1. an explicit choice — `--category` on the command line, the `category` field
   on the upload and embed endpoints;
2. the file's own YAML front matter, `category: DR`;
3. the folder it sits in — `solvay-spark/<code>/markdown` names its category,
   so `solvay-spark/pkg/markdown` is `PKG`;
4. `UNFILED`.

**The UI does not offer the category.** Every page reads the whole corpus, and
nothing uploaded through the browser is asked where to file it — the folder and
the front matter decide, which means `UNFILED` for anything dropped on Convert,
Batch Convert or Add to Knowledge Base. The category is still recorded, still
shown on a retrieved chunk and on an agent's source chips, and still honoured by
the API and the CLI; it is a label on the data rather than a control.

**Adding a category takes no code change.** Put the Markdown in
`solvay-spark/<code>/markdown` and index it: the folder names the category and
the row records it. `rag.py categories` lists what each one holds.

```bash
.venv/bin/python -m backend.rag.rag index solvay-spark/dr/markdown   # files everything as DR
.venv/bin/python -m backend.rag.rag categories                       # what each one holds
.venv/bin/python -m backend.rag.rag ask "..." --category DR          # search one category
.venv/bin/python -m backend.rag.rag ask "..."                        # search all of them
.venv/bin/python -m backend.rag.rag retag path/to/file.md PKG        # re-file, no re-embedding
```

Edit `CATEGORIES` in `rag.py` only to give a category a label and description
for the UI. `rag_categories` is the registry of the ones that exist.

The category is **metadata, never embedded text**. A code like `PKG` means
nothing to BGE-M3, and adding it to every chunk would move a whole category by
the same constant vector without making any chunk in it easier to tell apart —
so re-filing a document is one `UPDATE`, not 50 embedding calls. The chunks
follow the document through a foreign key on `(document_id, category)` with
`ON UPDATE CASCADE`, so they cannot be left disagreeing with it. The category is
passed to Claude on each excerpt, so an answer can say which kind of document it
rests on.

Searching with no category covers all of them, which is what every page now
does; `--category` on the CLI and `categories` on the API still narrow it. The BM25 corpus statistics are
computed over whatever is in scope, so a chunk scores the same wherever it is
filed — without that, a category holding a handful of chunks would have
near-zero keyword scores and never surface beside a large one.

One index over every category is a bigger HNSW graph than one index per category
was, so `RAG_HNSW_EF_SEARCH` defaults to **800** rather than 200. Measured
against an exact scan over ten questions, searching every category: 0.85 recall
at 200, 0.98 at 600 and above. It costs about 0.7 ms on a search that takes
180.

## Upgrading an index that still has a database per category

```bash
.venv/bin/python -m backend.rag.consolidate baseline    # record what the split system does
.venv/bin/python -m backend.rag.consolidate run         # merge into one database
.venv/bin/python -m backend.rag.consolidate verify      # hold the result to the baseline
```

Nothing is re-embedded — the vectors are carried across as they are, which takes
about three seconds where re-embedding would take eighteen minutes. `run` is
additive: it reads the old databases and never writes to them, so they stay
exactly where they are as the rollback.

## Removing or Resetting Data in pgvector

If you want to clear old records or switch embedding models:

1. **Reset schema for BGE-M3 (1024d) — Recommended:**
   Drops existing tables and recreates clean tables matching `vector(1024)`:
   ```bash
   .venv/bin/python -m backend.rag.rag reset               # drops and recreates the tables
   ```

2. **Clear all documents and chunks (keep schema):**
   Truncates all stored documents and chunks:
   ```bash
   .venv/bin/python -m backend.rag.rag clear               # every category
   .venv/bin/python -m backend.rag.rag clear --category DR # just one
   ```

3. **Wipe and immediately re-index a folder:**
   Recreates the schema and re-embeds all files in one step:
   ```bash
   .venv/bin/python -m backend.rag.rag index knowledge_base --rebuild
   ```

4. **Via direct SQL / `psql`:**
   ```sql
   -- Option A: Empty all records
   TRUNCATE TABLE rag_documents CASCADE;

   -- Option B: Completely drop tables
   DROP TABLE IF EXISTS rag_chunks, rag_documents CASCADE;
   ```
