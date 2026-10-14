import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ResendEmailAdapter, decideEmailSend, normalizeResendWebhook, resendOutboundRequest, verifyResendWebhook } from "../packages/adapters/src/resend.js";

const input = { from: "OpSpot <sender@opspot.test>", to: "receiver@opspot.test", subject: "Test", text: "hello" };
const envelope = { ownedSenders: ["sender@opspot.test"], ownedRecipients: ["receiver@opspot.test"], suppressedRecipients: [], dailyCap: 3, weeklyCap: 10, sentToday: 0, sentThisWeek: 0 };

describe("Resend email adapter", () => {
  it("builds the only outbound request and rejects unowned or suppressed mail", async () => {
    const request = resendOutboundRequest(input, envelope);
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(JSON.stringify(request)).not.toContain("re_test");
    expect(JSON.parse(request.body)).toMatchObject({ from: input.from, to: [input.to], subject: "Test", text: "hello" });
    expect(() => resendOutboundRequest({ ...input, to: "outside@example.com" }, envelope)).toThrow(/owned test endpoint/);
    expect(decideEmailSend(input, { ...envelope, suppressedRecipients: [input.to] })).toEqual({ allowed: false, reason: "recipient is suppressed" });
    expect(decideEmailSend(input, { ...envelope, sentToday: 3 })).toEqual({ allowed: false, reason: "daily email cap reached" });
    expect(decideEmailSend(input, { ...envelope, quietHours: { startHour: 9, endHour: 17, timeZone: "UTC" }, now: new Date("2026-07-20T12:00:00Z") })).toEqual({ allowed: false, reason: "quiet hours are active" });
    const adapter = new ResendEmailAdapter("re_test", async () => new Response(JSON.stringify({ id: "email_123" })));
    await expect(adapter.send(input, envelope)).resolves.toEqual({ id: "email_123" });
  });

  it("verifies and normalizes delivery, failure, suppression, and reply events with string or array recipients", () => {
    const secret = `whsec_${Buffer.from("webhook-secret").toString("base64")}`;
    const now = new Date("2026-07-20T12:00:00.000Z");
    const timestamp = String(now.getTime() / 1_000);
    for (const [type, kind] of Object.entries({ "email.sent": "sent", "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.suppressed": "suppressed", "email.received": "reply" })) {
      const raw = JSON.stringify({ id: `evt_${kind}`, type, created_at: "2026-07-20T12:00:00.000Z", data: { email_id: "email_123", to: type === "email.delivered" ? [input.to] : input.to, ...(type === "email.received" ? { from: "sender@example.test", message_id: "<received@example.test>" } : {}) } });
      const id = "msg_123";
      const signature = createHmac("sha256", Buffer.from("webhook-secret")).update(`${id}.${timestamp}.${raw}`).digest("base64");
      const headers = { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
      const verified = verifyResendWebhook(raw, headers, secret, { now });
      expect(normalizeResendWebhook(verified)).toMatchObject({ provider: "resend", eventId: id, dedupeKey: id, kind, emailId: "email_123", recipient: input.to });
      expect(verifyResendWebhook(raw, headers, secret, { now }).dedupeKey).toBe(verified.dedupeKey);
      expect(() => verifyResendWebhook(raw, { ...headers, "svix-signature": "v1,bad" }, secret, { now })).toThrow(/invalid Resend webhook signature/);
    }
  });

  it("retrieves inbound headers from the documented receiving endpoint and tokenizes only exact reference identifiers", async () => {
    const adapter = new ResendEmailAdapter("re_test", async (url, init) => {
      expect(String(url)).toBe("https://api.resend.com/emails/receiving/email_received");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test");
      return Response.json({ object: "email", id: "email_received", from: "Sender <sender@example.test>", to: ["receiver@opspot.test"], headers: { "IN-REPLY-TO": "<OpSpot.Thread@thread.opspot.invalid>", references: "<older@example.test> <OpSpot.Thread@thread.opspot.invalid>" } });
    });
    await expect(adapter.retrieveReceived("email_received", "2026-07-20T12:00:00.000Z")).resolves.toMatchObject({
      sender: "sender@example.test",
      recipients: ["receiver@opspot.test"],
      inReplyTo: ["<OpSpot.Thread@thread.opspot.invalid>"],
      references: ["<older@example.test>", "<OpSpot.Thread@thread.opspot.invalid>"]
    });
  });

  it("rejects a correctly signed stale webhook", () => {
    const secretBytes = Buffer.from("webhook-secret");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const raw = JSON.stringify({ type: "email.sent", created_at: "2024-01-01T00:00:00.000Z", data: { email_id: "email_stale" } });
    const id = "msg_stale";
    const timestamp = String(new Date("2024-01-01T00:00:00.000Z").getTime() / 1_000);
    const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${raw}`).digest("base64");
    expect(() => verifyResendWebhook(raw, { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, secret, { now: new Date("2026-07-20T12:00:00.000Z") })).toThrow(/outside tolerance/);
  });
});
