/** The application's sign-in page (/login), a bundle of its own so the
 *  application's code is not sent to someone who has not signed in.
 *  Accounts are in Postgres; see backend/auth/. */
import { CssBaseline, ThemeProvider } from "@mui/material";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import SignInForm from "../components/SignInForm";
import { makeTheme, type Mode } from "../theme";

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* private mode */
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Only a path on this site, and never the sign-in page itself -- the same
 *  rule the server applies (app_login.safe_next). */
function nextTarget(): string {
  const next = new URLSearchParams(location.search).get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") && !next.includes("\\")
    ? next : "/";
}

function LoginApp() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const theme = useMemo(() => makeTheme(mode), [mode]);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem("theme", mode); } catch { /* private mode */ }
  }, [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <SignInForm mode={mode} onToggleMode={() => setMode(mode === "dark" ? "light" : "dark")}
                  endpoint="/api/auth/login" subtitle="Sign in to continue"
                  nextTarget={nextTarget} idPrefix="app" />
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LoginApp />
  </StrictMode>,
);
