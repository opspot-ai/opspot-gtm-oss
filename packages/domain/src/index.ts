import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  CommandInputSchemas,
  CommandNameSchema,
  EvaluationBaselineCaptureInputSchema,
  EvaluationContractSchema,
  EvaluationExecutionBindingSchema,
  EvaluationInputManifestSchema,
  EvaluationReviewOutputSchema,
  EvaluationScoringOutputSchema,
  ExperimentRecordSchema,
  PlayPromotionSchema,
  ReceiptAttachInputSchema,
  ReceiptSchema,
  SkillVersionSchema,
  TaskDefinitionSchema,
  TransitionRequestSchema,
  canonicalize,
  makeId,
  nowIso,
  sha256,
  type CommandName,
  type CommandResponse,
  type DispatchResult,
  type EvaluationBaselineCaptureInput,
  type EvaluationContract,
  type EvaluationContractInput,
  type EvaluationExecutionBinding,
  type EvaluationInputManifest,
  type EvaluationTasksPlanInput,
  type EvidenceItem,
  executionContext,
  type ExecutionContext,
  localExecutionContext,
  type ExperimentRecord,
  type ExperimentRecordInput,
  type GoalChangeInput,
  type GoalConfirmChangeInput,
  type GoalTaskDisposition,
  type InitiativeDecisionInput,
  type LifecycleState,
  type PlayPromotionInput,
  type PolicyDecision,
  type Receipt,
  type ReceiptAttachInput,
  type SourceReference,
  type SkillVersionInput,
  type TaskDefinition,
  type TransitionRequest
} from "@opspot/contracts";
import { computeReadiness, loadPack, type LoadedPack } from "@opspot/packs";
import { evaluatePolicy, validateApproval } from "@opspot/policy";
import {
  EngineStorage,
  SqliteKernelStorage,
  StorageCursorError,
  StorageIdempotencyConflictError,
  StorageRevisionConflictError
} from "@opspot/storage";
import type { ReceiptWriter, RoleDispatcher, SourceAdapter } from "@opspot/dispatch";
import { FileReceiptAdapter, FixtureDispatcher, HermesKanbanDispatcher, OpenAIResponsesAdapter, ReadOnlySourceAdapter, ResendEmailAdapter } from "@opspot/adapters";
import { buildDecisionTrace, buildGoalPreview, buildGoalRevision, goalDefinitionSemantic } from "./phase9.js";
import {
  CompanyAutonomy,
  CompanyAutonomyError,
  DEFAULT_OPENAI_TARIFF,
  OpenAICeoExecutor,
  UnconfiguredCeoExecutor,
  type CeoExecutor,
  type CompanyDistributionMode
} from "./autonomous.js";
import {
  CompanyInitiativeWorker,
  OpenAIInitiativeExecutor,
  UnconfiguredInitiativeExecutor,
  type InitiativeExecutor
} from "./initiative.js";
import {
  GoldenCompanyWorker,
  PublicAssetGoldenExecutionExecutor,
  ResendGoldenExecutionExecutor,
  type GoldenExecutionExecutor
} from "./golden-provider.js";

export * from "./initiative.js";
export * from "./capabilities.js";
export * from "./company-cloud.js";
export * from "./golden-provider.js";

const lifecycleEdges: Record<LifecycleState, LifecycleState[]> = {
  candidate: ["validating", "parked", "killed"],
  validating: ["offer-ready", "parked", "killed"],
  "offer-ready": ["launch-ready", "parked", "killed"],
  "launch-ready": ["externally-live", "parked", "killed"],
  "externally-live": ["revenue-verified", "parked", "killed"],
  "revenue-verified": ["fulfillment-verified", "parked", "killed"],
  "fulfillment-verified": ["scaling", "parked", "killed"],
  scaling: ["parked", "killed"],
  parked: ["candidate", "validating", "killed"],
  killed: []
};

const MAX_EVALUATION_ARTIFACT_BYTES = 16 * 1024 * 1024;
const ALLOWED_SKILL_ARTIFACT_EXTENSIONS = new Set([
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".txt",
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".pdf"
]);
const SECRET_LIKE_ARTIFACT_SEGMENT = /(^|[._-])(secret|credential|token|password|passwd|private[-_ ]?key|\.env)([._-]|$)/i;

const transitionEvidence: Partial<Record<LifecycleState, string[]>> = {
  validating: ["problem-defined", "buyer-defined", "founder-boundaries-defined", "source-references-present"],
  "offer-ready": ["priced-offer-defined", "buyer-validation", "claim-boundaries-defined"],
  "launch-ready": ["acquisition-path-ready", "payment-path-ready", "fulfillment-plan-ready", "policy-bounds-ready", "kill-route-ready"],
  "externally-live": ["external-surface-live"],
  "revenue-verified": ["authoritative-payment-collected"],
  "fulfillment-verified": ["authoritative-fulfillment-delivered"],
  scaling: ["repeatable-economics-within-bounds"],
  parked: ["founder-lifecycle-decision"],
  killed: ["founder-lifecycle-decision"]
};

export interface EngineServiceDependencies {
  storage: EngineStorage;
  autonomy?: CompanyAutonomy;
  sourceAdapter: SourceAdapter;
  dispatcher: RoleDispatcher;
  receiptWriter: ReceiptWriter;
  venturesRoot: string;
  receiptRoot: string;
  dashboardUrl: string;
  forbiddenTermsByVenture: Record<string, string[]>;
  context: ExecutionContext;
}

export class EngineService {
  readonly storage: EngineStorage;
  readonly autonomy: CompanyAutonomy;
  readonly sourceAdapter: SourceAdapter;
  readonly dispatcher: RoleDispatcher;
  readonly receiptWriter: ReceiptWriter;
  readonly venturesRoot: string;
  readonly receiptRoot: string;
  readonly dashboardUrl: string;
  readonly forbiddenTermsByVenture: Record<string, string[]>;
  readonly context: ExecutionContext;

  constructor(dependencies: EngineServiceDependencies) {
    Object.assign(this, dependencies);
    this.storage = dependencies.storage;
    this.autonomy = dependencies.autonomy ?? new CompanyAutonomy({ storage: new SqliteKernelStorage(dependencies.storage), executor: new UnconfiguredCeoExecutor() });
    this.sourceAdapter = dependencies.sourceAdapter;
    this.dispatcher = dependencies.dispatcher;
    this.receiptWriter = dependencies.receiptWriter;
    this.venturesRoot = dependencies.venturesRoot;
    this.receiptRoot = dependencies.receiptRoot;
    this.dashboardUrl = dependencies.dashboardUrl;
    this.forbiddenTermsByVenture = dependencies.forbiddenTermsByVenture;
    this.context = executionContext(dependencies.context.workspaceId, dependencies.context.surface);
  }

  async execute(commandInput: string, rawInput: unknown, context: ExecutionContext = this.context): Promise<CommandResponse> {
    const trustedContext = executionContext(context.workspaceId, context.surface);
    const commandParsed = CommandNameSchema.safeParse(commandInput);
    if (!commandParsed.success) return { ok: false, command: "portfolio.scorecard", error: { code: "unknown-command", message: `unknown command ${commandInput}` } };
    const command = commandParsed.data;
    const parsed = CommandInputSchemas[command].safeParse(rawInput);
    if (!parsed.success) return { ok: false, command, error: { code: "invalid-input", message: parsed.error.message } };
    try {
      const data = await this.route(command, parsed.data as any, trustedContext);
      return { ok: true, command, data };
    } catch (error) {
      return {
        ok: false,
        command,
        error: {
          code:
            error instanceof EngineCommandError ||
            error instanceof CompanyAutonomyError ||
            error instanceof StorageCursorError ||
            error instanceof StorageIdempotencyConflictError ||
            error instanceof StorageRevisionConflictError
              ? error.code
              : "command-failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async route(command: CommandName, input: any, context: ExecutionContext): Promise<unknown> {
    if (command === "company.bootstrap") return this.autonomy.bootstrap(context.workspaceId, input);
    if (command === "company.list") return this.autonomy.list(context.workspaceId);
    if (command === "venture.create_or_update_pack") return this.createOrUpdatePack(input.packPath, context);
    if (command === "portfolio.scorecard") return this.scorecard(context.workspaceId);
    if (command === "approval.list_pending") return this.storage.listPendingApprovals(context.workspaceId, input.ventureId);
    this.assertWorkspaceReferences(context, input);
    switch (command) {
      case "company.get":
        return this.autonomy.get(context.workspaceId, input.ventureId);
      case "company.run":
        return this.autonomy.run(context.workspaceId, input);
      case "company.pause":
        return this.autonomy.pause(context.workspaceId, input);
      case "company.kill":
        return this.autonomy.kill(context.workspaceId, input);
      case "company.export":
        return this.autonomy.export(context.workspaceId, input.ventureId);
      case "company.delete":
        return this.autonomy.delete(context.workspaceId, input);
      case "venture.get":
        return this.getVenture(input.ventureId);
      case "venture.readiness":
        return this.getReadiness(input.ventureId);
      case "venture.request_transition":
        return this.requestTransition(input);
      case "play.propose":
        return this.proposePlay(input.ventureId);
      case "task.plan":
        return this.planTask(input.ventureId, input.playId);
      case "task.run_safe":
        return this.runSafeTask(input.ventureId, input.taskId);
      case "task.get":
        return this.getTask(input.ventureId, input.taskId);
      case "approval.revoke":
        return this.revokeApproval(input.ventureId, input.approvalId, input.actor);
      case "approval.resolve":
        return this.autonomy.resolveApproval(context.workspaceId, input);
      case "receipt.attach":
        return this.attachReceipt(input);
      case "goal.get":
        return this.getGoal(input.ventureId, input.goalRevisionId);
      case "goal.preview_change":
        return this.previewGoalChange(input);
      case "goal.confirm_change":
        return this.confirmGoalChange(input);
      case "initiative.decide":
        return this.decideInitiative(input);
      case "evaluation.create":
        return this.createEvaluationContract(input);
      case "evaluation.get":
        return this.getEvaluationContract(input.ventureId, input.evaluationContractId);
      case "evaluation.baseline.capture":
        return this.captureEvaluationBaseline(input);
      case "evaluation.tasks.plan":
        return this.planEvaluationTasks(input);
      case "experiment.record":
        return this.recordExperiment(input);
      case "experiment.get":
        return this.getExperiment(input.ventureId, input.experimentRecordId);
      case "skill.version.record":
        return this.recordSkillVersion(input);
      case "skill.version.list":
        return this.storage.listSkillVersions(input.ventureId, {
          ...(input.skillId ? { skillId: input.skillId } : {}),
          ...(input.state ? { state: input.state } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          includePageInfo: true
        });
      case "play.promotion.record":
        return this.recordPlayPromotion(input);
      case "play.promotion.list":
        return this.storage.listPlayPromotions(input.ventureId, {
          ...(input.playId ? { playId: input.playId } : {}),
          ...(input.skillVersionId ? { skillVersionId: input.skillVersionId } : {}),
          ...(input.state ? { state: input.state } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          includePageInfo: true
        });
    }
  }

  private assertWorkspaceAccess(context: ExecutionContext, ventureId: string): void {
    if (!this.storage.isVentureInWorkspace(context.workspaceId, ventureId)) {
      throw new EngineCommandError("workspace-access-denied", `workspace cannot access venture: ${ventureId}`);
    }
  }

  private assertWorkspaceReferences(context: ExecutionContext, input: unknown): void {
    if (!input || typeof input !== "object") return;
    for (const [key, value] of Object.entries(input)) {
      if (key === "ventureId" && typeof value === "string") this.assertWorkspaceAccess(context, value);
      else if ((key === "evaluatedVentureIds" || key === "transferVentureIds") && Array.isArray(value)) {
        for (const ventureId of value) if (typeof ventureId === "string") this.assertWorkspaceAccess(context, ventureId);
      } else this.assertWorkspaceReferences(context, value);
    }
  }

  async createOrUpdatePack(packPath: string, context: ExecutionContext): Promise<Record<string, unknown>> {
    const loaded = await loadPack(packPath, this.venturesRoot);
    const createdAt = nowIso();
    const owningWorkspace = this.storage.workspaceForVenture(loaded.pack.venture.id);
    if (owningWorkspace && owningWorkspace !== context.workspaceId) this.assertWorkspaceAccess(context, loaded.pack.venture.id);
    this.storage.ensureWorkspace(context.workspaceId);
    const revisionId = makeId("packrev", { ventureId: loaded.pack.venture.id, hash: loaded.canonicalHash });
    const revision = this.storage.upsertPack({ ...loaded, workspaceId: context.workspaceId, revisionId, createdAt });
    const sourceHealth = await Promise.all(loaded.pack.sources.map((source) => this.sourceAdapter.inspect(loaded.pack.venture.id, source)));
    this.storage.saveSourceHealth(loaded.pack.venture.id, sourceHealth);
    for (const play of loaded.pack.plays) this.storage.upsertPlay(loaded.pack.venture.id, play);
    for (const metric of loaded.pack.metrics) {
      this.storage.ensureMetricDefinition({
        ventureId: loaded.pack.venture.id,
        id: metric.id,
        name: metric.name,
        unit: metric.unit,
        status: metric.status,
        observedAt: createdAt,
        ...(metric.authoritativeSourceRef ? { sourceRef: metric.authoritativeSourceRef } : {})
      });
    }
    const realSafeReceipts = this.storage
      .listReceipts(loaded.pack.venture.id)
      .filter((receipt) => this.isAuthoritativeCompletedDispatchReceipt(receipt));
    const latestSafeReceipt = realSafeReceipts.at(-1);
    if (latestSafeReceipt) {
      this.storage.setMetric({
        ventureId: loaded.pack.venture.id,
        id: "safe_specialist_outcomes",
        name: "Safe specialist outcomes",
        value: realSafeReceipts.length,
        unit: "count",
        status: "known",
        sourceRef: latestSafeReceipt.id,
        observedAt: latestSafeReceipt.occurredAt
      });
    }
    this.storage.addAuditEvent({
      ventureId: loaded.pack.venture.id,
      id: makeId("audit", { action: "pack-load", hash: loaded.canonicalHash }),
      eventType: revision.created ? "pack-revision-created" : "pack-revision-reused",
      actor: "company-launch-engine",
      entityType: "venture-pack",
      entityId: revision.revisionId,
      payload: { canonicalHash: loaded.canonicalHash, sourcePath: loaded.sourcePath, sourceHealth },
      occurredAt: createdAt
    });
    return {
      ventureId: loaded.pack.venture.id,
      lifecycleState: loaded.pack.venture.declaredState,
      revisionId: revision.revisionId,
      revisionCreated: revision.created,
      canonicalHash: loaded.canonicalHash,
      migratedFrom: loaded.migratedFrom ?? null,
      sourceHealth
    };
  }

  getVenture(ventureId: string): Record<string, unknown> {
    const venture = this.storage.getVenture(ventureId);
    if (!venture?.pack) throw new EngineCommandError("venture-not-found", `venture not found: ${ventureId}`);
    return {
      id: venture.id,
      slug: venture.slug,
      name: venture.name,
      owner: venture.owner,
      owningRepo: venture.owning_repo,
      lifecycleState: venture.lifecycle_state,
      killSwitch: Boolean(venture.kill_switch),
      packHash: venture.current_pack_hash,
      packRevisionId: venture.current_pack_revision_id,
      pack: venture.pack,
      sourceHealth: this.storage.listSourceHealth(ventureId),
      evidence: this.storage.listEvidence(ventureId),
      tasks: this.storage.listTasks(ventureId),
      dispatches: this.storage.listDispatches(ventureId),
      receipts: this.storage.listReceipts(ventureId),
      metrics: this.storage.listMetrics(ventureId),
      founderInterventions: this.storage.founderInterventionCount(ventureId)
    };
  }

  getReadiness(ventureId: string): Record<string, unknown> {
    const venture = this.storage.getVenture(ventureId);
    if (!venture?.pack) throw new EngineCommandError("venture-not-found", `venture not found: ${ventureId}`);
    const sourceHealth = this.storage.listSourceHealth(ventureId);
    const gaps = computeReadiness(venture.pack, sourceHealth);
    return {
      ventureId,
      lifecycleState: venture.lifecycle_state,
      gapCount: gaps.length,
      byGroup: Object.fromEntries(
        [...new Set(gaps.map((gap) => gap.group))].map((group) => [group, gaps.filter((gap) => gap.group === group)])
      ),
      gaps,
      sourceHealth,
      recommendation: recommendPosture(venture.lifecycle_state, gaps)
    };
  }

  proposePlay(ventureId: string): Record<string, unknown> {
    const venture = this.storage.getVenture(ventureId);
    if (!venture?.pack) throw new EngineCommandError("venture-not-found", `venture not found: ${ventureId}`);
    const readiness = this.getReadiness(ventureId) as any;
    const gaps = readiness.gaps as Array<{ group: string }>;
    const preferred = venture.pack.plays.find((play) => gaps.some((gap) => play.purpose.toLowerCase().includes(gap.group))) ?? venture.pack.plays[0];
    if (!preferred) throw new EngineCommandError("no-play", `no play defined for ${ventureId}`);
    this.storage.upsertPlay(ventureId, preferred);
    this.storage.addAuditEvent({
      ventureId,
      id: makeId("audit", {
        action: "play-proposed",
        ventureId,
        playId: preferred.id,
        packHash: venture.current_pack_hash,
        gapsHash: sha256(gaps)
      }),
      eventType: "play-proposed",
      actor: "company-launch-engine",
      entityType: "play",
      entityId: preferred.id,
      payload: {
        gapCount: gaps.length,
        gapsHash: sha256(gaps),
        question: preferred.question,
        selectionMode: "deterministic-eligibility"
      },
      occurredAt: nowIso()
    });
    return {
      ventureId,
      play: preferred,
      gapCount: gaps.length,
      selectionMode: "deterministic-eligibility",
      reason: `first eligible pack play selected deterministically from ${gaps.length} current readiness gaps; value is not evaluated`
    };
  }

  planTask(ventureId: string, requestedPlayId?: string): Record<string, unknown> {
    const venture = this.storage.getVenture(ventureId);
    if (!venture?.pack) throw new EngineCommandError("venture-not-found", `venture not found: ${ventureId}`);
    const play = requestedPlayId
      ? venture.pack.plays.find((candidate) => candidate.id === requestedPlayId)
      : venture.pack.plays[0];
    if (requestedPlayId && !play) throw new EngineCommandError("play-not-found", `play not found: ${ventureId}/${requestedPlayId}`);
    if (!play) throw new EngineCommandError("no-play", `no play defined for ${ventureId}`);
    const publicResearchOnly = play.gateClass === "public-research-free";
    const goalHistory = this.storage.listGoalRevisions(ventureId);
    const currentGoal = goalHistory.at(-1);
    const goalAnchor = [...goalHistory]
      .reverse()
      .find((goal) => goal.changeImpact?.materialGoalChange !== false);
    const goalSemanticHash = currentGoal ? sha256(goalDefinitionSemantic(currentGoal)) : null;
    const idempotencyKey = currentGoal
      ? `plan:goal-${sha256({ ventureId, playId: play.id, goalSemanticHash, goalAnchorId: goalAnchor?.id ?? currentGoal.id })}:v3`
      : `plan:${ventureId}:${play.id}:v2`;
    const priorSemanticTask = this.storage.listTasks(ventureId).find((candidate) => candidate.idempotencyKey === idempotencyKey);
    const bindingGoalRevisionId = priorSemanticTask?.goalTaskBinding?.goalRevisionId ?? currentGoal?.id;
    const task = TaskDefinitionSchema.parse({
      id: makeId("task", idempotencyKey),
      ventureId,
      playId: play.id,
      purpose: play.name,
      expectedOutcome: play.purpose,
      ownerRole: play.ownerRole,
      dependencies: [],
      sourceRefs: play.sourceRefs,
      mode: play.mode,
      expectedProof: play.expectedProof,
      gateClass: play.gateClass,
      actionBounds: {
        question: play.question,
        target: venture.pack.venture.name,
        maxEvidenceRows: 8,
        publicResearchOnly,
        evidenceMode: publicResearchOnly ? "public-research" : "pack-sources-only",
        forbiddenMutations: venture.pack.policy.forbiddenActions,
        rollbackOrKillRoute: venture.pack.policy.killSwitchPath,
        senderOrSystem: play.ownerRole
      },
      budgetCents: 0,
      costCeilingCents: 0,
      approvalRequired: false,
      idempotencyKey,
      maxAttempts: 3,
      backoffMs: 2000,
      timeoutMs: 1_800_000,
      lifecycleEffect: {},
      metricEffects: [{ metric: "safe_specialist_outcomes", increment: 1 }],
      goalTaskBinding: {
        scope: "goal-specific",
        ...(bindingGoalRevisionId ? { goalRevisionId: bindingGoalRevisionId } : {}),
        onMaterialChange: "revise"
      }
    });
    const policy = evaluatePolicy(task);
    const status = policy.decision === "allow" ? "ready" : "blocked";
    const created = this.storage.createTask(task, policy.actionDigest, status);
    let approvalId: string | undefined;
    if (policy.decision === "approval-required" && policy.approvalPacket) {
      approvalId = makeId("approval", { ventureId, taskId: task.id, digest: policy.actionDigest });
      this.storage.createApproval({
        ventureId,
        id: approvalId,
        taskId: task.id,
        actionDigest: policy.actionDigest,
        packet: policy.approvalPacket,
        expiresAt: policy.approvalPacket.expiresAt
      });
      this.storage.recordFounderIntervention({
        ventureId,
        id: makeId("intervention", { ventureId, taskId: task.id, digest: policy.actionDigest }),
        taskId: task.id,
        gateClass: task.gateClass,
        reason: policy.reason
      });
    }
    this.storage.addAuditEvent({
      ventureId,
      id: makeId("audit", { action: "task-planned", taskId: task.id }),
      eventType: "task-planned",
      actor: "company-launch-engine",
      entityType: "task",
      entityId: task.id,
      payload: { policy, created: created.created },
      occurredAt: nowIso()
    });
    return { ventureId, task: created.task, created: created.created, status, policy, approvalId: approvalId ?? null };
  }

  async runSafeTask(ventureId: string, taskId: string): Promise<Record<string, unknown>> {
    const task = this.storage.getTask(ventureId, taskId);
    if (!task) throw new EngineCommandError("task-not-found", `task not found: ${ventureId}/${taskId}`);
    if (this.storage.isKilled(ventureId)) throw new EngineCommandError("kill-switch", `venture kill switch is active: ${ventureId}`);
    const goalBlock = this.goalExecutionBlock(task);
    if (goalBlock) {
      throw new EngineCommandError(
        "task-goal-reconciliation-blocked",
        `task ${task.id} is ${goalBlock.disposition} under confirmed goal ${goalBlock.goalRevisionId}: ${goalBlock.reason}`
      );
    }
    await this.validateEvaluationTaskForDispatch(task);
    const policy = evaluatePolicy(task);
    if (policy.decision !== "allow") throw new EngineCommandError("policy-blocked", policy.reason);
    const jobId = makeId("job", { ventureId, taskId, kind: "role-dispatch" });
    const job = this.storage.enqueueJob({ ventureId, id: jobId, taskId, kind: "role-dispatch", payload: { ventureId, taskId, actionDigest: policy.actionDigest } });
    this.storage.addAuditEvent({
      ventureId,
      id: makeId("audit", { action: "job-enqueued", jobId: job.id }),
      eventType: job.created ? "job-enqueued" : "job-reused",
      actor: "company-launch-engine",
      entityType: "job",
      entityId: job.id,
      payload: { taskId, policy },
      occurredAt: nowIso()
    });
    return { ventureId, taskId, jobId: job.id, created: job.created, status: job.created ? "queued" : task.status, policy };
  }

  goalExecutionBlock(
    task: TaskDefinition
  ): { disposition: Exclude<GoalTaskDisposition, "keep">; goalRevisionId: string; reason: string } | null {
    const latestGoal = this.storage.getLatestGoalRevision(task.ventureId);
    if (!latestGoal?.changeImpact) return null;
    const reconciliation = latestGoal.changeImpact.taskReconciliation.find((item) => item.taskId === task.id);
    if (reconciliation) {
      if (reconciliation.disposition === "keep") return null;
      return {
        disposition: reconciliation.disposition,
        goalRevisionId: latestGoal.id,
        reason: reconciliation.reason
      };
    }
    if (task.goalTaskBinding?.scope === "goal-independent") return null;
    if (
      task.goalTaskBinding?.scope === "goal-specific" &&
      task.goalTaskBinding.goalRevisionId === latestGoal.id
    ) {
      return null;
    }
    return {
      disposition: "revise",
      goalRevisionId: latestGoal.id,
      reason: "The task was not frozen in the latest reconciliation and is not bound to the latest confirmed goal."
    };
  }

  getTask(ventureId: string, taskId: string): Record<string, unknown> {
    const task = this.storage.getTask(ventureId, taskId);
    if (!task) throw new EngineCommandError("task-not-found", `task not found: ${ventureId}/${taskId}`);
    return {
      task,
      jobs: this.storage.listJobs(ventureId).filter((job) => job.task_id === taskId),
      dispatches: this.storage.listDispatches(ventureId).filter((dispatch) => dispatch.task_id === taskId),
      receipts: this.storage.listReceipts(ventureId).filter((receipt) => receipt.taskId === taskId)
    };
  }

  async requestTransition(input: unknown): Promise<Record<string, unknown>> {
    const request = TransitionRequestSchema.parse(input);
    const previous = this.storage.findTransitionByIdempotency(request.ventureId, request.idempotencyKey);
    if (previous) return { idempotentReplay: true, ...previous };
    const venture = this.storage.getVenture(request.ventureId);
    if (!venture) throw new EngineCommandError("venture-not-found", `venture not found: ${request.ventureId}`);
    const transitionId = makeId("transition", { ventureId: request.ventureId, idempotencyKey: request.idempotencyKey });
    const evidence = this.storage.listEvidence(request.ventureId).filter((item) => request.evidenceIds.includes(item.id));
    const evaluation = evaluateTransition(request, venture.lifecycle_state, evidence);
    const policy: PolicyDecision = {
      decision: evaluation.allowed ? "allow" : "deny",
      gateClass: "safe-internal-read-only",
      reason: evaluation.reason,
      actionDigest: sha256(request)
    };
    const occurredAt = nowIso();
    const receiptMachine = {
      receiptVersion: "1.0.0",
      ventureId: request.ventureId,
      transitionId,
      request,
      policy,
      outcome: evaluation.allowed ? "success" : "failure",
      reason: evaluation.reason,
      occurredAt
    };
    const receiptId = makeId("receipt", receiptMachine);
    const written = await this.receiptWriter.write({
      ventureId: request.ventureId,
      receiptId,
      occurredAt,
      machine: receiptMachine,
      markdown: `# Lifecycle transition ${evaluation.allowed ? "succeeded" : "failed"}\n\n${request.expectedState} -> ${request.targetState}\n\n${evaluation.reason}\n`
    });
    const receipt = ReceiptSchema.parse({
      id: receiptId,
      ventureId: request.ventureId,
      ...(request.requestingTaskId ? { taskId: request.requestingTaskId } : {}),
      proofTier: "fixture-verified",
      outcome: evaluation.allowed ? "success" : "failure",
      actor: request.actor,
      adapter: "lifecycle-engine",
      artifactPath: written.jsonPath,
      contentHash: written.contentHash,
      occurredAt,
      metadata: { transitionId, expectedState: request.expectedState, targetState: request.targetState, reason: evaluation.reason },
      origin: "engine-derived"
    });
    this.storage.transaction(() => {
      if (evaluation.allowed && !this.storage.setLifecycleState(request.ventureId, request.expectedState, request.targetState, occurredAt)) {
        throw new Error("lifecycle state changed concurrently");
      }
      this.storage.attachReceipt(receipt);
      this.storage.recordTransition({
        venture_id: request.ventureId,
        id: transitionId,
        expected_state: request.expectedState,
        target_state: request.targetState,
        evidence_ids_json: JSON.stringify(request.evidenceIds),
        requesting_task_id: request.requestingTaskId ?? null,
        requesting_agent: request.requestingAgent,
        policy_json: JSON.stringify(policy),
        approval_id: request.approvalId ?? null,
        idempotency_key: request.idempotencyKey,
        actor: request.actor,
        requested_at: request.requestedAt,
        outcome: evaluation.allowed ? "success" : "failure",
        reason: evaluation.reason,
        receipt_id: receiptId
      });
      this.storage.addAuditEvent({
        ventureId: request.ventureId,
        id: makeId("audit", { action: "transition", transitionId }),
        eventType: evaluation.allowed ? "lifecycle-transition-succeeded" : "lifecycle-transition-failed",
        actor: request.actor,
        entityType: "transition",
        entityId: transitionId,
        payload: { request, policy, receiptId },
        occurredAt
      });
    });
    return { transitionId, outcome: evaluation.allowed ? "success" : "failure", reason: evaluation.reason, receiptId, lifecycleState: evaluation.allowed ? request.targetState : venture.lifecycle_state };
  }

  revokeApproval(ventureId: string, approvalId: string, actor: string): Record<string, unknown> {
    const revokedAt = nowIso();
    const revoked = this.storage.revokeApproval(ventureId, approvalId, revokedAt);
    if (!revoked) throw new EngineCommandError("approval-not-revocable", `approval not found or not revocable: ${ventureId}/${approvalId}`);
    this.storage.addAuditEvent({
      ventureId,
      id: makeId("audit", { action: "approval-revoked", approvalId }),
      eventType: "approval-revoked",
      actor,
      entityType: "approval",
      entityId: approvalId,
      payload: { revokedAt },
      occurredAt: revokedAt
    });
    return { ventureId, approvalId, status: "revoked", revokedAt };
  }

  async attachReceipt(input: ReceiptAttachInput): Promise<Record<string, unknown>> {
    const attached = ReceiptAttachInputSchema.parse(input);
    if (!["scaffolded", "fixture-verified", "blocked"].includes(attached.proofTier)) {
      throw new EngineCommandError(
        "attached-proof-tier-untrusted",
        "manual artifact attachment cannot self-assert internally-live, externally-live, revenue, or fulfillment proof"
      );
    }
    const receiptType = attached.metadata.receiptType;
    if (
      receiptType === "scoring" ||
      receiptType === "reviewer" ||
      attached.metadata.engineStamped === true ||
      typeof attached.metadata.evaluationBindingHash === "string"
    ) {
      throw new EngineCommandError(
        "reserved-evaluation-receipt",
        "scoring, reviewer, and engine-bound evaluation receipts can only be created by the durable worker"
      );
    }
    const receiptRoot = await realpath(this.receiptRoot).catch(() => {
      throw new EngineCommandError("receipt-root-not-found", `project receipt root does not exist: ${this.receiptRoot}`);
    });
    const candidatePath = path.isAbsolute(attached.artifactPath)
      ? attached.artifactPath
      : path.resolve(path.dirname(this.receiptRoot), attached.artifactPath);
    const artifactRealPath = await realpath(candidatePath).catch(() => {
      throw new EngineCommandError("receipt-artifact-not-found", `attached receipt artifact does not exist: ${attached.artifactPath}`);
    });
    const relativeArtifactPath = path.relative(receiptRoot, artifactRealPath);
    if (relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
      throw new EngineCommandError("receipt-artifact-outside-root", "attached receipt artifact must resolve inside the project receipt root");
    }
    const artifactStats = await stat(artifactRealPath);
    if (!artifactStats.isFile() || artifactStats.size > MAX_EVALUATION_ARTIFACT_BYTES) {
      throw new EngineCommandError(
        "receipt-artifact-invalid",
        `attached receipt artifact must be a regular file no larger than ${MAX_EVALUATION_ARTIFACT_BYTES} bytes`
      );
    }
    const artifactHash = createHash("sha256").update(await readFile(artifactRealPath)).digest("hex");
    if (artifactHash !== attached.contentHash) {
      throw new EngineCommandError("receipt-artifact-hash-mismatch", "attached receipt content hash does not match the artifact bytes");
    }
    const receipt = ReceiptSchema.parse({ ...attached, artifactPath: artifactRealPath, origin: "attached-artifact" });
    const result = this.storage.attachReceipt(receipt);
    this.storage.addAuditEvent({
      ventureId: receipt.ventureId,
      id: makeId("audit", { action: "receipt-attached", receiptId: result.id }),
      eventType: result.created ? "receipt-attached" : "receipt-reused",
      actor: receipt.actor,
      entityType: "receipt",
      entityId: result.id,
      payload: { proofTier: receipt.proofTier, contentHash: receipt.contentHash, origin: receipt.origin },
      occurredAt: receipt.occurredAt
    });
    return result;
  }

  async captureEvaluationBaseline(input: EvaluationBaselineCaptureInput): Promise<Record<string, unknown>> {
    const captured = EvaluationBaselineCaptureInputSchema.parse(input);
    this.requireVenture(captured.ventureId);
    const inputHash = sha256(captured);
    const replay = this.storage
      .listReceipts(captured.ventureId)
      .find((receipt) => receipt.metadata.baselineCaptureIdempotencyKey === captured.idempotencyKey);
    if (replay) {
      if (
        replay.metadata.baselineCaptureInputHash !== inputHash ||
        replay.origin !== "engine-derived" ||
        replay.adapter !== "engine-baseline-capture" ||
        replay.metadata.engineStamped !== true
      ) {
        throw new StorageIdempotencyConflictError(
          "evaluation baseline capture",
          captured.ventureId,
          captured.idempotencyKey
        );
      }
      return { created: false, record: replay };
    }

    const receiptRoot = await realpath(this.receiptRoot).catch(() => {
      throw new EngineCommandError("receipt-root-not-found", `project receipt root does not exist: ${this.receiptRoot}`);
    });
    const candidatePath = path.isAbsolute(captured.artifactPath)
      ? captured.artifactPath
      : path.resolve(path.dirname(this.receiptRoot), captured.artifactPath);
    const artifactRealPath = await realpath(candidatePath).catch(() => {
      throw new EngineCommandError("baseline-artifact-not-found", `baseline artifact does not exist: ${captured.artifactPath}`);
    });
    const relativeArtifactPath = path.relative(receiptRoot, artifactRealPath);
    if (relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
      throw new EngineCommandError("baseline-artifact-outside-root", "baseline artifact must resolve inside the project receipts directory");
    }
    const artifactStats = await stat(artifactRealPath);
    if (!artifactStats.isFile() || artifactStats.size > MAX_EVALUATION_ARTIFACT_BYTES) {
      throw new EngineCommandError(
        "baseline-artifact-invalid",
        `baseline artifact must be a regular file no larger than ${MAX_EVALUATION_ARTIFACT_BYTES} bytes`
      );
    }
    const extension = path.extname(artifactRealPath).toLowerCase();
    const artifactBytes = await readFile(artifactRealPath);
    if (!isBoundedRasterArtifact(extension, artifactBytes)) {
      throw new EngineCommandError(
        "baseline-artifact-type-invalid",
        "baseline capture accepts only PNG, JPEG, or WebP bytes with a matching raster extension"
      );
    }
    const actualHash = createHash("sha256").update(artifactBytes).digest("hex");
    if (actualHash !== captured.contentHash) {
      throw new EngineCommandError("baseline-artifact-hash-mismatch", "baseline content hash does not match the raw artifact bytes");
    }

    const occurredAt = nowIso();
    const metadata = {
      receiptType: captured.receiptType,
      artifactHash: actualHash,
      ...(captured.primaryMetricValue === undefined ? {} : { primaryMetricValue: captured.primaryMetricValue }),
      costCents: captured.costCents,
      founderMinutes: captured.founderMinutes,
      complexityUnits: captured.complexityUnits,
      engineStamped: true,
      baselineTrust: "manual-local",
      promotionEligible: false,
      trustModel: "single-operator-local",
      customerSafe: false,
      baselineCaptureIdempotencyKey: captured.idempotencyKey,
      baselineCaptureInputHash: inputHash,
      requestedAt: captured.requestedAt
    };
    const receipt = ReceiptSchema.parse({
      id: makeId("receipt", {
        kind: "evaluation-baseline-capture",
        ventureId: captured.ventureId,
        receiptType: captured.receiptType,
        artifactPath: relativeArtifactPath,
        inputHash
      }),
      ventureId: captured.ventureId,
      proofTier: "scaffolded",
      outcome: "success",
      actor: captured.capturedBy,
      adapter: "engine-baseline-capture",
      artifactPath: artifactRealPath,
      contentHash: actualHash,
      occurredAt,
      metadata,
      origin: "engine-derived"
    });
    const result = this.storage.transaction(() => {
      const stored = this.storage.attachReceipt(receipt);
      if (!stored.created || stored.id !== receipt.id) {
        throw new EngineCommandError(
          "baseline-artifact-content-collision",
          `baseline artifact content is already bound to incompatible receipt ${stored.id}`
        );
      }
      this.storage.addAuditEvent({
        ventureId: receipt.ventureId,
        id: makeId("audit", { action: "evaluation-baseline-captured", receiptId: stored.id }),
        eventType: "evaluation-baseline-captured",
        actor: receipt.actor,
        entityType: "receipt",
        entityId: stored.id,
        payload: {
          receiptType: captured.receiptType,
          contentHash: actualHash,
          baselineTrust: "manual-local",
          promotionEligible: false,
          trustModel: "single-operator-local",
          customerSafe: false
        },
        occurredAt
      });
      return stored;
    });
    return { created: result.created, record: receipt };
  }

  getGoal(ventureId: string, goalRevisionId?: string): Record<string, unknown> {
    this.requireVenture(ventureId);
    const history = this.storage.listGoalRevisions(ventureId);
    const current = history.at(-1) ?? null;
    const selected = goalRevisionId ? this.storage.getGoalRevision(ventureId, goalRevisionId) : current;
    if (goalRevisionId && !selected) {
      throw new EngineCommandError("goal-not-found", `goal revision not found or belongs to another venture: ${ventureId}/${goalRevisionId}`);
    }
    return { ventureId, current, selected: selected ?? null, history };
  }

  previewGoalChange(input: GoalChangeInput): Record<string, unknown> {
    const venture = this.requireVenture(input.ventureId);
    const current = this.storage.getLatestGoalRevision(input.ventureId);
    this.assertExpectedGoal(input.ventureId, input.expectedGoalRevisionId, current?.id);
    return { ...buildGoalPreview(input, current, this.goalPreviewSnapshot(input.ventureId, venture.lifecycle_state)) };
  }

  confirmGoalChange(input: GoalConfirmChangeInput): Record<string, unknown> {
    const venture = this.requireVenture(input.ventureId);
    const existing = this.storage.listGoalRevisions(input.ventureId).find((goal) => goal.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (!immutableInputMatches(existing, input)) {
        throw new StorageIdempotencyConflictError("goal revision", input.ventureId, input.idempotencyKey);
      }
      const prior = existing.supersedesGoalRevisionId
        ? this.storage.getGoalRevision(input.ventureId, existing.supersedesGoalRevisionId)
        : undefined;
      const replayPreview = existing.changeImpact
        ? {
            previewId: existing.founderConfirmation.previewId,
            previewHash: existing.founderConfirmation.previewHash,
            ventureId: existing.ventureId,
            expectedGoalRevisionId: existing.expectedGoalRevisionId ?? null,
            currentGoalRevisionId: prior?.id ?? null,
            destination: existing.destination,
            customDestination: existing.customDestination ?? null,
            target: existing.target,
            horizon: existing.horizon,
            confirmationRequired: true as const,
            impact: existing.changeImpact
          }
        : buildGoalPreview(input, prior, this.goalPreviewSnapshot(input.ventureId, venture.lifecycle_state));
      return {
        created: false,
        goal: existing,
        preview: replayPreview
      };
    }
    const current = this.storage.getLatestGoalRevision(input.ventureId);
    this.assertExpectedGoal(input.ventureId, input.expectedGoalRevisionId, current?.id);
    const preview = buildGoalPreview(input, current, this.goalPreviewSnapshot(input.ventureId, venture.lifecycle_state));
    if (
      input.founderConfirmation.previewId !== preview.previewId ||
      input.founderConfirmation.previewHash !== preview.previewHash
    ) {
      throw new EngineCommandError("goal-preview-mismatch", "founder confirmation does not match the current goal-change preview");
    }
    if (Date.parse(input.founderConfirmation.confirmedAt) < Date.parse(input.requestedAt)) {
      throw new EngineCommandError("goal-confirmation-invalid", "goal confirmation cannot precede the goal-change request");
    }
    if (input.founderConfirmation.receiptId) {
      this.requireReceipts(input.ventureId, [input.founderConfirmation.receiptId], "goal founder confirmation");
    }
    const goal = buildGoalRevision(input, preview, current, this.storage.nextGoalRevision(input.ventureId), nowIso());
    const stored = this.storage.createGoalRevision(goal);
    this.auditImmutableRecord(input.ventureId, stored.created ? "goal-revision-created" : "goal-revision-reused", "goal-revision", goal.id, {
      revision: goal.revision,
      canonicalHash: goal.canonicalHash,
      previewId: preview.previewId,
      confirmationAuthority: goal.founderConfirmation.authority
    });
    return { created: stored.created, goal: stored.record, preview };
  }

  decideInitiative(input: InitiativeDecisionInput): Record<string, unknown> {
    const venture = this.requireVenture(input.ventureId);
    if (venture.current_pack_revision_id !== input.packRevisionId) {
      throw new EngineCommandError(
        "pack-revision-mismatch",
        `initiative decision requires current pack revision ${venture.current_pack_revision_id}, received ${input.packRevisionId}`
      );
    }
    const currentGoal = this.storage.getLatestGoalRevision(input.ventureId);
    if (currentGoal && !input.goalRevisionId) {
      throw new EngineCommandError("goal-revision-required", `current goal revision must be used: ${currentGoal.id}`);
    }
    if (input.goalRevisionId !== currentGoal?.id) {
      throw new EngineCommandError(
        "goal-revision-mismatch",
        `initiative decision goal must be ${currentGoal?.id ?? "absent"}, received ${input.goalRevisionId ?? "absent"}`
      );
    }
    this.requireReceipts(input.ventureId, input.baseline.receiptIds, "initiative baseline");
    if (input.selectionMode === "evaluated") {
      throw new EngineCommandError(
        "evaluated-selection-unavailable",
        "evaluated initiative selection requires immutable per-candidate scored outputs; the current command carries candidates but no evaluator-produced scores"
      );
    }
    const knownEvidenceIds = new Set(this.storage.listEvidence(input.ventureId).map((evidence) => evidence.id));
    const trace = buildDecisionTrace(input, { knownEvidenceIds, evaluatorContractExists: true, createdAt: nowIso() });
    const stored = this.storage.createDecisionTrace(trace);
    this.auditImmutableRecord(input.ventureId, stored.created ? "initiative-decision-created" : "initiative-decision-reused", "decision-trace", trace.id, {
      canonicalHash: trace.canonicalHash,
      selectedCandidateId: trace.selectedCandidateId ?? null,
      abstain: trace.abstain,
      uncertainty: trace.uncertainty,
      selectionMode: trace.selectionMode
    });
    return { created: stored.created, trace: stored.record };
  }

  createEvaluationContract(input: EvaluationContractInput): Record<string, unknown> {
    const venture = this.requireVenture(input.ventureId);
    const replay = this.storage
      .listEvaluationContracts(input.ventureId)
      .find((evaluation) => evaluation.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (!immutableInputMatches(replay, input)) {
        throw new StorageIdempotencyConflictError("evaluation contract", input.ventureId, input.idempotencyKey);
      }
      return { created: false, record: replay };
    }
    if (venture.current_pack_revision_id !== input.packRevisionId) {
      throw new EngineCommandError("pack-revision-mismatch", "evaluation contract must freeze the current venture-pack revision");
    }
    const goal = this.storage.getLatestGoalRevision(input.ventureId);
    if (!goal || goal.id !== input.goalRevisionId) {
      throw new EngineCommandError("goal-revision-mismatch", "evaluation contract must freeze the current confirmed goal revision");
    }
    const createdAt = nowIso();
    if (Date.parse(input.observationWindow.endsAt) <= Date.parse(createdAt)) {
      throw new EngineCommandError(
        "evaluation-window-expired",
        "evaluation observation window must remain open after the contract is frozen"
      );
    }
    if (sha256(input.promotionRule) !== input.promotionRuleHash) {
      throw new EngineCommandError("promotion-rule-hash-mismatch", "promotion rule hash does not match the frozen promotion rule");
    }
    if (!input.candidateVersion) {
      throw new EngineCommandError("candidate-version-required", "evaluation contracts must freeze the exact candidate version");
    }
    if (input.skillVersionId) {
      const skill = this.storage.getSkillVersion(input.ventureId, input.skillVersionId);
      if (!skill) {
        throw new EngineCommandError("skill-version-not-found", `skill version not found or belongs to another venture: ${input.skillVersionId}`);
      }
      if (skill.version !== input.candidateVersion) {
        throw new EngineCommandError(
          "candidate-version-mismatch",
          `evaluation candidate version ${input.candidateVersion} does not match skill version ${skill.version}`
        );
      }
      if (skill.producerId !== input.producerId) {
        throw new EngineCommandError(
          "evaluation-producer-mismatch",
          "evaluation producer must equal the producer of the exact stored skill candidate"
        );
      }
    }
    if (input.baseline.primaryMetricValue === undefined || !input.baseline.artifactHash) {
      throw new EngineCommandError(
        "evaluation-baseline-incomplete",
        "evaluation baseline must freeze both the primary metric value and artifact hash"
      );
    }
    this.requireReceipts(
      input.ventureId,
      [...input.baseline.receiptIds, ...input.baseline.plainAgentReceiptIds, ...input.baseline.noHistoryReceiptIds],
      "evaluation baseline"
    );
    for (const receiptId of input.baseline.receiptIds) {
      const receipt = this.requireReceiptRecord(input.ventureId, receiptId, "evaluation baseline");
      this.assertFreezableBaselineReceipt(receipt, "baseline", createdAt);
      this.assertReceiptType(receipt, "baseline", "evaluation baseline");
      this.assertReceiptMetadata(receipt, "artifactHash", input.baseline.artifactHash, "evaluation baseline");
      this.assertReceiptMetadata(receipt, "primaryMetricValue", input.baseline.primaryMetricValue, "evaluation baseline");
      for (const key of ["costCents", "founderMinutes", "complexityUnits"] as const) {
        const value = receipt.metadata[key];
        if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          throw new EngineCommandError(
            "receipt-metadata-invalid",
            `evaluation baseline receipt ${receipt.id} ${key} must be a nonnegative number, null, or absent`
          );
        }
      }
      if (Date.parse(receipt.occurredAt) > Date.parse(createdAt)) {
        throw new EngineCommandError("baseline-after-evaluation", `baseline receipt was recorded after the evaluation freeze: ${receipt.id}`);
      }
    }
    for (const receiptId of input.baseline.plainAgentReceiptIds) {
      const receipt = this.requireReceiptRecord(input.ventureId, receiptId, "plain-agent baseline");
      this.assertFreezableBaselineReceipt(receipt, "plain-agent-baseline", createdAt);
      this.assertReceiptType(receipt, "plain-agent-baseline", "plain-agent baseline");
    }
    for (const receiptId of input.baseline.noHistoryReceiptIds) {
      const receipt = this.requireReceiptRecord(input.ventureId, receiptId, "no-history baseline");
      this.assertFreezableBaselineReceipt(receipt, "no-history-baseline", createdAt);
      this.assertReceiptType(receipt, "no-history-baseline", "no-history baseline");
    }
    const sourceIds = new Set((venture.pack.sources as Array<{ id: string }>).map((source) => source.id));
    for (const sourceRef of [input.primaryMetric.authoritativeSourceRef, input.evaluationPopulation.authoritativeSourceRef]) {
      if (sourceRef && !sourceIds.has(sourceRef)) {
        throw new EngineCommandError("source-ref-not-found", `evaluation source is not present in the current venture pack: ${sourceRef}`);
      }
    }
    if (input.evaluationPopulation.kind !== "authoritative-system") {
      const evidenceById = new Map(this.storage.listEvidence(input.ventureId).map((item) => [item.id, item]));
      const knownCaseRefs = new Set([...sourceIds, ...evidenceById.keys()]);
      const unknownCase = input.evaluationPopulation.caseRefs.find((caseRef) => !knownCaseRefs.has(caseRef));
      if (unknownCase) {
        throw new EngineCommandError("evaluation-case-not-found", `evaluation case lacks venture-scoped provenance: ${unknownCase}`);
      }
      const invalidEvidenceCase = input.evaluationPopulation.caseRefs
        .map((caseRef) => evidenceById.get(caseRef))
        .find(
          (item) =>
            item &&
            (item.status !== "current" || (item.expiresAt !== undefined && Date.parse(item.expiresAt) <= Date.parse(createdAt)))
        );
      if (invalidEvidenceCase) {
        throw new EngineCommandError(
          "evaluation-case-evidence-not-current",
          `evaluation evidence case must be current, unexpired, and unsuperseded: ${invalidEvidenceCase.id}`
        );
      }
      const expectedPopulationHash = this.frozenPopulationHash(input.ventureId, input.evaluationPopulation.caseRefs);
      if (input.evaluationPopulation.populationHash !== expectedPopulationHash) {
        throw new EngineCommandError(
          "evaluation-population-hash-mismatch",
          "evaluation population hash does not match the frozen venture-scoped case content"
        );
      }
    } else {
      const sourceRef = input.evaluationPopulation.authoritativeSourceRef!;
      const sourceHealth = this.storage.listSourceHealth(input.ventureId).find((item) => item.sourceRef === sourceRef);
      if (sourceHealth?.status !== "current" || !sourceHealth.contentHash) {
        throw new EngineCommandError(
          "evaluation-authoritative-source-not-current",
          `authoritative evaluation source must have a current content-hashed snapshot: ${sourceRef}`
        );
      }
      const expectedPopulationHash = this.frozenPopulationHash(input.ventureId, [sourceRef]);
      if (input.evaluationPopulation.populationHash !== expectedPopulationHash) {
        throw new EngineCommandError(
          "evaluation-population-hash-mismatch",
          "evaluation population hash does not match the frozen authoritative source snapshot"
        );
      }
    }
    const latest = this.storage.listEvaluationContracts(input.ventureId).at(-1);
    const revision = this.storage.nextEvaluationRevision(input.ventureId);
    const semanticInput: Record<string, unknown> = { ...input };
    delete semanticInput.idempotencyKey;
    delete semanticInput.requestedAt;
    const canonicalHash = sha256({ revision, semanticInput, supersedesEvaluationContractId: latest?.id ?? null });
    const record = EvaluationContractSchema.parse({
      id: makeId("evaluation", { ventureId: input.ventureId, canonicalHash }),
      revision,
      ...input,
      ...(latest ? { supersedesEvaluationContractId: latest.id } : {}),
      createdAt,
      frozenAt: createdAt,
      canonicalHash
    });
    const stored = this.storage.createEvaluationContract(record);
    this.auditImmutableRecord(input.ventureId, "evaluation-contract-created", "evaluation-contract", record.id, {
      revision: record.revision,
      canonicalHash: record.canonicalHash,
      promotionRuleHash: record.promotionRuleHash,
      primaryMetricId: record.primaryMetric.id
    });
    return { created: stored.created, record: stored.record };
  }

  getEvaluationContract(ventureId: string, evaluationContractId: string): Record<string, unknown> {
    this.requireVenture(ventureId);
    const record = this.storage.getEvaluationContract(ventureId, evaluationContractId);
    if (!record) {
      throw new EngineCommandError(
        "evaluation-not-found",
        `evaluation contract not found or belongs to another venture: ${ventureId}/${evaluationContractId}`
      );
    }
    return { record };
  }

  async planEvaluationTasks(input: EvaluationTasksPlanInput): Promise<Record<string, unknown>> {
    const venture = this.requireVenture(input.ventureId);
    const evaluation = this.storage.getEvaluationContract(input.ventureId, input.evaluationContractId);
    if (!evaluation) {
      throw new EngineCommandError(
        "evaluation-not-found",
        `evaluation contract not found or belongs to another venture: ${input.evaluationContractId}`
      );
    }
    if (evaluation.canonicalHash !== input.evaluationContractHash) {
      throw new EngineCommandError("evaluation-hash-mismatch", "evaluation task plan does not match the frozen contract hash");
    }
    if (!evaluation.bounds.allowedGateClasses.includes("safe-internal-read-only")) {
      throw new EngineCommandError(
        "evaluation-gate-class-unavailable",
        "evaluation task planning requires safe-internal-read-only in the frozen allowed gate classes"
      );
    }
    const execution = await this.activeEvaluationExecution(evaluation);
    const { binding, manifest } = execution;
    const bindingHash = sha256(binding);
    if (!this.dispatcher.supportsRole(binding.evaluatorId)) {
      throw new EngineCommandError("evaluator-role-unavailable", `no configured dispatcher can run evaluator role ${binding.evaluatorId}`);
    }
    if (!this.dispatcher.supportsRole(binding.reviewerId)) {
      throw new EngineCommandError("reviewer-role-unavailable", `no configured dispatcher can run reviewer role ${binding.reviewerId}`);
    }
    const sourceRefs = this.evaluationManifestSourceRefs(manifest);
    const plannerVersion = "v1";
    const scoringIdempotencyKey = `evaluation:${evaluation.id}:${bindingHash}:scoring:${plannerVersion}`;
    const scoringTask = TaskDefinitionSchema.parse({
      id: makeId("task", scoringIdempotencyKey),
      ventureId: input.ventureId,
      taskKind: "evaluation-scoring",
      purpose: `Score ${evaluation.name}`,
      expectedOutcome: "A structured scoring result against the exact frozen baseline, candidate, metric, population, and hard gates",
      ownerRole: binding.evaluatorId,
      dependencies: [],
      sourceRefs,
      mode: "internal-read-only",
      expectedProof: "A dispatch-origin scoring receipt whose evaluator bindings are stamped by the engine",
      gateClass: "safe-internal-read-only",
      actionBounds: {
        question: evaluation.hypothesis,
        target: venture.name,
        evidenceMode: "frozen-evaluation-inputs",
        forbiddenMutations: venture.pack.policy.forbiddenActions,
        rollbackOrKillRoute: evaluation.bounds.killSwitchPath,
        senderOrSystem: binding.evaluatorId,
        formulaExecutionMode: "specialist-applied-free-text-formula",
        evaluationInputManifest: manifest
      },
      budgetCents: 0,
      costCeilingCents: 0,
      approvalRequired: false,
      idempotencyKey: scoringIdempotencyKey,
      maxAttempts: 1,
      backoffMs: 0,
      timeoutMs: evaluation.bounds.timeoutMs,
      lifecycleEffect: {},
      metricEffects: [],
      goalTaskBinding: {
        scope: "goal-specific",
        goalRevisionId: binding.goalRevisionId,
        onMaterialChange: "cancel"
      },
      evaluationBinding: binding,
      evaluationBindingHash: bindingHash
    });
    const reviewIdempotencyKey = `evaluation:${evaluation.id}:${bindingHash}:review:${plannerVersion}`;
    const reviewTask = TaskDefinitionSchema.parse({
      id: makeId("task", reviewIdempotencyKey),
      ventureId: input.ventureId,
      taskKind: "evaluation-review",
      purpose: `Independently review ${evaluation.name}`,
      expectedOutcome: "An independent verdict that reproduces or disputes the frozen scoring result without rewriting the candidate or evaluator",
      ownerRole: binding.reviewerId,
      dependencies: [scoringTask.id],
      sourceRefs,
      mode: "internal-read-only",
      expectedProof: "A dispatch-origin reviewer receipt bound to the exact scoring receipt and frozen evaluation",
      gateClass: "safe-internal-read-only",
      actionBounds: {
        question: `Independently review the result for: ${evaluation.hypothesis}`,
        target: venture.name,
        evidenceMode: "frozen-evaluation-inputs-and-scoring-receipt",
        forbiddenMutations: venture.pack.policy.forbiddenActions,
        rollbackOrKillRoute: evaluation.bounds.killSwitchPath,
        senderOrSystem: binding.reviewerId,
        formulaExecutionMode: "independent-reproduction-of-free-text-formula",
        evaluationInputManifest: manifest
      },
      budgetCents: 0,
      costCeilingCents: 0,
      approvalRequired: false,
      idempotencyKey: reviewIdempotencyKey,
      maxAttempts: 1,
      backoffMs: 0,
      timeoutMs: evaluation.bounds.timeoutMs,
      lifecycleEffect: {},
      metricEffects: [],
      goalTaskBinding: {
        scope: "goal-specific",
        goalRevisionId: binding.goalRevisionId,
        onMaterialChange: "cancel"
      },
      evaluationBinding: binding,
      evaluationBindingHash: bindingHash
    });
    const scoringPolicy = evaluatePolicy(scoringTask);
    const reviewPolicy = evaluatePolicy(reviewTask);
    if (scoringPolicy.decision !== "allow" || reviewPolicy.decision !== "allow") {
      throw new EngineCommandError(
        "evaluation-task-policy-blocked",
        `frozen evaluation task graph is not safe to plan: scoring=${scoringPolicy.reason}; review=${reviewPolicy.reason}`
      );
    }
    const stored = this.storage.createTaskGraph([
      { task: scoringTask, actionDigest: scoringPolicy.actionDigest, status: "ready" },
      { task: reviewTask, actionDigest: reviewPolicy.actionDigest, status: "ready" }
    ]);
    this.auditImmutableRecord(input.ventureId, stored.created ? "evaluation-task-graph-created" : "evaluation-task-graph-reused", "evaluation-contract", evaluation.id, {
      evaluationContractHash: evaluation.canonicalHash,
      evaluationBindingHash: bindingHash,
      scoringTaskId: scoringTask.id,
      reviewTaskId: reviewTask.id,
      formulaExecutionMode: "receipt-bound-free-text"
    });
    return {
      created: stored.created,
      ventureId: input.ventureId,
      evaluationContractId: evaluation.id,
      evaluationBindingHash: bindingHash,
      scoringTask,
      reviewTask,
      formulaExecutionMode: "receipt-bound-free-text"
    };
  }

  async validateEvaluationTaskForDispatch(
    task: TaskDefinition,
    dependencyReceipts: readonly Receipt[] = [],
    requireDependencyReceipt = false
  ): Promise<void> {
    if (task.taskKind === "venture-play") return;
    if (!task.evaluationBinding || !task.evaluationBindingHash) {
      throw new EngineCommandError("dispatch-evaluation-binding-missing", "evaluation task lacks its typed engine binding");
    }
    const evaluation = this.storage.getEvaluationContract(task.ventureId, task.evaluationBinding.evaluationContractId);
    if (!evaluation) throw new EngineCommandError("evaluation-not-found", "evaluation task references a missing or foreign contract");
    const frozenManifestResult = EvaluationInputManifestSchema.safeParse(task.actionBounds.evaluationInputManifest);
    if (!frozenManifestResult.success) {
      throw new EngineCommandError("evaluation-input-manifest-invalid", "evaluation task lacks its complete engine-owned frozen input manifest");
    }
    const frozenManifest = frozenManifestResult.data;
    if (sha256(frozenManifest) !== task.evaluationBinding.inputManifestHash) {
      throw new EngineCommandError("evaluation-input-manifest-hash-mismatch", "evaluation task input manifest no longer matches its binding");
    }
    if (
      frozenManifest.networkAccessPolicy !== "forbidden" ||
      frozenManifest.networkIsolation !== "not-mechanically-verified" ||
      frozenManifest.promotionEligibility !== "blocked-pending-network-isolation-proof" ||
      frozenManifest.evidenceMode !== "frozen-local-artifacts"
    ) {
      throw new EngineCommandError(
        "evaluation-network-mode-forbidden",
        "safe internal evaluation must forbid network access and preserve the unverified mechanical-isolation promotion gate"
      );
    }
    const active = await this.activeEvaluationExecution(evaluation);
    if (sha256(active.binding) !== task.evaluationBindingHash || !semanticEquals(active.binding, task.evaluationBinding)) {
      throw new EngineCommandError("evaluation-binding-drift", "evaluation task binding no longer matches active immutable records");
    }
    if (!semanticEquals(active.manifest, frozenManifest)) {
      throw new EngineCommandError("evaluation-input-manifest-drift", "evaluation task input manifest no longer matches active frozen artifacts and records");
    }
    const expectedSourceRefs = this.evaluationManifestSourceRefs(frozenManifest);
    if (!sameIds(expectedSourceRefs, task.sourceRefs)) {
      throw new EngineCommandError("evaluation-source-scope-drift", "evaluation task source scope differs from its exact frozen population inputs");
    }
    if (!this.dispatcher.supportsRole(task.ownerRole)) {
      throw new EngineCommandError("evaluation-role-unavailable", `no configured dispatcher can run ${task.ownerRole}`);
    }
    const now = Date.now();
    if (now < Date.parse(evaluation.observationWindow.startsAt)) {
      throw new EngineCommandError("evaluation-window-not-open", "evaluation task cannot run before its frozen observation window");
    }
    if (now > Date.parse(evaluation.observationWindow.endsAt)) {
      throw new EngineCommandError("evaluation-window-expired", "evaluation task cannot run after its frozen observation window");
    }
    if (task.taskKind === "evaluation-review") {
      const scoringTaskId = task.dependencies[0];
      const scoringTask = scoringTaskId ? this.storage.getTask(task.ventureId, scoringTaskId) : undefined;
      if (
        !scoringTask ||
        scoringTask.taskKind !== "evaluation-scoring" ||
        scoringTask.evaluationBindingHash !== task.evaluationBindingHash
      ) {
        throw new EngineCommandError("review-dependency-mismatch", "review task does not depend on its exact frozen scoring task");
      }
      if (requireDependencyReceipt) {
        const scoringReceipts = dependencyReceipts.filter(
          (receipt) =>
            receipt.taskId === scoringTask.id &&
            receipt.origin === "dispatch" &&
            receipt.outcome === "success" &&
            receipt.metadata.receiptType === "scoring" &&
            receipt.metadata.evaluationBindingHash === task.evaluationBindingHash
        );
        if (scoringReceipts.length !== 1) {
          throw new EngineCommandError("review-scoring-receipt-missing", "review requires exactly one successful engine-bound scoring receipt");
        }
      }
    }
  }

  async validateEvaluationArtifactBytes(task: TaskDefinition): Promise<void> {
    if (task.taskKind === "venture-play") return;
    const manifest = EvaluationInputManifestSchema.parse(task.actionBounds.evaluationInputManifest);
    const artifacts = [
      manifest.candidate.artifact,
      ...manifest.baseline.receipts.map((receipt) => receipt.artifact),
      ...manifest.population.cases.map((item) => item.artifact)
    ];
    for (const artifact of artifacts) {
      const artifactStats = await stat(artifact.absolutePath).catch(() => undefined);
      if (!artifactStats?.isFile() || artifactStats.size > MAX_EVALUATION_ARTIFACT_BYTES) {
        throw new EngineCommandError(
          "evaluation-artifact-post-dispatch-drift",
          `frozen evaluation artifact is absent, non-regular, or oversized after dispatch: ${artifact.absolutePath}`
        );
      }
      const actualHash = createHash("sha256").update(await readFile(artifact.absolutePath)).digest("hex");
      if (actualHash !== artifact.contentHash) {
        throw new EngineCommandError(
          "evaluation-artifact-post-dispatch-drift",
          `frozen evaluation artifact changed during dispatch: ${artifact.absolutePath}`
        );
      }
    }
  }

  isAuthoritativeCompletedDispatchReceipt(receipt: Receipt): boolean {
    if (
      receipt.origin !== "dispatch" ||
      receipt.proofTier !== "internally-live" ||
      receipt.outcome !== "success" ||
      receipt.adapter === "fixture" ||
      !receipt.taskId ||
      !receipt.dispatchId
    ) {
      return false;
    }
    const task = this.storage.getTask(receipt.ventureId, receipt.taskId);
    const dispatch = this.storage.listDispatches(receipt.ventureId).find((item) => item.id === receipt.dispatchId);
    return Boolean(
      task &&
        dispatch &&
        task.status === "succeeded" &&
        dispatch.status === "completed" &&
        dispatch.task_id === task.id &&
        dispatch.adapter === receipt.adapter &&
        dispatch.owner_role === receipt.actor &&
        task.ownerRole === receipt.actor
    );
  }

  private async activeEvaluationExecution(
    evaluation: EvaluationContract
  ): Promise<{ binding: EvaluationExecutionBinding; manifest: EvaluationInputManifest }> {
    const venture = this.requireVenture(evaluation.ventureId);
    const latest = this.storage.listEvaluationContracts(evaluation.ventureId).at(-1);
    if (latest?.id !== evaluation.id) {
      throw new EngineCommandError("evaluation-superseded", "only the latest unsuperseded evaluation contract may plan or dispatch work");
    }
    if (venture.current_pack_revision_id !== evaluation.packRevisionId) {
      throw new EngineCommandError("evaluation-pack-drift", "the venture pack changed after the evaluator froze");
    }
    if (this.storage.getLatestGoalRevision(evaluation.ventureId)?.id !== evaluation.goalRevisionId) {
      throw new EngineCommandError("evaluation-goal-drift", "the confirmed venture goal changed after the evaluator froze");
    }
    if (Date.now() > Date.parse(evaluation.observationWindow.endsAt)) {
      throw new EngineCommandError("evaluation-window-expired", "the frozen evaluation observation window has ended");
    }
    if (!evaluation.skillVersionId || !evaluation.candidateVersion) {
      throw new EngineCommandError("evaluation-skill-binding-required", "specialist evaluation tasks require an exact frozen skill candidate");
    }
    const skill = this.storage.getSkillVersion(evaluation.ventureId, evaluation.skillVersionId);
    if (!skill || skill.version !== evaluation.candidateVersion) {
      throw new EngineCommandError("evaluation-skill-binding-mismatch", "evaluation skill candidate is absent or no longer matches its version");
    }
    if (skill.producerId !== evaluation.producerId) {
      throw new EngineCommandError(
        "evaluation-producer-mismatch",
        "the active evaluator producer no longer matches the stored skill producer"
      );
    }
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(skill.artifactPath).toLowerCase())) {
      throw new EngineCommandError(
        "candidate-isolation-channel-unavailable",
        "generic text or executable candidates must run in a separate isolated stage; direct evaluator context is limited to screenshot/image candidates"
      );
    }
    if (evaluation.evaluationPopulation.kind === "hidden-held-out") {
      throw new EngineCommandError(
        "hidden-held-out-channel-unavailable",
        "hidden held-out evaluation requires an opaque authenticated evaluator channel; embedding its manifest would leak the held-out set"
      );
    }
    if (evaluation.evaluationPopulation.kind === "authoritative-system") {
      throw new EngineCommandError(
        "authoritative-evaluation-channel-unavailable",
        "authoritative-system evaluation requires a trusted authoritative count/result receipt channel before it can be planned"
      );
    }
    const projectRoot = await realpath(path.dirname(this.venturesRoot));
    const artifactCandidate = path.resolve(projectRoot, skill.artifactPath);
    const artifactRealPath = await realpath(artifactCandidate).catch(() => {
      throw new EngineCommandError("candidate-artifact-not-found", `frozen candidate artifact is absent: ${skill.artifactPath}`);
    });
    if (artifactRealPath !== projectRoot && !artifactRealPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new EngineCommandError("candidate-artifact-outside-root", "frozen candidate artifact must remain inside the engine project root");
    }
    const candidateArtifact = await this.resolveEvaluationArtifact(
      projectRoot,
      artifactRealPath,
      skill.artifactHash,
      "candidate artifact",
      "candidate-artifact"
    );
    if (!evaluation.evaluationPopulation.populationHash) {
      throw new EngineCommandError("evaluation-population-uncommitted", "evaluation task requires a frozen population hash");
    }
    const currentPopulationHash = this.frozenPopulationHash(
      evaluation.ventureId,
      evaluation.evaluationPopulation.caseRefs
    );
    if (currentPopulationHash !== evaluation.evaluationPopulation.populationHash) {
      throw new EngineCommandError("evaluation-population-drift", "frozen evaluation input content changed before dispatch");
    }
    const receiptById = new Map(this.storage.listReceipts(evaluation.ventureId).map((receipt) => [receipt.id, receipt]));
    const baselineBindings: Array<{ id: string; binding: "baseline" | "plain-agent-baseline" | "no-history-baseline" }> = [
      ...evaluation.baseline.receiptIds.map((id) => ({ id, binding: "baseline" as const })),
      ...evaluation.baseline.plainAgentReceiptIds.map((id) => ({ id, binding: "plain-agent-baseline" as const })),
      ...evaluation.baseline.noHistoryReceiptIds.map((id) => ({ id, binding: "no-history-baseline" as const }))
    ];
    const baselineReceipts = [] as EvaluationInputManifest["baseline"]["receipts"];
    for (const item of baselineBindings) {
      const receipt = receiptById.get(item.id);
      if (!receipt) throw new EngineCommandError("evaluation-baseline-receipt-missing", `frozen baseline receipt is absent: ${item.id}`);
      this.assertFreezableBaselineReceipt(receipt, item.binding, evaluation.frozenAt);
      const artifact = await this.resolveEvaluationArtifact(
        projectRoot,
        receipt.artifactPath,
        receipt.contentHash,
        `baseline receipt ${receipt.id}`,
        "evaluation-baseline-artifact"
      );
      const receiptType = typeof receipt.metadata.receiptType === "string" ? receipt.metadata.receiptType : "";
      if (receiptType !== item.binding) {
        throw new EngineCommandError(
          "evaluation-baseline-binding-drift",
          `baseline receipt ${receipt.id} no longer has expected type ${item.binding}`
        );
      }
      baselineReceipts.push({
        id: receipt.id,
        binding: item.binding,
        receiptType,
        artifact,
        contentHash: receipt.contentHash,
        occurredAt: receipt.occurredAt,
        outcome: receipt.outcome,
        origin: receipt.origin,
        baselineTrust: String(receipt.metadata.baselineTrust),
        promotionEligible: receipt.metadata.promotionEligible === true,
        trustModel: "single-operator-local",
        customerSafe: false,
        ...(typeof receipt.metadata.primaryMetricValue === "number"
          ? { primaryMetricValue: receipt.metadata.primaryMetricValue }
          : {}),
        costCents: this.optionalReceiptNumber(receipt, "costCents"),
        founderMinutes: this.optionalReceiptNumber(receipt, "founderMinutes"),
        complexityUnits: this.optionalReceiptNumber(receipt, "complexityUnits")
      });
    }
    const populationRefs = evaluation.evaluationPopulation.caseRefs;
    const populationCases = await Promise.all(
      [...populationRefs].sort().map((caseRef) => this.resolveEvaluationCase(evaluation.ventureId, projectRoot, caseRef, receiptById))
    );
    const manifest = EvaluationInputManifestSchema.parse({
      schemaVersion: "evaluation-input-manifest-v1",
      ventureId: evaluation.ventureId,
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      hypothesis: evaluation.hypothesis,
      evidenceMode: "frozen-local-artifacts",
      networkAccessPolicy: "forbidden",
      networkIsolation: "not-mechanically-verified",
      promotionEligibility: "blocked-pending-network-isolation-proof",
      formulaExecutionMode: "specialist-applied-free-text-formula",
      candidate: {
        skillVersionId: skill.id,
        skillVersionHash: skill.canonicalHash,
        version: skill.version,
        producerId: skill.producerId,
        artifact: candidateArtifact
      },
      baseline: {
        description: evaluation.baseline.description,
        artifactHash: evaluation.baseline.artifactHash,
        primaryMetricValue: evaluation.baseline.primaryMetricValue,
        receipts: baselineReceipts
      },
      primaryMetric: evaluation.primaryMetric,
      population: { definition: evaluation.evaluationPopulation, cases: populationCases },
      hardGates: evaluation.hardGates,
      mutableSurface: evaluation.mutableSurface,
      bounds: evaluation.bounds,
      expectedReceiptTypes: evaluation.expectedReceiptTypes,
      knownConfounders: evaluation.knownConfounders,
      promotionRule: evaluation.promotionRule,
      promotionRuleHash: evaluation.promotionRuleHash,
      allowedArtifactPaths: [
        candidateArtifact.absolutePath,
        ...baselineReceipts.map((receipt) => receipt.artifact.absolutePath),
        ...populationCases.map((item) => item.artifact.absolutePath)
      ].filter((item, index, values) => values.indexOf(item) === index).sort(),
      frozenAt: evaluation.frozenAt
    });
    const binding = EvaluationExecutionBindingSchema.parse({
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      packRevisionId: evaluation.packRevisionId,
      goalRevisionId: evaluation.goalRevisionId,
      skillVersionId: skill.id,
      skillVersionHash: skill.canonicalHash,
      candidateVersion: skill.version,
      candidateArtifactHash: skill.artifactHash,
      primaryMetricId: evaluation.primaryMetric.id,
      primaryMetricHash: sha256(evaluation.primaryMetric),
      formulaHash: sha256(evaluation.primaryMetric.formula),
      populationHash: evaluation.evaluationPopulation.populationHash,
      inputManifestHash: sha256(manifest),
      hardGatesHash: sha256(evaluation.hardGates),
      promotionRuleHash: evaluation.promotionRuleHash,
      producerId: evaluation.producerId,
      evaluatorId: evaluation.evaluatorId,
      reviewerId: evaluation.reviewerId,
      frozenAt: evaluation.frozenAt
    });
    return { binding, manifest };
  }

  private evaluationManifestSourceRefs(manifest: EvaluationInputManifest): string[] {
    const venture = this.requireVenture(manifest.ventureId);
    const packSources = venture.pack.sources as SourceReference[];
    const packSourceIds = new Set(packSources.map((source) => source.id));
    const refs = new Set<string>();
    for (const item of manifest.population.cases) {
      if (item.kind === "source" && item.source) refs.add(item.source.id);
      if (item.kind === "evidence" && item.evidence && packSourceIds.has(item.evidence.sourceRef)) refs.add(item.evidence.sourceRef);
    }
    for (const sourceRef of [
      manifest.primaryMetric.authoritativeSourceRef,
      manifest.population.definition.authoritativeSourceRef
    ]) {
      if (sourceRef && packSourceIds.has(sourceRef)) refs.add(sourceRef);
    }
    return [...refs].sort();
  }

  private async resolveEvaluationArtifact(
    projectRoot: string,
    candidatePath: string,
    expectedHash: string,
    label: string,
    errorPrefix: string
  ): Promise<EvaluationInputManifest["candidate"]["artifact"]> {
    const resolvedCandidate = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(projectRoot, candidatePath);
    const absolutePath = await realpath(resolvedCandidate).catch(() => {
      throw new EngineCommandError(`${errorPrefix}-not-found`, `${label} is absent: ${candidatePath}`);
    });
    if (absolutePath === projectRoot || !absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new EngineCommandError(`${errorPrefix}-outside-root`, `${label} must remain inside the engine project root`);
    }
    const artifactStats = await stat(absolutePath);
    if (!artifactStats.isFile() || artifactStats.size > MAX_EVALUATION_ARTIFACT_BYTES) {
      throw new EngineCommandError(
        `${errorPrefix}-invalid`,
        `${label} must be a regular file no larger than ${MAX_EVALUATION_ARTIFACT_BYTES} bytes`
      );
    }
    const actualHash = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
    if (actualHash !== expectedHash) {
      throw new EngineCommandError(`${errorPrefix}-drift`, `${label} bytes no longer match ${expectedHash}`);
    }
    return {
      relativePath: path.relative(projectRoot, absolutePath),
      absolutePath,
      contentHash: actualHash
    };
  }

  private async resolveEvaluationCase(
    ventureId: string,
    projectRoot: string,
    caseRef: string,
    receiptById: ReadonlyMap<string, Receipt>
  ): Promise<EvaluationInputManifest["population"]["cases"][number]> {
    const venture = this.requireVenture(ventureId);
    const evidence = this.storage.listEvidence(ventureId).find((item) => item.id === caseRef);
    const packSources = venture.pack.sources as SourceReference[];
    const source = packSources.find((item) => item.id === caseRef);
    if (!evidence && !source) {
      throw new EngineCommandError("evaluation-case-not-found", `evaluation case lacks venture-scoped provenance: ${caseRef}`);
    }
    if (source) {
      if (!source.path) {
        throw new EngineCommandError(
          "evaluation-case-local-artifact-required",
          `safe internal evaluation cannot browse URL-only case ${caseRef}; freeze a local content-hashed artifact first`
        );
      }
      const health = this.storage.listSourceHealth(ventureId).find((item) => item.sourceRef === caseRef);
      const expectedHash = health?.contentHash ?? source.expectedSha256;
      if (!expectedHash || health?.status !== "current") {
        throw new EngineCommandError(
          "evaluation-case-snapshot-not-current",
          `evaluation source case ${caseRef} requires a current content-hashed local snapshot`
        );
      }
      const artifact = await this.resolveEvaluationArtifact(
        projectRoot,
        source.path,
        expectedHash,
        `evaluation source case ${caseRef}`,
        "evaluation-case-artifact"
      );
      return {
        caseRef,
        kind: "source",
        frozenContentHash: expectedHash,
        sourceRevision: health?.actualRevision ?? source.revision ?? null,
        source,
        artifact
      };
    }

    const evidenceRecord = evidence!;
    if (
      evidenceRecord.status !== "current" ||
      (evidenceRecord.expiresAt !== undefined && Date.parse(evidenceRecord.expiresAt) <= Date.now())
    ) {
      throw new EngineCommandError(
        "evaluation-case-evidence-not-current",
        `evaluation evidence case must remain current, unexpired, and unsuperseded: ${caseRef}`
      );
    }
    let artifactPath: string | undefined;
    let artifactHash: string | undefined;
    const receipt = receiptById.get(evidenceRecord.sourceRef);
    if (receipt) {
      artifactPath = receipt.artifactPath;
      artifactHash = receipt.contentHash;
    } else {
      const evidenceSource = packSources.find((item) => item.id === evidenceRecord.sourceRef);
      if (evidenceSource?.path) {
        const health = this.storage.listSourceHealth(ventureId).find((item) => item.sourceRef === evidenceSource.id);
        if (health?.status === "current" && health.contentHash) {
          artifactPath = evidenceSource.path;
          artifactHash = health.contentHash;
        }
      } else if (
        typeof evidenceRecord.metadata.artifactPath === "string" &&
        typeof evidenceRecord.metadata.artifactHash === "string"
      ) {
        artifactPath = evidenceRecord.metadata.artifactPath;
        artifactHash = evidenceRecord.metadata.artifactHash;
      }
    }
    if (!artifactPath || !artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash)) {
      throw new EngineCommandError(
        "evaluation-case-local-artifact-required",
        `evidence case ${caseRef} does not resolve to a frozen local content-hashed artifact`
      );
    }
    const artifact = await this.resolveEvaluationArtifact(
      projectRoot,
      artifactPath,
      artifactHash,
      `evaluation evidence case ${caseRef}`,
      "evaluation-case-artifact"
    );
    return {
      caseRef,
      kind: "evidence",
      frozenContentHash: evidenceRecord.contentHash,
      sourceRevision: null,
      evidence: evidenceRecord,
      artifact
    };
  }

  async recordExperiment(input: ExperimentRecordInput): Promise<Record<string, unknown>> {
    this.requireVenture(input.ventureId);
    const replay = this.storage
      .listExperimentRecords(input.ventureId)
      .find((experiment) => experiment.idempotencyKey === input.idempotencyKey);
    if (replay) {
      const replayCallerView = {
        ...replay,
        receiptIds: replay.receiptIds.filter((receiptId) => receiptId !== replay.terminalReceiptId)
      };
      if (!immutableInputMatches(replayCallerView, input)) {
        throw new StorageIdempotencyConflictError("experiment record", input.ventureId, input.idempotencyKey);
      }
      return { created: false, record: replay, terminalReceiptId: replay.terminalReceiptId };
    }
    const evaluation = this.storage.getEvaluationContract(input.ventureId, input.evaluationContractId);
    if (!evaluation) {
      throw new EngineCommandError("evaluation-not-found", `evaluation contract not found or belongs to another venture: ${input.evaluationContractId}`);
    }
    if (evaluation.canonicalHash !== input.evaluationContractHash) {
      throw new EngineCommandError("evaluation-hash-mismatch", "experiment is not bound to the frozen evaluation hash");
    }
    if (evaluation.goalRevisionId !== input.goalRevisionId || evaluation.producerId !== input.producerId) {
      throw new EngineCommandError("experiment-context-mismatch", "experiment goal or producer does not match the frozen evaluation contract");
    }
    const requiresScoreAndReview = input.disposition === "keep" || input.disposition === "discard";
    const metricResult = input.primaryMetricResult;
    const reviewer = input.reviewer;
    if (requiresScoreAndReview && (!metricResult || !reviewer)) {
      throw new EngineCommandError("experiment-output-incomplete", `${input.disposition} requires a primary score and independent review`);
    }
    if (reviewer && evaluation.reviewerId !== reviewer.reviewerId) {
      throw new EngineCommandError("reviewer-mismatch", "experiment reviewer does not match the frozen evaluation contract");
    }
    if (evaluation.candidateVersion !== input.candidateVersion) {
      throw new EngineCommandError("candidate-version-mismatch", "experiment candidate version does not match the frozen evaluator");
    }
    if (evaluation.skillVersionId !== input.skillVersionId) {
      throw new EngineCommandError("skill-version-mismatch", "experiment skill version does not match the frozen evaluator");
    }
    if (input.skillVersionId) {
      const skill = this.storage.getSkillVersion(input.ventureId, input.skillVersionId);
      if (!skill) {
        throw new EngineCommandError("skill-version-not-found", `skill version not found or belongs to another venture: ${input.skillVersionId}`);
      }
      if (skill.version !== input.candidateVersion || skill.artifactHash !== input.candidateArtifactHash) {
        throw new EngineCommandError(
          "candidate-artifact-mismatch",
          "experiment candidate version and artifact hash must match the exact frozen skill version"
        );
      }
    }
    if (input.initiativeCandidateId) {
      const selected = this.storage
        .listDecisionTraces(input.ventureId)
        .some(
          (trace) =>
            trace.goalRevisionId === input.goalRevisionId &&
            trace.evaluationContractId === input.evaluationContractId &&
            trace.selectedCandidateId === input.initiativeCandidateId
        );
      if (!selected) {
        throw new EngineCommandError("initiative-not-selected", "experiment candidate is not selected by a matching immutable decision trace");
      }
    }
    this.requireReceipts(
      input.ventureId,
      [
        input.baselineReceiptId,
        ...input.receiptIds,
        ...(input.outcomeReceiptId ? [input.outcomeReceiptId] : []),
        ...(reviewer ? [reviewer.receiptId] : []),
        ...(metricResult ? [metricResult.scoringReceiptId] : []),
        ...input.attempts.flatMap((attempt) => attempt.receiptIds)
      ],
      "experiment"
    );
    if (!evaluation.baseline.receiptIds.includes(input.baselineReceiptId)) {
      throw new EngineCommandError("baseline-mismatch", "experiment baseline receipt is not a frozen primary baseline receipt");
    }
    if (evaluation.baseline.primaryMetricValue === undefined) {
      throw new EngineCommandError("evaluation-baseline-incomplete", "frozen evaluator has no primary metric baseline value");
    }
    if (metricResult && metricResult.baselineValue !== evaluation.baseline.primaryMetricValue) {
      throw new EngineCommandError("baseline-value-mismatch", "experiment baseline value does not match the frozen evaluator baseline");
    }
    const baselineReceipt = this.requireReceiptRecord(input.ventureId, input.baselineReceiptId, "experiment baseline");
    this.assertReceiptType(baselineReceipt, "baseline", "experiment baseline");
    this.assertReceiptMetadata(baselineReceipt, "primaryMetricValue", evaluation.baseline.primaryMetricValue, "experiment baseline");
    if (input.disposition === "keep") {
      this.assertPromotableBaselineReceipt(baselineReceipt, "baseline", evaluation.frozenAt);
    }
    const expectedMissingBaseline = (["costCents", "founderMinutes", "complexityUnits"] as const)
      .filter((key) => this.optionalReceiptNumber(baselineReceipt, key) === null)
      .map((key) => `baseline.${key}`);
    const reportedMissingBaseline = input.missingOutputs.filter((output) => output.startsWith("baseline.")).sort();
    if (!sameIds(expectedMissingBaseline, reportedMissingBaseline)) {
      throw new EngineCommandError(
        "baseline-missing-output-mismatch",
        `experiment must report exact unknown baseline fields: ${expectedMissingBaseline.sort().join(",") || "none"}`
      );
    }
    if (input.disposition === "keep" && expectedMissingBaseline.length > 0) {
      throw new EngineCommandError(
        "experiment-output-incomplete",
        "a promotable keep requires exact numeric baseline cost, founder-time, and complexity values"
      );
    }

    const recordReceipts = input.receiptIds.map((receiptId) => this.requireReceiptRecord(input.ventureId, receiptId, "experiment"));
    let scoringReceipt: Receipt | undefined;
    if (metricResult) {
      scoringReceipt = this.requireReceiptRecord(input.ventureId, metricResult.scoringReceiptId, "scoring");
      this.assertReceiptType(scoringReceipt, "scoring", "scoring");
      this.assertCandidateReceiptBinding(scoringReceipt, evaluation, input, "scoring");
      this.assertTrustedPhase9Receipt(scoringReceipt, evaluation, input, "scoring");
      if (scoringReceipt.actor !== evaluation.evaluatorId) {
        throw new EngineCommandError("scoring-authority-mismatch", "scoring receipt actor does not match the frozen evaluator");
      }
    }
    let reviewerReceipt: Receipt | undefined;
    if (reviewer) {
      reviewerReceipt = this.requireReceiptRecord(input.ventureId, reviewer.receiptId, "reviewer");
      this.assertReceiptType(reviewerReceipt, "reviewer", "reviewer");
      this.assertCandidateReceiptBinding(reviewerReceipt, evaluation, input, "reviewer");
      this.assertTrustedPhase9Receipt(reviewerReceipt, evaluation, input, "reviewer");
      this.assertReceiptMetadata(reviewerReceipt, "reviewerId", reviewer.reviewerId, "reviewer");
      this.assertReceiptMetadata(reviewerReceipt, "verdict", input.disposition, "reviewer");
      if (reviewerReceipt.actor !== evaluation.reviewerId) {
        throw new EngineCommandError("reviewer-authority-mismatch", "review receipt actor does not match the frozen reviewer");
      }
    }
    if (scoringReceipt?.origin === "dispatch" && reviewerReceipt?.origin === "dispatch") {
      const scoringTask = scoringReceipt.taskId
        ? this.storage.getTask(input.ventureId, scoringReceipt.taskId)
        : undefined;
      const reviewTask = reviewerReceipt.taskId
        ? this.storage.getTask(input.ventureId, reviewerReceipt.taskId)
        : undefined;
      if (
        !scoringTask ||
        !reviewTask ||
        reviewTask.taskKind !== "evaluation-review" ||
        reviewTask.dependencies.length !== 1 ||
        reviewTask.dependencies[0] !== scoringTask.id ||
        reviewerReceipt.metadata.reviewedScoringReceiptId !== scoringReceipt.id ||
        reviewerReceipt.metadata.reviewedScoringContentHash !== scoringReceipt.contentHash
      ) {
        throw new EngineCommandError("review-dependency-mismatch", "review receipt is not bound to the exact scoring task and receipt");
      }
      const scoringOutput = EvaluationScoringOutputSchema.parse(scoringReceipt.metadata.evaluationResult);
      const reviewOutput = EvaluationReviewOutputSchema.parse(reviewerReceipt.metadata.evaluationResult);
      if (
        reviewOutput.hardGatesPassed !== scoringOutput.hardGateResults.every((item) => item.passed) ||
        reviewOutput.leakageDetected !== scoringOutput.leakageDetected
      ) {
        throw new EngineCommandError(
          "review-proof-mismatch",
          "review hard-gate or leakage declarations do not match the exact scoring receipt"
        );
      }
    }
    const missingOutputs = new Set(input.missingOutputs);
    const missingReceiptType = evaluation.expectedReceiptTypes.find(
      (receiptType) =>
        !recordReceipts.some((receipt) => receipt.metadata.receiptType === receiptType) &&
        !receiptTypeCanBeMissing(receiptType, missingOutputs)
    );
    if (missingReceiptType) {
      throw new EngineCommandError("expected-receipt-missing", `experiment is missing frozen receipt type: ${missingReceiptType}`);
    }
    const usedAttemptReceiptIds = new Set<string>();
    const usedAttemptDispatchIds = new Set<string>();
    const usedAttemptTaskIds = new Set<string>();
    for (const attempt of input.attempts) {
      const attemptReceipts = attempt.receiptIds.map((receiptId) =>
        this.requireReceiptRecord(input.ventureId, receiptId, `attempt ${attempt.attempt}`)
      );
      for (const receiptId of attempt.receiptIds) {
        if (usedAttemptReceiptIds.has(receiptId)) {
          throw new EngineCommandError("attempt-receipt-reused", `attempt receipt cannot be reused across attempts: ${receiptId}`);
        }
        usedAttemptReceiptIds.add(receiptId);
        const receipt = attemptReceipts.find((candidate) => candidate.id === receiptId)!;
        this.assertCandidateReceiptBinding(receipt, evaluation, input, `attempt ${attempt.attempt}`, input.disposition === "keep");
      }
      const dispatchReceipts = attemptReceipts.filter((receipt) => receipt.origin === "dispatch");
      if (dispatchReceipts.length > 0) {
        if (dispatchReceipts.length !== 1 || attemptReceipts.length !== 1) {
          throw new EngineCommandError(
            "attempt-dispatch-envelope-invalid",
            `attempt ${attempt.attempt} must bind exactly one authoritative dispatch execution receipt`
          );
        }
        const executionReceipt = dispatchReceipts[0]!;
        if (!executionReceipt.dispatchId || !executionReceipt.taskId || executionReceipt.outcome !== "success") {
          throw new EngineCommandError(
            "attempt-dispatch-envelope-invalid",
            `attempt ${attempt.attempt} dispatch receipt lacks a successful task/dispatch envelope`
          );
        }
        if (usedAttemptDispatchIds.has(executionReceipt.dispatchId) || usedAttemptTaskIds.has(executionReceipt.taskId)) {
          throw new EngineCommandError(
            "attempt-dispatch-envelope-reused",
            `attempt ${attempt.attempt} reuses a task or dispatch execution envelope`
          );
        }
        usedAttemptDispatchIds.add(executionReceipt.dispatchId);
        usedAttemptTaskIds.add(executionReceipt.taskId);
        this.assertReceiptMetadata(executionReceipt, "dispatchStartedAt", attempt.startedAt, `attempt ${attempt.attempt}`);
        this.assertReceiptMetadata(executionReceipt, "dispatchCompletedAt", attempt.completedAt, `attempt ${attempt.attempt}`);
        this.assertReceiptMetadata(executionReceipt, "elapsedMs", attempt.elapsedMs, `attempt ${attempt.attempt}`);
        this.assertReceiptMetadata(executionReceipt, "providerCostCents", attempt.providerCostCents, `attempt ${attempt.attempt}`);
        this.assertReceiptMetadata(executionReceipt, "modelCostCents", attempt.modelCostCents, `attempt ${attempt.attempt}`);
        this.assertReceiptMetadata(executionReceipt, "founderMinutes", attempt.founderMinutes, `attempt ${attempt.attempt}`);
        this.assertReceiptMetadata(executionReceipt, "reviewerMinutes", attempt.reviewerMinutes, `attempt ${attempt.attempt}`);
        if (executionReceipt.occurredAt !== attempt.completedAt) {
          throw new EngineCommandError(
            "attempt-dispatch-envelope-invalid",
            `attempt ${attempt.attempt} completion must equal its authoritative receipt occurrence time`
          );
        }
      }
    }
    const hasAuthoritativeDispatchEnvelope =
      usedAttemptDispatchIds.size > 0 || scoringReceipt?.origin === "dispatch" || reviewerReceipt?.origin === "dispatch";
    if (
      input.disposition === "keep" &&
      input.outcomeReceiptId &&
      (scoringReceipt?.origin === "dispatch" || reviewerReceipt?.origin === "dispatch")
    ) {
      const outcomeReceipt = this.requireReceiptRecord(input.ventureId, input.outcomeReceiptId, "kept outcome");
      const containingAttempts = input.attempts.filter((attempt) => attempt.receiptIds.includes(outcomeReceipt.id));
      if (
        containingAttempts.length !== 1 ||
        containingAttempts[0]?.outcome !== "succeeded" ||
        outcomeReceipt.origin !== "dispatch" ||
        !outcomeReceipt.taskId ||
        !outcomeReceipt.dispatchId ||
        !evaluation.expectedReceiptTypes.includes(String(outcomeReceipt.metadata.receiptType ?? ""))
      ) {
        throw new EngineCommandError(
          "kept-outcome-receipt-invalid",
          "kept outcome must be the unique successful candidate attempt's authoritative typed task/dispatch receipt"
        );
      }
    }
    if (input.disposition === "keep") {
      for (const receipt of recordReceipts) this.assertTrustedPhase9Receipt(receipt, evaluation, input, "kept experiment");
    }

    const receiptsById = new Map(this.storage.listReceipts(input.ventureId).map((receipt) => [receipt.id, receipt]));
    const evidenceById = new Map(this.storage.listEvidence(input.ventureId).map((evidence) => [evidence.id, evidence]));
    const expectedGateIds = evaluation.hardGates.map((gate) => gate.id);
    const actualGateIds = input.hardGateResults.map((gate) => gate.hardGateId);
    if (new Set(actualGateIds).size !== actualGateIds.length || actualGateIds.some((gateId) => !expectedGateIds.includes(gateId))) {
      throw new EngineCommandError("hard-gate-mismatch", "experiment hard-gate results contain duplicate or unfrozen gates");
    }
    if (input.disposition === "keep" && !sameIds(expectedGateIds, actualGateIds)) {
      throw new EngineCommandError("hard-gate-mismatch", "experiment hard-gate results do not exactly match the frozen evaluator");
    }
    const failedGateDispositions = new Set<"discard" | "gated" | "unsafe">();
    for (const result of input.hardGateResults) {
      const frozenGate = evaluation.hardGates.find((gate) => gate.id === result.hardGateId)!;
      if (!result.passed) failedGateDispositions.add(frozenGate.failureDisposition);
      for (const proofId of result.evidenceIds) {
        const proof = receiptsById.get(proofId) ?? evidenceById.get(proofId);
        if (!proof) {
          throw new EngineCommandError("hard-gate-proof-not-found", `hard-gate proof is absent or belongs to another venture: ${proofId}`);
        }
        if (result.passed && "outcome" in proof && proof.outcome !== "success") {
          throw new EngineCommandError("hard-gate-proof-invalid", `hard-gate receipt did not succeed: ${proofId}`);
        }
        if ("status" in proof && (proof.status !== "current" || (proof.expiresAt && Date.parse(proof.expiresAt) <= Date.now()))) {
          throw new EngineCommandError("hard-gate-proof-invalid", `hard-gate evidence is not current: ${proofId}`);
        }
        this.assertProofBinding(proof, evaluation, input, result.hardGateId, frozenGate.evidenceRequirement);
        if (!("outcome" in proof) && proof.type === "evaluation-hard-gate-proof") {
          this.assertEngineHardGateEvidence(proof, result, receiptsById);
        }
        if (input.disposition === "keep") {
          if ("origin" in proof) {
            this.assertTrustedPhase9Receipt(proof, evaluation, input, `hard gate ${result.hardGateId}`);
          } else {
            if (proof.authority === "fixture" || proof.proofTier === "fixture-verified") {
              throw new EngineCommandError("receipt-origin-untrusted", `hard gate ${result.hardGateId} uses fixture evidence`);
            }
            const sourceReceipt = receiptsById.get(proof.sourceRef);
            if (sourceReceipt) this.assertTrustedPhase9Receipt(sourceReceipt, evaluation, input, `hard gate ${result.hardGateId}`);
          }
        }
      }
    }
    if (failedGateDispositions.size > 1) {
      throw new EngineCommandError("hard-gate-disposition-conflict", "failed frozen hard gates require conflicting terminal dispositions");
    }
    const failedGateDisposition = [...failedGateDispositions][0];
    if (failedGateDisposition && input.disposition !== failedGateDisposition) {
      throw new EngineCommandError(
        "hard-gate-disposition-mismatch",
        `failed hard gate requires ${failedGateDisposition}, not ${input.disposition}`
      );
    }
    if (metricResult && scoringReceipt) {
      if (metricResult.metricId !== evaluation.primaryMetric.id) {
        throw new EngineCommandError("metric-mismatch", "experiment primary metric does not match the frozen evaluator");
      }
      this.assertReceiptMetadata(scoringReceipt, "metricId", evaluation.primaryMetric.id, "scoring");
      this.assertReceiptMetadata(scoringReceipt, "formulaHash", sha256(evaluation.primaryMetric.formula), "scoring");
      this.assertReceiptMetadata(scoringReceipt, "baselineValue", metricResult.baselineValue, "scoring");
      this.assertReceiptMetadata(scoringReceipt, "candidateValue", metricResult.candidateValue, "scoring");
      this.assertReceiptMetadata(scoringReceipt, "sampleSize", metricResult.sampleSize, "scoring");
      if (!evaluation.evaluationPopulation.populationHash) {
        throw new EngineCommandError("evaluation-population-uncommitted", "experiment cannot be scored without a frozen population hash");
      }
      this.assertReceiptMetadata(scoringReceipt, "populationHash", evaluation.evaluationPopulation.populationHash, "scoring");
      if (
        evaluation.evaluationPopulation.kind !== "authoritative-system" &&
        metricResult.sampleSize !== evaluation.evaluationPopulation.caseRefs.length
      ) {
        throw new EngineCommandError("sample-population-mismatch", "experiment sample size does not equal the frozen case population");
      }
      const target = evaluation.primaryMetric.targetValue ?? metricResult.baselineValue;
      const measuredImprovement =
        evaluation.primaryMetric.direction === "higher-is-better"
          ? metricResult.candidateValue - metricResult.baselineValue
          : evaluation.primaryMetric.direction === "lower-is-better"
            ? metricResult.baselineValue - metricResult.candidateValue
            : Math.abs(metricResult.baselineValue - target) - Math.abs(metricResult.candidateValue - target);
      if (Math.abs(measuredImprovement - metricResult.improvement) > 1e-9) {
        throw new EngineCommandError("metric-calculation-mismatch", "recorded primary-metric improvement does not match the frozen direction/formula inputs");
      }
      const requiredSampleSize = Math.max(
        evaluation.primaryMetric.minimumSampleSize,
        evaluation.evaluationPopulation.minimumSampleSize,
        evaluation.promotionRule.minimumSampleSize
      );
      const thresholdPassed =
        metricResult.sampleSize >= requiredSampleSize &&
        metricResult.improvement >=
          Math.max(evaluation.primaryMetric.minimumImprovement, evaluation.promotionRule.minimumPrimaryMetricImprovement);
      if (metricResult.thresholdPassed !== thresholdPassed) {
        throw new EngineCommandError("metric-threshold-mismatch", "recorded threshold verdict does not match the frozen metric and sample-size rules");
      }
    }
    if (input.attempts.length > evaluation.bounds.maxAttempts) {
      throw new EngineCommandError("experiment-bounds-exceeded", "experiment exceeded the frozen attempt bound");
    }
    const recordNowMs = Date.now();
    for (const attempt of input.attempts) {
      if (
        hasAuthoritativeDispatchEnvelope &&
        (Date.parse(attempt.startedAt) > recordNowMs || Date.parse(attempt.completedAt) > recordNowMs)
      ) {
        throw new EngineCommandError("experiment-timestamp-future", `attempt ${attempt.attempt} cannot use future timestamps`);
      }
      if (Date.parse(attempt.startedAt) < Date.parse(evaluation.frozenAt)) {
        throw new EngineCommandError(
          "experiment-predates-evaluator",
          `attempt ${attempt.attempt} started before the evaluation contract was frozen`
        );
      }
      const actualElapsedMs = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt);
      if (attempt.elapsedMs !== null && attempt.elapsedMs !== actualElapsedMs) {
        throw new EngineCommandError(
          "attempt-elapsed-mismatch",
          `attempt ${attempt.attempt} elapsedMs does not match its start and completion timestamps`
        );
      }
      if (
        Date.parse(attempt.startedAt) < Date.parse(evaluation.observationWindow.startsAt) ||
        Date.parse(attempt.completedAt) > Date.parse(evaluation.observationWindow.endsAt)
      ) {
        throw new EngineCommandError("attempt-window-mismatch", `attempt ${attempt.attempt} falls outside the frozen observation window`);
      }
    }
    const latestAttemptCompletion = input.attempts.reduce<number | null>(
      (latest, attempt) => Math.max(latest ?? Number.NEGATIVE_INFINITY, Date.parse(attempt.completedAt)),
      null
    );
    if (Date.parse(input.recordedAt) < Date.parse(evaluation.frozenAt)) {
      throw new EngineCommandError("experiment-timestamp-order", "experiment record cannot predate the frozen evaluator");
    }
    if (
      hasAuthoritativeDispatchEnvelope &&
      (Date.parse(input.recordedAt) > recordNowMs || (reviewer && Date.parse(reviewer.reviewedAt) > recordNowMs))
    ) {
      throw new EngineCommandError("experiment-timestamp-future", "experiment record and review cannot use future timestamps");
    }
    if (latestAttemptCompletion !== null && Date.parse(input.recordedAt) < latestAttemptCompletion) {
      throw new EngineCommandError("experiment-timestamp-order", "experiment record timestamp must follow all attempts");
    }
    if (
      reviewer &&
      ((latestAttemptCompletion !== null && Date.parse(reviewer.reviewedAt) < latestAttemptCompletion) ||
        Date.parse(input.recordedAt) < Date.parse(reviewer.reviewedAt))
    ) {
      throw new EngineCommandError("experiment-timestamp-order", "review and record timestamps must follow all experiment attempts");
    }
    if (input.attempts.some((attempt) => attempt.candidateHash !== input.candidateArtifactHash)) {
      throw new EngineCommandError("candidate-hash-mismatch", "every attempt must execute the recorded candidate artifact hash");
    }
    for (const key of ["providerCostCents", "modelCostCents", "founderMinutes", "reviewerMinutes", "elapsedMs"] as const) {
      const aggregate = input.costs[key];
      if (aggregate === null) continue;
      const attemptValues = input.attempts.map((attempt) => attempt[key]);
      if (attemptValues.some((value) => value === null)) {
        throw new EngineCommandError("experiment-cost-unknown", `experiment ${key} cannot be known while an attempt value is unknown`);
      }
      const summed = sum(attemptValues.filter((value): value is number => value !== null));
      if (summed !== aggregate) {
        throw new EngineCommandError("experiment-cost-mismatch", `experiment ${key} does not equal the attempt ledger`);
      }
    }
    if (scoringReceipt) {
      this.assertReceiptMetadata(scoringReceipt, "otherCostCents", input.costs.otherCostCents, "scoring");
      const baselineComplexityUnits = this.optionalReceiptNumber(baselineReceipt, "complexityUnits");
      const candidateComplexityUnits = this.requireReceiptNumber(scoringReceipt, "candidateComplexityUnits", "scoring");
      if (baselineComplexityUnits === null) {
        if (input.complexityDeltaPercent !== null) {
          throw new EngineCommandError(
            "complexity-calculation-unavailable",
            "complexity delta must remain unknown when the frozen baseline complexity is unknown"
          );
        }
      } else if (
        input.complexityDeltaPercent === null ||
        Math.abs(percentageIncrease(baselineComplexityUnits, candidateComplexityUnits) - input.complexityDeltaPercent) > 1e-9
      ) {
        throw new EngineCommandError("complexity-calculation-mismatch", "complexity delta does not match frozen baseline and scored candidate complexity");
      }
    }
    if (input.disposition === "keep" && scoringReceipt?.metadata.leakageDetected !== false) {
      throw new EngineCommandError("evaluation-leakage-unproven", "kept experiment requires an explicit no-leakage scoring receipt");
    }
    const totalCost = knownTotalCost(input.costs);
    const exceeded =
      (totalCost !== null && totalCost > evaluation.bounds.maxCostCents) ||
      (input.costs.founderMinutes !== null && input.costs.founderMinutes > evaluation.bounds.maxFounderMinutes) ||
      (input.costs.reviewerMinutes !== null && input.costs.reviewerMinutes > evaluation.bounds.maxReviewerMinutes) ||
      (input.costs.elapsedMs !== null && input.costs.elapsedMs > evaluation.bounds.maxElapsedMs);
    if (exceeded && input.disposition === "keep") {
      throw new EngineCommandError("experiment-bounds-exceeded", "an experiment that exceeded frozen bounds cannot be kept");
    }
    if (input.disposition === "keep") {
      if (!scoringReceipt) throw new EngineCommandError("experiment-output-incomplete", "kept experiment lacks a scoring receipt");
      const tolerances = this.deriveExperimentTolerances(evaluation, input, baselineReceipt, scoringReceipt);
      if (!tolerances.costWithinTolerance || !tolerances.founderTimeWithinTolerance || !tolerances.complexityWithinTolerance) {
        throw new EngineCommandError(
          "experiment-tolerance-exceeded",
          "kept experiment exceeds a frozen cost, founder-time, or complexity tolerance"
        );
      }
    }
    const forbiddenSideEffect = input.attempts
      .flatMap((attempt) => attempt.sideEffects)
      .find((effect) => evaluation.bounds.forbiddenActions.some((forbidden) => effect.toLowerCase().includes(forbidden.toLowerCase())));
    if (forbiddenSideEffect && input.disposition !== "unsafe") {
      throw new EngineCommandError("unsafe-experiment", `forbidden side effect requires unsafe disposition: ${forbiddenSideEffect}`);
    }
    if (input.disposition === "keep" && !evaluation.promotionRule.allowedDispositions.includes("keep")) {
      throw new EngineCommandError("disposition-not-allowed", "the frozen evaluator does not permit keep");
    }
    const terminalReceiptId = makeId("receipt", {
      kind: "experiment-terminal",
      ventureId: input.ventureId,
      evaluationContractId: evaluation.id,
      idempotencyKey: input.idempotencyKey,
      callerInputHash: sha256(input)
    });
    const terminalMetadata = {
      receiptType: "terminal",
      engineStamped: true,
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      skillVersionId: input.skillVersionId ?? null,
      candidateVersion: input.candidateVersion,
      candidateArtifactHash: input.candidateArtifactHash,
      disposition: input.disposition,
      missingOutputs: input.missingOutputs,
      callerInputHash: sha256(input)
    };
    const terminalWritten = await this.receiptWriter.write({
      ventureId: input.ventureId,
      receiptId: terminalReceiptId,
      occurredAt: input.recordedAt,
      machine: {
        receiptId: terminalReceiptId,
        ventureId: input.ventureId,
        actor: "company-launch-engine",
        adapter: "engine-terminalizer",
        outcome: "success",
        metadata: terminalMetadata
      },
      markdown: `# Experiment terminal receipt\n\n- Venture: ${input.ventureId}\n- Evaluation: ${evaluation.id}\n- Disposition: ${input.disposition}\n- Missing outputs: ${input.missingOutputs.join(", ") || "none"}\n- Origin: engine-derived\n`
    });
    const terminalReceipt = ReceiptSchema.parse({
      id: terminalReceiptId,
      ventureId: input.ventureId,
      proofTier: "internally-live",
      outcome: "success",
      actor: "company-launch-engine",
      adapter: "engine-terminalizer",
      artifactPath: terminalWritten.jsonPath,
      contentHash: terminalWritten.contentHash,
      occurredAt: input.recordedAt,
      metadata: terminalMetadata,
      origin: "engine-derived"
    });
    const sequence = this.storage.nextExperimentSequence(input.ventureId);
    const finalReceiptIds = [...new Set([...input.receiptIds, terminalReceiptId])];
    const semanticInput: Record<string, unknown> = { ...input, receiptIds: finalReceiptIds, terminalReceiptId };
    delete semanticInput.idempotencyKey;
    const canonicalHash = sha256({ sequence, semanticInput });
    const record = ExperimentRecordSchema.parse({
      id: makeId("experiment", { ventureId: input.ventureId, canonicalHash }),
      sequence,
      ...input,
      receiptIds: finalReceiptIds,
      terminalReceiptId,
      createdAt: nowIso(),
      canonicalHash
    });
    const stored = this.storage.createExperimentRecord(record, terminalReceipt);
    this.auditImmutableRecord(input.ventureId, "experiment-recorded", "experiment-record", record.id, {
      sequence: record.sequence,
      canonicalHash: record.canonicalHash,
      disposition: record.disposition,
      metricId: record.primaryMetricResult?.metricId ?? null,
      improvement: record.primaryMetricResult?.improvement ?? null,
      thresholdPassed: record.primaryMetricResult?.thresholdPassed ?? null,
      missingOutputs: record.missingOutputs
    });
    return { created: stored.created, record: stored.record, terminalReceiptId };
  }

  getExperiment(ventureId: string, experimentRecordId: string): Record<string, unknown> {
    this.requireVenture(ventureId);
    const record = this.storage.getExperimentRecord(ventureId, experimentRecordId);
    if (!record) {
      throw new EngineCommandError(
        "experiment-not-found",
        `experiment record not found or belongs to another venture: ${ventureId}/${experimentRecordId}`
      );
    }
    return { record };
  }

  async recordSkillVersion(input: SkillVersionInput): Promise<Record<string, unknown>> {
    this.requireVenture(input.ventureId);
    const replay = this.storage
      .listSkillVersions(input.ventureId, { skillId: input.skillId })
      .find((skill) => skill.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (!immutableInputMatches(replay, input)) {
        throw new StorageIdempotencyConflictError("skill version", input.ventureId, input.idempotencyKey);
      }
      return { created: false, record: replay };
    }
    const root = await realpath(path.dirname(this.venturesRoot));
    const normalizedArtifactPath = path.normalize(input.artifactPath);
    const firstSegment = normalizedArtifactPath.split(path.sep)[0];
    if (path.isAbsolute(input.artifactPath) || firstSegment !== "skills") {
      throw new EngineCommandError("skill-artifact-root-invalid", "skill artifacts must live under the project-local skills directory");
    }
    if (
      normalizedArtifactPath
        .split(path.sep)
        .some((segment) => SECRET_LIKE_ARTIFACT_SEGMENT.test(segment))
    ) {
      throw new EngineCommandError("skill-artifact-secret-like", "skill artifact path contains a secret-like filename segment");
    }
    if (!ALLOWED_SKILL_ARTIFACT_EXTENSIONS.has(path.extname(normalizedArtifactPath).toLowerCase())) {
      throw new EngineCommandError("skill-artifact-type-invalid", "skill artifact type is not on the bounded candidate allowlist");
    }
    const artifactCandidate = path.resolve(root, input.artifactPath);
    let artifactRealPath: string;
    try {
      artifactRealPath = await realpath(artifactCandidate);
    } catch {
      throw new EngineCommandError("skill-artifact-not-found", `skill artifact does not exist: ${input.artifactPath}`);
    }
    if (artifactRealPath !== root && !artifactRealPath.startsWith(`${root}${path.sep}`)) {
      throw new EngineCommandError("skill-artifact-outside-root", "skill artifact must remain inside the engine project root");
    }
    const artifactStats = await stat(artifactRealPath);
    if (!artifactStats.isFile() || artifactStats.size > MAX_EVALUATION_ARTIFACT_BYTES) {
      throw new EngineCommandError(
        "skill-artifact-invalid",
        `skill artifact must be a regular file no larger than ${MAX_EVALUATION_ARTIFACT_BYTES} bytes`
      );
    }
    const artifactHash = createHash("sha256").update(await readFile(artifactRealPath)).digest("hex");
    if (artifactHash !== input.artifactHash) {
      throw new EngineCommandError("skill-artifact-hash-mismatch", "skill artifact hash does not match the recorded immutable version");
    }
    const latest = this.storage.listSkillVersions(input.ventureId, { skillId: input.skillId }).sort((a, b) => a.revision - b.revision).at(-1);
    if ((latest?.id ?? undefined) !== input.supersedesSkillVersionId) {
      throw new EngineCommandError(
        "skill-supersession-mismatch",
        `skill version must supersede ${latest?.id ?? "nothing"}, received ${input.supersedesSkillVersionId ?? "nothing"}`
      );
    }
    if (!["draft", "candidate"].includes(input.state)) {
      if (!input.supersedesSkillVersionId) {
        throw new EngineCommandError("promotion-required", `${input.state} cannot be self-declared on the first skill version`);
      }
      const promotion = this.storage
        .listPlayPromotions(input.ventureId, { skillVersionId: input.supersedesSkillVersionId })
        .sort(comparePromotionRecency)[0];
      const requiredDecision = input.state === "deprecated" ? "deprecate" : "promote";
      if (
        !promotion ||
        promotion.decision !== requiredDecision ||
        promotion.toState !== input.state ||
        !sameIds(promotion.evaluationContractIds, input.evaluationContractIds) ||
        !sameIds(promotion.experimentRecordIds, input.experimentRecordIds) ||
        !sameIds(promotion.evidenceIds, input.evidenceIds) ||
        !sameIds(promotion.transferVentureIds, input.evaluatedVentureIds)
      ) {
        throw new EngineCommandError("promotion-required", `${input.state} requires the latest matching immutable promotion decision`);
      }
      if (
        !latest ||
        input.version !== latest.version ||
        input.artifactPath !== latest.artifactPath ||
        input.artifactHash !== latest.artifactHash ||
        input.producerId !== latest.producerId ||
        input.name !== latest.name ||
        !semanticEquals(input.applicability, latest.applicability) ||
        !semanticEquals(input.exclusions, latest.exclusions) ||
        !semanticEquals(input.assumptions, latest.assumptions) ||
        !semanticEquals(input.mutableSurface, latest.mutableSurface)
      ) {
        throw new EngineCommandError(
          "promoted-artifact-mismatch",
          "evidence-state advancement must preserve the exact promoted skill identity, semantics, producer, path, and artifact"
        );
      }
      if (input.producerId === input.recordedBy) {
        throw new EngineCommandError("independent-recorder-required", "promoted skill state requires a recorder independent from its producer");
      }
    }
    const revision = this.storage.nextSkillRevision(input.ventureId, input.skillId);
    const semanticInput: Record<string, unknown> = { ...input };
    delete semanticInput.idempotencyKey;
    delete semanticInput.recordedAt;
    const canonicalHash = sha256({ revision, semanticInput });
    const record = SkillVersionSchema.parse({
      id: makeId("skillversion", { ventureId: input.ventureId, skillId: input.skillId, canonicalHash }),
      revision,
      ...input,
      createdAt: nowIso(),
      canonicalHash
    });
    const stored = this.storage.createSkillVersion(record);
    this.auditImmutableRecord(input.ventureId, "skill-version-recorded", "skill-version", record.id, {
      skillId: record.skillId,
      version: record.version,
      state: record.state,
      canonicalHash: record.canonicalHash,
      artifactHash: record.artifactHash
    });
    return { created: stored.created, record: stored.record };
  }

  recordPlayPromotion(input: PlayPromotionInput): Record<string, unknown> {
    this.requireVenture(input.ventureId);
    const replay = this.storage
      .listPlayPromotions(input.ventureId, { playId: input.playId })
      .find((promotion) => promotion.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (!immutableInputMatches(replay, input)) {
        throw new StorageIdempotencyConflictError("play promotion", input.ventureId, input.idempotencyKey);
      }
      return { created: false, record: replay, skillStateUnchanged: true };
    }
    const skill = this.storage.getSkillVersion(input.ventureId, input.skillVersionId);
    if (!skill) {
      throw new EngineCommandError("skill-version-not-found", `skill version not found or belongs to another venture: ${input.skillVersionId}`);
    }
    if (skill.state !== input.fromState) {
      throw new EngineCommandError("promotion-state-mismatch", `skill is ${skill.state}, not ${input.fromState}`);
    }
    if (skill.producerId !== input.producerId) {
      throw new EngineCommandError("promotion-producer-mismatch", "promotion producer must equal the exact stored skill producer");
    }
    if (!this.storage.listPlays(input.ventureId).some((play) => play.id === input.playId)) {
      throw new EngineCommandError("play-not-found", `play not found or belongs to another venture: ${input.playId}`);
    }
    const allowedVentures = [...new Set([input.ventureId, ...input.transferVentureIds])];
    for (const ventureId of allowedVentures) this.requireVenture(ventureId);
    const evaluations = input.evaluationContractIds.map((id) => this.findEvaluationReference(id, allowedVentures));
    const experiments = input.experimentRecordIds.map((id) => this.findExperimentReference(id, allowedVentures));
    this.requireReferenceEvidence(input.evidenceIds, allowedVentures, "promotion evidence");
    this.requireReferenceReceipts(input.noHistoryBaselineReceiptIds, allowedVentures, "no-history baseline");
    this.requireReferenceReceipts(input.plainAgentBaselineReceiptIds, allowedVentures, "plain-agent baseline");
    const originEvaluation = evaluations.find((item) => item.ventureId === input.ventureId);
    if (!originEvaluation) {
      throw new EngineCommandError("promotion-evaluation-missing", "promotion requires an originating-venture evaluation contract");
    }
    if (
      originEvaluation.record.producerId !== input.producerId ||
      originEvaluation.record.evaluatorId !== input.evaluatorId ||
      originEvaluation.record.reviewerId !== input.reviewerId ||
      originEvaluation.record.promotionAuthorityId !== input.promotionAuthorityId
    ) {
      throw new EngineCommandError("promotion-authority-mismatch", "promotion authorities do not match the frozen originating evaluator");
    }
    if (input.decision === "promote") {
      if (
        experiments.some(
          (experiment) =>
            experiment.record.disposition !== "keep" ||
            !experiment.record.primaryMetricResult?.thresholdPassed ||
            !experiment.record.reviewer?.independentFromProducer ||
            experiment.record.missingOutputs.length > 0 ||
            experiment.record.attempts.length === 0
        )
      ) {
        throw new EngineCommandError(
          "promotion-proof-insufficient",
          "promotion requires complete kept threshold-passing experiments before evidence can be evaluated"
        );
      }
      if (
        (input.toState === "held-out-verified" || input.toState === "cross-venture-proven") &&
        evaluations.some((evaluation) => evaluation.record.evaluationPopulation.kind !== "hidden-held-out")
      ) {
        throw new EngineCommandError(
          "held-out-proof-missing",
          `${input.toState} always requires a true hidden held-out evaluation, regardless of caller policy flags`
        );
      }
      for (const baselineReceiptId of [...input.noHistoryBaselineReceiptIds, ...input.plainAgentBaselineReceiptIds]) {
        const match = allowedVentures
          .map((ventureId) => this.storage.listReceipts(ventureId).find((receipt) => receipt.id === baselineReceiptId))
          .find((receipt): receipt is Receipt => Boolean(receipt));
        const expectedType = input.noHistoryBaselineReceiptIds.includes(baselineReceiptId)
          ? "no-history-baseline"
          : "plain-agent-baseline";
        if (!match) throw new EngineCommandError("receipt-not-found", `promotion baseline is absent: ${baselineReceiptId}`);
        const frozenBy = evaluations.find((evaluation) =>
          expectedType === "no-history-baseline"
            ? evaluation.record.baseline.noHistoryReceiptIds.includes(baselineReceiptId)
            : evaluation.record.baseline.plainAgentReceiptIds.includes(baselineReceiptId)
        );
        if (!frozenBy) throw new EngineCommandError("promotion-baseline-mismatch", `promotion baseline was not frozen: ${baselineReceiptId}`);
        this.assertPromotableBaselineReceipt(match, expectedType, frozenBy.record.frozenAt);
      }
      for (const evidenceId of input.evidenceIds) {
        const evidence = allowedVentures
          .map((ventureId) => this.storage.listEvidence(ventureId).find((item) => item.id === evidenceId))
          .find((item): item is EvidenceItem => Boolean(item));
        if (
          !evidence ||
          evidence.status !== "current" ||
          (evidence.expiresAt !== undefined && Date.parse(evidence.expiresAt) <= Date.now()) ||
          evidence.authority === "fixture" ||
          evidence.proofTier === "fixture-verified"
        ) {
          throw new EngineCommandError("promotion-evidence-untrusted", `promotion evidence is absent, stale, expired, or fixture: ${evidenceId}`);
        }
        const boundExperiment = experiments.find((experiment) =>
          experiment.record.hardGateResults.some(
            (gate) => gate.hardGateId === evidence.metadata.hardGateId && gate.evidenceIds.includes(evidence.id)
          )
        );
        if (
          !boundExperiment ||
          evidence.metadata.evaluationContractId !== boundExperiment.record.evaluationContractId ||
          evidence.metadata.candidateVersion !== boundExperiment.record.candidateVersion ||
          evidence.metadata.candidateArtifactHash !== boundExperiment.record.candidateArtifactHash ||
          !boundExperiment.record.receiptIds.includes(evidence.sourceRef)
        ) {
          throw new EngineCommandError(
            "promotion-evidence-unbound",
            `promotion evidence ${evidenceId} is not bound to a supplied experiment, evaluator, candidate, hard gate, and receipt`
          );
        }
      }
      const expectedOutcomeHash = comparableOutcomeDefinitionHash(originEvaluation.record);
      if (input.outcomeDefinitionHash !== expectedOutcomeHash) {
        throw new EngineCommandError("outcome-definition-mismatch", "promotion outcome definition does not match the frozen evaluator");
      }
      for (const evaluation of evaluations) {
        if (comparableOutcomeDefinitionHash(evaluation.record) !== expectedOutcomeHash) {
          throw new EngineCommandError(
            "cross-venture-outcome-mismatch",
            `evaluation outcome definition is not comparable with the origin evaluator: ${evaluation.record.id}`
          );
        }
        if (!evaluation.record.skillVersionId || !evaluation.record.candidateVersion) {
          throw new EngineCommandError("promotion-skill-binding-missing", "promotion evaluations must bind an exact skill and candidate version");
        }
        const evaluatedSkill = this.storage.getSkillVersion(evaluation.ventureId, evaluation.record.skillVersionId);
        if (!evaluatedSkill) {
          throw new EngineCommandError(
            "promotion-skill-binding-missing",
            `evaluation skill version is absent or belongs to another venture: ${evaluation.record.skillVersionId}`
          );
        }
        if (
          evaluatedSkill.version !== skill.version ||
          evaluatedSkill.artifactHash !== skill.artifactHash ||
          evaluation.record.candidateVersion !== skill.version ||
          (evaluation.ventureId === input.ventureId && evaluatedSkill.id !== skill.id)
        ) {
          throw new EngineCommandError(
            "promotion-candidate-mismatch",
            "every evaluation must bind the same exact skill version and artifact as the promotion target"
          );
        }
      }
      for (const baselineReceiptId of input.noHistoryBaselineReceiptIds) {
        if (!evaluations.some((evaluation) => evaluation.record.baseline.noHistoryReceiptIds.includes(baselineReceiptId))) {
          throw new EngineCommandError("promotion-baseline-mismatch", `no-history receipt is not frozen by a supplied evaluator: ${baselineReceiptId}`);
        }
      }
      for (const baselineReceiptId of input.plainAgentBaselineReceiptIds) {
        if (!evaluations.some((evaluation) => evaluation.record.baseline.plainAgentReceiptIds.includes(baselineReceiptId))) {
          throw new EngineCommandError("promotion-baseline-mismatch", `plain-agent receipt is not frozen by a supplied evaluator: ${baselineReceiptId}`);
        }
      }
      for (const ventureId of allowedVentures) {
        const ventureEvaluations = evaluations.filter((evaluation) => evaluation.ventureId === ventureId);
        if (ventureEvaluations.length === 0) {
          throw new EngineCommandError("promotion-evaluation-missing", `promotion lacks a frozen evaluator for ${ventureId}`);
        }
        const hasNoHistory = ventureEvaluations.some((evaluation) =>
          evaluation.record.baseline.noHistoryReceiptIds.some((receiptId) => input.noHistoryBaselineReceiptIds.includes(receiptId))
        );
        const hasPlainAgent = ventureEvaluations.some((evaluation) =>
          evaluation.record.baseline.plainAgentReceiptIds.some((receiptId) => input.plainAgentBaselineReceiptIds.includes(receiptId))
        );
        if (!hasNoHistory || !hasPlainAgent) {
          throw new EngineCommandError(
            "promotion-baseline-missing",
            `promotion requires frozen no-history and plain-agent baselines for ${ventureId}`
          );
        }
      }
      let allHardGatesPassed = true;
      let allCostWithinTolerance = true;
      let allFounderTimeWithinTolerance = true;
      let allComplexityWithinTolerance = true;
      let leakageDetected = false;
      for (const experiment of experiments) {
        const evaluator = evaluations.find(
          (evaluation) =>
            evaluation.ventureId === experiment.ventureId && evaluation.record.id === experiment.record.evaluationContractId
        );
        const metricResult = experiment.record.primaryMetricResult;
        const reviewer = experiment.record.reviewer;
        if (
          !evaluator ||
          experiment.record.disposition !== "keep" ||
          !metricResult?.thresholdPassed ||
          !reviewer?.independentFromProducer ||
          reviewer.reviewerId === experiment.record.producerId ||
          !experiment.record.outcomeReceiptId ||
          experiment.record.missingOutputs.length > 0 ||
          experiment.record.attempts.length === 0 ||
          Object.values(experiment.record.costs).some((value) => value === null) ||
          experiment.record.attempts.some(
            (attempt) =>
              attempt.receiptIds.length === 0 ||
              attempt.providerCostCents === null ||
              attempt.modelCostCents === null ||
              attempt.elapsedMs === null ||
              attempt.founderMinutes === null ||
              attempt.reviewerMinutes === null
          )
        ) {
          throw new EngineCommandError(
            "promotion-proof-insufficient",
            "promotion requires complete kept threshold-passing experiments bound to supplied evaluators"
          );
        }
        this.assertStoredExperimentProof(evaluator.record, experiment.record);
        if (
          experiment.record.skillVersionId !== evaluator.record.skillVersionId ||
          experiment.record.candidateVersion !== skill.version ||
          experiment.record.candidateArtifactHash !== skill.artifactHash
        ) {
          throw new EngineCommandError("promotion-candidate-mismatch", "promotion experiment is not bound to the exact evaluated skill artifact");
        }
        allHardGatesPassed &&= experiment.record.hardGateResults.every(
          (result) => result.passed && result.evidenceIds.length > 0
        );
        const baselineReceipt = this.requireReceiptRecord(experiment.ventureId, experiment.record.baselineReceiptId, "promotion baseline");
        const scoringReceipt = this.requireReceiptRecord(
          experiment.ventureId,
          metricResult.scoringReceiptId,
          "promotion scoring"
        );
        const tolerances = this.deriveExperimentTolerances(evaluator.record, experiment.record, baselineReceipt, scoringReceipt);
        allCostWithinTolerance &&= tolerances.costWithinTolerance;
        allFounderTimeWithinTolerance &&= tolerances.founderTimeWithinTolerance;
        allComplexityWithinTolerance &&= tolerances.complexityWithinTolerance;
        leakageDetected ||= scoringReceipt.metadata.leakageDetected !== false;
      }
      if (
        input.hardGatesPassed !== allHardGatesPassed ||
        input.costWithinTolerance !== allCostWithinTolerance ||
        input.founderTimeWithinTolerance !== allFounderTimeWithinTolerance ||
        input.complexityWithinTolerance !== allComplexityWithinTolerance ||
        input.leakageDetected !== leakageDetected ||
        !allHardGatesPassed ||
        !allCostWithinTolerance ||
        !allFounderTimeWithinTolerance ||
        !allComplexityWithinTolerance ||
        leakageDetected
      ) {
        throw new EngineCommandError("promotion-gate-mismatch", "promotion gate declarations do not match the frozen experiment proof");
      }
      if (
        evaluations.some(
          (evaluation) =>
            evaluation.record.promotionRule.requireHeldOut && evaluation.record.evaluationPopulation.kind !== "hidden-held-out"
        )
      ) {
        throw new EngineCommandError("held-out-proof-missing", "frozen promotion rule requires a hidden held-out evaluation population");
      }
      if (
        evaluations.some((evaluation) => evaluation.record.promotionRule.requireCrossVenture) &&
        allowedVentures.length < 2
      ) {
        throw new EngineCommandError("cross-venture-proof-missing", "frozen promotion rule requires a distinct transfer venture");
      }
      const coveredVentures = new Set(experiments.filter((item) => item.record.disposition === "keep").map((item) => item.ventureId));
      const missingVenture = allowedVentures.find((ventureId) => !coveredVentures.has(ventureId));
      if (missingVenture) {
        throw new EngineCommandError("promotion-proof-missing", `promotion lacks a kept experiment for ${missingVenture}`);
      }
    }
    const latest = this.storage.listPlayPromotions(input.ventureId, { playId: input.playId }).sort((a, b) => a.revision - b.revision).at(-1);
    const revision = this.storage.nextPromotionRevision(input.ventureId, input.playId);
    const semanticInput: Record<string, unknown> = { ...input };
    delete semanticInput.idempotencyKey;
    delete semanticInput.requestedAt;
    const canonicalHash = sha256({ revision, semanticInput, supersedesPlayPromotionId: latest?.id ?? null });
    const record = PlayPromotionSchema.parse({
      id: makeId("promotion", { ventureId: input.ventureId, playId: input.playId, canonicalHash }),
      revision,
      ...input,
      ...(latest ? { supersedesPlayPromotionId: latest.id } : {}),
      createdAt: nowIso(),
      canonicalHash
    });
    const stored = this.storage.createPlayPromotion(record);
    this.auditImmutableRecord(input.ventureId, "play-promotion-recorded", "play-promotion", record.id, {
      playId: record.playId,
      skillVersionId: record.skillVersionId,
      decision: record.decision,
      fromState: record.fromState,
      toState: record.toState,
      canonicalHash: record.canonicalHash,
      skillStateUnchanged: true
    });
    return { created: stored.created, record: stored.record, skillStateUnchanged: true };
  }

  private requireVenture(ventureId: string): any {
    const venture = this.storage.getVenture(ventureId);
    if (!venture?.pack) throw new EngineCommandError("venture-not-found", `venture not found: ${ventureId}`);
    return venture;
  }

  private assertExpectedGoal(ventureId: string, expected: string | undefined, current: string | undefined): void {
    if (expected !== current) {
      throw new EngineCommandError(
        "goal-revision-conflict",
        `goal revision conflict for ${ventureId}: expected ${current ?? "none"}, received ${expected ?? "none"}`
      );
    }
  }

  private goalPreviewSnapshot(ventureId: string, lifecycleState: LifecycleState) {
    const venture = this.requireVenture(ventureId);
    if (!venture.current_pack_revision_id) {
      throw new EngineCommandError("pack-revision-missing", `venture has no current pack revision: ${ventureId}`);
    }
    const tasks = this.storage.listTasks(ventureId);
    const gaps = computeReadiness(venture.pack, this.storage.listSourceHealth(ventureId));
    return {
      evidenceCount: this.storage.listEvidence(ventureId).length,
      taskCount: tasks.length,
      receiptCount: this.storage.listReceipts(ventureId).length,
      lifecycleState,
      packRevisionId: venture.current_pack_revision_id,
      tasks: tasks.map((task) => ({
        taskId: task.id,
        purpose: task.purpose,
        status: task.status,
        actionDigest: task.actionDigest,
        ...(task.goalTaskBinding ? { goalTaskBinding: task.goalTaskBinding } : {})
      })),
      readinessGaps: gaps
    };
  }

  private requireReceiptRecord(ventureId: string, receiptId: string, label: string): Receipt {
    const receipt = this.storage.listReceipts(ventureId).find((candidate) => candidate.id === receiptId);
    if (!receipt) {
      throw new EngineCommandError("receipt-not-found", `${label} receipt is absent or belongs to another venture: ${receiptId}`);
    }
    return receipt;
  }

  private assertReceiptType(receipt: Receipt, expectedType: string, label: string): void {
    this.assertReceiptMetadata(receipt, "receiptType", expectedType, label);
  }

  private assertReceiptMetadata(receipt: Receipt, key: string, expected: unknown, label: string): void {
    if (!(key in receipt.metadata) || !semanticEquals(receipt.metadata[key], expected)) {
      throw new EngineCommandError(
        "receipt-metadata-mismatch",
        `${label} receipt ${receipt.id} does not bind ${key} to the frozen value`
      );
    }
  }

  private assertFreezableBaselineReceipt(
    receipt: Receipt,
    expectedType: "baseline" | "plain-agent-baseline" | "no-history-baseline",
    frozenAt: string
  ): void {
    if (receipt.outcome !== "success" || Date.parse(receipt.occurredAt) > Date.parse(frozenAt)) {
      throw new EngineCommandError(
        "evaluation-baseline-untrusted",
        `${expectedType} receipt ${receipt.id} must be successful and predate the evaluation freeze`
      );
    }
    if (receipt.origin === "attached-artifact" || receipt.origin === "fixture" || receipt.origin === "legacy") {
      throw new EngineCommandError(
        "evaluation-baseline-untrusted",
        `${expectedType} receipt ${receipt.id} has a manual, fixture, or legacy origin and is non-promotable`
      );
    }
    if (
      typeof receipt.metadata.baselineTrust !== "string" ||
      receipt.metadata.baselineTrust.length === 0 ||
      typeof receipt.metadata.promotionEligible !== "boolean" ||
      receipt.metadata.trustModel !== "single-operator-local" ||
      receipt.metadata.customerSafe !== false
    ) {
      throw new EngineCommandError(
        "evaluation-baseline-untrusted",
        `${expectedType} receipt ${receipt.id} lacks explicit baseline trust, promotion eligibility, and local trust-model metadata`
      );
    }
    if (
      receipt.origin === "engine-derived" &&
      (receipt.metadata.engineStamped !== true ||
        receipt.metadata.trustModel !== "single-operator-local" ||
        receipt.metadata.customerSafe !== false)
    ) {
      throw new EngineCommandError(
        "evaluation-baseline-untrusted",
        `${expectedType} receipt ${receipt.id} lacks explicit single-operator-local, non-customer-safe engine provenance`
      );
    }
  }

  private assertPromotableBaselineReceipt(
    receipt: Receipt,
    expectedType: "baseline" | "plain-agent-baseline" | "no-history-baseline",
    frozenAt: string
  ): void {
    this.assertFreezableBaselineReceipt(receipt, expectedType, frozenAt);
    if (receipt.metadata.promotionEligible !== true || receipt.metadata.baselineTrust === "manual-local") {
      throw new EngineCommandError(
        "baseline-non-promotable",
        `${expectedType} receipt ${receipt.id} is evaluable manual-local evidence but cannot authorize keep or promotion`
      );
    }
  }

  private requireReceiptNumber(receipt: Receipt, key: string, label: string): number {
    const value = receipt.metadata[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new EngineCommandError("receipt-metadata-missing", `${label} receipt ${receipt.id} requires nonnegative numeric ${key}`);
    }
    return value;
  }

  private optionalReceiptNumber(receipt: Receipt, key: string): number | null {
    const value = receipt.metadata[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  private assertCandidateReceiptBinding(
    receipt: Receipt,
    evaluation: EvaluationContract,
    experiment: ExperimentRecordInput | ExperimentRecord,
    label: string,
    requireSuccess = true
  ): void {
    if (requireSuccess && receipt.outcome !== "success") {
      throw new EngineCommandError("receipt-outcome-invalid", `${label} receipt did not succeed: ${receipt.id}`);
    }
    this.assertReceiptMetadata(receipt, "evaluationContractId", evaluation.id, label);
    this.assertReceiptMetadata(receipt, "evaluationContractHash", evaluation.canonicalHash, label);
    this.assertReceiptMetadata(receipt, "candidateVersion", experiment.candidateVersion, label);
    this.assertReceiptMetadata(receipt, "candidateArtifactHash", experiment.candidateArtifactHash, label);
  }

  private assertTrustedPhase9Receipt(
    receipt: Receipt,
    evaluation: EvaluationContract,
    experiment: ExperimentRecordInput | ExperimentRecord,
    label: string
  ): void {
    if (
      receipt.adapter === "fixture" ||
      receipt.origin === "fixture" ||
      receipt.origin === "attached-artifact" ||
      receipt.origin === "legacy"
    ) {
      throw new EngineCommandError(
        "receipt-origin-untrusted",
        `${label} receipt ${receipt.id} has untrusted Phase 9 origin ${receipt.origin}/${receipt.adapter}`
      );
    }
    if (receipt.origin !== "dispatch") return;
    if (!receipt.dispatchId || !receipt.taskId) {
      throw new EngineCommandError("dispatch-receipt-invalid", `${label} dispatch receipt lacks a stored dispatch and task binding`);
    }
    const dispatch = this.storage
      .listDispatches(receipt.ventureId)
      .find((candidate) => candidate.id === receipt.dispatchId);
    const task = this.storage.getTask(receipt.ventureId, receipt.taskId);
    if (
      !dispatch ||
      !task ||
      dispatch.task_id !== receipt.taskId ||
      dispatch.adapter !== receipt.adapter ||
      dispatch.owner_role !== receipt.actor ||
      task.ownerRole !== receipt.actor ||
      dispatch.status !== "completed" ||
      task.status !== "succeeded"
    ) {
      throw new EngineCommandError(
        "dispatch-receipt-invalid",
        `${label} receipt does not match its authoritative stored dispatch, adapter, task, owner, and successful completion state`
      );
    }
    const receiptType = receipt.metadata.receiptType;
    if (receiptType === "scoring" || receiptType === "reviewer") {
      const expectedTaskKind = receiptType === "scoring" ? "evaluation-scoring" : "evaluation-review";
      if (
        task.taskKind !== expectedTaskKind ||
        !task.evaluationBinding ||
        !task.evaluationBindingHash ||
        sha256(task.evaluationBinding) !== task.evaluationBindingHash
      ) {
        throw new EngineCommandError(
          "dispatch-evaluation-binding-missing",
          `${label} dispatch task lacks its typed immutable ${expectedTaskKind} binding`
        );
      }
      const skill = evaluation.skillVersionId
        ? this.storage.getSkillVersion(evaluation.ventureId, evaluation.skillVersionId)
        : undefined;
      const expectedBinding: Record<string, unknown> = {
        evaluationContractId: evaluation.id,
        evaluationContractHash: evaluation.canonicalHash,
        skillVersionId: evaluation.skillVersionId,
        skillVersionHash: skill?.canonicalHash,
        candidateVersion: experiment.candidateVersion,
        candidateArtifactHash: experiment.candidateArtifactHash,
        metricId: evaluation.primaryMetric.id,
        primaryMetricHash: sha256(evaluation.primaryMetric),
        formulaHash: sha256(evaluation.primaryMetric.formula),
        populationHash: evaluation.evaluationPopulation.populationHash,
        hardGatesHash: sha256(evaluation.hardGates),
        promotionRuleHash: evaluation.promotionRuleHash,
        evaluationBindingHash: task.evaluationBindingHash,
        engineStamped: true
      };
      for (const [key, value] of Object.entries(expectedBinding)) {
        if (value === undefined || !semanticEquals(receipt.metadata[key], value)) {
          throw new EngineCommandError(
            "dispatch-evaluation-binding-missing",
            `${label} receipt does not carry engine-owned ${key}`
          );
        }
      }
      if (
        task.evaluationBinding.evaluationContractId !== evaluation.id ||
        task.evaluationBinding.evaluationContractHash !== evaluation.canonicalHash ||
        task.evaluationBinding.skillVersionId !== evaluation.skillVersionId ||
        task.evaluationBinding.candidateVersion !== experiment.candidateVersion ||
        task.evaluationBinding.candidateArtifactHash !== experiment.candidateArtifactHash
      ) {
        throw new EngineCommandError("dispatch-evaluation-binding-missing", `${label} task binding does not match the experiment candidate`);
      }
      return;
    }
    const expectedBinding: Record<string, unknown> = {
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      candidateVersion: experiment.candidateVersion,
      candidateArtifactHash: experiment.candidateArtifactHash
    };
    for (const [key, value] of Object.entries(expectedBinding)) {
      if (!semanticEquals(task.actionBounds[key], value)) {
        throw new EngineCommandError(
          "dispatch-evaluation-binding-missing",
          `${label} dispatch task does not carry engine-owned ${key}`
        );
      }
      this.assertReceiptMetadata(receipt, key, value, label);
    }
  }

  private assertProofBinding(
    proof: Receipt | EvidenceItem,
    evaluation: EvaluationContract,
    experiment: ExperimentRecordInput | ExperimentRecord,
    hardGateId: string,
    evidenceRequirement: string
  ): void {
    const metadata = proof.metadata;
    const expected: Record<string, unknown> = {
      hardGateId,
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      candidateVersion: experiment.candidateVersion,
      candidateArtifactHash: experiment.candidateArtifactHash,
      evidenceRequirementHash: sha256(evidenceRequirement)
    };
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in metadata) || !semanticEquals(metadata[key], value)) {
        throw new EngineCommandError(
          "hard-gate-proof-mismatch",
          `hard-gate proof ${proof.id} does not bind ${key} to the frozen experiment`
        );
      }
    }
  }

  private assertEngineHardGateEvidence(
    proof: EvidenceItem,
    result: ExperimentRecordInput["hardGateResults"][number] | ExperimentRecord["hardGateResults"][number],
    receiptsById: ReadonlyMap<string, Receipt>
  ): void {
    if (proof.authority !== "engine" || proof.sourceRef !== proof.metadata.scoringReceiptId) {
      throw new EngineCommandError(
        "hard-gate-proof-mismatch",
        `engine hard-gate evidence ${proof.id} is not sourced from its exact scoring receipt`
      );
    }
    const scoringReceipt = receiptsById.get(proof.sourceRef);
    if (!scoringReceipt || scoringReceipt.origin !== "dispatch" || scoringReceipt.metadata.receiptType !== "scoring") {
      throw new EngineCommandError(
        "hard-gate-proof-mismatch",
        `engine hard-gate evidence ${proof.id} lacks a dispatch-origin scoring source receipt`
      );
    }
    const expected = {
      passed: result.passed,
      reason: result.reason,
      scoringReceiptId: scoringReceipt.id,
      scoringReceiptContentHash: scoringReceipt.contentHash
    };
    for (const [key, value] of Object.entries(expected)) {
      if (!semanticEquals(proof.metadata[key], value)) {
        throw new EngineCommandError(
          "hard-gate-proof-mismatch",
          `engine hard-gate evidence ${proof.id} does not bind ${key} to the recorded result`
        );
      }
    }
    const supportingRefs = proof.metadata.supportingRefs;
    if (!Array.isArray(supportingRefs) || supportingRefs.some((item) => typeof item !== "string")) {
      throw new EngineCommandError("hard-gate-proof-mismatch", `engine hard-gate evidence ${proof.id} lacks exact supporting refs`);
    }
    const stampedProofs = scoringReceipt.metadata.hardGateProofs;
    const stamped = Array.isArray(stampedProofs)
      ? stampedProofs.find(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).evidenceId === proof.id
        ) as Record<string, unknown> | undefined
      : undefined;
    if (
      !stamped ||
      stamped.hardGateId !== result.hardGateId ||
      stamped.passed !== result.passed ||
      stamped.reason !== result.reason ||
      !semanticEquals(stamped.supportingRefs, supportingRefs)
    ) {
      throw new EngineCommandError(
        "hard-gate-proof-mismatch",
        `engine hard-gate evidence ${proof.id} does not match the source receipt's stamped proof`
      );
    }
  }

  private frozenPopulationHash(ventureId: string, caseRefs: readonly string[]): string {
    const venture = this.requireVenture(ventureId);
    const evidenceById = new Map(this.storage.listEvidence(ventureId).map((evidence) => [evidence.id, evidence]));
    const sourceById = new Map((venture.pack.sources as Array<Record<string, unknown> & { id: string }>).map((source) => [source.id, source]));
    const healthById = new Map(this.storage.listSourceHealth(ventureId).map((health) => [health.sourceRef, health]));
    const snapshots = [...caseRefs].sort().map((caseRef) => {
      const evidence = evidenceById.get(caseRef);
      if (evidence) return { kind: "evidence", id: caseRef, contentHash: evidence.contentHash };
      const source = sourceById.get(caseRef);
      if (!source) throw new EngineCommandError("evaluation-case-not-found", `evaluation case lacks venture-scoped provenance: ${caseRef}`);
      const health = healthById.get(caseRef);
      return {
        kind: "source",
        id: caseRef,
        contentHash: health?.contentHash ?? source.expectedSha256 ?? null,
        revision: health?.actualRevision ?? source.revision ?? null
      };
    });
    return sha256(snapshots);
  }

  private deriveExperimentTolerances(
    evaluation: EvaluationContract,
    experiment: ExperimentRecordInput | ExperimentRecord,
    baselineReceipt: Receipt,
    scoringReceipt: Receipt
  ) {
    const baselineCostCents = this.requireReceiptNumber(baselineReceipt, "costCents", "evaluation baseline");
    const baselineFounderMinutes = this.requireReceiptNumber(baselineReceipt, "founderMinutes", "evaluation baseline");
    const baselineComplexityUnits = this.requireReceiptNumber(baselineReceipt, "complexityUnits", "evaluation baseline");
    const candidateComplexityUnits = this.requireReceiptNumber(scoringReceipt, "candidateComplexityUnits", "scoring");
    const candidateCostCents = knownTotalCost(experiment.costs);
    if (candidateCostCents === null || experiment.costs.founderMinutes === null) {
      throw new EngineCommandError("experiment-output-incomplete", "promotion tolerance arithmetic requires exact candidate costs and founder time");
    }
    const costIncreasePercent = percentageIncrease(baselineCostCents, candidateCostCents);
    const founderTimeIncreasePercent = percentageIncrease(baselineFounderMinutes, experiment.costs.founderMinutes);
    const complexityIncreasePercent = percentageIncrease(baselineComplexityUnits, candidateComplexityUnits);
    return {
      costIncreasePercent,
      founderTimeIncreasePercent,
      complexityIncreasePercent,
      costWithinTolerance: costIncreasePercent <= evaluation.promotionRule.maximumCostIncreasePercent + 1e-9,
      founderTimeWithinTolerance:
        founderTimeIncreasePercent <= evaluation.promotionRule.maximumFounderTimeIncreasePercent + 1e-9,
      complexityWithinTolerance:
        complexityIncreasePercent <= evaluation.promotionRule.maximumComplexityIncreasePercent + 1e-9
    };
  }

  private assertStoredExperimentProof(evaluation: EvaluationContract, experiment: ExperimentRecord): void {
    const metricResult = experiment.primaryMetricResult;
    const reviewer = experiment.reviewer;
    if (
      experiment.disposition !== "keep" ||
      !metricResult ||
      !reviewer ||
      !reviewer.independentFromProducer ||
      reviewer.reviewerId === experiment.producerId ||
      !experiment.outcomeReceiptId ||
      experiment.missingOutputs.length > 0 ||
      experiment.attempts.length === 0 ||
      Object.values(experiment.costs).some((value) => value === null) ||
      experiment.attempts.some(
        (attempt) =>
          attempt.receiptIds.length === 0 ||
          attempt.providerCostCents === null ||
          attempt.modelCostCents === null ||
          attempt.elapsedMs === null ||
          attempt.founderMinutes === null ||
          attempt.reviewerMinutes === null
      )
    ) {
      throw new EngineCommandError("promotion-proof-insufficient", "stored experiment is not a complete kept result");
    }
    if (
      !evaluation.baseline.receiptIds.includes(experiment.baselineReceiptId) ||
      evaluation.baseline.primaryMetricValue === undefined ||
      metricResult.baselineValue !== evaluation.baseline.primaryMetricValue
    ) {
      throw new EngineCommandError("promotion-baseline-mismatch", "stored experiment is not bound to the frozen evaluator baseline");
    }
    const baselineReceipt = this.requireReceiptRecord(experiment.ventureId, experiment.baselineReceiptId, "promotion baseline");
    this.assertPromotableBaselineReceipt(baselineReceipt, "baseline", evaluation.frozenAt);
    this.assertReceiptType(baselineReceipt, "baseline", "promotion baseline");
    this.assertReceiptMetadata(baselineReceipt, "primaryMetricValue", evaluation.baseline.primaryMetricValue, "promotion baseline");

    const recordReceipts = experiment.receiptIds.map((receiptId) =>
      this.requireReceiptRecord(experiment.ventureId, receiptId, "promotion experiment")
    );
    for (const receipt of recordReceipts) this.assertTrustedPhase9Receipt(receipt, evaluation, experiment, "promotion experiment");
    const missingReceiptType = evaluation.expectedReceiptTypes.find(
      (receiptType) => !recordReceipts.some((receipt) => receipt.metadata.receiptType === receiptType)
    );
    if (missingReceiptType) {
      throw new EngineCommandError("expected-receipt-missing", `promotion experiment is missing frozen receipt type: ${missingReceiptType}`);
    }
    const scoringReceipt = this.requireReceiptRecord(
      experiment.ventureId,
      metricResult.scoringReceiptId,
      "promotion scoring"
    );
    this.assertReceiptType(scoringReceipt, "scoring", "promotion scoring");
    this.assertCandidateReceiptBinding(scoringReceipt, evaluation, experiment, "promotion scoring");
    this.assertTrustedPhase9Receipt(scoringReceipt, evaluation, experiment, "promotion scoring");
    this.assertReceiptMetadata(scoringReceipt, "metricId", evaluation.primaryMetric.id, "promotion scoring");
    this.assertReceiptMetadata(scoringReceipt, "formulaHash", sha256(evaluation.primaryMetric.formula), "promotion scoring");
    this.assertReceiptMetadata(scoringReceipt, "baselineValue", metricResult.baselineValue, "promotion scoring");
    this.assertReceiptMetadata(scoringReceipt, "candidateValue", metricResult.candidateValue, "promotion scoring");
    this.assertReceiptMetadata(scoringReceipt, "sampleSize", metricResult.sampleSize, "promotion scoring");
    this.assertReceiptMetadata(scoringReceipt, "populationHash", evaluation.evaluationPopulation.populationHash, "promotion scoring");
    if (scoringReceipt.origin === "dispatch" && scoringReceipt.metadata.networkIsolation !== "mechanically-verified") {
      throw new EngineCommandError(
        "promotion-network-isolation-unverified",
        "dispatch evaluation cannot authorize promotion until its no-network isolation is mechanically verified"
      );
    }
    if (
      evaluation.evaluationPopulation.kind === "hidden-held-out" &&
      scoringReceipt.metadata.heldOutChannel !== "opaque-authenticated"
    ) {
      throw new EngineCommandError(
        "promotion-held-out-channel-unverified",
        "hidden held-out promotion requires an opaque authenticated evaluator channel, not a caller-visible manifest"
      );
    }
    if (scoringReceipt.actor !== evaluation.evaluatorId || scoringReceipt.metadata.leakageDetected !== false) {
      throw new EngineCommandError("promotion-scoring-invalid", "stored scoring receipt lacks frozen evaluator authority or no-leakage proof");
    }
    const reviewerReceipt = this.requireReceiptRecord(experiment.ventureId, reviewer.receiptId, "promotion reviewer");
    this.assertReceiptType(reviewerReceipt, "reviewer", "promotion reviewer");
    this.assertCandidateReceiptBinding(reviewerReceipt, evaluation, experiment, "promotion reviewer");
    this.assertTrustedPhase9Receipt(reviewerReceipt, evaluation, experiment, "promotion reviewer");
    this.assertReceiptMetadata(reviewerReceipt, "reviewerId", evaluation.reviewerId, "promotion reviewer");
    this.assertReceiptMetadata(reviewerReceipt, "verdict", experiment.disposition, "promotion reviewer");
    if (reviewerReceipt.actor !== evaluation.reviewerId) {
      throw new EngineCommandError("promotion-reviewer-invalid", "stored reviewer receipt actor does not match the frozen reviewer");
    }

    const requiredSampleSize = Math.max(
      evaluation.primaryMetric.minimumSampleSize,
      evaluation.evaluationPopulation.minimumSampleSize,
      evaluation.promotionRule.minimumSampleSize
    );
    const thresholdPassed =
      metricResult.sampleSize >= requiredSampleSize &&
      metricResult.improvement >=
        Math.max(evaluation.primaryMetric.minimumImprovement, evaluation.promotionRule.minimumPrimaryMetricImprovement);
    if (!thresholdPassed || !metricResult.thresholdPassed) {
      throw new EngineCommandError("promotion-threshold-failed", "stored experiment does not satisfy the frozen promotion threshold");
    }
    if (
      evaluation.evaluationPopulation.kind !== "authoritative-system" &&
      metricResult.sampleSize !== evaluation.evaluationPopulation.caseRefs.length
    ) {
      throw new EngineCommandError("sample-population-mismatch", "stored experiment sample does not equal the frozen population");
    }

    const receiptsById = new Map(this.storage.listReceipts(experiment.ventureId).map((receipt) => [receipt.id, receipt]));
    const evidenceById = new Map(this.storage.listEvidence(experiment.ventureId).map((evidence) => [evidence.id, evidence]));
    if (!sameIds(evaluation.hardGates.map((gate) => gate.id), experiment.hardGateResults.map((gate) => gate.hardGateId))) {
      throw new EngineCommandError("hard-gate-mismatch", "stored experiment hard gates do not match the frozen evaluator");
    }
    for (const result of experiment.hardGateResults) {
      const gate = evaluation.hardGates.find((candidate) => candidate.id === result.hardGateId)!;
      if (!result.passed || result.evidenceIds.length === 0) {
        throw new EngineCommandError("promotion-hard-gate-failed", `stored experiment did not prove hard gate ${result.hardGateId}`);
      }
      for (const proofId of result.evidenceIds) {
        const proof = receiptsById.get(proofId) ?? evidenceById.get(proofId);
        if (!proof) throw new EngineCommandError("hard-gate-proof-not-found", `stored hard-gate proof is absent: ${proofId}`);
        if ("outcome" in proof && proof.outcome !== "success") {
          throw new EngineCommandError("hard-gate-proof-invalid", `stored hard-gate receipt did not succeed: ${proofId}`);
        }
        if ("status" in proof && (proof.status !== "current" || (proof.expiresAt && Date.parse(proof.expiresAt) <= Date.now()))) {
          throw new EngineCommandError("hard-gate-proof-invalid", `stored hard-gate evidence is not current: ${proofId}`);
        }
        this.assertProofBinding(proof, evaluation, experiment, gate.id, gate.evidenceRequirement);
        if (!("outcome" in proof) && proof.type === "evaluation-hard-gate-proof") {
          this.assertEngineHardGateEvidence(proof, result, receiptsById);
        }
        if ("origin" in proof) {
          this.assertTrustedPhase9Receipt(proof, evaluation, experiment, `promotion hard gate ${gate.id}`);
        } else {
          if (proof.authority === "fixture" || proof.proofTier === "fixture-verified") {
            throw new EngineCommandError("receipt-origin-untrusted", `promotion hard gate ${gate.id} uses fixture evidence`);
          }
          const sourceReceipt = receiptsById.get(proof.sourceRef);
          if (sourceReceipt) this.assertTrustedPhase9Receipt(sourceReceipt, evaluation, experiment, `promotion hard gate ${gate.id}`);
        }
      }
    }
    for (const attempt of experiment.attempts) {
      const elapsedMs = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt);
      if (attempt.elapsedMs === null || Date.parse(attempt.startedAt) < Date.parse(evaluation.frozenAt) || elapsedMs !== attempt.elapsedMs) {
        throw new EngineCommandError("promotion-timing-invalid", `stored attempt ${attempt.attempt} is pre-freeze or has false elapsed time`);
      }
    }
  }

  private requireReceipts(ventureId: string, receiptIds: readonly string[], label: string): void {
    const known = new Set(this.storage.listReceipts(ventureId).map((receipt) => receipt.id));
    const missing = receiptIds.find((receiptId) => !known.has(receiptId));
    if (missing) throw new EngineCommandError("receipt-not-found", `${label} receipt is absent or belongs to another venture: ${missing}`);
  }

  private requireReferenceReceipts(receiptIds: readonly string[], ventureIds: readonly string[], label: string): void {
    for (const receiptId of receiptIds) {
      const matches = ventureIds.filter((ventureId) => this.storage.listReceipts(ventureId).some((receipt) => receipt.id === receiptId));
      if (matches.length !== 1) {
        throw new EngineCommandError("receipt-not-found", `${label} receipt must resolve to exactly one allowed venture: ${receiptId}`);
      }
    }
  }

  private requireReferenceEvidence(evidenceIds: readonly string[], ventureIds: readonly string[], label: string): void {
    for (const evidenceId of evidenceIds) {
      const matches = ventureIds.filter((ventureId) => this.storage.listEvidence(ventureId).some((evidence) => evidence.id === evidenceId));
      if (matches.length !== 1) {
        throw new EngineCommandError("evidence-not-found", `${label} must resolve to exactly one allowed venture: ${evidenceId}`);
      }
    }
  }

  private findEvaluationReference(evaluationId: string, ventureIds: readonly string[]) {
    const matches = ventureIds.flatMap((ventureId) => {
      const record = this.storage.getEvaluationContract(ventureId, evaluationId);
      return record ? [{ ventureId, record }] : [];
    });
    if (matches.length !== 1) {
      throw new EngineCommandError("evaluation-not-found", `evaluation must resolve to exactly one allowed venture: ${evaluationId}`);
    }
    return matches[0]!;
  }

  private findExperimentReference(experimentId: string, ventureIds: readonly string[]) {
    const matches = ventureIds.flatMap((ventureId) => {
      const record = this.storage.getExperimentRecord(ventureId, experimentId);
      return record ? [{ ventureId, record }] : [];
    });
    if (matches.length !== 1) {
      throw new EngineCommandError("experiment-not-found", `experiment must resolve to exactly one allowed venture: ${experimentId}`);
    }
    return matches[0]!;
  }

  private auditImmutableRecord(
    ventureId: string,
    eventType: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>
  ): void {
    this.storage.addAuditEvent({
      ventureId,
      id: makeId("audit", { eventType, entityType, entityId }),
      eventType,
      actor: "company-launch-engine",
      entityType,
      entityId,
      payload,
      occurredAt: nowIso()
    });
  }

  scorecard(workspaceId: string): Record<string, unknown> {
    const ventures = this.storage.listVenturesInWorkspace(workspaceId).map((venture) => {
      const readiness = this.getReadiness(venture.id) as any;
      const tasks = this.storage.listTasks(venture.id);
      const dispatches = this.storage.listDispatches(venture.id);
      const receipts = this.storage.listReceipts(venture.id);
      const evidence = this.storage.listEvidence(venture.id);
      const proofTiers = [...new Set(receipts.map((receipt) => receipt.proofTier))];
      return {
        ventureId: venture.id,
        slug: venture.slug,
        name: venture.name,
        lifecycleState: venture.lifecycle_state,
        gapCount: readiness.gapCount,
        tasks: { total: tasks.length, succeeded: tasks.filter((task) => task.status === "succeeded").length },
        dispatches: { total: dispatches.length, completed: dispatches.filter((dispatch) => dispatch.status === "completed").length },
        receiptIds: receipts.map((receipt) => receipt.id),
        proofTiers,
        founderInterventions: this.storage.founderInterventionCount(venture.id),
        metrics: this.storage.listMetrics(venture.id),
        verifiedRevenue: evidence.some(
          (item) =>
            item.type === "authoritative-payment-collected" &&
            item.authority === "payment" &&
            item.proofTier === "revenue-verified" &&
            item.status === "current" &&
            item.metadata.fixture !== true
        ),
        verifiedFulfillment: evidence.some(
          (item) =>
            item.type === "authoritative-fulfillment-delivered" &&
            item.authority === "fulfillment" &&
            item.proofTier === "fulfillment-verified" &&
            item.status === "current" &&
            item.metadata.fixture !== true
        ),
        recommendation: readiness.recommendation
      };
    });
    return {
      generatedAt: nowIso(),
      dashboardUrl: this.dashboardUrl,
      proofVocabulary: ["scaffolded", "fixture-verified", "internally-live", "externally-live", "revenue-verified", "fulfillment-verified", "blocked"],
      ventures
    };
  }
}

export class EngineWorker {
  private readonly context: ExecutionContext;

  constructor(
    private readonly service: EngineService,
    private readonly workerId = `worker-${process.pid}`,
    context: ExecutionContext = executionContext(service.context.workspaceId, "worker")
  ) {
    this.context = executionContext(context.workspaceId, "worker");
  }

  async runOnce(): Promise<Record<string, unknown> | null> {
    this.service.storage.recoverExpiredJobs(this.context.workspaceId);
    const job = this.service.storage.claimNextJob(this.context.workspaceId, this.workerId, 120_000);
    if (!job) return null;
    const task = this.service.storage.getTask(job.venture_id, job.task_id);
    if (!task) {
      this.service.storage.failJob({ ventureId: job.venture_id, jobId: job.id, taskId: job.task_id, error: "task missing", deadLetter: true });
      return { ventureId: job.venture_id, jobId: job.id, outcome: "dead-letter", reason: "task missing" };
    }
    const initialGoalBlock = this.service.goalExecutionBlock(task);
    if (initialGoalBlock) return this.haltForGoalChange(job.id, task, initialGoalBlock);
    let dispatchId: string | undefined;
    try {
      if (this.service.storage.isKilled(task.ventureId)) throw new KillSwitchError(`kill switch active before attempt for ${task.ventureId}`);
      const policy = evaluatePolicy(task);
      if (policy.decision !== "allow") {
        if (task.approvalId) {
          const approval = this.service.storage.getApproval(task.ventureId, task.approvalId);
          const validation = validateApproval(task, approval);
          if (!validation.valid) throw new Error(validation.reason);
        } else throw new Error(policy.reason);
      }
      const allDependencyReceipts = task.dependencies.flatMap((dependencyTaskId) =>
        this.service.storage
          .listReceipts(task.ventureId)
          .filter((receipt) => receipt.taskId === dependencyTaskId && receipt.outcome === "success")
      );
      const dependencyReceipts =
        task.taskKind === "evaluation-review"
          ? allDependencyReceipts.filter(
              (receipt) =>
                receipt.origin === "dispatch" &&
                receipt.metadata.receiptType === "scoring" &&
                receipt.metadata.evaluationBindingHash === task.evaluationBindingHash &&
                receipt.taskId === task.dependencies[0]
            )
          : allDependencyReceipts;
      await this.service.validateEvaluationTaskForDispatch(task, dependencyReceipts, true);
      const preDispatchGoalBlock = this.service.goalExecutionBlock(task);
      if (preDispatchGoalBlock) return this.haltForGoalChange(job.id, task, preDispatchGoalBlock);
      const existing = this.service.storage
        .listDispatches(task.ventureId)
        .find((dispatch) => dispatch.task_id === task.id && dispatch.adapter === this.service.dispatcher.name);
      if (existing?.status === "completed" && existing.result) {
        this.service.storage.completeJob(task.ventureId, job.id, task.id);
        return { ventureId: task.ventureId, jobId: job.id, taskId: task.id, dispatchId: existing.id, outcome: "idempotent-replay" };
      }
      const resolvedDispatchId =
        existing?.id ?? makeId("dispatch", { ventureId: task.ventureId, taskId: task.id, adapter: this.service.dispatcher.name });
      dispatchId = resolvedDispatchId;
      this.service.storage.createDispatch({
        ventureId: task.ventureId,
        id: resolvedDispatchId,
        taskId: task.id,
        adapter: this.service.dispatcher.name,
        ownerRole: task.ownerRole
      });
      this.service.storage.updateDispatch({ ventureId: task.ventureId, id: resolvedDispatchId, status: "running", startedAt: nowIso() });
      if (this.service.storage.isKilled(task.ventureId)) throw new KillSwitchError(`kill switch active immediately before dispatch for ${task.ventureId}`);
      const venture = this.service.storage.getVenture(task.ventureId);
      if (!venture?.pack) throw new Error(`pack missing for ${task.ventureId}`);
      const immediateGoalBlock = this.service.goalExecutionBlock(task);
      if (immediateGoalBlock) return this.haltForGoalChange(job.id, task, immediateGoalBlock, resolvedDispatchId);
      const result = await this.service.dispatcher.dispatch(task, {
        pack: venture.pack,
        receiptDestination: path.join(this.service.receiptRoot, new Date().toISOString().slice(0, 10), task.ventureId),
        forbiddenTerms: this.service.forbiddenTermsByVenture[task.ventureId] ?? [],
        dependencyReceipts
      });
      if (result.outcome !== "success") throw new Error(`dispatch outcome ${result.outcome}: ${result.summary}`);
      await this.service.validateEvaluationArtifactBytes(task);
      const receipt = await this.ingestDispatchReceipt(task, resolvedDispatchId, result, dependencyReceipts);
      this.service.storage.updateDispatch({
        ventureId: task.ventureId,
        id: resolvedDispatchId,
        status: "completed",
        externalTaskId: result.externalTaskId,
        ...(result.externalRunId ? { externalRunId: result.externalRunId } : {}),
        result,
        startedAt: result.startedAt,
        completedAt: result.completedAt
      });
      this.service.storage.completeJob(task.ventureId, job.id, task.id);
      this.service.storage.setMetric({
        ventureId: task.ventureId,
        id: "safe_specialist_outcomes",
        name: "Safe specialist outcomes",
        value: this.service.storage
          .listReceipts(task.ventureId)
          .filter((item) => this.service.isAuthoritativeCompletedDispatchReceipt(item)).length,
        unit: "count",
        status: "known",
        sourceRef: receipt.id,
        observedAt: result.completedAt
      });
      this.service.storage.addAuditEvent({
        ventureId: task.ventureId,
        id: makeId("audit", { action: "dispatch-completed", dispatchId: resolvedDispatchId }),
        eventType: "dispatch-completed",
        actor: result.ownerRole,
        entityType: "dispatch",
        entityId: resolvedDispatchId,
        payload: { externalTaskId: result.externalTaskId, externalRunId: result.externalRunId, receiptId: receipt.id },
        occurredAt: result.completedAt
      });
      return { ventureId: task.ventureId, jobId: job.id, taskId: task.id, dispatchId: resolvedDispatchId, receiptId: receipt.id, externalTaskId: result.externalTaskId, externalRunId: result.externalRunId, outcome: "success" };
    } catch (error) {
      const goalBlock = this.service.goalExecutionBlock(task);
      if (goalBlock) return this.haltForGoalChange(job.id, task, goalBlock, dispatchId);
      const attempts = job.attempt_count;
      const killed = error instanceof KillSwitchError;
      const deadLetter = killed || attempts >= task.maxAttempts;
      const retryAt = new Date(Date.now() + task.backoffMs * Math.max(1, 2 ** (attempts - 1))).toISOString();
      this.service.storage.failJob({
        ventureId: task.ventureId,
        jobId: job.id,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
        ...(deadLetter ? {} : { retryAt }),
        deadLetter
      });
      return { ventureId: task.ventureId, jobId: job.id, taskId: task.id, outcome: deadLetter ? "dead-letter" : "retry", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private haltForGoalChange(
    jobId: string,
    task: TaskDefinition,
    block: { disposition: Exclude<GoalTaskDisposition, "keep">; goalRevisionId: string; reason: string },
    dispatchId?: string
  ): Record<string, unknown> {
    const resolvedDispatchId =
      dispatchId ??
      this.service.storage
        .listDispatches(task.ventureId)
        .find(
          (dispatch) =>
            dispatch.task_id === task.id &&
            dispatch.adapter === this.service.dispatcher.name &&
            dispatch.status !== "completed"
        )?.id;
    this.service.storage.haltJobForGoalChange({
      ventureId: task.ventureId,
      jobId,
      taskId: task.id,
      disposition: block.disposition,
      reason: block.reason
    });
    if (resolvedDispatchId) {
      this.service.storage.updateDispatch({
        ventureId: task.ventureId,
        id: resolvedDispatchId,
        status: "blocked",
        completedAt: nowIso(),
        result: {
          outcome: "blocked-before-dispatch",
          goalRevisionId: block.goalRevisionId,
          disposition: block.disposition,
          reason: block.reason
        }
      });
    }
    this.service.storage.addAuditEvent({
      ventureId: task.ventureId,
      id: makeId("audit", {
        action: "task-goal-reconciliation-blocked",
        goalRevisionId: block.goalRevisionId,
        taskId: task.id,
        jobId
      }),
      eventType: "task-goal-reconciliation-blocked",
      actor: "company-launch-engine",
      entityType: "task",
      entityId: task.id,
      payload: {
        goalRevisionId: block.goalRevisionId,
        disposition: block.disposition,
        reason: block.reason,
        providerCancellationAttempted: false
      },
      occurredAt: nowIso()
    });
    return {
      ventureId: task.ventureId,
      jobId,
      taskId: task.id,
      ...(resolvedDispatchId ? { dispatchId: resolvedDispatchId } : {}),
      outcome: "goal-reconciliation-blocked",
      goalRevisionId: block.goalRevisionId,
      disposition: block.disposition,
      providerCancellationAttempted: false,
      reason: block.reason
    };
  }

  private async ingestDispatchReceipt(
    task: TaskDefinition,
    dispatchId: string,
    result: DispatchResult,
    dependencyReceipts: readonly Receipt[]
  ): Promise<Receipt> {
    if (task.taskKind !== "venture-play" && result.adapter === "fixture") {
      throw new EngineCommandError("receipt-origin-untrusted", "fixture dispatch cannot create evaluation scoring or review proof");
    }
    const proofTier = result.adapter === "fixture" ? "fixture-verified" : "internally-live";
    const evaluationMetadata = this.evaluationReceiptMetadata(task, result, dependencyReceipts);
    const machine = {
      receiptVersion: "1.0.0",
      ventureId: task.ventureId,
      taskId: task.id,
      dispatchId,
      proofTier,
      roleRuntime: result.adapter,
      externalTaskId: result.externalTaskId,
      externalRunId: result.externalRunId ?? null,
      ownerRole: result.ownerRole,
      outcome: result.outcome,
      summary: result.summary,
      citations: result.citations,
      specialistOutput: result.metadata,
      ...(task.evaluationBinding
        ? {
            evaluationBinding: task.evaluationBinding,
            evaluationBindingHash: task.evaluationBindingHash,
            evaluationResult: evaluationMetadata.evaluationResult
          }
        : {}),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      safety: {
        externalSends: 0,
        publicPosts: 0,
        moneyMovements: 0,
        credentialMutations: 0,
        clientSystemMutations: 0,
        schedulesCreated: 0,
        productRepoWrites: 0
      }
    };
    const receiptId = makeId("receipt", machine);
    const written = await this.service.receiptWriter.write({
      ventureId: task.ventureId,
      receiptId,
      occurredAt: result.completedAt,
      machine,
      markdown: `# ${task.purpose}\n\nProof tier: \`${proofTier}\`\n\n${result.summary}\n\n## Citations\n\n${result.citations.map((url) => `- ${url}`).join("\n")}\n\nNo send, post, money, credential, client-system, schedule, or product-repo mutation occurred.\n`
    });
    const receipt = ReceiptSchema.parse({
      id: receiptId,
      ventureId: task.ventureId,
      taskId: task.id,
      dispatchId,
      proofTier,
      outcome: "success",
      actor: result.ownerRole,
      adapter: result.adapter,
      artifactPath: written.jsonPath,
      contentHash: written.contentHash,
      occurredAt: result.completedAt,
      metadata: {
        markdownPath: written.markdownPath,
        citations: result.citations,
        externalTaskId: result.externalTaskId,
        externalRunId: result.externalRunId ?? null,
        ...evaluationMetadata,
        ...(task.taskKind === "venture-play" ? {} : { specialistOutput: result.metadata })
      },
      origin: result.adapter === "fixture" ? "fixture" : "dispatch"
    });
    const evidence: EvidenceItem = {
      id: makeId("evidence", { ventureId: task.ventureId, taskId: task.id, receiptId }),
      ventureId: task.ventureId,
      type:
        task.taskKind === "evaluation-scoring"
          ? "evaluation-scoring-outcome"
          : task.taskKind === "evaluation-review"
            ? "evaluation-review-outcome"
            : "safe-specialist-outcome",
      proofTier,
      authority: result.adapter === "fixture" ? "fixture" : "engine",
      sourceRef: receiptId,
      observedAt: result.completedAt,
      status: "current",
      contentHash: written.contentHash,
      metadata: { taskId: task.id, dispatchId, externalTaskId: result.externalTaskId, citations: result.citations, fixture: result.adapter === "fixture" }
    };
    const evidenceItems: EvidenceItem[] = [evidence];
    if (task.taskKind === "evaluation-scoring" && task.evaluationBinding) {
      const evaluation = this.service.storage.getEvaluationContract(task.ventureId, task.evaluationBinding.evaluationContractId);
      if (!evaluation) throw new EngineCommandError("evaluation-not-found", "scoring evidence references a missing contract");
      const hardGateProofs = Array.isArray(evaluationMetadata.hardGateProofs)
        ? (evaluationMetadata.hardGateProofs as Array<{
            hardGateId: string;
            evidenceId: string;
            passed: boolean;
            reason: string;
            supportingRefs: string[];
          }>)
        : [];
      for (const proof of hardGateProofs) {
        const gate = evaluation.hardGates.find((item) => item.id === proof.hardGateId);
        if (!gate) throw new EngineCommandError("hard-gate-mismatch", `scoring proof references unfrozen gate ${proof.hardGateId}`);
        const metadata = {
          hardGateId: gate.id,
          evaluationContractId: evaluation.id,
          evaluationContractHash: evaluation.canonicalHash,
          candidateVersion: task.evaluationBinding.candidateVersion,
          candidateArtifactHash: task.evaluationBinding.candidateArtifactHash,
          evidenceRequirementHash: sha256(gate.evidenceRequirement),
          passed: proof.passed,
          reason: proof.reason,
          supportingRefs: proof.supportingRefs,
          scoringReceiptId: receipt.id,
          scoringReceiptContentHash: receipt.contentHash,
          engineStamped: true
        };
        evidenceItems.push({
          id: proof.evidenceId,
          ventureId: task.ventureId,
          type: "evaluation-hard-gate-proof",
          proofTier,
          authority: "engine",
          sourceRef: receipt.id,
          observedAt: result.completedAt,
          status: "current",
          contentHash: sha256(metadata),
          metadata
        });
      }
    }
    this.service.storage.transaction(() => {
      this.service.storage.attachReceipt(receipt);
      for (const item of evidenceItems) this.service.storage.addEvidence(item);
    });
    return receipt;
  }

  private evaluationReceiptMetadata(
    task: TaskDefinition,
    result: DispatchResult,
    dependencyReceipts: readonly Receipt[]
  ): Record<string, unknown> {
    if (task.taskKind === "venture-play") return evaluationBindingFromTask(task);
    if (!task.evaluationBinding || !task.evaluationBindingHash) {
      throw new EngineCommandError("dispatch-evaluation-binding-missing", "evaluation receipt lacks a typed task binding");
    }
    const evaluation = this.service.storage.getEvaluationContract(task.ventureId, task.evaluationBinding.evaluationContractId);
    if (!evaluation) throw new EngineCommandError("evaluation-not-found", "evaluation receipt references a missing contract");
    const startedAtMs = Date.parse(result.startedAt);
    const completedAtMs = Date.parse(result.completedAt);
    if (
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(completedAtMs) ||
      completedAtMs < startedAtMs ||
      completedAtMs > Date.now() + 5_000 ||
      startedAtMs < Date.parse(evaluation.observationWindow.startsAt) ||
      completedAtMs > Date.parse(evaluation.observationWindow.endsAt)
    ) {
      throw new EngineCommandError("dispatch-time-invalid", "evaluation dispatch timestamps must be ordered, current, and inside the frozen window");
    }
    const common = {
      ...evaluationBindingFromTask(task),
      dispatchStartedAt: result.startedAt,
      dispatchCompletedAt: result.completedAt,
      elapsedMs: completedAtMs - startedAtMs,
      providerCostCents: optionalDispatchNumber(result.metadata, "providerCostCents"),
      modelCostCents: optionalDispatchNumber(result.metadata, "modelCostCents"),
      founderMinutes: optionalDispatchNumber(result.metadata, "founderMinutes"),
      reviewerMinutes: optionalDispatchNumber(result.metadata, "reviewerMinutes"),
      trustModel: "single-operator-local",
      customerSafe: false
    };
    if (task.taskKind === "evaluation-scoring") {
      const output = EvaluationScoringOutputSchema.parse(result.metadata.evaluationResult);
      if (output.baselineValue !== evaluation.baseline.primaryMetricValue) {
        throw new EngineCommandError("baseline-value-mismatch", "scoring output changed the frozen baseline value");
      }
      if (evaluation.evaluationPopulation.kind !== "authoritative-system") {
        const caseRefs = output.caseResults.map((item) => item.caseRef);
        if (!sameIds(caseRefs, evaluation.evaluationPopulation.caseRefs) || output.sampleSize !== caseRefs.length) {
          throw new EngineCommandError("sample-population-mismatch", "scoring output does not cover the exact frozen case population");
        }
      }
      if (!sameIds(output.hardGateResults.map((item) => item.hardGateId), evaluation.hardGates.map((item) => item.id))) {
        throw new EngineCommandError("hard-gate-mismatch", "scoring output does not evaluate every frozen hard gate exactly once");
      }
      const manifest = EvaluationInputManifestSchema.parse(task.actionBounds.evaluationInputManifest);
      const allowedSupportingRefs = new Set([
        ...manifest.population.cases.map((item) => item.caseRef),
        ...manifest.baseline.receipts.map((receipt) => receipt.id),
        ...task.sourceRefs
      ]);
      const inventedCaseEvidenceRef = output.caseResults
        .flatMap((item) => item.evidenceRefs)
        .find((evidenceId) => !allowedSupportingRefs.has(evidenceId));
      if (inventedCaseEvidenceRef) {
        throw new EngineCommandError(
          "case-evidence-ref-unfrozen",
          `scoring case result cites a reference outside the frozen evaluator inputs: ${inventedCaseEvidenceRef}`
        );
      }
      const unprovedScoredCase = output.caseResults.find(
        (item) => !item.abstained && !item.evidenceRefs.includes(item.caseRef)
      );
      if (unprovedScoredCase) {
        throw new EngineCommandError(
          "case-evidence-ref-missing",
          `non-abstained case ${unprovedScoredCase.caseRef} must cite its exact frozen case reference`
        );
      }
      if (output.sampleSize === 0 && output.candidateValue !== evaluation.primaryMetric.abstentionScore) {
        throw new EngineCommandError(
          "all-abstain-score-invalid",
          "an all-abstain evaluation must use the frozen abstention score and cannot report a high candidate value"
        );
      }
      const inventedSupportingRef = output.hardGateResults
        .flatMap((item) => item.evidenceIds)
        .find((evidenceId) => !allowedSupportingRefs.has(evidenceId));
      if (inventedSupportingRef) {
        throw new EngineCommandError(
          "hard-gate-supporting-ref-unfrozen",
          `scoring hard-gate proof cites a reference outside the frozen evaluator inputs: ${inventedSupportingRef}`
        );
      }
      const hardGateProofs = output.hardGateResults.map((item) => ({
        hardGateId: item.hardGateId,
        evidenceId: makeId("evidence", {
          kind: "evaluation-hard-gate-proof",
          ventureId: task.ventureId,
          taskId: task.id,
          evaluationBindingHash: task.evaluationBindingHash,
          hardGateId: item.hardGateId
        }),
        passed: item.passed,
        reason: item.reason,
        supportingRefs: item.evidenceIds
      }));
      return {
        ...common,
        receiptType: "scoring",
        engineStamped: true,
        networkAccessPolicy: "forbidden",
        networkIsolation: "not-mechanically-verified",
        promotionEligibility: "blocked-pending-network-isolation-proof",
        evaluationResult: output,
        metricId: task.evaluationBinding.primaryMetricId,
        formulaHash: task.evaluationBinding.formulaHash,
        populationHash: task.evaluationBinding.populationHash,
        baselineValue: output.baselineValue,
        candidateValue: output.candidateValue,
        sampleSize: output.sampleSize,
        candidateComplexityUnits: output.candidateComplexityUnits,
        otherCostCents: output.otherCostCents,
        leakageDetected: output.leakageDetected,
        hardGateProofs,
        experimentHardGateResults: hardGateProofs.map((proof) => ({
          hardGateId: proof.hardGateId,
          passed: proof.passed,
          evidenceIds: [proof.evidenceId],
          reason: proof.reason
        }))
      };
    }
    const output = EvaluationReviewOutputSchema.parse(result.metadata.evaluationResult);
    const scoringReceipt = dependencyReceipts.find(
      (receipt) =>
        receipt.origin === "dispatch" &&
        receipt.taskId === task.dependencies[0] &&
        receipt.metadata.receiptType === "scoring" &&
        receipt.metadata.evaluationBindingHash === task.evaluationBindingHash
    );
    if (!scoringReceipt) {
      throw new EngineCommandError("review-scoring-receipt-missing", "review output has no exact engine-bound scoring receipt");
    }
    if (
      output.scoringMatches &&
      (output.reproducedCandidateValue !== scoringReceipt.metadata.candidateValue ||
        output.reproducedSampleSize !== scoringReceipt.metadata.sampleSize)
    ) {
      throw new EngineCommandError("review-score-mismatch", "review claimed a match but did not reproduce the scored value and sample");
    }
    const scoringOutput = EvaluationScoringOutputSchema.parse(scoringReceipt.metadata.evaluationResult);
    const scoringHardGatesPassed = scoringOutput.hardGateResults.every((item) => item.passed);
    if (output.hardGatesPassed !== scoringHardGatesPassed) {
      throw new EngineCommandError(
        "review-hard-gate-mismatch",
        "review hard-gate verdict does not match the exact engine-bound scoring receipt"
      );
    }
    if (output.leakageDetected !== scoringOutput.leakageDetected) {
      throw new EngineCommandError(
        "review-leakage-mismatch",
        "review leakage verdict does not match the exact engine-bound scoring receipt"
      );
    }
    return {
      ...common,
      receiptType: "reviewer",
      engineStamped: true,
      networkAccessPolicy: "forbidden",
      networkIsolation: "not-mechanically-verified",
      promotionEligibility: "blocked-pending-network-isolation-proof",
      evaluationResult: output,
      reviewerId: task.evaluationBinding.reviewerId,
      verdict: output.verdict,
      reviewedScoringReceiptId: scoringReceipt.id,
      reviewedScoringContentHash: scoringReceipt.contentHash,
      scoringMatches: output.scoringMatches,
      hardGatesPassed: output.hardGatesPassed,
      leakageDetected: output.leakageDetected
    };
  }
}

export interface DefaultRuntimeOptions {
  root?: string;
  databasePath?: string;
  dispatcher?: "hermes" | "fixture";
  fixtureBehavior?: "success" | "fail-once" | "timeout" | "blocked";
  fetchImpl?: typeof fetch;
  context?: ExecutionContext;
  ceoExecutor?: CeoExecutor;
  initiativeExecutor?: InitiativeExecutor;
  distributionMode?: CompanyDistributionMode;
}

export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): {
  service: EngineService;
  worker: EngineWorker;
  initiativeWorker: CompanyInitiativeWorker;
  goldenWorker?: GoldenCompanyWorker;
  autonomy: CompanyAutonomy;
  storage: EngineStorage;
} {
  const root = options.root ?? process.env.ENGINE_ROOT ?? findEngineRoot(process.cwd());
  const databasePath = options.databasePath ?? process.env.ENGINE_DB_PATH ?? path.join(root, "data", "engine.db");
  const storage = new EngineStorage(databasePath);
  const sourceAdapter = new ReadOnlySourceAdapter(
    process.env.ENGINE_SOURCE_ROOTS_JSON
      ? parseStringListMap(process.env.ENGINE_SOURCE_ROOTS_JSON, "ENGINE_SOURCE_ROOTS_JSON")
      : {},
    options.fetchImpl ?? fetch
  );
  const legacyDispatcher = options.dispatcher ?? process.env.ENGINE_DISPATCH_ADAPTER;
  const dispatcher =
    legacyDispatcher === "fixture"
      ? new FixtureDispatcher(options.fixtureBehavior ?? "success")
      : legacyDispatcher === "hermes"
        ? new HermesKanbanDispatcher({
          hermesPath: process.env.HERMES_PATH ?? "hermes",
          board: process.env.HERMES_KANBAN_BOARD ?? "default",
          allowedRoles: ["scout", "orbit"]
        })
        : new UnconfiguredRoleDispatcher();
  const receiptRoot = path.join(root, "receipts");
  const receiptWriter = new FileReceiptAdapter(receiptRoot);
  const context = options.context ?? localExecutionContext();
  const webSearchCost = process.env.OPENAI_WEB_SEARCH_COST_CENTS;
  const tariff = {
    ...DEFAULT_OPENAI_TARIFF,
    ...(webSearchCost ? { webSearchCostCents: parseNonnegativeInteger(webSearchCost, "OPENAI_WEB_SEARCH_COST_CENTS") } : {})
  };
  const openAIAdapter = process.env.OPENAI_API_KEY
    ? new OpenAIResponsesAdapter(process.env.OPENAI_API_KEY, {
        model: process.env.OPENAI_CEO_MODEL ?? "gpt-5.6-terra",
        maxOutputTokens: DEFAULT_OPENAI_TARIFF.maxOutputTokens,
        safetyIdentifier: `opspot-gtm-${context.workspaceId}`,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
      })
    : undefined;
  const ceoExecutor =
    options.ceoExecutor ??
    (openAIAdapter
      ? new OpenAICeoExecutor(
          openAIAdapter,
          tariff,
          { model: process.env.OPENAI_CEO_MODEL ?? "gpt-5.6-terra" }
        )
      : new UnconfiguredCeoExecutor());
  const initiativeExecutor =
    options.initiativeExecutor
    ?? (openAIAdapter
      ? new OpenAIInitiativeExecutor(openAIAdapter, tariff, { model: process.env.OPENAI_INITIATIVE_MODEL ?? "gpt-5.6-terra" })
      : new UnconfiguredInitiativeExecutor());
  const kernelStorage = new SqliteKernelStorage(storage);
  const autonomy = new CompanyAutonomy({
    storage: kernelStorage,
    executor: ceoExecutor,
    distributionMode: options.distributionMode ?? "local",
    initiativeTaskBinding: ({ company, task, evidence }) => {
      try {
        const reservationCents = initiativeExecutor.estimateExecutionReservation({ company, task, evidence });
        return reservationCents > 0 ? { provider: initiativeExecutor.provider, reservationCents } : undefined;
      } catch {
        return undefined;
      }
    },
    materializePack: ({ workspaceId, pack, bootstrapDigest, createdAt }) => {
      storage.upsertPack({
        pack,
        workspaceId,
        canonicalHash: sha256(pack),
        canonicalJson: canonicalize(pack),
        sourcePath: `engine://company/${pack.venture.id}/bootstrap/${bootstrapDigest}`,
        revisionId: makeId("packrev", { ventureId: pack.venture.id, bootstrapDigest }),
        createdAt
      });
    }
  });
  const service = new EngineService({
    storage,
    autonomy,
    sourceAdapter,
    dispatcher,
    receiptWriter,
    venturesRoot: path.join(root, "ventures"),
    receiptRoot,
    dashboardUrl: process.env.ENGINE_DASHBOARD_URL ?? "http://127.0.0.1:3210",
    forbiddenTermsByVenture: process.env.ENGINE_FORBIDDEN_TERMS_JSON
      ? parseStringListMap(process.env.ENGINE_FORBIDDEN_TERMS_JSON, "ENGINE_FORBIDDEN_TERMS_JSON")
      : {},
    context
  });
  const goldenExecutors: GoldenExecutionExecutor[] = [];
  const resendValues = [process.env.RESEND_API_KEY, process.env.RESEND_ACQUISITION_FROM, process.env.RESEND_ACQUISITION_TO, process.env.RESEND_OWNED_INBOUND_RECIPIENT];
  if (resendValues.some(Boolean) && !resendValues.every(Boolean)) {
    throw new Error("local Resend execution requires API key, sender, owned recipient, and owned reply recipient together");
  }
  if (resendValues.every(Boolean)) {
    goldenExecutors.push(new ResendGoldenExecutionExecutor(
      new ResendEmailAdapter(resendValues[0]!, options.fetchImpl ?? fetch),
      { sender: resendValues[1]!, ownedRecipient: resendValues[2]!, ownedReplyRecipient: resendValues[3]! }
    ));
  }
  const offerValues = [process.env.PUBLIC_OFFER_SLUG_KEY, process.env.PUBLIC_OFFER_SLUG_KEY_ID];
  if (offerValues.some(Boolean) && !offerValues.every(Boolean)) throw new Error("local public offer slug key and key id are required together");
  if (offerValues.every(Boolean)) {
    const key = Buffer.from(offerValues[0]!, "base64url");
    if (key.byteLength !== 32) throw new Error("PUBLIC_OFFER_SLUG_KEY must decode to exactly 32 bytes");
    goldenExecutors.push(new PublicAssetGoldenExecutionExecutor(kernelStorage, key, offerValues[1]!));
  }
  const goldenWorker = goldenExecutors.length ? new GoldenCompanyWorker(kernelStorage, goldenExecutors) : undefined;
  return {
    service,
    worker: new EngineWorker(service),
    initiativeWorker: new CompanyInitiativeWorker(kernelStorage, initiativeExecutor),
    ...(goldenWorker ? { goldenWorker } : {}),
    autonomy,
    storage
  };
}

class UnconfiguredRoleDispatcher implements RoleDispatcher {
  readonly name = "unconfigured";

  supportsRole(): boolean {
    return false;
  }

  async dispatch(): Promise<never> {
    throw new Error("legacy role dispatch is not configured; use the built-in company initiative worker or explicitly configure Hermes");
  }
}

export function findEngineRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml")) && existsSync(path.join(current, "packages", "domain", "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`could not resolve Company Launch Engine root from ${start}`);
    current = parent;
  }
}

function parseNonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer number of cents`);
  return parsed;
}

function parseStringListMap(value: string, name: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON object of string arrays`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of string arrays`);
  }
  const result: Record<string, string[]> = {};
  for (const [key, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error(`${name}.${key} must be an array of non-empty strings`);
    }
    result[key] = entries;
  }
  return result;
}

function immutableInputMatches(record: Record<string, unknown>, input: Record<string, unknown>): boolean {
  const recordedInput = Object.fromEntries(Object.keys(input).map((key) => [key, record[key]]));
  return sha256(recordedInput) === sha256(input);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function knownTotalCost(costs: {
  providerCostCents: number | null;
  modelCostCents: number | null;
  otherCostCents: number | null;
}): number | null {
  if (costs.providerCostCents === null || costs.modelCostCents === null || costs.otherCostCents === null) return null;
  return costs.providerCostCents + costs.modelCostCents + costs.otherCostCents;
}

function receiptTypeCanBeMissing(receiptType: string, missingOutputs: ReadonlySet<string>): boolean {
  const normalized = receiptType.trim().toLowerCase();
  if (normalized === "scoring") return missingOutputs.has("primaryMetricResult");
  if (normalized === "reviewer" || normalized === "review") return missingOutputs.has("reviewer");
  if (normalized === "provider" || normalized === "attempt") {
    return (
      missingOutputs.has("attempts") ||
      missingOutputs.has("attempts.receipts") ||
      missingOutputs.has("outcomeReceiptId")
    );
  }
  if (normalized === "gate-proof" || normalized === "hard-gate") return missingOutputs.has("hardGateResults");
  return false;
}

function evaluationBindingFromTask(task: TaskDefinition): Record<string, unknown> {
  if (task.evaluationBinding && task.evaluationBindingHash) {
    return {
      evaluationBinding: task.evaluationBinding,
      evaluationBindingHash: task.evaluationBindingHash,
      evaluationContractId: task.evaluationBinding.evaluationContractId,
      evaluationContractHash: task.evaluationBinding.evaluationContractHash,
      skillVersionId: task.evaluationBinding.skillVersionId,
      skillVersionHash: task.evaluationBinding.skillVersionHash,
      candidateVersion: task.evaluationBinding.candidateVersion,
      candidateArtifactHash: task.evaluationBinding.candidateArtifactHash,
      metricId: task.evaluationBinding.primaryMetricId,
      primaryMetricHash: task.evaluationBinding.primaryMetricHash,
      formulaHash: task.evaluationBinding.formulaHash,
      populationHash: task.evaluationBinding.populationHash,
      inputManifestHash: task.evaluationBinding.inputManifestHash,
      hardGatesHash: task.evaluationBinding.hardGatesHash,
      promotionRuleHash: task.evaluationBinding.promotionRuleHash
    };
  }
  const binding: Record<string, unknown> = {};
  for (const key of ["evaluationContractId", "evaluationContractHash", "candidateVersion", "candidateArtifactHash"] as const) {
    const value = task.actionBounds[key];
    if (typeof value === "string") binding[key] = value;
  }
  return binding;
}

function percentageIncrease(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((candidate - baseline) / Math.abs(baseline)) * 100;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return sha256([...new Set(left)].sort()) === sha256([...new Set(right)].sort());
}

function semanticEquals(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sha256(left) === sha256(right);
}

function optionalDispatchNumber(metadata: Record<string, unknown>, key: string): number | null {
  const candidates = [metadata, metadata.costs, metadata.runMetadata].filter(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
  );
  for (const candidate of candidates) {
    const value = candidate[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function isBoundedRasterArtifact(extension: string, bytes: Uint8Array): boolean {
  if (
    extension === ".png" &&
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) {
    return true;
  }
  if ((extension === ".jpg" || extension === ".jpeg") && bytes.length >= 3) {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === ".webp" && bytes.length >= 12) {
    return Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  }
  return false;
}

function comparePromotionRecency(
  left: { createdAt: string; revision: number; id: string },
  right: { createdAt: string; revision: number; id: string }
): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.revision - left.revision ||
    right.id.localeCompare(left.id)
  );
}

function comparableOutcomeDefinitionHash(evaluation: EvaluationContract): string {
  const primaryMetric: Record<string, unknown> = { ...evaluation.primaryMetric };
  delete primaryMetric.authoritativeSourceRef;
  return sha256({
    primaryMetric,
    hardGates: [...evaluation.hardGates].sort((left, right) => left.id.localeCompare(right.id)),
    populationProtocol: {
      kind: evaluation.evaluationPopulation.kind,
      minimumSampleSize: evaluation.evaluationPopulation.minimumSampleSize
    },
    expectedReceiptTypes: [...evaluation.expectedReceiptTypes].sort(),
    promotionRule: evaluation.promotionRule
  });
}

function evaluateTransition(request: TransitionRequest, currentState: LifecycleState, evidence: EvidenceItem[]): { allowed: boolean; reason: string } {
  if (request.expectedState !== currentState) return { allowed: false, reason: `expected state ${request.expectedState} does not match current state ${currentState}` };
  if (!lifecycleEdges[currentState].includes(request.targetState)) return { allowed: false, reason: `transition ${currentState} -> ${request.targetState} is not allowed` };
  const providedIds = new Set(evidence.map((item) => item.id));
  const unknownId = request.evidenceIds.find((id) => !providedIds.has(id));
  if (unknownId) return { allowed: false, reason: `evidence ${unknownId} is absent or belongs to another venture` };
  const required = transitionEvidence[request.targetState] ?? [];
  for (const type of required) {
    const candidates = evidence.filter((item) => item.type === type);
    if (!candidates.length) return { allowed: false, reason: `missing required evidence type: ${type}` };
    const invalid = candidates.find(
      (item) => item.status !== "current" || (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now())
    );
    if (invalid) return { allowed: false, reason: `evidence ${invalid.id} is ${invalid.status}${invalid.expiresAt ? " or expired" : ""}` };
    if (type === "authoritative-payment-collected") {
      const valid = candidates.some((item) => item.authority === "payment" && item.proofTier === "revenue-verified" && item.metadata.fixture !== true);
      if (!valid) return { allowed: false, reason: "revenue requires a non-fixture authoritative payment event" };
    }
    if (type === "authoritative-fulfillment-delivered") {
      const valid = candidates.some((item) => item.authority === "fulfillment" && item.proofTier === "fulfillment-verified" && item.metadata.fixture !== true);
      if (!valid) return { allowed: false, reason: "fulfillment requires a non-fixture authoritative delivery event" };
    }
  }
  return { allowed: true, reason: `all ${required.length} required evidence types are current and venture-scoped` };
}

function recommendPosture(state: LifecycleState, gaps: Array<{ group: string; reason: string }>): Record<string, unknown> {
  const severe = gaps.filter((gap) => ["missing", "conflicting", "unavailable"].includes(gap.reason));
  if (state === "killed" || state === "parked") return { posture: state, automatic: false, reason: `venture is explicitly ${state}` };
  if (severe.length > 0) return { posture: "continue-validation", automatic: false, reason: `${severe.length} blocking proof gaps remain` };
  return { posture: state === "fulfillment-verified" ? "consider-scaling" : "continue", automatic: false, reason: "no hard gap justifies an automatic destructive action" };
}

export class EngineCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineCommandError";
  }
}

class KillSwitchError extends Error {}

export type { LoadedPack };
