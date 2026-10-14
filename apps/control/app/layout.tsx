import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "OpSpot GTM Cloud",
  description: "Run companies with bounded autonomy, proof, and explicit founder approvals."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
