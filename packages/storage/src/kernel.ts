import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import postgres, { type Sql, type TransactionSql } from "postgres";
import {
  EvidenceItemSchema,
  GtmCapabilityIdSchema,
  ReceiptSchema,
  TaskDefinitionSchema,
  canonicalize,
  makeId,
  nowIso,
  sha256,
  type EvidenceItem,
  type LifecycleState,
  type Receipt,
  type TaskDefinition,
  type TaskStatus
} from "@opspot/contracts";
import type { EngineStorage } from "./index.js";

type JsonObject = Record<string, unknown>;
type PgExecutor = Sql | TransactionSql;

export type EntitlementStatus = "local" | "active" | "paused" | "expired" | "past-due" | "canceled" | "refunded" | "disputed";
export type EffectStatus = "reserved" | "needs-reconciliation" | "committed";

export interface KernelCompany {
  workspaceId: string;
  companyId: string;
  slug: string;
  name: string;
  owner: string;
  owningRepo: string;
  lifecycleState: LifecycleState;
  killed: boolean;
  state: JsonObject;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface KernelEvent {
  workspaceId: string;
  companyId: string;
  id: string;
  eventType: string;
  actor: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  occurredAt: string;
}

export interface KernelJob {
  workspaceId: string;
  companyId: string;
  id: string;
  taskId: string;
  kind: string;
  status: string;
  payload: unknown;
  availableAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  attemptCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type KernelJobStatus = "queued" | "leased" | "succeeded" | "failed" | "cancelled" | "dead-letter";

export interface KernelJobSummary {
  id: string;
  taskId: string;
  kind: string;
  status: KernelJobStatus;
  attemptCount: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  error?: { redacted: true; at: string };
}

export interface CompanyEntitlement {
  workspaceId: string;
  companyId: string;
  status: EntitlementStatus;
  plan: string;
  periodStart: string;
  periodEnd: string;
  modelCostCapCents: number;
  spentCostCents: number;
  reservedCostCents: number;
  providerEventId: string;
  providerOrder: number;
  observedAt: string;
  updatedAt: string;
}

export type CompanyEntitlementInput = Omit<CompanyEntitlement, "spentCostCents" | "reservedCostCents" | "updatedAt">;

export interface EffectReservation {
  workspaceId: string;
  companyId: string;
  idempotencyKey: string;
  jobId: string;
  taskId: string;
  provider: string;
  effectType: string;
  requestHash: string;
  providerIdempotencyKey: string;
  status: EffectStatus;
  leaseToken: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export type EffectReservationInput = Omit<EffectReservation, "status" | "result" | "createdAt" | "updatedAt"> & {
  actionLimits?: { daily: number; weekly: number; observedAt: string };
};

export interface SecretMetadata {
  workspaceId: string;
  companyId: string;
  id: string;
  provider: string;
  purpose: string;
  opaqueRef: string;
  status: "active" | "revoked";
  createdAt: string;
  rotatedAt?: string;
}

export interface WorkerSecretEnvelope {
  workspaceId: string;
  companyId: string;
  id: string;
  ciphertext: string;
  keyId: string;
  aadHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface CostReservation {
  workspaceId: string;
  companyId: string;
  id: string;
  taskId?: string;
  amountCents: number;
  status: "reserved" | "settled" | "released";
  actualCostCents?: number;
  provider: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface KernelApproval {
  workspaceId: string;
  companyId: string;
  id: string;
  taskId: string;
  actionDigest: string;
  status: "pending" | "approved" | "revoked";
  packet: unknown;
  expiresAt: string;
  createdAt: string;
  resolutionId?: string;
  resolvedAt?: string;
  resolutionActor?: string;
}

export interface WorkspaceMembership {
  authSubject: string;
  workspaceId: string;
  role: "owner" | "operator" | "viewer";
  createdAt: string;
}

export interface KernelCompanyExport {
  schemaVersion: 1;
  exportedAt: string;
  workspaceId: string;
  companyId: string;
  tables: Record<string, unknown[]>;
}

export interface KernelStorage {
  ensureWorkspace(workspaceId: string): Promise<void>;
  createCompany(input: Omit<KernelCompany, "killed" | "stateVersion">): Promise<{ created: boolean; company: KernelCompany }>;
  getCompany(workspaceId: string, companyId: string): Promise<KernelCompany | undefined>;
  listCompanies(workspaceId: string): Promise<KernelCompany[]>;
  updateCompanyState(workspaceId: string, companyId: string, expectedVersion: number, state: JsonObject): Promise<KernelCompany>;
  setKillSwitch(workspaceId: string, companyId: string, killed: boolean): Promise<void>;
  appendEvent(input: KernelEvent): Promise<{ created: boolean }>;
  listEvents(workspaceId: string, companyId: string): Promise<KernelEvent[]>;
  appendEvidence(workspaceId: string, item: EvidenceItem): Promise<{ created: boolean; id: string }>;
  listEvidence(workspaceId: string, companyId: string): Promise<EvidenceItem[]>;
  appendReceipt(workspaceId: string, receipt: Receipt): Promise<{ created: boolean; id: string }>;
  listReceipts(workspaceId: string, companyId: string): Promise<Receipt[]>;
  putTask(workspaceId: string, task: TaskDefinition, actionDigest: string, status?: TaskStatus): Promise<{ created: boolean }>;
  getTask(workspaceId: string, companyId: string, taskId: string): Promise<(TaskDefinition & { status: TaskStatus; actionDigest: string; attemptCount: number }) | undefined>;
  listJobs(workspaceId: string, companyId: string, options?: { statuses?: readonly KernelJobStatus[]; limit?: number }): Promise<KernelJobSummary[]>;
  enqueueJob(input: { workspaceId: string; companyId: string; id: string; taskId: string; kind: string; payload: unknown; availableAt?: string }): Promise<{ created: boolean; id: string }>;
  claimJob(workspaceId: string, workerId: string, leaseMs: number, kinds?: readonly string[]): Promise<KernelJob | undefined>;
  renewJobLease(workspaceId: string, companyId: string, jobId: string, leaseToken: string, leaseMs: number): Promise<boolean>;
  completeJob(workspaceId: string, companyId: string, jobId: string, leaseToken: string): Promise<boolean>;
  failJob(input: { workspaceId: string; companyId: string; jobId: string; leaseToken: string; error: string; retryAt?: string; deadLetter?: boolean }): Promise<boolean>;
  recoverExpiredJobs(workspaceId: string, at?: string): Promise<number>;
  putEntitlement(input: CompanyEntitlementInput): Promise<{ applied: boolean; entitlement: CompanyEntitlement }>;
  getEntitlement(workspaceId: string, companyId: string): Promise<CompanyEntitlement | undefined>;
  reserveEffect(input: EffectReservationInput): Promise<{ reserved: boolean; reservation?: EffectReservation; reason?: "entitlement" | "action-cap" }>;
  commitEffect(input: { workspaceId: string; companyId: string; idempotencyKey: string; leaseToken: string; result: unknown; reconciled?: boolean }): Promise<{ committed: boolean; reservation: EffectReservation }>;
  reserveCost(input: { workspaceId: string; companyId: string; id: string; taskId?: string; amountCents: number; provider: string; expiresAt: string }): Promise<{ reserved: boolean; reservation?: CostReservation; reason?: "entitlement" | "cost-cap" | "settled" }>;
  settleCost(input: { workspaceId: string; companyId: string; id: string; actualCostCents: number; sourceRef?: string }): Promise<{ settled: boolean; reservation: CostReservation }>;
  releaseExpiredCostReservations(workspaceId: string, at?: string): Promise<number>;
  createApproval(input: { workspaceId: string; companyId: string; id: string; taskId: string; actionDigest: string; packet: unknown; expiresAt: string }): Promise<{ created: boolean }>;
  getApproval(workspaceId: string, companyId: string, approvalId: string): Promise<KernelApproval | undefined>;
  listPendingApprovals(workspaceId: string, companyId?: string): Promise<KernelApproval[]>;
  resolveApproval(input: { workspaceId: string; companyId: string; approvalId: string; expectedActionDigest: string; resolution: "approved" | "revoked"; resolutionId: string; actor: string; resolvedAt: string }): Promise<{ applied: boolean; status: "approved" | "revoked"; taskId: string; jobId?: string }>;
  putSecretMetadata(input: SecretMetadata): Promise<{ created: boolean }>;
  putWorkerSecretEnvelope(input: WorkerSecretEnvelope): Promise<{ created: boolean }>;
  getWorkerSecretEnvelope(workspaceId: string, companyId: string, id: string): Promise<WorkerSecretEnvelope | undefined>;
  revokeSecretMetadata(workspaceId: string, companyId: string, id: string, rotatedAt: string): Promise<boolean>;
  listSecretMetadata(workspaceId: string, companyId: string): Promise<SecretMetadata[]>;
  exportCompany(workspaceId: string, companyId: string): Promise<KernelCompanyExport>;
  deleteCompany(workspaceId: string, companyId: string): Promise<boolean>;
  close(): Promise<void>;
}

export class KernelStorageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelStorageConflictError";
  }
}

export class KernelStorageAccessError extends Error {
  constructor() {
    super("workspace access denied");
    this.name = "KernelStorageAccessError";
  }
}

function requireMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new TypeError(`invalid ${label}`);
}

function requireWorkspaceId(value: string): void {
  requireMatch(value, /^workspace_[a-z0-9][a-z0-9_-]{0,149}$/, "workspace id");
}

function requireCompanyId(value: string): void {
  requireMatch(value, /^venture_[a-z0-9][a-z0-9_-]{0,149}$/, "company id");
}

function requireAuthSubject(value: string): void {
  requireMatch(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "auth subject");
}

function requireText(value: string, label: string, max = 500): void {
  if (value.length < 1 || value.length > max) throw new TypeError(`invalid ${label}`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
}

function jsonText(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError("value must be JSON serializable");
  JSON.parse(text);
  return text;
}

function parseJsonObject(value: unknown): JsonObject {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("company state must be a JSON object");
  return parsed as JsonObject;
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizedTimestamp(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid ${label}`);
  return date.toISOString();
}

function entitlementAdmits(entitlement: Pick<CompanyEntitlement, "status" | "periodEnd">, at = Date.now()): boolean {
  return (entitlement.status === "local" || entitlement.status === "active")
    && new Date(entitlement.periodEnd).getTime() > at;
}

function normalizeEntitlementInput(input: CompanyEntitlementInput): CompanyEntitlementInput {
  requireNonNegativeInteger(input.modelCostCapCents, "model cost cap");
  requireNonNegativeInteger(input.providerOrder, "provider order");
  requireText(input.providerEventId, "provider event id", 500);
  const periodStart = normalizedTimestamp(input.periodStart, "entitlement period start");
  const periodEnd = normalizedTimestamp(input.periodEnd, "entitlement period end");
  const observedAt = normalizedTimestamp(input.observedAt, "entitlement observed at");
  if (periodEnd <= periodStart) throw new TypeError("entitlement period end must follow period start");
  return { ...input, periodStart, periodEnd, observedAt };
}

function assertBootstrapDigestUnchanged(current: JsonObject, next: JsonObject): void {
  const currentBootstrap = current.bootstrap;
  const nextBootstrap = next.bootstrap;
  const currentDigest = currentBootstrap && typeof currentBootstrap === "object" && !Array.isArray(currentBootstrap)
    ? (currentBootstrap as JsonObject).digest
    : undefined;
  const nextDigest = nextBootstrap && typeof nextBootstrap === "object" && !Array.isArray(nextBootstrap)
    ? (nextBootstrap as JsonObject).digest
    : undefined;
  if (currentDigest !== undefined && currentDigest !== nextDigest) throw new KernelStorageConflictError("bootstrap digest is immutable");
}

function companyFromRow(row: Record<string, unknown>): KernelCompany {
  return {
    workspaceId: String(row.workspace_id),
    companyId: String(row.id),
    slug: String(row.company_slug),
    name: String(row.name),
    owner: String(row.owner),
    owningRepo: String(row.owning_repo),
    lifecycleState: String(row.lifecycle_state) as LifecycleState,
    killed: row.kill_switch === true || Number(row.kill_switch) === 1,
    state: parseJsonObject(row.state_json),
    stateVersion: Number(row.state_version),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function eventFromRow(row: Record<string, unknown>): KernelEvent {
  return {
    workspaceId: String(row.workspace_id),
    companyId: String(row.venture_id),
    id: String(row.id),
    eventType: String(row.event_type),
    actor: String(row.actor),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    payload: parseJson(row.payload_json),
    occurredAt: timestamp(row.occurred_at)
  };
}

function jobFromRow(row: Record<string, unknown>): KernelJob {
  return {
    workspaceId: String(row.workspace_id),
    companyId: String(row.venture_id),
    id: String(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind),
    status: String(row.status),
    payload: parseJson(row.payload_json),
    availableAt: timestamp(row.available_at),
    ...(optionalString(row.lease_owner) ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(optionalString(row.lease_token) ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: timestamp(row.lease_expires_at) } : {}),
    attemptCount: Number(row.attempt_count),
    ...(optionalString(row.last_error) ? { lastError: String(row.last_error) } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

const kernelJobStatuses = new Set<KernelJobStatus>(["queued", "leased", "succeeded", "failed", "cancelled", "dead-letter"]);

function jobListOptions(options: { statuses?: readonly KernelJobStatus[]; limit?: number } = {}): { statuses?: KernelJobStatus[]; limit: number } {
  const statuses = options.statuses ? [...new Set(options.statuses)] : undefined;
  if (statuses?.length === 0 || (statuses?.length ?? 0) > kernelJobStatuses.size || statuses?.some((status) => !kernelJobStatuses.has(status))) {
    throw new TypeError("invalid job status filter");
  }
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError("job list limit must be between one and two hundred");
  return { ...(statuses ? { statuses } : {}), limit };
}

function jobSummaryFromRow(row: Record<string, unknown>): KernelJobSummary {
  const updatedAt = timestamp(row.updated_at);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind),
    status: String(row.status) as KernelJobStatus,
    attemptCount: Number(row.attempt_count),
    availableAt: timestamp(row.available_at),
    createdAt: timestamp(row.created_at),
    updatedAt,
    ...(optionalString(row.last_error) ? { error: { redacted: true, at: updatedAt } as const } : {})
  };
}

function approvedGoldenJobBinding(rawDefinition: unknown, approvalId: string): { kind: "golden-execution"; capabilityId: string } {
  const task = TaskDefinitionSchema.parse(parseJson(rawDefinition));
  const capability = GtmCapabilityIdSchema.safeParse(task.actionBounds.capabilityId);
  const authorityEvaluatedAt = typeof task.actionBounds.authorityEvaluatedAt === "string"
    && Number.isFinite(Date.parse(task.actionBounds.authorityEvaluatedAt));
  const authorityEnvelopeDigest = typeof task.actionBounds.authorityEnvelopeDigest === "string"
    && /^[a-f0-9]{64}$/.test(task.actionBounds.authorityEnvelopeDigest);
  const capabilityVersion = typeof task.actionBounds.capabilityVersion === "string" && task.actionBounds.capabilityVersion.length > 0;
  const exactCommandPrefix = `golden-execution:${capability.success ? capability.data : "invalid"}:`;
  const exactCommand = typeof task.actionBounds.exactCommandOrProviderCall === "string"
    && task.actionBounds.exactCommandOrProviderCall.startsWith(exactCommandPrefix)
    && task.actionBounds.exactCommandOrProviderCall.length > exactCommandPrefix.length;
  if (
    task.taskKind !== "venture-play"
    || task.mode !== "external"
    || task.approvalRequired !== true
    || task.approvalId !== approvalId
    || !task.idempotencyKey.startsWith("ceo-initiative:")
    || task.actionBounds.senderOrSystem !== "ephemeral-specialist"
    || task.actionBounds.executionClass !== "golden-execution"
    || task.actionBounds.authorityDisposition !== "approval-required"
    || !capability.success
    || !capabilityVersion
    || !authorityEvaluatedAt
    || !authorityEnvelopeDigest
    || !exactCommand
  ) {
    throw new KernelStorageConflictError("approval task lacks a valid frozen golden execution binding");
  }
  return { kind: "golden-execution", capabilityId: capability.data };
}

function entitlementFromRow(workspaceId: string, row: Record<string, unknown>): CompanyEntitlement {
  return {
    workspaceId,
    companyId: String(row.venture_id),
    status: String(row.status) as EntitlementStatus,
    plan: String(row.plan),
    periodStart: timestamp(row.period_start),
    periodEnd: timestamp(row.period_end),
    modelCostCapCents: Number(row.model_cost_cap_cents),
    spentCostCents: Number(row.spent_cost_cents),
    reservedCostCents: Number(row.reserved_cost_cents),
    providerEventId: String(row.provider_event_id),
    providerOrder: Number(row.provider_order),
    observedAt: timestamp(row.observed_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function effectFromRow(workspaceId: string, row: Record<string, unknown>): EffectReservation {
  return {
    workspaceId,
    companyId: String(row.venture_id),
    idempotencyKey: String(row.idempotency_key),
    jobId: String(row.job_id),
    taskId: String(row.task_id),
    provider: String(row.provider),
    effectType: String(row.effect_type),
    requestHash: String(row.request_hash),
    providerIdempotencyKey: String(row.provider_idempotency_key),
    status: String(row.status) as EffectStatus,
    leaseToken: String(row.lease_token),
    ...(row.result_json === null || row.result_json === undefined ? {} : { result: parseJson(row.result_json) }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function secretFromRow(workspaceId: string, row: Record<string, unknown>): SecretMetadata {
  return {
    workspaceId,
    companyId: String(row.venture_id),
    id: String(row.id),
    provider: String(row.provider),
    purpose: String(row.purpose),
    opaqueRef: String(row.opaque_ref),
    status: String(row.status) as "active" | "revoked",
    createdAt: timestamp(row.created_at),
    ...(row.rotated_at ? { rotatedAt: timestamp(row.rotated_at) } : {})
  };
}

function approvalFromRow(workspaceId: string, row: Record<string, unknown>): KernelApproval {
  return {
    workspaceId,
    companyId: String(row.venture_id),
    id: String(row.id),
    taskId: String(row.task_id),
    actionDigest: String(row.action_digest),
    status: String(row.status) as KernelApproval["status"],
    packet: parseJson(row.packet_json),
    expiresAt: timestamp(row.expires_at),
    createdAt: timestamp(row.created_at),
    ...(optionalString(row.resolution_id) ? { resolutionId: String(row.resolution_id) } : {}),
    ...(row.resolved_at ? { resolvedAt: timestamp(row.resolved_at) } : {}),
    ...(optionalString(row.resolution_actor) ? { resolutionActor: String(row.resolution_actor) } : {})
  };
}

function validateEffectInput(input: EffectReservationInput): void {
  requireWorkspaceId(input.workspaceId);
  requireCompanyId(input.companyId);
  for (const [label, value] of [
    ["idempotency key", input.idempotencyKey],
    ["job id", input.jobId],
    ["task id", input.taskId],
    ["provider", input.provider],
    ["effect type", input.effectType],
    ["provider idempotency key", input.providerIdempotencyKey],
    ["lease token", input.leaseToken]
  ] as const) requireText(value, label, 500);
  requireMatch(input.requestHash, /^[a-f0-9]{64}$/, "request hash");
  if (input.actionLimits) {
    requireNonNegativeInteger(input.actionLimits.daily, "daily action cap");
    requireNonNegativeInteger(input.actionLimits.weekly, "weekly action cap");
    normalizedTimestamp(input.actionLimits.observedAt, "effect action-cap timestamp");
  }
}

function validateSecretMetadata(input: SecretMetadata): void {
  const allowed = new Set(["workspaceId", "companyId", "id", "provider", "purpose", "opaqueRef", "status", "createdAt", "rotatedAt"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`unexpected secret metadata field: ${key}`);
  requireWorkspaceId(input.workspaceId);
  requireCompanyId(input.companyId);
  requireMatch(input.id, /^secret_[a-z0-9][a-z0-9_-]{0,149}$/, "secret metadata id");
  requireText(input.provider, "secret provider", 100);
  requireText(input.purpose, "secret purpose", 200);
  requireText(input.opaqueRef, "opaque secret reference", 500);
  if (input.status !== "active" && input.status !== "revoked") throw new TypeError("invalid secret metadata status");
}

function validateSecretEnvelope(input: WorkerSecretEnvelope): void {
  const allowed = new Set(["workspaceId", "companyId", "id", "ciphertext", "keyId", "aadHash", "createdAt", "updatedAt"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`unexpected secret envelope field: ${key}`);
  requireWorkspaceId(input.workspaceId);
  requireCompanyId(input.companyId);
  requireMatch(input.id, /^secret_[a-z0-9][a-z0-9_-]{0,149}$/, "secret envelope id");
  requireText(input.ciphertext, "encrypted secret envelope", 100_000);
  requireText(input.keyId, "secret key id", 200);
  requireMatch(input.aadHash, /^[a-f0-9]{64}$/, "secret AAD hash");
}

function sqliteRows(statement: ReturnType<DatabaseSync["prepare"]>, ...parameters: Array<string | number>): Array<Record<string, unknown>> {
  return statement.all(...parameters) as unknown as Array<Record<string, unknown>>;
}

export class SqliteKernelStorage implements KernelStorage {
  constructor(private readonly storage: EngineStorage) {}

  async ensureWorkspace(workspaceId: string): Promise<void> {
    requireWorkspaceId(workspaceId);
    this.storage.ensureWorkspace(workspaceId);
  }

  async createCompany(input: Omit<KernelCompany, "killed" | "stateVersion">): Promise<{ created: boolean; company: KernelCompany }> {
    requireWorkspaceId(input.workspaceId);
    requireCompanyId(input.companyId);
    requireText(input.slug, "company slug", 160);
    const stateJson = jsonText(input.state);
    return this.storage.transaction(() => {
      this.storage.ensureWorkspace(input.workspaceId);
      const prior = this.storage.db.prepare("SELECT * FROM ventures WHERE id=?").get(input.companyId) as Record<string, unknown> | undefined;
      if (prior) {
        const company = companyFromRow(prior);
        const replay = company.workspaceId === input.workspaceId
          && company.slug === input.slug
          && company.name === input.name
          && company.owner === input.owner
          && company.owningRepo === input.owningRepo
          && company.lifecycleState === input.lifecycleState
          && canonicalize(company.state) === stateJson;
        if (!replay) throw new KernelStorageConflictError("company idempotency conflict");
        return { created: false, company };
      }
      const storageSlug = input.workspaceId === "workspace_local" ? input.slug : `${input.workspaceId}:${input.slug}`;
      this.storage.db.prepare(
        `INSERT INTO ventures(id,slug,company_slug,name,owner,owning_repo,lifecycle_state,workspace_id,state_json,state_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`
      ).run(input.companyId, storageSlug, input.slug, input.name, input.owner, input.owningRepo, input.lifecycleState, input.workspaceId, stateJson, input.createdAt, input.updatedAt);
      return { created: true, company: companyFromRow(this.storage.db.prepare("SELECT * FROM ventures WHERE id=?").get(input.companyId) as Record<string, unknown>) };
    });
  }

  async getCompany(workspaceId: string, companyId: string): Promise<KernelCompany | undefined> {
    requireWorkspaceId(workspaceId);
    requireCompanyId(companyId);
    const row = this.storage.db.prepare("SELECT * FROM ventures WHERE id=? AND workspace_id=?").get(companyId, workspaceId) as Record<string, unknown> | undefined;
    return row ? companyFromRow(row) : undefined;
  }

  async listCompanies(workspaceId: string): Promise<KernelCompany[]> {
    requireWorkspaceId(workspaceId);
    return sqliteRows(this.storage.db.prepare("SELECT * FROM ventures WHERE workspace_id=? ORDER BY company_slug"), workspaceId).map(companyFromRow);
  }

  async updateCompanyState(workspaceId: string, companyId: string, expectedVersion: number, state: JsonObject): Promise<KernelCompany> {
    requireNonNegativeInteger(expectedVersion, "expected state version");
    this.storage.transaction(() => {
      const current = this.storage.db.prepare("SELECT state_json,state_version FROM ventures WHERE id=? AND workspace_id=?")
        .get(companyId, workspaceId) as { state_json: string; state_version: number } | undefined;
      if (!current) throw new KernelStorageAccessError();
      if (current.state_version !== expectedVersion) throw new KernelStorageConflictError("company state version conflict");
      assertBootstrapDigestUnchanged(parseJsonObject(current.state_json), state);
      this.storage.db.prepare(
        "UPDATE ventures SET state_json=?,state_version=state_version+1,updated_at=? WHERE id=? AND workspace_id=? AND state_version=?"
      ).run(jsonText(state), nowIso(), companyId, workspaceId, expectedVersion);
    });
    return (await this.getCompany(workspaceId, companyId))!;
  }

  async setKillSwitch(workspaceId: string, companyId: string, killed: boolean): Promise<void> {
    if (!killed) throw new KernelStorageConflictError("public company kill is irreversible");
    const result = this.storage.db.prepare(
      `UPDATE ventures SET kill_switch=1,lifecycle_state='killed',
       state_json=json_set(state_json,'$.runState','killed','$.lifecycleState','killed'),state_version=state_version+1,updated_at=?
       WHERE id=? AND workspace_id=?`
    ).run(nowIso(), companyId, workspaceId);
    if (Number(result.changes) !== 1) throw new KernelStorageAccessError();
  }

  private assertCompany(workspaceId: string, companyId: string): void {
    if (!this.storage.isVentureInWorkspace(workspaceId, companyId)) throw new KernelStorageAccessError();
  }

  async appendEvent(input: KernelEvent): Promise<{ created: boolean }> {
    this.assertCompany(input.workspaceId, input.companyId);
    const payloadJson = jsonText(input.payload);
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT * FROM audit_events WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown> | undefined;
      if (prior) {
        const replay = String(prior.event_type) === input.eventType
          && String(prior.actor) === input.actor
          && String(prior.entity_type) === input.entityType
          && String(prior.entity_id) === input.entityId
          && String(prior.payload_json) === payloadJson
          && String(prior.occurred_at) === input.occurredAt;
        if (!replay) throw new KernelStorageConflictError("event idempotency conflict");
        return { created: false };
      }
      this.storage.db.prepare(
        "INSERT INTO audit_events(venture_id,id,event_type,actor,entity_type,entity_id,payload_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(input.companyId, input.id, input.eventType, input.actor, input.entityType, input.entityId, payloadJson, input.occurredAt);
      return { created: true };
    });
  }

  async listEvents(workspaceId: string, companyId: string): Promise<KernelEvent[]> {
    this.assertCompany(workspaceId, companyId);
    return sqliteRows(
      this.storage.db.prepare("SELECT ?,a.* FROM audit_events a WHERE venture_id=? ORDER BY occurred_at,id"),
      workspaceId,
      companyId
    ).map((row) => eventFromRow({ ...row, workspace_id: workspaceId }));
  }

  async appendEvidence(workspaceId: string, item: EvidenceItem): Promise<{ created: boolean; id: string }> {
    this.assertCompany(workspaceId, item.ventureId);
    EvidenceItemSchema.parse(item);
    return this.storage.addEvidence(item);
  }

  async listEvidence(workspaceId: string, companyId: string): Promise<EvidenceItem[]> {
    this.assertCompany(workspaceId, companyId);
    return this.storage.listEvidence(companyId);
  }

  async appendReceipt(workspaceId: string, receipt: Receipt): Promise<{ created: boolean; id: string }> {
    this.assertCompany(workspaceId, receipt.ventureId);
    ReceiptSchema.parse(receipt);
    return this.storage.attachReceipt(receipt);
  }

  async listReceipts(workspaceId: string, companyId: string): Promise<Receipt[]> {
    this.assertCompany(workspaceId, companyId);
    return this.storage.listReceipts(companyId);
  }

  async putTask(workspaceId: string, task: TaskDefinition, actionDigest: string, status: TaskStatus = "planned"): Promise<{ created: boolean }> {
    this.assertCompany(workspaceId, task.ventureId);
    TaskDefinitionSchema.parse(task);
    return { created: this.storage.createTask(task, actionDigest, status).created };
  }

  async getTask(workspaceId: string, companyId: string, taskId: string): Promise<(TaskDefinition & { status: TaskStatus; actionDigest: string; attemptCount: number }) | undefined> {
    this.assertCompany(workspaceId, companyId);
    return this.storage.getTask(companyId, taskId);
  }

  async listJobs(workspaceId: string, companyId: string, rawOptions: { statuses?: readonly KernelJobStatus[]; limit?: number } = {}): Promise<KernelJobSummary[]> {
    this.assertCompany(workspaceId, companyId);
    const options = jobListOptions(rawOptions);
    const statusClause = options.statuses ? `AND status IN (${options.statuses.map(() => "?").join(",")})` : "";
    return sqliteRows(this.storage.db.prepare(
      `SELECT id,task_id,kind,status,attempt_count,last_error,available_at,created_at,updated_at
       FROM jobs WHERE venture_id=? ${statusClause} ORDER BY updated_at DESC,id LIMIT ?`
    ), companyId, ...(options.statuses ?? []), options.limit).map(jobSummaryFromRow);
  }

  async enqueueJob(input: { workspaceId: string; companyId: string; id: string; taskId: string; kind: string; payload: unknown; availableAt?: string }): Promise<{ created: boolean; id: string }> {
    this.assertCompany(input.workspaceId, input.companyId);
    return this.storage.enqueueJob({
      ventureId: input.companyId,
      id: input.id,
      taskId: input.taskId,
      kind: input.kind,
      payload: input.payload,
      ...(input.availableAt ? { availableAt: input.availableAt } : {})
    });
  }

  async claimJob(workspaceId: string, workerId: string, leaseMs: number, kinds?: readonly string[]): Promise<KernelJob | undefined> {
    requireWorkspaceId(workspaceId);
    requireText(workerId, "worker id", 200);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new TypeError("lease must be between one second and one hour");
    if (kinds?.length === 0 || (kinds?.length ?? 0) > 20) throw new TypeError("job kinds must contain between one and twenty entries");
    for (const kind of kinds ?? []) requireMatch(kind, /^[a-z][a-z0-9-]{0,80}$/, "job kind");
    return this.storage.transaction(() => {
      const now = new Date();
      const kindClause = kinds ? `AND j.kind IN (${kinds.map(() => "?").join(",")})` : "";
      const row = this.storage.db.prepare(
        `SELECT j.*,v.workspace_id FROM jobs j
         JOIN ventures v ON v.id=j.venture_id
         JOIN tasks t ON t.venture_id=j.venture_id AND t.id=j.task_id
         WHERE v.workspace_id=? AND j.status='queued' AND j.available_at<=? ${kindClause} AND t.status NOT IN ('cancelled','dead-letter','succeeded')
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies td
             JOIN tasks dependency ON dependency.venture_id=td.venture_id AND dependency.id=td.depends_on_task_id
             WHERE td.venture_id=j.venture_id AND td.task_id=j.task_id AND dependency.status<>'succeeded'
           )
         ORDER BY j.available_at,j.created_at LIMIT 1`
      ).get(workspaceId, now.toISOString(), ...(kinds ?? [])) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const updated = this.storage.db.prepare(
        `UPDATE jobs SET status='leased',lease_owner=?,lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
         WHERE venture_id=? AND id=? AND status='queued'`
      ).run(workerId, leaseToken, leaseExpiresAt, now.toISOString(), String(row.venture_id), String(row.id));
      if (Number(updated.changes) !== 1) return undefined;
      this.storage.db.prepare("UPDATE tasks SET status='running',attempt_count=attempt_count+1,updated_at=? WHERE venture_id=? AND id=?")
        .run(now.toISOString(), String(row.venture_id), String(row.task_id));
      return jobFromRow({ ...row, status: "leased", lease_owner: workerId, lease_token: leaseToken, lease_expires_at: leaseExpiresAt, attempt_count: Number(row.attempt_count) + 1, updated_at: now.toISOString() });
    });
  }

  async renewJobLease(workspaceId: string, companyId: string, jobId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    this.assertCompany(workspaceId, companyId);
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.storage.db.prepare(
      "UPDATE jobs SET lease_expires_at=?,updated_at=? WHERE venture_id=? AND id=? AND status='leased' AND lease_token=? AND lease_expires_at>=?"
    ).run(expiresAt, nowIso(), companyId, jobId, leaseToken, nowIso());
    return Number(result.changes) === 1;
  }

  async completeJob(workspaceId: string, companyId: string, jobId: string, leaseToken: string): Promise<boolean> {
    this.assertCompany(workspaceId, companyId);
    return this.storage.transaction(() => {
      const row = this.storage.db.prepare("SELECT task_id FROM jobs WHERE venture_id=? AND id=? AND status='leased' AND lease_token=? AND lease_expires_at>=?")
        .get(companyId, jobId, leaseToken, nowIso()) as { task_id: string } | undefined;
      if (!row) return false;
      const unresolved = this.storage.db.prepare(
        "SELECT 1 FROM effect_reservations WHERE venture_id=? AND job_id=? AND status<>'committed' LIMIT 1"
      ).get(companyId, jobId);
      if (unresolved) throw new KernelStorageConflictError("job has an unresolved external effect");
      const at = nowIso();
      this.storage.db.prepare("UPDATE jobs SET status='succeeded',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE venture_id=? AND id=?")
        .run(at, companyId, jobId);
      this.storage.db.prepare("UPDATE tasks SET status='succeeded',updated_at=? WHERE venture_id=? AND id=?").run(at, companyId, row.task_id);
      return true;
    });
  }

  async failJob(input: { workspaceId: string; companyId: string; jobId: string; leaseToken: string; error: string; retryAt?: string; deadLetter?: boolean }): Promise<boolean> {
    this.assertCompany(input.workspaceId, input.companyId);
    return this.storage.transaction(() => {
      const at = nowIso();
      const row = this.storage.db.prepare("SELECT task_id FROM jobs WHERE venture_id=? AND id=? AND status='leased' AND lease_token=? AND lease_expires_at>=?")
        .get(input.companyId, input.jobId, input.leaseToken, at) as { task_id: string } | undefined;
      if (!row) return false;
      this.storage.db.prepare(
        "UPDATE effect_reservations SET status='needs-reconciliation',updated_at=? WHERE venture_id=? AND job_id=? AND status='reserved'"
      ).run(at, input.companyId, input.jobId);
      const status = input.deadLetter ? "dead-letter" : "queued";
      this.storage.db.prepare(
        "UPDATE jobs SET status=?,available_at=COALESCE(?,available_at),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE venture_id=? AND id=?"
      ).run(status, input.retryAt ?? null, input.error.slice(0, 4000), at, input.companyId, input.jobId);
      this.storage.db.prepare("UPDATE tasks SET status=?,dead_letter_reason=?,updated_at=? WHERE venture_id=? AND id=?")
        .run(status, input.deadLetter ? input.error.slice(0, 4000) : null, at, input.companyId, row.task_id);
      return true;
    });
  }

  async recoverExpiredJobs(workspaceId: string, at = nowIso()): Promise<number> {
    requireWorkspaceId(workspaceId);
    return this.storage.transaction(() => {
      this.storage.db.prepare(
        `UPDATE effect_reservations SET status='needs-reconciliation',updated_at=?
         WHERE status='reserved' AND EXISTS (
           SELECT 1 FROM jobs j JOIN ventures v ON v.id=j.venture_id
           WHERE j.venture_id=effect_reservations.venture_id AND j.id=effect_reservations.job_id
             AND v.workspace_id=? AND j.status='leased' AND j.lease_expires_at<?
         )`
      ).run(at, workspaceId, at);
      const result = this.storage.db.prepare(
        `UPDATE jobs SET status='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
         WHERE status='leased' AND lease_expires_at<? AND venture_id IN (SELECT id FROM ventures WHERE workspace_id=?)`
      ).run(at, at, workspaceId);
      return Number(result.changes);
    });
  }

  async putEntitlement(rawInput: CompanyEntitlementInput): Promise<{ applied: boolean; entitlement: CompanyEntitlement }> {
    const input = normalizeEntitlementInput(rawInput);
    this.assertCompany(input.workspaceId, input.companyId);
    const updatedAt = nowIso();
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT * FROM company_entitlements WHERE venture_id=?").get(input.companyId) as Record<string, unknown> | undefined;
      if (prior) {
        const current = entitlementFromRow(input.workspaceId, prior);
        if (current.providerEventId === input.providerEventId) {
          const replay = current.status === input.status
            && current.plan === input.plan
            && current.periodStart === input.periodStart
            && current.periodEnd === input.periodEnd
            && current.modelCostCapCents === input.modelCostCapCents
            && current.providerOrder === input.providerOrder
            && current.observedAt === input.observedAt;
          if (!replay) throw new KernelStorageConflictError("entitlement event idempotency conflict");
          return { applied: false, entitlement: current };
        }
        if (input.providerOrder < current.providerOrder) return { applied: false, entitlement: current };
        if (input.providerOrder === current.providerOrder) throw new KernelStorageConflictError("entitlement provider order conflict");
        const verifiedNewPeriod = input.periodStart > current.periodStart && input.periodStart >= current.periodEnd;
        if (verifiedNewPeriod && current.reservedCostCents !== 0) throw new KernelStorageConflictError("cannot roll entitlement period with reserved cost");
        this.storage.db.prepare(
          `UPDATE company_entitlements SET status=?,plan=?,period_start=?,period_end=?,model_cost_cap_cents=?,
           spent_cost_cents=?,reserved_cost_cents=?,provider_event_id=?,provider_order=?,observed_at=?,updated_at=? WHERE venture_id=?`
        ).run(
          input.status,
          input.plan,
          input.periodStart,
          input.periodEnd,
          input.modelCostCapCents,
          verifiedNewPeriod ? 0 : current.spentCostCents,
          verifiedNewPeriod ? 0 : current.reservedCostCents,
          input.providerEventId,
          input.providerOrder,
          input.observedAt,
          updatedAt,
          input.companyId
        );
      } else {
        this.storage.db.prepare(
          `INSERT INTO company_entitlements(venture_id,status,plan,period_start,period_end,model_cost_cap_cents,spent_cost_cents,reserved_cost_cents,provider_event_id,provider_order,observed_at,updated_at)
           VALUES(?,?,?,?,?,?,0,0,?,?,?,?)`
        ).run(input.companyId, input.status, input.plan, input.periodStart, input.periodEnd, input.modelCostCapCents, input.providerEventId, input.providerOrder, input.observedAt, updatedAt);
      }
      const eventId = `event_entitlement_${sha256({ companyId: input.companyId, providerEventId: input.providerEventId }).slice(0, 24)}`;
      this.storage.db.prepare(
        "INSERT OR IGNORE INTO audit_events(venture_id,id,event_type,actor,entity_type,entity_id,payload_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(input.companyId, eventId, "entitlement-observed", "billing-system", "entitlement", input.companyId, jsonText(input), input.observedAt);
      const row = this.storage.db.prepare("SELECT * FROM company_entitlements WHERE venture_id=?").get(input.companyId) as Record<string, unknown>;
      return { applied: true, entitlement: entitlementFromRow(input.workspaceId, row) };
    });
  }

  async getEntitlement(workspaceId: string, companyId: string): Promise<CompanyEntitlement | undefined> {
    this.assertCompany(workspaceId, companyId);
    const row = this.storage.db.prepare("SELECT * FROM company_entitlements WHERE venture_id=?").get(companyId) as Record<string, unknown> | undefined;
    return row ? entitlementFromRow(workspaceId, row) : undefined;
  }

  async reserveEffect(input: EffectReservationInput): Promise<{ reserved: boolean; reservation?: EffectReservation; reason?: "entitlement" | "action-cap" }> {
    validateEffectInput(input);
    this.assertCompany(input.workspaceId, input.companyId);
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT * FROM effect_reservations WHERE venture_id=? AND idempotency_key=?")
        .get(input.companyId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (prior) {
        const reservation = effectFromRow(input.workspaceId, prior);
        const replay = reservation.jobId === input.jobId
          && reservation.taskId === input.taskId
          && reservation.provider === input.provider
          && reservation.effectType === input.effectType
          && reservation.requestHash === input.requestHash
          && reservation.providerIdempotencyKey === input.providerIdempotencyKey;
        if (!replay) throw new KernelStorageConflictError("effect idempotency conflict");
        return { reserved: false, reservation };
      }
      const entitlementRow = this.storage.db.prepare("SELECT * FROM company_entitlements WHERE venture_id=?").get(input.companyId) as Record<string, unknown> | undefined;
      if (!entitlementRow || !entitlementAdmits(entitlementFromRow(input.workspaceId, entitlementRow))) {
        return { reserved: false, reason: "entitlement" };
      }
      const job = this.storage.db.prepare(
        "SELECT task_id FROM jobs WHERE venture_id=? AND id=? AND task_id=? AND status='leased' AND lease_token=? AND lease_expires_at>=?"
      ).get(input.companyId, input.jobId, input.taskId, input.leaseToken, nowIso());
      if (!job) throw new KernelStorageConflictError("effect reservation requires the active job lease");
      if (input.actionLimits) {
        const observedAt = new Date(input.actionLimits.observedAt).getTime();
        const daily = this.storage.db.prepare(
          "SELECT COUNT(*) AS count FROM effect_reservations WHERE venture_id=? AND provider=? AND effect_type=? AND created_at>=?"
        ).get(input.companyId, input.provider, input.effectType, new Date(observedAt - 24 * 60 * 60_000).toISOString()) as { count: number };
        const weekly = this.storage.db.prepare(
          "SELECT COUNT(*) AS count FROM effect_reservations WHERE venture_id=? AND provider=? AND effect_type=? AND created_at>=?"
        ).get(input.companyId, input.provider, input.effectType, new Date(observedAt - 7 * 24 * 60 * 60_000).toISOString()) as { count: number };
        if (Number(daily.count) >= input.actionLimits.daily || Number(weekly.count) >= input.actionLimits.weekly) return { reserved: false, reason: "action-cap" };
      }
      const at = nowIso();
      this.storage.db.prepare(
        `INSERT INTO effect_reservations(venture_id,idempotency_key,job_id,task_id,provider,effect_type,request_hash,provider_idempotency_key,status,
         lease_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?,?)`
      ).run(input.companyId, input.idempotencyKey, input.jobId, input.taskId, input.provider, input.effectType, input.requestHash, input.providerIdempotencyKey, input.leaseToken, at, at);
      const row = this.storage.db.prepare("SELECT * FROM effect_reservations WHERE venture_id=? AND idempotency_key=?")
        .get(input.companyId, input.idempotencyKey) as Record<string, unknown>;
      return { reserved: true, reservation: effectFromRow(input.workspaceId, row) };
    });
  }

  async commitEffect(input: { workspaceId: string; companyId: string; idempotencyKey: string; leaseToken: string; result: unknown; reconciled?: boolean }): Promise<{ committed: boolean; reservation: EffectReservation }> {
    this.assertCompany(input.workspaceId, input.companyId);
    const resultJson = jsonText(input.result);
    return this.storage.transaction(() => {
      const row = this.storage.db.prepare("SELECT * FROM effect_reservations WHERE venture_id=? AND idempotency_key=?")
        .get(input.companyId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (!row) throw new KernelStorageConflictError("effect reservation not found");
      const reservation = effectFromRow(input.workspaceId, row);
      if (reservation.status === "committed") {
        if (canonicalize(reservation.result) !== resultJson) {
          throw new KernelStorageConflictError("effect result idempotency conflict");
        }
        return { committed: false, reservation };
      }
      const activeJob = this.storage.db.prepare(
        "SELECT 1 FROM jobs WHERE venture_id=? AND id=? AND status='leased' AND lease_token=? AND lease_expires_at>=?"
      ).get(input.companyId, reservation.jobId, input.leaseToken, nowIso());
      if (!activeJob) throw new KernelStorageConflictError("effect commit requires the active job lease");
      if (reservation.status === "reserved" && reservation.leaseToken !== input.leaseToken) throw new KernelStorageConflictError("stale effect lease");
      if (reservation.status === "needs-reconciliation" && input.reconciled !== true) throw new KernelStorageConflictError("effect requires authoritative reconciliation");
      const at = nowIso();
      this.storage.db.prepare(
        "UPDATE effect_reservations SET status='committed',lease_token=?,result_json=?,updated_at=? WHERE venture_id=? AND idempotency_key=?"
      ).run(input.leaseToken, resultJson, at, input.companyId, input.idempotencyKey);
      const committed = this.storage.db.prepare("SELECT * FROM effect_reservations WHERE venture_id=? AND idempotency_key=?")
        .get(input.companyId, input.idempotencyKey) as Record<string, unknown>;
      return { committed: true, reservation: effectFromRow(input.workspaceId, committed) };
    });
  }

  async reserveCost(rawInput: { workspaceId: string; companyId: string; id: string; taskId?: string; amountCents: number; provider: string; expiresAt: string }): Promise<{ reserved: boolean; reservation?: CostReservation; reason?: "entitlement" | "cost-cap" | "settled" }> {
    this.assertCompany(rawInput.workspaceId, rawInput.companyId);
    requireNonNegativeInteger(rawInput.amountCents, "cost reservation amount");
    const expiresAt = normalizedTimestamp(rawInput.expiresAt, "cost reservation expiry");
    const now = Date.now();
    if (new Date(expiresAt).getTime() <= now) throw new TypeError("cost reservation expiry must be in the future");
    const input = { ...rawInput, expiresAt };
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT * FROM cost_reservations WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown> | undefined;
      if (prior) {
        const reservation = this.sqliteCostReservation(input.workspaceId, prior);
        const replay = reservation.taskId === input.taskId
          && reservation.amountCents === input.amountCents
          && reservation.provider === input.provider;
        if (!replay) throw new KernelStorageConflictError("cost reservation idempotency conflict");
        if (reservation.status === "settled") return { reserved: false, reservation, reason: "settled" };
        if (reservation.status === "reserved" && new Date(reservation.expiresAt).getTime() > now) {
          return { reserved: true, reservation };
        }
        if (reservation.status === "reserved") {
          const released = this.storage.db.prepare(
            "UPDATE company_entitlements SET reserved_cost_cents=reserved_cost_cents-?,updated_at=? WHERE venture_id=? AND reserved_cost_cents>=?"
          ).run(reservation.amountCents, nowIso(), input.companyId, reservation.amountCents);
          if (Number(released.changes) !== 1) throw new KernelStorageConflictError("cost reservation accounting conflict");
          this.storage.db.prepare("UPDATE cost_reservations SET status='released',updated_at=? WHERE venture_id=? AND id=?")
            .run(nowIso(), input.companyId, input.id);
        }
      }
      const entitlementRow = this.storage.db.prepare("SELECT * FROM company_entitlements WHERE venture_id=?").get(input.companyId) as Record<string, unknown> | undefined;
      if (!entitlementRow || !entitlementAdmits(entitlementFromRow(input.workspaceId, entitlementRow), now)) {
        return { reserved: false, reason: "entitlement" };
      }
      const budget = this.storage.db.prepare(
        `UPDATE company_entitlements SET reserved_cost_cents=reserved_cost_cents+?,updated_at=?
         WHERE venture_id=? AND spent_cost_cents+reserved_cost_cents+?<=model_cost_cap_cents`
      ).run(input.amountCents, nowIso(), input.companyId, input.amountCents);
      if (Number(budget.changes) !== 1) return { reserved: false, reason: "cost-cap" };
      const at = nowIso();
      if (prior) {
        this.storage.db.prepare(
          "UPDATE cost_reservations SET status='reserved',actual_cost_cents=NULL,expires_at=?,updated_at=? WHERE venture_id=? AND id=?"
        ).run(input.expiresAt, at, input.companyId, input.id);
      } else {
        this.storage.db.prepare(
          `INSERT INTO cost_reservations(venture_id,id,task_id,amount_cents,provider,status,expires_at,created_at,updated_at)
           VALUES(?,?,?,?,?,'reserved',?,?,?)`
        ).run(input.companyId, input.id, input.taskId ?? null, input.amountCents, input.provider, input.expiresAt, at, at);
      }
      const row = this.storage.db.prepare("SELECT * FROM cost_reservations WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown>;
      return { reserved: true, reservation: this.sqliteCostReservation(input.workspaceId, row) };
    });
  }

  private sqliteCostReservation(workspaceId: string, row: Record<string, unknown>): CostReservation {
    return {
      workspaceId,
      companyId: String(row.venture_id),
      id: String(row.id),
      ...(optionalString(row.task_id) ? { taskId: String(row.task_id) } : {}),
      amountCents: Number(row.amount_cents),
      status: String(row.status) as CostReservation["status"],
      ...(row.actual_cost_cents === null || row.actual_cost_cents === undefined ? {} : { actualCostCents: Number(row.actual_cost_cents) }),
      provider: String(row.provider),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  async settleCost(input: { workspaceId: string; companyId: string; id: string; actualCostCents: number; sourceRef?: string }): Promise<{ settled: boolean; reservation: CostReservation }> {
    this.assertCompany(input.workspaceId, input.companyId);
    requireNonNegativeInteger(input.actualCostCents, "actual cost");
    return this.storage.transaction(() => {
      const row = this.storage.db.prepare("SELECT * FROM cost_reservations WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown> | undefined;
      if (!row) throw new KernelStorageConflictError("cost reservation not found");
      const reservation = this.sqliteCostReservation(input.workspaceId, row);
      if (reservation.status === "settled") {
        if (reservation.actualCostCents !== input.actualCostCents) throw new KernelStorageConflictError("cost settlement idempotency conflict");
        return { settled: false, reservation };
      }
      if (reservation.status !== "reserved") throw new KernelStorageConflictError("cost reservation is not active");
      if (input.actualCostCents > reservation.amountCents) throw new KernelStorageConflictError("actual cost exceeds reservation");
      const at = nowIso();
      this.storage.db.prepare(
        `UPDATE company_entitlements SET reserved_cost_cents=reserved_cost_cents-?,spent_cost_cents=spent_cost_cents+?,updated_at=?
         WHERE venture_id=? AND reserved_cost_cents>=?`
      ).run(reservation.amountCents, input.actualCostCents, at, input.companyId, reservation.amountCents);
      this.storage.db.prepare(
        "INSERT INTO cost_entries(venture_id,id,task_id,amount_cents,provider,source_ref,occurred_at) VALUES(?,?,?,?,?,?,?)"
      ).run(input.companyId, input.id, reservation.taskId ?? null, input.actualCostCents, reservation.provider, input.sourceRef ?? input.id, at);
      this.storage.db.prepare("UPDATE cost_reservations SET status='settled',actual_cost_cents=?,updated_at=? WHERE venture_id=? AND id=?")
        .run(input.actualCostCents, at, input.companyId, input.id);
      const settled = this.storage.db.prepare("SELECT * FROM cost_reservations WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown>;
      return { settled: true, reservation: this.sqliteCostReservation(input.workspaceId, settled) };
    });
  }

  async releaseExpiredCostReservations(workspaceId: string, at = nowIso()): Promise<number> {
    requireWorkspaceId(workspaceId);
    return this.storage.transaction(() => {
      const rows = sqliteRows(this.storage.db.prepare(
        `SELECT cr.* FROM cost_reservations cr JOIN ventures v ON v.id=cr.venture_id
         WHERE v.workspace_id=? AND cr.status='reserved' AND cr.expires_at<?`
      ), workspaceId, at);
      for (const row of rows) {
        this.storage.db.prepare(
          "UPDATE company_entitlements SET reserved_cost_cents=reserved_cost_cents-?,updated_at=? WHERE venture_id=? AND reserved_cost_cents>=?"
        ).run(Number(row.amount_cents), at, String(row.venture_id), Number(row.amount_cents));
        this.storage.db.prepare("UPDATE cost_reservations SET status='released',updated_at=? WHERE venture_id=? AND id=?")
          .run(at, String(row.venture_id), String(row.id));
      }
      return rows.length;
    });
  }


  async createApproval(input: { workspaceId: string; companyId: string; id: string; taskId: string; actionDigest: string; packet: unknown; expiresAt: string }): Promise<{ created: boolean }> {
    this.assertCompany(input.workspaceId, input.companyId);
    const packetJson = jsonText(input.packet);
    const expiresAt = normalizedTimestamp(input.expiresAt, "approval expiry");
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT * FROM approvals WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown> | undefined;
      if (prior) {
        const replay = String(prior.task_id) === input.taskId
          && String(prior.action_digest) === input.actionDigest
          && String(prior.packet_json) === packetJson
          && timestamp(prior.expires_at) === expiresAt;
        if (!replay) throw new KernelStorageConflictError("approval idempotency conflict");
        return { created: false };
      }
      const task = this.storage.db.prepare("SELECT status,action_digest FROM tasks WHERE venture_id=? AND id=?")
        .get(input.companyId, input.taskId) as { status: string; action_digest: string } | undefined;
      if (!task || task.status !== "blocked" || task.action_digest !== input.actionDigest) {
        throw new KernelStorageConflictError("approval requires the exact blocked task digest");
      }
      this.storage.db.prepare(
        "INSERT INTO approvals(venture_id,id,task_id,action_digest,status,packet_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(input.companyId, input.id, input.taskId, input.actionDigest, "pending", packetJson, expiresAt, nowIso());
      return { created: true };
    });
  }

  async listPendingApprovals(workspaceId: string, companyId?: string): Promise<KernelApproval[]> {
    requireWorkspaceId(workspaceId);
    if (companyId) this.assertCompany(workspaceId, companyId);
    const rows = companyId
      ? sqliteRows(this.storage.db.prepare(
          `SELECT a.* FROM approvals a JOIN ventures v ON v.id=a.venture_id
           WHERE v.workspace_id=? AND a.venture_id=? AND a.status='pending' AND a.expires_at>? ORDER BY a.created_at,a.id`
        ), workspaceId, companyId, nowIso())
      : sqliteRows(this.storage.db.prepare(
          `SELECT a.* FROM approvals a JOIN ventures v ON v.id=a.venture_id
           WHERE v.workspace_id=? AND a.status='pending' AND a.expires_at>? ORDER BY a.created_at,a.id`
        ), workspaceId, nowIso());
    return rows.map((row) => approvalFromRow(workspaceId, row));
  }

  async getApproval(workspaceId: string, companyId: string, approvalId: string): Promise<KernelApproval | undefined> {
    this.assertCompany(workspaceId, companyId);
    const row = this.storage.db.prepare("SELECT * FROM approvals WHERE venture_id=? AND id=?").get(companyId, approvalId) as Record<string, unknown> | undefined;
    return row ? approvalFromRow(workspaceId, row) : undefined;
  }

  async resolveApproval(input: { workspaceId: string; companyId: string; approvalId: string; expectedActionDigest: string; resolution: "approved" | "revoked"; resolutionId: string; actor: string; resolvedAt: string }): Promise<{ applied: boolean; status: "approved" | "revoked"; taskId: string; jobId?: string }> {
    this.assertCompany(input.workspaceId, input.companyId);
    const resolvedAt = normalizedTimestamp(input.resolvedAt, "approval resolution timestamp");
    return this.storage.transaction(() => {
      const row = this.storage.db.prepare("SELECT * FROM approvals WHERE venture_id=? AND id=?").get(input.companyId, input.approvalId) as Record<string, unknown> | undefined;
      if (!row) throw new KernelStorageConflictError("approval not found");
      if (String(row.action_digest) !== input.expectedActionDigest) throw new KernelStorageConflictError("approval action digest conflict");
      const taskId = String(row.task_id);
      const task = this.storage.db.prepare("SELECT status,action_digest,definition_json FROM tasks WHERE venture_id=? AND id=?")
        .get(input.companyId, taskId) as { status: string; action_digest: string; definition_json: string } | undefined;
      if (!task || task.action_digest !== input.expectedActionDigest) {
        throw new KernelStorageConflictError("approval task is not the exact blocked digest");
      }
      const binding = input.resolution === "approved" ? approvedGoldenJobBinding(task.definition_json, input.approvalId) : undefined;
      const jobId = binding ? makeId("job", { ventureId: input.companyId, taskId, kind: binding.kind }) : undefined;
      if (row.resolution_id !== null && row.resolution_id !== undefined) {
        if (String(row.resolution_id) !== input.resolutionId || String(row.status) !== input.resolution) throw new KernelStorageConflictError("approval resolution conflict");
        return { applied: false, status: input.resolution, taskId, ...(jobId ? { jobId } : {}) };
      }
      if (String(row.status) !== "pending") throw new KernelStorageConflictError("approval is not pending");
      if (timestamp(row.expires_at) < resolvedAt) throw new KernelStorageConflictError("approval expired");
      if (task.status !== "blocked") {
        throw new KernelStorageConflictError("approval task is not the exact blocked digest");
      }
      this.storage.db.prepare(
        `UPDATE approvals SET status=?,resolution_id=?,resolution_actor=?,resolved_at=?,approver=?,revoked_at=?
         WHERE venture_id=? AND id=? AND status='pending' AND action_digest=?`
      ).run(input.resolution, input.resolutionId, input.actor, resolvedAt, input.resolution === "approved" ? input.actor : null, input.resolution === "revoked" ? resolvedAt : null, input.companyId, input.approvalId, input.expectedActionDigest);
      if (input.resolution === "revoked") {
        this.storage.db.prepare("UPDATE tasks SET status='cancelled',cancelled_at=?,updated_at=? WHERE venture_id=? AND id=? AND status='blocked'")
          .run(resolvedAt, resolvedAt, input.companyId, taskId);
        return { applied: true, status: input.resolution, taskId };
      }
      this.storage.db.prepare("UPDATE tasks SET status='ready',updated_at=? WHERE venture_id=? AND id=? AND status='blocked' AND action_digest=?")
        .run(resolvedAt, input.companyId, taskId, input.expectedActionDigest);
      const payload = {
        ventureId: input.companyId,
        taskId,
        actionDigest: input.expectedActionDigest,
        executionClass: binding!.kind,
        capabilityId: binding!.capabilityId
      };
      this.storage.db.prepare(
        `INSERT INTO jobs(venture_id,id,task_id,kind,status,payload_json,available_at,attempt_count,created_at,updated_at)
         VALUES(?,?,?,?, 'queued',?,?,0,?,?)`
      ).run(input.companyId, jobId!, taskId, binding!.kind, jsonText(payload), resolvedAt, resolvedAt, resolvedAt);
      return { applied: true, status: input.resolution, taskId, jobId: jobId! };
    });
  }

  async putSecretMetadata(input: SecretMetadata): Promise<{ created: boolean }> {
    validateSecretMetadata(input);
    this.assertCompany(input.workspaceId, input.companyId);
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT * FROM secret_metadata WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown> | undefined;
      if (prior) {
        if (canonicalize(secretFromRow(input.workspaceId, prior)) !== canonicalize(input)) throw new KernelStorageConflictError("secret metadata idempotency conflict");
        return { created: false };
      }
      this.storage.db.prepare(
        "INSERT INTO secret_metadata(venture_id,id,provider,purpose,opaque_ref,status,created_at,rotated_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(input.companyId, input.id, input.provider, input.purpose, input.opaqueRef, input.status, input.createdAt, input.rotatedAt ?? null);
      return { created: true };
    });
  }

  async putWorkerSecretEnvelope(input: WorkerSecretEnvelope): Promise<{ created: boolean }> {
    validateSecretEnvelope(input);
    this.assertCompany(input.workspaceId, input.companyId);
    return this.storage.transaction(() => {
      const metadata = this.storage.db.prepare("SELECT status FROM secret_metadata WHERE venture_id=? AND id=?")
        .get(input.companyId, input.id) as { status: string } | undefined;
      if (metadata?.status !== "active") throw new KernelStorageConflictError("secret envelope requires active metadata");
      const prior = this.storage.db.prepare("SELECT * FROM secret_envelopes WHERE venture_id=? AND id=?").get(input.companyId, input.id) as Record<string, unknown> | undefined;
      if (prior) {
        const replay = String(prior.ciphertext) === input.ciphertext
          && String(prior.key_id) === input.keyId
          && String(prior.aad_hash) === input.aadHash
          && String(prior.created_at) === input.createdAt
          && String(prior.updated_at) === input.updatedAt;
        if (!replay) throw new KernelStorageConflictError("secret envelope idempotency conflict");
        return { created: false };
      }
      this.storage.db.prepare(
        "INSERT INTO secret_envelopes(venture_id,id,ciphertext,key_id,aad_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
      ).run(input.companyId, input.id, input.ciphertext, input.keyId, input.aadHash, input.createdAt, input.updatedAt);
      return { created: true };
    });
  }

  async getWorkerSecretEnvelope(workspaceId: string, companyId: string, id: string): Promise<WorkerSecretEnvelope | undefined> {
    this.assertCompany(workspaceId, companyId);
    const row = this.storage.db.prepare(
      "SELECT se.* FROM secret_envelopes se JOIN secret_metadata sm ON sm.venture_id=se.venture_id AND sm.id=se.id WHERE se.venture_id=? AND se.id=? AND sm.status='active'"
    ).get(companyId, id) as Record<string, unknown> | undefined;
    return row ? {
      workspaceId,
      companyId,
      id: String(row.id),
      ciphertext: String(row.ciphertext),
      keyId: String(row.key_id),
      aadHash: String(row.aad_hash),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    } : undefined;
  }

  async revokeSecretMetadata(workspaceId: string, companyId: string, id: string, rotatedAt: string): Promise<boolean> {
    this.assertCompany(workspaceId, companyId);
    const normalizedRotatedAt = normalizedTimestamp(rotatedAt, "secret rotation timestamp");
    return this.storage.transaction(() => {
      const prior = this.storage.db.prepare("SELECT status,rotated_at FROM secret_metadata WHERE venture_id=? AND id=?")
        .get(companyId, id) as { status: string; rotated_at: string | null } | undefined;
      if (!prior) return false;
      if (prior.status === "revoked") {
        this.storage.db.prepare("DELETE FROM secret_envelopes WHERE venture_id=? AND id=?").run(companyId, id);
        if (prior.rotated_at === normalizedRotatedAt) return false;
        throw new KernelStorageConflictError("secret metadata revocation conflict");
      }
      this.storage.db.prepare("DELETE FROM secret_envelopes WHERE venture_id=? AND id=?").run(companyId, id);
      this.storage.db.prepare("UPDATE secret_metadata SET status='revoked',rotated_at=? WHERE venture_id=? AND id=? AND status='active'")
        .run(normalizedRotatedAt, companyId, id);
      return true;
    });
  }

  async listSecretMetadata(workspaceId: string, companyId: string): Promise<SecretMetadata[]> {
    this.assertCompany(workspaceId, companyId);
    return sqliteRows(this.storage.db.prepare("SELECT * FROM secret_metadata WHERE venture_id=? ORDER BY id"), companyId)
      .map((row) => secretFromRow(workspaceId, row));
  }

  async exportCompany(workspaceId: string, companyId: string): Promise<KernelCompanyExport> {
    this.assertCompany(workspaceId, companyId);
    const tables: Record<string, unknown[]> = {
      workspaces: sqliteRows(this.storage.db.prepare("SELECT * FROM workspaces WHERE id=?"), workspaceId),
      ventures: sqliteRows(this.storage.db.prepare("SELECT * FROM ventures WHERE id=? AND workspace_id=?"), companyId, workspaceId)
    };
    const scoped = sqliteRows(this.storage.db.prepare(
      `SELECT m.name FROM sqlite_master m
       WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT IN ('workspaces','ventures','schema_migrations','secret_envelopes')
         AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='venture_id')
       ORDER BY m.name`
    ));
    for (const { name } of scoped) {
      const table = String(name);
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error("unsafe SQLite table name");
      tables[table] = sqliteRows(this.storage.db.prepare(`SELECT * FROM "${table}" WHERE venture_id=?`), companyId)
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key.endsWith("_json") && typeof value === "string" ? parseJson(value) : value])));
    }
    return { schemaVersion: 1, exportedAt: nowIso(), workspaceId, companyId, tables };
  }

  async deleteCompany(workspaceId: string, companyId: string): Promise<boolean> {
    if (!this.storage.isVentureInWorkspace(workspaceId, companyId)) return false;
    return this.storage.transaction(() => {
      const triggers = sqliteRows(this.storage.db.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND lower(name) LIKE '%immutable_delete' ORDER BY name"
      ));
      for (const trigger of triggers) {
        const name = String(trigger.name);
        if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe SQLite trigger name");
        this.storage.db.exec(`DROP TRIGGER "${name}"`);
      }
      this.storage.db.exec("PRAGMA defer_foreign_keys=ON");
      const scoped = sqliteRows(this.storage.db.prepare(
        `SELECT m.name FROM sqlite_master m
         WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT IN ('workspaces','ventures','schema_migrations')
           AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='venture_id')`
      ));
      for (const { name } of scoped) {
        const table = String(name);
        if (!/^[a-z0-9_]+$/.test(table)) throw new Error("unsafe SQLite table name");
        this.storage.db.prepare(`DELETE FROM "${table}" WHERE venture_id=?`).run(companyId);
      }
      this.storage.db.prepare("DELETE FROM ventures WHERE id=? AND workspace_id=?").run(companyId, workspaceId);
      for (const trigger of triggers) this.storage.db.exec(String(trigger.sql));
      return true;
    });
  }

  async close(): Promise<void> {
    // EngineStorage owns the shared SQLite connection.
  }
}

function postgresKernelSchema(schema: string): string {
  const q = `"${schema}"`;
  return `
    CREATE TABLE IF NOT EXISTS ${q}.workspaces (
      id text PRIMARY KEY CHECK (id LIKE 'workspace\\_%' ESCAPE '\\'),
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${q}.ventures (
      id text PRIMARY KEY CHECK (id LIKE 'venture\\_%' ESCAPE '\\'),
      slug text NOT NULL UNIQUE,
      company_slug text NOT NULL,
      name text NOT NULL,
      owner text NOT NULL,
      owning_repo text NOT NULL,
      lifecycle_state text NOT NULL,
      current_pack_hash text,
      current_pack_revision_id text,
      kill_switch boolean NOT NULL DEFAULT false,
      workspace_id text NOT NULL REFERENCES ${q}.workspaces(id) ON DELETE RESTRICT,
      state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      state_version integer NOT NULL DEFAULT 1 CHECK (state_version >= 1),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (workspace_id, company_slug)
    );
    CREATE TABLE IF NOT EXISTS ${q}.workspace_members (
      auth_subject uuid PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES ${q}.workspaces(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner','operator','viewer')),
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${q}.auth_rate_limits (
      bucket_key text PRIMARY KEY CHECK (length(bucket_key)=64),
      request_count integer NOT NULL CHECK (request_count >= 1),
      reset_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${q}.evidence (
      venture_id text NOT NULL REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      id text NOT NULL,
      type text NOT NULL,
      proof_tier text NOT NULL,
      authority text NOT NULL,
      source_ref text NOT NULL,
      observed_at timestamptz NOT NULL,
      expires_at timestamptz,
      status text NOT NULL,
      content_hash text NOT NULL,
      metadata_json jsonb NOT NULL,
      PRIMARY KEY (venture_id,id),
      UNIQUE (venture_id,type,content_hash)
    );
    CREATE TABLE IF NOT EXISTS ${q}.tasks (
      venture_id text NOT NULL REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      id text NOT NULL,
      play_id text,
      purpose text NOT NULL,
      owner_role text NOT NULL,
      mode text NOT NULL,
      gate_class text NOT NULL,
      status text NOT NULL,
      expected_proof text NOT NULL,
      definition_json jsonb NOT NULL,
      action_digest text NOT NULL,
      idempotency_key text NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      cancelled_at timestamptz,
      dead_letter_reason text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,id),
      UNIQUE (venture_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS ${q}.task_dependencies (
      venture_id text NOT NULL,
      task_id text NOT NULL,
      depends_on_task_id text NOT NULL,
      PRIMARY KEY (venture_id,task_id,depends_on_task_id),
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE CASCADE,
      FOREIGN KEY (venture_id,depends_on_task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${q}.jobs (
      venture_id text NOT NULL,
      id text NOT NULL,
      task_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      payload_json jsonb NOT NULL,
      available_at timestamptz NOT NULL,
      lease_owner text,
      lease_token text,
      lease_expires_at timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,id),
      UNIQUE (venture_id,task_id,kind),
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${q}.receipts (
      venture_id text NOT NULL REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      id text NOT NULL,
      task_id text,
      dispatch_id text,
      proof_tier text NOT NULL,
      outcome text NOT NULL,
      actor text NOT NULL,
      adapter text NOT NULL,
      artifact_path text NOT NULL,
      content_hash text NOT NULL,
      occurred_at timestamptz NOT NULL,
      metadata_json jsonb NOT NULL,
      origin text NOT NULL,
      PRIMARY KEY (venture_id,id),
      UNIQUE (venture_id,content_hash),
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ${q}.approvals (
      venture_id text NOT NULL,
      id text NOT NULL,
      task_id text NOT NULL,
      action_digest text NOT NULL,
      status text NOT NULL,
      packet_json jsonb NOT NULL,
      approver text,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL,
      resolution_id text,
      resolved_at timestamptz,
      resolution_actor text,
      PRIMARY KEY (venture_id,id),
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${q}.cost_entries (
      venture_id text NOT NULL,
      id text NOT NULL,
      task_id text,
      amount_cents integer NOT NULL CHECK (amount_cents >= 0),
      provider text NOT NULL,
      source_ref text,
      occurred_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,id),
      FOREIGN KEY (venture_id) REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ${q}.audit_events (
      venture_id text NOT NULL REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      id text NOT NULL,
      event_type text NOT NULL,
      actor text NOT NULL,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      payload_json jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,id)
    );
    CREATE TABLE IF NOT EXISTS ${q}.company_entitlements (
      venture_id text PRIMARY KEY REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      status text NOT NULL,
      plan text NOT NULL,
      period_start timestamptz NOT NULL,
      period_end timestamptz NOT NULL,
      model_cost_cap_cents integer NOT NULL CHECK (model_cost_cap_cents >= 0),
      spent_cost_cents integer NOT NULL DEFAULT 0 CHECK (spent_cost_cents >= 0),
      reserved_cost_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cost_cents >= 0),
      provider_event_id text NOT NULL,
      provider_order bigint NOT NULL DEFAULT 0 CHECK (provider_order >= 0),
      observed_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${q}.effect_reservations (
      venture_id text NOT NULL,
      idempotency_key text NOT NULL,
      job_id text NOT NULL,
      task_id text NOT NULL,
      provider text NOT NULL,
      effect_type text NOT NULL,
      request_hash text NOT NULL,
      provider_idempotency_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('reserved','needs-reconciliation','committed')),
      lease_token text NOT NULL,
      result_json jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,idempotency_key),
      UNIQUE (venture_id,provider,provider_idempotency_key),
      FOREIGN KEY (venture_id,job_id) REFERENCES ${q}.jobs(venture_id,id) ON DELETE CASCADE,
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${q}.secret_metadata (
      venture_id text NOT NULL REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      id text NOT NULL,
      provider text NOT NULL,
      purpose text NOT NULL,
      opaque_ref text NOT NULL,
      status text NOT NULL CHECK (status IN ('active','revoked')),
      created_at timestamptz NOT NULL,
      rotated_at timestamptz,
      PRIMARY KEY (venture_id,id),
      UNIQUE (venture_id,opaque_ref)
    );
    CREATE TABLE IF NOT EXISTS ${q}.secret_envelopes (
      venture_id text NOT NULL,
      id text NOT NULL,
      ciphertext text NOT NULL,
      key_id text NOT NULL,
      aad_hash text NOT NULL CHECK (length(aad_hash)=64),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,id),
      FOREIGN KEY (venture_id,id) REFERENCES ${q}.secret_metadata(venture_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${q}.cost_reservations (
      venture_id text NOT NULL,
      id text NOT NULL,
      task_id text,
      amount_cents integer NOT NULL CHECK (amount_cents >= 0),
      actual_cost_cents integer CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
      provider text NOT NULL,
      status text NOT NULL CHECK (status IN ('reserved','settled','released')),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (venture_id,id),
      FOREIGN KEY (venture_id) REFERENCES ${q}.ventures(id) ON DELETE CASCADE,
      FOREIGN KEY (venture_id,task_id) REFERENCES ${q}.tasks(venture_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS jobs_ready_idx ON ${q}.jobs(status,available_at);
    CREATE INDEX IF NOT EXISTS effect_reservations_job_idx ON ${q}.effect_reservations(venture_id,job_id,status);
    CREATE INDEX IF NOT EXISTS cost_reservations_expiry_idx ON ${q}.cost_reservations(status,expires_at);
    ALTER TABLE ${q}.company_entitlements ADD COLUMN IF NOT EXISTS provider_order bigint NOT NULL DEFAULT 0 CHECK (provider_order >= 0);
    CREATE OR REPLACE FUNCTION ${q}.protect_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP='DELETE' AND current_setting('opspot.company_delete',true)='1' THEN RETURN OLD; END IF;
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    END $fn$;
    DO $do$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['evidence','audit_events','receipts','cost_entries'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS immutable_change ON %I.%I', '${schema}', table_name);
        EXECUTE format('CREATE TRIGGER immutable_change BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.protect_immutable()', '${schema}', table_name, '${schema}');
      END LOOP;
    END $do$;
    ALTER TABLE ${q}.secret_envelopes ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON SCHEMA ${q} FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA ${q} FROM PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q} FROM PUBLIC;
    REVOKE ALL ON TABLE ${q}.secret_envelopes FROM PUBLIC;
    DO $do$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA ${q} FROM anon';
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA ${q} FROM anon';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q} FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA ${q} FROM authenticated';
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA ${q} FROM authenticated';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q} FROM authenticated';
      END IF;
    END $do$;
  `;
}

export class PostgresKernelStorage implements KernelStorage {
  private constructor(private readonly sql: Sql, private readonly schema: string) {}

  static async connect(url: string, options: { schema?: string; max?: number } = {}): Promise<PostgresKernelStorage> {
    const schema = options.schema ?? "opspot_gtm";
    requireMatch(schema, /^[a-z][a-z0-9_]{0,62}$/, "Postgres schema");
    const sql = postgres(url, { max: options.max ?? 5, prepare: false });
    const storage = new PostgresKernelStorage(sql, schema);
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await sql.unsafe(postgresKernelSchema(schema));
    return storage;
  }

  private table(db: PgExecutor, name: string) {
    return db(`${this.schema}.${name}`);
  }

  private async assertCompany(db: PgExecutor, workspaceId: string, companyId: string): Promise<void> {
    const rows = await db`SELECT 1 FROM ${this.table(db, "ventures")} WHERE id=${companyId} AND workspace_id=${workspaceId}`;
    if (!rows[0]) throw new KernelStorageAccessError();
  }

  async ensureWorkspace(workspaceId: string): Promise<void> {
    requireWorkspaceId(workspaceId);
    const slug = workspaceId.replace(/^workspace_/, "");
    await this.sql`INSERT INTO ${this.table(this.sql, "workspaces")}(id,slug,name,created_at)
      VALUES(${workspaceId},${slug},${workspaceId},${nowIso()}) ON CONFLICT(id) DO NOTHING`;
  }

  async resolveWorkspaceForAuthSubject(authSubject: string): Promise<WorkspaceMembership | undefined> {
    requireAuthSubject(authSubject);
    const row = (await this.sql`SELECT auth_subject,workspace_id,role,created_at
      FROM ${this.table(this.sql, "workspace_members")} WHERE auth_subject=${authSubject}`)[0];
    return row ? {
      authSubject: String(row.auth_subject),
      workspaceId: String(row.workspace_id),
      role: String(row.role) as WorkspaceMembership["role"],
      createdAt: timestamp(row.created_at)
    } : undefined;
  }

  async resolveOrCreatePersonalWorkspaceForAuthSubject(authSubject: string): Promise<WorkspaceMembership> {
    requireAuthSubject(authSubject);
    const workspaceId = `workspace_${sha256(authSubject).slice(0, 24)}`;
    const workspaceSlug = `personal-${sha256(authSubject).slice(0, 24)}`;
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${authSubject},0))`;
      const existing = (await tx`SELECT auth_subject,workspace_id,role,created_at
        FROM ${this.table(tx, "workspace_members")} WHERE auth_subject=${authSubject}`)[0];
      if (existing) return {
        authSubject: String(existing.auth_subject),
        workspaceId: String(existing.workspace_id),
        role: String(existing.role) as WorkspaceMembership["role"],
        createdAt: timestamp(existing.created_at)
      };
      const createdAt = nowIso();
      await tx`INSERT INTO ${this.table(tx, "workspaces")}(id,slug,name,created_at)
        VALUES(${workspaceId},${workspaceSlug},'Personal workspace',${createdAt}) ON CONFLICT(id) DO NOTHING`;
      const row = (await tx`INSERT INTO ${this.table(tx, "workspace_members")}(auth_subject,workspace_id,role,created_at)
        VALUES(${authSubject},${workspaceId},'owner',${createdAt}) RETURNING auth_subject,workspace_id,role,created_at`)[0]!;
      return {
        authSubject: String(row.auth_subject),
        workspaceId: String(row.workspace_id),
        role: String(row.role) as WorkspaceMembership["role"],
        createdAt: timestamp(row.created_at)
      };
    });
  }

  async consumeAuthRateLimit(input: { bucketKeys: readonly string[]; limit: number; windowSeconds: number; at?: string }): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (input.bucketKeys.length < 1 || input.bucketKeys.length > 4) throw new TypeError("one to four auth rate-limit buckets are required");
    const bucketKeys = [...new Set(input.bucketKeys)].sort();
    for (const bucketKey of bucketKeys) requireMatch(bucketKey, /^[a-f0-9]{64}$/, "auth rate-limit bucket");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) throw new TypeError("invalid auth rate limit");
    if (!Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86_400) throw new TypeError("invalid auth rate-limit window");
    const at = normalizedTimestamp(input.at ?? nowIso(), "auth rate-limit timestamp");
    const resetAt = new Date(new Date(at).getTime() + input.windowSeconds * 1000).toISOString();
    return this.sql.begin(async (tx) => {
      let retryAfterSeconds = 0;
      for (const bucketKey of bucketKeys) {
        const row = (await tx`INSERT INTO ${this.table(tx, "auth_rate_limits")}(bucket_key,request_count,reset_at,updated_at)
          VALUES(${bucketKey},1,${resetAt},${at})
          ON CONFLICT(bucket_key) DO UPDATE SET
            request_count=CASE WHEN auth_rate_limits.reset_at<=${at} THEN 1 ELSE auth_rate_limits.request_count+1 END,
            reset_at=CASE WHEN auth_rate_limits.reset_at<=${at} THEN ${resetAt} ELSE auth_rate_limits.reset_at END,
            updated_at=${at}
          RETURNING request_count,reset_at`)[0]!;
        if (Number(row.request_count) > input.limit) {
          retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((new Date(String(row.reset_at)).getTime() - new Date(at).getTime()) / 1000)));
        }
      }
      return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
    });
  }

  async listRunnableWorkspaceIds(input: { after?: string; limit?: number; at?: string } = {}): Promise<{ workspaceIds: string[]; nextCursor?: string }> {
    if (input.after) requireWorkspaceId(input.after);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("runnable workspace limit must be between one and one hundred");
    const at = normalizedTimestamp(input.at ?? nowIso(), "runnable workspace timestamp");
    const rows = await this.sql`SELECT w.id FROM ${this.table(this.sql, "workspaces")} w
      WHERE w.id>${input.after ?? ""} AND EXISTS (
        SELECT 1 FROM ${this.table(this.sql, "ventures")} v
        WHERE v.workspace_id=w.id AND v.kill_switch=false AND (
          (v.state_json->>'runState'='running' AND v.state_json->>'nextCycleAt' IS NOT NULL
            AND (v.state_json->>'nextCycleAt')::timestamptz<=${at}::timestamptz)
          OR EXISTS (
            SELECT 1 FROM ${this.table(this.sql, "jobs")} j
            JOIN ${this.table(this.sql, "tasks")} t ON t.venture_id=j.venture_id AND t.id=j.task_id
            WHERE j.venture_id=v.id AND j.kind IN ('ceo-cycle','initiative-execution','golden-execution')
              AND t.status NOT IN ('cancelled','dead-letter','succeeded') AND (
              (j.status='leased' AND j.lease_expires_at<${at})
              OR (j.status='queued' AND j.available_at<=${at} AND NOT EXISTS (
                SELECT 1 FROM ${this.table(this.sql, "task_dependencies")} td
                JOIN ${this.table(this.sql, "tasks")} dependency
                  ON dependency.venture_id=td.venture_id AND dependency.id=td.depends_on_task_id
                WHERE td.venture_id=j.venture_id AND td.task_id=j.task_id AND dependency.status<>'succeeded'
              ))
            )
          )
        )
      ) ORDER BY w.id LIMIT ${limit + 1}`;
    const workspaceIds = rows.slice(0, limit).map((row) => String(row.id));
    return rows.length > limit
      ? { workspaceIds, nextCursor: workspaceIds.at(-1)! }
      : { workspaceIds };
  }

  async createCompany(input: Omit<KernelCompany, "killed" | "stateVersion">): Promise<{ created: boolean; company: KernelCompany }> {
    requireWorkspaceId(input.workspaceId);
    requireCompanyId(input.companyId);
    requireText(input.slug, "company slug", 160);
    const state = parseJsonObject(JSON.parse(jsonText(input.state)));
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO ${this.table(tx, "workspaces")}(id,slug,name,created_at)
        VALUES(${input.workspaceId},${input.workspaceId.replace(/^workspace_/, "")},${input.workspaceId},${input.createdAt}) ON CONFLICT(id) DO NOTHING`;
      const inserted = await tx`INSERT INTO ${this.table(tx, "ventures")}
        (id,slug,company_slug,name,owner,owning_repo,lifecycle_state,workspace_id,state_json,state_version,created_at,updated_at)
        VALUES(${input.companyId},${input.workspaceId === "workspace_local" ? input.slug : `${input.workspaceId}:${input.slug}`},${input.slug},${input.name},${input.owner},${input.owningRepo},${input.lifecycleState},${input.workspaceId},${tx.json(state as never)},1,${input.createdAt},${input.updatedAt})
        ON CONFLICT(id) DO NOTHING RETURNING *`;
      const row = inserted[0] ?? (await tx`SELECT * FROM ${this.table(tx, "ventures")} WHERE id=${input.companyId}`)[0];
      if (!row) throw new KernelStorageConflictError("company insert failed");
      const company = companyFromRow(row);
      if (!inserted[0]) {
        const replay = company.workspaceId === input.workspaceId && company.slug === input.slug && company.name === input.name
          && company.owner === input.owner && company.owningRepo === input.owningRepo && company.lifecycleState === input.lifecycleState
          && canonicalize(company.state) === canonicalize(state);
        if (!replay) throw new KernelStorageConflictError("company idempotency conflict");
      }
      return { created: Boolean(inserted[0]), company };
    });
  }

  async getCompany(workspaceId: string, companyId: string): Promise<KernelCompany | undefined> {
    const row = (await this.sql`SELECT * FROM ${this.table(this.sql, "ventures")} WHERE id=${companyId} AND workspace_id=${workspaceId}`)[0];
    return row ? companyFromRow(row) : undefined;
  }

  async listCompanies(workspaceId: string): Promise<KernelCompany[]> {
    return (await this.sql`SELECT * FROM ${this.table(this.sql, "ventures")} WHERE workspace_id=${workspaceId} ORDER BY company_slug`).map(companyFromRow);
  }

  async updateCompanyState(workspaceId: string, companyId: string, expectedVersion: number, state: JsonObject): Promise<KernelCompany> {
    return this.sql.begin(async (tx) => {
      const current = (await tx`SELECT * FROM ${this.table(tx, "ventures")} WHERE id=${companyId} AND workspace_id=${workspaceId} FOR UPDATE`)[0];
      if (!current) throw new KernelStorageAccessError();
      if (Number(current.state_version) !== expectedVersion) throw new KernelStorageConflictError("company state version conflict");
      assertBootstrapDigestUnchanged(parseJsonObject(current.state_json), state);
      const updated = (await tx`UPDATE ${this.table(tx, "ventures")} SET state_json=${tx.json(parseJsonObject(JSON.parse(jsonText(state))) as never)},
        state_version=state_version+1,updated_at=${nowIso()} WHERE id=${companyId} AND workspace_id=${workspaceId} RETURNING *`)[0]!;
      return companyFromRow(updated);
    });
  }

  async setKillSwitch(workspaceId: string, companyId: string, killed: boolean): Promise<void> {
    if (!killed) throw new KernelStorageConflictError("public company kill is irreversible");
    const rows = await this.sql`UPDATE ${this.table(this.sql, "ventures")} SET kill_switch=true,lifecycle_state='killed',
      state_json=state_json || ${this.sql.json({ runState: "killed", lifecycleState: "killed" })},state_version=state_version+1,updated_at=${nowIso()}
      WHERE id=${companyId} AND workspace_id=${workspaceId} RETURNING id`;
    if (!rows[0]) throw new KernelStorageAccessError();
  }

  async appendEvent(input: KernelEvent): Promise<{ created: boolean }> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    const payload = parseJson(jsonText(input.payload));
    const inserted = await this.sql`INSERT INTO ${this.table(this.sql, "audit_events")}
      (venture_id,id,event_type,actor,entity_type,entity_id,payload_json,occurred_at)
      VALUES(${input.companyId},${input.id},${input.eventType},${input.actor},${input.entityType},${input.entityId},${this.sql.json(payload as never)},${input.occurredAt})
      ON CONFLICT(venture_id,id) DO NOTHING RETURNING id`;
    if (inserted[0]) return { created: true };
    const row = (await this.sql`SELECT * FROM ${this.table(this.sql, "audit_events")} WHERE venture_id=${input.companyId} AND id=${input.id}`)[0]!;
    const replay = String(row.event_type) === input.eventType && String(row.actor) === input.actor && String(row.entity_type) === input.entityType
      && String(row.entity_id) === input.entityId && canonicalize(row.payload_json) === canonicalize(payload) && new Date(String(row.occurred_at)).toISOString() === input.occurredAt;
    if (!replay) throw new KernelStorageConflictError("event idempotency conflict");
    return { created: false };
  }

  async listEvents(workspaceId: string, companyId: string): Promise<KernelEvent[]> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    return (await this.sql`SELECT *,${workspaceId} AS workspace_id FROM ${this.table(this.sql, "audit_events")}
      WHERE venture_id=${companyId} ORDER BY occurred_at,id`).map(eventFromRow);
  }

  async appendEvidence(workspaceId: string, item: EvidenceItem): Promise<{ created: boolean; id: string }> {
    EvidenceItemSchema.parse(item);
    await this.assertCompany(this.sql, workspaceId, item.ventureId);
    const inserted = await this.sql`INSERT INTO ${this.table(this.sql, "evidence")}
      (venture_id,id,type,proof_tier,authority,source_ref,observed_at,expires_at,status,content_hash,metadata_json)
      VALUES(${item.ventureId},${item.id},${item.type},${item.proofTier},${item.authority},${item.sourceRef},${item.observedAt},${item.expiresAt ?? null},${item.status},${item.contentHash},${this.sql.json(item.metadata as never)})
      ON CONFLICT(venture_id,type,content_hash) DO NOTHING RETURNING id`;
    if (inserted[0]) return { created: true, id: String(inserted[0].id) };
    const prior = (await this.sql`SELECT * FROM ${this.table(this.sql, "evidence")}
      WHERE venture_id=${item.ventureId} AND type=${item.type} AND content_hash=${item.contentHash}`)[0];
    if (!prior) throw new KernelStorageConflictError("evidence id conflict");
    return { created: false, id: String(prior.id) };
  }

  async listEvidence(workspaceId: string, companyId: string): Promise<EvidenceItem[]> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const rows = await this.sql`SELECT * FROM ${this.table(this.sql, "evidence")} WHERE venture_id=${companyId} ORDER BY observed_at,id`;
    return rows.map((row) => EvidenceItemSchema.parse({
      id: row.id,
      ventureId: row.venture_id,
      type: row.type,
      proofTier: row.proof_tier,
      authority: row.authority,
      sourceRef: row.source_ref,
      observedAt: new Date(String(row.observed_at)).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(String(row.expires_at)).toISOString() } : {}),
      status: row.status,
      contentHash: row.content_hash,
      metadata: row.metadata_json
    }));
  }

  async appendReceipt(workspaceId: string, receipt: Receipt): Promise<{ created: boolean; id: string }> {
    ReceiptSchema.parse(receipt);
    await this.assertCompany(this.sql, workspaceId, receipt.ventureId);
    const inserted = await this.sql`INSERT INTO ${this.table(this.sql, "receipts")}
      (venture_id,id,task_id,dispatch_id,proof_tier,outcome,actor,adapter,artifact_path,content_hash,occurred_at,metadata_json,origin)
      VALUES(${receipt.ventureId},${receipt.id},${receipt.taskId ?? null},${receipt.dispatchId ?? null},${receipt.proofTier},${receipt.outcome},${receipt.actor},${receipt.adapter},${receipt.artifactPath},${receipt.contentHash},${receipt.occurredAt},${this.sql.json(receipt.metadata as never)},${receipt.origin})
      ON CONFLICT(venture_id,content_hash) DO NOTHING RETURNING id`;
    if (inserted[0]) return { created: true, id: String(inserted[0].id) };
    const prior = (await this.sql`SELECT id FROM ${this.table(this.sql, "receipts")} WHERE venture_id=${receipt.ventureId} AND content_hash=${receipt.contentHash}`)[0];
    if (!prior) throw new KernelStorageConflictError("receipt id conflict");
    return { created: false, id: String(prior.id) };
  }

  async listReceipts(workspaceId: string, companyId: string): Promise<Receipt[]> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const rows = await this.sql`SELECT * FROM ${this.table(this.sql, "receipts")} WHERE venture_id=${companyId} ORDER BY occurred_at,id`;
    return rows.map((row) => ReceiptSchema.parse({
      id: row.id,
      ventureId: row.venture_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.dispatch_id ? { dispatchId: row.dispatch_id } : {}),
      proofTier: row.proof_tier,
      outcome: row.outcome,
      actor: row.actor,
      adapter: row.adapter,
      artifactPath: row.artifact_path,
      contentHash: row.content_hash,
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
      metadata: row.metadata_json,
      origin: row.origin
    }));
  }

  async putTask(workspaceId: string, task: TaskDefinition, actionDigest: string, status: TaskStatus = "planned"): Promise<{ created: boolean }> {
    TaskDefinitionSchema.parse(task);
    await this.assertCompany(this.sql, workspaceId, task.ventureId);
    return this.sql.begin(async (tx) => {
      const at = nowIso();
      const inserted = await tx`INSERT INTO ${this.table(tx, "tasks")}
        (venture_id,id,play_id,purpose,owner_role,mode,gate_class,status,expected_proof,definition_json,action_digest,idempotency_key,created_at,updated_at)
        VALUES(${task.ventureId},${task.id},${task.playId ?? null},${task.purpose},${task.ownerRole},${task.mode},${task.gateClass},${status},${task.expectedProof},${tx.json(task as never)},${actionDigest},${task.idempotencyKey},${at},${at})
        ON CONFLICT(venture_id,idempotency_key) DO NOTHING RETURNING id`;
      if (!inserted[0]) {
        const prior = (await tx`SELECT * FROM ${this.table(tx, "tasks")} WHERE venture_id=${task.ventureId} AND idempotency_key=${task.idempotencyKey}`)[0];
        if (!prior || canonicalize(prior.definition_json) !== canonicalize(task) || String(prior.action_digest) !== actionDigest) {
          throw new KernelStorageConflictError("task idempotency conflict");
        }
        return { created: false };
      }
      for (const dependency of task.dependencies) {
        await tx`INSERT INTO ${this.table(tx, "task_dependencies")}(venture_id,task_id,depends_on_task_id)
          VALUES(${task.ventureId},${task.id},${dependency})`;
      }
      return { created: true };
    });
  }

  async getTask(workspaceId: string, companyId: string, taskId: string): Promise<(TaskDefinition & { status: TaskStatus; actionDigest: string; attemptCount: number }) | undefined> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const row = (await this.sql`SELECT * FROM ${this.table(this.sql, "tasks")} WHERE venture_id=${companyId} AND id=${taskId}`)[0];
    return row ? { ...TaskDefinitionSchema.parse(row.definition_json), status: String(row.status) as TaskStatus, actionDigest: String(row.action_digest), attemptCount: Number(row.attempt_count) } : undefined;
  }

  async listJobs(workspaceId: string, companyId: string, rawOptions: { statuses?: readonly KernelJobStatus[]; limit?: number } = {}): Promise<KernelJobSummary[]> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const options = jobListOptions(rawOptions);
    const statusFilter = options.statuses ? this.sql`AND status IN ${this.sql(options.statuses)}` : this.sql``;
    const rows = await this.sql`SELECT id,task_id,kind,status,attempt_count,last_error,available_at,created_at,updated_at
      FROM ${this.table(this.sql, "jobs")} WHERE venture_id=${companyId} ${statusFilter}
      ORDER BY updated_at DESC,id LIMIT ${options.limit}`;
    return rows.map(jobSummaryFromRow);
  }

  async enqueueJob(input: { workspaceId: string; companyId: string; id: string; taskId: string; kind: string; payload: unknown; availableAt?: string }): Promise<{ created: boolean; id: string }> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    const at = nowIso();
    const inserted = await this.sql`INSERT INTO ${this.table(this.sql, "jobs")}
      (venture_id,id,task_id,kind,status,payload_json,available_at,created_at,updated_at)
      VALUES(${input.companyId},${input.id},${input.taskId},${input.kind},'queued',${this.sql.json(parseJson(jsonText(input.payload)) as never)},${input.availableAt ?? at},${at},${at})
      ON CONFLICT(venture_id,task_id,kind) DO NOTHING RETURNING id`;
    if (inserted[0]) return { created: true, id: String(inserted[0].id) };
    const prior = (await this.sql`SELECT id,payload_json FROM ${this.table(this.sql, "jobs")}
      WHERE venture_id=${input.companyId} AND task_id=${input.taskId} AND kind=${input.kind}`)[0];
    if (!prior || canonicalize(prior.payload_json) !== canonicalize(input.payload)) throw new KernelStorageConflictError("job idempotency conflict");
    return { created: false, id: String(prior.id) };
  }

  async claimJob(workspaceId: string, workerId: string, leaseMs: number, kinds?: readonly string[]): Promise<KernelJob | undefined> {
    requireWorkspaceId(workspaceId);
    requireText(workerId, "worker id", 200);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new TypeError("lease must be between one second and one hour");
    if (kinds?.length === 0 || (kinds?.length ?? 0) > 20) throw new TypeError("job kinds must contain between one and twenty entries");
    for (const kind of kinds ?? []) requireMatch(kind, /^[a-z][a-z0-9-]{0,80}$/, "job kind");
    return this.sql.begin(async (tx) => {
      const kindFilter = kinds ? tx`AND j.kind IN ${tx(kinds as string[])}` : tx``;
      const row = (await tx`SELECT j.*,v.workspace_id FROM ${this.table(tx, "jobs")} j
        JOIN ${this.table(tx, "ventures")} v ON v.id=j.venture_id
        JOIN ${this.table(tx, "tasks")} t ON t.venture_id=j.venture_id AND t.id=j.task_id
        WHERE v.workspace_id=${workspaceId} AND j.status='queued' AND j.available_at<=${nowIso()} ${kindFilter}
          AND t.status NOT IN ('cancelled','dead-letter','succeeded')
          AND NOT EXISTS (SELECT 1 FROM ${this.table(tx, "task_dependencies")} td
            JOIN ${this.table(tx, "tasks")} dependency ON dependency.venture_id=td.venture_id AND dependency.id=td.depends_on_task_id
            WHERE td.venture_id=j.venture_id AND td.task_id=j.task_id AND dependency.status<>'succeeded')
        ORDER BY j.available_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`)[0];
      if (!row) return undefined;
      const leaseToken = randomUUID();
      const at = nowIso();
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      const updated = (await tx`UPDATE ${this.table(tx, "jobs")} SET status='leased',lease_owner=${workerId},lease_token=${leaseToken},
        lease_expires_at=${expiresAt},attempt_count=attempt_count+1,updated_at=${at}
        WHERE venture_id=${String(row.venture_id)} AND id=${String(row.id)} AND status='queued' RETURNING *,${workspaceId} AS workspace_id`)[0];
      if (!updated) return undefined;
      await tx`UPDATE ${this.table(tx, "tasks")} SET status='running',attempt_count=attempt_count+1,updated_at=${at}
        WHERE venture_id=${String(row.venture_id)} AND id=${String(row.task_id)}`;
      return jobFromRow(updated);
    });
  }

  async renewJobLease(workspaceId: string, companyId: string, jobId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const rows = await this.sql`UPDATE ${this.table(this.sql, "jobs")} SET lease_expires_at=${new Date(Date.now() + leaseMs).toISOString()},updated_at=${nowIso()}
      WHERE venture_id=${companyId} AND id=${jobId} AND status='leased' AND lease_token=${leaseToken} AND lease_expires_at>=${nowIso()} RETURNING id`;
    return Boolean(rows[0]);
  }

  async completeJob(workspaceId: string, companyId: string, jobId: string, leaseToken: string): Promise<boolean> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    return this.sql.begin(async (tx) => {
      const row = (await tx`SELECT task_id FROM ${this.table(tx, "jobs")} WHERE venture_id=${companyId} AND id=${jobId}
        AND status='leased' AND lease_token=${leaseToken} AND lease_expires_at>=${nowIso()} FOR UPDATE`)[0];
      if (!row) return false;
      const unresolved = (await tx`SELECT 1 FROM ${this.table(tx, "effect_reservations")}
        WHERE venture_id=${companyId} AND job_id=${jobId} AND status<>'committed' LIMIT 1`)[0];
      if (unresolved) throw new KernelStorageConflictError("job has an unresolved external effect");
      const at = nowIso();
      await tx`UPDATE ${this.table(tx, "jobs")} SET status='succeeded',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${at}
        WHERE venture_id=${companyId} AND id=${jobId}`;
      await tx`UPDATE ${this.table(tx, "tasks")} SET status='succeeded',updated_at=${at} WHERE venture_id=${companyId} AND id=${String(row.task_id)}`;
      return true;
    });
  }

  async failJob(input: { workspaceId: string; companyId: string; jobId: string; leaseToken: string; error: string; retryAt?: string; deadLetter?: boolean }): Promise<boolean> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    return this.sql.begin(async (tx) => {
      const at = nowIso();
      const row = (await tx`SELECT task_id FROM ${this.table(tx, "jobs")} WHERE venture_id=${input.companyId} AND id=${input.jobId}
        AND status='leased' AND lease_token=${input.leaseToken} AND lease_expires_at>=${at} FOR UPDATE`)[0];
      if (!row) return false;
      await tx`UPDATE ${this.table(tx, "effect_reservations")} SET status='needs-reconciliation',updated_at=${at}
        WHERE venture_id=${input.companyId} AND job_id=${input.jobId} AND status='reserved'`;
      const status = input.deadLetter ? "dead-letter" : "queued";
      await tx`UPDATE ${this.table(tx, "jobs")} SET status=${status},available_at=COALESCE(${input.retryAt ?? null},available_at),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=${input.error.slice(0, 4000)},updated_at=${at}
        WHERE venture_id=${input.companyId} AND id=${input.jobId}`;
      await tx`UPDATE ${this.table(tx, "tasks")} SET status=${status},dead_letter_reason=${input.deadLetter ? input.error.slice(0, 4000) : null},updated_at=${at}
        WHERE venture_id=${input.companyId} AND id=${String(row.task_id)}`;
      return true;
    });
  }

  async recoverExpiredJobs(workspaceId: string, at = nowIso()): Promise<number> {
    requireWorkspaceId(workspaceId);
    return this.sql.begin(async (tx) => {
      await tx`UPDATE ${this.table(tx, "effect_reservations")} e SET status='needs-reconciliation',updated_at=${at}
        FROM ${this.table(tx, "jobs")} j,${this.table(tx, "ventures")} v
        WHERE j.venture_id=e.venture_id AND j.id=e.job_id AND v.id=j.venture_id AND v.workspace_id=${workspaceId}
          AND e.status='reserved' AND j.status='leased' AND j.lease_expires_at<${at}`;
      const rows = await tx`UPDATE ${this.table(tx, "jobs")} j SET status='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${at}
        FROM ${this.table(tx, "ventures")} v WHERE v.id=j.venture_id AND v.workspace_id=${workspaceId}
          AND j.status='leased' AND j.lease_expires_at<${at} RETURNING j.id`;
      return rows.length;
    });
  }

  async putEntitlement(rawInput: CompanyEntitlementInput): Promise<{ applied: boolean; entitlement: CompanyEntitlement }> {
    const input = normalizeEntitlementInput(rawInput);
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    return this.sql.begin(async (tx) => {
      const prior = (await tx`SELECT * FROM ${this.table(tx, "company_entitlements")} WHERE venture_id=${input.companyId} FOR UPDATE`)[0];
      if (prior) {
        const current = entitlementFromRow(input.workspaceId, prior);
        if (current.providerEventId === input.providerEventId) {
          const replay = current.status === input.status && current.plan === input.plan && current.periodStart === input.periodStart
            && current.periodEnd === input.periodEnd && current.modelCostCapCents === input.modelCostCapCents
            && current.providerOrder === input.providerOrder && current.observedAt === input.observedAt;
          if (!replay) throw new KernelStorageConflictError("entitlement event idempotency conflict");
          return { applied: false, entitlement: current };
        }
        if (input.providerOrder < current.providerOrder) return { applied: false, entitlement: current };
        if (input.providerOrder === current.providerOrder) throw new KernelStorageConflictError("entitlement provider order conflict");
        const verifiedNewPeriod = input.periodStart > current.periodStart && input.periodStart >= current.periodEnd;
        if (verifiedNewPeriod && current.reservedCostCents !== 0) throw new KernelStorageConflictError("cannot roll entitlement period with reserved cost");
        await tx`UPDATE ${this.table(tx, "company_entitlements")} SET status=${input.status},plan=${input.plan},period_start=${input.periodStart},
          period_end=${input.periodEnd},model_cost_cap_cents=${input.modelCostCapCents},spent_cost_cents=${verifiedNewPeriod ? 0 : current.spentCostCents},
          reserved_cost_cents=${verifiedNewPeriod ? 0 : current.reservedCostCents},provider_event_id=${input.providerEventId},
          provider_order=${input.providerOrder},observed_at=${input.observedAt},updated_at=${nowIso()}
          WHERE venture_id=${input.companyId}`;
      } else {
        await tx`INSERT INTO ${this.table(tx, "company_entitlements")}
          (venture_id,status,plan,period_start,period_end,model_cost_cap_cents,spent_cost_cents,reserved_cost_cents,provider_event_id,provider_order,observed_at,updated_at)
          VALUES(${input.companyId},${input.status},${input.plan},${input.periodStart},${input.periodEnd},${input.modelCostCapCents},0,0,${input.providerEventId},${input.providerOrder},${input.observedAt},${nowIso()})`;
      }
      const eventId = `event_entitlement_${sha256({ companyId: input.companyId, providerEventId: input.providerEventId }).slice(0, 24)}`;
      await tx`INSERT INTO ${this.table(tx, "audit_events")}(venture_id,id,event_type,actor,entity_type,entity_id,payload_json,occurred_at)
        VALUES(${input.companyId},${eventId},'entitlement-observed','billing-system','entitlement',${input.companyId},${tx.json(input as never)},${input.observedAt})
        ON CONFLICT(venture_id,id) DO NOTHING`;
      const row = (await tx`SELECT * FROM ${this.table(tx, "company_entitlements")} WHERE venture_id=${input.companyId}`)[0]!;
      return { applied: true, entitlement: entitlementFromRow(input.workspaceId, row) };
    });
  }

  async getEntitlement(workspaceId: string, companyId: string): Promise<CompanyEntitlement | undefined> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const row = (await this.sql`SELECT * FROM ${this.table(this.sql, "company_entitlements")} WHERE venture_id=${companyId}`)[0];
    return row ? entitlementFromRow(workspaceId, row) : undefined;
  }

  async reserveEffect(input: EffectReservationInput): Promise<{ reserved: boolean; reservation?: EffectReservation; reason?: "entitlement" | "action-cap" }> {
    validateEffectInput(input);
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    return this.sql.begin(async (tx) => {
      const prior = (await tx`SELECT * FROM ${this.table(tx, "effect_reservations")}
        WHERE venture_id=${input.companyId} AND idempotency_key=${input.idempotencyKey}`)[0];
      if (prior) {
        const reservation = effectFromRow(input.workspaceId, prior);
        const replay = reservation.jobId === input.jobId && reservation.taskId === input.taskId && reservation.provider === input.provider
          && reservation.effectType === input.effectType && reservation.requestHash === input.requestHash
          && reservation.providerIdempotencyKey === input.providerIdempotencyKey;
        if (!replay) throw new KernelStorageConflictError("effect idempotency conflict");
        return { reserved: false, reservation };
      }
      const entitlement = (await tx`SELECT * FROM ${this.table(tx, "company_entitlements")} WHERE venture_id=${input.companyId} FOR UPDATE`)[0];
      if (!entitlement || !entitlementAdmits(entitlementFromRow(input.workspaceId, entitlement))) {
        return { reserved: false, reason: "entitlement" };
      }
      const job = (await tx`SELECT 1 FROM ${this.table(tx, "jobs")} WHERE venture_id=${input.companyId} AND id=${input.jobId}
        AND task_id=${input.taskId} AND status='leased' AND lease_token=${input.leaseToken} AND lease_expires_at>=${nowIso()}`)[0];
      if (!job) throw new KernelStorageConflictError("effect reservation requires the active job lease");
      if (input.actionLimits) {
        const observedAt = new Date(input.actionLimits.observedAt).getTime();
        const daily = (await tx`SELECT COUNT(*) AS count FROM ${this.table(tx, "effect_reservations")}
          WHERE venture_id=${input.companyId} AND provider=${input.provider} AND effect_type=${input.effectType}
            AND created_at>=${new Date(observedAt - 24 * 60 * 60_000).toISOString()}`)[0];
        const weekly = (await tx`SELECT COUNT(*) AS count FROM ${this.table(tx, "effect_reservations")}
          WHERE venture_id=${input.companyId} AND provider=${input.provider} AND effect_type=${input.effectType}
            AND created_at>=${new Date(observedAt - 7 * 24 * 60 * 60_000).toISOString()}`)[0];
        if (Number(daily?.count ?? 0) >= input.actionLimits.daily || Number(weekly?.count ?? 0) >= input.actionLimits.weekly) return { reserved: false, reason: "action-cap" as const };
      }
      const at = nowIso();
      const inserted = await tx`INSERT INTO ${this.table(tx, "effect_reservations")}
        (venture_id,idempotency_key,job_id,task_id,provider,effect_type,request_hash,provider_idempotency_key,status,lease_token,created_at,updated_at)
        VALUES(${input.companyId},${input.idempotencyKey},${input.jobId},${input.taskId},${input.provider},${input.effectType},${input.requestHash},
          ${input.providerIdempotencyKey},'reserved',${input.leaseToken},${at},${at}) RETURNING *`;
      return { reserved: true, reservation: effectFromRow(input.workspaceId, inserted[0]!) };
    });
  }

  async commitEffect(input: { workspaceId: string; companyId: string; idempotencyKey: string; leaseToken: string; result: unknown; reconciled?: boolean }): Promise<{ committed: boolean; reservation: EffectReservation }> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    const result = parseJson(jsonText(input.result));
    return this.sql.begin(async (tx) => {
      const row = (await tx`SELECT * FROM ${this.table(tx, "effect_reservations")}
        WHERE venture_id=${input.companyId} AND idempotency_key=${input.idempotencyKey} FOR UPDATE`)[0];
      if (!row) throw new KernelStorageConflictError("effect reservation not found");
      const reservation = effectFromRow(input.workspaceId, row);
      if (reservation.status === "committed") {
        if (canonicalize(reservation.result) !== canonicalize(result)) throw new KernelStorageConflictError("effect result idempotency conflict");
        return { committed: false, reservation };
      }
      const active = (await tx`SELECT 1 FROM ${this.table(tx, "jobs")} WHERE venture_id=${input.companyId} AND id=${reservation.jobId}
        AND status='leased' AND lease_token=${input.leaseToken} AND lease_expires_at>=${nowIso()}`)[0];
      if (!active) throw new KernelStorageConflictError("effect commit requires the active job lease");
      if (reservation.status === "reserved" && reservation.leaseToken !== input.leaseToken) throw new KernelStorageConflictError("stale effect lease");
      if (reservation.status === "needs-reconciliation" && input.reconciled !== true) throw new KernelStorageConflictError("effect requires authoritative reconciliation");
      const committed = (await tx`UPDATE ${this.table(tx, "effect_reservations")} SET status='committed',lease_token=${input.leaseToken},
        result_json=${tx.json(result as never)},updated_at=${nowIso()} WHERE venture_id=${input.companyId} AND idempotency_key=${input.idempotencyKey} RETURNING *`)[0]!;
      return { committed: true, reservation: effectFromRow(input.workspaceId, committed) };
    });
  }

  async reserveCost(rawInput: { workspaceId: string; companyId: string; id: string; taskId?: string; amountCents: number; provider: string; expiresAt: string }): Promise<{ reserved: boolean; reservation?: CostReservation; reason?: "entitlement" | "cost-cap" | "settled" }> {
    await this.assertCompany(this.sql, rawInput.workspaceId, rawInput.companyId);
    requireNonNegativeInteger(rawInput.amountCents, "cost reservation amount");
    const expiresAt = normalizedTimestamp(rawInput.expiresAt, "cost reservation expiry");
    const now = Date.now();
    if (new Date(expiresAt).getTime() <= now) throw new TypeError("cost reservation expiry must be in the future");
    const input = { ...rawInput, expiresAt };
    return this.sql.begin(async (tx) => {
      const prior = (await tx`SELECT * FROM ${this.table(tx, "cost_reservations")} WHERE venture_id=${input.companyId} AND id=${input.id} FOR UPDATE`)[0];
      if (prior) {
        const reservation = this.pgCostReservation(input.workspaceId, prior);
        const replay = reservation.taskId === input.taskId && reservation.amountCents === input.amountCents
          && reservation.provider === input.provider;
        if (!replay) throw new KernelStorageConflictError("cost reservation idempotency conflict");
        if (reservation.status === "settled") return { reserved: false, reservation, reason: "settled" };
        if (reservation.status === "reserved" && new Date(reservation.expiresAt).getTime() > now) {
          return { reserved: true, reservation };
        }
        if (reservation.status === "reserved") {
          const released = await tx`UPDATE ${this.table(tx, "company_entitlements")}
            SET reserved_cost_cents=reserved_cost_cents-${reservation.amountCents},updated_at=${nowIso()}
            WHERE venture_id=${input.companyId} AND reserved_cost_cents>=${reservation.amountCents} RETURNING venture_id`;
          if (!released[0]) throw new KernelStorageConflictError("cost reservation accounting conflict");
          await tx`UPDATE ${this.table(tx, "cost_reservations")} SET status='released',updated_at=${nowIso()}
            WHERE venture_id=${input.companyId} AND id=${input.id}`;
        }
      }
      const entitlement = (await tx`SELECT * FROM ${this.table(tx, "company_entitlements")} WHERE venture_id=${input.companyId} FOR UPDATE`)[0];
      if (!entitlement || !entitlementAdmits(entitlementFromRow(input.workspaceId, entitlement), now)) return { reserved: false, reason: "entitlement" };
      if (Number(entitlement.spent_cost_cents) + Number(entitlement.reserved_cost_cents) + input.amountCents > Number(entitlement.model_cost_cap_cents)) {
        return { reserved: false, reason: "cost-cap" };
      }
      const at = nowIso();
      await tx`UPDATE ${this.table(tx, "company_entitlements")} SET reserved_cost_cents=reserved_cost_cents+${input.amountCents},updated_at=${at}
        WHERE venture_id=${input.companyId}`;
      const row = prior
        ? (await tx`UPDATE ${this.table(tx, "cost_reservations")} SET status='reserved',actual_cost_cents=NULL,expires_at=${input.expiresAt},updated_at=${at}
            WHERE venture_id=${input.companyId} AND id=${input.id} RETURNING *`)[0]!
        : (await tx`INSERT INTO ${this.table(tx, "cost_reservations")}
            (venture_id,id,task_id,amount_cents,provider,status,expires_at,created_at,updated_at)
            VALUES(${input.companyId},${input.id},${input.taskId ?? null},${input.amountCents},${input.provider},'reserved',${input.expiresAt},${at},${at}) RETURNING *`)[0]!;
      return { reserved: true, reservation: this.pgCostReservation(input.workspaceId, row) };
    });
  }

  private pgCostReservation(workspaceId: string, row: Record<string, unknown>): CostReservation {
    return {
      workspaceId,
      companyId: String(row.venture_id),
      id: String(row.id),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      amountCents: Number(row.amount_cents),
      status: String(row.status) as CostReservation["status"],
      ...(row.actual_cost_cents === null || row.actual_cost_cents === undefined ? {} : { actualCostCents: Number(row.actual_cost_cents) }),
      provider: String(row.provider),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }

  async settleCost(input: { workspaceId: string; companyId: string; id: string; actualCostCents: number; sourceRef?: string }): Promise<{ settled: boolean; reservation: CostReservation }> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    requireNonNegativeInteger(input.actualCostCents, "actual cost");
    return this.sql.begin(async (tx) => {
      const row = (await tx`SELECT * FROM ${this.table(tx, "cost_reservations")} WHERE venture_id=${input.companyId} AND id=${input.id} FOR UPDATE`)[0];
      if (!row) throw new KernelStorageConflictError("cost reservation not found");
      const reservation = this.pgCostReservation(input.workspaceId, row);
      if (reservation.status === "settled") {
        if (reservation.actualCostCents !== input.actualCostCents) throw new KernelStorageConflictError("cost settlement idempotency conflict");
        return { settled: false, reservation };
      }
      if (reservation.status !== "reserved" || input.actualCostCents > reservation.amountCents) throw new KernelStorageConflictError("invalid cost settlement");
      const at = nowIso();
      await tx`UPDATE ${this.table(tx, "company_entitlements")} SET reserved_cost_cents=reserved_cost_cents-${reservation.amountCents},
        spent_cost_cents=spent_cost_cents+${input.actualCostCents},updated_at=${at} WHERE venture_id=${input.companyId}`;
      await tx`INSERT INTO ${this.table(tx, "cost_entries")}(venture_id,id,task_id,amount_cents,provider,source_ref,occurred_at)
        VALUES(${input.companyId},${input.id},${reservation.taskId ?? null},${input.actualCostCents},${reservation.provider},${input.sourceRef ?? input.id},${at})`;
      const settled = (await tx`UPDATE ${this.table(tx, "cost_reservations")} SET status='settled',actual_cost_cents=${input.actualCostCents},updated_at=${at}
        WHERE venture_id=${input.companyId} AND id=${input.id} RETURNING *`)[0]!;
      return { settled: true, reservation: this.pgCostReservation(input.workspaceId, settled) };
    });
  }

  async releaseExpiredCostReservations(workspaceId: string, at = nowIso()): Promise<number> {
    requireWorkspaceId(workspaceId);
    return this.sql.begin(async (tx) => {
      const rows = await tx`SELECT cr.* FROM ${this.table(tx, "cost_reservations")} cr
        JOIN ${this.table(tx, "ventures")} v ON v.id=cr.venture_id
        WHERE v.workspace_id=${workspaceId} AND cr.status='reserved' AND cr.expires_at<${at} FOR UPDATE OF cr`;
      for (const row of rows) {
        await tx`UPDATE ${this.table(tx, "company_entitlements")} SET reserved_cost_cents=reserved_cost_cents-${Number(row.amount_cents)},updated_at=${at}
          WHERE venture_id=${String(row.venture_id)}`;
        await tx`UPDATE ${this.table(tx, "cost_reservations")} SET status='released',updated_at=${at}
          WHERE venture_id=${String(row.venture_id)} AND id=${String(row.id)}`;
      }
      return rows.length;
    });
  }

  async createApproval(input: { workspaceId: string; companyId: string; id: string; taskId: string; actionDigest: string; packet: unknown; expiresAt: string }): Promise<{ created: boolean }> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    const packet = parseJson(jsonText(input.packet));
    const expiresAt = normalizedTimestamp(input.expiresAt, "approval expiry");
    return this.sql.begin(async (tx) => {
      const prior = (await tx`SELECT * FROM ${this.table(tx, "approvals")} WHERE venture_id=${input.companyId} AND id=${input.id}`)[0];
      if (prior) {
        const replay = String(prior.task_id) === input.taskId && String(prior.action_digest) === input.actionDigest
          && canonicalize(prior.packet_json) === canonicalize(packet) && timestamp(prior.expires_at) === expiresAt;
        if (!replay) throw new KernelStorageConflictError("approval idempotency conflict");
        return { created: false };
      }
      const task = (await tx`SELECT status,action_digest FROM ${this.table(tx, "tasks")}
        WHERE venture_id=${input.companyId} AND id=${input.taskId} FOR UPDATE`)[0];
      if (!task || String(task.status) !== "blocked" || String(task.action_digest) !== input.actionDigest) {
        throw new KernelStorageConflictError("approval requires the exact blocked task digest");
      }
      await tx`INSERT INTO ${this.table(tx, "approvals")}
        (venture_id,id,task_id,action_digest,status,packet_json,expires_at,created_at)
        VALUES(${input.companyId},${input.id},${input.taskId},${input.actionDigest},'pending',${tx.json(packet as never)},${expiresAt},${nowIso()})`;
      return { created: true };
    });
  }

  async listPendingApprovals(workspaceId: string, companyId?: string): Promise<KernelApproval[]> {
    requireWorkspaceId(workspaceId);
    if (companyId) await this.assertCompany(this.sql, workspaceId, companyId);
    const rows = companyId
      ? await this.sql`SELECT a.* FROM ${this.table(this.sql, "approvals")} a JOIN ${this.table(this.sql, "ventures")} v ON v.id=a.venture_id
          WHERE v.workspace_id=${workspaceId} AND a.venture_id=${companyId} AND a.status='pending' AND a.expires_at>${nowIso()} ORDER BY a.created_at,a.id`
      : await this.sql`SELECT a.* FROM ${this.table(this.sql, "approvals")} a JOIN ${this.table(this.sql, "ventures")} v ON v.id=a.venture_id
          WHERE v.workspace_id=${workspaceId} AND a.status='pending' AND a.expires_at>${nowIso()} ORDER BY a.created_at,a.id`;
    return rows.map((row) => approvalFromRow(workspaceId, row));
  }

  async getApproval(workspaceId: string, companyId: string, approvalId: string): Promise<KernelApproval | undefined> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const row = (await this.sql`SELECT * FROM ${this.table(this.sql, "approvals")} WHERE venture_id=${companyId} AND id=${approvalId}`)[0];
    return row ? approvalFromRow(workspaceId, row) : undefined;
  }

  async resolveApproval(input: { workspaceId: string; companyId: string; approvalId: string; expectedActionDigest: string; resolution: "approved" | "revoked"; resolutionId: string; actor: string; resolvedAt: string }): Promise<{ applied: boolean; status: "approved" | "revoked"; taskId: string; jobId?: string }> {
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    const resolvedAt = normalizedTimestamp(input.resolvedAt, "approval resolution timestamp");
    return this.sql.begin(async (tx) => {
      const row = (await tx`SELECT * FROM ${this.table(tx, "approvals")} WHERE venture_id=${input.companyId} AND id=${input.approvalId} FOR UPDATE`)[0];
      if (!row) throw new KernelStorageConflictError("approval not found");
      if (String(row.action_digest) !== input.expectedActionDigest) throw new KernelStorageConflictError("approval action digest conflict");
      const taskId = String(row.task_id);
      const task = (await tx`SELECT status,action_digest,definition_json FROM ${this.table(tx, "tasks")}
        WHERE venture_id=${input.companyId} AND id=${taskId} FOR UPDATE`)[0];
      if (!task || String(task.action_digest) !== input.expectedActionDigest) {
        throw new KernelStorageConflictError("approval task is not the exact blocked digest");
      }
      const binding = input.resolution === "approved" ? approvedGoldenJobBinding(task.definition_json, input.approvalId) : undefined;
      const jobId = binding ? makeId("job", { ventureId: input.companyId, taskId, kind: binding.kind }) : undefined;
      if (row.resolution_id) {
        if (String(row.resolution_id) !== input.resolutionId || String(row.status) !== input.resolution) throw new KernelStorageConflictError("approval resolution conflict");
        return { applied: false, status: input.resolution, taskId, ...(jobId ? { jobId } : {}) };
      }
      if (String(row.status) !== "pending") throw new KernelStorageConflictError("approval is not pending");
      if (timestamp(row.expires_at) < resolvedAt) throw new KernelStorageConflictError("approval expired");
      if (String(task.status) !== "blocked") {
        throw new KernelStorageConflictError("approval task is not the exact blocked digest");
      }
      await tx`UPDATE ${this.table(tx, "approvals")} SET status=${input.resolution},resolution_id=${input.resolutionId},resolution_actor=${input.actor},
        resolved_at=${resolvedAt},approver=${input.resolution === "approved" ? input.actor : null},revoked_at=${input.resolution === "revoked" ? resolvedAt : null}
        WHERE venture_id=${input.companyId} AND id=${input.approvalId}`;
      if (input.resolution === "revoked") {
        await tx`UPDATE ${this.table(tx, "tasks")} SET status='cancelled',cancelled_at=${resolvedAt},updated_at=${resolvedAt}
          WHERE venture_id=${input.companyId} AND id=${taskId} AND status='blocked'`;
        return { applied: true, status: input.resolution, taskId };
      }
      await tx`UPDATE ${this.table(tx, "tasks")} SET status='ready',updated_at=${resolvedAt}
        WHERE venture_id=${input.companyId} AND id=${taskId} AND status='blocked' AND action_digest=${input.expectedActionDigest}`;
      const payload = {
        ventureId: input.companyId,
        taskId,
        actionDigest: input.expectedActionDigest,
        executionClass: binding!.kind,
        capabilityId: binding!.capabilityId
      };
      await tx`INSERT INTO ${this.table(tx, "jobs")}(venture_id,id,task_id,kind,status,payload_json,available_at,attempt_count,created_at,updated_at)
        VALUES(${input.companyId},${jobId!},${taskId},${binding!.kind},'queued',${tx.json(payload as never)},${resolvedAt},0,${resolvedAt},${resolvedAt})`;
      return { applied: true, status: input.resolution, taskId, jobId: jobId! };
    });
  }

  async putSecretMetadata(input: SecretMetadata): Promise<{ created: boolean }> {
    validateSecretMetadata(input);
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    const inserted = await this.sql`INSERT INTO ${this.table(this.sql, "secret_metadata")}
      (venture_id,id,provider,purpose,opaque_ref,status,created_at,rotated_at)
      VALUES(${input.companyId},${input.id},${input.provider},${input.purpose},${input.opaqueRef},${input.status},${input.createdAt},${input.rotatedAt ?? null})
      ON CONFLICT(venture_id,id) DO NOTHING RETURNING id`;
    if (inserted[0]) return { created: true };
    const prior = (await this.sql`SELECT * FROM ${this.table(this.sql, "secret_metadata")} WHERE venture_id=${input.companyId} AND id=${input.id}`)[0]!;
    if (canonicalize(secretFromRow(input.workspaceId, prior)) !== canonicalize(input)) throw new KernelStorageConflictError("secret metadata idempotency conflict");
    return { created: false };
  }

  async putWorkerSecretEnvelope(input: WorkerSecretEnvelope): Promise<{ created: boolean }> {
    validateSecretEnvelope(input);
    await this.assertCompany(this.sql, input.workspaceId, input.companyId);
    return this.sql.begin(async (tx) => {
      const metadata = (await tx`SELECT status FROM ${this.table(tx, "secret_metadata")}
        WHERE venture_id=${input.companyId} AND id=${input.id} FOR UPDATE`)[0];
      if (String(metadata?.status) !== "active") throw new KernelStorageConflictError("secret envelope requires active metadata");
      const inserted = await tx`INSERT INTO ${this.table(tx, "secret_envelopes")}
        (venture_id,id,ciphertext,key_id,aad_hash,created_at,updated_at)
        VALUES(${input.companyId},${input.id},${input.ciphertext},${input.keyId},${input.aadHash},${input.createdAt},${input.updatedAt})
        ON CONFLICT(venture_id,id) DO NOTHING RETURNING id`;
      if (inserted[0]) return { created: true };
      const prior = (await tx`SELECT * FROM ${this.table(tx, "secret_envelopes")} WHERE venture_id=${input.companyId} AND id=${input.id}`)[0]!;
      const replay = String(prior.ciphertext) === input.ciphertext && String(prior.key_id) === input.keyId && String(prior.aad_hash) === input.aadHash
        && new Date(String(prior.created_at)).toISOString() === input.createdAt && new Date(String(prior.updated_at)).toISOString() === input.updatedAt;
      if (!replay) throw new KernelStorageConflictError("secret envelope idempotency conflict");
      return { created: false };
    });
  }

  async getWorkerSecretEnvelope(workspaceId: string, companyId: string, id: string): Promise<WorkerSecretEnvelope | undefined> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const row = (await this.sql`SELECT se.* FROM ${this.table(this.sql, "secret_envelopes")} se
      JOIN ${this.table(this.sql, "secret_metadata")} sm ON sm.venture_id=se.venture_id AND sm.id=se.id
      WHERE se.venture_id=${companyId} AND se.id=${id} AND sm.status='active'`)[0];
    return row ? {
      workspaceId,
      companyId,
      id: String(row.id),
      ciphertext: String(row.ciphertext),
      keyId: String(row.key_id),
      aadHash: String(row.aad_hash),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    } : undefined;
  }

  async revokeSecretMetadata(workspaceId: string, companyId: string, id: string, rotatedAt: string): Promise<boolean> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const normalizedRotatedAt = normalizedTimestamp(rotatedAt, "secret rotation timestamp");
    return this.sql.begin(async (tx) => {
      const prior = (await tx`SELECT status,rotated_at FROM ${this.table(tx, "secret_metadata")}
        WHERE venture_id=${companyId} AND id=${id} FOR UPDATE`)[0];
      if (!prior) return false;
      if (String(prior.status) === "revoked") {
        await tx`DELETE FROM ${this.table(tx, "secret_envelopes")} WHERE venture_id=${companyId} AND id=${id}`;
        if (new Date(String(prior.rotated_at)).toISOString() === normalizedRotatedAt) return false;
        throw new KernelStorageConflictError("secret metadata revocation conflict");
      }
      await tx`DELETE FROM ${this.table(tx, "secret_envelopes")} WHERE venture_id=${companyId} AND id=${id}`;
      await tx`UPDATE ${this.table(tx, "secret_metadata")} SET status='revoked',rotated_at=${normalizedRotatedAt}
        WHERE venture_id=${companyId} AND id=${id} AND status='active'`;
      return true;
    });
  }

  async listSecretMetadata(workspaceId: string, companyId: string): Promise<SecretMetadata[]> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    return (await this.sql`SELECT * FROM ${this.table(this.sql, "secret_metadata")} WHERE venture_id=${companyId} ORDER BY id`)
      .map((row) => secretFromRow(workspaceId, row));
  }

  async exportCompany(workspaceId: string, companyId: string): Promise<KernelCompanyExport> {
    await this.assertCompany(this.sql, workspaceId, companyId);
    const tables: Record<string, unknown[]> = {
      workspaces: [...await this.sql`SELECT * FROM ${this.table(this.sql, "workspaces")} WHERE id=${workspaceId}`],
      ventures: [...await this.sql`SELECT * FROM ${this.table(this.sql, "ventures")} WHERE id=${companyId} AND workspace_id=${workspaceId}`]
    };
    for (const table of ["evidence", "tasks", "task_dependencies", "jobs", "receipts", "approvals", "cost_entries", "audit_events", "company_entitlements", "effect_reservations", "secret_metadata", "cost_reservations"] as const) {
      tables[table] = [...await this.sql`SELECT * FROM ${this.table(this.sql, table)} WHERE venture_id=${companyId}`];
    }
    return { schemaVersion: 1, exportedAt: nowIso(), workspaceId, companyId, tables };
  }

  async deleteCompany(workspaceId: string, companyId: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const row = (await tx`SELECT 1 FROM ${this.table(tx, "ventures")} WHERE id=${companyId} AND workspace_id=${workspaceId} FOR UPDATE`)[0];
      if (!row) return false;
      await tx`SELECT set_config('opspot.company_delete','1',true)`;
      const deleted = await tx`DELETE FROM ${this.table(tx, "ventures")} WHERE id=${companyId} AND workspace_id=${workspaceId} RETURNING id`;
      return Boolean(deleted[0]);
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

}
