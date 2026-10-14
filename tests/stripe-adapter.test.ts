import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StripeAdapter, isLiveSettledStripePayment, normalizeStripeEvent, reconcileStripeEvent, stripeCheckoutRequest, stripeOperatedCompanyCheckoutRequest, stripePortalRequest, verifyStripeSignature } from "../packages/adapters/src/stripe.js";

const operatedMetadata = { opspot_kind: "operated_company_payment", opspot_workspace_id: "ws_2", opspot_company_id: "company_2" };

describe("Stripe adapter", () => {
  it("keeps credentials out of hosted Checkout and Portal descriptors", async () => {
    const checkout = stripeCheckoutRequest({ priceId: "price_1", successUrl: "https://app.example/success", cancelUrl: "https://app.example/cancel", workspaceId: "ws_1", companyId: "company_1" });
    expect(checkout.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(checkout.body).toContain("metadata%5Bopspot_kind%5D=saas_entitlement");
    expect(checkout.body).toContain("subscription_data%5Btrial_period_days%5D=7");
    expect(stripeCheckoutRequest({ priceId: "price_1", successUrl: "https://app.example/success", cancelUrl: "https://app.example/cancel", workspaceId: "ws_1", companyId: "company_1", trialBypass: true }).body).not.toContain("trial_period_days");
    const portal = stripePortalRequest({ customerId: "cus_1", returnUrl: "https://app.example" });
    expect(portal.body).toContain("customer=cus_1");
    expect(JSON.stringify([checkout, portal])).not.toMatch(/sk_test|authorization|bearer/i);
    let authorization = "";
    const adapter = new StripeAdapter("sk_test_x", async (_url, init) => { authorization = new Headers(init?.headers).get("authorization") ?? ""; return Response.json({ id: "cs_1" }); });
    await expect(adapter.post<{ id: string }>(checkout)).resolves.toEqual({ id: "cs_1" });
    expect(authorization).toBe("Bearer sk_test_x");
  });

  it("creates a positive, bound one-time operated-company Checkout request", () => {
    const valid = { offerId: "offer_1", offerName: "Launch Sprint", amount: 49900, currency: "USD", successUrl: "https://app.example/success", cancelUrl: "https://app.example/cancel", workspaceId: "ws_1", companyId: "company_1" };
    const checkout = stripeOperatedCompanyCheckoutRequest(valid);
    const form = new URLSearchParams(checkout.body);
    expect(form.get("mode")).toBe("payment");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("49900");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Launch Sprint");
    for (const [key, value] of Object.entries({ opspot_workspace_id: "ws_1", opspot_company_id: "company_1", opspot_offer_id: "offer_1", opspot_amount: "49900", opspot_currency: "usd" })) {
      expect(form.get(`metadata[${key}]`)).toBe(value);
      expect(form.get(`payment_intent_data[metadata][${key}]`)).toBe(value);
    }
    expect(() => stripeOperatedCompanyCheckoutRequest({ ...valid, amount: 0 })).toThrow(/positive USD amount/);
    expect(() => stripeOperatedCompanyCheckoutRequest({ ...valid, currency: "btc" })).toThrow(/positive USD amount/);
    expect(() => stripeOperatedCompanyCheckoutRequest({ ...valid, companyId: "company/bad" })).toThrow(/safe bounded/);
    expect(() => stripeOperatedCompanyCheckoutRequest({ ...valid, successUrl: "http://app.example/success" })).toThrow(/HTTPS/);
    expect(() => stripeOperatedCompanyCheckoutRequest({ ...valid, offerName: "x".repeat(101) })).toThrow(/bounded/);
  });

  it("retrieves only supported authoritative objects with the same JSON and status checks", async () => {
    let url = "";
    const adapter = new StripeAdapter("sk_test_x", async (requestUrl) => { url = String(requestUrl); return Response.json({ id: "in_1" }); });
    await expect(adapter.get<{ id: string }>({ target: "invoice", objectId: "in_1" })).resolves.toEqual({ id: "in_1" });
    expect(url).toBe("https://api.stripe.com/v1/invoices/in_1");
    const rejected = new StripeAdapter("sk_test_x", async () => Response.json({ error: "missing" }, { status: 404 }));
    await expect(rejected.get({ target: "invoice", objectId: "in_missing" })).rejects.toThrow("Stripe API error 404");
  });

  it("validates the untouched signed body and rejects stale or altered deliveries", () => {
    const body = '{"id":"evt_1"}';
    const signature = `t=1000,v1=${createHmac("sha256", "whsec_test").update(`1000.${body}`).digest("hex")}`;
    expect(verifyStripeSignature(body, signature, "whsec_test", 1100)).toBe(true);
    expect(verifyStripeSignature(`${body} `, signature, "whsec_test", 1100)).toBe(false);
    expect(verifyStripeSignature(body, signature, "whsec_test", 1301, 300)).toBe(false);
  });

  it("merges nested invoice metadata while explicit top-level opspot keys win", () => {
    const saas = normalizeStripeEvent({ id: "evt_saas", type: "invoice.paid", created: 1_700_000_000, data: { object: { id: "in_1", object: "invoice", metadata: { opspot_workspace_id: "ws_top" }, parent: { subscription_details: { metadata: { opspot_kind: "saas_entitlement", opspot_workspace_id: "ws_parent", opspot_company_id: "company_1" } } }, amount_paid: 49900, currency: "usd" } } });
    expect(saas).toMatchObject({ namespace: "saas_entitlement", observedEntitlement: "active", verification: "observed-unverified", dedupeKey: "stripe:event:evt_saas", workspaceId: "ws_top", reconciliation: { target: "invoice", objectId: "in_1" } });
    expect(JSON.stringify(saas)).not.toMatch(/sk_|authorization|bearer/i);
    expect(reconcileStripeEvent(saas!, { target: "invoice", objectId: "in_1", authoritative: false, retrievedAt: "2026-07-20T18:00:00.000Z", status: "paid", amount: 49900, currency: "usd", livemode: true })).toBeNull();
    expect(reconcileStripeEvent(saas!, { target: "invoice", objectId: "in_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "paid", amount: 49900, currency: "usd", livemode: false })).toMatchObject({ providerMode: "test" });
    expect(reconcileStripeEvent(saas!, { target: "invoice", objectId: "in_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "paid", amount: 49901, currency: "usd", livemode: true })).toBeNull();
    expect(reconcileStripeEvent(saas!, { target: "invoice", objectId: "in_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "open", amount: 49900, currency: "usd", livemode: true })).toBeNull();
    expect(reconcileStripeEvent(saas!, { target: "invoice", objectId: "in_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "paid", amount: 49900, currency: "usd", livemode: true })).toMatchObject({ verification: "authoritatively-reconciled", providerMode: "live", authoritativeStatus: "paid" });
  });

  it("represents trial and unpaid entitlement observations without treating either as paid", () => {
    const metadata = { opspot_kind: "saas_entitlement", opspot_workspace_id: "ws_1", opspot_company_id: "company_1" };
    expect(normalizeStripeEvent({ id: "evt_trial", type: "customer.subscription.created", created: 20, data: { object: { id: "sub_1", object: "subscription", status: "trialing", metadata } } })).toMatchObject({ observedEntitlement: "trialing", verification: "observed-unverified" });
    expect(normalizeStripeEvent({ id: "evt_unpaid", type: "customer.subscription.updated", created: 30, data: { object: { id: "sub_1", object: "subscription", status: "unpaid", metadata } } })).toMatchObject({ observedEntitlement: "unpaid", verification: "observed-unverified" });
  });

  it("accepts invoice subscription_details metadata when it is not parented", () => {
    expect(normalizeStripeEvent({ id: "evt_invoice", type: "invoice.paid", created: 20, data: { object: { id: "in_2", object: "invoice", metadata: {}, subscription_details: { metadata: { opspot_kind: "saas_entitlement", opspot_workspace_id: "ws_2" } }, amount_paid: 0, currency: "usd" } } })).toMatchObject({ namespace: "saas_entitlement", workspaceId: "ws_2", observedEntitlement: "trialing", amount: 0, currency: "usd" });
  });

  it("never treats a zero-dollar trial or test reconciliation as live paid proof", () => {
    const trial = normalizeStripeEvent({ id: "evt_trial_invoice", type: "invoice.paid", created: 20, data: { object: { id: "in_trial", object: "invoice", metadata: { opspot_kind: "saas_entitlement", opspot_workspace_id: "ws_1" }, amount_paid: 0, currency: "usd" } } })!;
    const result = { target: "invoice", objectId: "in_trial", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "paid", amount: 0, currency: "usd", livemode: true } as const;
    expect(isLiveSettledStripePayment(reconcileStripeEvent(trial, result)!)).toBe(false);
    const paid = normalizeStripeEvent({ id: "evt_paid_invoice", type: "invoice.paid", created: 20, data: { object: { id: "in_paid", object: "invoice", metadata: { opspot_kind: "saas_entitlement", opspot_workspace_id: "ws_1" }, amount_paid: 49900, currency: "usd" } } })!;
    expect(isLiveSettledStripePayment(reconcileStripeEvent(paid, { ...result, objectId: "in_paid", amount: 49900, livemode: false })!)).toBe(false);
    expect(isLiveSettledStripePayment(reconcileStripeEvent(paid, { ...result, objectId: "in_paid", amount: 49900 })!)).toBe(true);
  });

  it("never treats refunds or disputes as live settled payment proof", () => {
    const refund = normalizeStripeEvent({ id: "evt_refund", type: "charge.refunded", created: 40, data: { object: { id: "ch_refund", object: "charge", metadata: operatedMetadata, amount_refunded: 1200, currency: "usd" } } })!;
    const reconciledRefund = reconcileStripeEvent(refund, { target: "charge", objectId: "ch_refund", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "succeeded", amount: 1200, currency: "usd", livemode: true })!;
    expect(isLiveSettledStripePayment(reconciledRefund)).toBe(false);
    const dispute = normalizeStripeEvent({ id: "evt_dispute", type: "charge.dispute.created", created: 40, data: { object: { id: "dp_1", object: "dispute", metadata: operatedMetadata, amount: 1200, currency: "usd" } } })!;
    expect(reconcileStripeEvent(dispute, { target: "dispute", objectId: "dp_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "won", amount: 1200, currency: "usd", livemode: true })).toBeNull();
    const reconciledDispute = reconcileStripeEvent(dispute, { target: "dispute", objectId: "dp_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "needs_response", amount: 1200, currency: "usd", livemode: true })!;
    expect(isLiveSettledStripePayment(reconciledDispute)).toBe(false);
  });

  it("normalizes refunds and disputes separately and preserves replay and ordering fields", () => {
    const refund = normalizeStripeEvent({ id: "evt_refund", type: "charge.refunded", created: 40, data: { object: { id: "ch_1", object: "charge", metadata: operatedMetadata, amount_refunded: 1200, currency: "usd" } } });
    const payment = normalizeStripeEvent({ id: "evt_payment", type: "charge.succeeded", created: 30, data: { object: { id: "ch_1", object: "charge", metadata: operatedMetadata, amount: 1200, currency: "usd" } } });
    const dispute = normalizeStripeEvent({ id: "evt_dispute", type: "charge.dispute.created", created: 30, data: { object: { id: "dp_1", object: "dispute", metadata: operatedMetadata, amount: 1200, currency: "usd" } } });
    expect(refund).toMatchObject({ workspaceId: "ws_2", companyId: "company_2", observedKind: "refund", dedupeKey: "stripe:event:evt_refund", orderingKey: "stripe:object:charge:ch_1", providerCreatedAt: 40 });
    expect(dispute).toMatchObject({ observedKind: "dispute", dedupeKey: "stripe:event:evt_dispute", orderingKey: "stripe:object:dispute:dp_1", providerCreatedAt: 30 });
    expect(payment?.orderingKey).toBe(refund?.orderingKey);
    expect([refund!, payment!].sort((a, b) => a.providerCreatedAt - b.providerCreatedAt).map((event) => event.providerEventId)).toEqual(["evt_payment", "evt_refund"]);
    expect(normalizeStripeEvent({ id: "evt_refund", type: "charge.refunded", created: 40, data: { object: { id: "ch_1", object: "charge", metadata: operatedMetadata, amount_refunded: 1200, currency: "usd" } } })).toEqual(refund);
  });

  it("rejects operated-payment events without exact namespace and tenant binding", () => {
    const event = (metadata: Record<string, string>) => normalizeStripeEvent({ id: "evt_payment", type: "charge.succeeded", created: 30, data: { object: { id: "ch_1", object: "charge", metadata, amount: 1200, currency: "usd" } } });
    expect(event({ opspot_company_id: "company_2" })).toBeNull();
    expect(event({ ...operatedMetadata, opspot_kind: "saas_entitlement" })).toBeNull();
    expect(event({ opspot_kind: "operated_company_payment", opspot_company_id: "company_2" })).toBeNull();
  });

  it("fails closed when an operated payment's live amount, currency, or status disagrees", () => {
    const payment = normalizeStripeEvent({ id: "evt_payment", type: "charge.succeeded", created: 30, data: { object: { id: "ch_1", object: "charge", metadata: operatedMetadata, amount: 1200, currency: "usd" } } });
    expect(reconcileStripeEvent(payment!, { target: "charge", objectId: "ch_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "succeeded", amount: 1200, currency: "eur", livemode: true })).toBeNull();
    expect(reconcileStripeEvent(payment!, { target: "charge", objectId: "ch_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "pending", amount: 1200, currency: "usd", livemode: true })).toBeNull();
    const reconciled = reconcileStripeEvent(payment!, { target: "charge", objectId: "ch_1", authoritative: true, retrievedAt: "2026-07-20T18:00:00.000Z", status: "succeeded", amount: 1200, currency: "usd", livemode: true });
    expect(reconciled).toMatchObject({ verification: "authoritatively-reconciled" });
    expect(isLiveSettledStripePayment(reconciled!)).toBe(true);
  });
});
