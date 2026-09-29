import React, { useState, useEffect, useRef } from "react";
import "./SparkDemoFlow.css";

// ============================================================================
// ArchFlow DATA — regenerate this whole section per architecture.
// Everything below the "ArchFlow ENGINE" marker is proven, working code.
// Do not modify the engine; only touch it if a genuinely new interaction
// pattern is needed (and then port the fix back into the skill template).
// ============================================================================

// Canvas dimensions for the SVG stage. Compute from your node grid: take the
// bounding box of all NODES (max x + NW + margin, max y + NH + margin).
const STAGE_W = 1940;
const STAGE_H = 1366;

// Node card size — keep these unless you have a strong reason to change them;
// the layout math below (bubble placement, arrow clipping) assumes this size.
const NW = 180;
const NH = 76;

// One entry per component in the architecture. `external: true` marks systems
// this application depends on but doesn't own (third-party APIs, legacy
// systems, SaaS) — they render as dashed cards, matching the "dark cloud"
// convention from the Mermaid/PlantUML diagrams.
//
// Optional `desc`: 1-2 sentences shown in the node inspector (the side panel
// that opens when a node card is clicked). Write it for every node — it's the
// "what is this component and why does it exist" line. The inspector also
// derives the node's connections and step appearances automatically from
// STEPS, so desc is the only extra authoring this feature needs.
//
// LAYOUT RULES (avoid overlap, leave room for chat bubbles):
//  - Arrange nodes in columns (pipeline stages) and rows (siblings at that
//    stage). Column gap >= 100px between card edges. Row gap >= 140px
//    between card edges — bubbles need ~95-100px of clearance above/below
//    a node and must not collide with the next row.
//  - Leave >= 100px of margin above the topmost row (bubbles above a
//    top-row node render at `node.y - 101`, which goes negative / off-canvas
//    if the node is any higher than y=110).
//  - STAGE_W / STAGE_H = bounding box of (x + NW) / (y + NH) across all
//    nodes, plus ~20-40px margin.
const NODES = {
  "USER": {
    "x": 40,
    "y": 570,
    "icon": "👤",
    "title": "Analyst",
    "sub": "Browser",
    "color": "#6366f1",
    "desc": "A SPARK programme analyst: adds documents, asks questions, and runs the fit-gap analyses."
  },
  "UI": {
    "x": 320,
    "y": 570,
    "icon": "🖥️",
    "title": "Web UI",
    "sub": "React SPA",
    "color": "#0ea5e9",
    "desc": "One web app: Extract, Add to KB, Ask, Quality, Knowledge Graph (canvas + Cypher), Evidence Agent and Fit-Gap Copilot pages."
  },
  "API": {
    "x": 600,
    "y": 570,
    "icon": "⚡",
    "title": "FastAPI",
    "sub": "guardrails · :8000",
    "color": "#10b981",
    "desc": "app.py on :8000. Streams long runs as SSE. Guardrails: a scope check before any agent or RAG answer, and contact details redacted from every response."
  },
  "INGEST": {
    "x": 600,
    "y": 350,
    "icon": "📄",
    "title": "Ingestion",
    "sub": "Docling · OCR · CV",
    "color": "#ec4899",
    "desc": "converter.py turns decks, specs, spreadsheets, PDFs and e-mails into Markdown — Docling for structure, Tesseract and CV for the pictures inside."
  },
  "FILES": {
    "x": 880,
    "y": 350,
    "icon": "🗂️",
    "title": "Markdown corpus",
    "sub": "pkg · dr · knowledge_base",
    "color": "#64748b",
    "desc": "The converted Markdown on disk. The single source both engines are built from: the RAG index and the knowledge graph."
  },
  "RAG": {
    "x": 880,
    "y": 790,
    "icon": "🔍",
    "title": "RAG system",
    "sub": "bge-m3 via Ollama · search",
    "color": "#a855f7",
    "desc": "md_chunker + rag.py: heading-aware chunks embedded locally by Ollama bge-m3 (1024-d); hybrid retrieval (pgvector + BM25, fused by RRF); Claude writes a cited answer from the top chunks only."
  },
  "PG": {
    "x": 1160,
    "y": 570,
    "icon": "🐘",
    "title": "PostgreSQL",
    "sub": "pgvector · run history",
    "color": "#3b82f6",
    "desc": "Vector database and system of record: rag_chunks (HNSW vectors + full-text index), every Ask, agent and evaluation run, and the isolated docling_session for attachments."
  },
  "KG": {
    "x": 1440,
    "y": 350,
    "icon": "🕸️",
    "title": "Knowledge graph",
    "sub": "JSON graph · NL→Cypher",
    "color": "#84cc16",
    "desc": "knowledge_graph.py extracts streams, systems, BPML processes and SPARK specs from every Markdown file, linked to the chunks that mention them. kg_nl2cypher turns questions into Cypher."
  },
  "NEO": {
    "x": 1440,
    "y": 130,
    "icon": "🔷",
    "title": "Neo4j Community",
    "sub": "Bolt :7687 · Browser",
    "color": "#8b5cf6",
    "desc": "Neo4j 5 Community with APOC. A read-only copy of the knowledge graph, reloaded whole after each rebuild — for the Cypher view and Neo4j Browser (:7474)."
  },
  "RAGAS": {
    "x": 1720,
    "y": 790,
    "icon": "📏",
    "title": "Ragas evaluation",
    "sub": "nine judges",
    "color": "#f43f5e",
    "desc": "Scores every RAG answer in the background: faithfulness, answer relevance, context precision and more. Results go to Postgres (Quality page) and Langfuse."
  },
  "EVID": {
    "x": 600,
    "y": 1010,
    "icon": "🔎",
    "title": "Evidence Agent",
    "sub": "question → claims",
    "color": "#f59e0b",
    "desc": "Investigates one question across RAG, the knowledge graph and Hindsight memory; answers as claims, each with verified quotes and a computed score."
  },
  "COPILOT": {
    "x": 880,
    "y": 1230,
    "icon": "🧭",
    "title": "Fit-Gap Copilot",
    "sub": "As-Is vs template",
    "color": "#eab308",
    "desc": "Compares a country's As-Is documentation with the Global Template and SAP Best Practice in two passes; quality gates and computed scores; exports a workshop pack."
  },
  "TOOLS": {
    "x": 1160,
    "y": 1010,
    "icon": "🛠️",
    "title": "Agent runtime",
    "sub": "tool-use loop · verifier",
    "color": "#14b8a6",
    "desc": "Shared by the agents: the tool-use loop with Claude, the search and graph tools, the verifier that checks every quote against what was retrieved, the run store and tracing."
  },
  "MEM": {
    "x": 600,
    "y": 1230,
    "icon": "🧩",
    "title": "Hindsight",
    "sub": "agent memory · :8888",
    "color": "#d946ef",
    "desc": "Long-term agent memory. recall before a run points the agent where to look; retain after stores verified claims only. Memory orients — it is never evidence."
  },
  "CLAUDE": {
    "x": 1720,
    "y": 570,
    "icon": "🧠",
    "title": "Anthropic Claude",
    "sub": "reasoning · writing",
    "color": "#333333",
    "desc": "Writes RAG answers, drives both agents' tool-use loops, writes Cypher, judges for Ragas and extracts facts for Hindsight. It never searches on its own.",
    "external": true
  },
  "LF": {
    "x": 1440,
    "y": 1010,
    "icon": "📈",
    "title": "Langfuse Cloud",
    "sub": "traces · scores",
    "color": "#333333",
    "desc": "Observability: one trace per run and every quality score (Ragas, agent checks, graph checks).",
    "external": true
  }
};

const center = (n) => ({ x: NODES[n].x + NW / 2, y: NODES[n].y + NH / 2 });

// One entry per interaction in the demo scenario. Design ONE realistic,
// concrete end-to-end flow through the architecture (e.g. "a user submits
// a request and it propagates through every layer") rather than an abstract
// tour of every possible edge. Group steps into phases (ph: 0, 1, 2, ...)
// that match PHASES below.
//
// Fields:
//   f, t     — node IDs (from NODES). f === t means a "self-working" step
//              (the node pulses in place, no traveling dot) — use for
//              internal processing with no network hop.
//   ph       — phase index (see PHASES)
//   k        — 'call' (control/hand-off, indigo), 'data' (response, teal),
//              or 'work' (self-working, amber) — purely cosmetic, drives
//              log-item and pulse color.
//   route    — short label shown in the activity log, e.g. "Frontend → API"
//   m        — one-sentence description of what this step represents
//   roundTrip — set true when this is a request/response pair traveling the
//              SAME edge in one step (asker asks, responder answers, ball
//              travels both ways). When true: set f = the RESPONDER (who
//              has the data), t = the ASKER (who initiates) — this reads
//              backwards but matches the engine's `asker = t; responder = f`
//              convention. chat[0] should still be the asker speaking first.
//   chat     — array of [nodeId, "line of dialogue"] tuples, revealed in
//              order as the step plays out. Keep lines short (< ~70 chars).
//
// IMPORTANT: every pair used with roundTrip: true MUST also be added to the
// BIDIRECTIONAL set below (pairKey-sorted, e.g. ['A','B'].sort().join('|')),
// or the return-arrow won't render.
const STEPS = [
  {
    "f": "USER",
    "t": "UI",
    "ph": 0,
    "k": "call",
    "route": "Analyst → Web UI",
    "m": "The analyst drops a new document on the Extract page.",
    "chat": [
      [
        "USER",
        "Here's a new SPARK spec (.docx)."
      ],
      [
        "UI",
        "Uploading — page previews on the left."
      ]
    ]
  },
  {
    "f": "UI",
    "t": "API",
    "ph": 0,
    "k": "call",
    "route": "Web UI → FastAPI",
    "m": "POST /api/upload, then /api/convert.",
    "chat": [
      [
        "UI",
        "POST /api/upload, then /api/convert/{id}"
      ]
    ]
  },
  {
    "f": "API",
    "t": "INGEST",
    "ph": 0,
    "k": "call",
    "route": "FastAPI → Ingestion",
    "m": "Docling converts the structure; OCR and CV read the pictures inside the document.",
    "chat": [
      [
        "API",
        "convert(source)"
      ],
      [
        "INGEST",
        "Docling → Markdown; OCR reads the pictures."
      ]
    ]
  },
  {
    "f": "INGEST",
    "t": "FILES",
    "ph": 0,
    "k": "call",
    "route": "Ingestion → Markdown corpus",
    "m": "Add to knowledge base: the Markdown joins the corpus.",
    "chat": [
      [
        "INGEST",
        "Saved as knowledge_base/<name>.md"
      ],
      [
        "FILES",
        "Now part of the corpus."
      ]
    ]
  },
  {
    "f": "API",
    "t": "RAG",
    "ph": 1,
    "k": "call",
    "route": "FastAPI → RAG system",
    "m": "POST /api/docs/{id}/embed indexes the new file.",
    "chat": [
      [
        "API",
        "index_path(knowledge_base/<name>.md)"
      ]
    ]
  },
  {
    "f": "FILES",
    "t": "RAG",
    "ph": 1,
    "k": "data",
    "route": "RAG system ⇄ Markdown corpus",
    "m": "The file is split at its headings — one chunk per slide, sheet or section.",
    "chat": [
      [
        "RAG",
        "Read the Markdown."
      ],
      [
        "RAG",
        "Split into heading-aware chunks."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "RAG",
    "t": "RAG",
    "ph": 1,
    "k": "work",
    "route": "RAG system: embed",
    "m": "Each chunk is embedded locally by Ollama bge-m3.",
    "chat": [
      [
        "RAG",
        "Embed the chunks with bge-m3 (Ollama)."
      ],
      [
        "RAG",
        "1024-d vectors — on this machine."
      ]
    ]
  },
  {
    "f": "RAG",
    "t": "PG",
    "ph": 1,
    "k": "call",
    "route": "RAG system → PostgreSQL",
    "m": "Vectors and text go into pgvector, with a full-text index beside them.",
    "chat": [
      [
        "RAG",
        "Upsert into rag_chunks."
      ],
      [
        "PG",
        "HNSW vectors + full-text index."
      ]
    ]
  },
  {
    "f": "API",
    "t": "KG",
    "ph": 2,
    "k": "call",
    "route": "FastAPI → Knowledge graph",
    "m": "Rescan: rebuild the graph from the whole corpus.",
    "chat": [
      [
        "API",
        "POST /api/graph/rebuild"
      ]
    ]
  },
  {
    "f": "FILES",
    "t": "KG",
    "ph": 2,
    "k": "data",
    "route": "Knowledge graph ⇄ Markdown corpus",
    "m": "Every Markdown file the analysts have added is read.",
    "chat": [
      [
        "KG",
        "Read every Markdown file."
      ],
      [
        "FILES",
        "All documents, all categories."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "PG",
    "t": "KG",
    "ph": 2,
    "k": "data",
    "route": "Knowledge graph ⇄ PostgreSQL",
    "m": "The indexed chunks become the passage layer, so each link cites the text behind it.",
    "chat": [
      [
        "KG",
        "Which chunks mention each entity?"
      ],
      [
        "PG",
        "Every indexed chunk, by document."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "KG",
    "t": "KG",
    "ph": 2,
    "k": "work",
    "route": "Knowledge graph: extract",
    "m": "Streams, systems, BPML processes and SPARK specs, and how the documents connect them.",
    "chat": [
      [
        "KG",
        "Streams · systems · BPML · SPARK specs."
      ],
      [
        "KG",
        "Saved: knowledge_graph.json"
      ]
    ]
  },
  {
    "f": "KG",
    "t": "NEO",
    "ph": 2,
    "k": "call",
    "route": "Knowledge graph → Neo4j",
    "m": "The new build is loaded into Neo4j whole, in the background.",
    "chat": [
      [
        "KG",
        "Load this build into Neo4j."
      ],
      [
        "NEO",
        "Loaded — ready for Cypher."
      ]
    ]
  },
  {
    "f": "UI",
    "t": "API",
    "ph": 3,
    "k": "call",
    "route": "Web UI → FastAPI",
    "m": "A question on the Ask page.",
    "chat": [
      [
        "USER",
        "Who validated process 7.1.12.3?"
      ],
      [
        "UI",
        "POST /api/ask"
      ]
    ]
  },
  {
    "f": "API",
    "t": "RAG",
    "ph": 3,
    "k": "call",
    "route": "FastAPI → RAG system",
    "m": "The scope check passes; the RAG pipeline starts.",
    "chat": [
      [
        "API",
        "In scope — answer it."
      ]
    ]
  },
  {
    "f": "RAG",
    "t": "RAG",
    "ph": 3,
    "k": "work",
    "route": "RAG system: embed the question",
    "m": "The question is embedded with the same model as the chunks.",
    "chat": [
      [
        "RAG",
        "In scope. Embed the question (bge-m3)."
      ]
    ]
  },
  {
    "f": "PG",
    "t": "RAG",
    "ph": 3,
    "k": "data",
    "route": "RAG system ⇄ PostgreSQL",
    "m": "Two searches at once — by meaning and by exact words — fused into one ranking.",
    "chat": [
      [
        "RAG",
        "Vector search + BM25 keyword search."
      ],
      [
        "PG",
        "Top 8 chunks, fused by rank."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "CLAUDE",
    "t": "RAG",
    "ph": 3,
    "k": "data",
    "route": "RAG system ⇄ Claude",
    "m": "Only the retrieved chunks go to Claude, numbered, and it must cite them.",
    "chat": [
      [
        "RAG",
        "8 numbered excerpts + the question."
      ],
      [
        "CLAUDE",
        "Answer, citing [1] and [3]."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "API",
    "t": "UI",
    "ph": 3,
    "k": "data",
    "route": "FastAPI → Web UI",
    "m": "The answer streams in with its sources.",
    "chat": [
      [
        "UI",
        "Answer streaming, with sources."
      ]
    ]
  },
  {
    "f": "RAG",
    "t": "RAGAS",
    "ph": 3,
    "k": "call",
    "route": "RAG system → Ragas",
    "m": "In the background, the answer is judged.",
    "chat": [
      [
        "RAG",
        "Judge this answer."
      ]
    ]
  },
  {
    "f": "CLAUDE",
    "t": "RAGAS",
    "ph": 3,
    "k": "data",
    "route": "Ragas ⇄ Claude",
    "m": "Nine judges compare the answer with the excerpts it was written from.",
    "chat": [
      [
        "RAGAS",
        "Faithful? Relevant? Right chunks?"
      ],
      [
        "CLAUDE",
        "Verdicts per claim and per excerpt."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "RAGAS",
    "t": "LF",
    "ph": 3,
    "k": "call",
    "route": "Ragas → Langfuse",
    "m": "Scores land on the answer's trace and on the Quality page.",
    "chat": [
      [
        "RAGAS",
        "Scores → Langfuse and Postgres."
      ],
      [
        "LF",
        "On the answer's trace."
      ]
    ]
  },
  {
    "f": "UI",
    "t": "API",
    "ph": 4,
    "k": "call",
    "route": "Web UI → FastAPI",
    "m": "A question for the Evidence Agent.",
    "chat": [
      [
        "USER",
        "Which SPARK specs cover the SOVOS interface?"
      ],
      [
        "UI",
        "POST /api/evidence/ask"
      ]
    ]
  },
  {
    "f": "API",
    "t": "EVID",
    "ph": 4,
    "k": "call",
    "route": "FastAPI → Evidence Agent",
    "m": "Scope check passed; the investigation starts.",
    "chat": [
      [
        "API",
        "In scope — investigate."
      ],
      [
        "EVID",
        "Memory on. 14 tool calls to spend."
      ]
    ]
  },
  {
    "f": "MEM",
    "t": "EVID",
    "ph": 4,
    "k": "data",
    "route": "Evidence Agent ⇄ Hindsight",
    "m": "What earlier investigations concluded — a pointer, never evidence.",
    "chat": [
      [
        "EVID",
        "What do we already know?"
      ],
      [
        "MEM",
        "Earlier runs: look at the tax specs."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "CLAUDE",
    "t": "TOOLS",
    "ph": 4,
    "k": "data",
    "route": "Agent runtime ⇄ Claude (Evidence Agent)",
    "m": "Claude plans the investigation and asks for tools.",
    "chat": [
      [
        "TOOLS",
        "Question, tools, memory note."
      ],
      [
        "CLAUDE",
        "Search the corpus; then count in the graph."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "EVID",
    "t": "TOOLS",
    "ph": 4,
    "k": "call",
    "route": "Evidence Agent → Agent runtime",
    "m": "The runtime runs the tools and logs everything they return.",
    "chat": [
      [
        "EVID",
        "search_corpus · graph_enumerate"
      ]
    ]
  },
  {
    "f": "RAG",
    "t": "TOOLS",
    "ph": 4,
    "k": "data",
    "route": "Agent runtime ⇄ RAG system",
    "m": "Retrieval — every chunk returned is logged for the verifier.",
    "chat": [
      [
        "TOOLS",
        "Search: SOVOS tax interface."
      ],
      [
        "RAG",
        "8 relevant chunks."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "KG",
    "t": "TOOLS",
    "ph": 4,
    "k": "data",
    "route": "Agent runtime ⇄ Knowledge graph",
    "m": "The graph gives exact answers retrieval can only sample.",
    "chat": [
      [
        "TOOLS",
        "Specs connected to SOVOS?"
      ],
      [
        "KG",
        "Exact list, and the route to S/4HANA."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "CLAUDE",
    "t": "TOOLS",
    "ph": 4,
    "k": "data",
    "route": "Agent runtime ⇄ Claude (Evidence Agent)",
    "m": "Claude writes claims, each with verbatim quotes.",
    "chat": [
      [
        "TOOLS",
        "Here is what the tools found."
      ],
      [
        "CLAUDE",
        "Claims, each with verbatim quotes."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "EVID",
    "t": "EVID",
    "ph": 4,
    "k": "work",
    "route": "Evidence Agent: verify & score",
    "m": "Any quote not found in its chunk is removed; scores are arithmetic, not opinion.",
    "chat": [
      [
        "EVID",
        "Every quote checked against its chunk."
      ],
      [
        "EVID",
        "Score computed, not generated."
      ]
    ]
  },
  {
    "f": "EVID",
    "t": "MEM",
    "ph": 4,
    "k": "call",
    "route": "Evidence Agent → Hindsight",
    "m": "Only verified claims are remembered.",
    "chat": [
      [
        "EVID",
        "Retain: verified claims only."
      ],
      [
        "MEM",
        "Remembered for next time."
      ]
    ]
  },
  {
    "f": "TOOLS",
    "t": "PG",
    "ph": 4,
    "k": "call",
    "route": "Agent runtime → PostgreSQL",
    "m": "The whole investigation is stored — reopenable with its working.",
    "chat": [
      [
        "TOOLS",
        "Store the run: evidence_runs."
      ]
    ]
  },
  {
    "f": "TOOLS",
    "t": "LF",
    "ph": 4,
    "k": "call",
    "route": "Agent runtime → Langfuse",
    "m": "Trace and automatic quality scores.",
    "chat": [
      [
        "TOOLS",
        "Trace + citation and guardrail scores."
      ]
    ]
  },
  {
    "f": "API",
    "t": "UI",
    "ph": 4,
    "k": "data",
    "route": "FastAPI → Web UI",
    "m": "Claims with sources and scores.",
    "chat": [
      [
        "UI",
        "Claims, sources, scores."
      ]
    ]
  },
  {
    "f": "UI",
    "t": "API",
    "ph": 5,
    "k": "call",
    "route": "Web UI → FastAPI",
    "m": "The analyst attaches a country's As-Is SOP, tagged with its role.",
    "chat": [
      [
        "USER",
        "India's credit-check SOP — Country As-Is."
      ],
      [
        "UI",
        "POST /api/uploads"
      ]
    ]
  },
  {
    "f": "API",
    "t": "INGEST",
    "ph": 5,
    "k": "call",
    "route": "FastAPI → Ingestion",
    "m": "The attachment is converted like any document.",
    "chat": [
      [
        "API",
        "Convert the attachment."
      ]
    ]
  },
  {
    "f": "API",
    "t": "RAG",
    "ph": 5,
    "k": "call",
    "route": "FastAPI → RAG system",
    "m": "It is indexed — but into its own isolated session.",
    "chat": [
      [
        "API",
        "Index it for this session only."
      ]
    ]
  },
  {
    "f": "RAG",
    "t": "PG",
    "ph": 5,
    "k": "call",
    "route": "RAG system → PostgreSQL",
    "m": "docling_session: a separate schema that corpus search can never reach.",
    "chat": [
      [
        "RAG",
        "Into docling_session · schema u_<id>."
      ],
      [
        "PG",
        "Isolated — expires after 12 hours."
      ]
    ]
  },
  {
    "f": "API",
    "t": "COPILOT",
    "ph": 5,
    "k": "call",
    "route": "FastAPI → Fit-Gap Copilot",
    "m": "Run: Country As-Is vs Global Template.",
    "chat": [
      [
        "API",
        "Run the analysis for India."
      ],
      [
        "COPILOT",
        "Pass 1: read the As-Is only."
      ]
    ]
  },
  {
    "f": "CLAUDE",
    "t": "TOOLS",
    "ph": 5,
    "k": "data",
    "route": "Agent runtime ⇄ Claude (Fit-Gap Copilot)",
    "m": "Pass 1 builds a model of the country's process from the attachment alone.",
    "chat": [
      [
        "TOOLS",
        "Read the attachment."
      ],
      [
        "CLAUDE",
        "read_sources → As-Is model, step by step."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "COPILOT",
    "t": "TOOLS",
    "ph": 5,
    "k": "call",
    "route": "Fit-Gap Copilot → Agent runtime",
    "m": "Pass 2: compare with the template and SAP Best Practice.",
    "chat": [
      [
        "COPILOT",
        "Pass 2: compare_entities · search both sides"
      ]
    ]
  },
  {
    "f": "KG",
    "t": "TOOLS",
    "ph": 5,
    "k": "data",
    "route": "Agent runtime ⇄ Knowledge graph",
    "m": "Which entities the corpus already knows, and which template process matches.",
    "chat": [
      [
        "TOOLS",
        "Known entities? Matching template process?"
      ],
      [
        "KG",
        "Shared / new · BPML process."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "RAG",
    "t": "TOOLS",
    "ph": 5,
    "k": "data",
    "route": "Agent runtime ⇄ RAG system",
    "m": "Global Template and SAP Best Practice passages, labelled by side.",
    "chat": [
      [
        "TOOLS",
        "Template + SAP Best Practice passages."
      ],
      [
        "RAG",
        "Labelled by side."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "CLAUDE",
    "t": "TOOLS",
    "ph": 5,
    "k": "data",
    "route": "Agent runtime ⇄ Claude (Fit-Gap Copilot)",
    "m": "A deviation register with 0-4 ratings.",
    "chat": [
      [
        "TOOLS",
        "Three sides, kept apart."
      ],
      [
        "CLAUDE",
        "Deviation register + 0-4 ratings."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "COPILOT",
    "t": "COPILOT",
    "ph": 5,
    "k": "work",
    "route": "Fit-Gap Copilot: gates & scores",
    "m": "Quality gates repair the register; alignment scores are computed.",
    "chat": [
      [
        "COPILOT",
        "Quality gates: unverified quotes out."
      ],
      [
        "COPILOT",
        "Alignment scores A–D computed."
      ]
    ]
  },
  {
    "f": "TOOLS",
    "t": "PG",
    "ph": 5,
    "k": "call",
    "route": "Agent runtime → PostgreSQL",
    "m": "The analysis, scores and sources are stored.",
    "chat": [
      [
        "TOOLS",
        "Store the run."
      ]
    ]
  },
  {
    "f": "TOOLS",
    "t": "LF",
    "ph": 5,
    "k": "call",
    "route": "Agent runtime → Langfuse",
    "m": "Trace plus gate counts.",
    "chat": [
      [
        "TOOLS",
        "Trace + gate counts."
      ]
    ]
  },
  {
    "f": "API",
    "t": "UI",
    "ph": 5,
    "k": "data",
    "route": "FastAPI → Web UI",
    "m": "Register, heatmap, agenda — and a workshop pack in PDF, Word or Excel.",
    "chat": [
      [
        "UI",
        "Register · scores · workshop pack."
      ]
    ]
  },
  {
    "f": "UI",
    "t": "API",
    "ph": 6,
    "k": "call",
    "route": "Web UI → FastAPI",
    "m": "The Cypher view on the Knowledge Graph page.",
    "chat": [
      [
        "USER",
        "Which documents name SOVOS and S/4HANA?"
      ],
      [
        "UI",
        "POST /api/graph/cypher/generate"
      ]
    ]
  },
  {
    "f": "API",
    "t": "KG",
    "ph": 6,
    "k": "call",
    "route": "FastAPI → Knowledge graph",
    "m": "kg_nl2cypher prepares the real schema and values.",
    "chat": [
      [
        "API",
        "Turn this into Cypher."
      ]
    ]
  },
  {
    "f": "CLAUDE",
    "t": "KG",
    "ph": 6,
    "k": "data",
    "route": "Knowledge graph ⇄ Claude",
    "m": "Claude writes the Cypher and explains its assumptions.",
    "chat": [
      [
        "KG",
        "Schema, real values, the question."
      ],
      [
        "CLAUDE",
        "MATCH (d:Document)-[:MENTIONS_SYSTEM]->…"
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "NEO",
    "t": "KG",
    "ph": 6,
    "k": "data",
    "route": "Knowledge graph ⇄ Neo4j",
    "m": "Checked with EXPLAIN, then run read-only.",
    "chat": [
      [
        "KG",
        "EXPLAIN, then run read-only."
      ],
      [
        "NEO",
        "Rows, each with its graph id."
      ]
    ],
    "roundTrip": true
  },
  {
    "f": "API",
    "t": "UI",
    "ph": 6,
    "k": "data",
    "route": "FastAPI → Web UI",
    "m": "Results in a table, with the matching nodes highlighted on the graph.",
    "chat": [
      [
        "UI",
        "Table + highlighted nodes."
      ],
      [
        "USER",
        "And it's all in Neo4j Browser too."
      ]
    ]
  }
];

// One label per phase index used in STEPS. Shown in the toolbar's phase tag.
const PHASES = ["1 · Upload & convert", "2 · Chunk, embed, store", "3 · Build the knowledge graph", "4 · Ask RAG + Ragas", "5 · Evidence Agent", "6 · Fit-Gap Copilot", "7 · Explore in Neo4j"];

function buildPath(f, t) {
  const a = center(f);
  const b = center(t);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return `M ${a.x} ${a.y} C ${a.x + dx * 0.5} ${a.y}, ${b.x - dx * 0.5} ${
      b.y
    }, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy * 0.5}, ${b.x} ${
    b.y - dy * 0.5
  }, ${b.x} ${b.y}`;
}
// NOTE: if two nodes are far apart with unrelated nodes sitting between them
// on the direct path, this S-curve will visually cross those nodes. Either
// reposition nodes so no edge needs to cross unrelated cards, or special-case
// that one pair with a manual arc (see the git history of docs/architecture
// examples for the "top arc" pattern used when a straight S-curve would
// cut through the middle of the diagram).

const pairKey = (a, b) => [a, b].sort().join("|");

// Derived per-node info for the click-to-open node inspector: every unique
// route label the node participates in, and every step index it appears at
// (rendered as clickable chips that jump the demo to that step).
function nodeInfo(id) {
  const routes = [];
  const stepIdxs = [];
  STEPS.forEach((s, i) => {
    if (s.f === id || s.t === id) {
      stepIdxs.push(i);
      if (routes.indexOf(s.route) === -1) routes.push(s.route);
    }
  });
  return { routes, stepIdxs };
}

// Same idea for the connection inspector (click a link on the stage): every
// route label and step index that travels this one edge. Drives the "what
// would break" list shown before a connection is removed.
function linkInfo(key) {
  const routes = [];
  const stepIdxs = [];
  STEPS.forEach((s, i) => {
    if (s.f !== s.t && pairKey(s.f, s.t) === key) {
      stepIdxs.push(i);
      if (routes.indexOf(s.route) === -1) routes.push(s.route);
    }
  });
  return { routes, stepIdxs };
}

// Pairs that need arrowheads on BOTH ends because the flow is a
// request/response round-trip along one edge, not two distinct steps.
// Must exactly match every pairKey(f, t) used with roundTrip: true above.
const BIDIRECTIONAL = new Set(["CLAUDE|KG", "CLAUDE|RAG", "CLAUDE|RAGAS", "CLAUDE|TOOLS", "EVID|MEM", "FILES|KG", "FILES|RAG", "KG|NEO", "KG|PG", "KG|TOOLS", "PG|RAG", "RAG|TOOLS"]);

// Short text drawn on each connection — the protocol or payload that crosses
// it ("HTTP POST /orders", "publishes OrderPaid"). Keyed by pairKey; every key
// must be a link that actually exists. Viewers can retitle any of them in the
// browser, so this is the starting point, not the last word. {} is fine when
// nothing is worth labelling.
const LINK_LABELS = {
  "FILES|INGEST": "write .md",
  "PG|RAG": "pgvector",
  "CLAUDE|RAGAS": "judges",
  "LF|RAGAS": "scores",
  "KG|PG": "passage layer",
  "KG|NEO": "Bolt",
  "CLAUDE|KG": "NL → Cypher",
  "EVID|MEM": "recall · retain",
  "RAG|TOOLS": "search",
  "KG|TOOLS": "traverse",
  "LF|TOOLS": "traces"
};

// Free-text notes pinned under a card — the caveats a diagram can't hold
// ("p95 220ms", "owned by Payments", "rewrite planned Q3"). Usually {} at
// generation time: this is the viewer's own margin, and the per-node `desc`
// already carries the description the inspector shows. Keyed by node id.
const NODE_NOTES = {};

// Named boxes drawn around a set of cards — the deployment or ownership
// boundaries the diagram has but the arrows can't show ("AWS VPC", "Payments
// team", "Runs on-prem"). Authored per demo; viewers can draw their own by
// selecting cards and hitting ▣ Group. [] is fine when the architecture has no
// boundary worth boxing.
const GROUPS = [];

// OPTIONAL: dramatize one "persistence save" step (file-transfer console +
// flying particles) — nice for a moment like "the run is written to the
// database." Set DB_INGEST_TO to null to disable this entirely; that's the
// right default unless your scenario has one obvious "everything lands
// here" step. When enabled, DB_INGEST_FROM/TO must match the f/t of exactly
// one non-roundTrip STEPS entry.
const DB_INGEST_FROM = null; // node id, e.g. 'API', or null
const DB_INGEST_TO = null; // node id, e.g. 'DB', or null
const DB_INGEST_ICON = ""; // e.g. '🖥️ ➔ 🗄️'
const DB_INGEST_TITLE = ""; // e.g. 'Saving run to PostgreSQL...'
const DB_INGEST_FILES = []; // [{name,size}, ...] cosmetic file list
// Place the console in genuinely empty canvas space near DB_INGEST_TO — check
// your NODES layout for a gap, don't just guess.
const DB_INGEST_CONSOLE_X = 0;
const DB_INGEST_CONSOLE_Y = 0;
// Particle path: start near the bottom/edge of DB_INGEST_FROM's card, end
// near the top/edge of DB_INGEST_TO's card.
const DB_INGEST_PARTICLE_PATH = {
  startX: 0,
  startY: 0,
  endX: 0,
  endY: 0,
};

const TITLE = "Solvay Spark Spine AI — How it works";
const SUBTITLE = "From a new document to answers, evidence and fit-gap analysis — every component, every flow";

// ============================================================================
// ArchFlow ENGINE — do not modify below this line.
// ============================================================================

// Dragged node positions persist per demo (keyed by TITLE) so a decluttered
// layout survives reloads — but only once the viewer commits them with the
// 💾 Save layout button, so a reload always returns to the last saved (or
// authored) arrangement. Storage can be unavailable or stale (private mode,
// cleared NODES entries), so everything is best-effort: failures fall back to
// the authored layout.
//
// localStorage is per browser profile, so a layout saved in one Chrome profile
// is invisible in another — the same demo opened from a different profile
// window shows that profile's older layout instead. The durable arrangement is
// therefore the one baked into NODES above: ⬇ Export edits downloads the
// current coordinates so they can be written into this file as the authored
// default. LAYOUT_STAMP is bumped whenever that happens, which retires every
// previously saved layout in every profile — otherwise a stale localStorage
// entry would keep overriding the freshly baked one.
const LAYOUT_STAMP = "v6";
const LAYOUT_KEY = "archflow-layout:" + TITLE;
(function loadLayout() {
  try {
    const data = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
    if (data.stamp !== LAYOUT_STAMP) return; // baked layout supersedes it
    const saved = data.pos || {};
    Object.keys(saved).forEach((id) => {
      if (
        NODES[id] &&
        typeof saved[id].x === "number" &&
        typeof saved[id].y === "number"
      ) {
        NODES[id].x = Math.max(4, Math.min(STAGE_W - NW - 4, saved[id].x));
        NODES[id].y = Math.max(4, Math.min(STAGE_H - NH - 4, saved[id].y));
      }
    });
  } catch (e) {
    /* keep authored layout */
  }
})();
function currentLayout() {
  const pos = {};
  Object.keys(NODES).forEach((id) => {
    pos[id] = { x: Math.round(NODES[id].x), y: Math.round(NODES[id].y) };
  });
  return pos;
}
function saveLayout() {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ stamp: LAYOUT_STAMP, pos: currentLayout() }),
    );
  } catch (e) {
    /* storage unavailable — layout just won't persist */
  }
}
// Hand the viewer's edits back as a file, so they can be baked into NODES /
// LINK_LABELS and stop depending on which browser profile happens to open the
// demo.
function exportLayout() {
  const payload = {
    title: TITLE,
    stamp: LAYOUT_STAMP,
    pos: currentLayout(),
    labels: currentLabels(),
    notes: currentNotes(),
    groups: GROUP_LIST,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "archflow-edits.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Removed connections ("what breaks if this link goes away?"). The set holds
// pairKeys; it is the single source of truth for both the severed styling on
// the stage and the blocked-step behaviour during a run. Persisted per demo
// like the layout, and best-effort for the same reasons.
const LINKS_KEY = "archflow-removed-links:" + TITLE;
const REMOVED_LINKS = new Set();
(function loadRemovedLinks() {
  try {
    const saved = JSON.parse(localStorage.getItem(LINKS_KEY)) || [];
    saved.forEach((k) => {
      const ends = String(k).split("|");
      if (NODES[ends[0]] && NODES[ends[1]]) REMOVED_LINKS.add(k);
    });
  } catch (e) {
    /* every link stays connected */
  }
})();
function saveRemovedLinks() {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(Array.from(REMOVED_LINKS)));
  } catch (e) {
    /* storage unavailable — removals just won't persist */
  }
}
// Self-working steps (f === t) never travel a link, so they can't be blocked.
const isLinkRemoved = (f, t) => f !== t && REMOVED_LINKS.has(pairKey(f, t));

// Every connection drawn on the stage, in first-use order. Derived the same
// way the component derives its edges, so a label can never be authored for a
// link that doesn't exist.
const LINK_KEYS = [];
(function computeLinkKeys() {
  STEPS.forEach((s) => {
    if (s.f === s.t) return;
    const k = pairKey(s.f, s.t);
    if (LINK_KEYS.indexOf(k) === -1) LINK_KEYS.push(k);
  });
})();

// Viewer overrides of LINK_LABELS (double-click a link to retitle it).
// Persisted per demo — and per browser profile, so ⬇ Export edits is what
// makes a relabelling travel with the file.
const LABELS_KEY = "archflow-link-labels:" + TITLE;
const LABEL_EDITS = {};
(function loadLinkLabels() {
  try {
    const saved = JSON.parse(localStorage.getItem(LABELS_KEY)) || {};
    Object.keys(saved).forEach((k) => {
      if (LINK_KEYS.indexOf(k) !== -1 && typeof saved[k] === "string")
        LABEL_EDITS[k] = saved[k];
    });
  } catch (e) {
    /* authored labels stand */
  }
})();
// An edit back to the authored text is a *reset*, not an override, so a later
// re-authoring of that label still reaches this viewer.
const labelFor = (key) =>
  key in LABEL_EDITS ? LABEL_EDITS[key] : LINK_LABELS[key] || "";
function setLinkLabel(key, text) {
  const next = String(text).replace(/\s+/g, " ").trim();
  if (next === (LINK_LABELS[key] || "")) delete LABEL_EDITS[key];
  else LABEL_EDITS[key] = next;
  try {
    localStorage.setItem(LABELS_KEY, JSON.stringify(LABEL_EDITS));
  } catch (e) {
    /* storage unavailable — the edit just won't persist */
  }
}
function currentLabels() {
  const out = {};
  LINK_KEYS.forEach((k) => {
    const t = labelFor(k);
    if (t) out[k] = t;
  });
  return out;
}

// Viewer edits of NODE_NOTES (double-click a card to write one), same shape
// and same rules as the link labels: an edit back to the authored text is a
// reset, and ⬇ Export edits is what makes a note travel.
const NOTES_KEY = "archflow-node-notes:" + TITLE;
const NOTE_EDITS = {};
(function loadNodeNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTES_KEY)) || {};
    Object.keys(saved).forEach((id) => {
      if (NODES[id] && typeof saved[id] === "string")
        NOTE_EDITS[id] = saved[id];
    });
  } catch (e) {
    /* authored notes stand */
  }
})();
const noteFor = (id) =>
  id in NOTE_EDITS ? NOTE_EDITS[id] : NODE_NOTES[id] || "";
function setNodeNote(id, text) {
  const next = String(text).replace(/\s+/g, " ").trim();
  if (next === (NODE_NOTES[id] || "")) delete NOTE_EDITS[id];
  else NOTE_EDITS[id] = next;
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(NOTE_EDITS));
  } catch (e) {
    /* storage unavailable — the note just won't persist */
  }
}
function currentNotes() {
  const out = {};
  Object.keys(NODES).forEach((id) => {
    const t = noteFor(id);
    if (t) out[id] = t;
  });
  return out;
}

// Groups are structural, so a viewer's set REPLACES the authored one wholesale
// rather than merging — there's no stable identity to merge on, and
// half-merged boundaries would be worse than either version. Same storage
// rules as everything else: per demo, best-effort.
const GROUP_TONES = 6;
const GROUPS_KEY = "archflow-groups:" + TITLE;
let GROUP_LIST = [];
(function loadGroups() {
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .map((g, i) => ({
        name: String((g && g.name) || "Group " + (i + 1)),
        tone:
          (((Number(g && g.tone) || 0) % GROUP_TONES) + GROUP_TONES) %
          GROUP_TONES,
        members: (g && Array.isArray(g.members) ? g.members : []).filter(
          (id) => NODES[id],
        ),
      }))
      // A one-card box is just a card with extra ink.
      .filter((g) => g.members.length > 1);
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(GROUPS_KEY));
  } catch (e) {
    /* authored groups stand */
  }
  GROUP_LIST = clean(saved || GROUPS);
})();
function saveGroups() {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(GROUP_LIST));
  } catch (e) {
    /* storage unavailable — grouping just won't persist */
  }
}
// Index of the group whose members are exactly this selection — what turns the
// ▣ Group button into ⤫ Ungroup.
function groupMatching(ids) {
  const want = Array.from(ids).sort().join("|");
  for (let i = 0; i < GROUP_LIST.length; i++) {
    if (GROUP_LIST[i].members.slice().sort().join("|") === want) return i;
  }
  return -1;
}
function addGroup(ids) {
  const members = Array.from(ids).filter((id) => NODES[id]);
  if (members.length < 2) return null;
  // A card belongs to at most one box — boxes that overlap halfway read as a
  // mistake — so the newest claim wins and emptied groups go.
  GROUP_LIST.forEach((g) => {
    g.members = g.members.filter((id) => members.indexOf(id) === -1);
  });
  GROUP_LIST = GROUP_LIST.filter((g) => g.members.length > 1);
  const used = GROUP_LIST.map((g) => g.tone);
  let tone = 0;
  while (tone < GROUP_TONES && used.indexOf(tone) !== -1) tone++;
  const group = {
    name: "Group " + (GROUP_LIST.length + 1),
    members,
    tone: tone % GROUP_TONES,
  };
  GROUP_LIST.push(group);
  saveGroups();
  return group;
}
function removeGroup(group) {
  const i = GROUP_LIST.indexOf(group);
  if (i === -1) return;
  GROUP_LIST.splice(i, 1);
  saveGroups();
}
function renameGroup(group, name) {
  const next = String(name).replace(/\s+/g, " ").trim();
  if (next) group.name = next;
  saveGroups();
}

// Who *starts* a step. For roundTrip steps the engine's convention is
// f = responder, t = asker, so the initiator is t — get this wrong and every
// round-trip looks unreachable the moment anything upstream is cut.
const stepInitiator = (s) => (s.roundTrip ? s.t : s.f);

// Nodes that can start a flow on their own: the first time they appear in
// STEPS, they appear as an initiator, so nothing upstream ever handed to
// them. Usually just the entry point, but a demo may legitimately have a
// later cold start (a scheduler firing in phase 4) — seeding those keeps
// them running when an unrelated link is cut.
const ORIGINS = new Set();
(function computeOrigins() {
  const seen = new Set();
  STEPS.forEach((s) => {
    if (!seen.has(stepInitiator(s))) ORIGINS.add(stepInitiator(s));
    seen.add(s.f);
    seen.add(s.t);
  });
})();

// Every step's status for the CURRENT set of removed links:
//   'ok'          — runs normally
//   'blocked'     — its own link was cut
//   'unreachable' — nothing ever reached its initiator, because an upstream
//                   step was blocked (or itself unreachable)
// Pure and order-independent, so an animated run and a scrubber jump always
// agree. addKey / dropKey answer the hypothetical "what if this one link
// were also cut / put back?" for the connection inspector's impact line.
function computeStatuses(addKey, dropKey) {
  const reached = new Set(ORIGINS);
  // Nodes an earlier step failed to deliver to. A poller reading from a
  // starved node gets nothing, so it can't restart the flow — without this,
  // cutting "user uploads to OneDrive" left the scheduled Power Automate
  // poll (an ORIGIN, since it first appears as a round-trip asker) happily
  // picking up a file that never arrived, and the whole pipeline ran on.
  const starved = new Set();
  return STEPS.map((s) => {
    const key = s.f !== s.t ? pairKey(s.f, s.t) : null;
    const removed =
      !!key && key !== dropKey && (REMOVED_LINKS.has(key) || key === addKey);
    const initiator = stepInitiator(s);
    // For a round-trip, f is the responder being read from. A node that has
    // simply never been touched yet is fine (the first query to a database);
    // only one that was *supposed* to have been fed counts as starved.
    const readsStarved = s.roundTrip && starved.has(s.f);
    if (removed || readsStarved || !reached.has(initiator)) {
      // The request dies here. The initiator is no longer carrying a live
      // flow, so every later step it would have started is stranded too, and
      // whatever this step was meant to deliver never arrives.
      reached.delete(initiator);
      starved.add(s.t);
      return removed ? "blocked" : "unreachable";
    }
    reached.add(s.f);
    reached.add(s.t);
    starved.delete(s.t);
    return "ok";
  });
}

// Cached because it is read once per log entry; invalidated on every
// remove/restore.
let STATUS_CACHE = null;
function stepStatuses() {
  if (!STATUS_CACHE) STATUS_CACHE = computeStatuses();
  return STATUS_CACHE;
}
function invalidateStatuses() {
  STATUS_CACHE = null;
}

export function SparkDemoFlow() {
  const [theme, setTheme] = useState("light");
  const [speed, setSpeed] = useState(0.5);
  const [isPlaying, setIsPlaying] = useState(false);
  const [phaseText, setPhaseText] = useState("Ready");
  const [isDoneDisabled, setIsDoneDisabled] = useState(false);
  // progress mirrors idxRef into React state so the scrubber / step counter /
  // button labels re-render as the run advances.
  const [progress, setProgress] = useState(-1);
  // Node inspector: id of the clicked node, or null when closed.
  const [inspected, setInspected] = useState(null);
  // Connection inspector: pairKey of the clicked link, or null when closed.
  const [selectedLink, setSelectedLink] = useState(null);
  // Bumped on every remove/restore so the JSX (which reads REMOVED_LINKS
  // directly) re-renders and the link-visual effect re-runs.
  const [linkVersion, setLinkVersion] = useState(0);
  // Same trick for link labels and group boxes, which also live outside React
  // state.
  const [labelVersion, setLabelVersion] = useState(0);
  const [noteVersion, setNoteVersion] = useState(0);
  const [groupVersion, setGroupVersion] = useState(0);

  const stageRef = useRef(null);
  const logRef = useRef(null);
  const scrubTrackRef = useRef(null);

  const playingRef = useRef(false);
  const idxRef = useRef(-1);
  const speedRef = useRef(0.5);
  const animRef = useRef(null);
  // True while a ⏭ Step single-step animation runs — jumpTo must not fire
  // then (DOM log-item listeners bypass the disabled-button guards).
  const ffRef = useRef(false);
  // Node cards have been dragged since the last save (enables 💾 Save
  // layout); flips to a "Saved" confirmation for a moment after saving.
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [layoutSaved, setLayoutSaved] = useState(false);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef(null);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current
        .requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch((err) => console.error(err));
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () =>
      setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    Object.keys(nodeElsRef.current).forEach((id) =>
      nodeElsRef.current[id].classList.toggle("inspected", id === inspected),
    );
  }, [inspected]);

  // ⌘/Ctrl+A selects every node, Esc drops the selection. The page is just
  // this demo, so hijacking select-all is safe — except inside a real text
  // field, where the browser's own meaning must win.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(Object.keys(NODES));
      } else if (e.key === "Escape" && selectionRef.current.size) {
        setSelection([]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // One repaint path for every grouping change (create, rename, ungroup).
  useEffect(() => {
    if (renderGroupsRef.current) renderGroupsRef.current();
  }, [groupVersion]);

  // noteVersion exists so the inspector re-renders with the new text; the note
  // itself is redrawn by the editor that changed it.
  useEffect(() => {
    if (noteVersion && renderNoteRef.current && inspected)
      renderNoteRef.current(inspected);
  }, [noteVersion]);

  const edgesRef = useRef({});
  const nodeElsRef = useRef({});
  const pulseRef = useRef(null);
  const allArrowsRef = useRef([]);
  const bubbleLayerRef = useRef(null);
  const bubbleElsRef = useRef([]);
  const dbParticlesGroupRef = useRef(null);
  const pgConsoleFORef = useRef(null);
  // Handles into the imperative stage, so the inspector (React) can retitle a
  // link and the link-visual effect can redraw one.
  const renderLabelRef = useRef(null);
  const openLabelEditorRef = useRef(null);
  const renderNoteRef = useRef(null);
  const openNoteEditorRef = useRef(null);
  const renderGroupsRef = useRef(null);
  const openGroupEditorRef = useRef(null);

  // Multi-select. The ids live in a ref (the drag handlers, built once, read
  // it on every pointermove) and only the COUNT is mirrored into state, purely
  // so the toolbar button can re-label itself.
  const selectionRef = useRef(new Set());
  const [selCount, setSelCount] = useState(0);
  // Single place that turns the ref into what you see, so the selection can
  // never drift from the highlighted cards.
  const paintSelection = () => {
    const sel = selectionRef.current;
    Object.keys(nodeElsRef.current).forEach((id) =>
      nodeElsRef.current[id].classList.toggle("selected", sel.has(id)),
    );
    setSelCount(sel.size);
  };
  const setSelection = (ids) => {
    selectionRef.current = new Set(ids);
    paintSelection();
  };
  const toggleSelectAll = () => {
    setSelection(selectionRef.current.size ? [] : Object.keys(NODES));
  };

  // ▣ Group boxes the current selection; when that selection IS a group
  // already (clicking a box's name selects exactly its members), the same
  // button becomes ⤫ Ungroup. Read from the ref during render, which is safe
  // because every change to either the selection or the groups bumps state
  // (selCount / groupVersion) and re-renders.
  const matchedGroup = groupMatching(selectionRef.current);
  const toggleGroup = () => {
    if (matchedGroup !== -1) {
      removeGroup(GROUP_LIST[matchedGroup]);
      if (renderGroupsRef.current) renderGroupsRef.current();
      setGroupVersion((v) => v + 1);
      return;
    }
    const group = addGroup(selectionRef.current);
    if (!group) return;
    if (renderGroupsRef.current) renderGroupsRef.current();
    setGroupVersion((v) => v + 1);
    // Straight into naming it — an unnamed box is half the feature.
    if (openGroupEditorRef.current) openGroupEditorRef.current(group);
  };

  const BASE = 2400; // base step duration in ms

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);
  useEffect(
    () => () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!stageRef.current) return;
    stageRef.current.innerHTML = "";

    const SVGNS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs, text) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text !== undefined && text !== null) e.textContent = text;
      return e;
    };

    // SVG text can't wrap or clip itself, so anything that must stay inside a
    // box (card titles, link labels) is measured and trimmed here. Returns
    // true when it had to cut, so the caller can attach the full string as a
    // hover <title>.
    const ellipsize = (t, max) => {
      if (t.getComputedTextLength() <= max) return false;
      const full = t.textContent;
      let lo = 0;
      let hi = full.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        t.textContent = full.slice(0, mid) + "…";
        if (t.getComputedTextLength() <= max) lo = mid;
        else hi = mid - 1;
      }
      t.textContent = full.slice(0, lo).replace(/[\s,;:.-]+$/, "") + "…";
      return true;
    };
    const fullTextTip = (t, full) => t.appendChild(el("title", {}, full));

    const edges = {};
    const directed = new Set();

    STEPS.forEach((s) => {
      if (s.f !== s.t) {
        directed.add(s.f + ">" + s.t);
        const key = pairKey(s.f, s.t);
        if (!edges[key])
          edges[key] = { from: s.f, to: s.t, d: buildPath(s.f, s.t) };
      }
    });

    // Group boxes go in first so they sit behind every line and card — they're
    // a backdrop, not something to click through.
    const groupLayer = el("g", {});
    stageRef.current.appendChild(groupLayer);

    const edgeLayer = el("g", {});
    stageRef.current.appendChild(edgeLayer);
    // Transparent wide twins of every edge, so a link can actually be
    // clicked; and the ✕ markers drawn over removed links. Both layers sit
    // BELOW the node groups (appended later), so a node card always wins a
    // click where the two overlap.
    const hitLayer = el("g", {});
    stageRef.current.appendChild(hitLayer);
    const cutLayer = el("g", {});
    stageRef.current.appendChild(cutLayer);

    const edgesCached = {};
    Object.keys(edges).forEach((key) => {
      const e = edges[key];
      const p = el("path", { d: e.d, class: "edge dashed" });
      edgeLayer.appendChild(p);

      const hit = el("path", { d: e.d, class: "edge-hit" });
      hit.appendChild(
        el(
          "title",
          {},
          NODES[e.from].title +
            " ⇄ " +
            NODES[e.to].title +
            " — click to inspect or remove this connection",
        ),
      );
      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setInspected(null);
        setSelectedLink((prev) => (prev === key ? null : key));
      });
      hitLayer.appendChild(hit);

      const cut = el("text", { class: "edge-cut", x: 0, y: 0 }, "✕");
      cut.style.display = "none";
      cutLayer.appendChild(cut);

      edgesCached[key] = {
        el: p,
        hit,
        cut,
        from: e.from,
        to: e.to,
        len: p.getTotalLength(),
        arrows: {},
      };
    });
    edgesRef.current = edgesCached;

    const arrowLayer = el("g", {});
    stageRef.current.appendChild(arrowLayer);
    const allArrows = [];

    const norm = (x, y) => {
      const d = Math.hypot(x, y) || 1;
      return { x: x / d, y: y / d };
    };
    const insideCard = (p, n, pad) =>
      p.x >= n.x - pad &&
      p.x <= n.x + NW + pad &&
      p.y >= n.y - pad &&
      p.y <= n.y + NH + pad;

    const arrowPoints = (path, len, n, side) => {
      const STEP = 1;
      const OVERLAP = 2.5;
      let edgeL = 0;
      let tip = { x: 0, y: 0 };
      let dir = { x: 0, y: 0 };

      if (side === "to") {
        edgeL = 0;
        for (let q = len; q >= 0; q -= STEP) {
          if (!insideCard(path.getPointAtLength(q), n, 0)) {
            edgeL = q;
            break;
          }
        }
        const onEdge = path.getPointAtLength(edgeL);
        const ahead = path.getPointAtLength(Math.min(len, edgeL + 8));
        dir = norm(ahead.x - onEdge.x, ahead.y - onEdge.y);
        tip = { x: onEdge.x + dir.x * OVERLAP, y: onEdge.y + dir.y * OVERLAP };
      } else {
        edgeL = len;
        for (let q = 0; q <= len; q += STEP) {
          if (!insideCard(path.getPointAtLength(q), n, 0)) {
            edgeL = q;
            break;
          }
        }
        const onEdge = path.getPointAtLength(edgeL);
        const back = path.getPointAtLength(Math.max(0, edgeL - 8));
        dir = norm(back.x - onEdge.x, back.y - onEdge.y);
        tip = { x: onEdge.x + dir.x * OVERLAP, y: onEdge.y + dir.y * OVERLAP };
      }

      const size = 7;
      const half = 4;
      const nx = -dir.y;
      const ny = dir.x;
      const bx = tip.x - dir.x * size;
      const by = tip.y - dir.y * size;
      return `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${(
        bx +
        nx * half
      ).toFixed(1)},${(by + ny * half).toFixed(1)} ${(bx - nx * half).toFixed(
        1,
      )},${(by - ny * half).toFixed(1)}`;
    };

    const makeArrow = (path, len, n, side) => {
      const poly = el("polygon", {
        points: arrowPoints(path, len, n, side),
        class: "arrow",
      });
      arrowLayer.appendChild(poly);
      allArrows.push(poly);
      return poly;
    };

    Object.keys(edgesRef.current).forEach((key) => {
      const e = edgesRef.current[key];
      const nodesTo = NODES[e.to];
      const nodesFrom = NODES[e.from];
      e.arrows[e.to] = makeArrow(e.el, e.len, nodesTo, "to");
      if (
        directed.has(e.to + ">" + e.from) ||
        BIDIRECTIONAL.has(pairKey(e.from, e.to))
      ) {
        e.arrows[e.from] = makeArrow(e.el, e.len, nodesFrom, "from");
      }
    });
    allArrowsRef.current = allArrows;

    // ---- Link labels ------------------------------------------------------
    // Each connection carries a short line of text, sitting on an opaque pill
    // so the dashed line doesn't run through the letters. The layer goes above
    // the lines but below the node groups, so a card still wins any click
    // where the two overlap.
    const LABEL_MAX = 128;
    const LABEL_MIN = 44; // below this a stub reads as noise, so hide it
    const labelLayer = el("g", {});
    stageRef.current.appendChild(labelLayer);

    // How much bare line this link actually exposes between the two cards.
    // Cards are painted over the label layer, so a label wider than this
    // doesn't overflow — it disappears under a card, which is worse.
    // Neighbouring cards make this tiny, so the budget is per-link and
    // recomputed whenever a card moves.
    const freeSpan = (e) => {
      let start = 0;
      let end = e.len;
      for (let q = 0; q <= e.len; q += 2) {
        if (!insideCard(e.el.getPointAtLength(q), NODES[e.from], 2)) {
          start = q;
          break;
        }
      }
      for (let q = e.len; q >= 0; q -= 2) {
        if (!insideCard(e.el.getPointAtLength(q), NODES[e.to], 2)) {
          end = q;
          break;
        }
      }
      return Math.max(0, end - start);
    };
    // A vertical link can still run past a card that sits beside it, so the
    // pill is also tested against every card — not just the two it connects —
    // and slid along the line until it finds clear space.
    const hitsAnyCard = (x, y, w, h) =>
      Object.keys(NODES).some((id) => {
        const n = NODES[id];
        return (
          x < n.x + NW + 2 &&
          x + w > n.x - 2 &&
          y < n.y + NH + 2 &&
          y + h > n.y - 2
        );
      });
    const LABEL_SLOTS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];

    // Updates the pill in place — never replaces its elements. That matters:
    // a browser only fires dblclick when both clicks land on the SAME element,
    // so rebuilding the pill on the first click (this runs whenever a link is
    // selected) would silently kill the double-click-to-edit gesture.
    const renderLabel = (key) => {
      const e = edgesRef.current[key];
      if (!e || !e.labelG) return;
      const txt = labelFor(key);
      // A severed link already says everything with its ✕ marker, which sits
      // at this exact midpoint — two things there would collide.
      if (!txt || REMOVED_LINKS.has(key)) {
        e.labelG.style.display = "none";
        return;
      }
      // Two cards sitting shoulder to shoulder leave nothing to write on; the
      // inspector still shows the label in full.
      const budget = Math.min(LABEL_MAX, freeSpan(e) - 10);
      if (budget < LABEL_MIN) {
        e.labelG.style.display = "none";
        return;
      }
      e.labelG.style.display = "";
      e.labelText.textContent = txt; // reset before measuring
      ellipsize(e.labelText, budget);
      const w = e.labelText.getComputedTextLength() + 12;
      let at = null;
      for (let i = 0; i < LABEL_SLOTS.length; i++) {
        const pt = e.el.getPointAtLength(e.len * LABEL_SLOTS[i]);
        if (!hitsAnyCard(pt.x - w / 2, pt.y - 9, w, 18)) {
          at = pt;
          break;
        }
      }
      if (!at) {
        e.labelG.style.display = "none";
        return;
      }
      e.labelAt = at; // where the editor should open
      e.labelText.setAttribute("x", String(at.x));
      e.labelText.setAttribute("y", String(at.y));
      e.labelTip.textContent = txt + " — double-click to edit";
      e.labelBg.setAttribute("x", String(at.x - w / 2));
      e.labelBg.setAttribute("y", String(at.y - 9));
      e.labelBg.setAttribute("width", String(w));
    };
    renderLabelRef.current = renderLabel;

    // One editor for the whole stage — a real <input> in a foreignObject,
    // parked over whatever is being retitled (a link label or a group name).
    // Enter/blur commits, Esc backs out. Edits persist immediately: they're
    // content, like a removed link, not view state waiting on 💾 Save layout.
    const editorFO = el("foreignObject", {
      width: 190,
      height: 34,
      style: "display: none;",
    });
    const editorInput = document.createElement("input");
    editorInput.className = "edge-label-input";
    editorInput.setAttribute("maxlength", "48");
    editorFO.appendChild(editorInput);
    stageRef.current.appendChild(editorFO);
    let editing = null; // { kind: 'link' | 'group', key }
    const closeEditor = (commit) => {
      if (!editing) return;
      const what = editing;
      editing = null;
      editorFO.style.display = "none";
      if (!commit) return;
      if (what.kind === "link") {
        setLinkLabel(what.key, editorInput.value);
        renderLabel(what.key);
        setLabelVersion((v) => v + 1);
      } else if (what.kind === "note") {
        setNodeNote(what.key, editorInput.value);
        renderNote(what.key);
        setNoteVersion((v) => v + 1);
      } else {
        renameGroup(what.key, editorInput.value);
        renderGroups();
        setGroupVersion((v) => v + 1);
      }
    };
    const openEditorAt = (kind, key, at, value, placeholder) => {
      editing = { kind, key };
      editorFO.setAttribute("x", String(at.x - 95));
      editorFO.setAttribute("y", String(at.y - 17));
      editorFO.style.display = "";
      editorInput.setAttribute("placeholder", placeholder);
      editorInput.value = value;
      editorInput.focus();
      editorInput.select();
    };
    const openLabelEditor = (key) => {
      const e = edgesRef.current[key];
      if (!e) return;
      // Open over the label if one is drawn, else at the midpoint.
      const at =
        e.labelG.style.display !== "none" && e.labelAt
          ? e.labelAt
          : e.el.getPointAtLength(e.len / 2);
      openEditorAt("link", key, at, labelFor(key), "Label this connection…");
    };
    openLabelEditorRef.current = openLabelEditor;
    // Notes are written where they'll be read: just under the card.
    const openNoteEditor = (id) => {
      const n = NODES[id];
      if (!n) return;
      // openEditorAt centres the box on the point it's given.
      openEditorAt(
        "note",
        id,
        { x: n.x + NW / 2, y: n.y + NH + 23 },
        noteFor(id),
        "Add a note…",
      );
    };
    openNoteEditorRef.current = openNoteEditor;
    editorInput.addEventListener("keydown", (ev) => {
      // The stage owns ⌘A and Esc — while typing, they mean the usual
      // text-field things instead.
      ev.stopPropagation();
      if (ev.key === "Enter") closeEditor(true);
      else if (ev.key === "Escape") closeEditor(false);
    });
    editorInput.addEventListener("blur", () => closeEditor(true));

    Object.keys(edgesRef.current).forEach((key) => {
      const e = edgesRef.current[key];
      const grp = el("g", { class: "edge-label-g" });
      e.labelTip = el("title", {});
      e.labelBg = el("rect", {
        class: "edge-label-bg",
        rx: 5,
        x: 0,
        y: 0,
        width: 0,
        height: 18,
      });
      e.labelText = el("text", { class: "edge-label", x: 0, y: 0 });
      grp.appendChild(e.labelTip);
      grp.appendChild(e.labelBg);
      grp.appendChild(e.labelText);
      grp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setInspected(null);
        setSelectedLink((prev) => (prev === key ? null : key));
      });
      grp.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        openLabelEditor(key);
      });
      labelLayer.appendChild(grp);
      e.labelG = grp;
      // Double-clicking anywhere on the line works too — the label may not
      // exist yet, and an empty one is nothing to aim at.
      if (e.hit) {
        e.hit.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          openLabelEditor(key);
        });
      }
      renderLabel(key);
    });

    // ---- Group boxes --------------------------------------------------
    // A named box drawn around a set of cards. Elements are kept per group
    // object and only their attributes change, for the same dblclick reason as
    // the link labels — and because this re-runs on every frame of a drag.
    const GROUP_PAD = 20;
    const GROUP_HEAD = 22; // strip above the cards that holds the name
    const groupEls = new Map();
    // Rename in place, over the box's own title strip.
    const openGroupEditor = (g) => {
      const els = groupEls.get(g);
      if (!els) return;
      const at = {
        x: +els.rect.getAttribute("x") + 95,
        y: +els.rect.getAttribute("y") + 11,
      };
      openEditorAt("group", g, at, g.name, "Name this group…");
    };
    openGroupEditorRef.current = openGroupEditor;
    const renderGroups = () => {
      groupEls.forEach((els, g) => {
        if (GROUP_LIST.indexOf(g) === -1) {
          groupLayer.removeChild(els.g);
          groupEls.delete(g);
        }
      });
      GROUP_LIST.forEach((g) => {
        let els = groupEls.get(g);
        if (!els) {
          const box = el("g", { class: "group" });
          const tip = el("title", {});
          const rect = el("rect", { class: "group-box", rx: 14 });
          const name = el("text", { class: "group-name" });
          box.appendChild(tip);
          box.appendChild(rect);
          box.appendChild(name);
          // Selecting the members is what makes a group draggable: the
          // existing group-drag then moves the whole box as one piece.
          name.addEventListener("click", (ev) => {
            ev.stopPropagation();
            setSelection(g.members);
          });
          name.addEventListener("dblclick", (ev) => {
            ev.stopPropagation();
            openGroupEditor(g);
          });
          groupLayer.appendChild(box);
          els = { g: box, rect, name, tip };
          groupEls.set(g, els);
        }
        const xs = g.members.map((id) => NODES[id].x);
        const ys = g.members.map((id) => NODES[id].y);
        const x = Math.max(2, Math.min.apply(null, xs) - GROUP_PAD);
        const y = Math.max(
          2,
          Math.min.apply(null, ys) - GROUP_PAD - GROUP_HEAD,
        );
        const x2 = Math.min(
          STAGE_W - 2,
          Math.max.apply(null, xs) + NW + GROUP_PAD,
        );
        const y2 = Math.min(
          STAGE_H - 2,
          Math.max.apply(null, ys) + NH + GROUP_PAD,
        );
        els.g.setAttribute("class", "group tone-" + g.tone);
        // Membership on the element, so a check (and a reader of the DOM) can
        // tell a card inside the box from a card merely surrounded by it —
        // see the stray-card check in the skill's Step 8.
        els.g.setAttribute("data-members", g.members.join(" "));
        els.rect.setAttribute("x", String(x));
        els.rect.setAttribute("y", String(y));
        els.rect.setAttribute("width", String(Math.max(0, x2 - x)));
        els.rect.setAttribute("height", String(Math.max(0, y2 - y)));
        els.name.setAttribute("x", String(x + 14));
        els.name.setAttribute("y", String(y + 15));
        els.name.textContent = g.name; // reset before measuring
        ellipsize(els.name, Math.max(40, x2 - x - 28));
        els.tip.textContent =
          g.name + " — click to select these cards, double-click to rename";
      });
    };
    renderGroupsRef.current = renderGroups;
    renderGroups();

    const pulse = el("circle", {
      r: 5.5,
      class: "pulse",
      cx: -100,
      cy: -100,
      opacity: 0,
    });
    pulseRef.current = pulse;

    // Node dragging: NODES coords update live and every edge touching a moved
    // node (path + both arrowheads) is rebuilt each move, so links stay
    // attached while the user pulls cards apart to declutter overlapping
    // edges. A small movement threshold keeps a plain click still opening
    // the inspector.
    //
    // Dragging a SELECTED card moves the whole selection as one rigid block —
    // ⌘/Ctrl+A (or ⬚ Select all) then drag shoves the entire diagram around
    // the stage. The stage clamp is therefore computed for the block, not per
    // card: the offset is capped by whichever members sit furthest out,
    // otherwise cards would pile up against the edge and the arrangement
    // would collapse.
    const svg = stageRef.current;
    const toSvgPoint = (evt) => {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    };
    const refreshEdges = (ids) => {
      Object.keys(edgesRef.current).forEach((key) => {
        const e = edgesRef.current[key];
        if (!ids.has(e.from) && !ids.has(e.to)) return;
        e.el.setAttribute("d", buildPath(e.from, e.to));
        e.len = e.el.getTotalLength();
        if (e.hit) e.hit.setAttribute("d", e.el.getAttribute("d"));
        if (e.cut) {
          const mid = e.el.getPointAtLength(e.len / 2);
          e.cut.setAttribute("x", String(mid.x));
          e.cut.setAttribute("y", String(mid.y));
        }
        Object.keys(e.arrows).forEach((endId) => {
          e.arrows[endId].setAttribute(
            "points",
            arrowPoints(
              e.el,
              e.len,
              NODES[endId],
              endId === e.to ? "to" : "from",
            ),
          );
        });
        renderLabel(key); // the midpoint moved with the line
      });
    };
    const basePos = {};
    const dragState = { id: null, suppressClick: false, group: [], base: {} };

    const nodeEls = {};
    const noteEls = {};
    // Cards never rewrite their child coordinates — they ride a CSS transform
    // measured from where they were first drawn — so moving a card is "update
    // NODES + update the two vars".
    const moveNode = (nid, x, y) => {
      NODES[nid].x = x;
      NODES[nid].y = y;
      nodeEls[nid].style.setProperty("--drag-x", x - basePos[nid].x + "px");
      nodeEls[nid].style.setProperty("--drag-y", y - basePos[nid].y + "px");
    };
    Object.keys(NODES).forEach((id) => {
      const n = NODES[id];
      const g = el("g", {
        class: "node" + (n.external ? " external" : ""),
        "data-id": id,
      });
      g.appendChild(
        el("rect", {
          class: "node-card",
          x: n.x,
          y: n.y,
          width: NW,
          height: NH,
          rx: 12,
        }),
      );
      g.appendChild(
        el("circle", { cx: n.x + 30, cy: n.y + NH / 2, r: 19, fill: n.color }),
      );
      g.appendChild(
        el(
          "text",
          { class: "node-icon", x: n.x + 30, y: n.y + NH / 2 + 1 },
          n.icon,
        ),
      );
      g.appendChild(
        el("text", { class: "node-title", x: n.x + 58, y: n.y + 31 }, n.title),
      );
      g.appendChild(
        el("text", { class: "node-sub", x: n.x + 58, y: n.y + 50 }, n.sub),
      );
      // The note panel lives INSIDE the node group, so it rides the same CSS
      // transform as the card and needs no repositioning on drag.
      const noteBg = el("rect", {
        class: "node-note-bg",
        rx: 7,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
      const noteText = el("text", { class: "node-note" });
      g.appendChild(noteBg);
      g.appendChild(noteText);
      noteEls[id] = { bg: noteBg, text: noteText };
      g.addEventListener("click", () => {
        if (dragState.suppressClick) return;
        setSelectedLink(null);
        setInspected((prev) => (prev === id ? null : id));
      });
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        openNoteEditor(id);
      });
      basePos[id] = { x: n.x, y: n.y };
      g.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        // Shift / ⌘ / Ctrl click adds or removes this card from the selection
        // instead of dragging it or opening the inspector.
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          const sel = new Set(selectionRef.current);
          if (sel.has(id)) sel.delete(id);
          else sel.add(id);
          setSelection(sel);
          dragState.suppressClick = true;
          return;
        }
        const p = toSvgPoint(e);
        dragState.id = id;
        dragState.suppressClick = false;
        dragState.px = p.x;
        dragState.py = p.y;
        // Grabbing a selected card drags the whole selection; grabbing an
        // unselected one drags only it and leaves the selection alone.
        dragState.group = selectionRef.current.has(id)
          ? Array.from(selectionRef.current)
          : [id];
        dragState.base = {};
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        dragState.group.forEach((gid) => {
          const gn = NODES[gid];
          dragState.base[gid] = { x: gn.x, y: gn.y };
          minX = Math.min(minX, gn.x);
          maxX = Math.max(maxX, gn.x);
          minY = Math.min(minY, gn.y);
          maxY = Math.max(maxY, gn.y);
        });
        // Clamp the block, not each card: the offset the whole group may
        // travel is whatever its outermost members still have room for.
        dragState.minDx = 4 - minX;
        dragState.maxDx = STAGE_W - NW - 4 - maxX;
        dragState.minDy = 4 - minY;
        dragState.maxDy = STAGE_H - NH - 4 - maxY;
        g.setPointerCapture(e.pointerId);
      });
      g.addEventListener("pointermove", (e) => {
        if (dragState.id !== id) return;
        const p = toSvgPoint(e);
        let dx = p.x - dragState.px;
        let dy = p.y - dragState.py;
        if (!dragState.suppressClick && Math.hypot(dx, dy) < 3) return;
        dragState.suppressClick = true;
        dx = Math.min(dragState.maxDx, Math.max(dragState.minDx, dx));
        dy = Math.min(dragState.maxDy, Math.max(dragState.minDy, dy));
        const moved = new Set();
        dragState.group.forEach((gid) => {
          const b = dragState.base[gid];
          nodeEls[gid].classList.add("dragging");
          moveNode(gid, b.x + dx, b.y + dy);
          moved.add(gid);
        });
        refreshEdges(moved);
        renderGroups(); // boxes are drawn from where their cards are
      });
      const endDrag = () => {
        if (dragState.id !== id) return;
        dragState.id = null;
        dragState.group.forEach((gid) =>
          nodeEls[gid].classList.remove("dragging"),
        );
        // Dragging is deliberately NOT persisted here — the 💾 Save layout
        // button is what commits it, so a viewer can shove cards around to
        // read a busy diagram and reload to get the saved layout back.
        if (dragState.suppressClick) setLayoutDirty(true);
      };
      g.addEventListener("pointerup", endDrag);
      g.addEventListener("pointercancel", endDrag);
      stageRef.current.appendChild(g);
      nodeEls[id] = g;
    });
    nodeElsRef.current = nodeEls;

    // Keep card text inside the card. Node names come from the architecture
    // doc, so some are simply longer than the 180px box — before this, they
    // ran out over the card edge and across whatever was next to them. Titles
    // shrink a couple of points before they truncate (a component's name is
    // worth more than a uniform type size); subtitles are phrases, so they
    // wrap to a second line first. Whatever still doesn't fit is cut with an
    // ellipsis and gets a <title> so the full string is one hover away (the
    // inspector always shows it in full).
    //
    // Measuring needs the text laid out in the document, which is why this is
    // a pass over the finished cards rather than part of the loop that builds
    // them.
    const TEXT_X = 58; // icon gutter
    const TEXT_MAX = NW - TEXT_X - 12; // minus right padding
    Object.keys(NODES).forEach((id) => {
      const n = NODES[id];
      const titleEl = nodeEls[id].querySelector(".node-title");
      const subEl = nodeEls[id].querySelector(".node-sub");

      let size = 13.5;
      while (titleEl.getComputedTextLength() > TEXT_MAX && size > 11) {
        size = Math.max(11, size - 0.5);
        titleEl.style.fontSize = size + "px";
      }
      if (ellipsize(titleEl, TEXT_MAX)) fullTextTip(titleEl, n.title);

      if (subEl.getComputedTextLength() > TEXT_MAX) {
        const words = String(n.sub).trim().split(/\s+/);
        if (words.length < 2) {
          // One unbreakable word — nothing to wrap, so just trim it.
          if (ellipsize(subEl, TEXT_MAX)) fullTextTip(subEl, n.sub);
        } else {
          // Longest first line that fits, so line 2 carries the rest.
          let cut = words.length - 1;
          while (cut > 1) {
            subEl.textContent = words.slice(0, cut).join(" ");
            if (subEl.getComputedTextLength() <= TEXT_MAX) break;
            cut--;
          }
          subEl.textContent = "";
          const l1 = el(
            "tspan",
            { x: n.x + TEXT_X, y: n.y + 47 },
            words.slice(0, cut).join(" "),
          );
          const l2 = el(
            "tspan",
            { x: n.x + TEXT_X, y: n.y + 59 },
            words.slice(cut).join(" "),
          );
          subEl.appendChild(l1);
          subEl.appendChild(l2);
          const cut1 = ellipsize(l1, TEXT_MAX);
          const cut2 = ellipsize(l2, TEXT_MAX);
          if (cut1 || cut2) fullTextTip(subEl, n.sub);
        }
      }
    });

    // ---- Node notes -------------------------------------------------------
    // A viewer's own margin, pinned under the card: the caveats a diagram
    // can't hold. Wrapped to at most three lines the width of the card, on a
    // quiet panel so it reads as attached to that card rather than floating on
    // the stage. Everything sits inside the node group, so a dragged card
    // takes its note with it.
    const NOTE_W = NW + 16;
    const NOTE_LINES = 3;
    const NOTE_LH = 13;
    const renderNote = (id) => {
      const els = noteEls[id];
      if (!els) return;
      const n = NODES[id];
      const txt = noteFor(id);
      while (els.text.firstChild) els.text.removeChild(els.text.firstChild);
      if (!txt) {
        els.text.style.display = "none";
        els.bg.style.display = "none";
        return;
      }
      els.text.style.display = "";
      els.bg.style.display = "";
      // Greedy wrap: fill each line with as many words as fit, and trim the
      // last one if the note outruns the three lines it's given.
      const max = NOTE_W - 16;
      const widthOf = (s) => {
        els.text.textContent = s; // the element itself is the ruler
        return els.text.getComputedTextLength();
      };
      const lines = [];
      let line = "";
      txt.split(" ").forEach((w) => {
        const next = line ? line + " " + w : w;
        if (line && widthOf(next) > max) {
          lines.push(line);
          line = w;
        } else {
          line = next;
        }
      });
      if (line) lines.push(line);
      const shown = lines.slice(0, NOTE_LINES);
      // Anything past the third line joins it and gets trimmed there.
      if (lines.length > NOTE_LINES)
        shown[NOTE_LINES - 1] += " " + lines.slice(NOTE_LINES).join(" ");
      els.text.textContent = "";

      const top = n.y + NH + 8;
      let widest = 0;
      shown.forEach((s, i) => {
        const t = el(
          "tspan",
          { x: n.x + NW / 2, y: top + 12 + i * NOTE_LH },
          s,
        );
        els.text.appendChild(t);
        ellipsize(t, max);
        widest = Math.max(widest, t.getComputedTextLength());
      });
      els.bg.setAttribute("x", String(n.x + NW / 2 - widest / 2 - 8));
      els.bg.setAttribute("y", String(top));
      els.bg.setAttribute("width", String(widest + 16));
      els.bg.setAttribute("height", String(shown.length * NOTE_LH + 8));
    };
    renderNoteRef.current = renderNote;
    Object.keys(NODES).forEach(renderNote);

    stageRef.current.appendChild(pulse);

    const bubbleLayer = el("g", {});
    stageRef.current.appendChild(bubbleLayer);
    bubbleLayerRef.current = bubbleLayer;

    const dbParticlesGroup = el("g", { id: "dbParticlesGroup" });
    stageRef.current.appendChild(dbParticlesGroup);
    dbParticlesGroupRef.current = dbParticlesGroup;

    // OPTIONAL persistence-save flourish (file-transfer console + flying
    // particles). Wire DB_INGEST_FROM/DB_INGEST_TO/DB_INGEST_FILES below to
    // enable it for a "save to storage" step, or leave DB_INGEST_TO empty
    // (see DATA section note) to skip this block entirely — the generic
    // step animation still works fine without it.
    if (DB_INGEST_TO) {
      const pgConsoleFO = el("foreignObject", {
        id: "pgConsoleFO",
        x: DB_INGEST_CONSOLE_X,
        y: DB_INGEST_CONSOLE_Y,
        width: 255,
        height: 155,
        style: "display: none;",
      });
      const consoleDiv = document.createElement("div");
      consoleDiv.className = "transfer-modal";
      consoleDiv.innerHTML = `
        <div class="transfer-header">
          <span class="transfer-icon">${DB_INGEST_ICON}</span>
          <span class="transfer-title">${DB_INGEST_TITLE}</span>
          <span class="transfer-pct" id="transferPct">0%</span>
        </div>
        <div class="transfer-progress-container">
          <div class="transfer-progress-bar" id="transferProgressBar"></div>
        </div>
        <div class="transfer-stats">
          <div class="transfer-stat">Records: <span id="transferFiles">0 / ${DB_INGEST_FILES.length}</span></div>
          <div class="transfer-stat">Rate: <span id="transferRate">45.8 KB/s</span></div>
          <div class="transfer-stat">Time Left: <span id="transferTimeLeft">15s</span></div>
        </div>
        <div class="transfer-log" id="transferLog"></div>
      `;
      pgConsoleFO.appendChild(consoleDiv);
      stageRef.current.appendChild(pgConsoleFO);
      pgConsoleFORef.current = pgConsoleFO;
    }

    // Rubber-band selection. Appended last so the band draws over everything,
    // and pointer-events:none so it can never swallow the drag creating it.
    const marquee = el("rect", {
      class: "marquee",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      style: "display: none;",
    });
    stageRef.current.appendChild(marquee);

    // A pointerdown whose target IS the <svg> happened on empty stage —
    // anything drawn (card, edge, hit twin) is its own target, so this never
    // steals a click from them.
    const band = { on: false, moved: false, x0: 0, y0: 0, keep: [] };
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target !== svg || e.pointerType === "touch")
        return;
      const p = toSvgPoint(e);
      band.on = true;
      band.moved = false;
      band.x0 = p.x;
      band.y0 = p.y;
      // Shift-banding extends the current selection instead of replacing it.
      band.keep =
        e.shiftKey || e.metaKey || e.ctrlKey
          ? Array.from(selectionRef.current)
          : [];
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!band.on) return;
      const p = toSvgPoint(e);
      const x = Math.min(band.x0, p.x);
      const y = Math.min(band.y0, p.y);
      const w = Math.abs(p.x - band.x0);
      const h = Math.abs(p.y - band.y0);
      if (!band.moved && Math.hypot(w, h) < 3) return;
      band.moved = true;
      marquee.setAttribute("x", String(x));
      marquee.setAttribute("y", String(y));
      marquee.setAttribute("width", String(w));
      marquee.setAttribute("height", String(h));
      marquee.style.display = "";
      // Touched, not enclosed: brushing a card is enough to catch it.
      const hit = new Set(band.keep);
      Object.keys(NODES).forEach((nid) => {
        const nn = NODES[nid];
        if (nn.x < x + w && nn.x + NW > x && nn.y < y + h && nn.y + NH > y)
          hit.add(nid);
      });
      setSelection(hit);
    });
    const endBand = () => {
      if (!band.on) return;
      band.on = false;
      marquee.style.display = "none";
      // A click on empty stage (no band drawn) means "deselect".
      if (!band.moved) setSelection([]);
    };
    svg.addEventListener("pointerup", endBand);
    svg.addEventListener("pointercancel", endBand);

    resetAnimation(false);
  }, []);

  // Paint selection + severed styling from the current REMOVED_LINKS set.
  // Declared AFTER the build effect on purpose: effects run in declaration
  // order, and this one needs the edges to exist (a demo reloaded with
  // removals already in storage must show them severed on first paint).
  useEffect(() => {
    Object.keys(edgesRef.current).forEach((key) => {
      const e = edgesRef.current[key];
      const off = REMOVED_LINKS.has(key);
      e.el.classList.toggle("removed", off);
      e.el.classList.toggle("selected", key === selectedLink);
      Object.values(e.arrows).forEach((a) =>
        a.classList.toggle("removed", off),
      );
      if (e.cut) {
        const mid = e.el.getPointAtLength(e.len / 2);
        e.cut.setAttribute("x", String(mid.x));
        e.cut.setAttribute("y", String(mid.y));
        e.cut.style.display = off ? "" : "none";
      }
      // Labels hide behind the ✕ of a severed link and come back when it's
      // restored, so this has to run with the rest of the repaint.
      if (renderLabelRef.current) renderLabelRef.current(key);
    });
  }, [selectedLink, linkVersion, labelVersion]);

  // Remove / restore one connection. The demo is re-rendered at the current
  // step so the consequence is immediately visible: steps that need the link
  // turn into blocked entries in the activity log (and vice versa).
  function toggleLink(key) {
    if (!key) return;
    if (REMOVED_LINKS.has(key)) REMOVED_LINKS.delete(key);
    else REMOVED_LINKS.add(key);
    saveRemovedLinks();
    invalidateStatuses();
    setLinkVersion((v) => v + 1);
    jumpTo(idxRef.current);
  }

  function restoreAllLinks() {
    if (REMOVED_LINKS.size === 0) return;
    REMOVED_LINKS.clear();
    saveRemovedLinks();
    invalidateStatuses();
    setLinkVersion((v) => v + 1);
    jumpTo(idxRef.current);
  }

  function clearActive() {
    Object.values(edgesRef.current).forEach((e) =>
      e.el.classList.remove(
        "active",
        "flow",
        "call",
        "data",
        "flow-reverse",
        "blocked-flash",
      ),
    );
    Object.values(nodeElsRef.current).forEach((g) =>
      g.classList.remove("active", "working", "db-ingesting", "blocked"),
    );
    if (pulseRef.current) pulseRef.current.setAttribute("opacity", "0");
    allArrowsRef.current.forEach((a) => a.classList.remove("blink"));
    clearBubbles();
    if (pgConsoleFORef.current) {
      pgConsoleFORef.current.style.display = "none";
      const innerConsole =
        pgConsoleFORef.current.querySelector(".transfer-modal");
      if (innerConsole) innerConsole.classList.remove("show");
    }
    if (dbParticlesGroupRef.current) dbParticlesGroupRef.current.innerHTML = "";
  }

  function clearBubbles() {
    while (bubbleElsRef.current.length > 0) {
      const fo = bubbleElsRef.current.pop();
      if (fo && bubbleLayerRef.current) bubbleLayerRef.current.removeChild(fo);
    }
  }

  function addBubble(nodeId, text) {
    const n = NODES[nodeId];
    if (!n || !bubbleLayerRef.current) return;

    const top = n.y < STAGE_H / 2;
    const W = 200;
    const foH = top ? 95 : 85;
    let bx = n.x + NW / 2 - W / 2;
    bx = Math.max(8, Math.min(bx, STAGE_W - W - 8));
    const by = top ? n.y - 101 : n.y + NH + 4;

    const fo = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "foreignObject",
    );
    fo.setAttribute("x", String(bx));
    fo.setAttribute("y", String(by));
    fo.setAttribute("width", String(W));
    fo.setAttribute("height", String(foH));

    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap " + (top ? "above" : "below");
    const b = document.createElement("div");
    b.className = "bubble " + (top ? "tail-down" : "tail-up");
    const who = document.createElement("span");
    who.className = "bubble-who";
    who.textContent = NODES[nodeId].title;
    b.appendChild(who);
    b.appendChild(document.createTextNode(text));
    wrap.appendChild(b);
    fo.appendChild(wrap);

    bubbleLayerRef.current.appendChild(fo);
    bubbleElsRef.current.push(fo);
  }

  function blinkArrow(edge, destId) {
    const a = edge.arrows[destId];
    if (!a) return;
    a.classList.remove("blink");
    void a.getBBox();
    a.classList.add("blink");
  }

  function travelBall(edge, srcId, dstId, kind, travelMs) {
    return new Promise((res) => {
      const forward = edge.from === srcId;
      edge.el.classList.remove("call", "data", "flow-reverse");
      edge.el.classList.add(kind);
      if (!forward) edge.el.classList.add("flow-reverse");
      if (pulseRef.current) {
        pulseRef.current.setAttribute(
          "class",
          "pulse " + (kind === "data" ? "data" : "call"),
        );
        pulseRef.current.setAttribute("opacity", "1");
      }
      const t0 = performance.now();
      const tick = (now) => {
        let p = (now - t0) / travelMs;
        if (p > 1) p = 1;
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const t = forward ? eased : 1 - eased;
        const pt = edge.el.getPointAtLength(edge.len * t);
        if (pulseRef.current) {
          pulseRef.current.setAttribute("cx", String(pt.x));
          pulseRef.current.setAttribute("cy", String(pt.y));
        }
        if (p >= 1) res();
        else animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
    });
  }

  function waitMs(ms) {
    return new Promise((res) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (now - t0 >= ms) res();
        else animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
    });
  }

  function addLog(i) {
    if (!logRef.current) return;
    const s = STEPS[i];
    logRef.current
      .querySelectorAll(".log-item.cur")
      .forEach((n) => n.classList.remove("cur"));
    const item = document.createElement("div");
    const st = stepStatuses()[i];
    const note =
      st === "blocked"
        ? '<span class="log-blocked">blocked — connection removed</span>'
        : st === "unreachable"
          ? '<span class="log-skipped">skipped — never reached</span>'
          : "";
    const num = st === "blocked" ? "✕" : st === "unreachable" ? "–" : i + 1;
    item.className = "log-item cur " + s.k + (st === "ok" ? "" : " " + st);
    item.innerHTML = `
      <div class="log-num">${num}</div>
      <div class="log-body">
        <span class="log-route">${s.route}</span>
        ${note}
        ${s.m}
      </div>
    `;
    item.title = "Jump to this step";
    item.addEventListener("click", () => jumpTo(i));
    logRef.current.appendChild(item);
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }

  function markDone(id) {
    const node = nodeElsRef.current[id];
    if (node) node.classList.add("done");
  }

  function triggerDbIngestAnimation(currentSpeed) {
    return new Promise((resolveAnimation) => {
      const dbNode = nodeElsRef.current[DB_INGEST_TO];
      if (dbNode) dbNode.classList.add("db-ingesting");

      if (pgConsoleFORef.current) {
        pgConsoleFORef.current.style.display = "block";
        pgConsoleFORef.current.getBoundingClientRect();
        const innerConsole =
          pgConsoleFORef.current.querySelector(".transfer-modal");
        if (innerConsole) innerConsole.classList.add("show");
      }

      const pctEl = document.getElementById("transferPct");
      const barEl = document.getElementById("transferProgressBar");
      const filesEl = document.getElementById("transferFiles");
      const rateEl = document.getElementById("transferRate");
      const timeLeftEl = document.getElementById("transferTimeLeft");
      const localLogEl = document.getElementById("transferLog");
      if (localLogEl) localLogEl.innerHTML = "";

      const files = DB_INGEST_FILES;
      const totalDuration = 15000 / currentSpeed;
      const startTime = performance.now();
      let lastFileIdx = -1;
      let lastRateUpdate = 0;
      const transferActive = true;

      function addConsoleLog(text, type = "normal") {
        if (!localLogEl) return;
        const line = document.createElement("div");
        line.className = "log-line " + type;
        line.textContent = text;
        localLogEl.appendChild(line);
        localLogEl.scrollTop = localLogEl.scrollHeight;
      }

      addConsoleLog("Opening transaction...", "active");

      const progressTick = (now) => {
        if (!transferActive) return;
        const elapsed = now - startTime;
        const pct = Math.min(100, (elapsed / totalDuration) * 100);

        if (pctEl) pctEl.textContent = Math.round(pct) + "%";
        if (barEl) barEl.style.width = pct + "%";

        const secondsLeft = Math.max(
          0,
          Math.ceil((totalDuration - elapsed) / 1000),
        );
        if (timeLeftEl) timeLeftEl.textContent = secondsLeft + "s";

        if (now - lastRateUpdate > 1200) {
          lastRateUpdate = now;
          const rate = (30 + Math.random() * 25).toFixed(1);
          if (rateEl) rateEl.textContent = rate + " KB/s";
        }

        const step = 100 / files.length;
        const fileIdx = Math.floor(pct / step);
        if (fileIdx > lastFileIdx && fileIdx < files.length) {
          lastFileIdx = fileIdx;
          const f = files[fileIdx];
          if (filesEl) filesEl.textContent = `${fileIdx + 1} / ${files.length}`;
          addConsoleLog(
            `[${Math.round(pct)}%] Writing ${f.name} (${f.size})...`,
            "active",
          );
          if (localLogEl) {
            const lines = localLogEl.querySelectorAll(".log-line");
            if (lines.length > 1) {
              const prevLine = lines[lines.length - 2];
              prevLine.className = "log-line success";
              prevLine.textContent = "✓ " + prevLine.textContent.substring(4);
            }
          }
        }

        if (pct < 100) {
          animRef.current = requestAnimationFrame(progressTick);
        } else {
          if (filesEl)
            filesEl.textContent = `${files.length} / ${files.length}`;
          if (timeLeftEl) timeLeftEl.textContent = "0s";
          if (localLogEl) {
            const lines = localLogEl.querySelectorAll(".log-line");
            if (lines.length > 0) {
              const last = lines[lines.length - 1];
              last.className = "log-line success";
              if (last.textContent.startsWith("["))
                last.textContent = "✓ " + last.textContent.substring(6);
            }
          }
          addConsoleLog("✓ COMMIT — transaction closed.", "success");
          addConsoleLog("Saved. Next run will be smarter.", "finish");
          setTimeout(() => {
            if (dbNode) dbNode.classList.remove("db-ingesting");
            resolveAnimation();
          }, 1000);
        }
      };
      animRef.current = requestAnimationFrame(progressTick);

      if (dbParticlesGroupRef.current) {
        dbParticlesGroupRef.current.innerHTML = "";
        const { startX, startY, endX, endY } = DB_INGEST_PARTICLE_PATH;
        const spawnInterval = 500 / currentSpeed;
        let spawnedCount = 0;
        const maxSpawns = Math.floor(totalDuration / spawnInterval) - 2;
        const fileEmojis = ["📄", "📝", "📊", "📁", "⚡", "🗃️"];

        const spawnFileIcon = () => {
          if (
            spawnedCount >= maxSpawns ||
            !transferActive ||
            !dbParticlesGroupRef.current
          )
            return;
          spawnedCount++;
          const emoji =
            fileEmojis[Math.floor(Math.random() * fileEmojis.length)];
          const p = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "text",
          );
          p.setAttribute("x", String(startX));
          p.setAttribute("y", String(startY));
          p.setAttribute("font-size", "13px");
          p.setAttribute("text-anchor", "middle");
          p.setAttribute("dominant-baseline", "middle");
          p.setAttribute("opacity", "0.9");
          p.setAttribute(
            "style",
            `cursor: default; user-select: none; font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji';`,
          );
          p.textContent = emoji;
          dbParticlesGroupRef.current.appendChild(p);

          const iconStartTime = performance.now();
          const duration = (900 + Math.random() * 400) / currentSpeed;
          const offsetX = (Math.random() - 0.5) * 30;
          const offsetY = -25 - Math.random() * 45;

          const animateIcon = (now) => {
            const elapsed = now - iconStartTime;
            const pct = Math.min(1, elapsed / duration);
            const eased =
              pct < 0.5
                ? 4 * pct * pct * pct
                : 1 - Math.pow(-2 * pct + 2, 3) / 2;
            const cx =
              startX +
              (endX - startX) * eased +
              offsetX * Math.sin(pct * Math.PI);
            const cy =
              startY +
              (endY - startY) * eased +
              offsetY * Math.sin(pct * Math.PI);
            const rotation = eased * 360;
            p.setAttribute("x", String(cx));
            p.setAttribute("y", String(cy));
            p.setAttribute("transform", `rotate(${rotation}, ${cx}, ${cy})`);
            p.setAttribute("opacity", String(1 - eased));
            if (pct < 1) requestAnimationFrame(animateIcon);
            else p.remove();
          };
          requestAnimationFrame(animateIcon);
          setTimeout(spawnFileIcon, spawnInterval);
        };
        spawnFileIcon();
      }
    });
  }

  function runStep(i) {
    return new Promise((resolve) => {
      const s = STEPS[i];
      clearActive();
      setPhaseText(PHASES[s.ph]);
      setProgress(i);
      addLog(i);

      const currentSpeed = speedRef.current;
      let dur = BASE / currentSpeed;
      const V = 0.125 * currentSpeed;

      const status = stepStatuses()[i];

      // The link this step needs was removed by the user: nothing travels.
      // The source flashes red, says why, and the run carries on to the next
      // step — that "what still works without this link?" read is the whole
      // point of being able to cut a connection.
      if (status === "blocked") {
        const srcNode = nodeElsRef.current[stepInitiator(s)];
        if (srcNode) srcNode.classList.add("active", "blocked");
        const deadEdge = edgesRef.current[pairKey(s.f, s.t)];
        if (deadEdge) deadEdge.el.classList.add("blocked-flash");
        const other = stepInitiator(s) === s.f ? s.t : s.f;
        addBubble(stepInitiator(s), "✕ No connection to " + NODES[other].title);
        const tBlocked = performance.now();
        const blockedTick = (now) => {
          if (now - tBlocked >= 1300 / currentSpeed) resolve();
          else animRef.current = requestAnimationFrame(blockedTick);
        };
        animRef.current = requestAnimationFrame(blockedTick);
        return;
      }

      // Nothing ever reached this step's initiator, because an upstream step
      // was blocked. It can't happen, so nothing is drawn — the log entry
      // (already added above) carries the "skipped — never reached" note and
      // the run moves on after a short beat.
      if (status === "unreachable") {
        const tSkipped = performance.now();
        const skipTick = (now) => {
          if (now - tSkipped >= 450 / currentSpeed) resolve();
          else animRef.current = requestAnimationFrame(skipTick);
        };
        animRef.current = requestAnimationFrame(skipTick);
        return;
      }

      const chat = s.chat || [];
      const shownChat = new Array(chat.length).fill(false);
      const revealChat = (elapsed) => {
        for (let c = 0; c < chat.length; c++) {
          if (shownChat[c]) continue;
          const at = dur * Math.min(0.5, c * 0.42);
          if (elapsed >= at) {
            shownChat[c] = true;
            addBubble(chat[c][0], chat[c][1]);
          }
        }
      };

      if (s.f === s.t) {
        dur = 1600 / currentSpeed;
        const activeNode = nodeElsRef.current[s.f];
        if (activeNode) activeNode.classList.add("active", "working");
        const t0 = performance.now();
        const tick = (now) => {
          revealChat(now - t0);
          if (now - t0 >= dur) {
            if (activeNode) activeNode.classList.remove("working");
            markDone(s.f);
            resolve();
          } else {
            animRef.current = requestAnimationFrame(tick);
          }
        };
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      if (s.roundTrip) {
        const rtEdge = edgesRef.current[pairKey(s.f, s.t)];
        const asker = s.t;
        const responder = s.f;
        rtEdge.el.classList.remove("call", "data");
        rtEdge.el.classList.add("active", "flow", "call");
        const askerNode = nodeElsRef.current[asker];
        const responderNode = nodeElsRef.current[responder];
        if (askerNode) askerNode.classList.add("active");
        if (responderNode) responderNode.classList.add("active");

        const leg = rtEdge.len / V;
        (async () => {
          if (chat[0]) addBubble(chat[0][0], chat[0][1]);
          await travelBall(rtEdge, asker, responder, "call", leg);
          blinkArrow(rtEdge, responder);
          await waitMs(200 / currentSpeed);
          if (chat[1]) addBubble(chat[1][0], chat[1][1]);
          await travelBall(rtEdge, responder, asker, "data", leg);
          blinkArrow(rtEdge, asker);
          await waitMs(300 / currentSpeed);
          markDone(asker);
          markDone(responder);
          resolve();
        })();
        return;
      }

      const edge = edgesRef.current[pairKey(s.f, s.t)];
      const forward = edge.from === s.f;
      edge.el.classList.remove("call", "data", "flow-reverse");
      edge.el.classList.add("active", "flow", s.k);
      if (!forward) edge.el.classList.add("flow-reverse");
      const fromNode = nodeElsRef.current[s.f];
      const toNode = nodeElsRef.current[s.t];
      if (fromNode) fromNode.classList.add("active");
      if (toNode) toNode.classList.add("active");

      if (pulseRef.current) {
        pulseRef.current.setAttribute(
          "class",
          "pulse " + (s.k === "data" ? "data" : "call"),
        );
        pulseRef.current.setAttribute("opacity", "1");
      }

      const travel = edge.len / V;
      dur = travel + 600 / currentSpeed;
      const t0 = performance.now();
      let arrived = false;

      const tick = async (now) => {
        revealChat(now - t0);
        let p = (now - t0) / travel;
        if (p > 1) p = 1;
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const t = forward ? eased : 1 - eased;
        const pt = edge.el.getPointAtLength(edge.len * t);
        if (pulseRef.current) {
          pulseRef.current.setAttribute("cx", String(pt.x));
          pulseRef.current.setAttribute("cy", String(pt.y));
        }

        if (p >= 1 && !arrived) {
          arrived = true;
          blinkArrow(edge, s.t);
          if (DB_INGEST_TO && s.f === DB_INGEST_FROM && s.t === DB_INGEST_TO)
            triggerDbIngestAnimation(currentSpeed);
        }

        const extraWait =
          DB_INGEST_TO && s.f === DB_INGEST_FROM && s.t === DB_INGEST_TO
            ? 15000 / currentSpeed
            : 0;
        if (p >= 1 && now - t0 >= dur + extraWait) {
          markDone(s.f);
          markDone(s.t);
          resolve();
        } else {
          animRef.current = requestAnimationFrame(tick);
        }
      };
      animRef.current = requestAnimationFrame(tick);
    });
  }

  async function advance() {
    if (idxRef.current >= STEPS.length - 1) {
      stopPlay();
      return false;
    }
    idxRef.current++;
    await runStep(idxRef.current);
    if (idxRef.current >= STEPS.length - 1) {
      stopPlay();
      resetAnimation(true, true);
      setPhaseText("Run completed");
      markRunCompleteInLog();
    }
    return true;
  }

  function markRunCompleteInLog() {
    if (!logRef.current) return;
    logRef.current
      .querySelectorAll(".log-item.cur")
      .forEach((n) => n.classList.remove("cur"));
    const statuses = stepStatuses();
    const blocked = statuses.filter((s) => s === "blocked").length;
    const skipped = statuses.filter((s) => s === "unreachable").length;
    const parts = [];
    if (blocked) parts.push(blocked + " blocked");
    if (skipped) parts.push(skipped + " never reached");
    const item = document.createElement("div");
    item.className = "log-item cur";
    item.innerHTML = `
      <div class="log-num" style="background: ${parts.length ? "#ef4444" : "#22c55e"};">${parts.length ? "!" : "✓"}</div>
      <div class="log-body">
        <span class="log-route">System</span>
        Run completed${parts.length ? " — " + parts.join(", ") : ""}
      </div>
    `;
    logRef.current.appendChild(item);
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }

  async function loop() {
    while (playingRef.current) {
      const more = await advance();
      if (!more) break;
    }
  }

  function startPlay() {
    if (idxRef.current >= STEPS.length - 1) resetAnimation(false);
    else if (idxRef.current === -1 && logRef.current)
      logRef.current.innerHTML = "";
    setIsPlaying(true);
    playingRef.current = true;
    loop();
  }

  function stopPlay() {
    setIsPlaying(false);
    playingRef.current = false;
    if (animRef.current) cancelAnimationFrame(animRef.current);
  }

  function resetAnimation(repaint = true, keepLogs = false) {
    stopPlay();
    idxRef.current = -1;
    setProgress(-1);
    clearActive();
    Object.values(nodeElsRef.current).forEach((g) =>
      g.classList.remove("done"),
    );
    if (!keepLogs && logRef.current) logRef.current.innerHTML = "";
    if (repaint) setPhaseText("Ready");
  }

  // Jump the demo to the state where step `target` has just completed:
  // done-marks and the activity log are rebuilt for steps 0..target, and the
  // target step's nodes, edge and chat are shown statically so the jumped-to
  // moment reads at a glance. target = -1 lands on the pristine "Ready" state.
  // This backs the scrubber, the ⏮ Back button, the clickable activity log,
  // and the inspector's step chips.
  function jumpTo(target) {
    if (ffRef.current) return;
    stopPlay();
    target = Math.max(-1, Math.min(STEPS.length - 1, target));
    idxRef.current = target;
    setProgress(target);
    clearActive();
    Object.values(nodeElsRef.current).forEach((g) =>
      g.classList.remove("done"),
    );
    if (logRef.current) logRef.current.innerHTML = "";
    const statuses = stepStatuses();
    for (let i = 0; i <= target; i++) {
      // A blocked or unreachable step never ran, so neither end gets a
      // done-mark.
      if (statuses[i] === "ok") {
        markDone(STEPS[i].f);
        markDone(STEPS[i].t);
      }
      addLog(i);
    }
    if (target < 0) {
      setPhaseText("Ready");
      return;
    }
    const s = STEPS[target];
    setPhaseText(PHASES[s.ph]);
    if (statuses[target] === "blocked") {
      const srcNode = nodeElsRef.current[stepInitiator(s)];
      if (srcNode) srcNode.classList.add("active", "blocked");
      const other = stepInitiator(s) === s.f ? s.t : s.f;
      addBubble(stepInitiator(s), "✕ No connection to " + NODES[other].title);
      return;
    }
    // An unreachable step has nothing to show on the stage.
    if (statuses[target] === "unreachable") return;
    const fromNode = nodeElsRef.current[s.f];
    const toNode = nodeElsRef.current[s.t];
    if (fromNode) fromNode.classList.add("active");
    if (toNode) toNode.classList.add("active");
    if (s.f !== s.t) {
      const edge = edgesRef.current[pairKey(s.f, s.t)];
      if (edge)
        edge.el.classList.add("active", s.k === "data" ? "data" : "call");
    }
    (s.chat || []).forEach((c) => addBubble(c[0], c[1]));
  }

  function scrubToEvent(e) {
    const track = scrubTrackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    let frac = (e.clientX - r.left) / r.width;
    frac = Math.max(0, Math.min(0.999, frac));
    const i = Math.floor(frac * STEPS.length);
    if (i !== idxRef.current) jumpTo(i);
  }

  // Advance exactly ONE step, animated at the current speed. The step's final
  // state (active edge, chat bubbles) stays on screen afterwards so the user
  // can read what just happened before stepping again.
  async function handleStep() {
    if (playingRef.current || ffRef.current) return;
    if (idxRef.current >= STEPS.length - 1) return;
    setIsDoneDisabled(true);
    ffRef.current = true;
    await advance();
    ffRef.current = false;
    setIsDoneDisabled(false);
  }

  function adjustSpeed(amount) {
    let nextSpeed = speed + amount;
    nextSpeed = parseFloat(nextSpeed.toFixed(1));
    if (nextSpeed >= 0.1 && nextSpeed <= 3.0) setSpeed(nextSpeed);
  }

  // How many LATER steps this link strands (or, once cut, would get back) —
  // the answer to "is this connection load-bearing?", shown in the inspector
  // before the user commits to cutting it. linkVersion keeps it fresh.
  function strandedBy(key) {
    if (!key) return 0;
    const now = stepStatuses();
    if (REMOVED_LINKS.has(key)) {
      const restored = computeStatuses(null, key);
      return now.filter(
        (s, i) => s === "unreachable" && restored[i] !== "unreachable",
      ).length;
    }
    const cut = computeStatuses(key, null);
    return cut.filter((s, i) => s === "unreachable" && now[i] !== "unreachable")
      .length;
  }

  return (
    <div
      ref={containerRef}
      className={`archflow-container ${theme === "light" ? "light" : ""}`}
    >
      <header>
        <div>
          <h1>{TITLE}</h1>
          <p>{SUBTITLE}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            {theme === "dark" ? "☀ Light" : "🌙 Dark"}
          </button>
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
          >
            {isFullscreen ? "🗗 Exit" : "⛶ Fullscreen"}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <button
          onClick={() => (isPlaying ? stopPlay() : startPlay())}
          className={!isPlaying ? "primary" : ""}
          disabled={isDoneDisabled}
        >
          {isPlaying
            ? "⏸ Pause"
            : progress >= STEPS.length - 1
              ? "▶ Replay"
              : "▶ Play"}
        </button>
        <button
          onClick={() => jumpTo(idxRef.current - 1)}
          disabled={isPlaying || isDoneDisabled || progress < 0}
          title="Back one step"
        >
          ⏮ Back
        </button>
        <button onClick={handleStep} disabled={isPlaying || isDoneDisabled}>
          ⏭ Step
        </button>
        <button onClick={() => resetAnimation(true)} disabled={isDoneDisabled}>
          ↻ Restart
        </button>
        <button
          onClick={() => {
            saveLayout();
            setLayoutDirty(false);
            setLayoutSaved(true);
            setTimeout(() => setLayoutSaved(false), 1600);
          }}
          disabled={!layoutDirty}
          title="Remember where you dragged the cards, so this layout comes back on reload"
        >
          {layoutSaved ? "✓ Saved" : "💾 Save layout"}
        </button>
        <button
          onClick={exportLayout}
          title="Download the current card positions and link labels so they can be baked into the file as the defaults (survives browser profiles and machines)"
        >
          ⬇ Export edits
        </button>
        <button
          onClick={toggleSelectAll}
          title="Select every card (⌘/Ctrl+A), then drag any one of them to move the whole diagram. Shift-click a card or rubber-band the empty stage to pick a few; Esc clears."
        >
          {selCount ? `✕ Clear (${selCount})` : "⬚ Select all"}
        </button>
        <button
          onClick={toggleGroup}
          disabled={matchedGroup === -1 && selCount < 2}
          title={
            matchedGroup === -1
              ? "Draw a named box around the selected cards (select two or more first)"
              : "Remove this box — the cards stay where they are"
          }
        >
          {matchedGroup === -1 ? "▣ Group" : "⤫ Ungroup"}
        </button>
        <button
          onClick={restoreAllLinks}
          disabled={REMOVED_LINKS.size === 0}
          title="Reconnect every link you removed (click a link on the diagram to remove one)"
        >
          ⛓ Links
          {REMOVED_LINKS.size > 0 ? ` (${REMOVED_LINKS.size})` : ""}
        </button>
        <span className="speed">
          Speed
          <button
            onClick={() => adjustSpeed(-0.1)}
            className="speed-btn"
            disabled={isDoneDisabled}
          >
            −
          </button>
          <span id="speedVal">{speed.toFixed(1)}×</span>
          <button
            onClick={() => adjustSpeed(0.1)}
            className="speed-btn"
            disabled={isDoneDisabled}
          >
            +
          </button>
        </span>
        <span className="spacer"></span>
        <span className="phase-tag">{phaseText}</span>
      </div>

      <div className="scrubber">
        <span className="scrub-count">
          {progress + 1} / {STEPS.length}
        </span>
        <div
          ref={scrubTrackRef}
          className="scrub-track"
          title="Drag or click to jump to any step"
          onPointerDown={(e) => {
            if (isDoneDisabled) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubToEvent(e);
          }}
          onPointerMove={(e) => {
            if (isDoneDisabled || e.buttons !== 1) return;
            scrubToEvent(e);
          }}
        >
          {STEPS.map((s, i) => (
            <div
              key={i}
              className={
                "scrub-seg" +
                (i <= progress ? " filled" : "") +
                (i > 0 && STEPS[i - 1].ph !== s.ph ? " phase-start" : "")
              }
            />
          ))}
        </div>
      </div>

      <div className="wrap">
        <div className="stage-area">
          <svg
            ref={stageRef}
            className="stage"
            viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
            preserveAspectRatio="xMidYMid meet"
            aria-label={TITLE}
          ></svg>
        </div>
        <aside className="side">
          {selectedLink &&
            NODES[selectedLink.split("|")[0]] &&
            NODES[selectedLink.split("|")[1]] && (
              <div className="inspector">
                <div className="inspector-head">
                  <span className="inspector-icon link-icon">⇄</span>
                  <div className="inspector-name">
                    <div className="inspector-title">
                      {NODES[selectedLink.split("|")[0]].title} ⇄{" "}
                      {NODES[selectedLink.split("|")[1]].title}
                    </div>
                    <div className="inspector-sub">Connection</div>
                  </div>
                  <button
                    className="inspector-close"
                    onClick={() => setSelectedLink(null)}
                    title="Close inspector"
                  >
                    ✕
                  </button>
                </div>
                {REMOVED_LINKS.has(selectedLink) && (
                  <span className="inspector-badge danger">
                    Removed — every step over this link is blocked
                  </span>
                )}
                {strandedBy(selectedLink) > 0 && (
                  <p className="inspector-impact">
                    {REMOVED_LINKS.has(selectedLink)
                      ? `Restoring it also brings back ${strandedBy(selectedLink)} later step${strandedBy(selectedLink) === 1 ? "" : "s"} that nothing currently reaches.`
                      : `Cutting it also strands ${strandedBy(selectedLink)} later step${strandedBy(selectedLink) === 1 ? "" : "s"} — nothing downstream would reach them.`}
                  </p>
                )}
                <div className="inspector-section">Label on the line</div>
                <div className="inspector-label-row">
                  <span
                    className={
                      "inspector-label-value" +
                      (labelFor(selectedLink) ? "" : " empty")
                    }
                  >
                    {labelFor(selectedLink) || "No label"}
                  </span>
                  <button
                    className="inspector-label-edit"
                    onClick={() =>
                      openLabelEditorRef.current &&
                      openLabelEditorRef.current(selectedLink)
                    }
                    title="Type the protocol or payload this connection carries (or double-click the line itself)"
                  >
                    ✎ Edit
                  </button>
                </div>
                <div className="inspector-section">Carries</div>
                <ul className="inspector-routes">
                  {linkInfo(selectedLink).routes.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <div className="inspector-section">
                  Used in steps
                  {REMOVED_LINKS.has(selectedLink) ? " (blocked)" : ""}
                </div>
                <div className="inspector-steps">
                  {linkInfo(selectedLink).stepIdxs.map((i) => (
                    <button
                      key={i}
                      className="inspector-step-chip"
                      onClick={() => jumpTo(i)}
                      title={STEPS[i].m}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
                <button
                  className={
                    "inspector-action" +
                    (REMOVED_LINKS.has(selectedLink) ? "" : " danger")
                  }
                  onClick={() => toggleLink(selectedLink)}
                  title={
                    REMOVED_LINKS.has(selectedLink)
                      ? "Put this connection back"
                      : "Cut this connection and see which steps stop working"
                  }
                >
                  {REMOVED_LINKS.has(selectedLink)
                    ? "↺ Restore connection"
                    : "✂ Remove connection"}
                </button>
              </div>
            )}
          {inspected && NODES[inspected] && (
            <div className="inspector">
              <div className="inspector-head">
                <span
                  className="inspector-icon"
                  style={{ background: NODES[inspected].color }}
                >
                  {NODES[inspected].icon}
                </span>
                <div className="inspector-name">
                  <div className="inspector-title">
                    {NODES[inspected].title}
                  </div>
                  <div className="inspector-sub">{NODES[inspected].sub}</div>
                </div>
                <button
                  className="inspector-close"
                  onClick={() => setInspected(null)}
                  title="Close inspector"
                >
                  ✕
                </button>
              </div>
              {NODES[inspected].external && (
                <span className="inspector-badge">
                  External system — depended on, not owned
                </span>
              )}
              {NODES[inspected].desc && (
                <p className="inspector-desc">{NODES[inspected].desc}</p>
              )}
              <div className="inspector-section">Note under the card</div>
              <div className="inspector-label-row">
                <span
                  className={
                    "inspector-label-value" +
                    (noteFor(inspected) ? "" : " empty")
                  }
                >
                  {noteFor(inspected) || "No note"}
                </span>
                <button
                  className="inspector-label-edit"
                  onClick={() =>
                    openNoteEditorRef.current &&
                    openNoteEditorRef.current(inspected)
                  }
                  title="Pin your own text under this card (or double-click the card itself)"
                >
                  ✎ Edit
                </button>
              </div>
              <div className="inspector-section">Connections</div>
              <ul className="inspector-routes">
                {nodeInfo(inspected).routes.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="inspector-section">Appears in steps</div>
              <div className="inspector-steps">
                {nodeInfo(inspected).stepIdxs.map((i) => (
                  <button
                    key={i}
                    className="inspector-step-chip"
                    onClick={() => jumpTo(i)}
                    title={STEPS[i].m}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          )}
          <h2>Activity log</h2>
          <div ref={logRef} className="log"></div>
        </aside>
      </div>

      <footer>
        <div className="legend">
          <span>
            <i className="dot" style={{ background: "var(--accent)" }}></i>{" "}
            control / hand-off
          </span>
          <span>
            <i className="dot" style={{ background: "#0ea5a4" }}></i> data
            returned
          </span>
          <span>
            <i className="dot" style={{ background: "#f59e0b" }}></i> working
          </span>
          <span>
            <i
              className="dot"
              style={{ background: "#374151", border: "1px dashed #94a3b8" }}
            ></i>{" "}
            external system
          </span>
          <span>
            <i className="dot" style={{ background: "#ef4444" }}></i> click a
            link to remove it
          </span>
        </div>
        <b>One corpus, two engines, two agents.</b> Every document becomes Markdown; the <b>RAG system</b> indexes it in PostgreSQL/pgvector and the <b>knowledge graph</b> maps what it connects, with a copy in <b>Neo4j</b> for Cypher. <b>Claude</b> writes every answer but never searches — retrieval and traversal do that, and every quote is checked against what was retrieved. <b>Ragas</b> grades each RAG answer, <b>Hindsight</b> gives the Evidence Agent memory, and <b>Langfuse</b> traces every run.
      </footer>
    </div>
  );
}

export default SparkDemoFlow;
