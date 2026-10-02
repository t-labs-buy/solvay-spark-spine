/** Small pieces the four Quality views share. */
import {
  Alert, Box, Button, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ShieldQuestion } from "lucide-react";
import { useState, type ReactNode } from "react";

import { quality } from "../../api";

/** The workspace's one container. Square-cornered and flat, with a plain
 *  semibold title: the analytical-list look, where a panel is a frame for
 *  data rather than a card that draws attention to itself. */
export const RADIUS = "4px";

export const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** One figure in a header's KPI strip: a label, the number, a status word
 *  that carries the colour (so the colour is never the only signal), and a
 *  line of context. Laid out as peers in a wrapping row, ruled between. */
export function Kpi({ label, value, status, tone, sub }: {
  label: string; value: string; status: string; tone: "good" | "warn" | "muted"; sub: string;
}) {
  return (
    <Stack spacing={0.25} sx={{ flex: "1 1 0", minWidth: 150, py: 1.5, pr: 2, mr: 2, borderRight: 1, borderColor: "divider",
                                "&:last-of-type": { borderRight: 0, mr: 0 } }}>
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{label}</Typography>
      <Typography sx={{ fontFamily: MONO, fontSize: 24, fontWeight: 500, lineHeight: 1.25 }}>{value}</Typography>
      <Typography sx={{ fontSize: 12, fontWeight: 600,
                        color: tone === "good" ? "success.main" : tone === "warn" ? "warning.main" : "text.secondary" }}>
        {status}
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{sub}</Typography>
    </Stack>
  );
}

export function Panel({ title, hint, actions, children, pad = true }: {
  title: string; hint?: string; actions?: ReactNode; children: ReactNode; pad?: boolean;
}) {
  return (
    <Paper variant="outlined" sx={{ overflow: "hidden", minWidth: 0, display: "flex", flexDirection: "column", borderRadius: RADIUS }}>
      <Stack direction="row" spacing={1.25} useFlexGap sx={{
        alignItems: "center", flexWrap: "wrap", px: 2, py: 1, minHeight: 40,
        borderBottom: 1, borderColor: "divider",
      }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{title}</Typography>
        <Box sx={{ flex: 1 }} />
        {hint && <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{hint}</Typography>}
        {actions}
      </Stack>
      <Box sx={{ p: pad ? 2 : 0, flex: 1, minWidth: 0 }}>{children}</Box>
    </Paper>
  );
}

/** A quiet, explanatory empty state: what is missing and how to get it. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <Typography sx={{ fontSize: 13, color: "text.secondary", py: 2, lineHeight: 1.6 }}>
      {children}
    </Typography>
  );
}

/** Said under every view until the judge has been checked against people.
 *  Every number on these pages is a model's opinion; until enough answers
 *  have a person's verdict beside them, there is no evidence it is a good
 *  one, and the page should not let a reader forget that. */
export function TrustNote({ reviewed, needed }: { reviewed: number; needed: number }) {
  return (
    <Alert severity="info" variant="outlined" icon={<ShieldQuestion size={16} />}
           sx={{ py: 0, borderRadius: RADIUS, fontSize: 12.5, alignItems: "center", "& .MuiAlert-icon": { py: 0.75 } }}>
      Scores come from an automated judge not yet checked against people ({reviewed} of {needed} reviews).
      Treat them as indicative; add reviews under <b>Judge calibration</b>.
    </Alert>
  );
}

const VERDICT_LABEL = { grounded: "Grounded", partly: "Partly", not: "Not grounded" } as const;
type Verdict = keyof typeof VERDICT_LABEL;

/** A person's verdict on one answer. The only evidence there will ever be
 *  that the judge agrees with people, so it is one click, not a form. */
export function ReviewBar({ runId, current, onSaved }: {
  runId: string;
  current?: { verdict: Verdict; note: string } | null;
  onSaved?: (verdict: Verdict) => void;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(current?.verdict ?? null);
  const [note, setNote] = useState(current?.note ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");

  const save = async (v: Verdict) => {
    setVerdict(v);
    setState("saving");
    try {
      await quality.review(runId, v, note);
      setState("saved");
      onSaved?.(v);
    } catch (e) {
      setState((e as Error).message || "Could not save the review.");
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.75, display: "grid", gap: 1.25 }}>
      <Typography variant="overline" sx={{ color: "text.secondary", lineHeight: 1.2 }}>
        Your verdict
      </Typography>
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
        Reading the answer against its excerpts: is every claim backed by them?
      </Typography>
      <ToggleButtonGroup
        exclusive size="small" value={verdict}
        onChange={(_e, v: Verdict | null) => v && save(v)}
        aria-label="Is this answer grounded?"
      >
        {(Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => (
          <ToggleButton key={v} value={v} sx={{ textTransform: "none", px: 1.5 }}>
            {VERDICT_LABEL[v]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <TextField
        id={`review-note-${runId}`}
        size="small" placeholder="What is wrong with it (optional)" value={note}
        onChange={(e) => setNote(e.target.value)} multiline minRows={1} maxRows={4}
      />
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Button size="small" variant="text" disabled={!verdict || state === "saving"}
                onClick={() => verdict && save(verdict)} sx={{ textTransform: "none" }}>
          Save note
        </Button>
        <Typography sx={{ fontSize: 12, color: state === "saved" ? "success.main" : state === "idle" || state === "saving" ? "text.secondary" : "error.main" }}>
          {state === "saved" ? "Saved — the judge's agreement figure now includes it."
            : state === "saving" ? "Saving…" : state === "idle" ? "" : state}
        </Typography>
      </Stack>
    </Paper>
  );
}
