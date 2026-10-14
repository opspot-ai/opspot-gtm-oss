import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Terms | OpSpot GTM" };

export default function TermsPage() {
  return <PublicPage title="Terms"><p>The software in this repository is distributed under the MIT License. This local distribution does not include an OpSpot-hosted account, subscription, billing service, or service contract.</p><p>An operator who connects third-party services is responsible for reviewing and following the terms that apply to those services. See the repository's root LICENSE file for the software license.</p></PublicPage>;
}
