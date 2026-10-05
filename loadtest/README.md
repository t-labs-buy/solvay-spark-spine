# Load testing with Locust

[Locust](https://locust.io) drives the app over HTTP with simulated users written in Python. Nothing in the app changes for it: it signs in like the browser does and keeps the `spark_session` cookie.

| File | What it is |
|---|---|
| `locustfile.py` | The simulated users (table below) |
| `sse.py` | Times a streamed (server-sent events) endpoint to its `done` event |
| `seed_users.py` | Creates the `loadtest-01..N` accounts through the admin API |
| `mock_anthropic.py` | A stand-in for the Claude API, so a load test costs nothing |

## The simulated users

Each one covers one page of the app, and so also of `/demo`, which calls the same `/api/*` endpoints.

| User | Always does (no Claude calls) | Also does, when turned on |
|---|---|---|
| `BrowseUser` | Health, Fit-Gap status, scope, history and preview, Ask history, documents, coverage, graph | — |
| `AskUser` | — | Asks a question with `LOADTEST_LLM=1` |
| `FitGapUser` | — | A Fit-Gap run with `LOADTEST_HEAVY=1` |
| `EvidenceUser` | Evidence status and history | An investigation with `LOADTEST_LLM=1` |
| `RolloutUser` | Fit-to-Standard status, history, decisions and the cost preview | A run with `LOADTEST_HEAVY=1` **and** `LOADTEST_ROLLOUT_SESSION` |
| `QualityUser` | Quality overview, explorer, judge and experiments | — (admin only; stops at once for other accounts) |

## Read this first

- **Claude costs money and nothing limits it.** The app has no rate limit. Every Ask makes a Claude call, plus a Ragas judge unless `RAG_EVAL_SAMPLE=0`. A Fit-Gap run makes dozens of calls. That is why `AskUser` needs `LOADTEST_LLM=1` and `FitGapUser` needs `LOADTEST_HEAVY=1`. Without those flags, only the cheap reads run.
- **Only run against a stack you may load.** The locustfile refuses any host that is not in `LOADTEST_ALLOWED_HOSTS` (default `localhost,127.0.0.1`).
- **Runs are real runs.** Asks and Fit-Gap runs made under load are saved to the run history and show in the Admin dashboard under the `loadtest-*` accounts. A stream that is still open when the test stops is saved as `running` and stays that way.
- **Test the server as it is deployed.** That means one uvicorn process with no `--reload`, the way the Dockerfile runs it. `scripts/run.sh` adds `--reload`.

## Setup

```sh
python3 -m venv .venv-loadtest                  # kept apart: Locust brings gevent
.venv-loadtest/bin/pip install -r loadtest/requirements.txt

# The app needs a fixed AUTH_SECRET, or a restart signs every test user out.
export LOADTEST_PASSWORD='a-long-password'     # 8+ characters
ADMIN_USERNAME=... ADMIN_PASSWORD=... \
  .venv/bin/python loadtest/seed_users.py --host http://localhost:8000 --count 20
```

Running `seed_users.py` again is safe: existing accounts get the password reset and are reactivated. Each simulated user signs in as a different account. When there are more users than accounts, they share them in turn.

**Or sign every simulated user in as one existing account**, for example the admin. This needs no seeding. All the runs then appear under that account in the Admin dashboard, mixed in with its own real runs.

```sh
set -a; source ../.env; set +a        # from loadtest/
LOADTEST_USERNAME="$ADMIN_USERNAME" LOADTEST_PASSWORD="$ADMIN_PASSWORD" \
  ../.venv-loadtest/bin/locust -H http://localhost:8000 --class-picker
```

`--class-picker` lets you choose in the web UI which simulated users to start.

## Profiles

Run from `loadtest/`. Add `--headless -t 5m --html report.html --csv run` to save a run so it can be compared with the next one. Leave `--headless` off to use the web UI at http://localhost:8089.

**1. Reads.** API, Postgres and in-memory graph capacity. No Claude calls.

```sh
LOADTEST_ACCOUNTS=20 ../.venv-loadtest/bin/locust -H http://localhost:8000 -u 200 -r 20
```

**2. Ask against the mock.** This tests how many answers can stream at once, at no cost. Start the mock, then start a copy of the app that points at it:

```sh
../.venv/bin/uvicorn mock_anthropic:app --port 8099            # from loadtest/
ANTHROPIC_BASE_URL=http://localhost:8099 ANTHROPIC_API_KEY=mock RAG_EVAL_SAMPLE=0 \
  .venv/bin/uvicorn backend.api.app:app --port 8001            # from the repo root

LOADTEST_LLM=1 ../.venv-loadtest/bin/locust BrowseUser AskUser -H http://localhost:8001 -u 60 -r 5
```

The app reads `.env` with `override=False`, so these shell variables win over the real key. The mock's pace is set with `MOCK_FIRST_TOKEN_MS`, `MOCK_TOKENS_PER_SEC` and `MOCK_ANSWER_TOKENS`.

**3. Fit-Gap smoke test.** This uses the real API, so keep it to one or two users:

```sh
LOADTEST_HEAVY=1 LOADTEST_FITGAP_STEPS=2 ../.venv-loadtest/bin/locust FitGapUser \
  -H http://localhost:8000 -u 1 -t 10m --headless
```

The mock is not enough for Fit-Gap, Evidence or Rollout. Those agents expect particular tool calls, and the mock only ever answers in plain text.

**Fit-to-Standard runs** need a document to analyse:

1. Sign in to the app as the account Locust uses and open Fit-to-Standard.
2. Attach the SAP Best Practice (or Country As-Is) document and tag it, as you would for a real run.
3. Copy the upload session id from the browser's network tab (the `/api/uploads/<session>` requests).
4. Run Locust with it set:

```sh
LOADTEST_HEAVY=1 LOADTEST_ROLLOUT_SESSION=<session> LOADTEST_ROLLOUT_SUBJECT=sap_best_practice \
  LOADTEST_ROLLOUT_SCOPE=4.1 ../.venv-loadtest/bin/locust RolloutUser -H http://localhost:8000 -u 1
```

The session belongs to that account and expires like any other, so make a new one when runs start failing with 400 or 404. Each run is about 4 minutes of Claude calls.

**4. Later, more load than one machine can produce:** `locust --master` on one machine and `locust --worker --master-host=...` on the others.

## Reading the results

A streamed endpoint is reported as three rows:

- `<path> headers`: what Locust measures on its own, which for a stream is meaningless.
- `<path> ttfe`: time to the first event, which is how long the page takes to start moving.
- `<path> total`: time until `done`.

An `error` event, or a stream that ends without `done`, counts as a failure.

**What to watch for:** every open stream holds one of Starlette's 40 threadpool threads for its whole length, and the app is a single process. As streams approach 40, `/api/health` and sign-in slow down with everything else. That point is the app's real limit on concurrent agent runs.
