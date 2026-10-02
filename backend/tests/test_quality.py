"""Unit tests for the Answer Quality workspace.

Run: python backend/tests/test_quality.py

Needs Postgres and nothing else. The only model quality.py touches is the
corpus embedder, used to group questions and claims by meaning; here it is
replaced with a bag-of-words stand-in, so texts that share words group
together and nothing reaches Ollama. No judge is ever called -- this module
does arithmetic over verdicts already stored.

What is checked, each of which is a way the dashboard could mislead:

  * the failure rules fire in their stated order, and a judge that did not
    return skips its rule instead of failing it;
  * a score of exactly 0.0 counts as below the line (an `or` would pass it);
  * the previous period is the window before, not overlapping it;
  * the timeline's band is a real percentile, and the events on it come only
    from questions asked across the whole corpus;
  * a document's usefulness comes from the excerpt verdicts, and a verdict
    with no excerpt number is not counted against any document;
  * kappa is withheld below the minimum number of reviews, and correct above;
  * the judge-trust queue puts disagreements first and samples the rest the
    same way all week;
  * an experiment comparison calls a move inside the noise band unchanged,
    sorts regressions first, and names the configuration that differs.
"""

from __future__ import annotations

import hashlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np  # noqa: E402

from backend.rag import ask_store  # noqa: E402
from backend.rag import experiment_store  # noqa: E402
from backend.rag import quality  # noqa: E402
from backend.rag import rag  # noqa: E402


def _bag(texts):
    """Bag-of-words vectors: texts that share words point the same way."""
    out = []
    for t in texts:
        v = np.zeros(128)
        for w in quality._terms(t):
            v[int(hashlib.md5(w.lower().encode()).hexdigest(), 16) % 128] += 1
        out.append(v + 1e-3)
    return out


quality.EMBED = _bag

TEST_DATABASE = "docling_test_quality"
_original_base_url = rag.base_url
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


def _url(name: str) -> str:
    p = urlsplit(_original_base_url())
    return urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, p.fragment))


def _admin():
    import psycopg

    return psycopg.connect(_url("postgres"), autocommit=True)


def setup() -> None:
    with _admin() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{TEST_DATABASE}" WITH (FORCE)')
        c.execute(f'CREATE DATABASE "{TEST_DATABASE}"')
    rag.base_url = lambda: _url(TEST_DATABASE)
    rag.close()
    rag._schema_ready = False
    ask_store.create_schema(ask_store.connect())
    experiment_store.create_schema(experiment_store.connect())


def teardown() -> None:
    rag.close()
    rag.base_url = _original_base_url
    with _admin() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{TEST_DATABASE}" WITH (FORCE)')


def clear() -> None:
    conn = ask_store.connect()
    conn.execute("TRUNCATE TABLE ask_runs CASCADE")
    conn.execute("TRUNCATE TABLE eval_experiments CASCADE")
    conn.commit()
    quality._vector_cache.clear()


def m(value, **extra):
    return {"value": value, "reason": "", "error": "" if value is not None else "Timeout", **extra}


def good(**over):
    base = {"faithfulness": 0.95, "answer_relevancy": 0.9, "context_precision": 0.9,
            "context_relevance": 1.0, "context_utilization": 0.9,
            "coherence": 0.9, "conciseness": 0.9}
    base.update(over)
    return base


def answer(run_id, question="why?", *, days_ago=1.0, values=None, safety=1.0,
           sources=(("SOVOS spec", "PKG"),), categories=(), prompt="p1", corpus="c1",
           precision_working=None, claims=None, relevance=None, review=None, mode="hybrid"):
    """One judged question, with its time, scores, excerpts and working."""
    conn = ask_store.connect()
    ask_store.start_run(conn, {
        "id": run_id, "question": question, "mode": mode, "k": 8,
        "categories": list(categories), "answer_model": "claude-opus-5",
        "embed_model": "bge-m3", "corpus_fingerprint": corpus, "prompt_hash": prompt})
    ask_store.save_sources(conn, run_id, [
        {"n": n, "title": t, "category": c, "content": "x"}
        for n, (t, c) in enumerate(sources, 1)], [])
    ask_store.finish_run(conn, run_id, "an answer", {"seconds": 1})
    conn.execute("UPDATE ask_runs SET started_at = %s WHERE id = %s",
                 (NOW - timedelta(days=days_ago), run_id))
    conn.commit()
    values = values if values is not None else good()
    metrics = {k: m(v) for k, v in values.items()}
    if precision_working is not None:
        metrics.setdefault("context_precision", m(0.9))["working"] = {
            "kind": "excerpts", "items": precision_working}
    if claims is not None:
        metrics.setdefault("faithfulness", m(0.5))["working"] = {
            "kind": "claims", "items": claims}
    if relevance is not None:
        metrics.setdefault("context_relevance", m(1.0))["working"] = {
            "kind": "ratings", "items": [{"judge": i + 1, "rating": r, "of": 2}
                                         for i, r in enumerate(relevance)]}
    from backend.rag import evaluation

    score, safe, terms = evaluation.overall(metrics)
    if safety is not None and safety < 1:
        score = min(score, evaluation.SAFETY_CAP)
    ask_store.start_evaluation(conn, run_id, "claude-sonnet-5")
    ask_store.finish_evaluation(conn, run_id, {
        "status": "done", "judge_model": "claude-sonnet-5", "metrics": metrics,
        "overall": score, "safety": safety, "terms": terms})
    if review:
        ask_store.save_review(conn, run_id, review)


# --- failure rules ------------------------------------------------------------

def test_the_failure_rules_fire_in_their_stated_order():
    f = quality.failure
    assert f(good(), 1.0) is None
    assert f(good(), 0.0) == "safety"
    # With another rule also true, so the ORDER is what is being tested.
    assert f(good(context_relevance=0.1, faithfulness=0.1), 0.0) == "safety", (
        "safety must win over everything, including wrong sources")
    assert f(good(context_relevance=0.3, faithfulness=0.1), 1.0) == "wrong_sources"
    assert f(good(context_precision=0.3), 1.0) == "buried"
    assert f(good(context_utilization=0.2), 1.0) == "ignored"
    assert f(good(faithfulness=0.4), 1.0) == "invented"
    assert f(good(answer_relevancy=0.4), 1.0) == "off_question"


def test_a_judge_that_did_not_return_skips_its_rule():
    values = good(context_relevance=None, faithfulness=0.4)
    assert quality.failure(values, 1.0) == "invented"
    assert quality.failure(good(context_precision=None), 1.0) is None


def test_every_failure_key_is_reachable():
    """A failure type no score can produce is a filter chip that is always 0."""
    reached = {
        quality.failure(good(), 0.0),
        quality.failure(good(context_relevance=0.2), 1.0),
        quality.failure(good(context_precision=0.2), 1.0),
        quality.failure(good(context_utilization=0.2), 1.0),
        quality.failure(good(faithfulness=0.2), 1.0),
        quality.failure(good(answer_relevancy=0.2), 1.0),
    }
    assert reached == set(quality.FAILURE_KEYS), reached


def test_the_half_is_read_off_the_excerpts_not_the_scope():
    assert quality.half([{"category": "PKG"}, {"category": "PKG"}]) == "PKG"
    assert quality.half([{"category": "DR"}, {"category": "PKG"}]) == "PKG+DR"
    assert quality.half([]) == "—"


# --- overview -----------------------------------------------------------------

def test_the_tiles_compare_against_the_window_before():
    clear()
    answer("a1", days_ago=2, values=good(faithfulness=0.9))
    answer("a2", days_ago=3, values=good(faithfulness=0.7))
    answer("b1", days_ago=40, values=good(faithfulness=0.5))   # the previous window
    answer("c1", days_ago=70, values=good(faithfulness=0.1))   # older still: ignored
    got = quality.overview(ask_store.connect(), days=28, now=NOW)
    tile = next(t for t in got["tiles"] if t["key"] == "faithfulness")
    assert tile["value"] == 0.8, tile
    assert tile["previous"] == 0.5, (
        "the previous period must be the 28 days before, not everything older")
    assert tile["delta"] == 0.3, tile
    assert got["scored"] == 2 and got["previous_scored"] == 1


def test_a_score_of_exactly_zero_counts_as_below_the_line():
    clear()
    answer("z", days_ago=1, values=good(faithfulness=0.0))
    tile = next(t for t in quality.overview(ask_store.connect(), now=NOW)["tiles"]
                if t["key"] == "faithfulness")
    assert tile["below"] == 1, "0.0 was read as a pass"


def test_the_band_is_a_real_percentile():
    xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    assert quality._pct(xs, 0.5) == 0.55
    assert quality._pct(xs, 0.1) == 0.19
    assert quality._pct(xs, 0.9) == 0.91
    assert quality._pct([], 0.5) is None


def test_the_histogram_puts_a_perfect_score_in_the_top_bin():
    clear()
    answer("p", days_ago=1)
    conn = ask_store.connect()
    conn.execute("UPDATE ask_evaluations SET overall = 1.0")
    conn.commit()
    bins = quality.overview(conn, now=NOW)["histogram"]
    assert bins[9] == 1 and sum(bins) == 1, bins


def test_timeline_events_come_only_from_whole_corpus_questions():
    """A question scoped to PKG has its own corpus fingerprint; comparing it
    with an unscoped one would mark a corpus change that never happened."""
    clear()
    answer("e1", days_ago=10, prompt="p1", corpus="c1")
    answer("e2", days_ago=8, prompt="p1", corpus="SCOPED", categories=("PKG",))
    answer("e3", days_ago=6, prompt="p2", corpus="c1")
    answer("e4", days_ago=4, prompt="p2", corpus="c2")
    got = quality.events(ask_store.connect(), NOW - timedelta(days=28), NOW)
    kinds = [(e["kind"], e["value"]) for e in got]
    assert kinds == [("prompt", "p2"), ("corpus", "c2")], kinds


def test_a_subject_below_the_line_needs_attention():
    clear()
    for n in range(3):
        answer(f"bad{n}", f"agent commissions settlement self billing {n}",
               values=good(faithfulness=0.1, answer_relevancy=0.3, context_precision=0.2))
    for n in range(3):
        answer(f"ok{n}", f"SOVOS signed PDF invoice flow {n}")
    got = quality.overview(ask_store.connect(), now=NOW)
    subjects = [a for a in got["attention"] if a["kind"] == "subject"]
    assert len(subjects) == 1, got["attention"]
    assert "commissions" in subjects[0]["subject"].lower(), subjects[0]


# --- explorer -----------------------------------------------------------------

def test_document_usefulness_comes_from_the_excerpt_verdicts():
    clear()
    for n in range(6):
        answer(f"d{n}", f"q{n}",
               sources=(("Trainings deck", "PKG"), ("SOVOS spec", "PKG")),
               precision_working=[{"n": 1, "useful": False, "reason": ""},
                                  {"n": 2, "useful": True, "reason": ""}])
    docs = {d["title"]: d for d in quality.explorer(ask_store.connect(), now=NOW)["documents"]}
    assert docs["Trainings deck"]["retrieved"] == 6
    assert docs["Trainings deck"]["useful_rate"] == 0.0
    assert docs["Trainings deck"]["noisy"] is True
    assert docs["SOVOS spec"]["useful_rate"] == 1.0
    assert docs["SOVOS spec"]["noisy"] is False


def test_an_unnumbered_excerpt_verdict_is_not_counted_against_anyone():
    clear()
    answer("u", sources=(("A", "PKG"),),
           precision_working=[{"n": None, "useful": False, "reason": ""}])
    doc = quality.explorer(ask_store.connect(), now=NOW)["documents"][0]
    assert doc["judged"] == 0 and doc["useful_rate"] is None, doc


def test_invented_claims_are_grouped_by_meaning():
    clear()
    answer("c1", claims=[
        {"text": "roughly 400000 invoices each month", "supported": False, "reason": "no volume"},
        {"text": "SOVOS signs the invoice", "supported": True, "reason": "stated"}])
    answer("c2", claims=[
        {"text": "roughly 60000 invoices each month", "supported": False, "reason": "no volume"},
        {"text": "DocuSign pushes it through RFC", "supported": False, "reason": "not named"}])
    got = quality.explorer(ask_store.connect(), now=NOW)
    assert got["claim_count"] == 3, "a supported claim was counted as invented"
    groups = got["claims"]
    assert groups[0]["count"] == 2, groups
    assert "invoices" in groups[0]["label"].lower() or "month" in groups[0]["label"].lower()
    assert sorted(groups[0]["run_ids"]) == ["c1", "c2"]


def test_grouping_is_deterministic_and_the_biggest_group_is_zero():
    texts = ["delivery block forecast", "delivery block credit", "billing type italy",
             "delivery block picking"]
    first = quality.cluster(texts, 0.6)
    assert first == quality.cluster(texts, 0.6)
    assert first[0] == 0 and first[1] == 0 and first[3] == 0, first


def test_a_label_names_what_is_distinctive_not_what_is_everywhere():
    texts = ["SPARK delivery block", "SPARK delivery block FC", "SPARK billing type"]
    names = quality.label({0: [0, 1], 1: [2]}, texts)
    assert "SPARK" not in names[0], names
    assert "delivery" in names[0], names


def test_the_explorer_still_works_when_grouping_fails():
    clear()
    answer("g1", "one")
    answer("g2", "two")
    was = quality.EMBED
    try:
        def broken(_texts):
            raise ConnectionError("Ollama is not running")
        quality.EMBED = broken
        quality._vector_cache.clear()
        got = quality.explorer(ask_store.connect(), now=NOW)
    finally:
        quality.EMBED = was
    assert got["subjects"] == [] and "Ollama" in got["subjects_error"], got["subjects_error"]
    assert len(got["points"]) == 2, "losing the grouping lost the answers too"


# --- judge trust --------------------------------------------------------------

def test_kappa_is_zero_for_a_judge_that_always_says_grounded():
    """The case raw agreement flatters: right 90% of the time by never
    committing to anything."""
    pairs = [("grounded", "grounded")] * 9 + [("grounded", "not")]
    assert quality.kappa(pairs) == 0.0


def test_kappa_is_one_for_perfect_agreement():
    pairs = [("grounded", "grounded"), ("partly", "partly"), ("not", "not")] * 3
    assert quality.kappa(pairs) == 1.0


def test_agreement_is_withheld_below_the_minimum_number_of_reviews():
    clear()
    # Mixed verdicts, so a kappa is computable -- with identical ones it is
    # undefined anyway, and the withholding would go untested.
    answer("r0", values=good(faithfulness=0.95), review="grounded")
    answer("r1", values=good(faithfulness=0.2), review="not")
    answer("r2", values=good(faithfulness=0.6), review="grounded")
    assert quality.kappa([("grounded", "grounded"), ("not", "not"),
                          ("partly", "grounded")]) is not None
    got = quality.judge(ask_store.connect(), now=NOW)
    assert got["agreement"]["reviews"] == 3
    assert got["agreement"]["kappa"] is None, "a kappa over three reviews is noise"
    assert got["checked"] is False


def test_the_matrix_puts_the_judge_on_rows_and_the_reviewer_on_columns():
    clear()
    answer("x", values=good(faithfulness=0.95), review="not")
    matrix = quality.judge(ask_store.connect(), now=NOW)["agreement"]["matrix"]
    assert matrix[0][2] == 1, matrix   # judge "grounded", reviewer "not"


def test_disagreements_lead_the_review_queue():
    clear()
    answer("fine", review="grounded")
    answer("wrong", values=good(faithfulness=0.95), review="not")
    for n in range(4):
        answer(f"s{n}")
    queue = quality.judge(ask_store.connect(), now=NOW)["queue"]
    assert queue[0]["run_id"] == "wrong" and queue[0]["kind"] == "disagree", queue[0]
    assert queue[0]["severity"] == "bad"
    assert all(q["kind"] == "sample" for q in queue[1:])
    assert "fine" not in {q["run_id"] for q in queue}, "a reviewed answer was sampled again"


def test_the_sample_is_the_same_all_week():
    clear()
    for n in range(20):
        answer(f"w{n}")
    a = [q["run_id"] for q in quality.judge(ask_store.connect(), now=NOW)["queue"]]
    b = [q["run_id"] for q in quality.judge(ask_store.connect(), now=NOW + timedelta(hours=30))["queue"]]
    assert a == b, "reopening the page reshuffled the review queue"


def test_split_relevance_judges_are_found():
    clear()
    answer("same", relevance=[2, 2])
    answer("split", relevance=[2, 0])
    got = quality.judge(ask_store.connect(), now=NOW)
    assert got["relevance"] == {"pairs": 2, "agree": 1, "rate": 0.5}, got["relevance"]
    assert any(q["run_id"] == "split" and q["kind"] == "relevance_split" for q in got["queue"])


def test_stability_reads_the_last_two_scores_of_one_answer():
    clear()
    answer("st", values=good(faithfulness=0.9))
    conn = ask_store.connect()
    ask_store.finish_evaluation(conn, "st", {
        "status": "done", "judge_model": "j", "overall": 0.6,
        "metrics": {"faithfulness": m(0.6)}})
    got = quality.judge(conn, now=NOW)["stability"]
    assert got["rescored"] == 1 and got["unstable"] == 1, got
    assert abs(got["median"] - 0.3) < 1e-6, got


def test_a_failed_evaluation_does_not_enter_the_history():
    clear()
    answer("h")
    conn = ask_store.connect()
    ask_store.finish_evaluation(conn, "h", {"status": "failed", "error": "timeout"})
    n = conn.execute("SELECT count(*) FROM ask_evaluation_history WHERE run_id='h'").fetchone()[0]
    assert n == 1, "a failed re-score was recorded as a second verdict"


def test_the_dropped_judge_rate_counts_what_did_not_return():
    clear()
    answer("dr", values=good(coherence=None))
    got = quality.judge(ask_store.connect(), now=NOW)
    coherence = next(d for d in got["dropped"] if d["metric"] == "coherence")
    assert coherence["lost"] == 1 and coherence["rate"] == 1.0


# --- reviews ------------------------------------------------------------------

def test_a_second_review_replaces_the_first():
    clear()
    answer("rv")
    conn = ask_store.connect()
    ask_store.save_review(conn, "rv", "grounded")
    ask_store.save_review(conn, "rv", "not", note="the date is invented")
    assert ask_store.get_review(conn, "rv")["verdict"] == "not"
    assert conn.execute("SELECT count(*) FROM ask_reviews").fetchone()[0] == 1


def test_a_review_must_be_one_of_the_three_verdicts():
    clear()
    answer("rv2")
    try:
        ask_store.save_review(ask_store.connect(), "rv2", "maybe")
    except ValueError:
        pass
    else:
        raise AssertionError("an unknown verdict was stored")


def test_deleting_a_question_deletes_its_review_and_history():
    clear()
    answer("gone", review="partly")
    conn = ask_store.connect()
    ask_store.delete_run(conn, "gone")
    assert conn.execute("SELECT count(*) FROM ask_reviews").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM ask_evaluation_history").fetchone()[0] == 0


def test_the_review_endpoint_saves_and_reaches_the_judge_view():
    """Through the HTTP layer, against the throwaway database, with Langfuse
    replaced -- a review is a person's verdict, and a test must not write one
    onto a real trace."""
    from fastapi.testclient import TestClient

    from backend.api import app as server
    from backend.core import tracing

    clear()
    answer("http", values=good(faithfulness=0.95))
    sent = []

    class FakeLangfuse:
        def create_score(self, **kw):
            sent.append(kw)

        def flush(self):
            pass

    real_client = tracing.client
    tracing.client = lambda: FakeLangfuse()
    try:
        from backend.auth import store as auth_store

        conn = ask_store.connect()
        # Signed in as an Admin who owns the question: the review is the
        # owner's to give, and the judge view is an Admin's to read.
        try:
            admin = auth_store.create_user(conn, "quality-admin", "quality-pass", "admin")
        except auth_store.AccountError:
            admin = auth_store.authenticate(conn, "quality-admin", "quality-pass")
        conn.execute("UPDATE ask_runs SET trace_id = 'trace-1', user_id = %s WHERE id = 'http'",
                     (admin["id"],))
        conn.commit()
        c = TestClient(server.app)
        assert c.post("/api/auth/login", json={"username": "quality-admin",
                                               "password": "quality-pass"}).status_code == 200
        assert c.post("/api/ask/runs/http/review", json={"verdict": "maybe"}).status_code == 400
        assert c.post("/api/ask/runs/nope/review", json={"verdict": "not"}).status_code == 404
        r = c.post("/api/ask/runs/http/review", json={"verdict": "not", "note": "invented date"})
        assert r.status_code == 200, r.text
        judged = c.get("/api/quality/judge").json()
        assert judged["agreement"]["reviews"] == 1
        assert judged["queue"][0]["run_id"] == "http" and judged["queue"][0]["kind"] == "disagree"
        assert c.get("/api/ask/runs/http").json()["review"]["verdict"] == "not"
    finally:
        tracing.client = real_client
    assert len(sent) == 1 and sent[0]["name"] == "human_grounded", sent
    assert sent[0]["data_type"] == "CATEGORICAL" and sent[0]["value"] == "not"
    assert sent[0]["trace_id"] == "trace-1"


# --- experiments --------------------------------------------------------------

def _run(exp_id, name, config, items, baseline=False):
    conn = experiment_store.connect()
    experiment_store.start(conn, exp_id, name, config)
    for item in items:
        experiment_store.save_item(conn, exp_id, item)
    experiment_store.finish(conn, exp_id)
    if baseline:
        experiment_store.set_baseline(conn, exp_id)
    return experiment_store.get(conn, exp_id)


def _item(item_id, overall, *, correctness=0.5, titles=("A",), useful=None, tokens=100):
    metrics = {"correctness": m(correctness)}
    if useful is not None:
        metrics["context_precision"] = m(0.5, working={"kind": "excerpts", "items": [
            {"n": n, "useful": u, "reason": ""} for n, u in enumerate(useful, 1)]})
    return {"item_id": item_id, "question": f"question {item_id}",
            "part": quality.part(item_id), "overall": overall, "metrics": metrics,
            "sources": [{"n": n, "title": t, "category": "PKG"} for n, t in enumerate(titles, 1)],
            "input_tokens": tokens, "output_tokens": 0}


def test_a_move_inside_the_noise_band_is_unchanged():
    clear()
    base = _run("b", "base", {"k": 8}, [_item("Q1", 0.80), _item("Q2", 0.80), _item("Q3", 0.80)])
    cand = _run("c", "cand", {"k": 12}, [_item("Q1", 0.83), _item("Q2", 0.60), _item("Q3", 0.95)])
    got = quality.compare(base, cand)
    verdicts = {r["item_id"]: r["verdict"] for r in got["rows"]}
    assert verdicts == {"Q1": "unchanged", "Q2": "regressed", "Q3": "improved"}, verdicts


def test_regressions_sort_first_worst_first():
    clear()
    base = _run("b", "base", {}, [_item("Q1", 0.9), _item("Q2", 0.9), _item("Q3", 0.5)])
    cand = _run("c", "cand", {}, [_item("Q1", 0.8), _item("Q2", 0.3), _item("Q3", 0.9)])
    order = [r["item_id"] for r in quality.compare(base, cand)["rows"]]
    assert order == ["Q2", "Q1", "Q3"], order


def test_the_comparison_names_the_configuration_that_differs():
    clear()
    base = _run("b", "base", {"mode": "hybrid", "k": 8, "prompt_hash": "p"}, [_item("Q1", 0.8)])
    cand = _run("c", "cand", {"mode": "hybrid", "k": 12, "prompt_hash": "p"}, [_item("Q1", 0.8)])
    assert quality.compare(base, cand)["differs"] == ["k"]


def test_why_it_moved_is_read_off_the_excerpts():
    clear()
    base = _run("b", "b", {}, [_item("Q1", 0.9, titles=("A", "B"), useful=[True, True])])
    cand = _run("c", "c", {}, [_item("Q1", 0.4, titles=("A", "C"), useful=[True, False])])
    why = quality.compare(base, cand)["rows"][0]["why"]
    assert "now reads C" in why and "no longer reads B" in why, why
    assert "useful excerpts 2 → 1" in why, why


def test_a_question_missing_from_one_run_is_reported_not_dropped():
    clear()
    base = _run("b", "b", {}, [_item("Q1", 0.8), _item("Q2", 0.8)])
    cand = _run("c", "c", {}, [_item("Q1", 0.8)])
    got = quality.compare(base, cand)
    missing = [r for r in got["rows"] if r["verdict"] == "missing"]
    assert [r["item_id"] for r in missing] == ["Q2"], got["rows"]
    assert missing[0]["missing_from"] == "candidate"


def test_token_change_is_a_ratio():
    clear()
    base = _run("b", "b", {}, [_item("Q1", 0.8, tokens=100)])
    cand = _run("c", "c", {}, [_item("Q1", 0.8, tokens=150)])
    assert quality.compare(base, cand)["tokens"]["change"] == 0.5


def test_there_is_only_ever_one_baseline():
    clear()
    _run("b1", "b1", {}, [], baseline=True)
    _run("b2", "b2", {}, [], baseline=True)
    runs = experiment_store.list_experiments(experiment_store.connect())
    assert [r["id"] for r in runs if r["baseline"]] == ["b2"], runs


def test_the_part_follows_the_evaluation_set():
    assert quality.part("Q7") == "PKG"
    assert quality.part("D3") == "DR"
    assert quality.part("C5") == "PKG+DR"


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    setup()
    failed = 0
    try:
        for fn in tests:
            try:
                fn()
            except Exception as exc:
                failed += 1
                print(f"  FAIL {fn.__name__}: {exc.__class__.__name__}: {exc}")
            else:
                print(f"  ok   {fn.__name__}")
    finally:
        teardown()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
