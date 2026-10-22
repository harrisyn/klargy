import type { MetadataRoute } from 'next';
import { USE_CASES } from '@/lib/marketing/useCases';
import { siteUrl } from '@/lib/marketing/site';

// Public pages on the root domain only. Tenant pages (sign-in, queues,
// tickets) belong to each organization and are left out.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl('/'), changeFrequency: 'monthly', priority: 1 },
    { url: siteUrl('/pricing'), changeFrequency: 'monthly', priority: 0.9 },
    { url: siteUrl('/use-cases'), changeFrequency: 'monthly', priority: 0.9 },
    ...USE_CASES.map((u) => ({ url: siteUrl(`/use-cases/${u.slug}`), changeFrequency: 'monthly' as const, priority: 0.8 })),
    { url: siteUrl('/privacy'), changeFrequency: 'yearly', priority: 0.2 },
    { url: siteUrl('/terms'), changeFrequency: 'yearly', priority: 0.2 },
  ];
}
