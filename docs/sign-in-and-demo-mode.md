# Sign-in and Demo Mode

The presentation lock on the application, and the separate Demo Mode front door for client presentations. Neither is access control: see the "Localhost only" note in the [README](../README.md#notes).

## Signing in to the application

Every page of the application (`/`, `/ask`, `/rollout`, …) asks for a static
username and password first: **test** / **test** by default. The sign-in page
is `/login`; the sign-out button is at the right of the header. A page opened
while signed out goes to `/login` and comes back to that page afterwards.

It is a presentation lock, not access control: the `/api/*` endpoints stay
open, because Demo Mode's pages call the same API. Keep the "localhost only"
rule. Demo Mode has its own, separate sign-in (below). `app_login.py` holds it,
and `test_app_login.py` tests it.

| Variable | Default | |
|---|---|---|
| `APP_USERNAME` | `test` | |
| `APP_PASSWORD` | `test` | |
| `APP_SECRET` | random per process | signs the session cookie; set it to stay signed in across restarts |
| `APP_SESSION_HOURS` | `12` | |
| `APP_LOGIN` | `on` | `off` removes the sign-in |

## Demo Mode (client presentations)

A second front door for presenting to a client: <http://localhost:8000/demo>.
It asks for a sign-in, then opens on the Spark AI Spine landing page (the
logo returns to it) with only two tabs in the header, **Knowledge Graph** and
**Fit-Gap Copilot**. **Ask RAG** and the **Agent** sit in a sidebar that starts
minimized to icons: the menu button in the header expands it and minimizes it
again, and it can also be hidden entirely. It remembers its state in the
browser. The document tools (Convert, Batch Convert, Add to knowledge base),
the inspection pages (Coverage, Doc vs MD, MD Viewer), InsightLens and RAG
Metrics are left out of Demo Mode altogether -- their addresses under `/demo`
land on the introduction, and the landing page shows no buttons to them. All
of them remain in the application at `/`.

```bash
./scripts/run.sh                      # then open http://localhost:8000/demo
# username solvay, password solvay
```

The application at `/` is untouched. Demo Mode is a separate page bundle
(`frontend/demo.html`, `frontend/src/demo/`) served by its own routes in
`demo_mode.py`, and it renders the application's own page components, so a
fix to a page shows up in both.

**The sign-in is for a presentation, not for security.** It keeps a casual
visitor on a shared screen out of the demo page, and that is all: the main
application and every `/api/*` endpoint stay exactly as open as before, so the
"localhost only" note below still applies in full. The password is checked on
the server (it is not in the JavaScript bundle) and the session is an
HMAC-signed, HttpOnly cookie.

```bash
# Optional overrides (defaults shown):
DEMO_USERNAME=solvay
DEMO_PASSWORD=solvay
DEMO_SECRET=                  # unset: random per process, so a restart signs out
DEMO_SESSION_HOURS=12
```

```bash
.venv/bin/python backend/tests/test_demo_mode.py   # credentials, the signed session, the gate
```
