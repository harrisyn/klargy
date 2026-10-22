import type { Metadata } from 'next';
import { headers } from 'next/headers';
import HomeClient from './HomeClient';
import { jsonLd, siteUrl } from '@/lib/marketing/site';
import { readRuntimeConfigFromEnv } from '@/lib/runtimeConfig';
import { extractSubdomain, extractCustomDomainCandidate } from '@/lib/subdomain';

// Server wrapper so the root page can carry its own search metadata; what it
// shows (landing, dashboard or tenant sign-in) is decided in HomeClient.
const DESCRIPTION =
  'Queue management system and virtual queue software for clinics, restaurants, salons, banks and offices. QR check-in, live wait times, SMS alerts and lobby screens. Free plan.';

async function isTenantHost(): Promise<boolean> {
  const host = (await headers()).get('host') || '';
  return !!extractSubdomain(host) || !!extractCustomDomainCandidate(host);
}

export async function generateMetadata(): Promise<Metadata> {
  const { appName } = readRuntimeConfigFromEnv();
  // A tenant's own address shows its sign-in or dashboard, not the marketing page.
  if (await isTenantHost()) return { title: appName, robots: { index: false } };
  const title = `${appName}: Queue Management System & Virtual Queue Software`;
  return {
    title,
    description: DESCRIPTION,
    alternates: { canonical: siteUrl('/') },
    openGraph: { title, description: DESCRIPTION, url: siteUrl('/'), siteName: appName, type: 'website' },
    twitter: { card: 'summary', title, description: DESCRIPTION },
  };
}

export default async function Home() {
  if (await isTenantHost()) return <HomeClient />;
  const { appName } = readRuntimeConfigFromEnv();
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: appName,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: siteUrl('/'),
    description: DESCRIPTION,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Free plan for one location' },
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(structured)} />
      <HomeClient />
    </>
  );
}
