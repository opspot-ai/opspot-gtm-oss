import { createHash } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const VentureIdSchema = z.string().regex(/^venture_[a-z0-9][a-z0-9_-]*$/);
export const WorkspaceIdSchema = z.string().max(160).regex(/^workspace_[a-z0-9][a-z0-9_-]*$/);
export const EntityIdSchema = z.string().min(3).max(160);
export const IsoTimestampSchema = z.string().datetime({ offset: true });

/** A trusted boundary value; callers never supply this through command input. */
export const ExecutionContextSchema = z
  .object({ workspaceId: WorkspaceIdSchema, surface: z.enum(["api", "cli", "mcp", "worker", "local"]) })
  .strict()
  .readonly();
export type ExecutionContext = Readonly<z.infer<typeof ExecutionContextSchema>>;
export const LOCAL_WORKSPACE_ID = "workspace_local" as const;

/** Build only from a trusted boundary value, never from command input. */
export function executionContext(workspaceId: string, surface: ExecutionContext["surface"]): ExecutionContext {
  return Object.freeze(ExecutionContextSchema.parse({ workspaceId, surface }));
}

export function localExecutionContext(surface: ExecutionContext["surface"] = "local"): ExecutionContext {
  return executionContext(LOCAL_WORKSPACE_ID, surface);
}

/** Cloud auth supplies the authenticated session's workspace ID to this seam. */
export function cloudExecutionContext(workspaceId: string): ExecutionContext {
  return executionContext(workspaceId, "api");
}

export const LifecycleStateSchema = z.enum([
  "candidate",
  "validating",
  "offer-ready",
  "launch-ready",
  "externally-live",
  "revenue-verified",
  "fulfillment-verified",
  "scaling",
  "parked",
  "killed"
]);

export const ProofTierSchema = z.enum([
  "scaffolded",
  "fixture-verified",
  "internally-live",
  "externally-live",
  "revenue-verified",
  "fulfillment-verified",
  "blocked"
]);

export const FieldStatusSchema = z.enum(["known", "hypothesis", "missing", "not-applicable"]);
export const EvidenceStatusSchema = z.enum(["current", "stale", "conflicting", "superseded", "unavailable"]);

export const GateClassSchema = z.enum([
  "safe-internal-read-only",
  "public-research-free",
  "paid-research",
  "external-send-within-license",
  "external-send-above-license",
  "public-posting",
  "credential-mutation",
  "money-movement",
  "client-system-mutation",
  "recurring-schedule",
  "physical-site-work",
  "unfamiliar-claim"
]);

export const GtmCapabilityIdSchema = z.enum([
  "company-evidence-bootstrap",
  "market-problem-research",
  "icp-offer-positioning-pricing",
  "paid-demand-validation",
  "minimum-sellable-asset",
  "permissioned-acquisition",
  "reply-qualification-next-action",
  "checkout-payment-observation",
  "fulfillment-verification",
  "retention-renewal-observation",
  "pivot-kill-scale-decision",
  "frozen-evaluation-skill-promotion"
]);

export type GtmCapabilityId = z.infer<typeof GtmCapabilityIdSchema>;

export const TaskModeSchema = z.enum(["internal-read-only", "external", "fixture"]);
export const TaskStatusSchema = z.enum([
  "planned",
  "blocked",
  "ready",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "dead-letter"
]);

export const JobStatusSchema = z.enum(["queued", "leased", "succeeded", "failed", "cancelled", "dead-letter"]);
export const ApprovalStatusSchema = z.enum(["pending", "approved", "revoked", "expired", "consumed"]);

export const SourceReferenceSchema = z
  .object({
    id: EntityIdSchema,
    kind: z.enum(["file", "git", "url", "provider", "engine-receipt"]),
    authority: z.enum(["product", "customer", "company", "finance", "payment", "fulfillment", "public", "engine"]),
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    repositoryRoot: z.string().min(1).optional(),
    revision: z.string().min(4).optional(),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    observedAt: IsoTimestampSchema,
    freshForHours: z.number().nonnegative().max(24 * 365 * 10),
    confidence: z.number().min(0).max(1),
    rights: z.enum(["owned", "licensed", "public", "reference-only"]),
    description: z.string().min(1).max(1000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.path && !value.url) {
      ctx.addIssue({ code: "custom", message: "source requires path or url" });
    }
    if (value.kind === "url" && !value.url) {
      ctx.addIssue({ code: "custom", message: "url source requires url" });
    }
    if (["file", "git", "engine-receipt"].includes(value.kind) && !value.path) {
      ctx.addIssue({ code: "custom", message: `${value.kind} source requires path` });
    }
  });

export const FieldAssertionSchema = z
  .object({
    status: FieldStatusSchema,
    value: z.unknown().optional(),
    sourceRefs: z.array(EntityIdSchema).default([]),
    evidenceRefs: z.array(EntityIdSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    observedAt: IsoTimestampSchema.optional(),
    freshForHours: z.number().nonnegative().optional(),
    supersedes: z.array(EntityIdSchema).default([]),
    notes: z.string().max(2000).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "known" && value.value === undefined) {
      ctx.addIssue({ code: "custom", message: "known assertion requires value" });
    }
    if (value.status === "missing" && value.value !== undefined) {
      ctx.addIssue({ code: "custom", message: "missing assertion cannot carry value" });
    }
    if (value.status === "hypothesis" && value.confidence === undefined) {
      ctx.addIssue({ code: "custom", message: "hypothesis requires confidence" });
    }
  });

export const AssertionGroupSchema = z.record(z.string().min(1), FieldAssertionSchema);

export const MetricDefinitionSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().min(1),
    unit: z.string().min(1),
    target: z.number().optional(),
    guardrail: z.number().optional(),
    authoritativeSourceRef: EntityIdSchema.optional(),
    status: FieldStatusSchema
  })
  .strict();

export const PlayDefinitionSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().min(1),
    purpose: z.string().min(1),
    ownerRole: z.string().min(1),
    mode: TaskModeSchema,
    gateClass: GateClassSchema,
    reusable: z.boolean(),
    expectedProof: z.string().min(1),
    question: z.string().min(1),
    sourceRefs: z.array(EntityIdSchema).min(1),
    successThreshold: z.string().min(1),
    failureThreshold: z.string().min(1)
  })
  .strict();

export const VenturePackSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    venture: z
      .object({
        id: VentureIdSchema,
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        name: z.string().min(1),
        owner: z.string().min(1),
        owningRepo: z.string().min(1),
        declaredState: LifecycleStateSchema
      })
      .strict(),
    founder: z
      .object({
        thesis: FieldAssertionSchema,
        budget: FieldAssertionSchema,
        timeHorizon: FieldAssertionSchema,
        stopConditions: z.array(FieldAssertionSchema).min(1),
        boundaries: z.array(z.string().min(1)).min(1),
        approvals: z.array(z.string().min(1)).default([])
      })
      .strict(),
    authorities: z
      .object({
        product: z.array(EntityIdSchema).min(1),
        customer: z.array(EntityIdSchema).default([]),
        company: z.array(EntityIdSchema).default([]),
        finance: z.array(EntityIdSchema).default([]),
        payment: z.array(EntityIdSchema).default([]),
        fulfillment: z.array(EntityIdSchema).default([])
      })
      .strict(),
    assertions: z
      .object({
        buyer: AssertionGroupSchema,
        offer: AssertionGroupSchema,
        acquisition: AssertionGroupSchema,
        product: AssertionGroupSchema,
        payment: AssertionGroupSchema,
        fulfillment: AssertionGroupSchema,
        policy: AssertionGroupSchema,
        economics: AssertionGroupSchema,
        proof: AssertionGroupSchema
      })
      .strict(),
    policy: z
      .object({
        senderIdentity: FieldAssertionSchema,
        suppressionSource: FieldAssertionSchema,
        caps: FieldAssertionSchema,
        quietHours: FieldAssertionSchema,
        killSwitchPath: z.string().min(1),
        enabledGateClasses: z.array(GateClassSchema),
        forbiddenActions: z.array(z.string().min(1)).min(1),
        dataRetention: z.string().min(1)
      })
      .strict(),
    metrics: z.array(MetricDefinitionSchema),
    plays: z.array(PlayDefinitionSchema).min(1),
    sources: z.array(SourceReferenceSchema).min(1)
  })
  .strict()
  .superRefine((pack, ctx) => {
    const ids = new Set(pack.sources.map((source) => source.id));
    const refs: string[] = [];
    for (const group of Object.values(pack.assertions)) {
      for (const assertion of Object.values(group)) refs.push(...assertion.sourceRefs);
    }
    refs.push(...pack.founder.thesis.sourceRefs, ...pack.founder.budget.sourceRefs, ...pack.founder.timeHorizon.sourceRefs);
    for (const item of pack.founder.stopConditions) refs.push(...item.sourceRefs);
    for (const play of pack.plays) refs.push(...play.sourceRefs);
    for (const ref of refs) {
      if (!ids.has(ref)) ctx.addIssue({ code: "custom", message: `unknown source reference ${ref}` });
    }
    if (new Set(pack.sources.map((source) => source.id)).size !== pack.sources.length) {
      ctx.addIssue({ code: "custom", message: "source ids must be unique" });
    }
  });

export type VenturePack = z.infer<typeof VenturePackSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type ProofTier = z.infer<typeof ProofTierSchema>;
export type GateClass = z.infer<typeof GateClassSchema>;
export type TaskMode = z.infer<typeof TaskModeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const EvidenceItemSchema = z
  .object({
    id: EntityIdSchema,
    ventureId: VentureIdSchema,
    type: z.string().min(1),
    proofTier: ProofTierSchema,
    authority: z.enum(["product", "customer", "company", "finance", "payment", "fulfillment", "public", "engine", "fixture"]),
    sourceRef: EntityIdSchema,
    observedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.optional(),
    status: EvidenceStatusSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const IdempotencyKeySchema = z.string().min(8).max(240);

export const TaskKindSchema = z.enum(["venture-play", "ceo-cycle", "evaluation-scoring", "evaluation-review"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const GoalTaskBindingSchema = z
  .object({
    scope: z.enum(["goal-specific", "goal-independent"]),
    goalRevisionId: EntityIdSchema.optional(),
    onMaterialChange: z.enum(["revise", "defer", "cancel"])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "goal-independent" && value.goalRevisionId) {
      ctx.addIssue({
        code: "custom",
        path: ["goalRevisionId"],
        message: "goal-independent tasks cannot bind to a goal revision"
      });
    }
  });

export type GoalTaskBinding = z.infer<typeof GoalTaskBindingSchema>;

export const EvaluationExecutionBindingSchema = z
  .object({
    evaluationContractId: EntityIdSchema,
    evaluationContractHash: Sha256Schema,
    packRevisionId: EntityIdSchema,
    goalRevisionId: EntityIdSchema,
    skillVersionId: EntityIdSchema,
    skillVersionHash: Sha256Schema,
    candidateVersion: z.string().min(1).max(240),
    candidateArtifactHash: Sha256Schema,
    primaryMetricId: EntityIdSchema,
    primaryMetricHash: Sha256Schema,
    formulaHash: Sha256Schema,
    populationHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    hardGatesHash: Sha256Schema,
    promotionRuleHash: Sha256Schema,
    producerId: z.string().min(1).max(240),
    evaluatorId: z.string().min(1).max(240),
    reviewerId: z.string().min(1).max(240),
    frozenAt: IsoTimestampSchema
  })
  .strict();

export type EvaluationExecutionBinding = z.infer<typeof EvaluationExecutionBindingSchema>;

export const TaskDefinitionSchema = z
  .object({
    id: EntityIdSchema,
    ventureId: VentureIdSchema,
    taskKind: TaskKindSchema.default("venture-play"),
    playId: EntityIdSchema.optional(),
    purpose: z.string().min(1),
    expectedOutcome: z.string().min(1),
    ownerRole: z.string().min(1),
    dependencies: z.array(EntityIdSchema).default([]),
    sourceRefs: z.array(EntityIdSchema).default([]),
    mode: TaskModeSchema,
    expectedProof: z.string().min(1),
    gateClass: GateClassSchema,
    actionBounds: z.record(z.string(), z.unknown()).default({}),
    budgetCents: z.number().int().nonnegative().default(0),
    costCeilingCents: z.number().int().nonnegative().default(0),
    approvalRequired: z.boolean(),
    approvalId: EntityIdSchema.optional(),
    idempotencyKey: z.string().min(8).max(240),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    backoffMs: z.number().int().min(0).max(86_400_000).default(1000),
    timeoutMs: z.number().int().min(1000).max(7_200_000).default(1_800_000),
    lifecycleEffect: z.record(z.string(), z.unknown()).default({}),
    metricEffects: z.array(z.record(z.string(), z.unknown())).default([]),
    goalTaskBinding: GoalTaskBindingSchema.optional(),
    evaluationBinding: EvaluationExecutionBindingSchema.optional(),
    evaluationBindingHash: Sha256Schema.optional()
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.taskKind === "venture-play") {
      if (task.evaluationBinding || task.evaluationBindingHash) {
        ctx.addIssue({ code: "custom", path: ["evaluationBinding"], message: "venture-play tasks cannot carry evaluator bindings" });
      }
      if (task.sourceRefs.length === 0) {
        ctx.addIssue({ code: "custom", path: ["sourceRefs"], message: "venture-play tasks require at least one venture-pack source" });
      }
      return;
    }
    if (task.taskKind === "ceo-cycle") {
      if (task.evaluationBinding || task.evaluationBindingHash) {
        ctx.addIssue({ code: "custom", path: ["evaluationBinding"], message: "CEO cycle tasks cannot carry evaluator bindings" });
      }
      const zeroCostOrchestrator = task.costCeilingCents === 0 && task.budgetCents === 0;
      const paidProviderCycle = task.costCeilingCents > 0 && task.budgetCents >= task.costCeilingCents;
      if (
        task.ownerRole !== "ceo" ||
        (zeroCostOrchestrator && (task.mode !== "internal-read-only" || task.gateClass !== "safe-internal-read-only")) ||
        (paidProviderCycle && (task.mode !== "external" || task.gateClass !== "paid-research")) ||
        (!zeroCostOrchestrator && !paidProviderCycle)
      ) {
        ctx.addIssue({ code: "custom", message: "CEO cycle tasks must be either zero-cost internal orchestration or atomically bounded paid provider work" });
      }
      if (task.actionBounds.phase !== "plan" && task.actionBounds.phase !== "verify") {
        ctx.addIssue({ code: "custom", path: ["actionBounds", "phase"], message: "CEO cycle task phase must be plan or verify" });
      }
      return;
    }
    if (!task.evaluationBinding || !task.evaluationBindingHash) {
      ctx.addIssue({ code: "custom", path: ["evaluationBinding"], message: "evaluation tasks require an engine-owned binding and hash" });
      return;
    }
    if (sha256(task.evaluationBinding) !== task.evaluationBindingHash) {
      ctx.addIssue({ code: "custom", path: ["evaluationBindingHash"], message: "evaluation binding hash does not match the binding" });
    }
    const inputManifest = task.actionBounds.evaluationInputManifest;
    if (!inputManifest || typeof inputManifest !== "object" || Array.isArray(inputManifest)) {
      ctx.addIssue({ code: "custom", path: ["actionBounds", "evaluationInputManifest"], message: "evaluation tasks require a frozen input manifest" });
    } else if (sha256(inputManifest) !== task.evaluationBinding.inputManifestHash) {
      ctx.addIssue({ code: "custom", path: ["actionBounds", "evaluationInputManifest"], message: "evaluation input manifest hash does not match the binding" });
    }
    if (
      task.evaluationBinding.producerId === task.evaluationBinding.evaluatorId ||
      task.evaluationBinding.producerId === task.evaluationBinding.reviewerId ||
      task.evaluationBinding.evaluatorId === task.evaluationBinding.reviewerId
    ) {
      ctx.addIssue({ code: "custom", path: ["evaluationBinding"], message: "producer, evaluator, and reviewer must be distinct" });
    }
    if (
      task.mode !== "internal-read-only" ||
      task.gateClass !== "safe-internal-read-only" ||
      task.budgetCents !== 0 ||
      task.costCeilingCents !== 0 ||
      task.approvalRequired ||
      Object.keys(task.lifecycleEffect).length > 0 ||
      task.metricEffects.length > 0 ||
      task.maxAttempts !== 1
    ) {
      ctx.addIssue({ code: "custom", message: "evaluation tasks must remain one-attempt, zero-cost, read-only work with no direct state effects" });
    }
    if (task.taskKind === "evaluation-scoring") {
      if (task.ownerRole !== task.evaluationBinding.evaluatorId) {
        ctx.addIssue({ code: "custom", path: ["ownerRole"], message: "scoring task owner must be the frozen evaluator" });
      }
      if (task.dependencies.length > 0) {
        ctx.addIssue({ code: "custom", path: ["dependencies"], message: "scoring task cannot depend on reviewer work" });
      }
    }
    if (task.taskKind === "evaluation-review") {
      if (task.ownerRole !== task.evaluationBinding.reviewerId) {
        ctx.addIssue({ code: "custom", path: ["ownerRole"], message: "review task owner must be the frozen reviewer" });
      }
      if (task.dependencies.length !== 1) {
        ctx.addIssue({ code: "custom", path: ["dependencies"], message: "review task must depend on exactly one scoring task" });
      }
    }
  });

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

export const ReceiptOriginSchema = z.enum(["dispatch", "engine-derived", "attached-artifact", "fixture", "legacy"]);
export type ReceiptOrigin = z.infer<typeof ReceiptOriginSchema>;

const ReceiptAttachInputShape = {
  id: EntityIdSchema,
  ventureId: VentureIdSchema,
  taskId: EntityIdSchema.optional(),
  dispatchId: EntityIdSchema.optional(),
  proofTier: ProofTierSchema,
  outcome: z.enum(["success", "partial", "failure", "aborted-precondition", "aborted-killswitch"]),
  actor: z.string().min(1),
  adapter: z.string().min(1),
  artifactPath: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: IsoTimestampSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
};

export const ReceiptAttachInputSchema = z.object(ReceiptAttachInputShape).strict();
export type ReceiptAttachInput = z.infer<typeof ReceiptAttachInputSchema>;

export const ReceiptSchema = z
  .object({
    ...ReceiptAttachInputShape,
    origin: ReceiptOriginSchema.default("legacy")
  })
  .strict();

export type Receipt = z.infer<typeof ReceiptSchema>;

export const TransitionRequestSchema = z
  .object({
    ventureId: VentureIdSchema,
    expectedState: LifecycleStateSchema,
    targetState: LifecycleStateSchema,
    evidenceIds: z.array(EntityIdSchema),
    requestingTaskId: EntityIdSchema.optional(),
    requestingAgent: z.string().min(1),
    approvalId: EntityIdSchema.optional(),
    actor: z.string().min(1),
    idempotencyKey: z.string().min(8).max(240),
    requestedAt: IsoTimestampSchema
  })
  .strict();

export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

export const PolicyDecisionSchema = z
  .object({
    decision: z.enum(["allow", "deny", "approval-required"]),
    gateClass: GateClassSchema,
    reason: z.string().min(1),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvalPacket: z
      .object({
        recommendedAction: z.string(),
        target: z.string(),
        capOrCost: z.string(),
        senderOrSystem: z.string(),
        expiresAt: IsoTimestampSchema,
        rollbackOrKillRoute: z.string(),
        exactCommandOrProviderCall: z.string()
      })
      .strict()
      .optional()
  })
  .strict();

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const AutonomyModeSchema = z.enum([
  "inspect",
  "propose",
  "prepare",
  "execute-safe",
  "execute-gated",
  "observe",
  "promote"
]);

export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const GoalDestinationSchema = z.enum([
  "cash-flow",
  "growth",
  "durable-operation",
  "acquisition-readiness",
  "exit-readiness",
  "custom"
]);

export type GoalDestination = z.infer<typeof GoalDestinationSchema>;

const GoalChangeInputShape = {
  ventureId: VentureIdSchema,
  destination: GoalDestinationSchema,
  customDestination: z.string().min(1).max(240).optional(),
  target: z.string().min(1).max(1000),
  horizon: z.string().min(1).max(240),
  constraints: z.array(z.string().min(1).max(1000)).default([]),
  successConditions: z.array(z.string().min(1).max(1000)).min(1),
  killConditions: z.array(z.string().min(1).max(1000)).min(1),
  reason: z.string().min(1).max(2000),
  expectedGoalRevisionId: EntityIdSchema.optional(),
  requestedBy: z.string().min(1).max(240),
  requestedAt: IsoTimestampSchema,
  idempotencyKey: IdempotencyKeySchema
};

function validateCustomGoalDestination(
  value: { destination: GoalDestination; customDestination?: string | undefined },
  ctx: z.RefinementCtx
): void {
  if (value.destination === "custom" && !value.customDestination) {
    ctx.addIssue({ code: "custom", path: ["customDestination"], message: "custom destination requires a label" });
  }
  if (value.destination !== "custom" && value.customDestination) {
    ctx.addIssue({ code: "custom", path: ["customDestination"], message: "custom destination label is only valid for custom goals" });
  }
}

export const GoalChangeInputSchema = z.object(GoalChangeInputShape).strict().superRefine(validateCustomGoalDestination);
export type GoalChangeInput = z.infer<typeof GoalChangeInputSchema>;

export const GoalFounderConfirmationSchema = z
  .object({
    previewId: EntityIdSchema,
    previewHash: Sha256Schema,
    confirmedBy: z.string().min(1).max(240),
    authority: z.string().min(1).max(500),
    confirmedAt: IsoTimestampSchema,
    receiptId: EntityIdSchema.optional()
  })
  .strict();

export type GoalFounderConfirmation = z.infer<typeof GoalFounderConfirmationSchema>;

export const GoalConfirmChangeInputSchema = z
  .object({
    ...GoalChangeInputShape,
    founderConfirmation: GoalFounderConfirmationSchema
  })
  .strict()
  .superRefine(validateCustomGoalDestination);

export type GoalConfirmChangeInput = z.infer<typeof GoalConfirmChangeInputSchema>;

export const GoalTaskDispositionSchema = z.enum(["keep", "revise", "defer", "cancel"]);
export type GoalTaskDisposition = z.infer<typeof GoalTaskDispositionSchema>;

export const GoalTaskReconciliationRuleSchema = z.enum([
  "goal-semantics-unchanged",
  "goal-independent",
  "explicit-cancel-on-change",
  "explicit-defer-on-change",
  "revise-before-dispatch",
  "defer-active-work"
]);
export type GoalTaskReconciliationRule = z.infer<typeof GoalTaskReconciliationRuleSchema>;

export const GoalTaskReconciliationSchema = z
  .object({
    taskId: EntityIdSchema,
    purpose: z.string().min(1),
    taskStatus: TaskStatusSchema,
    taskActionDigest: Sha256Schema,
    goalTaskBinding: GoalTaskBindingSchema.optional(),
    disposition: GoalTaskDispositionSchema,
    ruleCode: GoalTaskReconciliationRuleSchema,
    reason: z.string().min(1).max(1000),
    executionBlocked: z.boolean()
  })
  .strict();

export type GoalTaskReconciliation = z.infer<typeof GoalTaskReconciliationSchema>;

export const GoalGapSnapshotItemSchema = z
  .object({
    group: z.enum(["buyer", "offer", "acquisition", "product", "payment", "fulfillment", "policy", "economics", "proof"]),
    field: z.string().min(1),
    reason: z.enum(["missing", "hypothesis", "stale", "conflicting", "unavailable"]),
    sourceRefs: z.array(EntityIdSchema),
    blockingStates: z.array(LifecycleStateSchema)
  })
  .strict();

export type GoalGapSnapshotItem = z.infer<typeof GoalGapSnapshotItemSchema>;

export const GoalGapSnapshotSchema = z
  .object({
    items: z.array(GoalGapSnapshotItemSchema),
    gapCount: z.number().int().nonnegative(),
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.gapCount !== value.items.length) {
      ctx.addIssue({ code: "custom", path: ["gapCount"], message: "gap count must equal the exact snapshot item count" });
    }
    if (value.canonicalHash !== sha256(value.items)) {
      ctx.addIssue({ code: "custom", path: ["canonicalHash"], message: "gap snapshot hash does not match its items" });
    }
  });

export type GoalGapSnapshot = z.infer<typeof GoalGapSnapshotSchema>;

export const GoalRoadmapMarkerSchema = z
  .object({
    state: z.enum(["unchanged", "recalculation-required"]),
    reasonCode: z.enum(["goal-semantics-unchanged", "goal-semantics-changed"]),
    packRevisionId: EntityIdSchema,
    gapSnapshotHash: Sha256Schema,
    taskReconciliationHash: Sha256Schema
  })
  .strict();

export type GoalRoadmapMarker = z.infer<typeof GoalRoadmapMarkerSchema>;

export const GoalChangeImpactSchema = z
  .object({
    evidenceCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    activeTaskCount: z.number().int().nonnegative(),
    receiptCount: z.number().int().nonnegative(),
    lifecycleState: LifecycleStateSchema,
    materialGoalChange: z.boolean(),
    destinationChanged: z.boolean(),
    roadmapRecalculationRequired: z.boolean(),
    evidencePreserved: z.literal(true),
    tasksPreserved: z.literal(true),
    receiptsPreserved: z.literal(true),
    activeWorkAutomaticallyCancelled: z.literal(false),
    taskReconciliation: z.array(GoalTaskReconciliationSchema),
    taskReconciliationHash: Sha256Schema,
    gapSnapshot: GoalGapSnapshotSchema,
    roadmap: GoalRoadmapMarkerSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const taskIds = new Set<string>();
    for (const [index, item] of value.taskReconciliation.entries()) {
      if (taskIds.has(item.taskId)) {
        ctx.addIssue({
          code: "custom",
          path: ["taskReconciliation", index, "taskId"],
          message: "each nonterminal task may appear exactly once"
        });
      }
      taskIds.add(item.taskId);
      if (item.executionBlocked !== (item.disposition !== "keep")) {
        ctx.addIssue({
          code: "custom",
          path: ["taskReconciliation", index, "executionBlocked"],
          message: "only keep dispositions may remain executable"
        });
      }
      if (item.disposition === "cancel" && item.goalTaskBinding?.onMaterialChange !== "cancel") {
        ctx.addIssue({
          code: "custom",
          path: ["taskReconciliation", index, "disposition"],
          message: "cancel requires an explicit structured cancel binding"
        });
      }
      if (value.materialGoalChange && item.taskStatus === "running" && item.disposition !== "defer") {
        ctx.addIssue({
          code: "custom",
          path: ["taskReconciliation", index, "disposition"],
          message: "a running lease must defer and may finish without retry"
        });
      }
    }
    if (value.activeTaskCount !== value.taskReconciliation.length) {
      ctx.addIssue({
        code: "custom",
        path: ["activeTaskCount"],
        message: "active task count must equal the exact reconciliation item count"
      });
    }
    if (value.taskReconciliationHash !== sha256(value.taskReconciliation)) {
      ctx.addIssue({
        code: "custom",
        path: ["taskReconciliationHash"],
        message: "task reconciliation hash does not match its items"
      });
    }
    if (value.roadmapRecalculationRequired !== value.materialGoalChange) {
      ctx.addIssue({
        code: "custom",
        path: ["roadmapRecalculationRequired"],
        message: "roadmap recalculation must track material goal change"
      });
    }
    const expectedRoadmapState = value.materialGoalChange ? "recalculation-required" : "unchanged";
    const expectedReasonCode = value.materialGoalChange ? "goal-semantics-changed" : "goal-semantics-unchanged";
    if (
      value.roadmap.state !== expectedRoadmapState ||
      value.roadmap.reasonCode !== expectedReasonCode ||
      value.roadmap.gapSnapshotHash !== value.gapSnapshot.canonicalHash ||
      value.roadmap.taskReconciliationHash !== value.taskReconciliationHash
    ) {
      ctx.addIssue({ code: "custom", path: ["roadmap"], message: "roadmap marker does not match the frozen goal-change impact" });
    }
  });

export type GoalChangeImpact = z.infer<typeof GoalChangeImpactSchema>;

export const GoalRevisionSchema = z
  .object({
    id: EntityIdSchema,
    revision: z.number().int().positive(),
    ...GoalChangeInputShape,
    founderConfirmation: GoalFounderConfirmationSchema,
    changeImpact: GoalChangeImpactSchema.optional(),
    supersedesGoalRevisionId: EntityIdSchema.optional(),
    createdAt: IsoTimestampSchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine((value, ctx) => {
    validateCustomGoalDestination(value, ctx);
    if (value.revision > 1 && !value.supersedesGoalRevisionId) {
      ctx.addIssue({
        code: "custom",
        path: ["supersedesGoalRevisionId"],
        message: "goal revisions after the first must identify the revision they supersede"
      });
    }
    if (value.revision === 1 && value.supersedesGoalRevisionId) {
      ctx.addIssue({
        code: "custom",
        path: ["supersedesGoalRevisionId"],
        message: "the first goal revision cannot supersede another revision"
      });
    }
  })
  .readonly();

export type GoalRevision = z.infer<typeof GoalRevisionSchema>;

export const InitiativeCandidateSchema = z
  .object({
    id: EntityIdSchema,
    ventureId: VentureIdSchema,
    goalRevisionId: EntityIdSchema,
    capabilityId: GtmCapabilityIdSchema,
    title: z.string().min(1).max(240),
    hypothesis: z.string().min(1).max(2000),
    dependencyIds: z.array(EntityIdSchema).default([]),
    requirementIds: z.array(EntityIdSchema).default([]),
    expectedOutcome: z.string().min(1).max(2000),
    expectedProof: z.string().min(1).max(2000),
    successThreshold: z.string().min(1).max(1000),
    failureThreshold: z.string().min(1).max(1000),
    stopCondition: z.string().min(1).max(1000),
    estimatedHours: z.number().nonnegative(),
    estimatedCostCents: z.number().int().nonnegative(),
    autonomyMode: AutonomyModeSchema,
    gateClasses: z.array(GateClassSchema).default([]),
    uncertainty: z.number().min(0).max(1),
    uncertaintyReason: z.string().min(1).max(1000),
    assumptions: z.array(z.string().min(1).max(1000)).default([]),
    evidenceIds: z.array(EntityIdSchema).default([])
  })
  .strict();

export type InitiativeCandidate = z.infer<typeof InitiativeCandidateSchema>;

export const InitiativeCandidateAssessmentSchema = z
  .object({
    candidateId: EntityIdSchema,
    eligible: z.boolean(),
    score: z.number().optional(),
    scoreComponents: z.record(z.string().min(1), z.number()).default({}),
    evidenceIds: z.array(EntityIdSchema).default([]),
    exclusionReasons: z.array(z.string().min(1).max(1000)).default([]),
    rationale: z.string().min(1).max(2000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligible && value.score === undefined) {
      ctx.addIssue({ code: "custom", path: ["score"], message: "eligible candidates require a score" });
    }
    if (!value.eligible && value.exclusionReasons.length === 0) {
      ctx.addIssue({ code: "custom", path: ["exclusionReasons"], message: "ineligible candidates require an exclusion reason" });
    }
  });

export type InitiativeCandidateAssessment = z.infer<typeof InitiativeCandidateAssessmentSchema>;

export const InitiativeSelectionModeSchema = z.enum(["deterministic-eligibility", "ceo-provider", "evaluated"]);
export type InitiativeSelectionMode = z.infer<typeof InitiativeSelectionModeSchema>;

export const InitiativeDecisionBaselineSchema = z
  .object({
    kind: z.enum(["none", "prior-version", "plain-agent", "human", "provider"]),
    description: z.string().min(1).max(1000),
    receiptIds: z.array(EntityIdSchema).default([]),
    score: z.number().optional(),
    costCents: z.number().int().nonnegative().optional(),
    founderMinutes: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind !== "none" && value.receiptIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["receiptIds"], message: "decision baselines require at least one receipt" });
    }
    if (value.kind === "none" && value.receiptIds.length > 0) {
      ctx.addIssue({ code: "custom", path: ["receiptIds"], message: "a none baseline cannot carry receipts" });
    }
  });

export type InitiativeDecisionBaseline = z.infer<typeof InitiativeDecisionBaselineSchema>;

export const InitiativeDecisionInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    packRevisionId: EntityIdSchema,
    goalRevisionId: EntityIdSchema.optional(),
    candidates: z.array(InitiativeCandidateSchema).max(100).default([]),
    selectionMode: InitiativeSelectionModeSchema,
    baseline: InitiativeDecisionBaselineSchema,
    evaluationContractId: EntityIdSchema.optional(),
    plannerId: z.string().min(1).max(240),
    evaluatorId: z.string().min(1).max(240),
    decisionPolicy: z.string().min(1).max(1000),
    evidenceIds: z.array(EntityIdSchema).default([]),
    requestedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    if (!value.goalRevisionId && value.candidates.length > 0) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "candidates require a current goal revision" });
    }
    if (value.selectionMode === "evaluated" && !value.evaluationContractId) {
      ctx.addIssue({ code: "custom", path: ["evaluationContractId"], message: "evaluated selection requires a frozen evaluation contract" });
    }
    if (value.selectionMode === "evaluated" && value.baseline.kind === "none") {
      ctx.addIssue({ code: "custom", path: ["baseline"], message: "evaluated selection requires a strong baseline" });
    }
    if (value.selectionMode === "evaluated" && value.plannerId === value.evaluatorId) {
      ctx.addIssue({ code: "custom", path: ["evaluatorId"], message: "evaluated selection requires planner and evaluator separation" });
    }
    for (const [index, candidate] of value.candidates.entries()) {
      if (candidate.ventureId !== value.ventureId) {
        ctx.addIssue({ code: "custom", path: ["candidates", index, "ventureId"], message: "candidate belongs to another venture" });
      }
      if (!value.goalRevisionId || candidate.goalRevisionId !== value.goalRevisionId) {
        ctx.addIssue({ code: "custom", path: ["candidates", index, "goalRevisionId"], message: "candidate belongs to another goal revision" });
      }
      if (ids.has(candidate.id)) {
        ctx.addIssue({ code: "custom", path: ["candidates", index, "id"], message: "candidate ids must be unique" });
      }
      ids.add(candidate.id);
    }
  });

export type InitiativeDecisionInput = z.infer<typeof InitiativeDecisionInputSchema>;

export const DecisionTraceSchema = z
  .object({
    id: EntityIdSchema,
    ventureId: VentureIdSchema,
    packRevisionId: EntityIdSchema,
    goalRevisionId: EntityIdSchema.optional(),
    candidates: z.array(InitiativeCandidateSchema).max(100),
    assessments: z.array(InitiativeCandidateAssessmentSchema).max(100),
    selectionMode: InitiativeSelectionModeSchema,
    baseline: InitiativeDecisionBaselineSchema,
    evaluationContractId: EntityIdSchema.optional(),
    selectedCandidateId: EntityIdSchema.optional(),
    abstain: z.boolean(),
    abstainReason: z.string().min(1).max(2000).optional(),
    uncertainty: z.number().min(0).max(1),
    uncertaintyReason: z.string().min(1).max(1000),
    plannerId: z.string().min(1).max(240),
    evaluatorId: z.string().min(1).max(240),
    evidenceIds: z.array(EntityIdSchema).default([]),
    createdAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine((value, ctx) => {
    const candidateIds = new Set(value.candidates.map((candidate) => candidate.id));
    const assessmentIds = new Set<string>();
    if (!value.goalRevisionId && !value.abstain) {
      ctx.addIssue({ code: "custom", path: ["goalRevisionId"], message: "a decision without a goal must abstain" });
    }
    if (value.selectionMode === "evaluated" && !value.evaluationContractId) {
      ctx.addIssue({ code: "custom", path: ["evaluationContractId"], message: "evaluated decisions require a frozen evaluation contract" });
    }
    if (value.selectionMode === "evaluated" && value.baseline.kind === "none") {
      ctx.addIssue({ code: "custom", path: ["baseline"], message: "evaluated decisions require a strong baseline" });
    }
    if (value.selectionMode === "evaluated" && value.plannerId === value.evaluatorId) {
      ctx.addIssue({ code: "custom", path: ["evaluatorId"], message: "evaluated decisions require planner and evaluator separation" });
    }
    if (!value.goalRevisionId && value.candidates.length > 0) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "a no-goal abstention cannot invent candidates" });
    }
    if (value.candidates.length === 0 && !value.abstain) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "an empty candidate set requires abstention" });
    }
    for (const [index, candidate] of value.candidates.entries()) {
      if (candidate.ventureId !== value.ventureId) {
        ctx.addIssue({ code: "custom", path: ["candidates", index, "ventureId"], message: "candidate belongs to another venture" });
      }
      if (!value.goalRevisionId || candidate.goalRevisionId !== value.goalRevisionId) {
        ctx.addIssue({ code: "custom", path: ["candidates", index, "goalRevisionId"], message: "candidate belongs to another goal revision" });
      }
    }
    for (const [index, assessment] of value.assessments.entries()) {
      if (!candidateIds.has(assessment.candidateId)) {
        ctx.addIssue({ code: "custom", path: ["assessments", index, "candidateId"], message: "assessment references an unknown candidate" });
      }
      if (assessmentIds.has(assessment.candidateId)) {
        ctx.addIssue({ code: "custom", path: ["assessments", index, "candidateId"], message: "candidate assessments must be unique" });
      }
      assessmentIds.add(assessment.candidateId);
    }
    if (assessmentIds.size !== candidateIds.size) {
      ctx.addIssue({ code: "custom", path: ["assessments"], message: "every candidate requires exactly one assessment" });
    }
    if (value.abstain === Boolean(value.selectedCandidateId)) {
      ctx.addIssue({ code: "custom", message: "decision must either select one candidate or abstain" });
    }
    if (value.abstain && !value.abstainReason) {
      ctx.addIssue({ code: "custom", path: ["abstainReason"], message: "abstention requires a reason" });
    }
    if (value.selectedCandidateId) {
      if (!candidateIds.has(value.selectedCandidateId)) {
        ctx.addIssue({ code: "custom", path: ["selectedCandidateId"], message: "selected candidate is not in the decision set" });
      }
      const assessment = value.assessments.find((item) => item.candidateId === value.selectedCandidateId);
      if (!assessment?.eligible) {
        ctx.addIssue({ code: "custom", path: ["selectedCandidateId"], message: "selected candidate must be eligible" });
      }
    }
  })
  .readonly();

export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

export const PublicOfferAuthoritySchema = z
  .object({
    offerName: z.string().trim().min(1).max(100),
    publicSummary: z.string().trim().min(1).max(2000),
    amountCents: z.number().int().positive().max(100_000_000),
    currency: z.literal("usd"),
    digitalPromise: z.string().trim().min(1).max(2000),
    claims: z.array(z.string().trim().min(1).max(1000)).max(24).default([])
  })
  .strict()
  .readonly();

export type PublicOfferAuthority = z.infer<typeof PublicOfferAuthoritySchema>;

export const OperatingEnvelopeSchema = z
  .object({
    senderIdentities: z.array(z.string().min(1).max(320)).default([]),
    allowedChannels: z.array(z.string().min(1).max(120)).default([]),
    recipientRules: z.array(z.string().min(1).max(1000)).default([]),
    suppressions: z.array(z.string().min(1).max(1000)).default([]),
    dailyActionCap: z.number().int().nonnegative().default(0),
    weeklyActionCap: z.number().int().nonnegative().default(0),
    quietHours: z.array(z.string().min(1).max(120)).default([]),
    approvedClaims: z.array(z.string().min(1).max(1000)).default([]),
    prohibitedClaims: z.array(z.string().min(1).max(1000)).default([]),
    modelBudgetCents: z.number().int().nonnegative(),
    toolBudgetCents: z.number().int().nonnegative().default(0),
    operatingBudgetCents: z.number().int().nonnegative().default(0),
    credentialScopes: z.array(z.string().min(1).max(240)).default([]),
    deploymentBoundaries: z.array(z.string().min(1).max(1000)).default([]),
    publicationAllowed: z.boolean().default(false),
    publicOfferAuthority: PublicOfferAuthoritySchema.optional(),
    expiresAt: IsoTimestampSchema.optional()
  })
  .strict();

export type OperatingEnvelope = z.infer<typeof OperatingEnvelopeSchema>;

export const CompanyAssertionsSchema = z
  .object({
    marketProblem: z.string().min(1).max(4000),
    icp: z.string().min(1).max(4000),
    offer: z.string().min(1).max(4000),
    price: z.string().min(1).max(1000),
    claims: z.array(z.string().min(1).max(1000)).default([]),
    channels: z.array(z.string().min(1).max(240)).default([]),
    payment: z.string().min(1).max(2000),
    fulfillment: z.string().min(1).max(2000),
    unknowns: z.array(z.string().min(1).max(2000)).default([])
  })
  .strict();

export type CompanyAssertions = z.infer<typeof CompanyAssertionsSchema>;

export const CompanyBootstrapInputSchema = z
  .object({
    idea: z.string().min(20).max(20_000),
    name: z.string().min(1).max(240).optional(),
    owner: z.string().min(1).max(240),
    destination: GoalDestinationSchema.default("cash-flow"),
    horizonDays: z.number().int().min(1).max(3650).default(90),
    budgetCents: z.number().int().min(0).max(100_000_000).default(1000),
    constraints: z.array(z.string().min(1).max(1000)).default([]),
    killConditions: z.array(z.string().min(1).max(1000)).default(["Stop when the bounded budget is exhausted without material demand evidence"]),
    permissions: z.string().min(1).max(5000).default("No external send, public post, deployment, credential mutation, or money movement without exact approval"),
    operatingEnvelope: OperatingEnvelopeSchema.optional(),
    requestedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export type CompanyBootstrapInput = z.infer<typeof CompanyBootstrapInputSchema>;

export const InitiativeDraftSchema = z
  .object({
    capabilityId: GtmCapabilityIdSchema,
    title: z.string().min(1).max(240),
    hypothesis: z.string().min(1).max(2000),
    dependencies: z.array(z.string().min(1).max(1000)).default([]),
    requirements: z.array(z.string().min(1).max(1000)).default([]),
    expectedOutcome: z.string().min(1).max(2000),
    expectedProof: z.string().min(1).max(2000),
    successThreshold: z.string().min(1).max(1000),
    failureThreshold: z.string().min(1).max(1000),
    stopCondition: z.string().min(1).max(1000),
    estimatedHours: z.number().nonnegative().max(10_000),
    estimatedCostCents: z.number().int().nonnegative().max(100_000_000),
    autonomyMode: AutonomyModeSchema,
    gateClasses: z.array(GateClassSchema).default([]),
    uncertainty: z.number().min(0).max(1),
    uncertaintyReason: z.string().min(1).max(1000),
    assumptions: z.array(z.string().min(1).max(1000)).default([])
  })
  .strict();

export type InitiativeDraft = z.infer<typeof InitiativeDraftSchema>;

export const CompanyBootstrapPlanSchema = z
  .object({
    name: z.string().min(1).max(240),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    summary: z.string().min(1).max(4000),
    assertions: CompanyAssertionsSchema,
    goal: z
      .object({
        target: z.string().min(1).max(1000),
        successConditions: z.array(z.string().min(1).max(1000)).min(1),
        killConditions: z.array(z.string().min(1).max(1000)).min(1)
      })
      .strict(),
    operatingEnvelope: OperatingEnvelopeSchema,
    alternatives: z.array(InitiativeDraftSchema).min(2).max(12),
    selectedAlternativeIndex: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.selectedAlternativeIndex >= value.alternatives.length) {
      ctx.addIssue({ code: "custom", path: ["selectedAlternativeIndex"], message: "selected bootstrap alternative is outside the candidate set" });
    }
  });

export type CompanyBootstrapPlan = z.infer<typeof CompanyBootstrapPlanSchema>;

export const CompanyBootstrapSnapshotSchema = z
  .object({
    ventureId: VentureIdSchema,
    narrative: z.string().min(20).max(20_000),
    name: z.string().min(1).max(240),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    owner: z.string().min(1).max(240),
    destination: GoalDestinationSchema,
    horizonDays: z.number().int().min(1).max(3650),
    budgetCents: z.number().int().nonnegative(),
    constraints: z.array(z.string().min(1).max(1000)),
    killConditions: z.array(z.string().min(1).max(1000)).min(1),
    assertions: CompanyAssertionsSchema,
    operatingEnvelope: OperatingEnvelopeSchema,
    initialGoal: z
      .object({
        target: z.string().min(1).max(1000),
        successConditions: z.array(z.string().min(1).max(1000)).min(1),
        killConditions: z.array(z.string().min(1).max(1000)).min(1)
      })
      .strict(),
    createdAt: IsoTimestampSchema
  })
  .strict();

export type CompanyBootstrapSnapshot = z.infer<typeof CompanyBootstrapSnapshotSchema>;

export const CompanyRunStateSchema = z.enum(["idle", "running", "paused", "waiting-approval", "killed"]);
export type CompanyRunState = z.infer<typeof CompanyRunStateSchema>;

export const CompanyStateSchema = z
  .object({
    ventureId: VentureIdSchema,
    workspaceId: WorkspaceIdSchema,
    version: z.number().int().positive(),
    bootstrap: z
      .object({
        digest: Sha256Schema,
        snapshot: CompanyBootstrapSnapshotSchema
      })
      .strict(),
    lifecycleState: LifecycleStateSchema,
    runState: CompanyRunStateSchema,
    initialGoalRevisionId: EntityIdSchema,
    currentGoalRevisionId: EntityIdSchema,
    initialInitiative: InitiativeCandidateSchema,
    currentInitiative: InitiativeCandidateSchema.optional(),
    lastMaterialEvidenceDigest: Sha256Schema,
    latestCycleSequence: z.number().int().nonnegative(),
    nextCycleAt: IsoTimestampSchema.optional(),
    latestCycleId: EntityIdSchema.optional(),
    latestDecisionTraceId: EntityIdSchema.optional(),
    pendingApprovalId: EntityIdSchema.optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.bootstrap.digest !== sha256(value.bootstrap.snapshot)) {
      ctx.addIssue({ code: "custom", path: ["bootstrap", "digest"], message: "bootstrap digest does not match the immutable snapshot" });
    }
    if (value.bootstrap.snapshot.ventureId !== value.ventureId) {
      ctx.addIssue({ code: "custom", path: ["bootstrap", "snapshot", "ventureId"], message: "bootstrap snapshot belongs to another company" });
    }
    if (value.initialInitiative.ventureId !== value.ventureId || value.currentInitiative?.ventureId !== value.ventureId) {
      ctx.addIssue({ code: "custom", path: ["currentInitiative"], message: "company initiatives must remain venture scoped" });
    }
    if (value.runState === "killed" && value.lifecycleState !== "killed") {
      ctx.addIssue({ code: "custom", path: ["lifecycleState"], message: "a killed company must have killed lifecycle state" });
    }
  });

export type CompanyState = z.infer<typeof CompanyStateSchema>;

export const CeoCycleDecisionSchema = z
  .object({
    alternatives: z.array(InitiativeDraftSchema).min(2).max(12),
    decision: z.enum(["select", "abstain", "kill"]),
    selectedAlternativeIndex: z.number().int().nonnegative().optional(),
    reason: z.string().min(1).max(4000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "select" && value.selectedAlternativeIndex === undefined) {
      ctx.addIssue({ code: "custom", path: ["selectedAlternativeIndex"], message: "selected CEO decision requires a candidate index" });
    }
    if (value.decision !== "select" && value.selectedAlternativeIndex !== undefined) {
      ctx.addIssue({ code: "custom", path: ["selectedAlternativeIndex"], message: "abstain and kill decisions cannot select a candidate" });
    }
    if (value.selectedAlternativeIndex !== undefined && value.selectedAlternativeIndex >= value.alternatives.length) {
      ctx.addIssue({ code: "custom", path: ["selectedAlternativeIndex"], message: "selected CEO alternative is outside the candidate set" });
    }
  });

export type CeoCycleDecision = z.infer<typeof CeoCycleDecisionSchema>;

export const ModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional()
  })
  .strict();

export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const CeoCycleSchema = z
  .object({
    id: EntityIdSchema,
    ventureId: VentureIdSchema,
    sequence: z.number().int().positive(),
    bootstrapDigest: Sha256Schema,
    observedStateDigest: Sha256Schema,
    materialEvidenceDigest: Sha256Schema,
    evidenceIds: z.array(EntityIdSchema),
    alternatives: z.array(InitiativeCandidateSchema).min(2).max(12),
    decisionTraceId: EntityIdSchema,
    outcome: z.enum(["selected", "abstained", "killed"]),
    selectedCandidateId: EntityIdSchema.optional(),
    plannedTaskIds: z.array(EntityIdSchema),
    receiptIds: z.array(EntityIdSchema).min(1),
    verification: z
      .object({
        status: z.enum(["verified", "inconclusive", "failed"]),
        summary: z.string().min(1).max(4000),
        evidenceDigest: Sha256Schema
      })
      .strict(),
    replan: z
      .object({
        priorInitiativeId: EntityIdSchema.optional(),
        nextInitiativeId: EntityIdSchema.optional(),
        materialChange: z.boolean()
      })
      .strict(),
    provider: z.string().min(1).max(240),
    model: z.string().min(1).max(240),
    usage: ModelUsageSchema,
    costCents: z.number().int().nonnegative(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.outcome === "selected") !== Boolean(value.selectedCandidateId)) {
      ctx.addIssue({ code: "custom", path: ["selectedCandidateId"], message: "only a selected cycle may carry a selected candidate" });
    }
    if (value.alternatives.some((candidate) => candidate.ventureId !== value.ventureId)) {
      ctx.addIssue({ code: "custom", path: ["alternatives"], message: "CEO alternatives must remain venture scoped" });
    }
    const { canonicalHash, ...semantic } = value;
    if (canonicalHash !== sha256(semantic)) {
      ctx.addIssue({ code: "custom", path: ["canonicalHash"], message: "CEO cycle hash does not match the immutable record" });
    }
  });

export type CeoCycle = z.infer<typeof CeoCycleSchema>;

export const CompanyEntitlementPlanSchema = z.enum(["local-byo", "trial", "paid"]);
export const CompanyEntitlementStatusSchema = z.enum(["local", "active", "paused", "expired", "past-due", "canceled", "refunded", "disputed"]);
export const CompanyEntitlementSchema = z
  .object({
    ventureId: VentureIdSchema,
    plan: CompanyEntitlementPlanSchema,
    status: CompanyEntitlementStatusSchema,
    periodStart: IsoTimestampSchema,
    periodEnd: IsoTimestampSchema,
    costCapCents: z.number().int().nonnegative().max(100_000_000),
    providerEventId: EntityIdSchema,
    updatedAt: IsoTimestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedCap = value.plan === "trial" ? 1000 : value.plan === "paid" ? 10_000 : undefined;
    if (expectedCap !== undefined && value.costCapCents !== expectedCap) {
      ctx.addIssue({ code: "custom", path: ["costCapCents"], message: `${value.plan} entitlement cap must be ${expectedCap} cents` });
    }
    if (value.plan === "local-byo" && value.status !== "local") {
      ctx.addIssue({ code: "custom", path: ["status"], message: "local-byo entitlement must use local status" });
    }
  });

export type CompanyEntitlement = z.infer<typeof CompanyEntitlementSchema>;

export const CompanyRunInputSchema = z.object({ ventureId: VentureIdSchema, requestedAt: IsoTimestampSchema, idempotencyKey: IdempotencyKeySchema }).strict();
export type CompanyRunInput = z.infer<typeof CompanyRunInputSchema>;
export const CompanyControlInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    reason: z.string().min(1).max(2000),
    actor: z.string().min(1).max(240),
    requestedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();
export type CompanyControlInput = z.infer<typeof CompanyControlInputSchema>;
export const CompanyDeleteInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    confirmVentureId: VentureIdSchema,
    actor: z.string().min(1).max(240),
    requestedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.confirmVentureId !== value.ventureId) {
      ctx.addIssue({ code: "custom", path: ["confirmVentureId"], message: "company deletion requires the exact venture id" });
    }
  });
export type CompanyDeleteInput = z.infer<typeof CompanyDeleteInputSchema>;
export const ApprovalResolveInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    approvalId: EntityIdSchema,
    expectedActionDigest: Sha256Schema,
    decision: z.enum(["approve", "deny"]),
    actor: z.string().min(1).max(240),
    resolvedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();
export type ApprovalResolveInput = z.infer<typeof ApprovalResolveInputSchema>;

export const EvaluationDispositionSchema = z.enum(["keep", "discard", "inconclusive", "crash", "gated", "unsafe"]);
export type EvaluationDisposition = z.infer<typeof EvaluationDispositionSchema>;

export const EvaluationBaselineSchema = z
  .object({
    description: z.string().min(1).max(2000),
    receiptIds: z.array(EntityIdSchema).min(1),
    artifactHash: Sha256Schema.optional(),
    primaryMetricValue: z.number().optional(),
    plainAgentReceiptIds: z.array(EntityIdSchema).default([]),
    noHistoryReceiptIds: z.array(EntityIdSchema).default([])
  })
  .strict();

export type EvaluationBaseline = z.infer<typeof EvaluationBaselineSchema>;

export const EvaluationPrimaryMetricSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().min(1).max(240),
    unit: z.string().min(1).max(120),
    direction: z.enum(["higher-is-better", "lower-is-better", "target"]),
    formula: z.string().min(1).max(2000),
    tieRule: z.string().min(1).max(1000),
    missingEvidenceRule: z.string().min(1).max(1000),
    abstentionScore: z.number(),
    targetValue: z.number().optional(),
    minimumImprovement: z.number(),
    minimumSampleSize: z.number().int().positive(),
    authoritativeSourceRef: EntityIdSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.direction === "target" && value.targetValue === undefined) {
      ctx.addIssue({ code: "custom", path: ["targetValue"], message: "target metrics require a target value" });
    }
  });

export type EvaluationPrimaryMetric = z.infer<typeof EvaluationPrimaryMetricSchema>;

export const EvaluationHardGateSchema = z
  .object({
    id: EntityIdSchema,
    description: z.string().min(1).max(1000),
    evidenceRequirement: z.string().min(1).max(1000),
    failureDisposition: z.enum(["discard", "gated", "unsafe"])
  })
  .strict();

export type EvaluationHardGate = z.infer<typeof EvaluationHardGateSchema>;

export const EvaluationPopulationSchema = z
  .object({
    kind: z.enum(["frozen-cases", "hidden-held-out", "authoritative-system"]),
    description: z.string().min(1).max(2000),
    caseRefs: z.array(EntityIdSchema).default([]),
    authoritativeSourceRef: EntityIdSchema.optional(),
    populationHash: Sha256Schema.optional(),
    minimumSampleSize: z.number().int().positive()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.caseRefs).size !== value.caseRefs.length) {
      ctx.addIssue({ code: "custom", path: ["caseRefs"], message: "evaluation population case references must be unique" });
    }
    if (value.kind === "authoritative-system" && (!value.authoritativeSourceRef || !value.populationHash)) {
      ctx.addIssue({
        code: "custom",
        path: value.authoritativeSourceRef ? ["populationHash"] : ["authoritativeSourceRef"],
        message: "authoritative-system populations require an authoritative source and frozen source-snapshot hash"
      });
    }
    if (value.kind !== "authoritative-system" && (value.caseRefs.length === 0 || !value.populationHash)) {
      ctx.addIssue({
        code: "custom",
        message: "frozen and held-out populations require case references and a population hash"
      });
    }
  });

export type EvaluationPopulation = z.infer<typeof EvaluationPopulationSchema>;

export const EvaluationBoundsSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(1000),
    maxElapsedMs: z.number().int().min(1).max(365 * 24 * 60 * 60 * 1000),
    maxCostCents: z.number().int().nonnegative(),
    maxFounderMinutes: z.number().int().nonnegative(),
    maxReviewerMinutes: z.number().int().nonnegative(),
    autonomyMode: AutonomyModeSchema,
    allowedGateClasses: z.array(GateClassSchema).default([]),
    forbiddenActions: z.array(z.string().min(1).max(1000)).default([]),
    timeoutMs: z.number().int().min(1000).max(7_200_000),
    killSwitchPath: z.string().min(1).max(1000),
    rollbackRoute: z.string().min(1).max(1000)
  })
  .strict();

export type EvaluationBounds = z.infer<typeof EvaluationBoundsSchema>;

export const EvaluationObservationWindowSchema = z
  .object({
    startsAt: IsoTimestampSchema,
    endsAt: IsoTimestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "observation window must end after it starts" });
    }
  });

export type EvaluationObservationWindow = z.infer<typeof EvaluationObservationWindowSchema>;

export const EvaluationPromotionRuleSchema = z
  .object({
    minimumPrimaryMetricImprovement: z.number(),
    maximumCostIncreasePercent: z.number().nonnegative(),
    maximumFounderTimeIncreasePercent: z.number().nonnegative(),
    maximumComplexityIncreasePercent: z.number().nonnegative(),
    minimumSampleSize: z.number().int().positive(),
    requireAllHardGates: z.boolean(),
    requireIndependentReview: z.boolean(),
    requireHeldOut: z.boolean(),
    requireCrossVenture: z.boolean(),
    allowedDispositions: z.array(EvaluationDispositionSchema).min(1)
  })
  .strict();

export type EvaluationPromotionRule = z.infer<typeof EvaluationPromotionRuleSchema>;

const EvaluationContractInputShape = {
  ventureId: VentureIdSchema,
  packRevisionId: EntityIdSchema,
  goalRevisionId: EntityIdSchema,
  skillVersionId: EntityIdSchema.optional(),
  candidateVersion: z.string().min(1).max(240).optional(),
  name: z.string().min(1).max(240),
  hypothesis: z.string().min(1).max(2000),
  baseline: EvaluationBaselineSchema,
  primaryMetric: EvaluationPrimaryMetricSchema,
  hardGates: z.array(EvaluationHardGateSchema).min(1),
  evaluationPopulation: EvaluationPopulationSchema,
  mutableSurface: z.array(z.string().min(1).max(1000)).min(1),
  bounds: EvaluationBoundsSchema,
  observationWindow: EvaluationObservationWindowSchema,
  expectedReceiptTypes: z.array(z.string().min(1).max(240)).min(1),
  knownConfounders: z.array(z.string().min(1).max(1000)).default([]),
  producerId: z.string().min(1).max(240),
  evaluatorId: z.string().min(1).max(240),
  reviewerId: z.string().min(1).max(240),
  promotionAuthorityId: z.string().min(1).max(240),
  promotionRule: EvaluationPromotionRuleSchema,
  promotionRuleHash: Sha256Schema,
  requestedAt: IsoTimestampSchema,
  idempotencyKey: IdempotencyKeySchema
};

function validateEvaluationAuthoritySeparation(
  value: { producerId: string; evaluatorId: string; reviewerId: string; promotionAuthorityId: string },
  ctx: z.RefinementCtx
): void {
  if (value.producerId === value.evaluatorId) {
    ctx.addIssue({ code: "custom", path: ["evaluatorId"], message: "producer and evaluator must be separate" });
  }
  if (value.producerId === value.reviewerId) {
    ctx.addIssue({ code: "custom", path: ["reviewerId"], message: "producer cannot independently review its own work" });
  }
  if (value.evaluatorId === value.reviewerId) {
    ctx.addIssue({ code: "custom", path: ["reviewerId"], message: "the independent reviewer must be separate from the evaluator" });
  }
  if (value.producerId === value.promotionAuthorityId || value.evaluatorId === value.promotionAuthorityId) {
    ctx.addIssue({ code: "custom", path: ["promotionAuthorityId"], message: "promotion authority must be separate from producer and evaluator" });
  }
  if (value.reviewerId === value.promotionAuthorityId) {
    ctx.addIssue({ code: "custom", path: ["promotionAuthorityId"], message: "promotion authority must be separate from reviewer" });
  }
}

function validateEvaluationDefinitionUniqueness(
  value: {
    hardGates: ReadonlyArray<{ id: string }>;
    expectedReceiptTypes: ReadonlyArray<string>;
    mutableSurface: ReadonlyArray<string>;
    bounds: { allowedGateClasses: ReadonlyArray<string> };
  },
  ctx: z.RefinementCtx
): void {
  if (new Set(value.hardGates.map((gate) => gate.id)).size !== value.hardGates.length) {
    ctx.addIssue({ code: "custom", path: ["hardGates"], message: "evaluation hard-gate ids must be unique" });
  }
  if (new Set(value.expectedReceiptTypes).size !== value.expectedReceiptTypes.length) {
    ctx.addIssue({ code: "custom", path: ["expectedReceiptTypes"], message: "expected receipt types must be unique" });
  }
  if (new Set(value.mutableSurface).size !== value.mutableSurface.length) {
    ctx.addIssue({ code: "custom", path: ["mutableSurface"], message: "mutable-surface entries must be unique" });
  }
  if (new Set(value.bounds.allowedGateClasses).size !== value.bounds.allowedGateClasses.length) {
    ctx.addIssue({ code: "custom", path: ["bounds", "allowedGateClasses"], message: "allowed gate classes must be unique" });
  }
}

export const EvaluationContractInputSchema = z
  .object(EvaluationContractInputShape)
  .strict()
  .superRefine((value, ctx) => {
    validateEvaluationAuthoritySeparation(value, ctx);
    validateEvaluationDefinitionUniqueness(value, ctx);
  });

export type EvaluationContractInput = z.infer<typeof EvaluationContractInputSchema>;

export const EvaluationContractSchema = z
  .object({
    id: EntityIdSchema,
    revision: z.number().int().positive(),
    ...EvaluationContractInputShape,
    supersedesEvaluationContractId: EntityIdSchema.optional(),
    createdAt: IsoTimestampSchema,
    frozenAt: IsoTimestampSchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine((value, ctx) => {
    validateEvaluationAuthoritySeparation(value, ctx);
    validateEvaluationDefinitionUniqueness(value, ctx);
    if (value.revision > 1 && !value.supersedesEvaluationContractId) {
      ctx.addIssue({
        code: "custom",
        path: ["supersedesEvaluationContractId"],
        message: "evaluation revisions after the first must identify the contract they supersede"
      });
    }
    if (value.revision === 1 && value.supersedesEvaluationContractId) {
      ctx.addIssue({
        code: "custom",
        path: ["supersedesEvaluationContractId"],
        message: "the first evaluation revision cannot supersede another contract"
      });
    }
  })
  .readonly();

export type EvaluationContract = z.infer<typeof EvaluationContractSchema>;

export const EvaluationManifestArtifactSchema = z
  .object({
    relativePath: z.string().min(1).max(2000),
    absolutePath: z.string().min(1).max(4000),
    contentHash: Sha256Schema
  })
  .strict();

export type EvaluationManifestArtifact = z.infer<typeof EvaluationManifestArtifactSchema>;

export const EvaluationManifestReceiptSchema = z
  .object({
    id: EntityIdSchema,
    binding: z.enum(["baseline", "plain-agent-baseline", "no-history-baseline"]),
    receiptType: z.string().min(1).max(240),
    artifact: EvaluationManifestArtifactSchema,
    contentHash: Sha256Schema,
    occurredAt: IsoTimestampSchema,
    outcome: z.enum(["success", "partial", "failure", "aborted-precondition", "aborted-killswitch"]),
    origin: ReceiptOriginSchema,
    baselineTrust: z.string().min(1).max(120),
    promotionEligible: z.boolean(),
    trustModel: z.literal("single-operator-local"),
    customerSafe: z.literal(false),
    primaryMetricValue: z.number().optional(),
    costCents: z.number().nonnegative().nullable(),
    founderMinutes: z.number().nonnegative().nullable(),
    complexityUnits: z.number().nonnegative().nullable()
  })
  .strict();

export const EvaluationManifestCaseSchema = z
  .object({
    caseRef: EntityIdSchema,
    kind: z.enum(["source", "evidence"]),
    frozenContentHash: Sha256Schema,
    sourceRevision: z.string().min(1).nullable(),
    source: SourceReferenceSchema.optional(),
    evidence: EvidenceItemSchema.optional(),
    artifact: EvaluationManifestArtifactSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "source" && (!value.source || value.evidence)) {
      ctx.addIssue({ code: "custom", message: "source evaluation cases require only a source record" });
    }
    if (value.kind === "evidence" && (!value.evidence || value.source)) {
      ctx.addIssue({ code: "custom", message: "evidence evaluation cases require only an evidence record" });
    }
  });

export const EvaluationInputManifestSchema = z
  .object({
    schemaVersion: z.literal("evaluation-input-manifest-v1"),
    ventureId: VentureIdSchema,
    evaluationContractId: EntityIdSchema,
    evaluationContractHash: Sha256Schema,
    hypothesis: z.string().min(1).max(2000),
    evidenceMode: z.literal("frozen-local-artifacts"),
    networkAccessPolicy: z.literal("forbidden"),
    networkIsolation: z.literal("not-mechanically-verified"),
    promotionEligibility: z.literal("blocked-pending-network-isolation-proof"),
    formulaExecutionMode: z.literal("specialist-applied-free-text-formula"),
    candidate: z
      .object({
        skillVersionId: EntityIdSchema,
        skillVersionHash: Sha256Schema,
        version: z.string().min(1).max(240),
        producerId: z.string().min(1).max(240),
        artifact: EvaluationManifestArtifactSchema
      })
      .strict(),
    baseline: z
      .object({
        description: z.string().min(1).max(2000),
        artifactHash: Sha256Schema,
        primaryMetricValue: z.number(),
        receipts: z.array(EvaluationManifestReceiptSchema).min(1)
      })
      .strict(),
    primaryMetric: EvaluationPrimaryMetricSchema,
    population: z
      .object({
        definition: EvaluationPopulationSchema,
        cases: z.array(EvaluationManifestCaseSchema).min(1)
      })
      .strict(),
    hardGates: z.array(EvaluationHardGateSchema).min(1),
    mutableSurface: z.array(z.string().min(1).max(1000)).min(1),
    bounds: EvaluationBoundsSchema,
    expectedReceiptTypes: z.array(z.string().min(1).max(240)).min(1),
    knownConfounders: z.array(z.string().min(1).max(1000)),
    promotionRule: EvaluationPromotionRuleSchema,
    promotionRuleHash: Sha256Schema,
    allowedArtifactPaths: z.array(z.string().min(1).max(4000)).min(1),
    frozenAt: IsoTimestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (sha256(value.promotionRule) !== value.promotionRuleHash) {
      ctx.addIssue({ code: "custom", path: ["promotionRuleHash"], message: "manifest promotion rule hash does not match" });
    }
    const actualPaths = [
      value.candidate.artifact.absolutePath,
      ...value.baseline.receipts.map((receipt) => receipt.artifact.absolutePath),
      ...value.population.cases.map((item) => item.artifact.absolutePath)
    ];
    if (canonicalize([...new Set(actualPaths)].sort()) !== canonicalize([...new Set(value.allowedArtifactPaths)].sort())) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedArtifactPaths"],
        message: "allowed artifact paths must exactly match the frozen candidate, baseline, and population artifacts"
      });
    }
    if (new Set(value.allowedArtifactPaths).size !== value.allowedArtifactPaths.length) {
      ctx.addIssue({ code: "custom", path: ["allowedArtifactPaths"], message: "allowed artifact paths must be unique" });
    }
    if (new Set(value.population.cases.map((item) => item.caseRef)).size !== value.population.cases.length) {
      ctx.addIssue({ code: "custom", path: ["population", "cases"], message: "manifest population cases must be unique" });
    }
    if (new Set(value.hardGates.map((gate) => gate.id)).size !== value.hardGates.length) {
      ctx.addIssue({ code: "custom", path: ["hardGates"], message: "manifest hard-gate ids must be unique" });
    }
    if (new Set(value.expectedReceiptTypes).size !== value.expectedReceiptTypes.length) {
      ctx.addIssue({ code: "custom", path: ["expectedReceiptTypes"], message: "manifest expected receipt types must be unique" });
    }
  });

export type EvaluationInputManifest = z.infer<typeof EvaluationInputManifestSchema>;

export const ExperimentAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    candidateHash: Sha256Schema,
    outcome: z.enum(["succeeded", "failed", "crashed", "gated", "unsafe"]),
    receiptIds: z.array(EntityIdSchema).default([]),
    providerCostCents: z.number().int().nonnegative().nullable(),
    modelCostCents: z.number().int().nonnegative().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
    founderMinutes: z.number().int().nonnegative().nullable(),
    reviewerMinutes: z.number().int().nonnegative().nullable(),
    sideEffects: z.array(z.string().min(1).max(1000)).default([]),
    confounders: z.array(z.string().min(1).max(1000)).default([]),
    notes: z.string().max(2000).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
      ctx.addIssue({ code: "custom", path: ["completedAt"], message: "attempt cannot finish before it starts" });
    }
  });

export type ExperimentAttempt = z.infer<typeof ExperimentAttemptSchema>;

export const ExperimentCostsSchema = z
  .object({
    providerCostCents: z.number().int().nonnegative().nullable(),
    modelCostCents: z.number().int().nonnegative().nullable(),
    otherCostCents: z.number().int().nonnegative().nullable(),
    founderMinutes: z.number().int().nonnegative().nullable(),
    reviewerMinutes: z.number().int().nonnegative().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable()
  })
  .strict();

export type ExperimentCosts = z.infer<typeof ExperimentCostsSchema>;

export const ExperimentReviewerSchema = z
  .object({
    reviewerId: z.string().min(1).max(240),
    reviewedAt: IsoTimestampSchema,
    independentFromProducer: z.boolean(),
    receiptId: EntityIdSchema,
    verdict: EvaluationDispositionSchema,
    notes: z.string().min(1).max(2000)
  })
  .strict();

export type ExperimentReviewer = z.infer<typeof ExperimentReviewerSchema>;

export const ExperimentHardGateResultSchema = z
  .object({
    hardGateId: EntityIdSchema,
    passed: z.boolean(),
    evidenceIds: z.array(EntityIdSchema).min(1),
    reason: z.string().min(1).max(1000)
  })
  .strict();

export type ExperimentHardGateResult = z.infer<typeof ExperimentHardGateResultSchema>;

export const ExperimentPrimaryMetricResultSchema = z
  .object({
    metricId: EntityIdSchema,
    baselineValue: z.number(),
    candidateValue: z.number(),
    improvement: z.number(),
    sampleSize: z.number().int().positive(),
    thresholdPassed: z.boolean(),
    scoringReceiptId: EntityIdSchema
  })
  .strict();

export type ExperimentPrimaryMetricResult = z.infer<typeof ExperimentPrimaryMetricResultSchema>;

export const ExperimentMissingOutputSchema = z.enum([
  "attempts",
  "attempts.costs",
  "attempts.receipts",
  "costs.providerCostCents",
  "costs.modelCostCents",
  "costs.otherCostCents",
  "costs.founderMinutes",
  "costs.reviewerMinutes",
  "costs.elapsedMs",
  "outcomeReceiptId",
  "primaryMetricResult",
  "hardGateResults",
  "reviewer",
  "baseline.costCents",
  "baseline.founderMinutes",
  "baseline.complexityUnits"
]);

export type ExperimentMissingOutput = z.infer<typeof ExperimentMissingOutputSchema>;

export const ExperimentRefinementSchema = z
  .object({
    sequence: z.number().int().positive(),
    description: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
    diffHash: Sha256Schema,
    mutableSurface: z.array(z.string().min(1).max(1000)).min(1),
    recordedAt: IsoTimestampSchema
  })
  .strict();

export type ExperimentRefinement = z.infer<typeof ExperimentRefinementSchema>;

const ExperimentRecordInputShape = {
  ventureId: VentureIdSchema,
  evaluationContractId: EntityIdSchema,
  evaluationContractHash: Sha256Schema,
  goalRevisionId: EntityIdSchema,
  initiativeCandidateId: EntityIdSchema.optional(),
  skillVersionId: EntityIdSchema.optional(),
  hypothesis: z.string().min(1).max(2000),
  baselineReceiptId: EntityIdSchema,
  producerId: z.string().min(1).max(240),
  candidateVersion: z.string().min(1).max(240),
  candidateArtifactHash: Sha256Schema,
  attempts: z.array(ExperimentAttemptSchema).max(1000),
  costs: ExperimentCostsSchema,
  receiptIds: z.array(EntityIdSchema).min(1),
  outcomeReceiptId: EntityIdSchema.optional(),
  terminalReceiptId: EntityIdSchema,
  outcomeSummary: z.string().min(1).max(2000),
  confounders: z.array(z.string().min(1).max(1000)).default([]),
  primaryMetricResult: ExperimentPrimaryMetricResultSchema.nullable(),
  hardGateResults: z.array(ExperimentHardGateResultSchema).max(1000),
  reviewer: ExperimentReviewerSchema.nullable(),
  missingOutputs: z.array(ExperimentMissingOutputSchema),
  disposition: EvaluationDispositionSchema,
  complexityDeltaPercent: z.number().nullable(),
  implementationState: z.enum(["retained", "reverted", "not-applied"]),
  refinements: z.array(ExperimentRefinementSchema).default([]),
  nextHypothesis: z.string().min(1).max(2000).optional(),
  recordedAt: IsoTimestampSchema,
  idempotencyKey: IdempotencyKeySchema
};

function validateExperimentRecord(
  value: {
    producerId: string;
    baselineReceiptId: string;
    attempts: ReadonlyArray<{
      attempt: number;
      outcome: "succeeded" | "failed" | "crashed" | "gated" | "unsafe";
      receiptIds: ReadonlyArray<string>;
      providerCostCents: number | null;
      modelCostCents: number | null;
      elapsedMs: number | null;
      founderMinutes: number | null;
      reviewerMinutes: number | null;
    }>;
    costs: {
      providerCostCents: number | null;
      modelCostCents: number | null;
      otherCostCents: number | null;
      founderMinutes: number | null;
      reviewerMinutes: number | null;
      elapsedMs: number | null;
    };
    receiptIds: ReadonlyArray<string>;
    outcomeReceiptId?: string | undefined;
    terminalReceiptId?: string | undefined;
    primaryMetricResult: { thresholdPassed: boolean; scoringReceiptId: string } | null;
    hardGateResults: ReadonlyArray<{ passed: boolean; evidenceIds: ReadonlyArray<string> }>;
    reviewer: { reviewerId: string; independentFromProducer: boolean; receiptId: string; verdict: EvaluationDisposition } | null;
    missingOutputs: ReadonlyArray<ExperimentMissingOutput>;
    disposition: EvaluationDisposition;
    complexityDeltaPercent: number | null;
    implementationState: "retained" | "reverted" | "not-applied";
  },
  ctx: z.RefinementCtx
): void {
  const attemptNumbers = new Set<number>();
  const receiptIds = new Set(value.receiptIds);
  const attemptReceiptIds = new Set<string>();
  const missingOutputs = new Set(value.missingOutputs);
  const baselineMissingOutputs = new Set(
    value.missingOutputs.filter((output) => output.startsWith("baseline."))
  );
  const expectedMissingOutputs = new Set<ExperimentMissingOutput>();
  const bindReceipt = (receiptId: string, path: PropertyKey[], label: string): void => {
    if (!receiptIds.has(receiptId)) {
      ctx.addIssue({ code: "custom", path, message: `${label} is missing from record receipts` });
    }
  };

  if (value.attempts.length === 0) {
    expectedMissingOutputs.add("attempts");
  } else {
    if (
      value.attempts.some(
        (attempt) =>
          attempt.providerCostCents === null ||
          attempt.modelCostCents === null ||
          attempt.elapsedMs === null ||
          attempt.founderMinutes === null ||
          attempt.reviewerMinutes === null
      )
    ) {
      expectedMissingOutputs.add("attempts.costs");
    }
    if (value.attempts.some((attempt) => attempt.receiptIds.length === 0)) {
      expectedMissingOutputs.add("attempts.receipts");
    }
  }
  if (receiptIds.size !== value.receiptIds.length) {
    ctx.addIssue({ code: "custom", path: ["receiptIds"], message: "experiment receipt ids must be unique" });
  }
  const costOutputs = {
    providerCostCents: "costs.providerCostCents",
    modelCostCents: "costs.modelCostCents",
    otherCostCents: "costs.otherCostCents",
    founderMinutes: "costs.founderMinutes",
    reviewerMinutes: "costs.reviewerMinutes",
    elapsedMs: "costs.elapsedMs"
  } as const;
  for (const [field, output] of Object.entries(costOutputs) as Array<
    [keyof typeof costOutputs, (typeof costOutputs)[keyof typeof costOutputs]]
  >) {
    if (value.costs[field] === null) {
      expectedMissingOutputs.add(output);
    }
  }
  if (!value.outcomeReceiptId) expectedMissingOutputs.add("outcomeReceiptId");
  if (!value.primaryMetricResult) expectedMissingOutputs.add("primaryMetricResult");
  if (value.hardGateResults.length === 0) expectedMissingOutputs.add("hardGateResults");
  if (!value.reviewer) expectedMissingOutputs.add("reviewer");

  if (missingOutputs.size !== value.missingOutputs.length) {
    ctx.addIssue({ code: "custom", path: ["missingOutputs"], message: "missing outputs must not contain duplicates" });
  }
  const unreportedMissing = [...expectedMissingOutputs].filter((output) => !missingOutputs.has(output));
  const falselyReported = [...missingOutputs].filter(
    (output) => !expectedMissingOutputs.has(output) && !baselineMissingOutputs.has(output)
  );
  if (unreportedMissing.length > 0 || falselyReported.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["missingOutputs"],
      message: `missing outputs must exactly match absent or unknown record fields; unreported=${unreportedMissing.sort().join(",") || "none"}; false=${falselyReported.sort().join(",") || "none"}`
    });
  }

  bindReceipt(value.baselineReceiptId, ["baselineReceiptId"], "baseline receipt");
  if (value.terminalReceiptId) bindReceipt(value.terminalReceiptId, ["terminalReceiptId"], "terminal receipt");
  if (value.outcomeReceiptId) bindReceipt(value.outcomeReceiptId, ["outcomeReceiptId"], "outcome receipt");
  for (const [index, attempt] of value.attempts.entries()) {
    if (attemptNumbers.has(attempt.attempt)) {
      ctx.addIssue({ code: "custom", path: ["attempts", index, "attempt"], message: "attempt numbers must be unique" });
    }
    attemptNumbers.add(attempt.attempt);
    if (new Set(attempt.receiptIds).size !== attempt.receiptIds.length) {
      ctx.addIssue({ code: "custom", path: ["attempts", index, "receiptIds"], message: "attempt receipt ids must be unique" });
    }
    for (const receiptId of attempt.receiptIds) {
      if (!receiptIds.has(receiptId)) {
        ctx.addIssue({ code: "custom", path: ["attempts", index, "receiptIds"], message: `attempt receipt ${receiptId} is missing from record receipts` });
      }
      if (attemptReceiptIds.has(receiptId)) {
        ctx.addIssue({ code: "custom", path: ["attempts", index, "receiptIds"], message: `attempt receipt ${receiptId} cannot be reused across attempts` });
      }
      attemptReceiptIds.add(receiptId);
    }
  }
  if (value.reviewer) {
    bindReceipt(value.reviewer.receiptId, ["reviewer", "receiptId"], "reviewer receipt");
  }
  if (value.primaryMetricResult) {
    bindReceipt(value.primaryMetricResult.scoringReceiptId, ["primaryMetricResult", "scoringReceiptId"], "scoring receipt");
  }
  if (value.reviewer && value.reviewer.verdict !== value.disposition) {
    ctx.addIssue({ code: "custom", path: ["reviewer", "verdict"], message: "reviewer verdict must match the recorded disposition" });
  }
  if (value.attempts.some((attempt) => attempt.outcome === "unsafe") && value.disposition !== "unsafe") {
    ctx.addIssue({ code: "custom", path: ["disposition"], message: "an unsafe attempt forces the unsafe disposition" });
  }
  if (value.implementationState === "retained" && value.disposition !== "keep") {
    ctx.addIssue({ code: "custom", path: ["implementationState"], message: "only kept experiments may retain the implementation" });
  }

  switch (value.disposition) {
    case "gated":
      if (value.implementationState !== "not-applied") {
        ctx.addIssue({ code: "custom", path: ["implementationState"], message: "gated experiments must remain not-applied" });
      }
      break;
    case "inconclusive":
      if (value.attempts.length === 0) {
        ctx.addIssue({ code: "custom", path: ["attempts"], message: "inconclusive requires at least one attempt" });
      }
      if (value.missingOutputs.length === 0) {
        ctx.addIssue({ code: "custom", path: ["missingOutputs"], message: "inconclusive requires at least one exact missing output" });
      }
      break;
    case "crash":
      if (!value.attempts.some((attempt) => attempt.outcome === "crashed" && attempt.receiptIds.length > 0)) {
        ctx.addIssue({ code: "custom", path: ["attempts"], message: "crash requires a crashed attempt with a receipt" });
      }
      break;
    case "unsafe": {
      const unsafeAttemptProof = value.attempts.some(
        (attempt) => attempt.outcome === "unsafe" && attempt.receiptIds.length > 0
      );
      const failedGateProof = value.hardGateResults.some((gate) => !gate.passed && gate.evidenceIds.length > 0);
      if (!unsafeAttemptProof && !failedGateProof) {
        ctx.addIssue({
          code: "custom",
          path: ["disposition"],
          message: "unsafe requires an unsafe attempt receipt or failed hard-gate proof"
        });
      }
      break;
    }
    case "discard":
      if (value.attempts.length === 0 || !value.primaryMetricResult || !value.reviewer) {
        ctx.addIssue({ code: "custom", path: ["disposition"], message: "discard requires an attempt, a score, and a review" });
      }
      break;
    case "keep": {
      if (value.attempts.length === 0) {
        ctx.addIssue({ code: "custom", path: ["attempts"], message: "keep requires at least one attempt" });
      }
      if (expectedMissingOutputs.size > 0) {
        ctx.addIssue({ code: "custom", path: ["missingOutputs"], message: "keep requires every expected output and exact cost" });
      }
      if (baselineMissingOutputs.size > 0 || value.complexityDeltaPercent === null) {
        ctx.addIssue({ code: "custom", path: ["missingOutputs"], message: "keep requires exact baseline cost, founder-time, and complexity inputs" });
      }
      if (!value.primaryMetricResult?.thresholdPassed) {
        ctx.addIssue({ code: "custom", path: ["disposition"], message: "keep requires the frozen primary-metric threshold to pass" });
      }
      if (value.hardGateResults.length === 0 || value.hardGateResults.some((gate) => !gate.passed)) {
        ctx.addIssue({ code: "custom", path: ["hardGateResults"], message: "keep requires evidenced passing hard gates" });
      }
      if (!value.reviewer || !value.reviewer.independentFromProducer || value.reviewer.reviewerId === value.producerId) {
        ctx.addIssue({ code: "custom", path: ["reviewer"], message: "keep requires an independent reviewer" });
      }
      if (value.implementationState === "reverted") {
        ctx.addIssue({
          code: "custom",
          path: ["implementationState"],
          message: "kept experiments may be retained or remain not-applied, but cannot be marked reverted"
        });
      }
      const exactAttemptCosts = value.attempts.every(
        (attempt) =>
          attempt.providerCostCents !== null &&
          attempt.modelCostCents !== null &&
          attempt.elapsedMs !== null &&
          attempt.founderMinutes !== null &&
          attempt.reviewerMinutes !== null
      );
      const exactCosts = Object.values(value.costs).every((cost) => cost !== null);
      if (exactAttemptCosts && exactCosts) {
        const summed = {
          providerCostCents: value.attempts.reduce((total, attempt) => total + attempt.providerCostCents!, 0),
          modelCostCents: value.attempts.reduce((total, attempt) => total + attempt.modelCostCents!, 0),
          founderMinutes: value.attempts.reduce((total, attempt) => total + attempt.founderMinutes!, 0),
          reviewerMinutes: value.attempts.reduce((total, attempt) => total + attempt.reviewerMinutes!, 0),
          elapsedMs: value.attempts.reduce((total, attempt) => total + attempt.elapsedMs!, 0)
        };
        for (const field of Object.keys(summed) as Array<keyof typeof summed>) {
          if (summed[field] !== value.costs[field]) {
            ctx.addIssue({
              code: "custom",
              path: ["costs", field],
              message: `kept experiment ${field} must equal the exact attempt ledger`
            });
          }
        }
      }
      break;
    }
  }
}

export const ExperimentRecordInputSchema = z
  .object(ExperimentRecordInputShape)
  .omit({ terminalReceiptId: true })
  .strict()
  .superRefine(validateExperimentRecord);

export type ExperimentRecordInput = z.infer<typeof ExperimentRecordInputSchema>;

export const ExperimentRecordSchema = z
  .object({
    id: EntityIdSchema,
    sequence: z.number().int().positive(),
    ...ExperimentRecordInputShape,
    createdAt: IsoTimestampSchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine(validateExperimentRecord)
  .readonly();

export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;

export const EvaluationScoringCaseResultSchema = z
  .object({
    caseRef: EntityIdSchema,
    baselineScore: z.number(),
    candidateScore: z.number(),
    abstained: z.boolean(),
    evidenceRefs: z.array(EntityIdSchema).default([]),
    notes: z.string().max(1000).optional()
  })
  .strict();

export const EvaluationScoringOutputSchema = z
  .object({
    baselineValue: z.number(),
    candidateValue: z.number(),
    sampleSize: z.number().int().nonnegative(),
    candidateComplexityUnits: z.number().nonnegative(),
    otherCostCents: z.number().int().nonnegative().nullable(),
    leakageDetected: z.boolean(),
    caseResults: z.array(EvaluationScoringCaseResultSchema).default([]),
    hardGateResults: z.array(ExperimentHardGateResultSchema),
    notes: z.string().min(1).max(2000)
  })
  .strict()
  .superRefine((value, ctx) => {
    const caseRefs = value.caseResults.map((item) => item.caseRef);
    if (new Set(caseRefs).size !== caseRefs.length) {
      ctx.addIssue({ code: "custom", path: ["caseResults"], message: "scoring case results must contain unique case references" });
    }
    const effectiveSampleSize = value.caseResults.filter((item) => !item.abstained).length;
    if (value.sampleSize !== effectiveSampleSize) {
      ctx.addIssue({ code: "custom", path: ["sampleSize"], message: "sample size must equal the number of non-abstained structured case results" });
    }
    const hardGateIds = value.hardGateResults.map((item) => item.hardGateId);
    if (new Set(hardGateIds).size !== hardGateIds.length) {
      ctx.addIssue({ code: "custom", path: ["hardGateResults"], message: "scoring hard-gate results must contain unique hard-gate ids" });
    }
  });

export type EvaluationScoringOutput = z.infer<typeof EvaluationScoringOutputSchema>;

export const EvaluationReviewOutputSchema = z
  .object({
    verdict: EvaluationDispositionSchema,
    reproducedCandidateValue: z.number().nullable(),
    reproducedSampleSize: z.number().int().positive().nullable(),
    scoringMatches: z.boolean(),
    hardGatesPassed: z.boolean(),
    leakageDetected: z.boolean(),
    notes: z.string().min(1).max(2000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict === "keep" && (!value.scoringMatches || !value.hardGatesPassed || value.leakageDetected)) {
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "keep review requires matching scoring, passing hard gates, and no leakage" });
    }
  });

export type EvaluationReviewOutput = z.infer<typeof EvaluationReviewOutputSchema>;

export const SKILL_EVIDENCE_STATE_ORDER = [
  "draft",
  "candidate",
  "held-out-verified",
  "cross-venture-proven"
] as const;

export type PromotableSkillEvidenceState = (typeof SKILL_EVIDENCE_STATE_ORDER)[number];

export const SKILL_EVIDENCE_STATE_RANK: Readonly<Record<PromotableSkillEvidenceState, number>> = Object.freeze({
  draft: 0,
  candidate: 1,
  "held-out-verified": 2,
  "cross-venture-proven": 3
});

export const SkillEvidenceStateSchema = z.enum([...SKILL_EVIDENCE_STATE_ORDER, "deprecated"]);

export type SkillEvidenceState = z.infer<typeof SkillEvidenceStateSchema>;

export function isAdjacentSkillEvidencePromotion(fromState: SkillEvidenceState, toState: SkillEvidenceState): boolean {
  if (fromState === "deprecated" || toState === "deprecated") return false;
  return SKILL_EVIDENCE_STATE_RANK[toState] === SKILL_EVIDENCE_STATE_RANK[fromState] + 1;
}

const SkillVersionInputShape = {
  ventureId: VentureIdSchema,
  skillId: EntityIdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  name: z.string().min(1).max(240),
  state: SkillEvidenceStateSchema,
  artifactPath: z.string().min(1).max(1000),
  artifactHash: Sha256Schema,
  applicability: z.array(z.string().min(1).max(1000)).min(1),
  exclusions: z.array(z.string().min(1).max(1000)).default([]),
  assumptions: z.array(z.string().min(1).max(1000)).default([]),
  mutableSurface: z.array(z.string().min(1).max(1000)).min(1),
  evidenceIds: z.array(EntityIdSchema).default([]),
  evaluationContractIds: z.array(EntityIdSchema).default([]),
  experimentRecordIds: z.array(EntityIdSchema).default([]),
  evaluatedVentureIds: z.array(VentureIdSchema).default([]),
  supersedesSkillVersionId: EntityIdSchema.optional(),
  producerId: z.string().min(1).max(240),
  recordedBy: z.string().min(1).max(240),
  reason: z.string().min(1).max(2000),
  recordedAt: IsoTimestampSchema,
  idempotencyKey: IdempotencyKeySchema
};

function validateSkillVersionEvidence(
  value: {
    state: z.infer<typeof SkillEvidenceStateSchema>;
    ventureId: string;
    evidenceIds: ReadonlyArray<string>;
    evaluationContractIds: ReadonlyArray<string>;
    experimentRecordIds: ReadonlyArray<string>;
    evaluatedVentureIds: ReadonlyArray<string>;
    supersedesSkillVersionId?: string | undefined;
  },
  ctx: z.RefinementCtx
): void {
  if (["held-out-verified", "cross-venture-proven"].includes(value.state)) {
    if (value.evidenceIds.length === 0 || value.evaluationContractIds.length === 0 || value.experimentRecordIds.length === 0) {
      ctx.addIssue({ code: "custom", message: `${value.state} skills require evidence, evaluation contracts, and experiment records` });
    }
  }
  if (value.state === "draft") {
    if (
      value.evidenceIds.length > 0 ||
      value.evaluationContractIds.length > 0 ||
      value.experimentRecordIds.length > 0 ||
      value.evaluatedVentureIds.length > 0
    ) {
      ctx.addIssue({ code: "custom", message: "draft skills cannot claim evaluation, experiment, or transfer evidence" });
    }
  }
  if (value.state === "cross-venture-proven") {
    const ventures = new Set([value.ventureId, ...value.evaluatedVentureIds]);
    if (ventures.size < 2) {
      ctx.addIssue({ code: "custom", path: ["evaluatedVentureIds"], message: "cross-venture proof requires a second venture" });
    }
  }
  if (["held-out-verified", "cross-venture-proven", "deprecated"].includes(value.state) && !value.supersedesSkillVersionId) {
    ctx.addIssue({
      code: "custom",
      path: ["supersedesSkillVersionId"],
      message: `${value.state} skill state requires an explicit predecessor version`
    });
  }
}

export const SkillVersionInputSchema = z.object(SkillVersionInputShape).strict().superRefine(validateSkillVersionEvidence);
export type SkillVersionInput = z.infer<typeof SkillVersionInputSchema>;

export const SkillVersionSchema = z
  .object({
    id: EntityIdSchema,
    revision: z.number().int().positive(),
    ...SkillVersionInputShape,
    createdAt: IsoTimestampSchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine(validateSkillVersionEvidence)
  .readonly();

export const SkillVersionRecordSchema = SkillVersionSchema;
export type SkillVersion = z.infer<typeof SkillVersionSchema>;
export type SkillVersionRecord = SkillVersion;

export const PlayPromotionDecisionSchema = z.enum(["promote", "refuse", "deprecate"]);
export type PlayPromotionDecision = z.infer<typeof PlayPromotionDecisionSchema>;

const PlayPromotionInputShape = {
  ventureId: VentureIdSchema,
  playId: EntityIdSchema,
  skillVersionId: EntityIdSchema,
  fromState: SkillEvidenceStateSchema,
  toState: SkillEvidenceStateSchema,
  decision: PlayPromotionDecisionSchema,
  evaluationContractIds: z.array(EntityIdSchema).min(1),
  experimentRecordIds: z.array(EntityIdSchema).min(1),
  evidenceIds: z.array(EntityIdSchema).min(1),
  transferVentureIds: z.array(VentureIdSchema).default([]),
  outcomeDefinitionHash: Sha256Schema,
  supportedArchetypes: z.array(z.string().min(1).max(500)).default([]),
  unsupportedArchetypes: z.array(z.string().min(1).max(500)).default([]),
  noHistoryBaselineReceiptIds: z.array(EntityIdSchema).default([]),
  plainAgentBaselineReceiptIds: z.array(EntityIdSchema).default([]),
  hardGatesPassed: z.boolean(),
  leakageDetected: z.boolean(),
  costWithinTolerance: z.boolean(),
  founderTimeWithinTolerance: z.boolean(),
  complexityWithinTolerance: z.boolean(),
  producerId: z.string().min(1).max(240),
  evaluatorId: z.string().min(1).max(240),
  reviewerId: z.string().min(1).max(240),
  promotionAuthorityId: z.string().min(1).max(240),
  reason: z.string().min(1).max(2000),
  nextBoundedTest: z.string().min(1).max(2000).optional(),
  requestedAt: IsoTimestampSchema,
  idempotencyKey: IdempotencyKeySchema
};

function validatePlayPromotion(
  value: {
    ventureId: string;
    fromState: z.infer<typeof SkillEvidenceStateSchema>;
    toState: z.infer<typeof SkillEvidenceStateSchema>;
    decision: z.infer<typeof PlayPromotionDecisionSchema>;
    transferVentureIds: ReadonlyArray<string>;
    noHistoryBaselineReceiptIds: ReadonlyArray<string>;
    plainAgentBaselineReceiptIds: ReadonlyArray<string>;
    hardGatesPassed: boolean;
    leakageDetected: boolean;
    costWithinTolerance: boolean;
    founderTimeWithinTolerance: boolean;
    complexityWithinTolerance: boolean;
    producerId: string;
    evaluatorId: string;
    reviewerId: string;
    promotionAuthorityId: string;
  },
  ctx: z.RefinementCtx
): void {
  if (value.producerId === value.evaluatorId || value.producerId === value.reviewerId || value.producerId === value.promotionAuthorityId) {
    ctx.addIssue({ code: "custom", path: ["producerId"], message: "a producer cannot evaluate, review, or promote its own play" });
  }
  if (value.evaluatorId === value.promotionAuthorityId) {
    ctx.addIssue({ code: "custom", path: ["promotionAuthorityId"], message: "promotion authority must be separate from evaluator" });
  }
  if (value.reviewerId === value.promotionAuthorityId) {
    ctx.addIssue({ code: "custom", path: ["promotionAuthorityId"], message: "promotion authority must be separate from reviewer" });
  }
  if (value.decision === "deprecate" && value.toState !== "deprecated") {
    ctx.addIssue({ code: "custom", path: ["toState"], message: "deprecation decisions must result in deprecated state" });
  }
  if (value.decision === "refuse" && value.toState !== value.fromState) {
    ctx.addIssue({ code: "custom", path: ["toState"], message: "a refused promotion must preserve the current evidence state" });
  }
  if (value.decision === "promote") {
    if (!isAdjacentSkillEvidencePromotion(value.fromState, value.toState)) {
      ctx.addIssue({
        code: "custom",
        path: ["toState"],
        message: "promotion must advance exactly one evidence state without skipping or regression"
      });
    }
    if (
      !value.hardGatesPassed ||
      value.leakageDetected ||
      !value.costWithinTolerance ||
      !value.founderTimeWithinTolerance ||
      !value.complexityWithinTolerance
    ) {
      ctx.addIssue({ code: "custom", message: "promotion cannot weaken safety, isolation, cost, founder-time, or complexity gates" });
    }
  }
  if (value.toState === "cross-venture-proven" && value.decision === "promote") {
    const transferVentures = new Set(value.transferVentureIds.filter((ventureId) => ventureId !== value.ventureId));
    if (transferVentures.size === 0) {
      ctx.addIssue({ code: "custom", path: ["transferVentureIds"], message: "cross-venture promotion requires a distinct transfer venture" });
    }
    if (value.noHistoryBaselineReceiptIds.length === 0 || value.plainAgentBaselineReceiptIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "cross-venture promotion requires no-history and plain-agent baseline receipts"
      });
    }
  }
}

export const PlayPromotionInputSchema = z.object(PlayPromotionInputShape).strict().superRefine(validatePlayPromotion);
export type PlayPromotionInput = z.infer<typeof PlayPromotionInputSchema>;

export const PlayPromotionSchema = z
  .object({
    id: EntityIdSchema,
    revision: z.number().int().positive(),
    ...PlayPromotionInputShape,
    supersedesPlayPromotionId: EntityIdSchema.optional(),
    createdAt: IsoTimestampSchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine(validatePlayPromotion)
  .readonly();

export const PlayPromotionRecordSchema = PlayPromotionSchema;
export type PlayPromotion = z.infer<typeof PlayPromotionSchema>;
export type PlayPromotionRecord = PlayPromotion;

export const GoalGetInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    goalRevisionId: EntityIdSchema.optional()
  })
  .strict();

export const EvaluationGetInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    evaluationContractId: EntityIdSchema
  })
  .strict();

export const EvaluationTasksPlanInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    evaluationContractId: EntityIdSchema,
    evaluationContractHash: Sha256Schema
  })
  .strict();

export type EvaluationTasksPlanInput = z.infer<typeof EvaluationTasksPlanInputSchema>;

export const EvaluationBaselineReceiptTypeSchema = z.enum([
  "baseline",
  "plain-agent-baseline",
  "no-history-baseline"
]);

export const EvaluationBaselineCaptureInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    receiptType: EvaluationBaselineReceiptTypeSchema,
    artifactPath: z.string().min(1).max(4000),
    contentHash: Sha256Schema,
    primaryMetricValue: z.number().optional(),
    costCents: z.number().nonnegative().nullable().default(null),
    founderMinutes: z.number().nonnegative().nullable().default(null),
    complexityUnits: z.number().nonnegative().nullable().default(null),
    capturedBy: z.string().min(1).max(240),
    requestedAt: IsoTimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.receiptType === "baseline" && value.primaryMetricValue === undefined) {
      ctx.addIssue({ code: "custom", path: ["primaryMetricValue"], message: "primary baseline capture requires a metric value" });
    }
    if (value.receiptType !== "baseline" && value.primaryMetricValue !== undefined) {
      ctx.addIssue({ code: "custom", path: ["primaryMetricValue"], message: "comparison baselines cannot assert the primary metric" });
    }
  });

export type EvaluationBaselineCaptureInput = z.infer<typeof EvaluationBaselineCaptureInputSchema>;

export const ExperimentGetInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    experimentRecordId: EntityIdSchema
  })
  .strict();

export const SkillVersionListInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    skillId: EntityIdSchema.optional(),
    state: SkillEvidenceStateSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(500).optional()
  })
  .strict();

export const PlayPromotionListInputSchema = z
  .object({
    ventureId: VentureIdSchema,
    playId: EntityIdSchema.optional(),
    skillVersionId: EntityIdSchema.optional(),
    state: SkillEvidenceStateSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(500).optional()
  })
  .strict();

export const CommandNameSchema = z.enum([
  "company.bootstrap",
  "company.get",
  "company.list",
  "company.run",
  "company.pause",
  "company.kill",
  "company.export",
  "company.delete",
  "venture.create_or_update_pack",
  "venture.get",
  "venture.readiness",
  "venture.request_transition",
  "play.propose",
  "task.plan",
  "task.run_safe",
  "task.get",
  "approval.list_pending",
  "approval.resolve",
  "approval.revoke",
  "receipt.attach",
  "portfolio.scorecard",
  "goal.get",
  "goal.preview_change",
  "goal.confirm_change",
  "initiative.decide",
  "evaluation.create",
  "evaluation.get",
  "evaluation.baseline.capture",
  "evaluation.tasks.plan",
  "experiment.record",
  "experiment.get",
  "skill.version.record",
  "skill.version.list",
  "play.promotion.record",
  "play.promotion.list"
]);

export type CommandName = z.infer<typeof CommandNameSchema>;

export const CommandInputSchemas: Record<CommandName, z.ZodType> = {
  "company.bootstrap": CompanyBootstrapInputSchema,
  "company.get": z.object({ ventureId: VentureIdSchema }).strict(),
  "company.list": z.object({}).strict(),
  "company.run": CompanyRunInputSchema,
  "company.pause": CompanyControlInputSchema,
  "company.kill": CompanyControlInputSchema,
  "company.export": z.object({ ventureId: VentureIdSchema }).strict(),
  "company.delete": CompanyDeleteInputSchema,
  "venture.create_or_update_pack": z.object({ packPath: z.string().min(1) }).strict(),
  "venture.get": z.object({ ventureId: VentureIdSchema }).strict(),
  "venture.readiness": z.object({ ventureId: VentureIdSchema }).strict(),
  "venture.request_transition": TransitionRequestSchema,
  "play.propose": z.object({ ventureId: VentureIdSchema }).strict(),
  "task.plan": z.object({ ventureId: VentureIdSchema, playId: EntityIdSchema.optional() }).strict(),
  "task.run_safe": z.object({ ventureId: VentureIdSchema, taskId: EntityIdSchema }).strict(),
  "task.get": z.object({ ventureId: VentureIdSchema, taskId: EntityIdSchema }).strict(),
  "approval.list_pending": z.object({ ventureId: VentureIdSchema.optional() }).strict(),
  "approval.resolve": ApprovalResolveInputSchema,
  "approval.revoke": z.object({ ventureId: VentureIdSchema, approvalId: EntityIdSchema, actor: z.string().min(1) }).strict(),
  "receipt.attach": ReceiptAttachInputSchema,
  "portfolio.scorecard": z.object({}).strict(),
  "goal.get": GoalGetInputSchema,
  "goal.preview_change": GoalChangeInputSchema,
  "goal.confirm_change": GoalConfirmChangeInputSchema,
  "initiative.decide": InitiativeDecisionInputSchema,
  "evaluation.create": EvaluationContractInputSchema,
  "evaluation.get": EvaluationGetInputSchema,
  "evaluation.baseline.capture": EvaluationBaselineCaptureInputSchema,
  "evaluation.tasks.plan": EvaluationTasksPlanInputSchema,
  "experiment.record": ExperimentRecordInputSchema,
  "experiment.get": ExperimentGetInputSchema,
  "skill.version.record": SkillVersionInputSchema,
  "skill.version.list": SkillVersionListInputSchema,
  "play.promotion.record": PlayPromotionInputSchema,
  "play.promotion.list": PlayPromotionListInputSchema
};

export interface CommandResponse<T = unknown> {
  ok: boolean;
  command: CommandName;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface SourceHealth {
  sourceRef: string;
  ventureId: string;
  status: EvidenceStatus;
  observedAt: string;
  contentHash?: string;
  actualRevision?: string;
  message: string;
}

export interface ReadinessGap {
  ventureId: string;
  group: "buyer" | "offer" | "acquisition" | "product" | "payment" | "fulfillment" | "policy" | "economics" | "proof";
  field: string;
  reason: "missing" | "hypothesis" | "stale" | "conflicting" | "unavailable";
  sourceRefs: string[];
  blockingStates: LifecycleState[];
}

export interface DispatchResult {
  adapter: string;
  externalTaskId: string;
  externalRunId?: string;
  ownerRole: string;
  outcome: "success" | "partial" | "failure" | "blocked";
  summary: string;
  citations: string[];
  metadata: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string, seed?: unknown): string {
  const entropy = seed === undefined ? `${Date.now()}:${crypto.randomUUID()}` : canonicalize(seed);
  return `${prefix}_${sha256(entropy).slice(0, 16)}`;
}
