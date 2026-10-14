import { createConfiguredCloudCompanyRuntime } from "../../../../lib/company-runtime";
import { handleCloudWorkerRequest } from "../../../../lib/cloud-worker-route";
import { getCloudKernelStorage } from "../../../../lib/kernel-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleCloudWorkerRequest(request, {
      ...(process.env.CRON_SECRET ? { cronSecret: process.env.CRON_SECRET } : {}),
      listRunnableWorkspaceIds: (input) => getCloudKernelStorage().then((storage) => storage.listRunnableWorkspaceIds(input)),
      runWorkspaceOnce: async (workspaceId) => (await createConfiguredCloudCompanyRuntime(workspaceId)).runWorkerOnce()
    });
  } catch {
    return Response.json({ ok: false, error: { code: "worker-unavailable", message: "Cloud worker is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}
