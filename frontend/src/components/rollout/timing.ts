/** How long a Fit-Gap run took, read from its investigation log. Every log
 *  entry is timestamped and the log is kept with the run, so a run being
 *  watched and a run reopened from history are timed the same way. The
 *  passes are bounded by the log's own markers: a "stage" note opens each
 *  pass, and the quality-gates note follows the last one. */

export type RunTiming = {
  /** Seconds from the first log entry to the quality gates. */
  total: number;
  passes: { label: string; seconds: number }[];
};

type Entry = { at?: string; kind?: string; note?: string };

const PASS_LABELS = ["reading", "comparing"];

export function runTiming(log: Entry[]): RunTiming | null {
  const t = (e?: Entry) => (e?.at ? Date.parse(e.at) : NaN);
  const start = t(log[0]);
  const marks = log.filter((e) => e.kind === "note" && e.note === "stage").map(t);
  const end = t(log.find((e) => e.kind === "note" && e.note === "gates"));
  // A run still going, failed or recorded before the log was kept has no end.
  if (!Number.isFinite(start) || !Number.isFinite(end) || marks.some((m) => !Number.isFinite(m))) {
    return null;
  }
  const bounds = [...marks, end];
  return {
    total: (end - start) / 1000,
    passes: marks.map((m, i) => ({
      label: PASS_LABELS[i] ?? `pass ${i + 1}`,
      seconds: (bounds[i + 1] - m) / 1000,
    })),
  };
}

/** Seconds between two ISO timestamps, or null if either is missing. */
export function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** 42s · 15m 41s · 1h 3m */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}
