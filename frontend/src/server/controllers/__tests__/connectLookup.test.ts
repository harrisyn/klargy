import { describe, it, expect, vi, beforeEach } from 'vitest';

// Klargy Connect phase 4 for staff: the lookup endpoints, the reception
// "Look up" through the INTEGRATION data source, and the setting.

const db = vi.hoisted(() => ({
  queueEntry: { findFirst: vi.fn() },
  externalReference: { findMany: vi.fn(), findFirst: vi.fn() },
  dataSource: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ default: db, prisma: db }));
vi.mock('../../middleware/tenantScope.middleware', () => ({
  loadCaller: vi.fn(async () => ({ id: 'staff1', role: 'RECEPTIONIST', organizationId: 'org1' })),
}));
vi.mock('../../services/connectLookup.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/connectLookup.service')>()),
  lookupIntegrationFor: vi.fn(),
  lookupPatient: vi.fn(),
  locationRefFor: vi.fn(async () => 'LOC-1'),
}));

import { LookupError, lookupIntegrationFor, lookupPatient } from '../../services/connectLookup.service';
import { postLookup, getEntryLookup } from '../connectLookup.controller';
import { fetchFromDataSource, createDataSource, getDataSources } from '../datasource.controller';

const prisma = db as any;
const named = db as any;
const integration = { id: 'int1', organizationId: 'org1', name: 'Serenity', lookupUrl: 'https://emr/lookup', webhookEndpoint: { encryptedSecret: 'x' } };
const answer = {
  matched: true,
  patient: { ref: 'P1', displayName: 'Ama Mensah', mrNumber: 'NH-1', identifiers: { memberNumber: 'M-9', nationalId: null }, cover: null, flags: [] },
  candidates: [],
};

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  (lookupIntegrationFor as any).mockResolvedValue(integration);
  (lookupPatient as any).mockResolvedValue(answer);
});

describe('POST /connect-lookup', () => {
  it('asks the EMR with staff context and the mapped location', async () => {
    const res = makeRes();
    await postLookup({ body: { identifierType: 'mrNumber', identifier: ' NH-1 ', locationId: 'l1' } } as any, res, vi.fn());
    expect(lookupIntegrationFor).toHaveBeenCalledWith('org1');
    expect(lookupPatient).toHaveBeenCalledWith(integration, { identifierType: 'mrNumber', identifier: 'NH-1', context: 'staff', locationRef: 'LOC-1' });
    expect(res.json).toHaveBeenCalledWith(answer);
  });

  it('answers 409 LOOKUP_NOT_CONFIGURED with no lookup set up, 502 LOOKUP_FAILED when the EMR fails', async () => {
    (lookupIntegrationFor as any).mockResolvedValueOnce(null);
    const res = makeRes();
    await postLookup({ body: { identifierType: 'mrNumber', identifier: 'NH-1' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('LOOKUP_NOT_CONFIGURED');

    (lookupPatient as any).mockRejectedValueOnce(new LookupError('The connected system took too long to answer', 'LOOKUP_FAILED'));
    const res2 = makeRes();
    await postLookup({ body: { identifierType: 'mrNumber', identifier: 'NH-1' } } as any, res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(502);
    expect(res2.json.mock.calls[0][0].code).toBe('LOOKUP_FAILED');
  });

  it('refuses an unknown identifier type or an empty identifier', async () => {
    for (const body of [{ identifierType: 'email', identifier: 'a' }, { identifierType: 'phone', identifier: '  ' }]) {
      const res = makeRes();
      await postLookup({ body } as any, res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(lookupPatient).not.toHaveBeenCalled();
  });
});

describe('GET /connect-lookup/entries/:entryId', () => {
  beforeEach(() => {
    prisma.queueEntry.findFirst.mockResolvedValue({ userId: 'u1', queue: { service: { locationId: 'l1' } } });
  });

  it('looks the ticket’s patient up by the EMR’s own id', async () => {
    prisma.externalReference.findMany.mockResolvedValue([{ integrationId: 'int1', externalId: 'P1' }]);
    const res = makeRes();
    await getEntryLookup({ params: { entryId: 'e1' } } as any, res, vi.fn());
    expect(prisma.queueEntry.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'e1', queue: { service: { location: { organizationId: 'org1' } } } });
    expect(lookupPatient).toHaveBeenCalledWith(integration, { identifierType: 'patientRef', identifier: 'P1', context: 'staff', locationRef: 'LOC-1' });
    expect(res.json).toHaveBeenCalledWith({ system: 'Serenity', ...answer });
  });

  it('answers 404 NO_PATIENT_REF for a patient who didn’t come from an EMR', async () => {
    prisma.externalReference.findMany.mockResolvedValue([]);
    const res = makeRes();
    await getEntryLookup({ params: { entryId: 'e1' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('NO_PATIENT_REF');
    expect(lookupPatient).not.toHaveBeenCalled();
  });
});

describe('data sources of type INTEGRATION', () => {
  const source = {
    id: 'ds1', organizationId: 'org1', type: 'INTEGRATION', isActive: true, config: { integrationId: 'int1' },
    fieldMappings: [
      { sourcePath: 'patient.mrNumber', targetField: 'mrNumber', transform: null },
      { sourcePath: 'patient.identifiers.memberNumber', targetField: 'memberNumber', transform: null },
      { sourcePath: 'patient.ref', targetField: 'emrPatientId', transform: null },
    ],
  };

  it('looks someone up by the EMR’s id when Klargy has it, and maps the answer', async () => {
    named.dataSource.findUnique.mockResolvedValue(source);
    named.externalReference.findFirst.mockResolvedValue({ externalId: 'P1' });
    const res = makeRes();
    await fetchFromDataSource({ params: { id: 'ds1' }, body: { identifier: '0244', identifierType: 'phone', userId: 'u1', locationId: 'l1' } } as any, res, vi.fn());
    expect(lookupIntegrationFor).toHaveBeenCalledWith('org1', 'int1');
    expect(lookupPatient).toHaveBeenCalledWith(integration, { identifierType: 'patientRef', identifier: 'P1', context: 'staff', locationRef: 'LOC-1' });
    expect(res.json.mock.calls[0][0].mapped).toEqual({ mrNumber: 'NH-1', memberNumber: 'M-9', emrPatientId: 'P1' });
  });

  it('falls back to the phone number, and explains a phone several people share', async () => {
    named.dataSource.findUnique.mockResolvedValue(source);
    named.externalReference.findFirst.mockResolvedValue(null);
    (lookupPatient as any).mockResolvedValue({ matched: false, patient: null, candidates: [{ ref: 'P1' }, { ref: 'P2' }] });
    const res = makeRes();
    await fetchFromDataSource({ params: { id: 'ds1' }, body: { identifier: '0244', identifierType: 'phone', userId: 'u1' } } as any, res, vi.fn());
    expect((lookupPatient as any).mock.calls[0][1]).toMatchObject({ identifierType: 'phone', identifier: '0244' });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].error).toMatch(/MR number/);
  });

  it('can’t be created by hand', async () => {
    const res = makeRes();
    await createDataSource({ params: { organizationId: 'org1' }, body: { name: 'x', type: 'INTEGRATION' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(named.dataSource.create).not.toHaveBeenCalled();
  });

  it('lists only names and types for desk staff', async () => {
    named.dataSource.findMany.mockResolvedValue([{ ...source, config: { url: 'https://secret' } }]);
    const res = makeRes();
    await getDataSources({ params: { organizationId: 'org1' }, user: { role: 'RECEPTIONIST' } } as any, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith([{ id: 'ds1', name: undefined, type: 'INTEGRATION', isActive: true }]);
  });
});
