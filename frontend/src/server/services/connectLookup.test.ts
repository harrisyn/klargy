import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// Klargy Connect phase 4: the signed lookup call to the EMR, and the
// INTEGRATION data source that follows the organisation's integrations.

vi.mock('../lib/prisma', () => ({
  default: {
    integration: { findFirst: vi.fn() },
    dataSource: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    fieldMapping: { createMany: vi.fn() },
    externalReference: { findUnique: vi.fn() },
  },
}));
vi.mock('../lib/urlSafety', () => ({ assertPublicUrl: vi.fn(async (u: string) => new URL(u)) }));
vi.mock('../lib/encryption', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));

import prisma from '../lib/prisma';
import { assertPublicUrl } from '../lib/urlSafety';
import {
  DEFAULT_LOOKUP_MAPPINGS,
  LookupError,
  joinIdentifierFor,
  lookupPatient,
  readLookupResponse,
  syncLookupDataSource,
} from './connectLookup.service';

const integration = {
  id: 'int1',
  organizationId: 'org1',
  name: 'Serenity',
  lookupUrl: 'https://emr.example.com/v2/integrations/abc/patient-lookup',
  webhookEndpoint: { encryptedSecret: 'enc:whsec_test' },
};

const staffAnswer = {
  matched: true,
  patient: {
    ref: 'P1', displayName: 'Ama Mensah', firstName: 'Ama', mrNumber: 'NH-004512', birthDate: '1988-04-02',
    gender: 'Female', phoneMasked: '024••••19', photoUrl: null,
    identifiers: { nationalId: 'GHA-1', passport: null, memberNumber: 'M-9' },
    cover: { payer: 'Acme Health', plan: 'Gold', memberNumber: 'M-9', status: 'expired', expiresOn: '2026-01-31', checkedVia: 'records', message: null },
    flags: ['outstanding_balance'],
    secretNote: 'never shown',
  },
  candidates: [],
};

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(reply(200, staffAnswer));
});
afterEach(() => vi.unstubAllGlobals());

describe('lookupPatient', () => {
  it('posts the identifier signed like a webhook, without following redirects', async () => {
    const result = await lookupPatient(integration, { identifierType: 'mrNumber', identifier: 'NH-004512', context: 'staff', locationRef: 'LOC-1' });
    expect(assertPublicUrl).toHaveBeenCalledWith(integration.lookupUrl);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(integration.lookupUrl);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body)).toEqual({ identifierType: 'mrNumber', identifier: 'NH-004512', context: 'staff', locationRef: 'LOC-1' });
    const h = init.headers;
    expect(h['X-Webhook-Event']).toBe('patient.lookup');
    expect(h['X-Webhook-Id']).toMatch(/^[0-9a-f-]{36}$/);
    const expected = crypto.createHmac('sha256', 'whsec_test').update(`${h['X-Webhook-Timestamp']}.${init.body}`).digest('hex');
    expect(h['X-Webhook-Signature']).toBe(`sha256=${expected}`);

    expect(result.matched).toBe(true);
    expect(result.patient).toMatchObject({ ref: 'P1', mrNumber: 'NH-004512', cover: { status: 'expired', expiresOn: '2026-01-31' } });
    expect(result.patient).not.toHaveProperty('secretNote');
  });

  it('keeps only the first name for a public lookup, whatever the EMR sends', async () => {
    const result = await lookupPatient(integration, { identifierType: 'memberNumber', identifier: 'M-9', context: 'public' });
    expect(result).toEqual({ matched: true, patient: { firstName: 'Ama' }, candidates: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).locationRef).toBeNull();
  });

  it('never sends a patient id lookup from the public', async () => {
    const result = await lookupPatient(integration, { identifierType: 'patientRef', identifier: 'P1', context: 'public' });
    expect(result.matched).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an error answer, a timeout or no connection into LOOKUP_FAILED', async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    await expect(lookupPatient(integration, { identifierType: 'phone', identifier: '024', context: 'staff' })).rejects.toMatchObject({
      code: 'LOOKUP_FAILED',
      status: 502,
    });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(lookupPatient(integration, { identifierType: 'phone', identifier: '024', context: 'staff' })).rejects.toThrow(/too long/);
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(lookupPatient(integration, { identifierType: 'phone', identifier: '024', context: 'staff' })).rejects.toBeInstanceOf(LookupError);
  });

  it('refuses with LOOKUP_NOT_CONFIGURED when there is no lookupUrl', async () => {
    await expect(
      lookupPatient({ ...integration, lookupUrl: null }, { identifierType: 'mrNumber', identifier: 'x', context: 'staff' })
    ).rejects.toMatchObject({ code: 'LOOKUP_NOT_CONFIGURED', status: 409 });
  });
});

describe('readLookupResponse', () => {
  it('keeps at most 5 candidates, and none when matched', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ref: `P${i}`, displayName: `Person ${i}`, extra: 'x' }));
    const out = readLookupResponse({ matched: false, patient: null, candidates: many }, 'staff');
    expect(out.candidates).toHaveLength(5);
    expect(out.candidates[0]).toEqual({ ref: 'P0', displayName: 'Person 0', mrNumber: null, birthDate: null, phoneMasked: null });
    expect(readLookupResponse({ ...staffAnswer, candidates: many }, 'staff').candidates).toEqual([]);
  });

  it('treats an unknown cover status as unknown', () => {
    const out = readLookupResponse({ matched: true, patient: { ref: 'P1', cover: { payer: 'X', status: 'weird' } } }, 'staff');
    expect(out.patient?.cover?.status).toBe('unknown');
  });
});

describe('syncLookupDataSource', () => {
  it('creates the INTEGRATION source with the default mappings', async () => {
    (prisma.integration.findFirst as any).mockResolvedValue(integration);
    (prisma.dataSource.findFirst as any).mockResolvedValue(null);
    (prisma.dataSource.create as any).mockResolvedValue({ id: 'ds1' });
    await syncLookupDataSource('org1');
    expect((prisma.integration.findFirst as any).mock.calls[0][0].where).toMatchObject({
      organizationId: 'org1', status: 'ACTIVE', lookupUrl: { not: null },
    });
    expect((prisma.dataSource.create as any).mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1', type: 'INTEGRATION', name: 'Serenity lookup', config: { integrationId: 'int1' }, isActive: true,
    });
    expect((prisma.fieldMapping.createMany as any).mock.calls[0][0].data).toEqual(
      DEFAULT_LOOKUP_MAPPINGS.map((m) => ({ ...m, dataSourceId: 'ds1' }))
    );
  });

  it('updates an existing source and keeps its mappings', async () => {
    (prisma.integration.findFirst as any).mockResolvedValue(integration);
    (prisma.dataSource.findFirst as any).mockResolvedValue({ id: 'ds1', isActive: false, _count: { fieldMappings: 2 } });
    (prisma.dataSource.update as any).mockResolvedValue({ id: 'ds1' });
    await syncLookupDataSource('org1');
    expect((prisma.dataSource.update as any).mock.calls[0][0]).toMatchObject({ where: { id: 'ds1' }, data: { isActive: true } });
    expect(prisma.fieldMapping.createMany).not.toHaveBeenCalled();
  });

  it('switches the source off when no integration can answer lookups', async () => {
    (prisma.integration.findFirst as any).mockResolvedValue(null);
    (prisma.dataSource.findFirst as any).mockResolvedValue({ id: 'ds1', isActive: true, _count: { fieldMappings: 4 } });
    await syncLookupDataSource('org1');
    expect(prisma.dataSource.update).toHaveBeenCalledWith({ where: { id: 'ds1' }, data: { isActive: false } });
    expect(prisma.dataSource.create).not.toHaveBeenCalled();
  });
});

describe('joinIdentifierFor', () => {
  it('asks only when the setting is on and an active INTEGRATION source exists', async () => {
    expect(await joinIdentifierFor({ id: 'org1', joinIdentifierType: null })).toBeNull();
    (prisma.dataSource.findFirst as any).mockResolvedValue(null);
    expect(await joinIdentifierFor({ id: 'org1', joinIdentifierType: 'mrNumber' })).toBeNull();
    (prisma.dataSource.findFirst as any).mockResolvedValue({ config: { integrationId: 'int1' } });
    (prisma.integration.findFirst as any).mockResolvedValue(integration);
    expect(await joinIdentifierFor({ id: 'org1', joinIdentifierType: 'memberNumber' })).toMatchObject({
      type: 'memberNumber', label: 'member number', integration: { id: 'int1' },
    });
    expect((prisma.integration.findFirst as any).mock.calls[0][0].where).toMatchObject({ organizationId: 'org1', id: 'int1' });
  });
});
