/** The Fit-Gap tabs drawn inside the shared outlined panel are listed in
 *  PANEL_TABS, and the panel renders only for those. The Evaluation tab was
 *  added inside the panel and left out of the list, and was blank for every
 *  run. This checks the list against what the panel actually draws.
 *
 *  Run: node test/rollout-tabs.mjs
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/pages/RolloutPage.tsx", import.meta.url), "utf8");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const m = src.match(/const PANEL_TABS = \[([^\]]*)\]/);
check("RolloutPage declares PANEL_TABS", !!m);
const listed = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];

// The panel: from the line that opens it to the first line closing at its indent.
const lines = src.split("\n");
const start = lines.findIndex((l) => l.includes("{PANEL_TABS.includes(tab) && ("));
check("the panel is gated on PANEL_TABS", start >= 0);
const indent = start >= 0 ? lines[start].match(/^ */)[0] : "";
const end = lines.findIndex((l, i) => i > start && l.startsWith(indent + ")}"));
const inside = lines.slice(start + 1, end).join("\n");
const drawn = [...new Set([...inside.matchAll(/\{tab === "([a-z_]+)"/g)].map((x) => x[1]))];

check("the panel draws some tabs", drawn.length > 0);
for (const t of drawn) check(`"${t}" is drawn in the panel and listed`, listed.includes(t));
for (const t of listed) check(`"${t}" is listed and drawn in the panel`, drawn.includes(t));
check("the Evaluation tab is drawn", drawn.includes("evaluation") && listed.includes("evaluation"));

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("all passed");
