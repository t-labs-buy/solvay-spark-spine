import {
  Alert, Autocomplete, Box, Button, ButtonBase, Chip, CircularProgress, Collapse, Divider, IconButton,
  LinearProgress, Paper, Stack, Switch, Tab, Tabs,
  TextField, Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { AnimatePresence, motion } from "framer-motion";
import { Ban, BookOpen, Brain, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleHelp, Copy, Dices, FileText, FlaskConical, GitBranch, Globe, History as HistoryIcon, Lightbulb, Network, Quote, ScanLine, Search, SendHorizontal, Sigma, Square, Target, Terminal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import {
  api, askEvidence, evidence, followEvidence,
  type EvidenceToolSources,
  type AnswerState, type EvidenceAnswer, type EvidenceSource,
  type EvidenceHandlers, type EvidenceLogEntry, type EvidenceMemory,
  type EvidenceRunDetail, type EvidenceRunSummary, type EvidenceStatus,
  type EvidenceToolCall, type ScoreTerm,
  type EvidenceRagHit,
  type Source, type Stance, type Lineage, type AgentEvaluation,
} from "../api";
import { EVIDENCE_SAMPLES, type SampleQuestion } from "../data/evidenceSamples";
import { surface } from "../theme";
import { clearAdornment } from "../components/ClearAdornment";
import DocumentInspectorDrawer from "../components/DocumentInspectorDrawer";
import AgentTraceDrawer from "../components/AgentTraceDrawer";
import AgentLogDrawer from "../components/AgentLogDrawer";
import AgentEvaluationView from "../components/AgentEvaluationView";
import MemoryReflectDrawer from "../components/MemoryReflectDrawer";
import ScrollRunway from "../components/ScrollRunway";
import RunHistoryDrawer, { type HistoryCard } from "../components/RunHistoryDrawer";
import ClaimsView, { ScoreBar, strength } from "../components/evidence/ClaimsView";
import InvestigationView from "../components/InvestigationView";
import ObjectHeader, { BandButton } from "../components/rollout/ObjectHeader";
import { MONO, RADIUS, usePremium } from "../components/rollout/premium";
import { Section } from "../components/rollout/SummaryView";
import { ownerLabel } from "../auth";
import useHistoryScope from "../useHistoryScope";
import type { RunRequest } from "../runRequest";

/* ------------------------------------------------------------------- states */

// How many times a dropped stream is reopened before the page gives up and
// points at History. The investigation carries on on the server either way.
const RECONNECTS = 5;

const STATES: Record<AnswerState, { label: string; blurb: string; hue: string; icon: ReactElement }> = {
  supported: { label: "Supported", hue: "success", icon: <CircleCheck size={16} />,
    blurb: "The sources agree and carry the claims." },
  conflicted: { label: "Conflicted", hue: "warning", icon: <TriangleAlert size={16} />,
    blurb: "Sources disagree. Both sides are reported; neither is chosen." },
  documented_unknown: { label: "Documented unknown", hue: "info", icon: <CircleHelp size={16} />,
    blurb: "The corpus records this as undecided — somebody wrote down that it is open." },
  not_in_corpus: { label: "Not in the corpus", hue: "neutral", icon: <Ban size={16} />,
    blurb: "Nothing in the indexed corpus addresses this." },
  false_premise: { label: "False premise", hue: "error", icon: <CircleAlert size={16} />,
    blurb: "The corpus contradicts an assumption in the question." },
  unrepresentable: { label: "Unrepresentable", hue: "neutral", icon: <Ban size={16} />,
    blurb: "Answering needs something neither engine models." },
};

const STANCE: Record<Stance, { label: string; hue: "success" | "error" | "neutral" }> = {
  supports: { label: "supports", hue: "success" },
  opposes: { label: "opposes", hue: "error" },
  context: { label: "context", hue: "neutral" },
};

const PROVENANCE_HINT: Record<string, string> = {
  mostly_machine_read: "Most of this document was transcribed from pictures by a vision model or OCR, not typed by an author.",
  has_unreadable_images: "This document contains pictures no engine could read at all.",
  discussion: "An email or meeting note — it records discussion, not an implemented state.",
  template: "A blank template rather than a filled document.",
  sparse_table: "Most of this document's table cells are empty.",
  unfilled_boilerplate: "Unfilled template phrases remain in this document.",
};

const ENGINE_ICON: Record<string, ReactElement> = {
  rag: <Search size={12} />,
  graph: <Network size={12} />,
  bpml: <Target size={12} />,
  web: <Globe size={12} />,
  other: <GitBranch size={12} />,
};

/** The three places the agent can look, named in the log so a reader can tell
 *  a corpus search from a graph traversal without knowing the function names. */
const ENGINE_NAME: Record<string, string> = {
  rag: "RAG",
  graph: "GRAPH",
  bpml: "BPML",
  // Gated external search (guardrails/web.py). Amber, because what it found
  // is not the programme's own evidence.
  web: "WEB",
  other: "\u2014",
};

const ENGINE_COLOUR: Record<string, string> = {
  rag: "primary.main",
  graph: "info.main",
  bpml: "success.main",
  web: "warning.main",
  other: "text.disabled",
};

/** The tooltip behind a log line's source chip: what was read, and -- for
 *  retrieval -- what it was allowed to read, so a narrow result is
 *  distinguishable from a narrow scope. */
function sourcesHint(s: EvidenceToolSources): string {
  if (s.kind === "postgres") {
    const hits = Object.entries(s.databases ?? {}).map(([where, n]) => `${where}: ${n}`).join(", ");
    const scope = (s.searched ?? []).join(", ");
    return [
      hits ? `Chunks returned from ${hits}` : "No chunk matched",
      scope ? `Searched: ${scope}` : "",
    ].filter(Boolean).join(" · ");
  }
  if (s.kind === "graph") {
    const built = (s.built_from ?? []).join(", ");
    const touched = (s.categories ?? []).join(", ");
    return [
      "The knowledge graph is held in memory, not in a database",
      built ? `built from the ${built} Markdown` : "",
      touched ? `this result names ${touched} document node(s)` : "this result names no document nodes",
    ].filter(Boolean).join(" · ");
  }
  if (s.kind === "sheet") return "Read from the BPML spreadsheet (runs before the hierarchy moved into the corpus)";
  return s.label;
}

const ENGINE_HINT: Record<string, string> = {
  rag: "Hybrid retrieval over the Markdown corpus: meaning-based vector search and BM25 keyword search, fused. Returns passages, never a written answer.",
  graph: "The knowledge graph, held in memory: entity lookup and breadth-first traversal. No database, no embeddings, no model.",
  bpml: "The BPML process hierarchy, read from the spreadsheet.",
};

function useHue() {
  const theme = useTheme();
  return useCallback((hue: string) => {
    if (hue === "neutral") return theme.palette.text.secondary;
    const slot = (theme.palette as unknown as Record<string, { main?: string } | undefined>)[hue];
    return slot?.main ?? theme.palette.text.secondary;
  }, [theme]);
}

const plural = (n: number, one: string, many = "") => `${n} ${n === 1 ? one : many || one + "s"}`;

/* ------------------------------------------------------------------- pieces */

function StateBadge({ state }: { state: AnswerState }) {
  const s = STATES[state];
  const colour = useHue()(s.hue);
  return (
    <Tooltip title={s.blurb}>
      <Stack direction="row" spacing={0.85} sx={{
        alignItems: "center", px: 1.25, py: 0.6, borderRadius: 1.5,
        bgcolor: alpha(colour, 0.13), color: colour, border: `1px solid ${alpha(colour, 0.35)}`,
        fontWeight: 800, fontSize: 12, letterSpacing: ".03em", whiteSpace: "nowrap",
      }}>
        {s.icon}<span>{s.label.toUpperCase()}</span>
      </Stack>
    </Tooltip>
  );
}

/** The score with its arithmetic attached — the number is only trustworthy if
 *  the terms that produced it are one hover away. */
function ScoreChip({ score, terms }: { score: number; terms: ScoreTerm[] }) {
  const theme = useTheme();
  const colour = score >= 0.65 ? theme.palette.success.main
    : score >= 0.4 ? theme.palette.warning.main : theme.palette.error.main;
  return (
    <Tooltip
      title={
        <Box sx={{ py: 0.5 }}>
          {terms.map((t, i) => (
            <Box key={i} sx={{ fontSize: 11.5, mb: 0.4 }}>
              <b style={{ fontFamily: "ui-monospace, monospace" }}>
                {t.cap != null ? `cap ${t.cap.toFixed(2)}` : `${t.delta >= 0 ? "+" : ""}${t.delta.toFixed(2)}`}
              </b>{" "}
              {t.rule} — {t.detail}
            </Box>
          ))}
          {!terms.length && <Box sx={{ fontSize: 11.5 }}>no terms recorded</Box>}
        </Box>
      }
    >
      <Stack direction="row" spacing={0.6} sx={{
        alignItems: "center", px: 0.9, py: 0.3, borderRadius: 1,
        bgcolor: alpha(colour, 0.14), color: colour, cursor: "help",
      }}>
        <Sigma size={11} />
        <Box sx={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 12 }}>
          {score.toFixed(2)}
        </Box>
      </Stack>
    </Tooltip>
  );
}

function SourceRow({ s, onInspect, busy }: {
  s: EvidenceSource;
  onInspect: (s: EvidenceSource) => void;
  busy: boolean;
}) {
  const theme = useTheme();
  const hue = useHue();
  const colour = hue(STANCE[s.stance].hue);
  const [copied, setCopied] = useState(false);
  return (
    <Paper
      role="button"
      tabIndex={0}
      onClick={() => onInspect(s)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onInspect(s); }
      }}
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: RADIUS,
        cursor: "pointer",
        transition: "background-color .15s ease, border-color .15s ease",
        "&:hover, &:focus-visible": {
          bgcolor: (t) => alpha(t.palette.primary.main, 0.05),
          borderColor: (t) => alpha(t.palette.primary.main, 0.4),
        },
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mb: 0.5, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: 10, fontWeight: 800, letterSpacing: ".06em", color: colour,
                          textTransform: "uppercase" }}>
          {STANCE[s.stance].label}
        </Typography>
        {s.verified === false && (
          <Tooltip title="This quote was not found in the chunk it names, so it was discarded from the score">
            <Chip size="small" color="error" label="unverified" sx={{ height: 17, fontSize: 9.5 }} />
          </Tooltip>
        )}
        <Typography sx={{ fontSize: 11, color: "text.secondary", flex: 1, minWidth: 0 }} noWrap title={s.doc}>
          {s.doc}
        </Typography>
        <Tooltip title="Copy the quote">
          <IconButton size="small" sx={{ p: 0.25 }}
                      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(s.quote); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
            {copied ? <CircleCheck size={12} /> : <Copy size={12} />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Open the document this quote came from">
          <IconButton size="small" sx={{ p: 0.25 }} aria-label="Open the source document"
                      onClick={(e) => { e.stopPropagation(); onInspect(s); }}>
            {busy ? <CircularProgress size={12} /> : <BookOpen size={12} />}
          </IconButton>
        </Tooltip>
      </Stack>

      {s.heading_path && (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", mb: 0.5 }} noWrap>{s.heading_path}</Typography>
      )}
      <Typography sx={{ fontSize: 12.5, lineHeight: 1.55, fontStyle: "italic" }}>“{s.quote}”</Typography>

      <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.85, alignItems: "center" }}>
        <Chip size="small" variant="outlined" label={`chunk ${s.chunk_id}`} sx={{ height: 17, fontSize: 9.5 }} />
        {/* Why this passage was found at all: the retrieval side of scoring. */}
        {s.score != null && (
          <Tooltip title="Reciprocal rank fusion score — how the two searches agreed on this passage">
            <Chip size="small" variant="outlined" label={`rrf ${s.score.toFixed(4)}`}
                  sx={{ height: 17, fontSize: 9.5, fontFamily: "ui-monospace, monospace" }} />
          </Tooltip>
        )}
        {s.vector_rank != null && (
          <Tooltip title="Rank in the vector (meaning) search"><Chip size="small" variant="outlined"
            label={`vec #${s.vector_rank}`} sx={{ height: 17, fontSize: 9.5 }} /></Tooltip>
        )}
        {s.keyword_rank != null && (
          <Tooltip title="Rank in the BM25 keyword search"><Chip size="small" variant="outlined"
            label={`bm25 #${s.keyword_rank}`} sx={{ height: 17, fontSize: 9.5 }} /></Tooltip>
        )}
        {s.provenance.map((f) => (
          <Tooltip key={f} title={PROVENANCE_HINT[f] ?? f}>
            <Chip size="small" icon={<ScanLine size={10} />} label={f.replace(/_/g, " ")}
                  sx={{ height: 17, fontSize: 9.5,
                        bgcolor: alpha(theme.palette.warning.main, 0.14), color: "warning.main" }} />
          </Tooltip>
        ))}
      </Stack>
    </Paper>
  );
}

/** Answer — the Evidence Agent's summary tab, in the Fit-Gap Copilot's
 *  Summary idiom: the answer and the claims that govern it on the left; claim
 *  strength, the engines consulted and what is still open on the right. */
function AnswerSummary({ answer, onClaim, engines, showModel = true }: {
  answer: EvidenceAnswer;
  onClaim: (index: number) => void;
  engines: string;
  showModel?: boolean;
}) {
  const p = usePremium();
  const theme = useTheme();
  const claims = answer.claims;
  // The weakest claim that asserts something governs the answer, so those
  // lead: they are what a reviewer should read first.
  const lead = claims.map((c, i) => ({ c, i })).sort((a, b) => a.c.score - b.c.score).slice(0, 2);
  const bands = [
    { l: "Strong", sub: "0.65 and above", n: claims.filter((c) => strength(c.score) === "Strong").length, c: p.accent },
    { l: "Moderate", sub: "0.40 – 0.64", n: claims.filter((c) => strength(c.score) === "Moderate").length, c: theme.palette.warning.main },
    { l: "Weak", sub: "below 0.40", n: claims.filter((c) => strength(c.score) === "Weak").length, c: theme.palette.error.main },
  ];
  return (
    <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 2fr) minmax(0, 1fr)" } }}>
      <Stack spacing={3} sx={{ minWidth: 0 }}>
        <Section title="Answer" hint={<StateBadge state={answer.state} />}>
          <Typography sx={{ fontSize: 15, lineHeight: 1.65 }}>{answer.answer}</Typography>
          {lead.length > 0 && (
            <Box sx={{ display: "grid", gap: 1.5, mt: 2, gridTemplateColumns: { xs: "1fr", md: `repeat(${lead.length}, minmax(0, 1fr))` } }}>
              {lead.map(({ c, i }) => (
                <ButtonBase key={i} onClick={() => onClaim(i)}
                            sx={{ display: "block", textAlign: "left", border: 1, borderColor: "divider", borderRadius: RADIUS,
                                  p: 1.75, "&:hover": { borderColor: p.accent } }}>
                  <Typography sx={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.04em", color: p.accent }}>
                    {i === lead[0].i ? "WEAKEST CLAIM" : "NEXT WEAKEST"} · C{i + 1} · {c.score.toFixed(2)}
                  </Typography>
                  <Typography sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.6, lineHeight: 1.45 }}>{c.text}</Typography>
                  <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.6 }}>
                    {c.sources.length} quote{c.sources.length === 1 ? "" : "s"} · {c.independent_sources} independent document{c.independent_sources === 1 ? "" : "s"}
                  </Typography>
                </ButtonBase>
              ))}
            </Box>
          )}
        </Section>

        {claims.length > 0 && (
          <Section pad={false} title="Claim register" hint={`${claims.length} claims · open one for its evidence and arithmetic`}>
            {claims.map((c, i) => (
              <ButtonBase key={i} onClick={() => onClaim(i)}
                          sx={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) 120px", columnGap: 1.75, alignItems: "center",
                                width: "100%", textAlign: "left", px: 2.5, minHeight: 44, borderTop: 1, borderColor: "divider",
                                "&:hover": { bgcolor: "action.hover" } }}>
                <Typography sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: p.accent }}>C{i + 1}</Typography>
                <Typography sx={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.text}>{c.text}</Typography>
                <ScoreBar score={c.score} width={52} />
              </ButtonBase>
            ))}
          </Section>
        )}
      </Stack>

      <Stack spacing={3} sx={{ minWidth: 0 }}>
        <Section title="Claim strength" hint="open a claim for its arithmetic">
          <Stack spacing={1.25}>
            {bands.map((b) => (
              <Box key={b.l} sx={{ display: "grid", gridTemplateColumns: "92px minmax(0, 1fr) 24px", gap: 1.25, alignItems: "center" }}>
                <Box>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>{b.l}</Typography>
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{b.sub}</Typography>
                </Box>
                <Box sx={{ height: 10, bgcolor: "action.hover" }}>
                  <Box sx={{ height: 10, width: `${claims.length ? (b.n / claims.length) * 100 : 0}%`, bgcolor: b.c }} />
                </Box>
                <Typography sx={{ fontFamily: MONO, fontSize: 12.5, textAlign: "right" }}>{b.n}</Typography>
              </Box>
            ))}
          </Stack>
        </Section>
        <Section title="How it was answered">
          <Stack spacing={0.75}>
            {[
              ["Engines", engines || "—"],
              ["Tool calls", String(answer.tool_calls)],
              ...(showModel ? [["Model", answer.model]] : []),
              ["Time", `${answer.seconds}s · ${answer.input_tokens.toLocaleString()} in · ${answer.output_tokens.toLocaleString()} out`],
            ].map(([k, v]) => (
              <Box key={k} sx={{ display: "grid", gridTemplateColumns: "96px minmax(0, 1fr)", gap: 1.25 }}>
                <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>{k}</Typography>
                <Typography sx={{ fontSize: 12.5 }}>{v}</Typography>
              </Box>
            ))}
          </Stack>
        </Section>
        {answer.open_questions.length > 0 && (
          <Section title="Open questions" hint={String(answer.open_questions.length)}>
            <Stack spacing={1}>
              {answer.open_questions.map((q, i) => (
                <Typography key={i} sx={{ fontSize: 13, lineHeight: 1.5, pt: i ? 1 : 0, borderTop: i ? 1 : 0, borderColor: "divider" }}>{q}</Typography>
              ))}
            </Stack>
          </Section>
        )}
        {answer.limits.length > 0 && (
          <Section title="What stopped it going further">
            <Stack spacing={1}>
              {answer.limits.map((l, i) => (
                <Typography key={i} sx={{ fontSize: 13, lineHeight: 1.5, color: "text.secondary", pt: i ? 1 : 0, borderTop: i ? 1 : 0, borderColor: "divider" }}>{l}</Typography>
              ))}
            </Stack>
          </Section>
        )}
      </Stack>
    </Box>
  );
}

/** How many notes a recorded run started from. Runs from before memory existed
 *  carry `{}`, which is neither on nor off — just older than the feature. */
function memoryNotes(run: { memory?: EvidenceMemory | Record<string, never> }): number {
  const m = run.memory;
  return m && "recalled" in m && m.used ? m.recalled : 0;
}

/** One past investigation, read inside the history drawer.
 *
 *  Deliberately not the page's own rendering at half the width. What a reader
 *  wants here is enough to recognise the run and judge it -- the verdict, the
 *  answer, each claim with its score and which documents carried it. The parts
 *  that need room or another drawer of their own (a source quote in its
 *  document, the tool trace, the log) stay one button away, behind "Load into
 *  page", rather than being stacked drawer-on-drawer at 560px.
 */
function PastInvestigation({ run, showModel = true }: { run: EvidenceRunDetail; showModel?: boolean }) {
  const theme = useTheme();
  const hue = useHue();
  const answer = run.answer;
  const state = (answer?.state ?? run.state) as AnswerState | "";
  const notes = memoryNotes(run);

  return (
    <Stack spacing={1.75}>
      {state && (
        <Paper sx={{ p: 1.5, borderLeft: `3px solid ${hue(STATES[state].hue)}` }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Box sx={{ display: "flex", color: hue(STATES[state].hue) }}>{STATES[state].icon}</Box>
            <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{STATES[state].label}</Typography>
          </Stack>
          <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5, lineHeight: 1.55 }}>
            {STATES[state].blurb}
          </Typography>
        </Paper>
      )}

      <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap" }}>
        {run.holdout && (
          <Tooltip title="Run against the holdout corpus">
            <Chip size="small" variant="outlined" label="holdout" sx={{ height: 19, fontSize: 10 }} />
          </Tooltip>
        )}
        {notes > 0 && (
          <Tooltip title={`Started from ${plural(notes, "note")} recalled from earlier investigations`}>
            <Chip size="small" variant="outlined" icon={<Brain size={10} />} label={plural(notes, "note")}
                  sx={{ height: 19, fontSize: 10, "& .MuiChip-icon": { ml: 0.4 } }} />
          </Tooltip>
        )}
        {showModel && <Chip size="small" variant="outlined" label={run.model} sx={{ height: 19, fontSize: 10 }} />}
        <Chip size="small" variant="outlined" label={plural(run.calls?.length ?? 0, "call")}
              sx={{ height: 19, fontSize: 10 }} />
        {run.seconds ? (
          <Chip size="small" variant="outlined" label={`${run.seconds.toFixed(1)}s`}
                sx={{ height: 19, fontSize: 10 }} />
        ) : null}
        {run.input_tokens ? (
          <Tooltip title="Tokens in and out, as recorded">
            <Chip size="small" variant="outlined"
                  label={`${run.input_tokens.toLocaleString()} / ${run.output_tokens.toLocaleString()}`}
                  sx={{ height: 19, fontSize: 10 }} />
          </Tooltip>
        ) : null}
      </Stack>

      {run.error && <Alert severity="warning" sx={{ fontSize: 12.5 }}>{run.error}</Alert>}
      {run.status === "abandoned" && !run.error && (
        <Alert severity="warning" sx={{ fontSize: 12.5 }}>
          Interrupted — the browser went away before it finished. What it had done by then is below.
        </Alert>
      )}

      {answer?.answer && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>Answer</Typography>
          <Typography sx={{ fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap", mt: 0.25 }}>
            {answer.answer}
          </Typography>
        </Box>
      )}

      {!!answer?.claims.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>
            {plural(answer.claims.length, "claim")}
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {answer.claims.map((c, i) => (
              <Paper key={i} sx={{ p: 1.4 }}>
                <Stack direction="row" spacing={1.15} sx={{ alignItems: "flex-start" }}>
                  <ScoreChip score={c.score} terms={c.score_terms} />
                  <Typography sx={{ fontSize: 12.5, lineHeight: 1.55, flex: 1 }}>{c.text}</Typography>
                </Stack>
                {c.note && (
                  <Typography sx={{ fontSize: 11, color: "warning.main", mt: 0.6 }}>{c.note}</Typography>
                )}
                {/* The documents, not the quotes. A quote wants its document
                    beside it, and that is the inspector's job, not a drawer
                    inside a drawer. */}
                {!!c.sources.length && (
                  <Stack spacing={0.35} sx={{ mt: 0.85 }}>
                    {c.sources.map((src, j) => (
                      <Stack key={j} direction="row" spacing={0.6}
                             sx={{ alignItems: "baseline", minWidth: 0 }}>
                        <Box sx={{ width: 5, height: 5, borderRadius: "50%", flex: "none",
                                   mt: 0.7, bgcolor: hue(STANCE[src.stance].hue) }} />
                        <Typography sx={{ fontSize: 11, color: "text.secondary", minWidth: 0,
                                          overflow: "hidden", textOverflow: "ellipsis",
                                          whiteSpace: "nowrap" }}>
                          {src.doc}
                          {src.heading_path ? ` · ${src.heading_path}` : ""}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
                <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap", mt: 0.85 }}>
                  {c.independent_sources > 0 && (
                    <Chip size="small" variant="outlined" icon={<Quote size={10} />}
                          label={plural(c.independent_sources, "independent document")}
                          sx={{ height: 18, fontSize: 9.5, "& .MuiChip-icon": { ml: 0.4 } }} />
                  )}
                  {c.graph_facts.map((f, k) => (
                    <Chip key={k} size="small" icon={<Network size={10} />}
                          label={f.meaningful ? "graph confirms" : "graph route flagged"}
                          sx={{ height: 18, fontSize: 9.5, "& .MuiChip-icon": { ml: 0.4 },
                                bgcolor: alpha(f.meaningful ? theme.palette.info.main : theme.palette.warning.main, 0.14),
                                color: f.meaningful ? "info.main" : "warning.main" }} />
                  ))}
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}

      {!!answer?.open_questions.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>
            Left open
          </Typography>
          <Stack component="ul" spacing={0.4} sx={{ m: 0, mt: 0.25, pl: 2.25 }}>
            {answer.open_questions.map((q, i) => (
              <Typography key={i} component="li" sx={{ fontSize: 12, lineHeight: 1.55, color: "text.secondary" }}>
                {q}
              </Typography>
            ))}
          </Stack>
        </Box>
      )}

      {!!answer?.limits.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>Limits</Typography>
          <Stack component="ul" spacing={0.4} sx={{ m: 0, mt: 0.25, pl: 2.25 }}>
            {answer.limits.map((l, i) => (
              <Typography key={i} component="li" sx={{ fontSize: 12, lineHeight: 1.55, color: "text.secondary" }}>
                {l}
              </Typography>
            ))}
          </Stack>
        </Box>
      )}

      {/* What is recorded but not shown here, and how to reach it. */}
      <Paper sx={{ p: 1.3, bgcolor: (t) => surface(t, 0.5) }}>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>
          {plural(run.calls?.length ?? 0, "tool call")}
          {run.log?.length ? ` and ${plural(run.log.length, "log entry", "log entries")}` : ""}
          {" "}are recorded for this run. Load it into the page to step through them, and to open a
          quote in the document it came from.
        </Typography>
      </Paper>
    </Stack>
  );
}

/* --------------------------------------------------------------------- page */

export default function EvidencePage({ active, showTechDetails = true, openRun: request = null }: {
  active: boolean;
  /** Open this recorded run, as the Admin page's run history asks. */
  openRun?: RunRequest | null;
  /** The model name and the corpus internals (tool count, filtered graph
   *  hubs, duplicate groups). Demo Mode turns it off: a client is shown what
   *  the agent does, not what it runs on. */
  showTechDetails?: boolean;
}) {
  const theme = useTheme();
  const [status, setStatus] = useState<EvidenceStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [picked, setPicked] = useState<SampleQuestion | null>(null);
  const [holdout, setHoldout] = useState(false);
  // Memory is off unless asked for. It changes what the agent is told before
  // it starts, so a run with it on is not the same experiment as one without,
  // and the row records which it was.
  const [useMemory, setUseMemory] = useState(false);
  const [memory, setMemory] = useState<EvidenceMemory | null>(null);
  // The run as a sequence. The panels below show what happened; this shows it
  // in order, including the steps that have no panel of their own.
  // Collapsed or not, remembered across reloads. Six recalled notes push the
  // investigation below the fold, and somebody who has read them once should
  // not have to scroll past them on every run. Per viewer, and never anything
  // that matters if it comes back empty -- private mode throws on read.
  const [memoryOpen, setMemoryOpen] = useState(() => {
    try { return localStorage.getItem("evidence.memoryOpen") !== "0"; } catch { return true; }
  });
  const [log, setLog] = useState<EvidenceLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [reflectOpen, setReflectOpen] = useState(false);
  // Every investigation reads the whole corpus; the category a chunk is filed
  // under is still reported on each tool call, but it is no longer a control.
  const [running, setRunning] = useState(false);
  const [calls, setCalls] = useState<EvidenceToolCall[]>([]);
  const [answer, setAnswer] = useState<EvidenceAnswer | null>(null);
  const [evaluation, setEvaluation] = useState<AgentEvaluation | Record<string, never> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // The investigation the live stream belongs to, from its first `run`
  // event: what a dropped connection reopens, and what Stop stops.
  const liveRun = useRef<string | null>(null);

  // Past investigations. Every run is written to evidence_runs as it happens,
  // so this survives a reload, a restart and a closed tab -- which is the
  // whole point: an answer nobody can go back to is one nobody can check.
  const [history, setHistory] = useState<EvidenceRunSummary[]>([]);
  // Whose runs the history lists: an Admin can switch to everyone's.
  const historyView = useHistoryScope();
  // Anchored to the header button rather than expanded in the page, the way
  // the Fit-Gap Copilot does it: past runs are a thing you go and get, not a
  // thing that sits between the question and the answer.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Named tabs, as on the Fit-Gap Copilot; which exist depends on what the run has.
  const [tab, setTab] = useState("answer");
  const [focusClaim, setFocusClaim] = useState<{ index: number; at: number } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState<string | null>(null);

  // --- citation traceability -------------------------------------------------
  // A claim's source names a chunk and quotes a sentence of it. That is enough
  // to check the arithmetic and not enough to check the reading: a quote can be
  // accurate and still mean something else in its paragraph. So a source opens
  // the document it came from, in the same inspector the Ask page uses.
  //
  // The chunk key is all the answer carries, so the passage behind it has to be
  // fetched. They are hydrated as a set rather than one at a time, because the
  // inspector pages through sources with prev/next and a half-filled list would
  // make that walk skip over the ones nobody had clicked yet.
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectSource, setInspectSource] = useState<Source | null>(null);
  const [inspectAll, setInspectAll] = useState<Source[]>([]);
  const [inspectQuote, setInspectQuote] = useState("");
  const [inspectBusy, setInspectBusy] = useState<string | null>(null);
  const chunkCache = useRef(new Map<string, Source>());

  // Every distinct chunk the answer cites, in the order the claims cite them.
  // This is the list the inspector walks, so it is the run's evidence, not one
  // claim's.
  const citedChunks = useMemo(() => {
    const seen: string[] = [];
    for (const c of answer?.claims ?? []) {
      for (const src of c.sources) {
        if (src.chunk_id && !seen.includes(src.chunk_id)) seen.push(src.chunk_id);
      }
    }
    return seen;
  }, [answer]);

  // Lineage is computed from the stored run, so it is asked for only once the
  // investigation has finished and been recorded.
  useEffect(() => { setLineage(null); setLineageError(""); }, [runId]);
  useEffect(() => {
    if (tab !== "investigation" || !runId || running || !answer) return;
    let live = true;
    evidence.lineage(runId)
      .then((l) => { if (live) { setLineage(l); setLineageError(""); } })
      .catch((e) => { if (live) setLineageError(`Could not trace this investigation: ${(e as Error).message}`); });
    return () => { live = false; };
  }, [tab, runId, running, answer]);

  /** `walk` is the list the inspector pages through with prev/next. It
   *  defaults to the answer's citations, which is what a reader opening a
   *  claim wants; a passage opened from a retrieval trace passes that call's
   *  own ranking instead, so paging walks the eight results the agent saw
   *  rather than jumping into a different call's evidence. */
  const inspect = useCallback(async (src: EvidenceSource, walk?: string[]) => {
    if (!src.chunk_id) return;
    setInspectBusy(src.chunk_id);
    try {
      const wanted = walk?.length ? walk : citedChunks.length ? citedChunks : [src.chunk_id];
      const loaded = await Promise.all(wanted.map(async (id, i) => {
        const hit = chunkCache.current.get(id);
        if (hit) return { ...hit, n: i + 1 };
        try {
          const fetched = await api.chunk(id);
          chunkCache.current.set(id, fetched);
          return { ...fetched, n: i + 1 };
        } catch {
          // A chunk that no longer resolves is a real answer, not a blank:
          // re-indexing renumbers chunks, so an old run can cite one that is
          // gone. Say so in place rather than dropping it from the walk.
          return {
            n: i + 1, title: src.doc, section: src.heading_path,
            content: `> ${src.quote}\n\n*Chunk \`${id}\` is no longer in the index, so the document it came from cannot be opened. Re-indexing renumbers chunks; this citation is from before the last one. The quote above is what the run recorded.*`,
            category: "", score: 0, similarity: null, bm25: null,
            vector_rank: src.vector_rank, keyword_rank: src.keyword_rank,
            file: "", source_path: "", missing: true,
          } as Source & { missing: boolean };
        }
      }));
      setInspectAll(loaded);
      setInspectSource(loaded[Math.max(0, wanted.indexOf(src.chunk_id))] ?? loaded[0] ?? null);
      setInspectQuote(src.quote);
      setInspectOpen(true);
    } finally {
      setInspectBusy(null);
    }
  }, [citedChunks]);

  // Which call's evidence is open. The log says a call happened; this says what
  // it brought back, which is the question a reader has the moment they doubt
  // the answer.
  const [traceCall, setTraceCall] = useState<EvidenceToolCall | null>(null);
  // The chunks to pick out in the call drawer when it is opened from a quote.
  const [traceHighlight, setTraceHighlight] = useState<string[]>([]);
  // The run's lineage (evidence/lineage.py), fetched when the Investigation
  // tab is opened on a finished run, and the claim to open there.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [lineageError, setLineageError] = useState("");
  const [traceFocus, setTraceFocus] = useState<string | null>(null);

  // What the finished answer actually rests on, so a trace can mark the part of
  // its haul that carried a claim. Retrieval is keyed by chunk, the graph by
  // node and edge -- the two engines contribute different kinds of thing and
  // are credited separately rather than merged into one count.
  const citedGraph = useMemo(() => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const c of answer?.claims ?? []) {
      for (const f of c.graph_facts ?? []) {
        for (const n of f.node_ids ?? []) nodes.add(n);
        for (const e of f.edge_ids ?? []) edges.add(e);
      }
    }
    return { nodes: [...nodes], edges: [...edges] };
  }, [answer]);

  const openTraceChunk = useCallback((hit: EvidenceRagHit, walk: string[]) => {
    inspect(
      {
        chunk_id: hit.chunk_id,
        doc: hit.doc,
        heading_path: hit.heading_path,
        // The inspector locates a passage by looking for it in the document.
        // The head of the chunk is a better anchor than the whole of it: long
        // enough to be unique, short enough that a highlight lands on one
        // place rather than striping the page.
        quote: hit.text.slice(0, 300),
        stance: "context",
        score: hit.score,
        vector_rank: hit.vector_rank,
        keyword_rank: hit.keyword_rank,
        provenance: hit.provenance,
        provenance_note: hit.provenance_note,
        verified: null,
      } as EvidenceSource,
      walk,
    );
  }, [inspect]);

  const loadHistory = useCallback(() => {
    evidence.runs().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!active) return;
    evidence.status().then(setStatus).catch(() => setStatus(null));
    loadHistory();
  }, [active, loadHistory, historyView]);

  // The toggle is offered only when there is something to offer. A switch that
  // silently does nothing is worse than one that is visibly unavailable and
  // says why -- the server is a separate process and is usually not running.
  const mem = status?.memory;
  const memoryOff = holdout || !mem?.available;
  const memoryTip = holdout
    ? "Memory is off under holdout. Holdout measures the agent against a corpus it cannot look "
      + "the answer up in, and an earlier run's answer arriving through memory would hand it back."
    : !showTechDetails && !mem?.available
    ? "Agent memory is not available right now."
    : !mem?.configured
    ? "Memory is switched off: HINDSIGHT_URL is empty."
    : !mem.available
    ? `No memory server at ${mem.url} — ${mem.detail}. See docs/agent-memory.md.`
    : `Read what earlier investigations concluded, and write down what this one does. `
      + `${mem.memories ?? 0} memories in '${mem.bank}'. Memory steers the search; it is never `
      + `evidence and can never be cited.`;

  useEffect(() => {
    try { localStorage.setItem("evidence.memoryOpen", memoryOpen ? "1" : "0"); }
    catch { /* private mode: the preference is simply not kept */ }
  }, [memoryOpen]);

  const engineCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const call of calls) c[call.engine] = (c[call.engine] ?? 0) + 1;
    return c;
  }, [calls]);

  /** Empty every panel a live stream fills, before it fills them. */
  function clearLive() {
    setCalls([]); setAnswer(null); setEvaluation(null); setError(null);
    setNotSaved(null); setMemory(null); setLog([]); setTab("investigation");
  }

  /** What a live stream does with its events. `ended` is set by the two
   *  events an investigation always finishes with, so a stream that closes
   *  without either is known to have been cut. */
  function liveHandlers(ended: { value: boolean }): EvidenceHandlers {
    return {
      run: (r) => { liveRun.current = r.id; setRunId(r.id); setNotSaved(r.not_saved ?? null); },
      memory: setMemory,
      log: (e) => setLog((es) => [...es, e]),
      toolCall: (c) => setCalls((cs) => [...cs, c]),
      answer: (a) => { ended.value = true; setAnswer(a); setTab("answer"); },
      evaluation: setEvaluation,
      error: (m) => { ended.value = true; setError(m); },
    };
  }

  /** Follow an investigation until it finishes. `first` opens the stream;
   *  without it, the one in `liveRun` is reopened. A connection that drops
   *  before it ends -- a proxy, a flaky network -- is reopened and replayed
   *  from the top, since the investigation carries on on the server. */
  async function follow(first: ((on: EvidenceHandlers, signal: AbortSignal) => Promise<unknown>) | null) {
    setRunning(true);
    const ctrl = new AbortController();
    controller.current = ctrl;
    const ended = { value: false };
    let start = first;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (start) {
            await start(liveHandlers(ended), ctrl.signal);
          } else {
            const id = liveRun.current;
            clearLive();
            if (!id || !(await followEvidence(id, liveHandlers(ended), ctrl.signal))) {
              // No longer live: it finished, or the server restarted. The
              // store has whatever it got to.
              if (id) await open(id, false);
              return;
            }
          }
          if (ended.value || ctrl.signal.aborted) return;
        } catch (e) {
          if ((e as Error).name === "AbortError" || ctrl.signal.aborted) return;
          if (!liveRun.current) { setError((e as Error).message); return; }
        }
        if (attempt >= RECONNECTS) {
          setError("Lost the connection to this investigation. It is still running on the server: reopen it from History.");
          return;
        }
        start = null;
        await new Promise((r) => setTimeout(r, 1000 * Math.min(attempt + 1, 5)));
      }
    } finally {
      setRunning(false);
      controller.current = null;
      // Whether it finished, failed or was stopped, the row exists and the
      // list should show it in the state it actually reached.
      loadHistory();
    }
  }

  async function run(text?: string) {
    const q = (text ?? question).trim();
    if (!q || running) return;
    clearLive();
    setRunId(null); setViewing(null);
    liveRun.current = null;
    await follow((on, signal) =>
      askEvidence({ question: q, holdout, categories: [], memory: useMemory }, on, signal));
  }

  /** Stop on the server as well: the investigation no longer ends with the
   *  stream. */
  function stop() {
    if (liveRun.current) evidence.stop(liveRun.current).catch(() => undefined);
    controller.current?.abort();
    setRunning(false);
  }

  /** The history summaries as the drawer's cards. Every badge this panel
   *  showed as a <Menu> is still here -- the state icon, holdout, how many
   *  notes were recalled -- so nothing was lost in moving it. */
  const historyCards: HistoryCard[] = useMemo(
    () => history.map((h) => ({
      id: h.id,
      title: h.question,
      subtitle: h.summary,
      startedAt: h.started_at,
      lead: h.state
        ? STATES[h.state as AnswerState].icon
        : <TriangleAlert size={15} color={theme.palette.warning.main} />,
      badges: (
        <>
          {h.status !== "done" && (
            <Chip size="small" variant="outlined"
                  color={h.status === "failed" ? "error" : "warning"}
                  label={h.status} sx={{ height: 18, fontSize: 9.5 }} />
          )}
          {h.holdout && (
            <Chip size="small" variant="outlined" label="holdout" sx={{ height: 18, fontSize: 9.5 }} />
          )}
          {memoryNotes(h) > 0 && (
            <Tooltip title={`Started from ${plural(memoryNotes(h), "note")} recalled from earlier investigations`}>
              <Chip size="small" variant="outlined" icon={<Brain size={10} />} label={memoryNotes(h)}
                    sx={{ height: 18, fontSize: 9.5, "& .MuiChip-icon": { ml: 0.4 } }} />
            </Tooltip>
          )}
        </>
      ),
      meta: [
        ownerLabel(h.owner),
        plural(h.tool_calls, "call"),
        h.claims ? plural(h.claims, "claim") : "",
        h.sources ? plural(h.sources, "source") : "",
        h.seconds ? `${h.seconds.toFixed(1)}s` : "",
      ].filter(Boolean).join(" · "),
    })),
    [history, theme],
  );

  /** Reopen a past investigation: the question, every tool call in the order
   *  it happened, and the answer as it was verified at the time. Nothing is
   *  re-run -- and nothing is re-billed. */
  useEffect(() => {
    if (request) void open(request.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  async function open(id: string, attach = true) {
    if (running && attach) return;
    setError(null);
    try {
      const run = await evidence.run(id);
      setQuestion(run.question);
      setPicked(EVIDENCE_SAMPLES.find((q) => q.question === run.question) ?? null);
      setHoldout(run.holdout);
      const remembered = run.memory as EvidenceMemory | undefined;
      setMemory(remembered && "enabled" in remembered ? remembered : null);
      setUseMemory(!!remembered && "enabled" in remembered && remembered.enabled);
      setLog(run.log ?? []);
      setCalls(run.calls ?? []);
      setAnswer(run.answer);
      setEvaluation(run.evaluation ?? {});
      setTab(run.answer ? "answer" : "investigation");
      setRunId(run.id);
      setViewing(run.id);
      if (run.status === "failed" && run.error) setError(run.error);
      if (run.status === "abandoned") {
        setError("This investigation was interrupted — the browser went away before it finished. "
                 + "What it had done by then is below.");
      }
      // Still going -- the stream was cut, the tab was closed, or it was
      // started in another one. Follow it live from its first event.
      if (attach && run.status === "running") {
        liveRun.current = run.id;
        await follow(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open that investigation.");
    }
  }

  async function remove(id: string) {
    try {
      await evidence.deleteRun(id);
      if (viewing === id) { setViewing(null); setRunId(null); }
      loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete that investigation.");
    }
  }

  const blocked = status && !status.anthropic_key;

  const claims = answer?.claims ?? [];
  const quotes = claims.flatMap((c) => c.sources);
  const docs = new Set(quotes.map((q) => q.doc)).size;
  const weakest = claims.length ? claims.reduce((m, c) => (c.score < m.score ? c : m), claims[0]) : null;
  const strongN = claims.filter((c) => strength(c.score) === "Strong").length;
  const weakN = claims.filter((c) => strength(c.score) === "Weak").length;
  const engineLine = Object.entries(answer?.engines && Object.keys(answer.engines).length ? answer.engines : engineCounts)
    .map(([e, n]) => `${ENGINE_NAME[e] ?? e} ${n}`).join(" · ");
  const showMemory = !!memory && (memory.used || memory.suppressed_by_holdout);
  const TABS = [
    { key: "answer", label: "Answer", show: !!answer },
    { key: "claims", label: `Claims (${claims.length})`, show: !!answer },
    { key: "investigation", label: `Traceability${calls.length ? ` (${calls.length})` : ""}`, show: calls.length > 0 || running || !!(runId && answer) },
    { key: "memory", label: `Memory${memory?.recalled ? ` (${memory.recalled})` : ""}`, show: showMemory },
    { key: "evaluation", label: "Evaluation", show: !!answer },
  ].filter((t) => t.show);
  const current = TABS.some((t) => t.key === tab) ? tab : TABS[0]?.key ?? "";
  const openClaim = (index: number) => { setTab("claims"); setFocusClaim({ index, at: Date.now() }); };
  const traceClaim = (index: number) => { setTraceFocus(`C${index + 1}`); setTab("investigation"); };
  const openCall = (i: number, chunks?: string[]) => {
    const c = calls[i];
    if (!c) return;
    setTraceHighlight(chunks ?? []);
    setTraceCall(c);
  };
  const traceable = !!(runId && answer && !running);
  const shownQuestion = answer?.question || (running ? question : "");

  return (
    <Box sx={{ height: "100%", overflow: "auto", bgcolor: "background.default" }}>
      <ObjectHeader
        breadcrumb={`Evidence Agent / Investigations${runId ? ` / ${runId}` : ""}`}
        title={shownQuestion ? (shownQuestion.length > 150 ? `${shownQuestion.slice(0, 150)}…` : shownQuestion) : "Evidence Agent"}
        badge={answer ? STATES[answer.state].label : running ? "Investigating…" : viewing ? "Recorded" : undefined}
        meta={answer
          ? `${STATES[answer.state].blurb}${showTechDetails ? ` · ${answer.model}` : ""}${holdout ? " · holdout" : ""}${memory?.used ? " · memory on" : ""}`
          : "One question, both engines. Every claim carries its sources and the arithmetic behind its score."}
        actions={
          <>
            <BandButton onClick={() => setHistoryOpen(true)} startIcon={<HistoryIcon size={14} />}
                        title="Past investigations — read one here, beside the one on the page">
              {history.length ? `History (${history.length})` : "History"}
            </BandButton>
            <BandButton onClick={() => setReflectOpen(true)} disabled={!mem?.available || !mem?.memories}
                        startIcon={<Lightbulb size={14} />}
                        title={!mem?.available
                          ? "The memory server is not reachable, so there is nothing to ask."
                          : !mem?.memories
                            ? "Nothing has been written to memory yet. Run an investigation with memory on."
                            : `Ask the ${mem.memories} memories what earlier investigations found — what we have looked at, where two runs disagreed, what is still open. Reads the whole bank, so it takes 30-60 seconds.`}>
              Ask memory
            </BandButton>
            <BandButton onClick={() => setLogOpen(true)} disabled={log.length === 0} startIcon={<Terminal size={15} />}
                        title={log.length === 0
                          ? "The step-by-step log of a run: the context the agent is handed, what it reasons, every engine it queries, and what it writes back. Ask a question to fill it."
                          : `Open the step-by-step log — ${log.length} step(s)`}>
              Logs{log.length ? ` (${log.length})` : ""}
            </BandButton>
          </>
        }
        kpis={answer ? [
          { label: "Claims", value: String(claims.length), sub: claims.length ? `${strongN} strong · ${weakN} weak` : "no claim rests on a source" },
          { label: "Weakest claim", value: weakest ? weakest.score.toFixed(2) : "—", sub: weakest ? `${strength(weakest.score)} — it governs the answer` : "—" },
          { label: "Evidence", value: String(docs), sub: `documents · ${quotes.length} quotes` },
          { label: "Investigation", value: String(answer.tool_calls), sub: engineLine || "tool calls" },
          { label: "Time", value: `${answer.seconds}s`, sub: `${Math.round((answer.input_tokens + answer.output_tokens) / 1000)}k tokens` },
        ] : undefined}
      />

      <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 2, md: 4 }, py: 2 }}>
          <Box sx={{ maxWidth: 1440 }}>
          <TextField
            fullWidth multiline maxRows={4} value={question}
            onChange={(e) => { setQuestion(e.target.value); if (picked) setPicked(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}
            placeholder={`Ask anything about the corpus — or pick one of the ${EVIDENCE_SAMPLES.length} sample questions below`}
            slotProps={{ input: {
              sx: { fontSize: 15, alignItems: "flex-start" },
              startAdornment: <Box sx={{ pt: 0.35, pr: 1.25, color: "primary.main" }}><FlaskConical size={18} /></Box>,
              // Clears the picked sample question with it: the text and the
              // chip below it are the same choice shown twice.
              endAdornment: clearAdornment(question, () => { setQuestion(""); setPicked(null); },
                                           { size: 16, label: "Clear question", top: true }),
            } }}
          />

          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1.5 }}>
            <Autocomplete
              openOnFocus size="small" sx={{ flex: 1 }} value={picked} options={EVIDENCE_SAMPLES}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              getOptionLabel={(q) => q.question}
              onChange={(_, q) => { setPicked(q); if (q) setQuestion(q.question); }}
              filterOptions={(opts, { inputValue }) => {
                const n = inputValue.trim().toLowerCase();
                return n ? opts.filter((q) => `${q.id} ${q.shows} ${q.question}`.toLowerCase().includes(n)) : opts;
              }}
              renderInput={(params) => (
                <TextField {...params} placeholder={`Sample questions — ${EVIDENCE_SAMPLES.length} to try, each showing something the agent does`}
                  slotProps={{ ...params.slotProps, input: { ...params.slotProps.input,
                    startAdornment: (<><Box sx={{ pl: 0.5, pr: 0.75, display: "flex", color: "text.secondary" }}>
                      <Lightbulb size={15} /></Box>{params.slotProps.input.startAdornment}</>) } }} />
              )}
              renderOption={(props, q) => {
                const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
                return (
                  <Box component="li" key={q.id} {...rest} sx={{ display: "block !important", py: 1, px: 1.5, borderBottom: 1, borderColor: "divider" }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.35 }}>
                      <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: "primary.main" }}>{q.id}</Box>
                      <Typography sx={{ fontSize: 11, fontWeight: 700, color: "text.secondary", textTransform: "uppercase", letterSpacing: ".04em" }}>
                        {q.shows}
                      </Typography>
                    </Stack>
                    <Typography sx={{ fontSize: 13, lineHeight: 1.45 }}>{q.question}</Typography>
                  </Box>
                );
              }}
              slotProps={{ paper: { sx: { width: { xs: "100%", md: 620 } } } }}
            />
            <Tooltip title="Pick one at random">
              <span><IconButton size="small" disabled={running}
                onClick={() => { const q = EVIDENCE_SAMPLES[Math.floor(Math.random() * EVIDENCE_SAMPLES.length)];
                                 setPicked(q); setQuestion(q.question); }}>
                <Dices size={16} /></IconButton></span>
            </Tooltip>
            <Tooltip title="Hide the fit registers and blank FIT/GAP tokens, for an unbiased evaluation run">
              <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                <Switch size="small" checked={holdout}
                        onChange={(e) => setHoldout(e.target.checked)} />
                <Typography sx={{ fontSize: 12, color: "text.secondary" }}>holdout</Typography>
              </Stack>
            </Tooltip>
            <Tooltip title={memoryTip}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: "center",
                                                        opacity: memoryOff ? 0.5 : 1 }}>
                <Switch size="small" checked={useMemory && !memoryOff} disabled={memoryOff}
                        onChange={(e) => setUseMemory(e.target.checked)} />
                <Stack direction="row" spacing={0.4} sx={{ alignItems: "center" }}>
                  <Brain size={13} />
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>memory</Typography>
                </Stack>
              </Stack>
            </Tooltip>
            {running ? (
              <Button variant="outlined" color="error" startIcon={<Square size={15} />}
                      onClick={stop}>Stop</Button>
            ) : (
              <Button variant="contained" disabled={!question.trim() || !!blocked}
                      startIcon={<SendHorizontal size={16} />} onClick={() => run()}>Investigate</Button>
            )}
          </Stack>

          {picked && (
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 1.25 }}>
              <b>{picked.id} · {picked.shows}</b> — {picked.lookFor}
            </Typography>
          )}
        </Box>
      </Paper>

      {TABS.length > 0 && (
        <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 1, md: 3 } }}>
          <Tabs value={current} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
                sx={{ minHeight: 46, "& .MuiTab-root": { minHeight: 46, textTransform: "none", fontSize: 13.5, fontWeight: 500, px: 1.75 },
                      "& .Mui-selected": { fontWeight: 600 } }}>
            {TABS.map((t) => <Tab key={t.key} value={t.key} label={t.label} />)}
          </Tabs>
        </Paper>
      )}

      <Box sx={{ px: { xs: 2, md: 4 }, py: 3 }}>
        {blocked && (
          <Alert severity="warning" sx={{ mb: 2, borderRadius: RADIUS }}>
            No <code>ANTHROPIC_API_KEY</code> is set, so no question can be answered.
          </Alert>
        )}
        {error && <Alert severity="error" sx={{ mb: 2, borderRadius: RADIUS }} onClose={() => setError(null)}>{error}</Alert>}

        {notSaved && (
          <Alert severity="warning" sx={{ mb: 2, borderRadius: RADIUS }} onClose={() => setNotSaved(null)}>
            This investigation is running but is <b>not being recorded</b> — {notSaved}. The answer
            below is real; it just will not be in the history afterwards.
          </Alert>
        )}


        {current === "answer" && answer && (
          <AnswerSummary answer={answer} onClaim={openClaim} engines={engineLine} showModel={showTechDetails} />
        )}

        {current === "evaluation" && answer && (
          <AgentEvaluationView evaluation={evaluation} running={running} agent="evidence" />
        )}

        {current === "claims" && answer && (
          <ClaimsView claims={claims} focus={focusClaim} fileStem={runId ?? "evidence"}
                      onTrace={traceable ? traceClaim : undefined}
                      renderSource={(s, i) => <SourceRow key={i} s={s} onInspect={inspect} busy={inspectBusy === s.chunk_id} />} />
        )}

        {current === "investigation" && traceable && (
          <InvestigationView exportUrl={(f) => evidence.lineageExportUrl(runId!, f)} lineage={lineage}
                             error={lineageError} focus={traceFocus} onOpenCall={openCall}
                             onOpenLogs={() => setLogOpen(true)} logCount={log.length} />
        )}
        {current === "investigation" && !traceable && (
          <>
        {/* the investigation, live */}
        {calls.length > 0 && (
          <Paper sx={{ p: 1.75, mb: 2.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.25 }}>
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
                Investigation · {plural(calls.length, "call")}
              </Typography>
              {runId && (
                <Tooltip title="The id this investigation is recorded under. It stays in the history after the tab is closed.">
                  <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontSize: 10,
                    fontWeight: 700, px: 0.55, borderRadius: 0.75, color: "text.secondary",
                    bgcolor: alpha(theme.palette.text.primary, 0.06) }}>{runId}</Box>
                </Tooltip>
              )}
              <Box sx={{ flex: 1 }} />
              {Object.entries(engineCounts).map(([e, n]) => (
                <Tooltip key={e} title={ENGINE_HINT[e] ?? ""}>
                  <Chip size="small" variant="outlined" icon={ENGINE_ICON[e] ?? ENGINE_ICON.other}
                        label={`${ENGINE_NAME[e] ?? e} ${plural(n, "call")}`}
                        sx={{ height: 20, fontSize: 10.5 }} />
                </Tooltip>
              ))}
            </Stack>
            {/* Whether these rows open anything, said once rather than left to
                be discovered. A run recorded before the log kept traces looks
                identical to one whose rows simply do nothing, and "the feature
                is not here" is the wrong conclusion to leave available. */}
            {calls.some((c) => c.trace) ? (
              <Typography sx={{ fontSize: 11, color: "text.disabled", mb: 1 }}>
                Click a call to see what it returned.
              </Typography>
            ) : !running && calls.length > 0 ? (
              <Typography sx={{ fontSize: 11, color: "text.disabled", mb: 1 }}>
                {calls.every((c) => c.error)
                  ? "Every call failed, so none of them returned evidence to show."
                  : "This run was recorded before the log kept what each call returned. Ask the question again to get a trace you can open."}
              </Typography>
            ) : null}
            {running && <LinearProgress sx={{ height: 2, borderRadius: 2, mb: 1.25 }} />}
            <Stack spacing={0.5}>
              <AnimatePresence initial={false}>
                {calls.map((c, i) => (
                  <Stack key={i} component={motion.div} layout initial={{ opacity: 0, x: -6 }}
                         animate={{ opacity: 1, x: 0 }} direction="row" spacing={0.85}
                         onClick={c.trace ? () => setTraceCall(c) : undefined}
                         role={c.trace ? "button" : undefined}
                         tabIndex={c.trace ? 0 : undefined}
                         onKeyDown={c.trace ? (e: ReactKeyboardEvent) => {
                           if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTraceCall(c); }
                         } : undefined}
                         sx={{ alignItems: "center", fontSize: 11.5,
                               color: c.error ? "error.main" : "text.secondary",
                               // Only a call that kept a trace is worth opening.
                               // A failed one, or one from a run recorded before
                               // traces existed, stays an ordinary log line
                               // rather than a button that opens an apology.
                               cursor: c.trace ? "pointer" : "default",
                               borderRadius: 0.75, px: 0.4, mx: -0.4,
                               transition: "background-color .12s",
                               "&:hover": c.trace
                                 ? { bgcolor: alpha(theme.palette.text.primary, 0.05) }
                                 : undefined,
                               "&:focus-visible": {
                                 outline: `2px solid ${theme.palette.primary.main}`,
                                 outlineOffset: 1,
                               } }}>
                    <Box sx={{ display: "flex", color: ENGINE_COLOUR[c.engine] ?? ENGINE_COLOUR.other }}>
                      {ENGINE_ICON[c.engine] ?? ENGINE_ICON.other}
                    </Box>
                    {/* Which engine was asked, then which function of it. Without
                        the engine name, "search_corpus" and "graph_entity" read as
                        one undifferentiated list of internals. */}
                    <Stack direction="row" spacing={0.75}
                           sx={{ alignItems: "baseline", minWidth: 176, flexShrink: 0 }}>
                      <Tooltip title={c.trace
                        ? `${ENGINE_HINT[c.engine] ?? ""}\n\nClick to see what this call returned.`
                        : (ENGINE_HINT[c.engine] ?? "")}>
                        <Box component="span" sx={{
                          fontSize: 10, fontWeight: 800, letterSpacing: ".06em",
                          color: ENGINE_COLOUR[c.engine] ?? ENGINE_COLOUR.other,
                          minWidth: 34, cursor: c.trace ? "pointer" : "help",
                          textDecoration: c.trace ? "underline" : "none",
                          textDecorationStyle: "dotted",
                          textUnderlineOffset: 3,
                        }}>
                          {ENGINE_NAME[c.engine] ?? c.engine.toUpperCase()}
                        </Box>
                      </Tooltip>
                      <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                        {c.tool}
                      </Box>
                    </Stack>
                    <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: "hidden",
                                                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.summary}
                    </Box>
                    {/* Which store answered. With the corpus split per
                        category, "rag" alone cannot say whether DR was read. */}
                    {c.sources?.label && (
                      <Tooltip title={sourcesHint(c.sources)}>
                        <Box component="span" sx={{
                          flexShrink: 0, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap", fontSize: 10, fontWeight: 700, cursor: "help",
                          px: 0.6, py: 0.1, borderRadius: 0.75,
                          border: 1, borderColor: "divider", color: "text.secondary",
                        }}>
                          {c.sources.label}
                        </Box>
                      </Tooltip>
                    )}
                    {c.warning && (
                      <Tooltip title={c.warning}>
                        <Box sx={{ display: "flex", color: "warning.main" }}><TriangleAlert size={12} /></Box>
                      </Tooltip>
                    )}
                    <Box component="span" sx={{ color: "text.disabled", fontVariantNumeric: "tabular-nums" }}>
                      {c.ms}ms
                    </Box>
                  </Stack>
                ))}
              </AnimatePresence>
            </Stack>
          </Paper>
        )}

          </>
        )}

        {current === "memory" && (
          <>
        {/* what the agent was told before it started */}
        {memory && (memory.used || memory.suppressed_by_holdout) && (
          <Paper sx={{ mb: 2.5, overflow: "hidden" }}>
            <Stack direction="row" spacing={1}
                   sx={{ alignItems: "center", p: 1.75, cursor: "pointer" }}
                   onClick={() => setMemoryOpen((o) => !o)}
                   role="button" aria-expanded={memoryOpen}
                   aria-label={`${memoryOpen ? "Hide" : "Show"} the notes memory supplied`}>
              <Brain size={15} color={theme.palette.text.secondary} />
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
                Memory · {memory.suppressed_by_holdout ? "not read" : plural(memory.recalled, "note")}
              </Typography>
              <Box sx={{ flex: 1 }} />
              {/* Collapsed, the panel still has to carry the warning: the
                  reader is about to scroll past retrieved passages, and what
                  memory supplied must never be mistaken for them. */}
              <Chip size="small" variant="outlined" label="not evidence"
                    sx={{ height: 20, fontSize: 10.5, fontWeight: 700 }} />
              {memoryOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </Stack>
            <Collapse in={memoryOpen}>
              <Divider />
              <Box sx={{ p: 1.75 }}>
                {memory.suppressed_by_holdout ? (
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                    Memory was requested but not read: this is a holdout run. Holdout measures the
                    agent against a corpus it cannot look the answer up in, and an earlier run's
                    answer arriving through memory would hand it back.
                  </Typography>
                ) : memory.recalled === 0 ? (
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                    Nothing was remembered about this question. The agent started from the corpus, as
                    it always did.
                  </Typography>
                ) : (
                  <>
                    <Typography sx={{ fontSize: 11.5, color: "text.secondary", mb: 1 }}>
                      Notes from earlier investigations, given to the agent before its first search.
                      They steer where it looks. They are <b>not</b> evidence and cannot be cited: a
                      quote that is not in a chunk retrieved in this run is discarded, so nothing here
                      can reach an answer without being proved again from the corpus.
                    </Typography>
                    <Stack spacing={0.75}>
                      {memory.memories.map((m, i) => (
                        <Box key={m.id || i} sx={{ p: 1, borderRadius: 1.5, border: 1,
                                                   borderColor: "divider", bgcolor: surface(theme, 0.5) }}>
                          <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
                            <Typography sx={{ fontSize: 10, fontWeight: 800, color: "text.disabled",
                                              textTransform: "uppercase", letterSpacing: ".04em" }}>
                              {m.type || "note"}
                            </Typography>
                            <Typography sx={{ fontSize: 12.5, lineHeight: 1.5 }}>{m.text}</Typography>
                          </Stack>
                    </Box>
                  ))}
                </Stack>
              </>
            )}
              </Box>
            </Collapse>
          </Paper>
        )}

          </>
        )}

        {/* idle */}
        {!answer && !running && !calls.length && (
          <Paper sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600, mb: 0.5 }}>Nothing asked yet</Typography>
            <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 660, mx: "auto" }}>
              The agent decides for itself which engine to use — the graph for identity and counting,
              hybrid retrieval for substance — then reports what it found as separate claims, each
              scored by a rule you can check. It will say <b>not in the corpus</b> rather than guess.
            </Typography>
            {status && showTechDetails && (
              <Stack direction="row" useFlexGap sx={{ justifyContent: "center", flexWrap: "wrap", gap: 1, mt: 2 }}>
                <Chip size="small" variant="outlined" icon={<FileText size={13} />} label={status.model} />
                <Chip size="small" variant="outlined" icon={<GitBranch size={13} />}
                      label={`${status.tools.length} tools`} />
                <Tooltip title={status.hubs.map((h) => `${h.label} (${h.degree})`).join(" · ")}>
                  <Chip size="small" variant="outlined" icon={<Network size={13} />}
                        label={`${status.hubs.length} graph hubs filtered`} />
                </Tooltip>
                <Tooltip title={status.duplicate_groups.map((g) => g.join("  ↔  ")).join("\n")}>
                  <Chip size="small" variant="outlined" icon={<Copy size={13} />}
                        label={`${status.duplicate_groups.length} duplicate groups`} />
                </Tooltip>
              </Stack>
            )}
          </Paper>
        )}
      </Box>

        {/* previous investigations, in a drawer beside the current one */}
        <RunHistoryDrawer<EvidenceRunDetail>
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          icon={<HistoryIcon size={18} />}
          title="Past investigations"
          noun={["investigation", "investigations"]}
          items={historyCards}
          currentId={viewing}
          onDelete={remove}
          deleteLabel="Delete this investigation"
          fetchDetail={evidence.run}
          renderDetail={(run) => <PastInvestigation run={run} showModel={showTechDetails} />}
          onLoadIntoPage={(id) => void open(id)}
          loadDisabled={running}
          opensInPage={(id) => history.some((r) => r.id === id && r.status === "running")}
          filterPlaceholder="Filter by question or answer…"
          emptyText="Nothing investigated yet. Ask a question and it will appear here."
        />

      {(!!answer || calls.length > 0) && <ScrollRunway />}

      {/* ---------- citation traceability ---------- */}
      <MemoryReflectDrawer
          open={reflectOpen}
          onClose={() => setReflectOpen(false)}
          memories={mem?.memories ?? 0}
        />
        <AgentLogDrawer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        log={log}
        running={running}
        onOpenCall={(i) => openCall(i)}
      />

      <AgentTraceDrawer
        open={Boolean(traceCall)}
        onClose={() => { setTraceCall(null); setTraceHighlight([]); }}
        call={traceCall}
        cited={citedChunks}
        focus={traceHighlight}
        citedNodes={citedGraph.nodes}
        citedEdges={citedGraph.edges}
        onOpenChunk={openTraceChunk}
      />

      <DocumentInspectorDrawer
        open={inspectOpen}
        onClose={() => setInspectOpen(false)}
        source={inspectSource}
        allSources={inspectAll}
        onSelectSource={setInspectSource}
        // The quote is what the reader is checking, so it is what gets marked --
        // not the question's keywords, which is what the Ask page marks because
        // there the excerpt itself is the unit being judged.
        locate={inspectQuote}
      />
    </Box>
  );
}
