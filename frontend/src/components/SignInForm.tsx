/** A static sign-in screen, shared by Demo Mode (/demo/login) and the
 *  application (/login). Each passes where to post and where it may go next.
 *
 *  The credentials are checked by the server, never here, so the password is
 *  not in any bundle. On success the server sets an HttpOnly session cookie
 *  and the page goes on to where the reader was heading.
 *
 *  An account whose password an Admin chose (a new account, a reset) is then
 *  asked for a password of its own before going anywhere; the server refuses
 *  everything else until it has one. The same step shows when such an account
 *  comes back to this page already signed in -- after a reload, say -- and
 *  then asks for the current password too, since the page no longer has it. */
import {
  Alert, Box, Button, IconButton, InputAdornment, Paper, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import { motion } from "framer-motion";
import { Eye, EyeOff, KeyRound, LogIn, Moon, Sun } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { changePassword, signOut } from "../auth";
import type { Mode } from "../theme";
import BrandLogo from "./BrandLogo";

export default function SignInForm({ mode, onToggleMode, endpoint, subtitle, nextTarget, idPrefix }: {
  mode: Mode;
  onToggleMode: () => void;
  /** Where the credentials are posted. */
  endpoint: string;
  subtitle: string;
  /** Where to go on success. Must only ever return a path on this site. */
  nextTarget: () => string;
  idPrefix: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set when the account must choose its own password before going on. The
  // current password is known if it was typed into this page a moment ago.
  const [mustChange, setMustChange] = useState<{ username: string; known: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (d?.must_change_password) setMustChange({ username: d.username, known: false }); })
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Enter a username and a password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `Sign-in failed (${res.status}).`);
      if (body.must_change_password) {
        setMustChange({ username: body.username ?? username, known: true });
        setBusy(false);
        return;
      }
      location.replace(nextTarget());
    } catch (err) {
      setError((err as Error).message || "Sign-in failed.");
      setBusy(false);
    }
  };

  if (mustChange) {
    return (
      <Frame mode={mode} onToggleMode={onToggleMode}>
        <ChangePasswordStep
          username={mustChange.username} current={mustChange.known ? password : null}
          idPrefix={idPrefix} onDone={() => location.replace(nextTarget())}
          onSignOut={() => void signOut(location.pathname + location.search)} />
      </Frame>
    );
  }

  return (
    <Frame mode={mode} onToggleMode={onToggleMode}>
      <Paper
        component={motion.form}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        onSubmit={submit}
        variant="outlined"
        sx={{ width: "100%", maxWidth: 400, p: { xs: 3, sm: 4 }, borderRadius: 3 }}
      >
        <Stack spacing={3}>
          <Heading subtitle={subtitle} />

          {error && <Alert severity="error" variant="outlined">{error}</Alert>}

          <Stack spacing={2}>
            <TextField
              id={`${idPrefix}-username`} label="Username" value={username} autoFocus fullWidth
              autoComplete="username" onChange={(e) => setUsername(e.target.value)}
            />
            <PasswordField
              id={`${idPrefix}-password`} label="Password" value={password} show={show}
              onToggleShow={() => setShow(!show)} autoComplete="current-password"
              onChange={setPassword}
            />
          </Stack>

          <Button
            type="submit" variant="contained" size="large" disabled={busy}
            startIcon={<LogIn size={18} />} sx={{ textTransform: "none", fontWeight: 600 }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </Stack>
      </Paper>
    </Frame>
  );
}

/** The page around either step: centred, with the theme switch. */
function Frame({ mode, onToggleMode, children }: { mode: Mode; onToggleMode: () => void; children: ReactNode }) {
  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", bgcolor: "background.default", px: 2, position: "relative" }}>
      <Tooltip title={`Switch to ${mode === "dark" ? "light" : "dark"} theme`}>
        <IconButton onClick={onToggleMode} aria-label="Switch theme" sx={{ position: "absolute", top: 12, right: 12 }}>
          {mode === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
      </Tooltip>
      {children}
    </Box>
  );
}

function Heading({ subtitle }: { subtitle: string }) {
  return (
    <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
      <BrandLogo size={56} />
      <Box>
        <Typography sx={{ fontWeight: 700, fontSize: 22, letterSpacing: "-.01em" }}>
          Spark AI{" "}
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}>Spine</Box>
        </Typography>
        <Typography sx={{ fontSize: 13.5, color: "text.secondary", mt: 0.5 }}>
          {subtitle}
        </Typography>
      </Box>
    </Stack>
  );
}

function PasswordField({ id, label, value, show, onToggleShow, onChange, autoComplete, autoFocus, helperText }: {
  id: string; label: string; value: string; show: boolean; onToggleShow: () => void;
  onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean; helperText?: string;
}) {
  return (
    <TextField
      id={id} label={label} value={value} fullWidth autoFocus={autoFocus} helperText={helperText}
      type={show ? "text" : "password"} autoComplete={autoComplete}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                onClick={onToggleShow} edge="end" size="small"
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

/** Choose a password of one's own, replacing the one an Admin handed over.
 *  `current` is that password if it was just typed in; null asks for it. */
function ChangePasswordStep({ username, current, idPrefix, onDone, onSignOut }: {
  username: string; current: string | null; idPrefix: string;
  onDone: () => void; onSignOut: () => void;
}) {
  const [old, setOld] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) { setError("The new passwords differ."); return; }
    setBusy(true);
    setError("");
    const why = await changePassword(current ?? old, next);
    if (why) { setError(why); setBusy(false); return; }
    onDone();
  };

  return (
    <Paper
      component={motion.form}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      onSubmit={submit}
      variant="outlined"
      sx={{ width: "100%", maxWidth: 400, p: { xs: 3, sm: 4 }, borderRadius: 3 }}
    >
      <Stack spacing={3}>
        <Heading subtitle="Choose your own password" />

        <Alert severity="info" variant="outlined">
          You signed in with a temporary password. For your security, create a new
          password to continue.
        </Alert>

        {error && <Alert severity="error" variant="outlined">{error}</Alert>}

        {/* For the browser's password manager: which account this is. */}
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />

        <Stack spacing={2}>
          {current === null && (
            <PasswordField
              id={`${idPrefix}-current`} label="Current password" value={old} show={show}
              onToggleShow={() => setShow(!show)} onChange={setOld}
              autoComplete="current-password" autoFocus
            />
          )}
          <PasswordField
            id={`${idPrefix}-new`} label="New password" value={next} show={show}
            onToggleShow={() => setShow(!show)} onChange={setNext}
            autoComplete="new-password" autoFocus={current !== null} helperText="At least 8 characters"
          />
          <PasswordField
            id={`${idPrefix}-again`} label="New password again" value={again} show={show}
            onToggleShow={() => setShow(!show)} onChange={setAgain} autoComplete="new-password"
          />
        </Stack>

        <Stack spacing={1}>
          <Button
            type="submit" variant="contained" size="large"
            disabled={busy || !next || !again || (current === null && !old)}
            startIcon={<KeyRound size={18} />} sx={{ textTransform: "none", fontWeight: 600 }}
          >
            {busy ? "Saving…" : "Set password and continue"}
          </Button>
          <Button onClick={onSignOut} sx={{ textTransform: "none" }}>Sign out</Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
