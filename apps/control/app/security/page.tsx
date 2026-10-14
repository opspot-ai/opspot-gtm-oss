import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Security | OpSpot GTM" };

export default function SecurityPage() {
  return <PublicPage title="Security"><p>OpSpot GTM aims to scope company data, keep connector secrets out of client-facing state, and bound external actions by configured controls. These are product goals, not a claim of certification or audit coverage.</p><p><strong>Pending:</strong> GitHub private vulnerability reporting for the new repository has not been enabled or verified. Until then, there is no monitored report channel. Do not post credentials, customer data, or exploit details in public issues, and do not send them to an unverified inbox.</p></PublicPage>;
}
