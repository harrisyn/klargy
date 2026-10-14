import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  default: {
    integration: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    webhookEndpoint: { create: vi.fn(), update: vi.fn() },
    externalReference: { findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    location: { findFirst: vi.fn() },
    service: { findFirst: vi.fn() },
    servicePoint: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));
vi.mock('../../lib/urlSafety', () => ({ assertPublicUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/encryption', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));

import prisma from '../../lib/prisma';
import { parseCatalog, registerIntegration, putCatalog } from '../connect.controller';
import { setMapping } from '../emrIntegration.controller';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('parseCatalog', () => {
  it('keeps only contract fields and lower-cases emails', () => {
    const c = parseCatalog({
      locations: [{ id: 'l1', name: ' Airport ', secret: 'x' }],
      practitioners: [{ id: 'p1', name: 'Ama', email: 'Ama@Example.com' }],
      registrationFields: [{ key: 'first_name', required: true }],
    });
    expect(c.locations).toEqual([{ id: 'l1', name: 'Airport' }]);
    expect(c.practitioners[0].email).toBe('ama@example.com');
    expect(c.registrationFields[0]).toEqual({ key: 'first_name', label: null, required: true, type: 'text' });
    expect(c.services).toEqual([]);
  });

  it('rejects duplicate ids and missing names', () => {
    expect(() => parseCatalog({ locations: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] })).toThrow(/duplicate/);
    expect(() => parseCatalog({ services: [{ id: 's1' }] })).toThrow(/name is required/);
    expect(() => parseCatalog({ locations: 'nope' })).toThrow(/must be an array/);
  });
});

describe('registerIntegration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the integration webhook endpoint once and returns its secret', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ id: 'int1', organizationId: 'org1', name: 'Serenity', webhookEndpoint: null });
    (prisma.webhookEndpoint.create as any).mockImplementation(({ data }: any) => Promise.resolve({ id: 'wh1', ...data }));
    const req: any = {
      integration: { id: 'int1' },
      body: { system: { name: 'Serenity' }, webhookUrl: 'https://api.example.com/v2/webhooks/queue/x', embedOrigins: ['https://emr.example.com/path'] },
    };
    const res = makeRes();
    await registerIntegration(req, res, vi.fn());
    const body = res.json.mock.calls[0][0];
    expect(body.signingSecret).toMatch(/^whsec_/);
    expect((prisma.webhookEndpoint.create as any).mock.calls[0][0].data.encryptedSecret).toBe(`enc:${body.signingSecret}`);
    expect((prisma.integration.update as any).mock.calls[0][0].data).toMatchObject({
      webhookEndpointId: 'wh1',
      embedOrigins: ['https://emr.example.com'],
    });
  });

  it('keeps the existing secret on re-registration', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      id: 'int1', organizationId: 'org1', name: 'Serenity',
      webhookEndpoint: { id: 'wh1', encryptedSecret: 'enc:whsec_old' },
    });
    (prisma.webhookEndpoint.update as any).mockResolvedValue({ id: 'wh1' });
    const res = makeRes();
    await registerIntegration({ integration: { id: 'int1' }, body: { webhookUrl: 'https://a.example.com/h' } } as any, res, vi.fn());
    expect(res.json.mock.calls[0][0].signingSecret).toBe('whsec_old');
    expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it('requires a webhook URL', async () => {
    const res = makeRes();
    await registerIntegration({ integration: { id: 'int1' }, body: {} } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('putCatalog', () => {
  it('stores the catalogue and returns counts', async () => {
    const res = makeRes();
    await putCatalog({ integration: { id: 'int1' }, body: { locations: [{ id: 'l1', name: 'A' }] } } as any, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ received: { locations: 1, services: 0, servicePoints: 0, practitioners: 0, registrationFields: 0 } });
  });
});

describe('setMapping', () => {
  beforeEach(() => vi.clearAllMocks());
  const integration = { id: 'int1', organizationId: 'org1', catalog: { services: [{ id: 'clinic-1', name: 'GP' }] } };

  it('maps a Klargy service to a published external record', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(integration);
    (prisma.service.findFirst as any).mockResolvedValue({ id: 's1' });
    (prisma.externalReference.findFirst as any).mockResolvedValue(null);
    const res = makeRes();
    await setMapping({ params: { id: 'int1' }, body: { resourceType: 'service', resourceId: 's1', externalId: 'clinic-1' } } as any, res, vi.fn());
    expect(prisma.externalReference.upsert).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ resourceType: 'service', klargyId: 's1', externalId: 'clinic-1' });
  });

  it('refuses an external record that was never published', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(integration);
    (prisma.service.findFirst as any).mockResolvedValue({ id: 's1' });
    const res = makeRes();
    await setMapping({ params: { id: 'int1' }, body: { resourceType: 'service', resourceId: 's1', externalId: 'other' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('refuses a record already matched to something else', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(integration);
    (prisma.service.findFirst as any).mockResolvedValue({ id: 's1' });
    (prisma.externalReference.findFirst as any).mockResolvedValue({ id: 'ref' });
    const res = makeRes();
    await setMapping({ params: { id: 'int1' }, body: { resourceType: 'service', resourceId: 's1', externalId: 'clinic-1' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('removes a mapping with a null externalId', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(integration);
    (prisma.service.findFirst as any).mockResolvedValue({ id: 's1' });
    const res = makeRes();
    await setMapping({ params: { id: 'int1' }, body: { resourceType: 'service', resourceId: 's1', externalId: null } } as any, res, vi.fn());
    expect(prisma.externalReference.deleteMany).toHaveBeenCalled();
  });

  it('refuses a Klargy record from another organisation', async () => {
    (prisma.integration.findUnique as any).mockResolvedValue(integration);
    (prisma.service.findFirst as any).mockResolvedValue(null);
    const res = makeRes();
    await setMapping({ params: { id: 'int1' }, body: { resourceType: 'service', resourceId: 'x', externalId: 'clinic-1' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
