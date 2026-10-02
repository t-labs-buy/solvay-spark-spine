import {
  Alert, Autocomplete, Box, Button, ButtonBase, Chip, Fade, IconButton, Link, MenuItem, Paper, Popper, Select,
  Skeleton, Stack, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { AnimatePresence, motion } from "framer-motion";
import {
  Ban, Binary, BookOpen, BrainCircuit, Check, ChevronDown, CircleAlert, CircleCheck, Copy, Dices, GitMerge, History as HistoryIcon, Lightbulb, LoaderCircle, MessageSquareText, SendHorizontal, Sparkles, Square, TextSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ask, api, askHistory, type AskEvaluation, type CategoryInfo, type Done, type RagStatus,
  type SearchMode, type Source, type StepKey, type StepStatus,
} from "../api";
import Markdown, { highlightRegex } from "../components/Markdown";
import DocumentInspectorDrawer from "../components/DocumentInspectorDrawer";
import { ASK_SAMPLES } from "../data/askSamples";
import type { SampleQuestion } from "../data/evidenceSamples";
import AskHistoryDrawer from "../components/AskHistoryDrawer";
import QualityScorecard from "../components/QualityScorecard";
import ScrollRunway from "../components/ScrollRunway";
import SourcesView from "../components/ask/SourcesView";
import ObjectHeader, { BandButton } from "../components/rollout/ObjectHeader";
import { MONO, RADIUS, usePremium } from "../components/rollout/premium";
import { Section } from "../components/rollout/SummaryView";
import { surface } from "../theme";
import { clearAdornment } from "../components/ClearAdornment";
import type { RunRequest } from "../runRequest";

interface Step {
  key: StepKey;
  name: string;
  tech: string;
  idle: string;
  icon: ReactNode;
  status: StepStatus;
  detail: string;
  ms?: number;
}

const STEPS: Omit<Step, "status" | "detail" | "ms">[] = [
  { key: "embed", name: "Embed question", tech: "Ollama · bge-m3", idle: "Turn the question into a 1024-d vector", icon: <Binary size={16} /> },
  { key: "vector", name: "Vector search", tech: "pgvector · cosine similarity", idle: "Chunks closest in meaning", icon: <BrainCircuit size={16} /> },
  { key: "keyword", name: "Keyword search", tech: "Postgres full text · BM25", idle: "Chunks containing the question's words and codes", icon: <TextSearch size={16} /> },
  { key: "fuse", name: "Merge rankings", tech: "Reciprocal rank fusion", idle: "Pick the best excerpts from both lists", icon: <GitMerge size={16} /> },
  { key: "answer", name: "Write answer", tech: "Claude", idle: "Answer only from the excerpts, with citations", icon: <Sparkles size={16} /> },
];

/** A pipeline step as Demo Mode shows it: what the step does, with the
 *  embedding model, the database and the answer model taken out. The server's
 *  stage lines name all three, so they are rewritten here rather than there --
 *  the main app keeps them. */
const CLIENT_TECH: Record<string, string> = {
  embed: "Meaning-based embedding",
  vector: "Search by meaning",
  keyword: "Search by exact words and codes",
  fuse: "Both result lists combined",
  answer: "Written only from the excerpts",
};

function clientStep(s: Step): Step {
  let detail = s.detail;
  if (s.key === "embed") {
    detail = s.status === "done" ? "Question ready for meaning-based search"
      : s.status === "running" ? "Reading the question for meaning"
      : s.status === "pending" ? "Turn the question into a meaning-based search" : detail;
  } else if (s.key === "vector" && s.status === "running") {
    detail = "Finding the passages closest in meaning";
  } else if (s.key === "answer" && s.status !== "pending") {
    detail = detail
      .replace(/^Sending (\d+) excerpts to .*/, "Sending $1 excerpts to the answer model")
      .replace(/^.* is reasoning over the excerpts$/, "Reasoning over the excerpts")
      .replace(/^.* is writing$/, "Writing the answer")
      .replace(/^[^:]*: ([\d,]+) tokens in, ([\d,]+) out$/, "Answer written: $1 tokens in, $2 out");
  }
  return { ...s, tech: CLIENT_TECH[s.key] ?? s.tech, detail };
}

const freshSteps = (mode: SearchMode): Step[] =>
  STEPS.map((s) => {
    const skipped = (mode === "keyword" && (s.key === "embed" || s.key === "vector")) || (mode === "vector" && s.key === "keyword");
    return { ...s, status: skipped ? "skipped" : "pending", detail: skipped ? "Not used in this search mode" : s.idle };
  });


export default function AskPage({ active, showTechDetails = true, openRun: request = null }: {
  active: boolean;
  /** Open this recorded run, as the Admin page's run history asks. */
  openRun?: RunRequest | null;
  /** Which models and how big a corpus: the line under the title, the model
   *  names in the pipeline and the judge model in the evaluation. Demo Mode
   *  turns it off -- a client is shown what the system does, not what it
   *  runs on. */
  showTechDetails?: boolean;
}) {
  const theme = useTheme();
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [k, setK] = useState(8);
  const [steps, setSteps] = useState<Step[]>(() => freshSteps("hybrid"));
  const [terms, setTerms] = useState<string[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [answer, setAnswer] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Named tabs, as on the Fit-Gap Copilot. A citation opens its excerpt in the
  // Sources register rather than scrolling a long page to a card.
  const [tab, setTab] = useState("answer");
  const [focusSource, setFocusSource] = useState<{ n: number; at: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // The sample question picked, if the question box holds one.
  const [picked, setPicked] = useState<SampleQuestion | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Bumped when a question finishes, so a reopened panel is never stale.
  const [historyKey, setHistoryKey] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState<string | null>(null);
  // The Langfuse trace this question opened, and the judges' verdict on it.
  // The verdict arrives long after the answer does, so it is polled rather
  // than streamed -- see the effect below for why that is the right shape.
  const [evaluation, setEvaluation] = useState<AskEvaluation | null>(null);
  const [rescoring, setRescoring] = useState(false);
  // Set when the view is showing a recorded question rather than a live one.
  const [replay, setReplay] = useState<{ id: string; at: string | null; changed: boolean } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef("");
  const questionField = useRef<HTMLTextAreaElement | null>(null);

  // Refresh the index counts whenever the page is shown: a document may have
  // just been added from the Extract page.
  useEffect(() => {
    if (active) api.ragStatus().then(setStatus).catch(() => setStatus(null));
  }, [active]);

  // Every question reads the whole corpus. The category each document is filed
  // under is still recorded and still shown on a source, but it is no longer a
  // control: there is one index and a question is asked of all of it.
  const scope = useMemo<CategoryInfo[]>(
    () => (status?.categories ?? []).filter((c) => c.chunks > 0), [status]);
  const scoped = useMemo(
    () => scope.reduce((acc, c) => ({ documents: acc.documents + c.documents, chunks: acc.chunks + c.chunks }), { documents: 0, chunks: 0 }),
    [scope],
  );

  // The typewriter. Text reaches the page a sentence at a time -- the server
  // holds each one back until it ends, so a phone number split across two
  // tokens is still redacted -- and pasting it in whole reads as blocks
  // appearing. Instead it is revealed a few characters a frame: steadily when
  // the buffer is short, faster when it builds up, so the page never falls
  // more than about a second behind the model. `typing` outlives `running`
  // until the last character is out.
  const [typing, setTyping] = useState(false);
  const streaming = useRef(false);
  useEffect(() => {
    if (!typing) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now: number) => {
      const backlog = pending.current.length;
      if (backlog) {
        const perSecond = Math.max(120, backlog * 1.2);
        carry += (perSecond * (now - last)) / 1000;
        const n = Math.min(backlog, Math.floor(carry));
        if (n > 0) {
          carry -= n;
          const chunk = pending.current.slice(0, n);
          pending.current = pending.current.slice(n);
          setAnswer((a) => a + chunk);
        }
      } else {
        carry = 0;
        if (!streaming.current) { setTyping(false); return; }
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [typing]);

  // Stopping, failing or leaving for a saved run shows what has arrived at
  // once rather than typing out an answer nobody is waiting for.
  const flushTyping = useCallback(() => {
    streaming.current = false;
    const rest = pending.current;
    pending.current = "";
    if (rest) setAnswer((a) => a + rest);
    setTyping(false);
  }, []);

  async function executeAsk(overrideQuestion?: string) {
    const q = (typeof overrideQuestion === "string" ? overrideQuestion : question).trim();
    if (!q || running) return;
    if (typeof overrideQuestion === "string") setQuestion(overrideQuestion);
    setAsked(q);
    setSteps(freshSteps(mode));
    setTerms([]);
    setSources([]);
    setAnswer("");
    pending.current = "";
    streaming.current = true;
    setTyping(true);
    setDone(null);
    setError(null);
    setRunning(true);
    setRunId(null);
    setNotSaved(null);
    setReplay(null);
    setEvaluation(null);
    setTab("answer");
    const ctrl = new AbortController();
    controller.current = ctrl;
    const fail = (message: string) => {
      flushTyping();
      setError(message);
      setSteps((ss) => {
        const i = ss.findIndex((s) => s.status === "running");
        const j = i >= 0 ? i : ss.findIndex((s) => s.status === "pending");
        return ss.map((s, n) => (n === j ? { ...s, status: "error", detail: message === "Stopped" ? "Stopped" : "Failed" } : s));
      });
    };
    try {
      await ask(
        { question: q, mode, k, categories: [] },
        {
          stage: (e) => {
            if (e.terms) setTerms(e.terms);
            setSteps((ss) => ss.map((s) => (s.key === e.key ? { ...s, status: e.status, detail: e.detail || s.detail, ms: e.ms ?? s.ms } : s)));
          },
          run: (r) => {
            setRunId(r.id);
            setNotSaved(r.not_saved ?? null);
          },
          sources: setSources,
          token: (t) => {
            pending.current += t;
          },
          done: (d) => {
            setDone(d);
            setHistoryKey((n) => n + 1);
            // The server starts judging the moment the answer is finished, so
            // the panel opens in its running state rather than appearing from
            // nothing once the first poll comes back.
            setEvaluation({ status: "running", metrics: {}, overall: null, safety: null, terms: {} });
          },
          error: fail,
        },
        ctrl.signal,
      );
    } catch (err) {
      fail((err as Error).name === "AbortError" ? "Stopped" : (err as Error).message);
    } finally {
      // The rest of the buffer is left to the typewriter, which stops itself
      // once it is empty.
      streaming.current = false;
      controller.current = null;
      setRunning(false);
    }
  }

  const run = () => executeAsk();

  // Reopening a recorded question restores the view it produced -- the answer
  // and the excerpts it was written from -- rather than asking it again. The
  // pipeline panel is put back to "done" because this run did happen; what it
  // cannot honestly show is the per-stage timing, which was never recorded.
  const openRun = useCallback(async (id: string) => {
    setHistoryOpen(false);
    try {
      const r = await askHistory.run(id);
      controller.current?.abort();
      flushTyping();
      setQuestion(r.question);
      setPicked(ASK_SAMPLES.find((q) => q.question === r.question) ?? null);
      setAsked(r.question);
      setMode(r.mode);
      setK(r.k);
      setTerms(r.terms);
      setSources(r.sources);
      pending.current = "";
      setAnswer(r.answer);
      setError(r.error || (r.status === "abandoned" ? "This question was interrupted before it was answered." : null));
      setDone(r.status === "done"
        ? { seconds: r.seconds, input_tokens: r.input_tokens, output_tokens: r.output_tokens }
        : null);
      setSteps(freshSteps(r.mode).map((st) =>
        st.status === "skipped"
          ? st
          : { ...st, status: r.status === "done" || st.key !== "answer" ? "done" : "error",
              detail: st.key === "answer" && r.status !== "done" ? "Not finished" : st.idle }));
      setRunId(r.id);
      setNotSaved(null);
      setReplay({ id: r.id, at: r.started_at, changed: r.corpus_changed });
      setTab("answer");
      // A recorded question brings its scorecard with it, in the same paint as
      // its answer. Nothing is polled here: this evaluation is already final.
      setEvaluation(r.evaluation ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (request) void openRun(request.id);
    // Only when a new request arrives; openRun is stable enough for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Judging happens on the server after the answer has been streamed, so the
  // SSE connection is already closed by the time there is a score. Polling
  // rather than holding that connection open is deliberate: a question is
  // answered in seconds and judged in tens of seconds, and a reader who closes
  // the tab in between should still come back to a complete evaluation --
  // which they do, because the result is written to Postgres either way.
  useEffect(() => {
    if (!runId || evaluation?.status !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const got = await askHistory.evaluation(runId);
        if (stopped) return;
        setEvaluation(got);
        // Every other status is terminal. Without this the page would poll a
        // finished evaluation for as long as it stayed open.
        if (got.status === "running") timer = setTimeout(poll, 2500);
        else setHistoryKey((n) => n + 1);
      } catch {
        if (!stopped) setEvaluation((e) => (e ? { ...e, status: "failed", error: "The score could not be read back." } : e));
      }
    };
    timer = setTimeout(poll, 2500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, evaluation?.status]);

  const rescore = useCallback(async () => {
    if (!runId) return;
    setRescoring(true);
    try {
      await askHistory.rescore(runId);
      setEvaluation({ status: "running", metrics: {}, overall: null, safety: null, terms: {} });
    } catch (e) {
      setEvaluation((prev) => ({
        ...(prev ?? { metrics: {}, overall: null, safety: null, terms: {} }),
        status: "failed", error: (e as Error).message,
      }));
    } finally {
      setRescoring(false);
    }
  }, [runId]);

  const askAgain = (q: string) => {
    setHistoryOpen(false);
    executeAsk(q);
  };

  // Picking a sample question drops it in the box and hands the reader the
  // caret, so it can be edited before it is asked. The arrow on a sample runs
  // it as it stands.

  const titles = useMemo(() => new Map(sources.map((s) => [s.n, s.title])), [sources]);
  const cited = useMemo(() => {
    const set = new Set<number>();
    for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) if (titles.has(Number(m[1]))) set.add(Number(m[1]));
    return set;
  }, [answer, titles]);
  const highlight = useMemo(() => highlightRegex(terms, asked), [terms, asked]);

  const cite = useCallback((n: number) => {
    setTab("sources");
    setFocusSource({ n, at: Date.now() });
  }, []);

  // ---------- Document Inspector & Hover Card State ----------
  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [hoverCite, setHoverCite] = useState<{ n: number; anchorEl: HTMLElement } | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openInspector = useCallback((s: Source) => {
    setActiveSource(s);
    setInspectorOpen(true);
    setHoverCite(null);
  }, []);

  const openInspectorForN = useCallback((n: number) => {
    const s = sources.find((src) => src.n === n);
    if (s) {
      openInspector(s);
    } else {
      cite(n);
    }
  }, [sources, openInspector, cite]);

  // mouseover fires again for every node the cursor crosses inside the same
  // citation. Re-setting state each time would hand Popper a new object and
  // make it recompute its position mid-hover, which reads as jitter.
  const handleHoverCite = useCallback((n: number, anchorEl: HTMLElement) => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setHoverCite((c) => (c && c.n === n && c.anchorEl === anchorEl ? c : { n, anchorEl }));
  }, []);

  // Leaving the citation does not close the card at once: the cursor has to
  // cross a few pixels of answer text to reach it, and the card cancels this
  // timer on mouseenter.
  const handleLeaveCite = useCallback((_n: number) => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => {
      setHoverCite(null);
    }, 280);
  }, []);

  useEffect(() => () => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
  }, []);

  // Every token flushed into the answer rebuilds the Markdown, which throws
  // away the button the card is anchored to. A detached anchor sends Popper to
  // the top-left corner, so drop the hover instead.
  useEffect(() => {
    if (hoverCite && !document.contains(hoverCite.anchorEl)) setHoverCite(null);
  }, [hoverCite, answer]);

  const scrollToSourceCard = useCallback((n: number) => {
    cite(n);
    setHoverCite(null);
  }, [cite]);

  const hoveredSource = useMemo(
    () => (hoverCite ? sources.find((s) => s.n === hoverCite.n) ?? null : null),
    [hoverCite, sources],
  );

  const problems: ReactNode[] = [];
  if (status?.missing.length) problems.push(<>Set {status.missing.join(", ")} in <code>.env</code> and restart the server.</>);
  if (status?.error) problems.push(<>Cannot read the index: {status.error}</>);
  else if (status && !status.missing.includes("DATABASE_URL") && !status.chunks)
    problems.push(<>The index is empty. Run <code>.venv/bin/python rag.py index solvay-spark/pkg/markdown</code> or add a document from the Extract page.</>);

  const answerModel = status?.answer_model ?? "Claude";
  const docsInSources = new Set(sources.map((s) => s.title)).size;
  const premium = usePremium();

  const overall = evaluation?.status === "done" ? evaluation.overall : null;
  const metric = (k: string) => evaluation?.metrics?.[k]?.value ?? null;
  const TABS = [
    { key: "answer", label: "Answer" },
    { key: "evaluation", label: evaluation ? `Evaluation${overall != null ? ` (${overall.toFixed(2)})` : evaluation.status === "running" ? " (scoring…)" : ""}` : "Evaluation" },
    { key: "sources", label: `Sources (${sources.length})` },
  ];

  return (
    <Box sx={{ height: "100%", overflow: "auto", bgcolor: "background.default" }}>
      <ObjectHeader
        breadcrumb={`Ask RAG / Questions${runId ? ` / ${runId}` : ""}`}
        title={asked ? (asked.length > 150 ? `${asked.slice(0, 150)}…` : asked) : "Ask the documents"}
        badge={running ? "Answering…" : replay ? "Saved answer" : done ? "Answered" : undefined}
        meta={!showTechDetails ? undefined : status && !status.error
          ? `${scoped.chunks.toLocaleString()} chunks · ${scoped.documents} documents · embeddings Ollama ${status.embed_model} · answers ${answerModel}`
          : "The answer is written only from the excerpts found in your documents, with numbered citations you can open."}
        actions={
          <>
            <BandButton onClick={() => setHistoryOpen(true)} startIcon={<HistoryIcon size={14} />}>History</BandButton>
            {answer && !running && !typing && (
              <BandButton startIcon={copied ? <Check size={14} /> : <Copy size={14} />}
                          onClick={async () => {
                            await navigator.clipboard.writeText(answer);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}>
                {copied ? "Copied" : "Copy answer"}
              </BandButton>
            )}
          </>
        }
        kpis={asked ? [
          { label: "Answer quality",
            value: overall != null ? overall.toFixed(2) : "—",
            sub: evaluation?.status === "running" ? "scoring…" : overall != null
              ? `overall${evaluation?.safety != null ? ` · safety ${evaluation.safety.toFixed(2)}` : ""}`
              : evaluation?.status === "failed" ? "scoring failed" : evaluation?.status === "skipped" ? "not scored" : "not scored yet" },
          { label: "Faithfulness", value: metric("faithfulness") != null ? metric("faithfulness")!.toFixed(2) : "—",
            sub: "claims backed by the excerpts" },
          { label: "Sources", value: String(sources.length),
            sub: `${docsInSources} document${docsInSources === 1 ? "" : "s"} · ${cited.size} cited` },
          { label: "Time", value: done ? `${done.seconds}s` : running ? "…" : "—",
            sub: done ? `${done.input_tokens.toLocaleString()} in · ${done.output_tokens.toLocaleString()} out` : `${mode} search · ${k} excerpts` },
        ] : undefined}
      />

      <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 2, md: 4 }, py: 2 }}>
        {problems.length > 0 && (
          <Alert severity="warning" sx={{ mb: 1.5, borderRadius: RADIUS }}>
            {problems.map((p, i) => (
              <div key={i}>{p}</div>
            ))}
          </Alert>
        )}
          {/* The same composer as the Evidence Agent's: the question, then one
              row of settings with the action at its right-hand end. */}
          <TextField
            fullWidth multiline maxRows={4} value={question}
            inputRef={questionField}
            onChange={(e) => { setQuestion(e.target.value); if (picked) setPicked(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}
            placeholder={`Ask anything about the indexed documents — or pick one of the ${ASK_SAMPLES.length} sample questions below`}
            slotProps={{ input: {
              sx: { fontSize: 15, alignItems: "flex-start" },
              startAdornment: <Box sx={{ pt: 0.35, pr: 1.25, color: "primary.main" }}><MessageSquareText size={18} /></Box>,
              endAdornment: clearAdornment(question, () => { setQuestion(""); setPicked(null); },
                                           { size: 16, label: "Clear question", top: true }),
            } }}
          />

          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mt: 1.5 }}>
            <Autocomplete
              openOnFocus size="small" sx={{ flex: 1, minWidth: 280 }} value={picked} options={ASK_SAMPLES}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              getOptionLabel={(q) => q.question}
              onChange={(_, q) => { setPicked(q); if (q) setQuestion(q.question); }}
              filterOptions={(opts, { inputValue }) => {
                const n = inputValue.trim().toLowerCase();
                return n ? opts.filter((q) => `${q.id} ${q.shows} ${q.question}`.toLowerCase().includes(n)) : opts;
              }}
              renderInput={(params) => (
                <TextField {...params} placeholder={`Sample questions — ${ASK_SAMPLES.length} to try, each showing something grounded search does`}
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
                onClick={() => { const q = ASK_SAMPLES[Math.floor(Math.random() * ASK_SAMPLES.length)];
                                 setPicked(q); setQuestion(q.question); }}>
                <Dices size={16} /></IconButton></span>
            </Tooltip>
            <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} disabled={running}
                               aria-label="Search mode"
                               sx={{ "& .MuiToggleButton-root": { textTransform: "none", fontSize: 12.5, px: 1.25, gap: 0.6, py: 0.6 } }}>
              <ToggleButton value="hybrid" title="Vector and keyword search, merged">
                <GitMerge size={14} /> Hybrid
              </ToggleButton>
              <ToggleButton value="vector" title="Closest in meaning only">
                <BrainCircuit size={14} /> Vector
              </ToggleButton>
              <ToggleButton value="keyword" title="Exact words and codes only">
                <TextSearch size={14} /> Keyword
              </ToggleButton>
            </ToggleButtonGroup>

            <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", ml: 1 }}>
              <Typography component="label" htmlFor="ask-excerpts" sx={{ fontSize: 12, color: "text.secondary" }}>
                excerpts
              </Typography>
              <Select size="small" value={k} onChange={(e) => setK(Number(e.target.value))} disabled={running}
                      inputProps={{ id: "ask-excerpts" }}
                      sx={{ fontSize: 12.5, "& .MuiSelect-select": { py: 0.6, px: 1.25 } }}>
                {[5, 8, 12, 20].map((n) => (
                  <MenuItem key={n} value={n} sx={{ fontSize: 12.5 }}>{n}</MenuItem>
                ))}
              </Select>
            </Stack>

            {running ? (
              <Button variant="outlined" color="error" startIcon={<Square size={15} />}
                      onClick={() => controller.current?.abort()}>Stop</Button>
            ) : (
              <Tooltip title="⌘/Ctrl + ↵ also asks">
                <span>
                  <Button variant="contained" disabled={!question.trim()}
                          startIcon={<SendHorizontal size={16} />} onClick={run}>Ask</Button>
                </span>
              </Tooltip>
            )}
          </Stack>

          {picked && (
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 1.25 }}>
              <b>{picked.id} · {picked.shows}</b> — {picked.lookFor}
            </Typography>
          )}
      </Paper>

      {(asked || sources.length > 0) && (
        <Paper square elevation={0} sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 1, md: 3 } }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
                sx={{ minHeight: 46, "& .MuiTab-root": { minHeight: 46, textTransform: "none", fontSize: 13.5, fontWeight: 500, px: 1.75 },
                      "& .Mui-selected": { fontWeight: 600 } }}>
            {TABS.map((t) => <Tab key={t.key} value={t.key} label={t.label} />)}
          </Tabs>
        </Paper>
      )}

      <Stack spacing={2.5} sx={{ px: { xs: 2, md: 4 }, py: 3 }}>
        {/* A recorded question, reopened. Saying WHEN matters: the answer below
            is what the corpus said then, and if the corpus has been re-indexed
            since, asking again is not guaranteed to reproduce it. */}
        {replay && (
          <Alert
            severity={replay.changed ? "warning" : "info"}
            action={
              <Button color="inherit" size="small" onClick={() => executeAsk(asked)} disabled={running}>
                Ask again
              </Button>
            }
            sx={{ borderRadius: RADIUS }}
          >
            Showing a saved answer from {replay.at ? new Date(replay.at).toLocaleString() : "an earlier session"}.
            {replay.changed
              ? " The corpus has changed since it was written, so asking again may give a different answer."
              : " The corpus has not changed since it was written."}
          </Alert>
        )}

        {notSaved && (
          <Alert severity="warning" sx={{ borderRadius: RADIUS }} onClose={() => setNotSaved(null)}>
            This question is being answered but not recorded in the history: {notSaved}
          </Alert>
        )}


        {tab === "answer" && (
          <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 2fr) minmax(0, 1fr)" }, alignItems: "start" }}>
            <Section title="Answer" hint={asked ? `${cited.size} of ${sources.length} excerpts cited` : undefined}>
              <Box sx={{ mx: -2.5, mb: -2.25 }}>
            <Box sx={{ p: 2.5 }}>
              {asked && (
                <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5, fontStyle: "italic" }}>
                  “{asked}”
                </Typography>
              )}
              {answer ? (
                <Box
                  sx={
                    running || typing
                      ? {
                          "& > div > :last-child::after": {
                            content: '""', display: "inline-block", width: ".5em", height: "1em", ml: "2px", verticalAlign: "-2px",
                            bgcolor: "primary.main", animation: "caret 1s steps(1) infinite",
                          },
                          "@keyframes caret": { "50%": { opacity: 0 } },
                        }
                      : undefined
                  }
                >
                  <Markdown
                    source={answer}
                    citations={titles}
                    onCite={openInspectorForN}
                    onHoverCite={handleHoverCite}
                    onLeaveCite={handleLeaveCite}
                    sx={{ maxWidth: "80ch" }}
                  />
                </Box>
              ) : running && !error ? (
                <Stack spacing={1}>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {sources.length ? `Waiting for ${showTechDetails ? answerModel : "the answer"}…` : "Retrieving excerpts…"}
                  </Typography>
                  {[92, 100, 78, 85].map((w, i) => (
                    <Skeleton key={i} variant="text" width={`${w}%`} />
                  ))}
                </Stack>
              ) : !error ? (
                <Stack spacing={1} sx={{ alignItems: "center", textAlign: "center", color: "text.secondary", py: 5 }}>
                  <Box sx={{ width: 52, height: 52, borderRadius: "50%", display: "grid", placeItems: "center", bgcolor: alpha(theme.palette.primary.main, 0.1), color: "primary.main" }}>
                    <Sparkles size={24} />
                  </Box>
                  <Typography sx={{ fontWeight: 650, color: "text.primary" }}>Ask a question</Typography>
                  <Typography variant="body2" sx={{ maxWidth: "44ch" }}>
                    The answer is written only from the excerpts found in your documents, with numbered citations you can click.
                  </Typography>
                </Stack>
              ) : null}
              <AnimatePresence>
                {error && (
                  <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <Alert severity={error === "Stopped" ? "info" : "error"} sx={{ mt: answer ? 2 : 0 }}>
                      {error}
                    </Alert>
                  </motion.div>
                )}
              </AnimatePresence>
            </Box>
              </Box>
            </Section>

            <Stack spacing={3} sx={{ minWidth: 0 }}>
              <Section pad={false} title="Pipeline" hint={done ? `${done.seconds}s total` : running ? "running" : undefined}>
            <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, py: 1 }}>
              {steps.map((s, i) => (
                <PipelineStep key={s.key} step={!showTechDetails ? clientStep(s) : { ...s, tech: s.key === "embed" && status ? `Ollama ${status.embed_model} (${status.embed_dimension || 1024}d)` : s.key === "answer" ? answerModel : s.tech }} last={i === steps.length - 1} next={steps[i + 1]?.status} />
              ))}
            </Box>
              </Section>

              {evaluation && (
                <Section title="Quality at a glance"
                         hint={<Link component="button" onClick={() => setTab("evaluation")}>open the evaluation</Link>}>
                  {evaluation.status === "running" ? (
                    <Typography sx={{ fontSize: 13, color: "text.secondary" }}>The judges are scoring this answer…</Typography>
                  ) : (
                    <Stack spacing={1}>
                      {[
                        ["Overall", overall],
                        ["Faithfulness", metric("faithfulness")],
                        ["Answer relevancy", metric("answer_relevancy")],
                        ["Context precision", metric("context_precision")],
                      ].map(([l, v]) => (
                        <Box key={l as string} sx={{ display: "grid", gridTemplateColumns: "130px minmax(0, 1fr) 44px", gap: 1.25, alignItems: "center" }}>
                          <Typography sx={{ fontSize: 12.5, fontWeight: l === "Overall" ? 600 : 400 }}>{l as string}</Typography>
                          <Box sx={{ height: 8, bgcolor: "action.hover" }}>
                            {v != null && (
                              <Box sx={{ height: 8, width: `${(v as number) * 100}%`,
                                         bgcolor: (v as number) >= 0.7 ? premium.accent : (v as number) >= 0.4 ? "warning.main" : "error.main" }} />
                            )}
                          </Box>
                          <Typography sx={{ fontFamily: MONO, fontSize: 12.5, textAlign: "right" }}>{v == null ? "—" : (v as number).toFixed(2)}</Typography>
                        </Box>
                      ))}
                    </Stack>
                  )}
                </Section>
              )}

              {cited.size > 0 && (
                <Section title="Cited sources" hint={`${cited.size} of ${sources.length}`}>
                  <Stack>
                    {sources.filter((x) => cited.has(x.n)).map((x, i) => (
                      <ButtonBase key={x.n} onClick={() => cite(x.n)}
                                  sx={{ display: "grid", gridTemplateColumns: "40px minmax(0, 1fr)", gap: 1, textAlign: "left", py: 1,
                                        borderTop: i ? 1 : 0, borderColor: "divider", "&:hover .t": { textDecoration: "underline" } }}>
                        <Typography sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: premium.accent }}>[{x.n}]</Typography>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography className="t" sx={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.title}</Typography>
                          <Typography sx={{ fontSize: 12, color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.section || "(start of document)"}</Typography>
                        </Box>
                      </ButtonBase>
                    ))}
                  </Stack>
                </Section>
              )}
            </Stack>
          </Box>
        )}

        {tab === "evaluation" && (
          evaluation ? (
              <QualityScorecard
                evaluation={showTechDetails ? evaluation : { ...evaluation, judge_model: undefined, scores_pushed: undefined }}
                status={status?.evaluation}
                onRescore={runId ? rescore : undefined}
                busy={rescoring || running}
                sources={sources}
              />
          ) : (
            <Section title="Evaluation">
              <Typography sx={{ fontSize: 13.5, color: "text.secondary" }}>
                {running ? "The answer is still being written; the judges score it once it is finished."
                  : status?.evaluation && !status.evaluation.enabled ? "Scoring is switched off on this server."
                  : "No evaluation was recorded for this answer."}
              </Typography>
            </Section>
          )
        )}

        {tab === "sources" && (
          sources.length > 0 ? (
            <SourcesView sources={sources} cited={cited} highlight={highlight} focus={focusSource}
                         onInspect={openInspector} showCategory={scope.length > 1} fileStem={runId ?? "ask"} />
          ) : (
            <Section title="Sources">
              <Typography sx={{ fontSize: 13.5, color: "text.secondary" }}>
                {running ? "Retrieving excerpts…" : "No excerpt was retrieved for this question."}
              </Typography>
            </Section>
          )
        )}
      </Stack>

      {(!!asked || sources.length > 0) && <ScrollRunway />}

      {/* ---------- Citation Hover Card ----------
          A Popper, not a Popover. A Popover is a Modal: it lays an invisible
          backdrop over the whole viewport and locks the page scrollbar. The
          backdrop slides between the cursor and the citation the instant the
          card opens, so the citation fires mouseout, the card closes, the
          backdrop goes with it, the citation fires mouseover again -- the
          flicker loop the card was reported for. The scroll lock also shifts
          the page sideways on every open. A Popper has neither. */}
      <Popper
        open={Boolean(hoverCite && hoveredSource)}
        anchorEl={hoverCite?.anchorEl}
        placement="bottom"
        transition
        modifiers={[
          { name: "offset", options: { offset: [0, 8] } },
          { name: "preventOverflow", options: { padding: 12 } },
          { name: "flip", options: { padding: 12 } },
        ]}
        // The popper box itself must not take the pointer, or it becomes the
        // same trap the backdrop was; only the card inside it does.
        sx={{ zIndex: (t) => t.zIndex.tooltip, pointerEvents: "none" }}
      >
        {({ TransitionProps }) => (
          <Fade {...TransitionProps} timeout={120}>
            <Paper
              elevation={0}
              onMouseEnter={() => {
                if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
              }}
              onMouseLeave={() => setHoverCite(null)}
              sx={{
                p: 2,
                width: 380,
                maxWidth: "calc(100vw - 32px)",
                borderRadius: 2.5,
                border: 1,
                borderColor: "divider",
                bgcolor: "background.paper",
                boxShadow: (t) =>
                  t.palette.mode === "dark"
                    ? "0 8px 32px rgba(0, 0, 0, 0.7)"
                    : "0 8px 24px rgba(0, 0, 0, 0.12)",
                pointerEvents: "auto",
              }}
            >
              {hoveredSource && (
          <Stack spacing={1.5}>
            {/* Header: [n] + Title + Category */}
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Chip
                size="small"
                label={`[${hoveredSource.n}]`}
                sx={{
                  fontWeight: 700,
                  fontSize: 12,
                  bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
                  color: "primary.main",
                  height: 22,
                }}
              />
              <Typography
                sx={{
                  fontWeight: 700,
                  fontSize: 13.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {hoveredSource.title}
              </Typography>
              {hoveredSource.category && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={hoveredSource.category}
                  sx={{ height: 18, fontSize: 10.5, fontWeight: 700 }}
                />
              )}
            </Stack>

            {/* Section & Metrics */}
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
              <Typography variant="caption" sx={{ color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {hoveredSource.section || "(document start)"}
              </Typography>
              {hoveredSource.similarity != null && (
                <Typography variant="caption" sx={{ fontWeight: 650, color: "primary.main", fontVariantNumeric: "tabular-nums" }}>
                  {(hoveredSource.similarity * 100).toFixed(0)}% match
                </Typography>
              )}
            </Stack>

            {/* Snippet Preview */}
            <Typography
              variant="body2"
              sx={{
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "text.secondary",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                bgcolor: (t) => surface(t, 0.5),
                p: 1.25,
                borderRadius: 1.5,
              }}
            >
              {hoveredSource.content.replace(/^#+.*$/gm, "").trim()}
            </Typography>

            {/* Actions */}
            <Stack direction="row" spacing={1} sx={{ pt: 0.5 }}>
              <Button
                size="small"
                variant="contained"
                startIcon={<BookOpen size={13} />}
                onClick={() => openInspector(hoveredSource)}
                sx={{
                  flex: 1,
                  height: 28,
                  fontSize: 11.5,
                  fontWeight: 650,
                  textTransform: "none",
                  borderRadius: 1.5,
                }}
              >
                Inspect in Document
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<ChevronDown size={13} />}
                onClick={() => scrollToSourceCard(hoveredSource.n)}
                sx={{
                  height: 28,
                  fontSize: 11.5,
                  fontWeight: 600,
                  textTransform: "none",
                  borderRadius: 1.5,
                  color: "text.secondary",
                }}
              >
                Jump to Card
              </Button>
            </Stack>
          </Stack>
              )}
            </Paper>
          </Fade>
        )}
      </Popper>

      {/* ---------- Document Inspector Drawer ---------- */}
      <DocumentInspectorDrawer
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        source={activeSource}
        allSources={sources}
        onSelectSource={setActiveSource}
        highlight={highlight}
      />

      {/* ---------- Previous questions ---------- */}
      <AskHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenRun={openRun}
        onAskAgain={askAgain}
        reloadKey={historyKey}
        busy={running}
      />

    </Box>
  );
}

function PipelineStep({ step, last, next }: { step: Step; last: boolean; next?: StepStatus }) {
  const theme = useTheme();
  const { status } = step;
  const color =
    status === "done" ? theme.palette.success.main
      : status === "running" ? theme.palette.primary.main
        : status === "error" ? theme.palette.error.main
          : theme.palette.text.disabled;
  const icon =
    status === "done" ? <CircleCheck size={22} />
      : status === "error" ? <CircleAlert size={22} />
        : status === "skipped" ? <Ban size={20} />
          : status === "running" ? (
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }} style={{ display: "flex" }}>
              <LoaderCircle size={22} />
            </motion.span>
          ) : (
            <Box sx={{ display: "flex", color: "text.disabled" }}>{step.icon}</Box>
          );
  // The line to the next step fills once this one is done.
  const filled = status === "done" && next !== "pending";

  return (
    <Box component="li" sx={{ display: "grid", gridTemplateColumns: "28px 1fr auto", columnGap: 1.25, px: 2, py: 1.1, position: "relative", opacity: status === "skipped" ? 0.5 : 1 }}>
      {!last && (
        <Box sx={{ position: "absolute", left: 29, top: 40, bottom: -6, width: 2, bgcolor: "divider", overflow: "hidden", borderRadius: 1 }}>
          <motion.div
            initial={false}
            animate={{ scaleY: filled ? 1 : 0 }}
            transition={{ duration: 0.4 }}
            style={{ originY: 0, height: "100%", background: theme.palette.success.main }}
          />
        </Box>
      )}
      <Box sx={{ position: "relative", width: 28, height: 28, display: "grid", placeItems: "center", color }}>
        {status === "running" && (
          <Box
            component={motion.span}
            animate={{ scale: [1, 1.6], opacity: [0.45, 0] }}
            transition={{ repeat: Infinity, duration: 1.2 }}
            sx={{ position: "absolute", inset: 2, borderRadius: "50%", bgcolor: alpha(theme.palette.primary.main, 0.35) }}
          />
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 25 }}
            style={{ display: "flex", position: "relative" }}
          >
            {icon}
          </motion.span>
        </AnimatePresence>
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 650, fontSize: 14, lineHeight: 1.3 }}>{step.name}</Typography>
        <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
          {step.tech}
        </Typography>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step.detail} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <Typography variant="body2" sx={{ fontSize: 12.5, mt: 0.25, color: status === "running" ? "text.primary" : "text.secondary", overflowWrap: "anywhere" }}>
              {step.detail}
            </Typography>
          </motion.div>
        </AnimatePresence>
      </Box>
      <AnimatePresence>
        {step.ms != null && (
          <motion.div initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }}>
            <Typography variant="caption" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {step.ms >= 1000 ? `${(step.ms / 1000).toFixed(1)} s` : `${step.ms} ms`}
            </Typography>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}
