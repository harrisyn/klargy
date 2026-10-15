// Single source of truth for the product's display name. Set APP_NAME in
// the repo-root .env - docker-compose forwards it to this service as-is.
export const DEFAULT_APP_NAME = 'Klargy';
export const APP_NAME = process.env.APP_NAME || DEFAULT_APP_NAME;

// Public base URL of the web app (root domain, no tenant subdomain). Desk
// launch links, status links and email links are built on it.
const CONFIGURED_APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
const DEV_FALLBACK_URL = 'http://localhost:8003';

/** True when APP_URL (or FRONTEND_URL) is set. */
export const APP_URL_CONFIGURED = CONFIGURED_APP_URL !== '';

/**
 * The configured base URL, or the development fallback. Kept for code that
 * only needs the root hostname (CORS, custom domains); links use appUrl().
 */
export const APP_URL = CONFIGURED_APP_URL || DEV_FALLBACK_URL;

export const APP_URL_MISSING_MESSAGE =
  'APP_URL is not set. Set it to the public root URL of the web app (for example https://klargy.com); ' +
  'desk, status and email links are built on it, with tenant workspaces at <slug>.<host>.';

// Development only: the root URL of the last request, when APP_URL is unset.
let requestAppUrl: string | null = null;

/**
 * The root URL links are built on. APP_URL when set. In production a missing
 * APP_URL is an error (links would point at a guess). In development it is
 * taken from the requests the app is serving (see rememberRequestAppUrl), so
 * `npm run dev` on :3000 links to :3000 without any setup.
 */
export function appUrl(): string {
  if (CONFIGURED_APP_URL) return CONFIGURED_APP_URL;
  if (process.env.NODE_ENV === 'production') throw new Error(APP_URL_MISSING_MESSAGE);
  return requestAppUrl ?? DEV_FALLBACK_URL;
}

/** Fails fast at startup in production when APP_URL is missing. */
export function assertAppUrlConfigured(): void {
  if (!CONFIGURED_APP_URL && process.env.NODE_ENV === 'production') throw new Error(APP_URL_MISSING_MESSAGE);
}

/**
 * Development with no APP_URL: remembers the root URL of an incoming request
 * (its protocol and host, without the tenant subdomain), so links built later,
 * even outside a request (webhooks, notifications), use the address the app
 * is actually reached on.
 */
export function rememberRequestAppUrl(
  headers: Record<string, string | string[] | undefined>,
  protocol: string,
  subdomainOf: (host: string) => string | null
): void {
  if (CONFIGURED_APP_URL || process.env.NODE_ENV === 'production') return;
  const first = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim();
  const host = first(headers['x-forwarded-host']) || first(headers.host);
  if (!host || !/^[a-z0-9.:\-\[\]]+$/i.test(host)) return;
  const proto = first(headers['x-forwarded-proto']) || protocol || 'http';
  if (proto !== 'http' && proto !== 'https') return;
  const slug = subdomainOf(host);
  const root = slug && host.toLowerCase().startsWith(`${slug}.`) ? host.slice(slug.length + 1) : host;
  requestAppUrl = `${proto}://${root}`;
}

/** Builds a URL on the root domain, a tenant subdomain, or the admin subdomain. */
export function buildAppUrl(path: string, subdomain?: string | null): string {
  const base = new URL(appUrl());
  if (subdomain) base.host = `${subdomain}.${base.host}`;
  return new URL(path, base).toString();
}

/** The patient's live status page for an entry, on the organisation's
 * workspace host (the "you've joined" message and Connect's `statusUrl`). */
export function statusUrlFor(queueId: string, entryId: string, slug?: string | null): string {
  return buildAppUrl(`/status/${queueId}/${entryId}`, slug);
}
