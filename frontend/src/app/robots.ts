import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/marketing/site';

// Read per request: the sitemap needs the absolute root URL (APP_URL).
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin/', '/superadmin/', '/widget/', '/setup'],
    },
    sitemap: siteUrl('/sitemap.xml'),
  };
}
