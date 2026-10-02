import {
  Alert, Box, Button, Chip, CircularProgress, Drawer, IconButton, Stack, TextField,
  Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { History, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { askHistory, type AskRunSummary, type QualityFilter } from "../api";
import { ownerLabel } from "../auth";
import useHistoryScope from "../useHistoryScope";
import { clearAdornment } from "./ClearAdornment";
// The same relative time the other three history panels show. It was
// written out here and again in EvidencePage; the two had not drifted yet.
import { when } from "./RunHistoryDrawer";

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const STATUS_COLOR: Record<AskRunSummary["status"], "default" | "success" | "warning" | "error"> = {
  done: "success",
  running: "default",
  abandoned: "warning",
  failed: "error",
};

/** The quality segments, and what each one is for. These are the questions the
 *  scores exist to make answerable -- "show me the hallucinations", "show me
 *  anything unsafe" -- so they belong beside the history rather than only in
 *  Langfuse. The values match ask_store.QUALITY_FILTERS. */
const SEGMENTS: { key: QualityFilter; label: string; hint: string }[] = [
  { key: "", label: "All", hint: "Every question, scored or not" },
  { key: "low", label: "Low quality", hint: "Overall score below the line" },
  { key: "unfaithful", label: "Unfaithful", hint: "Claims the excerpts do not support" },
  { key: "unsafe", label: "Unsafe", hint: "A safety judge flagged the answer" },
  { key: "unscored", label: "Unscored", hint: "Never judged, or judging did not finish" },
];

/** The overall score on a history row, or nothing at all.
 *
 *  Deliberately silent for a question nobody judged: an empty badge would read
 *  as a score of zero, and "not scored" is not a verdict. A flagged answer
 *  says so in words rather than as a number, because the number in that case
 *  is a cap rather than a measurement. */
function QualityBadge({ run }: { run: AskRunSummary }) {
  const theme = useTheme();
  if (run.eval_status === "running") {
    return (
      <Typography variant="caption" sx={{ fontSize: 11, color: "text.disabled" }}>
        · scoring…
      </Typography>
    );
  }
  if (run.eval_status !== "done" || run.overall === null || run.overall === undefined) return null;
  const flagged = (run.safety ?? 1) < 1;
  const colour = flagged || run.overall < 0.4
    ? theme.palette.error.main
    : run.overall < 0.7 ? theme.palette.warning.main : theme.palette.success.main;
  return (
    <Tooltip title={flagged
      ? "A safety judge flagged this answer, so its overall score is capped."
      : "Overall quality, weighted across the judges."}>
      <Box sx={{
        px: 0.6, py: 0.1, borderRadius: 0.75, cursor: "help",
        bgcolor: alpha(colour, 0.14), color: colour,
        fontSize: 10.5, fontWeight: 800, fontVariantNumeric: "tabular-nums",
      }}>
        {flagged ? "flagged" : run.overall.toFixed(2)}
      </Box>
    </Tooltip>
  );
}

export default function AskHistoryDrawer({
  open,
  onClose,
  onOpenRun,
  onAskAgain,
  reloadKey,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  /** Reopen a past question: its answer and its excerpts, as they were. */
  onOpenRun: (id: string) => void;
  /** Put the question back in the box so it can be asked against today's corpus. */
  onAskAgain: (question: string) => void;
  /** Bumped when a question finishes, so the panel is not stale when reopened. */
  reloadKey: number;
  busy: boolean;
}) {
  const theme = useTheme();
  const [runs, setRuns] = useState<AskRunSummary[]>([]);
  const [retention, setRetention] = useState(0);
  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState<QualityFilter>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useHistoryScope();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    // Debounced, so typing in the filter does not fire a query per keystroke.
    const t = setTimeout(() => {
      askHistory
        .runs(50, search, quality)
        .then((r) => {
          if (cancelled) return;
          setRuns(r.runs);
          setRetention(r.retention);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, search ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, search, quality, reloadKey, scope]);

  const remove = async (id: string) => {
    setRuns((rs) => rs.filter((r) => r.id !== id));
    try {
      await askHistory.deleteRun(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        backdrop: { sx: { backdropFilter: "blur(4px)", bgcolor: "rgba(0, 0, 0, 0.35)" } },
        paper: {
          sx: {
            width: { xs: "100%", sm: 480, md: 540 },
            display: "flex",
            flexDirection: "column",
            bgcolor: "background.paper",
            backgroundImage: "none",
            boxShadow:
              theme.palette.mode === "dark"
                ? "-8px 0 32px rgba(0, 0, 0, 0.7)"
                : "-8px 0 32px rgba(0, 0, 0, 0.12)",
          },
        },
      }}
    >
      {/* ---------- header ---------- */}
      <Box
        sx={{
          p: 2,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: (t) =>
            t.palette.mode === "dark"
              ? alpha(t.palette.background.default, 0.7)
              : alpha(t.palette.background.paper, 0.95),
          backdropFilter: "blur(12px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5 }}>
          <Box
            sx={{
              width: 34,
              height: 34,
              borderRadius: 2,
              bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
              color: "primary.main",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <History size={18} />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
              Previous questions
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {loading && !runs.length
                ? "Loading…"
                : runs.length
                  ? `${plural(runs.length, "question")}${retention ? ` · newest ${retention} kept` : ""}`
                  : "Nothing asked yet"}
            </Typography>
          </Box>
          {loading && runs.length > 0 && <CircularProgress size={14} />}
          <IconButton size="small" onClick={onClose} aria-label="Close history">
            <X size={16} />
          </IconButton>
        </Stack>

        <TextField
          fullWidth
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by question text…"
          slotProps={{
            input: {
              endAdornment: clearAdornment(search, () => setSearch(""), { label: "Clear filter" }),
              sx: { fontSize: 13, borderRadius: 1.75 },
            },
          }}
        />

        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mt: 1.25 }}>
          {SEGMENTS.map((seg) => (
            <Tooltip key={seg.key || "all"} title={seg.hint}>
              <Chip
                size="small"
                label={seg.label}
                variant={quality === seg.key ? "filled" : "outlined"}
                color={quality === seg.key && seg.key ? "primary" : "default"}
                onClick={() => setQuality(seg.key)}
                sx={{ height: 24, fontSize: 11, fontWeight: 600, borderRadius: 1 }}
              />
            </Tooltip>
          ))}
        </Stack>
      </Box>

      {/* ---------- list ---------- */}
      <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
        {error && (
          <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
            {error}
          </Alert>
        )}

        {!loading && !runs.length && !error && (
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 13 }}>
            {search
              ? "No past question matches that text."
              : "Questions are recorded as they are asked. Ask one and it will appear here."}
          </Typography>
        )}

        <Stack spacing={1.25}>
          {runs.map((r) => (
            <Box
              key={r.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenRun(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenRun(r.id);
                }
              }}
              sx={{
                p: 1.5,
                borderRadius: 2,
                border: 1,
                borderColor: "divider",
                cursor: "pointer",
                transition: "border-color .15s ease, background-color .15s ease",
                "&:hover, &:focus-visible": {
                  borderColor: (t) => alpha(t.palette.primary.main, 0.5),
                  bgcolor: (t) => alpha(t.palette.primary.main, 0.05),
                },
              }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                <Typography sx={{ flex: 1, fontSize: 13.5, fontWeight: 650, lineHeight: 1.45 }}>
                  {r.question}
                </Typography>
                <Tooltip title="Delete this question">
                  <IconButton
                    size="small"
                    aria-label="Delete this question"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(r.id);
                    }}
                    sx={{ mt: -0.25, color: "text.disabled", "&:hover": { color: "error.main" } }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </Tooltip>
              </Stack>

              {r.summary && (
                <Typography
                  variant="body2"
                  sx={{
                    mt: 0.75,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: "text.secondary",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {r.summary.replace(/^#+\s*/gm, "").replace(/\*\*/g, "")}
                </Typography>
              )}

              {r.error && (
                <Typography variant="caption" sx={{ color: "error.main", fontSize: 11 }}>
                  {r.error}
                </Typography>
              )}

              <Stack
                direction="row"
                spacing={0.75}
                useFlexGap
                sx={{ alignItems: "center", flexWrap: "wrap", mt: 1 }}
              >
                {r.status !== "done" && (
                  <Chip
                    size="small"
                    color={STATUS_COLOR[r.status]}
                    label={r.status}
                    sx={{ height: 18, fontSize: 10, fontWeight: 700, borderRadius: 1 }}
                  />
                )}
                <Typography variant="caption" sx={{ fontSize: 11, color: "text.disabled" }}>
                  {when(r.started_at)}
                </Typography>
                <Typography variant="caption" sx={{ fontSize: 11, color: "text.secondary" }}>
                  {ownerLabel(r.owner) ? `· ${ownerLabel(r.owner)} ` : ""}
                  · {r.mode} · {plural(r.sources, "excerpt")}
                  {r.seconds ? ` · ${r.seconds}s` : ""}
                </Typography>
                <QualityBadge run={r} />
                <Box sx={{ flex: 1 }} />
                <Button
                  size="small"
                  variant="text"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAskAgain(r.question);
                  }}
                  sx={{ fontSize: 11, fontWeight: 650, textTransform: "none", minWidth: 0, px: 0.75 }}
                >
                  Ask again
                </Button>
              </Stack>
            </Box>
          ))}
        </Stack>
      </Box>
    </Drawer>
  );
}
