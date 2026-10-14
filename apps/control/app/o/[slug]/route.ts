import { StripeAdapter, stripeApiKeyMode } from "@opspot/adapters";
import { PublicSellableAssetService } from "@opspot/domain";
import { createLocalCompanyRuntime, readEngineMode } from "../../../lib/company-runtime";
import { getCloudKernelStorage } from "../../../lib/kernel-storage";
import { handlePublicOfferGet } from "../../../lib/public-offer-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function key(name: string): Uint8Array {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

let localEngine: ReturnType<typeof createLocalCompanyRuntime> | undefined;

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const mode = readEngineMode();
    const storage = mode === "local"
      ? (localEngine ??= createLocalCompanyRuntime(process.env.ENGINE_ROOT ?? process.cwd())).storage
      : await getCloudKernelStorage();
    const publicOfferKey = key("PUBLIC_OFFER_SLUG_KEY");
    const publicOfferKeyId = process.env.PUBLIC_OFFER_SLUG_KEY_ID;
    if (!publicOfferKeyId) throw new Error("PUBLIC_OFFER_SLUG_KEY_ID is required");
    const sessionId = new URL(request.url).searchParams.get("session_id");
    const dependencies = {
      storage,
      assets: new PublicSellableAssetService(storage, publicOfferKey, publicOfferKeyId),
      ...(sessionId ? (() => {
        const apiKey = process.env.STRIPE_SECRET_KEY;
        const accessKeyId = process.env.DIGITAL_ACCESS_KEY_ID;
        if (!apiKey || !accessKeyId) throw new Error("offer access providers are unavailable");
        return {
          stripe: { adapter: new StripeAdapter(apiKey), mode: stripeApiKeyMode(apiKey) },
          access: { key: key("DIGITAL_ACCESS_ROOT_KEY"), keyId: accessKeyId },
          ...(mode === "local" && process.env.ENGINE_ALLOW_FIXTURE_PROVIDERS === "1" ? { allowFixtureAccess: true } : {})
        };
      })() : {})
    };
    return handlePublicOfferGet(request, (await context.params).slug, dependencies);
  } catch {
    return new Response("Offer unavailable", { status: 503, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  }
}
