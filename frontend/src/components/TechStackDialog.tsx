import {
  Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import {
  Activity, Cable, Check, Cloud, Code, Copy, Database, Download, Layers, LayoutTemplate, PackageX, Palette,
  Puzzle, Server, ShieldCheck, Workflow, X,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { MONO, RADIUS } from "./quality/parts";

/** What the application is built with, by layer.
 *
 *  Every entry was checked against the repository, not just a manifest: it is
 *  imported by backend/ or frontend/src, or configured in Dockerfile,
 *  compose.yml or scripts/. Versions are the ones the build actually installs
 *  -- constraints.txt for Python, package-lock.json for the UI, the image tag
 *  for a container -- and are left out where nothing pins one. When a
 *  dependency is added or dropped, change this list in the same commit. */

type Tone = "primary" | "secondary" | "info" | "success" | "warning" | "error";

interface Tech { name: string; version?: string; role: string }
interface Layer { title: string; icon: ReactElement; tone: Tone; items: Tech[] }

const LAYERS: Layer[] = [
  {
    title: "Frontend", icon: <LayoutTemplate size={16} />, tone: "primary", items: [
      { name: "React", version: "19.3.0", role: "Renders every page of the single-page application and Demo Mode." },
      { name: "TypeScript", version: "5.9.3", role: "Types the whole UI and is checked before every build." },
      { name: "Vite", version: "8.3.0", role: "Bundles the UI into static/dist and serves it with hot reload in development." },
      { name: "D3", version: "7.9.0", role: "Draws the interactive knowledge-graph view and the quality charts." },
      { name: "Mermaid", version: "10.9.1", role: "Renders process-flow diagrams from text inside answers and documents." },
      { name: "Marked", version: "12.0.2", role: "Turns the Markdown in answers and documents into HTML." },
      { name: "DOMPurify", version: "3.4.17", role: "Sanitises rendered Markdown and diagrams so no script can be injected." },
    ],
  },
  {
    title: "Styling & Animation", icon: <Palette size={16} />, tone: "secondary", items: [
      { name: "Material UI", version: "9.4.0", role: "Supplies the component library and the light and dark themes." },
      { name: "Emotion", version: "11.14", role: "The CSS-in-JS engine Material UI styles every component with." },
      { name: "Framer Motion", version: "13.4.0", role: "Animates page transitions, the theme toggle and Demo Mode." },
      { name: "Lucide", version: "1.46.0", role: "Provides the icon set used across the interface." },
      { name: "react-resizable-panels", version: "4.12.4", role: "Lets side-by-side panes, such as a document beside its preview, be resized." },
      { name: "Catppuccin Frappé", role: "The palette every dark-mode colour is drawn from." },
    ],
  },
  {
    title: "Backend", icon: <Server size={16} />, tone: "info", items: [
      { name: "Python", version: "3.12", role: "The runtime for the API, the agents and the ingestion pipeline." },
      { name: "FastAPI", version: "0.141.1", role: "Defines the HTTP API and serves the built UI." },
      { name: "Uvicorn", version: "0.54.0", role: "The ASGI server the container runs the application with." },
      { name: "Pydantic", version: "2.13.5", role: "Validates request bodies and the structured output agents submit." },
      { name: "Docling", version: "2.130.0", role: "Converts PDF, Word, Excel, PowerPoint and HTML files into Markdown for indexing." },
      { name: "Tesseract (tesserocr)", role: "Reads text from scanned pages, slide images and flow diagrams." },
      { name: "OpenCV", version: "5.0.0.93", role: "Finds tables and flow-chart shapes in page images before OCR." },
      { name: "WeasyPrint", role: "Exports Fit-to-Standard workshop packs as PDF." },
      { name: "python-docx & openpyxl", version: "openpyxl 3.1.5", role: "Read and write Word and Excel files, including the BPML hierarchy." },
    ],
  },
  {
    title: "API & Communication", icon: <Cable size={16} />, tone: "primary", items: [
      { name: "REST / JSON", role: "Every page talks to the backend through JSON endpoints under /api." },
      { name: "Server-Sent Events", role: "Streams answers and agent progress to the browser as they are produced." },
      { name: "Bolt / Cypher", role: "The protocol and query language the app uses to read and write Neo4j." },
      { name: "python-multipart", version: "0.0.32", role: "Accepts the document uploads the agents and knowledge base take." },
    ],
  },
  {
    title: "Database & Storage", icon: <Database size={16} />, tone: "success", items: [
      { name: "PostgreSQL", version: "18", role: "Stores accounts, run history, evaluations and the search index." },
      { name: "pgvector", role: "Adds vector similarity search to Postgres for semantic retrieval." },
      { name: "Postgres full-text search", role: "Keyword search that is combined with vectors for hybrid retrieval." },
      { name: "Neo4j", version: "5 Community", role: "Holds the knowledge graph so it can be queried with Cypher." },
      { name: "Docker volumes", role: "Persist the databases, uploads, the embedding model and the graph file." },
    ],
  },
  {
    title: "ORM & Data Access", icon: <Layers size={16} />, tone: "success", items: [
      { name: "psycopg", version: "3.3.6", role: "Runs plain SQL against Postgres; the app uses no ORM." },
      { name: "pgvector (Python)", version: "0.5.0", role: "Passes embeddings between Python and Postgres vector columns." },
      { name: "Neo4j Python driver", version: "6.3.1", role: "Connects to Neo4j to load the graph and run read-only Cypher." },
    ],
  },
  {
    title: "Authentication & Security", icon: <ShieldCheck size={16} />, tone: "warning", items: [
      { name: "scrypt password hashing", role: "Stores each password as a salted scrypt hash, checked in constant time." },
      { name: "HMAC-SHA256 session cookie", role: "Signs the session cookie so a forged or expired one is refused." },
      { name: "Role-based access", role: "Separates Admins from Users and limits each user to their own runs." },
      { name: "Agent guardrails", role: "A scope check, gated web search and contact-detail redaction on every agent." },
    ],
  },
  {
    title: "State Management", icon: <Workflow size={16} />, tone: "secondary", items: [
      { name: "React hooks", role: "Each page keeps its own state; there is no global store library." },
      { name: "useSyncExternalStore", role: "Shares the few app-wide settings, such as the history scope, across pages." },
      { name: "Fetch API client", role: "A small typed wrapper (api.ts) makes every request; no data-fetching library." },
    ],
  },
  {
    title: "Infrastructure & Deployment", icon: <Cloud size={16} />, tone: "info", items: [
      { name: "Docker", role: "A multi-stage Dockerfile builds the UI, downloads models and packages the app." },
      { name: "Docker Compose", role: "Runs the app, Postgres, Neo4j, Ollama and the memory server together." },
      { name: "Podman", role: "Builds the linux/amd64 image on the team's Macs." },
      { name: "GitLab Container Registry", role: "Hosts the published images at reg.ivolve.cloud." },
      { name: "AWS EC2", role: "The Ubuntu server the containerised stack runs on." },
      { name: "Caddy", role: "Terminates HTTPS in front of the app, as set up in the deployment guide." },
      { name: "docker-publish.sh", role: "Builds and pushes a release by hand; no CI/CD pipeline is configured." },
    ],
  },
  {
    title: "Monitoring & Observability", icon: <Activity size={16} />, tone: "error", items: [
      { name: "Langfuse", version: "4.15.6", role: "Traces every model call and records evaluation scores." },
      { name: "OpenTelemetry", role: "Instruments the Anthropic client and threads so traces reach Langfuse." },
      { name: "Ragas", version: "0.4.3", role: "Scores answers for faithfulness and relevance with LLM judges." },
      { name: "Activity log", role: "Records sign-ins and account changes for the Admin dashboard." },
      { name: "Docker health check", role: "Polls /api/health and marks the container unhealthy when it stops answering." },
    ],
  },
  {
    title: "External Integrations", icon: <Puzzle size={16} />, tone: "warning", items: [
      { name: "Anthropic Claude API", version: "SDK 1.8.0", role: "Powers Ask, the Evidence Agent, InsightLens and the Fit-Gap Copilot." },
      { name: "Claude web search", role: "Lets agents search an allow-list of sites such as sap.com, at most twice per run." },
      { name: "Ollama · bge-m3", role: "Runs the embedding model locally to index and search the corpus." },
      { name: "Hindsight", version: "client 0.10.1", role: "Gives the agents a long-term memory shared across runs." },
    ],
  },
  {
    title: "Installed, not used directly", icon: <PackageX size={16} />, tone: "secondary", items: [
      { name: "cohere", role: "Listed in requirements.txt but never imported by the application." },
      { name: "langchain-community", role: "Installed only because Ragas needs it; the app does not import it." },
      { name: "mlx-vlm", role: "An optional Mac-only OCR model; it is not in the image and is skipped when absent." },
    ],
  },
];

const TITLE = "Project Tech Stack";
const INTRO = "This application is built using the following technologies and tools:";

/** The list as plain text, laid out the way the dialog shows it. */
function asText(): string {
  const sections = LAYERS.map((l) => [
    l.title.toUpperCase(),
    ...l.items.map((t) => `- ${t.name}${t.version ? ` (${t.version})` : ""}: ${t.role}`),
  ].join("\n"));
  return [TITLE, INTRO, ...sections].join("\n\n") + "\n";
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** One row per technology. The byte-order mark makes Excel read the file as
 *  UTF-8, so "Catppuccin Frappé" does not come out as "FrappÃ©". */
function downloadCsv(): void {
  const head = ["layer", "technology", "version", "description"];
  const lines = LAYERS.flatMap((l) => l.items.map((t) => [l.title, t.name, t.version, t.role].map(csvCell).join(",")));
  const url = URL.createObjectURL(new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = "tech-stack.csv"; a.click();
  URL.revokeObjectURL(url);
}

/** Two letters standing in for a logo: the first letters of the first two
 *  words, or the first two of a single word. */
function monogram(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

export function TechStackButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="Project tech stack">
        <IconButton onClick={() => setOpen(true)} aria-label="Project tech stack">
          <Code size={18} />
        </IconButton>
      </Tooltip>
      <TechStackDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default function TechStackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const count = LAYERS.reduce((n, l) => n + l.items.length, 0);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(asText());
      setCopy("done");
    } catch {
      // The clipboard API needs a secure context and permission; say so
      // rather than appear to have copied.
      setCopy("failed");
    }
    setTimeout(() => setCopy("idle"), 1800);
  };

  return (
    // Escape and a click on the backdrop both call onClose: MUI's Dialog
    // handles both, so neither needs wiring here.
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth scroll="paper"
            aria-labelledby="tech-stack-title"
            slotProps={{
              backdrop: { sx: { backdropFilter: "blur(4px)", bgcolor: alpha(theme.palette.common.black, 0.4) } },
              paper: { sx: { borderRadius: 2, boxShadow: theme.shadows[8], m: { xs: 1.5, sm: 4 },
                             maxHeight: { xs: "calc(100% - 24px)", sm: "calc(100% - 64px)" } } },
            }}>
      <DialogTitle id="tech-stack-title" sx={{ pr: 7, pb: 1 }}>
        <Stack direction="row" spacing={1.25} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}>
          <Box sx={{ display: "flex", color: "primary.main" }}><Code size={20} /></Box>
          <Typography component="span" sx={{ fontSize: 18, fontWeight: 600, mr: "auto" }}>{TITLE}</Typography>
          <Stack direction="row" spacing={1}>
            <Tooltip title={copy === "failed" ? "The browser blocked the clipboard" : "Copy every entry as text"}>
              <Button size="small" variant="outlined" onClick={() => void copyAll()}
                      color={copy === "failed" ? "error" : "primary"}
                      startIcon={copy === "done" ? <Check size={15} /> : <Copy size={15} />}
                      sx={{ textTransform: "none", whiteSpace: "nowrap" }}>
                {copy === "done" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy"}
              </Button>
            </Tooltip>
            <Tooltip title="Download every entry as tech-stack.csv">
              <Button size="small" variant="outlined" onClick={downloadCsv} startIcon={<Download size={15} />}
                      sx={{ textTransform: "none", whiteSpace: "nowrap" }}>
                Download CSV
              </Button>
            </Tooltip>
          </Stack>
        </Stack>
        <Typography sx={{ fontSize: 13, color: "text.secondary", mt: 0.5 }}>{INTRO}</Typography>
        <IconButton onClick={onClose} aria-label="Close" sx={{ position: "absolute", right: 12, top: 12 }}>
          <X size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
        <Stack spacing={2.5}>
          {LAYERS.map((layer) => {
            const ink = theme.palette[layer.tone].main;
            return (
              <Box key={layer.title} component="section" aria-label={layer.title}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
                  <Box sx={{ display: "flex", color: ink }}>{layer.icon}</Box>
                  <Typography sx={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase" }}>
                    {layer.title}
                  </Typography>
                  <Box sx={{ flex: 1, height: "1px", bgcolor: "divider" }} />
                </Stack>
                <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
                  {layer.items.map((t) => (
                    <Stack key={t.name} direction="row" spacing={1.25}
                           sx={{ p: 1.25, border: 1, borderColor: "divider", borderRadius: RADIUS,
                                 bgcolor: alpha(ink, 0.03) }}>
                      <Box aria-hidden sx={{ width: 32, height: 32, flexShrink: 0, borderRadius: 1.5,
                                             display: "grid", placeItems: "center", fontFamily: MONO,
                                             fontSize: 12, fontWeight: 700, color: ink,
                                             bgcolor: alpha(ink, 0.14) }}>
                        {monogram(t.name)}
                      </Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap" }}>
                          <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</Typography>
                          {t.version && (
                            <Typography sx={{ fontSize: 11, fontFamily: MONO, color: "text.secondary" }}>
                              {t.version}
                            </Typography>
                          )}
                        </Stack>
                        <Typography sx={{ fontSize: 12.5, color: "text.secondary", lineHeight: 1.45 }}>
                          {t.role}
                        </Typography>
                      </Box>
                    </Stack>
                  ))}
                </Box>
              </Box>
            );
          })}
          <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
            {count} entries, checked against the code, the dependency manifests and the deployment
            configuration. Versions are the ones the build installs.
          </Typography>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
