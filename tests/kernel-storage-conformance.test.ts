import { describe, expect, it } from "vitest";
import { TaskDefinitionSchema, sha256, type TaskDefinition } from "@opspot/contracts";
import { decryptSecret, encryptSecret } from "@opspot/adapters";
import {
  EngineStorage,
  KernelStorageAccessError,
  KernelStorageConflictError,
  PostgresKernelStorage,
  SqliteKernelStorage,
  type KernelStorage
} from "@opspot/storage";

const AT = "2026-07-20T12:00:00.000Z";
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();
const PERIOD_END = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();

function task(companyId: string): TaskDefinition {
  return TaskDefinitionSchema.parse({
    id: "task_ceo_plan_1",
    ventureId: companyId,
    taskKind: "ceo-cycle",
    purpose: "plan the next bounded CEO cycle",
    expectedOutcome: "one evidence-backed decision",
    ownerRole: "ceo",
    dependencies: [],
    sourceRefs: [],
    mode: "internal-read-only",
    expectedProof: "decision trace",
    gateClass: "safe-internal-read-only",
    actionBounds: { phase: "plan" },
    budgetCents: 0,
    costCeilingCents: 0,
    approvalRequired: false,
    idempotencyKey: "ceo-cycle-plan-one",
    maxAttempts: 3,
    backoffMs: 0,
    timeoutMs: 10_000,
    lifecycleEffect: {},
    metricEffects: []
  });
}

async function exercise(storage: KernelStorage): Promise<void> {
  const workspaceA = "workspace_alpha";
  const workspaceB = "workspace_beta";
  const companyA = "venture_alpha";
  const companyB = "venture_beta";
  const state = { bootstrap: { digest: sha256("bootstrap-alpha") }, runState: "idle", lifecycleState: "candidate" };

  await storage.ensureWorkspace(workspaceA);
  await storage.ensureWorkspace(workspaceB);
  expect((await storage.createCompany({
    workspaceId: workspaceA,
    companyId: companyA,
    slug: "same-company",
    name: "Alpha",
    owner: "founder-alpha",
    owningRepo: "synthetic/alpha",
    lifecycleState: "candidate",
    state,
    createdAt: AT,
    updatedAt: AT
  })).created).toBe(true);
  expect((await storage.createCompany({
    workspaceId: workspaceB,
    companyId: companyB,
    slug: "same-company",
    name: "Beta",
    owner: "founder-beta",
    owningRepo: "synthetic/beta",
    lifecycleState: "candidate",
    state: { bootstrap: { digest: sha256("bootstrap-beta") } },
    createdAt: AT,
    updatedAt: AT
  })).created).toBe(true);
  expect(await storage.getCompany(workspaceB, companyA)).toBeUndefined();

  const updated = await storage.updateCompanyState(workspaceA, companyA, 1, { ...state, runState: "running" });
  expect(updated.stateVersion).toBe(2);
  await expect(storage.updateCompanyState(workspaceA, companyA, 2, {
    ...state,
    bootstrap: { digest: sha256("mutated") }
  })).rejects.toBeInstanceOf(KernelStorageConflictError);

  const event = {
    workspaceId: workspaceA,
    companyId: companyA,
    id: "event_cycle_1",
    eventType: "ceo-cycle-completed",
    actor: "ceo",
    entityType: "ceo-cycle",
    entityId: "cycle_1",
    payload: { outcome: "selected", sequence: 1 },
    occurredAt: AT
  };
  expect((await storage.appendEvent(event)).created).toBe(true);
  expect((await storage.appendEvent(event)).created).toBe(false);
  expect(await storage.listEvents(workspaceA, companyA)).toHaveLength(1);
  expect((await storage.appendEvidence(workspaceA, {
    id: "evidence_market_1",
    ventureId: companyA,
    type: "market-signal",
    proofTier: "internally-live",
    authority: "public",
    sourceRef: "source_market",
    observedAt: AT,
    status: "current",
    contentHash: sha256("market evidence"),
    metadata: {}
  })).created).toBe(true);
  expect((await storage.appendReceipt(workspaceA, {
    id: "receipt_cycle_1",
    ventureId: companyA,
    proofTier: "internally-live",
    outcome: "success",
    actor: "ceo",
    adapter: "kernel-conformance",
    artifactPath: "receipts/cycle-1.json",
    contentHash: sha256("cycle receipt"),
    occurredAt: AT,
    metadata: {},
    origin: "engine-derived"
  })).created).toBe(true);

  const ceoTask = task(companyA);
  expect((await storage.putTask(workspaceA, ceoTask, sha256(ceoTask), "ready")).created).toBe(true);
  expect(await storage.getTask(workspaceA, companyA, ceoTask.id)).toMatchObject({ id: ceoTask.id, status: "ready" });
  await storage.enqueueJob({ workspaceId: workspaceA, companyId: companyA, id: "job_role_1", taskId: ceoTask.id, kind: "role-dispatch", payload: {} });
  await storage.enqueueJob({ workspaceId: workspaceA, companyId: companyA, id: "job_ceo_1", taskId: ceoTask.id, kind: "ceo-plan", payload: { sequence: 1 } });

  await storage.putEntitlement({
    workspaceId: workspaceA,
    companyId: companyA,
    status: "active",
    plan: "trial",
    periodStart: AT,
    periodEnd: PERIOD_END,
    modelCostCapCents: 1_000,
    providerEventId: "entitlement_1",
    providerOrder: 10,
    observedAt: AT
  });
  const lease = await storage.claimJob(workspaceA, "worker-a", 1_000, ["ceo-plan"]);
  expect(lease).toMatchObject({ id: "job_ceo_1", kind: "ceo-plan", status: "leased" });
  expect(lease?.leaseToken).toBeTruthy();
  expect((await storage.reserveEffect({
    workspaceId: workspaceA,
    companyId: companyA,
    idempotencyKey: "effect-acquisition-self-test",
    jobId: lease!.id,
    taskId: lease!.taskId,
    provider: "owned-endpoint",
    effectType: "self-test",
    requestHash: sha256("owned self test"),
    providerIdempotencyKey: "provider-self-test-1",
    leaseToken: lease!.leaseToken!
  })).reserved).toBe(true);
  expect(await storage.recoverExpiredJobs(workspaceA, new Date(Date.now() + 5_000).toISOString())).toBe(1);
  expect(await storage.completeJob(workspaceA, companyA, lease!.id, lease!.leaseToken!)).toBe(false);
  const recovered = await storage.claimJob(workspaceA, "worker-b", 30_000, ["ceo-plan"]);
  expect(await storage.failJob({
    workspaceId: workspaceA,
    companyId: companyA,
    jobId: lease!.id,
    leaseToken: lease!.leaseToken!,
    error: "stale worker must not mutate the reclaimed job",
    deadLetter: true
  })).toBe(false);
  const replay = await storage.reserveEffect({
    workspaceId: workspaceA,
    companyId: companyA,
    idempotencyKey: "effect-acquisition-self-test",
    jobId: recovered!.id,
    taskId: recovered!.taskId,
    provider: "owned-endpoint",
    effectType: "self-test",
    requestHash: sha256("owned self test"),
    providerIdempotencyKey: "provider-self-test-1",
    leaseToken: recovered!.leaseToken!
  });
  expect(replay).toMatchObject({ reserved: false, reservation: { status: "needs-reconciliation" } });
  expect((await storage.commitEffect({
    workspaceId: workspaceA,
    companyId: companyA,
    idempotencyKey: "effect-acquisition-self-test",
    leaseToken: recovered!.leaseToken!,
    result: { reconciled: true },
    reconciled: true
  })).committed).toBe(true);
  expect(await storage.completeJob(workspaceA, companyA, recovered!.id, recovered!.leaseToken!)).toBe(true);

  const [firstCost, secondCost] = await Promise.all([
    storage.reserveCost({ workspaceId: workspaceA, companyId: companyA, id: "cost_model_1", amountCents: 700, provider: "model", expiresAt: LATER }),
    storage.reserveCost({ workspaceId: workspaceA, companyId: companyA, id: "cost_model_2", amountCents: 400, provider: "model", expiresAt: LATER })
  ]);
  expect([firstCost.reserved, secondCost.reserved].sort()).toEqual([false, true]);
  const accepted = firstCost.reserved ? firstCost : secondCost;
  const activeReplay = await storage.reserveCost({
    workspaceId: workspaceA,
    companyId: companyA,
    id: accepted.reservation!.id,
    amountCents: accepted.reservation!.amountCents,
    provider: accepted.reservation!.provider,
    expiresAt: LATER
  });
  expect(activeReplay).toMatchObject({ reserved: true, reservation: { status: "reserved" } });
  const actualCost = Math.min(600, accepted.reservation!.amountCents);
  expect((await storage.settleCost({ workspaceId: workspaceA, companyId: companyA, id: accepted.reservation!.id, actualCostCents: actualCost })).settled).toBe(true);
  expect(await storage.getEntitlement(workspaceA, companyA)).toMatchObject({ spentCostCents: actualCost, reservedCostCents: 0 });
  expect(await storage.reserveCost({
    workspaceId: workspaceA,
    companyId: companyA,
    id: accepted.reservation!.id,
    amountCents: accepted.reservation!.amountCents,
    provider: accepted.reservation!.provider,
    expiresAt: LATER
  })).toMatchObject({ reserved: false, reason: "settled", reservation: { status: "settled" } });

  const shortExpiry = new Date(Date.now() + 60_000).toISOString();
  expect((await storage.reserveCost({
    workspaceId: workspaceA,
    companyId: companyA,
    id: "cost_reusable",
    amountCents: 100,
    provider: "model",
    expiresAt: shortExpiry
  })).reserved).toBe(true);
  expect(await storage.releaseExpiredCostReservations(workspaceA, new Date(Date.now() + 120_000).toISOString())).toBe(1);
  expect(await storage.reserveCost({
    workspaceId: workspaceA,
    companyId: companyA,
    id: "cost_reusable",
    amountCents: 100,
    provider: "model",
    expiresAt: LATER
  })).toMatchObject({ reserved: true, reservation: { status: "reserved" } });
  await storage.settleCost({ workspaceId: workspaceA, companyId: companyA, id: "cost_reusable", actualCostCents: 0 });

  const samePeriod = await storage.putEntitlement({
    workspaceId: workspaceA,
    companyId: companyA,
    status: "active",
    plan: "trial-updated",
    periodStart: "2026-07-20T08:00:00-04:00",
    periodEnd: PERIOD_END,
    modelCostCapCents: 1_000,
    providerEventId: "entitlement_2",
    providerOrder: 11,
    observedAt: "2026-07-20T08:01:00-04:00"
  });
  expect(samePeriod.entitlement).toMatchObject({ periodStart: AT, observedAt: "2026-07-20T12:01:00.000Z", spentCostCents: actualCost });
  expect((await storage.putEntitlement({
    workspaceId: workspaceA,
    companyId: companyA,
    status: "paused",
    plan: "stale-event",
    periodStart: AT,
    periodEnd: PERIOD_END,
    modelCostCapCents: 1_000,
    providerEventId: "entitlement_stale",
    providerOrder: 9,
    observedAt: LATER
  })).applied).toBe(false);
  await expect(storage.putEntitlement({
    workspaceId: workspaceA,
    companyId: companyA,
    status: "active",
    plan: "same-order-conflict",
    periodStart: AT,
    periodEnd: PERIOD_END,
    modelCostCapCents: 1_000,
    providerEventId: "entitlement_same_order_other_id",
    providerOrder: 11,
    observedAt: LATER
  })).rejects.toThrow("entitlement provider order conflict");
  const nextPeriodEnd = new Date(new Date(PERIOD_END).getTime() + 7 * 24 * 60 * 60_000).toISOString();
  expect((await storage.putEntitlement({
    workspaceId: workspaceA,
    companyId: companyA,
    status: "active",
    plan: "trial-renewed",
    periodStart: PERIOD_END,
    periodEnd: nextPeriodEnd,
    modelCostCapCents: 1_000,
    providerEventId: "entitlement_3",
    providerOrder: 12,
    observedAt: LATER
  })).entitlement).toMatchObject({ spentCostCents: 0, reservedCostCents: 0, providerOrder: 12 });
  await storage.putEntitlement({
    workspaceId: workspaceA,
    companyId: companyA,
    status: "active",
    plan: "expired-snapshot",
    periodStart: "2020-01-01T00:00:00.000Z",
    periodEnd: "2020-01-02T00:00:00.000Z",
    modelCostCapCents: 1_000,
    providerEventId: "entitlement_4",
    providerOrder: 13,
    observedAt: LATER
  });
  expect(await storage.reserveCost({
    workspaceId: workspaceA,
    companyId: companyA,
    id: "cost_expired_entitlement",
    amountCents: 1,
    provider: "model",
    expiresAt: LATER
  })).toMatchObject({ reserved: false, reason: "entitlement" });
  const expiredEffectTask = TaskDefinitionSchema.parse({
    ...ceoTask,
    id: "task_expired_entitlement",
    idempotencyKey: "expired-entitlement-effect-check"
  });
  await storage.putTask(workspaceA, expiredEffectTask, sha256(expiredEffectTask), "ready");
  await storage.enqueueJob({
    workspaceId: workspaceA,
    companyId: companyA,
    id: "job_expired_entitlement",
    taskId: expiredEffectTask.id,
    kind: "expired-entitlement",
    payload: {}
  });
  const expiredEffectLease = await storage.claimJob(workspaceA, "worker-expired", 1_000, ["expired-entitlement"]);
  expect(await storage.reserveEffect({
    workspaceId: workspaceA,
    companyId: companyA,
    idempotencyKey: "effect-expired-entitlement",
    jobId: expiredEffectLease!.id,
    taskId: expiredEffectLease!.taskId,
    provider: "model",
    effectType: "expired-entitlement-check",
    requestHash: sha256("expired entitlement"),
    providerIdempotencyKey: "expired-entitlement-check",
    leaseToken: expiredEffectLease!.leaseToken!
  })).toMatchObject({ reserved: false, reason: "entitlement" });
  expect(await storage.failJob({
    workspaceId: workspaceA,
    companyId: companyA,
    jobId: expiredEffectLease!.id,
    leaseToken: expiredEffectLease!.leaseToken!,
    error: "entitlement expired",
    deadLetter: true
  })).toBe(true);
  const failedJobs = await storage.listJobs(workspaceA, companyA, { statuses: ["dead-letter"], limit: 10 });
  expect(failedJobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: expiredEffectLease!.id, status: "dead-letter", error: { redacted: true, at: expect.any(String) } })
  ]));
  expect(JSON.stringify(failedJobs)).not.toContain("entitlement expired");
  await expect(storage.listJobs(workspaceB, companyA)).rejects.toBeInstanceOf(KernelStorageAccessError);

  const approvalId = "approval_publish_1";
  const blockedTask = TaskDefinitionSchema.parse({
    ...ceoTask,
    id: "task_publish_1",
    taskKind: "venture-play",
    purpose: "publish the exact approved offer",
    sourceRefs: ["source_bootstrap"],
    mode: "external",
    gateClass: "public-posting",
    actionBounds: {
      executionClass: "golden-execution",
      authorityDisposition: "approval-required",
      authorityEvaluatedAt: AT,
      authorityEnvelopeDigest: sha256("authority-envelope"),
      capabilityId: "minimum-sellable-asset",
      capabilityVersion: "2026-07-20.1",
      senderOrSystem: "ephemeral-specialist",
      exactCommandOrProviderCall: "golden-execution:minimum-sellable-asset:candidate_publish_1"
    },
    idempotencyKey: "ceo-initiative:venture_alpha:1:candidate_publish_1",
    approvalRequired: true,
    approvalId
  });
  const approvalDigest = sha256(blockedTask);
  await storage.putTask(workspaceA, blockedTask, approvalDigest, "blocked");
  expect((await storage.createApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    id: approvalId,
    taskId: blockedTask.id,
    actionDigest: approvalDigest,
    packet: { action: "publish" },
    expiresAt: LATER
  })).created).toBe(true);
  expect(await storage.listPendingApprovals(workspaceA, companyA)).toEqual([
    expect.objectContaining({ id: approvalId, taskId: blockedTask.id, actionDigest: approvalDigest, status: "pending" })
  ]);
  expect(await storage.listPendingApprovals(workspaceB)).toEqual([]);
  const approved = await storage.resolveApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    approvalId,
    expectedActionDigest: approvalDigest,
    resolution: "approved",
    resolutionId: "resolution_publish_1",
    actor: "founder",
    resolvedAt: AT
  });
  expect(approved).toMatchObject({ applied: true, taskId: blockedTask.id, status: "approved" });
  expect(await storage.getTask(workspaceA, companyA, blockedTask.id)).toMatchObject({ status: "ready", actionDigest: approvalDigest });
  const approvedJob = await storage.claimJob(workspaceA, "worker-approved", 1_000, ["golden-execution"]);
  expect(approvedJob).toMatchObject({
    id: approved.jobId,
    taskId: blockedTask.id,
    kind: "golden-execution",
    payload: {
      ventureId: companyA,
      taskId: blockedTask.id,
      actionDigest: approvalDigest,
      executionClass: "golden-execution",
      capabilityId: "minimum-sellable-asset"
    }
  });
  expect(await storage.completeJob(workspaceA, companyA, approvedJob!.id, approvedJob!.leaseToken!)).toBe(true);

  const internalApprovalId = "approval_internal_1";
  const internalApprovalTask = TaskDefinitionSchema.parse({
    ...blockedTask,
    id: "task_internal_approval_1",
    mode: "internal-read-only",
    gateClass: "safe-internal-read-only",
    actionBounds: {
      ...blockedTask.actionBounds,
      executionClass: "initiative-execution",
      authorityDisposition: "internal-safe",
      exactCommandOrProviderCall: "initiative-execution:minimum-sellable-asset:candidate_internal_1"
    },
    approvalId: internalApprovalId,
    idempotencyKey: "ceo-initiative:venture_alpha:1:candidate_internal_1"
  });
  const internalApprovalDigest = sha256(internalApprovalTask);
  await storage.putTask(workspaceA, internalApprovalTask, internalApprovalDigest, "blocked");
  await storage.createApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    id: internalApprovalId,
    taskId: internalApprovalTask.id,
    actionDigest: internalApprovalDigest,
    packet: { action: "must remain internal" },
    expiresAt: LATER
  });
  await expect(storage.resolveApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    approvalId: internalApprovalId,
    expectedActionDigest: internalApprovalDigest,
    resolution: "approved",
    resolutionId: "resolution_internal_1",
    actor: "founder",
    resolvedAt: AT,
    jobKind: "golden-execution"
  } as Parameters<KernelStorage["resolveApproval"]>[0] & { jobKind: string })).rejects.toThrow("frozen golden execution binding");
  expect((await storage.resolveApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    approvalId: internalApprovalId,
    expectedActionDigest: internalApprovalDigest,
    resolution: "revoked",
    resolutionId: "resolution_internal_revoke_1",
    actor: "founder",
    resolvedAt: AT
  })).applied).toBe(true);

  const deniedTask = TaskDefinitionSchema.parse({
    ...blockedTask,
    id: "task_denied_1",
    purpose: "deny this exact action",
    idempotencyKey: "deny-exact-action",
    approvalId: "approval_denied_1"
  });
  const deniedDigest = sha256(deniedTask);
  await storage.putTask(workspaceA, deniedTask, deniedDigest, "blocked");
  await storage.createApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    id: "approval_denied_1",
    taskId: deniedTask.id,
    actionDigest: deniedDigest,
    packet: { action: "deny" },
    expiresAt: LATER
  });
  expect((await storage.resolveApproval({
    workspaceId: workspaceA,
    companyId: companyA,
    approvalId: "approval_denied_1",
    expectedActionDigest: deniedDigest,
    resolution: "revoked",
    resolutionId: "resolution_denied_1",
    actor: "founder",
    resolvedAt: AT
  })).applied).toBe(true);
  expect(await storage.getTask(workspaceA, companyA, deniedTask.id)).toMatchObject({ status: "cancelled" });
  expect(await storage.listPendingApprovals(workspaceA, companyA)).toEqual([]);

  const plaintextCanary = "UNIQUE_KERNEL_SECRET_CANARY";
  const keyId = "key_primary_v1";
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptSecret(key, keyId, plaintextCanary, "secret_provider_1");
  expect(encrypted.ciphertext).not.toContain(plaintextCanary);
  await storage.putSecretMetadata({
    workspaceId: workspaceA,
    companyId: companyA,
    id: "secret_provider_1",
    provider: "model",
    purpose: "hosted execution",
    opaqueRef: "secret-ref:model-primary",
    status: "active",
    createdAt: AT
  });
  const secretEnvelope = {
    workspaceId: workspaceA,
    companyId: companyA,
    id: "secret_provider_1",
    ciphertext: encrypted.ciphertext,
    keyId,
    aadHash: sha256(`${keyId}:secret_provider_1`),
    createdAt: AT,
    updatedAt: AT
  };
  await storage.putWorkerSecretEnvelope(secretEnvelope);
  const workerEnvelope = await storage.getWorkerSecretEnvelope(workspaceA, companyA, "secret_provider_1");
  expect(decryptSecret(key, { reference: "secret_provider_1", keyId: workerEnvelope!.keyId, ciphertext: workerEnvelope!.ciphertext })).toBe(plaintextCanary);
  expect(JSON.stringify(await storage.listSecretMetadata(workspaceA, companyA))).not.toContain(encrypted.ciphertext);
  const exported = await storage.exportCompany(workspaceA, companyA);
  expect(JSON.stringify(exported)).not.toContain(encrypted.ciphertext);
  expect(JSON.stringify(exported)).not.toContain(plaintextCanary);
  expect(exported.tables.secret_envelopes).toBeUndefined();
  expect(await storage.revokeSecretMetadata(workspaceA, companyA, "secret_provider_1", LATER)).toBe(true);
  expect(await storage.getWorkerSecretEnvelope(workspaceA, companyA, "secret_provider_1")).toBeUndefined();
  expect(await storage.listSecretMetadata(workspaceA, companyA)).toEqual([
    expect.objectContaining({ id: "secret_provider_1", status: "revoked", rotatedAt: LATER })
  ]);
  await expect(storage.putWorkerSecretEnvelope(secretEnvelope)).rejects.toThrow("secret envelope requires active metadata");
  await expect(storage.exportCompany(workspaceB, companyA)).rejects.toThrow("workspace access denied");
  expect(await storage.deleteCompany(workspaceB, companyA)).toBe(false);
  expect(await storage.deleteCompany(workspaceA, companyA)).toBe(true);
  expect(await storage.getCompany(workspaceA, companyA)).toBeUndefined();
  expect(await storage.getCompany(workspaceB, companyB)).toMatchObject({ companyId: companyB });
}

describe("kernel storage conformance", () => {
  it("passes on the authoritative local SQLite store", async () => {
    const engine = new EngineStorage(":memory:");
    try {
      await exercise(new SqliteKernelStorage(engine));
    } finally {
      engine.close();
    }
  });

  const postgresUrl = process.env.TEST_POSTGRES_URL;
  (postgresUrl ? it : it.skip)("passes on PostgreSQL", async () => {
    const storage = await PostgresKernelStorage.connect(postgresUrl!, { schema: process.env.TEST_POSTGRES_SCHEMA ?? "opspot_gtm_conformance" });
    try {
      await exercise(storage);
    } finally {
      await storage.close();
    }
  });
});
