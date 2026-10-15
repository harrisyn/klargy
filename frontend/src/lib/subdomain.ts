import { getRuntimeConfig } from './runtimeConfig';

const APP_DOMAIN = getRuntimeConfig().appDomain;

/**
 * Extracts the subdomain from a Host header value, relative to APP_DOMAIN.
 * Returns null for the bare root domain or `www`.
 * Returns null (treated as root) for any host that isn't a subdomain of
 * APP_DOMAIN at all (e.g. a raw IP during local debugging).
 */
export function extractSubdomain(host: string): string | null {
  const hostname = host.split(':')[0].toLowerCase();
  const domain = APP_DOMAIN.split(':')[0].toLowerCase();

  if (hostname === domain || hostname === `www.${domain}`) {
    return null;
  }
  if (!hostname.endsWith(`.${domain}`)) {
    return null;
  }
  return hostname.slice(0, hostname.length - domain.length - 1);
}

const IP_ADDRESS_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Returns the lowercased hostname when `host` looks like it could be a
 * verified custom domain worth resolving against the backend - i.e. it's
 * neither a subdomain of APP_DOMAIN, the bare APP_DOMAIN itself, nor a
 * localhost/IP host used for local debugging. Returns null otherwise.
 */
export function extractCustomDomainCandidate(host: string): string | null {
  const hostname = host.split(':')[0].toLowerCase();
  const domain = APP_DOMAIN.split(':')[0].toLowerCase();

  if (hostname === domain || hostname === `www.${domain}`) return null;
  if (hostname.endsWith(`.${domain}`)) return null;
  if (hostname === 'localhost' || IP_ADDRESS_PATTERN.test(hostname)) return null;

  return hostname;
}

function protocolFor(domain: string): string {
  return domain.startsWith('localhost') ? 'http' : 'https';
}

export function buildTenantUrl(slug: string, path: string = '/'): string {
  const protocol = protocolFor(APP_DOMAIN);
  return `${protocol}://${slug}.${APP_DOMAIN}${path}`;
}

export function buildAdminUrl(path: string = '/'): string {
  const protocol = protocolFor(APP_DOMAIN);
  return `${protocol}://admin.${APP_DOMAIN}${path}`;
}

export function buildRootUrl(path: string = '/'): string {
  const protocol = protocolFor(APP_DOMAIN);
  return `${protocol}://${APP_DOMAIN}${path}`;
}
