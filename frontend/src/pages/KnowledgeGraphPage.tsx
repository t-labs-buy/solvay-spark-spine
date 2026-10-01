import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import ModelView from "../components/ModelView";
import CypherView from "../components/CypherView";
import GraphQualityView from "../components/GraphQualityView";
import { clearAdornment, clearOnEscape } from "../components/ClearAdornment";
import ProcessFlowView from "../components/ProcessFlowView";
import * as d3 from "d3";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Copy,
  GitBranch,
  Cpu,
  Crosshair,
  Eye,
  EyeOff,
  FileCode,
  FileText,
  Info,
  Layers,
  Maximize2,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Route,
  Search,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  Terminal,
  Gauge,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type GraphData,
  type GraphModel,
  type GraphNode,
  type GraphQueryResult,
  type ModelNode,
} from "../api";
import Markdown from "../components/Markdown";
import { frappe, nodeHues, surface, unknownHue, well, type Mode } from "../theme";

interface SimNode extends d3.SimulationNodeDatum, GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string;
  source: SimNode | string;
  target: SimNode | string;
  relation: string;
  label: string;
}

/** What a node type is, minus its colour.
 *
 *  The hue lives in the theme, because it has to be two hues -- the slate-and-
 *  violet set for light paper, Frappé's own accents for dark -- and because
 *  the trace drawer draws the same five categories and used to hold a second
 *  copy of the list. `typeConfig()` puts the two halves back together. */
const TYPE_META: Record<
  string,
  { label: string; icon: typeof Network; defaultVisible: boolean }
> = {
  stream: { label: "Business Streams", icon: Layers, defaultVisible: true },
  system: { label: "Core Systems", icon: Cpu, defaultVisible: true },
  document: { label: "Markdown Documents", icon: FileText, defaultVisible: true },
  process: { label: "BPML Processes", icon: Workflow, defaultVisible: true },
  // Specs start hidden because there used to be 548 of them against 720 nodes,
  // and drawing them all on first paint buried everything else. Since the
  // process register's Lowest Level Key column stopped being read as specs
  // there are 47 of 354, so that reason no longer holds -- left hidden for now
  // only to avoid changing what the page does by default without asking.
  spec: { label: "SPARK Specifications", icon: FileCode, defaultVisible: false },
};

const typeConfig = (mode: Mode) =>
  Object.fromEntries(
    Object.entries(TYPE_META).map(([k, v]) => [k, { ...v, color: nodeHues[mode][k] }]),
  ) as Record<string, { label: string; color: string; icon: typeof Network; defaultVisible: boolean }>;

/** The colour a node is drawn in.
 *
 *  The type wins over the node's own `color`. The extractor gives every
 *  stream and every system its own hue, so the four streams came out purple,
 *  pink, green and amber and the six systems blue, slate, sky, red, blue and
 *  green — while the legend beside them showed one swatch per type. Worse, the
 *  L2C green and the process green were the same value, so a stream and a BPML
 *  step were indistinguishable. Keying off the type is what makes the canvas
 *  agree with the legend, and it holds even against a stale cached graph. */
function nodeColor(node: { type: string; color?: string }, mode: Mode): string {
  return nodeHues[mode][node.type] || node.color || unknownHue(mode);
}

const PRESET_QUERIES = [
  { label: "What specs are linked to Salesforce?", query: "What specs are linked to Salesforce and how does it integrate?" },
  { label: "How does eCommerce connect to S/4HANA?", query: "How does eCommerce connect to S4HANA?" },
  { label: "What is BPML process O-020-090?", query: "What is BPML process O-020-090?" },
  { label: "Which specs belong to L2C?", query: "Which specifications belong to L2C stream?" },
  { label: "Difference between ECC & S/4HANA", query: "What is the difference between ECC and S4HANA?" },
];

interface KnowledgeGraphPageProps {
  active: boolean;
  onNavigate?: (page: string, params?: any) => void;
  /** A query handed over from another page (InsightLens's "show in
   *  graph"). The nonce lets the same text be sent twice. */
  incomingQuery?: { text: string; nonce: number } | null;
}

export default function KnowledgeGraphPage({ active, onNavigate, incomingQuery }: KnowledgeGraphPageProps) {
  const theme = useTheme();
  const TYPE_CONFIG = useMemo(() => typeConfig(theme.palette.mode), [theme.palette.mode]);
  // The two query modes and the "matched" colour, named once so the chips in
  // the results panel are drawn in the same hue as the canvas behind them.
  const isDarkMode = theme.palette.mode === "dark";
  const PATH_HUE = isDarkMode ? frappe.sky : "#0284c7";
  const RELATED_HUE = isDarkMode ? frappe.pink : "#8b5cf6";
  const MATCH_HUE = isDarkMode ? frappe.peach : "#ea580c";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Query state
  const [queryInput, setQueryInput] = useState("");
  const [isQuerying, setIsQuerying] = useState(false);
  const [activeQueryResult, setActiveQueryResult] = useState<GraphQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [isAnswerDrawerOpen, setIsAnswerDrawerOpen] = useState(false);
  const [copiedAnswer, setCopiedAnswer] = useState(false);

  // Filter state
  // Derived from TYPE_CONFIG rather than repeated here, so `defaultVisible` is
  // the single place a default lives.
  const [visibleTypes, setVisibleTypes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.entries(TYPE_META).map(([k, v]) => [k, v.defaultVisible]))
  );
  const [searchQuery, setSearchQuery] = useState("");
  // The canvas shows the graph that was built; the model view shows the
  // ontology it was meant to build, with each label and relationship marked
  // built / partial / absent. The model is fetched the first time it is asked
  // for -- most visits never open it.
  const [viewMode, setViewMode] = useState<"graph" | "model" | "process" | "cypher" | "quality">("graph");
  const [model, setModel] = useState<GraphModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [selectedModelNode, setSelectedModelNode] = useState<ModelNode | null>(null);
  // Which label, if any, is currently opened into the nodes it stands for.
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<SimNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null);

  useEffect(() => {
    if (viewMode !== "model" || model || modelError) return;
    api
      .graphModel()
      .then(setModel)
      .catch((e: unknown) => setModelError(e instanceof Error ? e.message : String(e)));
  }, [viewMode, model, modelError]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isFocusNeighborhoodMode, setIsFocusNeighborhoodMode] = useState(false);
  const [currentZoomLevel, setCurrentZoomLevel] = useState(0.85);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  // Starts collapsed: it is a reference, not something to read every visit.
  const [isLegendMinimized, setIsLegendMinimized] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pageContainerRef = useRef<HTMLDivElement | null>(null);

  // Fullscreen toggle handler
  const toggleFullscreen = useCallback(() => {
    const container = pageContainerRef.current;
    if (!container) return;

    if (!document.fullscreenElement && !isFullscreen) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      }
      setIsFullscreen(true);
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
        setIsFullscreen(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  // D3 Refs
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; vx?: number; vy?: number }>>(new Map());
  const renderRef = useRef<() => void>(() => {});
  const hasCenteredRef = useRef<boolean>(false);

  // Fetch graph data. The whole graph, always: a document's category is still
  // recorded on its node and still shown when one is selected, but the graph is
  // no longer cut down to a subset of them. Cutting it was what made a DR
  // record's link to a PKG spec disappear, which is the edge a graph is for.
  const loadGraph = useCallback((force = false) => {
    setLoading(true);
    setError(null);
    const fetcher = force ? api.rebuildGraph() : api.graphData();
    fetcher
      .then((data) => {
        setGraphData(data);
        // The model view's built/partial counts are read off the graph, so a
        // rebuild makes them stale. Dropping it here lets the lazy fetch pick
        // the new numbers up the next time the tab is opened.
        if (force) {
          setModel(null);
          setModelError(null);
          setSelectedModelNode(null);
        }
      })
      .catch((err) => {
        console.error("Failed to load graph data", err);
        setError(err.message || "Failed to load knowledge graph");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (active && !graphData) {
      loadGraph();
    }
  }, [active, graphData, loadGraph]);

  // Filter nodes & links based on visibleTypes
  const { filteredNodes, filteredLinks, nodeMap } = useMemo(() => {
    if (!graphData) return { filteredNodes: [], filteredLinks: [], nodeMap: new Map<string, SimNode>() };

    const nodesToInclude = new Set<string>();
    const nodeMap = new Map<string, SimNode>();

    graphData.nodes.forEach((n) => {
      if (visibleTypes[n.type]) {
        nodesToInclude.add(n.id);
        const prev = nodePositionsRef.current.get(n.id);
        nodeMap.set(n.id, {
          ...n,
          x: prev?.x,
          y: prev?.y,
          vx: prev?.vx,
          vy: prev?.vy,
        });
      }
    });

    const filteredNodes = Array.from(nodeMap.values());
    const filteredLinks: SimLink[] = [];

    graphData.edges.forEach((e) => {
      const srcId = typeof e.source === "string" ? e.source : (e.source as any).id;
      const tgtId = typeof e.target === "string" ? e.target : (e.target as any).id;
      if (nodesToInclude.has(srcId) && nodesToInclude.has(tgtId)) {
        filteredLinks.push({
          id: e.id,
          source: srcId,
          target: tgtId,
          relation: e.relation,
          label: e.label,
        });
      }
    });

    return { filteredNodes, filteredLinks, nodeMap };
  }, [graphData, visibleTypes]);

  // Neighbor lookup for selected node
  const neighborIds = useMemo(() => {
    const set = new Set<string>();
    if (!selectedNode) return set;
    set.add(selectedNode.id);
    filteredLinks.forEach((l) => {
      const sId = typeof l.source === "object" ? (l.source as SimNode).id : l.source;
      const tId = typeof l.target === "object" ? (l.target as SimNode).id : l.target;
      if (sId === selectedNode.id) set.add(tId);
      if (tId === selectedNode.id) set.add(sId);
    });
    return set;
  }, [selectedNode, filteredLinks]);

  // Neighbor lookup for hovered node
  const hoverNeighborIds = useMemo(() => {
    const set = new Set<string>();
    if (!hoveredNode) return set;
    set.add(hoveredNode.id);
    filteredLinks.forEach((l) => {
      const sId = typeof l.source === "object" ? (l.source as SimNode).id : l.source;
      const tId = typeof l.target === "object" ? (l.target as SimNode).id : l.target;
      if (sId === hoveredNode.id) set.add(tId);
      if (tId === hoveredNode.id) set.add(sId);
    });
    return set;
  }, [hoveredNode, filteredLinks]);

  // Connected nodes details for inspector drawer
  const connectedDetails = useMemo(() => {
    if (!selectedNode) return { systems: [], streams: [], processes: [], specs: [], docs: [] };
    const systems: SimNode[] = [];
    const streams: SimNode[] = [];
    const processes: SimNode[] = [];
    const specs: SimNode[] = [];
    const docs: SimNode[] = [];

    filteredLinks.forEach((l) => {
      const sId = typeof l.source === "object" ? (l.source as SimNode).id : l.source;
      const tId = typeof l.target === "object" ? (l.target as SimNode).id : l.target;
      let otherId: string | null = null;
      if (sId === selectedNode.id) otherId = tId;
      else if (tId === selectedNode.id) otherId = sId;

      if (otherId && nodeMap.has(otherId)) {
        const other = nodeMap.get(otherId)!;
        if (other.type === "system" && !systems.some((n) => n.id === other.id)) systems.push(other);
        else if (other.type === "stream" && !streams.some((n) => n.id === other.id)) streams.push(other);
        else if (other.type === "process" && !processes.some((n) => n.id === other.id)) processes.push(other);
        else if (other.type === "spec" && !specs.some((n) => n.id === other.id)) specs.push(other);
        else if (other.type === "document" && !docs.some((n) => n.id === other.id)) docs.push(other);
      }
    });

    return { systems, streams, processes, specs, docs };
  }, [selectedNode, filteredLinks, nodeMap]);

  // Render loop
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const transform = transformRef.current;
    const isDark = theme.palette.mode === "dark";

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // Background grid
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const isQueryActive = Boolean(activeQueryResult);
    const queryNodeSet = new Set(activeQueryResult?.node_ids || []);
    const queryEdgeSet = new Set(activeQueryResult?.edge_ids || []);
    const isPathMode = activeQueryResult?.mode === "path";

    // Active focal entity: hovered node takes precedence for rapid exploration, falling back to selected node
    const focalNode = hoveredNode || selectedNode;
    const hasFocus = Boolean(focalNode);

    // Draw Links
    filteredLinks.forEach((link) => {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      if (!source.x || !source.y || !target.x || !target.y) return;

      // In Focus Neighborhood Mode, hide any edge not part of the selected node's 1-hop neighborhood
      if (isFocusNeighborhoodMode && selectedNode) {
        if (!neighborIds.has(source.id) || !neighborIds.has(target.id)) {
          return;
        }
      }

      const isQueryEdge = isQueryActive && queryEdgeSet.has(link.id);
      const isFocalLink = hasFocus && (source.id === focalNode!.id || target.id === focalNode!.id);
      const isHoveredLink = Boolean(hoveredNode && (source.id === hoveredNode.id || target.id === hoveredNode.id));

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.hypot(dx, dy);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);

      if (isQueryActive) {
        if (isQueryEdge) {
          ctx.strokeStyle = isPathMode ? (isDark ? frappe.sky : "#0284c7") : (isDark ? frappe.pink : "#7c3aed");
          ctx.lineWidth = 3.2 / transform.k;
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = isDark ? frappe.surface0 : "#e2e8f0";
          ctx.lineWidth = 0.6 / transform.k;
          ctx.globalAlpha = 0.05;
        }
      } else if (hoveredNode) {
        if (isHoveredLink) {
          // Vibrant Electric Cyan on hover
          ctx.strokeStyle = isDark ? frappe.sky : "#0284c7";
          ctx.lineWidth = Math.max(2.4, 3.5 / transform.k);
          ctx.shadowColor = ctx.strokeStyle;
          ctx.shadowBlur = 8 / transform.k;
          ctx.globalAlpha = 1;
        } else {
          // All other links stay at normal visibility! Other links DO NOT disappear!
          ctx.strokeStyle = isDark ? alpha(frappe.overlay1, 0.3) : "rgba(100, 116, 139, 0.25)";
          ctx.lineWidth = Math.max(0.7, 1 / transform.k);
          ctx.globalAlpha = transform.k < 0.4 ? 0.35 : 0.65;
        }
      } else if (selectedNode) {
        if (isFocalLink) {
          // Vibrant Indigo on selection
          ctx.strokeStyle = isDark ? frappe.lavender : "#4f46e5";
          ctx.lineWidth = Math.max(2.2, 3.2 / transform.k);
          ctx.shadowColor = ctx.strokeStyle;
          ctx.shadowBlur = 6 / transform.k;
          ctx.globalAlpha = 1;
        } else {
          // Softly de-emphasize other edges when a node is clicked, but keep them visible!
          ctx.strokeStyle = isDark ? alpha(frappe.surface2, 0.5) : "rgba(203, 213, 225, 0.65)";
          ctx.lineWidth = 0.7 / transform.k;
          ctx.globalAlpha = 0.3;
        }
      } else {
        // Normal rest state: clean subtle connection
        ctx.strokeStyle = isDark ? alpha(frappe.overlay1, 0.3) : "rgba(100, 116, 139, 0.25)";
        ctx.lineWidth = Math.max(0.7, 1 / transform.k);
        ctx.globalAlpha = transform.k < 0.4 ? 0.35 : 0.65;
      }
      ctx.stroke();
      ctx.restore();

      // Directional Arrowhead
      if (dist > 15) {
        const targetRadius = (target.size || 12) * (target.id === focalNode?.id ? 1.3 : 1);
        const angle = Math.atan2(dy, dx);
        const shouldDrawArrow = isFocalLink || isQueryEdge || isFocusNeighborhoodMode || transform.k > 0.75;

        if (shouldDrawArrow) {
          const tipOffset = targetRadius + 2 / transform.k;
          const tipX = target.x - tipOffset * Math.cos(angle);
          const tipY = target.y - tipOffset * Math.sin(angle);

          const arrowLength = Math.max(5, Math.min(12, 8 / Math.sqrt(transform.k)));
          const arrowWidth = Math.max(3, Math.min(7, 4.5 / Math.sqrt(transform.k)));

          ctx.save();
          ctx.fillStyle = isFocalLink
            ? (isHoveredLink ? (isDark ? frappe.sky : "#0284c7") : (isDark ? frappe.lavender : "#4f46e5"))
            : isQueryEdge
            ? (isPathMode ? (isDark ? frappe.sky : "#0284c7") : (isDark ? frappe.pink : "#7c3aed"))
            : isDark
            ? alpha(frappe.overlay1, 0.6)
            : "rgba(100, 116, 139, 0.6)";

          ctx.globalAlpha = isFocalLink || isQueryEdge ? 1 : 0.65;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(
            tipX - arrowLength * Math.cos(angle) + arrowWidth * Math.sin(angle),
            tipY - arrowLength * Math.sin(angle) - arrowWidth * Math.cos(angle)
          );
          ctx.lineTo(
            tipX - arrowLength * Math.cos(angle) - arrowWidth * Math.sin(angle),
            tipY - arrowLength * Math.sin(angle) + arrowWidth * Math.cos(angle)
          );
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      // Relationship label pill badge
      const rawLabel = link.label || link.relation || "";
      const shouldShowRelationLabel =
        Boolean(rawLabel) &&
        dist > 40 &&
        (isFocalLink || isQueryEdge || (transform.k >= 1.35 && !hasFocus));

      if (shouldShowRelationLabel) {
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;

        ctx.save();
        const fSize = Math.max(8, Math.min(11, 10 / Math.sqrt(transform.k)));
        ctx.font = `600 ${fSize}px system-ui, -apple-system, sans-serif`;
        const textWidth = ctx.measureText(rawLabel).width;
        const px = 5;
        const py = 2.5;

        // Badge pill
        ctx.fillStyle = isDark ? alpha(frappe.crust, 0.94) : "rgba(255, 255, 255, 0.96)";
        ctx.strokeStyle = isFocalLink
          ? (isHoveredLink ? (isDark ? frappe.sky : "#0284c7") : (isDark ? frappe.lavender : "#4f46e5"))
          : isQueryEdge
          ? (isPathMode ? (isDark ? frappe.sky : "#0284c7") : (isDark ? frappe.pink : "#7c3aed"))
          : isDark
          ? alpha(frappe.surface2, 0.6)
          : "rgba(203, 213, 225, 0.75)";
        ctx.lineWidth = (isFocalLink || isQueryEdge ? 1.5 : 0.8) / transform.k;

        const bx = midX - textWidth / 2 - px;
        const by = midY - fSize / 2 - py;
        const bw = textWidth + px * 2;
        const bh = fSize + py * 2;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(bx, by, bw, bh, 3);
        } else {
          ctx.rect(bx, by, bw, bh);
        }
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = isFocalLink
          ? (isHoveredLink ? (isDark ? frappe.sky : "#0369a1") : (isDark ? frappe.lavender : "#4338ca"))
          : isQueryEdge
          ? (isPathMode ? (isDark ? frappe.sky : "#0284c7") : (isDark ? frappe.pink : "#7c3aed"))
          : isDark
          ? frappe.subtext1
          : "#475569";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(rawLabel, midX, midY);
        ctx.restore();
      }
    });

    // Draw Nodes
    filteredNodes.forEach((node) => {
      if (!node.x || !node.y) return;

      // In Focus Neighborhood Mode, skip non-neighbors
      if (isFocusNeighborhoodMode && selectedNode) {
        if (!neighborIds.has(node.id)) return;
      }

      const isSelected = selectedNode?.id === node.id;
      const isHovered = hoveredNode?.id === node.id;
      const isFocal = isSelected || isHovered;
      const isSelectedNeighbor = Boolean(selectedNode && neighborIds.has(node.id));
      const isHoveredNeighbor = Boolean(hoveredNode && hoverNeighborIds.has(node.id));
      const isFocalNeighbor = isSelectedNeighbor || isHoveredNeighbor;
      const isQueryMatch = isQueryActive && queryNodeSet.has(node.id);

      // Node opacity: other nodes NEVER disappear on hover!
      // Only when a query is active or a node is clicked do we softly de-emphasize unrelated nodes
      const isDeemphasized = isQueryActive
        ? !isQueryMatch && !isSelected
        : selectedNode && !isSelected && !isSelectedNeighbor;

      const radius = (node.size || 12) * (isSelected ? 1.4 : isHovered ? 1.35 : isHoveredNeighbor ? 1.15 : isQueryMatch ? 1.2 : 1);
      const baseColor = isQueryMatch && isPathMode
        ? (node.type === "system"
            ? (isDark ? frappe.blue : "#0284c7")
            : (isDark ? frappe.peach : "#ea580c"))
        : nodeColor(node, theme.palette.mode);

      ctx.save();
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);

      if (isDeemphasized) {
        // Softly de-emphasize, but keep colors visible!
        ctx.fillStyle = baseColor;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.lineWidth = 1 / transform.k;
        ctx.strokeStyle = isDark ? alpha(frappe.crust, 0.6) : "rgba(255, 255, 255, 0.6)";
        ctx.stroke();
      } else {
        // Full opacity for normal state, hover, neighbor, or selection! Nothing disappears on hover!
        ctx.globalAlpha = isSelected || isHovered || isHoveredNeighbor || isQueryMatch ? 1 : 0.88;
        ctx.fillStyle = baseColor;

        if (isSelected || isHovered || isQueryMatch) {
          ctx.shadowColor = isHovered ? (isDark ? frappe.sky : "#0284c7") : baseColor;
          ctx.shadowBlur = (isSelected ? 18 : isHovered ? 14 : 12) / transform.k;
        }
        ctx.fill();

        // White/dark high-contrast border
        ctx.lineWidth = (isSelected ? 3 : isHovered ? 2.5 : isHoveredNeighbor ? 2 : 1.8) / transform.k;
        ctx.strokeStyle = isSelected
          ? (isDark ? frappe.text : "#ffffff")
          : isHovered || isHoveredNeighbor
          ? (isDark ? frappe.sky : "#0284c7")
          : isDark
          ? frappe.crust
          : "#ffffff";
        ctx.stroke();
      }
      ctx.restore();

      // Node Labels: Show for streams, systems, hovered node, hovered neighbors, selected node, selected neighbors
      const shouldShowLabel =
        !isDeemphasized &&
        (node.type === "stream" ||
          node.type === "system" ||
          isSelected ||
          isHovered ||
          isHoveredNeighbor ||
          isSelectedNeighbor ||
          isQueryMatch ||
          (node.degree && node.degree > 6) ||
          transform.k > 1.1 ||
          isFocusNeighborhoodMode);

      if (shouldShowLabel) {
        ctx.save();
        const fontSize = Math.max(9, (node.type === "stream" ? 14 : node.type === "system" ? 12 : 10.5) / Math.sqrt(transform.k));
        const isBold = node.type === "stream" || node.type === "system" || isFocal || isQueryMatch;
        ctx.font = `${isBold ? "bold" : "600"} ${fontSize}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const text = transform.k > 1.5 || isFocal || isFocalNeighbor || node.label.length <= 26
          ? node.label
          : node.label.slice(0, 23) + "...";
        const textY = node.y + radius + fontSize * 0.85;

        // Label background badge
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = isFocal
          ? (isDark ? alpha(frappe.crust, 0.95) : "rgba(255, 255, 255, 0.98)")
          : isDark
          ? alpha(frappe.crust, 0.88)
          : "rgba(255, 255, 255, 0.92)";

        ctx.strokeStyle = isFocal
          ? (isDark ? frappe.sky : "#0284c7")
          : isFocalNeighbor
          ? (isDark ? alpha(frappe.sky, 0.4) : "rgba(2, 132, 199, 0.4)")
          : isDark
          ? alpha(frappe.surface1, 0.7)
          : "rgba(226, 232, 240, 0.8)";
        ctx.lineWidth = 1 / transform.k;

        const lx = node.x - textWidth / 2 - 4;
        const ly = textY - fontSize / 2 - 2;
        const lw = textWidth + 8;
        const lh = fontSize + 4;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(lx, ly, lw, lh, 3);
        } else {
          ctx.rect(lx, ly, lw, lh);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isFocal
          ? (isDark ? frappe.sky : "#0284c7")
          : isFocalNeighbor
          ? (isDark ? frappe.sky : "#0369a1")
          : isDark
          ? frappe.text
          : "#0f172a";
        ctx.fillText(text, node.x, textY);
        ctx.restore();
      }
    });

    ctx.restore();
  }, [
    filteredNodes,
    filteredLinks,
    selectedNode,
    hoveredNode,
    neighborIds,
    hoverNeighborIds,
    isFocusNeighborhoodMode,
    activeQueryResult,
    theme.palette.mode,
  ]);

  // Keep renderRef updated with the latest render closure
  renderRef.current = render;

  // Trigger lightweight redraw whenever render dependencies (selection, hover, query, theme) update
  useEffect(() => {
    render();
  }, [render]);

  // Setup D3 simulation and Canvas handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || filteredNodes.length === 0) return;

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 650;
    canvas.width = width;
    canvas.height = height;

    // Simulation setup with spacious distances, collision buffers, and gentle centering
    const sim = d3
      .forceSimulation<SimNode>(filteredNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(filteredLinks)
          .id((d) => d.id)
          .distance((d) => {
            const sType = typeof d.source === "object" ? (d.source as SimNode).type : "";
            const tType = typeof d.target === "object" ? (d.target as SimNode).type : "";
            if (sType === "stream" || tType === "stream") return 240;
            if (sType === "system" || tType === "system") return 160;
            return 95;
          })
          .strength(0.35)
      )
      .force(
        "charge",
        d3
          .forceManyBody<SimNode>()
          .strength((d) => (d.type === "stream" ? -1800 : d.type === "system" ? -750 : -220))
          .distanceMax(950)
      )
      .force(
        "collide",
        d3
          .forceCollide<SimNode>()
          .radius((d) => {
            const base = d.size || 12;
            return d.type === "stream" ? base + 35 : d.type === "system" ? base + 24 : base + 16;
          })
          .iterations(2)
      )
      .force("center", d3.forceCenter(width / 2, height / 2).strength(0.015))
      .velocityDecay(0.4)
      .alphaDecay(0.035);

    simulationRef.current = sim;

    sim.on("tick", () => {
      // Persist node coordinates across re-renders and filter changes
      filteredNodes.forEach((n) => {
        if (n.x !== undefined && n.y !== undefined) {
          nodePositionsRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
        }
      });
      renderRef.current();
    });

    // Hit-testing helper
    const findNodeAt = (screenX: number, screenY: number): SimNode | null => {
      const transform = transformRef.current;
      const x = (screenX - transform.x) / transform.k;
      const y = (screenY - transform.y) / transform.k;

      for (let i = filteredNodes.length - 1; i >= 0; i--) {
        const n = filteredNodes[i];
        if (n.x === undefined || n.y === undefined) continue;
        const dx = n.x - x;
        const dy = n.y - y;
        const radius = (n.size || 12) * 1.4;
        if (dx * dx + dy * dy <= radius * radius) {
          return n;
        }
      }
      return null;
    };

    // Zoom behavior with filter so clicking/dragging a node does not pan canvas
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 12])
      .filter((event) => {
        if (event.type === "mousedown") {
          const rect = canvas.getBoundingClientRect();
          const node = findNodeAt(event.clientX - rect.left, event.clientY - rect.top);
          if (node) return false;
        }
        return !event.ctrlKey && !event.button;
      })
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        setCurrentZoomLevel(event.transform.k);
        renderRef.current();
      });

    zoomBehaviorRef.current = zoom;
    d3.select(canvas).call(zoom);

    // Initial centering transform: start with panoramic overview
    if (!hasCenteredRef.current) {
      d3.select(canvas).call(
        zoom.transform,
        d3.zoomIdentity.translate(width / 2, height / 2).scale(0.35)
      );
      hasCenteredRef.current = true;
    }

    // Drag behavior for individual nodes
    let dragStartPos = { x: 0, y: 0 };
    const drag = d3
      .drag<HTMLCanvasElement, any>()
      .container(canvas)
      .subject((event) => {
        const rect = canvas.getBoundingClientRect();
        const node = findNodeAt(event.sourceEvent.clientX - rect.left, event.sourceEvent.clientY - rect.top);
        return node || undefined;
      })
      .on("start", (event) => {
        if (!event.subject) return;
        dragStartPos = { x: event.sourceEvent.clientX, y: event.sourceEvent.clientY };
        if (!event.active) sim.alphaTarget(0.15).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on("drag", (event) => {
        if (!event.subject) return;
        const transform = transformRef.current;
        const rect = canvas.getBoundingClientRect();
        const mouseX = event.sourceEvent.clientX - rect.left;
        const mouseY = event.sourceEvent.clientY - rect.top;
        event.subject.fx = (mouseX - transform.x) / transform.k;
        event.subject.fy = (mouseY - transform.y) / transform.k;
      })
      .on("end", (event) => {
        if (!event.subject) return;
        if (!event.active) sim.alphaTarget(0);
        const dx = event.sourceEvent.clientX - dragStartPos.x;
        const dy = event.sourceEvent.clientY - dragStartPos.y;
        if (Math.hypot(dx, dy) < 5) {
          // Clean click without dragging
          setSelectedNode(event.subject);
          setIsDrawerOpen(true);
        }
        event.subject.fx = null;
        event.subject.fy = null;
        renderRef.current();
      });

    d3.select(canvas).call(drag as any);

    // Mouse move: update cursor and hovered node cleanly
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const node = findNodeAt(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = node ? "pointer" : "default";
      setHoveredNode((prev) => (prev?.id === node?.id ? prev : node));
    };

    // Pointer down/up tracking for clicking empty canvas (to deselect)
    let pointerDownPos = { x: 0, y: 0 };
    let pointerDownOnNode = false;

    const handlePointerDown = (e: MouseEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      const rect = canvas.getBoundingClientRect();
      pointerDownOnNode = Boolean(findNodeAt(e.clientX - rect.left, e.clientY - rect.top));
    };

    const handlePointerUp = (e: MouseEvent) => {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist < 5 && !pointerDownOnNode) {
        setSelectedNode(null);
      }
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mousedown", handlePointerDown);
    canvas.addEventListener("mouseup", handlePointerUp);

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!container) return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      sim.force("center", d3.forceCenter(canvas.width / 2, canvas.height / 2));
      renderRef.current();
    });
    ro.observe(container);

    return () => {
      sim.stop();
      d3.select(canvas).on(".drag", null);
      d3.select(canvas).on(".zoom", null);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mousedown", handlePointerDown);
      canvas.removeEventListener("mouseup", handlePointerUp);
      ro.disconnect();
    };
  }, [filteredNodes, filteredLinks]);

  // Center and zoom to specific node with offset for right drawer
  const zoomToNode = useCallback(
    (node: SimNode) => {
      const canvas = canvasRef.current;
      const zoom = zoomBehaviorRef.current;
      if (!canvas || !zoom || node.x === undefined || node.y === undefined) return;

      setSelectedNode(node);
      setIsDrawerOpen(true);

      const width = canvas.width;
      const height = canvas.height;
      const scale = 2.2;
      // Center in visible area left of the 380px drawer
      const visibleCenterX = width > 768 ? (width - 380) / 2 : width / 2;
      const visibleCenterY = height / 2;
      const x = visibleCenterX - node.x * scale;
      const y = visibleCenterY - node.y * scale;

      d3.select(canvas)
        .transition()
        .duration(650)
        .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
    },
    []
  );

  /** Jump from a label in the model view to one of its real nodes.
   *
   *  The simulation only holds the types the legend has switched on, so a
   *  `spec` instance has no coordinates until `spec` is visible again. The
   *  delay lets the filter re-run and d3 seed the node before the camera
   *  moves; `zoomToNodes` is a no-op if it still is not there. */
  const focusGraphNode = useCallback(
    (id: string) => {
      const type = id.split(":", 1)[0];
      const asType: Record<string, string> = {
        proc: "process",
        doc: "document",
        spec: "spec",
        system: "system",
        stream: "stream",
      };
      const nodeType = asType[type];
      setViewMode("graph");
      if (nodeType) setVisibleTypes((prev) => (prev[nodeType] ? prev : { ...prev, [nodeType]: true }));
      window.setTimeout(() => zoomToNodes([id]), 320);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Zoom to a collection of nodes (e.g. query results or path)
  const zoomToNodes = useCallback(
    (nodeIds: string[]) => {
      const canvas = canvasRef.current;
      const zoom = zoomBehaviorRef.current;
      if (!canvas || !zoom || nodeIds.length === 0) return;

      const matchedNodes = nodeIds
        .map((id) => nodeMap.get(id))
        .filter((n): n is SimNode => Boolean(n && n.x !== undefined && n.y !== undefined));

      if (matchedNodes.length === 0) return;

      if (matchedNodes.length === 1) {
        zoomToNode(matchedNodes[0]);
        return;
      }

      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      matchedNodes.forEach((n) => {
        if (n.x! < minX) minX = n.x!;
        if (n.x! > maxX) maxX = n.x!;
        if (n.y! < minY) minY = n.y!;
        if (n.y! > maxY) maxY = n.y!;
      });

      const width = canvas.width;
      const height = canvas.height;
      const padding = 140;
      const dx = Math.max(maxX - minX, 100);
      const dy = Math.max(maxY - minY, 100);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      const scale = Math.max(0.12, Math.min(2.5, Math.min((width - padding) / dx, (height - padding) / dy)));
      const visibleCenterX = width > 768 ? (width - 380) / 2 : width / 2;
      const visibleCenterY = height / 2;
      const x = visibleCenterX - cx * scale;
      const y = visibleCenterY - cy * scale;

      d3.select(canvas)
        .transition()
        .duration(700)
        .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
    },
    [nodeMap, zoomToNode]
  );

  // Smooth Zoom In (+40%)
  const handleZoomIn = useCallback(() => {
    const canvas = canvasRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!canvas || !zoom) return;
    d3.select(canvas).transition().duration(250).call(zoom.scaleBy, 1.4);
  }, []);

  // Smooth Zoom Out (-29%)
  const handleZoomOut = useCallback(() => {
    const canvas = canvasRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!canvas || !zoom) return;
    d3.select(canvas).transition().duration(250).call(zoom.scaleBy, 0.714);
  }, []);

  // Zoom to Fit Entire Graph
  const handleZoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!canvas || !zoom || filteredNodes.length === 0) return;

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    filteredNodes.forEach((n) => {
      if (n.x !== undefined && n.y !== undefined) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
    });

    if (minX === Infinity) return;

    const width = canvas.width;
    const height = canvas.height;
    const padding = 80;
    const dx = Math.max(maxX - minX, 100);
    const dy = Math.max(maxY - minY, 100);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const scale = Math.max(0.08, Math.min(2.5, Math.min((width - padding) / dx, (height - padding) / dy)));
    const x = width / 2 - cx * scale;
    const y = height / 2 - cy * scale;

    d3.select(canvas)
      .transition()
      .duration(700)
      .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
  }, [filteredNodes]);

  // Focus on Selected Node + its direct 1-hop neighbors
  const handleFocusSelected = useCallback(() => {
    if (!selectedNode) return;
    const neighborNodeIds = Array.from(neighborIds);
    zoomToNodes(neighborNodeIds);
  }, [selectedNode, neighborIds, zoomToNodes]);

  // Reset view
  const handleResetView = useCallback(() => {
    handleZoomToFit();
    setSelectedNode(null);
    setIsFocusNeighborhoodMode(false);
  }, [handleZoomToFit]);

  // Execute graph query
  const handleRunQuery = useCallback(
    async (queryText: string) => {
      const q = queryText.trim();
      if (!q) return;

      setIsQuerying(true);
      setQueryError(null);
      try {
        const res = await api.queryGraph({ query: q });
        setActiveQueryResult(res);
        setSelectedNode(null);
        if (res.answer) {
          setIsAnswerDrawerOpen(true);
        }

        // Focus camera on the resulting subgraph
        setTimeout(() => {
          if (res.node_ids && res.node_ids.length > 0) {
            zoomToNodes(res.node_ids);
          }
        }, 120);
      } catch (err: any) {
        console.error("Query failed", err);
        setQueryError(err.message || "Failed to query graph");
      } finally {
        setIsQuerying(false);
      }
    },
    [zoomToNodes]
  );

  // A query handed over from InsightLens: run it once the graph is
  // loaded and this page is the visible one.
  const lastIncoming = useRef<number>(0);
  useEffect(() => {
    if (!active || !incomingQuery || !graphData) return;
    if (incomingQuery.nonce === lastIncoming.current) return;
    lastIncoming.current = incomingQuery.nonce;
    setQueryInput(incomingQuery.text);
    handleRunQuery(incomingQuery.text);
  }, [active, incomingQuery, graphData, handleRunQuery]);

  // Copy answer to clipboard
  const handleCopyAnswer = useCallback(() => {
    if (!activeQueryResult?.answer) return;
    navigator.clipboard.writeText(activeQueryResult.answer);
    setCopiedAnswer(true);
    setTimeout(() => setCopiedAnswer(false), 2000);
  }, [activeQueryResult]);

  // Clear query and restore full graph
  const handleClearQuery = useCallback(() => {
    setActiveQueryResult(null);
    setQueryError(null);
    setQueryInput("");
    setIsAnswerDrawerOpen(false);
    handleResetView();
  }, [handleResetView]);
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return filteredNodes
      .filter((n) => n.label.toLowerCase().includes(q) || (n.code && n.code.toLowerCase().includes(q)))
      .slice(0, 10);
  }, [filteredNodes, searchQuery]);



  // Reheat physics simulation
  const handleReheat = () => {
    if (simulationRef.current) {
      simulationRef.current.alpha(0.4).restart();
    }
  };

  return (
    <Box
      ref={pageContainerRef}
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
        position: isFullscreen ? "fixed" : "relative",
        inset: isFullscreen ? 0 : "auto",
        zIndex: isFullscreen ? 1400 : "auto",
        overflow: "hidden",
      }}
    >
      {/* Slim Top Navigation Bar */}
      <Paper
        elevation={0}
        sx={{
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: (t) => alpha(t.palette.background.paper, 0.85),
          backdropFilter: "blur(16px)",
          zIndex: 10,
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          columnGap: 2,
          alignItems: "center",
          minHeight: 52,
          boxShadow: (t) =>
            t.palette.mode === "dark"
              ? "0 4px 20px -2px rgba(0, 0, 0, 0.4)"
              : "0 2px 10px -2px rgba(0, 0, 0, 0.05)",
        }}
      >
        {/* Left: Sidebar Toggle, Title, Live Status, Stats */}
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Tooltip title={isSidebarOpen ? "Collapse Sidebar" : "Expand Sidebar"}>
            <IconButton
              size="small"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                bgcolor: (t) => alpha(t.palette.background.paper, 0.6),
                "&:hover": { bgcolor: "action.hover" },
                transition: "all 0.15s ease",
              }}
            >
              {isSidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </IconButton>
          </Tooltip>

          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: 2,
              bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
              color: "primary.main",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: 1,
              borderColor: (t) => alpha(t.palette.primary.main, 0.25),
              boxShadow: (t) => `0 0 12px ${alpha(t.palette.primary.main, 0.2)}`,
            }}
          >
            <Network size={18} />
          </Box>

          <Stack spacing={0}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 800, letterSpacing: "-0.015em", fontSize: 15, display: { xs: "none", sm: "block" } }}>
                Solvay Spark Spine
              </Typography>
            </Stack>
          </Stack>
        </Stack>

        {/* Centre: View Switcher */}
        <Box
          sx={{
            display: "flex",
            p: 0.35,
            borderRadius: 2,
            bgcolor: (t) => (t.palette.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)"),
            border: 1,
            borderColor: "divider",
          }}
        >
          {(["graph", "process", "model", "cypher", "quality"] as const).map((mode) => {
            const active = viewMode === mode;
            return (
              <Button
                key={mode}
                size="small"
                disableElevation
                onClick={() => setViewMode(mode)}
                startIcon={
                  mode === "graph" ? (
                    <Network size={13} />
                  ) : mode === "process" ? (
                    <GitBranch size={13} />
                  ) : mode === "cypher" ? (
                    <Terminal size={13} />
                  ) : mode === "quality" ? (
                    <Gauge size={13} />
                  ) : (
                    <Layers size={13} />
                  )
                }
                sx={{
                  textTransform: "none",
                  fontWeight: active ? 750 : 600,
                  fontSize: 12,
                  borderRadius: 1.5,
                  px: 1.35,
                  minWidth: 0,
                  height: 26,
                  color: active ? "primary.contrastText" : "text.secondary",
                  bgcolor: active ? "primary.main" : "transparent",
                  boxShadow: active ? (t) => `0 2px 8px ${alpha(t.palette.primary.main, 0.35)}` : "none",
                  "&:hover": {
                    bgcolor: active ? "primary.dark" : "action.hover",
                    color: active ? "primary.contrastText" : "text.primary",
                  },
                  transition: "all 0.15s ease",
                }}
              >
                {mode === "graph" ? "Graph" : mode === "process" ? "Process" : mode === "cypher" ? "Cypher" : mode === "quality" ? "Quality" : "Model"}
              </Button>
            );
          })}
        </Box>

        {/* Right: Actions */}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "flex-end" }}>
          {activeQueryResult?.answer && (
            <Button
              variant="contained"
              color="secondary"
              size="small"
              onClick={() => setIsAnswerDrawerOpen(true)}
              startIcon={<BookOpen size={13} />}
              sx={{
                textTransform: "none",
                fontWeight: 700,
                height: 30,
                fontSize: 12,
                borderRadius: 2,
                boxShadow: (t) => `0 2px 10px ${alpha(t.palette.secondary.main, 0.4)}`,
              }}
            >
              View Answer
            </Button>
          )}

          <Tooltip title="Reset View to Center">
            <Button
              variant="outlined"
              size="small"
              startIcon={<Compass size={13} />}
              onClick={handleResetView}
              sx={{
                textTransform: "none",
                fontWeight: 650,
                height: 30,
                fontSize: 12,
                borderRadius: 2,
                borderColor: "divider",
                color: "text.primary",
                "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
              }}
            >
              Fit View
            </Button>
          </Tooltip>

          <Tooltip title="Reheat Physics Simulation">
            <IconButton
              size="small"
              onClick={handleReheat}
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                width: 30,
                height: 30,
                "&:hover": { borderColor: "primary.main", color: "primary.main" },
              }}
            >
              <Play size={13} />
            </IconButton>
          </Tooltip>

          <Tooltip title="Rescan and Rebuild Graph from Files">
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              startIcon={<RefreshCw size={13} className={loading ? "animate-spin" : ""} />}
              onClick={() => loadGraph(true)}
              disabled={loading}
              sx={{
                textTransform: "none",
                fontWeight: 650,
                height: 30,
                fontSize: 12,
                borderRadius: 2,
                borderColor: "divider",
                "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
              }}
            >
              Rescan
            </Button>
          </Tooltip>

          <Tooltip title={isFullscreen ? "Exit Full Screen Window (Esc)" : "Full Screen Window View"}>
            <Button
              variant={isFullscreen ? "contained" : "outlined"}
              color={isFullscreen ? "primary" : "inherit"}
              size="small"
              startIcon={isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              onClick={toggleFullscreen}
              sx={{
                textTransform: "none",
                fontWeight: 650,
                height: 30,
                fontSize: 12,
                borderRadius: 2,
                borderColor: isFullscreen ? "primary.main" : "divider",
                "&:hover": { borderColor: "primary.main" },
              }}
            >
              {isFullscreen ? "Exit Full Screen" : "Full Screen"}
            </Button>
          </Tooltip>
        </Stack>
      </Paper>

      {/* Body Row: Collapsible Sidebar + Canvas Area */}
      <Box sx={{ flex: 1, display: "flex", position: "relative", overflow: "hidden" }}>
        {/* Left Sidebar */}
        <Paper
          elevation={0}
          sx={{
            width: isSidebarOpen ? 320 : 0,
            minWidth: isSidebarOpen ? 320 : 0,
            transition: "width 0.22s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
            overflow: "hidden",
            borderRight: isSidebarOpen ? 1 : 0,
            borderColor: "divider",
            bgcolor: (t) => alpha(t.palette.background.paper, 0.94),
            backdropFilter: "blur(16px)",
            display: "flex",
            flexDirection: "column",
            zIndex: 10,
          }}
        >
          <Box sx={{ width: 320, height: "100%", display: "flex", flexDirection: "column", overflowY: "auto", p: 2, gap: 2.25 }}>
            {/* Section 1: Entity Search */}
            <Box>
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 750,
                  color: "text.secondary",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  mb: 1,
                }}
              >
                <Search size={13} /> Search & Jump
              </Typography>

              <Box sx={{ position: "relative" }}>
                <TextField
                  fullWidth
                  size="small"
                  placeholder="Search entities, systems, tickets..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={clearOnEscape(() => setSearchQuery(""))}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <Search size={14} color={theme.palette.text.secondary} />
                        </InputAdornment>
                      ),
                      endAdornment: searchQuery ? (
                        clearAdornment(searchQuery, () => setSearchQuery(""), { size: 13 })
                      ) : (
                        <InputAdornment position="end">
                          <Box
                            sx={{
                              px: 0.75,
                              py: 0.1,
                              borderRadius: 1,
                              bgcolor: (t) => surface(t, 0.8),
                              border: 1,
                              borderColor: "divider",
                              fontSize: 10,
                              fontWeight: 700,
                              color: "text.secondary",
                              fontFamily: "monospace",
                              letterSpacing: "0.02em",
                            }}
                          >
                            /
                          </Box>
                        </InputAdornment>
                      ),
                      sx: {
                        fontSize: 12.5,
                        height: 36,
                        borderRadius: 2,
                        bgcolor: "background.paper",
                        transition: "all 0.15s ease",
                        "&:hover": { borderColor: "primary.main" },
                        "&.Mui-focused": {
                          boxShadow: (t) => `0 0 0 3px ${alpha(t.palette.primary.main, 0.18)}`,
                        },
                      },
                    },
                  }}
                />

                {/* Suggestions Dropdown */}
                {searchResults.length > 0 && (
                  <Paper
                    elevation={8}
                    sx={{
                      position: "absolute",
                      top: 42,
                      left: 0,
                      right: 0,
                      zIndex: 50,
                      maxHeight: 280,
                      overflowY: "auto",
                      borderRadius: 2.5,
                      border: 1,
                      borderColor: "divider",
                      bgcolor: (t) => alpha(t.palette.background.paper, 0.98),
                      backdropFilter: "blur(16px)",
                      boxShadow: (t) =>
                        t.palette.mode === "dark"
                          ? "0 12px 30px -4px rgba(0,0,0,0.7)"
                          : "0 12px 24px -4px rgba(0,0,0,0.12)",
                    }}
                  >
                    {searchResults.map((n) => {
                      const cfg = TYPE_CONFIG[n.type];
                      return (
                        <Box
                          key={n.id}
                          onClick={() => {
                            zoomToNode(n);
                            setSearchQuery("");
                          }}
                          sx={{
                            p: 1.25,
                            display: "flex",
                            alignItems: "center",
                            gap: 1.25,
                            cursor: "pointer",
                            "&:hover": {
                              bgcolor: (t) => alpha(t.palette.primary.main, 0.08),
                            },
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            transition: "background-color 0.12s ease",
                          }}
                        >
                          <Box
                            sx={{
                              width: 9,
                              height: 9,
                              borderRadius: "50%",
                              bgcolor: cfg?.color || unknownHue(theme.palette.mode),
                              boxShadow: `0 0 6px ${cfg?.color || unknownHue(theme.palette.mode)}88`,
                            }}
                          />
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="body2" noWrap sx={{ fontWeight: 650, fontSize: 12.5 }}>
                              {n.label}
                            </Typography>
                            <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 10.5 }}>
                              {cfg?.label} • {n.degree ?? 0} connections
                            </Typography>
                          </Box>
                          <ArrowRight size={13} color={theme.palette.text.secondary} />
                        </Box>
                      );
                    })}
                  </Paper>
                )}
              </Box>
            </Box>

            <Divider />

            {/* Section 2: Entity Type Filter */}
            <Box>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.25 }}>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 750,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontSize: 11,
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                  }}
                >
                  <SlidersHorizontal size={13} /> Filter Types
                </Typography>
                <Box sx={{ display: "flex", gap: 0.75, alignItems: "center" }}>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      const allOn: Record<string, boolean> = {};
                      Object.keys(TYPE_CONFIG).forEach((k) => { allOn[k] = true; });
                      setVisibleTypes(allOn);
                    }}
                    sx={{ minWidth: "auto", p: 0.3, px: 0.8, fontSize: 11, textTransform: "none", color: "primary.main", fontWeight: 700, borderRadius: 1 }}
                  >
                    All
                  </Button>
                  <Typography variant="caption" sx={{ color: "divider" }}>|</Typography>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      const allOff: Record<string, boolean> = {};
                      Object.keys(TYPE_CONFIG).forEach((k) => { allOff[k] = false; });
                      setVisibleTypes(allOff);
                    }}
                    sx={{ minWidth: "auto", p: 0.3, px: 0.8, fontSize: 11, textTransform: "none", color: "text.secondary", fontWeight: 650, borderRadius: 1 }}
                  >
                    Clear
                  </Button>
                </Box>
              </Box>

              <Stack spacing={0.75}>
                {Object.entries(TYPE_CONFIG).map(([typeKey, cfg]) => {
                  const isVisible = visibleTypes[typeKey];
                  const count = graphData?.stats?.types[typeKey] || 0;
                  const IconComp = cfg.icon;

                  return (
                    <Box
                      key={typeKey}
                      onClick={() => setVisibleTypes((prev) => ({ ...prev, [typeKey]: !prev[typeKey] }))}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        px: 1.25,
                        py: 0.85,
                        borderRadius: 2,
                        cursor: "pointer",
                        border: 1,
                        borderColor: isVisible ? alpha(cfg.color, 0.4) : "divider",
                        bgcolor: isVisible ? alpha(cfg.color, 0.08) : "transparent",
                        boxShadow: isVisible ? `0 2px 8px ${alpha(cfg.color, 0.1)}` : "none",
                        "&:hover": {
                          bgcolor: isVisible ? alpha(cfg.color, 0.14) : "action.hover",
                          borderColor: isVisible ? cfg.color : "text.secondary",
                        },
                        transition: "all 0.15s ease",
                      }}
                    >
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <Checkbox
                          size="small"
                          checked={isVisible}
                          sx={{
                            p: 0,
                            color: alpha(cfg.color, 0.5),
                            "&.Mui-checked": { color: cfg.color },
                          }}
                        />
                        <Box
                          sx={{
                            width: 24,
                            height: 24,
                            borderRadius: 1.2,
                            bgcolor: alpha(cfg.color, 0.15),
                            color: cfg.color,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <IconComp size={13} />
                        </Box>
                        <Typography variant="body2" sx={{ fontSize: 12.5, fontWeight: isVisible ? 650 : 500 }}>
                          {cfg.label}
                        </Typography>
                      </Stack>
                      <Chip
                        size="small"
                        label={count}
                        sx={{
                          height: 20,
                          fontSize: 10.5,
                          fontWeight: 700,
                          bgcolor: isVisible ? alpha(cfg.color, 0.18) : "action.selected",
                          color: isVisible ? cfg.color : "text.secondary",
                          borderRadius: 1.5,
                        }}
                      />
                    </Box>
                  );
                })}
              </Stack>
            </Box>

            <Divider />

            {/* Section 3: Graph AI Natural Language Query */}
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2.5,
                bgcolor: (t) => (t.palette.mode === "dark" ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)"),
                border: 1,
                borderColor: "divider",
              }}
            >
              <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 750,
                    color: "text.primary",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontSize: 11,
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                  }}
                >
                  <Sparkles size={14} color={theme.palette.primary.main} /> Ask Knowledge Graph
                </Typography>
                <Chip
                  size="small"
                  label="Graph RAG"
                  sx={{
                    height: 18,
                    fontSize: 9.5,
                    fontWeight: 800,
                    bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
                    color: "primary.main",
                    borderRadius: 1,
                  }}
                />
              </Stack>

              <TextField
                fullWidth
                multiline
                minRows={2}
                maxRows={4}
                size="small"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleRunQuery(queryInput);
                  }
                }}
                placeholder="Ask anything (e.g. 'What specs are linked to Salesforce?', 'How does eCommerce connect to S/4HANA?')..."
                slotProps={{
                  input: {
                    sx: {
                      fontSize: 12.5,
                      borderRadius: 2,
                      bgcolor: "background.paper",
                      transition: "all 0.15s ease",
                      "&.Mui-focused": {
                        boxShadow: (t) => `0 0 0 3px ${alpha(t.palette.primary.main, 0.18)}`,
                      },
                    },
                    endAdornment: clearAdornment(queryInput, () => setQueryInput(""),
                                                 { label: "Clear question", top: true }),
                  },
                }}
              />

              <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 10, display: "block", mt: 0.5 }}>
                Press ↵ Enter to submit · Shift + ↵ for newline
              </Typography>

              <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
                <Button
                  fullWidth
                  variant="contained"
                  disabled={isQuerying || !queryInput.trim()}
                  onClick={() => handleRunQuery(queryInput)}
                  startIcon={isQuerying ? <CircularProgress size={13} color="inherit" /> : <Sparkles size={14} />}
                  sx={{
                    textTransform: "none",
                    fontWeight: 750,
                    borderRadius: 2,
                    fontSize: 12.5,
                    py: 0.75,
                    boxShadow: (t) => `0 3px 12px ${alpha(t.palette.primary.main, 0.35)}`,
                  }}
                >
                  Ask Graph
                </Button>
                {activeQueryResult && (
                  <Button
                    variant="outlined"
                    color="inherit"
                    onClick={handleClearQuery}
                    sx={{ textTransform: "none", fontWeight: 650, borderRadius: 2, fontSize: 12, px: 1.5, borderColor: "divider" }}
                  >
                    Clear
                  </Button>
                )}
              </Stack>

              {/* Quick Presets */}
              <Box sx={{ mt: 1.75 }}>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 750,
                    color: "text.secondary",
                    fontSize: 10.5,
                    mb: 0.75,
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                  }}
                >
                  <Zap size={12} color={theme.palette.warning.main} /> Quick Presets:
                </Typography>
                <Stack spacing={0.75}>
                  {PRESET_QUERIES.map((preset, idx) => (
                    <Paper
                      key={idx}
                      variant="outlined"
                      onClick={() => {
                        setQueryInput(preset.query);
                        handleRunQuery(preset.query);
                      }}
                      sx={{
                        p: 1.1,
                        cursor: "pointer",
                        borderRadius: 2,
                        bgcolor: "background.paper",
                        borderColor: "divider",
                        "&:hover": {
                          borderColor: "primary.main",
                          bgcolor: (t) => alpha(t.palette.primary.main, 0.05),
                          transform: "translateY(-1.5px)",
                          boxShadow: (t) =>
                            t.palette.mode === "dark"
                              ? "0 4px 12px rgba(0,0,0,0.4)"
                              : "0 4px 12px rgba(0,0,0,0.06)",
                        },
                        transition: "all 0.15s ease",
                      }}
                    >
                      <Typography variant="caption" sx={{ fontWeight: 700, display: "block", color: "text.primary" }}>
                        {preset.label}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 10.5, display: "block", mt: 0.25 }} noWrap>
                        {preset.query}
                      </Typography>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            </Box>
          </Box>
        </Paper>

        {/* Main Canvas Area */}
        <Box ref={containerRef} sx={{ flex: 1, position: "relative", bgcolor: (t) => well(t.palette.mode) }}>
        {loading && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "rgba(0,0,0,0.25)",
              backdropFilter: "blur(4px)",
              zIndex: 20,
            }}
          >
            <CircularProgress size={38} />
            <Typography variant="body2" sx={{ mt: 2, fontWeight: 600 }}>
              Analyzing documents & building knowledge graph...
            </Typography>
          </Box>
        )}

        {viewMode === "graph" && (error || queryError) && (
          <Box sx={{ position: "absolute", top: 20, left: 20, right: 20, zIndex: 20 }}>
            <Alert
              severity="error"
              onClose={() => {
                setError(null);
                setQueryError(null);
              }}
            >
              {error || queryError}
            </Alert>
          </Box>
        )}

        {/* Floating Query Results Banner */}
        {viewMode === "graph" && activeQueryResult && (
          <Paper
            elevation={4}
            sx={{
              position: "absolute",
              top: 16,
              left: 16,
              right: 16,
              zIndex: 15,
              p: 2,
              borderRadius: 2.5,
              bgcolor: (t) => alpha(t.palette.background.paper, 0.94),
              backdropFilter: "blur(12px)",
              border: "1.5px solid",
              borderColor: activeQueryResult.mode === "path" ? "primary.main" : "secondary.main",
              boxShadow: (t) =>
                t.palette.mode === "dark"
                  ? "0 10px 25px -5px rgba(0,0,0,0.6)"
                  : "0 10px 25px -5px rgba(0,0,0,0.12)",
            }}
          >
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              sx={{ justifyContent: "space-between", alignItems: { md: "center" } }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", mb: 0.75, flexWrap: "wrap", gap: 0.75 }}>
                  <Chip
                    size="small"
                    icon={
                      activeQueryResult.mode === "path" ? (
                        <Route size={14} color={PATH_HUE} />
                      ) : (
                        <Sparkles size={14} color={RELATED_HUE} />
                      )
                    }
                    label={
                      activeQueryResult.mode === "path"
                        ? `Pathfinding (${activeQueryResult.path?.hops || 0} Hops)`
                        : `Subgraph (${activeQueryResult.stats.nodes_count} Nodes, ${activeQueryResult.stats.edges_count} Relations)`
                    }
                    sx={{
                      fontWeight: 750,
                      fontSize: 11.5,
                      bgcolor: alpha(
                        activeQueryResult.mode === "path" ? PATH_HUE : RELATED_HUE,
                        0.15
                      ),
                      color: activeQueryResult.mode === "path" ? "primary.main" : "secondary.main",
                      border: 1,
                      borderColor: alpha(
                        activeQueryResult.mode === "path" ? PATH_HUE : RELATED_HUE,
                        0.3
                      ),
                    }}
                  />
                  <Typography variant="body2" sx={{ fontWeight: 700, fontSize: 13.5 }}>
                    {activeQueryResult.summary}
                  </Typography>
                </Stack>

                {/* Path steps or Subgraph highlights */}
                {activeQueryResult.mode === "path" && activeQueryResult.path?.steps && (
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      overflowX: "auto",
                      py: 0.5,
                    }}
                  >
                    {activeQueryResult.path.steps.map((step, idx) => {
                      const fromNode = nodeMap.get(step.from_id);
                      const toNode = nodeMap.get(step.to_id);
                      return (
                        <Stack key={idx} direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
                          {idx === 0 && (
                            <Chip
                              size="small"
                              label={step.from}
                              onClick={() => fromNode && zoomToNode(fromNode)}
                              sx={{
                                fontWeight: 700,
                                fontSize: 11.5,
                                cursor: "pointer",
                                bgcolor: alpha(TYPE_CONFIG[step.from_type || ""]?.color || unknownHue(theme.palette.mode), 0.15),
                                color: TYPE_CONFIG[step.from_type || ""]?.color || "text.primary",
                                border: 1,
                                borderColor: alpha(TYPE_CONFIG[step.from_type || ""]?.color || unknownHue(theme.palette.mode), 0.4),
                              }}
                            />
                          )}
                          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", px: 0.5 }}>
                            <Typography variant="caption" sx={{ fontSize: 10.5, color: "text.secondary", fontStyle: "italic" }}>
                              {step.relation}
                            </Typography>
                            <ArrowRight size={13} color={theme.palette.text.secondary} />
                          </Stack>
                          <Chip
                            size="small"
                            label={step.to}
                            onClick={() => toNode && zoomToNode(toNode)}
                            sx={{
                              fontWeight: 700,
                              fontSize: 11.5,
                              cursor: "pointer",
                              bgcolor: alpha(TYPE_CONFIG[step.to_type || ""]?.color || unknownHue(theme.palette.mode), 0.15),
                              color: TYPE_CONFIG[step.to_type || ""]?.color || "text.primary",
                              border: 1,
                              borderColor: alpha(TYPE_CONFIG[step.to_type || ""]?.color || unknownHue(theme.palette.mode), 0.4),
                            }}
                          />
                        </Stack>
                      );
                    })}
                  </Box>
                )}

                {activeQueryResult.mode === "subgraph" && (
                  <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", mt: 0.5 }}>
                    {activeQueryResult.node_ids.slice(0, 8).map((nid) => {
                      const n = nodeMap.get(nid);
                      if (!n) return null;
                      const cfg = TYPE_CONFIG[n.type];
                      return (
                        <Chip
                          key={nid}
                          size="small"
                          label={n.label}
                          onClick={() => zoomToNode(n)}
                          sx={{
                            fontWeight: 600,
                            fontSize: 11,
                            height: 22,
                            cursor: "pointer",
                            bgcolor: alpha(cfg?.color || unknownHue(theme.palette.mode), 0.12),
                            color: cfg?.color || "text.primary",
                          }}
                        />
                      );
                    })}
                    {activeQueryResult.node_ids.length > 8 && (
                      <Typography variant="caption" sx={{ color: "text.secondary", alignSelf: "center", fontSize: 11 }}>
                        +{activeQueryResult.node_ids.length - 8} more
                      </Typography>
                    )}
                  </Box>
                )}
              </Box>

              {/* Action Buttons */}
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
                {activeQueryResult.answer && (
                  <Button
                    variant="contained"
                    color="secondary"
                    size="small"
                    startIcon={<BookOpen size={14} />}
                    onClick={() => setIsAnswerDrawerOpen(true)}
                    sx={{ textTransform: "none", fontWeight: 700, height: 32 }}
                  >
                    View Answer
                  </Button>
                )}
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<Compass size={14} />}
                  onClick={() => zoomToNodes(activeQueryResult.node_ids)}
                  sx={{ textTransform: "none", fontWeight: 600, height: 32 }}
                >
                  Fit Subgraph
                </Button>
                <IconButton size="small" onClick={handleClearQuery}>
                  <X size={16} />
                </IconButton>
              </Stack>
            </Stack>
          </Paper>
        )}

        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />

        {viewMode === "process" && graphData && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              bgcolor: "background.default",
              zIndex: 5,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ProcessFlowView graph={graphData} onFocusNode={focusGraphNode} />
          </Box>
        )}

        {/* Cypher, against the graph's Neo4j copy. Over the canvas, like the
            model view below, for the same reason. */}
        {viewMode === "cypher" && (
          <Box sx={{ position: "absolute", inset: 0, bgcolor: "background.default", zIndex: 5,
                     display: "flex", flexDirection: "column" }}>
            <CypherView onFocusNode={focusGraphNode} />
          </Box>
        )}

        {/* Graph quality: the graph's own checks and the question check. */}
        {viewMode === "quality" && (
          <Box sx={{ position: "absolute", inset: 0, bgcolor: "background.default", zIndex: 5,
                     display: "flex", flexDirection: "column" }}>
            <GraphQualityView />
          </Box>
        )}

        {/* The model view sits over the canvas rather than replacing it: the d3
            simulation owns the canvas element and unmounting it mid-run leaves
            the ref dangling, so it keeps its size and is simply covered. */}
        {viewMode === "model" && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              bgcolor: "background.default",
              zIndex: 5,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {modelError ? (
              <Alert severity="error" sx={{ m: 2 }}>
                Could not load the model: {modelError}
              </Alert>
            ) : !model ? (
              <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center" }} spacing={1}>
                <CircularProgress size={22} />
                <Typography variant="caption" color="text.secondary">
                  Loading the target model…
                </Typography>
              </Stack>
            ) : (
              <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <ModelView
                    model={model}
                    graph={graphData}
                    expanded={expandedLabel}
                    onExpandedChange={setExpandedLabel}
                    onSelect={setSelectedModelNode}
                    onFocusNode={focusGraphNode}
                  />
                </Box>

                <Paper
                  elevation={0}
                  square
                  sx={{
                    width: 300,
                    flexShrink: 0,
                    borderLeft: 1,
                    borderColor: "divider",
                    p: 2,
                    overflowY: "auto",
                  }}
                >
                  {selectedModelNode ? (
                    <Stack spacing={1.5}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                          :{selectedModelNode.token}
                        </Typography>
                        <Chip
                          size="small"
                          label={`${selectedModelNode.count} nodes`}
                          sx={{
                            height: 20,
                            fontSize: 11,
                            fontWeight: 700,
                            bgcolor: (t) => alpha(t.palette.primary.main, 0.16),
                          }}
                        />
                      </Stack>

                      {selectedModelNode.constraints.length > 0 && (
                        <Stack spacing={0.25}>
                          {selectedModelNode.constraints.map((c) => (
                            <Typography
                              key={`${c.type}-${c.property}`}
                              variant="caption"
                              color="text.secondary"
                            >
                              <strong>{c.type === "key" ? "key" : "must exist"}</strong>{" "}
                              <code>{c.property}</code>
                            </Typography>
                          ))}
                        </Stack>
                      )}

                      <Divider />
                      <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
                        Properties
                      </Typography>
                      <Stack spacing={0.5}>
                        {selectedModelNode.properties.map((prop) => (
                          <Stack key={prop.name} direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                            <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600 }}>
                              {prop.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {prop.type}
                              {prop.nullable ? "" : " · required"}
                            </Typography>
                          </Stack>
                        ))}
                      </Stack>

                      {selectedModelNode.built_as && (
                        <>
                          <Divider />
                          <Typography variant="caption" color="text.secondary">
                            Built from node type{" "}
                            <code>{selectedModelNode.built_as}</code>
                          </Typography>
                        </>
                      )}

                      {selectedModelNode.count > 0 && (
                        <>
                          <Divider />
                          <Chip
                            size="small"
                            clickable
                            color={expandedLabel === selectedModelNode.token ? "primary" : "default"}
                            label={
                              expandedLabel === selectedModelNode.token
                                ? "Showing instances on the canvas"
                                : `Show the ${selectedModelNode.count} nodes on the canvas`
                            }
                            onClick={() =>
                              setExpandedLabel(
                                expandedLabel === selectedModelNode.token
                                  ? null
                                  : selectedModelNode.token
                              )
                            }
                            sx={{ height: 24, fontSize: 11, fontWeight: 700, alignSelf: "flex-start" }}
                          />
                        </>
                      )}

                      {selectedModelNode.instances.length > 0 && (
                        <>
                          <Divider />
                          <Stack
                            direction="row"
                            spacing={1}
                            sx={{ alignItems: "baseline", justifyContent: "space-between" }}
                          >
                            <Typography
                              variant="overline"
                              sx={{ color: "text.secondary", fontWeight: 700 }}
                            >
                              In the graph
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {selectedModelNode.instances.length} of {selectedModelNode.count}
                            </Typography>
                          </Stack>
                          <Stack spacing={0.25}>
                            {selectedModelNode.instances.map((inst) => (
                              <Box
                                key={inst.id}
                                onClick={() => focusGraphNode(inst.id)}
                                sx={{
                                  px: 1,
                                  py: 0.6,
                                  borderRadius: 1,
                                  cursor: "pointer",
                                  "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, 0.1) },
                                }}
                              >
                                <Typography
                                  variant="body2"
                                  sx={{ fontFamily: "monospace", fontWeight: 700, lineHeight: 1.3 }}
                                >
                                  {inst.label}
                                </Typography>
                                {inst.detail && (
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    sx={{ display: "block", lineHeight: 1.3 }}
                                  >
                                    {inst.detail}
                                  </Typography>
                                )}
                              </Box>
                            ))}
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            Click one to open it in the graph view.
                          </Typography>
                        </>
                      )}
                    </Stack>
                  ) : (
                    <Stack spacing={1.5}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                        The graph&apos;s own schema
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {model.stats.labels} node labels and {model.stats.relationship_types}{" "}
                        relationship types, generated from <code>knowledge_graph.json</code> as a
                        Neo4j Data Importer model. Properties, their nullability and the
                        constraints are all read off the nodes that carry them.
                      </Typography>
                      <Divider />
                      <Typography variant="caption" color="text.secondary">
                        {model.stats.nodes} nodes · {model.stats.edges} relationships ·{" "}
                        {model.stats.constraints} constraints
                      </Typography>
                      <Divider />
                      <Typography variant="caption" color="text.secondary">
                        Click a label for its properties and key constraint. Double-click one
                        marked <strong>+</strong> — or use the button in its panel — to draw its
                        real nodes on the canvas; <code>:Process</code> opens as the BPML
                        hierarchy. The file is <code>docs/kg-data-importer-model.json</code>,
                        openable at import.neo4j.io.
                      </Typography>
                    </Stack>
                  )}
                </Paper>
              </Box>
            )}
          </Box>
        )}

        {/* Floating Zoom & Decipher Navigation Dock. Hidden in model mode: it
            drives the d3 canvas, and at zIndex 14 it covered the model view's
            own zoom controls in the same corner. */}
        <Paper
          elevation={4}
          sx={{
            position: "absolute",
            top: activeQueryResult ? 115 : 20,
            right: 20,
            zIndex: 14,
            display: viewMode === "graph" ? "flex" : "none",
            alignItems: "center",
            gap: 0.5,
            p: 0.6,
            borderRadius: 999,
            bgcolor: (t) => alpha(t.palette.background.paper, 0.88),
            backdropFilter: "blur(20px)",
            border: 1,
            borderColor: "divider",
            boxShadow: (t) =>
              t.palette.mode === "dark"
                ? "0 14px 34px -4px rgba(0,0,0,0.65)"
                : "0 10px 25px -4px rgba(0,0,0,0.12)",
          }}
        >
          {/* Zoom Level Indicator */}
          <Chip
            size="small"
            label={`${Math.round(currentZoomLevel * 100)}%`}
            sx={{
              fontWeight: 750,
              fontSize: 11,
              height: 26,
              mr: 0.5,
              bgcolor: (t) => surface(t, 0.7),
              color: "text.primary",
              fontFamily: "monospace",
              borderRadius: 999,
            }}
          />

          <Tooltip title="Zoom In (+)">
            <IconButton size="small" onClick={handleZoomIn} sx={{ width: 28, height: 28, borderRadius: 999 }}>
              <ZoomIn size={15} />
            </IconButton>
          </Tooltip>

          <Tooltip title="Zoom Out (-)">
            <IconButton size="small" onClick={handleZoomOut} sx={{ width: 28, height: 28, borderRadius: 999 }}>
              <ZoomOut size={15} />
            </IconButton>
          </Tooltip>

          <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 16, alignSelf: "center" }} />

          <Tooltip title="Fit Entire Graph to Screen">
            <IconButton size="small" onClick={handleZoomToFit} sx={{ width: 28, height: 28, borderRadius: 999 }}>
              <Compass size={15} />
            </IconButton>
          </Tooltip>

          <Tooltip title={isFullscreen ? "Exit Full Screen Window (Esc)" : "Full Screen Window View"}>
            <IconButton
              size="small"
              onClick={toggleFullscreen}
              sx={{
                width: 28,
                height: 28,
                borderRadius: 999,
                color: isFullscreen ? "primary.main" : "inherit",
              }}
            >
              {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
          </Tooltip>

          <Tooltip title={selectedNode ? `Focus 1-Hop Neighborhood of "${selectedNode.label}"` : "Select a node to focus neighborhood"}>
            <span>
              <IconButton
                size="small"
                onClick={handleFocusSelected}
                disabled={!selectedNode}
                sx={{ width: 28, height: 28, borderRadius: 999, color: selectedNode ? "primary.main" : "inherit" }}
              >
                <Crosshair size={15} />
              </IconButton>
            </span>
          </Tooltip>

          <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 16, alignSelf: "center" }} />

          <Tooltip title={isFocusNeighborhoodMode ? "Show Full Graph (Exit Isolation)" : "Isolate 1-Hop Neighborhood (Hide unrelated nodes)"}>
            <span>
              <Button
                variant={isFocusNeighborhoodMode ? "contained" : "outlined"}
                color={isFocusNeighborhoodMode ? "primary" : "inherit"}
                size="small"
                disabled={!selectedNode}
                onClick={() => setIsFocusNeighborhoodMode((prev) => !prev)}
                startIcon={isFocusNeighborhoodMode ? <EyeOff size={13} /> : <Eye size={13} />}
                sx={{
                  textTransform: "none",
                  fontWeight: 700,
                  fontSize: 11.5,
                  height: 26,
                  px: 1.25,
                  borderRadius: 999,
                  boxShadow: isFocusNeighborhoodMode ? (t) => `0 2px 8px ${alpha(t.palette.primary.main, 0.4)}` : "none",
                }}
              >
                {isFocusNeighborhoodMode ? "Isolated (1-Hop)" : "Isolate"}
              </Button>
            </span>
          </Tooltip>
        </Paper>

        {/* Floating Quick Legend / Controls */}
        <Paper
          elevation={2}
          sx={{
            position: "absolute",
            bottom: 20,
            left: 20,
            p: isLegendMinimized ? 1 : 1.75,
            borderRadius: 3,
            bgcolor: (t) => alpha(t.palette.background.paper, 0.9),
            backdropFilter: "blur(16px)",
            border: 1,
            borderColor: "divider",
            boxShadow: (t) =>
              t.palette.mode === "dark"
                ? "0 10px 28px -4px rgba(0,0,0,0.6)"
                : "0 8px 20px -4px rgba(0,0,0,0.1)",
            maxWidth: isLegendMinimized ? "auto" : 270,
            display: viewMode === "graph" ? { xs: "none", sm: "block" } : "none",
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            zIndex: 10,
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
              justifyContent: "space-between",
              cursor: "pointer",
              userSelect: "none",
            }}
            onClick={() => setIsLegendMinimized((prev) => !prev)}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
              <Info size={14} color={theme.palette.text.secondary} />
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 750,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "text.secondary",
                  fontSize: 10.5,
                  whiteSpace: "nowrap",
                }}
              >
                Legend & Hints
              </Typography>
            </Stack>
            <Tooltip title={isLegendMinimized ? "Expand Legend & Hints" : "Minimize Legend & Hints"}>
              <IconButton size="small" sx={{ p: 0.25, ml: 0.5, borderRadius: 1.5 }}>
                {isLegendMinimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </IconButton>
            </Tooltip>
          </Stack>

          {!isLegendMinimized && (
            <Box sx={{ mt: 1.25 }}>
              <Stack spacing={0.85}>
                {Object.entries(TYPE_CONFIG).map(([typeKey, cfg]) => (
                  <Stack key={typeKey} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Box
                      sx={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        bgcolor: cfg.color,
                        boxShadow: `0 0 6px ${cfg.color}88`,
                      }}
                    />
                    <Typography variant="caption" sx={{ fontSize: 11.5, fontWeight: 550 }}>
                      {cfg.label}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
              <Divider sx={{ my: 1.25 }} />
              <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 10.5, display: "block", lineHeight: 1.55 }}>
                • <b>Hover any node</b> to highlight connected links & arrows.
                <br />• <b>Click any node</b> to inspect relationships & specifications.
                <br />• <b>"Isolate" button</b> hides unrelated nodes for crystal clarity.
                <br />• <b>Zoom controls</b> or mouse wheel for deep inspection.
              </Typography>
            </Box>
          )}
        </Paper>
      </Box>
    </Box>

      {/* Side Inspector Drawer */}
      <Drawer
        container={pageContainerRef.current}
        anchor="right"
        open={isDrawerOpen && Boolean(selectedNode)}
        onClose={() => setIsDrawerOpen(false)}
        slotProps={{
          paper: {
            sx: {
              width: { xs: "100%", sm: 390 },
              p: 3,
              bgcolor: (t) => alpha(t.palette.background.paper, 0.96),
              backdropFilter: "blur(20px)",
              boxShadow: 12,
              borderLeft: 1,
              borderColor: "divider",
              zIndex: (t) => (isFullscreen ? 1500 : t.zIndex.drawer),
            },
          },
        }}
        sx={{
          zIndex: (t) => (isFullscreen ? 1500 : t.zIndex.drawer),
        }}
      >
        {selectedNode && (
          <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
            {/* Drawer Header */}
            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "flex-start", mb: 2 }}>
              <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    borderRadius: 2,
                    bgcolor: alpha(nodeColor(selectedNode, theme.palette.mode), 0.15),
                    color: nodeColor(selectedNode, theme.palette.mode),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: 1,
                    borderColor: alpha(nodeColor(selectedNode, theme.palette.mode), 0.3),
                    boxShadow: `0 0 16px ${alpha(nodeColor(selectedNode, theme.palette.mode), 0.25)}`,
                  }}
                >
                  <Network size={20} />
                </Box>
                <Box>
                  <Chip
                    size="small"
                    label={TYPE_CONFIG[selectedNode.type]?.label || selectedNode.type}
                    sx={{
                      fontSize: 10.5,
                      fontWeight: 750,
                      height: 22,
                      bgcolor: alpha(nodeColor(selectedNode, theme.palette.mode), 0.15),
                      color: nodeColor(selectedNode, theme.palette.mode),
                      borderRadius: 1.5,
                    }}
                  />
                  <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mt: 0.25, fontWeight: 500 }}>
                    {selectedNode.degree ?? 0} direct relationships
                  </Typography>
                </Box>
              </Stack>
              <IconButton size="small" onClick={() => setIsDrawerOpen(false)} sx={{ borderRadius: 1.5, border: 1, borderColor: "divider" }}>
                <X size={15} />
              </IconButton>
            </Stack>

            {/* Entity Title */}
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 1, wordBreak: "break-word", lineHeight: 1.3, letterSpacing: "-0.01em" }}>
              {selectedNode.label}
            </Typography>

            {selectedNode.description && (
              <Typography variant="body2" sx={{ color: "text.secondary", mb: 2, fontSize: 13, lineHeight: 1.5 }}>
                {selectedNode.description}
              </Typography>
            )}

            {selectedNode.filename && (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  bgcolor: (t) => surface(t, 0.6),
                  border: 1,
                  borderColor: "divider",
                  mb: 2,
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
                  <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 650 }}>
                    Source Document
                  </Typography>
                  {selectedNode.category && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={selectedNode.category}
                      sx={{ height: 18, fontSize: 10, fontWeight: 700, borderRadius: 1 }}
                    />
                  )}
                </Stack>
                <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: 11.5, wordBreak: "break-all", fontWeight: 600 }}>
                  {selectedNode.filename}
                </Typography>
              </Box>
            )}

            {/* Quick Actions */}
            <Stack direction="row" spacing={1} sx={{ mb: 2.5 }}>
              {selectedNode.filename && onNavigate && (
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<FileText size={14} />}
                  onClick={() => onNavigate("viewer", selectedNode.filename)}
                  sx={{ textTransform: "none", fontWeight: 650, flex: 1, borderRadius: 2, borderColor: "divider" }}
                >
                  View Doc
                </Button>
              )}
              <Button
                variant="contained"
                size="small"
                startIcon={<Sparkles size={14} />}
                onClick={() => handleRunQuery(`Tell me about ${selectedNode.label} and its connected specifications and systems`)}
                sx={{
                  textTransform: "none",
                  fontWeight: 700,
                  flex: 1,
                  borderRadius: 2,
                  boxShadow: (t) => `0 2px 10px ${alpha(t.palette.primary.main, 0.35)}`,
                }}
              >
                Query Graph
              </Button>
            </Stack>

            <Divider sx={{ mb: 2 }} />

            {/* Connected Entities Sections */}
            <Box sx={{ flex: 1, overflowY: "auto", pr: 0.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 750, mb: 1.5, textTransform: "uppercase", fontSize: 11, letterSpacing: "0.05em", color: "text.secondary" }}>
                Connected Entities ({neighborIds.size - 1})
              </Typography>

              {/* Streams */}
              {connectedDetails.streams.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary", display: "block", mb: 0.75 }}>
                    Business Streams
                  </Typography>
                  <Stack spacing={0.75}>
                    {connectedDetails.streams.map((item) => (
                      <Chip
                        key={item.id}
                        size="small"
                        label={item.label}
                        clickable
                        onClick={() => zoomToNode(item)}
                        sx={{
                          justifyContent: "flex-start",
                          fontWeight: 650,
                          fontSize: 12,
                          borderRadius: 1.75,
                          border: 1,
                          borderColor: alpha(nodeColor(item, theme.palette.mode), 0.3),
                          bgcolor: alpha(nodeColor(item, theme.palette.mode), 0.08),
                          "&:hover": { bgcolor: alpha(nodeColor(item, theme.palette.mode), 0.16) },
                        }}
                      />
                    ))}
                  </Stack>
                </Box>
              )}

              {/* Core Systems */}
              {connectedDetails.systems.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary", display: "block", mb: 0.75 }}>
                    Core Systems
                  </Typography>
                  <Stack spacing={0.75}>
                    {connectedDetails.systems.map((item) => (
                      <Chip
                        key={item.id}
                        size="small"
                        label={item.label}
                        clickable
                        onClick={() => zoomToNode(item)}
                        sx={{
                          justifyContent: "flex-start",
                          fontWeight: 650,
                          fontSize: 12,
                          borderRadius: 1.75,
                          bgcolor: alpha(nodeColor(item, theme.palette.mode), 0.1),
                          color: nodeColor(item, theme.palette.mode),
                          border: 1,
                          borderColor: alpha(nodeColor(item, theme.palette.mode), 0.25),
                          "&:hover": { bgcolor: alpha(nodeColor(item, theme.palette.mode), 0.2) },
                        }}
                      />
                    ))}
                  </Stack>
                </Box>
              )}

              {/* Processes */}
              {connectedDetails.processes.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary", display: "block", mb: 0.75 }}>
                    BPML Processes ({connectedDetails.processes.length})
                  </Typography>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
                    {connectedDetails.processes.map((item) => (
                      <Chip
                        key={item.id}
                        size="small"
                        label={item.label}
                        clickable
                        onClick={() => zoomToNode(item)}
                        sx={{ fontWeight: 650, fontSize: 11, fontFamily: "monospace", borderRadius: 1.5 }}
                      />
                    ))}
                  </Box>
                </Box>
              )}

              {/* Specs */}
              {connectedDetails.specs.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary", display: "block", mb: 0.75 }}>
                    SPARK Specifications ({connectedDetails.specs.length})
                  </Typography>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
                    {connectedDetails.specs.map((item) => (
                      <Chip
                        key={item.id}
                        size="small"
                        label={item.label}
                        clickable
                        onClick={() => zoomToNode(item)}
                        sx={{
                          fontWeight: 750,
                          fontSize: 11,
                          fontFamily: "monospace",
                          color: MATCH_HUE,
                          bgcolor: alpha(MATCH_HUE, 0.1),
                          border: 1,
                          borderColor: alpha(MATCH_HUE, 0.25),
                          borderRadius: 1.5,
                        }}
                      />
                    ))}
                  </Box>
                </Box>
              )}

              {/* Related Documents */}
              {connectedDetails.docs.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary", display: "block", mb: 0.75 }}>
                    Related Documents ({connectedDetails.docs.length})
                  </Typography>
                  <Stack spacing={0.75}>
                    {connectedDetails.docs.slice(0, 15).map((item) => (
                      <Paper
                        key={item.id}
                        onClick={() => zoomToNode(item)}
                        sx={{
                          p: 1.25,
                          cursor: "pointer",
                          borderRadius: 2,
                          border: 1,
                          borderColor: "divider",
                          "&:hover": { bgcolor: "action.hover", borderColor: "primary.main" },
                          transition: "all 0.15s ease",
                        }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 650, fontSize: 12 }}>
                          {item.label}
                        </Typography>
                        <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 10.5 }}>
                          {item.format} • {item.degree ?? 0} relations
                        </Typography>
                      </Paper>
                    ))}
                  </Stack>
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Drawer>

      {/* Knowledge Graph AI Answer Drawer */}
      <Drawer
        container={pageContainerRef.current}
        anchor="left"
        open={isAnswerDrawerOpen && Boolean(activeQueryResult?.answer)}
        onClose={() => setIsAnswerDrawerOpen(false)}
        slotProps={{
          paper: {
            sx: {
              width: { xs: "100%", sm: 540, md: 580 },
              p: 3,
              bgcolor: (t) => alpha(t.palette.background.paper, 0.96),
              backdropFilter: "blur(20px)",
              boxShadow: 12,
              display: "flex",
              flexDirection: "column",
              zIndex: (t) => (isFullscreen ? 1500 : t.zIndex.drawer),
            },
          },
        }}
        sx={{
          zIndex: (t) => (isFullscreen ? 1500 : t.zIndex.drawer),
        }}
      >
        {activeQueryResult?.answer && (
          <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
            {/* Drawer Header */}
            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "flex-start", mb: 2 }}>
              <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                <Box
                  sx={{
                    width: 38,
                    height: 38,
                    borderRadius: 2,
                    bgcolor: (t) => alpha(t.palette.primary.main, 0.14),
                    color: "primary.main",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: 1,
                    borderColor: (t) => alpha(t.palette.primary.main, 0.3),
                    boxShadow: (t) => `0 0 16px ${alpha(t.palette.primary.main, 0.25)}`,
                  }}
                >
                  <Sparkles size={20} />
                </Box>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
                    Knowledge Graph Answer
                  </Typography>
                  <Chip
                    size="small"
                    label="Grounded in Knowledge Graph"
                    color="primary"
                    variant="outlined"
                    sx={{ height: 20, fontSize: 10, fontWeight: 750, mt: 0.35, borderRadius: 1.5 }}
                  />
                </Box>
              </Stack>

              <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                <Tooltip title={copiedAnswer ? "Copied!" : "Copy Answer"}>
                  <IconButton size="small" onClick={handleCopyAnswer} sx={{ border: 1, borderColor: "divider", borderRadius: 1.5 }}>
                    {copiedAnswer ? <Check size={14} color={theme.palette.success.main} /> : <Copy size={14} />}
                  </IconButton>
                </Tooltip>
                <IconButton size="small" onClick={() => setIsAnswerDrawerOpen(false)} sx={{ borderRadius: 1.5, border: 1, borderColor: "divider" }}>
                  <X size={15} />
                </IconButton>
              </Stack>
            </Stack>

            <Divider sx={{ mb: 2 }} />

            {/* Answer Content rendered via Markdown */}
            <Box sx={{ flex: 1, overflowY: "auto", pr: 0.5 }}>
              <Markdown source={activeQueryResult.answer} sx={{ fontSize: 13.5 }} />
            </Box>

            <Divider sx={{ my: 2 }} />

            {/* Bottom Controls */}
            <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<Compass size={14} />}
                onClick={() => {
                  zoomToNodes(activeQueryResult.node_ids);
                }}
                sx={{ textTransform: "none", fontWeight: 650, borderRadius: 2, borderColor: "divider" }}
              >
                Highlight on Canvas ({activeQueryResult.node_ids.length} Nodes)
              </Button>
              <Button
                variant="text"
                size="small"
                onClick={() => setIsAnswerDrawerOpen(false)}
                sx={{ textTransform: "none", fontWeight: 650, borderRadius: 2 }}
              >
                Close Answer
              </Button>
            </Stack>
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
