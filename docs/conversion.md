# Converting documents to Markdown

The conversion engine behind the **Extract** page and the command-line tools: which engines read which file, how images are handled, and how well it works.

## Command line

Same conversion engine, no browser:

```bash
.venv/bin/python -m backend.ingestion.pptx_to_md P2P.pptx -o out
```

Options: `--lang eng+deu`, `--scale 4` (upscale before OCR), `--no-ocr`,
`--no-flows`, `--vlm` (read dense images with the local vision model).

To convert a whole folder of `.xlsx`, `.pptx`, `.docx`, `.png` and `.jpg`/`.jpeg`
files in one go:

```bash
.venv/bin/python -m backend.ingestion.folder_to_md solvay-spark          # Tesseract OCR only
.venv/bin/python -m backend.ingestion.folder_to_md solvay-spark --vlm    # + local vision model
.venv/bin/python -m backend.ingestion.folder_to_md solvay-spark --vlm-provider claude   # or openai
```

The `.md` files are written to `solvay-spark/markdown/`, named after the file
and its type (`report.pptx` → `report_pptx.md`) so same-named files don't
overwrite each other. `-o DIR` writes somewhere else. Only the top level of the
folder is read, and a file that fails is reported and skipped. Progress is
printed per file:

```
[1/4] Converting deck.pptx ...
  144 pages, 2 image(s): 1 OCR, 1 tables, 0 flows, 0 vision model, 0 no text
  -> solvay-spark/markdown/deck_pptx.md (0.9s)
```

The vision model is **off unless you pass `--vlm` or `--vlm-provider`**. If
`mlx_vlm` is not installed the run falls back to Tesseract without an error, so
check that `vision model` is non-zero on the first run.

### Choosing the vision model

`--vlm-provider` (both CLIs) or the drop-down next to the AI toggle (web UI)
picks who reads the images:

| Provider | Where the image goes | Needs | Model |
|---|---|---|---|
| `qwen` (default) | Nowhere -- Qwen3-VL-8B runs on this Mac | `mlx_vlm` installed | `mlx-community/Qwen3-VL-8B-Instruct-4bit` |
| `openai` | OpenAI's API, through Docling's VLM pipeline | `OPENAI_API_KEY` | `gpt-5`, or set `OPENAI_VLM_MODEL` |
| `claude` | Anthropic's API, through Docling's VLM pipeline | `ANTHROPIC_API_KEY` | `claude-opus-5`, or set `CLAUDE_VLM_MODEL` |

```bash
export ANTHROPIC_API_KEY=...          # set where the CLI or ./scripts/run.sh runs
.venv/bin/python -m backend.ingestion.folder_to_md solvay-spark --vlm-provider claude
```

With `openai` or `claude`, **every dense image is uploaded to that company's
API** -- check that the documents may leave the machine before using them. The
cloud providers only re-read tables and screenshots as Markdown; flattened
flowcharts are still traced locally by `flow_cv.py`. If the key is missing or
the API refuses the call, the run carries on with image processing and OCR, and
says so on stderr (CLI) or in the status line (web UI).

Docling can only call an OpenAI-style `/v1/chat/completions` endpoint, so Claude
is reached through Anthropic's OpenAI-compatible endpoint. Anthropic describes
that endpoint as intended for evaluating models rather than as a long-term
production integration.

## How it works

Two independent paths run off one uploaded file:

- **Preview (left)** — LibreOffice → PDF → per-page PNG. Two hops because
  `--convert-to png` only exports the first slide of a presentation.
- **Extraction (right)** — Docling reads native text out of the OOXML, then each
  embedded raster image is OCR'd with Tesseract and spliced back in at its
  placeholder. Spreadsheets bypass Docling entirely (see below). Scanned PDFs
  have no embedded media to pull out, so their pages are rendered to images and
  read the same way. An uploaded PNG or JPEG skips Docling too and is read
  exactly like an image found inside a slide -- OCR, table and flow detection,
  and with the AI toggle on, the vision model. It is straightened (EXIF rotation) and
  flattened onto white first, so phone photos and transparent screenshots read
  correctly.

Preview failure doesn't block extraction — you can still convert a document that
won't render.

| File | Role |
|---|---|
| `app.py` | FastAPI: upload, convert, preview/media, download; `/ask` page and its streaming `/api/ask` endpoint; serves the built UI |
| `preview.py` | LibreOffice + pdftoppm rendering |
| `converter.py` | Conversion core, shared by the CLI and the web UI |
| `pptx_ocr.py` | Tesseract layer (upscale + sparse-text mode) |
| `xlsx_tables.py` | Spreadsheet tables (Docling splits sheets on blank rows) |
| `pptx_flow.py` | Rebuilds flowcharts from PowerPoint connector shapes |
| `table_cv.py` | Ruled tables in images: border lines + per-cell Tesseract |
| `flow_cv.py` | Flowcharts in images: shapes, connector lines and arrowheads |
| `vlm_ocr.py` | Local vision model: table structure, and arrows in flattened diagrams |
| `vlm_api.py` | GPT / Claude through Docling's VLM pipeline: table structure |
| `pptx_to_md.py` | CLI wrapper |
| `folder_to_md.py` | CLI: convert every supported file in a folder |
| `rag.py` | CLI: index the Markdown in pgvector (BGE-M3 Ollama embeddings) and answer questions with Claude |
| `md_chunker.py` | Splits the Markdown into heading-aware chunks for `rag.py` |
| `frontend/` | Web UI source (React + MUI + Lucide + Framer Motion): `src/pages/ExtractPage.tsx`, `src/pages/AskPage.tsx` |
| `static/dist/` | The built web UI that `app.py` serves (`npm run build`) |

## Which path each file takes

### The engines

| Engine | What it is | Used for |
|---|---|---|
| Docling Office backends | XML parsers, no ML model | Native text, headings, lists and tables in PPTX and DOCX |
| Docling PDF pipeline | `docling-layout-heron` layout model, TableFormer (accurate mode), auto-selected OCR engine | Text, layout and tables in PDFs |
| `xlsx_tables.py` | openpyxl, no ML model | Every sheet of an XLSX, as Markdown tables |
| `pptx_flow.py` | Reads PowerPoint connector shapes, no ML model | Exact flowcharts from slides whose arrows are real connectors |
| Tesseract (`pptx_ocr.py`) | Classic OCR, 3× upscale, sparse-text mode | Text inside images. Always on |
| `table_cv.py` | OpenCV border detection + Tesseract per cell, no ML model | Ruled tables in images (SAP GUI grids, Excel ranges) as Markdown tables. Always on |
| `flow_cv.py` | OpenCV shape, connector and arrowhead detection + Tesseract per shape, no ML model | Flowcharts pasted as pictures, as DRAFT Mermaid. Always on |
| Qwen3-VL-8B (`vlm_ocr.py`) | Local vision-language model via MLX, 4-bit | Tables and screenshots as Markdown, and flattened diagrams as draft Mermaid. **Only with `--vlm` or the AI toggle** |
| GPT / Claude (`vlm_api.py`) | Cloud vision model called through Docling's VLM pipeline | Tables and screenshots as Markdown. **Only with `--vlm-provider openai`/`claude` or the drop-down; images leave the machine** |

### By scenario

| Scenario | Path | Engines involved |
|---|---|---|
| PPTX, text only | Docling reads the slide XML. Nothing is OCR'd. | Docling |
| PPTX with native tables | The table is read from the XML as a real table. | Docling |
| PPTX with embedded images | Docling marks each picture, the image is pulled out of the package, matched to its slide, read, and its text spliced in where the picture sat. See [Images](#images). | Docling → Tesseract → (Qwen3-VL) → flow / table detection |
| PPTX with a flowchart drawn as shapes and connectors | Arrows rebuilt exactly and appended as Mermaid under "Process flows". Images on that slide are never traced as diagrams, but can still be read as tables. `--no-flows` turns this off. | `pptx_flow.py` |
| PPTX with a flowchart pasted as a picture | No connector data survives. The arrows are traced from the pixels into a Mermaid block marked DRAFT, with Tesseract's box labels below it; with `--vlm` the vision model is tried first. | Tesseract → (Qwen3-VL) → `flow_cv.py` |
| Any image holding a ruled table or SAP screen | Border lines give rows, columns and merged cells; each cell is OCR'd on its own. Text outside the tables follows as plain lines. | Tesseract → (Qwen3-VL) → `table_cv.py` |
| DOCX, text only | Docling reads the document XML. | Docling |
| DOCX with native tables | Read from the XML as real tables. | Docling |
| DOCX with embedded images | As for PPTX, but pictures are matched to images by order in the package (DOCX has no per-slide mapping). No connector flows. | Docling → Tesseract → (Qwen3-VL) → flow / table detection |
| XLSX | Bypasses Docling. Each sheet becomes one table, using cached values for formula cells. Images and charts in the workbook are **not** read. | `xlsx_tables.py` |
| PNG / JPEG | Bypasses Docling. Rotated upright, flattened onto white, then read as one image. | Tesseract → (Qwen3-VL) → flow / table detection |
| PDF with a text layer, no pictures | Layout, reading order and tables from Docling. | Docling PDF pipeline |
| PDF, scanned or with pictures | Docling's own pass runs, and each page holding a picture is also rendered at 150 DPI and read as an image, spliced in at the first picture on that page. Page text can therefore appear twice. | Docling PDF pipeline → Tesseract → (Qwen3-VL) → flow / table detection |
| PPT, DOC, XLS (web UI only) | Left to Docling. These are not zip packages, so images are not extracted, OCR'd or traced, and there are no connector flows. `folder_to_md.py` skips them. | Docling |

Steps in brackets run only with `--vlm` / `--vlm-provider` (or the AI toggle),
and only when the chosen model is usable: `mlx_vlm` installed for Qwen3-VL, the
API key set for GPT or Claude.

### Images

Every image, whatever file it came from, goes through the same decision:

| Step | Check | Outcome |
|---|---|---|
| 1 | Tesseract reads it | Always happens |
| 2 | Mean confidence below 70 | Photo, icon or gradient: left out, marked `<!-- no readable text -->`. Stops here. |
| 3 | `--vlm` on, at least 20 words and 200×150 px | The vision model gets the first try: steps 3a and 3b. If neither is kept, carry on at step 4. |
| 3a | Provider is `qwen`, and it looks like a diagram (≥ 5 scattered text blocks, not a grid), and its slide has no connector flow | Qwen3-VL is asked whether it *is* a diagram. If yes, it traces it into DRAFT Mermaid (at least 3 arrows, or it is discarded). Tesseract's labels are kept below. |
| 3b | Otherwise | The chosen model (Qwen3-VL, GPT or Claude) re-reads it as Markdown. Kept if it recovered a table, or read at least as much text as Tesseract without looping. |
| 4 | `flow_cv.py` finds a flowchart: at least 3 arrows with a visible arrowhead (40% of all arrows), and 60% of steps with a real word as label | DRAFT Mermaid, with Tesseract's labels below. If the slide already has connector flows, the image falls through to plain text instead. Stops here. |
| 5 | `table_cv.py` finds ruled tables with a mean cell confidence of at least 75 | Markdown tables, preceded by the text found outside them. Stops here. |
| 6 | Otherwise | Tesseract text. |

Each block in the Markdown starts with a comment saying which engine produced
it: `<!-- OCR of … via tesseract -->`, `<!-- tables in … read by image
processing + tesseract -->`, `<!-- … read by Qwen3-VL -->` / `<!-- … read by Claude (Anthropic API), model … -->`, or a DRAFT flow
caveat naming image processing or the vision model.

### How well the image-processing steps work

Measured on this corpus, with no ML model involved:

| What | Test set | Result |
|---|---|---|
| Tables (`table_cv.py`) | 6 hand-transcribed tables: SAP GUI grids, Excel ranges with merged cells | 94% of cells reproduced exactly |
| Flows (`flow_cv.py`) | 75 slides of *P2P- L4_L5 Processes* rendered to images, scored against the connector graph PowerPoint stores, shapes matched by position | 79% of shapes found; 60% of arrows recovered, 82% of drawn arrows correct |
| Flow vs not-flow | 104 images embedded in the decks | 20 of 24 flowcharts traced, no SAP screen mistaken for one |

For comparison, Qwen3-VL-8B scored 48% arrow recall and 63% precision on 12
slides of the same deck.

Known limits:

- **Dashed connectors are missed.** Each dash is a separate stroke, and joining
  them also joins text to lines, which cost more arrows than it recovered.
- **Crossing connectors** merge into one piece, so arrows can pair up wrongly.
- **Tables without drawn borders** (Fiori lists, whitespace-aligned text) are
  not detected and stay as plain OCR text.
- **Swimlane diagrams can be read as tables** when the flowchart itself is not
  recognised: the lanes are ruled like a grid.
- Cells in SAP's fixed-width font sometimes read `0` as `9` (`9020` for
  `0020`). Values in a table deserve a glance before they are relied on.

## Conversion notes

- **Process flows.** PowerPoint records which two shapes each arrow joins, so a
  deck's flowcharts are rebuilt *exactly* rather than guessed from pixels, and
  appended as Mermaid diagrams under a "Process flows" heading. Disable with
  `--no-flows`. Not available for PDFs, or for a diagram pasted into a slide as
  a picture -- in both cases the connector data was destroyed when the file was
  flattened. For those, see the vision model below.
- **Reading images with AI** (the header toggle, or `--vlm` on the CLI) sends
  dense images to `Qwen3-VL-8B` running locally through MLX. Nothing leaves the
  machine. It does two jobs, and is off by default. First use downloads ~5.4GB
  of weights to `~/.cache/huggingface`.
  - **Tables and SAP screenshots** are re-read as Markdown, recovering row and
    column structure Tesseract scrambles.
  - **Flattened process diagrams** are traced into a draft Mermaid graph. This
    is the only way to get *arrows* out of a picture, and the result is a draft:
    benchmarked against the connector ground truth in these decks it finds about
    half the arrows and about a third of the arrows it draws are wrong. Every
    such block is labelled `DRAFT` in the output. Where real connectors exist
    they always win -- a slide already covered by `pptx_flow.py` is never
    second-guessed.
- Asked for a flowchart, the model will draw one out of anything: shown a SAP
  table it chains the cells into a process that does not exist, and nothing
  downstream can tell that apart from a real answer. So each candidate image is
  first asked, in one word, whether it *is* a diagram, and only then traced.
- The vision model is used only when its answer actually beats Tesseract's: a
  recovered table always wins, anything else must read at least as much text and
  must not be a repetition loop.
- OCR groups words into the blocks they sit in rather than into full-width
  lines, so a diagram's boxes come out one label per line instead of three
  unrelated boxes interleaved word by word. Labels only -- Tesseract reads
  glyphs, never structure. The arrows come from `pptx_flow.py` where the source
  PowerPoint survives, and from `flow_cv.py` (or the vision model, with `--vlm`)
  where it does not.
- Images are OCR'd only when Tesseract is confident the content is text
  (mean confidence >= 70). Photos, icons and gradients otherwise yield pages of
  plausible-looking gibberish; those are left out and marked
  `<!-- no readable text -->` instead.
- The Markdown carries only what was read from each image, never the image
  itself. Embedded images are extracted solely so they can be read.
- Only `eng` language data ships by default. `brew install tesseract-lang` for
  the rest, then pass `--lang`.
- XLSX previews get arbitrary page breaks across wide sheets, so a 7-column
  sheet may show 2 columns per page. That is a LibreOffice PDF-export limit
  affecting the preview only; the extracted Markdown keeps every column.
- Spreadsheets are extracted by `xlsx_tables.py`, not Docling. Docling splits a
  sheet wherever it finds a blank row, which orphans the header from its data
  and promotes a data row to a header in every fragment.
