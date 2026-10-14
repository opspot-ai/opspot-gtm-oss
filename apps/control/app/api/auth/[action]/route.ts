import { getCloudKernelStorage } from "../../../../lib/kernel-storage";
import { handleAuthRequest } from "../../../../lib/auth-route";
import { createPostgresAuthRateLimiter } from "../../../../lib/auth-rate-limit";
import { localAuthResponse } from "../../../../lib/local-mode";
import { readSupabaseServerConfig } from "../../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ action: string }> };

async function execute(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { action } = await context.params;
    const local = localAuthResponse(request, action);
    if (local) return local;
    const config = readSupabaseServerConfig();
    return await handleAuthRequest(request, action, {
      appOrigin: config.appOrigin,
      createClient: createServerSupabaseClient,
      consumeRateLimit: createPostgresAuthRateLimiter(getCloudKernelStorage),
      resolveWorkspace: async (authSubject) => (await getCloudKernelStorage()).resolveOrCreatePersonalWorkspaceForAuthSubject(authSubject)
    });
  } catch {
    return Response.json({ ok: false, error: { code: "auth-unavailable", message: "Authentication is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return execute(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return execute(request, context);
}
