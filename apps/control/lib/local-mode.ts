const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const localHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export const isLoopbackHost = (hostname: string): boolean => loopbackHosts.has(hostname.toLowerCase());
export const isLocalMode = (environment: NodeJS.ProcessEnv = process.env): boolean => environment.ENGINE_MODE === "local";

export function localAuthResponse(request: Request, action: string, environment: NodeJS.ProcessEnv = process.env): Response | undefined {
  if (!isLocalMode(environment)) return undefined;
  if (!isLoopbackHost(new URL(request.url).hostname)) {
    return Response.json({ ok: false, error: { code: "local-origin-required", message: "Local mode accepts loopback origins only." } }, { status: 403, headers: localHeaders });
  }
  if (action === "session" && request.method === "GET") {
    return Response.json({ ok: false, error: { code: "auth-unavailable", message: "Authentication is unavailable in local mode." } }, { status: 503, headers: localHeaders });
  }
  return Response.json({ ok: false, error: { code: "local-auth-disabled", message: "Cloud authentication actions are disabled in local mode." } }, { status: 403, headers: localHeaders });
}
