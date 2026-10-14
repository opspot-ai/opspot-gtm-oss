import {
  DecisionTraceSchema,
  GoalChangeImpactSchema,
  GoalRevisionSchema,
  makeId,
  sha256,
  type DecisionTrace,
  type GoalChangeImpact,
  type GoalChangeInput,
  type GoalConfirmChangeInput,
  type GoalRevision,
  type GoalTaskBinding,
  type GoalTaskReconciliation,
  type InitiativeCandidate,
  type InitiativeCandidateAssessment,
  type InitiativeDecisionInput,
  type LifecycleState,
  type ReadinessGap,
  type TaskStatus
} from "@opspot/contracts";

export interface GoalPreviewTask {
  taskId: string;
  purpose: string;
  status: TaskStatus;
  actionDigest: string;
  goalTaskBinding?: GoalTaskBinding;
}

export interface GoalPreviewSnapshot {
  evidenceCount: number;
  taskCount: number;
  receiptCount: number;
  lifecycleState: LifecycleState;
  packRevisionId: string;
  tasks: GoalPreviewTask[];
  readinessGaps: ReadinessGap[];
}

export interface GoalChangePreview {
  previewId: string;
  previewHash: string;
  ventureId: string;
  expectedGoalRevisionId: string | null;
  currentGoalRevisionId: string | null;
  destination: GoalChangeInput["destination"];
  customDestination: string | null;
  target: string;
  horizon: string;
  confirmationRequired: true;
  impact: GoalChangeImpact;
}

const NONTERMINAL_TASK_STATUSES = new Set<TaskStatus>(["planned", "blocked", "ready", "queued", "running"]);

export function goalDefinitionSemantic(input: GoalChangeInput | GoalConfirmChangeInput | GoalRevision): Record<string, unknown> {
  return {
    ventureId: input.ventureId,
    destination: input.destination,
    customDestination: input.customDestination ?? null,
    target: input.target,
    horizon: input.horizon,
    constraints: [...input.constraints].sort(),
    successConditions: [...input.successConditions].sort(),
    killConditions: [...input.killConditions].sort()
  };
}

export function goalMateriallyChanges(
  input: GoalChangeInput | GoalConfirmChangeInput,
  current: GoalRevision | undefined
): boolean {
  return !current || sha256(goalDefinitionSemantic(input)) !== sha256(goalDefinitionSemantic(current));
}

export function reconcileGoalTasks(
  tasks: readonly GoalPreviewTask[],
  materialGoalChange: boolean,
  previousReconciliation: readonly GoalTaskReconciliation[] = []
): GoalTaskReconciliation[] {
  const previousByTaskId = new Map(previousReconciliation.map((item) => [item.taskId, item]));
  return tasks
    .filter((task) => NONTERMINAL_TASK_STATUSES.has(task.status))
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => {
      const base = {
        taskId: task.taskId,
        purpose: task.purpose,
        taskStatus: task.status,
        taskActionDigest: task.actionDigest,
        ...(task.goalTaskBinding ? { goalTaskBinding: task.goalTaskBinding } : {})
      };
      if (!materialGoalChange) {
        const previous = previousByTaskId.get(task.taskId);
        if (previous && previous.disposition !== "keep") {
          if (task.status === "running") {
            return {
              ...base,
              disposition: "defer" as const,
              ruleCode: "defer-active-work" as const,
              reason: "The running lease may finish, but it is deferred from any retry under the confirmed reconciliation.",
              executionBlocked: true
            };
          }
          return {
            ...base,
            disposition: previous.disposition,
            ruleCode: previous.ruleCode,
            reason: previous.reason,
            executionBlocked: true
          };
        }
        return {
          ...base,
          disposition: "keep" as const,
          ruleCode: "goal-semantics-unchanged" as const,
          reason: "The structured goal definition is unchanged.",
          executionBlocked: false
        };
      }
      if (task.goalTaskBinding?.scope === "goal-independent") {
        return {
          ...base,
          disposition: "keep" as const,
          ruleCode: "goal-independent" as const,
          reason: "The task is explicitly structured as goal-independent.",
          executionBlocked: false
        };
      }
      if (task.status === "running") {
        return {
          ...base,
          disposition: "defer" as const,
          ruleCode: "defer-active-work" as const,
          reason: "The running lease may finish, but it is deferred from any retry under the changed goal.",
          executionBlocked: true
        };
      }
      if (task.goalTaskBinding?.onMaterialChange === "cancel") {
        return {
          ...base,
          disposition: "cancel" as const,
          ruleCode: "explicit-cancel-on-change" as const,
          reason: "The task binding explicitly selects cancellation after a material goal change.",
          executionBlocked: true
        };
      }
      if (task.goalTaskBinding?.onMaterialChange === "defer") {
        return {
          ...base,
          disposition: "defer" as const,
          ruleCode: "explicit-defer-on-change" as const,
          reason: "The task binding explicitly defers execution after a material goal change.",
          executionBlocked: true
        };
      }
      if (task.status === "queued" || task.status === "blocked") {
        return {
          ...base,
          disposition: "defer" as const,
          ruleCode: "defer-active-work" as const,
          reason: "Active or gated work is deferred for reconciliation; an existing running lease may finish but cannot retry.",
          executionBlocked: true
        };
      }
      return {
        ...base,
        disposition: "revise" as const,
        ruleCode: "revise-before-dispatch" as const,
        reason: "Planned work must be revised against the newly confirmed goal before dispatch.",
        executionBlocked: true
      };
    });
}

export function goalChangeSemanticInput(input: GoalChangeInput | GoalConfirmChangeInput): Record<string, unknown> {
  return {
    ventureId: input.ventureId,
    destination: input.destination,
    customDestination: input.customDestination ?? null,
    target: input.target,
    horizon: input.horizon,
    constraints: [...input.constraints],
    successConditions: [...input.successConditions],
    killConditions: [...input.killConditions],
    reason: input.reason,
    expectedGoalRevisionId: input.expectedGoalRevisionId ?? null,
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt
  };
}

export function buildGoalPreview(
  input: GoalChangeInput,
  current: GoalRevision | undefined,
  snapshot: GoalPreviewSnapshot
): GoalChangePreview {
  const semanticInput = goalChangeSemanticInput(input);
  const materialGoalChange = goalMateriallyChanges(input, current);
  const taskReconciliation = reconcileGoalTasks(
    snapshot.tasks,
    materialGoalChange,
    current?.changeImpact?.taskReconciliation ?? []
  );
  const gapItems = snapshot.readinessGaps
    .map((gap) => ({
      group: gap.group,
      field: gap.field,
      reason: gap.reason,
      sourceRefs: [...gap.sourceRefs].sort(),
      blockingStates: [...gap.blockingStates].sort()
    }))
    .sort((left, right) =>
      `${left.group}:${left.field}:${left.reason}:${sha256(left)}`.localeCompare(
        `${right.group}:${right.field}:${right.reason}:${sha256(right)}`
      )
    );
  const gapSnapshot = {
    items: gapItems,
    gapCount: gapItems.length,
    canonicalHash: sha256(gapItems)
  };
  const taskReconciliationHash = sha256(taskReconciliation);
  const destinationChanged =
    !current ||
    current.destination !== input.destination ||
    (current.customDestination ?? null) !== (input.customDestination ?? null);
  const impact = GoalChangeImpactSchema.parse({
    evidenceCount: snapshot.evidenceCount,
    taskCount: snapshot.taskCount,
    activeTaskCount: taskReconciliation.length,
    receiptCount: snapshot.receiptCount,
    lifecycleState: snapshot.lifecycleState,
    materialGoalChange,
    destinationChanged,
    roadmapRecalculationRequired: materialGoalChange,
    evidencePreserved: true,
    tasksPreserved: true,
    receiptsPreserved: true,
    activeWorkAutomaticallyCancelled: false,
    taskReconciliation,
    taskReconciliationHash,
    gapSnapshot,
    roadmap: {
      state: materialGoalChange ? "recalculation-required" : "unchanged",
      reasonCode: materialGoalChange ? "goal-semantics-changed" : "goal-semantics-unchanged",
      packRevisionId: snapshot.packRevisionId,
      gapSnapshotHash: gapSnapshot.canonicalHash,
      taskReconciliationHash
    }
  });
  const previewHash = sha256({ semanticInput, currentGoalRevisionId: current?.id ?? null, impact });
  return {
    previewId: makeId("goalpreview", { ventureId: input.ventureId, previewHash }),
    previewHash,
    ventureId: input.ventureId,
    expectedGoalRevisionId: input.expectedGoalRevisionId ?? null,
    currentGoalRevisionId: current?.id ?? null,
    destination: input.destination,
    customDestination: input.customDestination ?? null,
    target: input.target,
    horizon: input.horizon,
    confirmationRequired: true,
    impact
  };
}

export function buildGoalRevision(
  input: GoalConfirmChangeInput,
  preview: GoalChangePreview,
  current: GoalRevision | undefined,
  revision: number,
  createdAt: string
): GoalRevision {
  const semantic = {
    revision,
    ...goalChangeSemanticInput(input),
    founderConfirmation: input.founderConfirmation,
    supersedesGoalRevisionId: current?.id ?? null,
    changeImpact: preview.impact
  };
  const canonicalHash = sha256(semantic);
  return GoalRevisionSchema.parse({
    id: makeId("goal", { ventureId: input.ventureId, canonicalHash }),
    revision,
    ...input,
    changeImpact: preview.impact,
    ...(current ? { supersedesGoalRevisionId: current.id } : {}),
    createdAt,
    canonicalHash
  });
}

export interface DecisionContext {
  knownEvidenceIds: Set<string>;
  evaluatorContractExists: boolean;
  createdAt: string;
}

export function buildDecisionTrace(input: InitiativeDecisionInput, context: DecisionContext): DecisionTrace {
  const candidates = [...input.candidates].sort((left, right) => left.id.localeCompare(right.id));
  const assessments = candidates.map((candidate) => assessCandidate(candidate, input, context));
  const eligible = assessments.filter((assessment) => assessment.eligible);
  const evaluatedReady = input.selectionMode !== "evaluated" || context.evaluatorContractExists;
  const selectedAssessment = evaluatedReady
    ? input.selectionMode === "evaluated"
      ? [...eligible].sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.candidateId.localeCompare(right.candidateId))[0]
      : eligible[0]
    : undefined;
  const selectedCandidate = selectedAssessment
    ? candidates.find((candidate) => candidate.id === selectedAssessment.candidateId)
    : undefined;
  const abstain = !input.goalRevisionId || candidates.length === 0 || !selectedCandidate || !evaluatedReady;
  const abstainReason = !input.goalRevisionId
    ? "no confirmed goal revision exists"
    : candidates.length === 0
      ? "no initiative candidates were supplied"
      : !evaluatedReady
        ? "the named evaluation contract is absent or belongs to another venture"
        : "no candidate has sufficient venture-scoped evidence and authority alignment";
  const uncertainty = selectedCandidate?.uncertainty ?? 1;
  const semantic = {
    ventureId: input.ventureId,
    packRevisionId: input.packRevisionId,
    goalRevisionId: input.goalRevisionId ?? null,
    candidates,
    assessments,
    selectionMode: input.selectionMode,
    baseline: input.baseline,
    evaluationContractId: input.evaluationContractId ?? null,
    selectedCandidateId: selectedCandidate?.id ?? null,
    abstain,
    abstainReason: abstain ? abstainReason : null,
    uncertainty,
    uncertaintyReason: selectedCandidate
      ? `${selectedCandidate.uncertaintyReason}; selection mode ${input.selectionMode}`
      : abstainReason,
    plannerId: input.plannerId,
    evaluatorId: input.evaluatorId,
    evidenceIds: [...input.evidenceIds].sort()
  };
  const canonicalHash = sha256(semantic);
  return DecisionTraceSchema.parse({
    id: makeId("decision", { ventureId: input.ventureId, canonicalHash }),
    ventureId: input.ventureId,
    packRevisionId: input.packRevisionId,
    ...(input.goalRevisionId ? { goalRevisionId: input.goalRevisionId } : {}),
    candidates,
    assessments,
    selectionMode: input.selectionMode,
    baseline: input.baseline,
    ...(input.evaluationContractId ? { evaluationContractId: input.evaluationContractId } : {}),
    ...(selectedCandidate ? { selectedCandidateId: selectedCandidate.id } : {}),
    abstain,
    ...(abstain ? { abstainReason } : {}),
    uncertainty,
    uncertaintyReason: selectedCandidate
      ? `${selectedCandidate.uncertaintyReason}; selection mode ${input.selectionMode}`
      : abstainReason,
    plannerId: input.plannerId,
    evaluatorId: input.evaluatorId,
    evidenceIds: [...input.evidenceIds].sort(),
    createdAt: context.createdAt,
    idempotencyKey: input.idempotencyKey,
    canonicalHash
  });
}

function assessCandidate(
  candidate: InitiativeCandidate,
  input: InitiativeDecisionInput,
  context: DecisionContext
): InitiativeCandidateAssessment {
  const missingEvidence = candidate.evidenceIds.filter((id) => !context.knownEvidenceIds.has(id));
  const crossVentureEvidence = input.evidenceIds.filter((id) => !context.knownEvidenceIds.has(id));
  const externalGate = candidate.gateClasses.some(
    (gate) => gate !== "safe-internal-read-only" && gate !== "public-research-free"
  );
  const authorityMismatch = externalGate && candidate.autonomyMode !== "execute-gated";
  const exclusionReasons = [
    ...(candidate.evidenceIds.length === 0 ? ["candidate has no venture-scoped evidence"] : []),
    ...(missingEvidence.length > 0 ? [`missing or foreign evidence: ${missingEvidence.join(", ")}`] : []),
    ...(crossVentureEvidence.length > 0 ? [`decision evidence is missing or foreign: ${crossVentureEvidence.join(", ")}`] : []),
    ...(authorityMismatch ? ["external gate requires execute-gated autonomy mode"] : [])
  ];
  const eligible = exclusionReasons.length === 0;
  const scoreComponents = {
    evidenceCoverage: eligible ? 1 : 0,
    reversibility: ["inspect", "propose", "prepare", "execute-safe"].includes(candidate.autonomyMode) ? 1 : 0.5,
    uncertaintyReduction: 1 - candidate.uncertainty,
    boundedness: 1 / (1 + candidate.estimatedHours / 40 + candidate.estimatedCostCents / 100_000)
  };
  const score = Object.values(scoreComponents).reduce((total, value) => total + value, 0) / Object.keys(scoreComponents).length;
  return {
    candidateId: candidate.id,
    eligible,
    ...(eligible ? { score } : {}),
    scoreComponents,
    evidenceIds: [...candidate.evidenceIds].sort(),
    exclusionReasons,
    rationale: eligible
      ? input.selectionMode === "evaluated"
        ? "eligible for comparison under the named frozen evaluator and strong baseline"
        : "eligible under deterministic rules; this score is not evidence of highest value or business impact"
      : exclusionReasons.join("; ")
  };
}
