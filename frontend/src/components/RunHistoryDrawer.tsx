import {
  Alert, Box, Button, Chip, CircularProgress, Divider, Drawer, IconButton, Stack,
  TextField, Tooltip, Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { ArrowLeft, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { clearAdornment } from "./ClearAdornment";

/** The history panel the Evidence Agent, the Fit-Gap Copilot and InsightLens
 *  all open from their header.
 *
 *  It is one component because it used to be three <Menu>s, written out
 *  separately, that had drifted into three different answers to the same
 *  question -- one showed relative time, two showed a sliced ISO string; one
 *  armed its delete against a stray click, one deleted on the first press, one
 *  had no delete at all; none of them could be filtered. That is the same
 *  class of bug as the page list in App.tsx: nothing errors, the three panels
 *  just quietly stop being the same feature.
 *
 *  Selecting a run opens it HERE, in the detail pane, rather than loading it
 *  into the page behind. Those pages each replace ten to eighteen pieces of
 *  state when they load a run, so looking at an old one used to cost you the
 *  one you were reading. "Load into page" is still there for when that is what
 *  you actually want -- it is just no longer the only way to look.
 *
 *  The chrome (width, backdrop blur, card and hover treatment, the filter box)
 *  is AskHistoryDrawer's, so the four history panels in the app read as one
 *  feature. What each module knows about its own runs -- which badges a run
 *  carries, what its detail looks like -- stays in that module, passed in.
 */

export interface HistoryCard {
  id: string;
  /** The question, or the scope the run was pointed at. */
  title: string;
  /** One line under it: the answer's opening, or the analysis headline. */
  subtitle?: string;
  /** A state icon, shown left of the title. */
  lead?: ReactNode;
  /** Status, holdout, mode — whatever this module marks a run with. */
  badges?: ReactNode;
  /** "8 calls · 3 claims · 12.4s" */
  meta?: string;
  startedAt: string | null;
}

export interface RunHistoryDrawerProps<D> {
  open: boolean;
  onClose: () => void;
  icon: ReactNode;
  /** "Past investigations" */
  title: string;
  /** ["investigation", "investigations"] */
  noun: [string, string];
  items: HistoryCard[];
  loading?: boolean;
  /** The run currently loaded into the page, marked in the list. */
  currentId?: string | null;
  /** Left out by a module with no delete endpoint — InsightLens has none. */
  onDelete?: (id: string) => void | Promise<void>;
  /** Require two presses, for a record other people may have written against. */
  armDelete?: boolean;
  deleteLabel?: string;
  fetchDetail: (id: string) => Promise<D>;
  renderDetail: (detail: D) => ReactNode;
  /** Extra buttons beside "Load into page" — exports, usually. */
  detailActions?: (detail: D) => ReactNode;
  onLoadIntoPage: (id: string) => void;
  loadDisabled?: boolean;
  /** True for a card that skips the detail pane and goes straight onto the
   *  page -- a run still in progress, whose register the pane cannot show
   *  yet but the page can follow live. */
  opensInPage?: (id: string) => boolean;
  filterPlaceholder: string;
  /** Shown when there is nothing to list at all. */
  emptyText: string;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "4 minutes ago", "yesterday", "12 Sep". A history panel is read to find one
 *  run among many, and an ISO timestamp is the one format that helps with
 *  neither. Two of the three menus this replaces showed a sliced ISO string. */
export function when(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return plural(mins, "minute", "minutes") + " ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return plural(hours, "hour", "hours") + " ago";
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function RunHistoryDrawer<D>({
  open, onClose, icon, title, noun, items, loading, currentId,
  onDelete, armDelete, deleteLabel = "Delete this run",
  fetchDetail, renderDetail, detailActions, onLoadIntoPage, loadDisabled, opensInPage,
  filterPlaceholder, emptyText,
}: RunHistoryDrawerProps<D>) {
  const theme = useTheme();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<D | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  // Closing the panel puts it back on the list. Reopening it onto a detail
  // pane for a run you looked at yesterday is a small thing that feels broken.
  useEffect(() => {
    if (!open) {
      setOpenId(null);
      setDetail(null);
      setDetailError(null);
      setArmed(null);
    }
  }, [open]);

  const show = useCallback(
    (id: string) => {
      setOpenId(id);
      setDetail(null);
      setDetailError(null);
      setDetailBusy(true);
      fetchDetail(id)
        .then((d) => setDetail(d))
        .catch((e) => setDetailError(e instanceof Error ? e.message : String(e)))
        .finally(() => setDetailBusy(false));
    },
    [fetchDetail],
  );

  const pick = (id: string) => {
    if (!loadDisabled && opensInPage?.(id)) {
      onLoadIntoPage(id);
      onClose();
    } else {
      show(id);
    }
  };

  // The three list endpoints take no query, so this filters what is already
  // here rather than asking the server, which is also why it needs no debounce.
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? items.filter((i) => `${i.title} ${i.subtitle ?? ""} ${i.meta ?? ""}`.toLowerCase().includes(needle))
    : items;

  const remove = async (id: string) => {
    if (!onDelete) return;
    if (armDelete && armed !== id) {
      setArmed(id);
      window.setTimeout(() => setArmed((a) => (a === id ? null : a)), 4000);
      return;
    }
    setArmed(null);
    if (openId === id) { setOpenId(null); setDetail(null); }
    await onDelete(id);
  };

  const onList = openId === null;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        backdrop: { sx: { backdropFilter: "blur(4px)", bgcolor: "rgba(0, 0, 0, 0.35)" } },
        paper: {
          sx: {
            width: { xs: "100%", sm: 480, md: 560 },
            display: "flex",
            flexDirection: "column",
            bgcolor: "background.paper",
            backgroundImage: "none",
            boxShadow: theme.palette.mode === "dark"
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
          bgcolor: (t) => t.palette.mode === "dark"
            ? alpha(t.palette.background.default, 0.7)
            : alpha(t.palette.background.paper, 0.95),
          backdropFilter: "blur(12px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: onList ? 1.5 : 0 }}>
          {onList ? (
            <Box
              sx={{
                width: 34, height: 34, borderRadius: 2, flexShrink: 0,
                bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
                color: "primary.main",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {icon}
            </Box>
          ) : (
            <Tooltip title={`Back to all ${noun[1]}`}>
              <IconButton size="small" onClick={() => setOpenId(null)} aria-label={`Back to all ${noun[1]}`}>
                <ArrowLeft size={17} />
              </IconButton>
            </Tooltip>
          )}
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
              {onList ? title : (items.find((i) => i.id === openId)?.title ?? title)}
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {onList
                ? (loading && !items.length
                    ? "Loading…"
                    : items.length
                      ? `${plural(items.length, noun[0], noun[1])}${
                          needle && shown.length !== items.length ? ` · ${shown.length} shown` : ""}`
                      : emptyText)
                : when(items.find((i) => i.id === openId)?.startedAt ?? null)}
            </Typography>
          </Box>
          {loading && items.length > 0 && <CircularProgress size={14} />}
          <IconButton size="small" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            <X size={16} />
          </IconButton>
        </Stack>

        {onList && items.length > 0 && (
          <TextField
            fullWidth
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={filterPlaceholder}
            slotProps={{
              input: {
                endAdornment: clearAdornment(search, () => setSearch(""), { label: "Clear filter" }),
                sx: { fontSize: 13, borderRadius: 1.75 },
              },
            }}
          />
        )}
      </Box>

      {/* ---------- list ---------- */}
      {onList && (
        <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
          {!items.length && !loading && (
            <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 13 }}>
              {emptyText}
            </Typography>
          )}
          {!!items.length && !shown.length && (
            <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 13 }}>
              Nothing here matches that text.
            </Typography>
          )}

          <Stack spacing={1.25}>
            {shown.map((r) => (
              <Box
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => pick(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(r.id);
                  }
                }}
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  border: 1,
                  borderColor: r.id === currentId ? (t) => alpha(t.palette.primary.main, 0.5) : "divider",
                  bgcolor: r.id === currentId ? (t) => alpha(t.palette.primary.main, 0.06) : "transparent",
                  cursor: "pointer",
                  transition: "border-color .15s ease, background-color .15s ease",
                  "&:hover, &:focus-visible": {
                    borderColor: (t) => alpha(t.palette.primary.main, 0.5),
                    bgcolor: (t) => alpha(t.palette.primary.main, 0.05),
                  },
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  {r.lead && <Box sx={{ pt: 0.15, flex: "none", display: "flex" }}>{r.lead}</Box>}
                  <Typography sx={{ flex: 1, fontSize: 13.5, fontWeight: 650, lineHeight: 1.45 }}>
                    {r.title}
                  </Typography>
                  {onDelete && (
                    <Tooltip title={armed === r.id ? "Press again to delete" : deleteLabel}>
                      <IconButton
                        size="small"
                        aria-label={armed === r.id ? "Confirm delete" : deleteLabel}
                        onClick={(e) => { e.stopPropagation(); void remove(r.id); }}
                        sx={{
                          mt: -0.25,
                          color: armed === r.id ? "error.main" : "text.disabled",
                          "&:hover": { color: "error.main" },
                        }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>

                {r.subtitle && (
                  <Typography
                    variant="body2"
                    sx={{
                      mt: 0.75, fontSize: 12, lineHeight: 1.5, color: "text.secondary",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {r.subtitle}
                  </Typography>
                )}

                <Stack
                  direction="row"
                  spacing={0.75}
                  useFlexGap
                  sx={{ alignItems: "center", flexWrap: "wrap", mt: 1 }}
                >
                  {r.id === currentId && (
                    <Chip size="small" color="primary" variant="outlined" label="on the page"
                          sx={{ height: 18, fontSize: 9.5, fontWeight: 700, borderRadius: 1 }} />
                  )}
                  {r.badges}
                  <Typography variant="caption" sx={{ fontSize: 11, color: "text.disabled" }}>
                    {when(r.startedAt)}
                  </Typography>
                  {r.meta && (
                    <Typography variant="caption" sx={{ fontSize: 11, color: "text.secondary" }}>
                      · {r.meta}
                    </Typography>
                  )}
                </Stack>
              </Box>
            ))}
          </Stack>
        </Box>
      )}

      {/* ---------- one run ---------- */}
      {!onList && (
        <>
          <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
            {detailBusy && (
              <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", color: "text.secondary" }}>
                <CircularProgress size={15} />
                <Typography sx={{ fontSize: 13 }}>Opening…</Typography>
              </Stack>
            )}
            {detailError && (
              <Alert severity="warning" sx={{ borderRadius: 2 }}>{detailError}</Alert>
            )}
            {detail && renderDetail(detail)}
          </Box>

          {/* Opaque, not a wash: the claim text underneath was reading through
              it and the bar stopped looking like a bar. */}
          <Divider />
          <Stack
            direction="row"
            spacing={1}
            sx={{
              p: 1.5, alignItems: "center", flexWrap: "wrap", gap: 1,
              bgcolor: "background.default",
            }}
          >
            {detail && detailActions?.(detail)}
            <Box sx={{ flex: 1 }} />
            <Tooltip title={loadDisabled
              ? "Wait for the run in progress to finish"
              : "Put this run back on the page, where every panel and drawer can read it"}>
              <span>
                <Button
                  size="small"
                  variant="contained"
                  disabled={loadDisabled || !detail}
                  onClick={() => { if (openId) { onLoadIntoPage(openId); onClose(); } }}
                  sx={{ fontSize: 12.5 }}
                >
                  Load into page
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </>
      )}
    </Drawer>
  );
}
