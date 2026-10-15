import { describe, it, expect, vi, beforeEach } from 'vitest';

type Ref = { resourceType: string; resourceId: string; externalId: string };
let refs: Ref[] = [];

vi.mock('../../lib/prisma', () => ({
  default: {
    externalReference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    connectIdempotencyKey: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    service: { findFirst: vi.fn() },
    customerJourney: { findUnique: vi.fn() },
    queueEntry: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    user: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    servicePoint: { findFirst: vi.fn() },
    servicePointService: { findFirst: vi.fn() },
  },
}));

vi.mock('../../services/queueActions.service', async () => {
  class QueueActionError extends Error {
    constructor(public status: number, public code: string, public body: Record<string, unknown>) {
      super(String(body.message ?? body.error));
    }
  }
  return { QueueActionError, joinQueueEntry: vi.fn(), callEntry: vi.fn(), serveEntry: vi.fn(), endEntry: vi.fn() };
});

vi.mock('../../services/notifications.service', () => ({
  WAITING_ORDER: [],
  notifyEntry: vi.fn().mockResolvedValue(undefined),
  notifyPositions: vi.fn(),
}));

vi.mock('../../services/queueEvents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/queueEvents.service')>()),
  getOrCreateQueueForDate: vi.fn(),
}));

import prisma from '../../lib/prisma';
import { getOrCreateQueueForDate } from '../../services/queueEvents.service';
import { QueueActionError, joinQueueEntry, callEntry, serveEntry, endEntry } from '../../services/queueActions.service';
import { notifyEntry } from '../../services/notifications.service';
import { postEntry, postEntryByRef, getEntryByRef, listEntries, putPatient } from '../connectQueue.controller';

const integration = { id: 'int1', organizationId: 'org1', scopes: [] };
const ORIGIN = { type: 'integration', integrationId: 'int1' };

function makeRes() {
  const res: any = { headers: {} };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn((k: string, v: string) => (res.headers[k] = v));
  return res;
}

function makeReq(over: Record<string, unknown> = {}) {
  const headers = (over.headers ?? {}) as Record<string, string>;
  return {
    integration,
    method: 'POST',
    baseUrl: '/api/v1/connect/v1',
    path: '/entries',
    params: {},
    query: {},
    body: {},
    get: (name: string) => headers[name.toLowerCase()],
    ...over,
  } as any;
}

function entryRow(id: string, status = 'WAITING', extra: Record<string, unknown> = {}) {
  return {
    id,
    ticketNumber: 'G001',
    status,
    queueId: 'q1',
    journeyId: 'j1',
    previousEntryId: null,
    joinedAt: new Date('2026-10-14T09:00:00Z'),
    calledAt: null,
    servedAt: null,
    completedAt: null,
    updatedAt: new Date('2026-10-14T09:00:00Z'),
    user: { id: 'u1', firstName: 'Ama', lastName: 'Mensah', phone: null, identityData: null },
    queue: {
      serviceId: 's1',
      service: { id: 's1', name: 'GP', location: { id: 'l1', name: 'Airport', organizationId: 'org1', organization: { slug: 'nyaho' } } },
    },
    servicePointInstance: null,
    ...extra,
  };
}

const service = { id: 's1', isActive: true, location: { organization: { status: 'ACTIVE' } } };
const body = {
  refs: { patient: 'P1', visit: 'V1' },
  patient: { firstName: 'Ama', lastName: 'Mensah', phone: '+233200000000' },
  service: 'clinic-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  refs = [
    { resourceType: 'service', resourceId: 's1', externalId: 'clinic-1' },
    { resourceType: 'location', resourceId: 'l1', externalId: 'LOC-1' },
  ];
  (prisma.externalReference.findUnique as any).mockImplementation(async ({ where }: any) => {
    const k = where.integrationId_resourceType_externalId;
    const r = refs.find((x) => x.resourceType === k.resourceType && x.externalId === k.externalId);
    return r ? { resourceId: r.resourceId } : null;
  });
  (prisma.externalReference.findMany as any).mockImplementation(async ({ where }: any) =>
    refs.filter((r) => where.OR.some((o: any) => o.resourceType === r.resourceType && o.resourceId.in.includes(r.resourceId)))
  );
  (prisma.externalReference.create as any).mockImplementation(async ({ data }: any) => {
    refs.push(data);
    return data;
  });
  (prisma.externalReference.upsert as any).mockImplementation(async ({ create }: any) => {
    refs = refs.filter((r) => !(r.resourceType === create.resourceType && r.resourceId === create.resourceId));
    refs.push(create);
    return create;
  });
  (prisma.service.findFirst as any).mockImplementation(async ({ where }: any) => (where.id === 's1' ? service : null));
  (prisma.user.create as any).mockResolvedValue({ id: 'u1' });
  (prisma.user.findFirst as any).mockResolvedValue(null);
  (prisma.customerJourney.findUnique as any).mockResolvedValue(null);
  (prisma.queueEntry.findFirst as any).mockResolvedValue(null);
  (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) =>
    where.queueId && where.status === 'WAITING' ? [{ id: 'e0' }, { id: 'e1' }] : (where.id?.in ?? []).map((id: string) => entryRow(id))
  );
  (getOrCreateQueueForDate as any).mockResolvedValue({ queue: { id: 'q1', status: 'ACTIVE' } });
  (joinQueueEntry as any).mockImplementation(async (_q: string, _input: unknown, _ctx: unknown, hooks: any) => {
    await hooks?.beforeEvent?.('e1');
    return { entry: { id: 'e1' }, position: 1 };
  });
  (prisma.queueEntry.findUnique as any).mockResolvedValue({ journeyId: 'j1' });
  (prisma.connectIdempotencyKey.create as any).mockResolvedValue({ id: 'k1' });
});

describe('POST /entries', () => {
  it('creates the patient, issues a ticket into a new journey and returns the entry with refs', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    const { entry } = res.json.mock.calls[0][0];
    expect(entry).toMatchObject({ entryId: 'e1', status: 'WAITING', servicePoint: null });
    expect(entry.refs).toEqual({
      patient: 'P1', visit: 'V1', encounter: null, service: 'clinic-1', location: 'LOC-1', servicePoint: null, staff: null,
    });
    const created = (prisma.user.create as any).mock.calls[0][0].data;
    expect(created).toMatchObject({ role: 'PATIENT', organizationId: 'org1', firstName: 'Ama' });
    expect(created.email).toMatch(/@guest\.qms\.local$/);
    expect(created.password).toMatch(/^\$2/);
    const [, input, ctx] = (joinQueueEntry as any).mock.calls[0];
    expect(input).toMatchObject({ userId: 'u1', journeyId: null, priority: 0 });
    expect(ctx.origin).toEqual(ORIGIN);
  });

  it('sends the patient the “you’ve joined” message for a new ticket, and gives its status page and place in line', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(notifyEntry).toHaveBeenCalledWith('e1', 'QUEUE_JOINED');
    const { entry } = res.json.mock.calls[0][0];
    expect(entry.statusUrl).toMatch(/^https?:\/\/nyaho\.[^/]+\/status\/q1\/e1$/);
    expect(entry.position).toBe(2);
  });

  it('gives no place in line once the entry is being served', async () => {
    (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) =>
      where.status ? [] : where.id.in.map((id: string) => entryRow(id, 'SERVING'))
    );
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(res.json.mock.calls[0][0].entry).toMatchObject({ status: 'SERVING', position: null });
  });

  it('replays the first response for a repeated Idempotency-Key', async () => {
    const stored = { entry: { entryId: 'e1' } };
    (prisma.connectIdempotencyKey.create as any).mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const first = makeReq({ body, headers: { 'idempotency-key': 'abc' } });
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(`POST ${first.baseUrl}${first.path}\n${JSON.stringify(body)}`).digest('hex');
    (prisma.connectIdempotencyKey.findUnique as any).mockResolvedValue({ requestHash: hash, statusCode: 201, response: stored });
    const res = makeRes();
    await postEntry(first, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(stored);
    expect(res.headers['Idempotent-Replayed']).toBe('true');
    expect(joinQueueEntry).not.toHaveBeenCalled();
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it('stores a successful response under the key, and refuses the key for a different request', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body, headers: { 'idempotency-key': 'abc' } }), res, vi.fn());
    expect((prisma.connectIdempotencyKey.update as any).mock.calls[0][0].data.statusCode).toBe(201);

    (prisma.connectIdempotencyKey.create as any).mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    (prisma.connectIdempotencyKey.findUnique as any).mockResolvedValue({ requestHash: 'other', statusCode: 201, response: {} });
    const res2 = makeRes();
    await postEntry(makeReq({ body, headers: { 'idempotency-key': 'abc' } }), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(422);
    expect(res2.json.mock.calls[0][0].code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('forgets the key when the request fails, so it can be retried', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, service: 'nope' }, headers: { 'idempotency-key': 'abc' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.connectIdempotencyKey.delete).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });

  it('answers 404 SERVICE_NOT_MAPPED for a service with no match', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, service: 'unmapped-clinic' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('SERVICE_NOT_MAPPED');
  });

  it('accepts a Klargy service id', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, service: 's1' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('answers 422 PATIENT_REQUIRED for an unknown patient without details', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, patient: undefined } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].code).toBe('PATIENT_REQUIRED');
  });

  it('answers 409 QUEUE_CLOSED when today’s queue is paused', async () => {
    (getOrCreateQueueForDate as any).mockResolvedValue({ queue: { id: 'q1', status: 'PAUSED' } });
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('QUEUE_CLOSED');
  });

  it('answers 403 LIMIT_REACHED when the plan’s limits are reached', async () => {
    (joinQueueEntry as any).mockRejectedValue(
      new (QueueActionError as any)(403, 'LIMIT_REACHED', { error: 'Limit reached', message: 'Daily limit', limitType: 'queueEntriesDaily', current: 5, limit: 5 })
    );
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'LIMIT_REACHED', limitType: 'queueEntriesDaily' });
  });

  it('joins the visit’s existing journey', async () => {
    refs.push({ resourceType: 'visit', resourceId: 'j1', externalId: 'V1' }, { resourceType: 'patient', resourceId: 'u1', externalId: 'P1' });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'u1', identityData: null });
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e0'] });
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, service: 's1', patient: undefined } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect((joinQueueEntry as any).mock.calls[0][1].journeyId).toBe('j1');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.externalReference.create).not.toHaveBeenCalled();
  });

  it('returns the visit’s open entry for the same service with 200 instead of a new ticket', async () => {
    refs.push({ resourceType: 'visit', resourceId: 'j1', externalId: 'V1' });
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e0'] });
    (prisma.queueEntry.findFirst as any).mockResolvedValue({ id: 'e0' });
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].entry.entryId).toBe('e0');
    expect(joinQueueEntry).not.toHaveBeenCalled();
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it('refuses a visit that belongs to another patient', async () => {
    refs.push({ resourceType: 'visit', resourceId: 'j1', externalId: 'V1' });
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'someone-else', queueEntryIds: [] });
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('VISIT_PATIENT_MISMATCH');
  });

  it('requires refs.patient, refs.visit and service', async () => {
    for (const b of [{ ...body, refs: { visit: 'V1' } }, { ...body, refs: { patient: 'P1' } }, { ...body, service: undefined }]) {
      const res = makeRes();
      await postEntry(makeReq({ body: b }), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });
});

describe('POST /entries/by-ref', () => {
  const byRef = (type: string, id: string, action: string, b: Record<string, unknown> = {}) =>
    makeReq({ params: { type, id, action }, body: b, path: `/entries/by-ref/${type}/${id}/${action}` });

  function entryIs(status: string) {
    (prisma.queueEntry.findFirst as any).mockResolvedValue({ id: 'e1', status, queueId: 'q1', queue: { serviceId: 's1' } });
  }

  it('calls a waiting entry by encounter, to the mapped service point and as the mapped staff member', async () => {
    refs.push(
      { resourceType: 'encounter', resourceId: 'e1', externalId: 'ENC1' },
      { resourceType: 'service_point', resourceId: 'sp1', externalId: 'ROOM3' },
      { resourceType: 'staff', resourceId: 'staff1', externalId: 'DR1' }
    );
    entryIs('WAITING');
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'staff1' });
    (prisma.servicePoint.findFirst as any).mockResolvedValue({ id: 'sp1' });
    (prisma.servicePointService.findFirst as any).mockResolvedValue({
      instances: [
        { id: 'desk1', isOccupied: true, occupiedByUserId: 'other' },
        { id: 'desk2', isOccupied: true, occupiedByUserId: 'staff1' },
      ],
    });
    const res = makeRes();
    await postEntryByRef(byRef('encounter', 'ENC1', 'call', { servicePoint: 'ROOM3', staff: 'DR1' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(callEntry).toHaveBeenCalledWith('q1', { entryId: 'e1', servicePointInstanceId: 'desk2' }, expect.objectContaining({ actorUserId: 'staff1', origin: ORIGIN }));
  });

  it('completes the visit’s open entry, guarded against races, and links the encounter', async () => {
    refs.push({ resourceType: 'visit', resourceId: 'j1', externalId: 'V1' });
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1', 'e2'] });
    (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) =>
      where.status ? [{ id: 'e1' }, { id: 'e2' }] : where.id.in.map((id: string) => entryRow(id))
    );
    (prisma.queueEntry.findFirst as any).mockImplementation(async ({ where }: any) => ({
      id: where.id, status: where.id === 'e2' ? 'SERVING' : 'WAITING', queueId: 'q1', queue: { serviceId: 's1' },
    }));
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'complete', { encounter: 'ENC9' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(serveEntry).toHaveBeenCalledWith('q1', 'e2', expect.objectContaining({ origin: ORIGIN }), { onlyFrom: ['WAITING', 'SERVING'] });
    expect(refs).toContainEqual(expect.objectContaining({ resourceType: 'encounter', resourceId: 'e2', externalId: 'ENC9' }));
  });

  it('answers 200 and changes nothing when the entry already has that status', async () => {
    entryIs('CANCELLED');
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'cancel'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(endEntry).not.toHaveBeenCalled();
  });

  it('answers 409 INVALID_TRANSITION for completing a cancelled entry', async () => {
    entryIs('CANCELLED');
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'complete'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'INVALID_TRANSITION', status: 'CANCELLED' });
    expect(serveEntry).not.toHaveBeenCalled();
  });

  it('answers 409 INVALID_TRANSITION when someone else moved it first', async () => {
    entryIs('WAITING');
    (endEntry as any).mockRejectedValue(new (QueueActionError as any)(409, 'INVALID_TRANSITION', { error: 'changed' }));
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'no-show', { reason: 'Left' }), res, vi.fn());
    expect((endEntry as any).mock.calls[0][3]).toMatchObject({ data: { reason: 'Left' } });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('answers 404 NO_OPEN_ENTRY for a visit with nothing open', async () => {
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V-unknown', 'call'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('NO_OPEN_ENTRY');
  });

  it('answers 404 ENTRY_NOT_FOUND for an unknown encounter and 400 for an unknown action', async () => {
    const res = makeRes();
    await postEntryByRef(byRef('encounter', 'nope', 'call'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('ENTRY_NOT_FOUND');
    const res2 = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'serve'), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /entries/by-ref', () => {
  const getRef = (type: string, id: string) =>
    makeReq({ method: 'GET', params: { type, id }, path: `/entries/by-ref/${type}/${id}` });

  it('returns the visit’s entry being served before one waiting', async () => {
    refs.push({ resourceType: 'visit', resourceId: 'j1', externalId: 'V1' });
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1', 'e2'] });
    (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) =>
      where.status?.in ? [{ id: 'e1' }, { id: 'e2' }] : where.queueId ? [] : where.id.in.map((id: string) => entryRow(id, id === 'e2' ? 'SERVING' : 'WAITING'))
    );
    (prisma.queueEntry.findFirst as any).mockImplementation(async ({ where }: any) => ({
      id: where.id, status: where.id === 'e2' ? 'SERVING' : 'WAITING', queueId: 'q1', queue: { serviceId: 's1' },
    }));
    const res = makeRes();
    await getEntryByRef(getRef('visit', 'V1'), res, vi.fn());
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].entry).toMatchObject({ entryId: 'e2', status: 'SERVING', position: null });
    expect(serveEntry).not.toHaveBeenCalled();
  });

  it('answers 404 NO_OPEN_ENTRY for a visit with nothing open, ENTRY_NOT_FOUND for an unknown encounter', async () => {
    const res = makeRes();
    await getEntryByRef(getRef('visit', 'V-unknown'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('NO_OPEN_ENTRY');
    const res2 = makeRes();
    await getEntryByRef(getRef('encounter', 'nope'), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(404);
    expect(res2.json.mock.calls[0][0].code).toBe('ENTRY_NOT_FOUND');
    const res3 = makeRes();
    await getEntryByRef(getRef('patient', 'P1'), res3, vi.fn());
    expect(res3.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /entries', () => {
  it('requires updatedSince', async () => {
    const res = makeRes();
    await listEntries(makeReq({ method: 'GET', query: {} }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('lists entries changed since, oldest first, scoped to the organisation', async () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 14, 9, m));
    (prisma.queueEntry.findMany as any).mockImplementation(async (args: any) =>
      args.select ? [{ id: 'e1', updatedAt: t(1) }, { id: 'e2', updatedAt: t(2) }] : args.where.id.in.map((id: string) => entryRow(id))
    );
    const res = makeRes();
    await listEntries(makeReq({ method: 'GET', query: { updatedSince: t(0).toISOString() } }), res, vi.fn());
    const where = (prisma.queueEntry.findMany as any).mock.calls[0][0].where;
    expect(where.queue).toEqual({ service: { location: { organizationId: 'org1' } } });
    const out = res.json.mock.calls[0][0];
    expect(out.entries.map((e: any) => e.entryId)).toEqual(['e1', 'e2']);
    expect(out.nextUpdatedSince).toBe(t(2).toISOString());
  });

  it('returns nothing for a visit Klargy doesn’t know', async () => {
    const res = makeRes();
    await listEntries(makeReq({ method: 'GET', query: { updatedSince: '2026-10-14T00:00:00Z', visit: 'V9' } }), res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ entries: [], nextUpdatedSince: '2026-10-14T00:00:00.000Z' });
  });
});

describe('PUT /patients/:patientId', () => {
  it('creates a patient and reports it, then updates it', async () => {
    const res = makeRes();
    await putPatient(
      makeReq({ params: { patientId: 'P1' }, body: { firstName: 'Ama', lastName: 'Mensah', email: 'Ama@Example.com', identifiers: { mrn: 'NMC-1' } } }),
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ patientId: 'P1', klargyId: 'u1', created: true });
    expect((prisma.user.create as any).mock.calls[0][0].data.identityData).toEqual({ mrn: 'NMC-1', email: 'ama@example.com' });

    (prisma.user.findFirst as any).mockResolvedValue({ id: 'u1', identityData: { mrn: 'NMC-1' } });
    const res2 = makeRes();
    await putPatient(makeReq({ params: { patientId: 'P1' }, body: { firstName: 'Ama', lastName: 'Owusu' } }), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(200);
    expect((prisma.user.update as any).mock.calls[0][0].data).toMatchObject({ lastName: 'Owusu', identityData: { mrn: 'NMC-1' } });
  });

  it('requires a first and last name', async () => {
    const res = makeRes();
    await putPatient(makeReq({ params: { patientId: 'P1' }, body: { firstName: 'Ama' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
