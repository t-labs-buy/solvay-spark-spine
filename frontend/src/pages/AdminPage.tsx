/** The Admin area: who has an account, what they have been doing, and the
 *  log of it. Laid out like the Quality workspace -- a header with a KPI strip,
 *  sub-tabs, a filter bar, then tables -- so it reads as the same product.
 *
 *    Runs      one account's run history across every tool, each run
 *              opening in its own page
 *    Users     create accounts, change a role, reset a password, deactivate
 *    Usage     runs, failures, time and tokens per account and per tool
 *    Activity  sign-ins, runs, reviews and account changes, newest first
 *    User × tool  a table of every account against every tool, heaviest
 *              account first, in runs, tokens or run time
 *
 *  Only an Admin reaches this page's data; the server refuses anyone else,
 *  and the tab is not shown to them. LLM cost is an estimate at list prices
 *  from each run's model and tokens (backend/core/pricing.py); the bill is in
 *  the Anthropic Console, and per trace in Langfuse. */
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, MenuItem, Paper, Select, Stack, Switch, Tab, Table, TableBody, TableCell,
  TableHead, TableRow, Tabs, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { ExternalLink, FlaskConical, Globe2, KeyRound, MessageSquareText, RefreshCw, Scale, UserPlus } from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import {
  admin, type ActivityEvent, type AdminRun, type AdminUser, type UsageNumbers, type UsageReport, type UsageTool,
} from "../api";
import type { Account } from "../auth";
import { DailyBars } from "../components/quality/charts";
import { Empty, Kpi, MONO, Panel, RADIUS } from "../components/quality/parts";
import { when } from "../components/RunHistoryDrawer";

type View = "users" | "usage" | "runs" | "activity" | "matrix";
const VIEWS: { value: View; label: string }[] = [
  { value: "usage", label: "Usage" },
  { value: "runs", label: "Run history" },
  { value: "users", label: "Users" },
  { value: "activity", label: "Activity" },
  { value: "matrix", label: "User × tool" },
];

const TOOL_LABEL: Record<UsageTool, string> = {
  ask: "Ask RAG", evidence: "Agent", fitgap: "InsightLens", rollout: "Fit-Gap Copilot",
};
const TOOLS: UsageTool[] = ["ask", "evidence", "fitgap", "rollout"];
// The same icons as the tabs in the top bar (App.tsx), so a tool looks the same here.
const TOOL_ICON: Record<UsageTool, ReactElement> = {
  ask: <MessageSquareText size={14} />, evidence: <FlaskConical size={14} />,
  fitgap: <Scale size={14} />, rollout: <Globe2 size={14} />,
};

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 12 months" },
];

const selectSx = { fontSize: 13, minWidth: 170, borderRadius: RADIUS, "& .MuiSelect-select": { py: 0.75 } };
const num = (n: number) => n.toLocaleString();
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
// "$1,234.56" in every locale: the currency style would print "US$" in
// en-GB, the locale this page's dates come out in.
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const COST_NOTE = "Estimated at Anthropic list prices from each run's model and recorded tokens. "
  + "On the high side: cached input is priced at the full rate. Not included: the scope guard, "
  + "the answer-quality judge, agent memory and embeddings. The bill is in the Anthropic Console.";

function remembered(): View {
  try {
    const v = localStorage.getItem("admin.view");
    if (VIEWS.some((x) => x.value === v)) return v as View;
  } catch { /* private window */ }
  return "usage";
}

export default function AdminPage({ active, account, onOpenRun, canOpen = () => true }: {
  active: boolean;
  account: Account | null;
  /** Open a run in its own tool's page. */
  onOpenRun?: (tool: UsageTool, id: string) => void;
  /** Whether this front end has a page for a tool -- Demo Mode has no InsightLens. */
  canOpen?: (tool: UsageTool) => boolean;
}) {
  const theme = useTheme();
  const [view, setView] = useState<View>(remembered);
  const [days, setDays] = useState(30);
  const [userId, setUserId] = useState<number | "">("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const choose = (v: View) => {
    setView(v);
    try { localStorage.setItem("admin.view", v); } catch { /* private window */ }
  };

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    return { from: isoDay(from), to: isoDay(to) };
  }, [days, tick]);

  useEffect(() => {
    if (!active || account?.role !== "admin") return;
    let stop = false;
    setLoading(true);
    Promise.all([admin.users(), admin.usage(range.from, range.to, userId || null)])
      .then(([u, r]) => { if (!stop) { setUsers(u.users); setUsage(r); setError(null); } })
      .catch((e) => !stop && setError(e.message))
      .finally(() => !stop && setLoading(false));
    return () => { stop = true; };
  }, [active, account, range, userId]);

  const colours: Record<UsageTool, string> = {
    ask: theme.palette.primary.main,
    evidence: theme.palette.info.main,
    fitgap: theme.palette.warning.main,
    rollout: theme.palette.success.main,
  };

  if (account && account.role !== "admin") {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">The Admin area is for Admins. Ask an Admin if you need access.</Alert>
      </Box>
    );
  }

  const t = usage?.totals;
  const tokenTotal = t ? t.input_tokens + t.output_tokens : 0;

  return (
    <Box sx={{ height: "100%", overflow: "auto", p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Paper variant="outlined" sx={{ px: 2.5, pt: 1.5, borderRadius: RADIUS }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontSize: 18, fontWeight: 600 }}>Admin</Typography>
            <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
              Accounts and usage{usage ? ` · ${new Date(usage.from).toLocaleDateString()} – ${new Date(usage.to).toLocaleDateString()}` : ""}
            </Typography>
          </Box>
          {loading && <CircularProgress size={16} />}
          <Button size="small" startIcon={<RefreshCw size={14} />} onClick={() => setTick((n) => n + 1)}>
            Refresh
          </Button>
        </Stack>
        <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", mt: 0.5 }}>
          <Kpi label="Runs" value={t ? num(t.runs) : "–"} tone={t && t.failed ? "warn" : "muted"}
               status={t ? (t.failed ? `${num(t.failed)} failed` : "none failed") : ""}
               sub={t ? TOOLS.map((k) => `${TOOL_LABEL[k]} ${t.by_tool[k]}`).join(" · ") : ""} />
          <Kpi label="Active accounts" value={t ? `${t.active_users} / ${users.length}` : "–"} tone="muted"
               status="signed in or ran something" sub="in the period" />
          <Kpi label="Tokens" value={t ? tokens(tokenTotal) : "–"} tone="muted"
               status={t ? `${tokens(t.input_tokens)} in · ${tokens(t.output_tokens)} out` : ""}
               sub={t ? `${hours(t.seconds)} of run time` : ""} />
          <Kpi label="Est. LLM cost" value={t ? usd(t.cost_usd) : "–"} tone={t?.unpriced_runs ? "warn" : "muted"}
               status={t ? (t.unpriced_runs
                 ? `${t.unpriced_runs} runs on ${t.unpriced_models.join(", ")} not priced`
                 : "at list prices · see note below") : ""}
               sub={t ? TOOLS.map((k) => `${TOOL_LABEL[k]} ${usd(t.cost_by_tool[k])}`).join(" · ") : ""} />
        </Stack>
        <Tabs value={view} onChange={(_, v) => choose(v)} sx={{ minHeight: 40, mt: 0.5,
          "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontSize: 13.5 } }}>
          {VIEWS.map((v) => <Tab key={v.value} value={v.value} label={v.label} />)}
        </Tabs>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}

      {view !== "users" && (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          {(view === "usage" || view === "matrix") && (
            <Select size="small" value={days} onChange={(e) => setDays(Number(e.target.value))} sx={selectSx}>
              {RANGES.map((r) => <MenuItem key={r.days} value={r.days}>{r.label}</MenuItem>)}
            </Select>
          )}
          <Select size="small" displayEmpty value={userId} sx={selectSx}
                  onChange={(e) => { const v = e.target.value as number | ""; setUserId(v === "" ? "" : Number(v)); }}>
            <MenuItem value="">Every account</MenuItem>
            {users.map((u) => <MenuItem key={u.id} value={u.id}>{u.username}</MenuItem>)}
            {/* `legacy` is not an account anyone signs in to, so it is not in
                the account list -- but it owns every run from before accounts,
                and an Admin has to be able to pick it. */}
            {(usage?.users ?? []).filter((u) => !users.some((a) => a.id === u.user_id)).map((u) => (
              <MenuItem key={u.user_id} value={u.user_id}>{u.username} (runs before accounts)</MenuItem>
            ))}
          </Select>
        </Stack>
      )}

      {view === "usage" && usage && (
        <UsageView usage={usage} colours={colours}
                   onPickUser={(id) => { setUserId(id); choose("runs"); }} />
      )}
      {view === "runs" && (
        <RunsView active={active && view === "runs"} userId={userId || null} tick={tick}
                  colours={colours} onOpenRun={onOpenRun} canOpen={canOpen} />
      )}
      {view === "users" && (
        <UsersView users={users} me={account} onChanged={() => setTick((n) => n + 1)} />
      )}
      {view === "activity" && (
        <ActivityView active={active && view === "activity"} userId={userId || null} tick={tick} />
      )}
      {view === "matrix" && usage && (
        <MatrixView usage={usage} period={RANGES.find((r) => r.days === days)?.label ?? ""}
                    onPickUser={(id) => { setUserId(id); choose("runs"); }} />
      )}
    </Box>
  );
}

// --- Usage --------------------------------------------------------------------

function UsageView({ usage, colours, onPickUser }: {
  usage: UsageReport; colours: Record<UsageTool, string>; onPickUser: (id: number) => void;
}) {
  return (
    <Stack spacing={1.5}>
      <Panel title="Runs per day" hint="stacked by tool">
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", mb: 1 }}>
          {TOOLS.map((k) => (
            <Stack key={k} direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
              <Box sx={{ width: 10, height: 10, bgcolor: colours[k], borderRadius: "2px" }} />
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{TOOL_LABEL[k]}</Typography>
            </Stack>
          ))}
        </Stack>
        <DailyBars days={usage.daily} keys={TOOLS} colours={colours} labels={TOOL_LABEL} />
      </Panel>
      <Panel title="By account" hint="runs · failed · tokens per tool" pad={false}>
        {usage.users.length === 0 ? (
          <Box sx={{ px: 2 }}><Empty>No activity in this period.</Empty></Box>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Account</TableCell>
                  {TOOLS.map((k) => <TableCell key={k} align="right">{TOOL_LABEL[k]}</TableCell>)}
                  <TableCell align="right">Runs</TableCell>
                  <TableCell align="right">Failed</TableCell>
                  <TableCell align="right">Tokens</TableCell>
                  <TableCell align="right">Run time</TableCell>
                  <TableCell align="right">Est. cost</TableCell>
                  <TableCell>Last seen</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {usage.users.map((u) => (
                  <TableRow key={u.user_id} hover>
                    <TableCell>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                        <Tooltip title={`Open ${u.username}'s run history`}>
                          <Typography component="button" onClick={() => onPickUser(u.user_id)}
                                      sx={{ fontSize: 13, fontWeight: 600, p: 0, border: 0, bgcolor: "transparent",
                                            color: "primary.main", cursor: "pointer", font: "inherit",
                                            "&:hover": { textDecoration: "underline" } }}>
                            {u.username}
                          </Typography>
                        </Tooltip>
                        {u.role === "admin" && <RoleChip role="admin" />}
                        {!u.active && <Chip size="small" label="inactive" variant="outlined"
                                            sx={{ height: 18, fontSize: 10.5 }} />}
                      </Stack>
                    </TableCell>
                    {TOOLS.map((k) => (
                      <TableCell key={k} align="right" sx={{ fontFamily: MONO, fontSize: 12.5,
                                                              color: u.tools[k].runs ? "text.primary" : "text.disabled" }}>
                        <Tooltip title={`${u.tools[k].runs} runs · ${u.tools[k].failed} failed · `
                                        + `${tokens(u.tools[k].input_tokens + u.tools[k].output_tokens)} tokens · `
                                        + hours(u.tools[k].seconds)}>
                          <span>{u.tools[k].runs}</span>
                        </Tooltip>
                      </TableCell>
                    ))}
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>{u.runs}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5,
                                                    color: u.failed ? "warning.main" : "text.disabled" }}>{u.failed}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>
                      {tokens(u.input_tokens + u.output_tokens)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{hours(u.seconds)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>{usd(u.cost_usd)}</TableCell>
                    <TableCell sx={{ fontSize: 12.5, color: "text.secondary", whiteSpace: "nowrap" }}>
                      {u.last_seen_at ? when(u.last_seen_at) : "never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Panel>
      <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
        Runs made before accounts existed are counted under <b>legacy</b>. Est. cost: {COST_NOTE}
      </Typography>
    </Stack>
  );
}

// --- User × tool --------------------------------------------------------------

/** Whole seconds as "4h 06m 25s" -- the same three units in every cell, so
 *  a column adds up by eye (which "23 min" beside "3.5 h" does not), and each
 *  unit is spelled out rather than left to a header. */
const clock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
};

type Measure = "runs" | "tokens" | "seconds" | "cost";
// Exact values only, never rounded to "2.6M" or "4.3 h": every Total is
// checked against its row by eye, and rounded parts never add up to a
// rounded whole.
// `column` is the unit printed under every column heading; `said` puts a
// value in a sentence with its unit, for the summary line, tooltips and legend.
const MEASURES: { value: Measure; label: string; unit: string; hint: string; column: string;
                  show: (n: number) => string; said: (n: number) => string }[] = [
  { value: "runs", label: "Runs", unit: "runs", hint: "number of runs", column: "runs",
    show: num, said: (n) => `${num(n)} run${n === 1 ? "" : "s"}` },
  { value: "tokens", label: "Tokens", unit: "tokens", hint: "LLM tokens, input + output", column: "tokens",
    show: num, said: (n) => `${num(n)} token${n === 1 ? "" : "s"}` },
  { value: "seconds", label: "Run time", unit: "run time", hint: "run time in hours, minutes, seconds", column: "h · m · s",
    show: clock, said: (n) => `${clock(n)} of run time` },
  // Held in whole cents, like seconds above, so the columns add up exactly.
  { value: "cost", label: "Cost", unit: "cost", hint: "estimated LLM cost in US dollars, at list prices", column: "USD",
    show: (c) => usd(c / 100), said: (c) => `${usd(c / 100)} of estimated cost` },
];

// Seconds are whole here, and every total below is the sum of the whole
// cells, so a row's Total is exactly what its cells add up to on screen.
/** A share to one decimal, so a small but real share is never shown as 0%
 *  and a near-total one never as 100%. */
const pct = (part: number, whole: number) => {
  if (!part || !whole) return "0%";
  const p = (part / whole) * 100;
  return p < 0.1 ? "<0.1%" : p > 99.9 && part < whole ? ">99.9%" : `${p.toFixed(1).replace(/\.0$/, "")}%`;
};

const measureOf = (n: UsageNumbers, m: Measure) =>
  m === "runs" ? n.runs : m === "tokens" ? n.input_tokens + n.output_tokens
    : m === "cost" ? Math.round(n.cost_usd * 100) : Math.round(n.seconds);

/** Every account against every tool, as plain numbers. Rows are ranked by
 *  the account's total, so the heaviest user is the first row, and the Total
 *  column gives each account's share of everything in the period.
 *
 *  Only the Total column is a heatmap, in one colour from zero to the busiest
 *  account, with a legend under the table giving that range. The tool cells
 *  stay plain: a heatmap with each tool in its own colour read as four
 *  different scales. It reads the same usage report as the Usage tab, so the
 *  period and account filters apply to it unchanged. */
function MatrixView({ usage, period, onPickUser }: {
  usage: UsageReport; period: string; onPickUser: (id: number) => void;
}) {
  const theme = useTheme();
  const ink = theme.palette.primary.main;
  const [measure, setMeasure] = useState<Measure>(() => {
    try {
      const m = localStorage.getItem("admin.matrix.measure");
      if (MEASURES.some((x) => x.value === m)) return m as Measure;
    } catch { /* private window */ }
    return "runs";
  });
  const pick = (m: Measure | null) => {
    if (!m) return;
    setMeasure(m);
    try { localStorage.setItem("admin.matrix.measure", m); } catch { /* private window */ }
  };
  const M = MEASURES.find((x) => x.value === measure)!;

  const rows = usage.users
    .map((u) => {
      const cells = TOOLS.map((k) => measureOf(u.tools[k], measure));
      return { u, cells, total: cells.reduce((n, v) => n + v, 0) };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.u.username.localeCompare(b.u.username));
  const idle = usage.users.length - rows.length;
  const grand = rows.reduce((n, r) => n + r.total, 0);
  const byTool = TOOLS.map((_, i) => rows.reduce((n, r) => n + r.cells[i], 0));
  const totalMax = Math.max(1, ...rows.map((r) => r.total));
  // From a faint tint at zero to the full colour at the busiest account. The
  // number turns to the colour's contrast text once the fill is strong enough
  // that the theme's own text would not read on it.
  const LOW = 0.08, HIGH = 0.9;
  const heat = (v: number) => {
    const t = v / totalMax;
    return {
      bgcolor: alpha(ink, LOW + (HIGH - LOW) * t),
      color: t > 0.5 ? theme.palette.getContrastText(ink) : "text.primary",
    };
  };
  // A platinum ground for the table, so the matrix stands apart from the
  // white panels around it: a cool light grey with a faint top-to-bottom
  // sheen, and in the dark theme a lift of the panel's own colour. Kept light
  // enough that secondary text stays readable on it (see theme.ts).
  const dark = theme.palette.mode === "dark";
  const platinum = dark
    ? `linear-gradient(180deg, ${alpha(theme.palette.common.white, 0.06)}, ${alpha(theme.palette.common.white, 0.03)})`
    : "linear-gradient(180deg, #f2f3f5 0%, #e8eaed 100%)";
  const platinumHead = dark ? alpha(theme.palette.common.white, 0.05) : alpha("#c9ccd1", 0.35);
  const top = rows[0];
  const cellMax = Math.max(1, ...rows.flatMap((r) => r.cells));
  const topTool = TOOLS.map((k, j) => ({ k, v: byTool[j] })).sort((a, b) => b.v - a.v)[0];
  // The cell under the pointer, so its whole row and column light up
  // together -- a crosshair across the matrix. Column 4 is Total.
  const [hot, setHot] = useState<{ row: number; col: number } | null>(null);
  const lit = (row: number, col: number) => hot !== null && (hot.row === row || hot.col === col);
  // A total under the pointer, and the cells that add up to it outlined while
  // everything else fades, so the sum can be followed by eye. `sumCol` is a
  // number in the "All accounts" row (0-3 a tool, 4 the grand total, 5 the
  // share), adding down its column; `sumRow` is an account's Total, adding
  // across its row.
  const [sumCol, setSumCol] = useState<number | null>(null);
  const [sumRow, setSumRow] = useState<number | null>(null);
  const summing = sumCol !== null || sumRow !== null;
  const feedsSx = { bgcolor: `${alpha(ink, dark ? 0.26 : 0.16)} !important`,
                    boxShadow: `inset 0 0 0 1.5px ${alpha(ink, 0.65)}` };
  const fadedSx = { opacity: 0.35 };
  const feeds = (row: number, col: number, v: number) =>
    v > 0 && (sumCol === col || (sumRow === row && col < 4));
  // The account Total being explained is outlined like its parts.
  const isSum = (row: number, col: number) => sumRow === row && col === 4;
  const faded = (row: number, col: number, v: number) => summing && !feeds(row, col, v) && !isSum(row, col);
  const sumOf = (parts: { name: string; v: number }[], whole: string) => {
    const used = parts.filter((p) => p.v > 0);
    return `${whole} = ${used.map((p) => M.show(p.v)).join(" + ")}`
      + ` (${used.map((p) => p.name).join(", ")})`;
  };
  const enterSum = (col: number) => { setHot(null); setSumRow(null); setSumCol(col); };
  const enterRowSum = (row: number) => { setHot(null); setSumCol(null); setSumRow(row); };
  const enterCell = (row: number, col: number) => { setSumCol(null); setSumRow(null); setHot({ row, col }); };
  const cross = alpha(ink, dark ? 0.12 : 0.07);

  const cellSx = { fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: "tabular-nums", textAlign: "center",
                   px: 1.5, py: 1.1, transition: "background-color 120ms, opacity 120ms" };
  const headSx = { ...cellSx, fontFamily: "inherit", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
                   textTransform: "uppercase" as const, color: "text.secondary", py: 1 };
  const unitLine = (text: string) => (
    <Typography component="span" sx={{ display: "block", fontSize: 10, fontWeight: 400, letterSpacing: 0,
                                       textTransform: "none", color: "text.disabled", mt: 0.25 }}>{text}</Typography>
  );
  // A thin bar under a number, its length the number's size. Grey, one shade
  // for every tool: length says "how much", and no colour has to be decoded.
  const bar = (v: number, max: number, w = 64) => (
    <Box sx={{ mx: "auto", mt: 0.6, width: w, height: 3, borderRadius: 2,
               bgcolor: alpha(theme.palette.text.primary, 0.06), overflow: "hidden" }}>
      <Box sx={{ width: `${(v / max) * 100}%`, height: "100%", borderRadius: 2,
                 bgcolor: alpha(theme.palette.text.primary, dark ? 0.45 : 0.32) }} />
    </Box>
  );
  const initials = (name: string) => {
    const parts = name.split(/[@._\s-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
  };
  const Insight = ({ label, children, sub }: { label: string; children: ReactNode; sub: string }) => (
    <Box sx={{ flex: "1 1 200px", minWidth: 0, px: 1.75, py: 1.25, borderRadius: 2,
               bgcolor: "background.paper", border: 1, borderColor: "divider",
               boxShadow: `0 1px 2px ${alpha(theme.palette.common.black, dark ? 0.3 : 0.04)}` }}>
      <Typography sx={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase",
                        color: "text.secondary" }}>{label}</Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 0.5, minWidth: 0 }}>{children}</Stack>
      <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.25 }} noWrap>{sub}</Typography>
    </Box>
  );

  return (
    <Stack spacing={1.5}>
      <Panel title="Who uses what" hint={`${period.toLowerCase()} · ${M.hint}, per account and tool`} pad={false}
             actions={
               <ToggleButtonGroup size="small" exclusive value={measure} onChange={(_, m) => pick(m)}
                                  sx={{ height: 28, ml: 1, p: 0.25, borderRadius: 2, bgcolor: alpha(theme.palette.text.primary, 0.05),
                                        "& .MuiToggleButton-root": { border: 0, borderRadius: "6px !important", px: 1.25, fontSize: 12 },
                                        "& .Mui-selected": { bgcolor: "background.paper !important",
                                                             boxShadow: `0 1px 2px ${alpha(theme.palette.common.black, 0.15)}` } }}>
                 {MEASURES.map((m) => (
                   <ToggleButton key={m.value} value={m.value}>{m.label}</ToggleButton>
                 ))}
               </ToggleButtonGroup>
             }>
        {rows.length === 0 ? (
          <Box sx={{ px: 2 }}><Empty>No runs in this period.</Empty></Box>
        ) : (
          <Box sx={{ p: 1.5, background: platinum }}>
            {top && (
              <Stack direction="row" spacing={1.25} useFlexGap sx={{ flexWrap: "wrap", mb: 1.5 }}>
                <Insight label="Top account" sub={`${M.said(top.total)} · ${pct(top.total, grand)} of all`}>
                  <Avatar sx={{ width: 26, height: 26, fontSize: 11, fontWeight: 700, bgcolor: alpha(ink, 0.14), color: ink }}>
                    {initials(top.u.username)}
                  </Avatar>
                  <Typography sx={{ fontSize: 15, fontWeight: 700 }} noWrap>{top.u.username}</Typography>
                </Insight>
                <Insight label="Most used tool" sub={`${M.said(topTool.v)} · ${pct(topTool.v, grand)} of all`}>
                  <Box sx={{ display: "flex", color: ink }}>{TOOL_ICON[topTool.k]}</Box>
                  <Typography sx={{ fontSize: 15, fontWeight: 700 }} noWrap>{TOOL_LABEL[topTool.k]}</Typography>
                </Insight>
                <Insight label="In the period" sub={`across ${rows.length} active account${rows.length === 1 ? "" : "s"}`}>
                  <Typography sx={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>{M.show(grand)}</Typography>
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{M.column === "USD" ? "" : M.column}</Typography>
                </Insight>
              </Stack>
            )}
            <Box sx={{ overflowX: "auto", borderRadius: 2, border: 1, borderColor: "divider",
                       bgcolor: alpha(theme.palette.background.paper, dark ? 0.35 : 0.55),
                       boxShadow: `inset 0 1px 0 ${alpha(theme.palette.common.white, dark ? 0.04 : 0.8)}` }}
                 onMouseLeave={() => { setHot(null); setSumCol(null); setSumRow(null); }}>
              {/* A vertical rule between every column, the same light shade as the
                  row lines, so each account-tool cell reads as its own box. */}
              <Table size="small" sx={{ "& td, & th": { borderBottomColor: alpha(theme.palette.divider, 0.6),
                                                        borderRight: 1, borderRightColor: alpha(theme.palette.divider, 0.6) },
                                        "& td:last-of-type, & th:last-of-type": { borderRight: 0 },
                                        "& thead th": { bgcolor: platinumHead } }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ ...headSx, width: 44 }}>#</TableCell>
                    <TableCell sx={{ ...headSx, textAlign: "left" }}>Account</TableCell>
                    {TOOLS.map((k, j) => (
                      <TableCell key={k} sx={{ ...headSx, ...(hot?.col === j && { color: ink, bgcolor: `${cross} !important` }) }}>
                        <Stack direction="row" spacing={0.6} sx={{ alignItems: "center", justifyContent: "center" }}>
                          <Box sx={{ display: "flex", opacity: 0.85 }}>{TOOL_ICON[k]}</Box>
                          <span>{TOOL_LABEL[k]}</span>
                        </Stack>
                        {unitLine(M.column)}
                      </TableCell>
                    ))}
                    <TableCell sx={{ ...headSx, color: "text.primary", ...(hot?.col === 4 && { color: ink, bgcolor: `${cross} !important` }) }}>
                      Total{unitLine(M.column)}
                    </TableCell>
                    <TableCell sx={headSx}>Share{unitLine(`% of all ${M.unit}`)}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r, i) => {
                    const rowLit = hot?.row === i;
                    return (
                      <TableRow key={r.u.user_id} sx={{ ...(rowLit && { "& td": { bgcolor: cross } }) }}>
                        <TableCell sx={{ ...cellSx, px: 1, ...(summing && sumRow !== i && fadedSx) }}>
                          <Box sx={{ width: 22, height: 22, mx: "auto", borderRadius: "50%", display: "grid", placeItems: "center",
                                     fontSize: 11, fontWeight: 700,
                                     ...(i === 0 ? { bgcolor: ink, color: theme.palette.getContrastText(ink) }
                                       : { border: 1, borderColor: "divider", color: "text.secondary" }) }}>
                            {i + 1}
                          </Box>
                        </TableCell>
                        <TableCell sx={{ py: 1.1, transition: "opacity 120ms", ...(summing && sumRow !== i && { opacity: 0.6 }) }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                            <Avatar sx={{ width: 28, height: 28, fontSize: 11, fontWeight: 700,
                                          bgcolor: alpha(ink, i === 0 ? 0.18 : 0.1), color: ink }}>
                              {initials(r.u.username)}
                            </Avatar>
                            <Tooltip title={`Open ${r.u.username}'s run history`}>
                              <Typography component="button" onClick={() => onPickUser(r.u.user_id)}
                                          sx={{ fontSize: 13, fontWeight: 600, p: 0, border: 0, bgcolor: "transparent",
                                                color: "text.primary", cursor: "pointer", font: "inherit",
                                                "&:hover": { color: "primary.main", textDecoration: "underline" } }}>
                                {r.u.username}
                              </Typography>
                            </Tooltip>
                            {r.u.role === "admin" && <RoleChip role="admin" />}
                            {!r.u.active && <Chip size="small" label="inactive" variant="outlined"
                                                  sx={{ height: 18, fontSize: 10.5 }} />}
                          </Stack>
                        </TableCell>
                        {TOOLS.map((k, j) => {
                          const v = r.cells[j];
                          const n = r.u.tools[k];
                          return (
                            <Tooltip key={k} placement="top" arrow
                                     title={v ? `${r.u.username} · ${TOOL_LABEL[k]}: ${num(n.runs)} runs`
                                       + `${n.failed ? ` (${n.failed} failed)` : ""} · `
                                       + `${num(n.input_tokens + n.output_tokens)} tokens · ${clock(Math.round(n.seconds))} · ${usd(n.cost_usd)} est.`
                                       + ` · ${pct(v, r.total)} of their ${M.unit}`
                                       : `${r.u.username} has not used ${TOOL_LABEL[k]} in this period`}>
                              <TableCell onMouseEnter={() => enterCell(i, j)}
                                         sx={{ ...cellSx, color: v ? "text.primary" : "text.disabled",
                                               ...(lit(i, j) && { bgcolor: cross }),
                                               ...(hot?.row === i && hot?.col === j && { bgcolor: alpha(ink, dark ? 0.22 : 0.13) }),
                                               ...(feeds(i, j, v) && feedsSx), ...(faded(i, j, v) && fadedSx) }}>
                                {v ? M.show(v) : "·"}
                                {v > 0 && bar(v, cellMax)}
                              </TableCell>
                            </Tooltip>
                          );
                        })}
                        <Tooltip placement="top" arrow
                                 title={`${r.u.username}, every tool: `
                                   + sumOf(TOOLS.map((k, j) => ({ name: TOOL_LABEL[k], v: r.cells[j] })), M.show(r.total))
                                   + ` · ${pct(r.total, totalMax)} of the busiest account`}>
                          <TableCell onMouseEnter={() => enterRowSum(i)}
                                     sx={{ ...cellSx, cursor: "help", ...(lit(i, 4) && { bgcolor: cross }),
                                           ...((feeds(i, 4, r.total) || isSum(i, 4)) && feedsSx),
                                           ...(faded(i, 4, r.total) && fadedSx) }}>
                            <Box component="span" sx={{ ...heat(r.total), display: "inline-block", minWidth: 64, px: 1.25, py: 0.4,
                                                        borderRadius: 999, fontWeight: 700,
                                                        boxShadow: `inset 0 0 0 1px ${alpha(ink, 0.25)}` }}>
                              {M.show(r.total)}
                            </Box>
                          </TableCell>
                        </Tooltip>
                        <TableCell sx={{ ...cellSx, color: "text.secondary",
                                         ...(feeds(i, 5, r.total) && feedsSx), ...(faded(i, 5, r.total) && fadedSx) }}>
                          {pct(r.total, grand)}
                          {bar(r.total, grand, 56)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow sx={{ "& td": { borderBottom: 0, borderTop: 2, borderTopColor: "divider", fontWeight: 700,
                                            bgcolor: alpha(theme.palette.text.primary, dark ? 0.04 : 0.025),
                                            transition: "opacity 120ms", ...(sumRow !== null && fadedSx) } }}>
                    <TableCell />
                    <TableCell sx={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
                                     color: "text.secondary" }}>All accounts</TableCell>
                    {TOOLS.map((k, j) => (
                      <Tooltip key={k} placement="bottom" arrow
                               title={byTool[j] ? `${TOOL_LABEL[k]}, every account: `
                                 + sumOf(rows.map((r) => ({ name: r.u.username, v: r.cells[j] })), M.show(byTool[j]))
                                 : `No ${M.unit} on ${TOOL_LABEL[k]} in this period`}>
                        <TableCell onMouseEnter={() => enterSum(j)}
                                   sx={{ ...cellSx, fontWeight: 700, cursor: "help", ...(hot?.col === j && { bgcolor: cross }),
                                         ...(sumCol === j && feedsSx) }}>
                          {byTool[j] ? M.show(byTool[j]) : "·"}
                          {byTool[j] > 0 && (
                            <Typography component="span" sx={{ display: "block", fontSize: 10.5, fontWeight: 400, color: "text.secondary" }}>
                              {pct(byTool[j], grand)} of total
                            </Typography>
                          )}
                        </TableCell>
                      </Tooltip>
                    ))}
                    <Tooltip placement="bottom" arrow
                             title={`Every account's total: ${sumOf(rows.map((r) => ({ name: r.u.username, v: r.total })), M.show(grand))}`}>
                      <TableCell onMouseEnter={() => enterSum(4)}
                                 sx={{ ...cellSx, fontWeight: 700, cursor: "help", ...(hot?.col === 4 && { bgcolor: cross }),
                                       ...(sumCol === 4 && feedsSx) }}>{M.show(grand)}</TableCell>
                    </Tooltip>
                    <Tooltip placement="bottom" arrow
                             title={`100% = ${rows.map((r) => pct(r.total, grand)).join(" + ")} (each account's share, rounded)`}>
                      <TableCell onMouseEnter={() => enterSum(5)}
                                 sx={{ ...cellSx, color: "text.secondary", cursor: "help", ...(sumCol === 5 && feedsSx) }}>100%</TableCell>
                    </Tooltip>
                  </TableRow>
                </TableBody>
              </Table>
            </Box>
          </Box>
        )}
      </Panel>
      {rows.length > 0 && (
        <Stack direction="row" spacing={1.25} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography sx={{ fontSize: 11.5, fontWeight: 600 }}>Total column</Typography>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary", fontFamily: MONO }}>{M.said(0)}</Typography>
          <Box role="img" aria-label={`Colour scale from ${M.said(0)} to ${M.said(totalMax)}`}
               sx={{ width: 180, height: 12, borderRadius: "3px", border: 1, borderColor: "divider",
                     background: `linear-gradient(to right, ${alpha(ink, LOW)}, ${alpha(ink, HIGH)})` }} />
          <Typography sx={{ fontSize: 11.5, color: "text.secondary", fontFamily: MONO }}>{M.said(totalMax)}</Typography>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
            — the stronger the colour, the more {measure === "runs" ? "runs" : M.unit} that account made;
            the strongest is the busiest account in the period ({rows[0].u.username}).
            {idle > 0 ? ` ${idle} account${idle === 1 ? "" : "s"} with no ${M.unit} in this period ${idle === 1 ? "is" : "are"} not shown.` : ""}
          </Typography>
        </Stack>
      )}
      {measure === "cost" && (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
          {COST_NOTE}
          {usage.totals.unpriced_runs > 0
            ? ` ${usage.totals.unpriced_runs} run(s) on ${usage.totals.unpriced_models.join(", ")} have no price and are left out.`
            : ""}
        </Typography>
      )}
    </Stack>
  );
}

function RoleChip({ role }: { role: "admin" | "user" }) {
  return (
    <Chip size="small" label={role === "admin" ? "Admin" : "User"} variant="outlined"
          color={role === "admin" ? "primary" : "default"} sx={{ height: 18, fontSize: 10.5 }} />
  );
}

// --- Run history --------------------------------------------------------------

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "default"> = {
  done: "success", running: "warning", failed: "error",
};

function RunsView({ active, userId, tick, colours, onOpenRun, canOpen }: {
  active: boolean; userId: number | null; tick: number; colours: Record<UsageTool, string>;
  onOpenRun?: (tool: UsageTool, id: string) => void; canOpen: (tool: UsageTool) => boolean;
}) {
  const [tool, setTool] = useState<UsageTool | "">("");
  const [runs, setRuns] = useState<AdminRun[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((before?: string) => {
    admin.runs({ userId, tool, before })
      .then((r) => {
        setRuns((prev) => (before ? [...prev, ...r.runs] : r.runs));
        setMore(r.more);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [userId, tool]);

  useEffect(() => { if (active) load(); }, [active, load, tick]);

  return (
    <Panel title="Run history" hint={userId ? "one account, every tool" : "every account, every tool"} pad={false}
           actions={
             <Select size="small" displayEmpty value={tool} sx={{ ...selectSx, minWidth: 150 }}
                     onChange={(e) => setTool(e.target.value as UsageTool | "")}>
               <MenuItem value="">Every tool</MenuItem>
               {TOOLS.map((t) => <MenuItem key={t} value={t}>{TOOL_LABEL[t]}</MenuItem>)}
             </Select>
           }>
      {error && <Alert severity="error" sx={{ m: 1.5 }}>{error}</Alert>}
      {runs.length === 0 ? (
        <Box sx={{ px: 2 }}><Empty>No runs{userId ? " for this account" : ""} yet.</Empty></Box>
      ) : (
        <Box sx={{ overflowX: "auto" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Account</TableCell>
                <TableCell>Tool</TableCell>
                <TableCell>Question or scope</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Time</TableCell>
                <TableCell align="right">Tokens</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={`${r.tool}:${r.id}`} hover>
                  <TableCell sx={{ fontSize: 12.5, whiteSpace: "nowrap", color: "text.secondary" }}>
                    {r.started_at && (
                      <Tooltip title={new Date(r.started_at).toLocaleString()}><span>{when(r.started_at)}</span></Tooltip>
                    )}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12.5, fontWeight: 600 }}>{r.username || "—"}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                      <Box sx={{ width: 8, height: 8, borderRadius: "2px", bgcolor: colours[r.tool] }} />
                      <Typography sx={{ fontSize: 12.5 }}>{TOOL_LABEL[r.tool]}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ fontSize: 12.5, maxWidth: 520 }}>
                    <Typography sx={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis",
                                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {r.title || "—"}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={r.status} color={STATUS_TONE[r.status] ?? "default"}
                          sx={{ height: 20, fontSize: 11 }} />
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>
                    {r.seconds ? hours(r.seconds) : "—"}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>
                    {r.tokens ? tokens(r.tokens) : "—"}
                  </TableCell>
                  <TableCell align="right">
                    {onOpenRun && canOpen(r.tool) ? (
                      <Button size="small" startIcon={<ExternalLink size={13} />}
                              onClick={() => onOpenRun(r.tool, r.id)}>
                        Open
                      </Button>
                    ) : (
                      <Tooltip title={`${TOOL_LABEL[r.tool]} is not part of this view`}>
                        <Typography component="span" sx={{ fontSize: 12, color: "text.disabled", fontFamily: MONO }}>
                          {r.id}
                        </Typography>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {more && (
        <Box sx={{ p: 1.5, textAlign: "center" }}>
          <Button size="small" onClick={() => load(runs[runs.length - 1]?.started_at ?? undefined)}>Load older</Button>
        </Box>
      )}
    </Panel>
  );
}

// --- Users --------------------------------------------------------------------

function UsersView({ users, me, onChanged }: { users: AdminUser[]; me: Account | null; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async (u: AdminUser, c: { role?: "admin" | "user"; active?: boolean }) => {
    try {
      await admin.updateUser(u.id, c);
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Panel title="Accounts" hint={`${users.length} account${users.length === 1 ? "" : "s"}`} pad={false}
           actions={<Button size="small" variant="contained" startIcon={<UserPlus size={14} />}
                            onClick={() => setCreating(true)}>New account</Button>}>
      {error && <Alert severity="error" sx={{ m: 1.5 }} onClose={() => setError(null)}>{error}</Alert>}
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Username</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Active</TableCell>
              <TableCell align="right">Runs</TableCell>
              <TableCell>Last sign-in</TableCell>
              <TableCell>Created</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map((u) => {
              const self = me?.id === u.id;
              return (
                <TableRow key={u.id} hover>
                  <TableCell sx={{ fontWeight: 600, fontSize: 13 }}>
                    {u.username}{self && <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}> (you)</Box>}
                    {u.must_change_password && (
                      <Tooltip title="Still on the password an Admin set; they choose their own at their next sign-in">
                        <Chip size="small" label="password not yet changed" variant="outlined" color="warning"
                              sx={{ ml: 1, height: 18, fontSize: 10.5 }} />
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={self ? "You cannot change your own role" : ""}>
                      <span>
                        <Select size="small" value={u.role} disabled={self} sx={{ ...selectSx, minWidth: 100 }}
                                onChange={(e) => change(u, { role: e.target.value as "admin" | "user" })}>
                          <MenuItem value="user">User</MenuItem>
                          <MenuItem value="admin">Admin</MenuItem>
                        </Select>
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip title={self ? "You cannot deactivate your own account"
                                         : u.active ? "Deactivate: signs them out and stops sign-in" : "Reactivate"}>
                      <span>
                        <FormControlLabel sx={{ m: 0 }} label={<Typography sx={{ fontSize: 12.5 }}>{u.active ? "Active" : "Inactive"}</Typography>}
                          control={<Switch size="small" checked={u.active} disabled={self}
                                           onChange={(e) => change(u, { active: e.target.checked })} />} />
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{u.runs}</TableCell>
                  <TableCell sx={{ fontSize: 12.5, color: "text.secondary" }}>
                    {u.last_login_at ? when(u.last_login_at) : "never"}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12.5, color: "text.secondary" }}>
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : ""}
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" startIcon={<KeyRound size={13} />} onClick={() => setResetting(u)}>
                      Reset password
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} onCreated={onChanged} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onDone={onChanged} />
    </Panel>
  );
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setUsername(""); setPassword(""); setError(null); onClose(); };
  const save = async () => {
    setBusy(true);
    try {
      // Every new account is a User: it sees only its own runs. Making
      // someone an Admin is a separate, deliberate step on the Users table.
      await admin.createUser(username.trim(), password, "user");
      onCreated();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>New account</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Username" value={username} autoFocus onChange={(e) => setUsername(e.target.value)}
                     helperText="No spaces. Not case-sensitive." />
          <TextField label="Temporary password" type="password" value={password} autoComplete="new-password"
                     onChange={(e) => setPassword(e.target.value)}
                     helperText="At least 8 characters. They must choose their own at first sign-in." />
          <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
            New accounts are Users: they see only their own run history. To make someone an
            Admin, change their role in the table afterwards.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy || !username.trim() || !password}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: AdminUser | null; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setPassword(""); setError(null); onClose(); };
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await admin.updateUser(user.id, { password });
      onDone();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!user} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Reset password for {user?.username}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            This signs {user?.username} out everywhere. Give them the new password yourself;
            they will be asked to choose their own when they next sign in.
          </Typography>
          <TextField label="New password" type="password" value={password} autoFocus autoComplete="new-password"
                     helperText="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy || !password}>Reset password</Button>
      </DialogActions>
    </Dialog>
  );
}

// --- Activity -----------------------------------------------------------------

const ACTION_LABEL: Record<string, string> = {
  login: "Signed in", login_failed: "Sign-in failed", logout: "Signed out", run: "Started a run",
  review: "Reviewed", decision: "Recorded a decision", workshop: "Submitted a workshop",
  export: "Exported", delete: "Deleted a run", clear_history: "Cleared history",
  password_changed: "Changed their password", user_created: "Created an account",
  user_updated: "Changed an account",
};

function describe(e: ActivityEvent): string {
  const d = e.detail || {};
  const bits = [e.tool ? TOOL_LABEL[e.tool as UsageTool] ?? e.tool : "", e.run_id ?? ""];
  if (typeof d.user === "string") bits.push(String(d.user));
  for (const k of ["role", "active", "password", "verdict", "format", "removed"]) {
    if (k in d) bits.push(`${k}: ${String(d[k])}`);
  }
  return bits.filter(Boolean).join(" · ");
}

function ActivityView({ active, userId, tick }: { active: boolean; userId: number | null; tick: number }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState("");
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((before?: number) => {
    admin.activity({ before, userId, action })
      .then((r) => {
        setEvents((prev) => (before ? [...prev, ...r.events] : r.events));
        setMore(r.more);
        setActions(r.actions);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [userId, action]);

  useEffect(() => { if (active) load(); }, [active, load, tick]);

  return (
    <Panel title="Activity" hint="newest first" pad={false}
           actions={
             <Select size="small" displayEmpty value={action} onChange={(e) => setAction(e.target.value)}
                     sx={{ ...selectSx, minWidth: 150 }}>
               <MenuItem value="">Every action</MenuItem>
               {actions.map((a) => <MenuItem key={a} value={a}>{ACTION_LABEL[a] ?? a}</MenuItem>)}
             </Select>
           }>
      {error && <Alert severity="error" sx={{ m: 1.5 }}>{error}</Alert>}
      {events.length === 0 ? (
        <Box sx={{ px: 2 }}><Empty>Nothing recorded yet.</Empty></Box>
      ) : (
        <Box sx={{ overflowX: "auto" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Account</TableCell>
                <TableCell>What</TableCell>
                <TableCell>Detail</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id} hover>
                  <TableCell sx={{ fontSize: 12.5, whiteSpace: "nowrap", color: "text.secondary" }}>
                    <Tooltip title={new Date(e.at).toLocaleString()}><span>{when(e.at)}</span></Tooltip>
                  </TableCell>
                  <TableCell sx={{ fontSize: 12.5, fontWeight: 600 }}>{e.username || "—"}</TableCell>
                  <TableCell sx={{ fontSize: 12.5, color: e.action === "login_failed" ? "warning.main" : "text.primary" }}>
                    {ACTION_LABEL[e.action] ?? e.action}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12, color: "text.secondary", fontFamily: MONO }}>{describe(e)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {more && (
        <Box sx={{ p: 1.5, textAlign: "center" }}>
          <Button size="small" onClick={() => load(events[events.length - 1]?.id)}>Load older</Button>
        </Box>
      )}
    </Panel>
  );
}
