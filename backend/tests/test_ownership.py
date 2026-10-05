"""Every run belongs to the account that made it.

Run: python backend/tests/test_ownership.py

Needs Postgres, nothing else: runs are seeded straight into a throwaway
database rather than produced by the agents, because what is under test is
who may see them, not how they were made. The promises:

  * a User sees only their own runs, in every tool's history;
  * someone else's run, asked for by id, is "not found" -- for reading,
    deleting, exporting and its audit trail -- so a guessed id confirms
    nothing;
  * an Admin can read anyone's run, and list everyone's with scope=all, but
    cannot delete or decide on another's;
  * runs from before accounts are handed to `legacy`, and can be handed on
    from there to a real account;
  * retention and "clear history" act on one account, not everyone;
  * the usage dashboard counts each account's runs and tokens.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

from fastapi.testclient import TestClient

from backend.agents.evidence import store as ev_store
from backend.agents.fitgap import store as fg_store
from backend.agents.rollout import store as ro_store
from backend.auth import middleware, store
from backend.rag import ask_store, rag

TEST_DATABASE = "docling_test_ownership"
_original_base_url = rag.base_url
IDS: dict[str, int] = {}


def _url(name: str) -> str:
    p = urlsplit(_original_base_url())
    return urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, p.fragment))


def _admin_conn():
    import psycopg

    return psycopg.connect(_url("postgres"), autocommit=True)


def setup() -> None:
    with _admin_conn() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{TEST_DATABASE}" WITH (FORCE)')
        c.execute(f'CREATE DATABASE "{TEST_DATABASE}"')
    rag.base_url = lambda: _url(TEST_DATABASE)
    rag.close()
    rag._schema_ready = False
    middleware.forget()
    conn = store.connect()
    for name, role in (("root", "admin"), ("alice", "user"), ("bob", "user")):
        IDS[name] = store.create_user(conn, name, f"{name}-password", role)["id"]
    for mod in (ask_store, ev_store, fg_store, ro_store):
        mod.create_schema(mod.connect())
    for who in ("alice", "bob"):
        seed(who)


def teardown() -> None:
    rag.close()
    rag.base_url = _original_base_url
    with _admin_conn() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{TEST_DATABASE}" WITH (FORCE)')


def seed(who: str) -> None:
    uid = IDS[who]
    conn = store.connect()
    ev_store.start_run(conn, {"id": f"ev_{who}", "question": f"{who}'s question", "holdout": False,
                              "categories": [], "model": "m", "prompt_hash": "",
                              "corpus_fingerprint": "", "user_id": uid})
    ev_store.finish_run(conn, f"ev_{who}", {"answer": "a", "input_tokens": 100,
                                            "output_tokens": 10, "seconds": 2.5}, [])
    ask_store.start_run(conn, {"id": f"ask_{who}", "question": "q", "mode": "hybrid", "k": 8,
                               "categories": [], "answer_model": "m", "embed_model": "e",
                               "corpus_fingerprint": "", "user_id": uid})
    ask_store.finish_run(conn, f"ask_{who}", "answer", {"seconds": 1.0, "input_tokens": 50,
                                                        "output_tokens": 5})
    fg_store.start_run(conn, {"id": f"fg_{who}", "mode": "A", "scope_bpml": "4.0",
                              "scope_label": "4.0 x", "question": "", "country": None,
                              "model": "m", "prompt_hash": "", "params": {}, "holdout": False,
                              "corpus_fingerprint": "", "categories": [], "uploads": {},
                              "user_id": uid})
    conn.execute("INSERT INTO fitgap_entries (run_id, bpml_code, classification, entry)"
                 " VALUES (%s, '4.1', 'fit', %s)",
                 (f"fg_{who}", json.dumps({"bpml_code": "4.1", "step_name": "s"})))
    ro_store.start_run(conn, {"id": f"ro_{who}", "scope_bpml": "4.0", "scope_label": "x",
                              "country": "FR", "country_context": "", "sap_release": "",
                              "gt_version": "", "question": "", "model": "m", "prompt_hash": "",
                              "categories": [], "uploads": {}, "corpus_fingerprint": "",
                              "user_id": uid})
    conn.commit()


def client(who: str) -> TestClient:
    from backend.api.app import app

    c = TestClient(app, follow_redirects=False)
    r = c.post("/api/auth/login", json={"username": who, "password": f"{who}-password"})
    assert r.status_code == 200, r.text
    return c


def ids(rows) -> set[str]:
    return {r["id"] for r in rows}


# --- tests --------------------------------------------------------------------


def test_a_user_lists_only_their_own() -> None:
    alice = client("alice")
    assert ids(alice.get("/api/evidence/runs").json()) == {"ev_alice"}
    assert ids(alice.get("/api/ask/runs").json()["runs"]) == {"ask_alice"}
    assert ids(alice.get("/api/fitgap/runs").json()) == {"fg_alice"}
    assert ids(alice.get("/api/rollout/runs").json()) == {"ro_alice"}
    # Asking for everyone's is a view choice, not a right.
    assert ids(alice.get("/api/evidence/runs?scope=all").json()) == {"ev_alice"}


def test_someone_elses_run_is_not_found() -> None:
    bob = client("bob")
    for path in ("/api/evidence/runs/ev_alice", "/api/evidence/runs/ev_alice/lineage",
                 "/api/ask/runs/ask_alice", "/api/ask/runs/ask_alice/evaluation",
                 "/api/fitgap/runs/fg_alice", "/api/fitgap/runs/fg_alice/export?format=json",
                 "/api/rollout/runs/ro_alice", "/api/rollout/runs/ro_alice/lineage",
                 "/api/rollout/runs/ro_alice/export?format=json"):
        assert bob.get(path).status_code == 404, path
    for path in ("/api/evidence/runs/ev_alice", "/api/ask/runs/ask_alice",
                 "/api/rollout/runs/ro_alice"):
        assert bob.delete(path).status_code == 404, path
    entry = store.connect().execute(
        "SELECT id FROM fitgap_entries WHERE run_id = 'fg_alice'").fetchone()[0]
    r = bob.post(f"/api/fitgap/entries/{entry}/review", json={"verdict": "accept"})
    assert r.status_code == 404
    assert bob.post("/api/rollout/runs/ro_alice/decisions",
                    json={"gap_id": "G1", "verdict": "accept"}).status_code == 404
    # ...and alice's runs are all still there.
    alice = client("alice")
    assert alice.get("/api/evidence/runs/ev_alice").status_code == 200
    assert alice.get("/api/rollout/runs/ro_alice").status_code == 200


def test_reviews_are_signed_by_the_account() -> None:
    alice = client("alice")
    entry = store.connect().execute(
        "SELECT id FROM fitgap_entries WHERE run_id = 'fg_alice'").fetchone()[0]
    r = alice.post(f"/api/fitgap/entries/{entry}/review",
                   json={"verdict": "accept", "reviewer": "Somebody Else"})
    assert r.status_code == 200, r.text
    assert r.json()["reviewer"] == "alice"


def test_an_admin_reads_everyone_but_changes_only_their_own() -> None:
    root = client("root")
    assert ids(root.get("/api/evidence/runs").json()) == set(), "mine by default"
    every = ids(root.get("/api/evidence/runs?scope=all").json())
    assert {"ev_alice", "ev_bob"} <= every
    rows = root.get("/api/rollout/runs?scope=all").json()
    assert {r["owner"] for r in rows} >= {"alice", "bob"}
    assert root.get("/api/evidence/runs/ev_bob").status_code == 200
    assert root.get("/api/fitgap/runs/fg_bob").status_code == 200
    assert root.delete("/api/evidence/runs/ev_bob").status_code == 404
    assert client("bob").get("/api/evidence/runs/ev_bob").status_code == 200


def test_runs_from_before_accounts_go_to_legacy() -> None:
    conn = store.connect()
    conn.execute("INSERT INTO evidence_runs (id, question) VALUES ('ev_old', 'from last year')")
    conn.commit()
    ev_store._ready.clear()
    ev_store.create_schema(conn)
    owner = conn.execute("SELECT user_id FROM evidence_runs WHERE id = 'ev_old'").fetchone()[0]
    assert owner == store.legacy_id()
    assert "ev_old" not in ids(client("alice").get("/api/evidence/runs").json())
    root = client("root")
    rows = root.get("/api/evidence/runs?scope=all").json()
    assert any(r["id"] == "ev_old" and r["owner"] == "legacy" for r in rows)


def test_legacy_runs_can_be_handed_to_an_account() -> None:
    conn = store.connect()
    for bad in ("nobody", "legacy"):
        try:
            store.reassign_legacy(conn, bad)
            raise AssertionError(f"{bad!r} should have been refused")
        except store.AccountError:
            pass
    try:
        store.reassign_legacy(conn, "bob", ["users"])
        raise AssertionError("a table outside OWNED_TABLES should have been refused")
    except store.AccountError:
        pass
    moved = store.reassign_legacy(conn, "Bob", ["evidence_runs"])
    assert moved == {"evidence_runs": 1}
    assert "ev_old" in ids(client("bob").get("/api/evidence/runs").json())
    assert store.reassign_legacy(conn, "bob")["evidence_runs"] == 0, "nothing left to move"


def test_retention_is_per_account() -> None:
    conn = store.connect()
    for i in range(3):
        ask_store.start_run(conn, {"id": f"ask_bob_{i}", "question": "q", "mode": "hybrid",
                                   "k": 8, "categories": [], "answer_model": "m",
                                   "embed_model": "e", "corpus_fingerprint": "",
                                   "user_id": IDS["bob"]})
    removed = ask_store.trim(conn, keep=1, owner=IDS["bob"])
    assert removed == 3
    assert ask_store.get_run(conn, "ask_alice") is not None, "alice's history is untouched"


def test_clear_history_clears_only_ones_own() -> None:
    bob = client("bob")
    assert bob.delete("/api/ask/runs").status_code == 200
    assert bob.get("/api/ask/runs").json()["runs"] == []
    assert ids(client("alice").get("/api/ask/runs").json()["runs"]) == {"ask_alice"}


def test_usage_counts_each_account() -> None:
    root = client("root")
    assert client("alice").get("/api/admin/usage").status_code == 403
    body = root.get("/api/admin/usage").json()
    by_name = {u["username"]: u for u in body["users"]}
    alice = by_name["alice"]
    assert alice["tools"]["evidence"]["runs"] == 1
    assert alice["tools"]["evidence"]["input_tokens"] == 100
    assert alice["tools"]["ask"]["output_tokens"] == 5
    assert alice["runs"] == 4 and alice["logins"] >= 1
    assert "root" in by_name, "an account that ran nothing still has a row"
    assert sum(d["evidence"] for d in body["daily"]) >= 2
    assert len(body["daily"]) == 30
    assert body["totals"]["active_users"] <= len([u for u in body["users"] if u["username"] != "legacy"])
    one = root.get(f"/api/admin/usage?user_id={IDS['alice']}").json()
    assert [u["username"] for u in one["users"]] == ["alice"]


def test_an_admin_lists_one_accounts_runs_across_tools() -> None:
    root = client("root")
    assert client("alice").get("/api/admin/runs").status_code == 403
    body = root.get(f"/api/admin/runs?user_id={IDS['alice']}").json()
    assert {(r["tool"], r["id"]) for r in body["runs"]} == {
        ("evidence", "ev_alice"), ("ask", "ask_alice"), ("fitgap", "fg_alice"), ("rollout", "ro_alice")}
    assert all(r["username"] == "alice" for r in body["runs"])
    only = root.get(f"/api/admin/runs?user_id={IDS['alice']}&tool=evidence").json()["runs"]
    assert [r["id"] for r in only] == ["ev_alice"] and only[0]["title"] == "alice's question"
    assert root.get("/api/admin/runs?tool=nope").status_code == 400


def test_conversions_belong_to_the_uploader() -> None:
    alice, bob = client("alice"), client("bob")
    doc = alice.post("/api/upload", files={"file": ("note.txt", b"Note: hello")}).json()["id"]
    batch = alice.post("/api/batch/upload",
                       files=[("files", ("a.txt", b"A")), ("files", ("b.txt", b"B"))]).json()["batch_id"]
    assert bob.get(f"/api/docs/{doc}/download").status_code == 404
    assert bob.delete(f"/api/docs/{doc}").status_code == 404
    assert bob.post(f"/api/convert/{doc}").status_code == 404
    assert bob.get(f"/api/batch/{batch}/download").status_code == 404
    assert bob.post(f"/api/batch/convert/{batch}", json={}).status_code == 404
    assert client("root").get(f"/api/docs/{doc}/download").status_code == 404, "not an Admin's either"
    assert alice.get(f"/api/docs/{doc}/download").status_code == 404, "hers, but not converted yet"
    # A job holding a knowledge-base original is shared: anyone may read it,
    # only its owner may change it.
    from backend.api import app as app_module
    app_module._mark_shared(app_module.WORKDIR / doc)
    r = bob.get(f"/api/docs/{doc}/download")
    assert r.status_code == 404 and "Convert" in r.json()["detail"], "read reaches the shared job"
    assert bob.delete(f"/api/docs/{doc}").status_code == 404, "but cannot delete it"
    assert alice.delete(f"/api/docs/{doc}").status_code == 200


def test_decisions_are_shared_memory() -> None:
    conn = store.connect()
    for who in ("alice", "bob"):
        conn.execute("INSERT INTO workshop_decisions (source_run, gap_id, verdict, decided_by, user_id)"
                     " VALUES (%s, 'GAP-01', 'accept', %s, %s)", (f"ro_{who}", who, IDS[who]))
    conn.commit()
    runs = lambda c, q="": {d["source_run"] for d in c.get("/api/rollout/decisions" + q).json()["decisions"]}
    # Organisational memory: everyone sees every decision, and each row still
    # records who made it.
    assert runs(client("alice")) == runs(client("root")) == {"ro_alice", "ro_bob"}


def test_copied_old_decisions_get_the_runs_owner() -> None:
    conn = store.connect()
    conn.execute("INSERT INTO rollout_decisions (run_id, gap_id, reviewer, verdict)"
                 " VALUES ('ro_bob', 'GAP-02', 'bob (typed)', 'accept')")
    conn.commit()
    assert ro_store._backfill(conn) == 1
    owners = dict(conn.execute("SELECT source_run, user_id FROM workshop_decisions"
                               " WHERE legacy_id IS NOT NULL").fetchall())
    assert owners == {"ro_bob": IDS["bob"]}, "the run's owner, not left empty"


TESTS = [
    test_an_admin_lists_one_accounts_runs_across_tools,
    test_a_user_lists_only_their_own,
    test_someone_elses_run_is_not_found,
    test_reviews_are_signed_by_the_account,
    test_an_admin_reads_everyone_but_changes_only_their_own,
    test_runs_from_before_accounts_go_to_legacy,
    test_legacy_runs_can_be_handed_to_an_account,
    test_retention_is_per_account,
    test_clear_history_clears_only_ones_own,
    test_usage_counts_each_account,
    test_conversions_belong_to_the_uploader,
    test_decisions_are_shared_memory,
    test_copied_old_decisions_get_the_runs_owner,
]


def main() -> int:
    setup()
    failed = 0
    try:
        for t in TESTS:
            try:
                t()
                print(f"ok    {t.__name__}")
            except Exception as exc:
                failed += 1
                print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
    finally:
        teardown()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
