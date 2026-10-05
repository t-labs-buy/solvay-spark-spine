"""Unit tests for the parts the register's credibility rests on (handover §10):
the verifier, the rubric arithmetic, BPML parsing and holdout masking.

Run: python -m pytest backend/tests/test_fitgap.py -q   (or `python backend/tests/test_fitgap.py`)

Nothing here calls Claude or the database.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.rag import rag  # noqa: E402
from backend.core import uploads  # noqa: E402
from backend.agents.fitgap import bpml, synthesis, tools, verifier  # noqa: E402
from backend.agents.fitgap.schemas import Evidence, FitGapEntry, VerifiedEntry  # noqa: E402


# --- helpers ------------------------------------------------------------------

CHUNK = (
    "## 4.5.1.3 Determine Order Type\n"
    "## 3.4 Dependencies\n"
    "| Sales document type | For sales order creation, sales document type is mandatory | OTC |\n"
    "The user creates a sales order via VA01 and enters an order type."
)


def session_with(chunk_id="4121", text=CHUNK, doc="Spec - FIT (docx)", holdout=False):
    s = tools.Session(holdout=holdout)
    s.retrieved[chunk_id] = {
        "chunk_id": chunk_id, "doc": doc, "full_text": text,
        "true_doc": doc, "true_heading_path": "3.4 Dependencies", "heading_path": "3.4 Dependencies",
    }
    return s


def entry(**kw):
    base = dict(bpml_code="4.5.1.3", step_name="Determine Order Type",
                classification="FIT_CONFIG", confidence=0.5, materiality="high")
    base.update(kw)
    return VerifiedEntry(entry=FitGapEntry(**base))


def ev(quote, chunk_id="4121", supports="for", doc="Spec - FIT (docx)"):
    return Evidence(chunk_id=chunk_id, doc=doc, heading_path="", quote=quote, supports=supports)


# --- quote matching -----------------------------------------------------------

def test_quote_matches_verbatim():
    assert verifier.quote_in_chunk("The user creates a sales order via VA01", CHUNK)


def test_quote_matches_across_whitespace_and_smart_punctuation():
    assert verifier.quote_in_chunk("The  user   creates a sales order via VA01", CHUNK)
    # The agent re-types a straight apostrophe as a curly one, or a hyphen
    # as an en dash. Neither makes the quote invented.
    assert verifier.quote_in_chunk(
        "the user\u2019s order \u2013 mandatory",
        "Before. the user's order - mandatory. After.",
    )


def test_quote_matches_a_table_row_whose_pipes_were_retyped():
    assert verifier.quote_in_chunk("Sales document type For sales order creation", CHUNK)


def test_invented_quote_is_rejected():
    assert not verifier.quote_in_chunk("no development is required for this step", CHUNK)


def test_empty_quote_is_rejected():
    assert not verifier.quote_in_chunk("", CHUNK)


# --- the verifier's repairs ---------------------------------------------------

def test_fabricated_quote_is_dropped_and_the_entry_falls_back_to_unknown():
    s = session_with()
    r = verifier.verify(entry(evidence=[ev("this sentence is not in the chunk")]), s)
    assert r.entry.classification == "UNKNOWN"
    assert r.entry.confidence == 0.0
    assert r.entry.evidence == []
    assert r.repaired
    assert not r.evidence_valid
    assert any(i.code == "quote_not_in_chunk" and i.severity == "hard" for i in r.issues)
    assert "Downgraded to UNKNOWN" in r.entry.rationale


def test_citing_a_chunk_that_was_never_retrieved_is_a_hard_failure():
    s = session_with()
    r = verifier.verify(entry(evidence=[ev("The user creates a sales order via VA01", chunk_id="9999")]), s)
    assert any(i.code == "chunk_not_retrieved" and i.severity == "hard" for i in r.issues)
    assert r.entry.classification == "UNKNOWN"


def test_good_evidence_survives_untouched():
    s = session_with()
    r = verifier.verify(entry(evidence=[ev("The user creates a sales order via VA01")]), s)
    assert r.entry.classification == "FIT_CONFIG"
    assert len(r.entry.evidence) == 1
    assert r.evidence_valid
    assert not r.repaired


def test_the_real_document_name_is_restored_after_a_holdout_run():
    # The agent was shown "Spec - ••• (docx)"; the register must name the file.
    s = session_with(doc="Spec - FIT (docx)", holdout=True)
    r = verifier.verify(
        entry(evidence=[ev("The user creates a sales order via VA01", doc="Spec - ••• (docx)")]), s)
    assert r.entry.evidence[0].doc == "Spec - FIT (docx)"


def test_an_unknown_entry_cannot_keep_a_confidence():
    s = session_with()
    r = verifier.verify(entry(classification="UNKNOWN", confidence=0.0), s)
    assert r.entry.confidence == 0.0


def test_a_ticket_missing_from_the_graph_is_only_a_soft_issue():
    # knowledge_graph.py misses tickets written "L2C_21999"; a hard failure
    # would punish the agent for the extractor's gap.
    s = session_with()
    r = verifier.verify(
        entry(evidence=[ev("The user creates a sales order via VA01")],
              linked_tickets=["SPARK-99999999"]), s)
    assert any(i.code == "ticket_not_in_graph" and i.severity == "soft" for i in r.issues)
    assert r.evidence_valid
    assert r.entry.classification == "FIT_CONFIG"


# --- the §6 confidence rubric -------------------------------------------------

def two_doc_session():
    s = session_with()
    s.retrieved["4200"] = {
        "chunk_id": "4200", "doc": "Second spec (docx)", "full_text": CHUNK,
        "true_doc": "Second spec (docx)", "true_heading_path": "", "heading_path": "",
    }
    return s


def test_one_supporting_source_scores_half():
    s = session_with()
    e = FitGapEntry(bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.5,
                    evidence=[ev("The user creates a sales order via VA01")])
    assert verifier.expected_confidence(e, s) == 0.5


def test_a_second_independent_document_adds_0_15():
    s = two_doc_session()
    e = FitGapEntry(bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.65,
                    evidence=[ev("The user creates a sales order via VA01"),
                              ev("The user creates a sales order via VA01", chunk_id="4200",
                                 doc="Second spec (docx)")])
    assert verifier.expected_confidence(e, s) == 0.65


def test_evidence_against_costs_0_2():
    s = session_with()
    e = FitGapEntry(bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.3,
                    evidence=[ev("The user creates a sales order via VA01"),
                              ev("sales document type is mandatory", supports="against")])
    assert verifier.expected_confidence(e, s) == 0.3


def test_a_code_that_never_appears_verbatim_costs_0_1():
    s = session_with(text="A chunk that never names the step code.")
    s.retrieved["4121"]["full_text"] = "A chunk that never names the step code."
    e = FitGapEntry(bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.4,
                    evidence=[ev("A chunk that never names the step code.")])
    assert verifier.expected_confidence(e, s) == 0.4


def test_transcript_only_evidence_is_capped_at_0_4():
    s = two_doc_session()
    s.retrieved["4121"]["true_doc"] = "L2C workshop transcript (docx)"
    s.retrieved["4200"]["true_doc"] = "WS021 meeting minutes (docx)"
    e = FitGapEntry(
        bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.4,
        evidence=[ev("The user creates a sales order via VA01", doc="L2C workshop transcript (docx)"),
                  ev("The user creates a sales order via VA01", chunk_id="4200",
                     doc="WS021 meeting minutes (docx)")])
    assert verifier.expected_confidence(e, s) == 0.4


def test_confidence_far_from_the_rubric_is_flagged_as_drift():
    s = session_with()
    r = verifier.verify(entry(confidence=0.9,
                              evidence=[ev("The user creates a sales order via VA01"),
                                        ev("sales document type is mandatory")]), s)
    assert any(i.code == "confidence_drift" for i in r.issues)


def test_high_confidence_on_a_single_source_is_capped():
    s = session_with()
    r = verifier.verify(entry(confidence=0.85,
                              evidence=[ev("The user creates a sales order via VA01"),
                                        ev("sales document type is mandatory")]), s)
    # Both quotes come from the same document, so §5's "two independent
    # sources" floor is not met by count alone -- the cap applies on count.
    assert r.entry.confidence <= 0.85


# --- schema floors ------------------------------------------------------------

def test_a_classified_entry_without_evidence_is_rejected_at_submission():
    import pydantic

    try:
        FitGapEntry(bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.5)
    except pydantic.ValidationError as exc:
        assert "at least one piece of evidence" in str(exc)
    else:
        raise AssertionError("the evidence floor did not fire")


def test_unknown_may_have_no_evidence():
    e = FitGapEntry(bpml_code="4.5.1.3", classification="UNKNOWN", confidence=0.0)
    assert e.status == "proposed"


def test_confidence_over_0_7_needs_two_sources():
    import pydantic

    try:
        FitGapEntry(bpml_code="4.5.1.3", classification="FIT_CONFIG", confidence=0.8,
                    evidence=[ev("The user creates a sales order via VA01")])
    except pydantic.ValidationError as exc:
        assert "two pieces of evidence" in str(exc)
    else:
        raise AssertionError("the two-source floor did not fire")


# --- holdout masking (§8.3) ---------------------------------------------------

def test_fit_and_gap_tokens_are_blanked():
    assert tools.mask_label("Determine Order Type - FIT") == "Determine Order Type - •••"
    assert tools.mask_label("3. GAPs - Development") == "3. ••• - Development"
    assert tools.mask_label("Benefits and profit") == "Benefits and profit"  # no false positives


def test_the_register_files_are_excluded():
    assert tools.is_held_out("L2C - Fits.xlsx")
    assert tools.is_held_out("Reports listed as FITs and GAPs L2C (xlsx)")
    assert tools.is_held_out("anything", "pkg/3. GAPs - Development/spec.docx")
    assert not tools.is_held_out("SPARK L2C Pricing (xlsx)", "pkg/markdown/pricing.md")


def test_a_session_masks_only_in_holdout_mode():
    plain, held = tools.Session(), tools.Session(holdout=True)
    assert plain.present("Order Type - FIT") == "Order Type - FIT"
    assert held.present("Order Type - FIT") == "Order Type - •••"
    assert held.masked_docs == {"Order Type - FIT"}


# --- documents attached to a session ------------------------------------------
#
# The isolation, not the storage: these assert the guarantees an analyst is
# relying on when they drop a draft into InsightLens. None of it needs a
# database -- every path below returns before it would reach one.

def test_an_attachment_is_not_in_the_corpus_database_at_all():
    # The isolation is the database boundary, not a filter. The corpus is in
    # DATABASE_URL; a session's schemas are in a database beside it, so there
    # is no WHERE clause that could be got wrong and let one through.
    assert uploads.database_url() != rag.base_url()
    assert uploads.database_url() == rag.sibling_database("SESSION")
    # And nothing can be filed under the category their chunks carry.
    assert uploads.CATEGORY in rag.RESERVED_CODES
    assert uploads.CATEGORY not in rag.known_categories()


def test_a_session_id_must_be_twelve_hex_digits():
    # It reaches SQL inside an identifier -- CREATE SCHEMA "u_<id>" -- which
    # cannot be a bind parameter.
    assert uploads.schema_name("0123456789ab") == "u_0123456789ab"
    assert uploads.check_session("0123456789AB") == "0123456789ab"
    for bad in ("", "short", "0123456789abc", "u_0123456789ab", 'a"; DROP SCHEMA x --',
                "0123456789ag", "../../etc"):
        try:
            uploads.check_session(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} was accepted as a session id")


def test_the_upload_tools_appear_only_when_something_is_attached():
    plain = [t["name"] for t in tools.definitions("A", has_uploads=False)]
    attached = [t["name"] for t in tools.definitions("A", has_uploads=True)]
    assert "search_uploads" not in plain and "upload_entities" not in plain
    assert "search_uploads" in attached and "upload_entities" in attached
    # submit_entry ends the turn, so it stays last whichever list is used.
    assert plain[-1] == "submit_entry" and attached[-1] == "submit_entry"
    assert set(plain) < set(attached)


def test_a_session_without_an_attachment_cannot_read_one():
    plain = tools.Session()
    assert "error" in tools.search_uploads(plain, "anything")
    assert "error" in tools.upload_entities(plain)
    # An uploaded chunk id must not fall through to rag.chunk, which reads the
    # corpus and knows nothing about this session.
    assert "error" in tools.get_chunk(plain, f"{uploads.CATEGORY}:1")


# --- BPML parsing -------------------------------------------------------------

def test_levels_handle_the_trailing_zero_of_a_top_level_process():
    assert bpml.level_of("4.0") == 1
    assert bpml.level_of("4.5") == 2
    assert bpml.level_of("4.5.1") == 3
    assert bpml.level_of("4.5.1.3") == 4


def test_parents_walk_back_up_to_the_root():
    assert bpml.parent_of("4.5.1.3") == "4.5.1"
    assert bpml.parent_of("4.5.1") == "4.5"
    assert bpml.parent_of("4.5") == "4.0"
    assert bpml.parent_of("4.0") is None


def test_codes_sort_numerically_not_alphabetically():
    assert sorted(["4.10", "4.9", "4.1"], key=bpml.sort_key) == ["4.1", "4.9", "4.10"]


def test_lead_to_cash_is_parsed_from_the_sheet():
    if not bpml.stats()["available"]:
        return  # the sheet is not in this checkout; nothing to assert
    l2c = bpml.get("4.0")
    assert l2c and l2c.name == "Lead to Cash" and l2c.level == 1
    assert bpml.get("4.5").parent == "4.0"


def test_a_scope_keeps_level_3_branches_that_have_no_level_4_children():
    if not bpml.stats()["available"]:
        return
    steps = bpml.steps_in_scope("4.0")
    assert steps, "4.0 should yield steps"
    # Every picked step is a leaf or level >= 4 -- never a level-3 branch that
    # was silently dropped because a sibling branch went deeper.
    for s in steps:
        assert s.level >= 4 or not bpml.children(s.code)


# --- synthesis arithmetic -----------------------------------------------------

def make(code, cls, conf, mat="low"):
    kw = dict(bpml_code=code, step_name=code, classification=cls, confidence=conf, materiality=mat)
    if cls != "UNKNOWN":
        # §5 floor: confidence >= 0.7 needs two independent sources.
        kw["evidence"] = [ev("The user creates a sales order via VA01")]
        if conf >= 0.7:
            kw["evidence"].append(
                ev("sales document type is mandatory", chunk_id="4200", doc="Second spec (docx)"))
    return VerifiedEntry(entry=FitGapEntry(**kw))


def test_unknown_is_never_counted_as_a_fit():
    r = synthesis.reuse_assessment([
        make("4.5.1.1", "FIT_CONFIG", 0.6),
        make("4.5.1.2", "GAP_DEVELOPMENT", 0.6),
        make("4.5.1.3", "UNKNOWN", 0.0),
    ])
    assert r["steps"] == 3
    assert r["classified"] == 2
    assert r["reuse_pct"] == 50.0          # 1 of 2 classified, not 1 of 3
    assert round(r["coverage_pct"], 1) == 66.7


def test_the_agenda_weighs_uncertainty_by_materiality():
    sure_and_material = make("4.5.1.1", "FIT_CONFIG", 1.0, "high")
    unsure_and_minor = make("4.5.2.1", "GAP_DEVELOPMENT", 0.0, "low")
    agenda = synthesis.workshop_agenda([sure_and_material, unsure_and_minor])
    # A step everyone is sure about needs no workshop time, however material.
    assert [s["code"] for s in agenda] == ["4.5.2"]
    assert agenda[0]["weight"] == 1.0


def test_the_gap_register_puts_material_uncertainty_first():
    rows = synthesis.gap_register([
        make("4.5.1.1", "GAP_DEVELOPMENT", 0.9, "low"),
        make("4.5.1.2", "GAP_DEVELOPMENT", 0.2, "high"),
        make("4.5.1.3", "FIT_STANDARD", 0.5, "high"),
    ])
    assert [r["bpml_code"] for r in rows] == ["4.5.1.2", "4.5.1.1"]  # fits excluded


# --- graph scoping -------------------------------------------------------------
# Retrieval is scoped to the run's categories; the graph tools were not, so a
# PKG-scoped run's two-hop neighbourhood came back 29 DR nodes to 11 PKG ones.
# Nothing could be cited from them, but the agent was shown documents its own
# retrieval would then refuse to open. These tests hold the scope closed.


def _fake_graph():
    """A corpus graph in miniature: one system both categories mention, one
    document in each, and a process only the DR document reaches."""
    nodes = [
        {"id": "system:S", "label": "SAP S/4HANA", "type": "system", "degree": 3},
        {"id": "doc:A", "label": "Package doc", "type": "document", "category": "PKG", "degree": 1},
        {"id": "doc:B", "label": "Design record", "type": "document", "category": "DR", "degree": 2},
        {"id": "process:P", "label": "Create returns order", "type": "process", "degree": 1},
    ]
    edges = [
        {"id": "e1", "source": "doc:A", "target": "system:S", "relation": "mentions", "label": ""},
        {"id": "e2", "source": "doc:B", "target": "system:S", "relation": "mentions", "label": ""},
        {"id": "e3", "source": "doc:B", "target": "process:P", "relation": "mentions", "label": ""},
    ]
    return {"nodes": nodes, "edges": edges,
            "stats": {"sources": "fingerprint-for-the-test",
                      "categories": {"PKG": 1, "DR": 1}}}


def _with_fake_graph(fn):
    from backend.agents.fitgap import tools as t
    from backend.graph import knowledge_graph
    real = knowledge_graph.extract_graph
    knowledge_graph.extract_graph = _fake_graph
    t._scoped_graphs.clear()
    try:
        return fn()
    finally:
        knowledge_graph.extract_graph = real
        t._scoped_graphs.clear()


def test_a_scoped_run_does_not_traverse_into_another_category():
    def check():
        pkg = tools.graph_neighbors(tools.Session(categories=("PKG",)), "system:S", 1)
        labels = {n["label"] for n in pkg["neighbors"]}
        assert "Package doc" in labels
        assert "Design record" not in labels, "a PKG run reached a DR document through the graph"
    _with_fake_graph(check)


def test_an_unscoped_run_still_sees_the_whole_graph():
    def check():
        both = tools.graph_neighbors(tools.Session(), "system:S", 1)
        assert {n["label"] for n in both["neighbors"]} == {"Package doc", "Design record"}
    _with_fake_graph(check)


def test_a_node_outside_the_scope_says_so_rather_than_looking_missing():
    def check():
        out = tools.graph_neighbors(tools.Session(categories=("PKG",)), "doc:B", 1)
        assert "outside this run's categories" in out["error"]
        assert "PKG" in out["error"]
        # And a name that is in no graph at all still reads as absent.
        assert "not in the graph" in tools.graph_neighbors(
            tools.Session(categories=("PKG",)), "doc:NOPE", 1)["error"]
    _with_fake_graph(check)


def test_scoping_keeps_the_entities_a_kept_document_refers_to():
    """Only documents belong to a category. Cutting the systems and processes
    out with them would leave a run with nothing to resolve a code against."""
    def check():
        found = tools.graph_entity(tools.Session(categories=("PKG",)), "SAP S/4HANA")
        assert [m["node_id"] for m in found["matches"]] == ["system:S"]
        # The DR-only process goes, because no PKG document refers to it.
        assert tools.graph_entity(tools.Session(categories=("PKG",)),
                                  "Create returns order")["matches"] == []
    _with_fake_graph(check)


def test_scoping_does_not_reorder_what_is_left():
    """graph_entity returns the first eight matches, so a re-sorted node list
    silently re-ranks every lookup -- systems fell below documents whose title
    merely contained the word."""
    def check():
        order = [n["id"] for n in tools._graph(tools.Session(categories=("PKG",)))["nodes"]]
        full = [n["id"] for n in _fake_graph()["nodes"]]
        assert order == [i for i in full if i in set(order)]
    _with_fake_graph(check)


# --- a run outlives the tab that started it ----------------------------------

def _live_run(events, owner=7):
    import threading
    from backend.core import live

    return live.start("fitgap", iter(events), owner, threading.Event())


def _drain(run):
    from backend.core import live

    return [e for e in run.follow() if e[0] != live.PING]


def test_a_late_reader_replays_the_run_from_its_first_event():
    from backend.core import live

    events = [("scope", {"run_id": "fg_live000001", "steps": []}),
              ("step_start", {"bpml_code": "1"}), ("done", {"run_id": "fg_live000001"})]
    first = _live_run(events)
    assert _drain(first) == events
    # Reopened after the first stream has gone: the same log, from the top.
    again = live.get("fitgap", "fg_live000001", owner=7)
    assert again is first and _drain(again) == events


def test_someone_elses_live_run_is_not_found_but_an_admin_sees_it():
    from backend.core import live

    _drain(_live_run([("scope", {"run_id": "fg_live000002", "steps": []})], owner=7))
    assert live.get("fitgap", "fg_live000002", owner=8) is None
    assert live.get("fitgap", "fg_live000002", owner=None) is not None


def test_a_run_that_raises_ends_its_stream_with_an_error():
    def events():
        yield "scope", {"run_id": "fg_live000003", "steps": []}
        raise RuntimeError("boom")

    got = _drain(_live_run(events()))
    assert got[-1] == ("error", {"message": "RuntimeError: boom"})


def test_a_quiet_run_sends_keepalives_so_a_proxy_keeps_the_stream_open():
    """One Copilot model turn can run for minutes without an event. Behind the
    deployed app's proxy that silence closed the stream as "network error"."""
    import time

    from backend.core import live

    def events():
        yield "scope", {"run_id": "fg_live000004", "steps": []}
        time.sleep(0.3)
        yield "done", {}

    real, live.PING_SECONDS = live.PING_SECONDS, 0.05
    try:
        got = [e[0] for e in _live_run(events()).follow()]
    finally:
        live.PING_SECONDS = real
    assert got[0] == "scope" and got[-1] == "done" and live.PING in got[1:-1]


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
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)

