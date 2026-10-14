import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ResendEmailAdapter, StripeAdapter } from "@opspot/adapters";
import { EngineStorage, SqliteKernelStorage } from "@opspot/storage";
import { handleProviderRequest, type ProviderAuthDependencies, type ProviderRouteDependencies } from "../apps/control/lib/provider-route.js";

const appOrigin = "https://gtm.example.test";
const workspaceId = "workspace_routes";
const otherWorkspaceId = "workspace_other";
const companyId = "venture_routes";
const otherCompanyId = "venture_other";
const subject = "123e4567-e89b-42d3-a456-426614174000";

async function harness() {
  const engine = new EngineStorage(":memory:");
  const storage = new SqliteKernelStorage(engine);
  await storage.ensureWorkspace(workspaceId);
  await storage.ensureWorkspace(otherWorkspaceId);
  await storage.createCompany({ workspaceId, companyId, slug: "routes", name: "Routes", owner: "founder", owningRepo: "synthetic/routes", lifecycleState: "candidate", state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await storage.createCompany({ workspaceId: otherWorkspaceId, companyId: otherCompanyId, slug: "other", name: "Other", owner: "founder", owningRepo: "synthetic/other", lifecycleState: "candidate", state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const auth: ProviderAuthDependencies = {
    appOrigin,
    createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: subject, role: "authenticated" } }, error: null }) } }) as never,
    resolveWorkspace: async () => ({ authSubject: subject, workspaceId, role: "owner", createdAt: new Date().toISOString() }),
    consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 })
  };
  return { engine, storage, auth };
}

function ownerRequest(body: unknown, origin = appOrigin) {
  return new Request(`${appOrigin}/api/providers/test/action`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

function stripeWebhookRequest(event: Record<string, unknown>, secret: string, valid = true): Request {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return new Request(`${appOrigin}/api/providers/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${valid ? signature : "0".repeat(64)}` }, body: raw });
}

function resendWebhookRequest(payload: Record<string, unknown>, secret: string, valid = true): Request {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = "msg_route_bounce";
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return new Request(`${appOrigin}/api/providers/resend/webhook`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${valid ? signature : Buffer.alloc(32).toString("base64")}` }, body: raw });
}

function genericWebhookRequest(payload: Record<string, unknown>, signer: string, secret: string, valid = true): Request {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return new Request(`${appOrigin}/api/providers/generic/webhook`, { method: "POST", headers: { "x-opspot-signer": signer, "x-opspot-timestamp": String(timestamp), "x-opspot-signature": valid ? signature : "0".repeat(64) }, body: raw });
}

describe("production provider routes", () => {
  it("derives the checkout tenant from owner claims, fixes price/mode server-side, and rejects cross-tenant company IDs", async () => {
    const context = await harness();
    const calls: Array<{ url: string; body: string; idempotency: string | null }> = [];
    const stripe = new StripeAdapter("sk_test_route", async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? ""), idempotency: new Headers(init?.headers).get("idempotency-key") });
      return Response.json({ id: "cs_test_routes", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/routes", livemode: false, created: 1_753_052_400 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, priceId: "price_routes", trialBypassSecret: "test-only-trial-bypass-secret-test-only", mode: "test" } };
    try {
      const response = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-1" }), "stripe", "checkout", dependencies);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, providerMode: "test", paymentVerified: false });
      expect(calls[0]?.body).toContain("line_items%5B0%5D%5Bprice%5D=price_routes");
      expect(calls[0]?.body).toContain(`metadata%5Bopspot_workspace_id%5D=${workspaceId}`);
      expect(new URLSearchParams(calls[0]?.body).get("success_url")).toBe(`${appOrigin}/?company=${companyId}&checkout=success`);
      expect(new URLSearchParams(calls[0]?.body).get("cancel_url")).toBe(`${appOrigin}/?company=${companyId}&checkout=cancelled`);
      expect(new URLSearchParams(calls[0]?.body).get("subscription_data[trial_period_days]")).toBe("7");
      expect(calls[0]?.idempotency).toMatch(/^opspot:/);

      expect((await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-2", priceId: "price_attacker" }), "stripe", "checkout", dependencies)).status).toBe(400);
      expect((await handleProviderRequest(ownerRequest({ companyId: otherCompanyId, idempotencyKey: "checkout-route-3" }), "stripe", "checkout", dependencies)).status).toBe(404);
      expect((await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-4" }, "https://evil.example"), "stripe", "checkout", dependencies)).status).toBe(403);
      expect((await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-bypass-missing" }), "stripe", "checkout-trial-bypass", dependencies)).status).toBe(403);
      const bypassRequest = () => new Request(`${appOrigin}/api/providers/stripe/checkout-trial-bypass`, { method: "POST", headers: { origin: appOrigin, "content-type": "application/json", "x-opspot-trial-bypass-authorization": "trial-bypass-secret-that-is-at-least-32-bytes" }, body: JSON.stringify({ companyId, idempotencyKey: "checkout-route-bypass-authorized" }) });
      expect((await handleProviderRequest(bypassRequest(), "stripe", "checkout-trial-bypass", dependencies)).status).toBe(200);
      expect((await handleProviderRequest(bypassRequest(), "stripe", "checkout-trial-bypass", dependencies)).status).toBe(200);
      expect(new URLSearchParams(calls[1]?.body).has("subscription_data[trial_period_days]")).toBe(false);
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "saas-trial-bypass-checkout-created")).toHaveLength(1);
      expect((await context.storage.listReceipts(workspaceId, companyId)).filter((receipt) => receipt.metadata.trialBypass === true && receipt.metadata.authorization === "dedicated-server-secret")).toHaveLength(1);
      expect(JSON.stringify(await context.storage.listReceipts(workspaceId, companyId))).not.toContain("trial-bypass-secret-that-is-at-least-32-bytes");
      expect(calls).toHaveLength(3);
    } finally {
      await context.storage.close();
    }
  });

  it("uses raw signed Stripe events, reconciles provider binding, persists replay once, and derives Portal customer server-side", async () => {
    const context = await harness();
    const secret = "whsec_stripe_routes";
    const providerObjects: Record<string, Record<string, unknown>> = {
      in_routes: { id: "in_routes", object: "invoice", status: "paid", amount_paid: 49_900, currency: "usd", livemode: false, customer: "cus_routes", subscription: "sub_routes", metadata: { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "saas_entitlement" }, lines: { data: [{ type: "subscription", period: { start: 1_752_537_600, end: 1_755_216_000 } }] } },
      in_forged: { id: "in_forged", object: "invoice", status: "paid", amount_paid: 49_900, currency: "usd", livemode: false, customer: "cus_other", metadata: { opspot_workspace_id: otherWorkspaceId, opspot_company_id: otherCompanyId, opspot_kind: "saas_entitlement" }, lines: { data: [{ type: "subscription", period: { start: 1_752_537_600, end: 1_755_216_000 } }] } }
    };
    const stripe = new StripeAdapter("sk_test_route", async (input) => {
      const url = String(input);
      if (url.includes("billing_portal/sessions")) return Response.json({ id: "bps_routes", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/routes" });
      const id = url.split("/").at(-1)!;
      return Response.json(providerObjects[id] ?? {}, { status: providerObjects[id] ? 200 : 404 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, webhookSecret: secret, mode: "test" } };
    const event = { id: "evt_routes", type: "invoice.paid", created: Math.floor(Date.now() / 1000), data: { object: { id: "in_routes", object: "invoice", amount_paid: 49_900, currency: "usd", metadata: { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "saas_entitlement" } } } };
    try {
      expect((await handleProviderRequest(stripeWebhookRequest(event, secret, false), "stripe", "webhook", dependencies)).status).toBe(401);
      const first = await handleProviderRequest(stripeWebhookRequest(event, secret), "stripe", "webhook", dependencies);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, created: true, proofTier: "fixture-verified" });
      expect(await (await handleProviderRequest(stripeWebhookRequest(event, secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ created: false });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((item) => item.eventType === "stripe-saas-entitlement-reconciled")).toHaveLength(1);

      const forged = { ...event, id: "evt_forged", data: { object: { ...(event.data.object as Record<string, unknown>), id: "in_forged" } } };
      expect((await handleProviderRequest(stripeWebhookRequest(forged, secret), "stripe", "webhook", dependencies)).status).toBe(202);
      expect(await context.storage.listEvents(otherWorkspaceId, otherCompanyId)).toEqual([]);

      dependencies.stripe!.priceId = "price_unused";
      const portal = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "portal-route-1" }), "stripe", "portal", dependencies);
      expect(portal.status).toBe(200);
      expect(await portal.json()).toMatchObject({ ok: true, providerMode: "test", url: "https://billing.stripe.com/p/session/routes" });
    } finally {
      await context.storage.close();
    }
  });

  it("records Checkout as non-entitlement proof, preserves the trial until authoritative subscription state, and handles same-second cancellation", async () => {
    const context = await harness();
    const secret = "whsec_stripe_normal_trial";
    const created = Math.floor(Date.now() / 1000);
    const metadata = { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "saas_entitlement" };
    const objects: Record<string, Record<string, unknown>> = {
      cs_normal: { id: "cs_normal", object: "checkout.session", status: "complete", livemode: false, customer: "cus_normal", metadata },
      sub_normal: { id: "sub_normal", object: "subscription", status: "trialing", livemode: false, customer: "cus_normal", metadata, current_period_start: created, current_period_end: created + 7 * 86_400 },
      sub_cancel: { id: "sub_cancel", object: "subscription", status: "canceled", livemode: false, customer: "cus_normal", metadata }
    };
    let portalReturnUrl: string | null = null;
    const stripe = new StripeAdapter("sk_test_normal", async (input, init) => {
      const url = String(input);
      if (url.endsWith("billing_portal/sessions")) {
        portalReturnUrl = new URLSearchParams(String(init?.body)).get("return_url");
        return Response.json({ id: "bps_normal", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/normal" });
      }
      const id = url.split("/").at(-1)!;
      return objects[id] ? Response.json(objects[id]) : Response.json({}, { status: 404 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, webhookSecret: secret, mode: "test" } };
    await context.storage.putEntitlement({ workspaceId, companyId, status: "active", plan: "test:bootstrap-trial", periodStart: new Date(created * 1000).toISOString(), periodEnd: new Date((created + 7 * 86_400) * 1000).toISOString(), modelCostCapCents: 1_000, providerEventId: "stripe:test:bootstrap-trial", providerOrder: 1, observedAt: new Date(created * 1000).toISOString() });
    const event = (id: string, type: string, objectId: string, object: string, status?: string) => ({ id, type, created, data: { object: { id: objectId, object, ...(status ? { status } : {}), metadata } } });
    try {
      expect(await (await handleProviderRequest(stripeWebhookRequest(event("evt_checkout_normal", "checkout.session.completed", "cs_normal", "checkout.session"), secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true });
      expect(await context.storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "active", providerEventId: "stripe:test:bootstrap-trial" });

      expect(await (await handleProviderRequest(stripeWebhookRequest(event("evt_trial_normal", "customer.subscription.created", "sub_normal", "subscription", "trialing"), secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true });
      expect(await context.storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "active", plan: "test:trial", providerEventId: "stripe:test:evt_trial_normal" });
      const portal = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "portal-normal-trial" }), "stripe", "portal", dependencies);
      expect(portal.status).toBe(200);
      expect(portalReturnUrl).toBe(`${appOrigin}/?company=${companyId}`);

      expect(await (await handleProviderRequest(stripeWebhookRequest(event("evt_cancel_normal", "customer.subscription.deleted", "sub_cancel", "subscription", "canceled"), secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true });
      expect(await context.storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "canceled", providerEventId: "stripe:test:evt_cancel_normal" });
    } finally {
      await context.storage.close();
    }
  });

  it("requires signed provider-tagged Resend events and persists suppression replay-safely", async () => {
    const context = await harness();
    const secret = `whsec_${Buffer.from("resend-route-secret").toString("base64")}`;
    const resend = new ResendEmailAdapter("re_test", async () => Response.json({ object: "email", id: "email_routes", to: ["owned@example.test"], created_at: new Date().toISOString(), last_event: "bounced", tags: [{ name: "opspot_workspace", value: workspaceId }, { name: "opspot_company", value: companyId }] }));
    const dependencies: ProviderRouteDependencies = { storage: context.storage, resend: { adapter: resend, webhookSecret: secret, connectorScope: { workspaceId, companyId }, ownedInboundRecipient: "owned@example.test" } };
    const payload = { type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "email_routes", to: ["owned@example.test"], tags: [{ name: "opspot_workspace", value: workspaceId }, { name: "opspot_company", value: companyId }] } };
    try {
      expect((await handleProviderRequest(resendWebhookRequest(payload, secret, false), "resend", "webhook", dependencies)).status).toBe(401);
      expect(await (await handleProviderRequest(resendWebhookRequest(payload, secret), "resend", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true, suppressed: 1 });
      expect(await (await handleProviderRequest(resendWebhookRequest(payload, secret), "resend", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: false, suppressed: 1 });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((item) => item.eventType === "email-recipient-suppressed")).toHaveLength(1);
    } finally {
      await context.storage.close();
    }
  });

  it("retrieves Resend inbound mail and binds an owned plus-address to the persisted exact thread reference", async () => {
    const context = await harness();
    const secret = `whsec_${Buffer.from("resend-inbound-route-secret").toString("base64")}`;
    const threadRef = `<opspot.${"a".repeat(48)}@thread.opspot.invalid>`;
    const inboundRecipient = `inbox+${"a".repeat(48)}@example.test`;
    const urls: string[] = [];
    const resend = new ResendEmailAdapter("re_test", async (url) => {
      urls.push(String(url));
      return Response.json({
        object: "email",
        id: "email_reply_routes",
        from: "sender@example.test",
        to: [inboundRecipient],
        headers: {}
      });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, resend: { adapter: resend, webhookSecret: secret, connectorScope: { workspaceId, companyId }, ownedInboundRecipient: "inbox@example.test" } };
    const payload = { type: "email.received", created_at: new Date().toISOString(), data: { email_id: "email_reply_routes", from: "sender@example.test", to: [inboundRecipient], message_id: "<received@example.test>" } };
    try {
      await context.storage.appendEvent({ workspaceId, companyId, id: "audit_outbound_thread_routes", eventType: "golden-execution-completed", actor: "golden-company-worker", entityType: "task", entityId: "task_outbound", payload: { provider: "resend", providerObjectId: "email_outbound_routes", threadRef }, occurredAt: new Date().toISOString() });
      expect((await context.storage.listEvents(workspaceId, companyId)).find((event) => event.id === "audit_outbound_thread_routes")?.payload).toMatchObject({ threadRef });
      expect((await handleProviderRequest(resendWebhookRequest(payload, secret), "resend", "webhook", dependencies)).status).toBe(200);
      expect(urls).toEqual(["https://api.resend.com/emails/receiving/email_reply_routes"]);

      const unbound = { ...payload, data: { ...payload.data, email_id: "email_reply_unbound" } };
      expect((await handleProviderRequest(resendWebhookRequest(unbound, secret), "resend", "webhook", {
        ...dependencies,
        resend: { ...dependencies.resend!, adapter: new ResendEmailAdapter("re_test", async () => Response.json({ object: "email", id: "email_reply_unbound", from: "sender@example.test", to: ["inbox@example.test"], headers: { References: "<other@thread.opspot.invalid>" } })) }
      })).status).toBe(502);
    } finally {
      await context.storage.close();
    }
  });

  it("rate-limits authenticated acquisition/verification routes and never accepts another workspace company", async () => {
    const context = await harness();
    let invoked = 0;
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, runAcquisitionOnce: async (claimedWorkspace) => { invoked += 1; return { outcome: "processed", workspaceId: claimedWorkspace }; } };
    try {
      expect(await (await handleProviderRequest(ownerRequest({}), "resend", "send", dependencies)).json()).toMatchObject({ ok: true, outcome: { workspaceId } });
      expect(invoked).toBe(1);
      expect((await handleProviderRequest(ownerRequest({ companyId: otherCompanyId, accessSecret: "x".repeat(32), idempotencyKey: "access-use-other-company" }), "fulfillment", "verify", dependencies)).status).toBe(404);
      dependencies.auth = { ...context.auth, consumeRateLimit: async () => ({ allowed: false, retryAfterSeconds: 30 }) };
      const limited = await handleProviderRequest(ownerRequest({}), "resend", "send", dependencies);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("30");
      expect(invoked).toBe(1);
    } finally {
      await context.storage.close();
    }
  });

  it("binds signed generic and bounded analytics events to the configured company without upgrading business proof", async () => {
    const context = await harness();
    const signer = "owned-system";
    const secret = "generic-webhook-secret-at-least-32-bytes";
    const dependencies: ProviderRouteDependencies = { storage: context.storage, generic: { signer, signingSecret: secret, scope: { workspaceId, companyId } } };
    const payload = { id: "hook_routes_1", type: "customer.signal", occurredAt: new Date().toISOString(), companyId: otherCompanyId };
    try {
      expect((await handleProviderRequest(genericWebhookRequest(payload, signer, secret, false), "generic", "webhook", dependencies)).status).toBe(401);
      expect(await (await handleProviderRequest(genericWebhookRequest(payload, signer, secret), "generic", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true, businessOutcomeVerified: false });
      expect(await (await handleProviderRequest(genericWebhookRequest(payload, signer, secret), "generic", "webhook", dependencies)).json()).toMatchObject({ created: false });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "generic-webhook-received")).toHaveLength(1);
      expect(await context.storage.listEvents(otherWorkspaceId, otherCompanyId)).toEqual([]);

      const analytics = { id: "analytics_routes_1", type: "landing-view", occurredAt: new Date().toISOString() };
      expect(await (await handleProviderRequest(genericWebhookRequest(analytics, signer, secret), "generic", "analytics", dependencies)).json()).toMatchObject({ ok: true, created: true, businessOutcomeVerified: false });
      expect((await handleProviderRequest(genericWebhookRequest({ ...analytics, id: "analytics_bad", type: "payment" }, signer, secret), "generic", "analytics", dependencies)).status).toBe(400);
    } finally {
      await context.storage.close();
    }
  });
});
