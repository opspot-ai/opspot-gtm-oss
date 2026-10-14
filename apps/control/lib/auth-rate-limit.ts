import { createHmac } from "node:crypto";
import type { PostgresKernelStorage } from "@opspot/storage";

export type MutableAuthAction = "sign-in" | "sign-up" | "recover" | "sign-out" | "update-password";
export type AuthRateLimitResult = { allowed: boolean; retryAfterSeconds: number };
export type ConsumeAuthRateLimit = (action: MutableAuthAction, request: Request, email?: string) => Promise<AuthRateLimitResult>;

const limits: Record<MutableAuthAction, { attempts: number; windowSeconds: number }> = {
  "sign-in": { attempts: 10, windowSeconds: 10 * 60 },
  "sign-up": { attempts: 3, windowSeconds: 60 * 60 },
  recover: { attempts: 3, windowSeconds: 60 * 60 },
  "sign-out": { attempts: 30, windowSeconds: 60 },
  "update-password": { attempts: 5, windowSeconds: 15 * 60 }
};

export function authRateLimitSecret(environment: NodeJS.ProcessEnv): string {
  const value = environment.AUTH_RATE_LIMIT_SECRET;
  if (!value || Buffer.byteLength(value, "utf8") < 32) throw new Error("AUTH_RATE_LIMIT_SECRET must contain at least 32 bytes");
  return value;
}

export function trustedClientAddress(request: Request, environment: NodeJS.ProcessEnv): string {
  const header = environment.VERCEL === "1" ? "x-vercel-forwarded-for" : environment.NODE_ENV === "production" ? undefined : "x-forwarded-for";
  const candidate = header ? request.headers.get(header)?.split(",")[0]?.trim() : undefined;
  return candidate && /^[0-9a-f:.]{1,64}$/i.test(candidate) ? candidate : "unknown";
}

export function hmacRateLimitBucketKey(key: string, scope: string, dimension: string, value: string): string {
  return createHmac("sha256", key).update(`${scope}\0${dimension}\0${value}`).digest("hex");
}

export function createPostgresAuthRateLimiter(
  storage: () => Promise<PostgresKernelStorage>,
  environment: NodeJS.ProcessEnv = process.env
): ConsumeAuthRateLimit {
  return async (action, request, email) => {
    const key = authRateLimitSecret(environment);
    const bucketKeys = [hmacRateLimitBucketKey(key, action, "ip", trustedClientAddress(request, environment))];
    if (email) bucketKeys.push(hmacRateLimitBucketKey(key, action, "email", email.trim().toLowerCase()));
    const limit = limits[action];
    return (await storage()).consumeAuthRateLimit({ bucketKeys, limit: limit.attempts, windowSeconds: limit.windowSeconds });
  };
}
