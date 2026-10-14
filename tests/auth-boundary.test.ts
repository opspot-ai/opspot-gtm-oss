import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostgresKernelStorage, WorkspaceMembership } from "@opspot/storage";
import { handleAuthCallback } from "../apps/control/lib/auth-callback.js";
import { createPostgresAuthRateLimiter } from "../apps/control/lib/auth-rate-limit.js";
import { handleAuthRequest, type AuthRouteDependencies } from "../apps/control/lib/auth-route.js";
import { readSupabaseServerConfig } from "../apps/control/lib/supabase/config.js";
import { localAuthResponse } from "../apps/control/lib/local-mode.js";

const ORIGIN = "https://cloud.opspot.test";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP: WorkspaceMembership = {
  authSubject: SUBJECT,
  workspaceId: "workspace_member_1",
  role: "owner",
  createdAt: "2026-07-20T12:00:00.000Z"
};
type AuthClient = Awaited<ReturnType<AuthRouteDependencies["createClient"]>>;

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.8", ...headers },
    body: JSON.stringify(body)
  });
}

function client(overrides: Record<string, unknown> = {}): AuthClient {
  return {
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: SUBJECT, email: "founder@example.com", role: "authenticated" } }, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { session: { access_token: "verified-token" } }, error: null })),
      signUp: vi.fn(async () => ({ data: { session: null }, error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null })),
      ...overrides
    }
  } as unknown as AuthClient;
}

function dependencies(authClient = client()): AuthRouteDependencies {
  return {
    appOrigin: ORIGIN,
    createClient: vi.fn(async () => authClient),
    resolveWorkspace: vi.fn(async () => MEMBERSHIP),
    consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }))
  };
}

describe("Cloud Supabase auth boundary", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("authorizes a session only from verified claims.sub and provisions its private workspace", async () => {
    const deps = dependencies();
    const response = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/session`), "session", deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, user: { email: "founder@example.com" }, workspace: { id: MEMBERSHIP.workspaceId, role: "owner" } });
    expect(deps.resolveWorkspace).toHaveBeenCalledWith(SUBJECT);
  });

  it("rejects cross-origin, non-JSON, malformed, and request-supplied tenancy fields before Supabase", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    expect((await handleAuthRequest(request("sign-in", { email: "founder@example.com", password: "password1" }, { origin: "https://evil.test" }), "sign-in", deps)).status).toBe(403);
    expect((await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }), "sign-in", deps)).status).toBe(415);
    expect((await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{" }), "sign-in", deps)).status).toBe(400);
    const tenancy = await handleAuthRequest(request("sign-in", { email: "founder@example.com", password: "password1", workspaceId: "workspace_attacker" }), "sign-in", deps);
    expect(tenancy.status).toBe(400);
    expect(authClient.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("normalizes sign-in input, verifies the returned token, and never takes subject from the body", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    const response = await handleAuthRequest(request("sign-in", { email: " Founder@Example.COM ", password: "password1" }), "sign-in", deps);
    expect(response.status).toBe(200);
    expect(authClient.auth.signInWithPassword).toHaveBeenCalledWith({ email: "founder@example.com", password: "password1" });
    expect(authClient.auth.getClaims).toHaveBeenCalledWith("verified-token");
    expect(deps.resolveWorkspace).toHaveBeenCalledWith(SUBJECT);
  });

  it("returns an honest confirmation-required signup and a usable recovery callback URL", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    const signup = await handleAuthRequest(request("sign-up", { email: "founder@example.com", password: "password1" }), "sign-up", deps);
    expect(signup.status).toBe(202);
    expect(await signup.json()).toMatchObject({ ok: true, user: null, confirmationRequired: true });
    expect(authClient.auth.signUp).toHaveBeenCalledWith({
      email: "founder@example.com",
      password: "password1",
      options: { emailRedirectTo: `${ORIGIN}/auth/callback?next=%2F` }
    });
    const recover = await handleAuthRequest(request("recover", { email: "founder@example.com" }), "recover", deps);
    expect(recover.status).toBe(200);
    expect(authClient.auth.resetPasswordForEmail).toHaveBeenCalledWith("founder@example.com", {
      redirectTo: `${ORIGIN}/auth/callback?next=%2Freset-password`
    });
  });

  it("maps provider and application rate limits to 429 without leaking provider details", async () => {
    const providerClient = client({
      signInWithPassword: vi.fn(async () => ({ data: { session: null }, error: { status: 429, message: "provider secret details" } }))
    });
    const providerResponse = await handleAuthRequest(request("sign-in", { email: "founder@example.com", password: "password1" }), "sign-in", dependencies(providerClient));
    expect(providerResponse.status).toBe(429);
    expect(JSON.stringify(await providerResponse.json())).not.toContain("provider secret details");

    const appClient = client();
    const deps = dependencies(appClient);
    deps.consumeRateLimit = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 37 }));
    const appResponse = await handleAuthRequest(request("sign-in", { email: "founder@example.com", password: "password1" }), "sign-in", deps);
    expect(appResponse.status).toBe(429);
    expect(appResponse.headers.get("retry-after")).toBe("37");
    expect(appClient.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("completes the recovery code exchange and password update contracts", async () => {
    const authClient = client();
    const callback = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=recovery-code&next=%2Freset-password`),
      { appOrigin: ORIGIN, createClient: async () => authClient }
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
    expect(authClient.auth.exchangeCodeForSession).toHaveBeenCalledWith("recovery-code");
    const signupCallback = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2F`),
      { appOrigin: ORIGIN, createClient: async () => authClient }
    );
    expect(signupCallback.status).toBe(303);
    expect(signupCallback.headers.get("location")).toBe(`${ORIGIN}/`);
    expect((await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=recovery-code&next=https%3A%2F%2Fevil.test`),
      { appOrigin: ORIGIN, createClient: async () => authClient }
    )).status).toBe(400);
    const updated = await handleAuthRequest(request("update-password", { password: "new-password-1" }), "update-password", dependencies(authClient));
    expect(updated.status).toBe(200);
    expect(authClient.auth.updateUser).toHaveBeenCalledWith({ password: "new-password-1" });
  });

  it("HMACs trusted Vercel IP and email before the durable limiter sees either value", async () => {
    const consumeAuthRateLimit = vi.fn(async (_input: { bucketKeys: readonly string[] }) => ({ allowed: true, retryAfterSeconds: 0 }));
    const limiter = createPostgresAuthRateLimiter(
      async () => ({ consumeAuthRateLimit } as unknown as PostgresKernelStorage),
      { VERCEL: "1", NODE_ENV: "production", AUTH_RATE_LIMIT_SECRET: "test-only-test-only-test-only-test-only" }
    );
    await limiter("sign-in", request("sign-in", {}), "Founder@Example.com");
    const input = consumeAuthRateLimit.mock.calls[0]![0];
    expect(input.bucketKeys).toHaveLength(2);
    expect(input.bucketKeys.every((value: string) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(JSON.stringify(input)).not.toContain("Founder");
    expect(JSON.stringify(input)).not.toContain("203.0.113.8");
  });

  it("rejects secret keys in the publishable-key slot", () => {
    expect(() => readSupabaseServerConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden",
      OPSPOT_APP_ORIGIN: ORIGIN,
      NODE_ENV: "production"
    })).toThrow("must never be used");
  });

  it("keeps local mode loopback-only and never synthesizes cloud auth", async () => {
    const session = localAuthResponse(new Request("http://127.0.0.1:3210/api/auth/session"), "session", { NODE_ENV: "test", ENGINE_MODE: "local" });
    expect(session?.status).toBe(503);
    expect(await session?.json()).toMatchObject({ ok: false, error: { code: "auth-unavailable" } });
    const mutation = localAuthResponse(request("sign-in", { email: "founder@example.com", password: "password1" }), "sign-in", { NODE_ENV: "test", ENGINE_MODE: "local" });
    expect(mutation?.status).toBe(403);
    expect(await mutation?.json()).toMatchObject({ ok: false, error: { code: "local-origin-required" } });
    const localMutation = localAuthResponse(new Request("http://localhost:3210/api/auth/sign-in", { method: "POST" }), "sign-in", { NODE_ENV: "test", ENGINE_MODE: "local" });
    expect(localMutation?.status).toBe(403);
    expect(await localMutation?.json()).toMatchObject({ ok: false, error: { code: "local-auth-disabled" } });
    expect(localAuthResponse(new Request(`${ORIGIN}/api/auth/session`), "session", { NODE_ENV: "test", ENGINE_MODE: "cloud" })).toBeUndefined();
  });
});
