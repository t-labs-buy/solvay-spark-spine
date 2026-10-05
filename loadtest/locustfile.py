"""Load tests for Spark Spine. See loadtest/README.md before running.

Three kinds of user, picked by what they cost:

  BrowseUser  cheap reads and previews, no LLM call. Always on.
  AskUser     POST /api/ask, which streams and calls Claude. LOADTEST_LLM=1.
  FitGapUser  POST /api/fitgap/run, minutes long, many Claude calls. LOADTEST_HEAVY=1.
  EvidenceUser   Evidence history and status; investigations with LOADTEST_LLM=1.
  RolloutUser    Fit-to-Standard history, status and previews; runs with
                 LOADTEST_HEAVY=1 and LOADTEST_ROLLOUT_SESSION (see README).
  QualityUser    The Quality dashboard. Admin only: needs loadtest-admin.

The parts that call Claude are left out unless asked for, so a plain
`locust` can never spend money by accident. Each simulated user signs in as
its own account (loadtest-01, loadtest-02, ... from seed_users.py) so its runs
are easy to tell apart in the Admin dashboard -- or, with LOADTEST_USERNAME set,
all of them sign in as that one account.

Only accounts named loadtest-* may be used. Signing in as the admin or a real
person mixes the test's runs into their history and the usage figures, with
no way to tell them apart afterwards, so any other name stops Locust before it
starts.
"""

from __future__ import annotations

import itertools
import os
import random
import threading
from urllib.parse import urlparse

from locust import HttpUser, between, events, tag, task
from locust.exception import StopUser

from sse import post_stream

# Fixed rather than configurable: it is what keeps the load test off real accounts.
PREFIX = "loadtest-"
# One account for every simulated user, e.g. loadtest-admin. When set, the
# loadtest-NN accounts are not used. It must still be a loadtest-* account.
USERNAME = os.environ.get("LOADTEST_USERNAME", "")
PASSWORD = os.environ.get("LOADTEST_PASSWORD", "")
ACCOUNTS = int(os.environ.get("LOADTEST_ACCOUNTS", "20"))
ALLOWED_HOSTS = {h.strip() for h in
                 os.environ.get("LOADTEST_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
                 if h.strip()}
LLM = os.environ.get("LOADTEST_LLM") == "1"
HEAVY = os.environ.get("LOADTEST_HEAVY") == "1"
# A Fit-to-Standard run has nothing to analyse without an attached document, so
# it needs an upload session made once in the app by the same account.
ROLLOUT_SESSION = os.environ.get("LOADTEST_ROLLOUT_SESSION", "")

# Questions about the corpus, so the scope guard lets them through and the
# retrieval has something to find. A short fixed list on purpose: comparable
# runs need comparable questions.
QUESTIONS = [
    "How is a sales order created and released for delivery?",
    "What are the steps in the procure-to-pay process?",
    "How are intercompany invoices handled at month end?",
    "Which approvals does a purchase requisition need?",
    "How is customer credit management configured?",
    "What happens to a goods receipt that fails quality inspection?",
]

_numbers = itertools.cycle(range(1, ACCOUNTS + 1))
_numbers_lock = threading.Lock()


def next_account() -> str:
    if USERNAME:
        return USERNAME
    with _numbers_lock:
        return f"{PREFIX}{next(_numbers):02d}"


def is_test_account(username: str) -> bool:
    return username.strip().lower().startswith(PREFIX)


@events.init.add_listener
def refuse_real_accounts(environment, **_kwargs):
    """Stop at startup, before the web UI opens, if told to use a real account."""
    if USERNAME and not is_test_account(USERNAME):
        raise SystemExit(f"LOADTEST_USERNAME={USERNAME!r} is not a load-test account. Only "
                         f"{PREFIX}* accounts may be used, so the test's runs never mix with "
                         "the admin's or a real user's. Create one with seed_users.py.")


@events.test_start.add_listener
def refuse_unknown_hosts(environment, **_kwargs):
    """Stop before the first request if the target is not on the allow list.
    There is no rate limit on the app, so pointing this at the wrong server
    would load it -- and its Anthropic budget -- with nothing to stop it."""
    host = urlparse(environment.host or "").hostname
    if host not in ALLOWED_HOSTS:
        raise SystemExit(f"{environment.host!r} is not in LOADTEST_ALLOWED_HOSTS "
                         f"({', '.join(sorted(ALLOWED_HOSTS))}). Add it there if it is "
                         "really a stack you may load.")
    if not PASSWORD:
        raise SystemExit("Set LOADTEST_PASSWORD: the password of LOADTEST_USERNAME, or the one "
                         "seed_users.py gave the loadtest-NN accounts.")


class SignedIn(HttpUser):
    abstract = True

    def on_start(self):
        self.username = next_account()
        if not is_test_account(self.username):  # belt and braces; see refuse_real_accounts
            raise StopUser()
        with self.client.post("/api/auth/login", name="/api/auth/login", catch_response=True,
                              json={"username": self.username, "password": PASSWORD}) as res:
            if res.status_code != 200:
                res.failure(f"{self.username}: HTTP {res.status_code}")
                raise StopUser()
            self.role = res.json().get("role")

    def open_newest(self, list_path: str, detail_path: str, name: str):
        """Open the newest run in a history list, as a person clicking it would."""
        res = self.client.get(list_path)
        if res.status_code != 200:
            return
        body = res.json()
        runs = body.get("runs", []) if isinstance(body, dict) else body
        if runs:
            self.client.get(detail_path.format(id=runs[0]["id"]), name=name)


class BrowseUser(SignedIn):
    """What a person clicking round the app costs: page data, history, previews."""

    weight = 10
    wait_time = between(1, 5)

    @tag("read")
    @task(5)
    def health(self):
        self.client.get("/api/health")

    @tag("read")
    @task(3)
    def fitgap_status(self):
        self.client.get("/api/fitgap/status")

    @tag("read")
    @task(2)
    def fitgap_scope(self):
        self.client.get("/api/fitgap/scope")

    @tag("read")
    @task(3)
    def fitgap_runs(self):
        self.client.get("/api/fitgap/runs")

    @tag("read")
    @task(3)
    def ask_runs(self):
        self.client.get("/api/ask/runs")

    @tag("read")
    @task(2)
    def kb_files(self):
        self.client.get("/api/kb/files")

    @tag("read")
    @task(2)
    def coverage(self):
        self.client.get("/api/coverage")

    @tag("read")
    @task(2)
    def rag_status(self):
        self.client.get("/api/rag/status")

    @tag("read")
    @task(2)
    def fitgap_preview(self):
        self.client.post("/api/fitgap/preview", json={"max_steps": 3})

    @tag("read")
    @task(2)
    def graph_query(self):
        self.client.post("/api/graph/query", json={"query": random.choice(
            ["sales order", "purchase order", "invoice", "goods receipt"])})

    @tag("read", "large")
    @task(1)
    def graph_data(self):
        # Several megabytes: the whole graph the canvas draws.
        self.client.get("/api/graph/data")


class AskUser(SignedIn):
    """One question at a time, read to the end as the Ask page would."""

    abstract = not LLM
    weight = 2
    wait_time = between(5, 15)

    @tag("llm")
    @task
    def ask(self):
        post_stream(self, "/api/ask", {"question": random.choice(QUESTIONS)}, "/api/ask",
                    timeout=300)


class FitGapUser(SignedIn):
    """A small Fit-Gap run. Even at three steps it is a dozen or more Claude calls."""

    abstract = not HEAVY
    weight = 1
    wait_time = between(30, 60)

    @tag("heavy")
    @task
    def fitgap(self):
        post_stream(self, "/api/fitgap/run",
                    {"max_steps": int(os.environ.get("LOADTEST_FITGAP_STEPS", "2")),
                     "concurrency": 2},
                    "/api/fitgap/run", timeout=1800)


class EvidenceUser(SignedIn):
    """The Evidence page: its status and history, and with LOADTEST_LLM=1 an
    investigation -- a tool loop of several Claude calls, then its scores."""

    weight = 2
    wait_time = between(5, 15)

    @tag("read")
    @task(3)
    def status(self):
        self.client.get("/api/evidence/status")

    @tag("read")
    @task(3)
    def history(self):
        self.open_newest("/api/evidence/runs", "/api/evidence/runs/{id}",
                         "/api/evidence/runs/[id]")

    if LLM:
        @tag("llm")
        @task(1)
        def investigate(self):
            post_stream(self, "/api/evidence/ask",
                        {"question": random.choice(QUESTIONS), "memory": False},
                        "/api/evidence/ask", timeout=900,
                        done_events=("answer",), read_to_end=True)


class RolloutUser(SignedIn):
    """The Fit-to-Standard page: status, history, decisions and the cost
    preview. With LOADTEST_HEAVY=1 and LOADTEST_ROLLOUT_SESSION, a real run."""

    weight = 2
    wait_time = between(5, 15)

    def payload(self) -> dict:
        return {"subject": os.environ.get("LOADTEST_ROLLOUT_SUBJECT", "sap_best_practice"),
                "scope_bpml": os.environ.get("LOADTEST_ROLLOUT_SCOPE", "4.1"),
                "upload_session": ROLLOUT_SESSION}

    @tag("read")
    @task(3)
    def status(self):
        self.client.get("/api/rollout/status")

    @tag("read")
    @task(3)
    def history(self):
        self.open_newest("/api/rollout/runs", "/api/rollout/runs/{id}", "/api/rollout/runs/[id]")

    @tag("read")
    @task(2)
    def decisions(self):
        self.client.get("/api/rollout/decisions")

    @tag("read")
    @task(2)
    def preview(self):
        self.client.post("/api/rollout/preview", json=self.payload())

    if HEAVY and ROLLOUT_SESSION:
        @tag("heavy")
        @task(1)
        def run(self):
            post_stream(self, "/api/rollout/run", self.payload(), "/api/rollout/run",
                        timeout=1800)


class QualityUser(SignedIn):
    """The Quality dashboard over the Ask history. Admin only, so it needs the
    loadtest-admin account (seed_users.py --admin); a user signed in without the
    admin role stops rather than counting 403s."""

    weight = 1
    wait_time = between(5, 20)

    def on_start(self):
        super().on_start()
        if self.role != "admin":
            raise StopUser()

    @tag("read")
    @task(3)
    def overview(self):
        self.client.get("/api/quality/overview")

    @tag("read", "large")
    @task(1)
    def explorer(self):
        # The slowest read in the app: every judged answer in the window.
        self.client.get("/api/quality/explorer")

    @tag("read")
    @task(2)
    def judge(self):
        self.client.get("/api/quality/judge")

    @tag("read")
    @task(2)
    def experiments(self):
        self.client.get("/api/quality/experiments")
