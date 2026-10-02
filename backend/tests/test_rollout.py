"""Unit tests for the parts a rollout team's decisions rest on: the scoring
arithmetic, the quality gates, and the invariant that stops a rated alignment
score sitting on top of an empty register.

Run: python backend/tests/test_rollout.py   (or python -m pytest backend/tests/test_rollout.py -q)

Nothing here calls Claude or the database.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pydantic  # noqa: E402

from backend.agents.fitgap import tools as ftools  # noqa: E402
from backend.agents.rollout import gates, scoring, tools as rtools  # noqa: E402
from backend.agents.rollout.schemas import (DEVIATION_TYPES, DIMENSIONS, DISPOSITIONS,  # noqa: E402
                             SUBJECTS,
                             LOCALIZATION_STATES, Analysis, AsIsModel, AsIsStep,
                             BacklogCandidate, Deviation, DimensionRating, Evidence, LocalizationItem,
                             FitArea)


# --- helpers ------------------------------------------------------------------

def dev(**kw) -> Deviation:
    base = dict(
        gap_id="GAP-01", as_is_statement="country does X", gt_statement="template does Y",
        exact_difference="X vs Y", primary_type="BR", dimension="rules",
        localization_state="CORPORATE_POLICY", materiality="High",
        gt_fit_rating=2, harmonization_potential=60,
        candidate_disposition="REQUIRES_DECISION", workshop_bucket="MUST_DISCUSS",
        decision_question="Which one?", workshop_minutes=10,
    )
    base.update(kw)
    return Deviation(**base)


def ev(quote="the quote", side="as_is", cls="E1", chunk="UPLOAD:1") -> Evidence:
    return Evidence(chunk_id=chunk, doc="doc", quote=quote, side=side, evidence_class=cls)


def session_with(*quotes) -> ftools.Session:
    s = ftools.Session()
    for i, q in enumerate(quotes, 1):
        s.retrieved[f"UPLOAD:{i}"] = {"full_text": q}
    return s


def analysis(**kw) -> Analysis:
    base = dict(dimension_ratings=[], deviations=[], fit_areas=[], localization=[], backlog=[])
    base.update(kw)
    return Analysis(**base)


def rate(dimension, gt, bp=None) -> DimensionRating:
    return DimensionRating(dimension=dimension, gt_rating=gt, sap_bp_rating=bp, note="")


# --- the controlled vocabularies ----------------------------------------------

def test_the_specification_taxonomy_is_complete():
    assert len(DEVIATION_TYPES) == 16
    assert len(DISPOSITIONS) == 10
    assert len(LOCALIZATION_STATES) == 6
    assert len(DIMENSIONS) == 7


def test_the_dimension_weights_sum_to_one():
    assert abs(sum(w for _, w in DIMENSIONS.values()) - 1.0) < 1e-9


# --- the invariant that caught a real failure ---------------------------------

def test_a_rated_divergence_must_name_its_deviations():
    # A dimension rated 2 ("moderate deviation") with nothing in the register
    # produces an alignment score that looks measured over a register saying
    # the process matched. This is the exact shape of a real failed run.
    try:
        analysis(dimension_ratings=[rate("governance", 1)])
    except pydantic.ValidationError as exc:
        assert "governance" in str(exc)
    else:
        raise AssertionError("a 1/4 rating with no deviation was accepted")


def test_a_clean_fit_needs_no_deviations():
    a = analysis(dimension_ratings=[rate(d, 4) for d in DIMENSIONS])
    assert scoring.score(a)["gt_alignment"] == 100.0


def test_a_minor_variation_may_stay_out_of_the_register():
    # 3 is "minor variation — standard configuration or local parameter"; it
    # is allowed to be below materiality, unlike 2 and below.
    analysis(dimension_ratings=[rate("reporting", 3)])


# --- the scoring arithmetic (§12) ---------------------------------------------

def test_the_score_is_the_weighted_rating():
    # flow 4/4 at 25%, rules 2/4 at 20%, everything else 4/4.
    ratings = [rate(d, 4) for d in DIMENSIONS if d != "rules"] + [rate("rules", 2)]
    a = analysis(dimension_ratings=ratings, deviations=[dev(dimension="rules")])
    # 0.80 * 100 + 0.20 * 50 = 90
    assert scoring.score(a)["gt_alignment"] == 90.0


def test_an_unrated_dimension_is_dropped_not_counted_as_zero():
    a = analysis(dimension_ratings=[rate("flow", 4), rate("rules", 4)])
    # Only two dimensions rated, both full marks: the answer is 100, not 45.
    assert scoring.score(a)["gt_alignment"] == 100.0


def test_no_rating_at_all_is_not_assessable_rather_than_zero():
    s = scoring.score(analysis())
    assert s["gt_alignment"] is None
    assert s["sap_bp_alignment"] is None


def test_only_confirmed_localization_lifts_the_adjusted_score():
    ratings = [rate(d, 4) for d in DIMENSIONS if d != "rules"] + [rate("rules", 2)]
    # A suspicion must not launder itself into a better score -- that is the
    # exact assumption §5.3 forbids.
    suspected = analysis(dimension_ratings=ratings,
                         deviations=[dev(dimension="rules", localization_state="SUSPECTED")])
    confirmed = analysis(dimension_ratings=ratings,
                         deviations=[dev(dimension="rules", localization_state="CONFIRMED_STATUTORY")])
    assert scoring.score(suspected)["localization_adjusted"] == 90.0
    assert scoring.score(confirmed)["localization_adjusted"] == 100.0


def test_harmonization_is_weighted_by_materiality():
    ratings = [rate(d, 4) for d in DIMENSIONS if d != "rules"] + [rate("rules", 2)]
    a = analysis(dimension_ratings=ratings, deviations=[
        dev(gap_id="GAP-01", dimension="rules", materiality="Critical", harmonization_potential=0),
        dev(gap_id="GAP-02", dimension="rules", materiality="Low", harmonization_potential=100),
    ])
    # (5*0 + 2*100) / 7 = 28.6 -- the critical gap that cannot be harmonised
    # outweighs the low one that can.
    assert scoring.score(a)["harmonization_potential"] == 28.6


def test_harmonization_follows_the_disposition_not_a_guess():
    """Same fit, opposite dispositions: the gap proposed for the template must
    score higher than the one proposed to stay a local exception. The agent's
    own numbers had these backwards (80 and 85)."""
    adopt, _ = scoring.harmonization(dev(candidate_disposition="ADOPT_GT", gt_fit_rating=3,
                                         localization_state="NOT_LOCALIZATION"))
    keep, terms = scoring.harmonization(dev(candidate_disposition="RETAIN_LOCAL_EXCEPTION", gt_fit_rating=3,
                                            localization_state="CORPORATE_POLICY"))
    assert (adopt, keep) == (95, 35)
    assert terms["formula"] == "Keep a local exception 30 · GT fit 3/4 +5 = 35"


def test_a_legal_obligation_caps_harmonization():
    statutory, terms = scoring.harmonization(dev(candidate_disposition="ADOPT_GT", gt_fit_rating=4,
                                                 localization_state="CONFIRMED_STATUTORY"))
    assert statutory == 15 and terms["cap"] == 15 and "capped at 15" in terms["formula"]
    suspected, _ = scoring.harmonization(dev(candidate_disposition="CONFIGURE_STANDARD", gt_fit_rating=2,
                                             localization_state="SUSPECTED"))
    assert suspected == 50
    low, _ = scoring.harmonization(dev(candidate_disposition="EXTEND_STANDARD", gt_fit_rating=0,
                                       localization_state="NOT_LOCALIZATION"))
    assert low == 10


def test_harmonization_is_not_asked_of_the_agent():
    """Hidden from the submit tool's schema, and whatever the agent sends is
    replaced by the computed value."""
    schema = str(Analysis.model_json_schema())
    assert "harmonization_potential" not in schema and "harmonization_terms" not in schema
    a = analysis(deviations=[dev(candidate_disposition="ADOPT_GT", gt_fit_rating=2,
                                 localization_state="NOT_LOCALIZATION", harmonization_potential=5)])
    scoring.apply_harmonization(a)
    assert a.deviations[0].harmonization_potential == 90
    assert a.deviations[0].harmonization_terms["value"] == 90


def test_the_four_score_patterns():
    assert "template review" in scoring._pattern(85, 40)
    assert "closer to SAP standard" in scoring._pattern(40, 85)
    assert scoring._pattern(85, 85).startswith("Strong")
    assert scoring._pattern(None, 80) == ""


def test_the_agenda_puts_legal_blockers_first():
    ratings = [rate(d, 4) for d in DIMENSIONS if d != "rules"] + [rate("rules", 2)]
    a = analysis(dimension_ratings=ratings, deviations=[
        dev(gap_id="GAP-RP", dimension="rules", primary_type="RP", materiality="Low"),
        dev(gap_id="GAP-LC", dimension="rules", primary_type="LC", materiality="Medium"),
        dev(gap_id="GAP-AP", dimension="rules", primary_type="AP", materiality="Critical"),
    ])
    assert [i["gap_id"] for i in scoring.agenda(a)] == ["GAP-LC", "GAP-AP", "GAP-RP"]


def test_the_heatmap_is_built_from_the_register():
    ratings = [rate(d, 4) for d in DIMENSIONS if d != "rules"] + [rate("rules", 2)]
    a = analysis(dimension_ratings=ratings,
                 deviations=[dev(dimension="rules", materiality="Critical")])
    rows = {r["dimension"]: r for r in scoring.heatmap(a)}
    assert rows["rules"]["focus"] == "High" and rows["rules"]["gap_ids"] == ["GAP-01"]
    assert rows["flow"]["focus"] == "None" and rows["flow"]["deviations"] == 0


# --- the quality gates (§25) --------------------------------------------------

def test_an_invented_quote_is_dropped():
    sess = session_with("the delivery is blocked when exposure exceeds the limit")
    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(evidence=[ev("a sentence nobody wrote"),
                                           ev("the delivery is blocked", side="template")])])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert len(out.deviations[0].evidence) == 1
    assert any(i.gate == "QG2" and i.severity == "hard" for i in issues)


def test_a_quote_from_a_chunk_never_retrieved_is_dropped():
    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(evidence=[ev("anything", chunk="PKG:999")])])
    out, issues = gates.check(a, AsIsModel(), ftools.Session(), has_sap_bp_source=False)
    assert out.deviations[0].evidence == []
    assert any("never retrieved" in i.detail for i in issues)


def test_statutory_localization_without_an_explicit_source_is_demoted():
    sess = session_with("the local block applies")
    a = analysis(dimension_ratings=[rate("controls", 2)], deviations=[
        dev(dimension="controls", localization_state="CONFIRMED_STATUTORY",
            evidence=[ev("the local block applies", cls="E3")]),
    ])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert out.deviations[0].localization_state == "SUSPECTED"
    assert any(i.gate == "QG4" for i in issues)


def test_an_extension_without_standard_options_becomes_a_decision():
    sess = session_with("country needs a custom check")
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[
        dev(candidate_disposition="EXTEND_STANDARD", standard_options_considered=[],
            evidence=[ev("country needs a custom check")]),
    ])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert out.deviations[0].candidate_disposition == "REQUIRES_DECISION"
    assert any(i.gate == "QG5" for i in issues)


def test_an_extension_that_shows_its_working_survives():
    sess = session_with("country needs a custom check")
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[
        dev(candidate_disposition="EXTEND_STANDARD",
            standard_options_considered=["SAP credit management configuration cannot hold advances"],
            evidence=[ev("country needs a custom check")]),
    ])
    out, _ = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert out.deviations[0].candidate_disposition == "EXTEND_STANDARD"


def test_an_sap_best_practice_rating_needs_an_sap_source():
    # §26: do not hallucinate SAP functionality. A Best Practice rating with
    # no Best Practice quote behind it is exactly that.
    sess = session_with("country does X")
    a = analysis(dimension_ratings=[rate("rules", 2, bp=3)], deviations=[
        dev(sap_bp_fit_rating=3, evidence=[ev("country does X")]),
    ])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert out.deviations[0].sap_bp_fit_rating is None
    assert out.dimension_ratings[0].sap_bp_rating is None
    assert scoring.score(out)["sap_bp_alignment"] is None
    assert "no SAP Best Practice source" in out.sap_bp_note


def test_a_material_gap_that_loses_all_its_evidence_cannot_keep_a_disposition():
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[
        dev(materiality="Critical", candidate_disposition="ADOPT_GT",
            evidence=[ev("invented", chunk="PKG:404")]),
    ])
    out, issues = gates.check(a, AsIsModel(), ftools.Session(), has_sap_bp_source=False)
    assert out.deviations[0].candidate_disposition == "REQUIRES_DECISION"
    assert out.deviations[0].evidence_confidence == "Low"


def test_one_sided_evidence_on_a_material_gap_is_flagged():
    sess = session_with("country does X")
    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(materiality="High", evidence=[ev("country does X")])])
    _, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert any("only the as_is side" in i.detail for i in issues)


def test_a_backlog_candidate_must_trace_to_a_gap():
    sess = session_with("x")
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[dev(evidence=[ev("x")])],
                 backlog=[BacklogCandidate(title="Build a thing", requirement="r", gap_id="GAP-99")])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)
    assert out.backlog == []
    assert any(i.gate == "QG7" for i in issues)


def test_an_unmapped_as_is_step_is_reported():
    sess = session_with("x")
    asis = AsIsModel(steps=[AsIsStep(step_id="S1", name="one"), AsIsStep(step_id="S2", name="two")])
    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(as_is_step_id="S1", evidence=[ev("x")])])
    _, issues = gates.check(a, asis, sess, has_sap_bp_source=False)
    assert any(i.gate == "QG1" and "S2" in i.detail for i in issues)


# --- the Global Template process is optional ---------------------------------

def test_naming_no_template_process_is_allowed():
    from backend.agents.rollout.orchestrator import _resolve

    assert _resolve("") == (None, "")
    assert _resolve("   ") == (None, "")


def test_a_template_process_that_does_not_resolve_is_still_an_error():
    # A typo must not quietly become "no scope" -- that would analyse against
    # a different process than the one the analyst asked for.
    #
    # The text has no real words in it on purpose: bpml.resolve_scope matches
    # on name as well as code, so a string containing "process" resolves to a
    # real node. That looseness is InsightLens's too, and the page shows what
    # it landed on beside the field.
    from backend.agents.rollout.orchestrator import _resolve

    found, err = _resolve("zzzqqq")
    assert found is None and "does not resolve" in err
    assert "Clear the field" in err


def test_an_unscoped_run_must_say_what_it_compared_against():
    sess = session_with("x")
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[dev(evidence=[ev("x")])])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False, scope_named=False)
    assert any(i.gate == "QG7" and "no stated baseline" in i.detail for i in issues)
    assert out.template_process.startswith("not identified")


def test_an_unscoped_run_that_names_its_baseline_passes():
    sess = session_with("x")
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[dev(evidence=[ev("x")])],
                 template_process="4.5.2 Order Fulfillment")
    _, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False, scope_named=False)
    assert not any("no stated baseline" in i.detail for i in issues)


def test_a_scoped_run_needs_no_template_process_of_its_own():
    sess = session_with("x")
    a = analysis(dimension_ratings=[rate("rules", 2)], deviations=[dev(evidence=[ev("x")])])
    _, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False, scope_named=True)
    assert not any("no stated baseline" in i.detail for i in issues)


def test_a_matched_process_becomes_a_label_that_fits_on_one_line():
    # The agent answers `template_process` with a paragraph. The run history
    # menu gives it one line, so what lands in `scope_label` is the name, not
    # the reasoning behind it.
    from backend.agents.rollout.store import _short_label

    long = ('Global Template: BPML **4.5.2.2 Block Delivery** (L2C > 4.0 Lead to Cash > 4.5 '
            'Manage Sales Orders), equivalent to dash code **O-050-020**. No Global Template '
            'document is attached, so the template side is reconstructed from the corpus.')
    assert _short_label(long) == "Global Template: BPML 4.5.2.2 Block Delivery"

    # No bracket to cut at: trimmed on a word boundary, never mid-word.
    unbracketed = "Global Template " + "process " * 20
    short = _short_label(unbracketed)
    assert len(short) <= 91 and short.endswith("\u2026") and "proces\u2026" not in short

    # A statement that opens with its qualifier keeps enough to be identifiable.
    assert _short_label("(no direct match) 4.3.3 Release or block orders").startswith("(no direct")
    assert _short_label("") == ""


def test_the_trace_headline_reports_the_numbers_the_scorer_actually_produced():
    """The headline is built from `scoring.score`, so it is only as right as
    its key names -- and a wrong key here is silent: it yields a plausible
    zero, not an error. This builds a real scores payload and checks the
    headline against it rather than against remembered key names.

    The first version of `_headline` failed exactly this: it read
    `counts["workshop"]["must"]` and reported 0 must-discuss items on a run
    that had nine."""
    from backend.agents.rollout.orchestrator import _headline

    a = analysis(
        dimension_ratings=[rate("rules", 2)],
        deviations=[dev(materiality="Critical", workshop_bucket="MUST_DISCUSS", evidence=[ev("x")]),
                    dev(materiality="Low", workshop_bucket="CONFIRM", evidence=[ev("x")])],
    )
    scores = scoring.score(a)
    head = _headline(a, scores, {"hard": 0, "soft": 1}, "4.3.3 Something")

    assert head["deviations"] == 2
    # Taken whole from the scorer, so the names cannot drift apart.
    assert head["workshop"] == scores["counts"]["workshop"]
    assert head["workshop"]["MUST_DISCUSS"] == 1
    assert head["workshop_minutes"] == scores["counts"]["workshop_minutes"]
    assert head["by_materiality"] == scores["counts"]["by_materiality"]
    assert head["gt_alignment"] == scores["gt_alignment"]
    assert head["hard_gate_failures"] == 0
    # No value in the headline may be a key that the scorer does not have.
    assert not [k for k, v in head.items() if v is None and k in
                ("workshop", "workshop_minutes", "by_materiality")]


def test_a_gap_decided_twice_counts_once():
    """The decision log is append-only, so clicking Accept three times writes
    three rows. The workshop pack must report one decided gap, not three --
    and must still be able to show that the verdict changed."""
    from backend.agents.rollout.export import _standing

    log = [
        {"gap_id": "GAP-01", "verdict": "accept", "reviewer": "A", "decided_at": "2026-09-22T10:00:00"},
        {"gap_id": "GAP-01", "verdict": "accept", "reviewer": "A", "decided_at": "2026-09-22T10:00:02"},
        {"gap_id": "GAP-02", "verdict": "defer", "reviewer": "B", "decided_at": "2026-09-22T10:01:00"},
        {"gap_id": "GAP-01", "verdict": "reject", "reviewer": "C", "decided_at": "2026-09-22T11:00:00"},
    ]
    standing, superseded = _standing(log)

    assert set(standing) == {"GAP-01", "GAP-02"}
    # The last word on GAP-01 is C's reject, not A's first accept.
    assert standing["GAP-01"]["verdict"] == "reject"
    assert standing["GAP-01"]["reviewer"] == "C"
    assert standing["GAP-02"]["verdict"] == "defer"
    # Nothing is thrown away: both of A's rows survive as history.
    assert len(superseded) == 2
    assert [d["reviewer"] for d in superseded] == ["A", "A"]


def test_the_decision_log_survives_rows_with_no_timestamp():
    # `decided_at` is nullable in the schema; sorting must not raise on it.
    from backend.agents.rollout.export import _standing

    standing, _ = _standing([
        {"gap_id": "G", "verdict": "accept", "reviewer": "A", "decided_at": None},
        {"gap_id": "G", "verdict": "reject", "reviewer": "B", "decided_at": "2026-01-01T00:00:00"},
    ])
    assert standing["G"]["verdict"] == "reject"


# --- analysing something other than a country -------------------------------

BP = SUBJECTS["sap_best_practice"]
COUNTRY = SUBJECTS["country_as_is"]


def test_each_subject_requires_its_own_upload_role():
    # The whole reason the second subject exists: a Best Practice document had
    # to be mis-tagged as a country's As-Is to be analysed at all, which made
    # the agent report SAP's process as a country's own.
    assert COUNTRY.role == "as_is"
    assert BP.role == "sap_bp"


def test_a_best_practice_run_cannot_claim_a_statutory_localization():
    """There is no country in the run, so there is nobody for a legal
    obligation to apply to. The vocabulary still offers the state, so this is
    repaired rather than trusted to the prompt."""
    sess = session_with("x")
    a = analysis(
        dimension_ratings=[rate("rules", 2)],
        deviations=[dev(localization_state="CONFIRMED_STATUTORY", evidence=[ev("x")])],
    )
    a, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=True, subject=BP)

    assert a.deviations[0].localization_state == "NOT_LOCALIZATION"
    assert any("has no country" in i.detail for i in issues)


def test_a_best_practice_run_drops_localization_items():
    from backend.agents.rollout.schemas import LocalizationItem

    sess = session_with("x")
    a = analysis(localization=[LocalizationItem(topic="GST e-way bill", status="Confirmed")])
    a, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=True, subject=BP)

    assert a.localization == []
    assert any("localization item" in i.detail for i in issues)


def test_a_best_practice_run_does_not_rate_itself_against_itself():
    sess = session_with("x")
    a = analysis(
        dimension_ratings=[rate("rules", 2, bp=3)],
        deviations=[dev(sap_bp_fit_rating=2, evidence=[ev("x")])],
    )
    a, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=True, subject=BP)

    assert a.deviations[0].sap_bp_fit_rating is None
    assert a.dimension_ratings[0].sap_bp_rating is None
    # The note has to say why Score B is absent, or a reader assumes the
    # comparison was attempted and came out empty.
    assert "Not applicable" in a.sap_bp_note and "subject of this run" in a.sap_bp_note
    assert any("comparison with itself" in i.detail for i in issues)


def test_score_c_is_not_reported_when_there_is_no_country():
    """Not zero, and not silently equal to Score A -- a number that happens to
    match reads as a second measurement agreeing with the first."""
    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(localization_state="NOT_LOCALIZATION", evidence=[ev("x")])])
    bp = scoring.score(a, BP)
    country = scoring.score(a, COUNTRY)

    assert bp["gt_alignment"] is not None
    assert bp["localization_adjusted"] is None
    assert bp["subject"] == "sap_best_practice"
    assert "does not apply" in bp["formula"]
    # The country reading of the same register still computes Score C.
    assert country["localization_adjusted"] is not None


def test_a_country_run_is_unchanged_by_the_new_subject():
    """The default has to mean exactly what it meant before this existed."""
    sess = session_with("the quote")
    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(localization_state="CORPORATE_POLICY", evidence=[ev("the quote")])])
    a, _ = gates.check(a, AsIsModel(), sess, has_sap_bp_source=False)

    assert a.deviations[0].localization_state == "CORPORATE_POLICY"
    assert scoring.score(a)["localization_adjusted"] is not None


def test_the_two_subjects_do_not_share_a_prompt_hash():
    # A run recorded against a hash that does not describe its instructions
    # cannot be reproduced from the record.
    from backend.agents.rollout import agent

    assert agent.prompt_hash(COUNTRY) != agent.prompt_hash(BP)
    assert agent.prompt_hash() == agent.prompt_hash(COUNTRY)


def test_the_best_practice_prompt_says_there_is_no_country():
    from backend.agents.rollout import agent

    text = agent.system_compare(BP)
    assert "NOT_LOCALIZATION" in text
    assert "no country in this run" in text
    # And it must not still be describing a three-way comparison.
    assert "three-way" not in text.lower()


def test_the_country_prompt_compares_against_the_template_and_sap_best_practice():
    # A country run is a Global Template comparison and an SAP Best Practice
    # comparison of the same As-Is, and the SAP side is read from the corpus.
    from backend.agents.rollout import agent

    text = agent.system_compare(COUNTRY)
    assert "BOTH the Global Template and SAP Best Practice" in text
    assert "search_sap_best_practice" in text
    assert "sap_bp_fit_rating" in text and "sap_bp_rating" in text
    # The Best Practice run has SAP as its subject, not as a third side.
    assert "search_sap_best_practice" not in agent.system_compare(BP)


def test_an_indexed_sap_best_practice_quote_keeps_the_rating_without_an_attachment():
    sess = session_with("country does X")
    sess.retrieved["SAP:7"] = {"full_text": "SAP standard does Z", "category": "SAP"}
    a = analysis(dimension_ratings=[rate("rules", 2, bp=3)], deviations=[
        dev(sap_bp_fit_rating=3, sap_bp_reference="SAP does Z (BKP1)",
            evidence=[ev("country does X"), ev("SAP standard does Z", side="sap_bp", chunk="SAP:7")]),
    ])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=True)
    assert out.deviations[0].sap_bp_fit_rating == 3
    assert out.dimension_ratings[0].sap_bp_rating == 3
    assert not [i for i in issues if i.gate == "QG5"]


def test_a_template_chunk_quoted_as_sap_best_practice_is_dropped():
    # The side is the agent's label. A template chunk passed off as SAP
    # standard would give the template's answer twice under two names.
    sess = session_with("country does X")
    sess.retrieved["PKG:3"] = {"full_text": "template does Y", "category": "PKG"}
    a = analysis(deviations=[
        dev(sap_bp_fit_rating=4,
            evidence=[ev("country does X"), ev("template does Y", side="sap_bp", chunk="PKG:3")]),
    ])
    out, issues = gates.check(a, AsIsModel(), sess, has_sap_bp_source=True)
    assert [e.chunk_id for e in out.deviations[0].evidence] == ["UPLOAD:1"]
    assert out.deviations[0].sap_bp_fit_rating is None
    assert any("not from an SAP Best Practice document" in i.detail for i in issues)


def test_the_sap_best_practice_search_reads_only_the_sap_category():
    seen = {}

    def fake(session, query, k=8, filters=None):
        seen["filters"] = filters
        return {"query": query, "results": [{"chunk_id": "SAP:1", "text": "t"}]}

    real = rtools.ftools.search_corpus
    rtools.ftools.search_corpus = fake
    try:
        out = rtools.search_sap_best_practice(ftools.Session(), "returns approval")
        refused = rtools.search_sap_best_practice(ftools.Session(categories=("PKG",)), "x")
    finally:
        rtools.ftools.search_corpus = real
    assert seen["filters"] == {"categories": ["SAP"]}
    assert out["results"][0]["side"] == "sap_bp"
    assert "error" in refused


def test_an_sap_best_practice_search_leaves_a_trace_the_investigation_can_open():
    """Its calls were stored with an empty trace: the query and the SAP
    passages it returned could not be opened from the Investigation tab or
    the log, and the sources label claimed every category was searched."""
    from backend.agents.fitgap import trace

    args = {"query": "returns order inspection", "k": 2}
    result = {"query": args["query"], "results": [
        {"chunk_id": "SAP:10005645", "doc": "BKP1_CRM", "heading_path": "Process steps",
         "text": "Create Returns Order", "score": 0.03, "side": "sap_bp",
         "side_label": "SAP Best Practice (indexed)"}]}
    t = trace.of("search_sap_best_practice", args, result)
    assert t and t["kind"] == "rag" and t["query"] == "returns order inspection"
    assert t["side"] == "sap_bp" and t["filters"] == {"categories": ["SAP"]}
    assert [h["chunk_id"] for h in t["hits"]] == ["SAP:10005645"]
    assert t["hits"][0]["category"] == "SAP" and t["hits"][0]["text"] == "Create Returns Order"
    src = rtools.describe_sources("search_sap_best_practice", args, result, ftools.Session())
    assert src["searched"] == ["SAP"], src


def test_the_source_note_points_at_indexed_sap_best_practice():
    note = rtools._source_note({"as_is": [{}]}, [{"category": "SAP"}], sap_bp_docs=3)
    assert "search_sap_best_practice" in note
    assert "Do not rate" not in note
    assert "Do not rate" in rtools._source_note({"as_is": [{}]}, [], sap_bp_docs=0)


# --- source traceability -----------------------------------------------------


def _retrieved(cid, doc, category, heading, score, text, uploaded=False):
    rec = {"chunk_id": cid, "true_doc": doc, "category": category,
           "true_heading_path": heading, "score": score, "full_text": text,
           "source": f"/corpus/{doc}.md", "vector_rank": 1, "keyword_rank": 2}
    if uploaded:
        rec["uploaded"] = True
    return rec


def test_the_source_index_says_where_each_finding_came_from():
    from backend.agents.rollout import sources

    a = analysis(
        dimension_ratings=[rate("rules", 2)],
        deviations=[dev(gap_id="GAP-01", evidence=[
            ev("the template says X", side="template", chunk="PKG:12"),
            ev("the country does Y", side="as_is", chunk="UPLOAD:3"),
        ])],
        fit_areas=[FitArea(as_is_step_id="S1", statement="matches",
                           evidence=[ev("same thing", side="template", chunk="PKG:12")])],
    )
    log = {
        "PKG:12": _retrieved("PKG:12", "L2C Billing", "PKG", "Billing / Blocks", 0.031,
                             "the template says X and rather a lot more besides"),
        "UPLOAD:3": _retrieved("UPLOAD:3", "India SOP.docx", "UPLOAD", "Step 3", None,
                               "the country does Y", uploaded=True),
    }
    idx = sources.index(a.model_dump(), AsIsModel().model_dump(), log,
                        upload_names={"India SOP.docx"})

    assert idx["cited_total"] == 2
    pkg = idx["chunks"]["PKG:12"]
    assert pkg["document"] == "L2C Billing"
    assert pkg["category"] == "PKG" and pkg["kind"] == "corpus"
    assert pkg["heading_path"] == "Billing / Blocks"
    assert pkg["score"] == 0.031
    assert "the template says X" in pkg["snippet"]
    # One chunk, cited by two different findings, stored once.
    assert {u["kind"] for u in pkg["used_by"]} == {"deviation", "fit_area"}
    assert {u["ref"] for u in pkg["used_by"]} == {"GAP-01", "S1"}

    up = idx["chunks"]["UPLOAD:3"]
    assert up["kind"] == "upload" and up["category"] == "UPLOAD"

    # And the document roll-up counts citations, not chunks.
    billing = next(d for d in idx["documents"] if d["document"] == "L2C Billing")
    assert billing["chunks"] == 1 and billing["citations"] == 2


def test_an_attachment_is_an_upload_even_when_its_title_is_not_its_file_name():
    """The real shape: the run records the file name ("…Sample.txt") while the
    chunk carries its indexed title ("…Sample_txt") and no `uploaded` flag. The
    reserved UPLOAD category must be enough, or the citation links to a
    knowledge-base file that does not exist."""
    from backend.agents.rollout import sources

    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(gap_id="GAP-01", evidence=[
                     ev("four approval tiers", side="as_is", chunk="UPLOAD:7")])])
    log = {"UPLOAD:7": _retrieved("UPLOAD:7", "India_Returns_Sample_txt", "UPLOAD", "5.3", 0.03,
                                  "four approval tiers")}
    idx = sources.index(a.model_dump(), AsIsModel().model_dump(), log,
                        upload_names={"India_Returns_Sample.txt"})
    assert idx["chunks"]["UPLOAD:7"]["kind"] == "upload"
    assert idx["documents"][0]["kind"] == "upload"


def test_the_index_counts_what_was_read_and_not_used():
    """The gap between retrieved and cited is the honest measure of how much
    the run looked at without relying on: it separates "the corpus does not
    say" from "the agent did not look"."""
    from backend.agents.rollout import sources

    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(evidence=[ev("q", chunk="PKG:1")])])
    log = {f"PKG:{n}": _retrieved(f"PKG:{n}", "doc", "PKG", "h", 0.01, "q") for n in range(1, 8)}
    idx = sources.index(a.model_dump(), AsIsModel().model_dump(), log)

    assert idx["retrieved_total"] == 7
    assert idx["cited_total"] == 1
    assert idx["unused_total"] == 6


def test_a_citation_the_gates_pruned_is_marked_not_guessed_at():
    # The quote gate drops evidence whose chunk this run never retrieved. If
    # one survives into the index anyway, an empty row that looks like a real
    # source is the worst outcome.
    from backend.agents.rollout import sources

    a = analysis(dimension_ratings=[rate("rules", 2)],
                 deviations=[dev(evidence=[ev("q", chunk="GHOST:9")])])
    idx = sources.index(a.model_dump(), AsIsModel().model_dump(), {})

    assert idx["chunks"]["GHOST:9"]["known"] is False
    assert idx["chunks"]["GHOST:9"]["document"] == ""


def test_semantic_accuracy_is_never_claimed_as_checked():
    # A gate that always passes would make the report look better than it is.
    assert any("QG3" in n for n in gates.summarise([])["not_checked"])


# --- the subject decides which documents are the subject -----------------------
# compare_entities asked for role "as_is" whatever the run was about. A Best
# Practice run attaches its document as "sap_bp", so the filter matched nothing
# and the tool returned an empty comparison -- which reads as "no shared
# entities", not as "you asked for the wrong documents". The prompt tells the
# agent to call this, so the blindness was silent.


def _compare_entities_with(subject_key, attached_role):
    """Run the tool against a stub upload store, and report what it asked for."""
    from backend.agents.rollout import tools as rtools
    from backend.core import uploads

    asked = {}

    def fake_compare(sid, roles=None, categories=None):
        asked["roles"] = list(roles or [])
        asked["categories"] = list(categories or [])
        match = not roles or attached_role in roles
        return {"documents": [{"node_id": "doc:subject", "label": "The subject document"}]
                             if match else [],
                "entities": ([{"node_id": "system:S", "type": "system", "label": "SAP S/4HANA",
                               "code": None, "ticket": None, "in_corpus": True,
                               "corpus_documents": ["A template doc"], "corpus_mentions": 1}]
                             if match else []),
                "shared": 1 if match else 0, "new": 0, "scope": list(categories or [])}

    real = uploads.compare
    uploads.compare = fake_compare
    try:
        session = ftools.Session(categories=("PKG",), uploads="sid",
                                 subject_role=SUBJECTS[subject_key].role)
        return rtools.compare_entities(session), asked
    finally:
        uploads.compare = real


def test_compare_entities_asks_for_the_subject_role_not_always_as_is():
    for key, attached in (("country_as_is", "as_is"), ("sap_best_practice", "sap_bp")):
        result, asked = _compare_entities_with(key, attached)
        assert asked["roles"] == [SUBJECTS[key].role], f"{key} asked for {asked['roles']}"
        assert result["subject_documents"] == ["The subject document"], (
            f"{key} found none of its own documents")
        assert result["shared"] == 1


def test_a_best_practice_run_is_not_blind_to_its_own_document():
    """The regression itself: sap_bp attached, as_is requested, nothing found."""
    result, asked = _compare_entities_with("sap_best_practice", "sap_bp")
    assert asked["roles"] != ["as_is"]
    assert result["subject_role"] == "sap_bp"
    assert result["subject_documents"], "the Best Practice document was filtered out"


def test_compare_entities_passes_the_run_scope_to_the_corpus_side():
    """'The corpus already knows this' has to mean the corpus this run reads."""
    _, asked = _compare_entities_with("country_as_is", "as_is")
    assert asked["categories"] == ["PKG"]


def test_a_session_with_no_subject_still_defaults_to_the_country():
    """InsightLens builds sessions without a subject; it only ever has one."""
    from backend.agents.rollout import tools as rtools
    from backend.core import uploads

    asked = {}
    real = uploads.compare
    uploads.compare = lambda sid, roles=None, categories=None: (
        asked.update(roles=list(roles or [])) or
        {"documents": [], "entities": [], "shared": 0, "new": 0, "scope": []})
    try:
        rtools.compare_entities(ftools.Session(uploads="sid"))
    finally:
        uploads.compare = real
    assert asked["roles"] == ["as_is"]




def _with_store(check):
    """A throwaway database with the rollout schema in it.

    The same shape as the Evidence Agent's helper. Rollout's tests had no
    store coverage at all, which is part of why it went this long without
    noticing it kept no investigation log."""
    import uuid
    from urllib.parse import urlsplit, urlunsplit
    import psycopg
    from backend.rag import rag
    from backend.agents.rollout import store

    original = rag.base_url
    parts = urlsplit(original())
    name = f"docling_test_ro_{uuid.uuid4().hex[:8]}"
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


# --- the investigation trace ---------------------------------------------------

def test_every_rollout_tool_is_assigned_an_engine():
    """A tool with no engine falls to "other" and loses its colour and its
    panel. The two lists are written separately, so they can drift."""
    from backend.agents.rollout import tools as rtools

    missing = [name for name in rtools.DISPATCH if name not in rtools.ENGINE_OF]
    assert not missing, f"no engine for: {', '.join(missing)}"


def test_read_sources_traces_carry_the_side_a_passage_came_from():
    """A Rollout answer stands or falls on whether a quote came from the
    country's As-Is or from the Global Template. A panel that does not say
    cannot be used to check one."""
    from backend.agents.fitgap import trace

    t = trace.of("read_sources", {"query": "returns", "side": "as_is"}, {
        "query": "returns", "side": "as_is",
        "results": [{"chunk_id": "UPLOAD:1", "doc": "India As-Is", "heading_path": "",
                     "side": "as_is", "side_label": "Country As-Is",
                     "text": "the clerk raises a credit memo", "score": 0.03}]})
    assert t["kind"] == "rag" and t["side"] == "as_is"
    assert t["hits"][0]["side_label"] == "Country As-Is"
    assert t["hits"][0]["text"]


def test_compare_entities_traces_keep_the_shared_and_new_split():
    """That split is the whole point of the call, so it travels on each node
    rather than being left for the reader to infer."""
    from backend.agents.fitgap import trace

    t = trace.of("compare_entities", {}, {
        "entities": [{"node_id": "system:SOVOS", "type": "system", "label": "SOVOS",
                      "in_corpus": True, "corpus_mentions": 12},
                     {"node_id": "proc:X-1-2", "type": "process", "label": "X-1-2",
                      "in_corpus": False, "corpus_mentions": 0}],
        "shared": 1, "new": 1})
    assert t["kind"] == "graph" and t["shared"] == 1 and t["new"] == 1
    flags = {n["label"]: n["in_corpus"] for n in t["nodes"]}
    assert flags == {"SOVOS": True, "X-1-2": False}


def test_a_rollout_call_event_carries_the_engine_and_the_trace():
    from backend.agents.fitgap.tools import ToolCall
    from backend.agents.rollout.orchestrator import _call_event

    call = ToolCall(name="search_corpus", arguments={"query": "q"}, summary="4 chunks",
                    ms=9, trace={"kind": "rag", "hits": []})
    event = _call_event("compare", call)
    assert event["engine"] == "rag"
    assert event["arguments"] == {"query": "q"}
    assert event["trace"]["kind"] == "rag"
    assert event["stage"] == "compare"


def test_no_contact_detail_is_stored_whatever_the_documents_contained():
    """The HTTP boundary masked contact details on the way out, but the row
    itself held them as the As-Is document wrote them. Read back here as raw
    SQL, so nothing on the read side can hide a leak."""
    mail, phone = "ravi.k@example.com", "+91 98765 43210"

    def check(store, conn):
        store.start_run(conn, {"id": "ro_pii", "subject": "country_as_is", "scope_bpml": "",
                               "scope_label": "", "country": "India",
                               "country_context": f"Escalations to {mail}",
                               "sap_release": "", "gt_version": "", "question": f"Call {phone}",
                               "model": "m", "prompt_hash": "h", "categories": [],
                               "uploads": {}, "corpus_fingerprint": ""})
        store.save_asis(conn, "ro_pii", {"steps": [{"step_id": "IN-RET-030", "actor": f"Supervisor ({mail})"}]})
        store.save_calls(conn, "ro_pii", [{"tool": "read_sources", "trace": {"hits": [
            {"chunk_id": "UPLOAD:19", "text": f"Contact {phone} for approval"}]}}])
        store.save_log(conn, "ro_pii", [{"seq": 0, "kind": "thinking", "text": f"Found {mail}"}])
        store.finish_run(conn, "ro_pii",
                         {"template_process": "4.10.2 Process Returns",
                          "deviations": [{"gap_id": "IN-RET-GAP-01", "as_is_statement": f"Email {mail}",
                                          "evidence": [{"chunk_id": "SAP:10005660", "quote": f"ring {phone}"}]}]},
                         {"gt_alignment": 52.5}, {"items": []}, (1, 1),
                         sources={"chunks": {"UPLOAD:19": {"snippet": f"{mail} / {phone}"}}})
        store.save_decision(conn, "ro_pii", "IN-RET-GAP-01", "A reviewer", "accept", comment=f"ask {mail}")
        row = conn.execute("SELECT row_to_json(r)::text FROM rollout_runs r WHERE id = 'ro_pii'").fetchone()[0]
        row += conn.execute("SELECT string_agg(rationale || ' ' || as_is_statement, ' ')"
                            " FROM workshop_decisions").fetchone()[0]
        assert mail not in row and "98765" not in row, row
        assert "[contact removed]" in row
        # Ids, codes and figures are not contact details and must survive.
        for kept in ("IN-RET-030", "IN-RET-GAP-01", "SAP:10005660", "UPLOAD:19", "4.10.2", "52.5"):
            assert kept in row, kept
    _with_store(check)


def test_the_log_survives_a_reopened_run():
    """Rollout kept none of this: the log streamed to the browser and was gone
    on reload, so a reopened run showed its conclusions with no working."""
    def check(store, conn):
        store.start_run(conn, {"id": "ro_log", "subject": "country_as_is", "scope_bpml": "4.5",
                               "scope_label": "x", "country": "", "country_context": "",
                               "sap_release": "", "gt_version": "", "question": "",
                               "model": "m", "prompt_hash": "h", "categories": [],
                               "uploads": {}, "corpus_fingerprint": ""})
        calls = [{"stage": "compare", "tool": "search_corpus", "engine": "rag",
                  "arguments": {"query": "q"}, "summary": "4 chunks", "ms": 9, "error": None,
                  "sources": {}, "trace": {"kind": "rag", "hits": [{"text": "a passage"}]}}]
        store.save_calls(conn, "ro_log", calls)
        back = store.get_run(conn, "ro_log")["calls"]
        assert len(back) == 1
        assert back[0]["trace"]["hits"][0]["text"] == "a passage"
        assert back[0]["engine"] == "rag"
        # The reasoning and notes are kept beside the calls, for the same reason.
        store.save_log(conn, "ro_log", [{"seq": 0, "kind": "thinking", "text": "Looking for X."}])
        assert store.get_run(conn, "ro_log")["log"][0]["text"] == "Looking for X."
    _with_store(check)


def test_a_pass_reports_its_reasoning_rejections_and_submission():
    """The Investigation log used to show only tool calls: the model's text
    between them was dropped, and a submission rejected and re-made left no
    trace. Driven here by a scripted model, so no real call is made."""
    import types

    import pydantic

    from backend.agents.fitgap import tools as ftools
    from backend.agents.rollout import agent

    class Out(pydantic.BaseModel):
        n: int

    def block(**kw):
        return types.SimpleNamespace(**kw)

    turns = [
        [block(type="text", text="Checking which sources are attached first."),
         block(type="tool_use", id="t1", name="no_such_tool", input={})],
        [block(type="text", text="Submitting."),
         block(type="tool_use", id="t2", name="submit_x", input={"n": "not a number"})],
        [block(type="tool_use", id="t3", name="submit_x", input={"n": 3})],
    ]
    usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)

    class Stream:
        def __init__(self, content):
            self.content = content
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get_final_message(self):
            return types.SimpleNamespace(content=self.content, usage=usage)

    class Client:
        class messages:
            @staticmethod
            def stream(**kw):
                return Stream(turns.pop(0))

    notes, tool_calls = [], []
    real = agent._client
    agent._client = lambda: Client()
    try:
        out, cost = agent._run("sys", "the context", "asis", ftools.Session(), "submit_x", Out,
                               lambda call, stage: tool_calls.append(call.name),
                               lambda kind, data: notes.append((kind, data)))
    finally:
        agent._client = real

    assert out == Out(n=3)
    kinds = [(k, d.get("kind")) for k, d in notes]
    assert kinds[0] == ("note", "prompt") and notes[0][1]["text"] == "the context"
    thinking = [d["text"] for k, d in notes if k == "thinking"]
    assert thinking == ["Checking which sources are attached first.", "Submitting."], thinking
    assert ("note", "rejected") in kinds, "a rejected submission left no trace"
    assert kinds[-1] == ("note", "submitted")
    assert all(d["stage"] == "asis" for _, d in notes)
    assert tool_calls == ["no_such_tool"]


def test_an_sap_rating_without_an_sap_quote_is_sent_back_once():
    """A run rated 12 deviations against SAP and quoted SAP for 5; the gates
    then stripped 7 ratings. The pass now hands such a submission back once,
    while the agent can still search, and accepts the corrected one."""
    import types

    from backend.agents.rollout import agent

    sess = session_with("country does X")
    sess.retrieved["SAP:7"] = {"full_text": "SAP standard does Z", "category": "SAP"}

    def submission(with_quote: bool):
        d = dev(sap_bp_fit_rating=3, evidence=[ev("country does X")]
                + ([ev("SAP standard does Z", side="sap_bp", chunk="SAP:7")] if with_quote else []))
        return analysis(deviations=[d]).model_dump()

    def block(**kw):
        return types.SimpleNamespace(**kw)

    turns = [
        [block(type="tool_use", id="t1", name="submit_analysis", input=submission(False))],
        [block(type="tool_use", id="t2", name="submit_analysis", input=submission(False))],
    ]
    fixed = [[block(type="tool_use", id="t3", name="submit_analysis", input=submission(True))]]
    usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)
    seen = []

    class Stream:
        def __init__(self, content):
            self.content = content
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get_final_message(self):
            return types.SimpleNamespace(content=self.content, usage=usage)

    def client(script):
        class Client:
            class messages:
                @staticmethod
                def stream(**kw):
                    seen.append(kw["messages"][-1])
                    return Stream(script.pop(0))
        return Client()

    notes = []
    real = agent._client
    try:
        # Unfixed twice: sent back once, then accepted -- the gates take over.
        agent._client = lambda: client(turns)
        out, _ = agent._run("sys", "ctx", "compare", sess, "submit_analysis", Analysis, None,
                            lambda kind, data: notes.append(data))
        sent = [n for n in notes if n.get("kind") == "rejected"]
        assert len(sent) == 1 and sent[0]["detail"]["gaps"] == ["GAP-01"], sent
        assert out.deviations[0].sap_bp_fit_rating == 3
        # Fixed on the first try: nothing to send back.
        notes.clear()
        agent._client = lambda: client(fixed)
        out, _ = agent._run("sys", "ctx", "compare", sess, "submit_analysis", Analysis, None,
                            lambda kind, data: notes.append(data))
        assert not [n for n in notes if n.get("kind") == "rejected"]
    finally:
        agent._client = real
    assert agent._unquoted_sap_ratings(Analysis(**submission(True)), sess) == []
    assert agent._unquoted_sap_ratings(Analysis(**submission(False)), sess) == ["GAP-01"]


def test_the_first_pass_keeps_the_documents_own_steps():
    """Three runs on one document gave 14, 15 and 17 steps, and the step count
    drives the Process flow rating -- a quarter of the score. The first pass
    now follows the document's numbering rather than choosing a granularity."""
    from backend.agents.rollout import agent

    for s in SUBJECTS.values():
        text = agent.system_subject(s)
        assert "exactly ONE step per numbered step" in text
        assert "same document must always give the same steps" in text


def test_the_prompts_state_the_limits_the_schema_enforces():
    # Stated from the schema, so the prompt cannot drift from the check that
    # sends a submission back.
    from backend.agents.rollout import agent

    assert agent.QUOTE_MAX == 400 and agent.HEADLINE_MAX == 600
    for s in SUBJECTS.values():
        for text in (agent.system_subject(s), agent.system_compare(s)):
            assert f"at most {agent.QUOTE_MAX} characters" in text
            assert f"at most {agent.HEADLINE_MAX} characters" in text


def test_a_deviation_with_no_as_is_step_is_sent_back_once():
    """Four runs of six left as_is_step_id empty on every deviation, and the
    Process alignment tab then placed none of them. The ids are the run's own
    -- "5.10" here, taken from the document's numbering."""
    import types

    from backend.agents.rollout import agent

    steps = ["5.1", "5.2", "5.10"]
    a = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.10"),
                             dev(gap_id="G2", as_is_step_id="5.1 / 5.2"),
                             dev(gap_id="G3", as_is_step_id=""),
                             dev(gap_id="G4", as_is_step_id="5.99")])
    assert agent._unplaced_deviations(a, steps) == ["G3", "G4"]
    assert agent._unplaced_deviations(a, None) == []

    def block(**kw):
        return types.SimpleNamespace(**kw)

    def sub(ref):
        return analysis(deviations=[dev(gap_id="G1", as_is_step_id=ref)]).model_dump()

    turns = [[block(type="tool_use", id="t1", name="submit_analysis", input=sub(""))],
             [block(type="tool_use", id="t2", name="submit_analysis", input=sub("5.2"))]]
    usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)

    class Stream:
        def __init__(self, content):
            self.content = content
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get_final_message(self):
            return types.SimpleNamespace(content=self.content, usage=usage)

    class Client:
        class messages:
            @staticmethod
            def stream(**kw):
                return Stream(turns.pop(0))

    notes = []
    real = agent._client
    agent._client = lambda: Client()
    try:
        out, _ = agent._run("sys", "ctx", "compare", ftools.Session(), "submit_analysis", Analysis,
                            None, lambda kind, data: notes.append(data), step_ids=steps)
    finally:
        agent._client = real
    sent = [n for n in notes if n.get("kind") == "rejected"]
    assert len(sent) == 1 and sent[0]["detail"]["unplaced"] == ["G1"], sent
    assert "'5.1'" in sent[0]["text"]
    assert out.deviations[0].as_is_step_id == "5.2"


def test_the_comparison_prompt_asks_for_the_as_is_step():
    from backend.agents.rollout import agent

    assert "Set its as_is_step_id" in agent.system_compare(SUBJECTS["country_as_is"])
    assert agent.MAX_TOOL_CALLS["asis"] >= 20 and agent.MAX_INPUT_TOKENS >= 150_000


def test_a_step_named_among_several_counts_as_covered():
    """QG1 compared the whole as_is_step_id, so "5.1, 5.14" covered neither 5.1
    nor 5.14 and a fully mapped run was reported as three steps short."""
    from backend.agents.rollout.schemas import step_refs

    assert step_refs("5.1, 5.14") == {"5.1", "5.14"}
    assert step_refs("(5.3); IN-RET-030 / 5.4.") == {"5.3", "IN-RET-030", "5.4"}
    asis = AsIsModel(steps=[AsIsStep(step_id=i, name=i) for i in ("5.1", "5.13", "5.14")])
    a = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1, 5.14"),
                             dev(gap_id="G2", as_is_step_id="5.13, 5.14")])
    _, issues = gates.check(a, asis, session_with(), has_sap_bp_source=False)
    assert not [i for i in issues if i.gate == "QG1"], issues


def test_a_localization_deviation_needs_an_advisory_item():
    from backend.agents.rollout import agent

    flagged = analysis(deviations=[dev(gap_id="G1", localization_state="SUSPECTED"),
                                   dev(gap_id="G2", localization_state="LOCAL_PREFERENCE")])
    assert agent._unadvised_localization(flagged) == ["G1"]
    advised = analysis(deviations=flagged.deviations, localization=[
        LocalizationItem(topic="e-way bill", status="Candidate")])
    assert agent._unadvised_localization(advised) == []
    assert "add an item to the localization" in agent.system_compare(SUBJECTS["country_as_is"])


def test_too_few_sap_searches_are_sent_back_while_there_is_budget():
    """Runs searched SAP Best Practice twice for a fourteen-step process, the
    instruction to search per stage notwithstanding."""
    import types

    from backend.agents.rollout import agent

    def block(**kw):
        return types.SimpleNamespace(**kw)

    ok = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1")]).model_dump()
    turns = [
        [block(type="tool_use", id="t1", name="submit_analysis", input=ok)],
        [block(type="tool_use", id="t2", name="search_sap_best_practice", input={"query": "q"})],
        [block(type="tool_use", id="t3", name="submit_analysis", input=ok)],
    ]
    usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)

    class Stream:
        def __init__(self, content):
            self.content = content
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get_final_message(self):
            return types.SimpleNamespace(content=self.content, usage=usage)

    class Client:
        class messages:
            @staticmethod
            def stream(**kw):
                return Stream(turns.pop(0))

    notes = []
    real_client, real_search = agent._client, agent.tools.DISPATCH["search_sap_best_practice"]
    agent._client = lambda: Client()
    agent.tools.DISPATCH["search_sap_best_practice"] = lambda session, **kw: {"results": []}
    try:
        out, _ = agent._run("sys", "ctx", "compare", ftools.Session(), "submit_analysis", Analysis,
                            None, lambda kind, data: notes.append(data), step_ids=["5.1"],
                            min_sap_searches=1)
    finally:
        agent._client = real_client
        agent.tools.DISPATCH["search_sap_best_practice"] = real_search
    sent = [n for n in notes if n.get("kind") == "rejected"]
    assert len(sent) == 1 and "SAP Best Practice search" in sent[0]["title"], sent
    assert out is not None and not turns


def _scripted_client(turns, seen=None):
    """A client whose stream() plays back `turns`: (content, stop_reason) pairs."""
    import types

    usage = types.SimpleNamespace(input_tokens=10, output_tokens=5)

    class Stream:
        def __init__(self, turn):
            self.turn = turn
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get_final_message(self):
            content, stop = self.turn
            return types.SimpleNamespace(content=content, usage=usage, stop_reason=stop)

    class Client:
        class messages:
            @staticmethod
            def stream(**kw):
                if seen is not None:
                    seen.append([dict(m) for m in kw["messages"]])
                return Stream(turns.pop(0))

    return Client()


def test_a_submission_cut_off_at_the_output_limit_is_not_accepted():
    """Three submit_analysis calls in one run stopped at max_tokens. The SDK
    parses streamed tool input leniently, so the cut-off register arrived as
    a valid one without its backlog and open questions -- and was accepted.
    A cut-off call is now sent back, and kept in the history only as an
    outline."""
    import types

    from backend.agents.rollout import agent

    def block(**kw):
        return types.SimpleNamespace(**kw)

    whole = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1")],
                     open_questions=["Who issues the e-way bill?"]).model_dump()
    cut = {k: v for k, v in whole.items() if k not in ("backlog", "open_questions")}
    turns = [([block(type="tool_use", id="t1", name="submit_analysis", input=cut)], "max_tokens"),
             ([block(type="tool_use", id="t2", name="submit_analysis", input=whole)], "tool_use")]
    seen, notes = [], []
    real = agent._client
    agent._client = lambda: _scripted_client(turns, seen)
    try:
        out, _ = agent._run("sys", "ctx", "compare", ftools.Session(), "submit_analysis", Analysis,
                            None, lambda kind, data: notes.append(data), step_ids=["5.1"])
    finally:
        agent._client = real
    assert out is not None and out.open_questions == ["Who issues the e-way bill?"]
    assert [n for n in notes if n.get("kind") == "rejected" and "output limit" in n["title"]]
    # The second request carries the cut-off call as an outline, not in full.
    kept = seen[1][-2]["content"][0]
    assert kept["id"] == "t1" and "_omitted" in kept["input"]
    assert kept["input"]["deviations"][0]["gap_id"] == "G1"
    assert "output limit" in seen[1][-1]["content"][0]["content"]

    # Cut off every time: the pass fails rather than publish part of a register.
    turns[:] = [([block(type="tool_use", id=f"c{i}", name="submit_analysis", input=cut)],
                 "max_tokens") for i in range(agent.MAX_CUT_OFFS)]
    agent._client = lambda: _scripted_client(turns)
    try:
        out, _ = agent._run("sys", "ctx", "compare", ftools.Session(), "submit_analysis", Analysis,
                            None, step_ids=["5.1"])
    finally:
        agent._client = real
    assert out is None and not turns


def test_a_schema_error_and_a_content_check_are_sent_back_together():
    """A headline over its limit was sent back on its own; the missing SAP
    searches surfaced only on the next submission -- two full rewrites of the
    register where one would have done."""
    import types

    from backend.agents.rollout import agent

    def block(**kw):
        return types.SimpleNamespace(**kw)

    good = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1")]).model_dump()
    long = {**good, "headline": "x" * (agent.HEADLINE_MAX + 1)}
    turns = [
        ([block(type="tool_use", id="t1", name="submit_analysis", input=long)], "tool_use"),
        ([block(type="tool_use", id="t2", name="search_sap_best_practice", input={"query": "q"})],
         "tool_use"),
        ([block(type="tool_use", id="t3", name="submit_analysis", input=good)], "tool_use"),
    ]
    seen, notes = [], []
    real_client, real_search = agent._client, agent.tools.DISPATCH["search_sap_best_practice"]
    agent._client = lambda: _scripted_client(turns, seen)
    agent.tools.DISPATCH["search_sap_best_practice"] = lambda session, **kw: {"results": []}
    try:
        out, _ = agent._run("sys", "ctx", "compare", ftools.Session(), "submit_analysis", Analysis,
                            None, lambda kind, data: notes.append(data), step_ids=["5.1"],
                            min_sap_searches=1)
    finally:
        agent._client = real_client
        agent.tools.DISPATCH["search_sap_best_practice"] = real_search
    sent = [n for n in notes if n.get("kind") == "rejected"]
    assert len(sent) == 1, sent
    assert "headline" in sent[0]["text"] and "SAP Best Practice" in sent[0]["text"]
    assert out is not None and not turns
    # The rejected register is outlined in the history, not replayed in full.
    assert "_omitted" in seen[1][-2]["content"][0]["input"]


def test_an_amend_changes_only_what_it_names():
    """A send-back cost a full rewrite of the register for fixes as small as
    one headline. amend_analysis carries only the fix: fields it names replace
    the kept ones, a deviation's new evidence is added to its quotes, and the
    lists it adds to keep what was there."""
    from backend.agents.rollout import agent

    held = analysis(deviations=[dev(gap_id="G1", as_is_step_id="", evidence=[ev("country does X")]),
                                dev(gap_id="G2", as_is_step_id="5.2"),
                                dev(gap_id="G3", as_is_step_id="5.3")],
                    open_questions=["Who signs?"]).model_dump()
    before = repr(held)
    extra = ev("SAP standard does Z", side="sap_bp", chunk="SAP:7").model_dump()
    new = dev(gap_id="G9", as_is_step_id="5.9").model_dump()
    out = agent._merge(held, {
        "headline": "Shorter.",
        "deviations": [{"gap_id": "G1", "as_is_step_id": "5.1", "evidence": [extra]}, new],
        "remove_deviations": ["G3"],
        "open_questions": ["Who issues the e-way bill?"],
    })
    assert repr(held) == before, "the kept submission must not change"
    assert out["headline"] == "Shorter."
    assert [d["gap_id"] for d in out["deviations"]] == ["G1", "G2", "G9"]
    g1 = out["deviations"][0]
    assert g1["as_is_step_id"] == "5.1"
    assert [e["quote"] for e in g1["evidence"]] == ["country does X", "SAP standard does Z"]
    assert out["deviations"][1] == held["deviations"][1], "an unnamed deviation is untouched"
    assert out["open_questions"] == ["Who signs?", "Who issues the e-way bill?"]
    assert out["fit_areas"] == held["fit_areas"] and out["dimension_ratings"] == held["dimension_ratings"]
    assert Analysis(**out).deviations[2].gap_id == "G9"


def test_an_over_long_quote_is_cut_to_a_verbatim_prefix():
    """The start of a verbatim quote is verbatim, so a quote over the limit is
    cut at a word boundary rather than sent back for a full rewrite."""
    from backend.agents.fitgap.verifier import quote_in_chunk
    from backend.agents.rollout import agent

    chunk = " ".join(f"word{i}" for i in range(200))
    long_quote = chunk[:agent.QUOTE_MAX + 60]
    payload = analysis(deviations=[dev(gap_id="G1", evidence=[ev("short one")])]).model_dump()
    payload["deviations"][0]["evidence"].append({**payload["deviations"][0]["evidence"][0],
                                                 "quote": long_quote})
    out, n = agent._shorten_quotes(payload)
    quotes = [e["quote"] for e in out["deviations"][0]["evidence"]]
    assert n == 1 and quotes[0] == "short one"
    assert len(quotes[1]) <= agent.QUOTE_MAX and long_quote.startswith(quotes[1])
    assert not quotes[1].endswith(" ") and long_quote[len(quotes[1])] == " ", "cut at a word boundary"
    assert quote_in_chunk(quotes[1], chunk)
    assert agent._validate(Analysis, out)[1] is None


def test_a_sent_back_analysis_is_corrected_with_an_amend():
    """End to end: a headline over its limit is sent back; the agent amends
    the headline alone, and the analysis it had already written is kept --
    including a quote the harness shortened rather than sent back."""
    import types

    from backend.agents.rollout import agent

    def block(**kw):
        return types.SimpleNamespace(**kw)

    sess = session_with("country does X")
    good = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1",
                                    evidence=[ev("country does X")])]).model_dump()
    first = {**good, "headline": "x" * (agent.HEADLINE_MAX + 1)}
    first["deviations"][0]["evidence"][0]["quote"] = "country does X " + "y " * 300
    turns = [
        ([block(type="tool_use", id="a0", name="amend_analysis", input={"headline": "early"})],
         "tool_use"),
        ([block(type="tool_use", id="t1", name="submit_analysis", input=first)], "tool_use"),
        ([block(type="tool_use", id="t2", name="amend_analysis", input={"headline": "Fixed."})],
         "tool_use"),
    ]
    seen, notes = [], []
    real = agent._client
    agent._client = lambda: _scripted_client(turns, seen)
    try:
        out, _ = agent._run("sys", "ctx", "compare", sess, "submit_analysis", Analysis, None,
                            lambda kind, data: notes.append(data), step_ids=["5.1"],
                            amend="amend_analysis")
    finally:
        agent._client = real
    assert "Nothing to amend" in seen[1][-1]["content"][0]["content"]
    sent = [n for n in notes if n.get("kind") == "rejected"]
    assert len(sent) == 1 and "headline" in sent[0]["text"] and "amend_analysis" in sent[0]["text"]
    assert [n for n in notes if n.get("kind") == "repaired" and "quote" in n["title"]]
    assert "amend_analysis" in seen[2][-2]["content"][0]["input"]["_omitted"]
    assert out is not None and out.headline == "Fixed." and out.deviations[0].gap_id == "G1"
    assert len(out.deviations[0].evidence[0].quote) <= agent.QUOTE_MAX
    assert notes[-1]["kind"] == "submitted" and notes[-1]["detail"]["amended"] is True


def test_a_list_sent_as_text_is_read_as_a_list():
    """A Sonnet run sent fit_areas as '<parameter name="fit_areas">[...]' --
    its tool-call markup leaked into the value around a valid list -- and the
    register was sent back and rewritten for it. Such a value is now parsed;
    anything that is not a list stays as sent, for validation to reject."""
    import json

    from backend.agents.rollout import agent

    fit = [{"statement": "Returns order with reference", "as_is_step_id": "5.1"}]
    base = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1")]).model_dump()

    leaked = {**base, "fit_areas": '\n<parameter name="fit_areas">' + json.dumps(fit, indent=1)}
    fixed, repaired = agent._repair_lists(Analysis, leaked)
    assert repaired == ["fit_areas"] and fixed["fit_areas"] == fit
    assert agent._validate(Analysis, fixed)[1] is None

    closed = {**base, "fit_areas": json.dumps(fit) + "</parameter>"}
    assert agent._repair_lists(Analysis, closed)[1] == ["fit_areas"]

    # Not a list, or not JSON: left alone, and still rejected.
    for bad in ('{"statement": "one"}', "<parameter name=\"fit_areas\">not json", "six fit areas"):
        out, repaired = agent._repair_lists(Analysis, {**base, "fit_areas": bad})
        assert repaired == [] and out["fit_areas"] == bad
        assert agent._validate(Analysis, out)[1] is not None
    # A text field is never touched, whatever it holds.
    out, repaired = agent._repair_lists(Analysis, {**base, "headline": "[1, 2]"})
    assert repaired == [] and out["headline"] == "[1, 2]"


def test_the_pass_is_told_its_sap_search_count_while_it_reads():
    """The count was checked only against a finished register. It is now said
    after each turn of reading, until the minimum is met."""
    import types

    from backend.agents.rollout import agent

    def block(**kw):
        return types.SimpleNamespace(**kw)

    def search(i):
        return ([block(type="tool_use", id=f"s{i}", name="search_sap_best_practice",
                       input={"query": f"q{i}"})], "tool_use")

    good = analysis(deviations=[dev(gap_id="G1", as_is_step_id="5.1")]).model_dump()
    turns = [search(1), search(2),
             ([block(type="tool_use", id="t3", name="submit_analysis", input=good)], "tool_use")]
    seen, notes = [], []
    real_client, real_search = agent._client, agent.tools.DISPATCH["search_sap_best_practice"]
    agent._client = lambda: _scripted_client(turns, seen)
    agent.tools.DISPATCH["search_sap_best_practice"] = lambda session, **kw: {"results": []}
    try:
        out, _ = agent._run("sys", "ctx", "compare", ftools.Session(), "submit_analysis", Analysis,
                            None, lambda kind, data: notes.append(data), step_ids=["5.1"],
                            min_sap_searches=2)
    finally:
        agent._client = real_client
        agent.tools.DISPATCH["search_sap_best_practice"] = real_search
    after_first, after_second = seen[1][-1]["content"], seen[2][-1]["content"]
    assert after_first[-1]["type"] == "text" and "1 of the 2" in after_first[-1]["text"]
    assert all(b["type"] == "tool_result" for b in after_second), "minimum met: no reminder"
    assert out is not None and not [n for n in notes if n.get("kind") == "rejected"]


def test_the_comparison_starts_with_its_fixed_calls_already_made():
    """Every run spent its first turns on list_sources, get_scope and
    compare_entities with the same arguments. They are made before the first
    turn, recorded like any call, and handed to the agent."""
    import types

    from backend.agents.rollout import agent

    names = ("list_sources", "get_scope", "compare_entities")
    real = {n: agent.tools.DISPATCH[n] for n in names}
    for n in names:
        agent.tools.DISPATCH[n] = (lambda n: lambda session, **kw: {"ran": n, **kw})(n)
    logged = []
    try:
        text = agent._prefetched(types.SimpleNamespace(code="4.10.2"), ftools.Session(),
                                 lambda call, stage: logged.append((call.name, stage)))
        unscoped = agent._prefetched(None, ftools.Session(), None)
    finally:
        agent.tools.DISPATCH.update(real)
    assert logged == [(n, "compare") for n in names]
    assert "do not call these again" in text
    assert "get_scope(bpml_code='4.10.2')" in text and '"bpml_code": "4.10.2"' in text
    assert "get_scope" not in unscoped and "compare_entities" in unscoped


def test_the_prompt_asks_the_agent_to_narrate():
    from backend.agents.rollout import agent
    from backend.agents.rollout.schemas import SUBJECTS

    for s in SUBJECTS.values():
        assert agent.NARRATION in agent.system_subject(s)
        assert agent.NARRATION in agent.system_compare(s)


def test_a_log_entry_keeps_the_shape_the_console_reads():
    from backend.agents.rollout.orchestrator import _log_entry

    call = _log_entry(3, "tool_call", {"tool": "search_corpus", "engine": "rag", "summary": "4",
                                       "ms": 9, "arguments": {"q": 1}, "stage": "compare"}, 2)
    assert call["call"] == 2 and call["stage"] == "compare" and call["tool"] == "search_corpus"
    long = _log_entry(0, "thinking", {"text": "x" * 9000, "turn": 1}, -1)
    assert len(long["text"]) == 6000
    note = _log_entry(1, "note", {"kind": "rejected", "title": "t", "text": "e"}, -1)
    assert note["note"] == "rejected" and note["title"] == "t"



def _decided_run(store, conn, run_id="ro_ws", country="India", scope="4.10.2"):
    store.start_run(conn, {"id": run_id, "subject": "country_as_is", "scope_bpml": scope,
                           "scope_label": "Process Returns", "country": country, "country_context": "",
                           "sap_release": "", "gt_version": "", "question": "",
                           "model": "m", "prompt_hash": "h", "categories": [],
                           "uploads": {}, "corpus_fingerprint": ""})
    store.finish_run(conn, run_id,
                     {"template_process": "4.10.2 Process Returns",
                      "deviations": [{"gap_id": "GAP-01", "primary_type": "AP", "materiality": "High",
                                      "localization_state": "NOT_LOCALIZATION", "as_is_step_id": "5.3",
                                      "exact_difference": "Two-level approval above INR 100,000",
                                      "decision_question": "Keep the second approval?",
                                      "decision_options": ["Keep it", "Drop it"],
                                      "decision_owner": ["Sales lead"],
                                      "evidence": [{"chunk_id": "UPLOAD:3", "doc": "as-is", "side": "as_is",
                                                    "quote": "Finance approves above INR 100,000"}]}]},
                     {"gt_alignment": 50.0, "agenda": []}, {"items": []}, (1, 1))


def test_a_decision_carries_its_own_context():
    """Read years later, with the run gone, a row must still say what was
    asked, what was offered and which option was chosen."""
    def check(store, conn):
        _decided_run(store, conn)
        d = store.save_decision(conn, "ro_ws", "GAP-01", "Asha", "accept", option_index=1,
                                rationale="Template approval is enough")
        assert d["question"] == "Keep the second approval?"
        assert d["options"] == ["Keep it", "Drop it"]
        assert (d["option_index"], d["option_text"]) == (1, "Drop it")
        assert d["country"] == "India" and d["scope_bpml"] == "4.10.2"
        assert d["primary_type"] == "AP" and d["materiality"] == "High" and d["as_is_step_id"] == "5.3"
        assert d["template_process"] == "4.10.2 Process Returns"
        assert d["comment"] == "Option B: Drop it — Template approval is enough"
        ev = conn.execute("SELECT evidence FROM workshop_decisions WHERE id = %s", (d["id"],)).fetchone()[0]
        assert ev[0]["chunk_id"] == "UPLOAD:3"
        try:
            store.save_decision(conn, "ro_ws", "GAP-01", "Asha", "accept", option_index=5)
        except ValueError:
            conn.rollback()
        else:
            raise AssertionError("an option that was never offered was recorded")
    _with_store(check)


def test_a_changed_mind_is_a_new_row_that_supersedes_the_old():
    def check(store, conn):
        _decided_run(store, conn)
        first = store.save_decision(conn, "ro_ws", "GAP-01", "Asha", "defer", rationale="Ask finance")
        second = store.save_decision(conn, "ro_ws", "GAP-01", "Asha", "accept", option_index=0)
        log = store.get_decisions(conn, "ro_ws")
        assert [x["id"] for x in log] == [first["id"], second["id"]]
        assert [x["is_current"] for x in log] == [False, True]
        assert log[1]["supersedes"] == first["id"]
        current = store.list_decisions(conn, country="india")
        assert [x["id"] for x in current] == [second["id"]]
        assert len(store.list_decisions(conn, current_only=False)) == 2
    _with_store(check)


def test_deleting_a_run_keeps_its_workshop_decisions():
    """What an organization agreed is not a run's working notes. The run goes;
    the decision stays, with the run's id and its own copy of the context."""
    def check(store, conn):
        _decided_run(store, conn, "ro_del")
        s = store.submit_workshop(conn, "ro_del", "Asha", ["Ravi", " ", "Meera"],
                                  [{"gap_id": "GAP-01", "verdict": "accept", "option_index": 0}])["session"]
        assert s["attendees"] == ["Ravi", "Meera"]
        assert store.delete_run(conn, "ro_del") is True
        assert store.get_run(conn, "ro_del") is None
        kept = store.get_decisions(conn, "ro_del")
        assert len(kept) == 1 and kept[0]["run_id"] is None and kept[0]["source_run"] == "ro_del"
        assert kept[0]["question"] == "Keep the second approval?" and kept[0]["session_id"] == s["id"]
        assert store.list_decisions(conn, scope_bpml="4.10")[0]["gap_id"] == "GAP-01"
        assert store.get_sessions(conn, "ro_del")[0]["facilitator"] == "Asha"
    _with_store(check)


def test_old_decisions_are_copied_once_with_their_option():
    """Before the option had a column, the page wrote it into the comment."""
    def check(store, conn):
        _decided_run(store, conn)
        conn.execute("INSERT INTO rollout_decisions (run_id, gap_id, reviewer, verdict, comment)"
                     " VALUES ('ro_ws', 'GAP-01', 'Ravi', 'accept', 'Option B: Drop it'),"
                     "        ('ro_ws', 'GAP-01', 'Ravi', 'defer', 'Option A: Not what was offered')")
        conn.commit()
        # Twice, as two server starts would: the schema is brought up once per
        # process, so each "start" forgets that it was done.
        for _ in range(2):
            store._ready.clear()
            store.create_schema(conn)
        log = store.get_decisions(conn, "ro_ws")
        assert len(log) == 2, log
        assert (log[0]["option_index"], log[0]["option_text"], log[0]["legacy"]) == (1, "Drop it", True)
        # The letter is not trusted when the text does not match what was offered.
        assert log[1]["option_index"] is None and log[1]["rationale"] == "Option A: Not what was offered"
        assert [x["is_current"] for x in log] == [False, True]
        assert log[0]["question"] == "Keep the second approval?"
    _with_store(check)


def test_a_submitted_workshop_is_saved_whole_or_not_at_all():
    """Facilitator mode submits every answer at the end. One bad answer must
    refuse the lot, not leave half a workshop in the record."""
    def check(store, conn):
        _decided_run(store, conn)
        for bad, why in (([{"gap_id": "GAP-01", "verdict": "defer"}], "rationale"),
                         ([{"gap_id": "GAP-99", "verdict": "accept"}], "not a deviation"),
                         ([{"gap_id": "GAP-01", "verdict": "accept", "option_index": 7}], "offered"),
                         ([{"gap_id": "GAP-01", "verdict": "accept"}] * 2, "twice"),
                         ([], "Nothing")):
            try:
                store.submit_workshop(conn, "ro_ws", "Asha", [], bad)
            except ValueError as e:
                conn.rollback()
                assert why in str(e), e
            else:
                raise AssertionError(f"accepted: {bad}")
        assert store.get_decisions(conn, "ro_ws") == [] and store.get_sessions(conn, "ro_ws") == []

        out = store.submit_workshop(conn, "ro_ws", "Asha", ["Ravi"],
                                    [{"gap_id": "GAP-01", "verdict": "accept", "option_index": 1,
                                      "rationale": "Template approval is enough"}])
        assert out["session"]["submitted_at"] and out["session"]["attendees"] == ["Ravi"]
        (d,) = out["decisions"]
        assert d["session_id"] == out["session"]["id"] and d["reviewer"] == "Asha"
        assert d["option_text"] == "Drop it" and d["question"] == "Keep the second approval?"
    _with_store(check)


def test_the_workshop_outcome_downloads_in_four_formats():
    """One outcome, four files. A replaced verdict is history, not the
    outcome; one sitting's download holds only what that sitting submitted."""
    import io
    import zipfile

    from backend.agents.rollout import pdf as ro_pdf
    from backend.agents.rollout import workshop_export as wx

    def check(store, conn):
        _decided_run(store, conn)
        store.save_decision(conn, "ro_ws", "GAP-01", "Asha", "defer", rationale="Ask finance")
        sitting = store.submit_workshop(conn, "ro_ws", "Asha", ["Ravi"],
                                        [{"gap_id": "GAP-01", "verdict": "accept", "option_index": 1,
                                          "rationale": "Template approval is enough"}])["session"]
        run = store.get_run(conn, "ro_ws")
        whole = wx.outcome(run, run["decisions"], run["sessions"])
        assert [r["Decision"] for r in whole["rows"]] == ["Accepted"], "a replaced verdict was reported"
        assert whole["rows"][0]["Option chosen"] == "B: Drop it"
        one = wx.outcome(run, run["decisions"], run["sessions"], sitting["id"])
        assert ("In the room", "Ravi") in one["facts"] and len(one["rows"]) == 1
        try:
            wx.outcome(run, run["decisions"], run["sessions"], "ws_nope")
        except LookupError:
            pass
        else:
            raise AssertionError("an unknown sitting was exported")

        md = wx.render(run, whole, "md").decode()
        assert "Keep the second approval?" in md and "Template approval is enough" in md
        for fmt, part in (("docx", "word/document.xml"), ("xlsx", "xl/worksheets/sheet1.xml")):
            blob = wx.render(run, whole, fmt)
            xml = zipfile.ZipFile(io.BytesIO(blob)).read(part).decode()
            assert "Keep the second approval?" in xml, fmt
        if ro_pdf.available()[0]:
            assert wx.render(run, whole, "pdf")[:5] == b"%PDF-"
        assert wx.filename(run, "docx").endswith(".docx")
    _with_store(check)


def test_an_old_style_comment_still_records_the_option():
    def check(store, conn):
        _decided_run(store, conn)
        d = store.save_decision(conn, "ro_ws", "GAP-01", "Asha", "accept", comment="Option A: Keep it")
        assert (d["option_index"], d["rationale"]) == (0, "")
    _with_store(check)


def test_deleting_a_run_that_is_not_there_reports_it():
    """False, not an exception and not a silent success: the endpoint turns
    this into a 404 rather than telling the browser it removed something."""
    def check(store, conn):
        assert store.delete_run(conn, "ro_never_existed") is False
    _with_store(check)


def test_deleting_one_run_leaves_the_others():
    def check(store, conn):
        for i in range(3):
            store.start_run(conn, {"id": f"ro_keep{i}", "subject": "country_as_is",
                                   "scope_bpml": "4.5", "scope_label": f"run {i}", "country": "",
                                   "country_context": "", "sap_release": "", "gt_version": "",
                                   "question": "", "model": "m", "prompt_hash": "h",
                                   "categories": [], "uploads": {}, "corpus_fingerprint": ""})
        store.delete_run(conn, "ro_keep1")
        left = {r["id"] for r in store.list_runs(conn)}
        assert left == {"ro_keep0", "ro_keep2"}, left
    _with_store(check)


# --- the PDF pack ---------------------------------------------------------------
# The PDF is rendered from the Markdown, so what is tested here is the trip:
# that the pack's own content survives it, that the parts Markdown cannot
# express are added, and that a machine without the libraries says so instead
# of producing half a file.


def _pack_run():
    """A run with the shapes a pack exercises: a table, a code span, an em-dash
    for an absent number, and the headerless provenance block."""
    return {
        "id": "ro_pdftest01",
        "country": "India",
        "scope_label": "4.10.2 Process Returns",
        "analysis": {"template_process": "4.10.2 Process Returns"},
    }


def test_the_pdf_is_a_pdf():
    from backend.agents.rollout import pdf as ro_pdf

    ok, why = ro_pdf.available()
    if not ok:
        print(f"       (skipped: {why[:70]})")
        return
    blob = ro_pdf.render(_pack_run(), "# Title\n\nBody.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")
    assert blob.startswith(b"%PDF-"), "not a PDF"
    assert b"%%EOF" in blob[-1024:], "truncated PDF"


def test_the_pdf_carries_the_run_id_on_every_page():
    """A pack is printed, split up and handed round. A loose page that cannot
    say which analysis it came from is worse than no page.

    The id is baked into the @page rule rather than carried by string-set,
    because string-set only fires for an element that generates a box -- the
    hidden div that first held it produced no box and no footer at all."""
    from backend.agents.rollout import pdf as ro_pdf

    css = ro_pdf.stylesheet("ro_pdftest01")
    assert "ro_pdftest01" in css
    assert "@bottom-left" in css
    assert "string(runid)" not in css, "back on string-set, which silently renders nothing"


def test_the_stylesheet_survives_its_own_formatting():
    """The sheet is percent-formatted to bake the id in, and it is full of
    literal percent signs. One unescaped `width: 100%` and every render raises
    ValueError."""
    from backend.agents.rollout import pdf as ro_pdf

    css = ro_pdf.stylesheet("ro_x")
    assert "width: 100%;" in css and "width: 34%;" in css
    assert "%(" not in css


def test_a_footer_cannot_be_escaped_out_of():
    from backend.agents.rollout import pdf as ro_pdf

    css = ro_pdf.stylesheet('evil"; } @page { size: A3; ')
    assert 'evil\\"' in css, "a quote in the id was not escaped"
    assert "size: A3" not in css.split("@bottom-left")[1].split("}")[0]


def test_the_headerless_provenance_table_loses_its_empty_bar():
    """`to_markdown` opens the pack with `| | |`, because Markdown has no
    headerless table. Rendered, that row is a grey bar over nothing."""
    from backend.agents.rollout import pdf as ro_pdf

    html = ro_pdf._markdown_to_html("| | |\n|---|---|\n| Run | x |\n")
    marked = ro_pdf._BLANK_HEAD.sub(
        lambda m: m.group(0).replace("<thead>", '<thead class="empty">'), html)
    assert 'thead class="empty"' in marked, "the empty header row was not found"
    assert "thead.empty { display: none; }" in ro_pdf.stylesheet("")

    # A real header must not be hidden with it.
    real = ro_pdf._markdown_to_html("| Score | Value |\n|---|---|\n| GT | 52% |\n")
    assert ro_pdf._BLANK_HEAD.search(real) is None, "a table with headings was blanked"


def test_the_filename_says_what_the_pack_is():
    from backend.agents.rollout import pdf as ro_pdf

    assert ro_pdf.filename(_pack_run()) == \
        "Fit-to-Standard - India - 4.10.2 Process Returns.pdf"
    # A process name with a slash in it must not become a directory.
    risky = {**_pack_run(), "scope_label": "4.1 Order / Return"}
    name = ro_pdf.filename(risky)
    assert "/" not in name and "\\" not in name, name
    # Nothing to name it after still produces a file name.
    assert ro_pdf.filename({"id": "ro_bare"}).endswith("ro_bare.pdf")


def test_the_pack_carries_the_workshop_views_and_the_verdicts():
    """The pack is what leaves the room, so it has to say what the page says:
    the agenda as timed slots with who must attend, which option each verdict
    chose, what can be confirmed without discussion, and the risk view."""
    from backend.agents.rollout.export import to_markdown

    def gap(gid, mat, bucket, harm, impacts):
        return {"gap_id": gid, "materiality": mat, "workshop_bucket": bucket, "harmonization_potential": harm,
                "primary_type": "PF", "secondary_types": [], "localization_state": "NOT_LOCALIZATION",
                "gt_fit_rating": 2, "candidate_disposition": "ADOPT_GT", "exact_difference": f"diff {gid}",
                "decision_options": ["Keep it", "Change it"], "impacts": impacts, "evidence": []}

    run = {
        **_pack_run(),
        "analysis": {"deviations": [
            gap("GAP-01", "High", "MUST_DISCUSS", 40, [{"area": "Tax", "score": 5, "note": ""}]),
            gap("GAP-02", "Medium", "CONFIRM", 90, [{"area": "Tax", "score": 2, "note": ""}]),
        ]},
        "scores": {"agenda": [{"position": 1, "gap_id": "GAP-01", "topic": "Keep or change?", "minutes": 30,
                               "materiality": "High", "primary_type": "PF", "disposition": "ADOPT_GT",
                               "localization_state": "NOT_LOCALIZATION", "options": ["Keep it", "Change it"],
                               "owner": ["Process Owner", "Tax Lead"], "why": "Because."}]},
        "decisions": [
            {"gap_id": "GAP-01", "reviewer": "Asha", "verdict": "defer", "comment": "", "decided_at": "2026-01-01T09:00"},
            {"gap_id": "GAP-01", "reviewer": "Asha", "verdict": "accept", "comment": "Option B: Change it",
             "decided_at": "2026-01-01T10:00"},
        ],
    }
    md = to_markdown(run)
    assert "## Workshop agenda — run-of-show" in md
    assert "| 0:00–0:30 | 1. GAP-01 · High |" in md, "the agenda lost its time slot"
    assert "| Process Owner | 30 | GAP-01 |" in md, "no attendee list"
    assert "Accepted · Asha" in md, "the table does not show the standing verdict"
    assert "Accepted by Asha — Option B: Change it" in md, "the chosen option was dropped"
    assert "Deferred" not in md.split("## Human decisions")[0], "a superseded verdict shown as standing"
    assert "- **A.** Keep it" in md and "- **B.** Change it" in md, "options are not lettered"
    confirm = md.split("## Confirm without discussion")[1].split("\n## ")[0]
    assert "GAP-02" in confirm and "GAP-01" not in confirm
    risk = md.split("## Deviation risk view")[1].split("## Deviation register")[0]
    assert "| High | **GAP-01** ✓ | — | — |" in risk, "the materiality matrix is wrong"
    assert "| Tax | 2 | 5/5 | GAP-01 5/5, GAP-02 2/5 |" in risk, "impact by area is wrong"


# A pack made of the shapes that actually broke: a ten-column register, an
# identifier that must not be split, a column of empty cells with one long one
# in it, a file name past any column width, and a timestamp.
HARD_PACK = """\
# Fit-to-Standard analysis — 4.10.2 Process Returns · India

| | |
|---|---|
| Run | `ro_hardpack1` |
| Country As-Is sources | sample_BKP_Customer_Returns.clean_xml (as_is) |
| Finished | 2026-09-22T11:59:48.566193+05:30 |

## Deviation register

| Gap | Step | Exact difference | Type | Materiality | Localization | GT fit | Harmonization | Disposition | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| GAP-01 | AS-04, AS-13 | The template enforces a two-person credit release control on returns; the As-Is depicts none at any point in the flow. | AP/CT/SEC | High | Not localization-related | 1/4 | 85% | CONFIGURE_STANDARD | Medium |
| GAP-11 | n/a | Neither side documents how Indian tax documents are produced for a return. | LC/CT/DT | High | Suspected localization — validate | 1/4 | 40% | RETAIN_LOCAL_EXCEPTION | Low |

## As-Is steps

| Step | Actor | Action | Rule | Control | System | Confidence |
|---|---|---|---|---|---|---|
| AS-01 Customer returns material | Returns and Refund Clerk | Process is started by the event. | | | | High |
| AS-02 Sell from Stock | Returns and Refund Clerk | Referenced preceding process. | | | | Medium |
| AS-03 Create Returns Order | Returns and Refund Clerk | Create the returns order. | Annotation attached to the task: creation with reference to a sales order or invoice is optional. | | | High |
| AS-04 Decide handling | Returns and Refund Clerk | | | | | High |
| AS-05 Generate Returns Delivery | Returns and Refund Clerk | Generates the returns delivery. | | | | High |
| AS-06 Perform Picking | Shipping Specialist | Pick the returns delivery. | | | | High |
| AS-07 Post Goods Receipt | Shipping Specialist | Post the goods receipt. | | | | High |
| AS-08 Perform Material Inspection | Receiving Specialist | Inspect the returned material. | | | | High |
| AS-09 Parallel split | Shipping Specialist | | | | | Medium |
| AS-10 Determine Refund | Returns and Refund Clerk | Determine the refund. | | | | High |
"""


def _broken_tokens(markdown: str, run_id: str = "ro_hardpack1"):
    """Every cell whose single unbreakable token was split across lines.

    Measured from the rendered layout, not estimated: the estimate is what got
    this wrong four times running. A cell that wrapped at a SPACE is fine; a
    break inside a token is not, and the two are told apart by joining the
    rendered lines with no separator and asking whether the result occurs
    verbatim in the source.
    """
    from weasyprint import CSS, HTML

    from backend.agents.rollout import pdf as ro_pdf

    flat = markdown.replace("**", "").replace("`", "")
    body = ro_pdf._html_body(markdown)
    doc = HTML(string=f"<!doctype html><html lang='en'><body>{body}</body></html>").render(
        stylesheets=[CSS(string=ro_pdf.stylesheet(run_id))])
    bad = []

    def lines_of(cell):
        out = []

        def walk(box):
            if type(box).__name__ == "LineBox":
                text = []

                def grab(x):
                    if type(x).__name__ == "TextBox":
                        text.append(x.text)
                    for c in getattr(x, "children", []):
                        grab(c)

                grab(box)
                out.append("".join(text))
            else:
                for c in getattr(box, "children", []):
                    walk(c)

        walk(cell)
        return out

    def walk(box):
        if type(box).__name__ == "TableCellBox":
            lines = lines_of(box)
            joined = "".join(l.strip() for l in lines)
            if len(lines) > 1 and joined and " " not in joined and joined in flat:
                bad.append((joined, len(lines)))
        for c in getattr(box, "children", []):
            walk(c)

    for page in doc.pages:
        walk(page._page_box)
    return bad


def test_no_identifier_is_ever_broken_in_half():
    """The whole point of measuring columns. Before this, 187 identifiers
    across twelve real packs came out as "GAP-0 / 1", "REQUIRES_DECISI / ON",
    "Materialit / y" -- unreadable, and quotable wrong."""
    from backend.agents.rollout import pdf as ro_pdf

    ok, why = ro_pdf.available()
    if not ok:
        print(f"       (skipped: {why[:60]})")
        return
    bad = _broken_tokens(HARD_PACK)
    assert not bad, f"{len(bad)} token(s) split: {bad[:5]}"


def test_a_table_too_wide_for_the_page_turns_it():
    """A ten-column register cannot be read on A4 portrait, and squeezing it
    pushed its last column off the paper entirely -- the content was not
    truncated, it was simply gone."""
    from backend.agents.rollout import pdf as ro_pdf

    tables = ro_pdf.measure(HARD_PACK)
    wide = [w for w, is_wide in tables if is_wide]
    assert len(wide) >= 1, "the ten-column register was left on a portrait page"
    assert len(wide[0]) == 10
    assert "@page wide" in ro_pdf.stylesheet("") and "size: A4 landscape" in ro_pdf.stylesheet("")


def test_every_table_shares_out_exactly_its_width():
    from backend.agents.rollout import pdf as ro_pdf

    for cols, _ in ro_pdf.measure(HARD_PACK):
        assert abs(sum(cols) - 1.0) < 1e-9, f"columns sum to {sum(cols)}"
        assert all(c > 0 for c in cols)


def test_a_column_is_wide_enough_for_its_longest_token():
    """The allocation gives every column what it NEEDS before sharing out what
    is left. A column that cannot hold its own longest identifier has already
    lost, whatever it does with the remainder."""
    from backend.agents.rollout import pdf as ro_pdf

    header = ["Gap", "Disposition"]
    tokens = [["GAP-01"], ["CONFIGURE_STANDARD"]]
    need = ro_pdf._needs(header, tokens, wide=True)
    unit, pad = ro_pdf.MM_PER_UNIT_WIDE, ro_pdf.PAD_MM_WIDE
    assert need[1] - pad >= unit * ro_pdf._width("CONFIGURE_STANDARD")
    # and the padding and the collapsed border are both paid for
    assert ro_pdf.PAD_MM_WIDE > 2 * 1.4, "the collapsed border is not accounted for"


def test_one_long_cell_among_empty_ones_still_gets_room():
    """The 75th percentile describes the typical cell and says nothing about
    the exceptional one. A Rule column of blanks with a single ninety-character
    annotation took the minimum width and turned that cell into ten lines,
    beside two columns that were entirely empty."""
    from backend.agents.rollout import pdf as ro_pdf

    cols, _ = ro_pdf.measure(HARD_PACK)[2]
    rule, control = cols[3], cols[4]
    assert rule > control * 1.5, (
        f"the column holding the annotation ({rule:.3f}) is not meaningfully wider "
        f"than the empty one beside it ({control:.3f})")


def test_a_token_too_long_for_any_column_breaks_at_a_seam():
    """Some tokens fit nowhere -- a thirty-seven character file name, a full
    ISO timestamp. Where they break is still a choice, and mid-word is the
    wrong one."""
    from backend.agents.rollout import pdf as ro_pdf

    html = ro_pdf._seams("<td>sample_BKP_Customer_Returns.clean_xml</td>")
    assert "<wbr>" in html
    assert "sample_<wbr>BKP_<wbr>Customer_<wbr>Returns." in html
    # A short identifier is left alone: it is made to fit instead.
    assert "<wbr>" not in ro_pdf._seams("<td>GAP-01</td>")


def test_the_character_widths_are_measured_not_guessed():
    """Counting characters got upper case wrong by a third in one direction
    and lower case wrong in the other, which is why headings broke."""
    from backend.agents.rollout import pdf as ro_pdf

    assert ro_pdf._width("W") > ro_pdf._width("i") * 3
    assert ro_pdf._width("REQUIRES") > ro_pdf._width("requires")
    assert ro_pdf._width("Gap", bold=True) > ro_pdf._width("Gap")
    # Unknown characters still cost something.
    assert ro_pdf._width("—") > 0


def test_the_pdf_and_the_markdown_are_the_same_document():
    """Rendered from the pack rather than from the run, so a section added to
    one cannot go missing from the other."""
    import inspect

    from backend.agents.rollout import pdf as ro_pdf

    src = inspect.getsource(ro_pdf.render)
    # The CALL, not the import: `from .export import to_markdown` sitting in
    # the function body satisfies a substring check while the body renders
    # something else entirely.
    assert "to_markdown(run)" in src, "the PDF builds its own content and will drift"


# --- traceability (backend/agents/rollout/lineage.py) -----------------------------------------

def _traced_run(quote_as_is="Returns above INR 500,000 need the Finance Manager.",
                quote_gt="A billing block is applied automatically.", gt_chunk="DR:7"):
    """A stored run in miniature: two retrieval calls, the reasoning before
    them, one As-Is step and one deviation quoting both sides."""
    ev_a = {"chunk_id": "UPLOAD:3", "doc": "India SOP", "heading_path": "5.3", "side": "as_is",
            "quote": quote_as_is, "evidence_class": "E1"}
    ev_t = {"chunk_id": gt_chunk, "doc": "L2C-WS020", "heading_path": "Returns", "side": "template",
            "quote": quote_gt, "evidence_class": "E1"}
    calls = [
        {"stage": "asis", "tool": "read_sources", "engine": "session", "summary": "3 chunks",
         "trace": {"kind": "rag", "query": "approval matrix", "hits": [
             {"rank": 1, "chunk_id": "UPLOAD:3", "score": 0.03, "vector_rank": 1, "keyword_rank": 2,
              "text": "| Above **INR 500,000** | ... |\nReturns above INR 500,000 need the\nFinance Manager."}]}},
        {"stage": "compare", "tool": "search_corpus", "engine": "rag", "summary": "2 chunks",
         "trace": {"kind": "rag", "query": "billing block returns", "hits": [
             {"rank": 2, "chunk_id": "DR:7", "score": 0.02, "text": "A **billing block** is applied automatically."},
             {"rank": 1, "chunk_id": "DR:8", "score": 0.04, "text": "Unrelated passage."}]}},
        {"stage": "compare", "tool": "compare_entities", "engine": "graph", "summary": "1 shared",
         "trace": {"kind": "graph", "nodes": [{"id": "system:S4HANA", "label": "SAP S/4HANA", "type": "system",
                                               "in_corpus": True}]}},
    ]
    log = [
        {"seq": 0, "kind": "thinking", "text": "Reading the approval matrix."},
        {"seq": 1, "kind": "tool_call", "call": 0, "tool": "read_sources", "engine": "session"},
        {"seq": 2, "kind": "thinking", "text": "Checking how the template blocks a return."},
        {"seq": 3, "kind": "tool_call", "call": 1, "tool": "search_corpus", "engine": "rag"},
        {"seq": 4, "kind": "tool_call", "call": 2, "tool": "compare_entities", "engine": "graph"},
        {"seq": 5, "kind": "note", "note": "rejected", "text": "GAP-01 quotes only one side."},
    ]
    d = dev(evidence=[Evidence(**ev_a), Evidence(**ev_t)],
            exact_difference="Four-tier approval in SAP S/4HANA vs a billing block").model_dump()
    return {
        "id": "ro_trace", "calls": calls, "log": log,
        "asis": {"steps": [{"step_id": "5.3", "name": "Approve", "action": "approve", "evidence": [ev_a]}]},
        "analysis": {"deviations": [d], "fit_areas": [], "localization": [],
                     "dimension_ratings": [{"dimension": "rules", "gt_rating": 2, "note": ""}], "backlog": []},
        "gates": {"items": [{"gate": "QG1", "severity": "soft", "detail": "x", "gap_id": "GAP-01"}]},
        "decisions": [{"gap_id": "GAP-01", "verdict": "accept", "decided_by": "Tarento"}],
        "scores": {"gt_alignment": 50},
    }


def test_every_quote_is_traced_to_the_call_that_returned_it():
    from backend.agents.rollout import lineage

    lin = lineage.build(_traced_run())
    gap = next(c for c in lin["claims"] if c["ref"] == "GAP-01")
    assert gap["status"] == "traced", gap["checks"]
    by_chunk = {e["chunk_id"]: e for e in gap["evidence"]}
    # Typeset differently from the chunk (bold, a line break) and still verbatim.
    assert by_chunk["UPLOAD:3"]["verification"]["status"] == "verbatim"
    assert by_chunk["DR:7"]["retrievals"][0] == {
        "call": 1, "tool": "search_corpus", "stage": "compare", "query": "billing block returns",
        "rank": 2, "score": 0.02, "vector_rank": None, "keyword_rank": None}
    # The reasoning each call was made under travels with the claim.
    assert [i["text"] for i in gap["intents"]] == ["Reading the approval matrix.",
                                                   "Checking how the template blocks a return."]
    assert gap["sendbacks"] and gap["gates"] and gap["decisions"]
    assert [g["id"] for g in gap["graph"]] == ["system:S4HANA"]


def test_a_quote_that_is_not_in_the_retrieved_text_is_caught():
    """The check the verifier cannot be trusted to have made: a chunk that was
    returned, and a quote that is not in it."""
    from backend.agents.rollout import lineage

    lin = lineage.build(_traced_run(quote_gt="Every return is approved by the CFO."))
    gap = next(c for c in lin["claims"] if c["ref"] == "GAP-01")
    ev = next(e for e in gap["evidence"] if e["chunk_id"] == "DR:7")
    assert ev["verification"]["status"] == "not_found"
    assert gap["status"] == "partial"
    assert lin["summary"]["not_found"] == 1


def test_a_chunk_no_call_returned_is_caught():
    from backend.agents.rollout import lineage

    lin = lineage.build(_traced_run(gt_chunk="DR:999"))
    gap = next(c for c in lin["claims"] if c["ref"] == "GAP-01")
    ev = next(e for e in gap["evidence"] if e["chunk_id"] == "DR:999")
    assert ev["verification"]["status"] == "not_retrieved" and ev["retrievals"] == []
    assert gap["status"] == "partial"


def test_a_deviation_quoting_one_side_is_not_fully_traced():
    from backend.agents.rollout import lineage

    run = _traced_run()
    run["analysis"]["deviations"][0]["evidence"] = run["analysis"]["deviations"][0]["evidence"][:1]
    gap = next(c for c in lineage.build(run)["claims"] if c["ref"] == "GAP-01")
    assert gap["status"] == "partial"
    assert not next(c for c in gap["checks"] if c["check"].startswith("Both sides"))["ok"]


def test_the_trail_says_what_each_call_supplied():
    from backend.agents.rollout import lineage

    trail = lineage.build(_traced_run())["trail"]
    calls = {t["call"]: t for t in trail if t["kind"] == "tool_call"}
    assert calls[0]["supports"] == ["5.3", "GAP-01"]
    assert calls[1]["cited_chunks"] == 1 and calls[1]["returned"] == 2
    assert calls[2]["supports"] == []
    assert [t["kind"] for t in trail][-2:] == ["scoring", "decision"]


def test_the_audit_file_names_every_claim_and_call():
    from backend.agents.rollout import lineage

    run = _traced_run(quote_gt="Every return is approved by the CFO.")
    md = lineage.to_markdown(run, lineage.build(run))
    assert "### Deviation GAP-01 — partial" in md
    assert "✗ not found" in md and "✓ verbatim" in md
    assert "call 2 `search_corpus`" in md


def test_quote_matching_is_not_fooled_by_a_fragment():
    from backend.agents.rollout import lineage

    assert lineage.verify_quote("billing block", "no such text")["status"] == "not_found"
    assert lineage.verify_quote("A is set ... then B follows", "A is set when X. Later then B follows.")["status"] == "verbatim"
    assert lineage.verify_quote("", "anything")["status"] == "empty"


def test_a_run_that_kept_no_calls_is_not_called_unretrieved():
    """Runs from before the log kept calls cannot say what was retrieved.
    Absence of a record is not evidence the agent read nothing."""
    from backend.agents.rollout import lineage

    run = _traced_run()
    run["calls"], run["log"] = [], []
    lin = lineage.build(run)
    gap = next(c for c in lin["claims"] if c["ref"] == "GAP-01")
    assert {e["verification"]["status"] for e in gap["evidence"]} == {"unrecorded"}
    assert lin["summary"]["record"] == "none" and lin["summary"]["not_retrieved"] == 0


if __name__ == "__main__":
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
