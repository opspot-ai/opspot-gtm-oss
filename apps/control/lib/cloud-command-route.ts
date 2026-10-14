import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceMembership } from "@opspot/storage";

const requestSchema = z.object({ command: z.unknown(), input: z.unknown().optional() }).strict();
const authSubjectSchema = z.uuid();
const MAX_BODY_BYTES = 64 * 1024;

type CommandResult =
  | { ok: true; command: string; data: unknown }
  | { ok: false; command?: string; error: { code: string; message: string } };

export interface CloudCommandRouteDependencies {
  appOrigin: string;
  createClient(): Promise<SupabaseClient>;
  resolveWorkspace(authSubject: string): Promise<WorkspaceMembership>;
  consumeRateLimit(workspaceId: string, request: Request): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  execute(workspaceId: string, command: unknown, input: unknown): Promise<CommandResult>;
}

export interface LocalCommandRouteDependencies {
  appOrigin: string;
  workspaceId: string;
  execute(workspaceId: string, command: unknown, input: unknown): Promise<CommandResult>;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      expires: "0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function failure(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

async function readBody(request: Request): Promise<unknown | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "json-required", "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failure(400, "invalid-json", "Request body must be valid JSON.");
  }
}

async function parsedCommandRequest(request: Request, appOrigin: string): Promise<z.infer<typeof requestSchema> | Response> {
  if (request.method !== "POST") return failure(405, "method-not-allowed", "Company commands require POST.", { allow: "POST" });
  if (request.headers.get("origin") !== appOrigin) return failure(403, "origin-rejected", "Request origin was rejected.");
  const rawBody = await readBody(request);
  if (rawBody instanceof Response) return rawBody;
  const body = requestSchema.safeParse(rawBody);
  return body.success ? body.data : failure(400, "invalid-command-request", "Command request fields are invalid.");
}

export async function handleCloudCommandRequest(request: Request, dependencies: CloudCommandRouteDependencies): Promise<Response> {
  const body = await parsedCommandRequest(request, dependencies.appOrigin);
  if (body instanceof Response) return body;

  const client = await dependencies.createClient();
  const { data, error } = await client.auth.getClaims();
  const subject = authSubjectSchema.safeParse(data?.claims?.sub);
  if (error || !subject.success || data?.claims?.role !== "authenticated") {
    return failure(401, "auth-required", "A verified session is required.");
  }
  const membership = await dependencies.resolveWorkspace(subject.data);
  if (membership.role !== "owner") {
    return failure(403, "workspace-access-denied", "Workspace owner access is required.");
  }
  const rate = await dependencies.consumeRateLimit(membership.workspaceId, request);
  if (!rate.allowed) {
    return failure(429, "command-rate-limited", "Too many command requests. Try again later.", { "retry-after": String(rate.retryAfterSeconds) });
  }
  const result = await dependencies.execute(membership.workspaceId, body.command, body.input ?? {});
  return json(result, result.ok ? 200 : result.error.code === "workspace-access-denied" ? 403 : 400);
}

export async function handleLocalCommandRequest(request: Request, dependencies: LocalCommandRouteDependencies): Promise<Response> {
  const body = await parsedCommandRequest(request, dependencies.appOrigin);
  if (body instanceof Response) return body;
  const result = await dependencies.execute(dependencies.workspaceId, body.command, body.input ?? {});
  return json(result, result.ok ? 200 : result.error.code === "workspace-access-denied" ? 403 : 400);
}
