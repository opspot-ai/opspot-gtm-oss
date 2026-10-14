import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Support | OpSpot GTM" };

export default function SupportPage() {
  return <PublicPage title="Support"><p>This distribution provides software for local or operator-managed use. It does not include an OpSpot-hosted account, billing, or support service. The operator of a self-hosted installation manages its deployment, providers, data, and support.</p><p>The issue tracker for the new repository is not active yet. Once the owner activates it, use it for reproducible, non-sensitive software issues. Do not include credentials, customer data, or private operational material in public issues.</p><p>No monitored security-reporting channel is active yet. See the <a href="/security">security page</a> for the pending activation state.</p></PublicPage>;
}
