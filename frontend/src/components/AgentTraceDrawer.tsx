import {
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme, type Theme } from "@mui/material/styles";
import { nodeHues, unknownHue } from "../theme";
import * as d3 from "d3";
import { ArrowRight, BookOpen, Crosshair, ExternalLink, Globe, Maximize2, Network, Quote, Search, Target, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentToolCall,
  EvidenceBpmlTrace,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidenceGraphTrace,
  EvidenceRagHit,
  EvidenceRagTrace,
} from "../api";

/** The evidence one investigation call contributed, opened from its row in the
 *  log. Shared by the Evidence Agent and the Fit-Gap Copilot: they call the same
 *  five retrieval and graph tools, and a reader walking one agent's log should
 *  not meet a different panel from the other's.
 *
 *  The log answers "what did the agent do". This answers "and what did it get
 *  back", which is the question a reader actually has when they doubt an
 *  answer. It is deliberately one drawer with three renderers rather than
 *  three components: the reader is walking one investigation, and a retrieval
 *  call and a graph call should not feel like different parts of the product.
 *
 *  Everything shown here is what the run recorded at the time, not a fresh
 *  read. That matters for an old run: the corpus may have moved underneath it,
 *  and the point of the panel is what the agent saw, not what it would see
 *  now. */

interface Props {
  open: boolean;
  onClose: () => void;
  call: AgentToolCall | null;
  /** Chunk ids the finished answer cites, so a hit can be marked as having
   *  actually carried a claim rather than merely having been retrieved. Empty
   *  while the run is still going. */
  cited: string[];
  /** Graph node and edge ids the answer's graph facts rest on. */
  citedNodes: string[];
  citedEdges: string[];
  /** Open the document behind a retrieved chunk in the full inspector. */
  onOpenChunk?: (hit: EvidenceRagHit, walk: string[]) => void;
  /** Chunks the reader came here to check -- a quote traced from a finding.
   *  Outlined and scrolled to; `cited` keeps its meaning for the rest. */
  focus?: string[];
}

const ENGINE_FACE: Record<string, { name: string; colour: string; icon: typeof Search }> = {
  rag: { name: "RAG", colour: "primary.main", icon: Search },
  graph: { name: "GRAPH", colour: "info.main", icon: Network },
  bpml: { name: "BPML", colour: "success.main", icon: Target },
  web: { name: "WEB", colour: "warning.main", icon: Globe },
};

const ROLE_LABEL: Record<string, string> = {
  seed: "started here",
  path: "on the route",
  match: "resolved to",
  neighbour: "reached",
};

export default function AgentTraceDrawer({
  open,
  onClose,
  call,
  cited,
  citedNodes,
  citedEdges,
  onOpenChunk,
  focus = [],
}: Props) {
  const theme = useTheme();
  const face = ENGINE_FACE[call?.engine ?? ""] ?? {
    name: call?.engine?.toUpperCase() ?? "", colour: "text.secondary", icon: Search,
  };
  const Icon = face.icon;
  const trace = call?.trace ?? null;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: { xs: "100%", sm: 560, md: 720, lg: 820 },
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", color: face.colour }}><Icon size={15} /></Box>
        <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: ".06em", color: face.colour }}>
          {face.name}
        </Typography>
        <Typography sx={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 600 }}>
          {call?.tool}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {call && (
          <Typography sx={{ fontSize: 11, color: "text.disabled", fontVariantNumeric: "tabular-nums" }}>
            {call.ms}ms
          </Typography>
        )}
        <IconButton size="small" onClick={onClose} aria-label="Close"><X size={16} /></IconButton>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1.75 }}>
        {call && <Preamble call={call} />}
        {!trace && <Empty call={call} />}
        {trace?.kind === "rag" && (
          <RagTrace trace={trace} cited={cited} onOpenChunk={onOpenChunk} focus={focus} />
        )}
        {trace?.kind === "graph" && (
          <GraphTrace trace={trace} citedNodes={citedNodes} citedEdges={citedEdges} theme={theme} />
        )}
        {trace?.kind === "bpml" && <BpmlTrace trace={trace} />}
      </Box>
    </Drawer>
  );
}

/** What was asked. Shown for every engine, because a result nobody can see the
 *  question behind is not evidence of anything. */
function Preamble({ call }: { call: AgentToolCall }) {
  const args = Object.entries(call.arguments ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== "" &&
      !(typeof v === "object" && Object.keys(v as object).length === 0),
  );
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
        Asked
      </Typography>
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", gap: 0.75, mt: 0.75 }}>
        {args.map(([k, v]) => (
          <Box
            key={k}
            sx={{
              fontSize: 11.5, px: 0.75, py: 0.35, borderRadius: 0.75,
              border: 1, borderColor: "divider", maxWidth: "100%",
            }}
          >
            <Box component="span" sx={{ color: "text.secondary", mr: 0.6 }}>{k}</Box>
            <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
              {typeof v === "object" ? JSON.stringify(v) : String(v)}
            </Box>
          </Box>
        ))}
        {!args.length && (
          <Typography sx={{ fontSize: 12, color: "text.disabled" }}>no arguments</Typography>
        )}
      </Stack>
      {call.sources?.label && (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 1 }}>
          Read from <strong>{call.sources.label}</strong>
        </Typography>
      )}
      {call.warning && (
        <Stack direction="row" spacing={0.75} sx={{ mt: 1, alignItems: "flex-start" }}>
          <Box sx={{ display: "flex", color: "warning.main", mt: "2px" }}><TriangleAlert size={13} /></Box>
          <Typography sx={{ fontSize: 12, color: "warning.main" }}>{call.warning}</Typography>
        </Stack>
      )}
    </Box>
  );
}

function Empty({ call }: { call: AgentToolCall | null }) {
  return (
    <Box sx={{ py: 4, textAlign: "center" }}>
      <Typography sx={{ fontSize: 13, color: "text.secondary", mb: 0.5 }}>
        {call?.error ? "This call failed, so it returned no evidence." : "No trace was recorded for this call."}
      </Typography>
      <Typography sx={{ fontSize: 12, color: "text.disabled" }}>
        {call?.error
          ? call.error
          : "Investigations run before the log carried traces keep their summary but not what each call returned. Re-run the question to get one."}
      </Typography>
    </Box>
  );
}

// --- retrieval ------------------------------------------------------------------

function RagTrace({
  trace,
  cited,
  onOpenChunk,
  focus = [],
}: {
  trace: EvidenceRagTrace;
  cited: string[];
  onOpenChunk?: (hit: EvidenceRagHit, walk: string[]) => void;
  focus?: string[];
}) {
  const theme = useTheme();
  const walk = useMemo(() => trace.hits.map((h) => h.chunk_id), [trace.hits]);
  const citedSet = useMemo(() => new Set(cited), [cited]);
  const usedHere = trace.hits.filter((h) => citedSet.has(h.chunk_id)).length;

  // The words keyword search was looking for, marked in each passage so a
  // reader can see why a hit ranked where it did rather than taking the score
  // on trust. Terms under three characters are dropped: they match everywhere
  // and turn the passage into a stripe.
  const terms = useMemo(() => {
    const words = (trace.query || "")
      .toLowerCase()
      .split(/[^a-z0-9./-]+/i)
      .filter((w) => w.length > 2 && !STOP.has(w));
    return Array.from(new Set(words));
  }, [trace.query]);

  const byCategory = useMemo(() => {
    const c: Record<string, number> = {};
    for (const h of trace.hits) c[h.category || "—"] = (c[h.category || "—"] ?? 0) + 1;
    return c;
  }, [trace.hits]);

  return (
    <>
      <Summary
        lines={[
          `${trace.hits.length} passage${trace.hits.length === 1 ? "" : "s"} returned`,
          cited.length ? `${usedHere} cited in the answer` : "answer not finished",
          trace.mode === "direct" ? "fetched by id" : `${trace.mode} search`,
        ]}
        chips={Object.entries(byCategory).map(([k, n]) => `${k} ${n}`)}
      />

      {trace.note && <Note text={trace.note} />}
      {trace.duplicate_warning && <Note text={trace.duplicate_warning} warn />}

      <Stack spacing={1.25} sx={{ mt: 1.5 }}>
        {trace.hits.map((h) => {
          const isCited = citedSet.has(h.chunk_id);
          const isFocus = focus.includes(h.chunk_id);
          return (
            <Box
              key={h.chunk_id + h.rank}
              ref={isFocus ? (el: HTMLDivElement | null) => el?.scrollIntoView({ block: "center" }) : undefined}
              sx={{
                outline: isFocus ? `2px solid ${theme.palette.primary.main}` : "none",
                outlineOffset: 2,
                border: 1,
                borderColor: isCited ? alpha(theme.palette.success.main, 0.5) : "divider",
                borderRadius: 1,
                overflow: "hidden",
                bgcolor: isCited ? alpha(theme.palette.success.main, 0.04) : "transparent",
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: "center", px: 1.25, py: 0.85, flexWrap: "wrap", gap: 0.5 }}
              >
                <Box
                  sx={{
                    flexShrink: 0, width: 22, height: 22, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums",
                    bgcolor: alpha(theme.palette.primary.main, 0.12), color: "primary.main",
                  }}
                >
                  {h.rank}
                </Box>
                <Typography
                  sx={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 140, wordBreak: "break-word" }}
                >
                  {h.doc}
                </Typography>
                {h.category && (
                  <Chip size="small" variant="outlined" label={h.category}
                        sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
                )}
                {h.uploaded && (
                  <Chip size="small" color="secondary" variant="outlined" label="uploaded"
                        sx={{ height: 18, fontSize: 10 }} />
                )}
                {isCited && (
                  <Tooltip title="A claim in the answer rests on this passage.">
                    <Chip size="small" color="success" variant="outlined" icon={<Quote size={10} />}
                          label="cited" sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
                  </Tooltip>
                )}
                {onOpenChunk && (
                  <Tooltip title="Open the document this came from">
                    <IconButton size="small" onClick={() => onOpenChunk(h, walk)} aria-label="Open document">
                      <ExternalLink size={13} />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>

              {h.heading_path && (
                <Typography
                  sx={{ px: 1.25, pb: 0.5, fontSize: 11, color: "text.secondary", wordBreak: "break-word" }}
                >
                  {h.heading_path}
                </Typography>
              )}

              {/* The arithmetic behind the rank. A hit placed first overall but
                  fourteenth by vector got there on words, and saying so is the
                  difference between a score and an explanation. */}
              <Stack
                direction="row"
                spacing={1.25}
                sx={{ px: 1.25, pb: 0.75, flexWrap: "wrap", gap: 0.5, fontSize: 10.5, color: "text.secondary" }}
              >
                <Metric label="chunk" value={h.chunk_id} mono />
                {h.score !== null && <Metric label="fusion" value={h.score.toFixed(5)} />}
                <Metric label="vector" value={h.vector_rank ? `#${h.vector_rank}` : "not found"}
                        dim={!h.vector_rank} />
                <Metric label="keyword" value={h.keyword_rank ? `#${h.keyword_rank}` : "not found"}
                        dim={!h.keyword_rank} />
              </Stack>

              {h.provenance.length > 0 && (
                <Stack direction="row" spacing={0.5} sx={{ px: 1.25, pb: 0.75, flexWrap: "wrap", gap: 0.5 }}>
                  {h.provenance.map((p) => (
                    <Tooltip key={p} title={h.provenance_note || ""}>
                      <Chip size="small" variant="outlined" color="warning" label={p}
                            sx={{ height: 17, fontSize: 9.5 }} />
                    </Tooltip>
                  ))}
                </Stack>
              )}

              <Box
                sx={{
                  px: 1.25, py: 1, borderTop: 1, borderColor: "divider",
                  bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.03 : 0.02),
                  fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  maxHeight: 260, overflowY: "auto",
                }}
              >
                <Marked text={h.text} terms={terms} />
              </Box>
            </Box>
          );
        })}
      </Stack>

      {trace.truncated && (
        <Note text="More passages came back than the trace keeps. What is shown is the top of the ranking." />
      )}
    </>
  );
}

const STOP = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "from",
  "what", "which", "how", "does", "did", "has", "have", "but", "not", "all",
  "any", "can", "its", "into", "when", "who", "why", "where",
]);

/** Query terms marked in a passage. Splitting on a single alternation keeps the
 *  passage a plain string until render, so a 2,400-character chunk is not
 *  turned into 2,400 React nodes. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  const theme = useTheme();
  const parts = useMemo(() => {
    if (!terms.length) return [text];
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let re: RegExp;
    try {
      re = new RegExp(`(${escaped.join("|")})`, "gi");
    } catch {
      return [text];
    }
    return text.split(re);
  }, [text, terms]);
  const lower = useMemo(() => new Set(terms.map((t) => t.toLowerCase())), [terms]);
  return (
    <>
      {parts.map((p, i) =>
        lower.has(p.toLowerCase()) ? (
          <Box
            key={i}
            component="mark"
            sx={{
              bgcolor: alpha(theme.palette.warning.main, 0.28),
              color: "inherit", borderRadius: 0.5, px: 0.2,
            }}
          >
            {p}
          </Box>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Metric({ label, value, mono, dim }: { label: string; value: string; mono?: boolean; dim?: boolean }) {
  return (
    <Box component="span">
      <Box component="span" sx={{ color: "text.disabled", mr: 0.4 }}>{label}</Box>
      <Box
        component="span"
        sx={{
          fontWeight: 700, color: dim ? "text.disabled" : "text.secondary",
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </Box>
    </Box>
  );
}

// --- graph ----------------------------------------------------------------------

function GraphTrace({
  trace,
  citedNodes,
  citedEdges,
  theme,
}: {
  trace: EvidenceGraphTrace;
  citedNodes: string[];
  citedEdges: string[];
  theme: Theme;
}) {
  const [selected, setSelected] = useState<EvidenceGraphNode | null>(null);
  const citedNodeSet = useMemo(() => new Set(citedNodes), [citedNodes]);
  const citedEdgeSet = useMemo(() => new Set(citedEdges), [citedEdges]);

  const usedHere = trace.nodes.filter((n) => citedNodeSet.has(n.id)).length;

  return (
    <>
      <Summary
        lines={[
          `${trace.nodes.length} entit${trace.nodes.length === 1 ? "y" : "ies"}`,
          `${trace.edges.length} relationship${trace.edges.length === 1 ? "" : "s"}`,
          trace.count !== null && trace.count !== undefined
            ? `counted ${trace.count}`
            : citedNodes.length
              ? `${usedHere} used in the answer`
              : "traversal only",
        ]}
        chips={trace.seeds.map((s) => s.split(":").slice(1).join(":") || s)}
      />

      {trace.path && (
        <Box
          sx={{
            mt: 1.5, p: 1.25, borderRadius: 1, border: 1,
            borderColor: trace.path.meaningful === false ? "warning.main" : "divider",
            bgcolor: trace.path.meaningful === false
              ? alpha(theme.palette.warning.main, 0.07)
              : "transparent",
          }}
        >
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mb: 0.5 }}>
            {trace.path.meaningful === false && (
              <Box sx={{ display: "flex", color: "warning.main" }}><TriangleAlert size={13} /></Box>
            )}
            <Typography sx={{ fontSize: 11.5, fontWeight: 700 }}>
              {trace.path.hops} hop{trace.path.hops === 1 ? "" : "s"}
              {trace.path.meaningful === false ? " — not a real connection" : ""}
            </Typography>
          </Stack>
          {trace.path.note && (
            <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{trace.path.note}</Typography>
          )}
        </Box>
      )}

      <GraphCanvas
        trace={trace}
        theme={theme}
        selected={selected}
        onSelect={setSelected}
        citedNodes={citedNodeSet}
        citedEdges={citedEdgeSet}
      />

      {selected && <NodeCard node={selected} trace={trace} cited={citedNodeSet.has(selected.id)} />}

      {/* The same walk as a list. The picture shows the shape; the list shows
          the order, and a route with five identical-looking hops is far easier
          to check written out than traced with a finger. */}
      <Typography variant="overline" color="text.secondary" sx={{ display: "block", mt: 2.5, mb: 0.75 }}>
        {trace.path ? "The route, step by step" : "Relationships followed"}
      </Typography>
      <StepList trace={trace} citedEdges={citedEdgeSet} />

      {trace.note && <Note text={trace.note} />}
      {trace.truncated && (
        <Note text="The neighbourhood is larger than the trace keeps. What is drawn is the closest part of it." />
      )}
    </>
  );
}

/** A force-directed picture of what the traversal touched.
 *
 *  Deliberately small and non-interactive beyond selection: this is a panel
 *  inside an investigation log, not the Knowledge Graph page. Seeds are ringed,
 *  route edges are drawn heavy, and anything the answer ended up resting on is
 *  marked — so the question "which of these mattered" is answered by looking. */
function GraphCanvas({
  trace,
  theme,
  selected,
  onSelect,
  citedNodes,
  citedEdges,
}: {
  trace: EvidenceGraphTrace;
  theme: Theme;
  selected: EvidenceGraphNode | null;
  onSelect: (n: EvidenceGraphNode | null) => void;
  citedNodes: Set<string>;
  citedEdges: Set<string>;
}) {
  const hues = nodeHues[theme.palette.mode];
  const ref = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 640, h: 340 });
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(280, entry.contentRect.width);
      setSize({ w, h: Math.max(260, Math.min(420, w * 0.55)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (!trace.nodes.length) return;

    type N = EvidenceGraphNode & d3.SimulationNodeDatum;
    type L = d3.SimulationLinkDatum<N> & { relation: string; on_path: boolean; id: string };

    const nodes: N[] = trace.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: L[] = trace.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: byId.get(e.source)!, target: byId.get(e.target)!,
        relation: e.relation, on_path: e.on_path, id: e.id,
      }));

    const { w, h } = size;
    const muted = theme.palette.text.disabled;
    const line = theme.palette.divider;

    const sim = d3
      .forceSimulation<N>(nodes)
      .force("link", d3.forceLink<N, L>(links).id((d) => d.id).distance(78).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collide", d3.forceCollide<N>().radius((d) => radius(d) + 12));

    const root = svg.attr("viewBox", `0 0 ${w} ${h}`).append("g");

    const link = root
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", (d) =>
        d.on_path ? theme.palette.info.main : citedEdges.has(d.id) ? theme.palette.success.main : line)
      .attr("stroke-width", (d) => (d.on_path ? 2.5 : citedEdges.has(d.id) ? 2 : 1))
      .attr("stroke-opacity", (d) => (d.on_path || citedEdges.has(d.id) ? 0.95 : 0.45));

    const label = root
      .append("g")
      .selectAll("text")
      .data(links.filter((d) => d.on_path))
      .join("text")
      .text((d) => d.relation.replace(/_/g, " "))
      .attr("font-size", 8.5)
      .attr("fill", muted)
      .attr("text-anchor", "middle");

    const node = root
      .append("g")
      .selectAll<SVGGElement, N>("g")
      .data(nodes)
      .join("g")
      .style("cursor", "pointer")
      .on("click", (_e, d) => onSelect(selected?.id === d.id ? null : d));

    node
      .append("circle")
      .attr("r", (d) => radius(d))
      .attr("fill", (d) => nodeHues[theme.palette.mode][d.type] ?? muted)
      .attr("fill-opacity", (d) => (d.role === "neighbour" ? 0.55 : 0.9))
      .attr("stroke", (d) =>
        d.id === selected?.id
          ? theme.palette.text.primary
          : citedNodes.has(d.id)
            ? theme.palette.success.main
            : d.role === "seed"
              ? theme.palette.info.main
              : theme.palette.background.paper)
      .attr("stroke-width", (d) =>
        d.id === selected?.id ? 3 : citedNodes.has(d.id) || d.role === "seed" ? 2.5 : 1.5);

    node
      .append("text")
      .text((d) => (d.label.length > 26 ? d.label.slice(0, 25) + "…" : d.label))
      .attr("font-size", 9.5)
      .attr("text-anchor", "middle")
      .attr("dy", (d) => radius(d) + 11)
      .attr("fill", theme.palette.text.secondary)
      .style("pointer-events", "none");

    node.call(
      d3
        .drag<SVGGElement, N>()
        .on("start", (event, d) => {
          if (!event.active) sim.alphaTarget(0.25).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end", (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null; d.fy = null;
        }),
    );

    sim.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as N).x ?? 0)
        .attr("y1", (d) => (d.source as N).y ?? 0)
        .attr("x2", (d) => (d.target as N).x ?? 0)
        .attr("y2", (d) => (d.target as N).y ?? 0);
      label
        .attr("x", (d) => (((d.source as N).x ?? 0) + ((d.target as N).x ?? 0)) / 2)
        .attr("y", (d) => (((d.source as N).y ?? 0) + ((d.target as N).y ?? 0)) / 2 - 3);
      node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    // The panel is a still picture, not a live toy: let it settle and stop, so
    // a drawer left open is not holding a timer.
    return () => { sim.stop(); };
  }, [trace, size, theme, selected, onSelect, citedNodes, citedEdges]);

  function radius(d: EvidenceGraphNode) {
    if (d.role === "seed") return 13;
    if (d.role === "path") return 11;
    return 8;
  }

  return (
    <Box
      ref={boxRef}
      sx={{
        mt: 1.5, border: 1, borderColor: "divider", borderRadius: 1,
        overflow: "hidden", bgcolor: alpha(theme.palette.text.primary, 0.02),
      }}
    >
      <svg ref={ref} width="100%" height={size.h} style={{ display: "block" }} />
      <Stack
        direction="row"
        spacing={1.25}
        sx={{
          px: 1.25, py: 0.75, borderTop: 1, borderColor: "divider",
          flexWrap: "wrap", gap: 0.75, fontSize: 10.5, color: "text.secondary",
        }}
      >
        <Key colour={theme.palette.info.main} label="started here" ring />
        <Key colour={theme.palette.success.main} label="used in the answer" ring />
        {Object.entries(hues)
          .filter(([t]) => trace.nodes.some((n) => n.type === t))
          .map(([t, hue]) => <Key key={t} colour={hue} label={t} />)}
        <Box sx={{ flex: 1 }} />
        <Box component="span" sx={{ color: "text.disabled" }}>drag to rearrange · click to inspect</Box>
      </Stack>
    </Box>
  );
}

function Key({ colour, label, ring }: { colour: string; label: string; ring?: boolean }) {
  return (
    <Stack direction="row" spacing={0.45} sx={{ alignItems: "center" }}>
      <Box
        sx={{
          width: 9, height: 9, borderRadius: "50%",
          bgcolor: ring ? "transparent" : colour,
          border: ring ? `2px solid ${colour}` : "none",
        }}
      />
      <Box component="span">{label}</Box>
    </Stack>
  );
}

function NodeCard({
  node,
  trace,
  cited,
}: {
  node: EvidenceGraphNode;
  trace: EvidenceGraphTrace;
  cited: boolean;
}) {
  const theme = useTheme();
  const related = trace.edges.filter((e) => e.source === node.id || e.target === node.id);
  const labelOf = (id: string) => trace.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <Box sx={{ mt: 1.25, p: 1.25, border: 1, borderColor: "divider", borderRadius: 1 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: nodeHues[theme.palette.mode][node.type] ?? unknownHue(theme.palette.mode) }} />
        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{node.label}</Typography>
        <Chip size="small" variant="outlined" label={node.type} sx={{ height: 18, fontSize: 10 }} />
        <Chip size="small" variant="outlined" label={ROLE_LABEL[node.role] ?? node.role}
              sx={{ height: 18, fontSize: 10 }} />
        {cited && (
          <Chip size="small" color="success" variant="outlined" label="in the answer"
                sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
        )}
        {node.degree !== null && node.degree !== undefined && (
          <Tooltip title="How many relationships this entity has in the whole graph this run could see. A high number means it is a junction, so a route through it may mean less than it looks.">
            <Chip size="small" variant="outlined" label={`degree ${node.degree}`}
                  sx={{ height: 18, fontSize: 10, cursor: "help" }} />
          </Tooltip>
        )}
      </Stack>
      {node.description && (
        <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.75 }}>{node.description}</Typography>
      )}
      <Typography
        sx={{ fontFamily: "ui-monospace, monospace", fontSize: 10.5, color: "text.disabled", mt: 0.75 }}
      >
        {node.id}
      </Typography>
      {related.length > 0 && (
        <Stack spacing={0.35} sx={{ mt: 1 }}>
          {related.slice(0, 12).map((e) => (
            <Stack key={e.id} direction="row" spacing={0.6}
                   sx={{ alignItems: "center", fontSize: 11.5, color: "text.secondary" }}>
              <ArrowRight size={11} />
              <Box component="span" sx={{ fontWeight: 600 }}>{e.relation.replace(/_/g, " ")}</Box>
              <Box component="span" sx={{ color: "text.disabled" }}>
                {e.source === node.id ? labelOf(e.target) : labelOf(e.source)}
              </Box>
            </Stack>
          ))}
          {related.length > 12 && (
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
              and {related.length - 12} more
            </Typography>
          )}
        </Stack>
      )}
    </Box>
  );
}

function StepList({ trace, citedEdges }: { trace: EvidenceGraphTrace; citedEdges: Set<string> }) {
  const theme = useTheme();
  if (trace.path?.steps?.length) {
    return (
      <Stack spacing={0.5}>
        {trace.path.steps.map((s, i) => (
          <Stack key={i} direction="row" spacing={0.85} sx={{ alignItems: "center", fontSize: 12 }}>
            <Box
              sx={{
                width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 800,
                bgcolor: alpha(theme.palette.info.main, 0.15), color: "info.main",
              }}
            >
              {i + 1}
            </Box>
            <Box component="span" sx={{ fontWeight: 600 }}>{s.from}</Box>
            <Box
              component="span"
              sx={{
                fontSize: 10.5, px: 0.5, borderRadius: 0.5,
                color: s.is_label_edge ? "warning.main" : "text.secondary",
                border: 1, borderColor: s.is_label_edge ? "warning.main" : "divider",
              }}
            >
              {s.relation.replace(/_/g, " ")}
            </Box>
            <Box component="span" sx={{ fontWeight: 600 }}>{s.to}</Box>
          </Stack>
        ))}
        {trace.path.steps.some((s) => s.is_label_edge) && (
          <Note text="Hops marked in amber are classification edges — they record what something is filed under, not any flow of data between systems." warn />
        )}
      </Stack>
    );
  }
  const byRelation = new Map<string, EvidenceGraphEdge[]>();
  for (const e of trace.edges) {
    const list = byRelation.get(e.relation) ?? [];
    list.push(e);
    byRelation.set(e.relation, list);
  }
  const labelOf = (id: string) => trace.nodes.find((n) => n.id === id)?.label ?? id;
  if (!byRelation.size) {
    return (
      <Typography sx={{ fontSize: 12, color: "text.disabled" }}>
        This call resolved entities without walking any relationship.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      {[...byRelation.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([relation, list]) => (
          <Box key={relation}>
            <Stack direction="row" spacing={0.6} sx={{ alignItems: "center", mb: 0.25 }}>
              <Typography sx={{ fontSize: 11.5, fontWeight: 700 }}>
                {relation.replace(/_/g, " ")}
              </Typography>
              <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
                {list.length}
              </Typography>
            </Stack>
            <Stack spacing={0.2} sx={{ pl: 1.25 }}>
              {list.slice(0, 8).map((e) => (
                <Stack key={e.id} direction="row" spacing={0.5}
                       sx={{ alignItems: "center", fontSize: 11.5, color: "text.secondary" }}>
                  <Box component="span">{labelOf(e.source)}</Box>
                  <ArrowRight size={10} />
                  <Box component="span"
                       sx={{ fontWeight: citedEdges.has(e.id) ? 700 : 400,
                             color: citedEdges.has(e.id) ? "success.main" : "inherit" }}>
                    {labelOf(e.target)}
                  </Box>
                  {e.chunks?.length ? (
                    <Tooltip title={`Extracted from ${e.chunks.join(", ")}${e.mentions ? ` · named ${e.mentions} time(s) in the document` : ""}`}>
                      <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontSize: 10, color: "text.disabled" }}>
                        {e.chunks[0]}{e.chunks.length > 1 ? ` +${e.chunks.length - 1}` : ""}
                      </Box>
                    </Tooltip>
                  ) : null}
                </Stack>
              ))}
              {list.length > 8 && (
                <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
                  and {list.length - 8} more
                </Typography>
              )}
            </Stack>
          </Box>
        ))}
    </Stack>
  );
}

// --- BPML -----------------------------------------------------------------------

function BpmlTrace({ trace }: { trace: EvidenceBpmlTrace }) {
  const theme = useTheme();
  const name = (p: Record<string, unknown> | null | undefined) =>
    p ? String(p.name ?? p.label ?? p.title ?? "") : "";
  const code = (p: Record<string, unknown> | null | undefined) =>
    p ? String(p.code ?? "") : "";

  return (
    <>
      <Summary
        lines={[
          `${trace.ancestry.length} level${trace.ancestry.length === 1 ? "" : "s"} above`,
          `${trace.children.length} child step${trace.children.length === 1 ? "" : "s"}`,
          "read from the BPML process house in the corpus",
        ]}
        chips={[code(trace.process)].filter(Boolean)}
      />

      <Typography variant="overline" color="text.secondary" sx={{ display: "block", mt: 2, mb: 0.75 }}>
        Where it sits
      </Typography>
      <Stack spacing={0.35}>
        {trace.ancestry.map((a, i) => (
          <Stack key={i} direction="row" spacing={0.75}
                 sx={{ alignItems: "center", pl: i * 1.5, fontSize: 12, color: "text.secondary" }}>
            <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
              {code(a)}
            </Box>
            <Box component="span">{name(a)}</Box>
          </Stack>
        ))}
        <Stack
          direction="row"
          spacing={0.75}
          sx={{
            alignItems: "center", pl: trace.ancestry.length * 1.5, fontSize: 12.5,
            fontWeight: 700, color: "success.main",
          }}
        >
          <Crosshair size={12} />
          <Box component="span" sx={{ fontFamily: "ui-monospace, monospace" }}>{code(trace.process)}</Box>
          <Box component="span">{name(trace.process)}</Box>
        </Stack>
      </Stack>

      {trace.children.length > 0 && (
        <>
          <Typography variant="overline" color="text.secondary" sx={{ display: "block", mt: 2, mb: 0.75 }}>
            Steps inside it
          </Typography>
          <Stack spacing={0.25}>
            {trace.children.map((c, i) => (
              <Stack key={i} direction="row" spacing={0.75}
                     sx={{ alignItems: "center", fontSize: 12, color: "text.secondary" }}>
                <BookOpen size={11} />
                <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
                  {code(c)}
                </Box>
                <Box component="span">{name(c)}</Box>
              </Stack>
            ))}
          </Stack>
        </>
      )}

      <Box
        sx={{
          mt: 2, p: 1.25, borderRadius: 1,
          bgcolor: alpha(theme.palette.text.primary, 0.03), fontSize: 11.5, color: "text.secondary",
        }}
      >
        The hierarchy is read from the process workbook, not from the corpus. It says what the
        programme's own register holds, which is why it can name a step no document happens to
        mention.
      </Box>
    </>
  );
}

// --- shared ---------------------------------------------------------------------

function Summary({ lines, chips }: { lines: string[]; chips: string[] }) {
  const theme = useTheme();
  return (
    <Box
      sx={{
        p: 1.25, borderRadius: 1, border: 1, borderColor: "divider",
        bgcolor: alpha(theme.palette.text.primary, 0.02),
      }}
    >
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 0.75, alignItems: "center" }}>
        {lines.map((l, i) => (
          <Stack key={l} direction="row" spacing={1} sx={{ alignItems: "center" }}>
            {i > 0 && <Divider orientation="vertical" flexItem sx={{ height: 12 }} />}
            <Typography sx={{ fontSize: 12, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "text.primary" : "text.secondary" }}>
              {l}
            </Typography>
          </Stack>
        ))}
      </Stack>
      {chips.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.85 }}>
          {chips.map((c) => (
            <Chip key={c} size="small" variant="outlined" label={c}
                  sx={{ height: 18, fontSize: 10, fontWeight: 600 }} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function Note({ text, warn }: { text: string; warn?: boolean }) {
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        mt: 1.25, p: 1, borderRadius: 1, alignItems: "flex-start",
        bgcolor: alpha(warn ? theme.palette.warning.main : theme.palette.info.main, 0.08),
      }}
    >
      <Box sx={{ display: "flex", color: warn ? "warning.main" : "info.main", mt: "1px" }}>
        {warn ? <TriangleAlert size={12} /> : <Maximize2 size={12} />}
      </Box>
      <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{text}</Typography>
    </Stack>
  );
}
