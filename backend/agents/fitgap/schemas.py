"""Data contracts for InsightLens (handover §5).

The JSON Schema the agent's `submit_entry` tool advertises is generated from
these models, so the prompt and the validator can never drift apart.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Mode A classifies the template itself; Mode B classifies what a new country
# should do with it. One enum so a register can hold both.
MODE_A_CLASSES = ("FIT_STANDARD", "FIT_CONFIG", "GAP_DEVELOPMENT")
MODE_B_CLASSES = ("REUSE", "ADAPT", "CHALLENGE", "SIMPLIFY", "REPLACE", "RETIRE")

Classification = Literal[
    "FIT_STANDARD", "FIT_CONFIG", "GAP_DEVELOPMENT",
    "REUSE", "ADAPT", "CHALLENGE", "SIMPLIFY", "REPLACE", "RETIRE",
    "UNKNOWN",
]


class Evidence(BaseModel):
    chunk_id: str
    doc: str
    heading_path: str = ""
    quote: str = Field(max_length=300)
    supports: Literal["for", "against", "context"] = "for"

    @field_validator("chunk_id", mode="before")
    @classmethod
    def _as_text(cls, v):  # the agent sometimes returns the id as a number
        return str(v)


class IntegrationImpact(BaseModel):
    system: str
    interface_ref: str | None = None
    impact: Literal["none", "reuse", "variant", "new"]
    evidence: list[Evidence] = Field(default_factory=list)


class DecisionPoint(BaseModel):
    question: str
    options: list[str] = Field(default_factory=list)
    consequence_note: str = ""
    evidence: list[Evidence] = Field(default_factory=list)

    @field_validator("options")
    @classmethod
    def _two_to_four(cls, v):
        if v and not 2 <= len(v) <= 4:
            raise ValueError("a decision point offers between 2 and 4 options")
        return v


class FitGapEntry(BaseModel):
    run_id: str = ""
    mode: Literal["A", "B"] = "A"
    bpml_code: str
    step_name: str = ""
    classification: Classification
    rationale: str = ""
    confidence: float = Field(ge=0.0, le=1.0)
    materiality: Literal["low", "medium", "high"] = "low"
    linked_tickets: list[str] = Field(default_factory=list)
    sap_objects: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    integration_impacts: list[IntegrationImpact] = Field(default_factory=list)
    decision_points: list[DecisionPoint] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    status: Literal["proposed"] = "proposed"

    @field_validator("rationale")
    @classmethod
    def _under_120_words(cls, v):
        words = v.split()
        return v if len(words) <= 120 else " ".join(words[:120]) + " …"

    def model_post_init(self, _context) -> None:
        # The two evidence floors from §5. Enforced here rather than in the
        # verifier so a malformed submission bounces back to the agent with a
        # message it can act on, instead of being silently accepted.
        if self.classification != "UNKNOWN" and not self.evidence:
            raise ValueError(
                f"classification {self.classification} needs at least one piece of evidence; "
                "use UNKNOWN if the corpus does not address this step"
            )
        if self.confidence >= 0.7 and len(self.evidence) < 2:
            raise ValueError(
                "confidence >= 0.7 needs at least two pieces of evidence; "
                "lower the confidence or cite a second independent source"
            )


class VerifyIssue(BaseModel):
    """One thing the verifier could not confirm about a submitted entry."""

    code: Literal[
        "quote_not_in_chunk", "chunk_not_retrieved", "chunk_missing",
        "ticket_not_in_graph", "bpml_code_unknown", "confidence_drift",
        "evidence_floor", "class_not_in_mode",
    ]
    severity: Literal["hard", "soft"]
    detail: str


class VerifiedEntry(BaseModel):
    entry: FitGapEntry
    issues: list[VerifyIssue] = Field(default_factory=list)
    repaired: bool = False
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    seconds: float = 0.0

    @property
    def evidence_valid(self) -> bool:
        return not any(i.severity == "hard" for i in self.issues)


class RunRequest(BaseModel):
    mode: Literal["A", "B"] = "A"
    scope_bpml: str = "4.0"
    country_profile: dict | None = None
    asis_dir: str | None = None
    holdout: bool = False
    max_steps: int = Field(default=6, ge=1, le=60)
    concurrency: int = Field(default=3, ge=1, le=8)
    question: str | None = None  # free text the user typed, kept for the audit trail
    # Document categories the run may read. Empty is every one of them. Stored
    # on the run beside the corpus fingerprint: what a run was allowed to see
    # is part of reproducing it (§10).
    categories: list[str] = Field(default_factory=list)
    # An upload session id, when the analyst attached documents of their own.
    # Their chunks live in that session's Postgres schema and are reached by a
    # tool of their own -- never by search_corpus.
    upload_session: str | None = None
    # The account the run belongs to. Set by the server from the session,
    # never by the browser (the API's request models do not have this field).
    user_id: int | None = None


class Review(BaseModel):
    reviewer: str
    verdict: Literal["accept", "reject", "refine"]
    corrected_classification: Classification | None = None
    comment: str = ""
