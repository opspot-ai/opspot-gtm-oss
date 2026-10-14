import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function stripeApiKeyMode(apiKey: string): "live" | "test" {
  if (/^(?:sk|rk)_live_/.test(apiKey)) return "live";
  if (/^(?:sk|rk)_test_/.test(apiKey)) return "test";
  throw new Error("Stripe API key must be a supported live or test secret/restricted key");
}

export type StripeRequest = { url: string; body: string };

type StripeMetadata = Record<string, string | undefined>;
type StripeObject = {
  id: string;
  object: string;
  metadata?: StripeMetadata;
  parent?: { subscription_details?: { metadata?: StripeMetadata; subscription?: string } };
  subscription_details?: { metadata?: StripeMetadata; subscription?: string };
  lines?: { data?: Array<{ type?: string; period?: { start?: number; end?: number }; parent?: { type?: string } }> };
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  status?: string;
  payment_status?: string;
  customer?: string;
  subscription?: string;
  invoice?: string;
  charge?: string;
  latest_charge?: string;
  payment_intent?: string;
  amount?: number;
  amount_total?: number;
  amount_paid?: number;
  amount_received?: number;
  amount_refunded?: number;
  currency?: string;
  paid?: boolean;
  refunded?: boolean;
  disputed?: boolean;
  livemode?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  period_start?: number;
  period_end?: number;
  dispute?: string | { id?: string; status?: string };
};
export type StripeEvent = { id: string; type: string; created: number; data: { object: StripeObject } };

export type StripeReconciliationTarget = { target: string; objectId: string };

type ObservedStripeEvent = {
  providerEventId: string;
  dedupeKey: string;
  orderingKey: string;
  providerCreatedAt: number;
  occurredAt: string;
  verification: "observed-unverified";
  reconciliation: StripeReconciliationTarget;
};

export type SaasEntitlementEvent = ObservedStripeEvent & {
  namespace: "saas_entitlement";
  workspaceId: string;
  companyId?: string;
  observedEntitlement: "pending" | "trialing" | "active" | "inactive" | "past_due" | "unpaid" | "refunded" | "disputed";
  amount?: number;
  currency?: string;
};

export type OperatedCompanyPaymentEvent = ObservedStripeEvent & {
  namespace: "operated_company_payment";
  workspaceId: string;
  companyId: string;
  observedKind: "payment" | "refund" | "dispute" | "dispute_resolved";
  relatedPaymentObjectId?: string;
  amount?: number;
  currency?: string;
};

export type NormalizedStripeEvent = SaasEntitlementEvent | OperatedCompanyPaymentEvent;
export type StripeProviderBinding = {
  workspaceId?: string;
  companyId?: string;
  kind?: string;
  offerId?: string;
  amount?: number;
  currency?: string;
};
export type ReconciledStripeEvent<T extends NormalizedStripeEvent = NormalizedStripeEvent> = T extends unknown ? Omit<T, "verification"> & {
  verification: "authoritatively-reconciled";
  reconciledAt: string;
  providerMode: "live" | "test";
  authoritativeStatus?: string;
  providerBinding?: StripeProviderBinding;
  authoritativePeriodStart?: string;
  authoritativePeriodEnd?: string;
  relatedPaymentObjectId?: string;
  customerId?: string;
  subscriptionId?: string;
} : never;
export type StripeReconciliationResult = StripeReconciliationTarget & {
  authoritative: boolean;
  retrievedAt: string;
  status?: string;
  amount?: number;
  currency?: string;
  livemode?: boolean;
  binding?: StripeProviderBinding;
  periodStart?: string;
  periodEnd?: string;
  relatedPaymentObjectId?: string;
  customerId?: string;
  subscriptionId?: string;
};

export type ReconciledOperatedCheckoutSession = {
  sessionId: string;
  paymentIntentId: string;
  providerMode: "live" | "test";
  amount: number;
  currency: string;
  binding: StripeProviderBinding & Required<Pick<StripeProviderBinding, "workspaceId" | "companyId" | "kind" | "offerId" | "amount" | "currency">>;
  retrievedAt: string;
};

export type ReconciledOperatedCheckoutAccess = ReconciledOperatedCheckoutSession & {
  chargeId: string;
  paymentIntentRetrievedAt: string;
  chargeRetrievedAt: string;
};

export function stripeCheckoutRequest(input: { priceId: string; successUrl: string; cancelUrl: string; customerId?: string; workspaceId: string; companyId: string; trialBypass?: boolean }): StripeRequest {
  if (![input.priceId, input.workspaceId, input.companyId, ...(input.customerId ? [input.customerId] : [])].every((value) => SAFE_ID.test(value)) || !isHttpsUrl(input.successUrl) || !isHttpsUrl(input.cancelUrl)) throw new Error("subscription Checkout requires safe identifiers and HTTPS return URLs");
  const form = new URLSearchParams({ mode: "subscription", "success_url": input.successUrl, "cancel_url": input.cancelUrl, "line_items[0][price]": input.priceId, "line_items[0][quantity]": "1", "metadata[opspot_workspace_id]": input.workspaceId, "metadata[opspot_company_id]": input.companyId, "metadata[opspot_kind]": "saas_entitlement", "subscription_data[metadata][opspot_workspace_id]": input.workspaceId, "subscription_data[metadata][opspot_company_id]": input.companyId, "subscription_data[metadata][opspot_kind]": "saas_entitlement" });
  if (!input.trialBypass) form.set("subscription_data[trial_period_days]", "7");
  if (input.customerId) form.set("customer", input.customerId);
  return stripePost("checkout/sessions", form);
}

export function stripeOperatedCompanyCheckoutRequest(input: { offerId: string; offerName: string; amount: number; currency: string; successUrl: string; cancelUrl: string; workspaceId: string; companyId: string }): StripeRequest {
  const currency = input.currency.trim().toLowerCase();
  const offerName = input.offerName.trim();
  const hasControlCharacter = Array.from(offerName).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (![input.offerId, input.workspaceId, input.companyId].every((value) => SAFE_ID.test(value)) || !offerName || offerName.length > 100 || hasControlCharacter || currency !== "usd" || !Number.isSafeInteger(input.amount) || input.amount <= 0 || !isHttpsUrl(input.successUrl) || !isHttpsUrl(input.cancelUrl)) throw new Error("operated-company Checkout requires a positive USD amount, safe bounded identifiers/name, and HTTPS return URLs");
  const metadata = { opspot_workspace_id: input.workspaceId, opspot_company_id: input.companyId, opspot_kind: "operated_company_payment", opspot_offer_id: input.offerId, opspot_amount: String(input.amount), opspot_currency: currency };
  const form = new URLSearchParams({ mode: "payment", "success_url": input.successUrl, "cancel_url": input.cancelUrl, "line_items[0][price_data][currency]": currency, "line_items[0][price_data][unit_amount]": String(input.amount), "line_items[0][price_data][product_data][name]": offerName, "line_items[0][price_data][product_data][metadata][opspot_offer_id]": input.offerId, "line_items[0][quantity]": "1" });
  for (const [key, value] of Object.entries(metadata)) {
    form.set(`metadata[${key}]`, value);
    form.set(`payment_intent_data[metadata][${key}]`, value);
  }
  return stripePost("checkout/sessions", form);
}

export function stripePortalRequest(input: { customerId: string; returnUrl: string }): StripeRequest {
  if (!SAFE_ID.test(input.customerId) || !isHttpsUrl(input.returnUrl)) throw new Error("Stripe Portal requires a safe customer id and HTTPS return URL");
  return stripePost("billing_portal/sessions", new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl }));
}

export class StripeAdapter {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async post<T>(request: StripeRequest, idempotencyKey?: string): Promise<T> {
    if (!this.apiKey.trim()) throw new Error("Stripe API key is required");
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,255}$/.test(idempotencyKey)) throw new Error("invalid Stripe idempotency key");
    const response = await this.fetchImpl(request.url, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: request.body });
    const body = await response.json().catch(() => { throw new Error("Stripe response is not JSON"); }) as T;
    if (!response.ok) throw new Error(`Stripe API error ${response.status}`);
    return body;
  }

  async get<T>(target: StripeReconciliationTarget): Promise<T> {
    if (!this.apiKey.trim()) throw new Error("Stripe API key is required");
    const response = await this.fetchImpl(stripeObjectUrl(target), { headers: { authorization: `Bearer ${this.apiKey}` } });
    const body = await response.json().catch(() => { throw new Error("Stripe response is not JSON"); }) as T;
    if (!response.ok) throw new Error(`Stripe API error ${response.status}`);
    return body;
  }

  async reconcile<T extends NormalizedStripeEvent>(event: T, retrievedAt = new Date().toISOString()): Promise<ReconciledStripeEvent<T> | null> {
    const object = await this.get<StripeObject>(event.reconciliation);
    const context = await this.authoritativeContext(object, event.namespace === "saas_entitlement" && event.observedEntitlement !== "pending");
    const result = normalizeStripeReconciliation(event.reconciliation, object, retrievedAt);
    const canonicalEvent = event.namespace === "operated_company_payment" && context.relatedPaymentObjectId
      ? { ...event, relatedPaymentObjectId: context.relatedPaymentObjectId } as T
      : event;
    return reconcileStripeEvent(canonicalEvent, {
      ...result,
      ...(context.binding ? { binding: context.binding } : {}),
      ...(context.periodStart ? { periodStart: context.periodStart } : {}),
      ...(context.periodEnd ? { periodEnd: context.periodEnd } : {}),
      ...(context.customerId ? { customerId: context.customerId } : {}),
      ...(context.subscriptionId ? { subscriptionId: context.subscriptionId } : {}),
      ...(context.relatedPaymentObjectId ? { relatedPaymentObjectId: context.relatedPaymentObjectId } : {})
    });
  }

  async reconcileWebhook(event: StripeEvent, retrievedAt = new Date().toISOString()): Promise<ReconciledStripeEvent | null> {
    let observed = normalizeStripeEvent(event);
    if (!observed && paymentKindFor(event.type, event.data.object)) {
      const context = await this.authoritativeContext(await this.get<StripeObject>({ target: event.data.object.object, objectId: event.data.object.id }), false);
      if (context.binding) observed = normalizeStripeEventWithBinding(event, context.binding);
    }
    return observed ? this.reconcile(observed, retrievedAt) : null;
  }

  async retrieveOperatedCheckoutSession(sessionId: string, retrievedAt = new Date().toISOString()): Promise<ReconciledOperatedCheckoutSession> {
    if (!/^cs_[A-Za-z0-9_-]{1,196}$/.test(sessionId)) throw new Error("invalid Stripe Checkout session id");
    const object = await this.get<StripeObject>({ target: "checkout.session", objectId: sessionId });
    const binding = bindingFromStripeObject(object);
    if (object.object !== "checkout.session" || object.id !== sessionId || object.status !== "complete" || object.payment_status !== "paid"
      || typeof object.livemode !== "boolean" || typeof object.amount_total !== "number" || !Number.isSafeInteger(object.amount_total) || object.amount_total <= 0
      || typeof object.currency !== "string" || !object.currency || typeof object.payment_intent !== "string"
      || !completeOperatedOfferBinding(binding)) {
      throw new Error("Stripe Checkout session is not an authoritative paid operated-company session");
    }
    return {
      sessionId,
      paymentIntentId: object.payment_intent,
      providerMode: object.livemode ? "live" : "test",
      amount: object.amount_total,
      currency: object.currency.toLowerCase(),
      binding,
      retrievedAt: normalizedIso(retrievedAt, "Stripe Checkout retrieval timestamp")
    };
  }

  async retrieveOperatedCheckoutAccess(sessionId: string, retrievedAt = new Date().toISOString()): Promise<ReconciledOperatedCheckoutAccess> {
    const session = await this.retrieveOperatedCheckoutSession(sessionId, retrievedAt);
    const paymentIntent = await this.get<StripeObject>({ target: "payment_intent", objectId: session.paymentIntentId });
    const paymentBinding = bindingFromStripeObject(paymentIntent);
    if (paymentIntent.object !== "payment_intent" || paymentIntent.id !== session.paymentIntentId || paymentIntent.status !== "succeeded"
      || paymentIntent.livemode !== (session.providerMode === "live") || !completeOperatedOfferBinding(paymentBinding)
      || !exactOperatedBinding(paymentBinding, session.binding)
      || (paymentIntent.amount_received ?? paymentIntent.amount) !== session.amount
      || paymentIntent.currency?.toLowerCase() !== session.currency
      || typeof paymentIntent.latest_charge !== "string" || !/^ch_[A-Za-z0-9_-]{1,196}$/.test(paymentIntent.latest_charge)) {
      throw new Error("Stripe PaymentIntent is not an authoritative settled operated-company payment");
    }
    const charge = await this.get<StripeObject>({ target: "charge", objectId: paymentIntent.latest_charge });
    const chargeBinding = bindingFromStripeObject(charge);
    if (charge.object !== "charge" || charge.id !== paymentIntent.latest_charge || charge.status !== "succeeded" || charge.paid !== true
      || charge.livemode !== (session.providerMode === "live") || charge.payment_intent !== paymentIntent.id
      || charge.amount !== session.amount || charge.currency?.toLowerCase() !== session.currency
      || !completeOperatedOfferBinding(chargeBinding) || !exactOperatedBinding(chargeBinding, session.binding)
      || charge.refunded === true || (charge.amount_refunded ?? 0) !== 0) {
      throw new Error("Stripe Charge is not an authoritative unrefunded operated-company payment");
    }
    const disputeId = typeof charge.dispute === "string" ? charge.dispute : charge.dispute?.id;
    if (disputeId) {
      const dispute = await this.get<StripeObject>({ target: "dispute", objectId: disputeId });
      if (dispute.object !== "dispute" || dispute.id !== disputeId || dispute.status !== "won" || dispute.livemode !== charge.livemode
        || (dispute.charge !== charge.id && dispute.payment_intent !== paymentIntent.id)) {
        throw new Error("Stripe payment has an unresolved or lost dispute");
      }
    } else if (charge.disputed === true || (typeof charge.dispute === "object" && charge.dispute?.status !== "won")) {
      throw new Error("Stripe payment has an unresolved or lost dispute");
    }
    const normalizedRetrievedAt = normalizedIso(retrievedAt, "Stripe access retrieval timestamp");
    return { ...session, chargeId: charge.id, paymentIntentRetrievedAt: normalizedRetrievedAt, chargeRetrievedAt: normalizedRetrievedAt };
  }

  private async authoritativeContext(initial: StripeObject, requirePeriod: boolean): Promise<{ binding?: StripeProviderBinding; periodStart?: string; periodEnd?: string; customerId?: string; subscriptionId?: string; relatedPaymentObjectId?: string }> {
    const queue: StripeObject[] = [initial];
    const queued = new Set([`${initial.object}:${initial.id}`]);
    let binding: StripeProviderBinding | undefined;
    let period: { periodStart: string; periodEnd: string } | undefined;
    let customerId: string | undefined;
    let subscriptionId: string | undefined;
    let relatedPaymentObjectId: string | undefined;
    while (queue.length) {
      const object = queue.shift()!;
      const candidateBinding = bindingFromStripeObject(object);
      if (completeBinding(candidateBinding)) {
        if (binding && !sameBinding(binding, candidateBinding)) throw new Error("Stripe authoritative objects disagree on tenant binding");
        binding = candidateBinding;
      }
      period ??= periodFromStripeObject(object);
      customerId ??= object.customer;
      subscriptionId ??= object.object === "subscription" ? object.id : object.subscription ?? object.parent?.subscription_details?.subscription ?? object.subscription_details?.subscription;
      relatedPaymentObjectId = preferredPaymentIdentity(relatedPaymentObjectId, canonicalStripePaymentObjectId(object));
      const unresolvedChargeIdentity = Boolean(object.charge) && !relatedPaymentObjectId?.startsWith("pi_");
      if (binding && (!requirePeriod || period) && !unresolvedChargeIdentity) return { binding, ...(period ?? {}), ...(customerId ? { customerId } : {}), ...(subscriptionId ? { subscriptionId } : {}), ...(relatedPaymentObjectId ? { relatedPaymentObjectId } : {}) };
      for (const target of stripeReferences(object)) {
        const key = `${target.target}:${target.objectId}`;
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push(await this.get<StripeObject>(target));
      }
    }
    return { ...(binding ? { binding } : {}), ...(period ?? {}), ...(customerId ? { customerId } : {}), ...(subscriptionId ? { subscriptionId } : {}), ...(relatedPaymentObjectId ? { relatedPaymentObjectId } : {}) };
  }
}

export function verifyStripeSignature(rawBody: string | Uint8Array, signature: string | null, webhookSecret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  if (!signature || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false;
  const pairs = signature.split(",").map((part) => part.split("=", 2));
  const timestamp = Number(pairs.find(([key]) => key === "t")?.[1]);
  const expected = pairs.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!);
  if (!Number.isInteger(timestamp) || !expected.length || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : Buffer.from(rawBody);
  const actual = createHmac("sha256", webhookSecret).update(Buffer.concat([Buffer.from(`${timestamp}.`), body])).digest("hex");
  const actualBytes = Buffer.from(actual, "hex");
  return expected.some((candidate) => {
    const candidateBytes = Buffer.from(candidate, "hex");
    return actualBytes.length === candidateBytes.length && timingSafeEqual(actualBytes, candidateBytes);
  });
}

export function normalizeStripeEvent(event: StripeEvent): NormalizedStripeEvent | null {
  return normalizeStripeEventWithBinding(event);
}

function normalizeStripeEventWithBinding(event: StripeEvent, authoritativeBinding?: StripeProviderBinding): NormalizedStripeEvent | null {
  const object = event.data.object;
  const metadata = { ...object.parent?.subscription_details?.metadata, ...object.subscription_details?.metadata, ...object.metadata };
  if (authoritativeBinding) {
    if ((metadata.opspot_workspace_id && metadata.opspot_workspace_id !== authoritativeBinding.workspaceId)
      || (metadata.opspot_company_id && metadata.opspot_company_id !== authoritativeBinding.companyId)
      || (metadata.opspot_kind && metadata.opspot_kind !== authoritativeBinding.kind)
      || (metadata.opspot_offer_id && authoritativeBinding.offerId && metadata.opspot_offer_id !== authoritativeBinding.offerId)
      || (metadata.opspot_amount && authoritativeBinding.amount !== undefined && metadata.opspot_amount !== String(authoritativeBinding.amount))
      || (metadata.opspot_currency && authoritativeBinding.currency && metadata.opspot_currency.toLowerCase() !== authoritativeBinding.currency)) return null;
    metadata.opspot_workspace_id = authoritativeBinding.workspaceId;
    metadata.opspot_company_id = authoritativeBinding.companyId;
    metadata.opspot_kind = authoritativeBinding.kind;
    if (authoritativeBinding.offerId) metadata.opspot_offer_id = authoritativeBinding.offerId;
    if (authoritativeBinding.amount !== undefined) metadata.opspot_amount = String(authoritativeBinding.amount);
    if (authoritativeBinding.currency) metadata.opspot_currency = authoritativeBinding.currency;
  }
  const occurredAt = new Date(event.created * 1000).toISOString();
  const reconciliation = { target: object.object, objectId: object.id };
  const dedupeKey = `stripe:event:${event.id}`;
  const orderingKey = `stripe:object:${object.object}:${object.id}`;
  const companyId = metadata.opspot_company_id;
  if (metadata.opspot_kind === "saas_entitlement" && metadata.opspot_workspace_id) {
    const observedEntitlement = entitlementFor(event.type, object);
    if (!observedEntitlement) return null;
    const amount = observedEntitlement === "refunded"
      ? object.amount_refunded ?? object.amount
      : observedEntitlement === "disputed"
        ? object.amount
        : object.amount_paid;
    return { namespace: "saas_entitlement", providerEventId: event.id, dedupeKey, orderingKey, providerCreatedAt: event.created, occurredAt, verification: "observed-unverified", reconciliation, workspaceId: metadata.opspot_workspace_id, ...(companyId ? { companyId } : {}), observedEntitlement, ...(amount === undefined ? {} : { amount }), ...(object.currency ? { currency: object.currency } : {}) };
  }
  const workspaceId = metadata.opspot_workspace_id;
  if (metadata.opspot_kind !== "operated_company_payment" || !workspaceId || !companyId) return null;
  const observedKind = paymentKindFor(event.type, object);
  if (!observedKind) return null;
  const amount = observedKind === "refund" ? object.amount_refunded ?? object.amount : object.amount_paid ?? object.amount_received ?? object.amount;
  const relatedPaymentObjectId = canonicalStripePaymentObjectId(object);
  return { namespace: "operated_company_payment", providerEventId: event.id, dedupeKey, orderingKey, providerCreatedAt: event.created, occurredAt, verification: "observed-unverified", reconciliation, workspaceId, companyId, observedKind, ...(relatedPaymentObjectId ? { relatedPaymentObjectId } : {}), ...(amount === undefined ? {} : { amount }), ...(object.currency ? { currency: object.currency } : {}) };
}

/** Converts a freshly retrieved Stripe object into the small authoritative surface used for reconciliation. */
export function normalizeStripeReconciliation(target: StripeReconciliationTarget, object: StripeObject, retrievedAt: string): StripeReconciliationResult {
  if (object.id !== target.objectId || object.object !== target.target) throw new Error("Stripe retrieved object does not match reconciliation target");
  const amount = target.target === "invoice"
    ? object.amount_paid
    : target.target === "charge"
      ? (object.amount_refunded ?? 0) > 0 ? object.amount_refunded : object.amount
      : target.target === "payment_intent"
        ? object.amount_received ?? object.amount
        : object.amount ?? object.amount_total;
  const period = periodFromStripeObject(object);
  const relatedPaymentObjectId = canonicalStripePaymentObjectId(object);
  return {
    ...target,
    authoritative: true,
    retrievedAt: normalizedIso(retrievedAt, "Stripe retrieval timestamp"),
    ...(object.status ? { status: object.status } : {}),
    ...(amount === undefined ? {} : { amount }),
    ...(object.currency ? { currency: object.currency } : {}),
    ...(typeof object.livemode === "boolean" ? { livemode: object.livemode } : {}),
    binding: bindingFromStripeObject(object),
    ...(period ?? {}),
    ...(relatedPaymentObjectId ? { relatedPaymentObjectId } : {}),
    ...(object.customer ? { customerId: object.customer } : {}),
    ...(object.object === "subscription" ? { subscriptionId: object.id } : object.subscription ? { subscriptionId: object.subscription } : {})
  };
}

export function reconcileStripeEvent<T extends NormalizedStripeEvent>(event: T, result: StripeReconciliationResult): ReconciledStripeEvent<T> | null {
  if (!result.authoritative || typeof result.livemode !== "boolean" || !result.status || Number.isNaN(Date.parse(result.retrievedAt))) return null;
  if (event.reconciliation.target !== result.target || event.reconciliation.objectId !== result.objectId) throw new Error("Stripe reconciliation target does not match observed event");
  if (result.binding && (
    (result.binding.workspaceId !== undefined && result.binding.workspaceId !== event.workspaceId)
    || (result.binding.companyId !== undefined && result.binding.companyId !== event.companyId)
    || (result.binding.kind !== undefined && result.binding.kind !== event.namespace)
  )) return null;
  if ((result.periodStart === undefined) !== (result.periodEnd === undefined)) return null;
  if (result.periodStart && result.periodEnd && normalizedIso(result.periodEnd, "Stripe period end") <= normalizedIso(result.periodStart, "Stripe period start")) return null;
  if (event.namespace === "operated_company_payment" && event.relatedPaymentObjectId && result.relatedPaymentObjectId && event.relatedPaymentObjectId !== result.relatedPaymentObjectId) return null;
  if (!matchesStripeStatus(event, result.status) || !matchesStripeValue(event.amount, result.amount) || !matchesStripeValue(event.currency, result.currency)) return null;
  return {
    ...event,
    verification: "authoritatively-reconciled",
    reconciledAt: normalizedIso(result.retrievedAt, "Stripe reconciliation timestamp"),
    providerMode: result.livemode ? "live" : "test",
    authoritativeStatus: result.status,
    ...(result.binding ? { providerBinding: result.binding } : {}),
    ...(result.periodStart ? { authoritativePeriodStart: normalizedIso(result.periodStart, "Stripe period start") } : {}),
    ...(result.periodEnd ? { authoritativePeriodEnd: normalizedIso(result.periodEnd, "Stripe period end") } : {}),
    ...(result.relatedPaymentObjectId ? { relatedPaymentObjectId: result.relatedPaymentObjectId } : {}),
    ...(result.customerId ? { customerId: result.customerId } : {}),
    ...(result.subscriptionId ? { subscriptionId: result.subscriptionId } : {})
  };
}

/** Revenue proof requires a reconciled live settled payment, never a trial or test event. */
export function isLiveSettledStripePayment(event: ReconciledStripeEvent): boolean {
  const paymentLedger = event.namespace === "saas_entitlement" ? event.observedEntitlement === "active" && event.reconciliation.target === "invoice" : event.observedKind === "payment" && ["charge", "payment_intent"].includes(event.reconciliation.target);
  return paymentLedger && event.providerMode === "live" && (event.amount ?? 0) > 0 && (event.reconciliation.target === "invoice" ? event.authoritativeStatus === "paid" : event.authoritativeStatus === "succeeded");
}

function stripePost(path: string, form: URLSearchParams): StripeRequest {
  return { url: `${STRIPE_API}/${path}`, body: form.toString() };
}

function stripeObjectUrl(target: StripeReconciliationTarget): string {
  const resources: Record<string, string> = { invoice: "invoices", charge: "charges", payment_intent: "payment_intents", refund: "refunds", dispute: "disputes", subscription: "subscriptions", "checkout.session": "checkout/sessions" };
  const resource = resources[target.target];
  if (!resource || !target.objectId) throw new Error("unsupported Stripe reconciliation target");
  return `${STRIPE_API}/${resource}/${encodeURIComponent(target.objectId)}`;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function entitlementFor(type: string, object: StripeObject): SaasEntitlementEvent["observedEntitlement"] | null {
  if (type === "checkout.session.completed") return "pending";
  if (type === "invoice.paid") return (object.amount_paid ?? 0) > 0 ? "active" : "trialing";
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    if (object.status === "trialing" || object.status === "active" || object.status === "past_due" || object.status === "unpaid") return object.status;
  }
  if (type === "invoice.payment_failed") return object.status === "unpaid" ? "unpaid" : "past_due";
  if (type === "charge.refunded") return "refunded";
  if (type === "charge.dispute.created") return "disputed";
  if (type === "charge.dispute.updated" && isOpenDisputeStatus(object.status)) return "disputed";
  if (type === "charge.dispute.closed") return object.status === "won" ? "active" : object.status === "lost" ? "disputed" : null;
  if (type === "customer.subscription.deleted") return "inactive";
  return null;
}

function paymentKindFor(type: string, object?: StripeObject): OperatedCompanyPaymentEvent["observedKind"] | null {
  if (type === "payment_intent.succeeded" || type === "charge.succeeded") return "payment";
  if (type === "charge.refunded" || type === "refund.created" || type === "refund.updated") return "refund";
  if (type === "charge.dispute.created") return "dispute";
  if (type === "charge.dispute.updated") return isOpenDisputeStatus(object?.status) ? "dispute" : null;
  if (type === "charge.dispute.closed") return object?.status === "won" ? "dispute_resolved" : object?.status === "lost" ? "dispute" : null;
  return null;
}

function isOpenDisputeStatus(status: string | undefined): boolean {
  return ["needs_response", "under_review", "warning_needs_response", "warning_under_review"].includes(String(status));
}

function matchesStripeValue(expected: number | string | undefined, actual: number | string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function matchesStripeStatus(event: NormalizedStripeEvent, status: string): boolean {
  if (event.namespace === "operated_company_payment") {
    if (event.observedKind === "dispute") return ["needs_response", "under_review", "lost", "warning_needs_response", "warning_under_review"].includes(status);
    if (event.observedKind === "dispute_resolved") return status === "won";
    return status === "succeeded";
  }
  if (event.observedEntitlement === "pending") return status === "complete";
  if (event.observedEntitlement === "active" || event.observedEntitlement === "trialing") {
    if (event.reconciliation.target === "dispute") return event.observedEntitlement === "active" && status === "won";
    return event.reconciliation.target === "invoice" ? status === "paid" : status === event.observedEntitlement;
  }
  if (event.observedEntitlement === "inactive") return status === "canceled";
  if (event.observedEntitlement === "refunded") return status === "succeeded";
  if (event.observedEntitlement === "disputed") return ["needs_response", "under_review", "lost", "warning_needs_response", "warning_under_review"].includes(status);
  return status === event.observedEntitlement;
}

function providerTimestamp(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid Stripe provider timestamp");
  return new Date(value * 1_000).toISOString();
}

function bindingFromStripeObject(object: StripeObject): StripeProviderBinding {
  const metadata = { ...object.parent?.subscription_details?.metadata, ...object.subscription_details?.metadata, ...object.metadata };
  const amount = /^\d+$/.test(metadata.opspot_amount ?? "") ? Number(metadata.opspot_amount) : undefined;
  return {
    ...(metadata.opspot_workspace_id ? { workspaceId: metadata.opspot_workspace_id } : {}),
    ...(metadata.opspot_company_id ? { companyId: metadata.opspot_company_id } : {}),
    ...(metadata.opspot_kind ? { kind: metadata.opspot_kind } : {}),
    ...(metadata.opspot_offer_id ? { offerId: metadata.opspot_offer_id } : {}),
    ...(typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 ? { amount } : {}),
    ...(metadata.opspot_currency ? { currency: metadata.opspot_currency.toLowerCase() } : {})
  };
}

function completeOperatedOfferBinding(binding: StripeProviderBinding): binding is StripeProviderBinding & Required<Pick<StripeProviderBinding, "workspaceId" | "companyId" | "kind" | "offerId" | "amount" | "currency">> {
  return completeBinding(binding) && binding.kind === "operated_company_payment" && Boolean(binding.offerId && binding.amount && binding.currency);
}

function completeBinding(binding: StripeProviderBinding): binding is StripeProviderBinding & Required<Pick<StripeProviderBinding, "workspaceId" | "companyId" | "kind">> {
  return Boolean(binding.workspaceId && binding.companyId && binding.kind);
}

function sameBinding(left: StripeProviderBinding, right: StripeProviderBinding): boolean {
  return left.workspaceId === right.workspaceId && left.companyId === right.companyId && left.kind === right.kind
    && compatibleOptional(left.offerId, right.offerId)
    && compatibleOptional(left.amount, right.amount)
    && compatibleOptional(left.currency, right.currency);
}

function exactOperatedBinding(
  left: StripeProviderBinding & Required<Pick<StripeProviderBinding, "workspaceId" | "companyId" | "kind" | "offerId" | "amount" | "currency">>,
  right: StripeProviderBinding & Required<Pick<StripeProviderBinding, "workspaceId" | "companyId" | "kind" | "offerId" | "amount" | "currency">>
): boolean {
  return left.workspaceId === right.workspaceId && left.companyId === right.companyId && left.kind === right.kind
    && left.offerId === right.offerId && left.amount === right.amount && left.currency === right.currency;
}

function compatibleOptional(left: string | number | undefined, right: string | number | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function canonicalStripePaymentObjectId(object: StripeObject): string | undefined {
  if (object.payment_intent) return object.payment_intent;
  if (object.object === "payment_intent") return object.id;
  if (object.object === "charge") return object.id;
  return object.charge;
}

function preferredPaymentIdentity(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current || candidate.startsWith("pi_")) return candidate;
  return current;
}

function periodFromStripeObject(object: StripeObject): { periodStart: string; periodEnd: string } | undefined {
  const periods: Array<{ start: number; end: number }> = [];
  if (object.object === "invoice") {
    for (const line of object.lines?.data ?? []) {
      if (line.type !== "subscription" && line.parent?.type !== "subscription_item_details") continue;
      if (line.period?.start !== undefined && line.period.end !== undefined) periods.push({ start: line.period.start, end: line.period.end });
    }
  }
  if (object.object === "subscription") {
    for (const item of object.items?.data ?? []) {
      if (item.current_period_start !== undefined && item.current_period_end !== undefined) periods.push({ start: item.current_period_start, end: item.current_period_end });
    }
    if (object.current_period_start !== undefined && object.current_period_end !== undefined) periods.push({ start: object.current_period_start, end: object.current_period_end });
  }
  const unique = [...new Map(periods.map((period) => [`${period.start}:${period.end}`, period])).values()];
  if (unique.length !== 1) return undefined;
  const periodStart = providerTimestamp(unique[0]!.start)!;
  const periodEnd = providerTimestamp(unique[0]!.end)!;
  if (periodEnd <= periodStart) throw new Error("Stripe authoritative period end must follow period start");
  return { periodStart, periodEnd };
}

function stripeReferences(object: StripeObject): StripeReconciliationTarget[] {
  const values: Array<[string, string | undefined]> = [
    ["charge", object.charge],
    ["charge", object.latest_charge],
    ["payment_intent", object.payment_intent],
    ["invoice", object.invoice],
    ["subscription", object.subscription],
    ["subscription", object.parent?.subscription_details?.subscription],
    ["subscription", object.subscription_details?.subscription],
    ["dispute", typeof object.dispute === "string" ? object.dispute : object.dispute?.id]
  ];
  return values.flatMap(([target, objectId]) => objectId ? [{ target, objectId }] : []);
}

function normalizedIso(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${label}`);
  return date.toISOString();
}
