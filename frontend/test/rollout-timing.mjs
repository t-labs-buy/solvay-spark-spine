/** The run duration in the Fit-Gap header is read from the investigation log:
 *  a "stage" note opens each pass and the quality-gates note follows the last.
 *  A run with no gates note -- still going, failed, or logged before the log
 *  was kept -- shows no duration rather than a wrong one.
 *
 *  Run: node test/rollout-timing.mjs
 */
import { readFileSync } from "node:fs";

const ts = (await import("typescript")).default;
const src = readFileSync(new URL("../src/components/rollout/timing.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { runTiming, elapsed, duration } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const at = (s) => new Date(Date.UTC(2026, 8, 25, 10, 27, 56) + s * 1000).toISOString();
// The shape of the India 4.10.2 run: 134s reading, 807s comparing.
const log = [
  { kind: "question", at: at(0) },
  { kind: "note", note: "stage", at: at(0.2) },
  { kind: "tool_call", at: at(2) },
  { kind: "note", note: "stage", at: at(134) },
  { kind: "tool_call", at: at(136) },
  { kind: "note", note: "gates", at: at(941) },
];

const t = runTiming(log);
check("a finished run is timed", t !== null);
check("total runs from the first entry to the gates", t?.total === 941, String(t?.total));
check("two passes, labelled", t?.passes.map((p) => p.label).join() === "reading,comparing");
check("each pass ends where the next begins", t?.passes.map((p) => p.seconds).join() === "133.8,807",
      t?.passes.map((p) => p.seconds).join());

check("a run without a gates note is not timed", runTiming(log.slice(0, -1)) === null);
check("a log without timestamps is not timed",
      runTiming(log.map(({ at: _, ...e }) => e)) === null);
check("an empty log is not timed", runTiming([]) === null);

check("elapsed between two timestamps", elapsed(at(0), at(941)) === 941);
check("elapsed with a missing end is null", elapsed(at(0), null) === null);

check("seconds", duration(42.4) === "42s", duration(42.4));
check("minutes and seconds", duration(941) === "15m 41s", duration(941));
check("hours and minutes", duration(3780) === "1h 3m", duration(3780));

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("all passed");
