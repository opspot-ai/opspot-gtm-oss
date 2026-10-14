import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type DigitalAccessRecord = {
  namespace: "digital_access";
  eventId: string;
  dedupeKey: string;
  companyId: string;
  subjectId: string;
  action: "grant" | "revoke" | "confirm";
  occurredAt: string;
  status: "granted" | "revoked" | "confirmed";
};

export function digitalAccessRecord(input: Omit<DigitalAccessRecord, "namespace" | "dedupeKey" | "status">): DigitalAccessRecord {
  return {
    namespace: "digital_access",
    dedupeKey: `digital-access:${input.companyId}:${input.eventId}`,
    status: input.action === "grant" ? "granted" : input.action === "revoke" ? "revoked" : "confirmed",
    ...input
  };
}

export type FirstPartyEvent = {
  namespace: "first_party_event";
  eventId: string;
  dedupeKey: string;
  companyId: string;
  type: string;
  occurredAt: string;
};

export function normalizeFirstPartyEvent(input: { id: string; companyId: string; type: string; occurredAt: string | Date; properties?: Record<string, unknown> }): FirstPartyEvent {
  const occurredAt = new Date(input.occurredAt).toISOString();
  if (!input.id || !input.companyId || !input.type || Number.isNaN(Date.parse(occurredAt))) throw new Error("first-party event requires id, companyId, type, and occurredAt");
  return { namespace: "first_party_event", eventId: input.id, dedupeKey: `first-party:${input.companyId}:${input.id}`, companyId: input.companyId, type: input.type, occurredAt };
}

export const GENERIC_WEBHOOK_TOLERANCE_SECONDS = 300;

export type SignedGenericWebhookEnvelope = {
  signer: string;
  timestamp: number;
  signature: string;
  rawBody: string | Uint8Array;
};

export type GenericWebhookEvent = {
  namespace: "generic_webhook";
  signer: string;
  eventId: string;
  type: string;
  occurredAt: string;
  dedupeKey: string;
  rawBodyHash: string;
};

export function verifyGenericWebhookSignature(envelope: SignedGenericWebhookEnvelope, signingSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!envelope.signature || !envelope.signer || !signingSecret || !Number.isSafeInteger(envelope.timestamp) || !Number.isSafeInteger(nowSeconds) || !(typeof envelope.rawBody === "string" || envelope.rawBody instanceof Uint8Array) || Math.abs(nowSeconds - envelope.timestamp) > GENERIC_WEBHOOK_TOLERANCE_SECONDS) return false;
  const body = Buffer.from(envelope.rawBody);
  const expected = createHmac("sha256", signingSecret).update(Buffer.concat([Buffer.from(`${envelope.timestamp}.`), body])).digest();
  const supplied = envelope.signature.replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const received = Buffer.from(supplied, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function ingestGenericWebhook(envelope: SignedGenericWebhookEnvelope, signingSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): GenericWebhookEvent {
  if (!verifyGenericWebhookSignature(envelope, signingSecret, nowSeconds)) throw new Error("invalid or stale generic webhook signature");
  const raw = Buffer.from(envelope.rawBody);
  const payload: unknown = JSON.parse(raw.toString("utf8"));
  if (!isRecord(payload) || !isText(payload.id) || !isText(payload.type) || !isText(payload.occurredAt) || Number.isNaN(Date.parse(payload.occurredAt))) {
    throw new Error("generic webhook requires object id, type, and occurredAt");
  }
  return { namespace: "generic_webhook", signer: envelope.signer, eventId: payload.id, type: payload.type, occurredAt: new Date(payload.occurredAt).toISOString(), dedupeKey: `generic-webhook:${envelope.signer}:${payload.id}`, rawBodyHash: createHash("sha256").update(raw).digest("hex") };
}

export type AuthoritativeOutcomeConfirmation = {
  confirmationId: string;
  kind: "payment" | "fulfillment";
  companyId: string;
  provider: string;
  objectId: string;
  evidenceHash: string;
  confirmedAt: string;
};

export type GenericOutcomeAttestation = {
  namespace: "generic_outcome_attestation";
  kind: "payment" | "fulfillment";
  attestationId: string;
  companyId: string;
  signer: string;
  authoritativeProvider: string;
  authoritativeObjectId: string;
  evidenceHash: string;
  dedupeKey: string;
  occurredAt: string;
  status: "unverified" | "verified";
  proofTier: "unverified" | "revenue-verified" | "fulfillment-verified";
  confirmationId?: string;
  confirmedAt?: string;
};

export function genericOutcomeAttestation(input: { kind: "payment" | "fulfillment"; attestationId: string; companyId: string; signer: string; authoritativeProvider: string; authoritativeObjectId: string; evidenceHash: string; occurredAt: string | Date }): GenericOutcomeAttestation {
  const occurredAt = new Date(input.occurredAt).toISOString();
  if (!input.attestationId || !input.companyId || !input.signer || !input.authoritativeProvider || !input.authoritativeObjectId || !isSha256(input.evidenceHash) || Number.isNaN(Date.parse(occurredAt))) throw new Error("generic attestation requires ids, signer, authoritative provider/object, evidence hash, and occurredAt");
  return { namespace: "generic_outcome_attestation", ...input, evidenceHash: input.evidenceHash.toLowerCase(), occurredAt, dedupeKey: `generic-attestation:${input.kind}:${input.companyId}:${input.attestationId}`, status: "unverified", proofTier: "unverified" };
}

export function reconcileGenericOutcomeAttestation(attestation: GenericOutcomeAttestation, confirmation: AuthoritativeOutcomeConfirmation): GenericOutcomeAttestation {
  if (!confirmation.confirmationId || !isText(confirmation.confirmedAt) || Number.isNaN(Date.parse(confirmation.confirmedAt)) || !isSha256(confirmation.evidenceHash) || confirmation.kind !== attestation.kind || confirmation.companyId !== attestation.companyId || confirmation.provider !== attestation.authoritativeProvider || confirmation.objectId !== attestation.authoritativeObjectId || confirmation.evidenceHash.toLowerCase() !== attestation.evidenceHash) return attestation;
  return { ...attestation, status: "verified", proofTier: attestation.kind === "payment" ? "revenue-verified" : "fulfillment-verified", confirmationId: confirmation.confirmationId, confirmedAt: new Date(confirmation.confirmedAt).toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
