/** The Admin area: who has an account, what they have been doing, and the
 *  log of it. Laid out like the Quality workspace -- a header with a KPI strip,
 *  sub-tabs, a filter bar, then tables -- so it reads as the same product.
 *
 *    Runs      one account's run history across every tool, each run
 *              opening in its own page
 *    Users     create accounts, change a role, reset a password, deactivate
 *    Usage     runs, failures, time and tokens per account and per tool
 *    Activity  sign-ins, runs, reviews and account changes, newest first
 *
 *  Only an Admin reaches this page's data; the server refuses anyone else,
 *  and the tab is not shown to them. LLM cost is not here -- it is in
 *  Langfuse, per trace, filed under each username. */
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, MenuItem, Paper, Select, Stack, Switch, Tab, Table, TableBody, TableCell,
  TableHead, TableRow, Tabs, TextField, Tooltip, Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { ExternalLink, KeyRound, RefreshCw, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  admin, type ActivityEvent, type AdminRun, type AdminUser, type UsageReport, type UsageTool,
} from "../api";
import type { Account } from "../auth";
import { DailyBars } from "../components/quality/charts";
import { Empty, Kpi, MONO, Panel, RADIUS } from "../components/quality/parts";
import { when } from "../components/RunHistoryDrawer";

type View = "users" | "usage" | "runs" | "activity";
const VIEWS: { value: View; label: string }[] = [
  { value: "usage", label: "Usage" },
  { value: "runs", label: "Run history" },
  { value: "users", label: "Users" },
  { value: "activity", label: "Activity" },
];

const TOOL_LABEL: Record<UsageTool, string> = {
  ask: "Ask RAG", evidence: "Agent", fitgap: "InsightLens", rollout: "Fit-Gap Copilot",
};
const TOOLS: UsageTool[] = ["ask", "evidence", "fitgap", "rollout"];

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
          <Kpi label="Sign-ins" value={t ? num(t.logins) : "–"} tone={t && t.failed_logins ? "warn" : "muted"}
               status={t ? `${num(t.failed_logins)} failed` : ""} sub="failed includes unknown usernames" />
          <Kpi label="Tokens" value={t ? tokens(tokenTotal) : "–"} tone="muted"
               status={t ? `${tokens(t.input_tokens)} in · ${tokens(t.output_tokens)} out` : ""}
               sub={t ? `${hours(t.seconds)} of run time` : ""} />
        </Stack>
        <Tabs value={view} onChange={(_, v) => choose(v)} sx={{ minHeight: 40, mt: 0.5,
          "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontSize: 13.5 } }}>
          {VIEWS.map((v) => <Tab key={v.value} value={v.value} label={v.label} />)}
        </Tabs>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}

      {view !== "users" && (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          {view === "usage" && (
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
                  <TableCell align="right">Sign-ins</TableCell>
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
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>
                      {u.logins}{u.failed_logins ? <Box component="span" sx={{ color: "warning.main" }}> +{u.failed_logins} failed</Box> : null}
                    </TableCell>
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
        Runs made before accounts existed are counted under <b>legacy</b>. LLM cost per run is in
        Langfuse, where each trace carries the username.
      </Typography>
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
                     helperText="At least 8 characters. They can change it from the account menu." />
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
            This signs {user?.username} out everywhere. Give them the new password yourself.
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
