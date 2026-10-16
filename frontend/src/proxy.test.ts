import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// /widget/desk may only be framed by the organisation's EMRs once it has
// any (docs/connect/v1.md section 6).

vi.mock('@/server/lib/prisma', () => ({
  default: {
    organization: { findUnique: vi.fn() },
    customDomain: { findFirst: vi.fn() },
    integration: { findMany: vi.fn() },
    user: { count: vi.fn() },
    setupToken: { findUnique: vi.fn(), createMany: vi.fn(), findUniqueOrThrow: vi.fn(), deleteMany: vi.fn() },
  },
}));

import prisma from '@/server/lib/prisma';
import { proxy } from './proxy';
import { resetSetupCache } from '@/server/services/setup.service';
import { deskFrameAncestors } from './lib/deskEmbed';

const request = (host: string, path: string) =>
  new NextRequest(`http://${host}${path}`, { headers: { host } });

beforeEach(() => {
  vi.clearAllMocks();
  resetSetupCache();
  (prisma.user.count as any).mockResolvedValue(1); // a superadmin exists
  (prisma.organization.findUnique as any).mockImplementation(async ({ where }: any) => ({ slug: where.slug }));
});

describe('desk frame-ancestors', () => {
  it('lists the active integrations’ embedOrigins', async () => {
    (prisma.integration.findMany as any).mockResolvedValue([
      { embedOrigins: ['https://emr.example.com', 'https://emr2.example.com'] },
      { embedOrigins: ['https://emr.example.com'] },
    ]);
    const res = await proxy(request('nyaho.localhost:8003', '/widget/desk'));
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://emr.example.com https://emr2.example.com"
    );
    expect((prisma.integration.findMany as any).mock.calls[0][0].where).toEqual({ status: 'ACTIVE', organization: { slug: 'nyaho' } });
  });

  it('leaves the desk embeddable anywhere for an organisation without EMR connections', async () => {
    (prisma.integration.findMany as any).mockResolvedValue([]);
    const res = await proxy(request('quiet.localhost:8003', '/widget/desk'));
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('only sets it on the desk', async () => {
    (prisma.integration.findMany as any).mockResolvedValue([{ embedOrigins: ['https://emr.example.com'] }]);
    const res = await proxy(request('other.localhost:8003', '/queue'));
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(prisma.integration.findMany).not.toHaveBeenCalled();
  });

  it('keeps junk out of the header', () => {
    expect(deskFrameAncestors(['https://ok.example.com', "https://x.com; script-src 'unsafe-inline'", '*'])).toBe(
      "frame-ancestors 'self' https://ok.example.com"
    );
    expect(deskFrameAncestors([])).toBeNull();
  });
});

describe('first-run setup', () => {
  it('sends every page to /setup while no superadmin exists', async () => {
    (prisma.user.count as any).mockResolvedValue(0);
    const res = await proxy(request('localhost:8003', '/login'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/setup');
    const setup = await proxy(request('localhost:8003', '/setup'));
    expect(setup.headers.get('location')).toBeNull();
  });

  it('closes /setup once a superadmin exists', async () => {
    const res = await proxy(request('localhost:8003', '/setup'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });
});
