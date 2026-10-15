// Single source of truth for the product's display name. Set APP_NAME in
// the repo-root .env - docker-compose forwards it to this service as-is.
export const DEFAULT_APP_NAME = 'Klargy';
export const APP_NAME = process.env.APP_NAME || DEFAULT_APP_NAME;

// Public base URL of the web app (root domain, no tenant subdomain).
export const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:8003').replace(/\/$/, '');

/** Builds a URL on the root domain, a tenant subdomain, or the admin subdomain. */
export function buildAppUrl(path: string, subdomain?: string | null): string {
  const base = new URL(APP_URL);
  if (subdomain) base.host = `${subdomain}.${base.host}`;
  return new URL(path, base).toString();
}

/** The patient's live status page for an entry, on the organisation's
 * workspace host (the "you've joined" message and Connect's `statusUrl`). */
export function statusUrlFor(queueId: string, entryId: string, slug?: string | null): string {
  return buildAppUrl(`/status/${queueId}/${entryId}`, slug);
}
