import type { ReactNode } from "react";
import Link from "next/link";

type PublicPageProps = {
  title: string;
  children: ReactNode;
};

export function PublicPage({ title, children }: PublicPageProps) {
  return (
    <main className="public-page">
      <header className="public-page-header">
        <Link className="brand public-brand" href="/">OpSpot <span>GTM</span></Link>
        <nav aria-label="Service information">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/support">Support</Link>
          <Link href="/security">Security</Link>
        </nav>
      </header>
      <article className="public-page-content">
        <p className="eyebrow">OpSpot GTM</p>
        <h1>{title}</h1>
        {children}
      </article>
    </main>
  );
}
