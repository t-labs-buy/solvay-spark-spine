# Accounts, roles and Demo Mode

Accounts are stored in Postgres. Each person signs in with their own username
and password, has a role (**Admin** or **User**), and sees only their own run
history. The same account opens the application at `/` and Demo Mode at
`/demo`. The code is in `backend/auth/`.

## Signing in

Every page (`/`, `/ask`, `/rollout`, …) and every `/api/*` endpoint needs a
signed-in account. A page opened while signed out goes to `/login` and returns
to that page afterwards. An API call made while signed out gets `401`. Demo
Mode has its own sign-in page at `/demo/login` that uses the same accounts.

The session is an HMAC-signed, HttpOnly cookie (`spark_session`). Passwords
are stored as scrypt hashes. On every request the server checks the account
behind the cookie, so the following take effect on that account's next
request, wherever it is signed in:

- **Resetting a password** signs the account out.
- **Deactivating** an account signs it out.
- **Changing a role** applies straight away, without signing out.

### The first Admin

When the server starts and there is no active Admin, it creates one from
`ADMIN_USERNAME` and `ADMIN_PASSWORD`. If neither is set, the server logs a
warning. You can also create an Admin from the command line:

```bash
.venv/bin/python -m backend.auth.store create-admin <username>   # prompts for the password
.venv/bin/python -m backend.auth.store list
```

| Variable | Default | |
|---|---|---|
| `ADMIN_USERNAME` | — | the first Admin, created at start-up if there is no active Admin |
| `ADMIN_PASSWORD` | — | at least 8 characters |
| `AUTH_SECRET` | random per process | signs the session cookie; set it to stay signed in across restarts (`APP_SECRET` is still read) |
| `AUTH_SESSION_HOURS` | `12` | |

The old static logins (`test`/`test` and `solvay`/`solvay`) and `APP_LOGIN=off`
no longer exist.

## Roles

| | User | Admin |
|---|---|---|
| Run Ask RAG, the Agent, InsightLens, the Fit-Gap Copilot | yes | yes |
| Their own run history: open, export, review, decide, delete | yes | yes |
| Other people's runs | no ("not found") | read-only, via **History: everyone's runs** in the account menu |
| RAG Metrics (Quality), experiments, the memory "reflect" button | no | yes |
| The **Admin** tab: accounts, usage, activity | no | yes |

Documents you upload to convert, singly or as a batch, are yours: nobody
else can open, convert, download or delete them, an Admin included. Once a
document is in the knowledge base, its original's pages are shown to anyone
in **Doc vs MD**.

The knowledge base, the knowledge graph and source documents are shared by
everyone. Two more things are shared as organisational memory:

- **The Evidence Agent's memory bank.** Facts it retains are tagged `user:<name>`.
- **The Fit-Gap Copilot's workshop decisions** (`/api/rollout/decisions`). Each
  decision records who made it.

Reviewer, facilitator and "decided by" names are no longer typed in. The
server takes them from the signed-in account.

Accounts are never deleted. An account that should no longer sign in is
deactivated, so its runs keep an owner. Runs recorded before accounts existed
belong to a built-in account called `legacy`. Only Admins can see those runs,
and `legacy` cannot sign in. To hand them to a real account so it sees them in
its history:

```bash
.venv/bin/python -m backend.auth.store reassign-legacy <username>              # everything legacy owns
.venv/bin/python -m backend.auth.store reassign-legacy <username> fitgap_runs  # one table
```

## The Admin tab

- **Usage.** Runs, failures, run time and tokens for each account and each
  tool, plus sign-ins and a chart of runs per day. The numbers come from the
  run tables themselves. LLM cost is in Langfuse, where every trace now
  carries the username.
- **Users.** Create accounts, change a role, reset a password, deactivate or
  reactivate an account. Nobody can demote or deactivate themselves, and the
  last active Admin cannot be removed.
- **Activity.** Sign-ins (including failed ones), runs, reviews, decisions,
  exports, deletions and account changes, newest first.

```bash
.venv/bin/python backend/tests/test_auth.py        # sign-in, sessions, roles, account rules
.venv/bin/python backend/tests/test_ownership.py   # per-user runs, legacy hand-over, usage
.venv/bin/python backend/tests/test_app_login.py   # the page gates (no database)
```

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
./scripts/run.sh                      # then open http://localhost:8000/demo and sign in
```

The application at `/` is untouched. Demo Mode is a separate page bundle
(`frontend/demo.html`, `frontend/src/demo/`) served by its own routes in
`demo_mode.py`, and it renders the application's own page components, so a
fix to a page shows up in both.

Demo Mode uses the same accounts and the same session as the application
(see above). Its pages send a signed-out visitor to `/demo/login`.
