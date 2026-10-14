import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { WorkspaceMembership } from "@opspot/storage";
import type { ConsumeAuthRateLimit, MutableAuthAction } from "./auth-rate-limit";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(8).max(128) }).strict();
const emailOnlySchema = z.object({ email: emailSchema }).strict();
const passwordOnlySchema = z.object({ password: z.string().min(8).max(128) }).strict();
const emptySchema = z.object({}).strict();
const authSubjectSchema = z.uuid();
const MAX_BODY_BYTES = 8_192;

type AuthAction = MutableAuthAction | "session";

export interface AuthRouteDependencies {
  appOrigin: string;
  createClient(): Promise<SupabaseClient>;
  resolveWorkspace(authSubject: string): Promise<WorkspaceMembership>;
  consumeRateLimit: ConsumeAuthRateLimit;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      expires: "0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function failure(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

function providerRateLimited(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return record.status === 429 || code.includes("rate") || message.includes("rate limit");
}

function providerFailure(error: unknown, fallback: string): Response {
  if (providerRateLimited(error)) return failure(429, "auth-rate-limited", "Too many requests. Try again later.", { "retry-after": "60" });
  return failure(400, "auth-rejected", fallback);
}

async function body(request: Request): Promise<unknown | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "json-required", "Content-Type must be application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failure(400, "invalid-json", "Request body must be valid JSON.");
  }
}

async function verifiedIdentity(client: SupabaseClient, dependencies: AuthRouteDependencies, accessToken?: string): Promise<Response> {
  const { data, error } = await client.auth.getClaims(accessToken);
  const claims = data?.claims;
  const subject = authSubjectSchema.safeParse(claims?.sub);
  const email = emailSchema.safeParse(claims?.email);
  if (error || !subject.success || !email.success || claims?.role !== "authenticated") {
    return failure(401, "auth-required", "A verified session is required.");
  }
  const membership = await dependencies.resolveWorkspace(subject.data);
  return json({
    ok: true,
    user: { email: email.data },
    workspace: { id: membership.workspaceId, role: membership.role }
  });
}

function parseAction(action: string): AuthAction | undefined {
  return (["session", "sign-in", "sign-up", "recover", "sign-out", "update-password"] as const).find((candidate) => candidate === action);
}

export async function handleAuthRequest(request: Request, rawAction: string, dependencies: AuthRouteDependencies): Promise<Response> {
  const action = parseAction(rawAction);
  if (!action) return failure(404, "auth-route-not-found", "Auth route not found.");
  if (request.method === "GET") {
    if (action !== "session") return failure(405, "method-not-allowed", "This auth route requires POST.", { allow: "POST" });
    return verifiedIdentity(await dependencies.createClient(), dependencies);
  }
  if (request.method !== "POST" || action === "session") {
    return failure(405, "method-not-allowed", action === "session" ? "Session lookup requires GET." : "This auth route requires POST.", { allow: action === "session" ? "GET" : "POST" });
  }
  if (request.headers.get("origin") !== dependencies.appOrigin) return failure(403, "origin-rejected", "Request origin was rejected.");
  const parsedBody = await body(request);
  if (parsedBody instanceof Response) return parsedBody;

  const empty = action === "sign-out" ? emptySchema.safeParse(parsedBody) : undefined;
  const emailOnly = action === "recover" ? emailOnlySchema.safeParse(parsedBody) : undefined;
  const credentials = action === "sign-in" || action === "sign-up" ? credentialsSchema.safeParse(parsedBody) : undefined;
  const passwordOnly = action === "update-password" ? passwordOnlySchema.safeParse(parsedBody) : undefined;
  if (empty?.success === false || emailOnly?.success === false || credentials?.success === false || passwordOnly?.success === false) {
    return failure(400, "invalid-auth-input", "Auth request fields are invalid.");
  }
  const email = emailOnly?.success ? emailOnly.data.email : credentials?.success ? credentials.data.email : undefined;
  const rate = await dependencies.consumeRateLimit(action, request, email);
  if (!rate.allowed) {
    return failure(429, "auth-rate-limited", "Too many requests. Try again later.", { "retry-after": String(rate.retryAfterSeconds) });
  }

  const client = await dependencies.createClient();
  if (action === "update-password") {
    const { data: claimsData, error: claimsError } = await client.auth.getClaims();
    const claims = claimsData?.claims;
    if (claimsError || !authSubjectSchema.safeParse(claims?.sub).success || claims?.role !== "authenticated") {
      return failure(401, "auth-required", "A verified recovery session is required.");
    }
    const { error } = await client.auth.updateUser({ password: passwordOnly!.data.password });
    if (error) return providerFailure(error, "Password could not be updated.");
    return json({ ok: true, user: { email: emailSchema.safeParse(claims.email).data ?? null } });
  }
  if (action === "sign-out") {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) return providerFailure(error, "Sign-out could not be completed.");
    return json({ ok: true, user: null });
  }
  if (action === "recover") {
    const callback = new URL("/auth/callback", dependencies.appOrigin);
    callback.searchParams.set("next", "/reset-password");
    const { error } = await client.auth.resetPasswordForEmail(emailOnly!.data.email, { redirectTo: callback.toString() });
    if (error) return providerFailure(error, "Recovery could not be requested.");
    return json({ ok: true, user: null });
  }
  if (action === "sign-in") {
    const { data, error } = await client.auth.signInWithPassword(credentials!.data);
    if (error || !data.session?.access_token) return providerFailure(error, "Invalid email or password.");
    return verifiedIdentity(client, dependencies, data.session.access_token);
  }
  const signupCallback = new URL("/auth/callback", dependencies.appOrigin);
  signupCallback.searchParams.set("next", "/");
  const { data, error } = await client.auth.signUp({
    ...credentials!.data,
    options: { emailRedirectTo: signupCallback.toString() }
  });
  if (error) return providerFailure(error, "Account could not be created.");
  if (!data.session?.access_token) return json({ ok: true, user: null, confirmationRequired: true }, 202);
  return verifiedIdentity(client, dependencies, data.session.access_token);
}
