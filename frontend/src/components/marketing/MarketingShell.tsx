import React from 'react';
import Link from 'next/link';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { APP_NAME } from '@/lib/appConfig';
import { USE_CASES } from '@/lib/marketing/useCases';
import styles from './marketing.module.css';

// Header and footer for the public marketing pages. Server-rendered, same
// look as the landing page's nav and footer.
export default function MarketingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <Link href="/" className={styles.brand} aria-label={`${APP_NAME} home`}>
          <BrandLogo height={36} compactBelow={480} />
        </Link>
        <nav className={styles.navLinks} aria-label="Site">
          <Link href="/use-cases" className={`${styles.navLink} ${styles.navHideSm}`}>Use cases</Link>
          <Link href="/pricing" className={styles.navLink}>Pricing</Link>
          <Link href="/login" className={`${styles.navLink} ${styles.navHideSm}`}>Sign in</Link>
          <Link href="/register" className={`${styles.btnPrimary} ${styles.btnSmall}`}>Start free</Link>
        </nav>
      </header>

      <main>{children}</main>

      <footer className={styles.footer}>
        <div className={styles.footerCols}>
          <div className={styles.footerBrand}>
            <BrandLogo height={30} />
            <p>Queue management for anywhere people wait.</p>
          </div>
          <nav aria-label="Use cases">
            <p className={styles.footerHead}>Use cases</p>
            <ul>
              {USE_CASES.map((u) => (
                <li key={u.slug}><Link href={`/use-cases/${u.slug}`}>{u.name}</Link></li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Product">
            <p className={styles.footerHead}>Product</p>
            <ul>
              <li><Link href="/#how-it-works">How it works</Link></li>
              <li><Link href="/pricing">Pricing</Link></li>
              <li><Link href="/use-cases">All use cases</Link></li>
              <li><Link href="/locations">Find a location</Link></li>
            </ul>
          </nav>
          <nav aria-label="Account">
            <p className={styles.footerHead}>Account</p>
            <ul>
              <li><Link href="/register">Start free</Link></li>
              <li><Link href="/login">Sign in</Link></li>
              <li><Link href="/privacy">Privacy</Link></li>
              <li><Link href="/terms">Terms</Link></li>
            </ul>
          </nav>
        </div>
        <p className={styles.footerBase}>© {new Date().getFullYear()} {APP_NAME}</p>
      </footer>
    </div>
  );
}

/** "Home › Use cases › Clinics" trail; the last item is the current page. */
export function Breadcrumbs({ items }: { items: { name: string; href: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.crumbs}>
      <ol>
        {items.map((item, i) => (
          <li key={item.href}>
            {i < items.length - 1 ? <Link href={item.href}>{item.name}</Link> : <span aria-current="page">{item.name}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ClosingCta({ title, text, secondary = { name: 'See pricing', href: '/pricing' } }: { title: string; text: string; secondary?: { name: string; href: string } }) {
  return (
    <section className={styles.section}>
      <div className={styles.closingInner}>
        <div>
          <h2>{title}</h2>
          <p>{text}</p>
        </div>
        <div className={styles.closingActions}>
          <Link href="/register" className={styles.btnInverse}>Start free</Link>
          <Link href={secondary.href} className={styles.btnGhostLight}>{secondary.name}</Link>
        </div>
      </div>
    </section>
  );
}

export function Faqs({ faqs, title = 'Questions people ask' }: { faqs: { q: string; a: string }[]; title?: string }) {
  return (
    <section className={styles.section} aria-labelledby="faq-title">
      <h2 id="faq-title" className={styles.sectionTitle}>{title}</h2>
      <div className={styles.faqs}>
        {faqs.map((f) => (
          <details key={f.q} className={styles.faq}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
