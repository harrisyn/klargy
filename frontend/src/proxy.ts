import { NextRequest, NextResponse } from 'next/server';
import { extractSubdomain, extractCustomDomainCandidate, buildAdminUrl } from '@/lib/subdomain';
import prisma from '@/server/lib/prisma';
import { deskFrameAncestors, isDeskPath } from '@/lib/deskEmbed';

// Next 16 "proxy" (formerly middleware). Always runs on the Node.js
// runtime, so it can read the tenant straight from the database.
export const config = {
  // Everything except the API, Next internals and static files.
  matcher: ['/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|json|webmanifest|js)$).*)'],
};

// Tenant lookups are hot (every page view) and change rarely.
const CACHE_MS = 60_000;
const cache = new Map<string, { slug: string | null; expires: number }>();

async function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.slug;
  const slug = await load();
  cache.set(key, { slug, expires: Date.now() + CACHE_MS });
  if (cache.size > 5000) cache.clear();
  return slug;
}

const slugExists = (slug: string) =>
  cached(`slug:${slug}`, async () => {
    const org = await prisma.organization.findUnique({ where: { slug }, select: { slug: true } });
    return org?.slug ?? null;
  });

const slugForCustomDomain = (domain: string) =>
  cached(`domain:${domain}`, async () => {
    const found = await prisma.customDomain.findFirst({
      where: { domain, status: 'VERIFIED' },
      select: { organization: { select: { slug: true } } },
    });
    return found?.organization.slug ?? null;
  });

const originCache = new Map<string, { origins: string[]; expires: number }>();

/** embedOrigins of the organisation's active integrations (Klargy Connect). */
async function embedOriginsFor(slug: string): Promise<string[]> {
  const hit = originCache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.origins;
  const integrations = await prisma.integration.findMany({
    where: { status: 'ACTIVE', organization: { slug } },
    select: { embedOrigins: true },
  });
  const origins = integrations.flatMap((i) => i.embedOrigins);
  originCache.set(slug, { origins, expires: Date.now() + CACHE_MS });
  if (originCache.size > 5000) originCache.clear();
  return origins;
}

/** The tenant's response; the desk gets frame-ancestors when the
 * organisation has EMR connections (see lib/deskEmbed). */
async function tenantResponse(pathname: string, slug: string, customDomain?: string) {
  const response = NextResponse.next();
  response.headers.set('x-tenant-slug', slug);
  if (customDomain) response.headers.set('x-tenant-custom-domain', customDomain);
  if (isDeskPath(pathname)) {
    // On a lookup error, refuse framing by others rather than allow it.
    const origins = await embedOriginsFor(slug).catch(() => null);
    const policy = origins ? deskFrameAncestors(origins) : "frame-ancestors 'self'";
    if (policy) response.headers.set('Content-Security-Policy', policy);
  }
  return response;
}

function notFound(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = '/workspace-not-found';
  return NextResponse.rewrite(url);
}

export async function proxy(req: NextRequest) {
  const host = req.headers.get('host') || '';
  const subdomain = extractSubdomain(host);
  const { pathname } = req.nextUrl;

  // Root domain / www: block direct /superadmin access from here. Before
  // falling back to that, check whether this host is a verified custom
  // domain - if so, treat it exactly like a tenant subdomain.
  if (!subdomain) {
    const candidate = extractCustomDomainCandidate(host);
    if (candidate) {
      const slug = await slugForCustomDomain(candidate).catch(() => null);
      if (slug) return tenantResponse(pathname, slug, candidate);
    }

    if (pathname.startsWith('/superadmin')) {
      return NextResponse.redirect(new URL(buildAdminUrl(pathname), req.url));
    }
    return NextResponse.next();
  }

  // Admin subdomain: only rewrite the bare root to the superadmin dashboard.
  if (subdomain === 'admin') {
    if (pathname === '/') {
      const url = req.nextUrl.clone();
      url.pathname = '/superadmin';
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  // Any other subdomain: treat as a tenant slug and resolve it. A DB error
  // fails to the not-found page rather than a 500 on every tenant request.
  const slug = await slugExists(subdomain).catch(() => null);
  if (!slug) return notFound(req);

  return tenantResponse(pathname, subdomain);
}
