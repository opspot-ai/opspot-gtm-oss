import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthCallbackDependencies {
  appOrigin: string;
  createClient(): Promise<SupabaseClient>;
}

function failure(code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status: 400,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}

export async function handleAuthCallback(request: Request, dependencies: AuthCallbackDependencies): Promise<Response> {
  if (request.method !== "GET") return failure("method-not-allowed", "Auth callback requires GET.");
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  if (!code || code.length > 2_048 || (next !== "/" && next !== "/reset-password")) {
    return failure("invalid-auth-callback", "The recovery callback is invalid or expired.");
  }
  const { error } = await (await dependencies.createClient()).auth.exchangeCodeForSession(code);
  if (error) return failure("invalid-auth-callback", "The recovery callback is invalid or expired.");
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(next, dependencies.appOrigin).toString(),
      "cache-control": "private, no-store"
    }
  });
}
