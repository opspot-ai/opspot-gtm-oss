import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digitalAccessRecord, genericOutcomeAttestation, ingestGenericWebhook, normalizeFirstPartyEvent, reconcileGenericOutcomeAttestation, verifyGenericWebhookSignature } from "../packages/adapters/src/outcomes.js";

describe("outcome adapters", () => {
  it("creates explicit built-in digital access records", () => {
    expect(digitalAccessRecord({ eventId: "access_1", companyId: "company_1", subjectId: "user_1", action: "grant", occurredAt: "2026-07-20T12:00:00Z" })).toMatchObject({ status: "granted", dedupeKey: "digital-access:company_1:access_1" });
    expect(digitalAccessRecord({ eventId: "access_2", companyId: "company_1", subjectId: "user_1", action: "revoke", occurredAt: "2026-07-20T12:00:00Z" }).status).toBe("revoked");
    expect(digitalAccessRecord({ eventId: "access_3", companyId: "company_1", subjectId: "user_1", action: "confirm", occurredAt: "2026-07-20T12:00:00Z" }).status).toBe("confirmed");
  });

  it("normalizes first-party analytics events with a company-scoped dedupe key", () => {
    const event = normalizeFirstPartyEvent({ id: "event_1", companyId: "company_1", type: "page_view", occurredAt: "2026-07-20T12:00:00Z", properties: { token: "must-not-leak" } });
    expect(event).toMatchObject({ namespace: "first_party_event", dedupeKey: "first-party:company_1:event_1" });
    expect(JSON.stringify(event)).not.toContain("must-not-leak");
  });

  it("verifies a fresh timestamped raw body and emits signer-scoped webhook dedupe", () => {
    const rawBody = '{"id":"hook_1","type":"payment.attested","occurredAt":"2026-07-20T12:00:00Z","secret":"must-not-leak"}';
    const timestamp = 1_000;
    const signature = createHmac("sha256", "secret").update(`${timestamp}.${rawBody}`).digest("hex");
    const envelope = { rawBody, timestamp, signature, signer: "customer-payment-system" };
    expect(verifyGenericWebhookSignature(envelope, "secret", 1_100)).toBe(true);
    expect(verifyGenericWebhookSignature({ ...envelope, rawBody: `${rawBody} ` }, "secret", 1_100)).toBe(false);
    expect(verifyGenericWebhookSignature(envelope, "secret", 1_301)).toBe(false);
    expect(verifyGenericWebhookSignature(envelope, "secret", Number.NaN)).toBe(false);
    const event = ingestGenericWebhook(envelope, "secret", 1_100);
    expect(event).toMatchObject({ dedupeKey: "generic-webhook:customer-payment-system:hook_1" });
    expect(JSON.stringify(event)).not.toContain("must-not-leak");
  });

  it("does not upgrade generic payment or fulfillment attestations without matching authority confirmation", () => {
    const evidenceHash = "a".repeat(64);
    const payment = genericOutcomeAttestation({ kind: "payment", attestationId: "payment_1", companyId: "company_1", signer: "customer", authoritativeProvider: "Acme Payments", authoritativeObjectId: "pay_1", evidenceHash, occurredAt: "2026-07-20T12:00:00Z" });
    const confirmation = { confirmationId: "opaque-confirmation-1", kind: "payment" as const, companyId: "company_1", provider: "Acme Payments", objectId: "pay_1", evidenceHash, confirmedAt: "2026-07-20T12:01:00Z" };
    expect(reconcileGenericOutcomeAttestation(payment, { ...confirmation, objectId: "other" }).status).toBe("unverified");
    expect(reconcileGenericOutcomeAttestation(payment, { ...confirmation, provider: "other" }).status).toBe("unverified");
    expect(reconcileGenericOutcomeAttestation(payment, { ...confirmation, evidenceHash: "b".repeat(64) }).status).toBe("unverified");
    expect(reconcileGenericOutcomeAttestation(payment, confirmation)).toMatchObject({ status: "verified", proofTier: "revenue-verified", confirmationId: "opaque-confirmation-1" });
    const fulfillment = genericOutcomeAttestation({ kind: "fulfillment", attestationId: "delivery_1", companyId: "company_1", signer: "customer", authoritativeProvider: "Acme Access", authoritativeObjectId: "access_1", evidenceHash, occurredAt: "2026-07-20T12:00:00Z" });
    expect(reconcileGenericOutcomeAttestation(fulfillment, { ...confirmation, confirmationId: "opaque-confirmation-2", kind: "fulfillment", provider: "Acme Access", objectId: "access_1" }).proofTier).toBe("fulfillment-verified");
  });
});
