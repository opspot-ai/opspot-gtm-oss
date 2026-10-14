import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type EmailSendInput = {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
};

export type EmailEnvelope = {
  ownedSenders: readonly string[];
  ownedRecipients: readonly string[];
  suppressedRecipients: readonly string[];
  dailyCap: number;
  weeklyCap: number;
  sentToday: number;
  sentThisWeek: number;
  quietHours?: { startHour: number; endHour: number; timeZone: string };
  now?: Date;
};

export type EmailDecision = { allowed: true } | { allowed: false; reason: string };
export type ResendRequest = { url: string; body: string };
export type ResendSourceBinding = { workspaceId: string; companyId: string };
export type VerifiedResendWebhook = { payload: Record<string, unknown>; dedupeKey: string; sourceBinding?: ResendSourceBinding };
export type ResendEmailEvent = {
  provider: "resend";
  verification: "signed-webhook";
  eventId: string;
  dedupeKey: string;
  kind: "sent" | "delivered" | "bounced" | "complained" | "suppressed" | "unsubscribed" | "reply";
  emailId: string;
  occurredAt: string;
  recipient?: string;
  recipients: string[];
  sender?: string;
  payloadHash: string;
  sourceBinding?: ResendSourceBinding;
};
export type ReconciledResendEmail = {
  provider: "resend";
  verification: "provider-retrieved";
  emailId: string;
  recipients: string[];
  lastEvent: string;
  createdAt: string;
  retrievedAt: string;
  sourceBinding: ResendSourceBinding;
};
export type ReconciledResendReceivedEmail = {
  provider: "resend";
  verification: "provider-retrieved";
  emailId: string;
  sender: string;
  recipients: string[];
  inReplyTo: string[];
  references: string[];
  retrievedAt: string;
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const EVENT_KIND = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.suppressed": "suppressed",
  "email.received": "reply"
} as const;

function address(value: string): string {
  const matched = /<([^<>]+)>$/.exec(value.trim());
  const email = (matched?.[1] ?? value).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`invalid email address: ${value}`);
  return email;
}

function contains(values: readonly string[], value: string): boolean {
  return values.some((candidate) => address(candidate) === value);
}

function currentHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(now).find((part) => part.type === "hour")?.value;
  if (!hour) throw new Error(`could not resolve quiet-hours time zone: ${timeZone}`);
  return Number(hour);
}

function inQuietHours(hour: number, quietHours: NonNullable<EmailEnvelope["quietHours"]>): boolean {
  const { startHour, endHour } = quietHours;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) throw new Error("quiet hours must use whole hours from 0 through 23");
  return startHour === endHour || (startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour);
}

/** Pure, fail-closed permission check; storage supplies the already-counted windows. */
export function decideEmailSend(input: EmailSendInput, envelope: EmailEnvelope): EmailDecision {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to]).map(address);
  if (!input.subject.trim() || (!input.html?.trim() && !input.text?.trim())) return { allowed: false, reason: "subject and html or text are required" };
  if (!contains(envelope.ownedSenders, address(input.from))) return { allowed: false, reason: "sender is not verified and owned" };
  if (!recipients.length || recipients.some((recipient) => !contains(envelope.ownedRecipients, recipient))) return { allowed: false, reason: "recipient is not an owned test endpoint" };
  if (recipients.some((recipient) => contains(envelope.suppressedRecipients, recipient))) return { allowed: false, reason: "recipient is suppressed" };
  if (!Number.isInteger(envelope.dailyCap) || !Number.isInteger(envelope.weeklyCap) || envelope.dailyCap < 0 || envelope.weeklyCap < 0) return { allowed: false, reason: "email caps are invalid" };
  if (envelope.sentToday >= envelope.dailyCap) return { allowed: false, reason: "daily email cap reached" };
  if (envelope.sentThisWeek >= envelope.weeklyCap) return { allowed: false, reason: "weekly email cap reached" };
  if (envelope.quietHours && inQuietHours(currentHour(envelope.now ?? new Date(), envelope.quietHours.timeZone), envelope.quietHours)) return { allowed: false, reason: "quiet hours are active" };
  return { allowed: true };
}

export function resendOutboundRequest(input: EmailSendInput, envelope: EmailEnvelope): ResendRequest {
  const decision = decideEmailSend(input, envelope);
  if (!decision.allowed) throw new Error(`email blocked: ${decision.reason}`);
  const tags = input.tags?.map((tag) => {
    if (!TAG.test(tag.name) || !TAG.test(tag.value)) throw new Error("Resend tags must be bounded ASCII identifiers");
    return { name: tag.name, value: tag.value };
  });
  return {
    url: "https://api.resend.com/emails",
    body: JSON.stringify({ from: input.from, to: Array.isArray(input.to) ? input.to : [input.to], subject: input.subject, ...(input.html ? { html: input.html } : {}), ...(input.text ? { text: input.text } : {}), ...(input.replyTo ? { reply_to: address(input.replyTo) } : {}), ...(input.headers ? { headers: input.headers } : {}), ...(tags ? { tags } : {}) })
  };
}

export class ResendEmailAdapter {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(input: EmailSendInput, envelope: EmailEnvelope, idempotencyKey?: string): Promise<{ id: string }> {
    if (!this.apiKey.trim()) throw new Error("Resend API key is required");
    if (idempotencyKey !== undefined && (!/^[A-Za-z0-9._:-]{1,256}$/.test(idempotencyKey))) throw new Error("invalid Resend idempotency key");
    const request = resendOutboundRequest(input, envelope);
    const response = await this.fetchImpl(request.url, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: request.body });
    const body = await response.json().catch(() => { throw new Error("Resend response is not JSON"); }) as { id?: unknown };
    if (!response.ok) throw new Error(`Resend email API error ${response.status}`);
    if (typeof body.id !== "string" || !body.id) throw new Error("Resend response is missing email id");
    return { id: body.id };
  }

  async retrieve(emailId: string, sourceBinding: ResendSourceBinding, retrievedAt = new Date().toISOString()): Promise<ReconciledResendEmail> {
    if (!this.apiKey.trim()) throw new Error("Resend API key is required");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(emailId)) throw new Error("invalid Resend email id");
    const response = await this.fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    const body = await response.json().catch(() => { throw new Error("Resend response is not JSON"); }) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Resend email API error ${response.status}`);
    const recipients = Array.isArray(body.to) ? body.to.map((value) => typeof value === "string" ? address(value) : "") : [];
    const providerBinding = sourceBindingFromTags(body.tags);
    const createdAt = typeof body.created_at === "string" ? normalizedIso(body.created_at, "Resend email creation timestamp") : undefined;
    if (body.object !== "email" || body.id !== emailId || recipients.some((value) => !value) || !recipients.length || typeof body.last_event !== "string" || !body.last_event || !createdAt || !providerBinding
      || providerBinding.workspaceId !== sourceBinding.workspaceId || providerBinding.companyId !== sourceBinding.companyId) {
      throw new Error("Resend retrieved email is missing authoritative fields");
    }
    return { provider: "resend", verification: "provider-retrieved", emailId, recipients, lastEvent: body.last_event, createdAt, retrievedAt: normalizedIso(retrievedAt, "Resend retrieval timestamp"), sourceBinding: providerBinding };
  }

  /** Retrieves a received email because email.received webhooks intentionally omit headers and bodies. */
  async retrieveReceived(emailId: string, retrievedAt = new Date().toISOString()): Promise<ReconciledResendReceivedEmail> {
    if (!this.apiKey.trim()) throw new Error("Resend API key is required");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(emailId)) throw new Error("invalid Resend email id");
    const response = await this.fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    const body = await response.json().catch(() => { throw new Error("Resend response is not JSON"); }) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Resend email API error ${response.status}`);
    const recipients = Array.isArray(body.to) ? body.to.map((value) => typeof value === "string" ? address(value) : "") : [];
    const sender = typeof body.from === "string" ? address(body.from) : undefined;
    const headers = body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
      ? body.headers as Record<string, unknown>
      : undefined;
    if (body.object !== "email" || body.id !== emailId || !sender || recipients.some((value) => !value) || !recipients.length || !headers) {
      throw new Error("Resend retrieved received email is missing authoritative fields");
    }
    return {
      provider: "resend",
      verification: "provider-retrieved",
      emailId,
      sender,
      recipients,
      inReplyTo: messageIdTokens(headerValue(headers, "in-reply-to")),
      references: messageIdTokens(headerValue(headers, "references")),
      retrievedAt: normalizedIso(retrievedAt, "Resend retrieval timestamp")
    };
  }
}

function header(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  return headers instanceof Headers ? headers.get(name) ?? undefined : headers[name] ?? headers[name.toLowerCase()];
}

/** Verifies the raw Svix-compatible Resend signature and freshness before parsing the event. */
export function verifyResendWebhook(
  rawBody: string,
  headers: Headers | Record<string, string | undefined>,
  signingSecret: string,
  options: { now?: Date; toleranceSeconds?: number; sourceBinding?: ResendSourceBinding } = {}
): VerifiedResendWebhook {
  const id = header(headers, "svix-id");
  const timestamp = header(headers, "svix-timestamp");
  const signatures = header(headers, "svix-signature");
  if (!id || !timestamp || !signatures || !signingSecret.startsWith("whsec_")) throw new Error("invalid Resend webhook signature headers");
  const key = Buffer.from(signingSecret.slice("whsec_".length), "base64");
  if (!key.length) throw new Error("invalid Resend webhook signing secret");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  const verified = signatures.split(" ").some((entry) => {
    const [, signature] = entry.split(",", 2);
    if (!signature) return false;
    const received = Buffer.from(signature, "base64");
    const wanted = Buffer.from(expected, "base64");
    return received.length === wanted.length && timingSafeEqual(received, wanted);
  });
  if (!verified) throw new Error("invalid Resend webhook signature");
  const timestampSeconds = Number(timestamp);
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isInteger(timestampSeconds) || !Number.isFinite(nowMs) || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) throw new Error("invalid Resend webhook timestamp configuration");
  if (Math.abs(nowMs - timestampSeconds * 1_000) > toleranceSeconds * 1_000) throw new Error("Resend webhook timestamp is outside tolerance");
  const parsed: unknown = JSON.parse(rawBody);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Resend webhook body must be an object");
  return { payload: parsed as Record<string, unknown>, dedupeKey: id, ...(options.sourceBinding ? { sourceBinding: options.sourceBinding } : {}) };
}

export function normalizeResendWebhook(verified: VerifiedResendWebhook): ResendEmailEvent {
  const { payload, dedupeKey } = verified;
  const type = payload.type;
  const data = payload.data;
  if (typeof type !== "string" || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("unsupported Resend email webhook event");
  const eventData = data as Record<string, unknown>;
  const taggedBinding = sourceBindingFromTags(eventData.tags);
  if (taggedBinding && verified.sourceBinding && (taggedBinding.workspaceId !== verified.sourceBinding.workspaceId || taggedBinding.companyId !== verified.sourceBinding.companyId)) {
    throw new Error("Resend webhook connector and provider tags disagree");
  }
  const sourceBinding = taggedBinding ?? verified.sourceBinding;
  if (type === "contact.updated") {
    const contactId = typeof eventData.id === "string" ? eventData.id : undefined;
    const occurredAt = typeof payload.created_at === "string" ? normalizedIso(payload.created_at, "Resend webhook timestamp") : undefined;
    const recipient = typeof eventData.email === "string" ? address(eventData.email) : undefined;
    if (!contactId || !occurredAt || !recipient || eventData.unsubscribed !== true) throw new Error("unsupported Resend contact update");
    return { provider: "resend", verification: "signed-webhook", eventId: dedupeKey, dedupeKey, kind: "unsubscribed", emailId: contactId, occurredAt, recipient, recipients: [recipient], payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), ...(sourceBinding ? { sourceBinding } : {}) };
  }
  if (!(type in EVENT_KIND)) throw new Error("unsupported Resend email webhook event");
  const emailId = typeof eventData.email_id === "string" ? eventData.email_id : typeof eventData.id === "string" ? eventData.id : undefined;
  const occurredAtValue = typeof payload.created_at === "string" ? payload.created_at : typeof eventData.created_at === "string" ? eventData.created_at : undefined;
  const occurredAt = occurredAtValue ? normalizedIso(occurredAtValue, "Resend webhook timestamp") : undefined;
  if (!emailId || !occurredAt) throw new Error("Resend email webhook is missing email id or timestamp");
  const recipients = typeof eventData.to === "string"
    ? [address(eventData.to)]
    : Array.isArray(eventData.to)
      ? eventData.to.map((value) => typeof value === "string" ? address(value) : "").filter(Boolean)
      : [];
  const recipient = recipients[0];
  const sender = type === "email.received" && typeof eventData.from === "string" ? address(eventData.from) : undefined;
  const messageId = type === "email.received" && typeof eventData.message_id === "string" ? eventData.message_id.trim() : undefined;
  if (type === "email.received" && (!sender || !recipients.length || !messageId)) {
    throw new Error("Resend received-email webhook is missing documented metadata");
  }
  return { provider: "resend", verification: "signed-webhook", eventId: dedupeKey, dedupeKey, kind: EVENT_KIND[type as keyof typeof EVENT_KIND], emailId, occurredAt, ...(recipient ? { recipient } : {}), recipients, ...(sender ? { sender } : {}), payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), ...(sourceBinding ? { sourceBinding } : {}) };
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const matched = Object.entries(headers).find(([key, value]) => key.toLowerCase() === name && typeof value === "string")?.[1];
  return typeof matched === "string" ? matched : undefined;
}

function messageIdTokens(value: string | undefined): string[] {
  if (!value || value.length > 8_192) return [];
  return value.match(/<[^<>\s]{1,998}>/g) ?? [];
}

function sourceBindingFromTags(value: unknown): ResendSourceBinding | undefined {
  const pairs = Array.isArray(value)
    ? value.flatMap((item) => item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).value === "string"
      ? [[String((item as Record<string, unknown>).name), String((item as Record<string, unknown>).value)] as const]
      : [])
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).flatMap(([name, tagValue]) => typeof tagValue === "string" ? [[name, tagValue] as const] : [])
      : [];
  const tags = new Map(pairs);
  const workspaceId = tags.get("opspot_workspace");
  const companyId = tags.get("opspot_company");
  return workspaceId && companyId ? { workspaceId, companyId } : undefined;
}

function normalizedIso(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${label}`);
  return date.toISOString();
}
