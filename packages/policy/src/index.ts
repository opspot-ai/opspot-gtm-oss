import { canonicalize, nowIso, sha256, type PolicyDecision, type TaskDefinition } from "@opspot/contracts";

const SAFE_GATES = new Set(["safe-internal-read-only", "public-research-free"]);

export interface ApprovalRecord {
  venture_id: string;
  id: string;
  task_id: string;
  action_digest: string;
  status: string;
  expires_at: string;
  revoked_at?: string | null;
  consumed_at?: string | null;
}

export function actionDigest(task: TaskDefinition): string {
  return sha256({
    ventureId: task.ventureId,
    taskId: task.id,
    taskKind: task.taskKind,
    ownerRole: task.ownerRole,
    purpose: task.purpose,
    mode: task.mode,
    gateClass: task.gateClass,
    sourceRefs: [...task.sourceRefs].sort(),
    dependencies: [...task.dependencies].sort(),
    actionBounds: task.actionBounds,
    goalTaskBinding: task.goalTaskBinding ?? null,
    evaluationBinding: task.evaluationBinding ?? null,
    evaluationBindingHash: task.evaluationBindingHash ?? null,
    budgetCents: task.budgetCents,
    costCeilingCents: task.costCeilingCents,
    expectedOutcome: task.expectedOutcome,
    expectedProof: task.expectedProof
  });
}

function approvalPacket(task: TaskDefinition): NonNullable<PolicyDecision["approvalPacket"]> {
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
  return {
    recommendedAction: task.purpose,
    target: String(task.actionBounds.target ?? task.ventureId),
    capOrCost: `${task.costCeilingCents} cents maximum; bounds=${canonicalize(task.actionBounds)}`,
    senderOrSystem: String(task.actionBounds.senderOrSystem ?? task.ownerRole),
    expiresAt,
    rollbackOrKillRoute: String(task.actionBounds.rollbackOrKillRoute ?? `venture kill switch for ${task.ventureId}`),
    exactCommandOrProviderCall: String(task.actionBounds.exactCommandOrProviderCall ?? "not supplied; task must remain blocked")
  };
}

export function evaluatePolicy(task: TaskDefinition, options: { externalActionsEnabled?: boolean } = {}): PolicyDecision {
  const digest = actionDigest(task);
  if (task.costCeilingCents > task.budgetCents) {
    return {
      decision: "deny",
      gateClass: task.gateClass,
      reason: `cost ceiling ${task.costCeilingCents} exceeds task budget ${task.budgetCents}`,
      actionDigest: digest
    };
  }
  if (SAFE_GATES.has(task.gateClass) && task.mode === "internal-read-only" && task.costCeilingCents === 0) {
    return { decision: "allow", gateClass: task.gateClass, reason: "safe local/internal/read-only work with zero provider spend", actionDigest: digest };
  }
  if (task.mode === "fixture") {
    return { decision: "allow", gateClass: task.gateClass, reason: "deterministic fixture path cannot create an external effect", actionDigest: digest };
  }
  if (task.gateClass === "paid-research" && task.costCeilingCents === 0) {
    return { decision: "deny", gateClass: task.gateClass, reason: "paid research requires a declared positive cost ceiling", actionDigest: digest };
  }

  const packet = approvalPacket(task);
  if (!options.externalActionsEnabled) {
    return {
      decision: "approval-required",
      gateClass: task.gateClass,
      reason: "this goal keeps paid/high-blast/external actions disabled; only the exact action may be approved by a later goal",
      actionDigest: digest,
      approvalPacket: packet
    };
  }
  return {
    decision: "approval-required",
    gateClass: task.gateClass,
    reason: "task is outside the safe read-only class and requires an exact unexpired approval",
    actionDigest: digest,
    approvalPacket: packet
  };
}

export function validateApproval(task: TaskDefinition, approval: ApprovalRecord | undefined, at = nowIso()): { valid: boolean; reason: string } {
  if (!approval) return { valid: false, reason: "approval not found" };
  if (approval.venture_id !== task.ventureId || approval.task_id !== task.id) return { valid: false, reason: "approval belongs to another venture or task" };
  if (approval.action_digest !== actionDigest(task)) return { valid: false, reason: "approval action digest does not match current target/payload/budget/channel/provider" };
  if (approval.status !== "approved") return { valid: false, reason: `approval status is ${approval.status}` };
  if (approval.revoked_at) return { valid: false, reason: "approval was revoked" };
  if (approval.consumed_at) return { valid: false, reason: "approval was already consumed" };
  if (new Date(approval.expires_at).getTime() <= new Date(at).getTime()) return { valid: false, reason: "approval expired" };
  return { valid: true, reason: "exact approval is valid" };
}
