"""Data contracts for the Fit-Gap Copilot.

Every controlled vocabulary here comes from the agent specification: the
deviation taxonomy (§8.2), the dispositions (§9), the localization states
(§5.3), the evidence classes (§5.1), the materiality classification (§13.2)
and the workshop buckets (§14). They are `Literal`s rather than free text so
that a register can be counted, filtered and scored -- and so the JSON Schema
the agent's submit tools advertise is generated from exactly the vocabulary
the validator enforces.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema


# --- what the run is about ----------------------------------------------------
# A run reads one document set as its *subject* and compares it against the
# Global Template. Which document set that is changes what the comparison
# means, and a few rules follow from it rather than from anything the agent
# decides -- so they are declared here once instead of being branched on in
# four modules.
#
# The second subject exists because "our template has drifted from SAP
# standard" is a real finding with an owner (§19: GT vs SAP BP divergence ->
# template improvement / design review), and it was previously only reachable
# by mis-tagging a Best Practice document as a country's As-Is, which made the
# agent report SAP's process as a country's own.


@dataclass(frozen=True)
class Subject:
    key: str
    label: str            # how the subject is named in the UI and the export
    role: str             # the upload role a run of this kind requires
    side: str             # the evidence side the subject's own quotes carry
    noun: str             # how the prompts refer to it in prose
    # Localization is a country lens. Comparing SAP standard against a
    # template has no country in it, so a statutory-localization claim there
    # is a category error rather than a judgement call -- and Score C, which
    # forgives confirmed-legal divergence, has nothing to forgive.
    localization: bool
    # Score B rates the subject against SAP Best Practice. When the subject IS
    # the Best Practice content, that is a comparison with itself.
    score_b: bool
    reading: str          # prompt fragment: what pass one is reading
    finding: str          # prompt fragment: what a deviation means here


def step_refs(ref: str | None) -> set[str]:
    """The step ids a reference names -- "5.1, 5.14", "IN-RET-030", "(5.3)" --
    upper-cased, punctuation stripped. One splitter for everything that reads
    an as_is_step_id, so the completeness gate and the send-back cannot
    disagree about which steps a finding covers."""
    return {t.strip("()[].:").upper() for t in re.split(r"[,;/\s]+", ref or "") if t.strip("()[].:")}


SUBJECTS: dict[str, Subject] = {
    "country_as_is": Subject(
        key="country_as_is",
        label="Country As-Is",
        role="as_is",
        side="as_is",
        noun="the country",
        localization=True,
        score_b=True,
        reading="the country's As-Is process",
        finding=("a difference between what the country does today and what the Global "
                 "Template prescribes"),
    ),
    "sap_best_practice": Subject(
        key="sap_best_practice",
        label="SAP Best Practice",
        role="sap_bp",
        side="sap_bp",
        noun="SAP standard",
        localization=False,
        score_b=False,
        reading="the SAP Best Practice process",
        finding=("a difference between SAP's delivered standard process and what the Global "
                 "Template prescribes -- which is a finding about the template, not about SAP"),
    ),
}

SubjectKey = Literal["country_as_is", "sap_best_practice"]

# §5.1 -- what kind of claim a statement is. E3 must never be presented as E1.
EvidenceClass = Literal["E1", "E2", "E3", "E4"]

# §8.2 -- the controlled deviation taxonomy.
DEVIATION_TYPES: dict[str, str] = {
    "PF": "Process flow — extra, missing or reordered step",
    "BR": "Business rule — different threshold, tolerance or calculation",
    "AP": "Approval / authority — extra approval or different authority level",
    "RO": "Role / organisation — different ownership or segregation",
    "LC": "Localization / compliance — country statutory or local requirement",
    "CT": "Control — additional or missing control or audit evidence",
    "DT": "Data / master data — different fields, master data or enrichment",
    "IN": "Integration — different interface or system interaction",
    "RP": "Reporting / KPI — local report, frequency, metric or layout",
    "UX": "User experience / channel — different UI, manual step, spreadsheet",
    "EX": "Exception handling — different exception path or escalation",
    "TM": "Timing / SLA — different timing, cut-off or batch window",
    "TC": "Technical customisation — custom code, enhancement, workflow",
    "SEC": "Security / authorization — different access or segregation of duties",
    "VOL": "Volume / performance — driven by materially different scale",
    "POL": "Corporate / country policy — local internal policy rather than law",
}
DeviationType = Literal[
    "PF", "BR", "AP", "RO", "LC", "CT", "DT", "IN",
    "RP", "UX", "EX", "TM", "TC", "SEC", "VOL", "POL",
]

# §9 -- candidate dispositions. Provisional until governance approves them.
DISPOSITIONS: dict[str, str] = {
    "ADOPT_GT": "The country can adopt the Global Template with no material local loss",
    "CONFIGURE_STANDARD": "Satisfied through SAP standard configuration",
    "USE_SAP_LOCALIZATION": "Should use SAP-delivered localization",
    "ADOPT_SAP_BP": "The template or local process can move closer to SAP Best Practice",
    "EXTEND_STANDARD": "Needs a supported extension, preserving clean core",
    "RETAIN_LOCAL_EXCEPTION": "The country-specific exception appears justified",
    "REDESIGN_GT": "The finding reveals a worthwhile change to the Global Template",
    "RETIRE_LEGACY": "The local step appears historical or duplicative",
    "REQUIRES_DECISION": "Evidence or business decision is insufficient to dispose of it",
    "OUT_OF_SCOPE": "Belongs to another process or workstream",
}
Disposition = Literal[
    "ADOPT_GT", "CONFIGURE_STANDARD", "USE_SAP_LOCALIZATION", "ADOPT_SAP_BP",
    "EXTEND_STANDARD", "RETAIN_LOCAL_EXCEPTION", "REDESIGN_GT", "RETIRE_LEGACY",
    "REQUIRES_DECISION", "OUT_OF_SCOPE",
]

# Dispositions that propose building something. §26 forbids reaching one of
# these before standard configuration and SAP localization have been weighed,
# so the verifier makes the agent show its working for them.
BUILD_DISPOSITIONS = ("EXTEND_STANDARD",)

# §5.3 -- the localization guardrail. "Country-specific" is not "mandatory".
LOCALIZATION_STATES: dict[str, str] = {
    "CONFIRMED_STATUTORY": "Confirmed statutory localization",
    "SAP_DELIVERED": "SAP-delivered localization",
    "CORPORATE_POLICY": "Corporate country policy",
    "LOCAL_PREFERENCE": "Local operating preference",
    "SUSPECTED": "Suspected localization — validate",
    "NOT_LOCALIZATION": "Not localization-related",
}
LocalizationState = Literal[
    "CONFIRMED_STATUTORY", "SAP_DELIVERED", "CORPORATE_POLICY",
    "LOCAL_PREFERENCE", "SUSPECTED", "NOT_LOCALIZATION",
]

# The two states that make a deviation a genuine legal obligation rather than
# an avoidable divergence. Score C (§12.3) exists so these are not counted as
# a standardization failure.
MANDATORY_LOCALIZATION = ("CONFIRMED_STATUTORY", "SAP_DELIVERED")

# §13.2
Materiality = Literal["Critical", "High", "Medium", "Low", "Informational"]
MATERIALITY_WEIGHT: dict[str, float] = {
    "Critical": 5.0, "High": 4.0, "Medium": 3.0, "Low": 2.0, "Informational": 1.0,
}

# §14
WorkshopBucket = Literal["MUST_DISCUSS", "CONFIRM", "NO_WORKSHOP_TIME"]

# §12.1 -- the seven scored dimensions and their weights. They sum to 1.0;
# scoring.py asserts it rather than trusting the table.
DIMENSIONS: dict[str, tuple[str, float]] = {
    "flow": ("Process flow / sequence", 0.25),
    "rules": ("Business rules / configuration", 0.20),
    "governance": ("Roles / approvals / governance", 0.15),
    "data": ("Data / master data", 0.10),
    "integration": ("Integration / technical execution", 0.10),
    "controls": ("Controls / compliance", 0.10),
    "reporting": ("Reporting / UX / operational handling", 0.10),
}
Dimension = Literal["flow", "rules", "governance", "data", "integration", "controls", "reporting"]

# §12.1 -- what a 0-4 dimension rating means.
RATING_MEANING: dict[int, str] = {
    4: "Fully aligned — semantically equivalent",
    3: "Minor variation — standard configuration or local parameter difference",
    2: "Moderate deviation — requires a design or workshop decision",
    1: "Major deviation — structurally different or a significant extension",
    0: "Fundamental mismatch — incompatible process or control",
}

Confidence = Literal["High", "Medium", "Low"]
Side = Literal["as_is", "template", "sap_bp", "localization"]


class Evidence(BaseModel):
    """One quote, and which of the three sides it came from.

    `side` is not decoration: a deviation is a statement about a difference
    between two sources, and evidence that only ever quotes one of them has
    not established that there is one."""

    chunk_id: str
    doc: str
    heading_path: str = ""
    quote: str = Field(max_length=400)
    side: Side
    evidence_class: EvidenceClass = "E1"

    @field_validator("chunk_id", mode="before")
    @classmethod
    def _as_text(cls, v):  # the agent sometimes returns the id as a number
        return str(v)


class AsIsStep(BaseModel):
    """§6.1 — the atomic process step model.

    Most attributes are optional because a real SOP does not state all of
    them; an empty field is an honest "the document does not say", and the
    coverage report counts them rather than letting the agent invent one."""

    step_id: str
    name: str
    trigger: str = ""
    actor: str = ""
    action: str = ""
    system: str = ""
    input: str = ""
    business_rule: str = ""
    decision: str = ""
    control: str = ""
    output: str = ""
    exception: str = ""
    integration: str = ""
    timing: str = ""
    volume: str = ""
    sequence: int = 0
    confidence: Confidence = "Medium"
    evidence: list[Evidence] = Field(default_factory=list)


class AsIsModel(BaseModel):
    """What the agent understood of the country process, before comparing."""

    process_name: str = ""
    country: str = ""
    steps: list[AsIsStep] = Field(default_factory=list)
    normalisation_notes: list[str] = Field(default_factory=list)
    evidence_gaps: list[str] = Field(default_factory=list)


class Impact(BaseModel):
    """§13.1 — one materiality dimension that is actually non-trivial.

    The agent lists only the areas that carry impact rather than scoring all
    eleven every time: the specification is explicit that the explanation
    matters more than the label."""

    area: str
    score: int = Field(ge=0, le=5)
    note: str = ""


class Deviation(BaseModel):
    """§24 — the machine-readable gap object."""

    gap_id: str
    # What places the finding on the Process alignment tab. Optional in the
    # schema, and so left empty in four runs of six until the prompt, this
    # description and the send-back in agent.py all asked for it.
    as_is_step_id: str = Field(
        default="",
        description=("The As-Is step id(s) this deviation is about, exactly as written in the "
                     "process model you were given (e.g. \"5.3\" or \"5.3, 5.4\"). Empty only "
                     "when it concerns no single step."),
    )
    gt_step_ref: str = ""
    sap_bp_reference: str | None = Field(
        default=None,
        description=("What SAP Best Practice does at this point, in one sentence, and which SAP "
                     "Best Practice document says so. Null when no SAP source was read."),
    )

    as_is_statement: str
    gt_statement: str
    exact_difference: str

    primary_type: DeviationType
    secondary_types: list[DeviationType] = Field(default_factory=list)
    # Which of the seven scored dimensions this deviation loads onto, so a
    # score can be traced back to the findings that produced it.
    dimension: Dimension

    localization_state: LocalizationState
    materiality: Materiality
    impacts: list[Impact] = Field(default_factory=list)

    gt_fit_rating: int = Field(ge=0, le=4)
    # None, not 0: "no SAP Best Practice source was available" and "the country
    # is fundamentally mismatched with SAP standard" are different answers.
    sap_bp_fit_rating: int | None = Field(default=None, ge=0, le=4)
    # Computed, not rated: scoring.harmonization() sets both after the quality
    # gates, from the disposition, the localization state and the GT fit. The
    # agent used to supply a bare 0-100 with no rubric, so two gaps with the
    # same fit and opposite dispositions could score backwards. Hidden from the
    # submit tool's schema so it is not asked for.
    harmonization_potential: SkipJsonSchema[int] = Field(default=0, ge=0, le=100)
    harmonization_terms: SkipJsonSchema[dict] = Field(default_factory=dict)

    candidate_disposition: Disposition
    # §26 / QG5: standard configuration, SAP localization and existing template
    # variation have to be considered before an extension is proposed.
    standard_options_considered: list[str] = Field(default_factory=list)

    workshop_bucket: WorkshopBucket
    decision_question: str = ""
    decision_options: list[str] = Field(default_factory=list)
    decision_owner: list[str] = Field(default_factory=list)
    workshop_minutes: int = 0
    why_discussed: str = ""

    evidence_confidence: Confidence = "Medium"
    evidence: list[Evidence] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)

    @field_validator("workshop_minutes")
    @classmethod
    def _sane_minutes(cls, v):
        # §15 offers 5 / 10 / 15 / 30; anything beyond an hour is not a
        # workshop topic, it is a separate design session.
        return max(0, min(int(v or 0), 60))


class DimensionRating(BaseModel):
    """§12.1 — one row of the alignment score, rated by the agent and
    arithmetic'd by scoring.py rather than by the model."""

    dimension: Dimension
    gt_rating: int = Field(ge=0, le=4)
    sap_bp_rating: int | None = Field(default=None, ge=0, le=4)
    note: str = ""


class LocalizationItem(BaseModel):
    """§10.2 — a localization finding, in the context of this process only."""

    topic: str
    status: Literal["Confirmed", "Candidate", "Not applicable"]
    relevance: str = ""
    requirement: str = ""
    sap_capability: str = ""
    gt_capability: str = ""
    as_is_handling: str = ""
    recommended_path: str = ""
    workshop_decision: str = ""
    owner: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)


class BacklogCandidate(BaseModel):
    """Output 10 — a candidate for the SAP Activate / Cloud ALM backlog.

    Candidate, never a requirement: §20 forbids turning a hypothesis into
    project scope, so these carry the gap they came from and are produced only
    for findings the agent can evidence."""

    title: str
    requirement: str
    business_value: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    affected_process: str = ""
    dependencies: list[str] = Field(default_factory=list)
    build_type: Literal["configuration", "extension", "localization", "undetermined"] = "undetermined"
    localization_flag: bool = False
    priority: Literal["Must", "Should", "Could", "Won't"] = "Should"
    gap_id: str = ""


class FitArea(BaseModel):
    """A step that matched. Named so the workshop can batch-confirm them
    instead of walking through them (§22)."""

    as_is_step_id: str = Field(
        default="",
        description="The As-Is step id(s) that fit, exactly as written in the process model.",
    )
    gt_step_ref: str = ""
    statement: str
    evidence: list[Evidence] = Field(default_factory=list)


class Analysis(BaseModel):
    """The agent's comparison pass. Scores are NOT in here: they are computed
    from `dimension_ratings` and `deviations` by scoring.py, so the arithmetic
    is reproducible and cannot be talked into a better number."""

    headline: str = Field(default="", max_length=600)
    # Which Global Template process the As-Is was compared against. Required
    # in substance when the run named no BPML code: without it the analysis
    # records a comparison but not what it compared to.
    template_process: str = Field(
        default="",
        description=("The Global Template process this As-Is was matched to -- its BPML code "
                     "and name where you can identify one, otherwise the process as the corpus "
                     "names it. Say so plainly if you could not identify one."),
    )
    dimension_ratings: list[DimensionRating] = Field(default_factory=list)
    fit_areas: list[FitArea] = Field(default_factory=list)
    deviations: list[Deviation] = Field(default_factory=list)
    localization: list[LocalizationItem] = Field(default_factory=list)
    backlog: list[BacklogCandidate] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    sap_bp_note: str = Field(
        default="",
        description="Why the SAP Best Practice comparison is or is not assessable here.",
    )

    @model_validator(mode="after")
    def _ratings_and_register_must_agree(self):
        """A dimension rated as diverging has to name the divergence.

        A 2 means "moderate deviation — requires a design or workshop
        decision" and a 1 means "major deviation". Rating a dimension there
        and recording no deviation on it produces the worst possible output:
        an alignment score that looks measured, over a register that says the
        process matched. The agent gets the contradiction back and fixes it,
        which is the whole reason the submission is validated rather than
        merely stored."""
        on_dimension = {d.dimension for d in self.deviations}
        wrong = [r for r in self.dimension_ratings
                 if r.gt_rating <= 2 and r.dimension not in on_dimension]
        if wrong:
            names = ", ".join(f"{r.dimension} (rated {r.gt_rating}/4)" for r in wrong)
            raise ValueError(
                f"these dimensions are rated as diverging but no deviation is recorded on "
                f"them: {names}. Either write the deviations out, or raise the rating to 3 "
                f"(minor variation) or 4 (fully aligned) and say why in the note."
            )
        return self


class QualityIssue(BaseModel):
    """A quality gate (§25) that the submitted analysis did not pass."""

    gate: str
    severity: Literal["hard", "soft"]
    detail: str
    gap_id: str = ""


class RunRequest(BaseModel):
    # Optional. Naming the Global Template process anchors the comparison to a
    # BPML node; leaving it empty asks the agent to find the template's
    # equivalent of the As-Is itself, and to say in `template_process` what it
    # matched. A code that is given but does not resolve is still an error --
    # a typo must not quietly become "no scope".
    scope_bpml: str = ""
    # What this run is analysing. The default keeps every existing caller and
    # every stored run meaning exactly what it did before.
    subject: SubjectKey = "country_as_is"
    country: str = Field(default="", max_length=80)
    country_context: str = Field(default="", max_length=4000)
    sap_release: str = Field(default="", max_length=200)
    gt_version: str = Field(default="", max_length=120)
    question: str | None = None
    # The session holding the As-Is (and optionally template / SAP BP)
    # documents. Without it there is nothing to analyse.
    upload_session: str = ""
    # The account the run belongs to. Set by the server from the session,
    # never by the browser (the API's request models do not have this field).
    user_id: int | None = None
    # Corpus categories that stand for the Global Template. Empty is all.
    categories: list[str] = Field(default_factory=list)
