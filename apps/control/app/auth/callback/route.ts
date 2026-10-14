import { handleAuthCallback } from "../../../lib/auth-callback";
import { readSupabaseServerConfig } from "../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const config = readSupabaseServerConfig();
    return await handleAuthCallback(request, { appOrigin: config.appOrigin, createClient: createServerSupabaseClient });
  } catch {
    return Response.json({ ok: false, error: { code: "auth-unavailable", message: "Authentication is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}
