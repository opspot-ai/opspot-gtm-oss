import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  ResendEmailAdapter,
  isLiveSettledStripePayment,
  type OperatedCompanyPaymentEvent,
  type ReconciledResendEmail,
  type ReconciledResendReceivedEmail,
  type ReconciledStripeEvent,
  type ResendEmailEvent
} from "@opspot/adapters";
import {
  CompanyStateSchema,
  EvidenceItemSchema,
  GtmCapabilityIdSchema,
  ReceiptSchema,
  TaskDefinitionSchema,
  canonicalize,
  makeId,
  sha256,
  type CompanyState,
  type EvidenceItem,
  type ProofTier,
  type TaskDefinition
} from "@opspot/contracts";
import { actionDigest } from "@opspot/policy";
import { KernelStorageConflictError, type EntitlementStatus, type KernelEvent, type KernelJob, type KernelStorage } from "@opspot/storage";
import { materialEvidenceDigest } from "./autonomous.js";
import { SellableAssetDraftSchema } from "./initiative.js";
import {
  GTM_CAPABILITY_CATALOG_VERSION,
  PUBLIC_OFFER_DEPLOYMENT_BOUNDARY,
  capabilityEvidencePrerequisites,
  evidenceSatisfiesCapabilityPrerequisite,
  getGtmCapability,
  preauthorizedEnvelopeBounds,
  publicOfferAuthorityProblems
} from "./capabilities.js";

type Scope = { workspaceId: string; companyId: string };
type ReconciledOperatedPayment = ReconciledStripeEvent<OperatedCompanyPaymentEvent>;
type StoredPayload = Record<string, unknown> & { semanticHash: string };
export type DigitalAccessKey = { key: Uint8Array; keyId: string };
export type DigitalAccessRedemption =
  | { created: true; delivered: true; grantId: string; accessSecret: string; proofTier: "fulfillment-verified" | "fixture-verified" }
  | { created: false; delivered: false; alreadyDelivered: true; grantId: string; proofTier: "fulfillment-verified" | "fixture-verified" };

const SUPPRESSION_KINDS = new Set<ResendEmailEvent["kind"]>(["bounced", "complained", "suppressed", "unsubscribed"]);

export class GoldenProviderProofService {
  constructor(private readonly storage: KernelStorage) {}

  async ingestStripe(event: ReconciledStripeEvent, scope: Scope): Promise<{ created: boolean; proofTier: ProofTier; entitlementApplied?: boolean; revokedGrants: number; restoredGrants: number }> {
    assertStripeBinding(event, scope);
    const entitlementPeriod = event.namespace === "saas_entitlement" && event.observedEntitlement !== "pending"
      ? await this.entitlementPeriod(event, scope)
      : undefined;
    const proofTier = stripeProofTier(event);
    const semantic = stripeSemantic(event, proofTier, entitlementPeriod);
    const stored = await this.persist({
      ...scope,
      id: providerEventId("stripe", event.providerEventId),
      eventType: event.namespace === "saas_entitlement" ? "stripe-saas-entitlement-reconciled" : "stripe-operated-payment-reconciled",
      actor: "stripe-reconciliation",
      entityType: event.namespace === "saas_entitlement" ? "saas-entitlement" : "operated-payment",
      entityId: event.reconciliation.objectId,
      semantic,
      firstObservedAt: event.reconciledAt,
      occurredAt: event.occurredAt
    });
    await this.appendProof(scope, stored.payload, proofTier, event.namespace === "saas_entitlement" ? "finance" : "payment", stored.occurredAt, stored.id, "stripe");
    if (event.namespace === "operated_company_payment" && event.providerMode === "live") {
      const authoritativeType = event.observedKind === "payment" && isLiveSettledStripePayment(event)
        ? "authoritative-payment-collected"
        : event.observedKind === "refund"
          ? "authoritative-payment-refunded"
          : event.observedKind === "dispute"
            ? "authoritative-payment-disputed"
            : event.observedKind === "dispute_resolved"
              ? "authoritative-payment-dispute-resolved"
            : undefined;
      if (authoritativeType) await this.appendAuthoritativeBusinessEvidence(scope, stored, authoritativeType, event.observedKind === "payment" ? "revenue-verified" : "externally-live", "payment");
    }

    let entitlementApplied: boolean | undefined;
    if (event.namespace === "saas_entitlement" && event.observedEntitlement !== "pending") {
      const entitlement = await this.storage.putEntitlement({
        ...scope,
        status: entitlementStatus(event.observedEntitlement),
        plan: `${event.providerMode}:${event.observedEntitlement === "trialing" ? "trial" : "paid"}`,
        periodStart: entitlementPeriod!.periodStart,
        periodEnd: entitlementPeriod!.periodEnd,
        modelCostCapCents: event.observedEntitlement === "trialing" ? 1_000 : 10_000,
        providerEventId: `stripe:${event.providerMode}:${event.providerEventId}`,
        providerOrder: stripeOrder(event),
        observedAt: String(stored.payload.firstObservedAt)
      });
      entitlementApplied = entitlement.applied;
    }

    const revokedGrants = event.namespace === "operated_company_payment" && ["refund", "dispute"].includes(event.observedKind)
      ? await this.revokePaymentGrants(scope, event)
      : 0;
    const restoredGrants = event.namespace === "operated_company_payment" && event.observedKind === "dispute_resolved"
      ? await this.restorePaymentGrants(scope, event)
      : 0;
    await this.reenableMaterialEvidenceReplan(scope, stored.occurredAt);
    return { created: stored.created, proofTier, ...(entitlementApplied === undefined ? {} : { entitlementApplied }), revokedGrants, restoredGrants };
  }

  async grantDigitalAccess(event: ReconciledOperatedPayment, scope: Scope, access: DigitalAccessKey): Promise<{ created: boolean; grantId: string; status: "pending-redemption" | "active" | "revoked" }> {
    await this.ingestStripe(event, scope);
    if (event.observedKind !== "payment" || !event.relatedPaymentObjectId || event.namespace !== "operated_company_payment"
      || event.verification !== "authoritatively-reconciled" || event.authoritativeStatus !== "succeeded" || (event.amount ?? 0) <= 0) {
      throw new Error("digital access requires an authoritatively reconciled operated-company payment");
    }
    assertAccessKey(access);
    const paymentObjectId = event.relatedPaymentObjectId;
    const grantId = `grant_${sha256({ companyId: scope.companyId, paymentObjectId }).slice(0, 24)}`;
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    const existing = events.find((item) => item.id === grantId);
    if (existing) {
      assertGrantEvent(existing, paymentObjectId);
      return { created: false, grantId, status: isGrantRevoked(events, grantId) ? "revoked" : isGrantRedeemed(events, grantId) ? "active" : "pending-redemption" };
    }
    if (hasNegativePaymentEvent(events, paymentObjectId)) throw new Error("digital access cannot be granted for a refunded or disputed payment");

    const accessSecret = deriveAccessSecret(access.key, scope, paymentObjectId);
    const proofTier = event.providerMode === "live" ? "externally-live" : "fixture-verified";
    const semantic = {
      provider: "opspot-digital-access",
      ledger: "operated_company_fulfillment",
      proofTier,
      providerMode: event.providerMode,
      status: "pending-redemption",
      grantId,
      paymentObjectId,
      paymentProviderEventId: event.providerEventId,
      keyId: access.keyId,
      accessSecretHash: createHash("sha256").update(accessSecret).digest("hex")
    };
    let stored: Awaited<ReturnType<GoldenProviderProofService["persist"]>>;
    try {
      stored = await this.persist({
        ...scope,
        id: grantId,
        eventType: "digital-access-granted",
        actor: "opspot-digital-access",
        entityType: "fulfillment-grant",
        entityId: grantId,
        semantic,
        firstObservedAt: event.reconciledAt,
        occurredAt: new Date().toISOString()
      });
    } catch (error) {
      if (!(error instanceof KernelStorageConflictError)) throw error;
      const replay = (await this.storage.listEvents(scope.workspaceId, scope.companyId)).find((item) => item.id === grantId);
      if (!replay) throw error;
      assertGrantEvent(replay, paymentObjectId);
      const current = await this.storage.listEvents(scope.workspaceId, scope.companyId);
      return { created: false, grantId, status: isGrantRevoked(current, grantId) ? "revoked" : isGrantRedeemed(current, grantId) ? "active" : "pending-redemption" };
    }
    await this.appendProof(scope, stored.payload, proofTier, "fulfillment", stored.occurredAt, stored.id, "opspot-digital-access");
    const afterGrant = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    const racedNegative = negativePaymentEvent(afterGrant, paymentObjectId);
    if (racedNegative) {
      await this.revokeGrantFromStoredNegative(scope, grantId, paymentObjectId, racedNegative);
      return { created: stored.created, grantId, status: "revoked" };
    }
    await this.reenableMaterialEvidenceReplan(scope, stored.occurredAt);
    return { created: stored.created, grantId, status: "pending-redemption" };
  }

  async redeemDigitalAccess(
    scope: Scope,
    paymentObjectId: string,
    providerMode: "live" | "test",
    access: DigitalAccessKey,
    options: { allowFixture?: boolean } = {}
  ): Promise<DigitalAccessRedemption> {
    assertAccessKey(access);
    if (providerMode === "test" && !options.allowFixture) throw new Error("test-mode access is fixture-only and cannot be released operationally");
    const grantId = `grant_${sha256({ companyId: scope.companyId, paymentObjectId }).slice(0, 24)}`;
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    const grant = events.find((event) => event.id === grantId);
    if (!grant) throw new Error("digital access has not been provisioned");
    assertGrantEvent(grant, paymentObjectId);
    if (isGrantRevoked(events, grantId)) throw new Error("digital access is revoked");
    const grantPayload = storedPayload(grant);
    if (grantPayload.providerMode !== providerMode || grantPayload.keyId !== access.keyId) throw new Error("digital access key or provider mode does not match the grant");
    const accessSecret = deriveAccessSecret(access.key, scope, paymentObjectId);
    const expectedHash = String(grantPayload.accessSecretHash ?? "");
    const actualHash = createHash("sha256").update(accessSecret).digest("hex");
    if (!safeEqualHex(actualHash, expectedHash)) throw new Error("digital access derivation does not match the grant");
    const proofTier = providerMode === "live" ? "fulfillment-verified" : "fixture-verified";
    const redemptionId = `redeem_${sha256({ grantId, paymentObjectId }).slice(0, 24)}`;
    const stored = await this.persist({
      ...scope,
      id: redemptionId,
      eventType: "digital-access-redeemed",
      actor: "opspot-digital-access",
      entityType: "fulfillment-grant",
      entityId: grantId,
      semantic: { provider: "opspot-digital-access", ledger: "operated_company_fulfillment", grantId, paymentObjectId, providerMode, status: "active", proofTier, owningSystem: "opspot-public-offer" },
      firstObservedAt: new Date().toISOString(),
      occurredAt: new Date().toISOString()
    });
    if (!stored.created) return { created: false, delivered: false, alreadyDelivered: true, grantId, proofTier };
    await this.appendProof(scope, stored.payload, proofTier, "fulfillment", stored.occurredAt, stored.id, "opspot-digital-access");
    await this.appendAccessOutcomeEvidence(scope, stored, providerMode, providerMode === "live" ? "authoritative-fulfillment-delivered" : "fixture-fulfillment-delivered");
    return { created: true, delivered: true, grantId, accessSecret, proofTier };
  }

  async verifyDigitalAccess(scope: Scope, accessSecret: string, options: { allowFixture?: boolean } = {}): Promise<boolean> {
    return Boolean(await this.activeGrantForSecret(scope, accessSecret, options));
  }

  async useDigitalAccess(
    scope: Scope,
    accessSecret: string,
    idempotencyKey: string,
    options: { allowFixture?: boolean } = {}
  ): Promise<{ active: boolean; created: boolean; retentionObserved: boolean }> {
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(idempotencyKey)) throw new Error("invalid access-use idempotency key");
    const grant = await this.activeGrantForSecret(scope, accessSecret, options);
    if (!grant) return { active: false, created: false, retentionObserved: false };
    const providerMode = grant.providerMode;
    const proofTier = providerMode === "live" ? "fulfillment-verified" : "fixture-verified";
    const occurredAt = new Date().toISOString();
    const useId = `use_${sha256({ grantId: grant.event.id, idempotencyKey }).slice(0, 24)}`;
    const use = await this.persist({
      ...scope,
      id: useId,
      eventType: "digital-access-used",
      actor: "opspot-digital-access",
      entityType: "fulfillment-grant",
      entityId: grant.event.id,
      semantic: {
        provider: "opspot-digital-access",
        ledger: "operated_company_fulfillment",
        grantId: grant.event.id,
        paymentObjectId: grant.paymentObjectId,
        providerMode,
        status: "used",
        proofTier,
        idempotencyKeyHash: sha256(idempotencyKey)
      },
      firstObservedAt: occurredAt,
      occurredAt
    });
    const firstUse = await this.persist({
      ...scope,
      id: `first_use_${sha256({ grantId: grant.event.id }).slice(0, 24)}`,
      eventType: "digital-access-first-use-observed",
      actor: "opspot-digital-access",
      entityType: "fulfillment-grant",
      entityId: grant.event.id,
      semantic: { provider: "opspot-digital-access", ledger: "operated_company_fulfillment", grantId: grant.event.id, paymentObjectId: grant.paymentObjectId, providerMode, status: "first-use", proofTier },
      firstObservedAt: use.occurredAt,
      occurredAt: use.occurredAt
    });
    if (use.created || firstUse.created) {
      await this.appendAccessOutcomeEvidence(scope, use, providerMode, providerMode === "live" ? "authoritative-usage-observed" : "fixture-usage-observed");
    }
    const retentionObserved = use.created && !firstUse.created;
    if (retentionObserved) {
      await this.appendAccessOutcomeEvidence(scope, use, providerMode, providerMode === "live" ? "authoritative-retention-observed" : "fixture-retention-observed");
      await this.reenableMaterialEvidenceReplan(scope, use.occurredAt);
    }
    return { active: true, created: use.created, retentionObserved };
  }

  private async activeGrantForSecret(
    scope: Scope,
    accessSecret: string,
    options: { allowFixture?: boolean }
  ): Promise<{ event: KernelEvent; paymentObjectId: string; providerMode: "live" | "test" } | undefined> {
    if (!accessSecret) return undefined;
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    const candidate = createHash("sha256").update(accessSecret).digest();
    for (const event of events) {
      if (event.eventType !== "digital-access-granted" || isGrantRevoked(events, event.id) || !isGrantRedeemed(events, event.id)) continue;
      const payload = storedPayload(event);
      const providerMode = payload.providerMode;
      if ((providerMode !== "live" && providerMode !== "test") || (providerMode === "test" && !options.allowFixture)) continue;
      const expected = Buffer.from(String((event.payload as Record<string, unknown>).accessSecretHash ?? ""), "hex");
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        return { event, paymentObjectId: String(payload.paymentObjectId), providerMode };
      }
    }
    return undefined;
  }

  async ingestEmail(event: ResendEmailEvent, scope: Scope, sentEmail?: ReconciledResendEmail, receivedEmail?: ReconciledResendReceivedEmail): Promise<{ created: boolean; suppressedRecipients: string[]; proofTier: "externally-live" }> {
    if (event.verification !== "signed-webhook" || event.sourceBinding?.workspaceId !== scope.workspaceId || event.sourceBinding.companyId !== scope.companyId) {
      throw new Error("Resend event is not bound to the target company connector");
    }
    if (event.kind === "reply") {
      if (!receivedEmail || receivedEmail.verification !== "provider-retrieved" || receivedEmail.emailId !== event.emailId
        || !event.sender || receivedEmail.sender !== event.sender) {
        throw new Error("Resend reply is missing authoritative received-email reconciliation");
      }
      const threadReferences = [
        ...receivedEmail.inReplyTo,
        ...receivedEmail.references,
        ...receivedEmail.recipients.map(resendThreadRefFromReplyAddress).filter((value): value is string => Boolean(value))
      ];
      if (!threadReferences.length) throw new Error("Resend reply is missing a strong outbound thread binding");
      const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
      const bound = events.some((candidate) => {
        if (candidate.eventType !== "golden-execution-completed" || !candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) return false;
        const payload = candidate.payload as Record<string, unknown>;
        const threadRef = payload.threadRef;
        return payload.provider === "resend" && typeof threadRef === "string"
          && threadReferences.some((reference) => reference.toLowerCase() === threadRef.toLowerCase());
      });
      if (!bound) throw new Error("Resend reply does not reference an outbound thread from this company");
    }
    const outgoing = event.kind !== "reply" && event.kind !== "unsubscribed";
    if (outgoing && !event.recipients.length) throw new Error("Resend outbound event requires a recipient");
    if (outgoing) {
      if (!sentEmail || sentEmail.verification !== "provider-retrieved" || sentEmail.emailId !== event.emailId
        || sentEmail.sourceBinding.workspaceId !== scope.workspaceId || sentEmail.sourceBinding.companyId !== scope.companyId
        || event.recipients.some((recipient) => !sentEmail.recipients.includes(recipient))) {
        throw new Error("Resend outbound event requires matching authoritative sent-email reconciliation");
      }
    }
    const recipients = [...new Set(event.recipients)];
    if (SUPPRESSION_KINDS.has(event.kind) && !recipients.length) throw new Error("suppression event requires a recipient");
    const proofTier = "externally-live" as const;
    const semantic = {
      provider: "resend",
      ledger: "email_delivery",
      proofTier,
      verification: outgoing || event.kind === "reply" ? "signed-webhook+provider-retrieved" : "signed-webhook",
      providerEventId: event.eventId,
      providerObjectId: event.emailId,
      kind: event.kind,
      recipients,
      payloadHash: event.payloadHash
    };
    const stored = await this.persist({
      ...scope,
      id: providerEventId("resend", event.eventId),
      eventType: "resend-email-event-reconciled",
      actor: "resend-webhook",
      entityType: "email-delivery",
      entityId: event.emailId,
      semantic,
      firstObservedAt: sentEmail?.retrievedAt ?? event.occurredAt,
      occurredAt: event.occurredAt
    });
    await this.appendProof(scope, stored.payload, proofTier, "company", stored.occurredAt, stored.id, "resend");

    const suppressedRecipients: string[] = [];
    if (SUPPRESSION_KINDS.has(event.kind)) {
      for (const recipient of recipients) {
        const id = `event_email_suppression_${sha256({ providerEventId: event.eventId, recipient }).slice(0, 24)}`;
        await this.storage.appendEvent({
          ...scope,
          id,
          eventType: "email-recipient-suppressed",
          actor: "resend-webhook",
          entityType: "email-recipient",
          entityId: sha256(recipient).slice(0, 32),
          payload: { provider: "resend", providerEventId: event.eventId, recipient, reason: event.kind, status: "suppressed", proofTier },
          occurredAt: event.occurredAt
        });
        suppressedRecipients.push(recipient);
      }
    }
    await this.reenableMaterialEvidenceReplan(scope, stored.occurredAt);
    return { created: stored.created, suppressedRecipients, proofTier };
  }

  async listSuppressedRecipients(scope: Scope): Promise<string[]> {
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    return [...new Set(events.filter((event) => event.eventType === "email-recipient-suppressed").map((event) => String((event.payload as Record<string, unknown>).recipient ?? "")).filter(Boolean))].sort();
  }

  async stripeSaasCustomerId(scope: Scope, providerMode: "live" | "test"): Promise<string | undefined> {
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    const candidates = events
      .filter((event) => event.eventType === "stripe-saas-entitlement-reconciled")
      .map((event) => storedPayload(event))
      .filter((payload) => payload.providerMode === providerMode)
      .filter((payload) => typeof payload.customerId === "string")
      .sort((left, right) => Number(right.providerCreatedAt) - Number(left.providerCreatedAt));
    return candidates.length ? String(candidates[0]!.customerId) : undefined;
  }

  private async entitlementPeriod(event: Extract<ReconciledStripeEvent, { namespace: "saas_entitlement" }>, scope: Scope): Promise<{ periodStart: string; periodEnd: string; source: "provider-event" | "stored-authoritative-entitlement" }> {
    if (event.authoritativePeriodStart || event.authoritativePeriodEnd) {
      return { ...authoritativeEntitlementPeriod(event.authoritativePeriodStart, event.authoritativePeriodEnd), source: "provider-event" };
    }
    if (!["inactive", "past_due", "unpaid", "refunded", "disputed"].includes(event.observedEntitlement)) {
      throw new Error("reconciled SaaS entitlement requires exact authoritative period fields");
    }
    const replay = (await this.storage.listEvents(scope.workspaceId, scope.companyId)).find((item) => item.id === providerEventId("stripe", event.providerEventId));
    if (replay) {
      const payload = storedPayload(replay);
      if (payload.providerEventId !== event.providerEventId || typeof payload.periodStart !== "string" || typeof payload.periodEnd !== "string") {
        throw new KernelStorageConflictError("stored entitlement provider event is invalid");
      }
      return { ...authoritativeEntitlementPeriod(payload.periodStart, payload.periodEnd), source: "stored-authoritative-entitlement" };
    }
    const current = await this.storage.getEntitlement(scope.workspaceId, scope.companyId);
    if (!current) throw new Error("negative SaaS entitlement cannot reuse a missing authoritative period");
    return { periodStart: current.periodStart, periodEnd: current.periodEnd, source: "stored-authoritative-entitlement" };
  }

  private async revokePaymentGrants(scope: Scope, event: ReconciledOperatedPayment): Promise<number> {
    if (!event.relatedPaymentObjectId) throw new Error("refund or dispute is missing its authoritative payment reference");
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    if (!negativePaymentEvent(events, event.relatedPaymentObjectId)) return 0;
    let created = 0;
    const proofTier = event.providerMode === "live" ? "externally-live" : "fixture-verified";
    for (const grant of events.filter((item) => paymentObjectForGrant(item) === event.relatedPaymentObjectId)) {
      if (isGrantRevoked(events, grant.id)) continue;
      const transitionObjectId = event.reconciliation.objectId;
      const id = `revoke_${sha256({ grantId: grant.id, reason: event.observedKind, transitionObjectId }).slice(0, 24)}`;
      const stored = await this.persist({
        ...scope,
        id,
        eventType: "digital-access-revoked",
        actor: "opspot-digital-access",
        entityType: "fulfillment-grant",
        entityId: grant.id,
        semantic: { provider: "opspot-digital-access", ledger: "operated_company_fulfillment", grantId: grant.id, paymentObjectId: event.relatedPaymentObjectId, reason: event.observedKind, transitionObjectId, providerCreatedAt: event.providerCreatedAt, providerMode: event.providerMode, status: "revoked", proofTier },
        firstObservedAt: event.reconciledAt,
        occurredAt: event.occurredAt
      });
      if (stored.created) created += 1;
      await this.appendProof(scope, stored.payload, proofTier, "fulfillment", stored.occurredAt, stored.id, "opspot-digital-access");
    }
    return created;
  }

  private async restorePaymentGrants(scope: Scope, event: ReconciledOperatedPayment): Promise<number> {
    if (!event.relatedPaymentObjectId) throw new Error("resolved dispute is missing its authoritative payment reference");
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    if (hasRefundPaymentEvent(events, event.relatedPaymentObjectId) || negativePaymentEvent(events, event.relatedPaymentObjectId)) return 0;
    let created = 0;
    for (const grant of events.filter((item) => paymentObjectForGrant(item) === event.relatedPaymentObjectId)) {
      const transitionObjectId = event.reconciliation.objectId;
      const id = `restore_${sha256({ grantId: grant.id, transitionObjectId }).slice(0, 24)}`;
      const stored = await this.persist({
        ...scope,
        id,
        eventType: "digital-access-restored",
        actor: "opspot-digital-access",
        entityType: "fulfillment-grant",
        entityId: grant.id,
        semantic: { provider: "opspot-digital-access", ledger: "operated_company_fulfillment", grantId: grant.id, paymentObjectId: event.relatedPaymentObjectId, reason: "dispute_won", transitionObjectId, providerCreatedAt: event.providerCreatedAt, providerMode: event.providerMode, status: "active", proofTier: event.providerMode === "live" ? "externally-live" : "fixture-verified" },
        firstObservedAt: event.reconciledAt,
        occurredAt: event.occurredAt
      });
      if (stored.created) created += 1;
      await this.appendProof(scope, stored.payload, event.providerMode === "live" ? "externally-live" : "fixture-verified", "fulfillment", stored.occurredAt, stored.id, "opspot-digital-access");
    }
    return created;
  }

  private async revokeGrantFromStoredNegative(scope: Scope, grantId: string, paymentObjectId: string, negative: KernelEvent): Promise<void> {
    const payload = storedPayload(negative);
    const proofTier = payload.providerMode === "live" ? "externally-live" : "fixture-verified";
    const transitionObjectId = String(payload.providerObjectId ?? payload.providerEventId);
    const id = `revoke_${sha256({ grantId, reason: payload.paymentKind, transitionObjectId }).slice(0, 24)}`;
    const stored = await this.persist({
      ...scope,
      id,
      eventType: "digital-access-revoked",
      actor: "opspot-digital-access",
      entityType: "fulfillment-grant",
      entityId: grantId,
      semantic: { provider: "opspot-digital-access", ledger: "operated_company_fulfillment", grantId, paymentObjectId, reason: payload.paymentKind, transitionObjectId, providerCreatedAt: payload.providerCreatedAt, providerMode: payload.providerMode, status: "revoked", proofTier },
      firstObservedAt: String(payload.firstObservedAt),
      occurredAt: negative.occurredAt
    });
    await this.appendProof(scope, stored.payload, proofTier, "fulfillment", stored.occurredAt, stored.id, "opspot-digital-access");
  }

  private async persist(input: Scope & { id: string; eventType: string; actor: string; entityType: string; entityId: string; semantic: Record<string, unknown>; firstObservedAt: string; occurredAt: string }): Promise<{ created: boolean; id: string; payload: StoredPayload; occurredAt: string }> {
    const semanticHash = sha256(input.semantic);
    const existing = (await this.storage.listEvents(input.workspaceId, input.companyId)).find((item) => item.id === input.id);
    if (existing) {
      const payload = storedPayload(existing);
      if (payload.semanticHash !== semanticHash || existing.eventType !== input.eventType || existing.actor !== input.actor || existing.entityType !== input.entityType || existing.entityId !== input.entityId) throw new KernelStorageConflictError("provider event idempotency conflict");
      return { created: false, id: existing.id, payload, occurredAt: existing.occurredAt };
    }
    const payload: StoredPayload = { ...input.semantic, semanticHash, firstObservedAt: iso(input.firstObservedAt, "provider reconciliation timestamp") };
    const occurredAt = iso(input.occurredAt, "provider event timestamp");
    try {
      const result = await this.storage.appendEvent({ ...input, payload, occurredAt });
      return { created: result.created, id: input.id, payload, occurredAt };
    } catch (error) {
      if (!(error instanceof KernelStorageConflictError)) throw error;
      const replay = (await this.storage.listEvents(input.workspaceId, input.companyId)).find((item) => item.id === input.id);
      if (!replay) throw error;
      const replayPayload = storedPayload(replay);
      if (replayPayload.semanticHash !== semanticHash) throw error;
      return { created: false, id: replay.id, payload: replayPayload, occurredAt: replay.occurredAt };
    }
  }

  private async appendProof(scope: Scope, payload: StoredPayload, proofTier: ProofTier, authority: "finance" | "payment" | "fulfillment" | "company", occurredAt: string, eventId: string, adapter: string): Promise<void> {
    const contentHash = sha256(payload);
    const suffix = sha256({ companyId: scope.companyId, eventId, contentHash }).slice(0, 24);
    await this.storage.appendEvidence(scope.workspaceId, {
      id: `evidence_${suffix}`,
      ventureId: scope.companyId,
      type: `${adapter}-provider-proof`,
      proofTier,
      authority,
      sourceRef: `source_${adapter}_${suffix}`,
      observedAt: occurredAt,
      status: "current",
      contentHash,
      metadata: {
        ...payload,
        materialFacts: {
          provider: adapter,
          providerEventId: payload.providerEventId ?? eventId,
          providerObjectId: payload.providerObjectId ?? payload.paymentObjectId ?? null,
          status: payload.status ?? payload.authoritativeStatus ?? payload.kind ?? payload.paymentKind ?? null,
          proofTier,
          contentHash
        }
      }
    });
    await this.storage.appendReceipt(scope.workspaceId, {
      id: `receipt_${suffix}`,
      ventureId: scope.companyId,
      proofTier,
      outcome: "success",
      actor: adapter,
      adapter,
      artifactPath: `provider/${adapter}/${eventId}.json`,
      contentHash,
      occurredAt,
      metadata: payload,
      origin: "engine-derived"
    });
  }

  private async appendAuthoritativeBusinessEvidence(
    scope: Scope,
    stored: { id: string; payload: StoredPayload; occurredAt: string },
    type: string,
    proofTier: ProofTier,
    authority: "payment" | "fulfillment"
  ): Promise<void> {
    const paymentIdentity = String(stored.payload.relatedPaymentObjectId ?? stored.payload.paymentObjectId ?? stored.payload.providerObjectId ?? stored.id);
    const transitionIdentity = type === "authoritative-payment-refunded"
      ? String(stored.payload.providerObjectId ?? stored.id)
      : paymentIdentity;
    const semantic = {
      type,
      provider: stored.payload.provider,
      providerMode: stored.payload.providerMode,
      paymentObjectId: paymentIdentity,
      transitionObjectId: transitionIdentity,
      amount: stored.payload.amount,
      currency: stored.payload.currency,
      status: stored.payload.paymentKind ?? stored.payload.status
    };
    const contentHash = sha256(semantic);
    await this.storage.appendEvidence(scope.workspaceId, EvidenceItemSchema.parse({
      id: `evidence_${sha256({ companyId: scope.companyId, type, transitionIdentity }).slice(0, 24)}`,
      ventureId: scope.companyId,
      type,
      proofTier,
      authority,
      sourceRef: `stripe:${transitionIdentity}`,
      observedAt: stored.occurredAt,
      status: "current",
      contentHash,
      metadata: semantic
    }));
  }

  private async appendAccessOutcomeEvidence(
    scope: Scope,
    stored: { id: string; payload: StoredPayload; occurredAt: string },
    providerMode: "live" | "test",
    type: "authoritative-fulfillment-delivered" | "fixture-fulfillment-delivered" | "authoritative-usage-observed" | "fixture-usage-observed" | "authoritative-retention-observed" | "fixture-retention-observed"
  ): Promise<void> {
    const proofTier = providerMode === "live" ? "fulfillment-verified" : "fixture-verified";
    const authority = providerMode === "live" ? "fulfillment" : "fixture";
    const contentHash = sha256({ eventId: stored.id, type, payload: stored.payload });
    await this.storage.appendEvidence(scope.workspaceId, EvidenceItemSchema.parse({
      id: `evidence_${sha256({ companyId: scope.companyId, eventId: stored.id, type }).slice(0, 24)}`,
      ventureId: scope.companyId,
      type,
      proofTier,
      authority,
      sourceRef: stored.id,
      observedAt: stored.occurredAt,
      status: "current",
      contentHash,
      metadata: {
        provider: "opspot-digital-access",
        owningSystem: "opspot-public-offer",
        outcomeEventId: stored.id,
        providerMode,
        businessOutcomeVerified: providerMode === "live"
      }
    }));
  }

  private async reenableMaterialEvidenceReplan(scope: Scope, observedAt: string): Promise<void> {
    const company = await this.storage.getCompany(scope.workspaceId, scope.companyId);
    if (!company || company.killed) return;
    const parsed = CompanyStateSchema.safeParse(company.state);
    if (!parsed.success || parsed.data.runState !== "running") return;
    iso(observedAt, "material evidence timestamp");
    const dueAt = new Date().toISOString();
    if (parsed.data.nextCycleAt && parsed.data.nextCycleAt <= dueAt) return;
    const next = CompanyStateSchema.parse({
      ...parsed.data,
      version: company.stateVersion + 1,
      nextCycleAt: dueAt,
      updatedAt: dueAt
    });
    try {
      await this.storage.updateCompanyState(scope.workspaceId, scope.companyId, company.stateVersion, JSON.parse(JSON.stringify(next)) as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof KernelStorageConflictError)) throw error;
    }
  }
}

export interface PublicSellableAsset {
  workspaceId: string;
  companyId: string;
  assetId: string;
  publicSlug: string;
  sourceEvidenceId: string;
  offerName: string;
  publicSummary: string;
  amountCents: number;
  currency: "usd";
  digitalPromise: string;
  claims: string[];
  authorityDisposition: "preauthorized" | "approval-required";
  authorityEnvelopeDigest: string;
  approvalId?: string;
  publishedAt: string;
}

export class PublicSellableAssetService {
  constructor(
    private readonly storage: KernelStorage,
    private readonly slugKey: Uint8Array,
    private readonly keyId: string
  ) {
    if (slugKey.byteLength !== 32 || !keyId) throw new Error("public offer slug crypto requires a 32-byte key and key id");
  }

  async publish(observation: GoldenExecutionObservation): Promise<{ created: boolean; asset: PublicSellableAsset }> {
    const envelope = observation.company.bootstrap.snapshot.operatingEnvelope;
    const disposition = observation.task.actionBounds.authorityDisposition;
    if (observation.task.actionBounds.bootstrapDigest !== observation.company.bootstrap.digest
      || observation.task.actionBounds.authorityEnvelopeDigest !== sha256(envelope)) {
      throw new Error("public offer task is stale against immutable company authority");
    }
    if (disposition === "preauthorized") {
      if (!envelope.publicationAllowed || !envelope.deploymentBoundaries.includes(PUBLIC_OFFER_DEPLOYMENT_BOUNDARY)
        || canonicalize(observation.task.actionBounds.preauthorizedBounds) !== canonicalize(preauthorizedEnvelopeBounds(envelope))
        || observation.task.approvalRequired || observation.task.approvalId) {
        throw new Error("immutable public offer preauthorization is absent");
      }
    } else if (disposition === "approval-required") {
      if (!observation.task.approvalRequired || !observation.task.approvalId) throw new Error("exact public offer approval is absent");
      const approval = await this.storage.getApproval(observation.workspaceId, observation.company.ventureId, observation.task.approvalId);
      if (!approval || approval.status !== "approved" || approval.taskId !== observation.task.id || approval.actionDigest !== actionDigest(observation.task)) {
        throw new Error("exact public offer approval is not durably approved");
      }
    } else {
      throw new Error("public offer authority disposition is invalid");
    }
    const source = publicAssetSource(observation.evidence);
    if (disposition === "preauthorized") {
      if (publicOfferAuthorityProblems(envelope).length > 0
        || canonicalize(source.sellableAsset) !== canonicalize(envelope.publicOfferAuthority)) {
        throw new Error("public offer asset does not exactly match immutable offer authority");
      }
    }
    const assetId = `offer_${sha256({ companyId: observation.company.ventureId, sourceEvidenceId: source.id, contentHash: source.contentHash }).slice(0, 24)}`;
    const eventId = `event_public_offer_${sha256({ companyId: observation.company.ventureId, assetId }).slice(0, 24)}`;
    const events = await this.storage.listEvents(observation.workspaceId, observation.company.ventureId);
    const existing = events.find((event) => event.id === eventId);
    if (existing) return { created: false, asset: publicAssetFromEvent(existing) };
    const reference = `slug_${randomBytes(16).toString("hex")}`;
    const encrypted = encryptSecret(this.slugKey, this.keyId, canonicalize({
      workspaceId: observation.workspaceId,
      companyId: observation.company.ventureId,
      assetId
    }), reference);
    const publicSlug = `${reference}.${encrypted.ciphertext}`;
    const publishedAt = new Date().toISOString();
    const draft = source.sellableAsset;
    const asset: PublicSellableAsset = {
      workspaceId: observation.workspaceId,
      companyId: observation.company.ventureId,
      assetId,
      publicSlug,
      sourceEvidenceId: source.id,
      ...draft,
      authorityDisposition: observation.task.actionBounds.authorityDisposition as "preauthorized" | "approval-required",
      authorityEnvelopeDigest: String(observation.task.actionBounds.authorityEnvelopeDigest),
      ...(observation.task.approvalId ? { approvalId: observation.task.approvalId } : {}),
      publishedAt
    };
    await this.storage.appendEvent({
      workspaceId: observation.workspaceId,
      companyId: observation.company.ventureId,
      id: eventId,
      eventType: "public-sellable-asset-published",
      actor: "golden-company-worker",
      entityType: "public-sellable-asset",
      entityId: assetId,
      payload: { ...asset, semanticHash: sha256(asset) },
      occurredAt: publishedAt
    });
    return { created: true, asset };
  }

  async getBySlug(publicSlug: string): Promise<PublicSellableAsset | undefined> {
    if (!/^slug_[a-f0-9]{32}\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(publicSlug)) return undefined;
    const separator = publicSlug.indexOf(".");
    const reference = publicSlug.slice(0, separator);
    let identity: unknown;
    try {
      identity = JSON.parse(decryptSecret(this.slugKey, { reference, keyId: this.keyId, ciphertext: publicSlug.slice(separator + 1) }));
    } catch {
      return undefined;
    }
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
    const value = identity as Record<string, unknown>;
    if (typeof value.workspaceId !== "string" || typeof value.companyId !== "string" || typeof value.assetId !== "string") return undefined;
    const events = await this.storage.listEvents(value.workspaceId, value.companyId);
    const event = events.find((candidate) => candidate.eventType === "public-sellable-asset-published" && candidate.entityId === value.assetId);
    if (!event) return undefined;
    const asset = publicAssetFromEvent(event);
    return asset.publicSlug === publicSlug ? asset : undefined;
  }

  async getByIdentity(scope: Scope, assetId: string): Promise<PublicSellableAsset | undefined> {
    const events = await this.storage.listEvents(scope.workspaceId, scope.companyId);
    const event = events.find((candidate) => candidate.eventType === "public-sellable-asset-published" && candidate.entityId === assetId);
    return event ? publicAssetFromEvent(event) : undefined;
  }
}

export class PublicAssetGoldenExecutionExecutor implements GoldenExecutionExecutor {
  readonly provider = "opspot-public-offer";
  private readonly service: PublicSellableAssetService;

  constructor(storage: KernelStorage, slugKey: Uint8Array, keyId: string) {
    this.service = new PublicSellableAssetService(storage, slugKey, keyId);
  }

  supports(capabilityId: string): boolean {
    return capabilityId === "minimum-sellable-asset";
  }

  describe(observation: GoldenExecutionObservation) {
    const source = publicAssetSource(observation.evidence);
    return {
      effectType: "publish-product-owned-minimum-sellable-asset",
      requestHash: sha256({ sourceEvidenceId: source.id, contentHash: source.contentHash, sellableAsset: source.sellableAsset }),
      providerIdempotencyKey: `opspot-public-offer:${sha256({ taskId: observation.task.id, sourceEvidenceId: source.id }).slice(0, 48)}`
    };
  }

  async execute(observation: GoldenExecutionObservation): Promise<GoldenExecutionResult> {
    return this.publish(observation);
  }

  async reconcile(observation: GoldenExecutionObservation): Promise<GoldenExecutionResult> {
    return this.publish(observation);
  }

  private async publish(observation: GoldenExecutionObservation): Promise<GoldenExecutionResult> {
    const { asset, created } = await this.service.publish(observation);
    return {
      provider: this.provider,
      kind: "public-sellable-asset",
      providerObjectId: asset.assetId,
      proofTier: "internally-live",
      authoritative: true,
      occurredAt: asset.publishedAt,
      metadata: {
        workspaceId: asset.workspaceId,
        companyId: asset.companyId,
        publicSlug: asset.publicSlug,
        sourceEvidenceId: asset.sourceEvidenceId,
        amountCents: asset.amountCents,
        currency: asset.currency,
        authorityDisposition: asset.authorityDisposition,
        created,
        businessOutcomeVerified: false
      }
    };
  }
}

function publicAssetSource(evidence: readonly EvidenceItem[]): EvidenceItem & { sellableAsset: ReturnType<typeof SellableAssetDraftSchema.parse> } {
  const candidates = evidence
    .filter((item) => item.status === "current" && item.authority !== "fixture" && item.metadata.fixture !== true
      && item.type === "initiative-internal-artifact" && item.metadata.capabilityId === "minimum-sellable-asset")
    .map((item) => ({ item, parsed: SellableAssetDraftSchema.safeParse(item.metadata.sellableAsset) }))
    .filter((candidate) => candidate.parsed.success)
    .sort((left, right) => right.item.observedAt.localeCompare(left.item.observedAt));
  const source = candidates[0];
  if (!source || !source.parsed.success) throw new Error("current persisted minimum-sellable-asset evidence is missing");
  return Object.assign(source.item, { sellableAsset: source.parsed.data });
}

function publicAssetFromEvent(event: KernelEvent): PublicSellableAsset {
  if (event.eventType !== "public-sellable-asset-published" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new KernelStorageConflictError("stored public sellable asset is invalid");
  }
  const payload = event.payload as Record<string, unknown>;
  const draft = SellableAssetDraftSchema.parse({
    offerName: payload.offerName,
    publicSummary: payload.publicSummary,
    amountCents: payload.amountCents,
    currency: payload.currency,
    digitalPromise: payload.digitalPromise,
    claims: payload.claims
  });
  if (![payload.workspaceId, payload.companyId, payload.assetId, payload.publicSlug, payload.sourceEvidenceId, payload.authorityEnvelopeDigest, payload.publishedAt].every((value) => typeof value === "string")) {
    throw new KernelStorageConflictError("stored public sellable asset binding is invalid");
  }
  if (payload.authorityDisposition !== "preauthorized" && payload.authorityDisposition !== "approval-required") throw new KernelStorageConflictError("stored public sellable asset authority is invalid");
  const asset: PublicSellableAsset = {
    workspaceId: String(payload.workspaceId),
    companyId: String(payload.companyId),
    assetId: String(payload.assetId),
    publicSlug: String(payload.publicSlug),
    sourceEvidenceId: String(payload.sourceEvidenceId),
    ...draft,
    authorityDisposition: payload.authorityDisposition,
    authorityEnvelopeDigest: String(payload.authorityEnvelopeDigest),
    ...(typeof payload.approvalId === "string" ? { approvalId: payload.approvalId } : {}),
    publishedAt: iso(String(payload.publishedAt), "public asset publication timestamp")
  };
  if (payload.semanticHash !== sha256(asset)) throw new KernelStorageConflictError("stored public sellable asset integrity check failed");
  return asset;
}

export interface GoldenExecutionObservation {
  workspaceId: string;
  company: CompanyState;
  task: TaskDefinition;
  evidence: EvidenceItem[];
  suppressedRecipients: string[];
  sentToday: number;
  sentThisWeek: number;
}

export interface GoldenExecutionResult {
  provider: string;
  kind: string;
  providerObjectId: string;
  proofTier: "internally-live" | "externally-live";
  authoritative: true;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface GoldenExecutionExecutor {
  readonly provider: string;
  supports(capabilityId: string): boolean;
  describe(observation: GoldenExecutionObservation): { effectType: string; requestHash: string; providerIdempotencyKey: string; actionLimits?: { daily: number; weekly: number; observedAt: string } };
  execute(observation: GoldenExecutionObservation, providerIdempotencyKey: string): Promise<GoldenExecutionResult>;
  reconcile(observation: GoldenExecutionObservation, providerIdempotencyKey: string): Promise<GoldenExecutionResult>;
}

export class ResendGoldenExecutionExecutor implements GoldenExecutionExecutor {
  readonly provider = "resend";

  constructor(
    private readonly adapter: ResendEmailAdapter,
    private readonly options: { sender: string; ownedRecipient: string; ownedReplyRecipient?: string; now?: () => Date }
  ) {}

  supports(capabilityId: string): boolean {
    return capabilityId === "permissioned-acquisition";
  }

  describe(observation: GoldenExecutionObservation) {
    const action = this.action(observation);
    return {
      effectType: "permissioned-owned-endpoint-email",
      requestHash: sha256(action.input),
      providerIdempotencyKey: `opspot-email:${sha256({ taskId: observation.task.id, action: action.input }).slice(0, 48)}`,
      actionLimits: {
        daily: observation.company.bootstrap.snapshot.operatingEnvelope.dailyActionCap,
        weekly: observation.company.bootstrap.snapshot.operatingEnvelope.weeklyActionCap,
        observedAt: new Date().toISOString()
      }
    };
  }

  execute(observation: GoldenExecutionObservation, providerIdempotencyKey: string): Promise<GoldenExecutionResult> {
    return this.sendAndRetrieve(observation, providerIdempotencyKey, false);
  }

  reconcile(observation: GoldenExecutionObservation, providerIdempotencyKey: string): Promise<GoldenExecutionResult> {
    return this.sendAndRetrieve(observation, providerIdempotencyKey, true);
  }

  private action(observation: GoldenExecutionObservation) {
    const { task, company, evidence, workspaceId } = observation;
    const envelope = company.bootstrap.snapshot.operatingEnvelope;
    if (!envelope.allowedChannels.includes("email")) throw new GoldenWorkerError("channel-denied", "the frozen operating envelope does not allow email");
    if (envelope.quietHours.length) throw new GoldenWorkerError("quiet-hours-unsupported", "the frozen quiet-hours rule has no executable v1 schedule binding");
    const sender = providerControl(evidence, "provider-verified-sender-domain", "sender", this.options.sender, workspaceId, task.ventureId);
    const recipient = providerControl(evidence, "provider-verified-owned-recipient-endpoint", "recipient", this.options.ownedRecipient, workspaceId, task.ventureId);
    if (this.options.ownedReplyRecipient) providerControl(evidence, "provider-verified-owned-recipient-endpoint", "replyRecipient", this.options.ownedReplyRecipient, workspaceId, task.ventureId);
    providerControl(evidence, "provider-verified-suppression-control", "suppressionRef", envelope.suppressions[0], workspaceId, task.ventureId);
    if (!envelope.senderIdentities.includes(String(sender.metadata.senderRef ?? ""))) throw new GoldenWorkerError("sender-binding-invalid", "the provider-verified sender is outside the frozen envelope");
    if (!envelope.recipientRules.includes(String(recipient.metadata.recipientRule ?? ""))) throw new GoldenWorkerError("recipient-binding-invalid", "the owned recipient is outside the frozen envelope");
    if (observation.suppressedRecipients.includes(this.options.ownedRecipient.toLowerCase())) throw new GoldenWorkerError("recipient-suppressed", "the owned recipient is suppressed");
    if (observation.sentToday >= envelope.dailyActionCap || observation.sentThisWeek >= envelope.weeklyActionCap) {
      throw new GoldenWorkerError("action-cap-reached", "the frozen email action cap is exhausted");
    }
    const threadRef = resendThreadRef(workspaceId, task.ventureId, task.id);
    const input = {
      from: this.options.sender,
      to: this.options.ownedRecipient,
      replyTo: this.options.ownedReplyRecipient ? resendReplyAddress(this.options.ownedReplyRecipient, threadRef) : this.options.ownedRecipient,
      subject: "OpSpot GTM controlled acquisition self-test",
      text: `Controlled owned-endpoint route verification for task ${task.id}. No reply is required.`,
      headers: { "X-Entity-Ref-ID": threadRef },
      tags: [
        { name: "opspot_workspace", value: workspaceId },
        { name: "opspot_company", value: task.ventureId },
        { name: "opspot_task", value: task.id.replaceAll(":", "-").slice(0, 256) }
      ]
    };
    return {
      input,
      threadRef,
      envelope: {
        ownedSenders: [this.options.sender],
        ownedRecipients: [this.options.ownedRecipient],
        suppressedRecipients: observation.suppressedRecipients,
        dailyCap: envelope.dailyActionCap,
        weeklyCap: envelope.weeklyActionCap,
        sentToday: observation.sentToday,
        sentThisWeek: observation.sentThisWeek,
        now: this.options.now?.() ?? new Date()
      }
    };
  }

  private async sendAndRetrieve(observation: GoldenExecutionObservation, providerIdempotencyKey: string, reconciled: boolean): Promise<GoldenExecutionResult> {
    const action = this.action(observation);
    const sent = await this.adapter.send(action.input, action.envelope, providerIdempotencyKey);
    const retrieved = await this.adapter.retrieve(sent.id, { workspaceId: observation.workspaceId, companyId: observation.task.ventureId });
    const expectedRecipient = this.options.ownedRecipient.toLowerCase();
    if (!retrieved.recipients.includes(expectedRecipient)) throw new GoldenWorkerError("provider-binding-invalid", "the retrieved Resend object is not bound to the owned endpoint");
    return goldenResult({
      provider: this.provider,
      kind: "permissioned-acquisition-send",
      providerObjectId: retrieved.emailId,
      proofTier: "externally-live",
      authoritative: true,
      occurredAt: retrieved.retrievedAt,
      metadata: {
        verification: retrieved.verification,
        lastEvent: retrieved.lastEvent,
        providerCreatedAt: retrieved.createdAt,
        workspaceId: retrieved.sourceBinding.workspaceId,
        companyId: retrieved.sourceBinding.companyId,
        recipientHashes: retrieved.recipients.map((recipient) => sha256(recipient)),
        threadRef: action.threadRef,
        reconciled
      }
    });
  }
}

class GoldenWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly fatal = true) {
    super(message);
    this.name = "GoldenWorkerError";
  }
}

type StoredGoldenTask = TaskDefinition & { status: string; actionDigest: string; attemptCount: number };

export class GoldenCompanyWorker {
  private readonly proof: GoldenProviderProofService;
  private readonly executors: readonly GoldenExecutionExecutor[];

  constructor(
    private readonly storage: KernelStorage,
    executor: GoldenExecutionExecutor | readonly GoldenExecutionExecutor[],
    private readonly workerId = `golden-worker-${process.pid}`
  ) {
    this.proof = new GoldenProviderProofService(storage);
    this.executors = Array.isArray(executor) ? executor : [executor];
    if (!this.executors.length) throw new Error("golden worker requires at least one executor");
  }

  async runOnce(workspaceId: string): Promise<Record<string, unknown> | null> {
    await this.storage.recoverExpiredJobs(workspaceId);
    const job = await this.storage.claimJob(workspaceId, this.workerId, 120_000, ["golden-execution"]);
    if (!job?.leaseToken) return null;
    let task: StoredGoldenTask | undefined;
    try {
      task = await this.loadTask(workspaceId, job);
      const executor = this.executorFor(task);
      let observation = await this.freshObservation(workspaceId, job, task);
      const described = executor.describe(observation);
      if (!described.effectType || !/^[a-f0-9]{64}$/.test(described.requestHash) || !described.providerIdempotencyKey) {
        throw new GoldenWorkerError("invalid-provider-binding", "the golden executor returned an invalid frozen effect binding");
      }
      const effectKey = `golden:${task.ventureId}:${task.id}:${task.actionDigest}`;
      const effect = await this.storage.reserveEffect({
        workspaceId,
        companyId: task.ventureId,
        idempotencyKey: effectKey,
        jobId: job.id,
        taskId: task.id,
        provider: executor.provider,
        effectType: described.effectType,
        requestHash: described.requestHash,
        providerIdempotencyKey: described.providerIdempotencyKey,
        leaseToken: job.leaseToken,
        ...(described.actionLimits ? { actionLimits: described.actionLimits } : {})
      });
      if (effect.reason === "entitlement") throw new GoldenWorkerError("entitlement-denied", "the company has no active execution entitlement", false);
      if (effect.reason === "action-cap") throw new GoldenWorkerError("action-cap-reached", "the atomic provider action cap is exhausted");

      let result: GoldenExecutionResult;
      if (effect.reservation?.status === "committed" && effect.reservation.result) {
        result = goldenResult(effect.reservation.result);
      } else if (effect.reservation?.status === "needs-reconciliation") {
        observation = await this.freshObservation(workspaceId, job, task);
        result = goldenResult(await executor.reconcile(observation, described.providerIdempotencyKey));
        await this.requireLease(workspaceId, job);
        await this.storage.commitEffect({ workspaceId, companyId: task.ventureId, idempotencyKey: effectKey, leaseToken: job.leaseToken, result, reconciled: true });
      } else if (effect.reserved && effect.reservation?.status === "reserved") {
        observation = await this.freshObservation(workspaceId, job, task);
        result = goldenResult(await executor.execute(observation, described.providerIdempotencyKey));
        await this.requireLease(workspaceId, job);
        await this.storage.commitEffect({ workspaceId, companyId: task.ventureId, idempotencyKey: effectKey, leaseToken: job.leaseToken, result });
      } else {
        throw new GoldenWorkerError("effect-reconciliation-required", "the golden provider effect is unresolved", false);
      }
      if (result.provider !== executor.provider || result.metadata.workspaceId !== workspaceId || result.metadata.companyId !== task.ventureId) {
        throw new GoldenWorkerError("provider-result-binding-invalid", "the authoritative provider result is bound to another company");
      }

      const machine = {
        receiptVersion: "1.0.0",
        ventureId: task.ventureId,
        taskId: task.id,
        jobId: job.id,
        actionDigest: task.actionDigest,
        capabilityId: task.actionBounds.capabilityId,
        capabilityVersion: task.actionBounds.capabilityVersion,
        effectKey,
        provider: result.provider,
        providerObjectId: result.providerObjectId,
        kind: result.kind,
        authoritative: result.authoritative,
        providerMetadata: result.metadata,
        businessOutcomeVerified: false
      };
      const receipt = ReceiptSchema.parse({
        id: makeId("receipt", machine),
        ventureId: task.ventureId,
        taskId: task.id,
        proofTier: result.proofTier,
        outcome: "success",
        actor: "golden-company-worker",
        adapter: result.provider,
        artifactPath: `provider/${result.provider}/${result.providerObjectId}.json`,
        contentHash: sha256(machine),
        occurredAt: result.occurredAt,
        metadata: machine,
        origin: "engine-derived"
      });
      await this.storage.appendReceipt(workspaceId, receipt);
      const evidence = EvidenceItemSchema.parse({
        id: makeId("evidence", { ventureId: task.ventureId, taskId: task.id, receiptId: receipt.id }),
        ventureId: task.ventureId,
        type: task.actionBounds.capabilityId === "minimum-sellable-asset" ? "minimum-sellable-asset-published" : "permissioned-acquisition-provider-action",
        proofTier: result.proofTier,
        authority: "company",
        sourceRef: receipt.id,
        observedAt: result.occurredAt,
        status: "current",
        contentHash: receipt.contentHash,
        metadata: {
          taskId: task.id,
          receiptId: receipt.id,
          capabilityId: task.actionBounds.capabilityId,
          provider: result.provider,
          providerObjectId: result.providerObjectId,
          materialFacts: { capabilityId: task.actionBounds.capabilityId, provider: result.provider, providerObjectId: result.providerObjectId, proofTier: result.proofTier },
          businessOutcomeVerified: false
        }
      });
      await this.storage.appendEvidence(workspaceId, evidence);
      await this.storage.appendEvent({
        workspaceId,
        companyId: task.ventureId,
        id: makeId("audit", { event: "golden-execution-completed", taskId: task.id, receiptId: receipt.id }),
        eventType: "golden-execution-completed",
        actor: "golden-company-worker",
        entityType: "task",
        entityId: task.id,
        payload: { receiptId: receipt.id, evidenceId: evidence.id, effectKey, provider: result.provider, providerObjectId: result.providerObjectId, ...(result.provider === "resend" && typeof result.metadata.threadRef === "string" ? { threadRef: result.metadata.threadRef } : {}), proofTier: result.proofTier },
        occurredAt: result.occurredAt
      });
      await this.reenableReplan(workspaceId, task.ventureId, result.occurredAt);
      const completed = await this.storage.completeJob(workspaceId, task.ventureId, job.id, job.leaseToken);
      if (!completed) throw new GoldenWorkerError("lease-lost", "the golden job lease expired before completion", false);
      return { ventureId: task.ventureId, jobId: job.id, taskId: task.id, receiptId: receipt.id, evidenceId: evidence.id, outcome: "success", proofTier: result.proofTier };
    } catch (error) {
      const fatal = error instanceof GoldenWorkerError ? error.fatal : false;
      const attempts = task?.attemptCount ?? job.attemptCount;
      const maxAttempts = task?.maxAttempts ?? 1;
      const deadLetter = fatal || attempts >= maxAttempts;
      const message = error instanceof GoldenWorkerError ? error.message : "golden provider action failed";
      const failed = await this.storage.failJob({
        workspaceId,
        companyId: job.companyId,
        jobId: job.id,
        leaseToken: job.leaseToken,
        error: message,
        ...(deadLetter ? {} : { retryAt: new Date(Date.now() + (task?.backoffMs ?? 1000)).toISOString() }),
        deadLetter
      });
      return { ventureId: job.companyId, jobId: job.id, taskId: job.taskId, outcome: failed ? deadLetter ? "dead-letter" : "retry" : "lease-lost", error: message };
    }
  }

  private async loadTask(workspaceId: string, job: KernelJob): Promise<StoredGoldenTask> {
    const task = await this.storage.getTask(workspaceId, job.companyId, job.taskId);
    if (!task) throw new GoldenWorkerError("task-missing", "the golden job task is missing");
    const capability = GtmCapabilityIdSchema.safeParse(task.actionBounds.capabilityId);
    if (!capability.success || !this.executors.some((executor) => executor.supports(capability.data))
      || job.kind !== "golden-execution" || task.taskKind !== "venture-play" || task.mode !== "external"
      || !task.idempotencyKey.startsWith("ceo-initiative:") || task.actionBounds.senderOrSystem !== "ephemeral-specialist"
      || task.actionBounds.executionClass !== "golden-execution" || task.actionBounds.capabilityVersion !== GTM_CAPABILITY_CATALOG_VERSION) {
      throw new GoldenWorkerError("unsupported-task", "the worker only accepts a supported frozen golden-execution task");
    }
    if (task.status !== "running") throw new GoldenWorkerError("task-state-invalid", `the claimed golden task is ${task.status}`);
    const definition = taskDefinition(task);
    if (task.actionDigest !== actionDigest(definition)) throw new GoldenWorkerError("action-digest-invalid", "the stored golden action digest is invalid");
    const payload = object(job.payload, "golden job payload");
    if (payload.ventureId !== task.ventureId || payload.taskId !== task.id || payload.actionDigest !== task.actionDigest
      || payload.executionClass !== "golden-execution" || payload.capabilityId !== capability.data) {
      throw new GoldenWorkerError("job-binding-invalid", "the golden job is not bound to the exact task digest");
    }
    const catalog = getGtmCapability(capability.data);
    if (!task.gateClass || !catalog.gateClasses.includes(task.gateClass)
      || canonicalize(task.actionBounds.evidencePrerequisites) !== canonicalize(capabilityEvidencePrerequisites(catalog, task.gateClass))) {
      throw new GoldenWorkerError("catalog-binding-invalid", "the task capability, gate, or evidence contract changed after planning");
    }
    const exactPrefix = `golden-execution:${capability.data}:`;
    if (typeof task.actionBounds.exactCommandOrProviderCall !== "string" || !task.actionBounds.exactCommandOrProviderCall.startsWith(exactPrefix)
      || typeof task.actionBounds.authorityEvaluatedAt !== "string" || !Number.isFinite(Date.parse(task.actionBounds.authorityEvaluatedAt))) {
      throw new GoldenWorkerError("authority-binding-invalid", "the task lacks its exact frozen provider and authority binding");
    }
    if (task.actionBounds.authorityDisposition === "preauthorized") {
      if (task.approvalRequired || task.approvalId) throw new GoldenWorkerError("authority-binding-invalid", "a preauthorized task cannot carry an approval gate");
    } else if (task.actionBounds.authorityDisposition === "approval-required") {
      if (!task.approvalRequired || !task.approvalId) throw new GoldenWorkerError("approval-binding-invalid", "the task lacks its exact approval binding");
      const approval = await this.storage.getApproval(workspaceId, task.ventureId, task.approvalId);
      if (!approval || approval.status !== "approved" || approval.taskId !== task.id || approval.actionDigest !== task.actionDigest || !approval.resolutionId || !approval.resolvedAt) {
        throw new GoldenWorkerError("approval-binding-invalid", "the exact golden task approval is not durably approved");
      }
    } else {
      throw new GoldenWorkerError("authority-binding-invalid", "the golden task authority disposition is invalid");
    }
    return task;
  }

  private executorFor(task: StoredGoldenTask): GoldenExecutionExecutor {
    const capabilityId = GtmCapabilityIdSchema.parse(task.actionBounds.capabilityId);
    const matches = this.executors.filter((executor) => executor.supports(capabilityId));
    if (matches.length !== 1) throw new GoldenWorkerError("unsupported-task", "the golden capability must map to exactly one executor");
    return matches[0]!;
  }

  private async freshObservation(workspaceId: string, job: KernelJob, expected: StoredGoldenTask): Promise<GoldenExecutionObservation> {
    await this.requireLease(workspaceId, job);
    const current = await this.storage.getTask(workspaceId, job.companyId, job.taskId);
    if (!current || current.status !== "running" || current.actionDigest !== expected.actionDigest || actionDigest(taskDefinition(current)) !== expected.actionDigest) {
      throw new GoldenWorkerError("stale-task", "the golden task changed after claim");
    }
    const company = await this.storage.getCompany(workspaceId, job.companyId);
    if (!company) throw new GoldenWorkerError("company-missing", "the golden task company is missing");
    const state = CompanyStateSchema.parse(company.state);
    if (company.killed || state.runState === "killed") throw new GoldenWorkerError("company-killed", "the company kill switch is active");
    if (state.runState !== "running") throw new GoldenWorkerError("company-paused", `the company became ${state.runState} before the provider effect`);
    if (current.actionBounds.bootstrapDigest !== state.bootstrap.digest
      || current.actionBounds.authorityEnvelopeDigest !== sha256(state.bootstrap.snapshot.operatingEnvelope)) {
      throw new GoldenWorkerError("stale-authority", "the task no longer matches the immutable company authority envelope");
    }
    if (current.actionBounds.authorityDisposition === "preauthorized"
      && canonicalize(current.actionBounds.preauthorizedBounds) !== canonicalize(preauthorizedEnvelopeBounds(state.bootstrap.snapshot.operatingEnvelope))) {
      throw new GoldenWorkerError("stale-authority", "the preauthorized bounds changed after planning");
    }
    const expiresAt = state.bootstrap.snapshot.operatingEnvelope.expiresAt;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new GoldenWorkerError("authority-expired", "the operating envelope expired before the provider effect");
    if (current.goalTaskBinding?.scope === "goal-specific" && current.goalTaskBinding.goalRevisionId !== state.currentGoalRevisionId) {
      throw new GoldenWorkerError("stale-goal", "the golden task belongs to a superseded goal revision");
    }
    const evidenceIds = current.actionBounds.evidenceIds;
    if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== "string")) throw new GoldenWorkerError("evidence-binding-invalid", "the task lacks a frozen evidence set");
    const evidence = await this.storage.listEvidence(workspaceId, current.ventureId);
    if (current.actionBounds.materialEvidenceDigest !== materialEvidenceDigest(evidence)) throw new GoldenWorkerError("material-evidence-drift", "material evidence changed after golden planning");
    const byId = new Map(evidence.map((item) => [item.id, item]));
    if (evidenceIds.some((id) => !byId.has(id))) throw new GoldenWorkerError("evidence-binding-stale", "frozen golden evidence is unavailable");
    const frozenEvidence = evidenceIds.map((id) => byId.get(id)!);
    const capability = getGtmCapability(GtmCapabilityIdSchema.parse(current.actionBounds.capabilityId));
    const missing = capabilityEvidencePrerequisites(capability, current.gateClass).find((prerequisite) => !evidenceSatisfiesCapabilityPrerequisite(prerequisite, frozenEvidence));
    if (missing) throw new GoldenWorkerError("evidence-prerequisite-missing", `golden capability prerequisite is missing: ${missing}`);
    const events = await this.storage.listEvents(workspaceId, current.ventureId);
    const now = Date.now();
    const sends = events.filter((event) => event.eventType === "golden-execution-completed");
    return {
      workspaceId,
      company: state,
      task: taskDefinition(current),
      evidence: frozenEvidence,
      suppressedRecipients: await this.proof.listSuppressedRecipients({ workspaceId, companyId: current.ventureId }),
      sentToday: sends.filter((event) => Date.parse(event.occurredAt) >= now - 24 * 60 * 60_000).length,
      sentThisWeek: sends.filter((event) => Date.parse(event.occurredAt) >= now - 7 * 24 * 60 * 60_000).length
    };
  }

  private async requireLease(workspaceId: string, job: KernelJob): Promise<void> {
    if (!job.leaseToken || !(await this.storage.renewJobLease(workspaceId, job.companyId, job.id, job.leaseToken, 120_000))) {
      throw new GoldenWorkerError("lease-lost", "the golden job lease is no longer current", false);
    }
  }

  private async reenableReplan(workspaceId: string, companyId: string, completedAt: string): Promise<void> {
    const company = await this.storage.getCompany(workspaceId, companyId);
    if (!company || company.killed) return;
    const state = CompanyStateSchema.parse(company.state);
    if (state.runState !== "running") return;
    iso(completedAt, "golden execution timestamp");
    const dueAt = new Date().toISOString();
    const next = CompanyStateSchema.parse({ ...state, version: company.stateVersion + 1, nextCycleAt: dueAt, updatedAt: dueAt });
    try {
      await this.storage.updateCompanyState(workspaceId, companyId, company.stateVersion, JSON.parse(JSON.stringify(next)) as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof KernelStorageConflictError)) throw error;
    }
  }
}

function providerControl(evidence: EvidenceItem[], type: string, field: string, expected: string | undefined, workspaceId: string, companyId: string): EvidenceItem {
  if (!expected) throw new GoldenWorkerError("provider-control-missing", `the frozen ${type} binding is missing`);
  const item = evidence.find((candidate) => candidate.type === type && candidate.status === "current" && candidate.authority !== "fixture"
    && candidate.metadata.provider === "resend" && candidate.metadata.workspaceId === workspaceId && candidate.metadata.companyId === companyId
    && candidate.metadata.verified === true && String(candidate.metadata[field] ?? "").toLowerCase() === expected.toLowerCase());
  if (!item) throw new GoldenWorkerError("provider-control-missing", `provider verification is missing for ${type}`);
  return item;
}

function resendThreadRef(workspaceId: string, companyId: string, taskId: string): string {
  return `<opspot.${sha256({ version: 1, workspaceId, companyId, taskId }).slice(0, 48)}@thread.opspot.invalid>`;
}

function splitEmail(value: string): [string, string] | undefined {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1 || normalized.includes(" ")) return undefined;
  return [normalized.slice(0, separator), normalized.slice(separator + 1)];
}

export function resendReplyAddress(baseRecipient: string, threadRef: string): string {
  const base = splitEmail(baseRecipient);
  const thread = /^<opspot\.([a-f0-9]{48})@thread\.opspot\.invalid>$/.exec(threadRef);
  if (!base || !thread) throw new Error("invalid Resend reply binding");
  return `${base[0]}+${thread[1]}@${base[1]}`;
}

export function resendInboundRecipientMatches(baseRecipient: string, candidate: string): boolean {
  const base = splitEmail(baseRecipient);
  const received = splitEmail(candidate);
  if (!base || !received || base[1] !== received[1]) return false;
  if (received[0] === base[0]) return true;
  return received[0].startsWith(`${base[0]}+`) && /^[a-f0-9]{48}$/.test(received[0].slice(base[0].length + 1));
}

function resendThreadRefFromReplyAddress(recipient: string): string | undefined {
  const parsed = splitEmail(recipient);
  if (!parsed) return undefined;
  const token = parsed[0].slice(parsed[0].lastIndexOf("+") + 1);
  return /^[a-f0-9]{48}$/.test(token) ? `<opspot.${token}@thread.opspot.invalid>` : undefined;
}

function taskDefinition(task: StoredGoldenTask): TaskDefinition {
  const definition = { ...task } as Record<string, unknown>;
  delete definition.status;
  delete definition.actionDigest;
  delete definition.attemptCount;
  return TaskDefinitionSchema.parse(definition);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoldenWorkerError("invalid-job", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function goldenResult(value: unknown): GoldenExecutionResult {
  const result = object(value, "golden provider result");
  if (typeof result.provider !== "string" || !result.provider || typeof result.kind !== "string" || !result.kind
    || typeof result.providerObjectId !== "string" || !result.providerObjectId || !["internally-live", "externally-live"].includes(String(result.proofTier))
    || result.authoritative !== true || typeof result.occurredAt !== "string" || !Number.isFinite(Date.parse(result.occurredAt))
    || !result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata)) {
    throw new GoldenWorkerError("provider-result-invalid", "the golden provider result lacks authoritative bounded fields");
  }
  return result as unknown as GoldenExecutionResult;
}

function assertStripeBinding(event: ReconciledStripeEvent, scope: Scope): void {
  if (event.verification !== "authoritatively-reconciled" || !event.authoritativeStatus || !["live", "test"].includes(event.providerMode)) throw new Error("Stripe event is not authoritatively reconciled");
  if (event.workspaceId !== scope.workspaceId || event.companyId !== scope.companyId
    || event.providerBinding?.workspaceId !== scope.workspaceId || event.providerBinding.companyId !== scope.companyId
    || event.providerBinding.kind !== event.namespace) throw new Error("Stripe provider binding does not match the target company");
  if (!Number.isSafeInteger(event.providerCreatedAt) || event.providerCreatedAt < 0) throw new Error("invalid Stripe provider order");
  iso(event.occurredAt, "Stripe event timestamp");
  iso(event.reconciledAt, "Stripe reconciliation timestamp");
}

function stripeProofTier(event: ReconciledStripeEvent): ProofTier {
  if (event.providerMode === "test") return "fixture-verified";
  return isLiveSettledStripePayment(event) ? "revenue-verified" : "externally-live";
}

function stripeSemantic(event: ReconciledStripeEvent, proofTier: ProofTier, entitlementPeriod?: { periodStart: string; periodEnd: string; source: string }): Record<string, unknown> {
  return {
    provider: "stripe",
    ledger: event.namespace,
    proofTier,
    verification: event.verification,
    providerMode: event.providerMode,
    providerEventId: event.providerEventId,
    providerCreatedAt: event.providerCreatedAt,
    providerObjectType: event.reconciliation.target,
    providerObjectId: event.reconciliation.objectId,
    authoritativeStatus: event.authoritativeStatus,
    workspaceId: event.workspaceId,
    companyId: event.companyId,
    ...(event.amount === undefined ? {} : { amount: event.amount }),
    ...(event.currency ? { currency: event.currency } : {}),
    ...(event.customerId ? { customerId: event.customerId } : {}),
    ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
    ...(event.namespace === "saas_entitlement"
      ? { entitlementStatus: event.observedEntitlement, ...(entitlementPeriod ? { periodStart: entitlementPeriod.periodStart, periodEnd: entitlementPeriod.periodEnd, periodSource: entitlementPeriod.source } : {}) }
      : { paymentKind: event.observedKind, relatedPaymentObjectId: event.relatedPaymentObjectId })
  };
}

function entitlementStatus(status: "pending" | "trialing" | "active" | "inactive" | "past_due" | "unpaid" | "refunded" | "disputed"): EntitlementStatus {
  if (status === "trialing" || status === "active") return "active";
  if (status === "pending") return "paused";
  if (status === "inactive") return "canceled";
  if (status === "past_due") return "past-due";
  if (status === "unpaid") return "expired";
  return status;
}

function authoritativeEntitlementPeriod(start: string | undefined, end: string | undefined): { periodStart: string; periodEnd: string } {
  if (!start || !end) throw new Error("reconciled SaaS entitlement requires exact authoritative period fields");
  const periodStart = iso(start, "Stripe entitlement period start");
  const periodEnd = iso(end, "Stripe entitlement period end");
  if (periodEnd <= periodStart) throw new Error("Stripe entitlement period end must follow period start");
  return { periodStart, periodEnd };
}

function stripeOrder(event: Extract<ReconciledStripeEvent, { namespace: "saas_entitlement" }>): number {
  const targetPriority: Record<string, number> = { "checkout.session": 0, subscription: 1, invoice: 2, charge: 3, dispute: 4 };
  const statusPriority: Record<string, number> = { pending: 0, trialing: 1, active: 2, past_due: 3, unpaid: 4, inactive: 5, refunded: 6, disputed: 7 };
  const tieBreak = Number.parseInt(sha256(event.providerEventId).slice(0, 4), 16) % 10_000;
  const created = event.providerCreatedAt * 1_000_000
    + (statusPriority[event.observedEntitlement] ?? 0) * 100_000
    + (targetPriority[event.reconciliation.target] ?? 5) * 10_000
    + tieBreak;
  if (!Number.isSafeInteger(created)) throw new Error("Stripe provider order exceeds safe integer range");
  return created;
}

function providerEventId(provider: string, id: string): string {
  return `event_${provider}_${sha256(id).slice(0, 24)}`;
}

function storedPayload(event: KernelEvent): StoredPayload {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) || typeof (event.payload as Record<string, unknown>).semanticHash !== "string") {
    throw new KernelStorageConflictError("stored provider event payload is invalid");
  }
  return event.payload as StoredPayload;
}

function assertGrantEvent(event: KernelEvent, paymentObjectId: string): void {
  if (event.eventType !== "digital-access-granted" || paymentObjectForGrant(event) !== paymentObjectId) {
    throw new KernelStorageConflictError("digital access grant idempotency conflict");
  }
}

function paymentObjectForGrant(event: KernelEvent): string | undefined {
  if (event.eventType !== "digital-access-granted" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const value = (event.payload as Record<string, unknown>).paymentObjectId;
  return typeof value === "string" ? value : undefined;
}

function isGrantRevoked(events: KernelEvent[], grantId: string): boolean {
  const transitions = events
    .filter((event) => ["digital-access-revoked", "digital-access-restored"].includes(event.eventType)
      && event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      && (event.payload as Record<string, unknown>).grantId === grantId)
    .sort((left, right) => providerTransitionOrder(left) - providerTransitionOrder(right) || left.occurredAt.localeCompare(right.occurredAt));
  return transitions.at(-1)?.eventType === "digital-access-revoked";
}

function isGrantRedeemed(events: KernelEvent[], grantId: string): boolean {
  return events.some((event) => event.eventType === "digital-access-redeemed" && event.entityId === grantId);
}

function hasNegativePaymentEvent(events: KernelEvent[], paymentObjectId: string): boolean {
  return Boolean(negativePaymentEvent(events, paymentObjectId));
}

function negativePaymentEvent(events: KernelEvent[], paymentObjectId: string): KernelEvent | undefined {
  const paymentEvents = events.filter((event) => {
    if (event.eventType !== "stripe-operated-payment-reconciled" || !event.payload || typeof event.payload !== "object") return false;
    const payload = event.payload as Record<string, unknown>;
    return ["refund", "dispute", "dispute_resolved"].includes(String(payload.paymentKind)) && payload.relatedPaymentObjectId === paymentObjectId;
  }).sort((left, right) => providerTransitionOrder(left) - providerTransitionOrder(right) || left.occurredAt.localeCompare(right.occurredAt));
  const refund = paymentEvents.find((event) => (event.payload as Record<string, unknown>).paymentKind === "refund");
  if (refund) return refund;
  const latest = paymentEvents.at(-1);
  return latest && (latest.payload as Record<string, unknown>).paymentKind === "dispute" ? latest : undefined;
}

function hasRefundPaymentEvent(events: KernelEvent[], paymentObjectId: string): boolean {
  return events.some((event) => event.eventType === "stripe-operated-payment-reconciled" && event.payload !== null
    && typeof event.payload === "object" && !Array.isArray(event.payload)
    && (event.payload as Record<string, unknown>).relatedPaymentObjectId === paymentObjectId
    && (event.payload as Record<string, unknown>).paymentKind === "refund");
}

function providerTransitionOrder(event: KernelEvent): number {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return 0;
  const value = Number((event.payload as Record<string, unknown>).providerCreatedAt ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function assertAccessKey(access: DigitalAccessKey): void {
  if (access.key.byteLength !== 32 || !/^[A-Za-z0-9._:-]{1,120}$/.test(access.keyId)) throw new Error("digital access requires a valid 32-byte key and key id");
}

function deriveAccessSecret(key: Uint8Array, scope: Scope, paymentObjectId: string): string {
  return `access_${createHmac("sha256", key).update(canonicalize({ purpose: "opspot-digital-access-v1", ...scope, paymentObjectId })).digest("base64url")}`;
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function iso(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${label}`);
  return date.toISOString();
}
