import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CeoCycleDecisionSchema, localExecutionContext, sha256 } from "@opspot/contracts";
import { createDefaultRuntime } from "@opspot/domain";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const context = localExecutionContext("worker");

class FixtureCeo {
  readonly identity = Object.freeze({
    provider: "fake-public-core-ceo",
    model: "fixture",
    tariffVersion: "fixture-v1",
    runtimeConfigHash: sha256({ provider: "fake-public-core-ceo", model: "fixture", tariffVersion: "fixture-v1" })
  });

  estimateDecisionReservation(): number { return 0; }

  async decide() {
    return {
      output: CeoCycleDecisionSchema.parse({
        alternatives: [
          {
            capabilityId: "market-problem-research",
            title: "Fixture bounded evidence pass", hypothesis: "A fixture can prove persistence without market claims.", dependencies: [],
            requirements: ["No external action"], expectedOutcome: "Fixture-only internal artifact", expectedProof: "Fixture receipt",
            successThreshold: "The fixture CEO cycle persists", failureThreshold: "The cycle cannot persist", stopCondition: "Stop before external work",
            estimatedHours: 1, estimatedCostCents: 0, autonomyMode: "execute-safe", gateClasses: ["safe-internal-read-only"], uncertainty: 1,
            uncertaintyReason: "This is fixture proof only", assumptions: []
          },
          {
            capabilityId: "icp-offer-positioning-pricing",
            title: "Fixture abstention alternative", hypothesis: "No external proof is available.", dependencies: [],
            requirements: ["No external action"], expectedOutcome: "Explicit uncertainty", expectedProof: "Fixture receipt",
            successThreshold: "Unknowns remain explicit", failureThreshold: "Unsupported claim", stopCondition: "Stop before external work",
            estimatedHours: 1, estimatedCostCents: 0, autonomyMode: "prepare", gateClasses: ["safe-internal-read-only"], uncertainty: 1,
            uncertaintyReason: "This is fixture proof only", assumptions: []
          }
        ],
        decision: "select", selectedAlternativeIndex: 0, reason: "Fixture CEO selected the bounded internal initiative; no provider or external action was used"
      }),
      provider: "fake-public-core-ceo",
      model: "fixture",
      responseId: "fixture-public-core-ceo",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      reservationCents: 0,
      costCents: 0
    };
  }
}

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try { checks.push({ name, ok: true, detail: await run() }); }
  catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
}

function requireOk<T>(result: any): T {
  if (!result.ok) throw new Error(`${result.error?.code ?? "command-failed"}: ${result.error?.message ?? "unknown command failure"}`);
  return result.data as T;
}

async function withClockAdvance<T>(milliseconds: number, run: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(value?: string | number | Date) {
      if (arguments.length === 0) super(RealDate.now() + milliseconds);
      else super(value!);
    }
    static now(): number { return RealDate.now() + milliseconds; }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
  try { return await run(); } finally { globalThis.Date = RealDate; }
}

const root = await mkdtemp(path.join(tmpdir(), "opspot-public-core-"));
let ventureId = "";
let firstCycleId = "";
let runtime: ReturnType<typeof createDefaultRuntime> | undefined;
const active = () => {
  if (!runtime) throw new Error("runtime is not open");
  return runtime;
};
try {
  runtime = createDefaultRuntime({ root, context, ceoExecutor: new FixtureCeo() });
  await check("plain-language-bootstrap", async () => {
    const data = requireOk<{ ventureId?: string }>(await active().service.execute("company.bootstrap", {
      idea: "Help independent consultants validate a fixed-scope analytics offer before they spend money or contact buyers.",
      owner: "public-core-smoke",
      destination: "cash-flow",
      horizonDays: 30,
      budgetCents: 0,
      constraints: ["Fixture-only smoke; no external action"],
      requestedAt: new Date().toISOString(),
      idempotencyKey: "public-core-bootstrap-v1"
    }, context));
    ventureId = String(data.ventureId ?? "");
    if (!ventureId.startsWith("venture_")) throw new Error("bootstrap did not return a venture id");
    return "command service persisted a plain-language company bootstrap";
  });
  await check("run-and-first-ceo-cycle", async () => {
    if (!ventureId) throw new Error("bootstrap prerequisite failed");
    requireOk(await active().service.execute("company.run", { ventureId, requestedAt: new Date().toISOString(), idempotencyKey: "public-core-run-v1" }, context));
    const first = await active().autonomy.runWorkerOnce(context.workspaceId, "public-core-ceo-1");
    firstCycleId = String((first as { cycle?: { id?: string } } | null)?.cycle?.id ?? "");
    if (!firstCycleId.startsWith("cycle_")) throw new Error("first CEO cycle did not persist");
    const replay = requireOk<{ replayed?: boolean }>(await active().service.execute("company.run", { ventureId, requestedAt: new Date().toISOString(), idempotencyKey: "public-core-run-v1" }, context));
    if (!replay.replayed) throw new Error("Run idempotency replay was not reported");
    return "Run scheduled and completed one fixture-labelled CEO cycle";
  });
  active().storage.close();
  runtime = createDefaultRuntime({ root, context, ceoExecutor: new FixtureCeo() });
  await check("restart-and-second-ceo-cycle", async () => {
    if (!ventureId || !firstCycleId) throw new Error("first cycle prerequisite failed");
    const second = await withClockAdvance(16 * 60_000, async () => {
      await active().autonomy.scheduleDue(context.workspaceId, new Date().toISOString());
      return active().autonomy.runWorkerOnce(context.workspaceId, "public-core-ceo-2");
    });
    const secondCycleId = String((second as { cycle?: { id?: string } } | null)?.cycle?.id ?? "");
    if (!secondCycleId.startsWith("cycle_") || secondCycleId === firstCycleId) throw new Error("second persisted CEO cycle was not created after reopen");
    const company = requireOk<{ cycles?: unknown[] }>(await active().service.execute("company.get", { ventureId }, context));
    if (company.cycles?.length !== 2) throw new Error(`expected exactly two persisted CEO cycles, found ${company.cycles?.length ?? 0}`);
    return "reopened runtime completed exactly one additional fixture-labelled CEO cycle";
  });
  await check("no-duplicate-job-or-effect", async () => {
    if (!ventureId) throw new Error("bootstrap prerequisite failed");
    const replay = await active().autonomy.runWorkerOnce(context.workspaceId, "public-core-ceo-replay");
    if (replay !== null) throw new Error("replaying the worker claimed a duplicate CEO job");
    const company = requireOk<{ cycles?: unknown[]; receipts?: Array<{ adapter?: string; proofTier?: string }> }>(await active().service.execute("company.get", { ventureId }, context));
    if (company.cycles?.length !== 2) throw new Error("worker replay created a duplicate CEO effect");
    if (!company.receipts?.filter((receipt) => receipt.adapter === "fake-public-core-ceo" && receipt.proofTier === "fixture-verified").length) {
      throw new Error("fixture CEO receipts were not explicitly fixture-verified");
    }
    return "idempotent Run and worker replay left two cycles with fixture-only proof";
  });
  await check("command-service-export-delete-and-absence", async () => {
    if (!ventureId) throw new Error("bootstrap prerequisite failed");
    const exported = requireOk<{ companyId?: string; tables?: Record<string, unknown[]> }>(await active().service.execute("company.export", { ventureId }, context));
    if (exported.companyId !== ventureId || !exported.tables) throw new Error("command service export did not contain the company");
    const deleted = requireOk<{ deleted?: boolean }>(await active().service.execute("company.delete", {
      ventureId,
      confirmVentureId: ventureId,
      actor: "public-core-smoke",
      requestedAt: new Date().toISOString(),
      idempotencyKey: "public-core-delete-v1"
    }, context));
    if (!deleted.deleted) throw new Error("command service did not confirm deletion");
    const missing = await active().service.execute("company.get", { ventureId }, context);
    if (missing.ok) throw new Error("deleted company remained readable");
    return "export and deletion ran through the command service; deleted company is absent";
  });
} finally {
  try { runtime?.storage.close(); } catch { /* the temporary runtime may already be closed */ }
  await rm(root, { recursive: true, force: true });
}

const ok = checks.every((item) => item.ok);
process.stdout.write(`${JSON.stringify({ ok, status: ok ? "passed" : "failed", checks }, null, 2)}\n`);
if (!ok) process.exitCode = 1;
