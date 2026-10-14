import { getCloudKernelStorage } from "../../../lib/kernel-storage";
import { readSupabaseServerConfig } from "../../../lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export async function GET(): Promise<Response> {
  try {
    readSupabaseServerConfig();
    await getCloudKernelStorage();
    return Response.json({
      ok: true,
      status: "ready",
      kernelVersion: process.env.OPSPOT_KERNEL_VERSION ?? "development"
    }, { headers });
  } catch {
    return Response.json({ ok: false, status: "not-ready" }, { status: 503, headers });
  }
}
