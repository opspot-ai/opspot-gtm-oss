import { randomBytes } from "node:crypto";
import { GoldenProviderProofService, type DigitalAccessKey, type PublicSellableAssetService } from "@opspot/domain";
import { StripeAdapter } from "@opspot/adapters";
import type { KernelStorage } from "@opspot/storage";

export interface PublicOfferRouteDependencies {
  storage: KernelStorage;
  assets: PublicSellableAssetService;
  stripe?: { adapter: StripeAdapter; mode: "live" | "test" };
  access?: DigitalAccessKey;
  allowFixtureAccess?: boolean;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main>${body}</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function handlePublicOfferGet(
  request: Request,
  publicSlug: string,
  dependencies: PublicOfferRouteDependencies
): Promise<Response> {
  const asset = await dependencies.assets.getBySlug(publicSlug);
  if (!asset) return page("Offer unavailable", "<h1>Offer unavailable</h1>", 404);
  const company = await dependencies.storage.getCompany(asset.workspaceId, asset.companyId);
  if (!company || company.killed) return page("Offer unavailable", "<h1>Offer unavailable</h1>", 404);
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (sessionId) {
    if (!dependencies.stripe || !dependencies.access) return page("Access unavailable", "<h1>Access is temporarily unavailable</h1>", 503);
    try {
      const session = await dependencies.stripe.adapter.retrieveOperatedCheckoutAccess(sessionId);
      if (session.providerMode !== dependencies.stripe.mode || session.binding.workspaceId !== asset.workspaceId
        || session.binding.companyId !== asset.companyId || session.binding.offerId !== asset.assetId
        || session.binding.amount !== asset.amountCents || session.binding.currency !== asset.currency
        || session.amount !== asset.amountCents || session.currency !== asset.currency) {
        throw new Error("Checkout session is bound to another offer");
      }
      if (session.providerMode === "test" && dependencies.allowFixtureAccess !== true) {
        return page("Fixture access unavailable", "<h1>Test payment verified, but operational access is disabled</h1>", 403);
      }
      const redemption = await new GoldenProviderProofService(dependencies.storage).redeemDigitalAccess(
        { workspaceId: asset.workspaceId, companyId: asset.companyId },
        session.paymentIntentId,
        session.providerMode,
        dependencies.access,
        { allowFixture: dependencies.allowFixtureAccess === true }
      );
      if (!redemption.delivered) {
        return page(asset.offerName, `<h1>${escapeHtml(asset.offerName)}</h1><p>This access credential was already delivered. It cannot be displayed again.</p><p>${escapeHtml(asset.digitalPromise)}</p>`);
      }
      const fixtureLabel = session.providerMode === "test" ? "<p><strong>Fixture-only access. Not operational.</strong></p>" : "";
      return page(asset.offerName, `<h1>${escapeHtml(asset.offerName)}</h1>${fixtureLabel}<p>Payment verified. Your access credential is available once through this verified Checkout session.</p><pre>${escapeHtml(redemption.accessSecret)}</pre><p>${escapeHtml(asset.digitalPromise)}</p>`);
    } catch {
      return page("Access unavailable", "<h1>Access could not be verified</h1>", 403);
    }
  }
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: asset.currency.toUpperCase() }).format(asset.amountCents / 100);
  const idempotencyKey = randomBytes(24).toString("base64url");
  return page(asset.offerName, `<h1>${escapeHtml(asset.offerName)}</h1><p>${escapeHtml(asset.publicSummary)}</p><p>${escapeHtml(amount)}</p><p>${escapeHtml(asset.digitalPromise)}</p><form method="post" action="/api/providers/stripe/offer-checkout"><input type="hidden" name="slug" value="${escapeHtml(asset.publicSlug)}"><input type="hidden" name="idempotencyKey" value="${idempotencyKey}"><button type="submit">Buy now</button></form>`);
}
