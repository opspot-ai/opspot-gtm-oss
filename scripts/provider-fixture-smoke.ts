import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResendEmailAdapter, StripeAdapter, normalizeResendWebhook, normalizeStripeEvent, verifyResendWebhook, type StripeEvent } from "@opspot/adapters";
import { CompanyStateSchema, localExecutionContext, nowIso } from "@opspot/contracts";
import { createDefaultRuntime, GoldenProviderProofService } from "@opspot/domain";
import { SqliteKernelStorage } from "@opspot/storage";

const root = await mkdtemp(path.join(tmpdir(), "opspot-provider-fixture-"));
const context = localExecutionContext("worker");
const runtime = createDefaultRuntime({ root, context });
try {
  const boot = await runtime.service.execute("company.bootstrap", { idea: "A fixture-only digital company exercising production-shaped provider contracts", owner: "provider-fixture-smoke", requestedAt: nowIso(), idempotencyKey: "provider-fixture-bootstrap" }, context);
  if (!boot.ok) throw new Error(boot.error?.message);
  const companyId = String((boot.data as { ventureId?: string }).ventureId);
  const run = await runtime.service.execute("company.run", { ventureId: companyId, requestedAt: nowIso(), idempotencyKey: "provider-fixture-run" }, context);
  if (!run.ok) throw new Error(run.error?.message);
  const storage = new SqliteKernelStorage(runtime.storage);
  const scope = { workspaceId: context.workspaceId, companyId };
  const proof = new GoldenProviderProofService(storage);

  const recipient = "owned@example.test";
  const resend = new ResendEmailAdapter("re_fixture", async (_input, init) => init?.method === "POST"
    ? Response.json({ id: "email_fixture" })
    : Response.json({ object: "email", id: "email_fixture", to: [recipient], created_at: nowIso(), last_event: "delivered", tags: [{ name: "opspot_workspace", value: scope.workspaceId }, { name: "opspot_company", value: companyId }] }));
  const sent = await resend.send({ from: "sender@example.test", to: recipient, subject: "Fixture", text: "Fixture-only owned endpoint", tags: [{ name: "opspot_workspace", value: scope.workspaceId }, { name: "opspot_company", value: companyId }] }, { ownedSenders: ["sender@example.test"], ownedRecipients: [recipient], suppressedRecipients: [], dailyCap: 1, weeklyCap: 1, sentToday: 0, sentThisWeek: 0 }, "provider-fixture-email");
  const retrieved = await resend.retrieve(sent.id, scope);
  const webhookKey = Buffer.from("provider-fixture-resend-secret");
  const webhookSecret = `whsec_${webhookKey.toString("base64")}`;
  const payload = { type: "email.delivered", created_at: nowIso(), data: { email_id: sent.id, to: [recipient], tags: [{ name: "opspot_workspace", value: scope.workspaceId }, { name: "opspot_company", value: companyId }] } };
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", webhookKey).update(`fixture-email.${timestamp}.${raw}`).digest("base64");
  const email = normalizeResendWebhook(verifyResendWebhook(raw, { "svix-id": "fixture-email", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, webhookSecret, { sourceBinding: scope }));
  await proof.ingestEmail(email, scope, retrieved);

  const metadata = { opspot_workspace_id: scope.workspaceId, opspot_company_id: companyId, opspot_kind: "operated_company_payment" };
  const stripeObject = { id: "pi_fixture", object: "payment_intent", status: "succeeded", amount: 1200, amount_received: 1200, currency: "usd", livemode: false, metadata };
  const stripe = new StripeAdapter("sk_test_fixture", async () => Response.json(stripeObject));
  const rawPayment: StripeEvent = { id: "evt_fixture_payment", type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), data: { object: stripeObject } };
  const observed = normalizeStripeEvent(rawPayment);
  if (!observed || observed.namespace !== "operated_company_payment") throw new Error("fixture payment did not normalize");
  const payment = await stripe.reconcile(observed);
  if (!payment || payment.namespace !== "operated_company_payment") throw new Error("fixture payment did not reconcile");
  const access = { key: Buffer.alloc(32, 7), keyId: "fixture-access-v1" };
  await proof.grantDigitalAccess(payment, scope, access);
  const redemption = await proof.redeemDigitalAccess(scope, "pi_fixture", "test", access, { allowFixture: true });
  if (!redemption.delivered) throw new Error("fixture access was not delivered");
  await proof.useDigitalAccess(scope, redemption.accessSecret, "fixture-use-first", { allowFixture: true });
  const company = await storage.getCompany(scope.workspaceId, scope.companyId);
  if (!company) throw new Error("fixture company disappeared before retention check");
  await storage.updateCompanyState(scope.workspaceId, scope.companyId, company.stateVersion, JSON.parse(JSON.stringify(CompanyStateSchema.parse({
    ...CompanyStateSchema.parse(company.state),
    version: company.stateVersion + 1,
    runState: "running",
    nextCycleAt: "2099-01-01T00:00:00.000Z",
    updatedAt: nowIso()
  }))));
  const retained = await proof.useDigitalAccess(scope, redemption.accessSecret, "fixture-use-second", { allowFixture: true });
  if (!retained.retentionObserved) throw new Error("fixture retention signal was not observed");
  const replanned = await storage.getCompany(scope.workspaceId, scope.companyId);
  if (!replanned || CompanyStateSchema.parse(replanned.state).nextCycleAt === "2099-01-01T00:00:00.000Z") throw new Error("fixture retention did not wake material replanning");
  process.stdout.write(`${JSON.stringify({ ok: true, proofTier: "fixture-verified", acquisition: true, payment: true, fulfillment: true, retention: true, materialReplan: true })}\n`);
} finally {
  runtime.storage.close();
  await rm(root, { recursive: true, force: true });
}
