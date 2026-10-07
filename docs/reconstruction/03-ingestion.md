# 03 — Document Ingestion / Conversion (documents → Markdown)

Scope: `backend/ingestion/*` (converter.py, pptx_ocr.py, pptx_flow.py, flow_cv.py, table_cv.py, vlm_ocr.py, vlm_api.py, xlsx_tables.py, xml_tables.py, bpml_markdown.py, md_chunker.py, mail_reader.py, preview.py, pptx_to_md.py, folder_to_md.py) plus the API callers that drive it (`backend/api/app.py`, `backend/core/uploads.py`).
Current as of commit fd5a375 (2026-10-06); nothing in `backend/ingestion/` changed after `1d37131`. `app.py` line numbers are at `1d37131` plus the ownership fixes; from ~line 800 on they have since moved down by roughly 40–160 lines.
Legend: **FACT (file:line)** = read from the code. **INFERRED** = deduced or taken from docs but not confirmed in code. Paths are relative to the repo root, and `ingestion/` means `backend/ingestion/`.

---

## 0. Dependencies & system tools

| Item | Detail | Source |
|---|---|---|
| Docling | `docling[tesserocr]`, pinned `docling==2.130.0`, `docling-core==2.99.0`, `docling-ibm-models==4.0.3`, `docling-parse==7.22.0` | FACT requirements.txt:1, constraints.txt:42-46 |
| tesserocr | `tesserocr==2.11.0` (Python binding; wheel bundles lib but **no language data**) | FACT constraints.txt:179, pptx_ocr.py:40-41 |
| OpenCV / numpy | `opencv-python`, `numpy` (table_cv, flow_cv) | FACT requirements.txt:5-7 |
| openpyxl | xlsx_tables, bpml_markdown | FACT requirements.txt:18 |
| olefile | .msg reading (comes with docling) | FACT mail_reader.py:11-12 |
| python-dotenv | vlm_api loads `ROOT/.env` with `override=False` | FACT vlm_api.py:39 |
| mlx_vlm + transformers | Optional; local Qwen3-VL. `available()` = whether `import mlx_vlm` succeeds | FACT vlm_ocr.py:117-122 |
| PIL (Pillow) | image prep | FACT |
| System: LibreOffice (`soffice`), Poppler (`pdftoppm`), `tesseract-ocr tesseract-ocr-eng` | Docker apt installs `libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils tesseract-ocr tesseract-ocr-eng libgl1 libglib2.0-0 libxcb1 fonts-dejavu` | FACT Dockerfile:59-66 |
| Docling models | Pre-downloaded via `docling-tools models download -o /opt/docling-models`; env `DOCLING_ARTIFACTS_PATH=/opt/docling-models` | FACT Dockerfile:32,69-72 |

Tessdata lookup (`default_tessdata()`, FACT pptx_ocr.py:50-58): use `$TESSDATA_PREFIX` if it is a directory, else the first existing directory among `/opt/homebrew/share/tessdata`, `/usr/local/share/tessdata`, `/usr/share/tesseract-ocr/5/tessdata`, `/usr/share/tessdata`, else fall back to the first entry. The default language is `"eng"`. Use `+` to combine languages (e.g. `eng+deu`; FACT pptx_to_md.py:19).

---

## 1. Format routing (`converter.convert`)

Signature (FACT converter.py:541-552):
`convert(src: Path, media_dir: Path|None=None, ocr=True, use_vlm=False, vlm_provider="qwen", flows=True, title=None, lang="eng", tessdata=None, scale=DEFAULT_SCALE(=3)) -> Result`

`Result` dataclass (FACT converter.py:103-117): `markdown, pages, pictures, unit="pages", skipped_images=0, vlm_images=0, flows=0, flow_images=0, table_images=0, cv_flow_images=0, ocr_blocks: list[OcrBlock(page, image, confidence, chars)], elapsed`.

Validation (FACT :561-568): `vlm_provider` must be in `VLM_PROVIDERS = ("qwen","openai","claude")`. Otherwise it raises `ValueError`. If `use_vlm` is set, the provider is not qwen, and its API key is missing, the converter prints `"  ! {KEY_ENV} is not set; images are read without the vision model"` to stderr and carries on.

The suffix is checked in this order (lowercased), and the first match wins:

| # | Suffix | Path | Result.pages / unit | Source |
|---|---|---|---|---|
| 1 | `.xlsx`, `.xlsm` | `xlsx_tables.workbook_to_markdown` (openpyxl, no Docling) | sheet_count / `"sheets"`, pictures=0 | FACT :38, :570-577 |
| 2 | `.png .jpg .jpeg .webp .bmp .tiff .tif` (`preview.IMAGE_FORMATS`) | `_convert_image` (no Docling) | 1 / `"image"`, pictures=1 | FACT preview.py:28, converter.py:579-584 |
| 3 | `.txt` | `text_to_markdown` (passthrough) | 1 / `"files"` | FACT :49, :586-593 |
| 4 | `.json` | `json_to_markdown` | 1 / `"files"` | FACT :68, :595-602 |
| 5 | `.msg`, `.eml` | `mail_to_markdown` → mail_reader | 1 / `"messages"` | FACT :73, :604-613 |
| 6 | `.csv` | `csv_to_markdown` (decode, then Docling CSV backend) | data rows (excluding header) / `"rows"` | FACT :63, :615-622 |
| 7 | `.xml` | `xml_tables.xml_to_markdown` (ElementTree) | 1 / `"files"` | FACT :624-631 |
| 8 | everything else (`.pdf .docx .doc .pptx .ppt .html .htm .xls`) | Docling `DocumentConverter()` with **default options** → `export_to_markdown()`, then the image/flow post-processing in §2 | `len(doc.pages) or 1` / `"pages"`, pictures=`len(doc.pictures)` | FACT :633-635 |

- The Docling converter is a module-level singleton: `DocumentConverter()` with no `format_options` and no pipeline options (FACT converter.py:84-92). No OCR engine, table mode or layout model is configured in code. The docs say the PDF pipeline uses "`docling-layout-heron` layout model, TableFormer (accurate mode), auto-selected OCR engine" (docs/conversion.md). **INFERRED**: these are the Docling 2.130 defaults, not explicit settings.
- `.xls` is **not** in SPREADSHEET_FORMATS, so it goes to Docling (FACT :38). **INFERRED**: legacy `.doc/.ppt/.xls` are not zip packages, so media extraction and `slide_flows` silently return nothing (BadZipFile is caught at :173, :190, pptx_flow.py:347).
- Accepted upload set (web API): `{.pptx,.ppt,.docx,.doc,.xlsx,.xlsm,.xls,.pdf,.html,.htm,.xml,.txt,.csv,.json,.msg,.eml} ∪ IMAGE_FORMATS` (FACT backend/api/app.py:71-73).
- `warnings.filterwarnings("ignore", category=UserWarning)` runs at import (FACT converter.py:34).

### 1.1 Plain-format converters (exact output)

- **.txt** (FACT converter.py:463-482): `# {title or stem}\n\n{body}\n`. The file is decoded as utf-8; on UnicodeDecodeError it falls back to `cp1252` with `errors="replace"`. CRLF and CR become LF, and leading/trailing `\n` are stripped. **Nothing is escaped.** The reason is that agents quote evidence verbatim and a verifier matches it character for character. Docling's Markdown parse would turn `->` into `-&gt;` and `5_000` into `5\_000`. An empty file gives `"# Empty\n\n\n"` (FACT tests/test_converter.py:~102).
- **.json** (FACT :426-445): `# {title}\n{note}\n```json\n{body}\n```\n`. The body is `json.dumps(json.loads(raw), indent=2, ensure_ascii=False)`. If parsing fails, the raw text is kept unchanged and `note = "\n> This file is not valid JSON ({exc}); it is shown as it arrived.\n"`.
- **.csv** (FACT :496-538): `_decode` tries `utf-8-sig`, then `utf-8`, then `cp1252`, then cp1252 with replace. Empty content gives `# {title}\n\n`. Otherwise the decoded text is written as UTF-8 to a temp `{stem}.csv` and run through Docling `.convert(...).document.export_to_markdown()`. Docling sniffs the delimiter (`,` `;` tab) and escapes only `|`. Output: `# {title}\n\n{body.strip()}\n`. If Docling throws, it falls back to `text_to_markdown`. `csv_rows` = non-blank lines − 1.
- **.msg/.eml**: see §8. If `title` is given, it replaces the first `# ` line (FACT :448-460).
- **.xml**: see §7.

---

## 2. Docling path + image post-processing (pptx/docx/pdf/…)

Algorithm (FACT converter.py:633-701):

1. `doc = _docling().convert(src).document`, then `md = doc.export_to_markdown()`. Docling writes each picture as the literal placeholder `<!-- image -->` (`PLACEHOLDER`, :75).
2. **Connector flows first**: if `flows` is true and the suffix is in `{.pptx,.ppt}`, then `diagrams = slide_flows(src)`, which maps slide number to Mermaid (§4) (:642-644).
3. If `doc.pictures` is non-empty, `ocr` is true and `media_dir` is set:
   - tessdata resolved.
   - **PDF**: `by_slide = pdf_page_images(src, media_dir)`. This calls `preview.render(src, media_dir, dpi=150)`, which renders every page to `media_dir/page-NNNN.png` and returns `{n: ["page-{n:04d}.png"]}`. If rendering fails, it prints `  ! could not render …` and returns `{}` (:195-210). `available` = all of those names.
   - **Other**: `available = extract_media(src, media_dir)` copies every zip member that starts with `ppt/media/`, `word/media/` or `xl/media/` (in sorted name order) into `media_dir/<basename>` (:178-192). `by_slide = slide_media_map(src)` parses `ppt/slides/_rels/slide(\d+).xml.rels` with regex `Target="\.\./media/([^"]+)"` to map slide number to the media names in rel order (:157-175). Only PPTX produces a mapping.
   - A single `_ImageReader` is used for the whole document (shared caches).
   - For each `pic` in `doc.pictures` (index i): `page = pic.prov[0].page_no` if prov exists. If `by_slide[page]` exists, the reader takes the nth unused name on that page (a per-page counter `taken[page]`). Otherwise it takes `available[i]` by global order (docx/xlsx). If there is no name or no file, it appends `PLACEHOLDER`. Otherwise it appends `reader.block(name, page, allow_flow = page not in diagrams)` (:667-684).
   - **PDF consequence**: each page has only one image (the full-page render), so only the first picture on that page receives it. Later pictures on the same page stay `<!-- image -->`. Page text can therefore appear twice: once from Docling and once from OCR of the rendered page (docs/conversion.md).
   - `_splice(md, blocks)` splits the text on `<!-- image -->` and replaces the i-th placeholder with `blocks[i]`. Placeholders beyond the end of `blocks` are left as they are (:213-222).
4. If `diagrams` is non-empty, this is appended (FACT :688-698):
```
\n\n## Process flows\n\n_Recovered from the PowerPoint connector shapes, which record which box each arrow joins._
\n### Slide {n}\n\n```mermaid\n{flow}\n```       (one per slide, sorted)
```
   `result.flows = len(diagrams)`.
5. `elapsed` is measured with `time.perf_counter`.

**The Markdown never links images.** Images are extracted only so they can be read (FACT docstring :553-556).

### 2.1 Standalone image (`_convert_image`, FACT :387-423)
- Heading `# {title or src.stem}\n\n`.
- If `ocr` is false or there is no `media_dir`: heading + `<!-- image -->\n`.
- Otherwise `preview.image_to_png(src, media_dir/"image.png")` applies `ImageOps.exif_transpose`. RGBA/LA/P images are alpha-composited onto opaque white and the result is saved as an RGB PNG (preview.py:102-119). Then: heading + `reader.block("image.png", None)` + `\n`.

### 2.2 `_ImageReader.block(name, page, allow_flow=True)` — per-image decision cascade (FACT converter.py:225-384)

Caches are per reader and keyed by **filename**: `ocr_cache`, `vlm_cache`, `flow_cache`, `structure_cache`. A logo repeated across slides is processed once.

1. **Tesseract**: `found = pptx_ocr.read(path, lang, tessdata, scale)`. If it raises, print `  ! OCR failed on {name}: {exc}` and return `<!-- image -->`.
2. **VLM** (only when `use_vlm`, `found.is_text` and the provider is available): `_vision(...)`. Exceptions print `  ! VLM failed on …` and the cascade continues.
   - Gate: `vlm_ocr.should_use(found.words, w, h)` requires words ≥ 20 **and** w·h ≥ 30 000 px (200×150). If the gate fails, return None.
   - If `allow_flow`, `found.is_diagram` and provider == `qwen`: `vlm_ocr.read_flow(path)` (cached). If it returns a flow, increment `flow_images` and return `_flow_block(flow, found.text)`.
   - Otherwise `vlm_ocr.read(path)` (qwen) or `vlm_api.read(path, provider)` (cached). If `vlm_ocr.is_better_than(vlm_md, found.text)`, increment `vlm_images` and return `<!-- {name} read by {source} -->\n\n{md}`. `source` is `Qwen3-VL (local vision model)` or `{label} via Docling's VLM pipeline`, where label = `"GPT (OpenAI API), model gpt-5"` / `"Claude (Anthropic API), model claude-opus-5"` (vlm_api.py:96-97).
3. If `found.is_text`: **structure** `_structure(...)` (cached; exceptions print `  ! structure detection failed on …`):
   - `img = gray_image(path)` (flattened, grayscale, scale 1). Then `gray = np.array(img)`.
   - `flow = flow_cv.find_flow(gray, lang, tessdata)`. If a flow is found and `allow_flow` is true, increment `cv_flow_images` and build `_cv_flow_block`. If a flow is found but `allow_flow` is false, block=None, the cascade falls through to plain OCR, and **tables are not tried**.
   - If no flow is found: `tables = table_cv.find_tables(...)`. If any tables are found, increment `table_images`, paint each table bbox white (`ImageDraw.rectangle(fill=255)`) and re-OCR the remainder with `read_image`. The block is `"\n\n".join(["<!-- tables in {name} read by image processing + tesseract -->", rest.text (if rest.is_text), *t.to_markdown()])`.
   - If a structured block was produced, return it.
   - Otherwise append `OcrBlock(page, name, confidence, len(text))` and return `<!-- OCR of {name} via tesseract, mean confidence {conf:.1f} -->\n\n{text}`.
4. Not text (mean confidence < 70): increment `skipped_images` and return `<!-- no readable text in {name} (OCR confidence {conf:.1f}) -->`.

Block templates (FACT converter.py:124-154):
- VLM flow: `<!-- {FLOW_CAVEAT} -->\n\n```mermaid\n{flow}\n```` plus, when OCR text exists, `\n\n<!-- labels read from the image via tesseract -->\n\n{ocr_text}`.
  FLOW_CAVEAT = "Flow read from the image by the local vision model. DRAFT -- on this corpus it recovers about half the arrows and about a third of the arrows it draws are wrong, so check every one against the image before relying on it. The box labels below are read by OCR and are reliable."
- CV flow: `<!-- {name}: {CV_FLOW_CAVEAT} -->` followed by the same mermaid and labels layout.
  CV_FLOW_CAVEAT = "Flow traced from the image by image processing (shapes, connector lines and arrowheads). DRAFT -- on rendered process slides it recovers about 60% of the arrows, and about 1 in 5 of the arrows it draws is wrong; dashed arrows are missed. Check it against the original. The box labels below are read by OCR."

Downstream dependency: `backend/agents/evidence/provenance.py:27-31` parses these comments with the regexes `read by (?:Claude|GPT|Qwen)`, `OCR of … (confidence|via)`, `no readable text in` and `confidence\s+([0-9.]+)`. **The comment wording is an interface. Keep it verbatim.**

---

## 3. Tesseract layer (`pptx_ocr.py`)

Constants (FACT pptx_ocr.py:38-72): `DEFAULT_SCALE=3`, `MIN_CONF=25.0` (per-word floor), `MIN_BLOCK_CONF=70.0` (whole-image "is text" floor), `MIN_BLOCKS_FOR_DIAGRAM=5`.

`read(path,…)` → `read_image(Image.open(path),…)` (FACT :330-365):
1. `_prepare(img, scale)`: if the mode is RGBA, LA or P, convert to RGBA and alpha-composite onto white. Then `convert("L")`. If scale > 1, resize by ×scale with `Image.LANCZOS` (:102-112).
2. `_read_words`: `PyTessBaseAPI(psm=PSM.SPARSE_TEXT (11), lang, path=tessdata)` → `SetImage`, `Recognize`, then iterate at `RIL.WORD`. For each word: text, `Confidence`, `BoundingBox`. Skip on RuntimeError, empty text, conf < 25 or box None (:115-136). No other Tesseract config variables or OEM are set.
3. `_cluster_blocks(words, gx=1.6, gy=0.9)`: h = median word height. Each word box is grown by px = 1.6h horizontally and py = 0.9h vertically. Union-find over all overlapping pairs (O(n²)). Blocks are sorted by `(round(top/(2h)), left)` (:163-202). A block's text is its words grouped into lines (`_group_lines`: sort by ymid, tolerance = 0.6·median height vs the mean ymid of the current line, sort each line by left) and joined with spaces.
4. Drop blocks with `len(text) <= 2 and conf < 80`, which removes arrowheads and gateway glyphs (:353-355).
5. Grid detection `_grid_rows`: rows are formed by top edge within 1.5·median word height (`_rows_of`). `_is_grid` needs ≥ 2 rows with ≥ 2 blocks; width = mode of those row lengths (≥ 2); rows of that width must number ≥ max(2, 0.6·full rows); and in every column, max(left) − min(left) ≤ 2.5·median word height (:280-312).
6. Render: for a grid, each row becomes `| c1 | c2 |` (pipes escaped, padded or truncated to width, **no separator row**). For a non-grid, block texts are joined with `\n\n` (:315-327).
7. `confidence = mean(word conf)`, or 0 if there are no words. `OcrResult(text, confidence, words, blocks, is_table)`. `is_text` = text non-empty and conf ≥ 70. `is_diagram` = is_text and not is_table and blocks ≥ 5 (:244-277).

`_render_line` (gap > max(2.5·median gap, 1.5·height) becomes ` | `) is defined but not used by `read_image` (FACT :230-241). **INFERRED**: legacy code.
CLI: `python -m backend.ingestion.pptx_ocr img1 img2…` prints `===== name (conf X, text|decorative / unreadable) =====` followed by the text (FACT :377-386).

---

## 4. PowerPoint connector flows (`pptx_flow.py`) — exact, preferred

Constants (FACT pptx_flow.py:25-51): `SNAP_FRACTION=0.04` (of slide width), `LABEL_FRACTION=0.10`, `STRAIGHT_EMU=100000`. `GATEWAY_SYMBOLS={"mathMultiply":"XOR","mathPlus":"AND"}`, `GATEWAY_SHAPES={"diamond","flowChartDecision"}`. `FURNITURE = ^(app name|done|n/?a|pull list|present|tbd|note)\s*$` (case-insensitive).

`slide_flows(src)` (FACT :331-349): open the zip and read the slide width from `ppt/presentation.xml` with regex `sldSz[^>]*cx="(\d+)"` (default 9144000). For every `ppt/slides/slide(\d+).xml`, call `to_mermaid(parse_slide(xml, n, width))` and keep the non-empty results.

Parsing is regex-only, with no XML parser (FACT :30-39, :91-150):
- Each `<p:sp>…</p:sp>` gives a Shape: id from `<p:cNvPr id="N"`, geom from `<a:prstGeom prst="…"` (default "rect"), `<a:off x y>`, `<a:ext cx cy>`, and text = the stripped `<a:t>` runs joined by spaces. Shapes whose geom is `mathMultiply`/`mathPlus` are recorded as gateway symbols at their centre point and are not kept as shapes.
- Each `<p:cxnSp>`: if it has both `<a:stCxn id>` and `<a:endCxn id>`, it becomes edge (st, en) and its bbox (off+ext) is stored in `boxes[pair]`. Otherwise, if it has geometry, it is "loose": endpoints p0/p1 come from the bbox corners, adjusted by `flipH="1"`/`flipV="1"`, together with any known endpoint.
- `_attach_loose`: an unknown endpoint is snapped to the nearest shape whose **box-edge distance** is less than width·0.04. The edge is added only if a ≠ b.
- Gateways: a shape with geom in GATEWAY_SHAPES and **no text** is a gateway. Its type comes from a symbol whose centre lies within (cx, cy) of the diamond centre; the default is XOR.
- `_split_through`: for an edge whose bbox is a straight run (min(w, h) ≤ 100000 EMU), shapes with text (or gateways), not conditions, whose centre lies inside the bbox ± 60000 EMU pad are inserted into the chain. They are ordered by squared distance from the start shape's centre. Edges touching non-parsed shapes (pictures, groups) are kept unchanged.
- Duplicate edges are removed with order preserved (`dict.fromkeys`).
- `to_mermaid`: skip condition shapes (text starts with "condition"), FURNITURE, and text-less non-gateways. Keep edges whose ends are both known shapes. `_assign_labels`: each `Condition: …` caption (sorted by id) goes to the nearest edge anchor (bbox centre, or the midpoint of the two shape centres) within width·0.10 that is not yet labelled. The `^condition\s*:\s*` prefix is stripped.
- Output:
```
flowchart LR
    n{id}{"XOR"}            # gateway
    n{id}(["text"])         # ellipse
    n{id}["text"]           # other (" -> ', newlines -> space)
    n{a} -->|"label"| n{b}  /  n{a} --> n{b}
```
CLI: `python -m backend.ingestion.pptx_flow deck.pptx [slide…]`. With no slides given, it prints the first 3 (FACT :352-360).

---

## 5. Table detection in images (`table_cv.py`)

Constants (FACT table_cv.py:37-67): EDGE_STEP=10, MERGE_TOL=4, BORDER_COVERAGE=0.6, MIN_COLUMN_SPAN=0.5, CROSSING_SHARE=0.05, MIN_COLUMN_WIDTH=20, MIN_ROWS=2, MIN_COLS=2, MIN_FILLED_CELLS=4, MIN_CELL_CONF=45.0, CELL_SCALE=4, MIN_TABLE_CONF=75.0, BORDER_BAND=3, MIN_CELL_CONTRAST=20. `_EDGE_JUNK` regex strips leading `[\s|\[\]{}()_‘'`"~,.:;!-]+` and trailing `[\s|\[\]{}_‘'`"~,:;!]+`.

`find_tables(gray, lang, tessdata, scale=4)` (FACT :430-488):
1. `_line_masks` (:91-113): compute |Δy| and |Δx| on int16. A step is a value ≥ 10, giving binary 255 masks ey and ex. `horiz = MORPH_OPEN(ey, RECT(max(15, w//60), 1))`, `vert = MORPH_OPEN(ex, RECT(1, max(12, h//40)))`.
2. `ink = adaptiveThreshold(gray, 255, ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY_INV, blockSize 15, C 12)`. Pixels under `dilate(horiz|vert, 3×3)` are zeroed, then the result is cast to bool. `lines = horiz|vert`.
3. `_find_grids` (:210-267):
   - Segments come from connectedComponentsWithStats (8-connectivity). hs: w ≥ 30 and h ≤ 8. vs: h ≥ 10 and w ≤ 8.
   - Keep a vertical only if it touches (tolerance 4) horizontals in ≥ 2 distinct `y//8` bands.
   - Rows: horizontals touching ≥ 2 verticals, or spanning ≥ 60% of the width and touching ≥ 1. Then add continuation horizontals that touch a vertical and are collinear (±4) with an existing row adjacent to it.
   - Draw hs+vs onto a grid mask, dilate 9×9, and take each connected component as a candidate grid.
   - ys/xs = clustered segment midpoints (tolerance 4, mean). Add the grid's outer edges when they are more than 8 px from the first or last line.
   - `_table_body` keeps the longest run of rows sharing a column layout, allowing 1 odd row. A column counts if it covers ≥ 50% of the rows; per-row column presence needs vertical coverage ≥ 0.6. Columns < 20 px apart are deduplicated, keeping the one with better coverage.
   - The grid is kept if rows ≥ 2 and cols ≥ 2.
4. `_merged_cells` (:270-308): union-find over adjacent cells whose shared border has coverage < 0.6. Non-rectangular groups are split back into single cells. `_split_unless_crossed` (:311-352) undoes a merge when no ink crosses the missing border (mean > 0.05 counts as crossed) and ≥ 2 sub-spans contain ink. It works recursively by rows, then by columns.
5. Per merged group, `_ocr_cell` (:382-427), with one `PyTessBaseAPI(psm=PSM.SINGLE_BLOCK (6))`:
   - Crop inside the border.
   - Paint border strokes within a 3 px frame using the median of the non-ruled pixels.
   - If max − min < 20 or Otsu ink pixels < 8, the cell is empty.
   - Resize ×4 with INTER_LANCZOS4, Otsu binarize, and invert if more than 50% is dark.
   - `_is_checkbox` → "☑" or "" at confidence 100 (:354-379): the largest component is square (aspect 0.75–1.33, height ≥ 45% of the cell), fill ≤ 50%, other ink ≤ 30%, all 4 sides have ≥ 85% coverage, and the inner fill is > 12% for ticked.
   - Otherwise add a 20 px white border, call `GetUTF8Text`, collapse whitespace, strip edge junk, and read `MeanTextConf`.
   - Reject if: (conf < 45 and len ≤ 3); alphanumeric characters < 50% of the non-space/dot/comma characters; or a lowercase fragment of length ≤ 2 with conf < 90.
6. A row-spanning cell whose words are ≥ the span and contain ≤ 2 distinct words (e.g. "CO CO CO") is re-queued as per-row cells. Text is written into column c0 of **every row it spans** (row-spans repeat; col-spans keep only the first column).
7. Drop empty rows. Reject the table if filled < 4 or rows < 2. Drop unused columns, then reject if cols < 2. Reject if mean confidence < 75.
8. `Table.to_markdown()` (:79-88): `| a | b |` with the separator `|---|---|` after the first row. Pipes become `\|` and newlines become spaces. Tables are sorted by (top, left).

Reported accuracy: 94% of cells exact on 6 reference tables (docs/conversion.md).

---

## 6. Flowchart detection in images (`flow_cv.py`)

Constants (FACT flow_cv.py:43-66): EDGE_STEP=24, MIN_NODE_AREA=0.0012, MAX_NODE_AREA=0.12 (fractions of the image area), ARROW_RATIO=2.2, MAX_GATE_PART=0.004, MIN_CONTENT=0.01, MIN_SOLIDITY=0.85, MIN_PART_AREA=0.0001, MIN_NODES=3, MIN_ARROWED=3, MIN_ARROWED_SHARE=0.4, MIN_NAMED_SHARE=0.6.

`find_flow(gray, lang, tessdata) -> Flow|None` (FACT :289-364):
1. `_edges`: mark pixels where |Δ| ≥ 24 vertically or horizontally, then dilate 3×3 to get the stroke mask.
2. `_shapes` (:144-230):
   - Take connected components (4-connectivity) of the non-stroke pixels. Drop components that touch the border, have area > 0.12·total, or have area < 0.0001·total.
   - Fill each component's external contours to get `whole`.
   - Small pieces (area ≤ 0.004·total, aspect between 1/3 and 3) are filled by their convex hull into a `parts` mask; these are candidate gateway pieces.
   - Otherwise the component needs solidity (whole.sum ≥ 0.85·hullArea). Skip it if content (holes) < 0.01·area **and** fill > 0.9.
   - The bbox is padded by 4 px and the mask dilated with a 9×9 kernel.
   - Merge "tiling" interiors (same left/right within 6 px and vertically adjacent within 1 px, or the horizontal equivalent) repeatedly.
   - MORPH_CLOSE 9×9, then `_ideal_kind`: argmax of {box: mask mean, event: IoU with a filled ellipse, gateway: IoU with a diamond polygon}.
   - Gateway pieces: dilate `parts` 9×9 and take 8-connected components with area ≥ 0.0012·total and aspect 0.6–1.7. These become kind "gateway".
   - Remove shapes fully contained in a larger kept shape (processed in descending area order).
3. If there are fewer than 3 shapes, return None. Build an `owner` map (pixel → shape index).
4. Connectors:
   - `dark = adaptiveThreshold(gray, 255, MEAN_C, BINARY_INV, 25, 15)`.
   - `lines = dark` with the dilated(5×5) owner area zeroed. `ink = dark & owner<0`.
   - `reach` = owner dilated 15×15. `near` = (owner+1) dilated 15×15 as uint16.
   - For each 8-connected piece of `lines` with max(w, h) ≥ 15: `ids` = the near-labels where the piece touches reach. Skip if fewer than 2.
   - `line_half` = max(60th percentile of the piece's distanceTransform, 0.7).
   - For each touched node: `_arrowhead` takes a window of radius max(8, round(min(H, W)/85)) around the mean contact point on `ink`. It is a head if `distanceTransform(L2, 3).max() ≥ 2.2·line_half + 0.5`.
   - Heads and tails present: add every tail→head edge (and count them as arrowed). No heads and exactly 2 tails: add one edge ordered by (left, top).
5. Reject unless arrowed ≥ 3 and arrowed ≥ 0.4·edges.
6. Labels: `PyTessBaseAPI(psm=SINGLE_BLOCK)` per used node. Inset is 0.22 for non-box shapes and 0.04 for boxes. `_read`: if the crop's max − min < 30, return "". Otherwise resize ×3 with LANCZOS4, Otsu, invert if more than 50% dark, add a 20 px border, OCR, and return "" if `MeanTextConf < 40`. Strip leading `[^\w(]+` and trailing `[^\w).?]+`.
7. A gateway whose text is ≤ 3 characters is typed by `_gateway_type`: the word XOR/AND/OR if present. Otherwise take the central half crop, Otsu ink, and compute a cross band (band = min/8) vs the diagonal mean. If cross > 0.9 and cross/2 > diag, it is AND; else XOR.
8. Reject if fewer than 60% of non-gateway used nodes contain `[A-Za-z]{3,}`.
9. `Flow.to_mermaid()` (:87-102) uses `flowchart LR` and only nodes that appear in edges. Gateways are `n{id}{"text"}` and events are `n{id}(["text"])`. Boxes are `n{id}["text"]`. Text falls back to the kind name, and `"` becomes `'`. Edges are written `n{a} --> n{b}` (no labels), sorted.

Reported accuracy: 61% arrow recall and 81% precision on 75 slides (docstring). The docs say 60% recall and 82% precision.

---

## 7. XML (`xml_tables.py`)

`xml_to_markdown(src, title)` (FACT xml_tables.py:151-196):
- Read the file as utf-8 with replace. If reading fails: `# {title}\n\n*Error reading XML file: {exc}*\n`. If `ET.parse` fails: a heading, then `*Note: XML parser reported an error: {exc}. Displaying raw content below.*` and the raw text in an ```xml fence.
- Lines: `# {title}\n`, then `> **Root Element**: \`{root}\`\n` if the root tag ≠ title. Root attributes become `### Document Attributes\n` plus a table (Attribute | Value, keys rendered as `**@k**`).
- `_render_element(root, level=2)`, recursive (FACT :45-148). prefix = `#`·min(level, 6).
  - Non-repeated leaf children with text, plus the element's attributes (`@attr`), form a `Field | Value` table with keys bolded.
  - Each child tag occurring more than once gets the heading `{prefix}# {tag} ({n} entries)\n`. Its columns are, in first-seen order, the `@attrs` and leaf sub-tags, plus `Text` if any item has its own text. The result is a multi-row table.
  - If there are no columns: leaf items with text become paragraphs. Others get the heading `{prefix}## {tag} [{idx}]` and are rendered recursively at level+2.
  - Mixed content (the element's own text plus children) is emitted as a paragraph.
  - Non-repeated complex children get `{prefix}# {tag}\n` and are rendered recursively at level+1.
- Table format: `| h1 | h2 |`, then `| :--- | :--- |`, then rows (pipes escaped, newlines become spaces), then a blank line.
- Always appended: `\n---\n\n## Raw XML Source\n` and an ```xml fence. This is truncated to the first 2500 lines followed by `... [N lines truncated] ...`.

---

## 8. Mail (`mail_reader.py`)

- **.msg** (OLE2 via `olefile`, FACT mail_reader.py:63-97): walk the streams named `__substg1.0_XXXXTTTT`. The tag maps to a field: `0037` subject, `0C1A` sender_name, `0C1F` sender_email, `0042` sent_representing, `0E04` to, `0E03` cc, `0E02` bcc, `1000` body, `1013` html, `007D` headers, `001A` message_class, `3707` attach_name, `3704` attach_short_name. The type decides decoding: `001F` → utf-16-le, `001E` → cp1252, else utf-8 (all with replace and trailing NULs stripped). The first value for a field wins. Attachments are keyed by storage (`entry[0]`) and sorted. The date is parsed from the `Date:` line in the transport headers with `parsedate_to_datetime(...).isoformat()`, falling back to the raw value. A file that is not OLE raises `MailError("{name} is not a readable Outlook message: …")`.
- **.eml** (`email.message_from_bytes(policy=default)`, :110-140): walk the non-multipart parts. A part with a filename or `attachment` disposition counts as an attachment (named `(unnamed attachment)` if it has no name). The first text/plain becomes the body and the first text/html becomes html. From fills both sender_name and sender_email.
- `to_markdown` (:169-187): `# {subject or stem}`, a blank line, then `| Field | Value |` / `| --- | --- |` with rows From, To, Cc, Date and (if any) Attachments (joined by ", "). Empty rows are dropped and `|` is escaped. The sender is `"name <email>"` when the email is not already in the name. Then the body; if the body is empty, the html is used with tags stripped, whitespace collapsed and entities unescaped; otherwise `*(no message body)*`.
- `to_html`: a small styled HTML page used only for previews (:190-212).

---

## 9. Spreadsheets (`xlsx_tables.py`) — `*_xlsx.md` content

`workbook_to_markdown(path, title)` (FACT xlsx_tables.py:151-166) uses `load_workbook(data_only=True, read_only=False)`, so formulas give their **cached values**. Output: `# {title or stem}`, then one `sheet_to_markdown(ws)` per worksheet, joined by `\n\n` and ending with a trailing `\n`. **Images and charts in workbooks are not read.**

`sheet_to_markdown` (:115-140):
1. `## {sheet title}`.
2. `_grid`: values are formatted by `_fmt`:
   - None → "", bool → TRUE/FALSE.
   - datetime at midnight → `%Y-%m-%d`, otherwise `%Y-%m-%d %H:%M`; date → `%Y-%m-%d`; time → `%H:%M`.
   - An integral float becomes an int string; everything else is `str().strip()`.
   - Rows are padded to the maximum width. **Vertical** merges (min_col == max_col) copy the anchor value down the rows; horizontal merges keep the value in the first cell only.
3. `_trim`: drop blank rows and blank left/right edge columns.
4. `_split_titles`: leading rows with ≤ 1 non-empty cell become plain paragraphs (titles). Then trim again.
5. An empty sheet gives `_Empty sheet._`. If width > `MAX_COLS=40`, output `_{rows} rows x {cols} columns; too wide to render as a table._`.
6. `_table`: the first row is the header. Empty header cells become `col{i+1}`. Separator: `|` + `|`.join([" --- "]·w) + `|`. Cells are escaped: `|` → `\|`, `\n` → `<br>`, `\r` removed.

CLI: `python -m backend.ingestion.xlsx_tables a.xlsx …` prints to stdout.

---

## 10. BPML process-house export → Markdown (`bpml_markdown.py`)

Purpose: `knowledge_base/BPML_Process.xlsx` (a Signavio export: 1 row per process, 17 columns) becomes `knowledge_base/BPML_Process_xlsx.md` as **records, not a table** (FACT bpml_markdown.py:1-37). The table rendering it replaces was padded to 119 columns.

- Required columns (header `_fix`ed). A missing one raises `ValueError("… is not a BPML process export: no … column")`: `Process Name, Root Path, Description, Accountable Organization, Process Type, Status, Inputs, Outputs, Roles (Responsible), Activities` (FACT :43-48, :143-145).
- `_fix(value)`: `str.encode("mac_roman").decode("cp1252")`, falling back to the raw string on error. Then replace U+00A0 with a space and strip (:84-96).
- Row filter: skip names in `{"", "To be Deleted", "Sub process"}` or starting with `"DELETE "`. Remove a `?` that follows a word character and precedes whitespace or the end (`(?<=\w)\?(?=\s|$)`) (:150-154).
- Code: `CODE_LINE = ^(\d+(?:\.\d+)+)\s+(.*)$` on the name. Root Path is split on `>`, with leading `Process House` / `EtE Processes` segments dropped.
- `level_of`: `X.0` → 1, otherwise the number of segments. `parent_of`: `4.5` → `4.0`; `4.5.1.4` → `4.5.1`. `sort_key` is numeric per segment (:62-81).
- Activities (`_activities`, :120-131): split on `" | "`, strip `:?\s*«position-offset:(\d+)»`. Sort by (rank: `(evStart)`=0, `(evEnd)`=2, else 1; offset or 10⁶; original index).
- `build` (:173-223):
  - A duplicate code keeps its first row, fills blanks from later rows and appends new activities.
  - Codes named only in a Root Path get synthesized records (`synthesised=True`).
  - Parent = `parent_of(code)` if that code exists, else the last numbered segment of the path, else the record is a root.
  - Objects (rows without a code) go under their path owner.
  - Children are sorted with objects first, then by numeric code.
- `render` (:242-276):
```
# BPML Process House

The Solvay process house (BPML), exported from Signavio: one section per process, nested under its parent. Each section gives the process's level, its path in the house, its type and status, who is responsible, and then its description and activities.

## 1.0 Name                (heading depth = tree depth+1, capped at ######)

- **Level:** N
- **Path:** A > B > C
- **Process type:** …  - **Status:** …  - **Accountable organisation:** …  - **Roles:** …  - **Inputs:** …  - **Outputs:** …   (only non-empty, one per line)
- **Note:** The export has no row for this process; it is named in the path of its sub-processes.   (synthesised only)

<description; lines starting with #, |, ``` or "- **" are backslash-escaped; 3+ newlines collapse>

**Activities:**

- activity 1

- activity 2          (blank line between items so the chunker can split)
```
- Read-back API (used by `backend/agents/fitgap/bpml.py` and `backend/graph/knowledge_graph.py`):
  - `sections(text)` parses headings `^#{2,6}\s+`, fields `^- \*\*(.+?):\*\*\s?(.*)$`, description lines and `- ` activity lines. It works on the chunks joined back together.
  - `parse(text)` returns the numbered processes as `{code, name, description, process_type, status, accountable, roles, inputs, outputs}`.
  - `hierarchy(text)` returns `{"parent":{code:parent}, "name":{code:name}}` and covers lettered BPMN codes too: `BPMN_CODE = ^([A-Za-z][A-Za-z0-9]{0,3}-\d{2,3}(?:-\d{2,3})*)\s+(.*)$` (FACT :282). Kind suffix: `\s*\((task|subProcess|ev[A-Z]\w*|\w*[Gg]ateway)\)(?:\W.*)?$` (FACT :286). Rank priority: own heading/task/subProcess = 0, object section = 1, event reference = 2, path mention = 9. Ties go to the earlier occurrence in the document. A code's name comes from its winning entry; its parent comes from the best entry that has a parent other than itself (FACT :354-416).
  - Host of an activity (FACT :383-407): in a numbered section the host is the section's own code. In any other section the host is the last numbered segment of its Path. When that section's heading is itself a lettered code (an object section, e.g. `T-050-050 …`), an activity whose code **extends** it (starts with `T-050-050-`) is placed under that lettered code, not under the numbered ancestor. An activity with an unrelated code keeps the numbered host. Before this rule, `T-050-050-020` in the `T-050-050` section filed under `8.0` was parented to `8.0`, a sibling of its own parent.
- CLI: `.venv/bin/python -m backend.ingestion.bpml_markdown [--source X.xlsx] [--target Y.md] [--index]`. `--index` calls `backend.rag.rag.index_path(target, force=True)` (FACT :419-435).

---

## 11. Vision models

### 11.1 Local: Qwen3-VL (`vlm_ocr.py`)
- `MODEL = "mlx-community/Qwen3-VL-8B-Instruct-4bit"`, loaded once via `mlx_vlm.load` with transformers logging set to error (FACT vlm_ocr.py:39, :125-136). The first run downloads about 5.4 GB to `~/.cache/huggingface` (docs).
- `_ask(path, prompt, max_tokens)`: `_shrink` scales the long edge down to `MAX_EDGE=2400` (LANCZOS, temp PNG via mkstemp, deleted afterwards). Then `apply_chat_template(processor, model.config, prompt, num_images=1)` and `generate(model, processor, formatted, [img], max_tokens, temperature=0.0, verbose=False)`, returning `.text.strip()` (:139-179).
- Gates: `MIN_WORDS_FOR_VLM=20`, `MIN_PIXELS_FOR_VLM=200*150` (:43-45).
- `read(path)`: `DOC_PROMPT` with max_tokens 4096. Unwrap a whole-answer fence matching ``^\s*```(markdown|md)?\n(.*?)\n?```\s*$``. Remove `<!-- image -->` and strip. If the count of ``` fences is odd, append a closing fence. Run `_tidy` on each mermaid block (:187-200).
- `read_flow(path)` (:262-294):
  1. Ask `IS_FLOW_PROMPT` with max_tokens 4. Unless the answer starts with YES, return None.
  2. Ask `FLOW_PROMPT` with `FLOW_MAX_TOKENS=4096`.
  3. Extract the first fenced block (`/```(?:mermaid)?\s*(.*?)```/s`). If the fence is unclosed, strip the opening fence and drop a final line that does not end in `] } ) "`.
  4. The body must start with `flowchart` or `graph `.
  5. Reject it if `looks_degenerate` (≥ 6 non-empty lines and unique/total < 0.5) or if there are fewer than 3 edges (`\b[A-Za-z]\w*\s*(?:--+>|-\.-*->|==+>)`).
  6. Return `_tidy(body)`.
- `_tidy`/`_clean_label` (:203-249): split each line on arrows `((?:--+>|-\.-*->|==+>|--+[xo])\s*(?:\|[^|]*\|)?)`. Edge labels become `|"label"|`. Node shapes matching `^(\s*)([A-Za-z]\w*)(\(\[|\[\[|\(\(|\{\{|\[\(|\[|\(|\{|>)(.+)$` get quoted labels, using the last matching closer. In labels, `<br>` and `\n` become a space, `"` becomes `'`, and whitespace is collapsed. (Mermaid is rendered with `securityLevel:"strict"`.)
- `is_better_than(vlm_md, ocr_text)` (:311-322): False if empty or degenerate. True if the answer contains `---|` or `| ---` (a table). Otherwise `len(vlm) >= len(ocr)`.

**Prompts (verbatim, FACT vlm_ocr.py:58-111):**

`DOC_PROMPT` (also used by the cloud providers):
```
Convert this document image into clean, accurate Markdown.

Follow these formatting rules:
1. OUTPUT PURITY:
   - Output ONLY the direct Markdown.
   - Do NOT include conversational text, greetings, explanations, or closing comments.
   - Do NOT wrap the entire response in ```markdown ... ``` code fences.

2. TABLES & DATA STRUCTURES:
   - Preserve all tables in standard GitHub Flavored Markdown (GFM) table format with their real rows and columns.
   - If a cell contains multiple lines of text, join them with <br> (never insert a raw newline inside a table row).
   - Escape any literal pipe symbols inside cells as \|.
   - Preserve empty cells (| |) so columns stay properly aligned; do not shift values left.
   - For multi-level headers, flatten into "Category - Subheader" or repeat parent headers.

3. VERBATIM ACCURACY:
   - Transcribe all text, numbers, codes, dates, and amounts exactly as shown without rounding or autocorrecting.
   - If text is partially obscured or illegible, write [illegible] instead of hallucinating.

4. HIERARCHY & FORMATTING:
   - Use Markdown headings (#, ##, ###) for visual section titles.
   - Preserve bullet points, numbered lists, and checkboxes ([ ] / [x]).
```
`IS_FLOW_PROMPT`:
```
Look at this image.

Answer YES if it is a diagram of a process: boxes, diamonds or circles joined by arrows showing the order steps happen in. Cycles and swim-lane diagrams count as YES.

Answer NO if it is anything else: a screenshot of software, a table or spreadsheet, a data-entry form, a photo, a logo or a chart.

Answer with exactly one word: YES or NO.
```
`FLOW_PROMPT` (the comment warns that changing the wording invalidates the 48% recall / 63% precision benchmark):
```
This image is a business process flowchart.

Convert it to Mermaid flowchart code.

Rules:
- Start with `flowchart TD`.
- Every box, diamond and rounded shape in the image becomes one node whose
  label is the exact text inside that shape.
- Every arrow in the image becomes one edge `A --> B`, following the
  arrowhead: the tail shape is A, the shape the head points at is B.
- If an arrow has a label beside it, write it as `A -->|label| B`.
- Only output arrows you can actually see. Do not invent connections.
- Output only the Mermaid code block, nothing else.
```

### 11.2 Cloud: OpenAI / Claude via Docling VLM pipeline (`vlm_api.py`)
| provider | label | url | key env | model env | default model | token param |
|---|---|---|---|---|---|---|
| `openai` | GPT (OpenAI API) | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | `OPENAI_VLM_MODEL` | `gpt-5` | `max_completion_tokens` |
| `claude` | Claude (Anthropic API) | `https://api.anthropic.com/v1/chat/completions` (Anthropic's OpenAI-compatible endpoint) | `ANTHROPIC_API_KEY` | `CLAUDE_VLM_MODEL` | `claude-opus-5` | `max_tokens` |
(FACT vlm_api.py:63-80)

Converter per provider (cached in `_converters`, FACT :103-159):
```python
VlmPipelineOptions(enable_remote_services=True,
  vlm_options=VlmConvertOptions(
    model_spec=VlmModelSpec(name=model, default_repo_id=model, prompt=DOC_PROMPT,
                            response_format=ResponseFormat.MARKDOWN, max_new_tokens=16000),
    engine_options=ApiVlmEngineOptions(engine_type=VlmEngineType.API, url=p.url,
        headers={"Authorization": f"Bearer {key}"},
        params={"model": model, "temperature": None, p.token_param: 16000},
        timeout=300),
    scale=1.0, max_size=2000))
DocumentConverter(format_options={InputFormat.IMAGE: ImageFormatOption(pipeline_cls=VlmPipeline, pipeline_options=options)})
```
`read(path, provider)` (:162-173): set the `docling.utils.api_image_request` logger to ERROR. Call `convert(path, raises_on_error=False)` and `export_to_markdown()`, remove `<!-- image -->` and strip. If the result is empty, raise `VisionApiError("{label} returned no text ({errors or 'empty answer'})")`. Collapse 3+ newlines to 2. Cloud providers **never trace flows**. Flows stay with flow_cv, or with Qwen `read_flow` when the provider is qwen. Only images that pass the gates (≥ 20 words, ≥ 30k px, is_text) are uploaded.

---

## 12. Preview rendering (`preview.py`)

- `find_soffice()`: `which soffice` or `which libreoffice`, else the first existing of `/Applications/LibreOffice.app/Contents/MacOS/soffice`, `/usr/bin/soffice`, `/usr/local/bin/soffice`. `find_pdftoppm()` = `which pdftoppm`. `PREVIEW_DPI=90`, `CONVERT_TIMEOUT=300` s (FACT preview.py:19-47).
- `render(src, out_dir, dpi=90) -> int` (FACT :159-176):
  - An image goes through `image_to_png` to `page-0001.png` and the function returns 1.
  - Otherwise `work = out_dir/.work`. `src = _readable(src, work)`:
    - json → re-indented `.txt` stand-in (malformed json is passed unchanged);
    - msg/eml → `mail_reader.to_html` written to a `.html` stand-in.
  - A non-PDF goes through `_to_pdf`, then `_to_pngs`. Each output is renamed to `out_dir/page-{i:04d}.png`. Finally `work` is removed (rmtree).
- LibreOffice command (FACT :59-74):
  `[soffice, "--headless", "--norestore", f"-env:UserInstallation={(out_dir/'lo-profile').resolve().as_uri()}", "--convert-to", "pdf", "--outdir", str(out_dir), str(src)]`
  Each job gets its own profile so concurrent runs do not collide. If no `*.pdf` is produced, it raises `PreviewError` with the last 400 characters of stderr/stdout.
- pdftoppm command (FACT :86-91): `[pdftoppm, "-png", "-r", str(dpi), str(pdf), str(out_dir/"page")]`. The output `page-*.png` files are sorted (pdftoppm pads its own numbers), and an empty result raises `PreviewError`.
- The two-hop path exists because `soffice --convert-to png` exports only the first slide.
- Error messages: `"LibreOffice not found. Install it with: brew install --cask libreoffice"` and `"pdftoppm not found. Install it with: brew install poppler"`.
- Used by: the upload endpoint (`job/preview`, 90 DPI), and the PDF OCR path in converter (`media_dir`, 150 DPI).

---

## 13. Chunking (`md_chunker.py`)

Constants (FACT md_chunker.py:38-48): `TARGET_TOKENS=500`, `MAX_TOKENS=1000`, `MIN_TOKENS=120`. Token estimate = `max(1, len(text)//4)`. **No overlap.**
Front matter regex: `\A---\r?\n.*?\r?\n---\r?\n` (DOTALL). Source-name regex: `^(.*)_(pptx|docx|xlsx|pdf|png|jpe?g)$` (case-insensitive) produces the title `"{stem} ({ext})"`; any other stem is used as is.

Algorithm (FACT :106-328):
1. `parse_blocks`: strip the front matter (once), strip **all** `<!-- … -->` comments (DOTALL), then split into lines:
   - A line starting with ``` begins a fence that runs to the next ``` line. A closing ``` is always appended, which also closes an unterminated fence. Kind `code`.
   - A run of lines starting with `|` is kind `table`. `_drop_empty_columns` removes columns with no data values whose header is empty or matches `col\d+`, rewrites the separator as `| --- |…`, and returns "" if no column survives.
   - A line matching `^(#{1,6})\s+(.*?)\s*#*\s*$` with non-empty text is kind `heading` (level = number of #).
   - A blank line flushes the paragraph. Other lines are stripped and appended to the paragraph (joined with `\n`).
   - All block text is `html.unescape`d.
2. `_sections`: start a new section at each heading.
3. `_join_small`: carry a section forward while its token total is < 120 **or** its last block is a heading. Leftover carry at the end is appended to the previous section.
4. `_fit` per block: limit = 500 for tables and 1000 for others. Blocks over the limit are split:
   - table → `_split_table`: the header plus separator repeat on every piece. Pieces are evenly sized at per_piece = total / ceil(total/500).
   - code → `_split_code`: cut by lines at 500 tokens. Each piece keeps the opening fence and the `flowchart|graph` first line and ends with ```.
   - paragraph → `_split_paragraph`: split on `(?<=[.!?;])\s+`. Sentences over 500 tokens are hard-cut at the last space before 2000 characters.
5. `_pack`: add blocks until the chunk has size ≥ 120 and size + next > 500. Then cut, but never end a chunk on trailing headings (they move to the next chunk).
6. Heading path: keep a stack of (level, text). For a chunk, `above` = stack headings with level < the minimum heading level inside the chunk, and `own` = deduplicated headings inside it. `headings = above + own-not-in-above`. Update the stack as the chunk's headings are processed. Content = blocks joined with `\n\n`, with headings re-rendered as `#… text`.
7. `Chunk(source=md filename, title=document_title(path), index, headings, content, tokens)`. `heading_path = " / ".join(headings)`. `embedding_text()` = `"Document: {title}\nSection: {heading_path}\n\n{content}"`; the Section line is omitted when there is no path.

Fingerprint for re-index skipping (rag.py, not ingestion; FACT rag.py:720-739): `sha256(f"{EMBED_MODEL}:{EMBED_DIMENSION}:{TARGET}:{MAX}:{MIN}\n" + strip_front_matter(text).lstrip("\r\n"))`.

---

## 14. CLI entry points

| Command | Args | Output |
|---|---|---|
| `python -m backend.ingestion.pptx_to_md DOC` | `-o/--out-dir` (default `out`), `--lang` (default `eng`), `--tessdata`, `--scale` (int, default 3), `--no-ocr`, `--no-flows`, `--vlm`, `--vlm-provider {qwen,openai,claude}` (default qwen; a non-qwen value implies --vlm) | `out/{stem}.md` (**no** `_ext` suffix). Media go to `out/media/` and are persisted. Prints stats (FACT pptx_to_md.py:15-83) |
| `python -m backend.ingestion.folder_to_md FOLDER` | `-o/--out-dir` (default `FOLDER/markdown`), `-r/--recursive`, `--vlm`, `--vlm-provider` | `{stem}{_ext}.md`, e.g. `report_pptx.md`. With -r, the relative subfolder is mirrored. Media go to a TemporaryDirectory per file. Exit code 1 if any file fails (FACT folder_to_md.py:34-113) |
| `python -m backend.ingestion.bpml_markdown` | `--source`, `--target`, `--index` | `knowledge_base/BPML_Process_xlsx.md` |
| `python -m backend.ingestion.pptx_ocr IMG…` | — | stdout |
| `python -m backend.ingestion.pptx_flow DECK [N…]` | — | stdout |
| `python -m backend.ingestion.xlsx_tables X.xlsx…` | — | stdout |

folder_to_md `FORMATS = {.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.xlsm,.html,.htm,.xml} ∪ IMAGE_FORMATS` (FACT :19-31). It skips names starting with `~$` or `.`, and anything inside out_dir. **It does NOT include .txt/.csv/.json/.msg/.eml** even though convert() supports them. It always passes `title=src.stem`, so lang, scale and tessdata are left at their defaults. Per-file progress line: `  {pages} {unit}, {pictures} image(s): {n_ocr} OCR, {tables} tables, {cv_flows} flows, {vlm+flow_images} vision model, {skipped} no text`.

---

## 15. Output files & locations (who writes what)

| Caller | Source stored at | Media dir | Markdown written to |
|---|---|---|---|
| Web single upload `POST /api/upload` → `POST /api/convert/{doc_id}?vlm=&provider=qwen` | `.workdir/{doc_id}/source{.ext}` + `name.txt` (original filename) + `owner.txt` (the uploader's user id; only that account can convert, preview, download, embed or delete the job, others get 404). doc_id = `uuid4().hex[:12]` | `.workdir/{doc_id}/media/` (persisted; served by `GET /api/docs/{id}/media/{name}`) | `.workdir/{doc_id}/output.md`. Preview PNGs go to `.workdir/{doc_id}/preview/page-NNNN.png` (FACT app.py:264-298) |
| `POST /api/docs/{doc_id}/embed?category=` | — | — | copied to `knowledge_base/{stem}{_ext}.md`, with category front matter added via `rag.declare_category`, then `rag.index_path` (FACT app.py:302-344) |
| Batch `POST /api/batch/upload` → `POST /api/batch/convert/{batch_id}` (body `{vlm=False, provider="claude"}`, SSE events `progress`/`file_done`…) | `.workdir/batches/{batch_id}/sources/{name}` + `owner.txt` (the uploader's user id; only that account can convert, download or embed the batch, others get 404) | temp dir | `.workdir/batches/{batch_id}/markdown/{stem}{_ext}.md` (FACT app.py:1264-1434) |
| Upload sessions (`backend/core/uploads.py:add_file`). Since accounts, each session belongs to the user who created it (`new_session(user_id)`), and another user's session id is refused (§04 §2.9) | `.workdir/uploads/{sid}/` | `{session}/media` | `{session}/{stem}{_ext}.md` (`md_name`), then `rag.index_file` (FACT uploads.py:59, 357, 398-415, 479-487) |
| Corpus convention | originals in `solvay-spark/<code>/` | — | `solvay-spark/<code>/markdown/{stem}_{ext}.md`. The category is the folder name (docs/ingesting-markdown.md). `rag_documents.source` stores the **absolute** path indexed from; a database restored on another machine is matched back to its files from the `solvay-spark/` or `knowledge_base/` path segment on (`_in_this_project`, bd153f1; 02 §8), and `GET /api/kb/files/{name}` searches every `solvay-spark/*/markdown/` folder |

Filename convention: `{stem}{suffix.lower().replace('.', '_')}.md`, so `Pricing.xlsx` becomes `Pricing_xlsx.md`. The review page reverses it to locate the original (tests/test_originals.py).

**Caching**: ingestion has **no on-disk content-hash cache**. `.workdir` is keyed by a random uuid per upload, not by a hash. The only caches are in memory: the per-`_ImageReader` dictionaries keyed by media filename, the Docling converter singleton, the per-provider VLM converters, and the Qwen weights loaded once. The skip-if-unchanged hashing happens at the embedding stage (rag fingerprint, §13).

---

## 16. Markdown output conventions (summary)

- Every converter **except** the generic Docling path emits `# {title}` as its first line. **INFERRED**: the Docling path gets its headings from the document itself (slide titles become `##`, etc.) and does not add a title heading.
- No YAML front matter is produced by conversion. The front matter `---\ncategory: X\n---` is added only at embed time (rag.declare_category), and the chunker strips it.
- No page markers. PPTX slide boundaries are not explicitly marked (**INFERRED**: Docling export has no page-break markers by default). Flows are labelled `### Slide N` under `## Process flows`.
- Images: always replaced by a provenance HTML comment plus the recovered text, never `![]()` links. An unprocessed picture stays as `<!-- image -->`.
- Tables: GFM pipe tables. Separator styles differ by producer: xlsx ` --- `, table_cv `---|`, xml `:---`, mail `---`, and pptx_ocr grid with **no** separator.
- Flows: fenced ```mermaid with `flowchart LR` (pptx_flow and flow_cv) or the model's `flowchart TD`/`graph` (Qwen).

---

## 17. Gaps / inconsistencies / unknowns

1. Docling pipeline options are not set anywhere (default `DocumentConverter()`), so the OCR engine, TableFormer mode and layout model are whatever Docling 2.130 defaults to (**INFERRED** from docs). Behaviour depends on the installed version and `DOCLING_ARTIFACTS_PATH`.
2. `md_chunker._SOURCE_KIND` recognises only `pptx|docx|xlsx|pdf|png|jpe?g`. Files like `X_csv.md`, `X_txt.md`, `X_xml.md`, `X_xlsm.md`, `X_msg.md` and `X_jpeg.md` (the last does match `jpe?g`) keep the raw stem as their title, e.g. "X_csv" (FACT md_chunker.py:48).
3. docs/conversion.md says folder_to_md "skips" .ppt/.doc/.xls and "only the top level is read". The code includes `.doc .ppt .xls` and has `-r` (FACT folder_to_md.py:19-31, :38-40). The docs are stale.
4. `.xls` is accepted but goes through Docling rather than openpyxl. Docling's support for legacy .xls/.ppt/.doc is unverified (**INFERRED**: possibly unsupported or converted via LibreOffice).
5. PDF path: only the first picture per page receives the page render, and text can be duplicated (documented).
6. `pptx_ocr._render_line` is unused.
7. The batch convert default provider is `"claude"`, while the single convert default is `"qwen"` (FACT app.py:1303-1305 vs 292).
8. The Qwen `read_flow` prompt asks for `flowchart TD`, while CV and connector flows emit `flowchart LR`.
9. Not examined here: how rag.declare_category formats front matter, and `rag.index_path`/`index_file` internals (see the RAG spec section).
10. Test files `backend/tests/test_converter.py`, `test_formats.py`, `test_bpml_markdown.py` and `test_originals.py` are plain-Python runners (`python backend/tests/test_x.py`) with no external services. Their assertions define the behaviours above (txt/csv verbatim, xml text retention, mail tables, json fencing, preview stand-ins, BPML round-trip, original-file lookup).
