import {
  Box,
  Chip,
  Divider,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { ChevronDown, ChevronRight, CornerDownRight, FileText, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { GraphData, GraphNode } from "../api";
import { clearAdornment, clearOnEscape } from "./ClearAdornment";

/** The BPML taxonomy as a tree, and the chain back up from any step.
 *
 *  The graph stores this as `subprocess_of` edges pointing from a child to its
 *  parent, which is the right shape for "what is this a part of" and the wrong
 *  one for "what is inside Lead to Cash". Both directions are built once here.
 */

interface Props {
  graph: GraphData;
  onFocusNode?: (id: string) => void;
}

/** 4.5.1.10 sorts after 4.5.1.2, not before it. Plain string ordering puts the
 *  tenth step between the first and the second, which makes a process list read
 *  as though the steps were shuffled. */
function byCode(a: string, b: string): number {
  const pa = a.split(/[.\-]/);
  const pb = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export default function ProcessFlowView({ graph, onFocusNode }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const { byId, parent, children, roots, specifiedBy } = useMemo(() => {
    const byId = new Map<string, GraphNode>();
    graph.nodes.forEach((n) => byId.set(n.id, n));

    // d3 rewrites edge endpoints from ids to node objects once the simulation
    // has run, so the same graph can arrive either way.
    const endId = (v: string | GraphNode): string => (typeof v === "string" ? v : v.id);

    const parent = new Map<string, string>();
    const children = new Map<string, string[]>();
    const specifiedBy = new Map<string, string[]>();
    graph.edges.forEach((e) => {
      const from = endId(e.source);
      const to = endId(e.target);
      if (e.relation === "subprocess_of") {
        parent.set(from, to);
        const list = children.get(to) || [];
        list.push(from);
        children.set(to, list);
      } else if (e.relation === "specifies_process") {
        const list = specifiedBy.get(to) || [];
        list.push(from);
        specifiedBy.set(to, list);
      }
    });
    children.forEach((list) =>
      list.sort((a, b) => byCode(byId.get(a)?.code || a, byId.get(b)?.code || b))
    );

    const roots = graph.nodes
      .filter((n) => n.type === "process" && !parent.has(n.id))
      // Value chains first (4.0, 9.0), then the orphans the workbook never
      // confirmed, which are kept parentless rather than given a made-up parent.
      .sort((a, b) => {
        const av = (a.code || "").endsWith(".0") ? 0 : 1;
        const bv = (b.code || "").endsWith(".0") ? 0 : 1;
        return av - bv || byCode(a.code || "", b.code || "");
      })
      .map((n) => n.id);

    return { byId, parent, children, roots, specifiedBy };
  }, [graph]);

  // Root plus its immediate children open, so the view starts showing the
  // shape of Lead to Cash rather than a single collapsed line.
  const initial = useMemo(() => {
    const open: Record<string, boolean> = {};
    const first = roots[0];
    if (first) {
      open[first] = true;
      (children.get(first) || []).forEach((c) => {
        open[c] = false;
      });
    }
    return open;
  }, [roots, children]);

  const isOpen = (id: string) => (id in expanded ? expanded[id] : initial[id] ?? false);
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !(id in prev ? prev[id] : initial[id] ?? false) }));

  /** The chain from a node back to its value chain — the backtrack. */
  const ancestry = useCallback(
    (id: string): GraphNode[] => {
      const chain: GraphNode[] = [];
      let cur: string | undefined = id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const node = byId.get(cur);
        if (node) chain.unshift(node);
        cur = parent.get(cur);
      }
      return chain;
    },
    [byId, parent]
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hit = new Set<string>();
    graph.nodes.forEach((n) => {
      if (n.type !== "process") return;
      const text = `${n.code || ""} ${n.description || ""} ${n.jira_key || ""}`.toLowerCase();
      if (text.includes(q)) {
        hit.add(n.id);
        // Keep every ancestor so a deep hit is still reachable in the tree.
        let cur = parent.get(n.id);
        while (cur) {
          hit.add(cur);
          cur = parent.get(cur);
        }
      }
    });
    return hit;
  }, [query, graph.nodes, parent]);

  const descendants = useCallback(
    (id: string): number => {
      const kids = children.get(id) || [];
      return kids.reduce((total, k) => total + 1 + descendants(k), 0);
    },
    [children]
  );

  const row = (id: string, depth: number): React.ReactNode => {
    if (matches && !matches.has(id)) return null;
    const node = byId.get(id);
    if (!node) return null;
    const kids = children.get(id) || [];
    const open = matches ? true : isOpen(id);
    const isSel = selected === id;
    return (
      <Box key={id}>
        <Stack
          direction="row"
          spacing={0.75}
          onClick={() => setSelected(id)}
          sx={{
            alignItems: "center",
            pl: `${depth * 18 + 6}px`,
            pr: 1,
            py: 0.45,
            borderRadius: 1,
            cursor: "pointer",
            bgcolor: (t) => (isSel ? alpha(t.palette.primary.main, 0.14) : "transparent"),
            "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, 0.07) },
          }}
        >
          <Box
            onClick={(e) => {
              e.stopPropagation();
              if (kids.length) toggle(id);
            }}
            sx={{ width: 16, display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            {kids.length > 0 &&
              (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
          </Box>
          <Typography
            variant="body2"
            sx={{ fontFamily: "monospace", fontWeight: 700, flexShrink: 0, minWidth: 92 }}
          >
            {node.code}
          </Typography>
          <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, color: "text.secondary" }}>
            {node.description}
          </Typography>
          {node.jira_key && (
            <Chip
              size="small"
              label={node.jira_key}
              sx={{ height: 18, fontSize: 10, fontWeight: 700, flexShrink: 0 }}
            />
          )}
          {kids.length > 0 && (
            <Typography variant="caption" sx={{ color: "text.disabled", flexShrink: 0 }}>
              {kids.length}
            </Typography>
          )}
        </Stack>
        {open && kids.map((k) => row(k, depth + 1))}
      </Box>
    );
  };

  const node = selected ? byId.get(selected) : null;
  const chain = selected ? ancestry(selected) : [];
  const kids = selected ? children.get(selected) || [] : [];
  const docs = selected ? specifiedBy.get(selected) || [] : [];

  return (
    <Box sx={{ display: "flex", height: "100%", minHeight: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Box sx={{ p: 1.25, borderBottom: 1, borderColor: "divider" }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Find a process, step or SPARK key…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={clearOnEscape(() => setQuery(""))}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={14} />
                  </InputAdornment>
                ),
                endAdornment: clearAdornment(query, () => setQuery(""), { size: 13 }),
              },
            }}
          />
        </Box>
        <Box sx={{ flex: 1, overflowY: "auto", py: 0.5 }}>{roots.map((r) => row(r, 0))}</Box>
      </Box>

      <Paper
        elevation={0}
        square
        sx={{ width: 320, flexShrink: 0, borderLeft: 1, borderColor: "divider", p: 2, overflowY: "auto" }}
      >
        {node ? (
          <Stack spacing={1.5}>
            <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
              Backtrack
            </Typography>
            <Stack spacing={0.25}>
              {chain.map((a, i) => (
                <Stack
                  key={a.id}
                  direction="row"
                  spacing={0.5}
                  onClick={() => setSelected(a.id)}
                  sx={{
                    alignItems: "baseline",
                    pl: `${i * 10}px`,
                    cursor: "pointer",
                    borderRadius: 1,
                    "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, 0.08) },
                  }}
                >
                  {i > 0 && <CornerDownRight size={11} style={{ flexShrink: 0, opacity: 0.5 }} />}
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: "monospace",
                      fontWeight: a.id === node.id ? 800 : 600,
                      color: a.id === node.id ? "text.primary" : "text.secondary",
                    }}
                  >
                    {a.code}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {a.description}
                  </Typography>
                </Stack>
              ))}
            </Stack>

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
              {node.code} — {node.description}
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5 }}>
              <Chip size="small" label={`Level ${chain.length}`} sx={{ height: 20, fontSize: 11 }} />
              {node.jira_key && (
                <Chip
                  size="small"
                  color="primary"
                  label={node.jira_key}
                  sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
                />
              )}
              <Chip
                size="small"
                variant="outlined"
                label={node.in_bpml ? "in BPML hierarchy" : "not in BPML hierarchy"}
                sx={{ height: 20, fontSize: 11 }}
              />
            </Stack>

            {kids.length > 0 && (
              <>
                <Divider />
                <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
                  Steps inside ({kids.length})
                </Typography>
                <Stack spacing={0.25}>
                  {kids.map((k) => {
                    const kid = byId.get(k);
                    if (!kid) return null;
                    return (
                      <Stack
                        key={k}
                        direction="row"
                        spacing={0.75}
                        onClick={() => setSelected(k)}
                        sx={{
                          alignItems: "baseline",
                          px: 0.75,
                          py: 0.3,
                          borderRadius: 1,
                          cursor: "pointer",
                          "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, 0.08) },
                        }}
                      >
                        <Typography variant="caption" sx={{ fontFamily: "monospace", fontWeight: 700 }}>
                          {kid.code}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {kid.description}
                        </Typography>
                      </Stack>
                    );
                  })}
                </Stack>
              </>
            )}

            {docs.length > 0 && (
              <>
                <Divider />
                <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
                  Specified by ({docs.length})
                </Typography>
                <Stack spacing={0.25}>
                  {docs.map((d) => (
                    <Stack
                      key={d}
                      direction="row"
                      spacing={0.5}
                      onClick={() => onFocusNode?.(d)}
                      sx={{
                        alignItems: "center",
                        px: 0.75,
                        py: 0.3,
                        borderRadius: 1,
                        cursor: "pointer",
                        "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, 0.08) },
                      }}
                    >
                      <FileText size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
                      <Typography variant="caption" noWrap>
                        {byId.get(d)?.label || d}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </>
            )}

            <Divider />
            <Tooltip title="Show this process in the graph canvas">
              <Chip
                size="small"
                clickable
                label="Open in graph view"
                onClick={() => onFocusNode?.(node.id)}
                sx={{ height: 24, fontSize: 11, fontWeight: 700, alignSelf: "flex-start" }}
              />
            </Tooltip>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
              Process flow
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The BPML taxonomy, from the value chain down to the L4 steps. Pick any
              row to see the chain back up to its value chain, the steps inside it,
              and the documents that specify it.
            </Typography>
            <Divider />
            <Typography variant="caption" color="text.secondary">
              {roots.length} roots · {graph.nodes.filter((n) => n.type === "process").length}{" "}
              processes · {graph.nodes.filter((n) => n.jira_key).length} steps carry a SPARK key
            </Typography>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
