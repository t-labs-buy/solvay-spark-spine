/** The evaluation questions from docs/three-engine-eval-questions.md.
 *
 *  Q1-Q16 are grounded in the PKG corpus. D1-D6 are grounded in DR, whose
 *  failure modes are different in kind: a workshop leaves questions open, a
 *  transcript records a proposal the minutes never ratify, and the same
 *  session arrives twice under two file names. C1-C5 need both, and exist to
 *  test whether an engine reads across both corpora and reconciles them rather
 *  than answering from whichever half it reached first.
 *
 *  Each one is grounded in a specific passage of the Solvay SPARK corpus and
 *  built to provoke one named failure. Every BPML scope below was checked
 *  against the BPML process hierarchy, so selecting a question
 *  always resolves to a real subtree InsightLens can run a register over.
 */

export type Engine = "rag" | "graph" | "copilot";

/** Which document categories a question needs. "PKG+DR" means neither half of
 *  the corpus can answer it alone -- the point is whether an engine reaches
 *  across both and reconciles what they say. */
export type QuestionCategory = "PKG" | "DR" | "PKG+DR";

/** How each engine is expected to do — the prediction being scored, not a
 *  claim about what it will actually answer. */
export type Expectation = "strong" | "partial" | "weak" | "blind";

export interface EvalQuestion {
  id: string;
  /** The corpus this question is grounded in. */
  category: QuestionCategory;
  /** "Is the fact right?" (Q1-Q8) or "Is its standing right?" (Q9-Q16). */
  half: 1 | 2;
  /** The single dimension this question isolates. */
  axis: string;
  question: string;
  /** A real BPML code; InsightLens runs its register over this subtree. */
  scope: string;
  scopeLabel: string;
  steps: number;
  /** One line: what is actually being measured. */
  tests: string;
  /** The failure this question exists to provoke. */
  watchFor: string;
  /** An automatic fail regardless of the rest of the answer. */
  mustNot?: string;
  /** Double-weighted: a fluent, specific, materially misleading answer. */
  heavy?: boolean;
  expect: Record<Engine, Expectation>;
}

export const HALVES: Record<1 | 2, { title: string; blurb: string }> = {
  1: {
    title: "1 · Is the fact right?",
    blurb: "Retrieval, traversal and reading accuracy.",
  },
  2: {
    title: "2 · Is its standing right?",
    blurb: "Which variant, whose decision, how firm, from what source.",
  },
};

export const EVAL_QUESTIONS: EvalQuestion[] = [
  {
    id: "Q1",
    category: "PKG",
    half: 1,
    axis: "Ontology limits",
    question:
      "Which BPML step does SPARK-22234 implement, and what is the end-to-end message flow for the signed PDF invoice?",
    scope: "4.7.1.3",
    scopeLabel: "Create Billing Document",
    steps: 1,
    tests:
      "Whether an engine admits what its own model cannot represent. CPI, DMS, Arkhineo and GOS carry this flow and none of them is in the graph's six-system ontology.",
    watchFor:
      "The graph presenting its single SOVOS edge as if it were the flow. RAG reproducing the document's INOIC02 typo without noting it sits beside the correct INVOIC02.",
    expect: { rag: "strong", graph: "blind", copilot: "strong" },
  },
  {
    id: "Q2",
    category: "PKG",
    half: 1,
    axis: "False connectivity",
    question: "How does Solvay@eCommerce connect to SOVOS?",
    scope: "4.7.1",
    scopeLabel: "Generate customer invoice",
    steps: 9,
    tests:
      "Whether a shared label is reported as an integration. It does not connect — SOVOS is fed from S/4HANA billing via CPI. The correct answer is a refusal.",
    watchFor:
      "Verified live: query_graph returns a confident 4-hop “integration route” and relabels every edge “Interfaces With”, including two that are only stream membership.",
    mustNot: "Route the answer through “Lead to Cash” as though a stream were a system.",
    heavy: true,
    expect: { rag: "partial", graph: "weak", copilot: "partial" },
  },
  {
    id: "Q3",
    category: "PKG",
    half: 1,
    axis: "Versioning",
    question:
      "For SPARK-21930, what happens when the item-line delivery block is removed, and has that requirement changed since the first version?",
    scope: "4.5.2.2",
    scopeLabel: "Block Delivery",
    steps: 1,
    tests:
      "Two near-identical specs for one ticket. The January version adds an ATP-retrigger requirement and deletes an auto-apply restriction the December one still carries.",
    watchFor:
      "Stating the deleted restriction as current. An InsightLens entry at 0.65 confidence citing one quote from each file — the rubric says a copy is not an independent source.",
    expect: { rag: "partial", graph: "weak", copilot: "strong" },
  },
  {
    id: "Q4",
    category: "PKG",
    half: 1,
    axis: "Entity identity",
    question: "What does SPARK-21999 cover?",
    scope: "4.5.1.4",
    scopeLabel: "Create Standard Order",
    steps: 1,
    tests:
      "There is no SPARK-21999. The file is named L2C_21999 but its body says SPARK-21199 four times and never says 21999 at all.",
    watchFor:
      "An answer that is substantively right and referentially false — describing the CMIR ship-to enhancement without noticing the number is wrong.",
    mustNot: "Treat SPARK-21999 as a real ticket.",
    heavy: true,
    expect: { rag: "partial", graph: "partial", copilot: "strong" },
  },
  {
    id: "Q5",
    category: "PKG",
    half: 1,
    axis: "Cross-document exception",
    question:
      "When a sales order is created, which partner wins for Incoterms, and which for the COA recipient — ship-to or sold-to?",
    scope: "4.5.1.4",
    scopeLabel: "Create Standard Order",
    steps: 1,
    tests:
      "A general rule with its exception filed elsewhere. Ship-to wins for Incoterms; for the COA recipient neither wins — both are copied, and that sits in one row of a small spreadsheet.",
    watchFor:
      "Over-generalising “ship-to always wins” to the COA recipient. With k=8 the deciding chunk may never surface.",
    expect: { rag: "partial", graph: "blind", copilot: "partial" },
  },
  {
    id: "Q6",
    category: "PKG",
    half: 1,
    axis: "Table fidelity",
    question:
      "List every SD billing type with its Italian FI document type, and flag anything inconsistent in that table.",
    scope: "4.7.1",
    scopeLabel: "Generate customer invoice",
    steps: 9,
    tests:
      "Reading a wide, sparse table without tidying it. Only five types have an Italian value; F2 appears twice, one row has no billing type at all, and ZS42/ZS44 post to DA rather than RV.",
    watchFor:
      "Invented Italian numbers for RE, IV or CBRE. A single de-duplicated F2 row. The “Service Billing ??” placeholder quietly cleaned away.",
    mustNot: "Invent an Italian FI document type for a row the sheet leaves blank.",
    expect: { rag: "strong", graph: "blind", copilot: "partial" },
  },
  {
    id: "Q7",
    category: "PKG",
    half: 1,
    axis: "Contradiction detection",
    question: "Does a Forecast Check delivery block stop a purchase requisition being created?",
    scope: "4.5.2.2",
    scopeLabel: "Block Delivery",
    steps: 1,
    tests:
      "One workbook that contradicts itself. The business sheet gives FC a purchase-requisition block; the SAP config sheet gives it only to AL.",
    watchFor:
      "A confident yes or no. The honest answer is that the two sheets disagree and someone has to reconcile them — a DecisionPoint, not a verdict.",
    expect: { rag: "partial", graph: "blind", copilot: "strong" },
  },
  {
    id: "Q8",
    category: "PKG",
    half: 1,
    axis: "Enumeration",
    question:
      "Which SPARK tickets does the eCommerce–SAP interface specification cover, and how many are there?",
    scope: "4.5.1",
    scopeLabel: "Accept and entering sales orders",
    steps: 23,
    tests:
      "Counting, against a document that miscounts itself. It covers 19 tickets; its own header lists 16 entries, 15 distinct, and omits four the body genuinely covers.",
    watchFor:
      "Answering 15 or 16 from the header. Listing 24926 twice. This is not a recall problem — the top-8 chunks do contain all 19 ids.",
    expect: { rag: "partial", graph: "strong", copilot: "strong" },
  },

  // ---- second half: the standing of a fact, not the fact -------------------

  {
    id: "Q9",
    category: "PKG",
    half: 2,
    axis: "Attribution across siblings",
    question: "For a commission contract, is the contract settled by self-billing?",
    scope: "4.4.11",
    scopeLabel: "Manage Commissions",
    steps: 4,
    tests:
      "Three cases in one deck with near-identical bullets. External Agent and Internal/S4HANA say “no self-billing”; Internal/ECC says “self-billing”, 678 lines away.",
    watchFor:
      "A flat answer for all three cases — true for two of them. Or quoting the ECC case as the general rule.",
    mustNot: "Give one self-billing answer covering all three cases.",
    expect: { rag: "partial", graph: "blind", copilot: "partial" },
  },
  {
    id: "Q10",
    category: "PKG",
    half: 2,
    axis: "Documented unknown",
    question:
      "What localization requirement applies to Spain, and what number range is assigned to billing type F2?",
    scope: "4.7.1",
    scopeLabel: "Generate customer invoice",
    steps: 9,
    tests:
      "Three states in one sheet: agreed (ZF5, “Confirmed by Willam”), proposed but not agreed (F2, “TBC - by R2R team”) and open (Spain, written as “??”).",
    watchFor:
      "Spain reported as “not mentioned” — it is mentioned, as an open item. F2's range quoted as settled fact.",
    mustNot: "Quote F2's number range without its TBC status, or invent a Spanish requirement.",
    expect: { rag: "strong", graph: "blind", copilot: "strong" },
  },
  {
    id: "Q11",
    category: "PKG",
    half: 2,
    axis: "Request vs decision",
    question: "Should sales from ECC to S/4HANA be avoided during the interim period?",
    scope: "4.5.1.7",
    scopeLabel: "Create Intercompany Order",
    steps: 1,
    tests:
      "An email thread, not a design. A request (“Any chance to have these switched to SCI?”) and a reply carrying carve-outs for Bicar Pharma and IPH.",
    watchFor:
      "Reporting it as policy. Dropping the exceptions. InsightLens's rubric caps confidence at 0.4 when the only evidence is discussion — an email is squarely that.",
    mustNot: "Present the email exchange as an approved design.",
    heavy: true,
    expect: { rag: "weak", graph: "blind", copilot: "strong" },
  },
  {
    id: "Q12",
    category: "PKG",
    half: 2,
    axis: "Explicit exclusion",
    question: "Which M3 order types does the eCommerce–SAP interface support?",
    scope: "4.5.1",
    scopeLabel: "Accept and entering sales orders",
    steps: 23,
    tests:
      "A false premise. The spec says “M3 is not in scope for S4” four times, while M3 itself appears eleven times — so retrieval returns plenty of M3 passages.",
    watchFor:
      "A list assembled from surrounding context. Embeddings are weak at negation: “M3 is not in scope” and “M3 is supported” look alike to a vector.",
    mustNot: "List any supported M3 order type.",
    expect: { rag: "weak", graph: "blind", copilot: "partial" },
  },
  {
    id: "Q13",
    category: "PKG",
    half: 2,
    axis: "Ontology ≠ inventory",
    question: "Which external systems does the L2C landscape integrate with?",
    scope: "4.0",
    scopeLabel: "Lead to Cash",
    steps: 128,
    tests:
      "The graph knows six systems because six are hard-coded. The corpus names at least thirteen more — Coface, Esker, Elemica, CPI, DMS, Arkhineo, VIM, OMP, Nexus, MS Fabric, Celonis, Ariba, MDG.",
    watchFor:
      "Six presented as the complete landscape. Omitting CPI is the worst case: it mediates the SOVOS, eCommerce and ECC interfaces, so a landscape without it is wrong about every integration in the corpus.",
    mustNot: "Present six systems as the complete landscape.",
    heavy: true,
    expect: { rag: "partial", graph: "weak", copilot: "strong" },
  },
  {
    id: "Q14",
    category: "PKG",
    half: 2,
    axis: "Which copy",
    question:
      "What is the German label for the freight order field on the billing form, and has the translation work been done?",
    scope: "4.7.1.3",
    scopeLabel: "Create Billing Document",
    steps: 1,
    tests:
      "The same 54 rows in two files — one an entirely blank template, one filled in seven languages. The answer is Frachtauftrag:, and the key misspells FREIGHT as FRIEGHT.",
    watchFor:
      "“Not yet translated”, taken confidently from the blank template. The key silently corrected to FREIGHTORDER, which is an identifier that does not exist.",
    mustNot: "Report the German translation as undefined, or tidy the FRIEGHT typo.",
    expect: { rag: "partial", graph: "blind", copilot: "partial" },
  },
  {
    id: "Q15",
    category: "PKG",
    half: 2,
    axis: "Direction",
    question:
      "In the ECC-selling / S4-supplying flow, at which step is the intercompany invoice raised, and in which direction does the IDoc travel?",
    scope: "4.5.1.7",
    scopeLabel: "Create Intercompany Order",
    steps: 1,
    tests:
      "The order flows ECC→S4; the goods and the invoice flow S4→ECC. A mirror document assigns the roles the opposite way round.",
    watchFor:
      "Steps drawn from the return document. Conflating order direction with invoice direction — they are genuinely opposite here, which is what makes a wrong answer sound plausible.",
    mustNot: "Place the intercompany invoice in ECC.",
    expect: { rag: "weak", graph: "blind", copilot: "partial" },
  },
  {
    id: "Q16",
    category: "PKG",
    half: 2,
    axis: "Provenance",
    question:
      "In the S4-selling / ECC-supplying return scenario, what is created in ECC after the return order, and how confident should I be in that answer?",
    scope: "4.10.2",
    scopeLabel: "Process Returns",
    steps: 3,
    tests:
      "A 20 KB document that is twelve VLM-read screenshots, three unreadable images and seven lines of human prose. Every concrete value was transcribed by a model.",
    watchFor:
      "Document numbers quoted as authoritative with no caveat. The RAG prompt explicitly instructs the model to flag OCR-derived text, so this tests an instruction the system claims to follow.",
    mustNot: "Quote a transcribed document number with no provenance caveat.",
    heavy: true,
    expect: { rag: "partial", graph: "blind", copilot: "partial" },
  },
  // ---------------------------------------------------------------- DR corpus
  // Grounded in solvay-spark/dr/markdown. A workshop record fails differently
  // from a specification: it defers, it proposes without deciding, and it
  // arrives twice under two names.
  {
    id: "D1",
    category: "DR",
    half: 2,
    axis: "Proposal vs decision",
    question:
      "For returnable packaging, was the sales-order-based solution or the EWM solution chosen, and what was settled about ATP for packaging materials?",
    scope: "4.5.1",
    scopeLabel: "Accept and entering sales orders",
    steps: 23,
    tests:
      "Nothing was chosen. L2C-WS022 demonstrated the sales-driven process and closed with five open items, every one owned by I2D and due \u201cTBC Next Session\u201d, including whether EWM can invoice unreturned packaging. On ATP the minutes confirm the opposite of a solution: no ATP runs for these materials and manual follow-up is required.",
    watchFor:
      "Reporting the demonstrated process as the decision. A transcript is full of someone explaining how the standard solution works; that is a demonstration, not an agreement.",
    mustNot: "State that returnable packaging is settled on either the sales-order or the EWM solution.",
    heavy: true,
    expect: { rag: "partial", graph: "blind", copilot: "strong" },
  },
  {
    id: "D2",
    category: "DR",
    half: 2,
    axis: "Unowned actions",
    question:
      "What did the master data follow-up session decide about customer material info records, and who owns the outcome?",
    scope: "4.5.1.4",
    scopeLabel: "Create Standard Order",
    steps: 1,
    tests:
      "L2C-WS048 (01.08.2025) closes with 28 action items. Almost every one carries owner TBD and due date TBD, including \u201cverify whether CMIR prioritize ship-to over sold-to\u201d. Only two carry a date at all. The honest answer names the question and says nobody owns it.",
    watchFor:
      "An answer that reads the action item as the answer \u2014 \u201cCMIR prioritise ship-to\u201d \u2014 when the item is the question, not its resolution.",
    mustNot: "Attribute an owner to an action item whose owner is TBD.",
    expect: { rag: "partial", graph: "blind", copilot: "strong" },
  },
  {
    id: "D3",
    category: "DR",
    half: 2,
    axis: "Which copy",
    question:
      "How many independent records are there of the returnable packaging workshop, and do they agree?",
    scope: "4.5.1",
    scopeLabel: "Accept and entering sales orders",
    steps: 23,
    tests:
      "Four files carry L2C-WS022: a deck, minutes, and two transcripts that are byte-for-byte identical under different names. There are three independent records, not four. The same trap exists for L2C-WS002.",
    watchFor:
      "Counting files as sources. Two identical transcripts quoted as mutual corroboration is the failure the independence check exists to catch \u2014 verify it fires.",
    mustNot: "Present the two identical transcripts as two sources that agree.",
    heavy: true,
    expect: { rag: "weak", graph: "partial", copilot: "strong" },
  },
  {
    id: "D4",
    category: "DR",
    half: 1,
    axis: "Cross-stream deferral",
    question:
      "Who is responsible for deciding how returnable packaging material is determined at delivery level, and how large containers are handled?",
    scope: "4.5.1",
    scopeLabel: "Accept and entering sales orders",
    steps: 23,
    tests:
      "Both were handed out of Lead to Cash. Packaging determination was deferred to I2D as an open item; large fleets (rail cars, containers) sit with Transportation Management, where the minutes record identified gaps and ongoing discussions with SAP. Small fleets (cylinders, IBCs) stay in EWM.",
    watchFor:
      "Answering as though L2C owns it, because the L2C workshop is where the discussion appears. The corpus is a Lead to Cash corpus, which makes every answer look like an L2C answer.",
    expect: { rag: "partial", graph: "weak", copilot: "partial" },
  },
  {
    id: "D5",
    category: "DR",
    half: 2,
    axis: "Session supersession",
    question:
      "What is the current state of the pricing procedure design, and which session last touched it?",
    scope: "4.5.1.3",
    scopeLabel: "Determine Order Type",
    steps: 1,
    tests:
      "Pricing runs across L2C-WS015 (Part 1, 13.05.2025), L2C-WS016 (Part 2) and a dedicated configuration meeting on 06.11.2025 whose minutes close with 20 action items, all TBD, including whether to remove condition types and subtotals such as Net Value Two. The later session supersedes the earlier decks.",
    watchFor:
      "Quoting the May workshop deck as current when a November meeting reopened the procedure. Three near-identical WS015 pricing decks also invite a copy being read as a second opinion.",
    expect: { rag: "partial", graph: "weak", copilot: "partial" },
  },
  {
    id: "D6",
    category: "DR",
    half: 1,
    axis: "Register is not evidence",
    question:
      "According to the L2C fit register, which processes are FITs, and does the register say why?",
    scope: "4.0",
    scopeLabel: "Lead to Cash",
    steps: 128,
    tests:
      "The register lists tickets with one-line summaries and an owner \u2014 SPARK-18542 appears as \u201cO-020-020 Determine Order Type - FIT\u201d with a user story, nothing more. It records a classification; it does not evidence one. A companion file is titled FITs with missing description.",
    watchFor:
      "Treating a register row as a design decision with reasoning behind it. The register is the single densest file in DR and dominates retrieval, so it will surface for almost any FIT question.",
    mustNot: "Present a register row as the rationale for a classification.",
    expect: { rag: "weak", graph: "partial", copilot: "strong" },
  },
  // ------------------------------------------------------- PKG + DR, combined
  // Each of these was checked by retrieving it three times -- unfiltered, PKG
  // only, DR only -- and kept because neither half answers it correctly alone.
  {
    id: "C1",
    category: "PKG+DR",
    half: 2,
    axis: "Open question later closed",
    question:
      "Do customer material info records prioritise ship-to over sold-to, and is that still an open question?",
    scope: "4.5.1.4",
    scopeLabel: "Create Standard Order",
    steps: 1,
    tests:
      "DR leaves it open: L2C-WS048 on 01.08.2025 lists “verify whether CMIR prioritize ship-to over sold-to” with owner TBD. PKG answers it: the functional specification dated 2025-10-31 sets the sequence — ship-to CMIR first, then sold-to — and notes the shipping-condition half is standard configuration. The dates settle it; the specification is the later word.",
    watchFor:
      "DR alone reports an unresolved question. PKG alone reports a settled design and never mentions it was open. Both are wrong: the answer is that the August question was closed in October.",
    mustNot: "Report the question as still open without the specification, or as never having been open.",
    heavy: true,
    expect: { rag: "partial", graph: "weak", copilot: "strong" },
  },
  {
    id: "C2",
    category: "PKG+DR",
    half: 1,
    axis: "Two coding schemes",
    question: "Which process step does SPARK-18542 belong to, and is it a FIT?",
    scope: "4.5.1.3",
    scopeLabel: "Determine Order Type",
    steps: 1,
    tests:
      "The two halves index it differently. PKG's specification titles it “4.5.1.3 Determine Order Type - FIT”; DR's register keys the same ticket to dash code “O-020-020”. Both are right and they must be reconciled. The FIT label also sits on an interface specification carrying mapping, message type, routing and reprocessing sections — worth questioning.",
    watchFor:
      "Reporting one code and not the other, or treating 4.5.1.3 and O-020-020 as two different steps. Also a FIT taken at face value when the document beneath it specifies an interface build.",
    expect: { rag: "partial", graph: "partial", copilot: "strong" },
  },
  {
    id: "C3",
    category: "PKG+DR",
    half: 1,
    axis: "Specification and workshop",
    question:
      "What does SPARK-22234 require for the signed PDF invoice, and what did the outputs workshop say about EDI, IDOC and forms?",
    scope: "4.7.1.3",
    scopeLabel: "Create Billing Document",
    steps: 1,
    tests:
      "PKG holds the SOVOS interface specification; DR holds the L2C-WS006 outputs deck with its minutes and transcript. Verified as the most balanced question in the set: five PKG chunks and five DR chunks in one unfiltered retrieval.",
    watchFor:
      "An answer built only from the specification, which describes the intended flow but not what the workshop raised about output determination across EDI, IDOC and forms.",
    expect: { rag: "strong", graph: "weak", copilot: "strong" },
  },
  {
    id: "C4",
    category: "PKG+DR",
    half: 2,
    axis: "Design vs conclusion",
    question:
      "How is the invoice split handled, and what did the billing workshop conclude about it?",
    scope: "4.7.1.3",
    scopeLabel: "Create Billing Document",
    steps: 1,
    tests:
      "PKG has the SPARK-49618 billing split enhancement and the billing-types workbook; DR has the L2C-WS018 billing deck and its two-part transcript. Verified end to end through the Evidence Agent: eleven PKG chunks and four DR chunks in one answer.",
    watchFor:
      "Reporting the custom BAdI split as settled without the workshop, or the workshop discussion without the enhancement that specifies the logic.",
    expect: { rag: "strong", graph: "weak", copilot: "strong" },
  },
  {
    id: "C5",
    category: "PKG+DR",
    half: 2,
    axis: "Corpus asymmetry",
    question:
      "What is the agreed approach for agent commissions settlement in S/4, and which document specifies the commissions reporting?",
    scope: "4.0",
    scopeLabel: "Lead to Cash",
    steps: 128,
    tests:
      "Both halves are needed and a single search does not find them: one unfiltered retrieval returns ten DR chunks and no PKG at all, because workshop vocabulary dominates. The agent recovers by reformulating toward specification language. Tests whether an engine notices it has only half the picture.",
    watchFor:
      "Answering entirely from WS-045, WS-046 and WS017-02 minutes and never reaching the cross-stream commissions process or the reporting-needs workbook in PKG. One query is not enough here; the failure is stopping after it.",
    heavy: true,
    expect: { rag: "weak", graph: "weak", copilot: "strong" },
  },
];

export const EXPECTATION_LABEL: Record<Expectation, string> = {
  strong: "Should handle it",
  partial: "Partial at best",
  weak: "Expected to fail",
  blind: "Structurally cannot",
};

export const ENGINE_LABEL: Record<Engine, string> = {
  rag: "RAG",
  graph: "Graph",
  copilot: "InsightLens",
};

export const AXES = Array.from(new Set(EVAL_QUESTIONS.map((q) => q.axis)));

/** The pickers' option order.
 *
 *  MUI's Autocomplete repeats a group header whenever the options are not
 *  already sorted by group, and the questions are authored in the order they
 *  were written, which interleaves the two halves within DR and PKG+DR. This
 *  is the same set, ordered so each header appears once. */
export const EVAL_QUESTIONS_BY_GROUP: EvalQuestion[] = (() => {
  const rank: Record<QuestionCategory, number> = { PKG: 0, DR: 1, "PKG+DR": 2 };
  return [...EVAL_QUESTIONS].sort(
    (a, b) =>
      rank[a.category] - rank[b.category] ||
      a.half - b.half ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
})();

export const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  PKG: "PKG · specifications",
  DR: "DR · workshops and minutes",
  "PKG+DR": "PKG + DR · needs both",
};
