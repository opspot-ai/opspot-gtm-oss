import { describe, expect, it } from "vitest";
import {
  CommandInputSchemas,
  DecisionTraceSchema,
  EvaluationContractInputSchema,
  ExperimentRecordInputSchema,
  InitiativeDecisionInputSchema,
  PlayPromotionInputSchema,
  ReceiptAttachInputSchema,
  ReceiptSchema,
  SKILL_EVIDENCE_STATE_ORDER,
  SKILL_EVIDENCE_STATE_RANK,
  SkillVersionInputSchema
} from "@opspot/contracts";

const HASH = "a".repeat(64);
const START = "2026-07-20T02:00:00.000Z";
const END = "2026-07-20T03:00:00.000Z";

function receiptAttachInput() {
  return {
    id: "receipt_attached_001",
    ventureId: "venture_engine",
    proofTier: "internally-live",
    outcome: "success",
    actor: "operator",
    adapter: "local-artifact",
    artifactPath: "receipts/attached.json",
    contentHash: HASH,
    occurredAt: END,
    metadata: { receiptType: "supporting-artifact" }
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "initiative_001",
    ventureId: "venture_engine",
    goalRevisionId: "goal_001",
    capabilityId: "market-problem-research",
    title: "Test the next bounded initiative",
    hypothesis: "The initiative will reduce uncertainty",
    dependencyIds: [],
    requirementIds: ["requirement_001"],
    expectedOutcome: "A decision-quality result",
    expectedProof: "An authoritative receipt",
    successThreshold: "Quality improves",
    failureThreshold: "Quality does not improve",
    stopCondition: "Stop at the resource bound",
    estimatedHours: 1,
    estimatedCostCents: 100,
    autonomyMode: "propose",
    gateClasses: [],
    uncertainty: 0.4,
    uncertaintyReason: "The outcome has not been tested",
    assumptions: [],
    evidenceIds: ["evidence_001"],
    ...overrides
  };
}

function decisionInput(candidateOverrides: Record<string, unknown> = {}) {
  return {
    ventureId: "venture_engine",
    packRevisionId: "packrev_001",
    goalRevisionId: "goal_001",
    candidates: [candidate(candidateOverrides)],
    selectionMode: "evaluated",
    baseline: {
      kind: "plain-agent",
      description: "Frozen plain-agent baseline",
      receiptIds: ["receipt_plain"],
      score: 0.7,
      costCents: 10,
      founderMinutes: 0
    },
    evaluationContractId: "evaluation_001",
    plannerId: "planner",
    evaluatorId: "evaluator",
    decisionPolicy: "Use the frozen evaluator",
    evidenceIds: ["evidence_001"],
    requestedAt: START,
    idempotencyKey: "decision-input-001"
  };
}

function evaluationInput() {
  return {
    ventureId: "venture_engine",
    packRevisionId: "packrev_001",
    goalRevisionId: "goal_001",
    name: "Planner quality evaluation",
    hypothesis: "The candidate planner improves decision quality",
    baseline: {
      description: "Frozen plain-agent baseline",
      receiptIds: ["receipt_baseline"],
      primaryMetricValue: 0.7,
      plainAgentReceiptIds: ["receipt_plain"],
      noHistoryReceiptIds: ["receipt_no_history"]
    },
    primaryMetric: {
      id: "metric_quality",
      name: "Decision quality",
      unit: "score",
      direction: "higher-is-better",
      formula: "correct_points / available_points",
      tieRule: "Prefer lower fully loaded cost, otherwise abstain",
      missingEvidenceRule: "Return inconclusive",
      abstentionScore: 0,
      minimumImprovement: 0.05,
      minimumSampleSize: 1
    },
    hardGates: [
      {
        id: "gate_safety",
        description: "No unauthorized action",
        evidenceRequirement: "Policy receipt",
        failureDisposition: "unsafe"
      }
    ],
    evaluationPopulation: {
      kind: "hidden-held-out",
      description: "Frozen hidden cases",
      caseRefs: ["case_001"],
      populationHash: HASH,
      minimumSampleSize: 1
    },
    mutableSurface: ["planner prompt"],
    bounds: {
      maxAttempts: 2,
      maxElapsedMs: 60_000,
      maxCostCents: 500,
      maxFounderMinutes: 10,
      maxReviewerMinutes: 20,
      autonomyMode: "propose",
      allowedGateClasses: [],
      forbiddenActions: ["external send"],
      timeoutMs: 10_000,
      killSwitchPath: "internal://kill",
      rollbackRoute: "revert candidate"
    },
    observationWindow: { startsAt: START, endsAt: END },
    expectedReceiptTypes: ["evaluation"],
    knownConfounders: [],
    producerId: "producer",
    evaluatorId: "evaluator",
    reviewerId: "reviewer",
    promotionAuthorityId: "promoter",
    promotionRule: {
      minimumPrimaryMetricImprovement: 0.05,
      maximumCostIncreasePercent: 10,
      maximumFounderTimeIncreasePercent: 0,
      maximumComplexityIncreasePercent: 5,
      minimumSampleSize: 1,
      requireAllHardGates: true,
      requireIndependentReview: true,
      requireHeldOut: true,
      requireCrossVenture: false,
      allowedDispositions: ["keep"]
    },
    promotionRuleHash: HASH,
    requestedAt: START,
    idempotencyKey: "evaluation-input-001"
  };
}

it("requires an authoritative-system population to freeze its source snapshot hash", () => {
  const withoutHash = {
    ...evaluationInput(),
    evaluationPopulation: {
      kind: "authoritative-system",
      description: "Authoritative outcome stream",
      caseRefs: [],
      authoritativeSourceRef: "source_outcomes",
      minimumSampleSize: 1
    }
  };
  expect(EvaluationContractInputSchema.safeParse(withoutHash).success).toBe(false);

  expect(EvaluationContractInputSchema.safeParse({
    ...withoutHash,
    evaluationPopulation: { ...withoutHash.evaluationPopulation, populationHash: HASH }
  }).success).toBe(true);
});

function experimentInput() {
  return {
    ventureId: "venture_engine",
    evaluationContractId: "evaluation_001",
    evaluationContractHash: HASH,
    goalRevisionId: "goal_001",
    skillVersionId: "skillversion_001",
    hypothesis: "One bounded change improves the metric",
    baselineReceiptId: "receipt_baseline",
    producerId: "producer",
    candidateVersion: "0.2.0",
    candidateArtifactHash: HASH,
    attempts: [
      {
        attempt: 1,
        startedAt: START,
        completedAt: END,
        candidateHash: HASH,
        outcome: "succeeded",
        receiptIds: ["receipt_attempt"],
        providerCostCents: 10,
        modelCostCents: 20,
        elapsedMs: 1_000,
        founderMinutes: 0,
        reviewerMinutes: 5,
        sideEffects: [],
        confounders: []
      }
    ],
    costs: {
      providerCostCents: 10,
      modelCostCents: 20,
      otherCostCents: 0,
      founderMinutes: 0,
      reviewerMinutes: 5,
      elapsedMs: 1_000
    },
    receiptIds: ["receipt_baseline", "receipt_attempt", "receipt_scoring", "receipt_review"],
    outcomeReceiptId: "receipt_attempt",
    outcomeSummary: "The candidate beat the baseline",
    confounders: [],
    primaryMetricResult: {
      metricId: "metric_quality",
      baselineValue: 0.7,
      candidateValue: 0.8,
      improvement: 0.1,
      sampleSize: 1,
      thresholdPassed: true,
      scoringReceiptId: "receipt_scoring"
    },
    hardGateResults: [
      { hardGateId: "gate_safety", passed: true, evidenceIds: ["receipt_attempt"], reason: "No violation" }
    ],
    reviewer: {
      reviewerId: "reviewer",
      reviewedAt: END,
      independentFromProducer: true,
      receiptId: "receipt_review",
      verdict: "keep",
      notes: "Frozen evaluator passed"
    },
    missingOutputs: [],
    disposition: "keep",
    complexityDeltaPercent: 1,
    implementationState: "retained",
    refinements: [
      {
        sequence: 1,
        description: "Clarified one instruction",
        rationale: "Remove ambiguity without changing the evaluator",
        diffHash: HASH,
        mutableSurface: ["planner prompt"],
        recordedAt: START
      }
    ],
    recordedAt: END,
    idempotencyKey: "experiment-input-001"
  };
}

function skillVersionInput() {
  return {
    ventureId: "venture_engine",
    skillId: "skill_planner",
    version: "0.2.0",
    name: "Planner skill",
    state: "cross-venture-proven",
    artifactPath: "skills/planner/SKILL.md",
    artifactHash: HASH,
    applicability: ["founder-led software"],
    exclusions: [],
    assumptions: [],
    mutableSurface: ["planner prompt"],
    evidenceIds: ["evidence_001"],
    evaluationContractIds: ["evaluation_001"],
    experimentRecordIds: ["experiment_001"],
    evaluatedVentureIds: [],
    supersedesSkillVersionId: "skillversion_prior",
    producerId: "producer",
    recordedBy: "promoter",
    reason: "Held-out result is available",
    recordedAt: END,
    idempotencyKey: "skill-version-input-001"
  };
}

function promotionInput() {
  return {
    ventureId: "venture_engine",
    playId: "play_planner",
    skillVersionId: "skillversion_001",
    fromState: "held-out-verified",
    toState: "cross-venture-proven",
    decision: "promote",
    evaluationContractIds: ["evaluation_001"],
    experimentRecordIds: ["experiment_001"],
    evidenceIds: ["evidence_001"],
    transferVentureIds: ["venture_beacon"],
    outcomeDefinitionHash: HASH,
    supportedArchetypes: ["founder-led software"],
    unsupportedArchetypes: [],
    noHistoryBaselineReceiptIds: [],
    plainAgentBaselineReceiptIds: [],
    hardGatesPassed: true,
    leakageDetected: false,
    costWithinTolerance: true,
    founderTimeWithinTolerance: true,
    complexityWithinTolerance: true,
    producerId: "producer",
    evaluatorId: "evaluator",
    reviewerId: "reviewer",
    promotionAuthorityId: "promoter",
    reason: "Transfer beat the frozen baselines",
    requestedAt: END,
    idempotencyKey: "promotion-input-001"
  };
}

describe("Phase 9 contract invariants", () => {
  it("keeps receipt origin engine-owned while preserving legacy stored receipts", () => {
    const input = receiptAttachInput();
    expect(ReceiptAttachInputSchema.safeParse(input).success).toBe(true);
    expect(CommandInputSchemas["receipt.attach"].safeParse(input).success).toBe(true);
    expect(ReceiptAttachInputSchema.safeParse({ ...input, origin: "dispatch" }).success).toBe(false);
    expect(CommandInputSchemas["receipt.attach"].safeParse({ ...input, origin: "fixture" }).success).toBe(false);

    const legacy = ReceiptSchema.parse(input);
    expect(legacy.origin).toBe("legacy");
    for (const origin of ["dispatch", "engine-derived", "attached-artifact", "fixture", "legacy"] as const) {
      expect(ReceiptSchema.safeParse({ ...input, origin }).success).toBe(true);
    }
    expect(ReceiptSchema.safeParse({ ...input, origin: "caller-claimed" }).success).toBe(false);
  });

  it("allows an honest no-goal abstention and rejects a no-goal selection", () => {
    const trace = {
      id: "decision_001",
      ventureId: "venture_engine",
      packRevisionId: "packrev_001",
      candidates: [],
      assessments: [],
      selectionMode: "deterministic-eligibility",
      baseline: { kind: "none", description: "No goal means no comparable decision", receiptIds: [] },
      abstain: true,
      abstainReason: "No confirmed goal revision",
      uncertainty: 1,
      uncertaintyReason: "The destination is unknown",
      plannerId: "planner",
      evaluatorId: "evaluator",
      evidenceIds: [],
      createdAt: END,
      idempotencyKey: "decision-trace-001",
      canonicalHash: HASH
    };

    expect(DecisionTraceSchema.safeParse(trace).success).toBe(true);
    expect(DecisionTraceSchema.safeParse({ ...trace, abstain: false }).success).toBe(false);
  });

  it("rejects initiative candidates from another venture or goal revision", () => {
    expect(InitiativeDecisionInputSchema.safeParse(decisionInput({ ventureId: "venture_other" })).success).toBe(false);
    expect(InitiativeDecisionInputSchema.safeParse(decisionInput({ goalRevisionId: "goal_other" })).success).toBe(false);
  });

  it("separates evaluator and producer and freezes metric scoring semantics", () => {
    const input = evaluationInput();
    const parsed = EvaluationContractInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.primaryMetric).toMatchObject({
        formula: "correct_points / available_points",
        tieRule: "Prefer lower fully loaded cost, otherwise abstain",
        missingEvidenceRule: "Return inconclusive",
        abstentionScore: 0
      });
    }

    expect(EvaluationContractInputSchema.safeParse({ ...input, evaluatorId: "producer" }).success).toBe(false);
    expect(
      EvaluationContractInputSchema.safeParse({
        ...input,
        observationWindow: { startsAt: END, endsAt: START }
      }).success
    ).toBe(false);

    const metricWithoutFormula = Object.fromEntries(Object.entries(input.primaryMetric).filter(([key]) => key !== "formula"));
    expect(EvaluationContractInputSchema.safeParse({ ...input, primaryMetric: metricWithoutFormula }).success).toBe(false);
  });

  it("requires the reviewer verdict and receipt to be part of the experiment record", () => {
    const input = experimentInput();
    expect(ExperimentRecordInputSchema.safeParse(input).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        reviewer: { ...input.reviewer, verdict: "discard" }
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        receiptIds: input.receiptIds.filter((receiptId) => receiptId !== "receipt_review")
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        receiptIds: input.receiptIds.filter((receiptId) => receiptId !== "receipt_scoring")
      }).success
    ).toBe(false);
  });

  it("preserves failed-gate proof for the frozen evaluator disposition and rejects invalid attempt chronology", () => {
    const input = experimentInput();
    const failedGate = {
      ...input,
      hardGateResults: [{ ...input.hardGateResults[0], passed: false, reason: "Unauthorized action" }],
      disposition: "discard",
      implementationState: "reverted",
      reviewer: { ...input.reviewer, verdict: "discard" }
    };
    expect(ExperimentRecordInputSchema.safeParse(failedGate).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...failedGate,
        disposition: "gated",
        implementationState: "not-applied",
        reviewer: { ...failedGate.reviewer, verdict: "gated" }
      }).success
    ).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...failedGate,
        disposition: "unsafe",
        reviewer: { ...failedGate.reviewer, verdict: "unsafe" }
      }).success
    ).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        attempts: [{ ...input.attempts[0], startedAt: END, completedAt: START }]
      }).success
    ).toBe(false);
  });

  it("requires evidence for every hard-gate verdict, including unsafe failures", () => {
    const input = experimentInput();
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        hardGateResults: [{ ...input.hardGateResults[0], evidenceIds: [] }]
      }).success
    ).toBe(false);

    const unprovenFailure = {
      ...input,
      hardGateResults: [
        { ...input.hardGateResults[0], passed: false, evidenceIds: [], reason: "The gate failed before proof could be produced" }
      ],
      disposition: "unsafe",
      implementationState: "reverted",
      reviewer: { ...input.reviewer, verdict: "unsafe" }
    };
    expect(ExperimentRecordInputSchema.safeParse(unprovenFailure).success).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...unprovenFailure,
        hardGateResults: [{ ...unprovenFailure.hardGateResults[0], evidenceIds: ["receipt_attempt"] }]
      }).success
    ).toBe(true);
  });

  it("records a pre-run gate without inventing attempts, scores, review, or unknown costs", () => {
    const input = experimentInput();
    const gated = {
      ...input,
      attempts: [],
      costs: {
        providerCostCents: 0,
        modelCostCents: 0,
        otherCostCents: 0,
        founderMinutes: 0,
        reviewerMinutes: 0,
        elapsedMs: 0
      },
      outcomeReceiptId: undefined,
      primaryMetricResult: null,
      hardGateResults: [],
      reviewer: null,
      missingOutputs: ["attempts", "outcomeReceiptId", "primaryMetricResult", "hardGateResults", "reviewer"],
      disposition: "gated",
      implementationState: "not-applied"
    };

    expect(ExperimentRecordInputSchema.safeParse(gated).success).toBe(true);
    expect(ExperimentRecordInputSchema.safeParse({ ...gated, implementationState: "reverted" }).success).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...gated,
        missingOutputs: gated.missingOutputs.filter((output) => output !== "primaryMetricResult")
      }).success
    ).toBe(false);
  });

  it("distinguishes explicitly unknown costs from known zero and audits the exact missing-output set", () => {
    const input = experimentInput();
    const unknownCosts = {
      providerCostCents: null,
      modelCostCents: null,
      otherCostCents: null,
      founderMinutes: null,
      reviewerMinutes: null,
      elapsedMs: null
    };
    const gatedUnknown = {
      ...input,
      attempts: [],
      costs: unknownCosts,
      outcomeReceiptId: undefined,
      primaryMetricResult: null,
      hardGateResults: [],
      reviewer: null,
      missingOutputs: [
        "attempts",
        "costs.providerCostCents",
        "costs.modelCostCents",
        "costs.otherCostCents",
        "costs.founderMinutes",
        "costs.reviewerMinutes",
        "costs.elapsedMs",
        "outcomeReceiptId",
        "primaryMetricResult",
        "hardGateResults",
        "reviewer"
      ],
      disposition: "gated",
      implementationState: "not-applied"
    };

    expect(ExperimentRecordInputSchema.safeParse(gatedUnknown).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...gatedUnknown,
        costs: { ...unknownCosts, providerCostCents: 0 }
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...gatedUnknown,
        missingOutputs: [...gatedUnknown.missingOutputs, "reviewer"]
      }).success
    ).toBe(false);
  });

  it("requires an attempted run and named missing outputs for inconclusive", () => {
    const input = experimentInput();
    const inconclusive = {
      ...input,
      primaryMetricResult: null,
      reviewer: null,
      missingOutputs: ["primaryMetricResult", "reviewer"],
      disposition: "inconclusive",
      implementationState: "reverted"
    };

    expect(ExperimentRecordInputSchema.safeParse(inconclusive).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...inconclusive,
        attempts: [],
        missingOutputs: ["attempts", "primaryMetricResult", "reviewer"]
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        disposition: "inconclusive",
        reviewer: { ...input.reviewer, verdict: "inconclusive" },
        implementationState: "reverted"
      }).success
    ).toBe(false);
    expect(ExperimentRecordInputSchema.safeParse({ ...inconclusive, implementationState: "retained" }).success).toBe(false);
  });

  it("requires a receipted crashed attempt for crash", () => {
    const input = experimentInput();
    const crash = {
      ...input,
      attempts: [{ ...input.attempts[0], outcome: "crashed" }],
      primaryMetricResult: null,
      hardGateResults: [],
      reviewer: null,
      missingOutputs: ["primaryMetricResult", "hardGateResults", "reviewer"],
      disposition: "crash",
      implementationState: "reverted"
    };

    expect(ExperimentRecordInputSchema.safeParse(crash).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...crash,
        attempts: [{ ...crash.attempts[0], outcome: "failed" }]
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...crash,
        attempts: [{ ...crash.attempts[0], receiptIds: [] }],
        missingOutputs: [...crash.missingOutputs, "attempts.receipts"]
      }).success
    ).toBe(false);
  });

  it("requires receipted unsafe behavior or failed-gate proof for unsafe", () => {
    const input = experimentInput();
    const unsafeAttempt = {
      ...input,
      attempts: [{ ...input.attempts[0], outcome: "unsafe" }],
      primaryMetricResult: null,
      hardGateResults: [],
      reviewer: null,
      missingOutputs: ["primaryMetricResult", "hardGateResults", "reviewer"],
      disposition: "unsafe",
      implementationState: "reverted"
    };
    expect(ExperimentRecordInputSchema.safeParse(unsafeAttempt).success).toBe(true);

    const failedGateProof = {
      ...unsafeAttempt,
      attempts: [{ ...input.attempts[0], outcome: "failed" }],
      hardGateResults: [{ ...input.hardGateResults[0], passed: false, reason: "Safety gate failed" }],
      missingOutputs: ["primaryMetricResult", "reviewer"]
    };
    expect(ExperimentRecordInputSchema.safeParse(failedGateProof).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...failedGateProof,
        hardGateResults: [{ ...input.hardGateResults[0], passed: true }]
      }).success
    ).toBe(false);
  });

  it("requires score and review for discard without pretending discard is keep", () => {
    const input = experimentInput();
    const discard = {
      ...input,
      primaryMetricResult: { ...input.primaryMetricResult, thresholdPassed: false },
      reviewer: { ...input.reviewer, verdict: "discard" },
      disposition: "discard",
      implementationState: "reverted"
    };
    expect(ExperimentRecordInputSchema.safeParse(discard).success).toBe(true);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...discard,
        primaryMetricResult: null,
        missingOutputs: ["primaryMetricResult"]
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...discard,
        reviewer: null,
        missingOutputs: ["reviewer"]
      }).success
    ).toBe(false);
  });

  it("keeps only fully receipted, exactly costed, passing results", () => {
    const input = experimentInput();
    expect(ExperimentRecordInputSchema.safeParse(input).success).toBe(true);
    expect(ExperimentRecordInputSchema.safeParse({ ...input, implementationState: "not-applied" }).success).toBe(true);
    expect(ExperimentRecordInputSchema.safeParse({ ...input, implementationState: "reverted" }).success).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        attempts: [{ ...input.attempts[0], providerCostCents: null }],
        missingOutputs: ["attempts.costs"]
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        costs: { ...input.costs, providerCostCents: 11 }
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        terminalReceiptId: "receipt_caller_spoofed_terminal"
      }).success
    ).toBe(false);
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        primaryMetricResult: { ...input.primaryMetricResult, thresholdPassed: false }
      }).success
    ).toBe(false);
  });

  it("requires an independent reviewer before keeping an experiment", () => {
    const input = experimentInput();
    expect(
      ExperimentRecordInputSchema.safeParse({
        ...input,
        reviewer: { ...input.reviewer, reviewerId: "producer", independentFromProducer: false }
      }).success
    ).toBe(false);
  });

  it("requires evidence and a distinct second venture for cross-venture skill state", () => {
    const input = skillVersionInput();
    expect(SkillVersionInputSchema.safeParse(input).success).toBe(false);
    expect(
      SkillVersionInputSchema.safeParse({ ...input, evaluatedVentureIds: ["venture_beacon"] }).success
    ).toBe(true);
  });

  it("keeps draft skills evidence-free and requires an explicit predecessor for proven states", () => {
    const input = skillVersionInput();
    const draft = {
      ...input,
      state: "draft",
      evidenceIds: [],
      evaluationContractIds: [],
      experimentRecordIds: [],
      evaluatedVentureIds: [],
      supersedesSkillVersionId: undefined
    };
    expect(SkillVersionInputSchema.safeParse(draft).success).toBe(true);
    expect(SkillVersionInputSchema.safeParse({ ...draft, evidenceIds: ["evidence_claimed"] }).success).toBe(false);
    expect(
      SkillVersionInputSchema.safeParse({
        ...input,
        evaluatedVentureIds: ["venture_beacon"],
        supersedesSkillVersionId: undefined
      }).success
    ).toBe(false);
  });

  it("defines a strict adjacent evidence-state order and rejects skipped or regressive promotions", () => {
    expect(SKILL_EVIDENCE_STATE_ORDER).toEqual(["draft", "candidate", "held-out-verified", "cross-venture-proven"]);
    expect(SKILL_EVIDENCE_STATE_RANK).toEqual({
      draft: 0,
      candidate: 1,
      "held-out-verified": 2,
      "cross-venture-proven": 3
    });

    const base = {
      ...promotionInput(),
      noHistoryBaselineReceiptIds: ["receipt_no_history"],
      plainAgentBaselineReceiptIds: ["receipt_plain"]
    };
    expect(PlayPromotionInputSchema.safeParse({ ...base, fromState: "draft", toState: "candidate" }).success).toBe(true);
    expect(PlayPromotionInputSchema.safeParse({ ...base, fromState: "candidate", toState: "held-out-verified" }).success).toBe(true);
    expect(PlayPromotionInputSchema.safeParse(base).success).toBe(true);

    expect(PlayPromotionInputSchema.safeParse({ ...base, fromState: "draft", toState: "held-out-verified" }).success).toBe(false);
    expect(PlayPromotionInputSchema.safeParse({ ...base, fromState: "candidate", toState: "cross-venture-proven" }).success).toBe(false);
    expect(PlayPromotionInputSchema.safeParse({ ...base, fromState: "held-out-verified", toState: "candidate" }).success).toBe(false);
    expect(PlayPromotionInputSchema.safeParse({ ...base, fromState: "cross-venture-proven", toState: "held-out-verified" }).success).toBe(false);

    expect(
      PlayPromotionInputSchema.safeParse({
        ...base,
        fromState: "candidate",
        toState: "deprecated",
        decision: "deprecate"
      }).success
    ).toBe(true);
  });

  it("keeps state unchanged on refusal and requires both baselines for cross-venture promotion", () => {
    const promotion = promotionInput();
    expect(PlayPromotionInputSchema.safeParse(promotion).success).toBe(false);
    expect(
      PlayPromotionInputSchema.safeParse({
        ...promotion,
        noHistoryBaselineReceiptIds: ["receipt_no_history"],
        plainAgentBaselineReceiptIds: ["receipt_plain"]
      }).success
    ).toBe(true);

    const refusal = {
      ...promotion,
      fromState: "candidate",
      toState: "held-out-verified",
      decision: "refuse",
      transferVentureIds: []
    };
    expect(PlayPromotionInputSchema.safeParse(refusal).success).toBe(false);
    expect(PlayPromotionInputSchema.safeParse({ ...refusal, toState: "candidate" }).success).toBe(true);
  });
});
