/** The charts of the Answer Quality workspace.
 *
 *  Hand-drawn SVG over d3 scales rather than a chart library: each one is a
 *  specific argument (a band, not a line; a quadrant, not a scatter) and a
 *  library's defaults would have to be argued out of every one of them.
 *
 *  Every colour comes from the theme palette, so the dark theme stays Frappé
 *  and nothing here writes a hex. Every mark carries a native <title>, so
 *  hovering anything says what it is without a tooltip library.
 */
import { Box, Typography, alpha, useTheme } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import * as d3 from "d3";
import { useMemo } from "react";

import type { FailureType, QualityPoint, QualitySubject } from "../../api";

/** The bands every score widget in the app uses: the Ask scorecard, the
 *  metric drawer, InsightLens's confidence meter. Kept identical --
 *  frontend/test/quality-page.mjs fails if the three copies drift -- so a
 *  colour means the same thing wherever it appears. */
export function band(theme: Theme, value: number) {
  return value >= 0.7 ? theme.palette.success.main
    : value >= 0.4 ? theme.palette.warning.main
      : theme.palette.error.main;
}

/** The status word for a score, on the same bands as `band`: what the
 *  analytical list shows beside the colour, so status never rests on hue. */
export function statusOf(value: number | null): { label: string; key: "pass" | "review" | "fail" | "none" } {
  if (value === null) return { label: "Not scored", key: "none" };
  return value >= 0.7 ? { label: "Pass", key: "pass" }
    : value >= 0.4 ? { label: "Review", key: "review" }
      : { label: "Fail", key: "fail" };
}

/** A bullet bar: the score as a bar, the threshold as a tick across it. The
 *  one chart that fits in a table cell and still shows "how far from the
 *  line", which a coloured number alone cannot. */
export function Bullet({ value, line, width = 84 }: { value: number | null; line: number; width?: number }) {
  const theme = useTheme();
  const v = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <Box component="span" sx={{ position: "relative", display: "inline-block", width, height: 8,
                                 bgcolor: alpha(theme.palette.text.primary, 0.08), flexShrink: 0 }}>
      <Box component="span" sx={{ position: "absolute", left: 0, top: 0, height: 8, width: v * width,
                                   bgcolor: value !== null && value < line ? theme.palette.warning.main
                                     : alpha(theme.palette.primary.main, 0.75) }} />
      <Box component="span" sx={{ position: "absolute", left: line * width - 1, top: -3, height: 14,
                                   borderLeft: `2px solid ${theme.palette.text.primary}` }} />
    </Box>
  );
}

/** A colour per failure type. Retrieval failures are warm, generation
 *  failures red, so the quadrant reads as two kinds of problem at a glance. */
export function failureColour(theme: Theme, key: FailureType["key"] | null) {
  switch (key) {
    case null: return theme.palette.success.main;
    case "invented":
    case "safety": return theme.palette.error.main;
    case "wrong_sources":
    case "buried": return theme.palette.warning.main;
    case "ignored": return theme.palette.info.main;
    case "off_question": return theme.palette.secondary.main;
    default: return theme.palette.text.disabled;
  }
}

export function Meter({ value, colour }: { value: number | null; colour: string }) {
  return (
    <Box sx={{ height: 5, borderRadius: 3, bgcolor: alpha(colour, 0.15), overflow: "hidden" }}>
      {value !== null && (
        <Box sx={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: "100%", bgcolor: colour, borderRadius: 3 }} />
      )}
    </Box>
  );
}

/** A small deterministic nudge, so twenty answers at (1.0, 1.0) read as
 *  twenty dots and not one. Hashed from the run id, so a dot does not jump
 *  between two renders. */
function jitter(id: string, axis: number) {
  let h = 2166136261 ^ axis;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295 - 0.5) * 0.03;
}

/** Where each answer went wrong. Horizontal: did retrieval do its job.
 *  Vertical: did the answer stay with what was retrieved. The two
 *  off-diagonal corners are the two causes that look identical from outside
 *  -- bad retrieval, bad generation -- and each needs a different fix. */
export function Quadrant({ points, line, onPick, selected }: {
  points: QualityPoint[]; line: number;
  onPick: (p: QualityPoint) => void;
  selected?: FailureType["key"] | "";
}) {
  const theme = useTheme();
  const W = 380, H = 300, L = 40, R = 10, T = 22, B = 40;
  const x = d3.scaleLinear().domain([0, 1]).range([L, W - R]);
  const y = d3.scaleLinear().domain([0, 1]).range([H - B, T]);
  const shown = points.filter((p) => p.retrieval !== null && p.faithfulness !== null);
  const muted = theme.palette.text.secondary;
  const zone = alpha(theme.palette.text.primary, 0.04);
  const label = (tx: number, ty: number, a: string, b?: string) => (
    <g>
      <text x={tx} y={ty} fontSize={11} fontWeight={600} fill={theme.palette.text.primary} fillOpacity={0.75}>{a}</text>
      {b && <text x={tx} y={ty + 12} fontSize={10} fill={muted}>{b}</text>}
    </g>
  );
  return (
    <Box>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Answers by retrieval quality and faithfulness" style={{ width: "100%", height: "auto", display: "block" }}>
        <rect x={L} y={T} width={x(line) - L} height={y(line) - T} fill={zone} />
        <rect x={x(line)} y={y(line)} width={W - R - x(line)} height={H - B - y(line)} fill={zone} />
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={theme.palette.divider} />
        <line x1={L} x2={L} y1={T} y2={H - B} stroke={theme.palette.divider} />
        <line x1={x(line)} x2={x(line)} y1={T} y2={H - B} stroke={theme.palette.divider} strokeDasharray="2 3" />
        <line x1={L} x2={W - R} y1={y(line)} y2={y(line)} stroke={theme.palette.divider} strokeDasharray="2 3" />
        {label(x(line) + 6, T - 8, "Healthy")}
        {label(x(line) + 6, y(line) + 14, "Invented claims", "answer strayed")}
        {label(L + 6, T + 12, "Weak sources, used faithfully", "likely incomplete")}
        {label(L + 6, H - B - 8, "Retrieval failure")}
        {shown.map((p) => {
          const colour = failureColour(theme, p.failure);
          const dim = selected && p.failure !== selected;
          return (
            <circle
              key={p.run_id}
              cx={x(Math.max(0, Math.min(1, p.retrieval! + jitter(p.run_id, 1))))}
              cy={y(Math.max(0, Math.min(1, p.faithfulness! + jitter(p.run_id, 2))))}
              r={p.failure ? 5 : 4}
              fill={colour}
              fillOpacity={dim ? 0.15 : 0.85}
              stroke={p.review ? theme.palette.text.primary : "none"}
              strokeWidth={1.5}
              tabIndex={0}
              role="button"
              style={{ cursor: "pointer", outline: "none" }}
              onClick={() => onPick(p)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(p); } }}
            >
              <title>{`${p.question}\nretrieval ${p.retrieval!.toFixed(2)} · faithfulness ${p.faithfulness!.toFixed(2)} · overall ${p.overall?.toFixed(2) ?? "—"}${p.review ? `\nreviewed: ${p.review}` : ""}`}</title>
            </circle>
          );
        })}
        <text x={(L + W - R) / 2} y={H - 18} textAnchor="middle" fontSize={10} fill={muted}>retrieval → (context relevance and precision)</text>
        <text x={L} y={H - 4} fontSize={10} fill={muted}>0</text>
        <text x={x(line)} y={H - 4} fontSize={10} fill={muted} textAnchor="middle">{line.toFixed(1)}</text>
        <text x={W - R} y={H - 4} fontSize={10} fill={muted} textAnchor="end">1</text>
        <text transform={`translate(12 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle" fontSize={10} fill={muted}>stuck to the sources (faithfulness) →</text>
      </svg>
      {shown.length < points.length && (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
          {points.length - shown.length} answer{points.length - shown.length === 1 ? "" : "s"} not drawn: a judge they need did not return.
        </Typography>
      )}
    </Box>
  );
}

/** Subjects -- groups of questions by meaning -- sized by how many questions
 *  and coloured by how well they were answered. A weak subject is a coloured
 *  area rather than a row somewhere in a table. */
export function SubjectBubbles({ subjects, onPick }: {
  subjects: QualitySubject[]; onPick: (s: QualitySubject) => void;
}) {
  const theme = useTheme();
  const W = 480, H = 300;
  const nodes = useMemo(() => {
    const root = d3.hierarchy<{ children?: QualitySubject[] } & Partial<QualitySubject>>(
      { children: subjects }).sum((d) => (d as QualitySubject).n ?? 0);
    return d3.pack<typeof root.data>().size([W, H]).padding(8)(root).leaves();
  }, [subjects]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Subjects by quality" style={{ width: "100%", height: "auto", display: "block" }}>
      {nodes.map((node) => {
        const s = node.data as QualitySubject;
        const colour = s.overall === null ? theme.palette.text.disabled : band(theme, s.overall);
        const r = node.r;
        // The label's terms on their own lines, as many as the circle holds,
        // rather than one line cut off after a word and a half.
        const size = Math.min(12, r / 3.2);
        const chars = Math.max(4, Math.floor((r * 1.7) / (size * 0.58)));
        const fit = (t: string) => (t.length > chars ? `${t.slice(0, chars - 1)}…` : t);
        const lines = s.label.split(" · ").slice(0, r > 44 ? 2 : 1).map(fit);
        return (
          <g key={s.id} transform={`translate(${node.x},${node.y})`} tabIndex={0} role="button"
             style={{ cursor: "pointer", outline: "none" }}
             onClick={() => onPick(s)}
             onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(s); } }}>
            <circle r={r} fill={colour} fillOpacity={0.2} stroke={colour} strokeWidth={1.5} />
            {r > 18 && (
              <>
                {lines.map((line, i) => (
                  <text key={i} textAnchor="middle" y={(i - lines.length / 2) * (size + 1) + size * 0.4}
                        fontSize={size} fontWeight={600} fill={theme.palette.text.primary}>{line}</text>
                ))}
                <text textAnchor="middle" y={(lines.length / 2) * (size + 1) + size * 0.55}
                      fontSize={Math.min(10.5, r / 3.6)} fill={theme.palette.text.secondary}>
                  {s.n} · {s.overall?.toFixed(2) ?? "—"}
                </text>
              </>
            )}
            <title>{`${s.label}\n${s.n} question${s.n === 1 ? "" : "s"} · answer quality ${s.overall?.toFixed(2) ?? "—"}\ne.g. “${s.example}”`}</title>
          </g>
        );
      })}
    </svg>
  );
}

/** The judge's faithfulness, cut into three verdicts, against a reviewer's.
 *  The diagonal is agreement; the far corners are the costly mistakes. */
export function AgreementMatrix({ matrix, buckets }: { matrix: number[][]; buckets: string[] }) {
  const theme = useTheme();
  const W = 330, H = 210, L = 64, T = 22, cw = (W - L) / 3, ch = (H - T) / 3;
  const max = Math.max(1, ...matrix.flat());
  const rowLabel = ["≥ 0.8", "0.5–0.8", "< 0.5"];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Judge and reviewer agreement" style={{ width: "100%", height: "auto", display: "block" }}>
      {buckets.map((b, j) => (
        <text key={b} x={L + cw * j + cw / 2} y={14} textAnchor="middle" fontSize={10} fill={theme.palette.text.secondary}>
          {j === 0 ? `reviewer: ${b}` : b === "not" ? "not grounded" : b}
        </text>
      ))}
      {matrix.map((row, i) => (
        <g key={i}>
          <text x={L - 8} y={T + ch * i + ch / 2 + 3} textAnchor="end" fontSize={10} fill={theme.palette.text.secondary}>{rowLabel[i]}</text>
          {row.map((n, j) => {
            const colour = i === j ? theme.palette.success.main
              : Math.abs(i - j) === 2 ? theme.palette.error.main : theme.palette.warning.main;
            return (
              <g key={j}>
                <rect x={L + cw * j + 1} y={T + ch * i + 1} width={cw - 2} height={ch - 2} rx={3}
                      fill={colour} fillOpacity={0.08 + (0.6 * n) / max} />
                <text x={L + cw * j + cw / 2} y={T + ch * i + ch / 2 + 4} textAnchor="middle" fontSize={13}
                      fontWeight={700} fill={theme.palette.text.primary}>{n}</text>
                <title>{`judge ${rowLabel[i]}, reviewer ${buckets[j]}: ${n}`}</title>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

/** Runs per day, stacked by tool, for the Admin usage dashboard.
 *
 *  Bars rather than lines: a day is a bucket, and an empty day should look
 *  empty rather than be interpolated across. Each tool keeps one colour from
 *  the theme everywhere it appears on the page, and every bar segment carries
 *  a <title> with the day, the tool and the count. */
export function DailyBars<K extends string>({ days, keys, colours, labels, height = 160 }: {
  days: ({ day: string } & Record<K, number>)[];
  keys: K[];
  colours: Record<K, string>;
  labels: Record<K, string>;
  height?: number;
}) {
  const theme = useTheme();
  const width = 720;
  const pad = { top: 10, right: 8, bottom: 22, left: 30 };
  const totals = days.map((d) => keys.reduce((n, k) => n + (d[k] || 0), 0));
  const max = Math.max(1, ...totals);
  const x = useMemo(() => d3.scaleBand<string>().domain(days.map((d) => d.day))
    .range([pad.left, width - pad.right]).paddingInner(0.2), [days]);
  const y = d3.scaleLinear().domain([0, max]).nice().range([height - pad.bottom, pad.top]);
  const ticks = y.ticks(Math.min(4, max));
  const every = Math.max(1, Math.ceil(days.length / 10));
  const label = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <Box component="svg" viewBox={`0 0 ${width} ${height}`} role="img"
         aria-label="Runs per day by tool" sx={{ width: "100%", height: "auto", display: "block" }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)}
                stroke={alpha(theme.palette.text.primary, 0.08)} />
          <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10}
                fill={theme.palette.text.secondary}>{t}</text>
        </g>
      ))}
      {days.map((d, i) => {
        let base = 0;
        return (
          <g key={d.day}>
            {keys.map((k) => {
              const n = d[k] || 0;
              if (!n) return null;
              const y0 = y(base), y1 = y(base + n);
              base += n;
              return (
                <rect key={k} x={x(d.day)} width={x.bandwidth()} y={y1} height={Math.max(0, y0 - y1)}
                      fill={colours[k]}>
                  <title>{`${label(d.day)} · ${labels[k]}: ${n} run${n === 1 ? "" : "s"}`}</title>
                </rect>
              );
            })}
            {totals[i] === 0 && (
              <rect x={x(d.day)} width={x.bandwidth()} y={y(0) - 1} height={1}
                    fill={alpha(theme.palette.text.primary, 0.15)}>
                <title>{`${label(d.day)}: no runs`}</title>
              </rect>
            )}
            {i % every === 0 && (
              <text x={(x(d.day) ?? 0) + x.bandwidth() / 2} y={height - 6} textAnchor="middle"
                    fontSize={10} fill={theme.palette.text.secondary}>{label(d.day)}</text>
            )}
          </g>
        );
      })}
    </Box>
  );
}
