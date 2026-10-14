import type { PostgresKernelStorage } from "@opspot/storage";
import { authRateLimitSecret, hmacRateLimitBucketKey, trustedClientAddress } from "./auth-rate-limit";

export type ConsumeCommandRateLimit = (
  workspaceId: string,
  request: Request
) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

export function createPostgresCommandRateLimiter(
  storage: () => Promise<PostgresKernelStorage>,
  environment: NodeJS.ProcessEnv = process.env
): ConsumeCommandRateLimit {
  return async (workspaceId, request) => {
    const key = authRateLimitSecret(environment);
    return (await storage()).consumeAuthRateLimit({
      bucketKeys: [
        hmacRateLimitBucketKey(key, "company-command", "ip", trustedClientAddress(request, environment)),
        hmacRateLimitBucketKey(key, "company-command", "workspace", workspaceId)
      ],
      limit: 120,
      windowSeconds: 60
    });
  };
}
