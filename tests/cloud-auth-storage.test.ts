import { describe, expect, it } from "vitest";
import { TaskDefinitionSchema, sha256 } from "@opspot/contracts";
import { PostgresKernelStorage } from "@opspot/storage";
import { createPostgresCommandRateLimiter } from "../apps/control/lib/command-rate-limit.js";

const postgresUrl = process.env.TEST_POSTGRES_URL;

describe("Cloud auth durable storage", () => {
  (postgresUrl ? it : it.skip)("atomically provisions one personal workspace per verified subject and rate-limits concurrent requests", async () => {
    const baseSchema = process.env.TEST_POSTGRES_SCHEMA ?? "opspot_auth_conformance";
    const storage = await PostgresKernelStorage.connect(postgresUrl!, { schema: `${baseSchema}_auth`, max: 4 });
    try {
      const subjectA = "11111111-1111-4111-8111-111111111111";
      const subjectB = "22222222-2222-4222-8222-222222222222";
      const subjectC = "33333333-3333-4333-8333-333333333333";
      const memberships = await Promise.all(Array.from({ length: 12 }, () => storage.resolveOrCreatePersonalWorkspaceForAuthSubject(subjectA)));
      expect(new Set(memberships.map((membership) => membership.workspaceId))).toEqual(new Set([memberships[0]!.workspaceId]));
      expect(await storage.resolveWorkspaceForAuthSubject(subjectA)).toEqual(memberships[0]);
      const other = await storage.resolveOrCreatePersonalWorkspaceForAuthSubject(subjectB);
      const third = await storage.resolveOrCreatePersonalWorkspaceForAuthSubject(subjectC);
      expect(other.workspaceId).not.toBe(memberships[0]!.workspaceId);
      expect(await storage.resolveWorkspaceForAuthSubject(subjectB)).toEqual(other);

      const bucketKey = "a".repeat(64);
      const results = await Promise.all(Array.from({ length: 10 }, () => storage.consumeAuthRateLimit({
        bucketKeys: [bucketKey],
        limit: 3,
        windowSeconds: 600,
        at: "2026-07-20T12:00:00.000Z"
      })));
      expect(results.filter((result) => result.allowed)).toHaveLength(3);
      expect(results.filter((result) => !result.allowed)).toHaveLength(7);
      expect(results.find((result) => !result.allowed)?.retryAfterSeconds).toBe(600);

      const commandLimiter = createPostgresCommandRateLimiter(
        async () => storage,
        { VERCEL: "1", NODE_ENV: "production", AUTH_RATE_LIMIT_SECRET: "test-only-test-only-test-only-test-only" }
      );
      const commandRequest = new Request("https://cloud.opspot.test/api/command", { headers: { "x-vercel-forwarded-for": "203.0.113.10" } });
      const commandResults = await Promise.all(Array.from({ length: 121 }, () => commandLimiter(memberships[0]!.workspaceId, commandRequest)));
      expect(commandResults.filter((result) => result.allowed)).toHaveLength(120);
      expect(commandResults.filter((result) => !result.allowed)).toHaveLength(1);
      expect((await commandLimiter(other.workspaceId, new Request("https://cloud.opspot.test/api/command", {
        headers: { "x-vercel-forwarded-for": "203.0.113.11" }
      }))).allowed).toBe(true);

      const at = "2026-07-20T12:00:00.000Z";
      await storage.createCompany({
        workspaceId: memberships[0]!.workspaceId,
        companyId: "venture_runnable_alpha",
        slug: "runnable-alpha",
        name: "Runnable alpha",
        owner: "founder",
        owningRepo: "engine://company/venture_runnable_alpha",
        lifecycleState: "candidate",
        state: { bootstrap: { digest: "a".repeat(64) }, runState: "running", nextCycleAt: "2026-07-20T08:00:00.000-04:00" },
        createdAt: at,
        updatedAt: at
      });
      await storage.createCompany({
        workspaceId: other.workspaceId,
        companyId: "venture_runnable_beta",
        slug: "runnable-beta",
        name: "Runnable beta",
        owner: "founder",
        owningRepo: "engine://company/venture_runnable_beta",
        lifecycleState: "candidate",
        state: { bootstrap: { digest: "b".repeat(64) }, runState: "running", nextCycleAt: "2026-07-20T11:59:00.000Z" },
        createdAt: at,
        updatedAt: at
      });
      await storage.createCompany({
        workspaceId: third.workspaceId,
        companyId: "venture_idle_gamma",
        slug: "idle-gamma",
        name: "Idle gamma",
        owner: "founder",
        owningRepo: "engine://company/venture_idle_gamma",
        lifecycleState: "candidate",
        state: { bootstrap: { digest: "c".repeat(64) }, runState: "idle" },
        createdAt: at,
        updatedAt: at
      });
      const parkedGoldenTask = TaskDefinitionSchema.parse({
        id: "task_parked_golden",
        ventureId: "venture_idle_gamma",
        taskKind: "venture-play",
        purpose: "retain an approved effect until its dedicated provider worker exists",
        expectedOutcome: "a durable unclaimed golden execution job",
        ownerRole: "scout",
        dependencies: [],
        sourceRefs: ["engine://company/venture_idle_gamma"],
        mode: "external",
        expectedProof: "provider receipt from the dedicated golden worker",
        gateClass: "public-posting",
        actionBounds: {},
        budgetCents: 0,
        costCeilingCents: 0,
        approvalRequired: false,
        idempotencyKey: "parked-golden-provider-worker",
        maxAttempts: 1,
        backoffMs: 0,
        timeoutMs: 10_000,
        lifecycleEffect: {},
        metricEffects: []
      });
      await storage.putTask(third.workspaceId, parkedGoldenTask, sha256(parkedGoldenTask), "ready");
      await storage.enqueueJob({
        workspaceId: third.workspaceId,
        companyId: parkedGoldenTask.ventureId,
        id: "job_parked_golden",
        taskId: parkedGoldenTask.id,
        kind: "golden-execution",
        payload: {}
      });
      const due = [memberships[0]!.workspaceId, other.workspaceId].sort();
      const firstPage = await storage.listRunnableWorkspaceIds({ limit: 1, at });
      expect(firstPage).toEqual({ workspaceIds: [due[0]], nextCursor: due[0] });
      expect(await storage.listRunnableWorkspaceIds({ after: firstPage.nextCursor!, limit: 1, at })).toEqual({ workspaceIds: [due[1]] });
    } finally {
      await storage.close();
    }
  });
});
