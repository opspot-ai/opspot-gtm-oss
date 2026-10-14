import { ResendEmailAdapter, StripeAdapter, stripeApiKeyMode } from "@opspot/adapters";
import { PublicSellableAssetService } from "@opspot/domain";
import { createConfiguredCloudCompanyRuntime, createLocalCompanyRuntime, readEngineMode } from "../../../../../lib/company-runtime";
import { createPostgresCommandRateLimiter } from "../../../../../lib/command-rate-limit";
import { getCloudKernelStorage } from "../../../../../lib/kernel-storage";
import { handleProviderRequest, type ProviderRouteDependencies } from "../../../../../lib/provider-route";
import { readSupabaseServerConfig } from "../../../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cryptoKey(name: string): Uint8Array {
  const decoded = Buffer.from(required(name), "base64url");
  if (decoded.byteLength !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

let localEngine: ReturnType<typeof createLocalCompanyRuntime> | undefined;
const localRate = new Map<string, { startedAt: number; count: number }>();

function localRuntime() {
  return localEngine ??= createLocalCompanyRuntime(process.env.ENGINE_ROOT ?? process.cwd());
}

async function consumeLocalRateLimit(workspaceId: string) {
  const now = Date.now();
  const current = localRate.get(workspaceId);
  if (!current || now - current.startedAt >= 60_000) {
    localRate.set(workspaceId, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  current.count += 1;
  return { allowed: current.count <= 120, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1000)) };
}

function genericConfig(result: ProviderRouteDependencies, mode: "local" | "cloud") {
  const values = [process.env.GENERIC_WEBHOOK_SIGNER, process.env.GENERIC_WEBHOOK_SECRET, process.env.GENERIC_WEBHOOK_WORKSPACE_ID, process.env.GENERIC_WEBHOOK_COMPANY_ID];
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error("generic webhook signer, secret, workspace, and company are required together");
  if (!values.every(Boolean)) return;
  if (values[1]!.length < 32 || (mode === "local" && values[2] !== "workspace_local")) throw new Error("generic webhook binding is invalid");
  result.generic = { signer: values[0]!, signingSecret: values[1]!, scope: { workspaceId: values[2]!, companyId: values[3]! } };
}

async function dependencies(provider: string, action: string): Promise<ProviderRouteDependencies> {
  const mode = readEngineMode();
  const local = mode === "local" ? localRuntime() : undefined;
  const cloudStorage = mode === "cloud" ? await getCloudKernelStorage() : undefined;
  const storage = local?.storage ?? cloudStorage!;
  const result: ProviderRouteDependencies = { storage };
  if (action !== "webhook") {
    if (mode === "cloud") {
      const config = readSupabaseServerConfig();
      result.auth = {
        appOrigin: config.appOrigin,
        createClient: createServerSupabaseClient,
        resolveWorkspace: (authSubject) => cloudStorage!.resolveOrCreatePersonalWorkspaceForAuthSubject(authSubject),
        consumeRateLimit: createPostgresCommandRateLimiter(getCloudKernelStorage)
      };
    } else {
      result.auth = {
        appOrigin: process.env.ENGINE_DASHBOARD_URL ?? "http://127.0.0.1:3210",
        localWorkspaceId: "workspace_local",
        createClient: async () => { throw new Error("local provider owner actions use CLI or MCP"); },
        resolveWorkspace: async () => { throw new Error("local provider owner actions use CLI or MCP"); },
        consumeRateLimit: consumeLocalRateLimit
      };
    }
  }
  if (provider === "stripe") {
    const apiKey = required("STRIPE_SECRET_KEY");
    result.stripe = {
      adapter: new StripeAdapter(apiKey),
      mode: stripeApiKeyMode(apiKey),
      ...(action === "webhook" ? { webhookSecret: required("STRIPE_WEBHOOK_SECRET") } : {}),
      ...(["checkout", "checkout-trial-bypass"].includes(action) ? { priceId: required("STRIPE_PRICE_ID") } : {}),
      ...(action === "checkout-trial-bypass" ? { trialBypassSecret: required("STRIPE_TRIAL_BYPASS_SECRET") } : {})
    };
    const offerValues = [process.env.PUBLIC_OFFER_SLUG_KEY, process.env.PUBLIC_OFFER_SLUG_KEY_ID, process.env.DIGITAL_ACCESS_ROOT_KEY, process.env.DIGITAL_ACCESS_KEY_ID];
    if (offerValues.some(Boolean) && !offerValues.every(Boolean)) throw new Error("public offer and digital access keys must be configured together");
    if (offerValues.every(Boolean)) {
      result.publicOffer = {
        assets: new PublicSellableAssetService(storage, cryptoKey("PUBLIC_OFFER_SLUG_KEY"), required("PUBLIC_OFFER_SLUG_KEY_ID")),
        access: { key: cryptoKey("DIGITAL_ACCESS_ROOT_KEY"), keyId: required("DIGITAL_ACCESS_KEY_ID") },
        ...(mode === "local" && process.env.ENGINE_ALLOW_FIXTURE_PROVIDERS === "1" ? { allowFixtureAccess: true } : {})
      };
    } else if (action === "offer-checkout") {
      throw new Error("public offer provider configuration is required");
    }
  }
  if (provider === "resend") {
    result.resend = {
      adapter: new ResendEmailAdapter(required("RESEND_API_KEY")),
      ...(action === "webhook" ? {
        webhookSecret: required("RESEND_WEBHOOK_SECRET"),
        connectorScope: { workspaceId: mode === "local" ? "workspace_local" : required("RESEND_CONNECTOR_WORKSPACE_ID"), companyId: required("RESEND_CONNECTOR_COMPANY_ID") },
        ownedInboundRecipient: required("RESEND_OWNED_INBOUND_RECIPIENT")
      } : {})
    };
    if (action === "send") {
      result.runAcquisitionOnce = async (workspaceId) => {
        const worker = mode === "local" ? localRuntime().runtime.goldenWorker : (await createConfiguredCloudCompanyRuntime(workspaceId)).goldenWorker;
        if (!worker) throw new Error("golden acquisition worker is unavailable");
        return worker.runOnce(workspaceId);
      };
    }
  }
  if (provider === "generic") genericConfig(result, mode);
  return result;
}

export async function POST(request: Request, context: { params: Promise<{ provider: string; action: string }> }): Promise<Response> {
  const { provider, action } = await context.params;
  try {
    return handleProviderRequest(request, provider, action, await dependencies(provider, action));
  } catch {
    return Response.json({ ok: false, error: { code: "provider-unavailable", message: "Provider route is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}
