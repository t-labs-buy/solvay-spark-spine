/** The account button at the right of the header: who is signed in, with
 *  which role, a way to change one's own password, and Sign out. Shared by
 *  the application and Demo Mode, which use the same accounts. */
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  IconButton, ListItemIcon, Menu, MenuItem, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import { CircleUserRound, KeyRound, LogOut, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";

import { changePassword, setHistoryScope, signOut, type Account } from "../auth";
import useHistoryScope from "../useHistoryScope";

export default function AccountMenu({ account, loginPath, onAdmin }: {
  account: Account | null;
  loginPath: string;
  /** Opens the Admin page; given only to an Admin, and only where there is one. */
  onAdmin?: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState(false);
  const scope = useHistoryScope();

  return (
    <>
      <Tooltip title={account ? `Signed in as ${account.username}` : "Account"}>
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label="Account" aria-haspopup="menu">
          <CircleUserRound size={19} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}>
        <Box sx={{ px: 2, py: 1, minWidth: 200 }}>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>Signed in as</Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography sx={{ fontWeight: 600 }}>{account?.username ?? "…"}</Typography>
            {account && (
              <Chip size="small" label={account.role === "admin" ? "Admin" : "User"}
                    color={account.role === "admin" ? "primary" : "default"} variant="outlined"
                    sx={{ height: 20, fontSize: 11 }} />
            )}
          </Stack>
        </Box>
        <Divider />
        {onAdmin && (
          <MenuItem onClick={() => { setAnchor(null); onAdmin(); }}>
            <ListItemIcon><ShieldCheck size={17} /></ListItemIcon>
            Admin: usage, accounts, activity
          </MenuItem>
        )}
        {account?.role === "admin" && (
          // An Admin may read everyone's runs. One switch for every history
          // list on every page, so "whose runs am I looking at" has one answer.
          <MenuItem onClick={() => setHistoryScope(scope === "all" ? "mine" : "all")}>
            <ListItemIcon><Users size={17} /></ListItemIcon>
            <Box sx={{ flex: 1 }}>History: {scope === "all" ? "everyone's runs" : "my runs"}</Box>
            <Switch size="small" checked={scope === "all"} sx={{ ml: 1 }} />
          </MenuItem>
        )}
        <MenuItem onClick={() => { setAnchor(null); setDialog(true); }}>
          <ListItemIcon><KeyRound size={17} /></ListItemIcon>
          Change password
        </MenuItem>
        <MenuItem onClick={() => { setAnchor(null); void signOut(loginPath); }}>
          <ListItemIcon><LogOut size={17} /></ListItemIcon>
          Sign out
        </MenuItem>
      </Menu>
      <PasswordDialog open={dialog} onClose={() => setDialog(false)} />
    </>
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setCurrent(""); setNext(""); setAgain(""); setError(null); setDone(false);
    onClose();
  };

  const save = async () => {
    if (next !== again) { setError("The new passwords differ."); return; }
    setBusy(true);
    const why = await changePassword(current, next);
    setBusy(false);
    if (why) setError(why);
    else { setError(null); setDone(true); }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Change password</DialogTitle>
      <DialogContent>
        {done ? (
          <Alert severity="success" sx={{ mt: 1 }}>
            Password changed. Other browsers signed in to this account have been signed out.
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Current password" type="password" value={current} autoFocus
                       autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
            <TextField label="New password" type="password" value={next} autoComplete="new-password"
                       helperText="At least 8 characters" onChange={(e) => setNext(e.target.value)} />
            <TextField label="New password again" type="password" value={again} autoComplete="new-password"
                       onChange={(e) => setAgain(e.target.value)} />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{done ? "Close" : "Cancel"}</Button>
        {!done && (
          <Button variant="contained" onClick={save} disabled={busy || !current || !next || !again}>
            Change password
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
