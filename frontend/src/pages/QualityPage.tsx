/** The Answer Quality workspace, laid out as an analytical list page.
 *
 *    header        what this is, and the KPIs against their targets
 *    tabs          Answers · Metric matrix · Source documents ·
 *                  Failure analysis · Experiments · Judge calibration
 *    filter bar    one set of filters for the first four tabs
 *    content       small charts that filter, over a dense table
 *
 *  The pattern SAP users read without being taught, chosen for that reason:
 *  the people this is shown to live in Fiori all day. Colour is kept for
 *  exceptions -- a score under the line -- and every status carries a word
 *  as well as a colour. Every answer opens the judge's working in the same
 *  drawer the Ask page uses, with a place for a person's verdict underneath,
 *  which is how the judge gets checked at all.
 */
import {
  Alert, Box, Button, CircularProgress, MenuItem, Paper, Select, Stack, Tab, Tabs, Typography,
} from "@mui/material";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  askHistory, experimentItem, quality, type AskEvaluation, type ExperimentRow,
  type JudgeTrust, type QualityDocument, type QualityExplorer, type QualityFilters,
  type QualityOverview, type QualityPoint,
} from "../api";
import MetricDetailDrawer from "../components/MetricDetailDrawer";
import AnswerListDrawer from "../components/quality/AnswerListDrawer";
import AnswersView, { Field } from "../components/quality/AnswersView";
import DocumentsView from "../components/quality/DocumentsView";
import ExperimentsView from "../components/quality/ExperimentsView";
import ExplorerView, { FOCUS, type Drill } from "../components/quality/ExplorerView";
import JudgeView from "../components/quality/JudgeView";
import MatrixView from "../components/quality/MatrixView";
import { Kpi, RADIUS, ReviewBar, TrustNote } from "../components/quality/parts";

type View = "answers" | "matrix" | "documents" | "analysis" | "experiments" | "judge";
const VIEWS: { value: View; label: string }[] = [
  { value: "answers", label: "Answers" },
  { value: "matrix", label: "Metric matrix" },
  { value: "documents", label: "Source documents" },
  { value: "analysis", label: "Failure analysis" },
  { value: "experiments", label: "Experiments" },
  { value: "judge", label: "Judge calibration" },
];
/** The tabs the filter bar applies to. Experiments compare fixed runs and the
 *  judge's calibration covers every review, so neither takes a window. */
const FILTERED: View[] = ["answers", "matrix", "documents", "analysis"];

/** The order the metric switcher lists them in, matching the scorecard. */
const METRIC_ORDER = [
  "faithfulness", "answer_relevancy", "context_precision", "context_relevance",
  "context_utilization", "coherence", "conciseness", "context_recall", "correctness",
  "harmfulness", "maliciousness", "toxicity", "bias",
];

/** The KPI names: the metrics' own, as a technical reader expects them. */
const KPI_LABEL: Record<string, string> = {
  overall: "Overall quality",
  faithfulness: "Faithfulness",
  context_relevance: "Context relevance",
  answer_relevancy: "Answer relevancy",
};
const KPI_ORDER = ["overall", "faithfulness", "context_relevance", "answer_relevancy"];

type Detail = {
  key: string;
  title: string;
  subtitle: string;
  evaluation: AskEvaluation;
  sources: { n: number; title: string }[];
  focus: string;
  runId?: string;
  review?: { verdict: "grounded" | "partly" | "not"; note: string } | null;
};

function remembered(): View {
  try {
    const v = localStorage.getItem("quality.view");
    // The two views this layout replaced land where their content went.
    if (v === "overview") return "answers";
    if (v === "explorer") return "analysis";
    if (VIEWS.some((x) => x.value === v)) return v as View;
  } catch { /* private window */ }
  return "answers";
}

const selectSx = { fontSize: 13, minWidth: 190, borderRadius: RADIUS, "& .MuiSelect-select": { py: 0.75 } };

export default function QualityPage({ active }: { active: boolean }) {
  const [view, setView] = useState<View>(remembered);
  const [filters, setFilters] = useState<QualityFilters>({ days: 28, half: "", mode: "" });
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [explorer, setExplorer] = useState<QualityExplorer | null>(null);
  const [judge, setJudge] = useState<JudgeTrust | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [metric, setMetric] = useState("faithfulness");

  const choose = (v: View) => {
    setView(v);
    try { localStorage.setItem("quality.view", v); } catch { /* private window */ }
  };

  // The overview is always loaded: the KPI strip is on every tab, and its
  // review count drives the note that the judge has not been checked.
  useEffect(() => {
    if (!active) return;
    let stop = false;
    setLoading(true);
    const wants = [quality.overview(filters).then((d) => !stop && setOverview(d))];
    if (FILTERED.includes(view)) wants.push(quality.explorer(filters).then((d) => !stop && setExplorer(d)));
    if (view === "judge") wants.push(quality.judge().then((d) => !stop && setJudge(d)));
    Promise.all(wants).then(() => !stop && setError(null))
      .catch((e) => !stop && setError(e.message))
      .finally(() => !stop && setLoading(false));
    return () => { stop = true; };
  }, [active, filters, view, tick]);

  const openAnswer = useCallback(async (runId: string, focus?: string) => {
    try {
      const run = await askHistory.run(runId);
      if (!run.evaluation) {
        setError("This answer has no evaluation to open.");
        return;
      }
      const key = focus && run.evaluation.metrics[focus] ? focus : "faithfulness";
      setMetric(key);
      setDetail({
        key: runId, title: run.question,
        subtitle: `${run.mode} · asked ${run.started_at ? new Date(run.started_at).toLocaleString() : ""}`,
        evaluation: run.evaluation, sources: run.sources, focus: key, runId,
        review: run.review ? { verdict: run.review.verdict, note: run.review.note } : null,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const openPoint = useCallback((p: QualityPoint) => openAnswer(p.run_id, p.failure ? FOCUS[p.failure] : "faithfulness"),
    [openAnswer]);

  const openDocument = (d: QualityDocument) => setDrill({
    title: d.title,
    detail: `retrieved ${d.retrieved}× · ${d.useful_rate === null ? "not judged" : `useful ${Math.round(d.useful_rate * 100)}%`}`,
    runIds: d.run_ids, focus: "context_precision",
  });

  const openExperimentItem = useCallback(async (experimentId: string, row: ExperimentRow) => {
    try {
      const item = await experimentItem(experimentId, row.item_id);
      setMetric("faithfulness");
      setDetail({
        key: `${experimentId}:${row.item_id}`,
        title: `${item.item_id} · ${item.question}`,
        subtitle: `${item.experiment.name} · candidate run`,
        evaluation: { status: "done", metrics: item.metrics, overall: item.overall, safety: item.safety, terms: {} },
        sources: item.sources, focus: "faithfulness",
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const drillPoints = useMemo(() => {
    if (!drill || !explorer) return [];
    const ids = new Set(drill.runIds);
    return explorer.points.filter((p) => ids.has(p.run_id));
  }, [drill, explorer]);

  const available = detail ? METRIC_ORDER.filter((m) => detail.evaluation.metrics[m]) : [];
  const reviewed = judge?.agreement.reviews ?? overview?.reviewed ?? 0;
  const checked = judge?.checked ?? overview?.checked ?? false;
  const needed = judge?.agreement.min_reviews ?? 20;
  const line = overview?.line ?? 0.7;

  const tiles = KPI_ORDER.map((k) => overview?.tiles.find((t) => t.key === k)).filter(Boolean) as QualityOverview["tiles"];
  const overall = tiles.find((t) => t.key === "overall");

  return (
    <Box sx={{ height: "100%", overflow: "auto", bgcolor: "background.default" }}>
      <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 2, md: 3 }, pt: 1.75 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
          <Stack spacing={0.4} sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>RAG Metrics / Answer evaluation</Typography>
            <Typography component="h1" sx={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.01em" }}>Answer evaluation</Typography>
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              Ask RAG · {overview ? `${overview.scored} answer${overview.scored === 1 ? "" : "s"} scored in the last ${overview.days} days` : "loading"}
              {overview ? ` · ${overview.failing} with a failure cause` : ""}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", pt: 2 }}>
            {loading && <CircularProgress size={16} />}
            <Button variant="outlined" size="small" startIcon={<RefreshCw size={14} />} onClick={() => setTick((t) => t + 1)}
                    sx={{ textTransform: "none", borderRadius: RADIUS }}>
              Refresh
            </Button>
            <Button variant="contained" size="small" disableElevation onClick={() => choose("judge")}
                    sx={{ textTransform: "none", borderRadius: RADIUS }}>
              Open review queue
            </Button>
          </Stack>
        </Stack>

        <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", mt: 1.5, borderTop: 1, borderColor: "divider" }}>
          {tiles.map((t) => (
            <Kpi key={t.key} label={KPI_LABEL[t.key] ?? t.label}
                 value={t.value === null ? "—" : t.value.toFixed(2)}
                 status={t.value === null ? "No data" : t.value >= line ? "On target" : "Below target"}
                 tone={t.value === null ? "muted" : t.value >= line ? "good" : "warn"}
                 sub={t.delta !== null
                   ? `${t.delta >= 0 ? "▲" : "▼"} ${Math.abs(t.delta).toFixed(2)} vs previous ${overview?.days} days`
                   : `${t.below} of ${t.n} below ${line.toFixed(2)}`} />
          ))}
          {overall && (
            <Kpi label="Answers below threshold" value={`${overall.below} / ${overall.n}`}
                 status={overall.n ? `${Math.round((overall.below / overall.n) * 100)}% of scored answers` : "No data"}
                 tone={overall.below ? "warn" : "good"} sub={`overall under ${line.toFixed(2)}`} />
          )}
          <Kpi label="Judge calibration" value={`${reviewed} / ${needed}`}
               status={checked ? "Calibrated" : "Not calibrated"} tone={checked ? "good" : "warn"}
               sub="human reviews collected" />
        </Stack>

        <Tabs value={view} onChange={(_e, v: View) => choose(v)} variant="scrollable" allowScrollButtonsMobile
              sx={{ minHeight: 40, "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: 13.5, px: 2 } }}>
          {VIEWS.map((v) => <Tab key={v.value} value={v.value} label={v.label} />)}
        </Tabs>
      </Paper>

      {FILTERED.includes(view) && (
        <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 2, md: 3 }, py: 1.5 }}>
          <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field id="quality-days" label="Period">
              <Select id="quality-days" size="small" value={filters.days} sx={selectSx}
                      onChange={(e) => setFilters((f) => ({ ...f, days: Number(e.target.value) }))}>
                <MenuItem value={7}>Last 7 days</MenuItem>
                <MenuItem value={28}>Last 28 days</MenuItem>
                <MenuItem value={84}>Last 84 days</MenuItem>
                <MenuItem value={365}>Last year</MenuItem>
              </Select>
            </Field>
            <Field id="quality-half" label="Corpus scope">
              <Select id="quality-half" size="small" value={filters.half} displayEmpty sx={selectSx}
                      onChange={(e) => setFilters((f) => ({ ...f, half: e.target.value }))}>
                <MenuItem value="">All categories</MenuItem>
                <MenuItem value="PKG">PKG — package documents</MenuItem>
                <MenuItem value="DR">DR — design reviews</MenuItem>
                <MenuItem value="PKG+DR">PKG + DR — both</MenuItem>
              </Select>
            </Field>
            <Field id="quality-mode" label="Search mode">
              <Select id="quality-mode" size="small" value={filters.mode} displayEmpty sx={selectSx}
                      onChange={(e) => setFilters((f) => ({ ...f, mode: e.target.value }))}>
                <MenuItem value="">All modes</MenuItem>
                <MenuItem value="hybrid">Hybrid</MenuItem>
                <MenuItem value="vector">Vector</MenuItem>
                <MenuItem value="keyword">Keyword</MenuItem>
              </Select>
            </Field>
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={() => setFilters({ days: 28, half: "", mode: "" })}
                    disabled={filters.days === 28 && !filters.half && !filters.mode}
                    sx={{ textTransform: "none" }}>
              Clear filters
            </Button>
          </Stack>
        </Paper>
      )}

      <Stack spacing={2} sx={{ px: { xs: 2, md: 3 }, py: 2 }}>
        {!checked && <TrustNote reviewed={reviewed} needed={needed} />}
        {error && <Alert severity="warning" onClose={() => setError(null)} sx={{ borderRadius: RADIUS }}>{error}</Alert>}

        {view === "answers" && overview && explorer && (
          <AnswersView overview={overview} explorer={explorer} half={filters.half}
                       onHalf={(half) => setFilters((f) => ({ ...f, half }))} onOpen={openPoint} />
        )}
        {view === "matrix" && explorer && (
          <MatrixView points={explorer.points} line={explorer.line} failures={explorer.failures} onOpen={openPoint} />
        )}
        {view === "documents" && explorer && <DocumentsView documents={explorer.documents} onOpen={openDocument} />}
        {view === "analysis" && explorer && <ExplorerView data={explorer} onDrill={setDrill} onPoint={openPoint} />}
        {view === "experiments" && <ExperimentsView onOpenItem={openExperimentItem} />}
        {view === "judge" && judge && <JudgeView data={judge} onReview={(id) => openAnswer(id, "faithfulness")} />}
      </Stack>

      <AnswerListDrawer
        open={!!drill}
        title={drill?.title ?? ""}
        detail={drill?.detail}
        points={drillPoints}
        failures={explorer?.failures ?? []}
        onClose={() => setDrill(null)}
        onOpen={(p) => openAnswer(p.run_id, drill?.focus ?? (p.failure ? FOCUS[p.failure] : undefined))}
      />

      <MetricDetailDrawer
        open={!!detail}
        metric={metric}
        evaluation={detail?.evaluation ?? null}
        sources={detail?.sources}
        onClose={() => setDetail(null)}
        onPick={setMetric}
        available={available}
        context={detail && (
          <Box>
            <Typography sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45 }}>{detail.title}</Typography>
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              {detail.subtitle}
              {detail.evaluation.overall !== null && ` · overall ${detail.evaluation.overall.toFixed(2)}`}
            </Typography>
          </Box>
        )}
        footer={detail?.runId && (
          <ReviewBar
            key={detail.key}
            runId={detail.runId}
            current={detail.review}
            onSaved={() => setTick((t) => t + 1)}
          />
        )}
      />
    </Box>
  );
}
