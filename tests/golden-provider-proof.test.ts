import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ResendEmailAdapter,
  StripeAdapter,
  normalizeResendWebhook,
  normalizeStripeEvent,
  stripeApiKeyMode,
  type OperatedCompanyPaymentEvent,
  reconcileStripeEvent,
  verifyResendWebhook,
  type ReconciledResendEmail,
  type ReconciledResendReceivedEmail,
  type ReconciledStripeEvent,
  type StripeEvent,
  type StripeReconciliationResult
} from "@opspot/adapters";
import { GoldenProviderProofService } from "../packages/domain/src/golden-provider.js";
import { EngineStorage, SqliteKernelStorage } from "@opspot/storage";

const AT = "2026-07-20T18:00:00.000Z";
const PERIOD_START = "2026-07-20T00:00:00.000Z";
const PERIOD_END = "2026-08-20T00:00:00.000Z";
const workspaceId = "workspace_golden";
const companyId = "venture_alpha";
const otherCompanyId = "venture_beta";
const access = { key: Buffer.alloc(32, 7), keyId: "access-test-v1" };

async function harness() {
  const engine = new EngineStorage(":memory:");
  const storage = new SqliteKernelStorage(engine);
  await storage.ensureWorkspace(workspaceId);
  for (const [id, slug] of [[companyId, "alpha"], [otherCompanyId, "beta"]] as const) {
    await storage.createCompany({ workspaceId, companyId: id, slug, name: slug, owner: "founder", owningRepo: `synthetic/${slug}`, lifecycleState: "candidate", state: {}, createdAt: AT, updatedAt: AT });
  }
  return { storage, service: new GoldenProviderProofService(storage) };
}

function stripeEvent(input: { id: string; type: string; created: number; objectId: string; object: string; kind: "saas_entitlement" | "operated_company_payment"; status?: string; amount?: number; amountRefunded?: number; charge?: string; company?: string }): StripeEvent {
  return {
    id: input.id,
    type: input.type,
    created: input.created,
    data: {
      object: {
        id: input.objectId,
        object: input.object,
        metadata: { opspot_kind: input.kind, opspot_workspace_id: workspaceId, opspot_company_id: input.company ?? companyId },
        ...(input.status ? { status: input.status } : {}),
        ...(input.amount === undefined ? {} : { amount: input.amount, amount_paid: input.amount, amount_received: input.amount }),
        ...(input.amountRefunded === undefined ? {} : { amount_refunded: input.amountRefunded }),
        ...(input.charge ? { charge: input.charge } : {}),
        ...(input.amount === undefined && input.amountRefunded === undefined ? {} : { currency: "usd" })
      }
    }
  };
}

function reconciled(raw: StripeEvent, input: { status: string; live?: boolean; amount?: number; company?: string; period?: boolean; relatedPaymentObjectId?: string }): ReconciledStripeEvent {
  const observed = normalizeStripeEvent(raw);
  if (!observed) throw new Error("test Stripe event did not normalize");
  const result: StripeReconciliationResult = {
    ...observed.reconciliation,
    authoritative: true,
    retrievedAt: AT,
    status: input.status,
    livemode: input.live ?? true,
    binding: { workspaceId, companyId: input.company ?? companyId, kind: observed.namespace },
    ...(input.amount === undefined ? {} : { amount: input.amount, currency: "usd" }),
    ...(input.period ? { periodStart: PERIOD_START, periodEnd: PERIOD_END } : {}),
    ...(input.relatedPaymentObjectId ? { relatedPaymentObjectId: input.relatedPaymentObjectId } : {})
  };
  const value = reconcileStripeEvent(observed, result);
  if (!value) throw new Error("test Stripe event did not reconcile");
  return value;
}

function saas(input: { id: string; type: string; created: number; observedStatus?: string; providerStatus: string; amount?: number; live?: boolean; period?: boolean; object?: string; objectId?: string }): ReconciledStripeEvent {
  return reconciled(stripeEvent({ id: input.id, type: input.type, created: input.created, objectId: input.objectId ?? "sub_1", object: input.object ?? "subscription", kind: "saas_entitlement", ...(input.observedStatus ? { status: input.observedStatus } : {}), ...(input.amount === undefined ? {} : { amount: input.amount }), ...(input.type === "charge.refunded" && input.amount !== undefined ? { amountRefunded: input.amount } : {}) }), { status: input.providerStatus, ...(input.amount === undefined ? {} : { amount: input.amount }), ...(input.live === undefined ? {} : { live: input.live }), period: input.period ?? true });
}

function payment(input: { id: string; type?: string; created: number; charge?: string; amount?: number; live?: boolean }): ReconciledStripeEvent {
  const objectId = input.charge ?? "ch_1";
  const type = input.type ?? "charge.succeeded";
  const refund = type === "charge.refunded";
  return reconciled(stripeEvent({ id: input.id, type, created: input.created, objectId, object: "charge", kind: "operated_company_payment", amount: input.amount ?? 12_000, ...(refund ? { amountRefunded: input.amount ?? 12_000 } : {}) }), { status: "succeeded", amount: input.amount ?? 12_000, relatedPaymentObjectId: objectId, ...(input.live === undefined ? {} : { live: input.live }) });
}

function signedResend(payload: Record<string, unknown>, binding = { workspaceId, companyId }) {
  const secretBytes = Buffer.from("golden-provider-webhook-secret");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const raw = JSON.stringify(payload);
  const id = `msg_${String(payload.type).replaceAll(".", "_")}_${String((payload.data as Record<string, unknown>).id ?? (payload.data as Record<string, unknown>).email_id)}`;
  const timestamp = String(new Date(AT).getTime() / 1_000);
  const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return normalizeResendWebhook(verifyResendWebhook(raw, { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, secret, { now: new Date(AT), sourceBinding: binding }));
}

describe("golden provider proof service", () => {
  it("classifies Stripe secret and restricted keys without exposing key material", () => {
    expect(stripeApiKeyMode("sk_test_redacted")).toBe("test");
    expect(stripeApiKeyMode("rk_test_redacted")).toBe("test");
    expect(stripeApiKeyMode("sk_live_redacted")).toBe("live");
    expect(stripeApiKeyMode("rk_live_redacted")).toBe("live");
    expect(() => stripeApiKeyMode("pk_live_redacted")).toThrow(/supported live or test/);
  });

  it("fails closed on missing SaaS period truth and keeps test billing out of revenue proof", async () => {
    const { storage, service } = await harness();
    try {
      const missingPeriod = saas({ id: "evt_missing_period", type: "invoice.paid", created: 10, providerStatus: "paid", amount: 49_900, period: false, object: "invoice", objectId: "in_missing" });
      await expect(service.ingestStripe(missingPeriod, { workspaceId, companyId })).rejects.toThrow(/exact authoritative period/);
      const firstSeenRefund = saas({ id: "evt_first_refund", type: "charge.refunded", created: 11, providerStatus: "succeeded", amount: 49_900, period: false, object: "charge", objectId: "ch_first_refund" });
      await expect(service.ingestStripe(firstSeenRefund, { workspaceId, companyId })).rejects.toThrow(/missing authoritative period/);
      expect(await storage.listEvents(workspaceId, companyId)).toEqual([]);

      const testInvoice = saas({ id: "evt_test_invoice", type: "invoice.paid", created: 20, providerStatus: "paid", amount: 49_900, live: false, object: "invoice", objectId: "in_test" });
      expect(await service.ingestStripe(testInvoice, { workspaceId, companyId })).toMatchObject({ proofTier: "fixture-verified", entitlementApplied: true });
      expect(await storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "active", plan: "test:paid", periodStart: PERIOD_START, periodEnd: PERIOD_END });

      const testPayment = payment({ id: "evt_test_payment", created: 30, charge: "ch_test", live: false });
      expect(await service.ingestStripe(testPayment, { workspaceId, companyId })).toMatchObject({ proofTier: "fixture-verified" });
      expect(await service.grantDigitalAccess(testPayment as OperatedPayment, { workspaceId, companyId }, access)).toMatchObject({ status: "pending-redemption" });
      expect((await storage.listEvidence(workspaceId, companyId)).some((item) => item.proofTier === "revenue-verified" || item.proofTier === "fulfillment-verified")).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("orders entitlement truth and refuses stale active events after cancel, refund, and dispute", async () => {
    const { storage, service } = await harness();
    try {
      const scope = { workspaceId, companyId };
      await service.ingestStripe(saas({ id: "evt_active_100", type: "customer.subscription.updated", created: 100, observedStatus: "active", providerStatus: "active" }), scope);
      expect((await service.ingestStripe(saas({ id: "evt_same_second_past_due", type: "customer.subscription.updated", created: 100, observedStatus: "past_due", providerStatus: "past_due", period: false }), scope)).entitlementApplied).toBe(true);
      expect(await storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "past-due" });
      await service.ingestStripe(saas({ id: "evt_cancel_300", type: "customer.subscription.deleted", created: 300, providerStatus: "canceled", period: false }), scope);
      expect((await service.ingestStripe(saas({ id: "evt_stale_active_200", type: "customer.subscription.updated", created: 200, observedStatus: "active", providerStatus: "active" }), scope)).entitlementApplied).toBe(false);
      expect(await storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "canceled", providerEventId: "stripe:live:evt_cancel_300" });

      await service.ingestStripe(saas({ id: "evt_refund_400", type: "charge.refunded", created: 400, providerStatus: "succeeded", amount: 49_900, period: false, object: "charge", objectId: "ch_saas" }), scope);
      expect(await storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "refunded" });
      await service.ingestStripe(saas({ id: "evt_dispute_500", type: "charge.dispute.created", created: 500, providerStatus: "needs_response", amount: 49_900, period: false, object: "dispute", objectId: "dp_saas" }), scope);
      expect(await storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "disputed" });
      expect(normalizeStripeEvent(stripeEvent({ id: "evt_dispute_updated_won", type: "charge.dispute.updated", created: 501, objectId: "dp_saas", object: "dispute", kind: "saas_entitlement", status: "won", amount: 49_900 }))).toBeNull();
      await service.ingestStripe(saas({ id: "evt_dispute_won_600", type: "charge.dispute.closed", created: 600, observedStatus: "won", providerStatus: "won", amount: 49_900, period: true, object: "dispute", objectId: "dp_saas" }), scope);
      expect(await storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "active", providerEventId: "stripe:live:evt_dispute_won_600" });
      expect((await service.ingestStripe(saas({ id: "evt_refund_400", type: "charge.refunded", created: 400, providerStatus: "succeeded", amount: 49_900, period: false, object: "charge", objectId: "ch_saas" }), scope)).created).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("rejects webhook metadata and authoritative binding from another company", async () => {
    const { storage, service } = await harness();
    try {
      const raw = stripeEvent({ id: "evt_cross_company", type: "charge.succeeded", created: 10, objectId: "ch_cross", object: "charge", kind: "operated_company_payment", amount: 1_200 });
      const observed = normalizeStripeEvent(raw)!;
      expect(reconcileStripeEvent(observed, { ...observed.reconciliation, authoritative: true, retrievedAt: AT, status: "succeeded", amount: 1_200, currency: "usd", livemode: true, binding: { workspaceId, companyId: otherCompanyId, kind: observed.namespace }, relatedPaymentObjectId: "ch_cross" })).toBeNull();
      await expect(service.ingestStripe(payment({ id: "evt_bound_alpha", created: 20, charge: "ch_alpha" }), { workspaceId, companyId: otherCompanyId })).rejects.toThrow(/binding/);
      expect(await storage.listEvents(workspaceId, otherCompanyId)).toEqual([]);
    } finally {
      await storage.close();
    }
  });

  it("canonicalizes PaymentIntent and Charge success plus Charge reversal onto one operated payment grant", async () => {
    const { storage, service } = await harness();
    const metadata = { opspot_kind: "operated_company_payment", opspot_workspace_id: workspaceId, opspot_company_id: companyId };
    const raw = (id: string, type: string, object: Record<string, unknown>): StripeEvent => ({ id, type, created: 50, data: { object: object as StripeEvent["data"]["object"] } });
    const piRaw = raw("evt_pi_success", "payment_intent.succeeded", { id: "pi_canonical", object: "payment_intent", status: "succeeded", amount: 12_000, amount_received: 12_000, currency: "usd", livemode: true, metadata });
    const chargeRaw = raw("evt_charge_success", "charge.succeeded", { id: "ch_canonical", object: "charge", status: "succeeded", amount: 12_000, currency: "usd", livemode: true, payment_intent: "pi_canonical", metadata });
    const refundRaw = raw("evt_charge_refund", "charge.refunded", { id: "ch_canonical", object: "charge", status: "succeeded", amount: 12_000, amount_refunded: 12_000, currency: "usd", livemode: true, payment_intent: "pi_canonical", metadata });
    const reconcile = (event: StripeEvent) => {
      const observed = normalizeStripeEvent(event)!;
      return reconcileStripeEvent(observed, { ...observed.reconciliation, authoritative: true, retrievedAt: AT, status: "succeeded", amount: 12_000, currency: "usd", livemode: true, binding: { workspaceId, companyId, kind: "operated_company_payment" }, relatedPaymentObjectId: "pi_canonical" })! as OperatedPayment;
    };
    try {
      const pi = reconcile(piRaw);
      const charge = reconcile(chargeRaw);
      expect(pi.relatedPaymentObjectId).toBe("pi_canonical");
      expect(charge.relatedPaymentObjectId).toBe("pi_canonical");
      expect(await service.grantDigitalAccess(pi, { workspaceId, companyId }, access)).toMatchObject({ created: true });
      expect(await service.grantDigitalAccess(charge, { workspaceId, companyId }, access)).toMatchObject({ created: false });
      expect((await storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "digital-access-granted")).toHaveLength(1);
      expect(await service.ingestStripe(reconcile(refundRaw), { workspaceId, companyId })).toMatchObject({ revokedGrants: 1 });
    } finally {
      await storage.close();
    }
  });

  it("revokes on an open dispute, restores only on authoritative won-close, and never restores a refunded payment", async () => {
    const { storage, service } = await harness();
    const scope = { workspaceId, companyId };
    const paid = payment({ id: "evt_dispute_payment", created: 700, charge: "pi_dispute" }) as OperatedPayment;
    const disputedRaw = stripeEvent({ id: "evt_dispute_open", type: "charge.dispute.created", created: 710, objectId: "dp_operated", object: "dispute", kind: "operated_company_payment", status: "needs_response", amount: 12_000 });
    disputedRaw.data.object.payment_intent = "pi_dispute";
    const wonUpdatedRaw = stripeEvent({ id: "evt_dispute_won_updated", type: "charge.dispute.updated", created: 720, objectId: "dp_operated", object: "dispute", kind: "operated_company_payment", status: "won", amount: 12_000 });
    wonUpdatedRaw.data.object.payment_intent = "pi_dispute";
    const wonClosedRaw = stripeEvent({ id: "evt_dispute_won_closed", type: "charge.dispute.closed", created: 730, objectId: "dp_operated", object: "dispute", kind: "operated_company_payment", status: "won", amount: 12_000 });
    wonClosedRaw.data.object.payment_intent = "pi_dispute";
    const reconcile = (raw: StripeEvent, status: string) => {
      const observed = normalizeStripeEvent(raw)!;
      return reconcileStripeEvent(observed, { ...observed.reconciliation, authoritative: true, retrievedAt: AT, status, amount: 12_000, currency: "usd", livemode: true, binding: { workspaceId, companyId, kind: "operated_company_payment" }, relatedPaymentObjectId: "pi_dispute" })! as OperatedPayment;
    };
    try {
      await service.grantDigitalAccess(paid, scope, access);
      const redemption = await service.redeemDigitalAccess(scope, "pi_dispute", "live", access);
      if (!redemption.delivered) throw new Error("expected first access delivery");
      const secret = redemption.accessSecret;
      expect(await service.ingestStripe(reconcile(disputedRaw, "needs_response"), scope)).toMatchObject({ revokedGrants: 1, restoredGrants: 0 });
      expect(await service.verifyDigitalAccess(scope, secret)).toBe(false);
      expect(normalizeStripeEvent(wonUpdatedRaw)).toBeNull();
      expect(await service.ingestStripe(reconcile(wonClosedRaw, "won"), scope)).toMatchObject({ revokedGrants: 0, restoredGrants: 1 });
      expect(await service.verifyDigitalAccess(scope, secret)).toBe(true);

      await service.ingestStripe(payment({ id: "evt_dispute_refund", type: "charge.refunded", created: 740, charge: "pi_dispute" }), scope);
      const secondWon = reconcile({ ...wonClosedRaw, id: "evt_dispute_won_after_refund", created: 750 }, "won");
      expect(await service.ingestStripe(secondWon, scope)).toMatchObject({ restoredGrants: 0 });
      expect(await service.verifyDigitalAccess(scope, secret)).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("reconciles metadata-free refund and dispute webhooks through authoritative related objects", async () => {
    const metadata = { opspot_kind: "operated_company_payment", opspot_workspace_id: workspaceId, opspot_company_id: companyId };
    const saasMetadata = { opspot_kind: "saas_entitlement", opspot_workspace_id: workspaceId, opspot_company_id: companyId };
    const objects: Record<string, Record<string, unknown>> = {
      "disputes/dp_unbound": { id: "dp_unbound", object: "dispute", status: "needs_response", amount: 12_000, currency: "usd", livemode: true, charge: "ch_operated" },
      "charges/ch_operated": { id: "ch_operated", object: "charge", status: "succeeded", amount: 12_000, currency: "usd", livemode: true, metadata },
      "charges/ch_saas_refund": { id: "ch_saas_refund", object: "charge", status: "succeeded", amount: 49_900, amount_refunded: 49_900, currency: "usd", livemode: true, payment_intent: "pi_saas", invoice: "in_saas" },
      "payment_intents/pi_saas": { id: "pi_saas", object: "payment_intent", status: "succeeded", amount: 49_900, amount_received: 49_900, currency: "usd", livemode: true, metadata: saasMetadata, invoice: "in_saas" },
      "invoices/in_saas": { id: "in_saas", object: "invoice", status: "paid", amount_paid: 49_900, currency: "usd", livemode: true, parent: { subscription_details: { metadata: saasMetadata } }, lines: { data: [{ type: "subscription", period: { start: 1_753_056_000, end: 1_755_734_400 } }] } }
    };
    const adapter = new StripeAdapter("sk_test", async (url) => {
      const key = String(url).replace("https://api.stripe.com/v1/", "");
      const object = objects[key];
      return object ? Response.json(object) : Response.json({ error: "missing" }, { status: 404 });
    });
    const disputeRaw: StripeEvent = { id: "evt_unbound_dispute", type: "charge.dispute.created", created: 600, data: { object: { id: "dp_unbound", object: "dispute", status: "needs_response", amount: 12_000, currency: "usd", livemode: true, charge: "ch_operated" } } };
    await expect(adapter.reconcileWebhook(disputeRaw, AT)).resolves.toMatchObject({ namespace: "operated_company_payment", observedKind: "dispute", providerBinding: { workspaceId, companyId, kind: "operated_company_payment" }, relatedPaymentObjectId: "ch_operated" });

    const refundRaw: StripeEvent = { id: "evt_unbound_saas_refund", type: "charge.refunded", created: 700, data: { object: { id: "ch_saas_refund", object: "charge", status: "succeeded", amount: 49_900, amount_refunded: 49_900, currency: "usd", livemode: true, payment_intent: "pi_saas", invoice: "in_saas" } } };
    await expect(adapter.reconcileWebhook(refundRaw, AT)).resolves.toMatchObject({ namespace: "saas_entitlement", observedEntitlement: "refunded", providerBinding: { workspaceId, companyId, kind: "saas_entitlement" }, authoritativePeriodStart: "2025-07-21T00:00:00.000Z", authoritativePeriodEnd: "2025-08-21T00:00:00.000Z" });
  });

  it("keeps payment and provisioning separate from fulfillment, reveals no secret before verified redemption, and revokes on refund", async () => {
    const { storage, service } = await harness();
    try {
      const scope = { workspaceId, companyId };
      const paid = payment({ id: "evt_live_payment", created: 10, charge: "ch_paid" });
      expect(await service.ingestStripe(paid, scope)).toMatchObject({ proofTier: "revenue-verified" });
      expect((await storage.listEvidence(workspaceId, companyId)).some((item) => item.proofTier === "fulfillment-verified")).toBe(false);

      const grants = await Promise.all([
        service.grantDigitalAccess(paid as OperatedPayment, scope, access),
        service.grantDigitalAccess(paid as OperatedPayment, scope, access)
      ]);
      expect(grants.filter((grant) => grant.created)).toHaveLength(1);
      expect((await storage.listEvidence(workspaceId, companyId)).some((item) => item.proofTier === "fulfillment-verified")).toBe(false);
      const redemptions = await Promise.all([
        service.redeemDigitalAccess(scope, "ch_paid", "live", access),
        service.redeemDigitalAccess(scope, "ch_paid", "live", access)
      ]);
      expect(redemptions.filter((item) => item.delivered)).toHaveLength(1);
      const redemption = redemptions.find((item) => item.delivered);
      if (!redemption?.delivered) throw new Error("expected one atomic access delivery");
      const secret = redemption.accessSecret;
      expect(redemption).toMatchObject({ created: true, delivered: true, proofTier: "fulfillment-verified" });
      expect(await service.verifyDigitalAccess(scope, secret)).toBe(true);
      const durable = JSON.stringify([await storage.listEvents(workspaceId, companyId), await storage.listEvidence(workspaceId, companyId), await storage.listReceipts(workspaceId, companyId)]);
      expect(durable).not.toContain(secret);
      expect(durable).toContain(createHashForTest(secret));
      const replay = await service.redeemDigitalAccess(scope, "ch_paid", "live", access);
      expect(replay).toMatchObject({ created: false, delivered: false, alreadyDelivered: true });
      expect(replay).not.toHaveProperty("accessSecret");

      const refund = payment({ id: "evt_live_refund", type: "charge.refunded", created: 20, charge: "ch_paid" });
      expect(await service.ingestStripe(refund, scope)).toMatchObject({ proofTier: "externally-live", revokedGrants: 1 });
      expect(await service.verifyDigitalAccess(scope, secret)).toBe(false);
      expect((await service.ingestStripe(refund, scope)).revokedGrants).toBe(0);
      expect((await storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "digital-access-revoked")).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("blocks access when a refund arrives before the older payment event", async () => {
    const { storage, service } = await harness();
    try {
      const scope = { workspaceId, companyId };
      await service.ingestStripe(payment({ id: "evt_refund_first", type: "charge.refunded", created: 40, charge: "ch_out_of_order" }), scope);
      const paid = payment({ id: "evt_payment_late", created: 30, charge: "ch_out_of_order" });
      await service.ingestStripe(paid, scope);
      await expect(service.grantDigitalAccess(paid as OperatedPayment, scope, access)).rejects.toThrow(/refunded or disputed/);
    } finally {
      await storage.close();
    }
  });

  it("coalesces refund created/updated transitions while preserving distinct partial-refund evidence and one revocation", async () => {
    const { storage, service } = await harness();
    const scope = { workspaceId, companyId };
    const paid = payment({ id: "evt_partial_paid", created: 10, charge: "pi_partial" }) as OperatedPayment;
    const metadata = { opspot_kind: "operated_company_payment", opspot_workspace_id: workspaceId, opspot_company_id: companyId };
    const refund = (eventId: string, type: "refund.created" | "refund.updated", created: number, refundId: string, amount: number): OperatedPayment => {
      const raw: StripeEvent = { id: eventId, type, created, data: { object: { id: refundId, object: "refund", status: "succeeded", amount, currency: "usd", livemode: true, payment_intent: "pi_partial", metadata } } };
      const observed = normalizeStripeEvent(raw)!;
      return reconcileStripeEvent(observed, { ...observed.reconciliation, authoritative: true, retrievedAt: AT, status: "succeeded", amount, currency: "usd", livemode: true, binding: { workspaceId, companyId, kind: "operated_company_payment" }, relatedPaymentObjectId: "pi_partial" })! as OperatedPayment;
    };
    try {
      await service.grantDigitalAccess(paid, scope, access);
      const redemption = await service.redeemDigitalAccess(scope, "pi_partial", "live", access);
      if (!redemption.delivered) throw new Error("expected access delivery");
      expect(await service.ingestStripe(refund("evt_refund_one_created", "refund.created", 20, "re_partial_one", 3_000), scope)).toMatchObject({ revokedGrants: 1 });
      expect(await service.ingestStripe(refund("evt_refund_one_updated", "refund.updated", 21, "re_partial_one", 3_000), scope)).toMatchObject({ revokedGrants: 0 });
      expect(await service.ingestStripe(refund("evt_refund_two_created", "refund.created", 22, "re_partial_two", 2_000), scope)).toMatchObject({ revokedGrants: 0 });
      expect((await storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "digital-access-revoked")).toHaveLength(1);
      const refunds = (await storage.listEvidence(workspaceId, companyId)).filter((item) => item.type === "authoritative-payment-refunded");
      expect(refunds).toHaveLength(2);
      expect(refunds.map((item) => item.metadata.transitionObjectId).sort()).toEqual(["re_partial_one", "re_partial_two"]);
    } finally {
      await storage.close();
    }
  });

  it("reconciles sent email, durably suppresses bounce, complaint, and unsubscribe, and never promotes reply to payment", async () => {
    const { storage, service } = await harness();
    try {
      const scope = { workspaceId, companyId };
      const adapter = new ResendEmailAdapter("re_test", async (url, init) => {
        expect(String(url)).toBe("https://api.resend.com/emails/email_bounce");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test");
        return Response.json({ object: "email", id: "email_bounce", to: ["bounce@example.test"], created_at: AT, last_event: "bounced", tags: [{ name: "opspot_workspace", value: workspaceId }, { name: "opspot_company", value: companyId }], subject: "not persisted by reconciliation" });
      });
      const bounceReconciliation = await adapter.retrieve("email_bounce", scope, AT);
      const bounce = signedResend({ type: "email.bounced", created_at: AT, data: { email_id: "email_bounce", to: ["bounce@example.test"] } });
      expect(await service.ingestEmail(bounce, scope, bounceReconciliation)).toMatchObject({ created: true, suppressedRecipients: ["bounce@example.test"] });
      expect(await service.ingestEmail(bounce, scope, bounceReconciliation)).toMatchObject({ created: false });

      const complaint = signedResend({ type: "email.complained", created_at: AT, data: { email_id: "email_complaint", to: ["complaint@example.test"] } });
      const complaintReconciliation: ReconciledResendEmail = { ...bounceReconciliation, emailId: "email_complaint", recipients: ["complaint@example.test"], lastEvent: "complained" };
      await service.ingestEmail(complaint, scope, complaintReconciliation);
      const unsubscribe = signedResend({ type: "contact.updated", created_at: AT, data: { id: "contact_1", email: "unsubscribe@example.test", unsubscribed: true } });
      await service.ingestEmail(unsubscribe, scope);
      const threadRef = "<opspot.thread-proof@thread.opspot.invalid>";
      const received: ReconciledResendReceivedEmail = { provider: "resend", verification: "provider-retrieved", emailId: "email_reply", sender: "sender@example.test", recipients: ["inbox@example.test"], inReplyTo: [threadRef], references: [], retrievedAt: AT };
      await storage.appendEvent({ workspaceId, companyId, id: "audit_outbound_reply_binding", eventType: "golden-execution-completed", actor: "golden-company-worker", entityType: "task", entityId: "task_outbound", payload: { provider: "resend", providerObjectId: "email_outbound", threadRef }, occurredAt: AT });
      const reply = signedResend({ type: "email.received", created_at: AT, data: { email_id: "email_reply", from: "sender@example.test", to: ["inbox@example.test"], message_id: "<received@example.test>" } });
      await service.ingestEmail(reply, scope, undefined, received);
      await expect(service.ingestEmail(signedResend({ type: "email.received", created_at: AT, data: { email_id: "email_unbound", from: "sender@example.test", to: ["inbox@example.test"], message_id: "<unbound@example.test>" } }), scope)).rejects.toThrow(/authoritative received-email reconciliation/);
      const cross = signedResend({ type: "email.received", created_at: AT, data: { email_id: "email_cross", from: "sender@example.test", to: ["inbox@example.test"], message_id: "<cross@example.test>" } });
      await expect(service.ingestEmail(cross, scope, undefined, { ...received, emailId: "email_cross", inReplyTo: ["<other@thread.opspot.invalid>"] })).rejects.toThrow(/does not reference/);

      expect(await service.listSuppressedRecipients(scope)).toEqual(["bounce@example.test", "complaint@example.test", "unsubscribe@example.test"]);
      const events = await storage.listEvents(workspaceId, companyId);
      expect(events.filter((event) => event.eventType === "email-recipient-suppressed")).toHaveLength(3);
      expect(events.some((event) => event.eventType.includes("payment"))).toBe(false);
      expect((await storage.listEvidence(workspaceId, companyId)).some((item) => item.proofTier === "revenue-verified" || item.proofTier === "fulfillment-verified")).toBe(false);
      await expect(service.ingestEmail(bounce, { workspaceId, companyId: otherCompanyId }, { ...bounceReconciliation, sourceBinding: { workspaceId, companyId: otherCompanyId } })).rejects.toThrow(/bound/);
    } finally {
      await storage.close();
    }
  });
});

type OperatedPayment = ReconciledStripeEvent<OperatedCompanyPaymentEvent>;

function createHashForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
