import {
  Alert, Autocomplete, Box, Button, Chip, CircularProgress, Collapse, Divider, Drawer,
  IconButton, LinearProgress, ListSubheader, MenuItem, Paper, Select, Slider,
  Stack, Switch, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { AnimatePresence, motion } from "framer-motion";
import {
  Ban, Blocks, BookOpenCheck, Braces, CalendarClock, Check, ChevronDown, ChevronRight, CircleAlert,
  CircleCheck, CircleHelp, Cog, Compass, Dices, Download, Eye, FileSpreadsheet, FileText, FlaskConical,
  GitBranch, Hammer, History, Layers, Network, Quote, Scale, Search, SendHorizontal, ShieldCheck,
  Paperclip, Sparkles, Square, Target, TriangleAlert, Trash2, Upload, Wrench, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CATEGORY_LABEL, EVAL_QUESTIONS, EVAL_QUESTIONS_BY_GROUP, EXPECTATION_LABEL, ENGINE_LABEL, HALVES,
  type EvalQuestion, type Engine, type Expectation,
} from "../data/evalQuestions";
import {
  fitgap, runFitGap, uploadSessionDocuments,
  type BpmlProcess, type FitGapClass, type FitGapEntry, type FitGapEvidence, type FitGapIssue,
  type FitGapPreview, type FitGapRunDetail, type FitGapRunSummary, type FitGapStatus,
  type FitGapSynthesis,
  type UploadComparison, type UploadSession,
} from "../api";
import { clearAdornment, clearOnEscape } from "../components/ClearAdornment";
import RunHistoryDrawer, { type HistoryCard } from "../components/RunHistoryDrawer";

/* -------------------------------------------------------------- attachments */

/** Documents the analyst attached to this InsightLens session.
 *
 *  They are converted by Docling, embedded into a Postgres schema of their
 *  own and given a knowledge graph of their own -- in a different database from
 *  the corpus, so they are NOT added to it. The panel says so, because an
 *  analyst dropping a draft specification into a chat box has every reason to
 *  assume the opposite.
 */
function Attachments({
  session, data, comparison, busy, error, disabled, accepted, ttlHours, maxFiles,
  onAdd, onRemove, onClear,
}: {
  session: string;
  data: UploadSession | null;
  comparison: UploadComparison | null;
  busy: { filename: string; index: number; total: number; stage: string } | null;
  error: string | null;
  disabled: boolean;
  accepted: string[];
  ttlHours: number;
  maxFiles: number;
  onAdd: (files: File[]) => void;
  onRemove: (name: string) => void;
  onClear: () => void;
}) {
  const theme = useTheme();
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const [showEntities, setShowEntities] = useState(false);
  const files = data?.files ?? [];
  const full = files.length >= maxFiles;

  const expiry = (() => {
    if (!data?.expires_at) return "";
    const mins = Math.round((new Date(data.expires_at).getTime() - Date.now()) / 60000);
    if (mins <= 0) return "expired";
    return mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  })();

  const STAGES: Record<string, string> = {
    converting: "converting with Docling",
    embedding: "chunking and embedding",
    graph: "extracting entities",
  };

  return (
    <Box
      onDragOver={(e) => { e.preventDefault(); if (!disabled && !full) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled || full) return;
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length) onAdd(dropped);
      }}
      sx={{
        mt: 1.75, px: 1.5, py: 1.25, borderRadius: 2,
        border: "1px dashed",
        borderColor: over ? "primary.main" : "divider",
        bgcolor: over ? alpha(theme.palette.primary.main, 0.06) : "transparent",
        transition: "background-color .15s, border-color .15s",
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accepted.join(",")}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          if (chosen.length) onAdd(chosen);
          e.target.value = "";
        }}
      />

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
        <Paperclip size={14} color={theme.palette.text.secondary} />
        <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>
          Your documents
        </Typography>
        {files.length > 0 && (
          <Chip
            size="small"
            label={`${files.length} · ${(data?.chunks ?? 0).toLocaleString()} chunks`}
            sx={{ height: 19, fontSize: 10.5 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {files.length > 0 && (
          <Button size="small" variant="text" color="inherit" disabled={disabled}
                  startIcon={<Trash2 size={13} />} onClick={onClear}
                  sx={{ fontSize: 11.5, color: "text.secondary" }}>
            Discard all
          </Button>
        )}
        <Button
          size="small"
          variant="outlined"
          startIcon={<Upload size={14} />}
          disabled={disabled || full || !!busy}
          onClick={() => input.current?.click()}
          sx={{ fontSize: 12 }}
        >
          {files.length ? "Add more" : "Attach"}
        </Button>
      </Stack>

      {files.length === 0 && !busy && (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.6 }}>
          Drop a PDF, Word, Excel or PowerPoint file here to compare it against the corpus.
          It is converted, embedded and graphed in a store of its own — never added to the
          permanent knowledge bases.
        </Typography>
      )}

      <AnimatePresence initial={false}>
        {busy && (
          <Box component={motion.div} key="busy"
               initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
               exit={{ opacity: 0, height: 0 }} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
              <CircularProgress size={12} />
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                {busy.total > 1 ? `${busy.index}/${busy.total} · ` : ""}
                {busy.filename} — {STAGES[busy.stage] ?? busy.stage}
              </Typography>
            </Stack>
            <LinearProgress sx={{ height: 3, borderRadius: 2 }} />
          </Box>
        )}
      </AnimatePresence>

      {files.length > 0 && (
        <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.6, mt: 1 }}>
          {files.map((f) => (
            <Chip
              key={f.name}
              size="small"
              icon={<FileText size={12} />}
              label={`${f.name} · ${f.chunks} chunk${f.chunks === 1 ? "" : "s"}`}
              onDelete={disabled || busy ? undefined : () => onRemove(f.name)}
              deleteIcon={<X size={12} />}
              sx={{ height: 23, fontSize: 11, maxWidth: 380 }}
            />
          ))}
        </Stack>
      )}

      {error && (
        <Typography sx={{ fontSize: 11.5, color: "error.main", mt: 0.75 }}>{error}</Typography>
      )}

      {files.length > 0 && (
        <>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", mt: 1, flexWrap: "wrap", gap: 0.5 }}>
            <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
              Held in <code>{data?.database}.{data?.schema}</code> · deleted in {expiry}
              {ttlHours ? ` of no use` : ""} · not searchable from the Ask page or any other run
            </Typography>
            <Box sx={{ flex: 1 }} />
            {comparison && (comparison.shared + comparison.new) > 0 && (
              <Button size="small" variant="text" onClick={() => setShowEntities((v) => !v)}
                      endIcon={<ChevronDown size={13} style={{ transform: showEntities ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />}
                      sx={{ fontSize: 11.5 }}>
                {comparison.shared} known to the corpus · {comparison.new} new
              </Button>
            )}
          </Stack>
          <Collapse in={showEntities}>
            <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.5, mt: 1 }}>
              {(comparison?.entities ?? []).slice(0, 40).map((e) => (
                <Tooltip
                  key={e.node_id}
                  title={
                    e.in_corpus
                      ? `${e.type} · mentioned by ${e.corpus_mentions} corpus document${e.corpus_mentions === 1 ? "" : "s"}${e.corpus_documents.length ? `: ${e.corpus_documents.join(", ")}` : ""}`
                      : `${e.type} · nothing in the corpus mentions this`
                  }
                >
                  <Chip
                    size="small"
                    label={e.label}
                    variant={e.in_corpus ? "filled" : "outlined"}
                    color={e.in_corpus ? "default" : "warning"}
                    sx={{ height: 21, fontSize: 10.5, maxWidth: 260 }}
                  />
                </Tooltip>
              ))}
            </Stack>
            <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.75 }}>
              Outlined chips are entities only the attachment mentions. InsightLens is told to
              report a disagreement between an attachment and the corpus rather than pick a winner.
            </Typography>
          </Collapse>
        </>
      )}
      {session && files.length === 0 && !busy && (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", mt: 0.5 }}>
          Session {session} is empty.
        </Typography>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ classes */

interface ClassStyle {
  label: string;
  short: string;
  hue: "success" | "info" | "warning" | "error" | "primary" | "neutral";
  icon: ReactNode;
  blurb: string;
}

const CLASSES: Record<FitGapClass, ClassStyle> = {
  FIT_STANDARD: { label: "Fit — standard", short: "STANDARD", hue: "success", icon: <CircleCheck size={15} />, blurb: "SAP standard or a best-practice scope item; no change specific to this step." },
  FIT_CONFIG: { label: "Fit — config", short: "CONFIG", hue: "info", icon: <Cog size={15} />, blurb: "Met by configuration — document types, pricing, output determination — with no custom code." },
  GAP_DEVELOPMENT: { label: "Gap — development", short: "DEVELOPMENT", hue: "warning", icon: <Hammer size={15} />, blurb: "Needs an enhancement, custom report, form, interface build, BAdI or user exit." },
  REUSE: { label: "Reuse", short: "REUSE", hue: "success", icon: <CircleCheck size={15} />, blurb: "The template step carries over to the country unchanged." },
  ADAPT: { label: "Adapt", short: "ADAPT", hue: "info", icon: <Wrench size={15} />, blurb: "Reuse with a deliberate country change." },
  CHALLENGE: { label: "Challenge", short: "CHALLENGE", hue: "error", icon: <TriangleAlert size={15} />, blurb: "Question it before it travels — the template choice may not fit." },
  SIMPLIFY: { label: "Simplify", short: "SIMPLIFY", hue: "primary", icon: <Layers size={15} />, blurb: "Same intent, fewer moving parts." },
  REPLACE: { label: "Replace", short: "REPLACE", hue: "primary", icon: <Blocks size={15} />, blurb: "SAP standard or a localization beats the template's custom element." },
  RETIRE: { label: "Retire", short: "RETIRE", hue: "neutral", icon: <Ban size={15} />, blurb: "Does not earn a place in the next wave." },
  UNKNOWN: { label: "Unknown", short: "UNKNOWN", hue: "neutral", icon: <CircleHelp size={15} />, blurb: "The evidence ran out. A first-class answer, never a guess in disguise." },
};

function useHue() {
  const theme = useTheme();
  return useCallback(
    (hue: ClassStyle["hue"]) =>
      hue === "neutral" ? theme.palette.text.secondary : theme.palette[hue].main,
    [theme],
  );
}

const MATERIALITY: Record<string, { label: string; weight: number }> = {
  high: { label: "High", weight: 3 },
  medium: { label: "Medium", weight: 2 },
  low: { label: "Low", weight: 1 },
};

/** A shape the agent can read without a schema: what the country runs today,
 *  what it is obliged to do, and what it has already decided. */
const SAMPLE_PROFILE = JSON.stringify(
  {
    country: "Italy",
    wave: 2,
    legal_entities: ["Solvay Chimica Italia S.p.A."],
    statutory: ["Electronic invoicing via SDI", "Split payment for public bodies"],
    as_is: { erp: "SAP ECC", order_intake: ["EDI", "email via Esker"], tax_engine: "SOVOS" },
    decided: ["Adopt the template pricing procedure unchanged"],
    to_challenge: ["Customer-specific billing forms"],
  },
  null,
  2,
);

const plural = (n: number, one: string, many = "") => `${n} ${n === 1 ? one : many || one + "s"}`;

/* ------------------------------------------------------------- small pieces */

function SectionLabel({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Stack direction="row"  spacing={1} sx={{ alignItems: "center", mb: 1.25 }}>
      {icon}
      <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
        {children}
      </Typography>
      <Box sx={{ flex: 1 }} />
      {right}
    </Stack>
  );
}

/** One past register, read inside the history drawer.
 *
 *  The page lays a register out as a scope tree, a step list and four
 *  synthesis tabs. What survives at 560px is the shape of it: how much was
 *  classified and how, the gaps in weight order, and the decisions the
 *  synthesis surfaced. The XLSX underneath has every column.
 */
function PastRegister({ run }: { run: FitGapRunDetail }) {
  const synth = (run.synthesis && "reuse" in run.synthesis
    ? run.synthesis
    : null) as FitGapSynthesis | null;
  const reuse = synth?.reuse;
  const TOP = 8;

  // by_class counts come from the synthesis when there is one, and from the
  // entries themselves when the run stopped before it synthesised. A register
  // with no verdict summary at all is the one thing this panel cannot show.
  const byClass = reuse?.by_class
    ?? run.entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.classification] = (acc[e.classification] ?? 0) + 1;
      return acc;
    }, {});

  return (
    <Stack spacing={1.75}>
      <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Chip size="small" variant="outlined" label={`Mode ${run.mode}`} sx={{ height: 19, fontSize: 10 }} />
        {run.status !== "done" && (
          <Chip size="small" variant="outlined" color={run.status === "failed" ? "error" : "warning"}
                label={run.status} sx={{ height: 19, fontSize: 10 }} />
        )}
        {run.holdout && (
          <Chip size="small" variant="outlined" label="holdout" sx={{ height: 19, fontSize: 10 }} />
        )}
        <Chip size="small" variant="outlined" label={run.model} sx={{ height: 19, fontSize: 10 }} />
        {run.categories?.map((c) => (
          <Chip key={c} size="small" variant="outlined" label={(CATEGORY_LABEL as Record<string, string>)[c] ?? c}
                sx={{ height: 19, fontSize: 10 }} />
        ))}
        {/* The attachment is swept within hours, so its name is the whole record. */}
        {run.uploads?.documents?.map((d) => (
          <Tooltip key={d} title="An attachment this run read. The file itself is long gone.">
            <Chip size="small" variant="outlined" icon={<Paperclip size={10} />} label={d}
                  sx={{ height: 19, fontSize: 10, "& .MuiChip-icon": { ml: 0.4 } }} />
          </Tooltip>
        ))}
      </Stack>

      {run.question && (
        <Typography sx={{ fontSize: 13, lineHeight: 1.65 }}>{run.question}</Typography>
      )}

      {reuse && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {([
            ["Reuse", reuse.reuse_pct],
            ["Coverage", reuse.coverage_pct],
          ] as [string, number | null][]).map(([label, v]) => (
            <Paper key={label} variant="outlined" sx={{ p: 1.5, flex: "1 1 150px", minWidth: 140 }}>
              <Typography sx={{ fontSize: 10, color: "text.secondary", textTransform: "uppercase",
                                letterSpacing: ".06em" }}>
                {label}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: "baseline", mt: 0.5 }}>
                <Typography sx={{ fontSize: 26, fontWeight: 800, lineHeight: 1,
                                  color: v === null ? "text.disabled" : "primary.main" }}>
                  {v === null ? "—" : v}
                </Typography>
                {v !== null && (
                  <Typography sx={{ fontSize: 13, fontWeight: 600, color: "primary.main" }}>%</Typography>
                )}
              </Stack>
            </Paper>
          ))}
          <Paper variant="outlined" sx={{ p: 1.5, flex: "1 1 150px", minWidth: 140 }}>
            <Typography sx={{ fontSize: 10, color: "text.secondary", textTransform: "uppercase",
                              letterSpacing: ".06em" }}>
              Classified
            </Typography>
            <Typography sx={{ fontSize: 26, fontWeight: 800, lineHeight: 1, mt: 0.5 }}>
              {reuse.classified}
              <Box component="span" sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary" }}>
                {" / "}{reuse.steps}
              </Box>
            </Typography>
          </Paper>
        </Stack>
      )}

      {!!Object.keys(byClass).length && (
        <Stack direction="row" spacing={0.6} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
          {Object.entries(byClass)
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([cls, n]) => (
              <Stack key={cls} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                <ClassBadge value={cls as FitGapClass} size="sm" />
                <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: "text.secondary" }}>{n}</Typography>
              </Stack>
            ))}
        </Stack>
      )}

      {reuse?.note && (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>{reuse.note}</Typography>
      )}

      {!!synth?.gaps.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>
            Gaps, heaviest first
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {synth.gaps.slice(0, TOP).map((g) => (
              <Paper key={g.bpml_code} sx={{ p: 1.4 }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap", gap: 0.6 }}>
                  <Typography sx={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
                    {g.bpml_code}
                  </Typography>
                  <ClassBadge value={g.classification} size="sm" />
                  <Chip size="small" variant="outlined" label={g.materiality}
                        sx={{ height: 17, fontSize: 9.5 }} />
                </Stack>
                <Typography sx={{ fontSize: 12.5, fontWeight: 650, mt: 0.6 }}>{g.step_name}</Typography>
                {g.rationale && (
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.4, lineHeight: 1.55 }}>
                    {g.rationale}
                  </Typography>
                )}
              </Paper>
            ))}
          </Stack>
          {synth.gaps.length > TOP && (
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 1 }}>
              {synth.gaps.length - TOP} more, with their evidence and reviews, on the page.
            </Typography>
          )}
        </Box>
      )}

      {!!synth?.decisions.length && (
        <Box>
          <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>
            {plural(synth.decisions.length, "decision")} to take
          </Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, mt: 0.25, pl: 2.25 }}>
            {synth.decisions.map((d, i) => (
              <Typography key={i} component="li" sx={{ fontSize: 12, lineHeight: 1.55 }}>
                {d.question}
              </Typography>
            ))}
          </Stack>
        </Box>
      )}

      {!run.entries.length && (
        <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
          This run classified no steps{run.status !== "done" ? ` — it ${run.status}.` : "."}
        </Typography>
      )}
    </Stack>
  );
}

function ClassBadge({ value, size = "md" }: { value: FitGapClass; size?: "sm" | "md" }) {
  const style = CLASSES[value];
  const hue = useHue()(style.hue);
  return (
    <Tooltip title={style.blurb}>
      <Stack
        direction="row"
        
        spacing={0.75}
        sx={{ alignItems: "center", px: size === "sm" ? 0.9 : 1.15,
          py: size === "sm" ? 0.3 : 0.5,
          borderRadius: 1.5,
          bgcolor: alpha(hue, 0.13),
          color: hue,
          border: `1px solid ${alpha(hue, 0.35)}`,
          fontWeight: 700,
          fontSize: size === "sm" ? 10.5 : 11.5,
          letterSpacing: ".04em",
          whiteSpace: "nowrap" }}
      >
        {style.icon}
        <span>{style.short}</span>
      </Stack>
    </Tooltip>
  );
}

/** The confidence number with the rubric that produced it close at hand — a
 *  register is only useful if the reader can see how sure the machine was. */
function ConfidenceMeter({ value, width = 92 }: { value: number; width?: number }) {
  const theme = useTheme();
  const colour =
    value >= 0.7 ? theme.palette.success.main : value >= 0.4 ? theme.palette.warning.main : theme.palette.error.main;
  return (
    <Tooltip title={`Confidence ${value.toFixed(2)} — computed from the §6 rubric, then re-checked by the verifier`}>
      <Stack direction="row"  spacing={0.85} sx={{ alignItems: "center" }}>
        <Box sx={{ width, height: 6, borderRadius: 3, bgcolor: alpha(colour, 0.18), overflow: "hidden" }}>
          <Box
            component={motion.div}
            initial={{ width: 0 }}
            animate={{ width: `${Math.round(value * 100)}%` }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            sx={{ height: "100%", bgcolor: colour, borderRadius: 3 }}
          />
        </Box>
        <Typography sx={{ fontVariantNumeric: "tabular-nums", fontSize: 12, fontWeight: 700, color: colour, minWidth: 28 }}>
          {value.toFixed(2)}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

function CountUp({ value, suffix = "", decimals = 0 }: { value: number; suffix?: string; decimals?: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 750);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(a + (value - a) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {shown.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* ------------------------------------------------------------- live step card */

type StepState = "waiting" | "running" | "done" | "failed";

interface LiveStep {
  code: string;
  name: string;
  state: StepState;
  tools: { tool: string; summary: string; error: string | null }[];
  entry?: FitGapEntry;
  message?: string;
}

const TOOL_ICON: Record<string, ReactNode> = {
  get_scope: <Compass size={12} />,
  search_corpus: <Search size={12} />,
  get_chunk: <FileText size={12} />,
  graph_entity: <Target size={12} />,
  graph_neighbors: <Network size={12} />,
  graph_path: <GitBranch size={12} />,
};

function StepCard({ step, onOpen }: { step: LiveStep; onOpen: () => void }) {
  const theme = useTheme();
  const hue = useHue();
  const entry = step.entry;
  const accent = entry
    ? hue(CLASSES[entry.classification].hue)
    : step.state === "failed"
      ? theme.palette.error.main
      : step.state === "running"
        ? theme.palette.primary.main
        : theme.palette.divider;

  return (
    <Paper
      component={motion.div}
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      onClick={entry ? onOpen : undefined}
      sx={{
        p: 1.5,
        borderLeft: `3px solid ${accent}`,
        cursor: entry ? "pointer" : "default",
        transition: "border-color .3s, background .15s",
        "&:hover": entry ? { bgcolor: alpha(theme.palette.primary.main, 0.04) } : undefined,
      }}
    >
      <Stack direction="row"  spacing={1} sx={{ alignItems: "center" }}>
        <Typography sx={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 700, color: "text.secondary" }}>
          {step.code}
        </Typography>
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
          {step.name}
        </Typography>
        {step.state === "running" && <CircularProgress size={13} thickness={6} />}
        {entry && <ClassBadge value={entry.classification} size="sm" />}
        {step.state === "failed" && <CircleAlert size={14} color={theme.palette.error.main} />}
      </Stack>

      {entry ? (
        <Stack direction="row"  spacing={1.25} sx={{ alignItems: "center", mt: 1 }}>
          <ConfidenceMeter value={entry.confidence} width={70} />
          <Chip size="small" variant="outlined" label={MATERIALITY[entry.materiality].label}
                sx={{ height: 19, fontSize: 10.5 }} />
          <Box sx={{ flex: 1 }} />
          <Tooltip title={entry.evidence_valid ? "Every quote was found verbatim in the chunk it names" : "Some evidence did not survive verification"}>
            <Stack direction="row"  spacing={0.4}
                   sx={{ alignItems: "center", color: entry.evidence_valid ? "success.main" : "warning.main" }}>
              <Quote size={11} />
              <Typography sx={{ fontSize: 11, fontWeight: 700 }}>{entry.evidence.length}</Typography>
            </Stack>
          </Tooltip>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
            {entry.tool_calls ?? 0} calls · {Math.round(entry.seconds ?? 0)}s
          </Typography>
        </Stack>
      ) : step.state === "failed" ? (
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "error.main" }}>{step.message}</Typography>
      ) : (
        <Box sx={{ mt: 0.75, minHeight: 34 }}>
          <AnimatePresence initial={false} mode="popLayout">
            {step.tools.slice(-2).map((t, i) => (
              <Stack
                key={`${t.tool}-${step.tools.length - 2 + i}`}
                component={motion.div}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                direction="row"
                
                spacing={0.6}
                sx={{ alignItems: "center", color: t.error ? "error.main" : "text.secondary", fontSize: 11, lineHeight: 1.5 }}
              >
                {TOOL_ICON[t.tool] ?? <Braces size={12} />}
                <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {t.tool}
                </Box>
                <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.summary}
                </Box>
              </Stack>
            ))}
          </AnimatePresence>
          {step.state === "waiting" && !step.tools.length && (
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>queued</Typography>
          )}
        </Box>
      )}
    </Paper>
  );
}

/* ------------------------------------------------------------ evidence panel */

function EvidenceRow({ ev }: { ev: FitGapEvidence }) {
  const theme = useTheme();
  const colour =
    ev.supports === "for" ? theme.palette.success.main
      : ev.supports === "against" ? theme.palette.error.main
        : theme.palette.text.secondary;
  return (
    <Paper sx={{ p: 1.25, borderLeft: `3px solid ${colour}` }}>
      <Stack direction="row"  spacing={0.75} sx={{ alignItems: "center", mb: 0.6 }}>
        <Typography sx={{ fontSize: 10, fontWeight: 800, letterSpacing: ".06em", color: colour, textTransform: "uppercase" }}>
          {ev.supports}
        </Typography>
        <Typography sx={{ fontSize: 11, color: "text.secondary", flex: 1, minWidth: 0 }} noWrap title={ev.doc}>
          {ev.doc}
        </Typography>
        <Chip size="small" variant="outlined" label={`chunk ${ev.chunk_id}`} sx={{ height: 17, fontSize: 9.5 }} />
      </Stack>
      {ev.heading_path && (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", mb: 0.5 }} noWrap>
          {ev.heading_path}
        </Typography>
      )}
      <Typography sx={{ fontSize: 12.5, lineHeight: 1.55, fontStyle: "italic" }}>“{ev.quote}”</Typography>
    </Paper>
  );
}

function IssueRow({ issue }: { issue: FitGapIssue }) {
  const hard = issue.severity === "hard";
  return (
    <Stack direction="row" spacing={0.75} 
           sx={{ alignItems: "flex-start", color: hard ? "error.main" : "warning.main", fontSize: 11.5 }}>
      {hard ? <CircleAlert size={13} style={{ marginTop: 2 }} /> : <TriangleAlert size={13} style={{ marginTop: 2 }} />}
      <Box>
        <b>{issue.code}</b> — {issue.detail}
      </Box>
    </Stack>
  );
}

function EntryDetail({
  entry, onReview, onGraph, reviewer, setReviewer,
}: {
  entry: FitGapEntry;
  onReview: (verdict: "accept" | "reject" | "refine", corrected?: FitGapClass) => Promise<void>;
  onGraph: (text: string) => void;
  reviewer: string;
  setReviewer: (v: string) => void;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [corrected, setCorrected] = useState<FitGapClass | "">("");
  const reviews = entry.reviews ?? [];

  const send = async (verdict: "accept" | "reject" | "refine") => {
    if (!reviewer.trim()) return;
    setBusy(verdict);
    try {
      await onReview(verdict, corrected || undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row"  spacing={1} sx={{ alignItems: "center", mb: 0.75 }}>
          <Typography sx={{ fontFamily: "ui-monospace, monospace", fontWeight: 800, fontSize: 13 }}>
            {entry.bpml_code}
          </Typography>
          <ClassBadge value={entry.classification} />
          <Box sx={{ flex: 1 }} />
          <Chip size="small" label={`status: ${entry.status}`} variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />
        </Stack>
        <Typography variant="h6" sx={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>
          {entry.step_name}
        </Typography>
        <Stack direction="row"  spacing={2} sx={{ alignItems: "center", mt: 1 }}>
          <ConfidenceMeter value={entry.confidence} />
          <Chip size="small" icon={<Scale size={12} />} label={`${MATERIALITY[entry.materiality].label} materiality`}
                variant="outlined" sx={{ height: 22, fontSize: 11 }} />
        </Stack>
      </Box>

      <Typography sx={{ fontSize: 13.5, lineHeight: 1.65 }}>{entry.rationale}</Typography>

      {(entry.linked_tickets.length > 0 || entry.sap_objects.length > 0) && (
        <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.75 }}>
          {entry.linked_tickets.map((t) => (
            <Chip key={t} size="small" label={t} icon={<Network size={12} />} onClick={() => onGraph(t)}
                  sx={{ height: 22, fontSize: 11 }} />
          ))}
          {entry.sap_objects.map((o) => (
            <Chip key={o} size="small" label={o} variant="outlined" sx={{ height: 22, fontSize: 11 }} />
          ))}
        </Stack>
      )}

      {entry.issues && entry.issues.length > 0 && (
        <Paper sx={{ p: 1.25, bgcolor: alpha(theme.palette.warning.main, 0.07) }}>
          <SectionLabel icon={<ShieldCheck size={13} />}>Verification</SectionLabel>
          <Stack spacing={0.75}>
            {entry.issues.map((i, n) => <IssueRow key={n} issue={i} />)}
          </Stack>
        </Paper>
      )}

      <Box>
        <SectionLabel icon={<Quote size={13} />}>
          Evidence · {entry.evidence.length}
          {entry.evidence_valid === false ? " (unverified)" : ""}
        </SectionLabel>
        <Stack spacing={1}>
          {entry.evidence.length
            ? entry.evidence.map((ev, n) => <EvidenceRow key={n} ev={ev} />)
            : <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                No evidence — which is why this step is {entry.classification}.
              </Typography>}
        </Stack>
      </Box>

      {entry.integration_impacts.length > 0 && (
        <Box>
          <SectionLabel icon={<Network size={13} />}>Integration impact</SectionLabel>
          <Stack spacing={0.75}>
            {entry.integration_impacts.map((imp, n) => (
              <Stack key={n} direction="row"  spacing={1} sx={{ alignItems: "center" }}>
                <Chip size="small" label={imp.impact} sx={{ height: 20, fontSize: 10.5, textTransform: "uppercase", fontWeight: 700 }} />
                <Typography sx={{ fontSize: 12.5, fontWeight: 600, cursor: "pointer" }} onClick={() => onGraph(imp.system)}>
                  {imp.system}
                </Typography>
                {imp.interface_ref && (
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{imp.interface_ref}</Typography>
                )}
              </Stack>
            ))}
          </Stack>
        </Box>
      )}

      {entry.decision_points.length > 0 && (
        <Box>
          <SectionLabel icon={<Compass size={13} />}>Decisions for Solvay</SectionLabel>
          <Stack spacing={1.25}>
            {entry.decision_points.map((dp, n) => (
              <Paper key={n} sx={{ p: 1.25, bgcolor: alpha(theme.palette.primary.main, 0.05) }}>
                <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.75 }}>{dp.question}</Typography>
                <Stack spacing={0.4}>
                  {dp.options.map((o, i) => (
                    <Stack key={i} direction="row" spacing={0.75} sx={{ alignItems: "flex-start" }}>
                      <ChevronRight size={13} style={{ marginTop: 2, flexShrink: 0 }} />
                      <Typography sx={{ fontSize: 12.5 }}>{o}</Typography>
                    </Stack>
                  ))}
                </Stack>
                {dp.consequence_note && (
                  <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.75, fontStyle: "italic" }}>
                    {dp.consequence_note}
                  </Typography>
                )}
              </Paper>
            ))}
          </Stack>
        </Box>
      )}

      {entry.open_questions.length > 0 && (
        <Box>
          <SectionLabel icon={<CircleHelp size={13} />}>Open questions</SectionLabel>
          <Stack spacing={0.5}>
            {entry.open_questions.map((q, n) => (
              <Typography key={n} sx={{ fontSize: 12.5 }}>• {q}</Typography>
            ))}
          </Stack>
        </Box>
      )}

      <Divider />

      {/* AI proposes, humans decide: nothing here changes the entry, it only
          records what a named person concluded next to it. */}
      <Box>
        <SectionLabel icon={<BookOpenCheck size={13} />}>Human decision</SectionLabel>
        {reviews.length > 0 && (
          <Stack spacing={0.5} sx={{ mb: 1.25 }}>
            {reviews.map((r) => (
              <Stack key={r.id} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Chip size="small" label={r.verdict} color={r.verdict === "accept" ? "success" : r.verdict === "reject" ? "error" : "warning"}
                      sx={{ height: 19, fontSize: 10.5, fontWeight: 700 }} />
                <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{r.reviewer}</Typography>
                {r.corrected_classification && <ClassBadge value={r.corrected_classification} size="sm" />}
                <Typography sx={{ fontSize: 11.5, color: "text.secondary", flex: 1, minWidth: 0 }} noWrap>
                  {r.comment}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <TextField size="small" placeholder="Your name" value={reviewer}
                     onChange={(e) => setReviewer(e.target.value)} sx={{ flex: 1 }} />
          <Select size="small" displayEmpty value={corrected}
                  onChange={(e) => setCorrected(e.target.value as FitGapClass | "")} sx={{ minWidth: 150 }}>
            <MenuItem value="">Keep classification</MenuItem>
            {(Object.keys(CLASSES) as FitGapClass[]).map((c) => (
              <MenuItem key={c} value={c} sx={{ fontSize: 13 }}>{CLASSES[c].label}</MenuItem>
            ))}
          </Select>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="contained" color="success" disabled={!reviewer.trim() || !!busy}
                  startIcon={busy === "accept" ? <CircularProgress size={13} /> : <Check size={15} />}
                  onClick={() => send("accept")}>Accept</Button>
          <Button size="small" variant="outlined" color="warning" disabled={!reviewer.trim() || !!busy}
                  startIcon={<Wrench size={15} />} onClick={() => send("refine")}>Refine</Button>
          <Button size="small" variant="outlined" color="error" disabled={!reviewer.trim() || !!busy}
                  startIcon={<X size={15} />} onClick={() => send("reject")}>Reject</Button>
        </Stack>
        {!reviewer.trim() && (
          <Typography sx={{ fontSize: 11, color: "text.disabled", mt: 0.75 }}>
            A verdict needs a name against it — that is the whole point of the review loop.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

/* ------------------------------------------------------------------ synthesis */

function ReuseBar({ synth }: { synth: FitGapSynthesis }) {
  const hue = useHue();
  const theme = useTheme();
  const counts = synth.reuse.by_class;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const order = (Object.keys(CLASSES) as FitGapClass[]).filter((c) => counts[c]);
  return (
    <Box>
      <Stack direction="row" sx={{ height: 12, borderRadius: 6, overflow: "hidden", bgcolor: theme.palette.divider }}>
        {order.map((c) => (
          <Tooltip key={c} title={`${CLASSES[c].label}: ${counts[c]}`}>
            <Box
              component={motion.div}
              initial={{ flexGrow: 0 }}
              animate={{ flexGrow: counts[c] / total }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              sx={{ bgcolor: hue(CLASSES[c].hue), flexBasis: 0 }}
            />
          </Tooltip>
        ))}
      </Stack>
      <Stack direction="row"   useFlexGap sx={{ flexWrap: "wrap", gap: 1.25, mt: 1 }}>
        {order.map((c) => (
          <Stack key={c} direction="row"  spacing={0.6} sx={{ alignItems: "center" }}>
            <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: hue(CLASSES[c].hue) }} />
            <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
              {CLASSES[c].label} <b style={{ color: hue(CLASSES[c].hue) }}>{counts[c]}</b>
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function SynthesisView({ synth, tab }: { synth: FitGapSynthesis; tab: number }) {
  const theme = useTheme();
  const hue = useHue();

  if (tab === 0) {
    const r = synth.reuse;
    return (
      <Stack spacing={2.5}>
        <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 2 }}>
          <Paper sx={{ p: 2, flex: "1 1 190px" }}>
            <Typography variant="overline" color="text.secondary">Reuse of classified steps</Typography>
            <Typography sx={{ fontSize: 38, fontWeight: 800, lineHeight: 1.1, color: theme.palette.success.main }}>
              {r.reuse_pct === null ? "—" : <CountUp value={r.reuse_pct} suffix="%" decimals={1} />}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{r.note}</Typography>
          </Paper>
          <Paper sx={{ p: 2, flex: "1 1 160px" }}>
            <Typography variant="overline" color="text.secondary">Coverage</Typography>
            <Typography sx={{ fontSize: 38, fontWeight: 800, lineHeight: 1.1 }}>
              <CountUp value={r.coverage_pct} suffix="%" decimals={1} />
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
              {r.classified} of {plural(r.steps, "step")} classified; the rest are UNKNOWN.
            </Typography>
          </Paper>
          <Paper sx={{ p: 2, flex: "1 1 160px" }}>
            <Typography variant="overline" color="text.secondary">Average confidence</Typography>
            <Typography sx={{ fontSize: 38, fontWeight: 800, lineHeight: 1.1 }}>
              <CountUp value={r.avg_confidence} decimals={2} />
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
              {Object.entries(r.confidence_bins).map(([bin, n]) => (
                <Tooltip key={bin} title={`${bin}: ${n}`}>
                  <Box sx={{ flex: 1, textAlign: "center" }}>
                    <Box sx={{ height: 24, display: "flex", alignItems: "flex-end" }}>
                      <Box component={motion.div} initial={{ height: 0 }}
                           animate={{ height: `${Math.min(100, (n / Math.max(...Object.values(r.confidence_bins), 1)) * 100)}%` }}
                           sx={{ width: "100%", bgcolor: alpha(theme.palette.primary.main, 0.5), borderRadius: 0.5 }} />
                    </Box>
                    <Typography sx={{ fontSize: 8.5, color: "text.disabled" }}>{bin}</Typography>
                  </Box>
                </Tooltip>
              ))}
            </Stack>
          </Paper>
        </Stack>

        <Paper sx={{ p: 2 }}>
          <SectionLabel icon={<Layers size={13} />}>Class mix</SectionLabel>
          <ReuseBar synth={synth} />
        </Paper>

        <Paper sx={{ p: 2 }}>
          <SectionLabel icon={<Layers size={13} />}>By process</SectionLabel>
          <Stack spacing={1}>
            {r.by_process.map((p) => (
              <Stack key={p.code} direction="row"  spacing={1.5} sx={{ alignItems: "center" }}>
                <Typography sx={{ fontSize: 12.5, flex: "1 1 auto", minWidth: 0 }} noWrap>{p.label}</Typography>
                <Stack direction="row" spacing={0.5}>
                  <Chip size="small" label={`${p.fit} fit`} sx={{ height: 19, fontSize: 10, bgcolor: alpha(theme.palette.success.main, 0.15) }} />
                  <Chip size="small" label={`${p.gap} gap`} sx={{ height: 19, fontSize: 10, bgcolor: alpha(theme.palette.warning.main, 0.15) }} />
                  {p.unknown > 0 && <Chip size="small" label={`${p.unknown} ?`} sx={{ height: 19, fontSize: 10 }} />}
                </Stack>
                <Typography sx={{ fontSize: 12, fontWeight: 700, width: 52, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {p.reuse_pct === null ? "—" : `${p.reuse_pct}%`}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Paper>
      </Stack>
    );
  }

  if (tab === 1) {
    return (
      <Stack spacing={1.25}>
        {!synth.gaps.length && <Typography color="text.secondary">No gaps proposed in this scope.</Typography>}
        {synth.gaps.map((g) => (
          <Paper key={g.bpml_code} sx={{ p: 1.75, borderLeft: `3px solid ${hue(CLASSES[g.classification].hue)}` }}>
            <Stack direction="row"  spacing={1} sx={{ alignItems: "center", mb: 0.75 }}>
              <Typography sx={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 700 }}>{g.bpml_code}</Typography>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>{g.step_name}</Typography>
              <ClassBadge value={g.classification} size="sm" />
              <Chip size="small" label={MATERIALITY[g.materiality].label} variant="outlined" sx={{ height: 19, fontSize: 10.5 }} />
              <ConfidenceMeter value={g.confidence} width={60} />
            </Stack>
            <Typography sx={{ fontSize: 12.5, color: "text.secondary", lineHeight: 1.6 }}>{g.rationale}</Typography>
            {g.linked_tickets.length > 0 && (
              <Stack direction="row"  useFlexGap sx={{ gap: 0.6, flexWrap: "wrap", mt: 0.75 }} >
                {g.linked_tickets.map((t) => <Chip key={t} size="small" label={t} sx={{ height: 19, fontSize: 10 }} />)}
              </Stack>
            )}
          </Paper>
        ))}
      </Stack>
    );
  }

  if (tab === 2) {
    return (
      <Stack spacing={1.5}>
        {!synth.decisions.length && <Typography color="text.secondary">No decision points were raised.</Typography>}
        {synth.decisions.map((d, n) => (
          <Paper key={n} sx={{ p: 1.75 }}>
            <Stack direction="row"  spacing={1} sx={{ alignItems: "flex-start" }}>
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 700, mb: 0.4 }}>{d.question}</Typography>
                <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{d.process}</Typography>
              </Box>
              <Tooltip title="Decision weight: Σ materiality × (1 − confidence) over the steps that raised it">
                <Chip size="small" label={`weight ${d.weight}`} sx={{ height: 20, fontSize: 10.5 }} />
              </Tooltip>
            </Stack>
            <Stack spacing={0.4} sx={{ mt: 1 }}>
              {d.options.map((o, i) => (
                <Stack key={i} direction="row" spacing={0.75} sx={{ alignItems: "flex-start" }}>
                  <ChevronRight size={13} style={{ marginTop: 2, flexShrink: 0 }} />
                  <Typography sx={{ fontSize: 12.5 }}>{o}</Typography>
                </Stack>
              ))}
            </Stack>
            {d.consequence_note && (
              <Typography sx={{ fontSize: 12, fontStyle: "italic", color: "text.secondary", mt: 0.75 }}>
                {d.consequence_note}
              </Typography>
            )}
            <Stack direction="row"  useFlexGap sx={{ gap: 0.5, flexWrap: "wrap", mt: 1 }} >
              {d.steps.map((s) => (
                <Chip key={s.bpml_code} size="small" variant="outlined" label={s.bpml_code}
                      sx={{ height: 18, fontSize: 10, fontFamily: "ui-monospace, monospace" }} />
              ))}
            </Stack>
          </Paper>
        ))}
      </Stack>
    );
  }

  if (tab === 3) {
    return (
      <Stack spacing={1.25}>
        {!synth.integrations.length && <Typography color="text.secondary">No integration impacts were identified.</Typography>}
        {synth.integrations.map((i) => (
          <Paper key={i.system} sx={{ p: 1.75 }}>
            <Stack direction="row"  spacing={1} sx={{ alignItems: "center" }}>
              <Network size={15} />
              <Typography sx={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{i.system}</Typography>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{plural(i.step_count, "step")}</Typography>
            </Stack>
            <Stack direction="row"  useFlexGap sx={{ gap: 0.6, flexWrap: "wrap", mt: 1 }} >
              {Object.entries(i.impacts).map(([k, v]) => (
                <Chip key={k} size="small" label={`${k} × ${v}`} sx={{ height: 19, fontSize: 10.5 }} />
              ))}
              {i.interfaces.map((r) => (
                <Chip key={r} size="small" variant="outlined" label={r} sx={{ height: 19, fontSize: 10.5 }} />
              ))}
            </Stack>
            <Stack direction="row"  useFlexGap sx={{ gap: 0.5, flexWrap: "wrap", mt: 1 }} >
              {i.steps.map((s) => (
                <Tooltip key={s.bpml_code} title={s.step_name}>
                  <Chip size="small" variant="outlined" label={s.bpml_code}
                        sx={{ height: 18, fontSize: 10, fontFamily: "ui-monospace, monospace" }} />
                </Tooltip>
              ))}
            </Stack>
          </Paper>
        ))}
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      {!synth.agenda.length && <Typography color="text.secondary">Nothing in this scope needs workshop time.</Typography>}
      {synth.agenda.map((s) => (
        <Paper key={s.code} sx={{ p: 1.75 }}>
          <Stack direction="row"  spacing={1.25} sx={{ alignItems: "center" }}>
            <Box sx={{ width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center",
                       bgcolor: alpha(theme.palette.primary.main, 0.15), color: "primary.main",
                       fontWeight: 800, fontSize: 12 }}>
              {s.order}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 700 }} noWrap>{s.process}</Typography>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                {plural(s.steps, "step")} · {s.gaps} gaps · {s.unresolved} unresolved
              </Typography>
            </Box>
            <Chip size="small" icon={<CalendarClock size={12} />} label={`${s.minutes} min`} sx={{ height: 22, fontSize: 11 }} />
            <Tooltip title="Σ materiality × (1 − confidence): what this session has to resolve">
              <Chip size="small" label={`weight ${s.weight}`} variant="outlined" sx={{ height: 22, fontSize: 11 }} />
            </Tooltip>
          </Stack>
          {s.decisions.length > 0 && (
            <Stack spacing={0.4} sx={{ mt: 1.25 }}>
              {s.decisions.map((q, n) => (
                <Typography key={n} sx={{ fontSize: 12.5 }}><b>Decide:</b> {q}</Typography>
              ))}
            </Stack>
          )}
          {s.open_questions.length > 0 && (
            <Stack spacing={0.3} sx={{ mt: 0.75 }}>
              {s.open_questions.map((q, n) => (
                <Typography key={n} sx={{ fontSize: 12, color: "text.secondary" }}>Open: {q}</Typography>
              ))}
            </Stack>
          )}
          {s.pre_read.length > 0 && (
            <Stack direction="row"   useFlexGap sx={{ gap: 0.5, flexWrap: "wrap", mt: 1 }}>
              {s.pre_read.map((d) => (
                <Chip key={d} size="small" variant="outlined" label={d} sx={{ height: 18, fontSize: 9.5, maxWidth: 260 }} />
              ))}
            </Stack>
          )}
        </Paper>
      ))}
    </Stack>
  );
}


/* --------------------------------------------------- sample question picker */

function ExpectationDot({ value }: { value: Expectation }) {
  const theme = useTheme();
  const colour =
    value === "strong" ? theme.palette.success.main
      : value === "partial" ? theme.palette.warning.main
        : value === "weak" ? theme.palette.error.main
          : theme.palette.text.disabled;
  return (
    <Box sx={{
      width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
      bgcolor: value === "blind" ? "transparent" : colour,
      border: value === "blind" ? `1.5px solid ${colour}` : "none",
    }} />
  );
}

/** The corpus-grounded evaluation questions, as a searchable list.
 *  Picking one sets both the question and the BPML scope it belongs to, so a
 *  register can be run over exactly the process step the question is about. */
function QuestionPicker({
  value, onPick, onClear, disabled,
}: {
  value: EvalQuestion | null;
  onPick: (q: EvalQuestion) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [axis, setAxis] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const options = useMemo<EvalQuestion[]>(
    () => EVAL_QUESTIONS_BY_GROUP.filter((q) => !axis || q.axis === axis),
    [axis],
  );
  const heavyCount = options.filter((q) => q.heavy).length;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <FlaskConical size={14} color={theme.palette.text.secondary} />
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
          Evaluation set · {EVAL_QUESTIONS.length} questions
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Pick one at random">
          <span>
            <IconButton size="small" disabled={disabled}
                        onClick={() => onPick(options[Math.floor(Math.random() * options.length)])}>
              <Dices size={15} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {/* Filtering the set by the dimension each question isolates is faster than
          reading them all, and it makes the shape of the set visible. */}
      <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.6, mb: 1.25 }}>
        <Chip
          size="small" label="All" variant={axis ? "outlined" : "filled"}
          color={axis ? "default" : "primary"} onClick={() => setAxis(null)}
          sx={{ height: 22, fontSize: 11 }}
        />
        {Array.from(new Set(EVAL_QUESTIONS.map((q) => q.axis))).map((a) => (
          <Chip
            key={a} size="small" label={a}
            variant={axis === a ? "filled" : "outlined"}
            color={axis === a ? "primary" : "default"}
            onClick={() => setAxis(axis === a ? null : a)}
            sx={{ height: 22, fontSize: 11 }}
          />
        ))}
      </Stack>

      <Autocomplete
        openOnFocus
        disabled={disabled}
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        value={value}
        options={options}
        // Grouped by corpus first: which half of the corpus a question needs
        // is the coarser distinction, and the ones that need both are the
        // point of keeping the categories apart.
        groupBy={(q) => `${CATEGORY_LABEL[q.category]}  ·  ${HALVES[q.half].title}`}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        getOptionLabel={(q) => q.question}
        onChange={(_, q) => (q ? onPick(q) : onClear())}
        // Search the axis and the id too, so "provenance" or "Q13" both land.
        filterOptions={(opts, { inputValue }) => {
          const needle = inputValue.trim().toLowerCase();
          if (!needle) return opts;
          return opts.filter((q) =>
            `${q.id} ${q.axis} ${q.question} ${q.scopeLabel}`.toLowerCase().includes(needle));
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            placeholder="Pick an evaluation question, or type to search…"
            slotProps={{
              ...params.slotProps,
              input: {
                ...params.slotProps.input,
                startAdornment: (
                  <>
                    <Box sx={{ pl: 0.5, pr: 0.75, display: "flex", color: "text.secondary" }}>
                      <Search size={15} />
                    </Box>
                    {params.slotProps.input.startAdornment}
                  </>
                ),
              },
            }}
          />
        )}
        renderGroup={(params) => (
          <Box key={params.key} component="li" sx={{ listStyle: "none" }}>
            <ListSubheader
              sx={{
                bgcolor: "background.paper", lineHeight: "30px", fontSize: 11, fontWeight: 800,
                letterSpacing: ".05em", textTransform: "uppercase", color: "text.secondary",
                borderBottom: 1, borderColor: "divider",
              }}
            >
              {params.group}
            </ListSubheader>
            <Box component="ul" sx={{ p: 0, m: 0 }}>{params.children}</Box>
          </Box>
        )}
        renderOption={(props, q) => {
          const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
          return (
            <Box component="li" key={q.id} {...rest}
                 sx={{ display: "block !important", py: 1, px: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.35 }}>
                <Box component="span" sx={{
                  fontFamily: "ui-monospace, monospace", fontSize: 10.5, fontWeight: 800,
                  px: 0.6, py: 0.15, borderRadius: 0.75, color: "primary.main",
                  bgcolor: alpha(theme.palette.primary.main, 0.12),
                }}>
                  {q.id}
                </Box>
                <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: "text.secondary",
                                  textTransform: "uppercase", letterSpacing: ".04em" }}>
                  {q.axis}
                </Typography>
                {q.heavy && (
                  <Tooltip title="Double weight — a fluent, specific, materially misleading answer is possible here">
                    <Box sx={{ display: "flex", color: "warning.main" }}><TriangleAlert size={12} /></Box>
                  </Tooltip>
                )}
                <Box sx={{ flex: 1 }} />
                <Stack direction="row" spacing={0.4} sx={{ alignItems: "center" }}>
                  {(["rag", "graph", "copilot"] as Engine[]).map((e) => (
                    <ExpectationDot key={e} value={q.expect[e]} />
                  ))}
                </Stack>
              </Stack>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.45 }}>{q.question}</Typography>
              <Typography sx={{ fontSize: 10.5, color: "text.disabled", mt: 0.25 }}>
                scope {q.scope} {q.scopeLabel} · {plural(q.steps, "step")}
              </Typography>
            </Box>
          );
        }}
        slotProps={{ paper: { sx: { width: { xs: "100%", md: 620 } } } }}
      />

      {axis && (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", mt: 0.6 }}>
          {plural(options.length, "question")} on this axis
          {heavyCount ? ` · ${heavyCount} double-weighted` : ""}
        </Typography>
      )}
    </Box>
  );
}

/** What the selected question is actually measuring, and how to mark it. */
function QuestionBriefing({
  q, onRun, running, maxSteps,
}: { q: EvalQuestion; onRun: () => void; running: boolean; maxSteps: number }) {
  const theme = useTheme();
  // Some questions sit on a single level-4 step and map cleanly onto a
  // register run. Others are corpus-wide and their scope is a whole subtree,
  // so a default run classifies a fraction of it. Say so rather than letting
  // the step counter imply the question was answered.
  const partial = q.steps > maxSteps;
  return (
    <Paper
      component={motion.div}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25 }}
      sx={{ p: 1.75, mt: 1.5, bgcolor: alpha(theme.palette.primary.main, 0.045), overflow: "hidden" }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.25, flexWrap: "wrap" }}>
        <Chip size="small" label={q.id} color="primary"
              sx={{ height: 20, fontSize: 10.5, fontWeight: 800, fontFamily: "ui-monospace, monospace" }} />
        <Chip size="small" variant="outlined" label={q.axis} sx={{ height: 20, fontSize: 10.5 }} />
        <Chip size="small" variant="outlined" icon={<Target size={11} />}
              label={`${q.scope} ${q.scopeLabel}`} sx={{ height: 20, fontSize: 10.5 }} />
        {q.heavy && (
          <Chip size="small" color="warning" variant="outlined" icon={<TriangleAlert size={11} />}
                label="double weight" sx={{ height: 20, fontSize: 10.5 }} />
        )}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" disabled={running}
                startIcon={<SendHorizontal size={14} />} onClick={onRun}>
          Run this one
        </Button>
      </Stack>

      <Stack spacing={1.1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
          <Box sx={{ pt: 0.2, color: "text.secondary", display: "flex" }}><FlaskConical size={13} /></Box>
          <Box>
            <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em",
                              textTransform: "uppercase", color: "text.secondary" }}>
              What it tests
            </Typography>
            <Typography sx={{ fontSize: 12.5, lineHeight: 1.55 }}>{q.tests}</Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
          <Box sx={{ pt: 0.2, color: "warning.main", display: "flex" }}><Eye size={13} /></Box>
          <Box>
            <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em",
                              textTransform: "uppercase", color: "warning.main" }}>
              Watch for
            </Typography>
            <Typography sx={{ fontSize: 12.5, lineHeight: 1.55 }}>{q.watchFor}</Typography>
          </Box>
        </Stack>

        {q.mustNot && (
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <Box sx={{ pt: 0.2, color: "error.main", display: "flex" }}><Ban size={13} /></Box>
            <Box>
              <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em",
                                textTransform: "uppercase", color: "error.main" }}>
                Must not — automatic fail
              </Typography>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.55 }}>{q.mustNot}</Typography>
            </Box>
          </Stack>
        )}
      </Stack>

      {partial && (
        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", mt: 1.1 }}>
          <Box sx={{ pt: 0.2, color: "text.secondary", display: "flex" }}><Layers size={13} /></Box>
          <Box>
            <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em",
                              textTransform: "uppercase", color: "text.secondary" }}>
              Scope coverage
            </Typography>
            <Typography sx={{ fontSize: 12.5, lineHeight: 1.55 }}>
              {q.scope} holds {plural(q.steps, "step")} and this run classifies {maxSteps}. A register
              over part of the subtree will not answer this on its own — read it alongside the same
              question put to Ask and to the Graph, or raise the step limit in Options.
            </Typography>
          </Box>
        </Stack>
      )}

      <Divider sx={{ my: 1.25 }} />
      <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
        <Typography sx={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em",
                          textTransform: "uppercase", color: "text.secondary" }}>
          Expected
        </Typography>
        {(["rag", "graph", "copilot"] as Engine[]).map((e) => (
          <Tooltip key={e} title={`${ENGINE_LABEL[e]}: ${EXPECTATION_LABEL[q.expect[e]]}`}>
            <Stack direction="row" spacing={0.6} sx={{ alignItems: "center" }}>
              <ExpectationDot value={q.expect[e]} />
              <Typography sx={{ fontSize: 11.5 }}>
                {ENGINE_LABEL[e]}{" "}
                <Box component="span" sx={{ color: "text.disabled" }}>
                  {EXPECTATION_LABEL[q.expect[e]].toLowerCase()}
                </Box>
              </Typography>
            </Stack>
          </Tooltip>
        ))}
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>
          predictions to score, not claims
        </Typography>
      </Stack>
    </Paper>
  );
}

/* ----------------------------------------------------------------- the page */

interface Props {
  active: boolean;
  onShowInGraph?: (text: string) => void;
}

export default function FitGapPage({ active, onShowInGraph }: Props) {
  const theme = useTheme();
  const [status, setStatus] = useState<FitGapStatus | null>(null);
  const [question, setQuestion] = useState("");
  // The evaluation question currently loaded, if the analyst picked one from
  // the set rather than typing their own. Cleared as soon as they edit the text.
  const [picked, setPicked] = useState<EvalQuestion | null>(null);
  const [scopeText, setScopeText] = useState("4.5.1");
  const [matches, setMatches] = useState<BpmlProcess[]>([]);
  const [scope, setScope] = useState<BpmlProcess | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [plan, setPlan] = useState<FitGapPreview | null>(null);

  const [mode, setMode] = useState<"A" | "B">("A");
  const [holdout, setHoldout] = useState(false);
  // Every run reads the whole corpus. Runs made while the scope could be
  // narrowed still record what they were pointed at, and the history below
  // still shows it, but a new run is not given the choice.
  const [country, setCountry] = useState("");
  const countryError = (() => {
    if (!country.trim()) return null;
    try { JSON.parse(country); return null; } catch (e) { return (e as Error).message; }
  })();
  const [maxSteps, setMaxSteps] = useState(4);
  const [concurrency, setConcurrency] = useState(3);
  const [showOptions, setShowOptions] = useState(false);

  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [synth, setSynth] = useState<FitGapSynthesis | null>(null);
  const [summary, setSummary] = useState<Parameters<Parameters<typeof runFitGap>[1]["done"]>[0] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState(() => {
    try { return localStorage.getItem("fitgap.reviewer") ?? ""; } catch { return ""; }
  });
  // Documents attached to this session. The id is kept in localStorage so a
  // reload does not orphan a store the analyst is still working with; the
  // server sweeps it either way once it expires.
  const [uploadSession, setUploadSession] = useState(() => {
    try { return localStorage.getItem("fitgap.uploads") ?? ""; } catch { return ""; }
  });
  const [uploads, setUploads] = useState<UploadSession | null>(null);
  const [comparison, setComparison] = useState<UploadComparison | null>(null);
  const [uploading, setUploading] =
    useState<{ filename: string; index: number; total: number; stage: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [history, setHistory] = useState<FitGapRunSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    try { localStorage.setItem("fitgap.reviewer", reviewer); } catch { /* private mode */ }
  }, [reviewer]);

  useEffect(() => {
    if (!active) return;
    fitgap.status().then(setStatus).catch(() => setStatus(null));
    fitgap.runs().then(setHistory).catch(() => setHistory([]));
  }, [active]);

  const refreshUploads = useCallback(async (id: string) => {
    if (!id) { setUploads(null); setComparison(null); return; }
    try {
      const info = await fitgap.uploads.status(id);
      if (!info.exists) {
        // Swept while the tab was open. Forget it rather than show a store
        // that is no longer there.
        setUploadSession("");
        setUploads(null);
        setComparison(null);
        return;
      }
      setUploads(info);
      setComparison(info.documents > 0 ? await fitgap.uploads.entities(id) : null);
    } catch {
      setUploads(null);
      setComparison(null);
    }
  }, []);

  useEffect(() => {
    try {
      if (uploadSession) localStorage.setItem("fitgap.uploads", uploadSession);
      else localStorage.removeItem("fitgap.uploads");
    } catch { /* private mode */ }
  }, [uploadSession]);

  useEffect(() => {
    if (active) void refreshUploads(uploadSession);
  }, [active, uploadSession, refreshUploads]);

  // Resolve what the user typed into a real place in the BPML tree while they
  // type, so the scope is never a surprise once the run starts.
  useEffect(() => {
    const text = scopeText.trim();
    if (!text) { setMatches([]); setScope(null); return; }
    const t = setTimeout(() => {
      fitgap.search(text)
        .then((r) => { setMatches(r.matches); setScope(r.matches[0] ?? null); })
        .catch(() => setMatches([]));
    }, 220);
    return () => clearTimeout(t);
  }, [scopeText]);

  useEffect(() => {
    if (!scope) { setPlan(null); return; }
    fitgap.preview({ scope_bpml: scope.code, max_steps: maxSteps, concurrency, mode, holdout, categories: [] })
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [scope, maxSteps, concurrency, mode, holdout]);

  const doneCount = steps.filter((s) => s.state === "done" || s.state === "failed").length;
  const current = steps.find((s) => s.code === openEntry);

  const patch = useCallback((code: string, fn: (s: LiveStep) => LiveStep) => {
    setSteps((ss) => ss.map((s) => (s.code === code ? fn(s) : s)));
  }, []);

  const pickQuestion = (q: EvalQuestion) => {
    setPicked(q);
    setQuestion(q.question);
    setScopeText(q.scope);
  };

  const clearQuestion = () => {
    setPicked(null);
    setQuestion("");
  };

  async function start() {
    if (running || !scope) return;
    setRunning(true);
    setError(null);
    setSynth(null);
    setSummary(null);
    setRunId(null);
    setOpenEntry(null);
    setTab(0);
    setSteps((plan?.steps ?? []).map((s) => ({ code: s.code, name: s.name, state: "waiting", tools: [] })));
    const ctrl = new AbortController();
    controller.current = ctrl;
    try {
      await runFitGap(
        {
          mode, scope_bpml: scope.code, holdout, max_steps: maxSteps, concurrency, categories: [],
          upload_session: (uploads?.documents ?? 0) > 0 ? uploadSession : null,
          // Tag the run with the eval id so a stored register can be traced
          // back to the question that produced it.
          question: picked ? `[${picked.id} · ${picked.axis}] ${question.trim()}` : question.trim() || null,
          country_profile: mode === "B" && country.trim() && !countryError ? JSON.parse(country) : null,
        },
        {
          scope: (d) => {
            setRunId(d.run_id);
            setSteps(d.steps.map((s) => ({ code: s.code, name: s.name, state: "waiting", tools: [] })));
          },
          stepStart: (d) => patch(d.bpml_code, (s) => ({ ...s, state: "running" })),
          toolCall: (d) =>
            patch(d.bpml_code, (s) => ({
              ...s,
              tools: [...s.tools, { tool: d.tool, summary: d.summary, error: d.error }],
            })),
          entry: (d) => patch(d.bpml_code, (s) => ({ ...s, state: "done", entry: d })),
          verifyFail: () => { /* surfaced on the entry itself, as issues */ },
          stepError: (d) => patch(d.bpml_code, (s) => ({ ...s, state: "failed", message: d.message })),
          synthesis: setSynth,
          done: setSummary,
          error: setError,
        },
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      controller.current = null;
      fitgap.runs().then(setHistory).catch(() => undefined);
    }
  }

  function stop() {
    controller.current?.abort();
    setRunning(false);
  }

  async function addUploads(files: File[]) {
    setUploadError(null);
    let id = uploadSession;
    try {
      await uploadSessionDocuments(files, id, "other", {
        session: (d) => { id = d.session; setUploadSession(d.session); },
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

  async function removeUpload(name: string) {
    try {
      await fitgap.uploads.remove(uploadSession, name);
    } catch (e) {
      setUploadError((e as Error).message);
    }
    await refreshUploads(uploadSession);
  }

  async function clearUploads() {
    const id = uploadSession;
    setUploadSession("");
    setUploads(null);
    setComparison(null);
    setUploadError(null);
    try { if (id) await fitgap.uploads.drop(id); } catch { /* already swept */ }
  }

  /** The history summaries as the drawer's cards. */
  const historyCards: HistoryCard[] = useMemo(
    () => history.map((r) => ({
      id: r.id,
      title: r.scope_label,
      subtitle: r.question,
      startedAt: r.started_at,
      badges: (
        <>
          <Chip size="small" variant="outlined" label={`Mode ${r.mode}`}
                sx={{ height: 18, fontSize: 9.5 }} />
          {r.status !== "done" && (
            <Chip size="small" variant="outlined"
                  color={r.status === "failed" ? "error" : "warning"}
                  label={r.status} sx={{ height: 18, fontSize: 9.5 }} />
          )}
          {r.holdout && (
            <Chip size="small" variant="outlined" label="holdout" sx={{ height: 18, fontSize: 9.5 }} />
          )}
          {/* The attachment is swept within hours, so the count is all a
              reopened register can show for it. */}
          {!!r.uploads?.documents?.length && (
            <Chip size="small" variant="outlined" icon={<Paperclip size={10} />}
                  label={r.uploads.documents.length}
                  sx={{ height: 18, fontSize: 9.5, "& .MuiChip-icon": { ml: 0.4 } }} />
          )}
        </>
      ),
      meta: [
        plural(r.entries, "entry", "entries"),
        r.reuse_pct !== null ? `${r.reuse_pct}% reuse` : "",
        r.coverage_pct !== null ? `${r.coverage_pct}% covered` : "",
      ].filter(Boolean).join(" · "),
    })),
    [history],
  );

  async function loadRun(id: string) {
    try {
      const run = await fitgap.run(id);
      setRunId(run.id);
      setScopeText(run.scope_bpml);
      setQuestion(run.question || "");
      setPicked(EVAL_QUESTIONS.find((q) => (run.question || "").startsWith(`[${q.id} `)) ?? null);
      setMode(run.mode);
      setHoldout(run.holdout);
      setCountry(run.country ? JSON.stringify(run.country, null, 2) : "");
      setSteps(run.entries.map((e) => ({ code: e.bpml_code, name: e.step_name, state: "done", tools: [], entry: e })));
      setSynth((run.synthesis && "reuse" in run.synthesis ? run.synthesis : null) as FitGapSynthesis | null);
      setSummary(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function review(entry: FitGapEntry, verdict: "accept" | "reject" | "refine", corrected?: FitGapClass) {
    if (!entry.id) return;
    const rec = await fitgap.review(entry.id, {
      reviewer, verdict, corrected_classification: corrected ?? null, comment: "",
    });
    patch(entry.bpml_code, (s) => ({
      ...s,
      entry: s.entry ? { ...s.entry, reviews: [...(s.entry.reviews ?? []), rec] } : s.entry,
    }));
  }

  const blocked = status && (!status.bpml.available || !status.anthropic_key || status.error);

  return (
    <Box sx={{ height: "100%", overflow: "auto", bgcolor: "background.default" }}>
      <Box sx={{ maxWidth: 1320, mx: "auto", p: { xs: 2, md: 3 } }}>
        {/* ---------------------------------------------------------- header */}
        <Stack direction="row"  spacing={2} sx={{ alignItems: "flex-start", mb: 2.5 }}>
          <Box sx={{ flex: 1 }}>
            <Stack direction="row"  spacing={1.25} sx={{ alignItems: "center" }}>
              <Box sx={{ width: 32, height: 32, borderRadius: 2, display: "grid", placeItems: "center",
                         bgcolor: "primary.main", color: "primary.contrastText" }}>
                <Scale size={18} />
              </Box>
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.15 }}>
                  InsightLens
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                  Reads the corpus through both engines and drafts a fit-gap register.
                  <b> AI proposes, humans decide.</b>
                </Typography>
              </Box>
            </Stack>
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            {runId && (
              <>
                <Tooltip title="Download the register as Markdown">
                  <IconButton size="small" component="a" href={fitgap.exportUrl(runId, "md")}><FileText size={16} /></IconButton>
                </Tooltip>
                <Tooltip title="Download the register as XLSX — one sheet per synthesis output, plus a review sheet">
                  <IconButton size="small" component="a" href={fitgap.exportUrl(runId, "xlsx")}><FileSpreadsheet size={16} /></IconButton>
                </Tooltip>
                <Tooltip title="Download the raw JSON">
                  <IconButton size="small" component="a" href={fitgap.exportUrl(runId, "json")}><Download size={16} /></IconButton>
                </Tooltip>
              </>
            )}
            <Tooltip title="Previous runs — read one here, beside the one on the page">
              <IconButton size="small" onClick={() => setHistoryOpen(true)} aria-label="Previous runs">
                <History size={16} />
              </IconButton>
            </Tooltip>
            {/* previous runs, in a drawer beside the current one */}
            <RunHistoryDrawer<FitGapRunDetail>
              open={historyOpen}
              onClose={() => setHistoryOpen(false)}
              icon={<History size={18} />}
              title="Previous runs"
              noun={["run", "runs"]}
              items={historyCards}
              currentId={runId}
              /* No onDelete: /api/fitgap/runs has no DELETE, and a trash icon
                 that throws is worse than no trash icon. */
              fetchDetail={fitgap.run}
              renderDetail={(run) => <PastRegister run={run} />}
              detailActions={(run) => (
                <>
                  <Button size="small" variant="outlined" startIcon={<FileSpreadsheet size={13} />}
                          href={fitgap.exportUrl(run.id, "xlsx")} sx={{ fontSize: 12 }}>
                    XLSX
                  </Button>
                  <Button size="small" variant="text" startIcon={<Download size={13} />}
                          href={fitgap.exportUrl(run.id, "json")} sx={{ fontSize: 12 }}>
                    JSON
                  </Button>
                </>
              )}
              onLoadIntoPage={(id) => void loadRun(id)}
              loadDisabled={running}
              filterPlaceholder="Filter by scope or question…"
              emptyText="Nothing run yet. Run one and it will appear here."
            />
          </Stack>
        </Stack>

        {blocked && (
          <Alert severity="warning" icon={<TriangleAlert size={18} />} sx={{ mb: 2 }}>
            {!status?.bpml.available && <div>The BPML process house could not be read from the corpus ({status?.bpml.error ?? status?.bpml.document}). Scope resolution will not work.</div>}
            {!status?.anthropic_key && <div>No <code>ANTHROPIC_API_KEY</code> is set, so no step can be classified.</div>}
            {status?.error && <div>{status.error}</div>}
          </Alert>
        )}

        {/* ------------------------------------------------------- the query */}
        <Paper sx={{ p: 2, mb: 2.5 }}>
          <TextField
            fullWidth
            multiline
            maxRows={3}
            value={question}
            onChange={(e) => { setQuestion(e.target.value); if (picked) setPicked(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); } }}
            placeholder={`Ask InsightLens about a slice of the process, or pick one of the ${EVAL_QUESTIONS.length} evaluation questions below`}
            slotProps={{
              input: {
                sx: { fontSize: 15, alignItems: "flex-start" },
                startAdornment: <Box sx={{ pt: 0.35, pr: 1.25, color: "primary.main" }}><Sparkles size={18} /></Box>,
                endAdornment: clearAdornment(question, () => { setQuestion(""); setPicked(null); },
                                             { size: 16, label: "Clear question", top: true }),
              },
            }}
          />

          <Box sx={{ mt: 2 }}>
            <QuestionPicker
              value={picked}
              onPick={pickQuestion}
              onClear={clearQuestion}
              disabled={running}
            />
            <AnimatePresence initial={false}>
              {picked && (
                <QuestionBriefing key={picked.id} q={picked} onRun={start} running={running}
                                  maxSteps={maxSteps} />
              )}
            </AnimatePresence>

            <Attachments
              session={uploadSession}
              data={uploads}
              comparison={comparison}
              busy={uploading}
              error={uploadError}
              disabled={running}
              accepted={status?.uploads?.accepted ?? [".pdf", ".docx", ".xlsx", ".pptx"]}
              ttlHours={status?.uploads?.ttl_hours ?? 12}
              maxFiles={status?.uploads?.max_files ?? 12}
              onAdd={addUploads}
              onRemove={removeUpload}
              onClear={clearUploads}
            />
          </Box>

          <Divider sx={{ my: 1.75 }} />

          {/* scope resolution */}
          <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ alignItems: { md: "center" } }}>
            <TextField
              size="small"
              label="Scope — a BPML code or a process name"
              value={scopeText}
              onChange={(e) => setScopeText(e.target.value)}
              onFocus={() => setShowPicker(true)}
              onKeyDown={clearOnEscape(() => setScopeText(""))}
              sx={{ flex: "1 1 320px" }}
              slotProps={{ input: {
                startAdornment: <Box sx={{ pr: 1, color: "text.secondary" }}><Search size={15} /></Box>,
                endAdornment: clearAdornment(scopeText, () => setScopeText(""), { label: "Clear scope" }),
              } }}
            />
            <AnimatePresence mode="wait">
              {scope && (
                <Stack
                  key={scope.code}
                  component={motion.div}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  direction="row"
                  
                  spacing={1}
                  sx={{ alignItems: "center", px: 1.25, py: 0.75, borderRadius: 2, bgcolor: alpha(theme.palette.primary.main, 0.08) }}
                >
                  <Target size={14} color={theme.palette.primary.main} />
                  <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                    {scope.code} {scope.name}
                  </Typography>
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                    L{scope.level} · {plural(plan?.steps_total ?? scope.steps ?? 0, "step")}
                  </Typography>
                </Stack>
              )}
            </AnimatePresence>
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="text" endIcon={<ChevronDown size={15} style={{ transform: showOptions ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />}
                    onClick={() => setShowOptions((v) => !v)}>
              Options
            </Button>
            {running ? (
              <Button variant="outlined" color="error" startIcon={<Square size={15} />} onClick={stop}>Stop</Button>
            ) : (
              <Button
                variant="contained"
                size="large"
                disabled={!scope || !!blocked || (mode === "B" && !!countryError)}
                startIcon={<SendHorizontal size={17} />}
                onClick={start}
                sx={{ px: 2.5 }}
              >
                Run register
              </Button>
            )}
          </Stack>

          <Collapse in={showPicker && matches.length > 1 && !running}>
            <Stack direction="row"   useFlexGap sx={{ flexWrap: "wrap", gap: 0.75, mt: 1.25 }}>
              {matches.slice(0, 8).map((m) => (
                <Chip
                  key={m.code}
                  size="small"
                  label={`${m.code} ${m.name}`}
                  color={scope?.code === m.code ? "primary" : "default"}
                  variant={scope?.code === m.code ? "filled" : "outlined"}
                  onClick={() => { setScope(m); setScopeText(m.code); }}
                  sx={{ fontSize: 11, height: 23, maxWidth: 320 }}
                />
              ))}
            </Stack>
          </Collapse>

          <Collapse in={showOptions}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
              <Box>
                <Typography variant="overline" color="text.secondary">Mode</Typography>
                <ToggleButtonGroup exclusive size="small" value={mode} onChange={(_, v) => v && setMode(v)} sx={{ display: "block", mt: 0.5 }}>
                  <ToggleButton value="A" sx={{ px: 1.5, py: 0.4, fontSize: 12 }}>A · Template baseline</ToggleButton>
                  <ToggleButton value="B" sx={{ px: 1.5, py: 0.4, fontSize: 12 }}>B · Country delta</ToggleButton>
                </ToggleButtonGroup>
                <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5, maxWidth: 280 }}>
                  {mode === "A"
                    ? "Does the template meet this step with standard, configuration or development?"
                    : "What carries over to a new country, what changes, what must be challenged?"}
                </Typography>
              </Box>
              <Box sx={{ minWidth: 190 }}>
                <Typography variant="overline" color="text.secondary">Steps · {maxSteps}</Typography>
                <Slider size="small" min={1} max={20} value={maxSteps} onChange={(_, v) => setMaxSteps(v as number)} valueLabelDisplay="auto" />
                <Typography variant="overline" color="text.secondary">In parallel · {concurrency}</Typography>
                <Slider size="small" min={1} max={6} value={concurrency} onChange={(_, v) => setConcurrency(v as number)} valueLabelDisplay="auto" />
              </Box>
              <Box sx={{ maxWidth: 320 }}>
                <Stack direction="row"  spacing={1} sx={{ alignItems: "center" }}>
                  <Switch size="small" checked={holdout} onChange={(e) => setHoldout(e.target.checked)} />
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Evaluation holdout</Typography>
                </Stack>
                <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>
                  Hides the fit registers and blanks the FIT/GAP tokens in file names and headings, so a
                  score measures reasoning rather than label-reading.
                </Typography>
              </Box>
            </Stack>
            {/* Mode B classifies a country's delta from the template, so it is
                only meaningful with the country's stated position in hand. */}
            <Collapse in={mode === "B"}>
              <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.75 }}>
                  <Typography variant="overline" color="text.secondary">Country profile (JSON)</Typography>
                  <Box sx={{ flex: 1 }} />
                  <Button size="small" variant="text" onClick={() => setCountry(SAMPLE_PROFILE)}>
                    Insert a sample
                  </Button>
                </Stack>
                <TextField
                  fullWidth multiline minRows={3} maxRows={10} size="small"
                  value={country} onChange={(e) => setCountry(e.target.value)}
                  error={!!countryError}
                  helperText={
                    countryError
                      ? `Not valid JSON — ${countryError}`
                      : country.trim()
                        ? "Passed to the agent as the country's stated position, weighed against the corpus."
                        : "Without a profile the agent has only the template to go on, and will mostly answer UNKNOWN."
                  }
                  slotProps={{ input: { sx: { fontFamily: "ui-monospace, monospace", fontSize: 12 } } }}
                />
              </Box>
            </Collapse>
          </Collapse>

          {plan && !running && (
            <Stack direction="row"    useFlexGap sx={{ flexWrap: "wrap", gap: 1, alignItems: "center", mt: 1.75 }}>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                Will classify <b>{plan.steps_planned}</b> of {plural(plan.steps_total, "step")}
                {plan.steps_total > plan.steps_planned && " (raise the step limit in Options for the rest)"}
                {" · ~"}{plan.estimated_minutes} min · ~{Math.round(plan.estimated_input_tokens / 1000)}k input tokens
                {" · "}{plan.model}
              </Typography>
            </Stack>
          )}
        </Paper>

        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

        {/* --------------------------------------------------------- the run */}
        {steps.length > 0 && (
          <Box sx={{ mb: 2.5 }}>
            <SectionLabel
              icon={<Layers size={14} />}
              right={
                <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                  {doneCount} / {plural(steps.length, "step")}
                  {summary && ` · ${summary.seconds}s · ${Math.round((summary.input_tokens + summary.output_tokens) / 1000)}k tokens`}
                </Typography>
              }
            >
              Register {runId && <Box component="span" sx={{ fontFamily: "ui-monospace, monospace", opacity: 0.6 }}>· {runId}</Box>}
            </SectionLabel>
            {running && (
              <LinearProgress
                variant="determinate"
                value={(doneCount / Math.max(steps.length, 1)) * 100}
                sx={{ height: 3, borderRadius: 2, mb: 1.5 }}
              />
            )}
            <Box sx={{ display: "grid", gap: 1.25, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr", lg: "1fr 1fr 1fr" } }}>
              {steps.map((s) => (
                <StepCard key={s.code} step={s} onOpen={() => setOpenEntry(s.code)} />
              ))}
            </Box>
          </Box>
        )}

        {summary && (
          <Paper
            component={motion.div}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            sx={{ p: 1.5, mb: 2.5, bgcolor: alpha(summary.verification.evidence_valid_pct === 100 ? theme.palette.success.main : theme.palette.warning.main, 0.08) }}
          >
            <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", gap: 2 }}>
              <Stack direction="row"  spacing={0.85} sx={{ alignItems: "center" }}>
                <ShieldCheck size={16} color={summary.verification.evidence_valid_pct === 100 ? theme.palette.success.main : theme.palette.warning.main} />
                <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                  Evidence validity {summary.verification.evidence_valid_pct}%
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                {summary.verification.evidence_items} quotes checked against the chunks they name ·{" "}
                {summary.verification.hard_issues} discarded · {summary.verification.soft_issues} flagged ·{" "}
                {summary.verification.entries_repaired} entries repaired
                {summary.failed > 0 && ` · ${summary.failed} step(s) failed`}
              </Typography>
            </Stack>
          </Paper>
        )}

        {/* --------------------------------------------------- the synthesis */}
        {synth && (
          <Paper sx={{ p: { xs: 1.5, md: 2.5 } }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
                  sx={{ mb: 2, minHeight: 40, "& .MuiTab-root": { minHeight: 40, py: 0, fontSize: 13 } }}>
              <Tab label="Reuse assessment" icon={<Target size={15} />} iconPosition="start" />
              <Tab label={`Gap register (${synth.gaps.length})`} icon={<Hammer size={15} />} iconPosition="start" />
              <Tab label={`Decisions (${synth.decisions.length})`} icon={<Compass size={15} />} iconPosition="start" />
              <Tab label={`Integrations (${synth.integrations.length})`} icon={<Network size={15} />} iconPosition="start" />
              <Tab label={`Agenda (${synth.agenda.length})`} icon={<CalendarClock size={15} />} iconPosition="start" />
            </Tabs>
            <AnimatePresence mode="wait">
              <Box key={tab} component={motion.div} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <SynthesisView synth={synth} tab={tab} />
              </Box>
            </AnimatePresence>
          </Paper>
        )}

        {!steps.length && !running && (
          <Paper sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600, mb: 0.5 }}>Nothing run yet</Typography>
            <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 620, mx: "auto" }}>
              Pick a slice of the BPML hierarchy and InsightLens classifies each step under it, one bounded
              agent run at a time: the knowledge graph for identity, hybrid retrieval for substance, and a
              quote from a real chunk behind every claim.
            </Typography>
            {status && (
              <Stack direction="row"    useFlexGap sx={{ justifyContent: "center", flexWrap: "wrap", gap: 1, mt: 2 }}>
                <Chip size="small" variant="outlined" icon={<Layers size={13} />} label={`${status.bpml.processes} BPML processes`} />
                <Chip size="small" variant="outlined" icon={<FileText size={13} />} label={`${status.documents ?? 0} documents · ${status.chunks ?? 0} chunks`} />
                {status.graph && <Chip size="small" variant="outlined" icon={<Network size={13} />} label={`${status.graph.total_nodes} nodes · ${status.graph.total_edges} edges`} />}
                <Chip size="small" variant="outlined" icon={<Sparkles size={13} />} label={status.model} />
              </Stack>
            )}
          </Paper>
        )}
      </Box>

      {/* ------------------------------------------------------------ drawer */}
      <Drawer anchor="right" open={!!current?.entry} onClose={() => setOpenEntry(null)}
              slotProps={{ paper: { sx: { width: { xs: "100%", sm: 560 }, p: 2.5 } } }}>
        <Stack direction="row"  sx={{ justifyContent: "flex-end", mb: 1 }}>
          <IconButton size="small" onClick={() => setOpenEntry(null)}><X size={18} /></IconButton>
        </Stack>
        {current?.entry && (
          <EntryDetail
            entry={current.entry}
            reviewer={reviewer}
            setReviewer={setReviewer}
            onReview={(v, c) => review(current.entry!, v, c)}
            onGraph={(text) => { onShowInGraph?.(text); setOpenEntry(null); }}
          />
        )}
      </Drawer>
    </Box>
  );
}
