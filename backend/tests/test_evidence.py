"""Unit tests for the four judgements the Evidence Agent's scores rest on:
provenance, independence, hub filtering and the scoring arithmetic.

Run: python backend/tests/test_evidence.py      (no model calls; the database and
the corpus are read, since that is what these modules are judging).
"""

from __future__ import annotations

import pathlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.graph import knowledge_graph  # noqa: E402

from backend.agents.evidence import agent as ev_agent, independence, paths, provenance, scoring  # noqa: E402
from backend.agents.fitgap import memory as agent_memory  # noqa: E402
from backend.agents.fitgap import trace  # noqa: E402
from backend.agents.evidence.schemas import Answer, Claim, GraphFact, Source  # noqa: E402

MD = "solvay-spark/pkg/markdown/"


def src(cid="1", doc="A", quote="q", stance="supports"):
    return Source(chunk_id=cid, doc=doc, quote=quote, stance=stance)


def retrieved(**docs):
    return {cid: {"source": MD + f, "true_doc": cid, "full_text": "the user creates a sales order"}
            for cid, f in docs.items()}


# --- provenance ---------------------------------------------------------------

def test_a_document_of_screenshots_is_flagged_machine_read():
    p = provenance.of(MD + "Return S4 Selling ECC supplying_docx.md")
    assert p.vlm_images == 12 and p.unreadable_images == 3
    assert p.mostly_machine_read
    assert "mostly_machine_read" in p.flags()


def test_an_email_thread_is_flagged_as_discussion():
    p = provenance.of(MD + "SPARK L2C Interim Process avoid ECC to S4_docx.md")
    assert p.is_discussion and "discussion" in p.flags()


def test_a_written_specification_is_not_flagged_machine_read():
    p = provenance.of(MD + "SPARK_FS_L2C_SPARK -22234-FS_Interface - SOVOS_docx.md")
    assert not p.mostly_machine_read
    assert "discussion" not in p.flags()


def test_the_blank_label_sheet_is_flagged_sparse():
    p = provenance.of(MD + "Manage Text Labels for Billing Form_xlsx.md")
    assert "sparse_table" in p.flags()
    assert p.sparse_ratio > 0.6


def test_the_filled_translation_sheet_is_not_sparse():
    p = provenance.of(MD + "billing_form_translations_html.md")
    assert "sparse_table" not in p.flags()


def test_a_missing_source_file_does_not_raise():
    p = provenance.of(MD + "does-not-exist.md")
    assert not p.exists and p.flags() == []


def test_boilerplate_is_recognised_per_quote():
    assert provenance.is_boilerplate("*Add details on all the other documents/objects*")
    assert provenance.is_boilerplate("|  |  |  |")
    assert provenance.is_boilerplate("")
    assert not provenance.is_boilerplate("The user creates a sales order via VA01")


# --- independence -------------------------------------------------------------

def test_two_versions_of_one_spec_are_one_source():
    d = independence.load()
    pair = ["20251212_SPARK_L2C_SPARK_FS_Enhancement - Item Line Delivery Block (docx)",
            "SPARK_FS_L2C_21930_ Item Line Delivery Block Part 1 (docx)"]
    assert d.independent_count(pair) == 1
    assert "near-identical" in d.note_for(pair)


def test_different_specs_from_one_template_stay_independent():
    # 0.966 cosine on shared boilerplate, but different ticket numbers.
    d = independence.load()
    pair = ["SPARK_FS_L2C_SPARK-21175_Form_Billing Document PDF (docx)",
            "SPARK_FS_L2C_SPARK-49618_Billing Split_Enhancement (docx)"]
    assert d.independent_count(pair) == 2
    assert d.note_for(pair) == ""


def test_unrelated_documents_stay_independent():
    d = independence.load()
    assert d.independent_count(["SPARK L2C Create Billing Types (xlsx)",
                                "SPARK_Interface__L2C_18542_Determine Order Type - FIT (docx)"]) == 2


def test_a_document_is_never_independent_of_itself():
    d = independence.load()
    assert d.independent_count(["X (docx)", "X (docx)"]) == 1


# --- hub filtering ------------------------------------------------------------

def test_a_route_through_a_stream_is_rejected():
    # Salesforce and SOVOS share no document; the only route between them runs
    # through the L2C stream label, which is co-membership, not an interface.
    g = knowledge_graph.extract_graph()
    v = paths.shortest(g, "system:Salesforce", "system:SOVOS")
    assert v and not v.meaningful
    assert "stream" in v.reason.lower()
    assert v.via_label_edges


def test_a_content_derived_route_is_accepted():
    g = knowledge_graph.extract_graph()
    v = paths.shortest(g, "system:eCommerce", "system:S4HANA")
    assert v and v.meaningful and not v.via_label_edges


def test_the_stream_and_the_target_erp_are_hubs():
    g = knowledge_graph.extract_graph()
    labels = {i for i in paths.hubs(g)}
    assert "stream:L2C" in labels
    assert "system:S4HANA" in labels


def test_the_process_register_is_no_longer_a_hub():
    # It used to be the single biggest node in the graph, with one edge per row
    # of its "Lowest Level Key" column -- 502 of them. Those keys are process
    # step identifiers, not functional specs, and now ride on the step as its
    # `jira_key`. The register is an ordinary document again, so a route that
    # passes through it is no longer dismissed as a topology artefact.
    g = knowledge_graph.extract_graph()
    register = next(n for n in g["nodes"] if "L1-L4 Processes" in n["id"])
    assert register["degree"] < paths.HUB_DEGREE
    assert register["id"] not in paths.hubs(g)


# --- scoring ------------------------------------------------------------------

def test_one_source_scores_the_base():
    r = retrieved(**{"1": "SPARK L2C Create Billing Types_xlsx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "B")]), r, independence.load())
    assert c.score == 0.50


def test_a_second_independent_document_is_worth_fifteen_hundredths():
    r = retrieved(**{"1": "SPARK L2C Create Billing Types_xlsx.md",
                     "2": "SPARK_Interface__L2C_18542_Determine Order Type - FIT_docx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "B"), src("2", "C")]), r, independence.load())
    assert c.score == 0.65 and c.independent_sources == 2


def test_a_near_duplicate_buys_nothing():
    a = "20251212_SPARK_L2C_SPARK_FS_Enhancement - Item Line Delivery Block (docx)"
    b = "SPARK_FS_L2C_21930_ Item Line Delivery Block Part 1 (docx)"
    r = {"1": {"source": MD + "20251212_SPARK_L2C_SPARK_FS_Enhancement - Item Line Delivery Block_docx.md",
               "true_doc": a, "full_text": "x"},
         "2": {"source": MD + "SPARK_FS_L2C_21930_ Item Line Delivery Block Part 1_docx.md",
               "true_doc": b, "full_text": "x"}}
    c = scoring.score(Claim(text="x", sources=[src("1", a), src("2", b)]), r, independence.load())
    assert c.score == 0.50, "two copies of one document must not score as two sources"
    assert any(t.rule == "duplicates_discounted" for t in c.score_terms)


def test_a_contradiction_costs_a_quarter():
    r = retrieved(**{"1": "SPARK L2C Create Billing Types_xlsx.md",
                     "2": "SPARK_Interface__L2C_18542_Determine Order Type - FIT_docx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "B"), src("2", "C", stance="opposes")]),
                      r, independence.load())
    assert c.score == 0.25


def test_an_email_is_capped_at_four_tenths():
    r = retrieved(**{"1": "SPARK L2C Interim Process avoid ECC to S4_docx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "E")]), r, independence.load())
    assert c.score == 0.40
    assert any(t.rule == "discussion_only" for t in c.score_terms)


def test_a_transcribed_document_costs_fifteen_hundredths():
    r = retrieved(**{"1": "Return S4 Selling ECC supplying_docx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "V")]), r, independence.load())
    assert c.score == 0.35
    assert any(t.rule == "machine_read" for t in c.score_terms)


def test_a_boilerplate_quote_is_capped():
    r = retrieved(**{"1": "SPARK_FS_Form_Template_docx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "T", "*Add details on the object*")]),
                      r, independence.load())
    assert c.score == 0.30


def test_an_identifier_absent_from_the_evidence_costs_a_tenth():
    r = retrieved(**{"1": "SPARK L2C Create Billing Types_xlsx.md"})
    c = scoring.score(Claim(text="SPARK-99999 does it", sources=[src("1", "B")]),
                      r, independence.load(), ["SPARK-99999"])
    assert c.score == 0.40


def test_a_graph_only_claim_scores_even_when_it_reports_an_artefact():
    # "this route is an artefact" is a sound finding, not an unsupported one.
    c = scoring.score(Claim(text="x", graph_facts=[GraphFact(statement="g", meaningful=False)]),
                      {}, independence.load())
    assert c.score == scoring.GRAPH_ONLY
    assert any(t.rule == "about_a_flagged_route" for t in c.score_terms)


def test_context_only_is_unweighted_not_false():
    r = retrieved(**{"1": "SPARK L2C Create Billing Types_xlsx.md"})
    c = scoring.score(Claim(text="x", sources=[src("1", "B", stance="context")]),
                      r, independence.load())
    assert c.score == scoring.CONTEXT_ONLY


def test_nothing_at_all_scores_zero():
    c = scoring.score(Claim(text="x"), {}, independence.load())
    assert c.score == 0.0


def test_no_claim_is_ever_certain():
    r = {str(i): {"source": MD + f, "true_doc": f, "full_text": "x"} for i, f in enumerate(
        ["SPARK L2C Create Billing Types_xlsx.md",
         "SPARK_Interface__L2C_18542_Determine Order Type - FIT_docx.md",
         "SPARK L2C - Shipto priority_xlsx.md",
         "20260112_SPARK_L2C_Delivery Blocks_xlsx.md",
         "Pricing_xlsx.md"], 0)}
    sources = [src(str(i), f) for i, f in enumerate(r.keys())]
    c = scoring.score(Claim(text="x", sources=sources,
                            graph_facts=[GraphFact(statement="g")]), r, independence.load())
    assert c.score <= scoring.CEILING


# --- the answer contract ------------------------------------------------------

def test_an_asserting_state_needs_a_claim():
    import pydantic
    try:
        Answer(state="supported", claims=[])
    except pydantic.ValidationError as e:
        assert "needs at least one claim" in str(e)
    else:
        raise AssertionError("the empty-claim guard did not fire")


def test_a_claim_needs_evidence():
    import pydantic
    try:
        Answer(state="supported", claims=[Claim(text="unsupported")])
    except pydantic.ValidationError as e:
        assert "no sources" in str(e)
    else:
        raise AssertionError("the no-evidence guard did not fire")


def test_not_in_corpus_needs_no_claim():
    assert Answer(state="not_in_corpus").confidence == 0.0


def test_the_answer_is_capped_at_120_words_not_80():
    # A tighter cap pushed the model into abbreviation-stuffing to fit, which
    # is exactly what the plain-English rules exist to prevent.
    short = Answer(state="not_in_corpus", answer=" ".join(f"w{i}" for i in range(119)))
    assert len(short.answer.split()) == 119 and not short.answer.endswith("\u2026")
    long = Answer(state="not_in_corpus", answer=" ".join(f"w{i}" for i in range(200)))
    assert len(long.answer.split()) == 121 and long.answer.endswith("\u2026")


def test_a_normal_length_answer_is_never_truncated():
    text = ("The documents disagree about the Forecast Check block. Three of them say it "
            "stops a purchase requisition being created. Two say the opposite. One workbook "
            "contradicts itself across its two sheets.")
    assert Answer(state="conflicted", answer=text, claims=[
        Claim(text="x", sources=[src()])]).answer == text


def test_confidence_ignores_unweighted_claims():
    r = retrieved(**{"1": "SPARK L2C Create Billing Types_xlsx.md"})
    d = independence.load()
    a = Answer(state="supported", claims=[
        scoring.score(Claim(text="real", sources=[src("1", "B")]), r, d),
        scoring.score(Claim(text="ctx", sources=[src("1", "B", stance="context")]), r, d),
    ])
    assert len(a.load_bearing) == 1
    assert a.confidence == 0.50, "a context claim must not drag the answer down"


# --- graph scoping -------------------------------------------------------------
# The Evidence Agent reads with the same Session as InsightLens, so its four
# graph tools have to honour the same category scope its retrieval does.
# graph_enumerate is the one that matters most: it produces an exact count,
# and an unscoped count puts documents the run cannot open into a figure the
# answer then quotes.


def _fake_graph():
    nodes = [
        {"id": "system:S", "label": "SAP S/4HANA", "type": "system", "degree": 3},
        {"id": "doc:A", "label": "Package doc", "type": "document", "category": "PKG", "degree": 1},
        {"id": "doc:B", "label": "Design record", "type": "document", "category": "DR", "degree": 1},
        {"id": "doc:C", "label": "Second design record", "type": "document",
         "category": "DR", "degree": 1},
    ]
    edges = [{"id": f"e{i}", "source": d, "target": "system:S",
              "relation": "mentions", "label": ""}
             for i, d in enumerate(("doc:A", "doc:B", "doc:C"))]
    return {"nodes": nodes, "edges": edges,
            "stats": {"sources": "fingerprint-for-the-test",
                      "categories": {"PKG": 1, "DR": 2}}}


def _with_fake_graph(fn):
    from backend.agents.fitgap import tools as ftools
    real = knowledge_graph.extract_graph
    knowledge_graph.extract_graph = _fake_graph
    ftools._scoped_graphs.clear()
    try:
        return fn()
    finally:
        knowledge_graph.extract_graph = real
        ftools._scoped_graphs.clear()


def test_graph_enumerate_counts_only_what_the_run_may_read():
    from backend.agents.fitgap import tools as ftools
    from backend.agents.evidence import agent

    def check():
        assert agent.graph_enumerate(ftools.Session(), "system:S", "document")["count"] == 3
        scoped = agent.graph_enumerate(
            ftools.Session(categories=("PKG",)), "system:S", "document")
        assert scoped["count"] == 1, "a PKG run counted DR documents it cannot open"
        assert [i["label"] for i in scoped["items"]] == ["Package doc"]
    _with_fake_graph(check)


def test_an_exact_count_says_what_it_counted_over():
    from backend.agents.fitgap import tools as ftools
    from backend.agents.evidence import agent

    def check():
        note = agent.graph_enumerate(
            ftools.Session(categories=("PKG",)), "system:S", "document")["note"]
        assert "PKG" in note and "scope of this run" in note
        assert "scope of this run" not in agent.graph_enumerate(
            ftools.Session(), "system:S", "document")["note"]
    _with_fake_graph(check)


def test_a_path_cannot_be_drawn_to_a_node_outside_the_scope():
    from backend.agents.fitgap import tools as ftools
    from backend.agents.evidence import agent

    def check():
        out = agent.graph_path(ftools.Session(categories=("PKG",)), "doc:B", "system:S")
        assert "outside this run's categories" in out["error"]
    _with_fake_graph(check)


# --- the run history ----------------------------------------------------------
#
# An investigation is written down as it happens, so an answer can be gone back
# to. These run against a throwaway database: what is being tested is the
# bookkeeping, not what the agent thinks.

def _with_store(check):
    """A throwaway database with the evidence schema in it."""
    import uuid
    from urllib.parse import urlsplit, urlunsplit
    import psycopg
    from backend.rag import rag
    from backend.agents.evidence import store

    original = rag.base_url
    parts = urlsplit(original())
    name = f"docling_test_ev_{uuid.uuid4().hex[:8]}"
    admin = urlunsplit((parts.scheme, parts.netloc, "/postgres", "", ""))
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    rag.base_url = lambda: urlunsplit((parts.scheme, parts.netloc, f"/{name}", "", ""))
    rag.close()
    try:
        conn = rag.connection(schema=False)
        store.create_schema(conn)
        check(store, conn)
    finally:
        rag.close()
        rag.base_url = original
        with psycopg.connect(admin, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def test_an_investigation_is_recorded_before_it_answers():
    # The row exists from the first moment, so a run whose stream is dropped
    # still leaves a trace of having been asked.
    def check(store, conn):
        store.start_run(conn, {"id": "ev_1", "question": "does it record?", "holdout": False,
                               "categories": [], "model": "m", "prompt_hash": "h",
                               "corpus_fingerprint": "f"})
        run = store.get_run(conn, "ev_1")
        assert run["status"] == "running" and run["answer"] is None
        assert run["question"] == "does it record?"
        assert store.list_runs(conn)[0]["id"] == "ev_1"
    _with_store(check)


def test_the_tool_calls_are_kept_so_a_reopened_run_shows_its_working():
    def check(store, conn):
        store.start_run(conn, {"id": "ev_2", "question": "q", "holdout": False, "categories": [],
                               "model": "m", "prompt_hash": "h", "corpus_fingerprint": "f"})
        calls = [{"tool": "search_corpus", "engine": "rag", "summary": "8 chunks"},
                 {"tool": "graph_entity", "engine": "graph", "summary": "1 node"}]
        store.save_calls(conn, "ev_2", calls)
        store.finish_run(conn, "ev_2", {
            "state": "supported", "answer": "yes", "input_tokens": 10, "output_tokens": 2,
            "seconds": 1.5, "claims": [{"text": "c", "sources": [{"chunk_id": "PKG:1"}]}],
        }, calls)
        run = store.get_run(conn, "ev_2")
        assert run["status"] == "done" and run["state"] == "supported"
        assert [c["tool"] for c in run["calls"]] == ["search_corpus", "graph_entity"]
        row = store.list_runs(conn)[0]
        assert row["tool_calls"] == 2 and row["claims"] == 1 and row["sources"] == 1
    _with_store(check)


def test_a_failed_investigation_is_kept_with_what_it_had_done():
    # What the agent managed to read before it failed is often the whole point
    # of looking again, so a failure is recorded rather than dropped.
    def check(store, conn):
        store.start_run(conn, {"id": "ev_3", "question": "q", "holdout": True, "categories": ["PKG"],
                               "model": "m", "prompt_hash": "h", "corpus_fingerprint": "f"})
        store.fail_run(conn, "ev_3", "RuntimeError: the model refused",
                       [{"tool": "search_corpus", "engine": "rag", "summary": "3 chunks"}])
        run = store.get_run(conn, "ev_3")
        assert run["status"] == "failed"
        assert "refused" in run["error"] and len(run["calls"]) == 1
        assert run["holdout"] is True and run["categories"] == ["PKG"]
    _with_store(check)


def test_a_run_whose_stream_was_dropped_reads_as_abandoned_not_running():
    def check(store, conn):
        store.start_run(conn, {"id": "ev_4", "question": "q", "holdout": False, "categories": [],
                               "model": "m", "prompt_hash": "h", "corpus_fingerprint": "f"})
        conn.execute("UPDATE evidence_runs SET started_at = now() - interval '2 hours'"
                     " WHERE id = 'ev_4'")
        assert store.get_run(conn, "ev_4")["status"] == "abandoned"
        assert store.list_runs(conn)[0]["status"] == "abandoned"
        # The row is not mutated -- it still records that it was interrupted
        # rather than finished.
        assert conn.execute("SELECT status FROM evidence_runs WHERE id = 'ev_4'").fetchone()[0] \
            == "running"
    _with_store(check)


def test_history_is_newest_first_and_deletable():
    def check(store, conn):
        for i, q in enumerate(["first", "second", "third"]):
            store.start_run(conn, {"id": f"ev_{i}", "question": q, "holdout": False,
                                   "categories": [], "model": "m", "prompt_hash": "h",
                                   "corpus_fingerprint": "f"})
            conn.execute("UPDATE evidence_runs SET started_at = now() + make_interval(secs => %s)"
                         " WHERE id = %s", (i, f"ev_{i}"))
        assert [r["question"] for r in store.list_runs(conn)] == ["third", "second", "first"]
        assert store.delete_run(conn, "ev_1") is True
        assert store.delete_run(conn, "ev_1") is False
        assert [r["question"] for r in store.list_runs(conn)] == ["third", "first"]
    _with_store(check)




def test_the_history_is_trimmed_so_traces_do_not_grow_without_bound():
    # A call used to be a summary line. Now it carries the passages that call
    # returned, so a row is kilobytes rather than bytes and the table has to be
    # capped -- oldest first, after each run finishes.
    def check(store, conn):
        for i in range(6):
            store.start_run(conn, {"id": f"ev_t{i}", "question": f"q{i}", "holdout": False,
                                   "categories": [], "model": "m", "prompt_hash": "h",
                                   "corpus_fingerprint": "f"})
        assert store.trim(conn, keep=3) == 3
        kept = [r["id"] for r in store.list_runs(conn)]
        assert len(kept) == 3
        # The newest survive; the oldest go.
        assert "ev_t5" in kept and "ev_t0" not in kept
    _with_store(check)


def test_counting_calls_does_not_drag_every_trace_across_the_wire():
    # list_runs counts calls in SQL. Selecting the column to take its length
    # was free when a call was one line and is not now.
    def check(store, conn):
        store.start_run(conn, {"id": "ev_c", "question": "q", "holdout": False, "categories": [],
                               "model": "m", "prompt_hash": "h", "corpus_fingerprint": "f"})
        big = [{"tool": "search_corpus", "engine": "rag", "summary": "s",
                "trace": {"kind": "rag", "hits": [{"text": "x" * 2000}]}} for _ in range(3)]
        store.save_calls(conn, "ev_c", big)
        assert store.list_runs(conn)[0]["tool_calls"] == 3
        # The full trace is still there when the run itself is opened.
        assert store.get_run(conn, "ev_c")["calls"][0]["trace"]["kind"] == "rag"
    _with_store(check)


# --- the investigation trace ---------------------------------------------------
#
# The log records that a call happened; the trace records what it brought back.
# These check the three things that make it worth keeping: that a retrieval hit
# carries its own text rather than only a pointer to it, that all four graph
# tools come back in one shape the page can draw, and that nothing here can turn
# a working call into a failed one.

def _hit(cid="PKG:412", rank_v=2, rank_k=5):
    return {"chunk_id": cid, "doc": "A spec (docx)", "heading_path": "Scope > Returns",
            "text": "the return is created in S/4HANA", "score": 0.031,
            "vector_rank": rank_v, "keyword_rank": rank_k}


def test_a_retrieval_trace_keeps_the_passage_not_just_its_id():
    # ask_store learned this the hard way: re-indexing renumbers chunks, so a
    # trace that kept only the id would show a different passage next month --
    # or none. The text the agent was given is recorded verbatim.
    t = trace.of("search_corpus", {"query": "returns", "k": 8},
                 {"query": "returns", "results": [_hit(), _hit("DR:7")]})
    assert t["kind"] == "rag" and len(t["hits"]) == 2
    assert t["hits"][0]["text"] == "the return is created in S/4HANA"
    assert t["hits"][0]["rank"] == 1 and t["hits"][1]["rank"] == 2


def test_a_retrieval_trace_carries_both_ranks_behind_the_fusion_score():
    # A hit ranked first overall but fourteenth by vector got there on words.
    # Keeping only the fused score would hide that, which is the one thing a
    # reader checking a suspicious hit actually wants to see.
    t = trace.of("search_corpus", {"query": "O-050-030"},
                 {"results": [_hit(rank_v=14, rank_k=1)]})
    hit = t["hits"][0]
    assert hit["vector_rank"] == 14 and hit["keyword_rank"] == 1 and hit["score"] == 0.031


def test_a_chunk_id_declares_the_store_it_came_from():
    # Chunk ids are prefixed with the category they are filed under, so the
    # panel can say "this came from DR" without a second lookup.
    t = trace.of("search_corpus", {"query": "q"}, {"results": [_hit("DR:88")]})
    assert t["hits"][0]["category"] == "DR"


def test_a_retrieval_trace_is_capped():
    t = trace.of("search_corpus", {"query": "q"},
                 {"results": [_hit(f"PKG:{i}") for i in range(40)]})
    assert len(t["hits"]) == trace.MAX_HITS and t["truncated"] is True


def test_all_four_graph_tools_come_back_in_one_shape():
    # One payload means the page has one graph renderer rather than four, and a
    # node id is a node id whichever tool produced it.
    calls = [
        ("graph_entity", {"text_or_code": "SOVOS"},
         {"matches": [{"node_id": "system:SOVOS", "label": "SOVOS (Tax Engine)", "type": "system"}]}),
        ("graph_neighbors", {"node_id": "system:SOVOS"},
         {"node": {"node_id": "system:SOVOS", "label": "SOVOS", "type": "system"},
          "neighbors": [{"node_id": "doc:a.md", "label": "a", "type": "document", "hops": 1}],
          "edges": [{"edge_id": "e1", "source": "doc:a.md", "target": "system:SOVOS",
                     "relation": "interfaces_with", "label": "Tax Engine Interface"}]}),
        ("graph_path", {"a": "Salesforce", "b": "SOVOS"},
         {"hops": 2, "node_ids": ["system:Salesforce", "doc:a.md", "system:SOVOS"],
          "edge_ids": ["e0", "e1"], "meaningful": True,
          "steps": [{"from": "Salesforce", "relation": "integrates_with", "to": "a"}],
          "note": "every hop is content-derived"}),
        ("graph_enumerate", {"node_id": "system:SOVOS", "type": "document"},
         {"node": {"node_id": "system:SOVOS", "label": "SOVOS", "type": "system"},
          "count": 23, "type_filter": "document",
          "items": [{"node_id": "doc:a.md", "label": "a", "type": "document",
                     "relation": "interfaces_with"}]}),
    ]
    for tool, args, result in calls:
        t = trace.of(tool, args, result, session=None)
        assert t["kind"] == "graph", tool
        assert t["op"] == tool
        assert t["nodes"], f"{tool} produced no nodes"
        for n in t["nodes"]:
            assert n["id"] and n["label"] and n["role"] in ("seed", "path", "match", "neighbour")


def test_a_path_trace_says_where_it_started_and_whether_the_route_is_real():
    # paths.judge decides whether a route is an integration or an artefact of
    # the graph's shape. That verdict has to survive into the panel, or the
    # picture presents a meaningless route as a finding.
    t = trace.of("graph_path", {"a": "A", "b": "B"},
                 {"hops": 4, "node_ids": ["system:A", "stream:L2C", "system:B"],
                  "edge_ids": ["e1"], "meaningful": False,
                  "steps": [], "note": "NOT a real connection"})
    assert t["seeds"] == ["system:A", "system:B"]
    assert t["path"]["meaningful"] is False and "NOT a real" in t["path"]["note"]
    roles = {n["id"]: n["role"] for n in t["nodes"]}
    assert roles["system:A"] == "seed" and roles["stream:L2C"] == "path"


def test_a_node_is_typed_from_its_id_when_the_graph_is_not_to_hand():
    t = trace.of("graph_entity", {"text_or_code": "x"},
                 {"matches": [{"node_id": "proc:O-050-030"}, {"node_id": "spec:SPARK-21265"}]})
    assert [n["type"] for n in t["nodes"]] == ["process", "spec"]


def test_a_bpml_trace_keeps_the_ancestry_so_the_scope_reads_as_a_ladder():
    t = trace.of("get_scope", {"bpml_code": "4.5.2.4"},
                 {"process": {"code": "4.5.2.4", "name": "Validate Order Readiness"},
                  "parent": {"code": "4.5.2", "name": "Manage Orders"},
                  "ancestry": [{"code": "4", "name": "Lead to Cash"},
                               {"code": "4.5", "name": "Manage Sales Orders"}],
                  "children": [{"code": "O-050-030", "name": "Check credit"}]})
    assert t["kind"] == "bpml" and len(t["ancestry"]) == 2 and len(t["children"]) == 1


def test_a_failed_call_has_no_trace_rather_than_an_empty_one():
    # An empty panel reads as "nothing was found"; no panel reads as "this call
    # failed", which is what happened.
    assert trace.of("search_corpus", {"query": "q"}, {"error": "boom"}) is None
    assert trace.of("graph_entity", {"text_or_code": "q"}, {"matches": []}) is None


def test_a_broken_trace_never_breaks_the_run():
    # A trace is a record of what happened. Failing to build one must not turn a
    # successful investigation into a failed one.
    class Exploding(dict):
        def get(self, *a, **k):
            raise RuntimeError("malformed result")

    assert trace.of("search_corpus", {"query": "q"}, Exploding()) is None


def test_an_unknown_tool_contributes_nothing():
    assert trace.of("submit_answer", {}, {"ok": True}) is None


# --- memory -------------------------------------------------------------------
# Memory orients a run and must never ground one. These pin the two places that
# is enforced: what may be written down, and when it may be read at all.


def test_holdout_beats_the_memory_toggle():
    """A holdout run that read memory would be scored on the memory. Both
    directions: it must not read, and it must not write either."""
    assert agent_memory.allowed(True, holdout=False) is True
    assert agent_memory.allowed(True, holdout=True) is False
    assert agent_memory.allowed(False, holdout=False) is False
    assert agent_memory.allowed(False, holdout=True) is False


def test_only_verified_claims_are_remembered():
    """finalise() strips every quote it could not find in the chunk it named,
    so a claim left with no sources is one whose evidence did not hold up.
    Nothing re-checks a memory, so writing that down would be believing it for
    ever."""
    kept = Claim(text="The interface covers 19 tickets.", score=0.75,
                 sources=[src(quote="19 SPARK tickets")])
    dropped = Claim(text="It also covers M3.", score=0.4,
                    sources=[src(quote="a quote that is not in the chunk")])
    answer = Answer(question="Which tickets?", state="supported",
                    answer="Nineteen.", claims=[kept, dropped])
    # How finalise() leaves a claim whose every quote failed verification. It
    # uses model_copy, which does not re-validate -- the schema refuses to
    # BUILD a sourceless claim, so this state only ever arrives that way, and
    # constructing it any other way would test something that cannot happen.
    answer = answer.model_copy(update={
        "claims": [kept, dropped.model_copy(update={"sources": []})]})

    note = ev_agent.worth_remembering(answer)
    assert "19 tickets" in note
    assert "M3" not in note, "a claim whose quotes were all discarded was remembered"


def test_an_absence_is_worth_remembering():
    """'We looked and the corpus does not address this' is the note that stops
    the next run spending its whole budget rediscovering the same absence."""
    answer = Answer(question="Does it cover payroll?", state="not_in_corpus",
                    answer="Nothing in the corpus addresses payroll.",
                    open_questions=["Ask the process lead whether payroll is in scope."])
    note = ev_agent.worth_remembering(answer)
    assert "not_in_corpus" in note
    assert "payroll" in note
    assert "Still open:" in note


def test_the_memory_preface_says_it_is_not_evidence():
    """The agent is told, in the same block, that none of this can be cited.
    The machinery already enforces it; saying so stops the model wasting a
    submission on a quote that will be discarded."""
    note = ev_agent.memory_note([{"text": "The eCommerce spec covers 19 tickets."}])
    assert "NOT" in note and "EVIDENCE" in note
    assert "corpus wins" in note
    assert "19 tickets" in note


def test_a_memory_server_that_is_not_there_is_not_an_error():
    """The server is a separate process and is usually not running. Every call
    has to come back empty rather than raise, or an investigation would depend
    on a daemon that has nothing to do with it."""
    real = agent_memory.URL
    agent_memory.URL = "http://127.0.0.1:9"  # discard port: refuses immediately
    agent_memory._local.__dict__.clear()
    agent_memory._probe = (0.0, False, "")
    try:
        ok, detail = agent_memory.available(force=True)
        assert ok is False and detail, "a dead server reported no reason"
        assert agent_memory.recall("anything") == []
        # The real one: this test is about what the transport does when the
        # server refuses, which the suite-wide stub would hide.
        assert _REAL_RETAIN("anything") is False
        assert agent_memory.stats() == {"memories": 0}
    finally:
        agent_memory.close()
        agent_memory.URL = real


def test_memory_switched_off_asks_nothing_of_the_network():
    """An empty HINDSIGHT_URL means off. It must not fall back to a default and
    start probing a host nobody asked for."""
    real = agent_memory.URL
    agent_memory.URL = ""
    agent_memory._local.__dict__.clear()
    agent_memory._probe = (0.0, False, "")
    try:
        assert agent_memory.configured() is False
        ok, detail = agent_memory.available(force=True)
        assert ok is False and "switched off" in detail
        assert agent_memory.recall("anything") == []
    finally:
        agent_memory.URL = real


# --- the wiring ---------------------------------------------------------------
# The two calls above are only useful if run() actually makes them. These drive
# the real loop with a stubbed model, because the link that was never proved by
# hand is "does the run write anything down at all".


class _FakeAnthropic:
    """A model that submits a fixed answer on its first turn and no tools."""

    def __init__(self, *a, **k):
        self.messages = self

    def create(self, **kwargs):
        import types

        narration = types.SimpleNamespace(type="text",
                                          text="  Nothing left to check. Submitting.  ")
        answer = {"question": "ignored", "state": "not_in_corpus",
                  "answer": "Nothing in the corpus addresses the Zeta interface.",
                  "claims": [],
                  "open_questions": ["Ask whether Zeta is in programme scope."],
                  "limits": []}
        use = types.SimpleNamespace(type="tool_use", name="submit_answer",
                                    id="tu_1", input=answer)
        usage = types.SimpleNamespace(input_tokens=10, output_tokens=5,
                                      cache_read_input_tokens=0,
                                      cache_creation_input_tokens=0)
        return types.SimpleNamespace(content=[narration, use], usage=usage)


# --- reflect ------------------------------------------------------------------
#
# reflect() is the one memory call a person triggers rather than a run, so its
# failures are seen rather than swallowed. These drive it against a stub,
# because the real thing is an LLM call over the whole bank: tens of seconds
# and real money per press, which is not a test.


def _stub_reflect(response=None, raises=None):
    """Put a fake Hindsight in front of reflect(). Returns a restore callable.

    On `_local`, not on the module: the clients are per-thread now, and a stub
    set as a module attribute is simply never read.
    """
    from types import SimpleNamespace

    real = getattr(agent_memory._local, "reflect_client", None)

    def call(**_kw):
        if raises is not None:
            raise raises
        return response

    agent_memory._local.reflect_client = SimpleNamespace(reflect=call)

    def restore():
        if real is None:
            agent_memory._local.__dict__.pop("reflect_client", None)
        else:
            agent_memory._local.reflect_client = real

    return restore


def _reflect_response(facts=(), text="An answer.", query="what did we find"):
    """A reflect response shaped the way the server really sends one.

    The provenance arrives in `trace.tool_calls[].output`, not in `based_on`.
    That field exists, is the obvious one to read, and is always empty here:
    Hindsight's reflect is agentic, so it fetches facts through tool calls
    rather than being handed a set. Reading it returned an answer with no
    sources and no error.
    """
    from types import SimpleNamespace

    call = SimpleNamespace(
        tool="recall",
        input={"query": query},
        output={"results": [{"id": f"m{i}", "text": f"  {t}  ", "fact_type": "world"}
                            for i, t in enumerate(facts)]},
    )
    return SimpleNamespace(
        text=f"  {text}  ",
        based_on=SimpleNamespace(memories=[], mental_models=[], directives=[]),
        trace=SimpleNamespace(tool_calls=[call] if facts or query else [], llm_calls=[]),
        usage=SimpleNamespace(model_dump=lambda: {"input_tokens": 43175, "output_tokens": 2409}),
    )


def test_reflect_takes_its_provenance_from_the_trace():
    """`based_on` is always empty; the facts are in the tool trace.

    Hindsight's own docstring says so -- "based_on: Empty dict (agent
    retrieves facts dynamically)" -- and reading it instead produced an
    answer with no sources and no error, which looks exactly like a server
    that forgot to send them.
    """
    restore = _stub_reflect(_reflect_response(["The spec references 19 tickets."]))
    try:
        out = agent_memory.reflect("anything")
        assert out["error"] == "", out["error"]
        assert out["text"] == "An answer."
        assert out["based_on"] == [
            {"id": "m0", "text": "The spec references 19 tickets.", "type": "world"}
        ], out["based_on"]
        assert out["searched"] == ["what did we find"], out["searched"]
        assert out["usage"]["input_tokens"] == 43175
    finally:
        restore()


def test_reflect_would_find_nothing_in_based_on():
    """The shape of the bug, kept so the fix cannot be undone quietly.

    A response with a populated `based_on` and an empty trace is what the
    first version read. It must still come back with no sources, because that
    is not where the server puts them.
    """
    from types import SimpleNamespace

    response = _reflect_response(query="")
    response.based_on = SimpleNamespace(
        memories=[SimpleNamespace(id="m0", text="x", type="world")],
        mental_models=[], directives=[])
    restore = _stub_reflect(response)
    try:
        assert agent_memory.reflect("anything")["based_on"] == []
    finally:
        restore()


def test_reflect_survives_every_shape_a_tool_returns():
    """lookup, recall, learn and expand do not agree on an output shape."""
    cases = {
        "a bare list": [{"id": "a", "text": "one", "fact_type": "world"}],
        "results": {"results": [{"id": "b", "text": "two", "type": "observation"}]},
        "memories": {"memories": [{"id": "c", "text": "three"}]},
        "facts": {"facts": [{"id": "d", "text": "four"}]},
        "one fact": {"id": "e", "text": "five"},
    }
    for name, output in cases.items():
        found = agent_memory._facts_in(output)
        assert len(found) == 1, f"{name}: {found}"
        assert found[0]["text"] in {"one", "two", "three", "four", "five"}
    # And anything that is not a memory is skipped rather than guessed at.
    for junk in (None, "a string", 7, {"results": [{"id": "f"}]}, {"nothing": 1}):
        assert agent_memory._facts_in(junk) == [], junk


def test_reflect_returns_a_reason_rather_than_a_blank_panel():
    """A person pressed a button and is owed an explanation.

    Unlike recall and retain, which fail silently on purpose because a run
    must survive a memory server that has gone away.
    """
    restore = _stub_reflect(raises=TimeoutError())
    try:
        out = agent_memory.reflect("anything")
        assert out["text"] == ""
        assert out["error"].startswith("TimeoutError"), out["error"]
    finally:
        restore()


def test_each_thread_gets_its_own_memory_client():
    """The client belongs to the thread that made it.

    It wraps an async library whose session is bound to an event loop, so a
    client reused from another thread fails every call with

        RuntimeError: Timeout context manager should be used inside a task

    which available() reports, accurately and uselessly, as the server being
    down. FastAPI runs `def` endpoints on a threadpool: the status endpoint
    answered `available: false` on every thread but one, the memory toggle
    went grey and Ask memory disabled itself, against a healthy server.

    It hid because one thread is the case that works, and a probe, a test and
    a manual check are all one thread.

    This asserts the identity rather than driving a call across threads. The
    behavioural version passed against a deliberately shared client -- whether
    the reuse actually breaks depends on what the loop was doing at the time
    -- and a test that only sometimes notices is worse than the rule written
    down.
    """
    import threading

    mine = agent_memory._get()
    if mine is None:
        return  # hindsight-client is not installed; nothing to be wrong about

    seen: dict[str, object] = {}

    def grab():
        seen["client"] = agent_memory._get()
        seen["reflect"] = agent_memory._get_reflect()

    thread = threading.Thread(target=grab)
    thread.start()
    thread.join()

    assert seen["client"] is not None
    assert seen["client"] is not mine, (
        "two threads share one client; every call on the second one fails "
        "and reads as the memory server being down"
    )
    # The same thread asking twice must not build a new one each time.
    assert agent_memory._get() is mine
    # The long-deadline client is per-thread for the same reason.
    assert seen["reflect"] is not agent_memory._get_reflect()


def test_reflect_refuses_an_empty_question():
    restore = _stub_reflect(_reflect_response())
    try:
        assert agent_memory.reflect("   ")["error"]
    finally:
        restore()


def test_reflect_has_a_longer_deadline_than_the_run_path():
    """Not a style point -- it is why reflect works at all.

    TIMEOUT is 8s because recall and retain sit in front of an investigation.
    Reflect sits in front of a person, reads the whole bank and runs an
    agentic loop; at 8s it times out every time, which is exactly what
    happened the first time it was called.
    """
    assert agent_memory.REFLECT_TIMEOUT > agent_memory.TIMEOUT * 5


def test_reflect_never_reaches_the_agent():
    """Memory orients and cannot ground, and reflect is a summary of summaries.

    The structural guarantee still holds -- nothing recalled or reflected is
    in session.retrieved, so none of it can be cited -- but prose the agent
    cannot check belongs in front of a person who can. If an investigation
    ever starts calling reflect(), this is the check that says so.
    """
    source = (pathlib.Path(__file__).resolve().parents[1] / "agents" / "evidence" / "agent.py").read_text()
    assert "reflect" not in source, "the agent is calling reflect(); see backend/agents/fitgap/memory.py"


def _drive(question, **kw):
    """Run the agent against the fake model, collecting every event."""
    import sys as _sys
    import types

    fake = types.ModuleType("anthropic")
    fake.Anthropic = _FakeAnthropic
    real = _sys.modules.get("anthropic")
    _sys.modules["anthropic"] = fake
    try:
        return list(ev_agent.run(question, **kw))
    finally:
        if real is not None:
            _sys.modules["anthropic"] = real
        else:
            _sys.modules.pop("anthropic", None)


# ═══ THE SUITE MUST NOT WRITE TO THE REAL MEMORY BANK ═══
#
# It did. `retain` was stubbed per-test, by the tests that were about
# retaining, and one that was not -- the log-ordering test -- drove a run with
# memory=True and wrote for real. Every run of this file put two more facts
# about a fabricated "Zeta interface" into the bank the application uses. They
# consolidated, they came back in recalls, and they were indistinguishable
# from findings, because by the time you see them that is exactly what they
# are: things an Evidence Agent run concluded and wrote down.
#
# Deleting them did not help, because the next test run put them straight
# back. Eleven documents' worth accumulated before anyone looked.
#
# So the swap is global and happens at import. A test that wants to see what
# was written asks _capture_retain(); a test that does not care cannot write
# by accident. recall() is deliberately left real: it only reads, and letting
# it talk to a live server is the only thing here that exercises the
# transport.
# ═══ NOR MAY IT ASK THE SCOPE CLASSIFIER ═══
#
# guardrails.scope sends a question it cannot place by keywords to a model.
# Here "the model" is _FakeAnthropic, whose replies are a script for the
# agent: a classifier call would eat the agent's first turn and every test
# after it would be reading the wrong page. The guardrail has suites of its
# own (test_guardrails.py); this one tests the agent behind it.
from backend.agents.guardrails import scope as _scope  # noqa: E402

_scope._classify = lambda text: _scope.Verdict(True, "stub", "test suite: no classifier call")


def test_the_suite_cannot_reach_the_scope_classifier():
    assert _scope._classify("anything").method == "stub"


_retained: list[dict] = []
# Kept so the two tests that are about the transport itself can reach past the
# stub. Nothing else may use it.
_REAL_RETAIN = agent_memory.retain


def _no_write_retain(content, **kw):
    _retained.append({"content": content, **kw})
    return True


agent_memory.retain = _no_write_retain


def _capture_retain():
    """The list retains are recorded into, cleared. See the block above.

    The returned callable used to put the real `retain` back and now does
    nothing, on purpose: restoring it is what let one test write to the bank.
    """
    _retained.clear()
    return _retained, (lambda: None)


def test_the_suite_cannot_write_to_the_real_memory_bank():
    """The guard above, checked -- not the tests that rely on it.

    Every run of this file used to add two facts about a fabricated interface
    to the real bank, from a test that was not about memory at all.
    """
    assert agent_memory.retain is _no_write_retain, (
        "something restored the real retain; this suite writes to the bank the "
        "application reads"
    )


def test_a_run_writes_down_what_it_concluded():
    written, restore = _capture_retain()
    try:
        events = _drive("Does the corpus cover the Zeta interface?", memory=True)
    finally:
        restore()

    kinds = [e for e, _ in events]
    assert kinds[0] == "memory", f"the memory event must come first, got {kinds[:2]}"
    assert "answer" in kinds

    assert len(written) == 1, f"the run wrote {len(written)} memories, expected 1"
    note = written[0]["content"]
    assert "Zeta" in note and "not_in_corpus" in note
    assert "evidence" in written[0]["tags"]
    assert written[0]["metadata"]["state"] == "not_in_corpus"


def test_a_holdout_run_writes_nothing_down_and_says_so():
    written, restore = _capture_retain()
    try:
        events = _drive("Does the corpus cover the Zeta interface?",
                        memory=True, holdout=True)
    finally:
        restore()

    event = next(data for kind, data in events if kind == "memory")
    assert event["enabled"] is True
    assert event["used"] is False
    assert event["suppressed_by_holdout"] is True
    assert event["recalled"] == 0
    assert written == [], "a holdout run wrote its answer into memory"


def test_a_run_with_the_toggle_off_leaves_memory_alone():
    written, restore = _capture_retain()
    try:
        events = _drive("Does the corpus cover the Zeta interface?")
    finally:
        restore()

    event = next(data for kind, data in events if kind == "memory")
    assert event == {"enabled": False, "used": False, "suppressed_by_holdout": False,
                     "recalled": 0, "memories": []}
    assert written == []


# --- the session log ----------------------------------------------------------
# The log is the run as a SEQUENCE. `calls` already said what each tool
# returned; these pin the steps that had no record at all before.


def test_the_run_narrates_before_it_calls_a_tool():
    """The model writes a line beside its tool calls because the prompt asks
    for it. Those blocks always went back into `messages` -- the model saw
    them -- and were dropped everywhere else, so the page could show WHAT was
    called and never WHY."""
    events = _drive("Does the corpus cover the Zeta interface?")
    thinking = [d for k, d in events if k == "thinking"]
    assert thinking, "no reasoning was emitted; the text blocks are being discarded again"
    assert thinking[0]["text"] == "Nothing left to check. Submitting.", "not stripped"
    assert thinking[0]["turn"] == 0


def test_the_prompt_the_agent_received_is_recorded_not_the_one_typed():
    """Between the question and what the model reads sit a scope note and,
    with memory on, a page of recalled notes. A reader who only sees the
    question cannot tell why the agent went where it went."""
    events = _drive("Does the corpus cover the Zeta interface?", categories=["PKG"])
    prompt = next(d for k, d in events if k == "note" and d["kind"] == "prompt")
    assert "Zeta" in prompt["text"]
    assert "PKG" in prompt["text"], "the scope note the model was given is missing"
    assert prompt["detail"]["scope"] == ["PKG"]
    assert prompt["detail"]["characters"] == len(prompt["text"])


def test_the_order_of_the_log_is_the_order_it_happened():
    """A console that shows the tool call before the reasoning that led to it
    is worse than no console."""
    events = _drive("Does the corpus cover the Zeta interface?", memory=True)
    kinds = [k for k, _ in events]
    assert kinds.index("memory") < kinds.index("note"), "context assembled before memory was read"
    assert kinds.index("note") < kinds.index("thinking"), "reasoning before the prompt existed"
    # The run's scores follow the answer they describe.
    assert kinds[-2:] == ["answer", "evaluation"], kinds[-3:]


def test_what_was_written_to_memory_is_in_the_log():
    """Retaining is the one step that changes something outside this run. It
    has to be visible, and it has to be the text that was actually sent."""
    written, restore = _capture_retain()
    try:
        events = _drive("Does the corpus cover the Zeta interface?", memory=True)
    finally:
        restore()
    note = next(d for k, d in events if k == "note" and d["kind"] == "retained")
    assert note["text"] == written[0]["content"], "the log shows something other than what was sent"


# --- traceability (backend/agents/evidence/lineage.py) ----------------------------------------

def _traced_investigation(quote="CPI calls SOVOS over SOAP.", edge="doc:FS->system:SOVOS:interfaces_with"):
    """A stored investigation in miniature: a retrieval, a graph walk, the
    reasoning before each, and an answer of two claims."""
    calls = [
        {"tool": "search_corpus", "engine": "rag", "summary": "2 chunks",
         "trace": {"kind": "rag", "query": "SOVOS interface", "hits": [
             {"rank": 1, "chunk_id": "PKG:1", "score": 0.03, "text": "In step 4, **CPI calls SOVOS** over SOAP."},
             {"rank": 2, "chunk_id": "PKG:2", "score": 0.02, "text": "CPI stores the signed PDF in DMS."}]}},
        {"tool": "graph_neighbors", "engine": "graph", "summary": "1 neighbour",
         "trace": {"kind": "graph",
                   "nodes": [{"id": "doc:FS", "label": "FS"}, {"id": "system:SOVOS", "label": "SOVOS"}],
                   "edges": [{"id": "doc:FS->system:SOVOS:interfaces_with", "source": "doc:FS",
                              "target": "system:SOVOS", "relation": "interfaces_with"}]}},
    ]
    log = [
        {"seq": 0, "kind": "question", "text": "How does SOVOS connect?"},
        {"seq": 1, "kind": "thinking", "text": "Searching for the SOVOS specification."},
        {"seq": 2, "kind": "tool_call", "call": 0, "tool": "search_corpus", "engine": "rag"},
        {"seq": 3, "kind": "thinking", "text": "Checking what the graph links to SOVOS."},
        {"seq": 4, "kind": "tool_call", "call": 1, "tool": "graph_neighbors", "engine": "graph"},
    ]
    answer = {"state": "supported", "answer": "CPI calls SOVOS.", "claims": [
        {"text": "CPI calls SOVOS over SOAP.", "score": 0.6, "independent_sources": 1,
         "score_terms": [{"rule": "base", "delta": 0.5, "detail": "one supporting passage"},
                         {"rule": "graph_corroborates", "delta": 0.1, "detail": "graph agrees"}],
         "sources": [{"chunk_id": "PKG:1", "doc": "FS", "quote": quote, "stance": "supports", "verified": True}],
         "graph_facts": [{"statement": "The FS interfaces with SOVOS.", "node_ids": ["doc:FS", "system:SOVOS"],
                          "edge_ids": [edge]}]},
        {"text": "The signed PDF is stored in DMS.", "score": 0.5, "independent_sources": 1,
         "sources": [{"chunk_id": "PKG:2", "doc": "FS", "quote": "CPI stores the signed PDF in DMS.",
                      "stance": "supports"}]},
    ]}
    return {"id": "ev_trace", "question": "How does SOVOS connect?", "calls": calls, "log": log,
            "answer": answer, "memory": {"used": True, "memories": [{"text": "SOVOS signs invoices.",
                                                                     "type": "world"}]}}


def test_every_passage_and_graph_fact_is_traced_to_its_call():
    from backend.agents.evidence import lineage

    lin = lineage.build(_traced_investigation())
    c1 = lin["claims"][0]
    assert c1["status"] == "traced", c1["checks"]
    assert c1["evidence"][0]["verification"]["status"] == "verbatim"
    assert c1["evidence"][0]["retrievals"][0]["query"] == "SOVOS interface"
    assert c1["graph_facts"][0]["confirmed"] == c1["graph_facts"][0]["total"] == 3
    assert c1["calls"] == [0, 1]
    assert [i["text"] for i in c1["intents"]] == ["Searching for the SOVOS specification.",
                                                  "Checking what the graph links to SOVOS."]
    # The weakest supported claim sets the confidence, and says so.
    assert lin["answer"]["governing"] == "C2" and lin["claims"][1]["governs"]
    assert lin["answer"]["confidence"] == 0.5
    # Memory steered the run; it is reported, and never counted as evidence.
    assert lin["answer"]["memory"]["recalled"][0]["text"] == "SOVOS signs invoices."


def test_a_graph_fact_nobody_looked_up_is_caught():
    from backend.agents.evidence import lineage

    lin = lineage.build(_traced_investigation(edge="doc:FS->system:ARKHINEO:archives_in"))
    c1 = lin["claims"][0]
    assert c1["status"] == "partial"
    assert c1["graph_facts"][0]["confirmed"] == 2 and c1["graph_facts"][0]["total"] == 3
    assert lin["summary"]["graph_facts_confirmed"] == 0


def test_a_quote_the_call_never_returned_is_caught():
    from backend.agents.evidence import lineage

    lin = lineage.build(_traced_investigation(quote="CPI calls SOVOS over REST every hour."))
    assert lin["claims"][0]["evidence"][0]["verification"]["status"] in ("partial", "not_found")
    assert lin["claims"][0]["status"] == "partial"


def test_the_trail_credits_graph_calls_and_the_audit_file_says_so():
    from backend.agents.evidence import lineage

    run = _traced_investigation()
    lin = lineage.build(run)
    calls = {t["call"]: t for t in lin["trail"] if t["kind"] == "tool_call"}
    assert calls[0]["supports"] == ["C1", "C2"] and calls[1]["supports"] == ["C1"]
    md = lineage.to_markdown(run, lin)
    assert "Recalled from earlier investigations (not evidence)" in md
    assert "call 1 `search_corpus`" in md and "3/3 seen in calls" in md


def test_a_stopped_investigation_makes_no_model_call():
    """Stop from the page ends the investigation before its next turn. The
    run no longer ends with its stream, so without this a Stop would leave it
    going -- and billing -- on the server."""
    import threading

    stop = threading.Event()
    stop.set()
    events = _drive("Which middleware carries the Zeta interface?", stop=stop)
    kinds = [k for k, _ in events]
    assert "answer" not in kinds and "tool_call" not in kinds, kinds
    assert kinds[-1] == "error" and "Stopped" in events[-1][1]["message"]


if __name__ == "__main__":
    import traceback

    fns = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in fns:
        try:
            fn()
            print(f"  ok   {name}")
        except Exception:
            failed += 1
            print(f"  FAIL {name}")
            traceback.print_exc()
    # The memory tests open a real HTTP session when a server is up. Without
    # this, aiohttp prints an unclosed-connector warning after the score line,
    # which reads like a failure in the thing being tested.
    agent_memory.close()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
