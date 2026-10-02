/** Answers — the analytical list.
 *
 *  The pattern an SAP user already reads without being taught: a row of small
 *  charts that double as filters, and under them one dense, sortable table of
 *  every judged answer. A score below the line is the only thing that takes a
 *  colour; everything else stays quiet so the exceptions are what the eye
 *  finds. Every row opens the judge's working for that answer.
 */
import {
  Box, ButtonBase, Link, MenuItem, Select, Stack, Table, TableBody, TableCell, TableHead,
  TableRow, TableSortLabel, TextField, Typography, alpha, useTheme,
} from "@mui/material";
import { Download } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { FailureType, QualityExplorer, QualityOverview, QualityPoint } from "../../api";
import { band, Bullet, statusOf } from "./charts";
import { Empty, MONO, Panel, RADIUS } from "./parts";

// Defined beside the other shared pieces; re-exported for the views that
// have always imported it from here.
export { MONO };

type SortKey = "status" | "question" | "at" | "overall" | "faithfulness" | "answer_relevancy"
  | "context_precision" | "context_relevance" | "cause" | "tokens";

const METRIC_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "faithfulness", label: "Faithful." },
  { key: "answer_relevancy", label: "Ans. rel." },
  { key: "context_precision", label: "Ctx prec." },
  { key: "context_relevance", label: "Ctx rel." },
];

const when = (at: string | null) => at
  ? new Date(at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
  : "—";

/** A field with its label above it, not floating inside: the form idiom of
 *  enterprise filter bars, where a row of fields is scanned by its labels. */
export function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <Stack spacing={0.5}>
      <Typography component="label" htmlFor={id} sx={{ fontSize: 12, color: "text.secondary" }}>{label}</Typography>
      {children}
    </Stack>
  );
}

/** One bar of a visual filter. Pressing it filters the table; pressing the
 *  chosen one again clears it. */
function BarRow({ label, n, share, value, selected, colour, onClick }: {
  label: string; n: number; share: number; value?: string; selected: boolean; colour: string; onClick?: () => void;
}) {
  const theme = useTheme();
  const body = (
    <Box sx={{
      display: "grid", gridTemplateColumns: value ? "128px 1fr 26px 40px" : "128px 1fr 26px", gap: 1,
      alignItems: "center", width: "100%", py: 0.4, px: 0.5,
      bgcolor: selected ? alpha(theme.palette.primary.main, 0.1) : "transparent",
      outline: selected ? `1px solid ${theme.palette.primary.main}` : "none",
    }}>
      <Typography sx={{ fontSize: 12, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</Typography>
      <Box sx={{ height: 10, bgcolor: alpha(theme.palette.text.primary, 0.06) }}>
        <Box sx={{ height: 10, width: `${share * 100}%`, bgcolor: colour }} />
      </Box>
      <Typography sx={{ fontSize: 12, fontFamily: MONO, textAlign: "right" }}>{n}</Typography>
      {value && <Typography sx={{ fontSize: 12, fontFamily: MONO, textAlign: "right" }}>{value}</Typography>}
    </Box>
  );
  return onClick
    ? <ButtonBase onClick={onClick} aria-pressed={selected} sx={{ width: "100%", display: "block" }}>{body}</ButtonBase>
    : body;
}

export default function AnswersView({ overview, explorer, half, onHalf, onOpen }: {
  overview: QualityOverview;
  explorer: QualityExplorer;
  half: string;
  onHalf: (half: string) => void;
  onOpen: (p: QualityPoint) => void;
}) {
  const theme = useTheme();
  const line = explorer.line;
  const [cause, setCause] = useState<string>("");   // "" all · "none" no failure · a failure key
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "overall", dir: "asc" });

  const causeLabel = useMemo(
    () => Object.fromEntries(explorer.failures.map((f) => [f.key, f.label])) as Record<FailureType["key"], string>,
    [explorer.failures]);

  const valueOf = (p: QualityPoint, key: SortKey): number | string => {
    switch (key) {
      case "status": return p.overall ?? -1;
      case "question": return p.question.toLowerCase();
      case "at": return p.at ?? "";
      case "overall": return p.overall ?? -1;
      case "cause": return p.failure ? causeLabel[p.failure] : "";
      case "tokens": return p.tokens ?? 0;
      default: return p.values?.[key] ?? -1;
    }
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const kept = explorer.points.filter((p) =>
      (!q || p.question.toLowerCase().includes(q))
      && (!cause || (cause === "none" ? !p.failure : p.failure === cause))
      && (!status || statusOf(p.overall).key === status));
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...kept].sort((a, b) => {
      const x = valueOf(a, sort.key), y = valueOf(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    // valueOf only reads causeLabel, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer.points, search, cause, status, sort, causeLabel]);

  // A new column sorts ascending (worst first for scores); the same column again flips it.
  const sortBy = (key: SortKey) => setSort((s) => ({
    key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc",
  }));

  const exportCsv = () => {
    const head = ["status", "question", "asked", "overall", ...METRIC_COLUMNS.map((c) => c.key), "cause", "tokens", "run_id"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((p) => [
      statusOf(p.overall).label, p.question, p.at ?? "", p.overall?.toFixed(4) ?? "",
      ...METRIC_COLUMNS.map((c) => p.values?.[c.key]?.toFixed(4) ?? ""),
      p.failure ? causeLabel[p.failure] : "", p.tokens ?? "", p.run_id,
    ].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `answer-evaluation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- the visual filters ------------------------------------------------------
  const total = explorer.points.length;
  const healthy = explorer.points.filter((p) => !p.failure).length;
  const causeBars = [
    { key: "none", label: "No failure", n: healthy },
    ...explorer.failures.map((f) => ({ key: f.key, label: f.label, n: f.count })),
  ];
  const maxCause = Math.max(1, ...causeBars.map((c) => c.n));
  const bins = overview.histogram;
  const maxBin = Math.max(1, ...bins);
  const maxHalf = Math.max(1, ...overview.halves.map((h) => h.n));
  const series = overview.series.filter((s) => s.median !== null);
  const neutral = alpha(theme.palette.primary.main, 0.7);

  const header = (key: SortKey, label: string, numeric = false) => (
    <TableCell key={key} align={numeric ? "right" : "left"} sortDirection={sort.key === key ? sort.dir : false}
               sx={{ fontWeight: 600, fontSize: 12, whiteSpace: "nowrap", color: "text.secondary" }}>
      <TableSortLabel active={sort.key === key} direction={sort.key === key ? sort.dir : "asc"} onClick={() => sortBy(key)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );

  return (
    <Stack spacing={2}>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr", xl: "repeat(4, minmax(0, 1fr))" } }}>
        <Panel title="Failure cause" hint="select to filter">
          <Stack spacing={0.25}>
            {causeBars.map((c) => (
              <BarRow key={c.key} label={c.label} n={c.n} share={c.n / maxCause}
                      colour={c.key === "none" ? alpha(theme.palette.text.primary, 0.3) : neutral}
                      selected={cause === c.key} onClick={() => setCause(cause === c.key ? "" : c.key)} />
            ))}
          </Stack>
        </Panel>
        <Panel title="Overall score distribution" hint={`threshold ${line.toFixed(2)}`}>
          <Box sx={{ position: "relative", height: 104, display: "flex", alignItems: "flex-end", gap: 0.5,
                     borderBottom: 1, borderColor: "divider" }}>
            {bins.map((n, i) => (
              <Box key={i} title={`${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}: ${n} answer${n === 1 ? "" : "s"}`}
                   sx={{ flex: "1 1 0", height: `${(n / maxBin) * 100}%`,
                         bgcolor: (i + 1) / 10 <= line ? theme.palette.warning.main : neutral }} />
            ))}
            <Box sx={{ position: "absolute", left: `${line * 100}%`, top: 0, bottom: 0,
                       borderLeft: `1px dashed ${theme.palette.text.primary}` }} />
          </Box>
          <Stack direction="row" sx={{ justifyContent: "space-between", mt: 0.5 }}>
            {["0.0", "0.5", "1.0"].map((t) => <Typography key={t} sx={{ fontSize: 11, fontFamily: MONO, color: "text.secondary" }}>{t}</Typography>)}
          </Stack>
        </Panel>
        <Panel title="By corpus scope" hint="answers · mean overall">
          {overview.halves.length ? (
            <Stack spacing={0.25}>
              {overview.halves.map((h) => (
                <BarRow key={h.half} label={h.half.replace(/\+/g, " + ")} n={h.n} share={h.n / maxHalf}
                        value={h.overall === null ? "—" : h.overall.toFixed(2)}
                        colour={h.overall !== null && h.overall < line ? theme.palette.warning.main : neutral}
                        selected={half === h.half} onClick={() => onHalf(half === h.half ? "" : h.half)} />
              ))}
            </Stack>
          ) : <Empty>No answers in this window.</Empty>}
        </Panel>
        <Panel title="Median overall by period" hint={`${overview.days}-day window`}>
          {series.length > 1 ? (
            <Box sx={{ position: "relative", height: 104, display: "flex", alignItems: "flex-end", gap: 0.5,
                       borderBottom: 1, borderColor: "divider" }}>
              {series.map((s) => (
                <Box key={s.at} title={`${new Date(s.at).toLocaleDateString("en-GB")}: median ${s.median?.toFixed(2)} over ${s.n}`}
                     sx={{ flex: "1 1 0", height: `${(s.median ?? 0) * 100}%`,
                           bgcolor: (s.median ?? 0) < line ? theme.palette.warning.main : neutral }} />
              ))}
              <Box sx={{ position: "absolute", left: 0, right: 0, bottom: `${line * 100}%`,
                         borderTop: `1px dashed ${theme.palette.text.primary}` }} />
            </Box>
          ) : (
            <Stack spacing={0.75}>
              <Typography sx={{ fontFamily: MONO, fontSize: 22 }}>{series[0]?.median?.toFixed(2) ?? "—"}</Typography>
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                One period of data so far. The trend appears as answers are scored in later periods.
              </Typography>
            </Stack>
          )}
          {overview.events.length > 0 && (
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.75 }}>
              Prompt or corpus changed {overview.events.length}× in this window, most recently {when(overview.events[overview.events.length - 1].at)}.
            </Typography>
          )}
        </Panel>
      </Box>

      <Box sx={{ border: 1, borderColor: "divider", borderRadius: RADIUS, bgcolor: "background.paper", overflow: "hidden" }}>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", px: 2, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
          <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Answers ({rows.length}{rows.length !== total ? ` of ${total}` : ""})</Typography>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            sorted by {sort.key.replace(/_/g, " ")}, {sort.dir === "asc" ? "lowest first" : "highest first"}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Select size="small" value={status} displayEmpty onChange={(e) => setStatus(e.target.value)}
                  inputProps={{ "aria-label": "Status" }} sx={{ fontSize: 13, minWidth: 140, borderRadius: RADIUS }}>
            <MenuItem value="">All statuses</MenuItem>
            <MenuItem value="pass">Pass</MenuItem>
            <MenuItem value="review">Review</MenuItem>
            <MenuItem value="fail">Fail</MenuItem>
          </Select>
          <TextField size="small" placeholder="Search questions" value={search} onChange={(e) => setSearch(e.target.value)}
                     slotProps={{ htmlInput: { "aria-label": "Search questions" } }}
                     sx={{ width: 240, "& .MuiOutlinedInput-root": { borderRadius: RADIUS, fontSize: 13 } }} />
          <ButtonBase onClick={exportCsv} sx={{
            height: 32, px: 1.5, gap: 0.75, border: 1, borderColor: "divider", borderRadius: RADIUS, fontSize: 13,
            "&:hover": { bgcolor: "action.hover" },
          }}>
            <Download size={14} /> Export CSV
          </ButtonBase>
        </Stack>
        {rows.length ? (
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small" sx={{ "& td, & th": { borderColor: "divider" }, "& td": { py: 0.9, fontSize: 13 } }}>
              <TableHead sx={{ bgcolor: alpha(theme.palette.text.primary, 0.03) }}>
                <TableRow>
                  {header("status", "Status")}
                  {header("question", "Question")}
                  {header("at", "Asked")}
                  {header("overall", "Overall")}
                  {METRIC_COLUMNS.map((c) => header(c.key, c.label, true))}
                  {header("cause", "Cause")}
                  {header("tokens", "Tokens", true)}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((p) => {
                  const st = statusOf(p.overall);
                  const colour = p.overall === null ? theme.palette.text.disabled : band(theme, p.overall);
                  return (
                    <TableRow key={p.run_id} hover>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>
                        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", color: colour, fontWeight: 500, fontSize: 12.5 }}>
                          <Box sx={{ width: 8, height: 8, bgcolor: colour, borderRadius: st.key === "pass" ? "50%" : 0 }} />
                          <span>{st.label}</span>
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 340 }}>
                        <Link component="button" type="button" underline="hover" onClick={() => onOpen(p)}
                              sx={{ display: "block", maxWidth: "100%", textAlign: "left", overflow: "hidden",
                                    textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                          {p.question}
                        </Link>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap", color: "text.secondary", fontSize: "12px !important" }}>{when(p.at)}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <Bullet value={p.overall} line={line} />
                          <Box component="span" sx={{ fontFamily: MONO, fontWeight: 500 }}>{p.overall?.toFixed(2) ?? "—"}</Box>
                        </Stack>
                      </TableCell>
                      {METRIC_COLUMNS.map((c) => {
                        const v = p.values?.[c.key] ?? null;
                        const low = v !== null && v < line;
                        return (
                          <TableCell key={c.key} align="right" sx={{
                            fontFamily: MONO, color: low ? "warning.main" : "text.primary", fontWeight: low ? 600 : 400,
                          }}>
                            {v === null ? "—" : v.toFixed(2)}
                          </TableCell>
                        );
                      })}
                      <TableCell sx={{ whiteSpace: "nowrap", color: "text.secondary" }}>{p.failure ? causeLabel[p.failure] : "—"}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, color: "text.secondary", fontSize: "12px !important" }}>
                        {(p.tokens ?? 0).toLocaleString("en-GB")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <Box sx={{ px: 2 }}><Empty>No answer matches these filters.</Empty></Box>
        )}
      </Box>
    </Stack>
  );
}
