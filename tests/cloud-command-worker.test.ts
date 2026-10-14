import { describe, expect, it, vi } from "vitest";
import type { KernelStorage, PostgresKernelStorage, WorkspaceMembership } from "@opspot/storage";
import type { CompanyAutonomy } from "../packages/domain/src/autonomous.js";
import { CompanyCommandService, createCloudCompanyRuntime } from "../packages/domain/src/company-cloud.js";
import { handleCloudCommandRequest, handleLocalCommandRequest, type CloudCommandRouteDependencies } from "../apps/control/lib/cloud-command-route.js";
import { handleCloudWorkerRequest, type CloudWorkerRouteDependencies } from "../apps/control/lib/cloud-worker-route.js";
import { createPostgresCommandRateLimiter } from "../apps/control/lib/command-rate-limit.js";

const ORIGIN = "https://cloud.opspot.test";
const SUBJECT_A = "11111111-1111-4111-8111-111111111111";
const SUBJECT_B = "22222222-2222-4222-8222-222222222222";

function membership(subject: string, workspaceId: string): WorkspaceMembership {
  return { authSubject: subject, workspaceId, role: "owner", createdAt: "2026-07-20T12:00:00.000Z" };
}

type AuthClient = Awaited<ReturnType<CloudCommandRouteDependencies["createClient"]>>;

function authClient(subject = SUBJECT_A, role = "authenticated"): AuthClient {
  return {
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: subject, role } }, error: null }))
    }
  } as unknown as AuthClient;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/command`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function companyService() {
  const autonomy = {
    bootstrap: vi.fn(),
    get: vi.fn(async (workspaceId: string, ventureId: string) => ({ workspaceId, ventureId })),
    list: vi.fn(async (workspaceId: string) => ({ workspaceId })),
    run: vi.fn(),
    pause: vi.fn(),
    kill: vi.fn(),
    export: vi.fn(),
    delete: vi.fn(),
    resolveApproval: vi.fn()
  } as unknown as CompanyAutonomy;
  const storage = {
    listPendingApprovals: vi.fn(async () => []),
    listJobs: vi.fn(async () => [{
      id: "job_failed_1",
      taskId: "task_failed_1",
      kind: "initiative-execution",
      status: "dead-letter",
      attemptCount: 3,
      availableAt: "2026-07-20T12:00:00.000Z",
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:01:00.000Z",
      error: { redacted: true, at: "2026-07-20T12:01:00.000Z" }
    }])
  } as unknown as KernelStorage;
  return { autonomy, storage, service: new CompanyCommandService(storage, autonomy) };
}

function commandDependencies(subject = SUBJECT_A) {
  const company = companyService();
  const memberships = new Map([
    [SUBJECT_A, membership(SUBJECT_A, "workspace_alpha")],
    [SUBJECT_B, membership(SUBJECT_B, "workspace_beta")]
  ]);
  const dependencies: CloudCommandRouteDependencies = {
    appOrigin: ORIGIN,
    createClient: vi.fn(async () => authClient(subject)),
    resolveWorkspace: vi.fn(async (authSubject) => memberships.get(authSubject)!),
    consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    execute: vi.fn((workspaceId, command, input) => company.service.execute(workspaceId, command, input))
  };
  return { ...company, dependencies };
}

describe("authenticated Company Cloud command boundary", () => {
  it("derives isolated A/B workspaces only from verified claims membership", async () => {
    const alpha = commandDependencies(SUBJECT_A);
    const beta = commandDependencies(SUBJECT_B);
    const alphaResponse = await handleCloudCommandRequest(request({ command: "company.list", input: {} }, { "x-opspot-workspace-id": "workspace_beta" }), alpha.dependencies);
    const betaResponse = await handleCloudCommandRequest(request({ command: "company.list", input: {} }), beta.dependencies);
    expect(await alphaResponse.json()).toMatchObject({ ok: true, data: { workspaceId: "workspace_alpha" } });
    expect(await betaResponse.json()).toMatchObject({ ok: true, data: { workspaceId: "workspace_beta" } });
    expect(alpha.dependencies.resolveWorkspace).toHaveBeenCalledWith(SUBJECT_A);
    expect(beta.dependencies.resolveWorkspace).toHaveBeenCalledWith(SUBJECT_B);
    expect(alpha.autonomy.list).toHaveBeenCalledWith("workspace_alpha");
    expect(beta.autonomy.list).toHaveBeenCalledWith("workspace_beta");
  });

  it("rejects caller workspace fields and every non-company legacy command", async () => {
    const { dependencies, autonomy } = commandDependencies();
    const topLevel = await handleCloudCommandRequest(request({ command: "company.list", input: {}, workspaceId: "workspace_beta" }), dependencies);
    expect(topLevel.status).toBe(400);
    const nested = await handleCloudCommandRequest(request({ command: "company.list", input: { workspaceId: "workspace_beta" } }), dependencies);
    expect(nested.status).toBe(400);
    expect(await nested.json()).toMatchObject({ error: { code: "invalid-input" } });
    const legacy = await handleCloudCommandRequest(request({ command: "portfolio.scorecard", input: {} }), dependencies);
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({ error: { code: "command-not-allowed" } });
    expect(autonomy.list).not.toHaveBeenCalled();
  });

  it("fails before command execution on cross-origin, unauthenticated, non-JSON, and oversized requests", async () => {
    const { dependencies } = commandDependencies();
    expect((await handleCloudCommandRequest(request({ command: "company.list", input: {} }, { origin: "https://evil.test" }), dependencies)).status).toBe(403);
    const unauthenticated = { ...dependencies, createClient: async () => authClient("not-a-uuid", "anon") };
    expect((await handleCloudCommandRequest(request({ command: "company.list", input: {} }), unauthenticated)).status).toBe(401);
    expect((await handleCloudCommandRequest(new Request(`${ORIGIN}/api/command`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }), dependencies)).status).toBe(415);
    expect((await handleCloudCommandRequest(request({ command: "company.bootstrap", input: { idea: "x".repeat(70_000) } }), dependencies)).status).toBe(413);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("requires owner membership before rate limiting or command execution", async () => {
    const { dependencies } = commandDependencies();
    dependencies.resolveWorkspace = vi.fn(async () => ({
      ...membership(SUBJECT_A, "workspace_alpha"),
      role: "viewer" as const
    }));
    const response = await handleCloudCommandRequest(request({ command: "company.list", input: {} }), dependencies);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "workspace-access-denied" } });
    expect(dependencies.consumeRateLimit).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected command failures and Cloud runtime refuses missing provider configuration", async () => {
    const { service, autonomy } = companyService();
    vi.mocked(autonomy.list).mockRejectedValueOnce(new Error("database-password-secret"));
    const result = await service.execute("workspace_alpha", "company.list", {});
    expect(result).toMatchObject({ ok: false, error: { code: "command-failed" } });
    expect(JSON.stringify(result)).not.toContain("database-password-secret");
    expect(() => createCloudCompanyRuntime({
      storage: {} as never,
      workspaceId: "workspace_alpha",
      openAiApiKey: "",
      webSearchCostCents: 1
    })).toThrow("OPENAI_API_KEY is required");
  });

  it("enforces durable workspace and trusted-IP command buckets before execution", async () => {
    const consumeAuthRateLimit = vi.fn(async (_input: { bucketKeys: readonly string[]; limit: number; windowSeconds: number }) => ({ allowed: true, retryAfterSeconds: 0 }));
    const limiter = createPostgresCommandRateLimiter(
      async () => ({ consumeAuthRateLimit } as unknown as PostgresKernelStorage),
      { VERCEL: "1", NODE_ENV: "production", AUTH_RATE_LIMIT_SECRET: "test-only-test-only-test-only-test-only" }
    );
    const commandRequest = request({ command: "company.list", input: {} }, { "x-vercel-forwarded-for": "203.0.113.8" });
    await limiter("workspace_alpha", commandRequest);
    await limiter("workspace_beta", commandRequest);
    const alpha = consumeAuthRateLimit.mock.calls[0]![0];
    const beta = consumeAuthRateLimit.mock.calls[1]![0];
    expect(alpha).toMatchObject({ limit: 120, windowSeconds: 60 });
    expect(alpha.bucketKeys[0]).toBe(beta.bucketKeys[0]);
    expect(alpha.bucketKeys[1]).not.toBe(beta.bucketKeys[1]);
    expect(JSON.stringify([alpha, beta])).not.toContain("203.0.113.8");
    expect(JSON.stringify([alpha, beta])).not.toContain("workspace_alpha");

    const { dependencies } = commandDependencies();
    dependencies.consumeRateLimit = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 23 }));
    const response = await handleCloudCommandRequest(request({ command: "company.list", input: {} }), dependencies);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("23");
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("returns only bounded redacted failed-job summaries for the authenticated company", async () => {
    const { service, storage } = companyService();
    const result = await service.execute("workspace_alpha", "company.get", { ventureId: "venture_alpha" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        ventureId: "venture_alpha",
        failedJobs: [{ id: "job_failed_1", status: "dead-letter", error: { redacted: true } }]
      }
    });
    expect(storage.listJobs).toHaveBeenCalledWith("workspace_alpha", "venture_alpha", {
      statuses: ["failed", "dead-letter"],
      limit: 50
    });
    expect(JSON.stringify(result)).not.toContain("payload");
    expect(JSON.stringify(result)).not.toContain("leaseToken");
  });

  it("keeps explicit loopback local mode on the same strict company command surface without Cloud auth", async () => {
    const { service, autonomy } = companyService();
    const response = await handleLocalCommandRequest(request({ command: "company.list", input: {} }), {
      appOrigin: ORIGIN,
      workspaceId: "workspace_local",
      execute: (workspaceId, command, input) => service.execute(workspaceId, command, input)
    });
    expect(response.status).toBe(200);
    expect(autonomy.list).toHaveBeenCalledWith("workspace_local");
    const legacy = await handleLocalCommandRequest(request({ command: "portfolio.scorecard", input: {} }), {
      appOrigin: ORIGIN,
      workspaceId: "workspace_local",
      execute: (workspaceId, command, input) => service.execute(workspaceId, command, input)
    });
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({ error: { code: "command-not-allowed" } });
  });
});

describe("bounded durable Cloud worker boundary", () => {
  function workerDependencies(secret: string | undefined = "cron-secret") {
    const dependencies: CloudWorkerRouteDependencies = {
      cronSecret: secret,
      listRunnableWorkspaceIds: vi.fn(async () => ({ workspaceIds: ["workspace_alpha", "workspace_beta"], nextCursor: "workspace_beta" })),
      runWorkspaceOnce: vi.fn(async (workspaceId) => ({ workspaceId, outcome: "idempotent-replay" }))
    };
    return dependencies;
  }

  function workerRequest(secret = "cron-secret", query = ""): Request {
    return new Request(`${ORIGIN}/api/cron/worker${query}`, { headers: { authorization: `Bearer ${secret}` } });
  }

  it("fails closed without CRON_SECRET and requires its exact Bearer value", async () => {
    const absent = workerDependencies("");
    expect((await handleCloudWorkerRequest(workerRequest(), absent)).status).toBe(503);
    expect(absent.listRunnableWorkspaceIds).not.toHaveBeenCalled();
    const configured = workerDependencies();
    expect((await handleCloudWorkerRequest(workerRequest("wrong"), configured)).status).toBe(401);
    expect(configured.listRunnableWorkspaceIds).not.toHaveBeenCalled();
  });

  it("processes only one bounded page and exposes the durable continuation cursor", async () => {
    const dependencies = workerDependencies();
    const response = await handleCloudWorkerRequest(workerRequest("cron-secret", "?limit=2"), dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      processedWorkspaces: 2,
      nextCursor: "workspace_beta",
      results: [
        { workspaceId: "workspace_alpha", outcome: "processed", result: { outcome: "idempotent-replay" } },
        { workspaceId: "workspace_beta", outcome: "processed", result: { outcome: "idempotent-replay" } }
      ]
    });
    expect(dependencies.listRunnableWorkspaceIds).toHaveBeenCalledWith({ limit: 2 });
    expect(dependencies.runWorkspaceOnce).toHaveBeenCalledTimes(2);
  });

  it("bounds paging input and does not leak worker errors across restarts", async () => {
    const dependencies = workerDependencies();
    expect((await handleCloudWorkerRequest(workerRequest("cron-secret", "?limit=21"), dependencies)).status).toBe(400);
    vi.mocked(dependencies.runWorkspaceOnce).mockRejectedValueOnce(new Error("provider-secret-error"));
    const first = await handleCloudWorkerRequest(workerRequest(), dependencies);
    expect(JSON.stringify(await first.json())).not.toContain("provider-secret-error");
    const restarted = await handleCloudWorkerRequest(workerRequest(), dependencies);
    expect((await restarted.json()).results[0]).toMatchObject({ result: { outcome: "idempotent-replay" } });
  });
});
