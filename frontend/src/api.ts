// Types and calls for the FastAPI endpoints in app.py.

export interface Upload {
  id: string;
  filename: string;
  format: string;
  size: number;
  pages: number;
  warning: string | null;
}

export interface Conversion {
  markdown: string;
  vlm_notice: string | null;
  pages: number;
  unit?: string;
  pictures: number;
  skipped_images: number;
  vlm_images: number;
  flows: number;
  flow_images: number;
  table_images: number;
  cv_flow_images: number;
  elapsed: number;
  ocr: { page: number; image: string; confidence: number; chars: number }[];
}

export interface EmbedResult {
  status: "added" | "updated" | "unchanged";
  title: string;
  chunks: number;
  tokens: number;
  duplicates: string[];
  documents: number;
  total_chunks: number;
  seconds: number;
  file: string;
}

/** A corpus a document can be filed in. One table holds them all and a
 *  category is a column of it, so `documents` and `chunks` are how much of the
 *  corpus this category accounts for. */
export interface CategoryInfo {
  code: string;
  label: string;
  description: string;
  folder: string;
  documents: number;
  chunks: number;
}

export interface RagStatus {
  missing: string[];
  embed_model: string;
  embed_provider?: string;
  embed_dimension?: number;
  answer_model: string;
  default_k: number;
  documents: number;
  chunks: number;
  categories: CategoryInfo[];
  /** Where a document may be filed. Wider than `categories`, which lists only
   *  what there is to search: a category holding nothing is still a valid
   *  destination, it just cannot be a filter yet. */
  ingest_categories?: CategoryInfo[];
  /** A fingerprint of the answering prompt. Two quality scores either side of
   *  a change to it are not comparable. */
  prompt_hash?: string;
  tracing?: { enabled: boolean; environment: string; host: string };
  evaluation?: EvaluationStatus;
  error: string | null;
}

export type StepKey = "embed" | "vector" | "keyword" | "fuse" | "answer";
export type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface StageEvent {
  key: StepKey;
  status: StepStatus;
  detail: string;
  ms?: number;
  terms?: string[];
}

export interface Source {
  n: number;
  title: string;
  section: string;
  content: string;
  category: string;
  score: number;
  similarity: number | null;
  bm25: number | null;
  vector_rank: number | null;
  keyword_rank: number | null;
  file?: string;
  source_path?: string;
}

export interface Done {
  seconds: number;
  input_tokens: number;
  output_tokens: number;
}

export type SearchMode = "hybrid" | "vector" | "keyword";

/** The judge's own working, kept on the way past.
 *
 *  Ragas computes all of this and then discards it -- its MetricResult comes
 *  back with no reason and no traces -- so it is intercepted at the judge LLM
 *  and normalised server-side into one of four shapes. The page draws the
 *  shape and never needs to know what an `NLIStatementOutput` is. */
export type MetricWorking =
  | { kind: "claims"; items: { text: string; supported: boolean; reason: string }[] }
  | { kind: "excerpts"; items: { n: number | null; useful: boolean; reason: string }[] }
  | { kind: "questions"; items: { text: string; noncommittal: boolean }[] }
  | { kind: "ratings"; items: { judge: number; rating: number | null; of: number; label: string }[] }
  | Record<string, never>;

/** One judge's verdict on one answer. `value` is null when that judge did not
 *  return -- which is different from a zero, and is drawn differently. */
export interface MetricScore {
  value: number | null;
  /** Why, in the judge's words. Ragas' own metrics return nothing here; the
   *  rubric-based ones (coherence, conciseness, the safety pair) do -- and for
   *  the Ragas five, `working` carries far more than a reason would. */
  reason: string;
  error: string;
  seconds?: number;
  working?: MetricWorking;
}

/** The arithmetic behind the overall score, kept so the number can be checked
 *  rather than believed. */
export interface EvaluationTerms {
  weights?: Record<string, number>;
  /** Judges that did not return, and so were left out of both sides of the
   *  mean instead of being counted as zero. */
  dropped?: string[];
  flagged?: string[];
  capped?: boolean;
  cap?: number;
}

export interface AskEvaluation {
  run_id?: string;
  /** `none` means nobody has judged this answer; `skipped` means we chose not
   *  to. The page says something different for each. */
  status: "none" | "running" | "done" | "failed" | "skipped" | "abandoned";
  judge_model?: string;
  ragas_version?: string;
  started_at?: string | null;
  finished_at?: string | null;
  seconds?: number;
  metrics: Record<string, MetricScore>;
  overall: number | null;
  safety: number | null;
  terms: EvaluationTerms;
  scores_pushed?: number;
  error?: string;
}

/** What scoring is configured to do, from /api/rag/status. Lets the page
 *  explain an absent scorecard instead of showing an empty panel. */
export interface EvaluationStatus {
  enabled: boolean;
  available: boolean;
  detail: string;
  judge_model?: string;
  ragas_version?: string;
  sample?: number;
  online?: string[];
  /** Needs a reference answer, so never scored on a live question. */
  reference_only?: string[];
  safety?: string[];
  weights?: Record<string, number>;
}

/** `?categories=PKG&categories=DR`, or nothing at all for the whole graph. */
function categoryQuery(categories: string[]): string {
  if (!categories.length) return "";
  return "?" + categories.map((c) => `categories=${encodeURIComponent(c)}`).join("&");
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === "string") throw new Error(detail);
    // A structured detail carries the explanation in `message`; without this
    // the caller sees only "Request failed (404)" and cannot tell the user
    // which category the document is actually in.
    const message = (detail as { message?: unknown } | null)?.message;
    throw new Error(typeof message === "string" ? message : `Request failed (${res.status})`);
  }
  return data as T;
}

export interface KbFileItem {
  name: string;
  title: string;
  size: number;
  /** Which corpus this document is filed in. */
  category?: string;
  /** The path it was indexed from. This identifies it -- two documents can
   *  share a file name -- and is what a delete is aimed with. */
  source?: string;
  full_path?: string;
  chunks?: number;
  tokens?: number;
  is_indexed?: boolean;
}

/** A document as the three stores see it: the file on disk, the row in the
 *  corpus, the node in the graph. Any of the three can be missing, which is
 *  the point. */
export interface CoverageDocument {
  name: string;
  title: string;
  source: string;
  on_disk: boolean;
  indexed: boolean;
  in_graph: boolean;
  corpus_category: string | null;
  graph_category: string | null;
  chunks: number | null;
  tokens: number | null;
  degree: number | null;
  size: number | null;
  has_original: boolean;
  original: string | null;
  issues: CoverageIssueKind[];
}

export type CoverageIssueKind =
  | "file_missing" | "not_indexed" | "not_in_graph"
  | "shadowed" | "category_mismatch" | "no_original";

export interface CoverageIssue {
  kind: CoverageIssueKind;
  severity: "error" | "warning" | "info";
  title: string;
  source: string;
  detail: string;
}

export interface CoverageReport {
  summary: {
    on_disk: number; indexed: number; in_graph: number;
    documents: number; clean: number;
  } & Record<CoverageIssueKind, number>;
  issues: CoverageIssue[];
  help: Record<CoverageIssueKind, string>;
  corpus_error: string | null;
  graph_error: string | null;
  documents?: CoverageDocument[];
}

export const api = {
  health: () => fetch("/api/health").then((r) => json<{ preview_available: boolean }>(r)),
  upload: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return fetch("/api/upload", { method: "POST", body }).then((r) => json<Upload>(r));
  },
  convert: (id: string, vlm: boolean, provider: string) =>
    fetch(`/api/convert/${id}?vlm=${vlm}&provider=${provider}`, { method: "POST" }).then((r) => json<Conversion>(r)),
  embed: (id: string, category?: string) =>
    fetch(`/api/docs/${id}/embed${category ? `?category=${encodeURIComponent(category)}` : ""}`,
          { method: "POST" }).then((r) => json<EmbedResult>(r)),
  ragStatus: () => fetch("/api/rag/status").then((r) => json<RagStatus>(r)),
  /** One indexed chunk by its key ("PKG:412"), in the Source shape the
   *  document inspector takes. The Evidence Agent needs this: a claim's
   *  source names a chunk and quotes a sentence, and the passage it came
   *  from has to be fetched before the document can be opened on it. */
  chunk: (chunkId: string) =>
    fetch(`/api/rag/chunk/${encodeURIComponent(chunkId)}`).then((r) => json<Source>(r)),
  previewUrl: (id: string, page: number) => `/api/docs/${id}/preview/${page}`,
  downloadUrl: (id: string) => `/api/docs/${id}/download`,
  kbFiles: () => fetch("/api/kb/files").then((r) => json<KbFileItem[]>(r)),
  /** Where the file system, the corpus and the graph disagree. Read-only. */
  coverage: (documents = true) =>
    fetch(`/api/coverage?documents=${documents}`).then((r) => json<CoverageReport>(r)),
  /** Open an indexed document's ORIGINAL file (the .pptx/.pdf the Markdown was
   *  converted from) so it can be previewed beside its Markdown. Takes the
   *  Markdown's source path, because that is what identifies a document; the
   *  original is found next to it. Rejected for a document added through the
   *  UI, which has no original on disk. */
  openKbOriginal: (source: string) =>
    fetch(`/api/kb/files/open?source=${encodeURIComponent(source)}`, { method: "POST" })
      .then((r) => json<Upload & { markdown_source: string }>(r)),
  kbFileContent: (filename: string, source?: string) =>
    fetch(`/api/kb/files/${encodeURIComponent(filename)}${source ? `?source=${encodeURIComponent(source)}` : ""}`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }),
  /** `source` says WHICH document, when several share a file name -- they can,
   *  since knowledge_base/X.md and solvay-spark/pkg/markdown/X.md are two
   *  files. Without it the server refuses an ambiguous delete rather than
   *  removing them all, which is what it used to do. */
  deleteKbFile: (filename: string, source?: string) =>
    fetch(`/api/kb/files/${encodeURIComponent(filename)}`
            + (source ? `?source=${encodeURIComponent(source)}` : ""),
          { method: "DELETE" })
      .then((r) => json<{ status: string; deleted_from_db: boolean; remaining: number;
                          file_removed: boolean }>(r)),
  graphData: (categories: string[] = []) =>
    fetch(`/api/graph/data${categoryQuery(categories)}`).then((r) => json<GraphData>(r)),
  rebuildGraph: (categories: string[] = []) =>
    fetch(`/api/graph/rebuild${categoryQuery(categories)}`, { method: "POST" }).then((r) => json<GraphData>(r)),
  queryGraph: (req: { query?: string; source_id?: string; target_id?: string }) =>
    fetch("/api/graph/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<GraphQueryResult>(r)),
  /** The schema is the same whatever the categories; the counts and sample
   *  instances follow them. */
  graphModel: (categories: string[] = []) =>
    fetch(`/api/graph/model${categoryQuery(categories)}`).then((r) => json<GraphModel>(r)),
  /** The graph's Neo4j copy: whether it is up, and whether it holds this build. */
  neo4jStatus: () => fetch("/api/graph/neo4j/status").then((r) => json<Neo4jStatus>(r)),
  neo4jSync: (force = false) =>
    fetch(`/api/graph/neo4j/sync${force ? "?force=true" : ""}`, { method: "POST" })
      .then((r) => json<Record<string, unknown>>(r)),
  /** Plain English to Cypher with Claude; checked by Neo4j, not run. */
  generateCypher: (question: string) =>
    fetch("/api/graph/cypher/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    }).then((r) => json<GeneratedCypher>(r)),
  /** A read-only Cypher query; writes are refused by Neo4j itself. */
  cypher: (query: string, limit = 200, params: Record<string, unknown> = {}) =>
    fetch("/api/graph/cypher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit, params }),
    }).then((r) => json<CypherResult>(r)),
  /** The latest graph-itself check and question check (graph_eval.py). */
  graphQuality: () => fetch("/api/graph/quality").then((r) => json<GraphQuality>(r)),
  /** Check the graph itself now: no model call, a few seconds. */
  checkGraphStructure: () =>
    fetch("/api/graph/quality/structure", { method: "POST" }).then((r) => json<GraphQualityRun>(r)),
  /** Start the plain-English question check; it runs in the background. */
  startGraphQuestions: () =>
    fetch("/api/graph/quality/questions", { method: "POST" }).then((r) => json<{ id: string }>(r)),
};

/** One stored run of a knowledge graph quality check. */
export interface GraphQualityRun {
  id: string;
  status: "running" | "done" | "failed" | "abandoned";
  started_at: string;
  finished_at: string | null;
  error: string;
  report?: AgentEvaluation;
  seconds?: number;
  /** Question check only. */
  total?: number;
  results?: GraphQuestionResult[];
  reviewed?: boolean;
}

/** One plain-English question, as the question check answered it. */
export interface GraphQuestionResult {
  id: string;
  question: string;
  expected_answerable: boolean;
  /** What Claude judged; null when generation failed. */
  answerable: boolean | null;
  answerability_correct: boolean;
  cypher?: string;
  reference: string;
  compare: string;
  valid: boolean;
  attempts: number;
  /** null for a question the graph cannot answer. */
  matched: boolean | null;
  why?: string;
  reference_rows?: number;
  answer_rows?: number;
  error?: string;
  note?: string;
  seconds: number;
}

export interface GraphQuality {
  structure: GraphQualityRun | null;
  questions: GraphQualityRun | null;
  /** Whether someone has checked the reference answers. */
  reviewed: boolean;
}

export interface Neo4jStatus {
  configured: boolean;
  reachable: boolean;
  uri: string;
  browser: string;
  detail: string;
  current?: boolean;
  loaded?: { nodes: number; relationships: number; loaded_at: string; sources: string } | null;
  examples: { title: string; query: string }[];
  /** Plain-English questions for the generator, grouped. */
  questions?: { group: string; questions: string[] }[];
  max_rows: number;
  timeout: number;
}

export interface GeneratedCypher {
  question: string;
  answerable: boolean;
  cypher: string;
  explanation: string;
  assumptions: string[];
  /** Planned by Neo4j without error, and read-only. */
  valid: boolean;
  error: string;
  attempts: number;
  /** The database's objections the model corrected along the way. */
  corrections: string[];
  seconds: number;
}

export interface CypherResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  limit: number;
  ms: number;
  notifications: string[];
}

/** The graph's own schema, as a Neo4j Data Importer model. */
export interface ModelConstraint {
  type: string;
  property: string;
}

export interface ModelProperty {
  name: string;
  type: string;
  nullable: boolean;
}

/** A real node from the built graph, standing in for its label. */
export interface ModelInstance {
  id: string;
  label: string;
  detail: string;
  degree: number;
}

export interface ModelNode {
  id: string;
  token: string;
  position: { x: number; y: number };
  properties: ModelProperty[];
  constraints: ModelConstraint[];
  built_as: string | null;
  count: number;
  instances: ModelInstance[];
}

export interface ModelRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
  count: number;
}

export interface GraphModel {
  version: string;
  nodes: ModelNode[];
  relationships: ModelRelationship[];
  stats: {
    labels: number;
    relationship_types: number;
    constraints: number;
    nodes: number;
    edges: number;
  };
}

export interface GraphNode {
  id: string;
  label: string;
  type: "stream" | "system" | "document" | "process" | "spec";
  color?: string;
  size?: number;
  degree?: number;
  description?: string;
  code?: string;
  ticket?: string;
  filename?: string;
  source?: string;
  format?: string;
  chars?: number;
  is_primary?: boolean;
  /** Present on BPML processes, and true when the workbook confirms the code. */
  in_bpml?: boolean;
  /** The register's "Lowest Level Key", on L4 steps only. */
  jira_key?: string;
  /** The category the document came from (document nodes only). Streams,
   *  systems, processes and specs are shared, so they carry none. */
  category?: string;
}

export interface GraphEdge {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  relation: string;
  label: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    total_nodes: number;
    total_edges: number;
    types: Record<string, number>;
    streams: string[];
    systems: string[];
    /** Documents per category in the graph as returned. */
    categories?: Record<string, number>;
    /** Present when the graph was narrowed to some categories. */
    filtered_to?: string[];
  };
}

export interface GraphPathStep {
  from_id: string;
  from: string;
  from_type?: string;
  to_id: string;
  to: string;
  to_type?: string;
  relation: string;
}

export interface GraphPath {
  start_id: string;
  end_id: string;
  hops: number;
  nodes: string[];
  edges: string[];
  steps: GraphPathStep[];
}

export interface GraphQueryResult {
  query: string;
  mode: "path" | "subgraph";
  summary: string;
  answer?: string;
  node_ids: string[];
  edge_ids: string[];
  path?: GraphPath;
  stats: {
    nodes_count: number;
    edges_count: number;
  };
}

export interface KbBatchInsertHandlers {
  onProgress?: (data: { type: "start"; index: number; total: number; filename: string }) => void;
  onFileDone?: (data: {
    type: "done";
    index: number;
    total: number;
    filename: string;
    title: string;
    status: string;
    chunks: number;
    tokens: number;
    duplicates: string[];
  }) => void;
  onFileError?: (data: { type: "error"; index: number; total: number; filename: string; error: string }) => void;
  onComplete?: (data: {
    total: number;
    succeeded: number;
    failed: number;
    total_chunks: number;
    total_tokens: number;
    total_documents_in_db: number;
    total_chunks_in_db: number;
    seconds: number;
  }) => void;
  onError?: (err: string) => void;
}

export async function batchInsertKb(
  files: File[],
  handlers: KbBatchInsertHandlers,
  signal?: AbortSignal,
  category?: string,
): Promise<void> {
  const formData = new FormData();
  for (const f of files) {
    formData.append("files", f);
  }
  if (category) formData.append("category", category);

  const res = await fetch("/api/kb/batch-insert", {
    method: "POST",
    body: formData,
    signal,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { detail?: string }).detail || `Request failed (${res.status})`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const raw of events) {
      if (!raw.trim()) continue;
      let eventType = "message";
      let dataStr = "";

      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
      }

      if (!dataStr) continue;
      try {
        const payload = JSON.parse(dataStr);
        if (eventType === "progress" && handlers.onProgress) handlers.onProgress(payload);
        else if (eventType === "file_done" && handlers.onFileDone) handlers.onFileDone(payload);
        else if (eventType === "file_error" && handlers.onFileError) handlers.onFileError(payload);
        else if (eventType === "complete" && handlers.onComplete) handlers.onComplete(payload);
        else if (eventType === "error" && handlers.onError) handlers.onError(payload.message || "Embedding error");
      } catch (e) {
        console.error("Failed to parse SSE payload", e);
      }
    }
  }
}

export interface AskHandlers {
  /** The history row this question is being written to, sent before the
   *  pipeline starts. `not_saved` means the answer is coming but the history
   *  write failed -- the question is answered either way. */
  run?: (r: { id: string; not_saved?: string }) => void;
  /** The Langfuse trace this question opened, sent before any work. Both
   *  fields are empty strings when tracing is off. Optional so that a caller
   *  which does not care keeps compiling. */
  trace?: (t: { id: string; url: string }) => void;
  stage: (e: StageEvent) => void;
  sources: (s: Source[]) => void;
  token: (t: string) => void;
  done: (d: Done) => void;
  error: (message: string) => void;
}

/** POST a question and dispatch the server-sent events as they arrive.
 *  Parsed by hand: EventSource can only GET, and it reconnects on close --
 *  which would ask the question (and pay for it) again. */
export async function ask(
  /** An empty `categories` searches every one of them. */
  body: { question: string; mode: SearchMode; k: number; categories: string[] },
  on: AskHandlers,
  signal: AbortSignal,
) {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      const payload = data ? JSON.parse(data) : null;
      if (event === "run") on.run?.(payload);
      else if (event === "trace") on.trace?.(payload);
      else if (event === "stage") on.stage(payload);
      else if (event === "sources") on.sources(payload);
      else if (event === "token") on.token(payload);
      else if (event === "done") on.done(payload);
      else if (event === "error") on.error(payload.message);
    }
  }
}

export interface BatchEmbedFileResult {
  filename: string;
  title: string;
  status: "added" | "updated" | "unchanged";
  chunks: number;
  tokens: number;
  duplicates: string[];
}

export interface BatchEmbedSummary {
  total: number;
  succeeded: number;
  failed: number;
  total_chunks: number;
  total_tokens: number;
  db_documents: number;
  db_chunks: number;
  seconds: number;
}

// --- InsightLens ----------------------------------------------------------

export type FitGapClass =
  | "FIT_STANDARD" | "FIT_CONFIG" | "GAP_DEVELOPMENT"
  | "REUSE" | "ADAPT" | "CHALLENGE" | "SIMPLIFY" | "REPLACE" | "RETIRE"
  | "UNKNOWN";

export interface BpmlProcess {
  code: string;
  name: string;
  level: number;
  parent: string | null;
  description?: string;
  process_type?: string;
  status?: string;
  children?: string[];
  stream?: string | null;
  steps?: number;
}

export interface FitGapEvidence {
  chunk_id: string;
  doc: string;
  heading_path: string;
  quote: string;
  supports: "for" | "against" | "context";
}

export interface FitGapImpact {
  system: string;
  interface_ref: string | null;
  impact: "none" | "reuse" | "variant" | "new";
  evidence: FitGapEvidence[];
}

export interface FitGapDecision {
  question: string;
  options: string[];
  consequence_note: string;
  evidence: FitGapEvidence[];
}

export interface FitGapIssue {
  code: string;
  severity: "hard" | "soft";
  detail: string;
}

export interface FitGapReviewRecord {
  id: number;
  reviewer: string;
  verdict: "accept" | "reject" | "refine";
  corrected_classification: FitGapClass | null;
  comment: string;
  created_at: string;
}

export interface FitGapEntry {
  id?: number;
  run_id: string;
  mode: "A" | "B";
  bpml_code: string;
  step_name: string;
  classification: FitGapClass;
  rationale: string;
  confidence: number;
  materiality: "low" | "medium" | "high";
  linked_tickets: string[];
  sap_objects: string[];
  evidence: FitGapEvidence[];
  integration_impacts: FitGapImpact[];
  decision_points: FitGapDecision[];
  open_questions: string[];
  status: "proposed";
  issues?: FitGapIssue[];
  evidence_valid?: boolean;
  tool_calls?: number;
  seconds?: number;
  reviews?: FitGapReviewRecord[];
}

export interface FitGapSynthesis {
  reuse: {
    steps: number;
    classified: number;
    coverage_pct: number;
    reuse_pct: number | null;
    by_class: Record<string, number>;
    by_process: {
      code: string; label: string; steps: number; fit: number; gap: number;
      unknown: number; reuse_pct: number | null; avg_confidence: number;
    }[];
    confidence_bins: Record<string, number>;
    avg_confidence: number;
    note: string;
  };
  gaps: {
    bpml_code: string; step_name: string; classification: FitGapClass; confidence: number;
    materiality: "low" | "medium" | "high"; rationale: string; linked_tickets: string[];
    sap_objects: string[]; evidence_count: number; docs: string[]; weight: number;
  }[];
  decisions: {
    process: string; question: string; options: string[]; consequence_note: string;
    steps: { bpml_code: string; step_name: string; classification: FitGapClass }[];
    evidence: { doc: string; quote: string; chunk_id: string }[]; weight: number;
  }[];
  integrations: {
    system: string; step_count: number; impacts: Record<string, number>; interfaces: string[];
    steps: { bpml_code: string; step_name: string; impact: string; classification: string }[];
  }[];
  agenda: {
    order: number; process: string; code: string; weight: number; minutes: number;
    steps: number; unresolved: number; gaps: number; decisions: string[];
    open_questions: string[]; pre_read: string[];
  }[];
}

export interface FitGapStatus {
  bpml: { document: string; source: string | null; available: boolean; error: string | null; processes: number; by_level: Record<string, number>; roots: BpmlProcess[] };
  model: string;
  prompt_hash: string;
  max_tool_calls: number;
  anthropic_key: boolean;
  runs: number;
  entries: number;
  reviews: number;
  chunks?: number;
  documents?: number;
  /** The document categories a run can be pointed at, with what each holds. */
  categories?: { code: string; documents: number; chunks: number }[];
  graph: { total_nodes: number; total_edges: number; types: Record<string, number> } | null;
  error: string | null;
  /** Set when the corpus counts could not be read; the register itself is fine. */
  corpus_error?: string;
  /** What an analyst may attach to a session, and for how long it is kept. */
  uploads?: { ttl_hours: number; max_files: number; accepted: string[]; database: string };
}

export interface FitGapPreview {
  scope: BpmlProcess;
  scope_label: string;
  ancestry: BpmlProcess[];
  steps_total: number;
  steps_planned: number;
  steps: BpmlProcess[];
  model: string;
  max_tool_calls: number;
  estimated_input_tokens: number;
  estimated_minutes: number;
}

export interface FitGapRunSummary {
  id: string; mode: "A" | "B"; scope_bpml: string; scope_label: string; question: string;
  holdout: boolean; status: string; started_at: string | null; finished_at: string | null;
  model: string; entries: number; reuse_pct: number | null; coverage_pct: number | null;
  /** Categories the run was limited to. Empty means it read every one. */
  categories: string[];
  /** The attachment the run read, if any. The upload itself is long gone by
   *  the time a register is reopened, so the names are the whole record. */
  uploads?: { session?: string; schema?: string; documents?: string[] };
}

export interface FitGapRunDetail extends Omit<FitGapRunSummary, "entries"> {
  prompt_hash: string;
  corpus_fingerprint: string;
  params: Record<string, unknown>;
  country: Record<string, unknown> | null;
  input_tokens: number;
  output_tokens: number;
  synthesis: FitGapSynthesis | Record<string, never>;
  entries: FitGapEntry[];
}

export interface FitGapRunBody {
  mode?: "A" | "B";
  scope_bpml: string;
  country_profile?: Record<string, unknown> | null;
  holdout?: boolean;
  max_steps?: number;
  concurrency?: number;
  question?: string | null;
  /** Empty reads every category. Enforced server-side, not a hint. */
  categories?: string[];
  /** The session holding documents attached to this run, if any. */
  upload_session?: string | null;
}

export interface FitGapHandlers {
  scope: (d: {
    run_id: string; scope: BpmlProcess; scope_label: string; ancestry: BpmlProcess[];
    steps: BpmlProcess[]; mode: "A" | "B"; holdout: boolean; model: string;
    prompt_hash: string; corpus_fingerprint: string; categories: string[];
    uploads?: { session?: string; schema?: string; documents?: string[] };
  }) => void;
  stepStart: (d: { bpml_code: string; step_name: string; level: number }) => void;
  toolCall: (d: { bpml_code: string; tool: string; summary: string; ms: number; error: string | null }) => void;
  entry: (d: FitGapEntry) => void;
  verifyFail: (d: { bpml_code: string; issues: FitGapIssue[]; repaired: boolean }) => void;
  stepError: (d: { bpml_code: string; step_name: string; message: string }) => void;
  synthesis: (d: FitGapSynthesis) => void;
  done: (d: {
    run_id: string; steps: number; entries: number; failed: number; seconds: number;
    input_tokens: number; output_tokens: number;
    verification: { entries: number; evidence_items: number; hard_issues: number; soft_issues: number; entries_repaired: number; evidence_valid_pct: number };
  }) => void;
  error: (message: string) => void;
}

/** Run InsightLens and dispatch its server-sent events. Hand-parsed for the
 *  same reason as ask(): EventSource can only GET, and a reconnect would
 *  re-run (and re-bill) the whole register. */
export async function runFitGap(body: FitGapRunBody, on: FitGapHandlers, signal: AbortSignal) {
  const res = await fetch("/api/fitgap/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "scope") on.scope(payload);
      else if (event === "step_start") on.stepStart(payload);
      else if (event === "tool_call") on.toolCall(payload);
      else if (event === "entry") on.entry(payload);
      else if (event === "verify_fail") on.verifyFail(payload);
      else if (event === "step_error") on.stepError(payload);
      else if (event === "synthesis") on.synthesis(payload);
      else if (event === "done") on.done(payload);
      else if (event === "error") on.error(payload.message);
    }
  }
}

// --- documents attached to one agent session ----------------------------------
//
// Shared by InsightLens and the Fit-Gap Copilot. A document carries the
// role it plays in the analysis, which is what lets the Fit-Gap Copilot run a
// three-way comparison rather than a two-document diff.

export type UploadRole = "as_is" | "template" | "sap_bp" | "localization" | "other";

export interface UploadedFile {
  name: string; role: UploadRole; role_label: string;
  format: string; bytes: number; pages: number; unit: string;
  chunks: number; tokens: number; seconds: number; added_at: string | null;
}

/** An upload session: a Postgres schema of its own inside docling_session,
 *  swept once it expires. Never part of the corpus. */
export interface UploadSession {
  session: string;
  exists: boolean;
  created_at?: string;
  used_at?: string;
  expires_at?: string;
  ttl_hours?: number;
  max_files?: number;
  database?: string;
  schema?: string;
  files: UploadedFile[];
  documents: number;
  chunks: number;
  tokens?: number;
  graph?: { total_nodes: number; total_edges: number; entities: number; documents: number };
}

export interface UploadEntity {
  node_id: string; type: string; label: string; code: string | null; ticket: string | null;
  /** Whether the permanent corpus already knows this entity. */
  in_corpus: boolean;
  corpus_documents: string[];
  corpus_mentions: number;
}

export interface UploadComparison {
  documents: { node_id: string; label: string }[];
  entities: UploadEntity[];
  shared: number;
  new: number;
}

export interface UploadHandlers {
  session: (d: { session: string }) => void;
  start: (d: { index: number; total: number; filename: string }) => void;
  stage: (d: { index: number; total: number; filename: string; stage: string }) => void;
  doneFile: (d: UploadedFile & { title: string; graph: Record<string, unknown> }) => void;
  fileError: (d: { index: number; total: number; filename: string; message: string }) => void;
  done: (d: UploadSession & { added: number; total: number }) => void;
  error: (message: string) => void;
}

/** Read a server-sent-event stream and hand each event to its handler.
 *  Hand-parsed for the same reason as ask(): EventSource can only GET. */
async function readEvents(res: Response, on: Record<string, (payload: unknown) => void>) {
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      on[event]?.(JSON.parse(data));
    }
  }
}

/** Convert, chunk, embed and graph documents into a session. `session` is ""
 *  for the first upload; the server answers with the id it created. */
export async function uploadSessionDocuments(
  files: File[],
  session: string,
  role: UploadRole,
  on: UploadHandlers,
  signal?: AbortSignal,
) {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  form.append("session", session);
  form.append("role", role);
  const res = await fetch("/api/uploads", { method: "POST", body: form, signal });
  // The payloads are `unknown` on the way out of JSON.parse and asserted here,
  // once, rather than anywhere further in.
  await readEvents(res, {
    session: (d) => on.session(d as Parameters<UploadHandlers["session"]>[0]),
    start: (d) => on.start(d as Parameters<UploadHandlers["start"]>[0]),
    stage: (d) => on.stage(d as Parameters<UploadHandlers["stage"]>[0]),
    done_file: (d) => on.doneFile(d as Parameters<UploadHandlers["doneFile"]>[0]),
    file_error: (d) => on.fileError(d as Parameters<UploadHandlers["fileError"]>[0]),
    done: (d) => on.done(d as Parameters<UploadHandlers["done"]>[0]),
    error: (d) => on.error((d as { message: string }).message),
  });
}

export const sessionUploads = {
  status: (session: string) =>
    fetch(`/api/uploads/${session}`).then((r) => json<UploadSession>(r)),
  entities: (session: string, roles?: UploadRole[]) =>
    fetch(`/api/uploads/${session}/entities` +
      (roles?.length ? `?${roles.map((r) => `roles=${r}`).join("&")}` : ""))
      .then((r) => json<UploadComparison>(r)),
  retag: (session: string, name: string, role: UploadRole) =>
    fetch(`/api/uploads/${session}/files/${encodeURIComponent(name)}?role=${role}`,
      { method: "PATCH" }).then((r) => json<UploadSession>(r)),
  remove: (session: string, name: string) =>
    fetch(`/api/uploads/${session}/files/${encodeURIComponent(name)}`, { method: "DELETE" })
      .then((r) => json<UploadSession>(r)),
  drop: (session: string) =>
    fetch(`/api/uploads/${session}`, { method: "DELETE" })
      .then((r) => json<{ dropped: boolean }>(r)),
};

export const fitgap = {
  status: () => fetch("/api/fitgap/status").then((r) => json<FitGapStatus>(r)),
  uploads: sessionUploads,
  roots: () => fetch("/api/fitgap/scope").then((r) => json<{ roots: BpmlProcess[] }>(r)),
  search: (q: string) =>
    fetch(`/api/fitgap/scope?q=${encodeURIComponent(q)}`).then((r) => json<{ query: string; matches: BpmlProcess[] }>(r)),
  node: (code: string) =>
    fetch(`/api/fitgap/scope?code=${encodeURIComponent(code)}`).then((r) =>
      json<{ process: BpmlProcess; ancestry: BpmlProcess[]; children: BpmlProcess[]; steps: number }>(r)),
  preview: (body: FitGapRunBody) =>
    fetch("/api/fitgap/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<FitGapPreview>(r)),
  runs: () => fetch("/api/fitgap/runs").then((r) => json<FitGapRunSummary[]>(r)),
  run: (id: string) => fetch(`/api/fitgap/runs/${id}`).then((r) => json<FitGapRunDetail>(r)),
  exportUrl: (id: string, format: "md" | "json" | "xlsx") => `/api/fitgap/runs/${id}/export?format=${format}`,
  review: (entryId: number, body: { reviewer: string; verdict: string; corrected_classification?: string | null; comment?: string }) =>
    fetch(`/api/fitgap/entries/${entryId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<FitGapReviewRecord>(r)),
};

// --- Evidence Agent -----------------------------------------------------------

export type AnswerState =
  | "supported" | "conflicted" | "documented_unknown"
  | "not_in_corpus" | "false_premise" | "unrepresentable";

export type Stance = "supports" | "opposes" | "context";

export interface EvidenceSource {
  chunk_id: string;
  doc: string;
  heading_path: string;
  quote: string;
  stance: Stance;
  score: number | null;
  vector_rank: number | null;
  keyword_rank: number | null;
  provenance: string[];
  provenance_note: string;
  verified: boolean | null;
}

export interface EvidenceGraphFact {
  statement: string;
  node_ids: string[];
  edge_ids: string[];
  meaningful: boolean;
  note: string;
}

export interface ScoreTerm {
  rule: string;
  delta: number;
  cap: number | null;
  detail: string;
}

export interface EvidenceClaim {
  text: string;
  sources: EvidenceSource[];
  graph_facts: EvidenceGraphFact[];
  score: number;
  score_terms: ScoreTerm[];
  independent_sources: number;
  note: string;
}

export interface EvidenceAnswer {
  question: string;
  state: AnswerState;
  answer: string;
  claims: EvidenceClaim[];
  open_questions: string[];
  limits: string[];
  engines: Record<string, number>;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  seconds: number;
  model: string;
}

/** Which store a tool call read. Retrieval hits the corpus table in Postgres,
 *  the knowledge graph is held in memory and built from every category's
 *  Markdown, and the BPML hierarchy is parsed from the process house document
 *  in the corpus ("sheet" is what runs logged while it came from a workbook). An attachment is
 *  somewhere else again: a database of its own. */
export interface EvidenceToolSources {
  kind: "postgres" | "graph" | "sheet" | "other";
  /** One line for the log, e.g. "PKG 7 · DR 3". */
  label: string;
  /** Categories the result actually came from. */
  categories?: string[];
  /** postgres only: hits per category; for a session, per schema. */
  databases?: Record<string, number>;
  /** postgres only: the categories the search was allowed to cover. */
  searched?: string[];
  /** graph only: the categories the graph was built from. */
  built_from?: string[];
}

/** One passage retrieval returned, at the rank the agent saw it. `text` is the
 *  passage itself rather than a pointer to it: re-indexing renumbers chunks, so
 *  `chunk_id` is a best-effort deep link and not a way to fetch this back. */
export interface EvidenceRagHit {
  rank: number;
  chunk_id: string;
  category: string;
  doc: string;
  heading_path: string;
  score: number | null;
  vector_rank: number | null;
  keyword_rank: number | null;
  text: string;
  uploaded: boolean;
  /** Which side of a three-way comparison this passage is evidence for. Only
   *  the Fit-Gap Copilot's read_sources sets it; empty everywhere else. */
  side: string;
  side_label: string;
  provenance: string[];
  provenance_note: string;
}

export interface EvidenceRagTrace {
  kind: "rag";
  op: string;
  /** The side read_sources was restricted to, when it was. */
  side?: string;
  query: string;
  k: number | null;
  mode: string;
  filters: Record<string, unknown>;
  hits: EvidenceRagHit[];
  note: string;
  duplicate_warning: string;
  truncated: boolean;
}

/** `role` is why the node is in the trace: where the walk started (`seed`), a
 *  node the route passed through (`path`), something a lookup resolved to
 *  (`match`), or somewhere the walk reached (`neighbour`). */
export interface EvidenceGraphNode {
  id: string;
  label: string;
  type: string;
  degree: number | null;
  description: string;
  role: "seed" | "path" | "match" | "neighbour";
  hops: number;
  /** Only compare_entities sets these: whether the corpus already knows this
   *  entity, and in how many documents. null everywhere else, and the panel
   *  leaves the badge off rather than claiming "new". */
  in_corpus?: boolean | null;
  corpus_mentions?: number | null;
}

export interface EvidenceGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  label: string;
  on_path: boolean;
  /** A document link's source passages and how often it names the target. */
  chunks?: string[];
  mentions?: number | null;
}

export interface EvidenceGraphTrace {
  kind: "graph";
  op: string;
  query: string;
  seeds: string[];
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
  path: {
    hops: number | null;
    steps: { from: string; relation: string; to: string; is_label_edge?: boolean }[];
    meaningful: boolean | null;
    note: string;
    node_ids: string[];
  } | null;
  count: number | null;
  shared?: number | null;
  new?: number | null;
  type_filter: string;
  note: string;
  truncated: boolean;
}

export interface EvidenceBpmlStep {
  code?: string;
  name?: string;
  [key: string]: unknown;
}

export interface EvidenceBpmlTrace {
  kind: "bpml";
  op: string;
  query: string;
  process: EvidenceBpmlStep;
  parent: EvidenceBpmlStep | null;
  ancestry: EvidenceBpmlStep[];
  children: EvidenceBpmlStep[];
  truncated: boolean;
}

export type EvidenceTrace = EvidenceRagTrace | EvidenceGraphTrace | EvidenceBpmlTrace;

/** What the trace drawer needs from a call, whichever agent made it. The
 *  Evidence Agent labels its calls by engine and the Fit-Gap Copilot also by
 *  stage, but the panel only ever reads the fields below. */
export interface AgentToolCall {
  tool: string;
  engine: string;
  arguments: Record<string, unknown>;
  summary: string;
  sources?: EvidenceToolSources;
  ms: number;
  error: string | null;
  warning?: string | null;
  trace?: EvidenceTrace | null;
}

export interface EvidenceToolCall {
  tool: string;
  engine: "rag" | "graph" | "bpml" | "other";
  arguments: Record<string, unknown>;
  summary: string;
  sources?: EvidenceToolSources;
  ms: number;
  error: string | null;
  warning: string | null;
  /** What the call returned. Absent on a failed call, and on runs recorded
   *  before the investigation log carried traces. */
  trace?: EvidenceTrace | null;
}

/** What the agent recalled before it started, and whether it was allowed to.
 *  Memory ORIENTS a run and can never ground one: nothing recalled here is in
 *  `session.retrieved`, so a quote taken from it fails verification and its
 *  claim is dropped. The panel says so, because a reader who sees a memory
 *  beside the evidence must not mistake it for evidence. */
export interface EvidenceMemory {
  /** The toggle was on for this run. */
  enabled: boolean;
  /** Memory was actually read. False under holdout even when enabled. */
  used: boolean;
  /** Why it was not read, when it was asked for. */
  suppressed_by_holdout: boolean;
  recalled: number;
  memories: { id: string; text: string; type: string; score: number | null }[];
}

/** One line of the session log: the run as a SEQUENCE, in the order it
 *  happened. `calls` says what each tool returned; this says what the agent was
 *  handed, what it reasoned, when it ran out of budget and what it wrote back —
 *  all of which used to exist only for whoever was watching the stream.
 *
 *  A `tool_call` entry carries `call`, the index into `calls`, so the console
 *  can open the same trace drawer without a second copy of every passage. */
export interface EvidenceLogEntry {
  seq: number;
  /** ISO timestamp, millisecond precision. */
  at: string;
  kind: "question" | "memory" | "note" | "thinking" | "tool_call" | "answer" | "error";
  text?: string;
  /** tool_call */
  tool?: string;
  engine?: string;
  summary?: string;
  ms?: number;
  error?: string | null;
  warning?: string | null;
  arguments?: Record<string, unknown>;
  /** Index into EvidenceRunDetail.calls. -1 when the call was not recorded. */
  call?: number;
  /** note: which kind of note — prompt · budget · rejected · retained. */
  note?: string;
  title?: string;
  detail?: Record<string, unknown>;
  /** thinking */
  turn?: number;
  /** Fit-Gap Copilot: which pass the line belongs to (asis · compare). */
  stage?: string;
  /** memory */
  used?: boolean;
  recalled?: number;
  suppressed_by_holdout?: boolean;
  memories?: string[];
  /** question */
  holdout?: boolean;
  scope?: string[];
  memory?: boolean;
  /** answer */
  state?: string;
  claims?: number;
}

/** Whether the Hindsight memory server is reachable, and how much it holds. */
export interface MemoryStatus {
  /** HINDSIGHT_URL is set. Empty means memory is switched off deliberately. */
  configured: boolean;
  /** The server answered. When false, `detail` says why. */
  available: boolean;
  detail: string;
  url: string;
  bank: string;
  memories?: number;
}

export interface EvidenceStatus {
  model: string;
  prompt_hash: string;
  max_tool_calls: number;
  anthropic_key: boolean;
  tools: string[];
  /** Document categories an investigation can be pointed at. */
  categories: { code: string; documents: number; chunks: number }[];
  duplicate_groups: string[][];
  duplicate_threshold: number;
  hubs: { label: string; degree: number }[];
  hub_degree: number;
  graph: { total_nodes: number; total_edges: number } | null;
  /** How many investigations are on record. */
  history?: { runs: number; answered: number; database?: string; error?: string };
  memory?: MemoryStatus;
  error: string | null;
}

/** One past investigation, as the history strip shows it. Enough to recognise
 *  a question and decide whether to reopen it, without carrying every claim
 *  and quote of fifty runs. */
export interface EvidenceRunSummary {
  id: string;
  question: string;
  holdout: boolean;
  /** running · done · failed · abandoned (a run whose stream was dropped). */
  status: string;
  state: AnswerState | "";
  started_at: string | null;
  finished_at: string | null;
  seconds: number;
  model: string;
  claims: number;
  sources: number;
  tool_calls: number;
  categories: string[];
  /** `{}` for a run recorded before memory existed. */
  memory?: EvidenceMemory | Record<string, never>;
  /** The first 180 characters of the answer. */
  summary: string;
}

/** A past investigation in full: what was asked, every tool call in order, and
 *  the verified answer. `calls` is what makes a reopened run an investigation
 *  rather than an answer with no working. */
export interface EvidenceRunDetail extends Omit<EvidenceRunSummary, "claims" | "sources" | "summary"> {
  prompt_hash: string;
  corpus_fingerprint: string;
  input_tokens: number;
  output_tokens: number;
  answer: EvidenceAnswer | null;
  calls: EvidenceToolCall[];
  /** Empty for a run recorded before the log existed. */
  log?: EvidenceLogEntry[];
  evaluation?: AgentEvaluation | Record<string, never>;
  error: string;
}

/** One of a run's own quality scores (agent_eval.py): counted from what the
 *  run already checked, with the target it is read against. */
export interface AgentScore {
  name: string;
  label: string;
  /** Groundedness, Tool call accuracy, Task success, Topic adherence or Guardrails. */
  metric: string;
  description: string;
  value: number;
  kind: "boolean" | "share" | "count";
  comment: string;
  /** Which way is good against `target`; empty for a count shown for context. */
  good: "min" | "max" | "";
  target: number;
  /** A softer line on the same side as the target; missing the target but
   *  staying within this reads "Watch", not "Below". */
  watch?: number | null;
  /** Null when the score has no target. */
  passed: boolean | null;
  /** Absent on runs scored before the Watch level existed; read `passed`. */
  status?: "pass" | "watch" | "below" | null;
}

/** A run's Evaluation tab. Empty (`{}`) for runs recorded before it was kept. */
export interface AgentEvaluation {
  scores: AgentScore[];
  passed: number;
  /** Checks between their target and their watch line. */
  watch?: number;
  judged: number;
  /** The run's Langfuse trace; empty when tracing is off. */
  trace_url: string;
}

export interface EvidenceHandlers {
  /** The id the investigation is being recorded under, sent before any work
   *  starts so the page can link to it even if the run is abandoned. */
  run?: (r: { id: string; not_saved?: string }) => void;
  /** Sent once, before the first tool call, whether or not memory was on. */
  memory?: (m: EvidenceMemory) => void;
  /** Every step, in order — including the ones that have no panel of their
   *  own: the assembled prompt, the reasoning between calls, the budget
   *  notice, a rejected submission. */
  log?: (e: EvidenceLogEntry) => void;
  toolCall: (c: EvidenceToolCall) => void;
  answer: (a: EvidenceAnswer) => void;
  /** The run's quality scores, sent just after the answer. */
  evaluation?: (e: AgentEvaluation) => void;
  error: (message: string) => void;
}

/** Ask the Evidence Agent and dispatch its server-sent events. Hand-parsed for
 *  the same reason as ask(): EventSource can only GET, and a reconnect would
 *  re-run (and re-bill) the whole investigation. */
export async function askEvidence(
  /** An empty `categories` reads every one of them. */
  body: { question: string; holdout?: boolean; categories?: string[]; memory?: boolean },
  on: EvidenceHandlers,
  signal: AbortSignal,
) {
  const res = await fetch("/api/evidence/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "run") on.run?.(payload);
      else if (event === "log") on.log?.(payload);
      else if (event === "memory") on.memory?.(payload);
      else if (event === "tool_call") on.toolCall(payload);
      else if (event === "answer") on.answer(payload);
      else if (event === "evaluation") on.evaluation?.(payload);
      else if (event === "error") on.error(payload.message);
    }
  }
}

/** One row of the Ask history panel. Carries no excerpts and no full answer:
 *  those are fetched only when a question is reopened. */
export interface AskRunSummary {
  id: string;
  question: string;
  mode: SearchMode;
  k: number;
  categories: string[];
  status: "running" | "done" | "failed" | "abandoned";
  started_at: string | null;
  finished_at: string | null;
  seconds: number;
  answer_model: string;
  sources: number;
  summary: string;
  input_tokens: number;
  output_tokens: number;
  error: string;
  /** Enough of the evaluation to badge the row. "" when nothing has judged it. */
  eval_status?: "" | "running" | "done" | "failed" | "skipped" | "abandoned";
  overall?: number | null;
  safety?: number | null;
}

export interface AskRunDetail extends Omit<AskRunSummary, "sources" | "summary"> {
  embed_model: string;
  corpus_fingerprint: string;
  /** The corpus has been re-indexed since this answer was written, so the
   *  excerpts below are what it said then, not what it would say now. */
  corpus_changed: boolean;
  answer: string;
  sources: Source[];
  terms: string[];
  trace_id?: string;
  prompt_hash?: string;
  /** Sent with the run so a reopened question shows its scorecard in the same
   *  paint as its answer. Null when it was never judged. */
  evaluation?: AskEvaluation | null;
  /** A person's verdict on whether the answer is grounded, if one was given. */
  review?: { verdict: "grounded" | "partly" | "not"; reviewer: string; note: string; created_at: string | null } | null;
}

/** The quality segments the history panel offers. Kept in step with
 *  ask_store.QUALITY_FILTERS by frontend/test/rag-quality.mjs. */
export type QualityFilter = "" | "low" | "unfaithful" | "unsafe" | "unscored";

export const askHistory = {
  runs: (limit = 50, search = "", quality: QualityFilter = "") =>
    fetch(`/api/ask/runs?limit=${limit}&search=${encodeURIComponent(search)}`
          + `&quality=${encodeURIComponent(quality)}`)
      .then((r) => json<{
        runs: AskRunSummary[];
        retention: number;
        filters: string[];
        low_quality_below: number;
      }>(r)),
  evaluation: (id: string) =>
    fetch(`/api/ask/runs/${encodeURIComponent(id)}/evaluation`)
      .then((r) => json<AskEvaluation>(r)),
  rescore: (id: string) =>
    fetch(`/api/ask/runs/${encodeURIComponent(id)}/evaluation`, { method: "POST" })
      .then((r) => json<{ status: string; run_id: string; judge_model: string }>(r)),
  run: (id: string) =>
    fetch(`/api/ask/runs/${encodeURIComponent(id)}`).then((r) => json<AskRunDetail>(r)),
  deleteRun: (id: string) =>
    fetch(`/api/ask/runs/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((r) => json<{ status: string; id: string }>(r)),
  clear: () =>
    fetch("/api/ask/runs", { method: "DELETE" })
      .then((r) => json<{ status: string; removed: number }>(r)),
};

/** One memory the bank leaned on while answering. */
export interface ReflectFact {
  id: string;
  text: string;
  /** world · observation · experience · opinion — Hindsight's own classes. */
  type: string;
}

export interface MemoryReflection {
  /** Markdown. */
  text: string;
  /** The memories the reflection actually read, rebuilt from its tool trace.
   *  Hindsight's own `based_on` is always empty here: reflect is agentic and
   *  fetches facts as it goes rather than being handed a set. */
  based_on: ReflectFact[];
  /** The searches it ran to find them, in order. */
  searched: string[];
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error: string;
}

export const evidence = {
  status: () => fetch("/api/evidence/status").then((r) => json<EvidenceStatus>(r)),
  runs: (limit = 50) =>
    fetch(`/api/evidence/runs?limit=${limit}`).then((r) => json<EvidenceRunSummary[]>(r)),
  run: (id: string) =>
    fetch(`/api/evidence/runs/${encodeURIComponent(id)}`).then((r) => json<EvidenceRunDetail>(r)),
  /** Every claim traced to its passages, graph facts, the calls that returned
   *  them and the reasoning behind them; `lineageExportUrl` downloads it. */
  lineage: (id: string) =>
    fetch(`/api/evidence/runs/${encodeURIComponent(id)}/lineage`).then((r) => json<Lineage>(r)),
  lineageExportUrl: (id: string, format: "md" | "json") =>
    `/api/evidence/runs/${encodeURIComponent(id)}/lineage?format=${format}`,
  deleteRun: (id: string) =>
    fetch(`/api/evidence/runs/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((r) => json<{ status: string; id: string }>(r)),
  /** Ask the memory bank a question about itself. Slow on purpose -- it reads
   *  the whole bank and writes an answer -- so no timeout is imposed here. */
  reflect: (question: string) =>
    fetch("/api/evidence/memory/reflect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    }).then((r) => json<MemoryReflection>(r)),
};

// --- the Fit-Gap Copilot --------------------------------------------------------
//
// Fit-to-Standard analysis for a country rollout: the country's As-Is compared
// against the Global Template and, where a source exists, SAP Best Practice.
// Every controlled vocabulary comes from /api/rollout/status so the page shows
// the labels the validator enforces rather than a second copy that can drift.

export type DeviationType =
  | "PF" | "BR" | "AP" | "RO" | "LC" | "CT" | "DT" | "IN"
  | "RP" | "UX" | "EX" | "TM" | "TC" | "SEC" | "VOL" | "POL";

export type Disposition =
  | "ADOPT_GT" | "CONFIGURE_STANDARD" | "USE_SAP_LOCALIZATION" | "ADOPT_SAP_BP"
  | "EXTEND_STANDARD" | "RETAIN_LOCAL_EXCEPTION" | "REDESIGN_GT" | "RETIRE_LEGACY"
  | "REQUIRES_DECISION" | "OUT_OF_SCOPE";

export type LocalizationState =
  | "CONFIRMED_STATUTORY" | "SAP_DELIVERED" | "CORPORATE_POLICY"
  | "LOCAL_PREFERENCE" | "SUSPECTED" | "NOT_LOCALIZATION";

export type Materiality = "Critical" | "High" | "Medium" | "Low" | "Informational";
export type WorkshopBucket = "MUST_DISCUSS" | "CONFIRM" | "NO_WORKSHOP_TIME";
export type RolloutDimension =
  "flow" | "rules" | "governance" | "data" | "integration" | "controls" | "reporting";

export interface RolloutEvidence {
  chunk_id: string; doc: string; heading_path: string; quote: string;
  side: "as_is" | "template" | "sap_bp" | "localization";
  evidence_class: "E1" | "E2" | "E3" | "E4";
}

export interface AsIsStep {
  step_id: string; name: string; trigger: string; actor: string; action: string;
  system: string; input: string; business_rule: string; decision: string; control: string;
  output: string; exception: string; integration: string; timing: string; volume: string;
  sequence: number; confidence: "High" | "Medium" | "Low"; evidence: RolloutEvidence[];
}

export interface AsIsModel {
  process_name: string; country: string; steps: AsIsStep[];
  normalisation_notes: string[]; evidence_gaps: string[];
}

export interface Deviation {
  gap_id: string; as_is_step_id: string; gt_step_ref: string; sap_bp_reference: string | null;
  as_is_statement: string; gt_statement: string; exact_difference: string;
  primary_type: DeviationType; secondary_types: DeviationType[]; dimension: RolloutDimension;
  localization_state: LocalizationState; materiality: Materiality;
  impacts: { area: string; score: number; note: string }[];
  gt_fit_rating: number; sap_bp_fit_rating: number | null; harmonization_potential: number;
  /** How harmonization_potential was computed; absent on runs from before it was. */
  harmonization_terms?: { base: number; fit_adjustment: number; cap: number | null; value: number; formula: string };
  candidate_disposition: Disposition; standard_options_considered: string[];
  workshop_bucket: WorkshopBucket; decision_question: string; decision_options: string[];
  decision_owner: string[]; workshop_minutes: number; why_discussed: string;
  evidence_confidence: "High" | "Medium" | "Low";
  evidence: RolloutEvidence[]; open_questions: string[];
}

export interface LocalizationItem {
  topic: string; status: "Confirmed" | "Candidate" | "Not applicable";
  relevance: string; requirement: string; sap_capability: string; gt_capability: string;
  as_is_handling: string; recommended_path: string; workshop_decision: string;
  owner: string[]; evidence: RolloutEvidence[];
}

export interface BacklogCandidate {
  title: string; requirement: string; business_value: string; acceptance_criteria: string[];
  affected_process: string; dependencies: string[];
  build_type: "configuration" | "extension" | "localization" | "undetermined";
  localization_flag: boolean; priority: "Must" | "Should" | "Could" | "Won't"; gap_id: string;
}

export interface RolloutAnalysis {
  headline: string;
  /** What the agent compared the As-Is against. Filled by the agent itself
   *  when the run named no Global Template process. */
  template_process: string;
  dimension_ratings: { dimension: RolloutDimension; gt_rating: number; sap_bp_rating: number | null; note: string }[];
  fit_areas: { as_is_step_id: string; gt_step_ref: string; statement: string; evidence: RolloutEvidence[] }[];
  deviations: Deviation[];
  localization: LocalizationItem[];
  backlog: BacklogCandidate[];
  open_questions: string[];
  sap_bp_note: string;
}

export interface RolloutScores {
  /** Which subject the run read. The score cards that do not apply to a
   *  subject are blank, and this is what says why. */
  subject?: string; subject_label?: string;
  gt_alignment: number | null; gt_band: string;
  sap_bp_alignment: number | null; sap_bp_band: string; sap_bp_note: string;
  localization_adjusted: number | null; localization_share: number;
  harmonization_potential: number | null; harmonization_band: string;
  /** The rule each deviation's figure follows; absent on older runs. */
  harmonization_rule?: string;
  pattern: string; formula: string;
  dimensions: { dimension: string; label: string; weight: number; rating: number | null; percent: number | null; note: string }[];
  sap_bp_dimensions: { dimension: string; label: string; weight: number; rating: number | null; percent: number | null; note: string }[];
  counts: {
    fit_areas: number; deviations: number; localization_items: number;
    localization_confirmed: number; backlog: number; open_questions: number;
    by_materiality: Record<string, number>; by_type: Record<string, number>;
    workshop: Record<string, number>; workshop_minutes: number;
  };
  heatmap: {
    dimension: string; label: string; weight: number; rating: number | null;
    deviations: number; must_discuss: number; localization: number;
    focus: "High" | "Medium" | "Low" | "None"; gap_ids: string[];
  }[];
  agenda: {
    position: number; gap_id: string; topic: string; why: string; minutes: number;
    materiality: Materiality; primary_type: DeviationType;
    localization_state: LocalizationState; options: string[]; owner: string[];
    disposition: Disposition;
  }[];
}

export interface RolloutQualityIssue {
  gate: string; severity: "hard" | "soft"; detail: string; gap_id: string;
}

export interface RolloutGates {
  issues: number; hard: number; soft: number;
  by_gate: Record<string, number>; not_checked: string[];
  items: RolloutQualityIssue[];
}

export interface RolloutStatus {
  /** Whether this server can render the workshop pack as a PDF. WeasyPrint
   *  needs pango, cairo and gdk-pixbuf; when they are missing `detail` says
   *  so and the page offers Markdown instead of a button that fails. */
  pdf?: { available: boolean; detail: string };
  bpml: FitGapStatus["bpml"];
  model: string; prompt_hash: string;
  max_tool_calls: Record<string, number>;
  anthropic_key: boolean; runs: number; decisions: number;
  documents?: number; chunks?: number;
  categories?: { code: string; documents: number; chunks: number }[];
  vocabulary: {
    deviation_types: Record<string, string>;
    dispositions: Record<string, string>;
    localization_states: Record<string, string>;
    dimensions: Record<string, { label: string; weight: number }>;
    ratings: Record<string, string>;
  };
  /** What a run can analyse, and which upload role each one needs. */
  subjects: RolloutSubject[];
  uploads: {
    ttl_hours: number; max_files: number; accepted: string[]; database: string;
    roles: { value: UploadRole; label: string }[];
  };
  error: string | null;
  corpus_error?: string;
}

/** A run reads one document set as its subject and compares it against the
 *  Global Template. `country_as_is` asks how far the country is from the
 *  template; `sap_best_practice` asks how far the template has drifted from
 *  SAP standard, and has no country in it at all. */
export interface RolloutSubject {
  value: string; label: string; role: UploadRole;
  localization: boolean; score_b: boolean;
}

export interface RolloutPreview {
  /** null when no Global Template process was named — the agent finds one. */
  scope: BpmlProcess | null;
  scope_label: string; ancestry: BpmlProcess[]; steps_total: number;
  attached: { name: string; role: UploadRole; role_label: string; chunks: number }[];
  by_role: Record<string, number>;
  ready: boolean; blocker: string; sap_bp_available: boolean;
  subject: string; subject_label: string; required_role: UploadRole;
  model: string; max_tool_calls: Record<string, number>;
  estimated_input_tokens: number; estimated_minutes: number;
}

export interface RolloutRunBody {
  /** Optional. Empty asks the agent to identify the template process itself. */
  scope_bpml?: string;
  subject?: string;
  country?: string;
  country_context?: string;
  sap_release?: string;
  gt_version?: string;
  question?: string | null;
  upload_session: string;
  categories?: string[];
}

export interface RolloutRunSummary {
  id: string; scope_bpml: string; scope_label: string; country: string; status: string;
  started_at: string | null; finished_at: string | null; model: string;
  categories: string[]; uploads: { session?: string; documents?: { name: string; role: string }[] };
  gt_alignment: number | null; harmonization_potential: number | null;
  deviations: number; must_discuss: number;
}

/** What the analysis was built from: every cited chunk, with the document it
 *  came from, where in it, how it scored and what it supported. Empty for
 *  runs made before the record was kept. */
export interface RolloutSourceChunk {
  chunk_id: string; document: string; category: string;
  kind: "corpus" | "upload";
  heading_path: string;
  score: number | null; vector_rank: number | null; keyword_rank: number | null;
  snippet: string; truncated: boolean; file: string; known: boolean;
  used_by: { kind: string; ref: string; label: string; side: string;
             evidence_class: string; quote: string }[];
}

export interface RolloutSourceDocument {
  document: string; category: string; kind: "corpus" | "upload"; file: string;
  chunks: number; citations: number; best_score: number | null; headings: string[];
}

export interface RolloutSources {
  chunks: Record<string, RolloutSourceChunk>;
  documents: RolloutSourceDocument[];
  retrieved_total: number; cited_total: number; unused_total: number;
}

export interface RolloutRunDetail extends RolloutRunSummary {
  subject: string;
  sources: RolloutSources | Record<string, never>;
  /** The investigation log, with the evidence each call returned. Empty for
   *  runs recorded before the log was kept at all. */
  calls?: (AgentToolCall & { stage: string })[];
  country_context: string; sap_release: string; gt_version: string; question: string;
  prompt_hash: string; corpus_fingerprint: string;
  input_tokens: number; output_tokens: number;
  asis: AsIsModel | Record<string, never>;
  analysis: RolloutAnalysis | Record<string, never>;
  scores: RolloutScores | Record<string, never>;
  gates: RolloutGates | Record<string, never>;
  decisions: RolloutDecision[];
  sessions?: WorkshopSession[];
  /** The investigation log. Empty for runs recorded before it was kept. */
  log?: EvidenceLogEntry[];
  evaluation?: AgentEvaluation | Record<string, never>;
}

/** One named person's verdict on one gap. The log is append-only: a later
 *  decision supersedes an earlier one for display but never replaces it, so
 *  the record still shows that the view changed and when. */
export interface RolloutDecision {
  id: number; gap_id: string; reviewer: string; verdict: "accept" | "reject" | "defer";
  disposition: string;
  /** "Option B: … — rationale", composed by the server for display. */
  comment: string;
  decided_at: string | null;
  option_index?: number | null; option_text?: string; rationale?: string;
  session_id?: string | null; supersedes?: number | null; is_current?: boolean;
  /** What was decided about, copied at the time so the row outlives the run. */
  question?: string; options?: string[]; decision_owner?: string[];
  country?: string; scope_bpml?: string; primary_type?: string; materiality?: string;
}

/** One sitting of the workshop: who ran the room and who was in it. */
export interface WorkshopSession {
  id: string; run_id?: string; facilitator: string; attendees: string[];
  started_at: string | null; submitted_at?: string | null;
}

export interface RolloutHandlers {
  scope: (d: {
    run_id: string; scope: BpmlProcess | null; scope_label: string; ancestry: BpmlProcess[];
    country: string; model: string; prompt_hash: string; corpus_fingerprint: string;
    categories: string[]; uploads: Record<string, unknown>; sap_bp_available: boolean;
  }) => void;
  stage: (d: { stage: string; status: string; detail: string; tool_calls?: number; seconds?: number }) => void;
  toolCall: (d: AgentToolCall & { stage: string }) => void;
  asis: (d: AsIsModel) => void;
  gate: (d: RolloutGates) => void;
  analysis: (d: RolloutAnalysis) => void;
  scores: (d: RolloutScores) => void;
  sources: (d: RolloutSources) => void;
  /** The run's quality scores, sent just before `done`. */
  evaluation?: (d: AgentEvaluation) => void;
  done: (d: { run_id: string; seconds: number; input_tokens: number; output_tokens: number; tool_calls: number }) => void;
  error: (message: string) => void;
  /** One line of the investigation log: reasoning, notes and tool calls, in
   *  the Evidence Agent's shape. Optional so existing callers keep compiling. */
  log?: (entry: EvidenceLogEntry) => void;
}

/** Run the Fit-Gap Copilot and dispatch its server-sent events. */
export async function runRollout(body: RolloutRunBody, on: RolloutHandlers, signal: AbortSignal) {
  const res = await fetch("/api/rollout/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await readEvents(res, {
    scope: (d) => on.scope(d as Parameters<RolloutHandlers["scope"]>[0]),
    stage: (d) => on.stage(d as Parameters<RolloutHandlers["stage"]>[0]),
    tool_call: (d) => on.toolCall(d as Parameters<RolloutHandlers["toolCall"]>[0]),
    asis: (d) => on.asis(d as AsIsModel),
    gate: (d) => on.gate(d as RolloutGates),
    analysis: (d) => on.analysis(d as RolloutAnalysis),
    scores: (d) => on.scores(d as RolloutScores),
    sources: (d) => on.sources(d as RolloutSources),
    evaluation: (d) => on.evaluation?.(d as AgentEvaluation),
    done: (d) => on.done(d as Parameters<RolloutHandlers["done"]>[0]),
    error: (d) => on.error((d as { message: string }).message),
    log: (d) => on.log?.(d as EvidenceLogEntry),
  });
}

/** Whether workshop-pack downloads are the client copy (no model named).
 *  Off in the application; Demo Mode switches it on for its whole session. */
let clientCopies = false;
export function clientExports(on = true) { clientCopies = on; }

export const rollout = {
  status: () => fetch("/api/rollout/status").then((r) => json<RolloutStatus>(r)),
  preview: (body: RolloutRunBody) =>
    fetch("/api/rollout/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<RolloutPreview>(r)),
  runs: () => fetch("/api/rollout/runs").then((r) => json<RolloutRunSummary[]>(r)),
  run: (id: string) => fetch(`/api/rollout/runs/${id}`).then((r) => json<RolloutRunDetail>(r)),
  deleteRun: (id: string) =>
    fetch(`/api/rollout/runs/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((r) => json<{ status: string; id: string }>(r)),
  /** `client` leaves the model out of the pack. Demo Mode turns it on for
   *  every download with clientExports(), once, at start-up. */
  exportUrl: (id: string, format: "md" | "json" | "pdf", client = clientCopies) =>
    `/api/rollout/runs/${id}/export?format=${format}${client ? "&client=1" : ""}`,
  /** Where a cited document can be read. Corpus documents are resolved by
   *  file name; an attachment is served from its session, as the Markdown the
   *  agent actually read. */
  /** Where a cited passage's document opens. An attachment is served from the
   *  run that read it -- not from the page's current upload session, which is
   *  a different one, and expires hours after the run anyway. UPLOAD is the
   *  reserved category of attachments, which also catches runs recorded when
   *  they were mislabelled as corpus. */
  sourceUrl: (chunk: RolloutSourceChunk, runId: string | null) =>
    chunk.kind === "upload" || chunk.category === "UPLOAD"
      ? (runId && chunk.file
          ? `/api/rollout/runs/${runId}/attachments/${encodeURIComponent(chunk.file)}` : "")
      : (chunk.file ? `/api/kb/files/${encodeURIComponent(chunk.file)}` : ""),
  decide: (runId: string, body: {
    gap_id: string; reviewer: string; verdict: string; disposition?: string; comment?: string;
    option_index?: number; rationale?: string; session_id?: string;
  }) =>
    fetch(`/api/rollout/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<RolloutDecision>(r)),
  /** Every claim of the run traced to its quotes, the calls that retrieved
   *  them and the reasoning behind them; `format` downloads it as an audit file. */
  lineage: (runId: string) => fetch(`/api/rollout/runs/${runId}/lineage`).then((r) => json<Lineage>(r)),
  lineageExportUrl: (runId: string, format: "md" | "json") => `/api/rollout/runs/${runId}/lineage?format=${format}`,
  /** The workshop outcome as md, pdf, docx or xlsx; one sitting when `session` is given. */
  workshopExportUrl: (runId: string, format: string, session?: string) =>
    `/api/rollout/runs/${runId}/workshop/export?format=${format}${session ? `&session=${encodeURIComponent(session)}` : ""}`,
  /** Facilitator mode's Submit: the sitting and every answer, saved together or not at all. */
  submitWorkshop: (runId: string, body: {
    facilitator: string; attendees: string[];
    answers: { gap_id: string; verdict: string; option_index?: number; rationale?: string }[];
  }) =>
    fetch(`/api/rollout/runs/${runId}/workshop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ session: WorkshopSession; decisions: RolloutDecision[] }>(r)),
};

// --- the Answer Quality workspace ---------------------------------------------
//
// Four views over the judged Ask RAG answers; the arithmetic is all in
// quality.py. Nothing here calls a judge.

/** One of the four triad tiles on the Overview. */
export interface QualityTile {
  key: "overall" | "context_relevance" | "faithfulness" | "answer_relevancy";
  label: string;
  metric: string;
  value: number | null;
  /** The same window, one window earlier. */
  previous: number | null;
  delta: number | null;
  below: number;
  n: number;
}

/** Something worth a person's time, named as a cause rather than a metric.
 *  `text` carries a `{subject}` placeholder the page emphasises. */
export interface QualityAttention {
  severity: "bad" | "warn";
  kind: "subject" | "document" | "event";
  target: string | number;
  subject: string;
  text: string;
  detail: string;
}

export interface QualityOverview {
  days: number;
  line: number;
  scored: number;
  previous_scored: number;
  failing: number;
  tiles: QualityTile[];
  series: { at: string; n: number; median: number | null; p10: number | null; p90: number | null; faithfulness: number | null }[];
  /** Where the answering prompt or the corpus changed. */
  events: { at: string; kind: "prompt" | "corpus"; value: string }[];
  histogram: number[];
  halves: { half: string; n: number; overall: number | null; faithfulness: number | null }[];
  attention: QualityAttention[];
  attention_error: string;
  reviewed: number;
  /** Whether enough answers have a person's verdict to trust the judge. */
  checked: boolean;
}

/** A failure type: a stated rule over the scores, first match wins. */
export interface FailureType {
  key: "safety" | "wrong_sources" | "buried" | "ignored" | "invented" | "off_question";
  label: string;
  rule: string;
  means: string;
  fix: string;
  count: number;
}

export interface QualityPoint {
  run_id: string;
  question: string;
  at: string | null;
  overall: number | null;
  safety: number | null;
  /** Mean of context relevance and precision: the quadrant's horizontal axis. */
  retrieval: number | null;
  faithfulness: number | null;
  failure: FailureType["key"] | null;
  half: string;
  mode: string;
  subject: number | null;
  review: string | null;
  /** Every score the judge returned, by metric name; null where one failed. */
  values: Record<string, number | null>;
  /** Input plus output tokens the answer cost. */
  tokens: number;
}

export interface QualitySubject {
  id: number;
  label: string;
  n: number;
  overall: number | null;
  faithfulness: number | null;
  failure: FailureType["key"] | null;
  failing: number;
  /** The most typical question in the group. */
  example: string;
  run_ids: string[];
}

export interface QualityDocument {
  title: string;
  category: string;
  retrieved: number;
  judged: number;
  useful: number;
  useful_rate: number | null;
  /** Retrieved often and rarely useful: crowding out something better. */
  noisy: boolean;
  run_ids: string[];
}

export interface ClaimGroup {
  id: number;
  label: string;
  count: number;
  example: string;
  reason: string;
  run_ids: string[];
}

export interface QualityExplorer {
  days: number;
  line: number;
  failures: FailureType[];
  points: QualityPoint[];
  subjects: QualitySubject[];
  subjects_error: string;
  documents: QualityDocument[];
  claims: ClaimGroup[];
  claim_count: number;
  claims_error: string;
}

export interface JudgeQueueItem {
  run_id: string;
  question: string;
  kind: "disagree" | "relevance_split" | "unstable" | "sample";
  severity: "bad" | "warn" | "info";
  detail: string;
}

export interface JudgeTrust {
  judge_models: string[];
  scored: number;
  dropped: { metric: string; tried: number; lost: number; rate: number }[];
  dropped_rate: number | null;
  relevance: { pairs: number; agree: number; rate: number | null };
  stability: { rescored: number; median: number | null; unstable: number };
  agreement: {
    reviews: number;
    /** Withheld (null) below `min_reviews`: a kappa over six answers is noise. */
    kappa: number | null;
    raw: number | null;
    /** Rows are the judge's verdict, columns the reviewer's, in `buckets` order. */
    matrix: number[][];
    buckets: string[];
    min_reviews: number;
  };
  checked: boolean;
  queue: JudgeQueueItem[];
  unstable_above: number;
}

export interface ExperimentConfig {
  mode?: string;
  k?: number;
  answer_model?: string;
  judge_model?: string;
  prompt_hash?: string;
  corpus_fingerprint?: string;
  ragas_version?: string;
  limit?: number | null;
}

export interface ExperimentSummary {
  id: string;
  name: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  config: ExperimentConfig;
  baseline: boolean;
  langfuse_url: string;
  error: string;
  items: number;
  overall: number | null;
  correctness: number | null;
  faithfulness: number | null;
}

export interface ExperimentRow {
  item_id: string;
  question: string;
  part: string;
  verdict: "improved" | "regressed" | "unchanged" | "missing";
  missing_from?: "baseline" | "candidate";
  deltas: Record<string, number | null>;
  base: Record<string, number | null>;
  cand: Record<string, number | null>;
  /** Read off the excerpts, not a model: what entered, what left, what helped. */
  why: string[];
}

export interface ExperimentComparison {
  base: Pick<ExperimentSummary, "id" | "name" | "started_at" | "config" | "baseline">;
  cand: Pick<ExperimentSummary, "id" | "name" | "started_at" | "config" | "baseline">;
  /** The configuration keys that differ. A fair comparison differs in one. */
  differs: string[];
  counts: Partial<Record<ExperimentRow["verdict"], number>>;
  summary: Record<string, number | null>;
  tokens: { base: number | null; cand: number | null; change: number | null };
  rows: ExperimentRow[];
  noise: number;
}

export interface QualityFilters {
  days: number;
  half: string;
  mode: string;
}

const qualityQuery = (f: QualityFilters) =>
  `?days=${f.days}&half=${encodeURIComponent(f.half)}&mode=${encodeURIComponent(f.mode)}`;

export const quality = {
  overview: (f: QualityFilters) =>
    fetch(`/api/quality/overview${qualityQuery(f)}`).then((r) => json<QualityOverview>(r)),
  explorer: (f: QualityFilters) =>
    fetch(`/api/quality/explorer${qualityQuery(f)}`).then((r) => json<QualityExplorer>(r)),
  judge: () => fetch("/api/quality/judge").then((r) => json<JudgeTrust>(r)),
  experiments: () =>
    fetch("/api/quality/experiments").then((r) => json<{ experiments: ExperimentSummary[] }>(r)),
  compare: (base: string, cand: string) =>
    fetch(`/api/quality/experiments/compare?base=${encodeURIComponent(base)}&cand=${encodeURIComponent(cand)}`)
      .then((r) => json<ExperimentComparison>(r)),
  setBaseline: (id: string) =>
    fetch(`/api/quality/experiments/${encodeURIComponent(id)}/baseline`, { method: "POST" })
      .then((r) => json<{ status: string; id: string }>(r)),
  deleteExperiment: (id: string) =>
    fetch(`/api/quality/experiments/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((r) => json<{ status: string; id: string }>(r)),
  review: (runId: string, verdict: "grounded" | "partly" | "not", note = "", reviewer = "") =>
    fetch(`/api/ask/runs/${encodeURIComponent(runId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict, note, reviewer }),
    }).then((r) => json<{ status: string; verdict: string }>(r)),
};

/** One answered question from a run over the evaluation set. */
export interface ExperimentItem {
  item_id: string;
  question: string;
  part: string;
  answer: string;
  sources: { n: number; title: string; category: string }[];
  metrics: Record<string, MetricScore>;
  overall: number | null;
  safety: number | null;
  error: string;
  experiment: { id: string; name: string; config: ExperimentConfig };
}

export const experimentItem = (experimentId: string, itemId: string) =>
  fetch(`/api/quality/experiments/${encodeURIComponent(experimentId)}/items/${encodeURIComponent(itemId)}`)
    .then((r) => json<ExperimentItem>(r));

// --- traceability: rollout/lineage.py ------------------------------------------

export type QuoteStatus = "verbatim" | "partial" | "not_found" | "not_retrieved" | "unrecorded" | "empty";

export interface LineageRetrieval {
  call: number; tool: string; stage: string; query: string;
  rank: number | null; score: number | null; vector_rank: number | null; keyword_rank: number | null;
}

export interface LineageEvidence {
  chunk_id: string; doc: string; heading_path: string; side: string; evidence_class: string; quote: string;
  verification: { status: QuoteStatus; match: number; call: number | null; short?: boolean; elided?: boolean; via?: string };
  /** Evidence Agent passages: what the passage does for the claim. */
  stance?: "supports" | "opposes" | "context";
  provenance_note?: string;
  server_verified?: boolean | null;
  retrievals: LineageRetrieval[];
  first_call: number | null;
}

export interface LineageEntity {
  id: string; label: string; type: string; description: string; in_corpus: boolean | null; calls: number[];
}

export interface LineageClaim {
  kind: "asis_step" | "deviation" | "fit_area" | "localization" | "dimension" | "backlog" | "claim";
  ref: string; title: string; stage: string; statement?: string;
  status: "traced" | "partial" | "untraced";
  checks: { check: string; ok: boolean; detail: string }[];
  sides: string[];
  evidence: LineageEvidence[];
  evidence_inherited?: boolean;
  calls: number[];
  intents: { seq: number; text: string; calls: number[] }[];
  reasoning: { seq: number; text: string }[];
  sendbacks: { seq: number; title: string; text: string }[];
  graph: LineageEntity[];
  supported_by?: string[];
  derivation?: { what: string; value: string | number | null; how: string }[];
  gates?: { gate: string; severity: string; detail: string; gap_id: string }[];
  decisions?: { verdict: string; option_text: string | null; rationale: string; decided_by: string;
                decided_at: string; is_current: boolean }[];
  as_is_statement?: string; gt_statement?: string; sap_bp_reference?: string | null;
  as_is_step_id?: string; dimension?: string; disposition?: string; localization_state?: string;
  standard_options_considered?: string[];
  /** Evidence Agent claims. */
  graph_facts?: LineageGraphFact[];
  score?: number;
  governs?: boolean;
}

export interface LineageGraphFact {
  statement: string; meaningful: boolean; note: string; calls: number[]; confirmed: number; total: number;
  nodes: { id: string; label: string; type: string; calls: number[]; seen: boolean }[];
  edges: { id: string; relation: string; source: string; target: string; calls: number[]; seen: boolean;
           chunks?: string[] }[];
}

export interface LineageTrailEntry {
  seq: number | null; at?: string; kind: string; stage?: string; note?: string; title: string; text: string;
  call?: number; tool?: string; engine?: string; summary?: string; error?: string | null; ms?: number;
  query?: string; returned?: number; cited_chunks?: number; supports?: string[]; source?: string; by?: string;
}

export interface Lineage {
  run_id: string;
  claims: LineageClaim[];
  trail: LineageTrailEntry[];
  summary: {
    claims: number; by_status: Record<string, number>;
    quotes: number; verbatim: number; partial: number; not_found: number; not_retrieved: number; unrecorded: number;
    record: "full" | "partial" | "none"; calls_without_results: number;
    calls: number; engines: Record<string, number>; contributing_calls: number;
    chunks_retrieved: number; chunks_cited: number; documents_cited: number;
    graph_entities: number; graph_entities_mentioned: number; sendbacks: number; gate_issues: number;
    graph_facts?: number; graph_facts_confirmed?: number;
  };
  /** Evidence Agent runs: the answer the claims add up to. */
  answer?: {
    question: string; state: string; state_blurb: string; text: string;
    confidence: number | null; governing: string; open_questions: string[]; limits: string[];
    memory: { enabled?: boolean; used?: boolean; suppressed?: boolean;
              recalled: { text: string; type: string }[]; retained: string };
  };
  context: {
    model: string; prompt_hash: string; corpus_fingerprint: string; categories: string[]; scope: string;
    template_process: string; started_at: string; finished_at: string; not_checked: string[];
  };
}
