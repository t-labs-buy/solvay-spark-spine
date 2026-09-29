"""Generate docs/system-architecture.svg — a hand-laid-out layered architecture diagram."""
import sys

W, H = 1800, 1340
out = []
a = out.append

FONT = "Helvetica Neue, Helvetica, Arial, sans-serif"
INK, MUTED = "#1F2430", "#5B6474"
ARROW, EGRESS = "#4A5262", "#7B5EA7"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=13, weight="normal", fill=INK, anchor="middle", italic=False):
    st = ' font-style="italic"' if italic else ""
    a(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
      f'text-anchor="{anchor}"{st}>{esc(s)}</text>')


def label(x, y, s, fill=MUTED, anchor="middle"):
    """Small edge label on a white pill so lines never run through the text."""
    w = len(s) * 6.1 + 10
    x0 = x - w / 2 if anchor == "middle" else (x if anchor == "start" else x - w)
    a(f'<rect x="{x0:.1f}" y="{y-11}" width="{w:.1f}" height="16" rx="8" fill="#FFFFFF" fill-opacity="0.95"/>')
    text(x0 + w / 2, y + 1, s, size=11, fill=fill)


TITLES = []


def draw_titles():
    for x, y, title, sub, fill, stroke in TITLES:
        if title == "Backend":
            x = 300  # sit between the Ask and Agents arrows
        w = len(title) * 9.2 + (len(sub) * 6.6 + 14 if sub else 0) + 28
        a(f'<rect x="{x+10}" y="{y+10}" width="{w:.0f}" height="28" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
        sb = f'<tspan font-size="12" font-weight="normal" fill="{MUTED}" dx="10">{esc(sub)}</tspan>' if sub else ""
        a(f'<text x="{x+24}" y="{y+29}" font-size="15" font-weight="bold" fill="{INK}">{esc(title)}{sb}</text>')


def band(x, y, w, h, title, fill, stroke, sub=None):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    TITLES.append((x, y, title, sub, fill, stroke))


def box(x, y, w, h, title, lines, fill="#FFFFFF", stroke="#9AA3B2", tfill=INK, lfill=MUTED, accent=None):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="1.3"/>')
    if accent:
        a(f'<rect x="{x}" y="{y}" width="{w}" height="5" rx="2" fill="{accent}"/>')
    n = 1 + len(lines)
    top = y + h / 2 - (n - 1) * 9 + 5
    text(x + w / 2, top, title, size=14, weight="bold", fill=tfill)
    for i, ln in enumerate(lines):
        text(x + w / 2, top + 19 * (i + 1), ln, size=12, fill=lfill)


def cylinder(x, y, w, h, title, lines):
    e = 9
    a(f'<path d="M{x},{y+e} A{w/2},{e} 0 0 1 {x+w},{y+e} V{y+h-e} A{w/2},{e} 0 0 1 {x},{y+h-e} Z" '
      f'fill="#FFFFFF" stroke="#D4A24C" stroke-width="1.3"/>')
    a(f'<path d="M{x},{y+e} A{w/2},{e} 0 0 0 {x+w},{y+e}" fill="none" stroke="#D4A24C" stroke-width="1.3"/>')
    n = 1 + len(lines)
    top = y + h / 2 - (n - 1) * 9 + 9
    text(x + w / 2, top, title, size=14, weight="bold")
    for i, ln in enumerate(lines):
        text(x + w / 2, top + 19 * (i + 1), ln, size=12, fill=MUTED)


def path(pts, color=ARROW, width=1.6, dash=None, head=True):
    d = "M" + " L".join(f"{px},{py}" for px, py in pts)
    da = f' stroke-dasharray="{dash}"' if dash else ""
    mk = f' marker-end="url(#{"ah-e" if color == EGRESS else "ah"})"' if head else ""
    a(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"{da} '
      f'stroke-linejoin="round"{mk}/>')


# ── canvas ────────────────────────────────────────────────────────────────
a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
  f'font-family="{FONT}">')
a('<defs>'
  f'<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
  f'<path d="M0,0 L10,5 L0,10 z" fill="{ARROW}"/></marker>'
  f'<marker id="ah-e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
  f'<path d="M0,0 L10,5 L0,10 z" fill="{EGRESS}"/></marker>'
  '</defs>')
a(f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>')

text(W / 2, 46, "Solvay Spark Spine AI — System Architecture", size=26, weight="bold")
text(W / 2, 72, "From the browser to the data stores, and the only calls that leave the machine",
     size=14, fill=MUTED)

# ── layer 1 · user ───────────────────────────────────────────────────────
a(f'<rect x="790" y="100" width="220" height="44" rx="22" fill="{INK}"/>')
text(900, 128, "Analyst / Consultant", size=15, weight="bold", fill="#FFFFFF")
path([(900, 144), (900, 196)])
label(900, 172, "HTTPS")

# ── layer 2 · presentation ───────────────────────────────────────────────
band(60, 200, 1680, 160, "Presentation", "#EDF4FF", "#8FB0E3", "React 19 SPA · Vite · /demo presenter mode")
BX = [100, 520, 940, 1360]
BW = 340
ui = [("Ask", ["RAG answer with sources", "Quality view"]),
      ("Agents", ["Evidence · InsightLens · Fit-Gap Copilot", "run history · attachments"]),
      ("Ingest", ["Extract · Batch · Add KB", "upload → convert → embed"]),
      ("Graph", ["D3 canvas · 2-hop explore", "Cypher view"])]
for x, (t, ls) in zip(BX, ui):
    box(x, 250, BW, 90, t, ls, accent="#5B8DD9")

# ── layer 3 · backend (gateway + core engines) ───────────────────────────
band(60, 400, 1680, 400, "Backend", "#EEF7F0", "#8CBF97", "FastAPI · app.py · :8000")

box(100, 450, 760, 80, "Guardrails",
    ["scope check (claude-haiku) · contact redaction · gated web search"], accent="#4E9A5E")
box(940, 450, 760, 80, "API routes",
    ["REST / JSON · SSE streams · run history · /api/ask · /api/graph · /api/fitgap"], accent="#4E9A5E")

# UI → gateway
path([(270, 340), (270, 446)]); label(270, 400, "POST /api/ask")
path([(690, 340), (690, 446)]); label(690, 400, "POST · SSE")
path([(1110, 340), (1110, 446)]); label(1110, 400, "REST · upload")
path([(1530, 340), (1530, 446)]); label(1530, 400, "/api/graph/*")
path([(860, 490), (936, 490)]); label(898, 481, "in scope")

# core engines sub-panel
a('<rect x="80" y="560" width="1640" height="220" rx="12" fill="#F8FCF9" stroke="#B9D9C0" '
  'stroke-width="1.2" stroke-dasharray="5 4"/>')
text(100, 582, "Core engines", size=13, weight="bold", fill="#3D7A4B", anchor="start")

EX = [100, 430, 760, 1090, 1420]
EW = 280
engines = [("Ingestion", ["Docling · Tesseract OCR · CV", "Qwen3-VL (MLX) preview"]),
           ("RAG engine", ["rag.py · chunk · embed", "hybrid search (BM25 + vector)", "grounded answer"]),
           ("Agents", ["Evidence · InsightLens · Fit-Gap", "tools · quote verifier", "scoring · quality gates"]),
           ("Graph engine", ["knowledge_graph.py · BFS", "NL → Cypher · Neo4j sync"]),
           ("Evaluation", ["Ragas judge · agent_eval", "RAG quality scores"])]
for x, (t, ls) in zip(EX, engines):
    box(x, 640, EW, 120, t, ls, accent="#4E9A5E")

# dispatch bus: API routes → every engine
path([(1320, 530), (1320, 606)], head=False)
path([(240, 606), (1560, 606)], head=False, width=1.8)
for x in EX:
    path([(x + EW / 2, 606), (x + EW / 2, 636)])
label(1390, 596, "dispatch")

# agent tools between engines
path([(760, 686), (714, 686)]); label(737, 676, "search")
path([(1040, 686), (1086, 686)]); label(1063, 676, "graph")

# ── layer 4 · local data ─────────────────────────────────────────────────
band(60, 838, 1680, 172, "Local state & services", "#FFF8EC", "#E3B868", "127.0.0.1 only")
DX = [100, 378, 656, 934, 1212, 1490]
DW = 210
cylinder(DX[0], 895, DW, 100, "Markdown corpus", ["pkg/markdown", "knowledge_base"])
box(DX[1], 900, DW, 92, "Ollama · :11434", ["bge-m3 embeddings", "1024-d vectors"], fill="#FFFFFF", stroke="#D4A24C")
cylinder(DX[2], 895, DW, 100, "PostgreSQL + pgvector", [":5433 · rag_chunks", "runs · docling_session"])
box(DX[3], 900, DW, 92, "Hindsight · :8888", ["agent memory", "recall · retain"], fill="#FFFFFF", stroke="#D4A24C")
cylinder(DX[4], 895, DW, 100, "knowledge_graph.json", ["source of truth", "entities · relations"])
cylinder(DX[5], 895, DW, 100, "Neo4j · :7687", ["read-only graph copy", "synced from JSON"])

# engines → local data (mostly straight drops)
path([(180, 760), (180, 891)]); label(180, 826, "write .md")
path([(455, 760), (455, 815), (260, 815), (260, 891)]); label(357, 815, "read .md")
path([(520, 760), (520, 896)]); label(520, 846, "embed")
path([(690, 760), (690, 891)]); label(690, 830, "SQL")
path([(810, 760), (810, 891)]); label(810, 830, "store run")
path([(990, 760), (990, 896)]); label(990, 830, "recall · retain")
path([(1300, 760), (1300, 891)]); label(1300, 830, "load · BFS")
path([(1350, 760), (1350, 822), (1560, 822), (1560, 891)]); label(1400, 822, "Cypher")
path([(1422, 950), (1486, 950)], dash="4 3")

# ── egress bus → external services ───────────────────────────────────────
band(60, 1090, 1680, 150, "External services", "#F3F2F7", "#A99BC6",
     "HTTPS · API keys — the only places data leaves the machine")

drops = [(344, 760, "vision (optional)"), (622, 760, "answer"), (900, 760, "tool-use · traces"),
         (1039, 992, "fact extraction"), (1178, 760, "writes Cypher"), (1456, 760, "judge · scores")]
for x, y0, lb in drops:
    path([(x, y0), (x, 1050)], color=EGRESS, head=False, width=1.6)
path([(300, 1050), (1500, 1050)], color=EGRESS, head=False, width=3)
for x, _, lb in drops:
    a(f'<circle cx="{x}" cy="1050" r="3.5" fill="{EGRESS}"/>')
for x, _, lb in drops:
    label(x, 1036, lb, fill=EGRESS)
for x in (300, 900, 1500):
    path([(300 if x == 300 else x, 1050), (x, 1131)], color=EGRESS, width=2)

def cloud(x, y, w, h, t, ls):
    box(x, y, w, h, t, ls, fill="#2F3542", stroke="#1B1F27", tfill="#FFFFFF", lfill="#C9CDD6")

cloud(160, 1135, 280, 86, "GPT / Claude vision", ["optional · Docling VLM"])
cloud(620, 1135, 560, 86, "Anthropic Claude", ["answers · agent tool-use loops · NL → Cypher · judge · web search"])
cloud(1360, 1135, 280, 86, "Langfuse Cloud", ["traces · scores · RAG quality"])

draw_titles()

# ── legend ───────────────────────────────────────────────────────────────
ly = 1290
items = [("#EDF4FF", "#8FB0E3", "Browser"), ("#EEF7F0", "#8CBF97", "FastAPI backend"),
         ("#FFF8EC", "#E3B868", "Local data & services"), ("#2F3542", "#1B1F27", "External cloud service")]
lx = 240
for f, s, t in items:
    a(f'<rect x="{lx}" y="{ly-12}" width="18" height="16" rx="4" fill="{f}" stroke="{s}"/>')
    text(lx + 26, ly + 1, t, size=12, fill=MUTED, anchor="start")
    lx += 200
path([(lx, ly - 4), (lx + 40, ly - 4)]); text(lx + 48, ly + 1, "call", size=12, fill=MUTED, anchor="start")
lx += 110
path([(lx, ly - 4), (lx + 40, ly - 4)], color=EGRESS, width=2)
text(lx + 48, ly + 1, "leaves the machine", size=12, fill=MUTED, anchor="start")
text(W / 2, 1322, "Agents reach RAG and the graph through their tools; Guardrails screen Ask and every agent run before any model is called.",
     size=12, fill=MUTED, italic=True)

a("</svg>")
open(sys.argv[1], "w").write("\n".join(out))
