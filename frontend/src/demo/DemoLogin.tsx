/** The Demo Mode sign-in screen: the shared form, posting to the demo's own
 *  login and going on only to somewhere inside the demo. */
import type { Mode } from "../theme";
import SignInForm from "../components/SignInForm";

/** Only somewhere inside the demo: `next` comes from the address bar, and an
 *  open redirect would make this page a way to bounce people elsewhere. */
function nextTarget(): string {
  const next = new URLSearchParams(location.search).get("next") ?? "";
  return /^\/demo(\/[\w-]*)?$/.test(next) && !next.startsWith("/demo/login") ? next : "/demo";
}

export default function DemoLogin({ mode, onToggleMode }: { mode: Mode; onToggleMode: () => void }) {
  return (
    <SignInForm mode={mode} onToggleMode={onToggleMode} endpoint="/api/auth/login"
                subtitle="Sign in to the client demo" nextTarget={nextTarget} idPrefix="demo" />
  );
}
