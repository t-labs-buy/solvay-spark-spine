/** The signed-in account, from the browser's side.
 *
 *  The server decides who is signed in (backend/auth/); this reads its answer
 *  and reacts when a session ends mid-page. The guard is installed once per
 *  bundle, around `fetch` itself, because the API is called from seventy
 *  places and a check at each would be the one a new call forgets. */

export type Role = "admin" | "user";

export interface Account {
  id: number;
  username: string;
  role: Role;
}

/** The auth routes answer 401 as part of their job -- a wrong password, a
 *  session check while signed out -- so they never trigger the redirect. */
const OWN = /^\/api\/(auth|app|demo)\/(login|logout|session|password)\b/;

let installed = false;

/** Send the reader to sign in when the server says the session has ended:
 *  the cookie expired, the password was reset, the account was deactivated --
 *  or that the account must choose its own password before going on.
 *  Without it, every panel on the page would fail one by one with
 *  "Sign in first." and nothing would say what to do. */
export function installSessionGuard(loginPath: string): void {
  if (installed) return;
  installed = true;
  const real = window.fetch.bind(window);
  let leaving = false;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await real(input, init);
    if ((res.status === 401 || res.status === 403) && !leaving) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href);
      // A 403 is usually "not an Admin", which the caller shows itself; only
      // "change your password first" means leave for the sign-in page.
      const held = res.status === 403
        && (await res.clone().json().catch(() => ({}))).code === "password_change_required";
      if ((res.status === 401 || held) && !leaving && path.origin === location.origin
          && path.pathname.startsWith("/api/") && !OWN.test(path.pathname)) {
        leaving = true;
        location.replace(`${loginPath}?next=${encodeURIComponent(location.pathname + location.search)}`);
      }
    }
    return res;
  };
}

export async function currentAccount(): Promise<Account | null> {
  try {
    const res = await fetch("/api/auth/session");
    if (!res.ok) return null;
    const d = await res.json();
    return { id: d.id, username: d.username ?? d.user, role: d.role };
  } catch {
    return null;
  }
}

export async function signOut(loginPath: string): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  location.replace(loginPath);
}

/** Change one's own password. Resolves to an error message, or null. */
export async function changePassword(current: string, next: string): Promise<string | null> {
  const res = await fetch("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current, new: next }),
  });
  if (res.ok) return null;
  const d = await res.json().catch(() => ({}));
  return typeof d.detail === "string" ? d.detail : `Request failed (${res.status})`;
}

// --- whose run history the lists show ----------------------------------------
//
// A User's lists only ever hold their own runs; the server sees to that. An
// Admin may also read everyone's, and chooses which in the account menu. The
// choice is one setting for every history list, kept per browser, and the
// pages that list runs re-fetch when it changes (useHistoryScope).

export type HistoryScope = "mine" | "all";
const SCOPE_KEY = "history-scope";
let scope: HistoryScope = (() => {
  try { return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "mine"; } catch { return "mine"; }
})();
const listeners = new Set<() => void>();

export function historyScope(): HistoryScope {
  return scope;
}

export function setHistoryScope(next: HistoryScope): void {
  scope = next;
  try { localStorage.setItem(SCOPE_KEY, next); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

export function onHistoryScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** "by alice", for a history card, when the list is everyone's. */
export function ownerLabel(owner: string | null | undefined): string {
  return scope === "all" && owner ? `by ${owner}` : "";
}
