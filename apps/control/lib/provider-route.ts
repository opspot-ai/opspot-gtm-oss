import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ResendEmailAdapter,
  StripeAdapter,
  ingestGenericWebhook,
  normalizeResendWebhook,
  normalizeFirstPartyEvent,
  stripeCheckoutRequest,
  stripeOperatedCompanyCheckoutRequest,
  stripePortalRequest,
  verifyResendWebhook,
  verifyStripeSignature,
  type StripeEvent
} from "@opspot/adapters";
import { GoldenProviderProofService, resendInboundRecipientMatches, type DigitalAccessKey, type PublicSellableAssetService } from "@opspot/domain";
import { ReceiptSchema, makeId, sha256 } from "@opspot/contracts";
import type { KernelStorage, WorkspaceMembership } from "@opspot/storage";

const companyIdSchema = z.string().regex(/^venture_[a-z0-9][a-z0-9_-]{0,149}$/);
const idempotencySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const checkoutSchema = z.object({ companyId: companyIdSchema, idempotencyKey: idempotencySchema }).strict();
const portalSchema = checkoutSchema;
const publicCheckoutSchema = z.object({
  slug: z.string().min(20).max(1000).regex(/^slug_[a-f0-9]{32}\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  idempotencyKey: idempotencySchema
}).strict();
const verificationSchema = z.object({ companyId: companyIdSchema, accessSecret: z.string().min(32).max(128), idempotencyKey: idempotencySchema }).strict();
const emptySchema = z.object({}).strict();
const authSubjectSchema = z.uuid();
const MAX_JSON_BYTES = 64 * 1024;
const MAX_WEBHOOK_BYTES = 512 * 1024;

export interface ProviderAuthDependencies {
  appOrigin: string;
  localWorkspaceId?: string;
  createClient(): Promise<SupabaseClient>;
  resolveWorkspace(authSubject: string): Promise<WorkspaceMembership>;
  consumeRateLimit(workspaceId: string, request: Request): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface ProviderRouteDependencies {
  storage: KernelStorage;
  auth?: ProviderAuthDependencies;
  stripe?: {
    adapter: StripeAdapter;
    webhookSecret?: string;
    priceId?: string;
    trialBypassSecret?: string;
    mode: "live" | "test";
  };
  resend?: {
    adapter: ResendEmailAdapter;
    webhookSecret?: string;
    connectorScope?: { workspaceId: string; companyId: string };
    ownedInboundRecipient?: string;
  };
  publicOffer?: { assets: PublicSellableAssetService; access: DigitalAccessKey; allowFixtureAccess?: boolean };
  generic?: { signer: string; signingSecret: string; scope: { workspaceId: string; companyId: string } };
  runAcquisitionOnce?(workspaceId: string): Promise<Record<string, unknown> | null>;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      expires: "0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function failure(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return failure(413, "body-too-large", "Request body is too large.");
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength > maxBytes ? failure(413, "body-too-large", "Request body is too large.") : body;
}

async function ownerJson<T>(request: Request, dependencies: ProviderRouteDependencies, schema: z.ZodType<T>): Promise<{ workspaceId: string; body: T } | Response> {
  const auth = dependencies.auth;
  if (!auth) return failure(503, "provider-unavailable", "Provider action is unavailable.");
  if (request.method !== "POST") return failure(405, "method-not-allowed", "Provider actions require POST.", { allow: "POST" });
  if (request.headers.get("origin") !== auth.appOrigin) return failure(403, "origin-rejected", "Request origin was rejected.");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "json-required", "Content-Type must be application/json.");
  }
  const raw = await boundedBody(request, MAX_JSON_BYTES);
  if (raw instanceof Response) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return failure(400, "invalid-json", "Request body must be valid JSON.");
  }
  const body = schema.safeParse(parsed);
  if (!body.success) return failure(400, "invalid-provider-request", "Provider request fields are invalid.");
  if (auth.localWorkspaceId) {
    const rate = await auth.consumeRateLimit(auth.localWorkspaceId, request);
    if (!rate.allowed) return failure(429, "provider-rate-limited", "Too many provider requests. Try again later.", { "retry-after": String(rate.retryAfterSeconds) });
    return { workspaceId: auth.localWorkspaceId, body: body.data };
  }
  const client = await auth.createClient();
  const { data, error } = await client.auth.getClaims();
  const subject = authSubjectSchema.safeParse(data?.claims?.sub);
  if (error || !subject.success || data?.claims?.role !== "authenticated") return failure(401, "auth-required", "A verified session is required.");
  const membership = await auth.resolveWorkspace(subject.data);
  if (membership.role !== "owner") return failure(403, "workspace-access-denied", "Workspace owner access is required.");
  const rate = await auth.consumeRateLimit(membership.workspaceId, request);
  if (!rate.allowed) return failure(429, "provider-rate-limited", "Too many provider requests. Try again later.", { "retry-after": String(rate.retryAfterSeconds) });
  return { workspaceId: membership.workspaceId, body: body.data };
}

async function requireCompany(storage: KernelStorage, workspaceId: string, companyId: string) {
  const company = await storage.getCompany(workspaceId, companyId);
  if (!company || company.killed) return undefined;
  return company;
}

function providerUrl(value: unknown, host: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stripeObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactSecret(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected || expected.length < 32) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function stripeWebhook(request: Request, dependencies: ProviderRouteDependencies): Promise<Response> {
  const stripe = dependencies.stripe;
  if (!stripe?.webhookSecret) return failure(503, "stripe-unavailable", "Stripe webhook is unavailable.");
  const raw = await boundedBody(request, MAX_WEBHOOK_BYTES);
  if (raw instanceof Response) return raw;
  if (!verifyStripeSignature(raw, request.headers.get("stripe-signature"), stripe.webhookSecret)) return failure(401, "invalid-webhook-signature", "Webhook signature verification failed.");
  let event: StripeEvent;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>;
    const data = stripeObject(parsed.data);
    const object = stripeObject(data?.object);
    if (typeof parsed.id !== "string" || typeof parsed.type !== "string" || !Number.isSafeInteger(parsed.created) || !object
      || typeof object.id !== "string" || typeof object.object !== "string") throw new Error("invalid");
    event = parsed as unknown as StripeEvent;
  } catch {
    return failure(400, "invalid-webhook", "Webhook body is invalid.");
  }
  const reconciled = await stripe.adapter.reconcileWebhook(event);
  if (!reconciled) return json({ ok: true, ignored: true }, 202);
  if (reconciled.providerMode !== stripe.mode || !reconciled.providerBinding?.workspaceId || !reconciled.providerBinding.companyId
    || reconciled.providerBinding.kind !== reconciled.namespace) return failure(400, "provider-binding-invalid", "Webhook provider binding is invalid.");
  const scope = { workspaceId: reconciled.providerBinding.workspaceId, companyId: reconciled.providerBinding.companyId };
  if (!await requireCompany(dependencies.storage, scope.workspaceId, scope.companyId)) return failure(400, "provider-binding-invalid", "Webhook provider binding is invalid.");
  const service = new GoldenProviderProofService(dependencies.storage);
  if (reconciled.namespace === "operated_company_payment") {
    const binding = reconciled.providerBinding;
    if (!dependencies.publicOffer || !binding.offerId || binding.amount === undefined || !binding.currency) {
      return failure(400, "provider-binding-invalid", "Operated payment offer binding is invalid.");
    }
    const asset = await dependencies.publicOffer.assets.getByIdentity(scope, binding.offerId);
    if (!asset) return failure(400, "provider-binding-invalid", "Operated payment offer binding is invalid.");
    const amountMatches = reconciled.observedKind === "payment"
      ? reconciled.amount === asset.amountCents
      : typeof reconciled.amount === "number" && reconciled.amount > 0 && reconciled.amount <= asset.amountCents;
    if (binding.amount !== asset.amountCents || binding.currency !== asset.currency
      || !amountMatches || reconciled.currency !== asset.currency) {
      return failure(400, "provider-binding-invalid", "Operated payment offer binding is invalid.");
    }
    if (reconciled.observedKind === "payment") {
      if (reconciled.providerMode === "test" && !dependencies.publicOffer.allowFixtureAccess) {
        const fixture = await service.ingestStripe(reconciled, scope);
        return json({ ok: true, created: fixture.created, proofTier: "fixture-verified", accessProvisioned: false, accessStatus: "fixture-only" });
      }
      const grant = await service.grantDigitalAccess(reconciled, scope, dependencies.publicOffer.access);
      return json({ ok: true, created: grant.created, proofTier: reconciled.providerMode === "live" ? "revenue-verified" : "fixture-verified", accessProvisioned: true, accessStatus: grant.status });
    }
  }
  const result = await service.ingestStripe(reconciled, scope);
  return json({ ok: true, created: result.created, proofTier: result.proofTier, revokedGrants: result.revokedGrants, restoredGrants: result.restoredGrants });
}

async function publicOfferCheckout(request: Request, dependencies: ProviderRouteDependencies): Promise<Response> {
  if (!dependencies.auth || !dependencies.stripe || !dependencies.publicOffer) return failure(503, "provider-unavailable", "Offer Checkout is unavailable.");
  if (request.headers.get("origin") !== dependencies.auth.appOrigin) return failure(403, "origin-rejected", "Request origin was rejected.");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return failure(415, "form-required", "Content-Type must be application/x-www-form-urlencoded.");
  }
  const raw = await boundedBody(request, MAX_JSON_BYTES);
  if (raw instanceof Response) return raw;
  const params = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if ([...params.keys()].some((key) => !["slug", "idempotencyKey"].includes(key)) || [...params.keys()].some((key) => params.getAll(key).length !== 1)) {
    return failure(400, "invalid-provider-request", "Offer Checkout request fields are invalid.");
  }
  const parsed = publicCheckoutSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return failure(400, "invalid-provider-request", "Offer Checkout request fields are invalid.");
  const asset = await dependencies.publicOffer.assets.getBySlug(parsed.data.slug);
  if (!asset || !await requireCompany(dependencies.storage, asset.workspaceId, asset.companyId)) return failure(404, "offer-not-found", "Offer was not found.");
  const rate = await dependencies.auth.consumeRateLimit(asset.workspaceId, request);
  if (!rate.allowed) return failure(429, "provider-rate-limited", "Too many provider requests. Try again later.", { "retry-after": String(rate.retryAfterSeconds) });
  const idempotencyKey = `opspot-offer:${sha256({ assetId: asset.assetId, key: parsed.data.idempotencyKey }).slice(0, 48)}`;
  const result = await dependencies.stripe.adapter.post<Record<string, unknown>>(stripeOperatedCompanyCheckoutRequest({
    offerId: asset.assetId,
    offerName: asset.offerName,
    amount: asset.amountCents,
    currency: asset.currency,
    workspaceId: asset.workspaceId,
    companyId: asset.companyId,
    successUrl: `${dependencies.auth.appOrigin}/o/${encodeURIComponent(asset.publicSlug)}?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${dependencies.auth.appOrigin}/o/${encodeURIComponent(asset.publicSlug)}`
  }), idempotencyKey);
  const url = providerUrl(result.url, "checkout.stripe.com");
  if (result.object !== "checkout.session" || typeof result.id !== "string" || typeof result.livemode !== "boolean"
    || (result.livemode ? "live" : "test") !== dependencies.stripe.mode || !url) {
    return failure(502, "stripe-response-invalid", "Stripe returned an invalid Checkout session.");
  }
  return new Response(null, { status: 303, headers: { location: url, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

async function resendWebhook(request: Request, dependencies: ProviderRouteDependencies): Promise<Response> {
  const resend = dependencies.resend;
  if (!resend?.webhookSecret || !resend.connectorScope || !resend.ownedInboundRecipient) return failure(503, "resend-unavailable", "Resend webhook is unavailable.");
  const raw = await boundedBody(request, MAX_WEBHOOK_BYTES);
  if (raw instanceof Response) return raw;
  let event;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    event = normalizeResendWebhook(verifyResendWebhook(text, request.headers, resend.webhookSecret, { sourceBinding: resend.connectorScope }));
  } catch {
    return failure(401, "invalid-webhook-signature", "Webhook signature verification failed.");
  }
  if (!event.sourceBinding || event.sourceBinding.workspaceId !== resend.connectorScope.workspaceId || event.sourceBinding.companyId !== resend.connectorScope.companyId
    || !await requireCompany(dependencies.storage, resend.connectorScope.workspaceId, resend.connectorScope.companyId)) {
    return failure(400, "provider-binding-invalid", "Webhook provider binding is invalid.");
  }
  const scope = resend.connectorScope;
  const outgoing = event.kind !== "reply" && event.kind !== "unsubscribed";
  const sent = outgoing ? await resend.adapter.retrieve(event.emailId, scope) : undefined;
  const received = event.kind === "reply" ? await resend.adapter.retrieveReceived(event.emailId) : undefined;
  const ownedInboundRecipient = resend.ownedInboundRecipient.trim().toLowerCase();
  if (event.kind === "reply" && (!event.recipients.some((recipient) => resendInboundRecipientMatches(ownedInboundRecipient, recipient))
    || !received?.recipients.some((recipient) => resendInboundRecipientMatches(ownedInboundRecipient, recipient)))) {
    return failure(400, "provider-binding-invalid", "Received email is not bound to the owned inbound recipient.");
  }
  const result = await new GoldenProviderProofService(dependencies.storage).ingestEmail(event, scope, sent, received);
  return json({ ok: true, created: result.created, proofTier: result.proofTier, suppressed: result.suppressedRecipients.length });
}

const ANALYTICS_TYPES = new Set(["landing-view", "checkout-started"]);

async function genericWebhook(request: Request, dependencies: ProviderRouteDependencies, analytics: boolean): Promise<Response> {
  const binding = dependencies.generic;
  if (!binding) return failure(503, "generic-webhook-unavailable", "Generic webhook ingestion is unavailable.");
  const raw = await boundedBody(request, MAX_WEBHOOK_BYTES);
  if (raw instanceof Response) return raw;
  const signer = request.headers.get("x-opspot-signer") ?? "";
  const timestamp = Number(request.headers.get("x-opspot-timestamp"));
  if (signer !== binding.signer) return failure(401, "invalid-webhook-signature", "Webhook signature verification failed.");
  let event;
  try {
    event = ingestGenericWebhook({ signer, timestamp, signature: request.headers.get("x-opspot-signature") ?? "", rawBody: raw }, binding.signingSecret);
  } catch {
    return failure(401, "invalid-webhook-signature", "Webhook signature verification failed.");
  }
  if (!await requireCompany(dependencies.storage, binding.scope.workspaceId, binding.scope.companyId)) {
    return failure(400, "provider-binding-invalid", "Webhook provider binding is invalid.");
  }
  const normalized = analytics
    ? normalizeFirstPartyEvent({ id: event.eventId, companyId: binding.scope.companyId, type: event.type, occurredAt: event.occurredAt })
    : undefined;
  if (analytics && !ANALYTICS_TYPES.has(event.type)) return failure(400, "analytics-event-invalid", "Analytics event type is invalid.");
  const id = makeId("event", { scope: binding.scope, dedupeKey: normalized?.dedupeKey ?? event.dedupeKey });
  const stored = await dependencies.storage.appendEvent({
    ...binding.scope,
    id,
    eventType: analytics ? `analytics-${event.type}` : "generic-webhook-received",
    actor: analytics ? "first-party-analytics" : `generic-webhook:${binding.signer}`,
    entityType: analytics ? "analytics-event" : "generic-webhook",
    entityId: event.eventId,
    payload: { signer: binding.signer, type: event.type, rawBodyHash: event.rawBodyHash, businessOutcomeVerified: false },
    occurredAt: event.occurredAt
  });
  return json({ ok: true, created: stored.created, eventId: id, businessOutcomeVerified: false });
}

export async function handleProviderRequest(request: Request, provider: string, action: string, dependencies: ProviderRouteDependencies): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method-not-allowed", "Provider routes require POST.", { allow: "POST" });
  try {
    if (provider === "stripe" && action === "webhook") return stripeWebhook(request, dependencies);
    if (provider === "stripe" && action === "offer-checkout") return publicOfferCheckout(request, dependencies);
    if (provider === "resend" && action === "webhook") return await resendWebhook(request, dependencies);
    if (provider === "generic" && action === "webhook") return genericWebhook(request, dependencies, false);
    if (provider === "generic" && action === "analytics") return genericWebhook(request, dependencies, true);
    if (provider === "stripe" && (action === "checkout" || action === "checkout-trial-bypass")) {
      const parsed = await ownerJson(request, dependencies, checkoutSchema);
      if (parsed instanceof Response) return parsed;
      if (!dependencies.stripe?.priceId || !await requireCompany(dependencies.storage, parsed.workspaceId, parsed.body.companyId)) return failure(404, "company-not-found", "Company was not found.");
      const trialBypass = action === "checkout-trial-bypass";
      if (trialBypass && !exactSecret(request.headers.get("x-opspot-trial-bypass-authorization"), dependencies.stripe.trialBypassSecret)) {
        return failure(403, "trial-bypass-not-authorized", "Trial bypass requires exact server authorization.");
      }
      const idempotencyKey = `opspot:${sha256({ action, workspaceId: parsed.workspaceId, companyId: parsed.body.companyId, key: parsed.body.idempotencyKey }).slice(0, 48)}`;
      const result = await dependencies.stripe.adapter.post<Record<string, unknown>>(stripeCheckoutRequest({
        priceId: dependencies.stripe.priceId,
        workspaceId: parsed.workspaceId,
        companyId: parsed.body.companyId,
        successUrl: `${dependencies.auth!.appOrigin}/?company=${encodeURIComponent(parsed.body.companyId)}&checkout=success`,
        cancelUrl: `${dependencies.auth!.appOrigin}/?company=${encodeURIComponent(parsed.body.companyId)}&checkout=cancelled`,
        ...(trialBypass ? { trialBypass: true } : {})
      }), idempotencyKey);
      const url = providerUrl(result.url, "checkout.stripe.com");
      if (result.object !== "checkout.session" || typeof result.id !== "string" || typeof result.livemode !== "boolean" || (result.livemode ? "live" : "test") !== dependencies.stripe.mode || !url) {
        return failure(502, "stripe-response-invalid", "Stripe returned an invalid Checkout session.");
      }
      if (trialBypass) {
        if (!Number.isSafeInteger(result.created) || Number(result.created) < 0) return failure(502, "stripe-response-invalid", "Stripe returned an invalid Checkout session.");
        const proofTier = dependencies.stripe.mode === "live" ? "externally-live" : "fixture-verified";
        const machine = { provider: "stripe", kind: "saas-trial-bypass-checkout", workspaceId: parsed.workspaceId, companyId: parsed.body.companyId, providerObjectId: result.id, providerMode: dependencies.stripe.mode, trialBypass: true, authorization: "dedicated-server-secret", paymentVerified: false };
        const receiptId = makeId("receipt", machine);
        const eventId = makeId("audit", machine);
        const [existingReceipt, existingEvent] = await Promise.all([
          dependencies.storage.listReceipts(parsed.workspaceId, parsed.body.companyId).then((items) => items.find((item) => item.id === receiptId)),
          dependencies.storage.listEvents(parsed.workspaceId, parsed.body.companyId).then((items) => items.find((item) => item.id === eventId))
        ]);
        const occurredAt = existingReceipt?.occurredAt ?? existingEvent?.occurredAt ?? new Date(Number(result.created) * 1_000).toISOString();
        const receipt = ReceiptSchema.parse({ id: receiptId, ventureId: parsed.body.companyId, proofTier, outcome: "success", actor: "workspace-owner", adapter: "stripe", artifactPath: `provider/stripe/${result.id}.json`, contentHash: sha256(machine), occurredAt, metadata: machine, origin: dependencies.stripe.mode === "live" ? "engine-derived" : "fixture" });
        await dependencies.storage.appendReceipt(parsed.workspaceId, receipt);
        if (!existingEvent) {
          await dependencies.storage.appendEvent({ workspaceId: parsed.workspaceId, companyId: parsed.body.companyId, id: eventId, eventType: "saas-trial-bypass-checkout-created", actor: "workspace-owner", entityType: "checkout-session", entityId: result.id, payload: { receiptId: receipt.id, providerMode: dependencies.stripe.mode, trialBypass: true, paymentVerified: false }, occurredAt });
        }
      }
      return json({ ok: true, url, providerMode: dependencies.stripe.mode, paymentVerified: false });
    }
    if (provider === "stripe" && action === "portal") {
      const parsed = await ownerJson(request, dependencies, portalSchema);
      if (parsed instanceof Response) return parsed;
      if (!dependencies.stripe || !await requireCompany(dependencies.storage, parsed.workspaceId, parsed.body.companyId)) return failure(404, "company-not-found", "Company was not found.");
      const service = new GoldenProviderProofService(dependencies.storage);
      const customerId = await service.stripeSaasCustomerId({ workspaceId: parsed.workspaceId, companyId: parsed.body.companyId }, dependencies.stripe.mode);
      if (!customerId) return failure(409, "billing-customer-unavailable", "No reconciled Stripe customer is available for this company.");
      const idempotencyKey = `opspot:${sha256({ action, workspaceId: parsed.workspaceId, companyId: parsed.body.companyId, key: parsed.body.idempotencyKey }).slice(0, 48)}`;
      const result = await dependencies.stripe.adapter.post<Record<string, unknown>>(stripePortalRequest({ customerId, returnUrl: `${dependencies.auth!.appOrigin}/?company=${encodeURIComponent(parsed.body.companyId)}` }), idempotencyKey);
      const url = providerUrl(result.url, "billing.stripe.com");
      if (result.object !== "billing_portal.session" || typeof result.id !== "string" || !url) return failure(502, "stripe-response-invalid", "Stripe returned an invalid Portal session.");
      return json({ ok: true, url, providerMode: dependencies.stripe.mode });
    }
    if (provider === "resend" && action === "send") {
      const parsed = await ownerJson(request, dependencies, emptySchema);
      if (parsed instanceof Response) return parsed;
      if (!dependencies.runAcquisitionOnce) return failure(503, "acquisition-unavailable", "Acquisition worker is unavailable.");
      const result = await dependencies.runAcquisitionOnce(parsed.workspaceId);
      return json({ ok: true, outcome: result ?? { outcome: "idle" } });
    }
    if (provider === "fulfillment" && action === "verify") {
      const parsed = await ownerJson(request, dependencies, verificationSchema);
      if (parsed instanceof Response) return parsed;
      if (!await requireCompany(dependencies.storage, parsed.workspaceId, parsed.body.companyId)) return failure(404, "company-not-found", "Company was not found.");
      const usage = await new GoldenProviderProofService(dependencies.storage).useDigitalAccess(
        { workspaceId: parsed.workspaceId, companyId: parsed.body.companyId },
        parsed.body.accessSecret,
        parsed.body.idempotencyKey,
        { allowFixture: dependencies.publicOffer?.allowFixtureAccess === true }
      );
      return json({ ok: true, ...usage });
    }
    return failure(404, "provider-route-not-found", "Provider route was not found.");
  } catch {
    return failure(502, "provider-operation-failed", "Provider operation could not be completed.");
  }
}
