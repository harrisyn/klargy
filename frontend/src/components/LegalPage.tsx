import React from 'react';
import Link from 'next/link';
import { APP_NAME } from '@/lib/appConfig';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { getRuntimeConfig } from '@/lib/runtimeConfig';

// Shared shell for /privacy and /terms. The copy on those pages describes
// what this product actually stores and does; the operator still needs to
// add their legal entity, jurisdiction and contact details before launch
// (LEGAL_CONTACT_EMAIL fills the contact line).
export const LEGAL_CONTACT = getRuntimeConfig().legalContactEmail;

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--gray-50)' }}>
      <header style={{ background: 'var(--gray-900)', padding: '1rem 1.5rem' }}>
        <Link href="/" aria-label={`${APP_NAME} home`} style={{ display: 'inline-flex', color: 'white', fontWeight: 700, fontSize: '1.125rem' }}>
          <BrandLogo height={28} surface="dark" />
        </Link>
      </header>
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '2.5rem 1.25rem 4rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--gray-900)', marginBottom: '0.25rem' }}>{title}</h1>
        <p className="muted" style={{ marginBottom: '2rem' }}>Last updated {updated}</p>
        <div className="legal-body">{children}</div>
      </main>
      <style>{`
        .legal-body h2 { font-size: 1.125rem; font-weight: 600; color: var(--gray-900); margin: 2rem 0 0.5rem; }
        .legal-body p, .legal-body li { color: var(--gray-700); line-height: 1.7; font-size: 0.975rem; }
        .legal-body ul { padding-left: 1.25rem; margin: 0.5rem 0; }
        .legal-body a { color: var(--primary-700); text-decoration: underline; }
      `}</style>
    </div>
  );
}
