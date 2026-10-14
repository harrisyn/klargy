import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  default: { integration: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('./subscription.middleware', () => ({ getOrganizationFeatures: vi.fn() }));

import prisma from '../lib/prisma';
import { getOrganizationFeatures } from './subscription.middleware';
import { generateApiKey } from '../lib/apiKeys';
import { authenticateIntegration, requireScope } from './integrationAuth.middleware';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const { key, hash } = generateApiKey();
const active = { id: 'int1', organizationId: 'org1', scopes: ['catalog:read'], status: 'ACTIVE', lastUsedAt: new Date() };

describe('authenticateIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getOrganizationFeatures as any).mockResolvedValue({ emrIntegration: true });
  });

  it('rejects a missing or malformed key without a lookup', async () => {
    const res = makeRes();
    const next = vi.fn();
    await authenticateIntegration({ headers: { authorization: 'Bearer not-a-key' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.integration.findUnique).not.toHaveBeenCalled();
  });

  it('looks the key up by its hash and attaches the integration', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(active);
    const req: any = { headers: { authorization: `Bearer ${key}` } };
    const next = vi.fn();
    await authenticateIntegration(req, makeRes(), next);
    expect((prisma.integration.findUnique as any).mock.calls[0][0].where).toEqual({ keyHash: hash });
    expect(next).toHaveBeenCalledWith();
    expect(req.integration).toEqual({ id: 'int1', organizationId: 'org1', scopes: ['catalog:read'] });
  });

  it('rejects a revoked key', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ ...active, status: 'REVOKED' });
    const res = makeRes();
    await authenticateIntegration({ headers: { authorization: `Bearer ${key}` } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects an organisation whose plan lacks EMR connections', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(active);
    (getOrganizationFeatures as any).mockResolvedValue({ emrIntegration: false });
    const res = makeRes();
    await authenticateIntegration({ headers: { authorization: `Bearer ${key}` } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('records last use only when the stored value is stale', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ ...active, lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) });
    await authenticateIntegration({ headers: { authorization: `Bearer ${key}` } } as any, makeRes(), vi.fn());
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
  });
});

describe('requireScope', () => {
  it('passes a key with the scope and refuses one without', () => {
    const next = vi.fn();
    requireScope('catalog:read')({ integration: active } as any, makeRes(), next);
    expect(next).toHaveBeenCalled();
    const res = makeRes();
    requireScope('catalog:write')({ integration: active } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
