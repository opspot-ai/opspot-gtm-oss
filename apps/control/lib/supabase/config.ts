type Environment = Record<string, string | undefined>;

export interface SupabaseServerConfig {
  url: string;
  publishableKey: string;
  appOrigin: string;
}

function legacyJwtRole(value: string): string | undefined {
  const payload = value.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: unknown };
    return typeof parsed.role === "string" ? parsed.role : undefined;
  } catch {
    return undefined;
  }
}

function publishableKey(value: string | undefined): string {
  if (!value || value.length > 2_048) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required");
  if (value.startsWith("sb_secret_") || legacyJwtRole(value) === "service_role") {
    throw new Error("a Supabase secret or service-role key must never be used by the control app");
  }
  if (!value.startsWith("sb_publishable_") && legacyJwtRole(value) !== "anon") {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable or legacy anon key");
  }
  return value;
}

function rootUrl(value: string | undefined, label: string, allowLocalHttp: boolean): string {
  if (!value) throw new Error(`${label} is required`);
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`${label} must be an origin URL`);
  if (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url.origin;
}

export function readSupabaseServerConfig(environment: Environment = process.env): SupabaseServerConfig {
  return {
    url: rootUrl(environment.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL", true),
    publishableKey: publishableKey(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    appOrigin: rootUrl(environment.OPSPOT_APP_ORIGIN, "OPSPOT_APP_ORIGIN", environment.NODE_ENV !== "production")
  };
}
