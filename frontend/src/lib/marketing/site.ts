// Shared helpers for the public marketing pages (/use-cases, /pricing). These
// pages render on the server so search engines get the full text in the
// first response; canonical links always point at the root domain, so the
// same page served on a tenant's address doesn't compete with it.
import { APP_URL } from '@/server/config/appConfig';
import { readRuntimeConfigFromEnv } from '@/lib/runtimeConfig';

export function siteUrl(path = '/'): string {
  return `${APP_URL}${path === '/' ? '' : path}`;
}

/** Where "Talk to us" goes: SALES_CONTACT_EMAIL, else LEGAL_CONTACT_EMAIL, else sign-up. */
export function salesContactHref(subject: string): string {
  const email = process.env.SALES_CONTACT_EMAIL || readRuntimeConfigFromEnv().legalContactEmail;
  if (!email) return '/register';
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

/** Serialise structured data for a <script type="application/ld+json"> tag. */
export function jsonLd(data: unknown): { __html: string } {
  return { __html: JSON.stringify(data).replace(/</g, '\\u003c') };
}
