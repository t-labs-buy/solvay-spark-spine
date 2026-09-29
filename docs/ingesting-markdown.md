# Ingesting Markdown into a New Category

How to add a folder of Markdown files to the corpus under a category of your
own, and make the knowledge graph see them too.

Worked example throughout: three SAP Best Practices process models on the
Desktop, ingested as category `SAP`.

---

## The one thing to get right

There are **three stores**, and they are filled by different commands:

| Store | What it holds | Filled by |
|---|---|---|
| Files on disk | the Markdown itself | you, copying files |
| Vector corpus | chunks and embeddings, in Postgres | `rag.py index` |
| Knowledge graph | entities and relationships, in `knowledge_graph.json` | `POST /api/graph/rebuild` |

Indexing does **not** rebuild the graph, and rebuilding the graph does **not**
index anything. Both commands are needed, and the second is the one people
forget.

The graph never reads the database. It builds itself by scanning folders, and
the folders it scans are the ones registered in `rag.CATEGORIES` plus anything
matching `solvay-spark/*/markdown`. **A folder outside that pattern is invisible
to the graph no matter what you pass to `--category`.** That is why step 1
below copies the files in rather than indexing them where they lie.

---

## The commands

```bash
cd /Users/senthilpalanivelu/Programme/solvay-spark-spine

# 1. Put the files where both the corpus and the graph will look
mkdir -p solvay-spark/sap/markdown
cp /Users/senthilpalanivelu/Desktop/sap_best_practice/markdown/*.md solvay-spark/sap/markdown/

# 2. Chunk, embed and store them
.venv/bin/python -m backend.rag.rag index solvay-spark/sap/markdown --category SAP

# 3. Rebuild the graph so it sees them too
curl -s -X POST -o /dev/null -w "graph rebuilt (%{size_download} bytes)\n" \
  http://127.0.0.1:8000/api/graph/rebuild

# 4. Check
.venv/bin/python -m backend.rag.rag categories
```

Substitute your own source folder and code. A category code is letters, digits
and underscores, starting with a letter — `SAP`, `HR`, `FIN_2026` are all fine.

---

## Step by step

### 1. Copy the files in

```bash
mkdir -p solvay-spark/<code>/markdown
cp /path/to/your/markdown/*.md solvay-spark/<code>/markdown/
```

The folder name **is** the category. `category_for()` resolves a file's category
in this order:

1. an explicit `--category` flag,
2. the file's own front matter (`category: SAP`),
3. **the folder it sits in** — `<anything>/<code>/markdown`,
4. `UNFILED`.

The graph applies the same rule, which is what keeps the two stores agreeing.

### 2. Index

```bash
.venv/bin/python -m backend.rag.rag index solvay-spark/sap/markdown --category SAP
```

This chunks each file (~500 tokens, split on headings), embeds every chunk with
local Ollama `bge-m3`, and writes chunks, vectors and a full-text index to
Postgres.

**No code change is needed to add a category.** `check_category()` accepts any
well-formed code and `rag_categories` records it the first time it is used. The
`CATEGORIES` dict in `rag.py` only carries labels and descriptions for the UI —
adding an entry there later is cosmetic.

**`--category` is optional here** but worth passing. The folder already says
`SAP`, so the flag is belt and braces. Where it stops being optional is an
external path — see *Indexing without copying* below.

### 3. Rebuild the graph

```bash
curl -s -X POST -o /dev/null -w "graph rebuilt (%{size_download} bytes)\n" \
  http://127.0.0.1:8000/api/graph/rebuild
```

The `-o /dev/null` matters: the endpoint returns **the entire graph** as its
response, about 1.5 MB of JSON, straight into your terminal otherwise.

The rebuild also happens on its own when the file set changes — the graph
fingerprints every file's name, category and size, and a cached graph built from
a different set is discarded rather than served. Forcing it is still worth doing
so the next page load is not the thing that pays for it.

**If the server is not running**, rebuild from the command line instead:

```bash
.venv/bin/python -c "import knowledge_graph as kg; \
  s = kg.extract_graph(force=True)['stats']; \
  print(s['total_nodes'], 'nodes', s['total_edges'], 'edges', s['categories'])"
```

### 4. Check

```bash
.venv/bin/python -m backend.rag.rag categories
```

```
  CODE      DOCS  CHUNKS  FOLDER
  DR         132    3195  solvay-spark/dr/markdown
  PKG         81    4255  solvay-spark/pkg/markdown
  SAP          3      23  solvay-spark/sap/markdown
  UNFILED      1    1382  knowledge_base

  docling: 217 documents, 8855 chunks
```

Then confirm all three stores agree, either on the **Coverage** page or:

```bash
curl -s http://127.0.0.1:8000/api/coverage | \
  .venv/bin/python -c "import json,sys; print(json.load(sys.stdin)['summary'])"
```

```
{'on_disk': 217, 'indexed': 217, 'in_graph': 217, 'documents': 217,
 'clean': 217, 'file_missing': 0, 'not_indexed': 0, 'not_in_graph': 0,
 'shadowed': 0, 'category_mismatch': 0, 'no_original': 0}
```

`on_disk`, `indexed` and `in_graph` must be equal. If `in_graph` is short, you
skipped step 3.

---

## What to check after ingesting

Getting the counts to line up is not the same as the documents being useful.
Two things are worth looking at, and the SAP example hits both.

### Are the new documents connected to anything?

```bash
.venv/bin/python -c "
import json
g = json.load(open('knowledge_graph.json'))
for n in g['nodes']:
    if n.get('category') == 'SAP':
        print(f\"  {n['label']:20} degree {n['degree']}\")
"
```

```
  BKP1_CRM             degree 0
  BKP2_CRM             degree 0
  BKP3_CRM             degree 0
```

**Degree 0 means the document is in the graph and joined to nothing.** This is
not a bug and not a failed ingest — retrieval works on these files perfectly
well. It means the graph's matchers found none of the entities it knows about.

The graph only draws an edge when a document mentions something in its
vocabulary: the four streams (L2C, I2D, R2R, P2P), the eighteen systems
(S/4HANA, Salesforce, SOVOS, Fiori, …), BPML process codes like `O-050-030`,
and SPARK tickets. These SAP Best Practices models are generic — they name none
of them — so there is nothing to attach them to.

Three options, in increasing order of effort:

1. **Accept it.** The documents are searchable and citable. Ask RAG and the
   Evidence Agent's `search_corpus` will find them. Only graph traversal and
   `graph_enumerate` counts will miss them.
2. **Teach the graph their vocabulary.** Add entries to `STREAMS` or `SYSTEMS`
   in `knowledge_graph.py` and a word-bounded pattern to `SYSTEM_RE`, then
   rebuild. Twelve systems were added this way in one commit.
3. **Give them a matching code scheme.** If the new corpus has its own
   identifiers, add a pattern for them alongside `CODE_RE`.

A useful habit either way: after every ingest, list the isolated nodes. A
document that matched nothing is either genuinely off-topic or a silent
extraction failure, and the two look identical until you open one.

### Can the conversion be reviewed?

Coverage reported `no_original` for all three SAP files. The Doc vs Markdown
Review page pairs a Markdown file with the document it was converted from, and
nothing in the database records that pairing -- `rag_documents` stores the
Markdown path, because the Markdown is what was chunked -- so it is recovered
by name, from the folder directly above `markdown/`.

Two names are tried, in this order:

| The Markdown       | Name tried        | When it applies                        |
| ------------------ | ----------------- | -------------------------------------- |
| `Pricing_xlsx.md`  | `Pricing.xlsx`    | written by this repo's converter, which names its output `<stem>_<ext>.md` |
| `BKP1_CRM.md`      | `BKP1_CRM.*`      | written by anything else, which keeps the original's name intact |

Each name is looked for in two folders, nearest convention first:

| Layout                        | Where the original goes          |
| ----------------------------- | -------------------------------- |
| `solvay-spark/<code>/markdown/` | `solvay-spark/<code>/` — beside the `markdown/` folder |
| `knowledge_base/` (flat)        | `knowledge_base/` — beside the Markdown itself |

The flat case needs saying because `knowledge_base/` has no `markdown/`
subfolder to be above: "the folder above" it is the repo root, and nobody keeps
a source workbook next to `app.py`.

The SAP files are the second case. `bpmn2md.py` produced them outside this
repo, so the trailing `_CRM` is part of the name rather than a format suffix --
and reading it as one sends the lookup after a `BKP1.CRM` that never existed.
The fix was to copy the PDFs in, no renaming required:

```bash
cp ~/Desktop/sap_best_practice/pdf/*.pdf solvay-spark/sap/
```

```
solvay-spark/sap/BKP1_CRM.pdf             <- the original
solvay-spark/sap/markdown/BKP1_CRM.md     <- the Markdown
```

Put the original there **before** you index if you can, but nothing breaks if
you do it afterwards: the corpus stores the Markdown path only, so dropping a
file into the folder above is invisible to it. Refresh Coverage and the flag
clears.

`knowledge_base/BPML_Process_xlsx.md` was the flat case: its workbook went to

```bash
cp ~/Desktop/BPML_Process.xlsx knowledge_base/
```

Both folders are gitignored, so originals put in either place stay local. They
are also invisible to the two scanners — indexing and the graph build both glob
`*.md` — so a workbook dropped in beside its Markdown changes nothing but the
review page.

---

## Variations

### Adding more files to a category later

Run the same index command again. It is idempotent: each file is fingerprinted,
and an unchanged file is skipped without an embedding call.

```bash
cp /path/to/more/*.md solvay-spark/sap/markdown/
.venv/bin/python -m backend.rag.rag index solvay-spark/sap/markdown --category SAP
```

Deleting a file from the folder removes it from the index on the next run —
`index()` compares the folder against the rows pointing into it and drops the
ones with no file left. It prints `Removed N stale documents from the index`.
Rebuild the graph afterwards either way.

### Indexing without copying

You can index an external folder directly:

```bash
.venv/bin/python -m backend.rag.rag index ~/Desktop/sap_best_practice/markdown --category SAP
```

Three consequences, all of them quiet:

- **The graph will never see these documents.** It scans folders, not the
  database, and this one is not in its list.
- **Coverage will not see them on disk either**, since it scans the same folder
  list — so you get no warning that the graph is missing them.
- **`rag_documents.source` records the absolute external path.** Move or tidy
  that folder later and the corpus row points at nothing.

`--category` also stops being optional. Without it, the folder convention reads
the parent directory name, and `~/Desktop/sap_best_practice/markdown` files
itself as **`SAP_BEST_PRACTICE`** — a perfectly valid code, silently not the one
you wanted.

### Changing one document's category

```bash
.venv/bin/python -m backend.rag.rag retag solvay-spark/sap/markdown/BKP1_CRM.md DR
```

Nothing is re-embedded — the category is deliberately outside the fingerprint,
so this is an `UPDATE`. It also writes `category: DR` into the file's front
matter, which is what stops the next `index` over that folder resetting it back
to whatever the folder implies.

### Removing a category

```bash
.venv/bin/python -m backend.rag.rag clear --category SAP     # drop its rows from the corpus
rm -rf solvay-spark/sap                          # drop the files
curl -s -X POST -o /dev/null http://127.0.0.1:8000/api/graph/rebuild
```

Check Coverage afterwards. `clear` without the files removed leaves
`not_indexed`; removing the files without `clear` leaves `file_missing`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No .md files in <folder>` | Wrong path, or the files are nested one level deeper. `index` globs `*.md`, not `**/*.md`. |
| `Failed to generate embeddings from Ollama` | Ollama is not running, or `bge-m3` is not pulled. `ollama pull bge-m3`. Embedding is local — an expired Anthropic key does not affect ingestion. |
| `DATABASE_URL is not set` | `.env` is missing or you ran from another directory. `rag.py` loads `.env` from beside itself. |
| `not a category code: 'sap best'` | Codes take letters, digits and `_`, starting with a letter. |
| Documents indexed but absent from the graph | Step 3 was skipped, or they were indexed from a folder outside `solvay-spark/*/markdown`. |
| Documents in both, connected to nothing | Expected for a corpus with unfamiliar vocabulary. See *Are the new documents connected to anything?* |
| Coverage says `shadowed` | Two files share a name in different category folders. The graph keys by filename, so the second is never walked. Rename one. |
| Category came out wrong | The folder convention or existing front matter won. Front matter outranks the folder; `--category` outranks both. |

---

## Related

- `rag.py` — chunking, embedding, hybrid search, the category rules
- `knowledge_graph.py` — `source_folders()` and `collect_files()` decide what the graph scans
- `coverage.py` — the three-store reconciliation behind the Coverage page
- `docs/solvay-kb-pipeline.md` — the end-to-end pipeline this fits into
