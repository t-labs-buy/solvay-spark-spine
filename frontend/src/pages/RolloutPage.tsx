import {
  Alert, Box, Button, Chip, CircularProgress, Collapse, Divider,
  LinearProgress, Menu, MenuItem, Paper, Select, Stack, Tab, Tabs, TextField,
  Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import RunHistoryDrawer, { type HistoryCard } from "../components/RunHistoryDrawer";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, CheckCircle2, ChevronDown, CircleHelp, Download, FileDown, FileText, Globe2,
  History, Layers, ListChecks, Paperclip, Plus, Scale, Search, ShieldCheck, Square,
  Terminal, Trash2, Upload, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fitgap, rollout, runRollout, sessionUploads, uploadSessionDocuments,
  type AgentToolCall, type AsIsModel, type Lineage, type EvidenceLogEntry, type BpmlProcess, type Deviation,
  type Materiality, type RolloutAnalysis, type RolloutDecision, type RolloutGates,
  type RolloutSourceChunk, type RolloutSourceDocument, type RolloutSources,
  type RolloutSubject,
  type RolloutPreview,
  type RolloutRunDetail, type RolloutRunSummary, type RolloutScores, type RolloutStatus,
  type UploadRole,
  type UploadSession, type AgentEvaluation,
} from "../api";
import { clearAdornment, clearOnEscape } from "../components/ClearAdornment";
import AgentLogDrawer from "../components/AgentLogDrawer";
import AgentTraceDrawer from "../components/AgentTraceDrawer";
import AgentEvaluationView from "../components/AgentEvaluationView";
import ScrollRunway from "../components/ScrollRunway";
import BriefView from "../components/rollout/BriefView";
import type { DecisionExtra } from "../components/rollout/decision";
import DeviationRegisterView from "../components/rollout/DeviationRegisterView";
import FacilitatorView, { type WorkshopDraft } from "../components/rollout/FacilitatorView";
import InvestigationView from "../components/InvestigationView";
import WorkshopAgendaView from "../components/rollout/WorkshopAgendaView";
import ObjectHeader, { BandButton } from "../components/rollout/ObjectHeader";
import { MONO, RADIUS, usePremium } from "../components/rollout/premium";
import ProcessAlignmentView from "../components/rollout/ProcessAlignmentView";
import ScoreCards from "../components/rollout/ScoreCards";
import SummaryView, { Section } from "../components/rollout/SummaryView";

/** A log for a run recorded before the reasoning was kept: its tool calls,
 *  in order, under a note that says that is all there is. */
function logFromCalls(calls: (AgentToolCall & { stage?: string })[]): EvidenceLogEntry[] {
  if (!calls.length) return [];
  return [
    { seq: 0, at: "", kind: "note", note: "legacy",
      title: "Recorded before the reasoning was kept — tool calls only",
      text: "Runs from this version on also log the context each pass was handed, the agent's reasoning between calls, rejected submissions and the quality gates." },
    ...calls.map((c, i) => ({
      seq: i + 1, at: "", kind: "tool_call" as const, tool: c.tool, engine: c.engine, summary: c.summary,
      ms: c.ms, error: c.error ?? null, arguments: c.arguments as Record<string, unknown>, call: i, stage: c.stage,
    })),
  ];
}

/* ------------------------------------------------------------------ palette */

/** Semantic colours for the process overlay and the heatmap (§16.2). Green
 *  fit, amber configurable, red material decision, blue confirmed
 *  localization, grey insufficient evidence — the specification's own legend,
 *  taken from the theme so each has a light and a dark variant. */
function useSemantic() {
  const t = useTheme();
  return {
    fit: t.palette.success.main,
    minor: t.palette.warning.main,
    material: t.palette.error.main,
    localization: t.palette.info.main,
    unknown: t.palette.text.disabled,
  };
}

const MATERIALITY_HUE: Record<Materiality, "error" | "warning" | "info" | "success" | "default"> = {
  Critical: "error", High: "error", Medium: "warning", Low: "info", Informational: "default",
};

/** The two states that are a real legal obligation. Everything else is a
 *  choice, however local — which is the whole point of §5.3. */

const plural = (n: number, one: string, many = "") => `${n} ${n === 1 ? one : many || one + "s"}`;

/* ------------------------------------------------------------------ pieces */

/** One colour per engine, the same three the Evidence Agent's log uses, so a
 *  reader moving between the two agents reads the same signal. */
const ENGINE_COLOUR: Record<string, string> = {
  rag: "primary.main",
  graph: "info.main",
  bpml: "success.main",
  session: "text.secondary",
};

function SectionLabel({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", mb: 1.75 }}>
      {icon}
      <Typography variant="overline" sx={{ letterSpacing: ".08em", color: "text.secondary" }}>
        {children}
      </Typography>
      <Box sx={{ flex: 1 }} />
      {right}
    </Stack>
  );
}

/** One of the four scores. `null` is rendered as "not assessable" rather than
 *  as a zero — §26 forbids inventing an SAP Best Practice number, so the page
 *  has to be able to show the absence of one. */
function ScoreTile({ label, value, band, hint, accent }: {
  label: string; value: number | null; band: string; hint?: string; accent?: string;
}) {
  const theme = useTheme();
  const colour = accent ?? theme.palette.primary.main;
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: "1 1 190px", minWidth: 180 }}>
      <Typography sx={{ fontSize: 11, color: "text.secondary", textTransform: "uppercase", letterSpacing: ".06em" }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", mt: 0.75 }}>
        <Typography sx={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: value === null ? "text.disabled" : colour }}>
          {value === null ? "—" : value}
        </Typography>
        {value !== null && <Typography sx={{ fontSize: 15, fontWeight: 600, color: colour }}>%</Typography>}
      </Stack>
      {value !== null && (
        <Box sx={{ mt: 1, height: 5, borderRadius: 3, bgcolor: alpha(colour, 0.15), overflow: "hidden" }}>
          <Box component={motion.div} initial={{ width: 0 }} animate={{ width: `${value}%` }}
               transition={{ duration: 0.7 }} sx={{ height: "100%", bgcolor: colour }} />
        </Box>
      )}
      <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.75, minHeight: 28 }}>
        {value === null ? (hint || "Not assessable") : band}
      </Typography>
    </Paper>
  );
}

function Dot({ colour, title }: { colour: string; title: string }) {
  return (
    <Tooltip title={title}>
      <Box sx={{ width: 11, height: 11, borderRadius: "50%", bgcolor: colour, display: "inline-block" }} />
    </Tooltip>
  );
}

/* ------------------------------------------------------- source attachments */

/** The country's As-Is and its baselines, each tagged with the role it plays.
 *
 *  Roles are the part that makes this a three-way comparison rather than a
 *  two-document diff: without them the agent cannot tell a country SOP from a
 *  template extract. The panel also states plainly where the file goes, since
 *  an analyst dropping a confidential country SOP into a chat box has every
 *  reason to assume it joins the corpus. It does not. */
function Sources({
  data, busy, error, disabled, accepted, roles, maxFiles, subject, subjects,
  onAdd, onRetag, onRemove, onClear, onSubject,
}: {
  data: UploadSession | null;
  busy: { filename: string; index: number; total: number; stage: string } | null;
  error: string | null;
  disabled: boolean;
  accepted: string[];
  roles: { value: UploadRole; label: string }[];
  maxFiles: number;
  /** What this run analyses. Decides which role has to be present, so the
   *  panel asks for the right document instead of always asking for an
   *  As-Is. */
  subject: RolloutSubject;
  /** Every subject a run can have, so the panel can offer the one the
   *  attached documents actually support. */
  subjects: RolloutSubject[];
  onSubject: (value: string) => void;
  onAdd: (files: File[], role: UploadRole) => void;
  onRetag: (name: string, role: UploadRole) => void;
  onRemove: (name: string) => void;
  onClear: () => void;
}) {
  const theme = useTheme();
  const premium = usePremium();
  // The one action on this screen, so it is filled in the accent rather than
  // outlined like the controls around it.
  const attachSx = {
    textTransform: "none", fontWeight: 600, fontSize: 13, height: 36, px: 2, borderRadius: RADIUS,
    bgcolor: premium.accent, color: premium.dark ? premium.onAccent : "#ffffff",
    "&:hover": { bgcolor: premium.accent, filter: "brightness(1.08)" },
  } as const;
  const input = useRef<HTMLInputElement | null>(null);
  const [role, setRole] = useState<UploadRole>(subject.role);
  const [over, setOver] = useState(false);
  // Which chip's role menu is open. This used to advance to the next role in
  // the list on every click, which is a poor way to reach a specific one of
  // five -- and re-tagging is exactly what the missing-As-Is warning asks the
  // analyst to do, so it should not be a guessing game.
  const [retag, setRetag] = useState<{ el: HTMLElement; name: string; role: UploadRole } | null>(null);
  const files = data?.files ?? [];
  const full = files.length >= maxFiles;
  const hasSubject = files.some((f) => f.role === subject.role);
  // A subject this session could be analysed as instead: its document is
  // attached and the selected one's is not. That is the whole of the
  // "you attached a Best Practice document and were asked for an As-Is"
  // problem, so the panel offers the switch rather than demanding a file.
  const alternative = subjects.find(
    (x) => x.value !== subject.value && files.some((f) => f.role === x.role));

  // Follow the subject when it changes, so switching the run type does not
  // leave the next upload filed under the old subject's role.
  useEffect(() => { setRole(subject.role); }, [subject.role]);

  const STAGES: Record<string, string> = {
    converting: "converting with Docling",
    embedding: "chunking and embedding",
    graph: "extracting entities",
  };

  const expiry = (() => {
    if (!data?.expires_at) return "";
    const mins = Math.round((new Date(data.expires_at).getTime() - Date.now()) / 60000);
    if (mins <= 0) return "expired";
    return mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  })();

  const grouped = roles
    .map((r) => ({ ...r, items: files.filter((f) => f.role === r.value) }))
    .filter((g) => g.items.length > 0);

  return (
    <Box
      onDragOver={(e) => { e.preventDefault(); if (!disabled && !full) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled || full) return;
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length) onAdd(dropped, role);
      }}
      sx={{
        mt: 0.5, px: 1.75, py: 1.5, borderRadius: "4px",
        // Dashed because it is a drop zone. Heavier while empty, because then
        // attaching is the only thing to do on this screen.
        border: files.length ? "1px dashed" : "2px dashed",
        borderColor: over ? premium.accent : files.length ? "divider" : alpha(premium.accent, 0.55),
        bgcolor: over ? alpha(premium.accent, 0.08) : files.length ? "transparent" : alpha(premium.accent, 0.035),
        transition: "background-color .15s, border-color .15s",
      }}
    >
      <input
        ref={input} type="file" multiple hidden accept={accepted.join(",")}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          if (chosen.length) onAdd(chosen, role);
          e.target.value = "";
        }}
      />

      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
        <Paperclip size={14} color={theme.palette.text.secondary} />
        <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>Sources</Typography>
        {files.length > 0 && (
          <Chip size="small" label={`${files.length} · ${(data?.chunks ?? 0).toLocaleString()} chunks`}
                sx={{ height: 19, fontSize: 10.5 }} />
        )}
        <Box sx={{ flex: 1 }} />
        {files.length > 0 && (
          <Button size="small" variant="text" color="inherit" disabled={disabled}
                  startIcon={<Trash2 size={13} />} onClick={onClear}
                  sx={{ fontSize: 12.5, color: "text.secondary" }}>
            Discard all
          </Button>
        )}
        {files.length > 0 && (
          <>
        <Select
          size="small" value={role} disabled={disabled || !!busy}
          onChange={(e) => setRole(e.target.value as UploadRole)}
          title="What the next upload is in the analysis"
          sx={{ fontSize: 12.5, minWidth: 168 }}
        >
          {roles.map((r) => (
            <MenuItem key={r.value} value={r.value} sx={{ fontSize: 12.5 }}>
              {r.label}
              <Typography component="span"
                          sx={{ fontSize: 10.5, ml: 1,
                                color: r.value === subject.role ? "warning.main" : "text.secondary" }}>
                {r.value === subject.role ? "required" : "baseline"}
              </Typography>
            </MenuItem>
          ))}
        </Select>
            <Button variant="contained" disableElevation startIcon={<Upload size={15} />}
                    disabled={disabled || full || !!busy} onClick={() => input.current?.click()}
                    sx={attachSx}>
              Attach more
            </Button>
          </>
        )}
      </Stack>

      {files.length === 0 && !busy && (
        <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center", py: 3 }}>
          <Box sx={{ width: 52, height: 52, borderRadius: "50%", display: "grid", placeItems: "center",
                     bgcolor: alpha(premium.accent, 0.12), color: premium.accent }}>
            <Upload size={24} />
          </Box>
          <Typography sx={{ fontSize: 16, fontWeight: 600 }}>
            Attach the {subject.label} to start
          </Typography>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            Drag files here, or choose them — PDF, Word, Excel, PowerPoint, HTML, XML or plain text
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", justifyContent: "center", pt: 0.5 }}>
            <Typography component="label" sx={{ fontSize: 12.5, color: "text.secondary" }}>Attach as</Typography>
              <Select
          size="small" value={role} disabled={disabled || !!busy}
          onChange={(e) => setRole(e.target.value as UploadRole)}
          title="What the next upload is in the analysis"
          sx={{ fontSize: 12.5, minWidth: 168 }}
        >
          {roles.map((r) => (
            <MenuItem key={r.value} value={r.value} sx={{ fontSize: 12.5 }}>
              {r.label}
              <Typography component="span"
                          sx={{ fontSize: 10.5, ml: 1,
                                color: r.value === subject.role ? "warning.main" : "text.secondary" }}>
                {r.value === subject.role ? "required" : "baseline"}
              </Typography>
            </MenuItem>
          ))}
        </Select>
            <Button variant="contained" disableElevation size="large" startIcon={<Upload size={17} />}
                    disabled={disabled || full} onClick={() => input.current?.click()}
                    sx={{ ...attachSx, height: 42, px: 3, fontSize: 14.5 }}>
              Attach documents
            </Button>
          </Stack>
        </Stack>
      )}

      {files.length === 0 && !busy && (
        <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.75 }}>
          Start with the <b>{subject.label}</b> — {subject.value === "country_as_is"
            ? "an SOP, work instruction, process narrative or workshop transcript describing how"
              + " the country works today"
            : "SAP's delivered process: a scope item description, process flow or test script"}.
          That one is <b>required</b>: it is what the run analyses.
          <Box component="span" sx={{ display: "block", mt: 0.85 }}>
            The other roles are optional baselines to compare it against, so the comparison rests
            on your documents rather than on the indexed corpus alone.
          </Box>
          <Box component="span" sx={{ display: "block", mt: 0.85 }}>
            Everything is converted, embedded and graphed in a store of its own, and is never
            added to the permanent knowledge bases.
          </Box>
        </Typography>
      )}

      <AnimatePresence initial={false}>
        {busy && (
          <Box component={motion.div} key="busy"
               initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
               exit={{ opacity: 0, height: 0 }} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", mb: 0.5 }}>
              <CircularProgress size={12} />
              <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                {busy.total > 1 ? `${busy.index}/${busy.total} · ` : ""}
                {busy.filename} — {STAGES[busy.stage] ?? busy.stage}
              </Typography>
            </Stack>
            <LinearProgress sx={{ height: 3, borderRadius: 2 }} />
          </Box>
        )}
      </AnimatePresence>

      {grouped.map((g) => (
        <Box key={g.value} sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", textTransform: "uppercase", letterSpacing: ".07em", mb: 0.4 }}>
            {g.label}
          </Typography>
          <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.75 }}>
            {g.items.map((f) => (
              <Chip
                key={f.name} size="small" icon={<FileText size={12} />}
                label={`${f.name} · ${f.chunks} chunk${f.chunks === 1 ? "" : "s"}`}
                onDelete={disabled || busy ? undefined : () => onRemove(f.name)}
                deleteIcon={<X size={12} />}
                onClick={disabled || busy
                  ? undefined
                  : (e) => setRetag({ el: e.currentTarget, name: f.name, role: f.role })}
                title="Click to change what this document is in the analysis"
                sx={{ height: 23, fontSize: 11, maxWidth: 400 }}
              />
            ))}
          </Stack>
        </Box>
      ))}

      <Menu anchorEl={retag?.el ?? null} open={!!retag} onClose={() => setRetag(null)}>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", px: 2, py: 0.5 }}>
          What is this document in the analysis?
        </Typography>
        {roles.map((r) => (
          <MenuItem
            key={r.value} selected={r.value === retag?.role} sx={{ fontSize: 12.5 }}
            onClick={() => {
              if (retag && r.value !== retag.role) onRetag(retag.name, r.value);
              setRetag(null);
            }}
          >
            {r.label}
            {r.value === subject.role && (
              <Typography component="span" sx={{ fontSize: 10.5, color: "text.secondary", ml: 1 }}>
                required
              </Typography>
            )}
          </MenuItem>
        ))}
      </Menu>

      {error && <Typography sx={{ fontSize: 12.5, color: "error.main", mt: 0.75 }}>{error}</Typography>}

      {files.length > 0 && !hasSubject && alternative && (
        <Alert severity="info" sx={{ mt: 2, py: 0.85, fontSize: 12.5 }}
               action={<Button size="small" onClick={() => onSubject(alternative.value)}
                               sx={{ fontSize: 12 }}>Analyse {alternative.label}</Button>}>
          You have attached <b>{alternative.label}</b> content and nothing tagged{" "}
          <b>{subject.label}</b>. Analyse what you have against the Global Template instead?
        </Alert>
      )}

      {files.length > 0 && !hasSubject && !alternative && (
        <Alert severity="warning" sx={{ mt: 2, py: 0.85, fontSize: 12.5 }}>
          <b>The {subject.label} document is missing.</b>{" "}
          {grouped.map((g) => g.label).join(" and ")}
          {grouped.length === 1 ? " is a baseline" : " are baselines"} to compare
          <i>against</i>; this run analyses the {subject.label}, so one document has to be
          tagged <b>{subject.label}</b>.
          <Box component="span" sx={{ display: "block", mt: 0.85, color: "text.secondary" }}>
            {subject.value === "country_as_is"
              ? "Attach the SOP, work instruction, process narrative or workshop transcript that"
                + " describes how the country works today. If one of the documents above is that,"
                + " click its chip and re-tag it — but do not re-tag a template or Best Practice"
                + " extract, which would have the agent report SAP's process as the country's own."
              : "Attach the SAP Best Practice process documentation — a scope item description,"
                + " process flow or test script. If one of the documents above is that, click its"
                + " chip and re-tag it."}
          </Box>
        </Alert>
      )}

      {files.length > 0 && (
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 1 }}>
          Held in <code>{data?.database}.{data?.schema}</code> · deleted in {expiry} of no use ·
          not searchable from the Ask page, InsightLens or any other run
        </Typography>
      )}
    </Box>
  );
}

/** One piece of evidence, with where it came from.
 *
 *  The quote alone was all a reader used to get: a document title, a chunk id
 *  and no way to ask where in the document it was, how it came up, or what
 *  else that passage says. Everything needed to answer that is gathered
 *  during the run -- see rollout/sources.py -- so here it is attached to the
 *  quote it justifies. Collapsed by default: the quote is the finding, the
 *  provenance is what you open when you doubt it. */
function EvidenceRow({ ev, chunk, runId }: {
  ev: { quote: string; side: string; evidence_class: string; doc: string; chunk_id: string;
        heading_path?: string };
  chunk?: RolloutSourceChunk;
  runId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const href = chunk ? rollout.sourceUrl(chunk, runId) : "";
  const heading = chunk?.heading_path || ev.heading_path || "";
  return (
    <Box sx={{ mt: 0.6, pl: 1, borderLeft: 2, borderColor: "divider" }}>
      <Typography sx={{ fontSize: 12.5, fontStyle: "italic" }}>“{ev.quote}”</Typography>
      <Stack direction="row" spacing={1}
             sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75, mt: 0.25 }}>
        <Chip size="small" label={ev.side} sx={{ height: 17, fontSize: 10.5 }} />
        <Chip size="small" label={ev.evidence_class} sx={{ height: 17, fontSize: 10.5 }} />
        {chunk?.category && (
          <Chip size="small" color={chunk.kind === "upload" || chunk.category === "UPLOAD" ? "warning" : "default"}
                label={chunk.kind === "upload" || chunk.category === "UPLOAD" ? "attached" : chunk.category}
                sx={{ height: 17, fontSize: 10.5 }} />
        )}
        <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
          {chunk?.document || ev.doc}
        </Typography>
        {chunk?.score != null && (
          <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>
            score {chunk.score.toFixed(4)}
            {chunk.vector_rank != null ? ` · vector #${chunk.vector_rank}` : ""}
            {chunk.keyword_rank != null ? ` · keyword #${chunk.keyword_rank}` : ""}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="text" onClick={() => setOpen((v) => !v)}
                sx={{ fontSize: 10.5, minWidth: 0, py: 0 }}>
          {open ? "less" : "source"}
        </Button>
      </Stack>
      <Collapse in={open}>
        <Box sx={{ mt: 0.85, p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
          {heading && (
            <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.5 }}>
              {heading}
            </Typography>
          )}
          {chunk?.known === false ? (
            <Typography sx={{ fontSize: 12, color: "warning.main" }}>
              This chunk is not in the run's retrieval log — the quote gate dropped it, so
              there is no passage to show.
            </Typography>
          ) : chunk ? (
            <>
              <Typography sx={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
                {chunk.snippet}{chunk.truncated ? " …" : ""}
              </Typography>
              <Stack direction="row" spacing={1.25} sx={{ mt: 0.75, alignItems: "center" }}>
                <Typography sx={{ fontSize: 10.5, color: "text.disabled", fontFamily: "monospace" }}>
                  {ev.chunk_id}
                </Typography>
                {href && (
                  <Button size="small" variant="text" href={href} target="_blank" rel="noreferrer"
                          startIcon={<FileText size={12} />} sx={{ fontSize: 10.5, py: 0 }}>
                    Open {chunk.file || chunk.document}
                  </Button>
                )}
              </Stack>
            </>
          ) : (
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              No source record for this run. Traceability is kept from this version on;
              runs made earlier show the quote only. <code>{ev.chunk_id}</code>
            </Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

/** One document the analysis drew on, and what it actually supported.
 *
 *  Grouped by document rather than listed per citation: a workshop deck cited
 *  by nine deviations is one thing a reader wants to open, not nine rows. The
 *  chunks under it say which passage carried which finding, and clicking a
 *  finding goes to it. */
function SourceDocument({ doc, sources, runId, onGap }: {
  doc: RolloutSourceDocument;
  sources: RolloutSources;
  runId: string | null;
  onGap: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chunks = Object.values(sources.chunks)
    .filter((c) => c.document === doc.document)
    .sort((a, b) => (b.used_by.length - a.used_by.length));
  const href = chunks[0] ? rollout.sourceUrl(chunks[0], runId) : "";
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
        <FileText size={14} />
        <Typography sx={{ fontSize: 13, fontWeight: 700, flex: "1 1 260px", minWidth: 0 }}>
          {doc.document || "(unrecorded document)"}
        </Typography>
        <Chip size="small" color={doc.kind === "upload" || doc.category === "UPLOAD" ? "warning" : "default"}
              label={doc.kind === "upload" || doc.category === "UPLOAD" ? "attached" : doc.category}
              sx={{ height: 19, fontSize: 10.5 }} />
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {doc.citations} citation{doc.citations === 1 ? "" : "s"} · {doc.chunks} passage
          {doc.chunks === 1 ? "" : "s"}
          {doc.best_score != null ? ` · best score ${doc.best_score.toFixed(4)}` : ""}
        </Typography>
        {href && (
          <Button size="small" variant="text" href={href} target="_blank" rel="noreferrer"
                  sx={{ fontSize: 10.5 }}>Open</Button>
        )}
        <Button size="small" variant="text" onClick={() => setOpen((v) => !v)}
                sx={{ fontSize: 10.5 }}>{open ? "Hide passages" : "Passages"}</Button>
      </Stack>

      <Collapse in={open}>
        <Divider sx={{ my: 1.5 }} />
        <Stack spacing={1.25}>
          {chunks.map((c) => (
            <Box key={c.chunk_id} sx={{ pl: 1, borderLeft: 2, borderColor: "divider" }}>
              <Stack direction="row" spacing={1}
                     sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
                  {c.heading_path || "(no heading)"}
                </Typography>
                <Typography sx={{ fontSize: 10.5, color: "text.disabled", fontFamily: "monospace" }}>
                  {c.chunk_id}
                </Typography>
                {c.score != null && (
                  <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>
                    score {c.score.toFixed(4)}
                  </Typography>
                )}
              </Stack>
              <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.75,
                                whiteSpace: "pre-wrap" }}>
                {c.snippet}{c.truncated ? " …" : ""}
              </Typography>
              <Stack direction="row" spacing={0.85}
                     sx={{ mt: 0.85, flexWrap: "wrap", gap: 0.75, alignItems: "center" }}>
                <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>supports</Typography>
                {c.used_by.map((u, i) => (
                  <Chip key={i} size="small" clickable={u.kind === "deviation"}
                        onClick={u.kind === "deviation" ? () => onGap(u.ref) : undefined}
                        label={`${u.ref || u.kind}${u.side ? ` · ${u.side}` : ""}`}
                        title={u.label}
                        sx={{ height: 18, fontSize: 10.5 }} />
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      </Collapse>
    </Paper>
  );
}

/** A dimension's score, and the findings underneath it.
 *
 *  A bar and a rating out of four is a conclusion with its working hidden.
 *  The rating comes from the deviations recorded on that dimension -- the
 *  submission is rejected if it does not, see the Analysis validator -- so
 *  those deviations, with their evidence, are what the row should open into.
 *  Nothing here is new information; it is the same register, reached from the
 *  number it produced. */
function AlignmentRow({ deviations, chunks, runId, onGap, children }: {
  deviations: Deviation[];
  chunks?: Record<string, RolloutSourceChunk>;
  runId: string | null;
  onGap: (ref: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const can = deviations.length > 0;
  return (
    <Box>
      <Box onClick={can ? () => setOpen((v) => !v) : undefined}
           sx={{ cursor: can ? "pointer" : "default", borderRadius: 1,
                 "&:hover": can ? { bgcolor: "action.hover" } : {} }}>
        {children}
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", ml: "228px" }}>
          {can
            ? `${deviations.length} deviation${deviations.length === 1 ? "" : "s"} on this dimension — click to ${open ? "hide" : "see"} them`
            : "no deviation recorded on this dimension"}
        </Typography>
      </Box>
      <Collapse in={open}>
        <Stack spacing={1.25} sx={{ ml: "228px", mt: 0.75, mb: 1 }}>
          {deviations.map((d) => (
            <Paper key={d.gap_id} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 800, fontFamily: "monospace" }}>
                  {d.gap_id}
                </Typography>
                <Chip size="small" label={d.materiality} sx={{ height: 18, fontSize: 10.5 }} />
                <Chip size="small" label={`GT fit ${d.gt_fit_rating}/4`} sx={{ height: 18, fontSize: 10.5 }} />
                <Box sx={{ flex: 1 }} />
                <Button size="small" variant="text" sx={{ fontSize: 10.5, py: 0 }}
                        onClick={() => onGap(d.gap_id)}>Open in Deviations</Button>
              </Stack>
              <Typography sx={{ fontSize: 12.5, mt: 0.75 }}>{d.exact_difference}</Typography>
              {d.evidence.length > 0 && (
                <Box sx={{ mt: 0.85 }}>
                  {d.evidence.map((e, i) => (
                    <EvidenceRow key={i} ev={e} chunk={chunks?.[e.chunk_id]} runId={runId} />
                  ))}
                </Box>
              )}
            </Paper>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}

/** One past analysis, read inside the history drawer.
 *
 *  The page shows this run across five tabs and a dozen wide tables. None of
 *  that survives being poured into a 560px column, so this is the shape of the
 *  answer rather than the answer itself: the headline, the four scores, what
 *  the workshop has to decide, and the deviations in materiality order. The
 *  exports and "Load into page" are underneath for everything else.
 */
function PastAnalysis({ run, showModel = true }: { run: RolloutRunDetail; showModel?: boolean }) {
  const sem = useSemantic();
  const analysis = "deviations" in run.analysis ? (run.analysis as RolloutAnalysis) : null;
  const scores = "counts" in run.scores ? (run.scores as RolloutScores) : null;
  const gates = "issues" in run.gates ? (run.gates as RolloutGates) : null;
  const counts = scores?.counts;

  // Materiality order, so the drawer's short list is the top of the real list
  // rather than whatever the agent happened to emit first.
  const ORDER: Materiality[] = ["Critical", "High", "Medium", "Low", "Informational"];
  const deviations = [...(analysis?.deviations ?? [])].sort(
    (a, b) => ORDER.indexOf(a.materiality) - ORDER.indexOf(b.materiality),
  );
  const TOP = 8;

  return (
    <Stack spacing={1.75}>
      <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap" }}>
        {run.country && <Chip size="small" variant="outlined" label={run.country} sx={{ height: 19, fontSize: 10 }} />}
        {run.status !== "done" && (
          <Chip size="small" variant="outlined" color={run.status === "failed" ? "error" : "warning"}
                label={run.status} sx={{ height: 19, fontSize: 10 }} />
        )}
        {scores?.subject_label && (
          <Chip size="small" variant="outlined" label={scores.subject_label} sx={{ height: 19, fontSize: 10 }} />
        )}
        {showModel && <Chip size="small" variant="outlined" label={run.model} sx={{ height: 19, fontSize: 10 }} />}
        {run.decisions.length > 0 && (
          <Tooltip title="Verdicts recorded against this analysis">
            <Chip size="small" variant="outlined" color="primary"
                  label={`${run.decisions.length} decided`} sx={{ height: 19, fontSize: 10 }} />
          </Tooltip>
        )}
      </Stack>

      {analysis?.headline && (
        <Typography sx={{ fontSize: 13, lineHeight: 1.65 }}>{analysis.headline}</Typography>
      )}

      {scores && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <ScoreTile label="GT alignment" value={scores.gt_alignment} band={scores.gt_band} accent={sem.fit} />
          <ScoreTile label="Harmonization potential" value={scores.harmonization_potential}
                     band={scores.harmonization_band} accent={sem.localization} />
        </Stack>
      )}

      {counts && (
        <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap" }}>
          {([
            ["fit areas", counts.fit_areas],
            ["deviations", counts.deviations],
            ["localization", counts.localization_items],
            ["backlog", counts.backlog],
            ["open questions", counts.open_questions],
            ["must discuss", counts.workshop?.MUST_DISCUSS ?? 0],
          ] as [string, number][]).map(([label, n]) => (
            <Chip key={label} size="small" variant="outlined" label={`${n} ${label}`}
                  sx={{ height: 19, fontSize: 10 }} />
          ))}
          {counts.workshop_minutes ? (
            <Tooltip title="Workshop time the deviations add up to">
              <Chip size="small" variant="outlined" label={`${counts.workshop_minutes} min`}
                    sx={{ height: 19, fontSize: 10 }} />
            </Tooltip>
          ) : null}
        </Stack>
      )}

      {gates && gates.issues > 0 && (
        <Alert severity={gates.hard ? "warning" : "info"} sx={{ fontSize: 12.5 }}>
          {plural(gates.issues, "quality issue")} — {gates.hard} hard, {gates.soft} soft.
        </Alert>
      )}

      {!!deviations.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>
            Deviations, most material first
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {deviations.slice(0, TOP).map((d) => (
              <Paper key={d.gap_id} sx={{ p: 1.4 }}>
                <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
                  <Typography sx={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
                    {d.gap_id}
                  </Typography>
                  <Chip size="small" color={MATERIALITY_HUE[d.materiality]} variant="outlined"
                        label={d.materiality} sx={{ height: 17, fontSize: 9.5 }} />
                  <Chip size="small" variant="outlined" label={d.primary_type}
                        sx={{ height: 17, fontSize: 9.5 }} />
                  {d.workshop_bucket === "MUST_DISCUSS" && (
                    <Chip size="small" variant="outlined" color="warning" label="must discuss"
                          sx={{ height: 17, fontSize: 9.5 }} />
                  )}
                </Stack>
                <Typography sx={{ fontSize: 12.5, lineHeight: 1.55, mt: 0.7 }}>
                  {d.exact_difference}
                </Typography>
                {d.decision_question && (
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.5, lineHeight: 1.55 }}>
                    {d.decision_question}
                  </Typography>
                )}
              </Paper>
            ))}
          </Stack>
          {deviations.length > TOP && (
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 1 }}>
              {deviations.length - TOP} more, with their evidence and decision options, on the page.
            </Typography>
          )}
        </Box>
      )}

      {!!analysis?.open_questions.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>Left open</Typography>
          <Stack component="ul" spacing={0.4} sx={{ m: 0, mt: 0.25, pl: 2.25 }}>
            {analysis.open_questions.map((q, i) => (
              <Typography key={i} component="li" sx={{ fontSize: 12, lineHeight: 1.55, color: "text.secondary" }}>
                {q}
              </Typography>
            ))}
          </Stack>
        </Box>
      )}

      {!analysis && (
        <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
          This run recorded no analysis{run.status !== "done" ? ` — it ${run.status}.` : "."}
        </Typography>
      )}
    </Stack>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: "flex-start" }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: "text.secondary", minWidth: 84, flexShrink: 0, pt: 0.15 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 12.5 }}>{value}</Typography>
    </Stack>
  );
}

/* -------------------------------------------------------------------- page */

interface Props {
  active: boolean;
  /** The model the analysis runs on, in the plan summary and the history.
   *  Demo Mode turns it off: a client is shown the analysis, not what it
   *  runs on. Its downloads leave the model out as well -- see clientExports. */
  showTechDetails?: boolean;
}

export default function RolloutPage({ active, showTechDetails = true }: Props) {
  const theme = useTheme();
  const semantic = useSemantic();
  const premium = usePremium();
  const [status, setStatus] = useState<RolloutStatus | null>(null);
  // Older servers report no `pdf` block at all. Treat that as "yes" rather
  // than hiding the button: the endpoint answers with its own 503 and the
  // reason, which is better than a button that quietly is not there.
  const pdfReady = status?.pdf?.available !== false;

  const [subjectKey, setSubjectKey] = useState("country_as_is");
  // Whether the analyst has chosen the subject themselves. Until they do it
  // follows the documents: attaching Best Practice content and being asked
  // for a country As-Is was the whole complaint, and a second dropdown that
  // has to be set to match the first is not an answer to it.
  const [subjectTouched, setSubjectTouched] = useState(false);
  const [scopeText, setScopeText] = useState("");
  const [matches, setMatches] = useState<BpmlProcess[]>([]);
  const [scope, setScope] = useState<BpmlProcess | null>(null);
  const [country, setCountry] = useState("");
  const [countryContext, setCountryContext] = useState("");
  const [sapRelease, setSapRelease] = useState("");
  const [gtVersion, setGtVersion] = useState("");
  const [question, setQuestion] = useState("");
  // Every run reads the whole corpus as the Global Template. Runs made while
  // the scope could be narrowed still record what they were pointed at.
  const [plan, setPlan] = useState<RolloutPreview | null>(null);
  const [showOptions, setShowOptions] = useState(false);

  const [session, setSession] = useState(() => {
    try { return localStorage.getItem("rollout.uploads") ?? ""; } catch { return ""; }
  });
  const [uploads, setUploads] = useState<UploadSession | null>(null);
  const [uploading, setUploading] =
    useState<{ filename: string; index: number; total: number; stage: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [stages, setStages] = useState<{ stage: string; status: string; detail: string }[]>([]);
  const [calls, setCalls] = useState<(AgentToolCall & { stage: string })[]>([]);
  // Which call's evidence is open. The log says a call happened; this says what
  // it brought back.
  const [traceCall, setTraceCall] = useState<AgentToolCall | null>(null);
  // The chunks to pick out in the call drawer when it is opened from a quote.
  const [traceHighlight, setTraceHighlight] = useState<string[]>([]);
  // The run's lineage (rollout/lineage.py), fetched when the Investigation tab
  // is opened, and the finding to open there when a tab sends the reader.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [lineageError, setLineageError] = useState("");
  const [traceFocus, setTraceFocus] = useState<string | null>(null);
  // The investigation as the Evidence Agent's console shows it: the context
  // each pass was handed, the reasoning between calls, rejected submissions,
  // the gates -- with the tool calls in their place among them.
  const [log, setLog] = useState<EvidenceLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [asis, setAsis] = useState<AsIsModel | null>(null);
  const [analysis, setAnalysis] = useState<RolloutAnalysis | null>(null);
  const [scores, setScores] = useState<RolloutScores | null>(null);
  const [gates, setGates] = useState<RolloutGates | null>(null);
  const [sources, setSources] = useState<RolloutSources | null>(null);
  const [evaluation, setEvaluation] = useState<AgentEvaluation | Record<string, never> | null>(null);
  // Which gap the Deviations tab should scroll to and flash, when a reader
  // arrives from a source citation rather than from the list.
  const [highlightGap, setHighlightGap] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // Named rather than numbered: the workspace has a dozen tabs, and "show
  // this gap in the register" should not depend on where Deviations sits.
  const [tab, setTab] = useState<string>("summary");
  // True while the New analysis screen is open over a loaded analysis. A run
  // that finishes, or one loaded from history, returns to the workspace.
  const [composing, setComposing] = useState(false);
  // Which agenda item facilitator mode opens on; null while it is closed.
  const [facilitating, setFacilitating] = useState<number | null>(null);
  // Facilitator mode's answers, held until Submit. Kept per run in the
  // browser too, so closing the window or reloading mid-workshop does not
  // lose what the room has already said.
  const [attendees, setAttendees] = useState("");
  const [drafts, setDrafts] = useState<Record<string, WorkshopDraft>>({});
  const [history, setHistory] = useState<RolloutRunSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewer, setReviewer] = useState(() => {
    try { return localStorage.getItem("fitgap.reviewer") ?? ""; } catch { return ""; }
  });
  // Every verdict recorded against this run, oldest first. Loaded with a past
  // run and appended to as decisions are made, so a card can show what was
  // decided instead of looking exactly as it did before the click.
  const [decisions, setDecisions] = useState<RolloutDecision[]>([]);
  const [deciding, setDeciding] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Follow the tail of the live log, but stop following the moment the
  // analyst scrolls up to read an earlier line -- yanking them back to the
  // bottom every few seconds is worse than not following at all.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [calls.length, running]);

  const vocab = status?.vocabulary;
  const types = vocab?.deviation_types ?? {};
  const dispositions = vocab?.dispositions ?? {};
  const states = vocab?.localization_states ?? {};

  useEffect(() => {
    if (!active) return;
    rollout.status().then(setStatus).catch(() => setStatus(null));
    rollout.runs().then(setHistory).catch(() => setHistory([]));
  }, [active]);

  const refreshUploads = useCallback(async (id: string) => {
    if (!id) { setUploads(null); return; }
    try {
      const info = await sessionUploads.status(id);
      if (!info.exists) { setSession(""); setUploads(null); return; }
      setUploads(info);
    } catch { setUploads(null); }
  }, []);

  useEffect(() => {
    try {
      if (session) localStorage.setItem("rollout.uploads", session);
      else localStorage.removeItem("rollout.uploads");
    } catch { /* private mode */ }
  }, [session]);

  useEffect(() => { if (active) void refreshUploads(session); }, [active, session, refreshUploads]);

  useEffect(() => {
    try { localStorage.setItem("fitgap.reviewer", reviewer); } catch { /* private mode */ }
  }, [reviewer]);

  // The scope picker is InsightLens's — both agents read the Global Template
  // hierarchy out of the same BPML process house document in the corpus.
  const [scopeUnknown, setScopeUnknown] = useState(false);

  useEffect(() => {
    const text = scopeText.trim();
    if (!text) { setMatches([]); setScope(null); setScopeUnknown(false); return; }
    const t = setTimeout(() => {
      fitgap.search(text)
        .then((r) => {
          setMatches(r.matches);
          setScope(r.matches[0] ?? null);
          setScopeUnknown(r.matches.length === 0);
        })
        .catch(() => setMatches([]));
    }, 220);
    return () => clearTimeout(t);
  }, [scopeText]);

  useEffect(() => {
    if (!session) { setPlan(null); return; }
    rollout.preview({ scope_bpml: scope?.code ?? "", upload_session: session, categories: [],
                      country, subject: subjectKey })
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [scope, session, country, uploads, subjectKey]);

  async function addUploads(files: File[], role: UploadRole) {
    setUploadError(null);
    let id = session;
    try {
      await uploadSessionDocuments(files, id, role, {
        session: (d) => { id = d.session; setSession(d.session); },
        start: (d) => setUploading({ ...d, stage: "converting" }),
        stage: (d) => setUploading({ index: d.index, total: d.total, filename: d.filename, stage: d.stage }),
        doneFile: () => undefined,
        fileError: (d) => setUploadError(`${d.filename}: ${d.message}`),
        done: (d) => { setUploads(d); setUploading(null); },
        error: (m) => setUploadError(m),
      });
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(null);
      await refreshUploads(id);
    }
  }

  async function retag(name: string, role: UploadRole) {
    try { setUploads(await sessionUploads.retag(session, name, role)); }
    catch (e) { setUploadError((e as Error).message); }
  }

  async function removeUpload(name: string) {
    try { await sessionUploads.remove(session, name); }
    catch (e) { setUploadError((e as Error).message); }
    await refreshUploads(session);
  }

  async function clearUploads() {
    const id = session;
    setSession(""); setUploads(null); setUploadError(null);
    try { if (id) await sessionUploads.drop(id); } catch { /* already swept */ }
  }

  async function start() {
    if (running || !session) return;
    setRunning(true);
    setError(null); setAsis(null); setAnalysis(null); setScores(null); setGates(null);
    setStages([]); setCalls([]); setLog([]); setRunId(null); setTab("summary"); setDecisions([]); setComposing(false);
    setSources(null); setEvaluation(null);
    const ctrl = new AbortController();
    controller.current = ctrl;
    try {
      await runRollout(
        {
          scope_bpml: scope?.code ?? "", upload_session: session, categories: [],
          subject: subjectKey,
          country: country.trim(), country_context: countryContext.trim(),
          sap_release: sapRelease.trim(), gt_version: gtVersion.trim(),
          question: question.trim() || null,
        },
        {
          scope: (d) => setRunId(d.run_id),
          stage: (d) => setStages((prev) => {
            const next = prev.filter((s) => s.stage !== d.stage);
            return [...next, { stage: d.stage, status: d.status, detail: d.detail }];
          }),
          toolCall: (d) => setCalls((prev) => [...prev, d]),
          log: (e) => setLog((prev) => [...prev, e]),
          asis: setAsis,
          gate: setGates,
          analysis: setAnalysis,
          scores: setScores,
          sources: setSources,
          evaluation: setEvaluation,
          done: () => undefined,
          error: setError,
        },
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      controller.current = null;
      rollout.runs().then(setHistory).catch(() => undefined);
    }
  }

  // Which retrieved passages the analysis ended up resting on. Rollout records
  // this per chunk rather than per claim: `used_by` names the deviations and
  // fit areas a chunk carried, so an empty one was retrieved and never used.
  const citedChunks = useMemo(
    () => Object.values(sources?.chunks ?? {})
      .filter((c) => (c.used_by ?? []).length > 0)
      .map((c) => c.chunk_id),
    [sources],
  );

  // Lineage is computed from the stored run, so it is asked for only once the
  // run has finished, and again when a decision is added to it.
  useEffect(() => {
    setLineage(null); setLineageError("");
  }, [runId]);
  useEffect(() => {
    if (tab !== "log" || !runId || running || !analysis) return;
    let live = true;
    rollout.lineage(runId)
      .then((l) => { if (live) { setLineage(l); setLineageError(""); } })
      .catch((e) => { if (live) setLineageError(`Could not trace this run: ${(e as Error).message}`); });
    return () => { live = false; };
  }, [tab, runId, running, analysis, decisions.length]);
  const openCall = (i: number, chunks?: string[]) => {
    const c = calls[i];
    if (!c) return;
    setTraceHighlight(chunks ?? []);
    setTraceCall(c);
  };
  const traceGap = (gapId: string) => { setTraceFocus(gapId); setTab("log"); };

  // Deleting takes two presses. The first arms the button for five seconds and
  // then disarms itself, so a mis-click in a menu costs nothing; the second
  // removes the analysis and, by ON DELETE CASCADE, the decisions recorded
  // against it, which is why it is not a single click.
  // The two presses this used to arm for itself are the history drawer's job
  // now -- `armDelete` below -- because all three panels wanted them and only
  // this one had them. An analysis carries decisions somebody recorded against
  // it, so a stray click must not be enough.
  async function remove(id: string) {
    try {
      await rollout.deleteRun(id);
      // A deleted run must not be left on screen as though it were still there.
      if (runId === id) { setRunId(null); setCalls([]); setLog([]); setAsis(null); setAnalysis(null);
                          setScores(null); setGates(null); setSources(null); setDecisions([]); }
      setHistory(await rollout.runs());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** The history summaries as the drawer's cards. */
  const historyCards: HistoryCard[] = useMemo(
    () => history.map((r) => ({
      id: r.id,
      title: `${r.scope_label}${r.country ? ` · ${r.country}` : ""}`,
      startedAt: r.started_at,
      badges: r.status !== "done"
        ? (
          <Chip size="small" variant="outlined"
                color={r.status === "failed" ? "error" : "warning"}
                label={r.status} sx={{ height: 18, fontSize: 9.5 }} />
        )
        : null,
      meta: [
        r.gt_alignment !== null ? `GT ${r.gt_alignment}%` : "",
        r.harmonization_potential !== null ? `harm ${r.harmonization_potential}%` : "",
        r.deviations ? plural(r.deviations, "deviation") : "",
        r.must_discuss ? `${r.must_discuss} must discuss` : "",
      ].filter(Boolean).join(" · "),
    })),
    [history],
  );

  async function loadRun(id: string) {
    try {
      const run = await rollout.run(id);
      setRunId(run.id);
      setScopeText(run.scope_bpml);
      setCountry(run.country || "");
      setCountryContext(run.country_context || "");
      setSapRelease(run.sap_release || "");
      setGtVersion(run.gt_version || "");
      setQuestion(run.question || "");
      setSubjectKey(run.subject || "country_as_is");
      setSubjectTouched(true);   // the record decides, not the current uploads
      setAsis("steps" in run.asis ? (run.asis as AsIsModel) : null);
      setAnalysis("deviations" in run.analysis ? (run.analysis as RolloutAnalysis) : null);
      setScores("counts" in run.scores ? (run.scores as RolloutScores) : null);
      setGates("issues" in run.gates ? (run.gates as RolloutGates) : null);
      setDecisions(run.decisions ?? []);
      setSources("chunks" in (run.sources ?? {}) ? (run.sources as RolloutSources) : null);
      setEvaluation(run.evaluation ?? {});
      // The log is part of the record now, so a reopened run shows its working
      // rather than its conclusions alone.
      setCalls(run.calls ?? []);
      setLog(run.log?.length ? run.log : logFromCalls(run.calls ?? []));
      setStages([]); setError(null); setTab("summary"); setComposing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!runId) { setDrafts({}); return; }
    try { setDrafts(JSON.parse(localStorage.getItem(`fitgap.drafts.${runId}`) ?? "{}")); } catch { setDrafts({}); }
  }, [runId]);

  function draft(gapId: string, d: WorkshopDraft) {
    setDrafts((prev) => {
      const next = { ...prev, [gapId]: d };
      try { if (runId) localStorage.setItem(`fitgap.drafts.${runId}`, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }

  async function submitWorkshop(): Promise<{ saved: number; session: string }> {
    if (!runId || !scores) throw new Error("No analysis loaded");
    const answers = scores.agenda.map((a) => {
      const d = drafts[a.gap_id];
      return { gap_id: a.gap_id, verdict: d?.verdict ?? "", option_index: d?.option,
               rationale: d?.rationale.trim() || undefined };
    });
    const out = await rollout.submitWorkshop(runId, {
      facilitator: reviewer.trim(),
      attendees: attendees.split(",").map((x) => x.trim()).filter(Boolean),
      answers,
    });
    setDecisions((prev) => [...prev, ...out.decisions]);
    setDrafts({});
    try { localStorage.removeItem(`fitgap.drafts.${runId}`); } catch { /* private mode */ }
    return { saved: out.decisions.length, session: out.session.id };
  }

  async function decide(gapId: string, verdict: "accept" | "reject" | "defer", extra?: DecisionExtra) {
    // No anonymous verdicts. This used to fall back to "unnamed", which meant
    // a click with an empty name field wrote a row nobody could be asked
    // about -- the opposite of what a decision log is for. The buttons are
    // disabled without a name; this is the backstop.
    if (!runId || !reviewer.trim() || deciding[gapId]) return;
    setDeciding((d) => ({ ...d, [gapId]: verdict }));
    try {
      const saved = await rollout.decide(runId, {
        gap_id: gapId, reviewer: reviewer.trim(), verdict,
        ...(extra?.option !== undefined ? { option_index: extra.option } : {}),
        ...(extra?.rationale ? { rationale: extra.rationale } : {}),
      });
      setDecisions((prev) => [...prev, saved]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeciding((d) => {
        const next = { ...d };
        delete next[gapId];
        return next;
      });
    }
  }

  // Grouped once per render rather than filtered inside every card.
  const decisionsByGap = useMemo(() => {
    const by: Record<string, RolloutDecision[]> = {};
    for (const d of decisions) (by[d.gap_id] ??= []).push(d);
    return by;
  }, [decisions]);

  // Arriving at a gap from somewhere else -- a source citation, an alignment
  // row -- should land on it, not at the top of a list of thirteen.
  useEffect(() => {
    if (!highlightGap || tab !== "deviations") return;
    const el = document.getElementById(`gap-${highlightGap}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    const t = setTimeout(() => setHighlightGap(""), 2200);
    return () => clearTimeout(t);
  }, [highlightGap, tab]);

  const runningStage = stages.find((s) => s.status === "running")?.stage ?? "";
  const must = useMemo(
    () => (analysis?.deviations ?? []).filter((d) => d.workshop_bucket === "MUST_DISCUSS"),
    [analysis]);
  const attachedRoles = useMemo(
    () => new Set((uploads?.files ?? []).map((f) => f.role)),
    [uploads]);
  // An As-Is wins when both are attached: it is the richer analysis, and it
  // is what someone who attached one came for.
  const inferredSubject =
    attachedRoles.has("as_is") ? "country_as_is"
      : attachedRoles.has("sap_bp") ? "sap_best_practice"
        : null;

  useEffect(() => {
    if (!subjectTouched && inferredSubject && inferredSubject !== subjectKey) {
      setSubjectKey(inferredSubject);
    }
  }, [inferredSubject, subjectTouched, subjectKey]);

  const subject: RolloutSubject =
    status?.subjects?.find((x) => x.value === subjectKey)
    ?? { value: "country_as_is", label: "Country As-Is", role: "as_is",
         localization: true, score_b: true };
  const ready = !!plan?.ready && !scopeUnknown && !!status?.anthropic_key;

  const workspace = !!(analysis && scores) && !composing;
  const templateName = scope ? `${scope.code} ${scope.name}`
    : (analysis?.template_process ?? "").split(" (")[0] || "Global Template";
  const decided = new Set(decisions.map((d) => d.gap_id)).size;
  // The agenda is complete when every Must-discuss item has a decision on
  // record, from facilitator mode or any tab. Drafts do not count.
  const agendaDone = !!scores?.agenda.length && scores.agenda.every((a) => decisionsByGap[a.gap_id]?.length);
  const TABS: { key: string; label: string; done?: boolean }[] = analysis ? [
    { key: "summary", label: "Summary" },
    { key: "brief", label: "Brief" },
    { key: "workshop", label: `Workshop agenda (${scores?.agenda.length ?? must.length})`, done: agendaDone },
    { key: "deviations", label: `Deviations (${analysis.deviations.length})` },
    ...(asis ? [{ key: "process", label: `Process alignment (${asis.steps.length})` }] : []),
    { key: "localization", label: subject.localization ? `Localization (${analysis.localization.length})` : "Localization — n/a" },
    { key: "dimensions", label: "Dimensions" },
    { key: "backlog", label: `Backlog (${analysis.backlog.length})` },
    { key: "asis", label: `${subject.label} model (${asis?.steps.length ?? 0})` },
    { key: "sources", label: `Sources${sources ? ` (${sources.documents.length})` : ""}` },
    { key: "gates", label: "Quality gates" },
    { key: "log", label: `Traceability${calls.length ? ` (${calls.length})` : ""}` },
    { key: "evaluation", label: "Evaluation" },
  ] : [];
  const openGap = (gapId: string) => { setTab("deviations"); setHighlightGap(gapId); };
  // Whether this run rated its dimensions against SAP Best Practice too.
  const sapRated = !!subject.score_b && !!scores?.sap_bp_dimensions?.some((d) => d.rating !== null);
  const setupStep = !(uploads?.files ?? []).some((f) => f.role === subject.role) ? 1 : ready ? 3 : 2;

  const historyButton = (
    <BandButton onClick={() => setHistoryOpen(true)} startIcon={<History size={14} />}
                title="Past analyses — read one beside the one on the page">
      {history.length ? `History (${history.length})` : "History"}
    </BandButton>
  );

  return (
    <Box sx={{ height: "100%", overflow: "auto", bgcolor: "background.default" }}>
      {workspace && analysis && scores ? (
        <>
          <ObjectHeader
            breadcrumb={`Fit-Gap Copilot / Analyses${runId ? ` / ${runId}` : ""}`}
            title={`${templateName}${country ? ` — ${country}` : ""}`}
            badge={decided ? `${decided} of ${analysis.deviations.length} decided` : "Proposed · awaiting workshop"}
            meta={`${subject.label} compared with the Global Template${
              scope ? "" : analysis.template_process ? " · template process identified by the agent" : ""}${
              question ? ` · “${question.length > 90 ? question.slice(0, 90) + "…" : question}”` : ""}`}
            actions={
              <>
                {historyButton}
                <BandButton onClick={() => setComposing(true)} startIcon={<Plus size={14} />}>New analysis</BandButton>
                {runId && (
                  <>
                    <BandButton href={rollout.exportUrl(runId, "md")} startIcon={<Download size={14} />}
                                title="The same pack as Markdown, to paste into a wiki or Cloud ALM">Markdown</BandButton>
                    <BandButton href={rollout.exportUrl(runId, "json")}>JSON</BandButton>
                    <BandButton primary href={pdfReady ? rollout.exportUrl(runId, "pdf") : undefined} disabled={!pdfReady} startIcon={<FileDown size={14} />}
                                title={pdfReady ? "The workshop pack as a PDF: run-of-show, decisions so far, register, risk view and evidence"
                                  : `This server cannot render PDFs. ${status?.pdf?.detail ?? ""}`}>
                      Download PDF
                    </BandButton>
                  </>
                )}
              </>
            }
          />

          <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 1, md: 3 },
                                            display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
                  sx={{ flex: 1, minWidth: 0, minHeight: 46,
                        "& .MuiTab-root": { minHeight: 46, textTransform: "none", fontSize: 13.5, fontWeight: 500, px: 1.75 },
                        "& .Mui-selected": { fontWeight: 600 } }}>
              {TABS.map((t) => (
                <Tab key={t.key} value={t.key} label={t.label}
                     {...(t.done ? {
                       icon: <CheckCircle2 size={16} aria-label="completed" color={theme.palette.success.main} />,
                       iconPosition: "end" as const,
                       title: "Every agenda item has a decision",
                     } : {})} />
              ))}
            </Tabs>
            {runId && (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", py: 0.75 }}>
                <Typography component="label" htmlFor="rollout-reviewer"
                            sx={{ fontSize: 12, color: reviewer.trim() ? "text.secondary" : "error.main", whiteSpace: "nowrap" }}>
                  Deciding as
                </Typography>
                <TextField id="rollout-reviewer" size="small" placeholder="Your name" value={reviewer}
                           onChange={(e) => setReviewer(e.target.value)}
                           error={!reviewer.trim() && decisions.length === 0}
                           sx={{ width: 180, "& .MuiInputBase-input": { fontSize: 12.5, py: 0.75 },
                                 "& .MuiOutlinedInput-root": { borderRadius: RADIUS } }} />
              </Stack>
            )}
          </Paper>

          <Box sx={{ px: { xs: 2, md: 4 }, py: 3 }}>
            {error && <Alert severity="error" sx={{ mb: 2, fontSize: 12.5, borderRadius: RADIUS }}>{error}</Alert>}
            {tab === "summary" && (
              <ScoreCards analysis={analysis} scores={scores} subject={subject} types={types} onTab={setTab} />
            )}
            {tab === "summary" && (
              <SummaryView analysis={analysis} scores={scores} subject={subject} onGap={openGap} onTab={setTab} />
            )}
            {tab === "brief" && (
              <BriefView analysis={analysis} scores={scores} subject={subject} country={country} onGap={openGap} />
            )}
            {tab === "process" && asis && (
              <ProcessAlignmentView asis={asis} analysis={analysis} scores={scores} subject={subject}
                                    decisions={decisionsByGap} reviewer={reviewer} deciding={deciding}
                                    onDecide={runId ? (g, v, x) => void decide(g, v, x) : undefined} onOpenGap={openGap} />
            )}
            {tab === "log" && runId && analysis && !running && (
              <InvestigationView exportUrl={(f) => rollout.lineageExportUrl(runId, f)} lineage={lineage} error={lineageError} focus={traceFocus}
                                 onOpenCall={openCall} onOpenLogs={() => setLogOpen(true)} logCount={log.length} />
            )}
            {tab === "log" && !(runId && analysis && !running) && (
              <Stack spacing={2}>
        {/* --------------------------------------------------- the investigation */}
        {/* Its own panel, not a corner of Progress. Progress renders only while
            there is no analysis yet, so the log used to vanish at the exact
            moment the run finished -- and a run reopened from history, which
            always has an analysis, never showed one at all. The log is the
            working behind the answer; it outlives the run that produced it. */}
        {(calls.length > 0 || running || (runId && !running)) && (
          <Paper variant="outlined" sx={{ p: 2.75, borderRadius: RADIUS }}>
            <SectionLabel icon={<ListChecks size={14} />}
              right={
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                  {calls.length > 0 && (
                    <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                      {calls.length} call{calls.length === 1 ? "" : "s"}
                    </Typography>
                  )}
                  <Tooltip title={log.length
                    ? `Open the step-by-step log — the context each pass was handed, the agent's reasoning, every call, rejected submissions and the gates (${log.length} steps)`
                    : "The step-by-step log appears here as the run goes"}>
                    <span>
                      <Button variant="outlined" size="small" disabled={log.length === 0}
                              startIcon={<Terminal size={15} />} onClick={() => setLogOpen(true)}
                              sx={{ textTransform: "none", borderRadius: RADIUS }}>
                        Logs{log.length ? ` (${log.length})` : ""}
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              }>
              Investigation
            </SectionLabel>
            {calls.length === 0 && !running ? (
              <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                This run was recorded before the log kept what each call returned.
                Run the analysis again to get a log you can open.
              </Typography>
            ) : (
            <Box ref={logRef}
                 sx={{ mt: 1.5, maxHeight: 220, overflowY: "auto", p: 1, borderRadius: 1.5,
                       bgcolor: alpha(theme.palette.text.primary, 0.035) }}>
              {calls.some((c) => c.trace) ? (
                <Typography sx={{ fontSize: 10.5, color: "text.disabled", mb: 0.75 }}>
                  Click a call to see what it returned.
                </Typography>
              ) : !running && calls.length > 0 ? (
                <Typography sx={{ fontSize: 10.5, color: "text.disabled", mb: 0.75 }}>
                  This run was recorded before the log kept what each call returned.
                </Typography>
              ) : null}
              {calls.map((c, i) => (
                <Stack key={i} direction="row" spacing={1}
                       onClick={c.trace ? () => setTraceCall(c) : undefined}
                       role={c.trace ? "button" : undefined}
                       tabIndex={c.trace ? 0 : undefined}
                       onKeyDown={c.trace ? (e) => {
                         if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTraceCall(c); }
                       } : undefined}
                       sx={{ alignItems: "baseline", fontFamily: "monospace",
                             // Only a call that kept a trace opens anything. A
                             // failed one stays a log line rather than a button
                             // that opens an apology.
                             cursor: c.trace ? "pointer" : "default",
                             borderRadius: 0.75, px: 0.5, mx: -0.5, py: 0.15,
                             transition: "background-color .12s",
                             "&:hover": c.trace
                               ? { bgcolor: alpha(theme.palette.text.primary, 0.06) }
                               : undefined,
                             "&:focus-visible": {
                               outline: `2px solid ${theme.palette.primary.main}`,
                               outlineOffset: 1,
                             } }}>
                  <Typography component="span" sx={{ fontSize: 10.5, color: "text.disabled",
                                                     minWidth: 22, textAlign: "right" }}>
                    {i + 1}
                  </Typography>
                  <Typography component="span"
                              sx={{ fontSize: 10.5, minWidth: 62,
                                    color: ENGINE_COLOUR[c.engine] ?? "primary.main",
                                    textDecoration: c.trace ? "underline" : "none",
                                    textDecorationStyle: "dotted",
                                    textUnderlineOffset: 3 }}>
                    {c.tool}
                  </Typography>
                  <Typography component="span"
                              sx={{ fontSize: 12, flex: 1,
                                    color: c.error ? "error.main" : "text.secondary",
                                    wordBreak: "break-word" }}>
                    {c.summary || c.error}
                    {/* Which store the call read. The corpus is one table
                        with a category per row and the attachment is in a
                        database of its own, so "searched" without saying
                        where is not an answer. */}
                    {c.sources?.label ? (
                      <Box component="span" sx={{ color: "text.disabled" }}>
                        {"  ·  "}{String(c.sources.label)}
                      </Box>
                    ) : null}
                  </Typography>
                  <Typography component="span" sx={{ fontSize: 10.5, color: "text.disabled" }}>
                    {c.ms}ms
                  </Typography>
                </Stack>
              ))}
              {running && (
                // Between tool calls the agent is generating, which is most
                // of the wall clock. A log that goes quiet for a minute with
                // no line saying why reads as a hang.
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: calls.length ? 0.5 : 0 }}>
                  <CircularProgress size={9} />
                  <Typography sx={{ fontSize: 12, color: "text.disabled", fontStyle: "italic" }}>
                    {runningStage === "gates" ? "checking the analysis…" : "the agent is thinking…"}
                  </Typography>
                </Stack>
              )}
        </Box>
            )}
          </Paper>
        )}
              </Stack>
            )}
            {tab === "workshop" && (
              <WorkshopAgendaView analysis={analysis} scores={scores} subject={subject} types={types} states={states}
                                  decisions={decisionsByGap} reviewer={reviewer} deciding={deciding}
                                  onDecide={runId ? (g, v, x) => void decide(g, v, x) : undefined}
                                  onOpenGap={openGap} onFacilitate={setFacilitating} runId={runId} />
            )}
            {tab === "deviations" && (
              <DeviationRegisterView deviations={analysis.deviations} subject={subject} types={types}
                                     dispositions={dispositions} states={states} decisions={decisionsByGap}
                                     reviewer={reviewer} deciding={deciding}
                                     onDecide={runId ? (g, v, x) => void decide(g, v, x) : undefined}
                                     focusGap={highlightGap} fileStem={runId ?? "fit-gap"}
                                     onTrace={runId && !running ? traceGap : undefined}
                                     renderEvidence={(e) => <EvidenceRow ev={e} chunk={sources?.chunks?.[e.chunk_id]} runId={runId} />} />
            )}
            <FacilitatorView open={facilitating !== null} start={facilitating ?? 0}
                             onClose={() => setFacilitating(null)}
                             attendees={attendees} onAttendees={setAttendees}
                             analysis={analysis} scores={scores} subject={subject} country={country}
                             decisions={decisionsByGap} reviewer={reviewer} onReviewer={setReviewer}
                             drafts={drafts} onDraft={draft} onSubmit={runId ? submitWorkshop : undefined} runId={runId} />
            {["localization", "dimensions", "backlog", "asis", "gates", "sources"].includes(tab) && (
              <Paper variant="outlined" sx={{ borderRadius: RADIUS }}>
            <Box sx={{ p: 2 }}>
              {/* ------------------------------------------------ workshop scope */}
              {/* ------------------------------------------ localization advisory */}
              {tab === "localization" && (
                <Stack spacing={1.5}>
                  <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                    {subject.localization
                      ? "Only findings that interact with this process. A requirement is confirmed"
                        + " statutory only where an explicit source says so — country-specific is"
                        + " not the same as legally required."
                      : `Not applicable: this run analyses the ${subject.label} against the Global`
                        + " Template and has no country in it, so there is nobody for a statutory"
                        + " requirement to apply to. Localization findings are reported in a"
                        + " Country As-Is run."}
                  </Typography>
                  {analysis.localization.map((item, i) => (
                    <Paper key={i} variant="outlined" sx={{ p: 2 }}>
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                        <Globe2 size={14} color={theme.palette.info.main} />
                        <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{item.topic}</Typography>
                        <Chip size="small" label={item.status}
                              color={item.status === "Confirmed" ? "info" : item.status === "Candidate" ? "warning" : "default"}
                              sx={{ height: 20, fontSize: 10.5 }} />
                      </Stack>
                      <Stack spacing={0.75} sx={{ mt: 1 }}>
                        <Row label="Relevance" value={item.relevance} />
                        <Row label="Requirement" value={item.requirement} />
                        <Row label="SAP" value={item.sap_capability} />
                        <Row label="Template" value={item.gt_capability} />
                        <Row label="Country" value={item.as_is_handling} />
                        <Row label="Path" value={item.recommended_path} />
                        <Row label="Decision" value={item.workshop_decision} />
                        <Row label="Owner" value={item.owner.join(", ")} />
                      </Stack>
                    </Paper>
                  ))}
                  {analysis.localization.length === 0 && (
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                      No localization topic interacts with this process, on the evidence read.
                    </Typography>
                  )}
                </Stack>
              )}

              {/* --------------------------------------------- scores and heatmap */}
              {tab === "dimensions" && (
                <Stack spacing={2}>
                  <Typography sx={{ fontSize: 12, color: "text.secondary", fontStyle: "italic" }}>{scores.formula}</Typography>
                  <Box>
                    <SectionLabel icon={<Scale size={14} />}>
                      {sapRated ? "Alignment by dimension — Global Template and SAP Best Practice" : "Alignment by dimension"}
                    </SectionLabel>
                    <Stack spacing={1.25}>
                      {scores.dimensions.map((row) => (
                        <AlignmentRow key={row.dimension}
                                      deviations={analysis.deviations.filter(
                                        (d) => d.dimension === row.dimension)}
                                      chunks={sources?.chunks} runId={runId}
                                      onGap={(ref) => { setTab("deviations"); setHighlightGap(ref); }}>
                          <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                            <Typography sx={{ fontSize: 12.5, fontWeight: 600, minWidth: 220 }}>
                              {row.label}
                            </Typography>
                            <Typography sx={{ fontSize: 12, color: "text.secondary", minWidth: 34 }}>
                              {row.weight}%
                            </Typography>
                            {/* Template, and SAP Best Practice beneath it when the
                                run rated against both: one bar per side. */}
                            <Stack spacing={0.6} sx={{ flex: 1, minWidth: 0 }}>
                              {[
                                { side: "Global Template", r: row },
                                ...(sapRated ? [{ side: "SAP Best Practice",
                                                  r: scores.sap_bp_dimensions.find((b) => b.dimension === row.dimension) }] : []),
                              ].map(({ side, r }) => (
                                <Stack key={side} direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                                  {sapRated && (
                                    <Typography sx={{ fontSize: 11.5, color: "text.secondary", width: 112, flex: "none" }}>{side}</Typography>
                                  )}
                                  <Box sx={{ flex: 1, height: 7, borderRadius: 4, bgcolor: "divider", overflow: "hidden" }}>
                                    <Box sx={{ width: `${r?.percent ?? 0}%`, height: "100%",
                                               bgcolor: (r?.percent ?? 0) >= 75 ? semantic.fit
                                                 : (r?.percent ?? 0) >= 50 ? semantic.minor : semantic.material }} />
                                  </Box>
                                  <Typography sx={{ fontSize: 12.5, fontWeight: 700, minWidth: 54, textAlign: "right" }}>
                                    {r?.rating == null ? "—" : `${r.rating}/4`}
                                  </Typography>
                                </Stack>
                              ))}
                            </Stack>
                          </Stack>
                          {row.note && (
                            <Typography sx={{ fontSize: 12, color: "text.secondary", ml: "228px" }}>{row.note}</Typography>
                          )}
                        </AlignmentRow>
                      ))}
                    </Stack>
                  </Box>

                  <Box>
                    <SectionLabel icon={<Layers size={14} />}>Deviation heatmap</SectionLabel>
                    <Stack spacing={0.85}>
                      {scores.heatmap.map((row) => (
                        <Stack key={row.dimension} direction="row" spacing={1.5}
                               onClick={row.deviations ? () => {
                                 const first = analysis.deviations.find(
                                   (d) => d.dimension === row.dimension);
                                 if (first) { setTab("deviations"); setHighlightGap(first.gap_id); }
                               } : undefined}
                               sx={{ alignItems: "center", py: 1, borderBottom: 1,
                                     borderColor: "divider",
                                     cursor: row.deviations ? "pointer" : "default",
                                     "&:hover": row.deviations ? { bgcolor: "action.hover" } : {} }}>
                          <Typography sx={{ fontSize: 12.5, minWidth: 220 }}>{row.label}</Typography>
                          <Dot colour={row.focus === "High" ? semantic.material
                            : row.focus === "Medium" ? semantic.minor
                              : row.focus === "Low" ? semantic.fit : semantic.unknown}
                               title={`${row.focus} focus`} />
                          <Typography sx={{ fontSize: 12.5, color: "text.secondary", minWidth: 150 }}>
                            {row.deviations} deviation{row.deviations === 1 ? "" : "s"}
                            {row.must_discuss ? ` · ${row.must_discuss} to decide` : ""}
                          </Typography>
                          {row.localization > 0 && (
                            <Chip size="small" icon={<Globe2 size={10} />} label={`${row.localization} localization`}
                                  sx={{ height: 19, fontSize: 10.5, bgcolor: alpha(theme.palette.info.main, 0.12), color: "info.main" }} />
                          )}
                          <Box sx={{ flex: 1 }} />
                          <Typography sx={{ fontSize: 10.5, color: "text.secondary", fontFamily: "monospace" }}>
                            {row.gap_ids.join(" ")}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  </Box>

                  {analysis.sap_bp_note && (
                    <Alert severity="info" sx={{ fontSize: 12.5 }}>{analysis.sap_bp_note}</Alert>
                  )}
                </Stack>
              )}

              {/* ------------------------------------------- backlog candidates */}
              {tab === "backlog" && (
                <Stack spacing={1.5}>
                  <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                    Candidates only. A hypothesis does not become project scope until the workshop
                    validates it — each one names the gap it came from.
                  </Typography>
                  {analysis.backlog.map((item, i) => (
                    <Paper key={i} variant="outlined" sx={{ p: 2 }}>
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
                        <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{item.title}</Typography>
                        <Chip size="small" label={item.priority} sx={{ height: 20, fontSize: 10.5 }} />
                        <Chip size="small" variant="outlined" label={item.build_type} sx={{ height: 20, fontSize: 10.5 }} />
                        {item.localization_flag && (
                          <Chip size="small" icon={<Globe2 size={10} />} label="localization" color="info"
                                sx={{ height: 20, fontSize: 10.5 }} />
                        )}
                        <Box sx={{ flex: 1 }} />
                        <Typography sx={{ fontSize: 10.5, fontFamily: "monospace", color: "text.secondary" }}>
                          {item.gap_id}
                        </Typography>
                      </Stack>
                      <Typography sx={{ fontSize: 12.5, mt: 0.75 }}>{item.requirement}</Typography>
                      {item.business_value && (
                        <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.75 }}>
                          {item.business_value}
                        </Typography>
                      )}
                      {item.acceptance_criteria.length > 0 && (
                        <Box sx={{ mt: 0.75 }}>
                          {item.acceptance_criteria.map((c, n) => (
                            <Typography key={n} sx={{ fontSize: 12.5 }}>· {c}</Typography>
                          ))}
                        </Box>
                      )}
                    </Paper>
                  ))}
                  {analysis.backlog.length === 0 && (
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                      No finding is evidenced well enough to propose as a backlog candidate yet.
                    </Typography>
                  )}
                  {analysis.open_questions.length > 0 && (
                    <>
                      <Divider sx={{ my: 1.5 }} />
                      <SectionLabel icon={<CircleHelp size={14} />}>Evidence requests</SectionLabel>
                      {analysis.open_questions.map((q, i) => (
                        <Typography key={i} sx={{ fontSize: 12.5 }}>· {q}</Typography>
                      ))}
                    </>
                  )}
                </Stack>
              )}

              {/* ------------------------------------------------ the As-Is model */}
              {tab === "asis" && asis && (
                <Stack spacing={1.5}>
                  <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                    {asis.process_name}
                  </Typography>
                  {asis.steps.map((s) => (
                    <Paper key={s.step_id} variant="outlined" sx={{ p: 2 }}>
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                        <Typography sx={{ fontSize: 12.5, fontFamily: "monospace", color: "text.secondary" }}>
                          {s.step_id}
                        </Typography>
                        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{s.name}</Typography>
                        <Box sx={{ flex: 1 }} />
                        <Chip size="small" label={s.confidence} sx={{ height: 19, fontSize: 10.5 }} />
                      </Stack>
                      <Stack spacing={0.6} sx={{ mt: 0.75 }}>
                        <Row label="Actor" value={s.actor} />
                        <Row label="System" value={s.system} />
                        <Row label="Rule" value={s.business_rule} />
                        <Row label="Decision" value={s.decision} />
                        <Row label="Control" value={s.control} />
                        <Row label="Output" value={s.output} />
                        <Row label="Exception" value={s.exception} />
                        <Row label="Timing" value={s.timing} />
                      </Stack>
                    </Paper>
                  ))}
                  {asis.normalisation_notes.length > 0 && (
                    <>
                      <SectionLabel icon={<ShieldCheck size={14} />}>Terminology normalised</SectionLabel>
                      {asis.normalisation_notes.map((n, i) => (
                        <Typography key={i} sx={{ fontSize: 12.5 }}>· {n}</Typography>
                      ))}
                    </>
                  )}
                  {asis.evidence_gaps.length > 0 && (
                    <>
                      <SectionLabel icon={<CircleHelp size={14} />}>
                        Evidence gaps in the {subject.label}
                      </SectionLabel>
                      {asis.evidence_gaps.map((g, i) => (
                        <Typography key={i} sx={{ fontSize: 12.5 }}>· {g}</Typography>
                      ))}
                    </>
                  )}
                </Stack>
              )}

              {/* -------------------------------------------------- quality gates */}
              {tab === "evaluation" && (
                <AgentEvaluationView evaluation={evaluation} running={running} agent="rollout" />
              )}

              {tab === "gates" && (
                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
                    <Chip size="small" color={gates?.hard ? "error" : "success"}
                          label={`${gates?.hard ?? 0} hard`} sx={{ height: 22, fontSize: 12.5, fontWeight: 700 }} />
                    <Chip size="small" label={`${gates?.soft ?? 0} soft`} sx={{ height: 22, fontSize: 12.5 }} />
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                      Hard issues were repaired: bad evidence dropped, unevidenced statutory claims
                      demoted, extensions without standard options turned back into decisions.
                    </Typography>
                  </Stack>
                  {(gates?.items ?? []).map((issue, i) => (
                    <Stack key={i} direction="row" spacing={1.25} sx={{ alignItems: "flex-start" }}>
                      <Chip size="small" label={issue.gate} color={issue.severity === "hard" ? "error" : "default"}
                            sx={{ height: 19, fontSize: 10.5, minWidth: 40 }} />
                      <Typography sx={{ fontSize: 12.5 }}>
                        {issue.gap_id && <b>{issue.gap_id} — </b>}{issue.detail}
                      </Typography>
                    </Stack>
                  ))}
                  {(gates?.not_checked ?? []).length > 0 && (
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 1 }}>
                      Not checked mechanically: {(gates?.not_checked ?? []).join("; ")}.
                    </Typography>
                  )}
                </Stack>
              )}

              {/* --------------------------------------------- traceability */}
              {tab === "sources" && (
                <Stack spacing={1.5}>
                  {!sources ? (
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                      No source record for this run. The retrieval log is kept with a run from
                      this version on; a run made earlier shows its quotes but cannot show where
                      in a document they came from.
                    </Typography>
                  ) : (
                    <>
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
                        <Chip size="small" label={`${sources.documents.length} documents`}
                              sx={{ height: 22, fontSize: 12.5, fontWeight: 700 }} />
                        <Chip size="small" label={`${sources.cited_total} chunks cited`}
                              sx={{ height: 22, fontSize: 12.5 }} />
                        <Chip size="small" label={`${sources.unused_total} read, not used`}
                              sx={{ height: 22, fontSize: 12.5 }} />
                        <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                          Everything the analysis rests on. The second number is the honest one:
                          it separates “the corpus does not say” from “the agent did not look”.
                        </Typography>
                      </Stack>

                      {sources.documents.map((doc) => (
                        <SourceDocument key={doc.document} doc={doc} sources={sources}
                                        runId={runId} onGap={(ref) => {
                                          setTab("deviations");
                                          setHighlightGap(ref);
                                        }} />
                      ))}
                    </>
                  )}
                </Stack>
              )}
            </Box>
              </Paper>
            )}
          </Box>
        </>
      ) : (
        <>
          <ObjectHeader
            breadcrumb="Fit-Gap Copilot / New analysis"
            title="Compare a process with the Global Template"
            meta="SAP Activate Fit-to-Standard. Reads the subject you attach, compares it against the Global Template, and turns the difference into a short list of decisions for the workshop."
            actions={
              <>
                {historyButton}
                {analysis && scores && (
                  <BandButton onClick={() => setComposing(false)} startIcon={<ArrowLeft size={14} />}>Back to the analysis</BandButton>
                )}
              </>
            }
          />
          <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 2, md: 4 }, display: "flex", gap: 4, flexWrap: "wrap" }}>
            {["Sources", "Scope", "Review and run"].map((label, i) => {
              const n = i + 1;
              const on = n === setupStep;
              const done = n < setupStep;
              return (
                <Stack key={label} direction="row" spacing={1.25}
                       sx={{ alignItems: "center", py: 1.75, borderBottom: 2, borderColor: on ? premium.accent : "transparent" }}>
                  <Box sx={{ width: 26, height: 26, borderRadius: "13px", display: "grid", placeItems: "center",
                             fontSize: 12.5, fontWeight: 600,
                             bgcolor: on || done ? "text.primary" : "action.selected",
                             color: on || done ? "background.paper" : "text.secondary" }}>
                    {done ? <CheckCircle2 size={14} /> : n}
                  </Box>
                  <Typography sx={{ fontSize: 13.5, fontWeight: on ? 600 : 500, color: on ? "text.primary" : "text.secondary" }}>{label}</Typography>
                </Stack>
              );
            })}
          </Paper>

          <Box sx={{ px: { xs: 2, md: 4 }, py: 3 }}>
        {status && (!status.anthropic_key || status.error || !status.bpml.available) && (
          <Alert severity="warning" sx={{ mb: 3, fontSize: 12.5, borderRadius: RADIUS }}>
            {!status.anthropic_key && <div>No <code>ANTHROPIC_API_KEY</code> is set, so no analysis can run.</div>}
            {!status.bpml.available && <div>The BPML process house is not readable from the corpus ({status.bpml.error ?? status.bpml.document}), so the Global Template hierarchy is unavailable.</div>}
            {status.error && <div>{status.error}</div>}
          </Alert>
        )}
            <Box sx={{ display: "grid", gap: 3, alignItems: "start", gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 1fr) 380px" } }}>
              <Stack spacing={3} sx={{ minWidth: 0 }}>
                <Section title="1. Sources" hint={`The ${subject.label} is required; the rest are optional baselines`}>
                  <Sources
                    data={uploads} busy={uploading} error={uploadError} disabled={running}
                    accepted={status?.uploads?.accepted ?? [".pdf", ".docx", ".xlsx", ".pptx", ".txt"]}
                    roles={status?.uploads?.roles ?? [{ value: "as_is", label: "Country As-Is" }]}
                    subject={subject}
                    subjects={status?.subjects ?? []}
                    onSubject={(v) => { setSubjectKey(v); setSubjectTouched(true); }}
                    maxFiles={status?.uploads?.max_files ?? 12}
                    onAdd={addUploads} onRetag={retag} onRemove={removeUpload} onClear={clearUploads}
                  />
                </Section>

                <Section title="2. Scope">
                  <Stack spacing={2.5}>
                    <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: subject.localization ? "220px 160px minmax(0, 1fr)" : "220px minmax(0, 1fr)" } }}>
                      <Stack spacing={0.6}>
                        <Typography component="label" htmlFor="rollout-subject" sx={{ fontSize: 12, color: "text.secondary" }}>Analyse</Typography>
                        <Select id="rollout-subject" size="small" value={subjectKey} disabled={running}
                                onChange={(e) => { setSubjectKey(e.target.value); setSubjectTouched(true); }}
                                sx={{ fontSize: 13, borderRadius: RADIUS }}>
                          {(status?.subjects ?? []).map((x) => (
                            <MenuItem key={x.value} value={x.value} sx={{ fontSize: 13 }}>{x.label}</MenuItem>
                          ))}
                        </Select>
                      </Stack>
                      {subject.localization && (
                        <Stack spacing={0.6}>
                          <Typography component="label" htmlFor="rollout-country" sx={{ fontSize: 12, color: "text.secondary" }}>Country</Typography>
                          <TextField id="rollout-country" size="small" value={country} placeholder="India"
                                     onChange={(e) => setCountry(e.target.value)}
                                     sx={{ "& .MuiOutlinedInput-root": { borderRadius: RADIUS } }} />
                        </Stack>
                      )}
                      <Stack spacing={0.6}>
                        <Typography component="label" htmlFor="rollout-scope" sx={{ fontSize: 12, color: "text.secondary" }}>
                          Global Template process (optional)
                        </Typography>
                        <TextField
                          id="rollout-scope" size="small"
                          placeholder="A BPML code or name — or leave empty to let the agent find it"
                          value={scopeText} onChange={(e) => setScopeText(e.target.value)}
                          onKeyDown={clearOnEscape(() => setScopeText(""))}
                          error={scopeUnknown}
                          helperText={scopeUnknown
                            ? "No BPML process matches. Correct it, or clear the field to let the agent choose."
                            : scope ? `${scope.code} ${scope.name}` : "The agent will identify the template process."}
                          sx={{ "& .MuiOutlinedInput-root": { borderRadius: RADIUS } }}
                          slotProps={{ input: {
                            startAdornment: <Box sx={{ pr: 1, color: "text.secondary", display: "flex" }}><Search size={15} /></Box>,
                            endAdornment: clearAdornment(scopeText, () => setScopeText(""), { label: "Clear scope" }),
                          } }}
                        />
                      </Stack>
                    </Box>
                    {matches.length > 1 && (
                      <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.85, mt: -1 }}>
                        {matches.slice(0, 6).map((m) => (
                          <Chip key={m.code} size="small" label={`${m.code} ${m.name}`}
                                variant={scope?.code === m.code ? "filled" : "outlined"}
                                onClick={() => { setScope(m); setScopeText(m.code); }}
                                sx={{ fontSize: 11.5, height: 26, maxWidth: 320, borderRadius: RADIUS }} />
                        ))}
                      </Stack>
                    )}
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: -1 }}>
                      {subject.value === "country_as_is"
                        ? "How far the country's current process is from the Global Template, with localization as a lens."
                        : "How far the Global Template has drifted from SAP's delivered standard. No country, no localization — the findings are about the template."}
                      {!subjectTouched && inferredSubject === subject.value && " Chosen from what you attached."}
                    </Typography>
                    <Stack spacing={0.6}>
                      <Typography component="label" htmlFor="rollout-question" sx={{ fontSize: 12, color: "text.secondary" }}>
                        Additional Instructions (optional)
                      </Typography>
                      <TextField
                        id="rollout-question" fullWidth multiline minRows={2} maxRows={4} value={question}
                        placeholder={subject.value === "country_as_is"
                          ? "e.g. Focus on GST e-invoicing and the approval thresholds for credit notes, and flag anything that needs a legal sign-off."
                          : "e.g. Focus on where the template's approval workflow departs from SAP standard, and which of those changes we could drop."}
                        onChange={(e) => setQuestion(e.target.value)}
                        sx={{ "& .MuiOutlinedInput-root": { borderRadius: RADIUS, fontSize: 13.5 } }}
                        slotProps={{ input: {
                          endAdornment: clearAdornment(question, () => setQuestion(""), { size: 16, label: "Clear question", top: true }),
                        } }}
                      />
                    </Stack>
                    <Box>
                      <Button size="small" variant="text" onClick={() => setShowOptions((v) => !v)} sx={{ textTransform: "none", px: 0 }}
                              endIcon={<ChevronDown size={15} style={{ transform: showOptions ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />}>
                        Context: company codes, SAP release, template version, your name
                      </Button>
                      <Collapse in={showOptions}>
                        <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ mt: 2 }}>
                          <TextField size="small" label="Country context" value={countryContext} multiline minRows={2}
                                     onChange={(e) => setCountryContext(e.target.value)} sx={{ flex: "2 1 320px" }}
                                     placeholder="Company codes, sales/purchasing organisations, legal entities, shared-service model, tax context" />
                          <Stack spacing={1.5} sx={{ flex: "1 1 240px" }}>
                            <TextField size="small" label="SAP target solution / release" value={sapRelease}
                                       onChange={(e) => setSapRelease(e.target.value)}
                                       placeholder="S/4HANA Cloud Private Edition 2023" />
                            <TextField size="small" label="Global Template version" value={gtVersion}
                                       onChange={(e) => setGtVersion(e.target.value)} />
                          </Stack>
                          <Box sx={{ flex: "1 1 220px" }}>
                            <TextField size="small" fullWidth label="Your name (for decisions)" value={reviewer}
                                       onChange={(e) => setReviewer(e.target.value)} />
                          </Box>
                        </Stack>
                      </Collapse>
                    </Box>
                  </Stack>
                </Section>
              </Stack>

              <Box sx={{ position: { lg: "sticky" }, top: { lg: 16 } }}>
                <Section title="3. Review and run">
                  <Stack spacing={1.75}>
                    <Box sx={{ display: "grid", gridTemplateColumns: "128px minmax(0, 1fr)", rowGap: 1.1, columnGap: 1.5, fontSize: 13 }}>
                      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Subject</Typography>
                      <Typography sx={{ fontSize: 13 }}>{subject.label}{subject.localization && country ? ` · ${country}` : ""}</Typography>
                      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Attached</Typography>
                      <Typography sx={{ fontSize: 13 }}>
                        {(uploads?.files ?? []).length ? plural((uploads?.files ?? []).length, "document") : "Nothing yet"}
                      </Typography>
                      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Template process</Typography>
                      <Typography sx={{ fontSize: 13 }}>{scope ? `${scope.code} ${scope.name}` : "Found by the agent"}</Typography>
                      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Passes</Typography>
                      <Typography sx={{ fontSize: 13 }}>Read the {subject.label}, then compare</Typography>
                      {plan && (
                        <>
                          {showTechDetails && (
                            <>
                              <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Model</Typography>
                              <Typography sx={{ fontSize: 12.5, fontFamily: MONO }}>{plan.model}</Typography>
                            </>
                          )}
                          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Estimate</Typography>
                          <Typography sx={{ fontSize: 13 }}>
                            ~{Math.round(plan.estimated_input_tokens / 1000)}k input tokens · ~{plan.estimated_minutes} min
                          </Typography>
                        </>
                      )}
                    </Box>
                    {plan && !plan.ready && (
                      <Alert severity="info" variant="outlined" sx={{ py: 0.5, fontSize: 12.5, borderRadius: RADIUS }}>{plan.blocker}</Alert>
                    )}
                    {plan?.ready && !plan.sap_bp_available && (
                      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                        No SAP Best Practice source is attached or indexed, so that score is reported as not assessable rather than guessed.
                      </Typography>
                    )}
                    <Typography sx={{ fontSize: 12, color: "text.secondary", borderTop: 1, borderColor: "divider", pt: 1.5 }}>
                      {subject.score_b && plan?.sap_bp_available
                        ? "You get a Global Template and an SAP Best Practice comparison of the same process, a deviation register, dimension ratings, a localization advisory and a workshop agenda."
                        : "You get a deviation register, dimension ratings, a localization advisory and a workshop agenda."}{" "}
                      Every finding stays proposed until someone accepts it.
                    </Typography>
                    {running ? (
                      <Button variant="outlined" color="error" size="large" startIcon={<Square size={15} />}
                              onClick={() => { controller.current?.abort(); setRunning(false); }}
                              sx={{ textTransform: "none", borderRadius: RADIUS }}>
                        Stop
                      </Button>
                    ) : (
                      <Button variant="contained" size="large" disableElevation disabled={!ready} onClick={start}
                              startIcon={<Scale size={16} />} sx={{ textTransform: "none", borderRadius: RADIUS, py: 1.25 }}>
                        Run analysis
                      </Button>
                    )}
                  </Stack>
                </Section>
              </Box>
            </Box>

            {error && <Alert severity="error" sx={{ mt: 3, fontSize: 12.5, borderRadius: RADIUS }}>{error}</Alert>}
            {(running || stages.length > 0) && (
              <Stack spacing={2} sx={{ mt: 3 }}>
        {/* ---------------------------------------------------------- progress */}
        {(running || stages.length > 0) && !analysis && (
          <Paper variant="outlined" sx={{ p: 2.75, borderRadius: RADIUS }}>
            <SectionLabel icon={<ListChecks size={14} />}>Progress</SectionLabel>
            <Stack spacing={1}>
              {["asis", "compare", "gates"].map((key) => {
                const s = stages.find((x) => x.stage === key);
                const label = key === "asis" ? `Read the ${subject.label}`
                  : key === "compare" ? "Compare against the Global Template" : "Quality gates";
                return (
                  <Stack key={key} direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                    {s?.status === "done" ? <CheckCircle2 size={14} color={semantic.fit} />
                      : s?.status === "running" ? <CircularProgress size={12} />
                        : <Box sx={{ width: 14 }} />}
                    <Typography sx={{ fontSize: 12.5, fontWeight: s ? 600 : 400,
                                      color: s ? "text.primary" : "text.disabled" }}>{label}</Typography>
                    {s?.detail && <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>— {s.detail}</Typography>}
                  </Stack>
                );
              })}
            </Stack>
          </Paper>
        )}
        {/* --------------------------------------------------- the investigation */}
        {/* Its own panel, not a corner of Progress. Progress renders only while
            there is no analysis yet, so the log used to vanish at the exact
            moment the run finished -- and a run reopened from history, which
            always has an analysis, never showed one at all. The log is the
            working behind the answer; it outlives the run that produced it. */}
        {(calls.length > 0 || running || (runId && !running)) && (
          <Paper variant="outlined" sx={{ p: 2.75, borderRadius: RADIUS }}>
            <SectionLabel icon={<ListChecks size={14} />}
              right={
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                  {calls.length > 0 && (
                    <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                      {calls.length} call{calls.length === 1 ? "" : "s"}
                    </Typography>
                  )}
                  <Tooltip title={log.length
                    ? `Open the step-by-step log — the context each pass was handed, the agent's reasoning, every call, rejected submissions and the gates (${log.length} steps)`
                    : "The step-by-step log appears here as the run goes"}>
                    <span>
                      <Button variant="outlined" size="small" disabled={log.length === 0}
                              startIcon={<Terminal size={15} />} onClick={() => setLogOpen(true)}
                              sx={{ textTransform: "none", borderRadius: RADIUS }}>
                        Logs{log.length ? ` (${log.length})` : ""}
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              }>
              Investigation
            </SectionLabel>
            {calls.length === 0 && !running ? (
              <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                This run was recorded before the log kept what each call returned.
                Run the analysis again to get a log you can open.
              </Typography>
            ) : (
            <Box ref={logRef}
                 sx={{ mt: 1.5, maxHeight: 220, overflowY: "auto", p: 1, borderRadius: 1.5,
                       bgcolor: alpha(theme.palette.text.primary, 0.035) }}>
              {calls.some((c) => c.trace) ? (
                <Typography sx={{ fontSize: 10.5, color: "text.disabled", mb: 0.75 }}>
                  Click a call to see what it returned.
                </Typography>
              ) : !running && calls.length > 0 ? (
                <Typography sx={{ fontSize: 10.5, color: "text.disabled", mb: 0.75 }}>
                  This run was recorded before the log kept what each call returned.
                </Typography>
              ) : null}
              {calls.map((c, i) => (
                <Stack key={i} direction="row" spacing={1}
                       onClick={c.trace ? () => setTraceCall(c) : undefined}
                       role={c.trace ? "button" : undefined}
                       tabIndex={c.trace ? 0 : undefined}
                       onKeyDown={c.trace ? (e) => {
                         if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTraceCall(c); }
                       } : undefined}
                       sx={{ alignItems: "baseline", fontFamily: "monospace",
                             // Only a call that kept a trace opens anything. A
                             // failed one stays a log line rather than a button
                             // that opens an apology.
                             cursor: c.trace ? "pointer" : "default",
                             borderRadius: 0.75, px: 0.5, mx: -0.5, py: 0.15,
                             transition: "background-color .12s",
                             "&:hover": c.trace
                               ? { bgcolor: alpha(theme.palette.text.primary, 0.06) }
                               : undefined,
                             "&:focus-visible": {
                               outline: `2px solid ${theme.palette.primary.main}`,
                               outlineOffset: 1,
                             } }}>
                  <Typography component="span" sx={{ fontSize: 10.5, color: "text.disabled",
                                                     minWidth: 22, textAlign: "right" }}>
                    {i + 1}
                  </Typography>
                  <Typography component="span"
                              sx={{ fontSize: 10.5, minWidth: 62,
                                    color: ENGINE_COLOUR[c.engine] ?? "primary.main",
                                    textDecoration: c.trace ? "underline" : "none",
                                    textDecorationStyle: "dotted",
                                    textUnderlineOffset: 3 }}>
                    {c.tool}
                  </Typography>
                  <Typography component="span"
                              sx={{ fontSize: 12, flex: 1,
                                    color: c.error ? "error.main" : "text.secondary",
                                    wordBreak: "break-word" }}>
                    {c.summary || c.error}
                    {/* Which store the call read. The corpus is one table
                        with a category per row and the attachment is in a
                        database of its own, so "searched" without saying
                        where is not an answer. */}
                    {c.sources?.label ? (
                      <Box component="span" sx={{ color: "text.disabled" }}>
                        {"  ·  "}{String(c.sources.label)}
                      </Box>
                    ) : null}
                  </Typography>
                  <Typography component="span" sx={{ fontSize: 10.5, color: "text.disabled" }}>
                    {c.ms}ms
                  </Typography>
                </Stack>
              ))}
              {running && (
                // Between tool calls the agent is generating, which is most
                // of the wall clock. A log that goes quiet for a minute with
                // no line saying why reads as a hang.
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: calls.length ? 0.5 : 0 }}>
                  <CircularProgress size={9} />
                  <Typography sx={{ fontSize: 12, color: "text.disabled", fontStyle: "italic" }}>
                    {runningStage === "gates" ? "checking the analysis…" : "the agent is thinking…"}
                  </Typography>
                </Stack>
              )}
        </Box>
            )}
          </Paper>
        )}
              </Stack>
            )}
          </Box>
        </>
      )}

      {/* What one call in the log returned. The Evidence Agent's panel, on the
          Fit-Gap Copilot's calls -- the two share five of their tools, so the
          reader should not meet a different panel depending on which agent
          they happen to be reading. */}
      {/* On the New analysis screen too: its last section is the form a reader
          fills in, and it should not sit against the bottom edge either. */}
      <ScrollRunway />

      {/* past runs, in a drawer beside the current one. Outside both views:
          the workspace and New analysis each have a History button, and a
          drawer that lives inside one of them does nothing for the other. */}
      <RunHistoryDrawer<RolloutRunDetail>
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        icon={<History size={18} />}
        title="Past runs"
        noun={["run", "runs"]}
        items={historyCards}
        currentId={runId}
        onDelete={remove}
        armDelete
        deleteLabel="Delete this analysis and any decisions recorded against it"
        fetchDetail={rollout.run}
        renderDetail={(run) => <PastAnalysis run={run} showModel={showTechDetails} />}
        detailActions={(run) => (
          <>
            {pdfReady && (
              <Button size="small" variant="outlined" startIcon={<FileDown size={13} />}
                      href={rollout.exportUrl(run.id, "pdf")} sx={{ fontSize: 12 }}>
                PDF
              </Button>
            )}
            <Button size="small" variant="text" startIcon={<Download size={13} />}
                    href={rollout.exportUrl(run.id, "md")} sx={{ fontSize: 12 }}>
              Markdown
            </Button>
          </>
        )}
        onLoadIntoPage={(id) => void loadRun(id)}
        loadDisabled={running}
        filterPlaceholder="Filter by scope, country or headline…"
        emptyText="Nothing analysed yet. Run one and it will appear here."
      />
      <AgentLogDrawer open={logOpen} onClose={() => setLogOpen(false)} log={log} running={running}
                      onOpenCall={(i) => openCall(i)} />
      <AgentTraceDrawer
        open={Boolean(traceCall)}
        onClose={() => { setTraceCall(null); setTraceHighlight([]); }}
        call={traceCall}
        cited={citedChunks}
        focus={traceHighlight}
        citedNodes={[]}
        citedEdges={[]}
      />
    </Box>
  );
}
