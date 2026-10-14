import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Privacy | OpSpot GTM" };

export default function PrivacyPage() {
  return <PublicPage title="Privacy"><p>This distribution supports local and operator-managed use; it does not include an OpSpot-hosted account or service.</p><h2>Local data</h2><p>The documented setup creates a local SQLite database. The operator manages that database, backups, logs, and any copies.</p><h2>Connected services</h2><p>The runtime contains optional integrations. When an operator configures and uses one, information is sent to the selected provider under the operator's settings and that provider's terms. Review those terms before connecting real accounts. Deleting local runtime data does not remove separately managed backups or provider-side records.</p></PublicPage>;
}
