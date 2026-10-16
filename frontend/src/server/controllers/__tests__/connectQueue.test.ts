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
    user: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    servicePoint: { findFirst: vi.fn() },
    servicePointService: { findFirst: vi.fn() },
    servicePointInstance: { findMany: vi.fn().mockResolvedValue([]) },
    appointment: { findFirst: vi.fn(), updateMany: vi.fn() },
    organization: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../../services/queueActions.service', async () => {
  class QueueActionError extends Error {
    constructor(public status: number, public code: string, public body: Record<string, unknown>) {
      super(String(body.message ?? body.error));
    }
  }
  return {
    QueueActionError,
    joinQueueEntry: vi.fn(),
    callEntry: vi.fn(),
    serveEntry: vi.fn(),
    endEntry: vi.fn(),
    checkEntryLimits: vi.fn(),
    setEntryPriority: vi.fn(),
    holdEntry: vi.fn(),
    resumeEntry: vi.fn(),
    clearEntry: vi.fn(),
  };
});

vi.mock('../../services/notifications.service', () => ({
  WAITING_ORDER: [],
  CALLABLE_WHERE: { status: 'WAITING', heldAt: null, awaitingClearance: false },
  notifyEntry: vi.fn().mockResolvedValue(undefined),
  notifyPositions: vi.fn(),
  queueLineRanks: vi.fn(async (queueId: string) => {
    const { default: db } = await import('../../lib/prisma');
    const rows = ((await (db as any).queueEntry.findMany({ where: { queueId, status: 'WAITING', heldAt: null, awaitingClearance: false }, select: { id: true } })) ?? []) as { id: string }[];
    return new Map(rows.map((e, i) => [e.id, i + 1]));
  }),
}));

vi.mock('../../services/queueEvents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/queueEvents.service')>()),
  getOrCreateQueueForDate: vi.fn(),
  transferEntryToService: vi.fn(),
  recordQueueEvent: vi.fn(),
}));

import prisma from '../../lib/prisma';
import { getOrCreateQueueForDate, transferEntryToService, recordQueueEvent, TransferError } from '../../services/queueEvents.service';
import {
  QueueActionError,
  holdEntry,
  resumeEntry,
  clearEntry,
  joinQueueEntry,
  callEntry,
  serveEntry,
  endEntry,
  checkEntryLimits,
  setEntryPriority,
} from '../../services/queueActions.service';
import { notifyEntry } from '../../services/notifications.service';
import { postEntry, postEntryByRef, getEntryByRef, listEntries, putPatient, postServingLink } from '../connectQueue.controller';

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
    where.OR ? [] : where.queueId && where.status === 'WAITING' ? [{ id: 'e0' }, { id: 'e1' }] : (where.id?.in ?? []).map((id: string) => entryRow(id))
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
      where.OR ? [] : where.status ? [] : where.id.in.map((id: string) => entryRow(id, 'SERVING'))
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
      where.OR ? [] : where.status ? [{ id: 'e1' }, { id: 'e2' }] : where.id.in.map((id: string) => entryRow(id))
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
      where.OR ? [] : where.status?.in ? [{ id: 'e1' }, { id: 'e2' }] : where.queueId ? [] : where.id.in.map((id: string) => entryRow(id, id === 'e2' ? 'SERVING' : 'WAITING'))
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
      args.where.OR ? [] : args.select ? [{ id: 'e1', updatedAt: t(1) }, { id: 'e2', updatedAt: t(2) }] : args.where.id.in.map((id: string) => entryRow(id))
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

describe('phase 5: by-ref service selector, transfer and priority', () => {
  const byRef = (type: string, id: string, action: string, b: Record<string, unknown> = {}) =>
    makeReq({ params: { type, id, action }, body: b, path: `/entries/by-ref/${type}/${id}/${action}` });

  // Visit V1 has e1 waiting in s1 (GP) and e2 being served in s2 (Lab).
  beforeEach(() => {
    refs.push(
      { resourceType: 'visit', resourceId: 'j1', externalId: 'V1' },
      { resourceType: 'service', resourceId: 's2', externalId: 'loc-1:lab' }
    );
    (prisma.service.findFirst as any).mockImplementation(async ({ where }: any) =>
      where.id === 's1' || where.id === 's2' ? { ...service, id: where.id } : null
    );
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1', 'e2'] });
    const svc: Record<string, string> = { e1: 's1', e2: 's2', e3: 's2' };
    const st: Record<string, string> = { e1: 'WAITING', e2: 'SERVING', e3: 'WAITING' };
    (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) => {
      if (where.queueId || where.OR) return [];
      if (where.status?.in) {
        return where.id.in.filter((id: string) => !where.queue || svc[id] === where.queue.serviceId).map((id: string) => ({ id }));
      }
      return where.id.in.map((id: string) => entryRow(id, st[id] ?? 'WAITING'));
    });
    (prisma.queueEntry.findFirst as any).mockImplementation(async ({ where }: any) =>
      where.id && typeof where.id === 'string'
        ? { id: where.id, status: st[where.id], queueId: 'q1', queue: { serviceId: svc[where.id] } }
        : null
    );
    (prisma.queueEntry.findUnique as any).mockResolvedValue({ userId: 'u1', journeyId: 'j1' });
    (transferEntryToService as any).mockResolvedValue({ entry: { id: 'e3' } });
  });

  it('narrows a visit’s by-ref action to one service’s entries', async () => {
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'call', { service: 'clinic-1' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(callEntry).toHaveBeenCalledWith('q1', { entryId: 'e1', servicePointInstanceId: null }, expect.anything());
  });

  it('answers 404 NO_OPEN_ENTRY when the chosen service has nothing open for the visit', async () => {
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1'] });
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'complete', { service: 'loc-1:lab' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('NO_OPEN_ENTRY');
  });

  it('accepts the selector on GET by-ref too', async () => {
    const res = makeRes();
    await getEntryByRef(makeReq({ method: 'GET', params: { type: 'visit', id: 'V1' }, query: { service: 'clinic-1' } }), res, vi.fn());
    expect(res.json.mock.calls[0][0].entry.entryId).toBe('e1');
  });

  it('transfers the visit’s entry to another service and returns both entries', async () => {
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1'] });
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'transfer', { to: 'loc-1:lab', priority: 50, reason: 'Lab orders' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(checkEntryLimits).toHaveBeenCalledWith('org1');
    expect(transferEntryToService).toHaveBeenCalledWith('e1', 's2', expect.objectContaining({
      priority: 50, completeSource: true, requireOpenSource: true, origin: ORIGIN, data: { reason: 'Lab orders' },
    }));
    expect(notifyEntry).toHaveBeenCalledWith('e3', 'QUEUE_JOINED');
    const out = res.json.mock.calls[0][0];
    expect(out.entry.entryId).toBe('e3');
    expect(out.from.entryId).toBe('e1');
  });

  it('returns 200 and changes nothing when the visit already has an open entry in the target', async () => {
    (prisma.queueEntry.findFirst as any).mockImplementation(async ({ where }: any) =>
      where.queue?.serviceId === 's2' ? { id: 'e2' } : null
    );
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'transfer', { to: 'loc-1:lab' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ entry: { entryId: 'e2' }, from: null });
    expect(transferEntryToService).not.toHaveBeenCalled();
  });

  it('refuses an unmapped target, a closed target queue, a finished source and the plan limit', async () => {
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1'] });
    let res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'transfer', { to: 'nope' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('SERVICE_NOT_MAPPED');

    res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'transfer', {}), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);

    (getOrCreateQueueForDate as any).mockResolvedValueOnce({ queue: { id: 'q2', status: 'PAUSED' } });
    res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'transfer', { to: 'loc-1:lab' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('QUEUE_CLOSED');

    (prisma.queueEntry.findFirst as any).mockImplementation(async ({ where }: any) =>
      typeof where.id === 'string' ? { id: where.id, status: 'SERVED', queueId: 'q1', queue: { serviceId: 's1' } } : null
    );
    res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'transfer', { to: 'loc-1:lab' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_TRANSITION');

    (prisma.queueEntry.findFirst as any).mockImplementation(async ({ where }: any) =>
      typeof where.id === 'string' ? { id: where.id, status: 'WAITING', queueId: 'q1', queue: { serviceId: 's1' } } : null
    );
    (checkEntryLimits as any).mockRejectedValueOnce(
      new (QueueActionError as any)(403, 'LIMIT_REACHED', { error: 'Limit reached', message: 'Daily limit', limitType: 'queueEntriesDaily', current: 5, limit: 5 })
    );
    res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'transfer', { to: 'loc-1:lab' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'LIMIT_REACHED', limitType: 'queueEntriesDaily' });
    expect(transferEntryToService).not.toHaveBeenCalled();
  });

  it('answers 409 INVALID_TRANSITION when the source moved during the transfer', async () => {
    (prisma.customerJourney.findUnique as any).mockResolvedValue({ id: 'j1', userId: 'u1', queueEntryIds: ['e1'] });
    (transferEntryToService as any).mockRejectedValue(new (TransferError as any)('changed', 409, 'INVALID_TRANSITION'));
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'transfer', { to: 'loc-1:lab' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_TRANSITION');
  });

  it('sets the priority of the visit’s open entry, and validates it', async () => {
    (setEntryPriority as any).mockResolvedValue({ previousPriority: 0 });
    const res = makeRes();
    await postEntryByRef(byRef('visit', 'V1', 'priority', { priority: 70, service: 'clinic-1' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(setEntryPriority).toHaveBeenCalledWith('e1', 70, expect.objectContaining({ origin: ORIGIN }));

    for (const priority of [undefined, 101, -1, 2.5, '50']) {
      const bad = makeRes();
      await postEntryByRef(byRef('visit', 'V1', 'priority', { priority }), bad, vi.fn());
      expect(bad.status).toHaveBeenCalledWith(400);
    }
  });
});

describe('POST /entries with refs.appointment', () => {
  it('checks the known appointment in and announces it', async () => {
    refs.push({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' });
    const startTime = new Date(Date.now() + 5 * 60 * 1000);
    (prisma.appointment.findFirst as any).mockResolvedValue({ id: 'a1', userId: 'u1', startTime });
    (prisma.appointment.updateMany as any).mockResolvedValue({ count: 1 });
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, refs: { ...body.refs, appointment: 'APT1' } } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    // Five minutes early is on time: placed in line by the booked time.
    expect((joinQueueEntry as any).mock.calls[0][1].booked).toEqual({ appointmentId: 'a1', bookedFor: startTime, bookedPlaceAt: startTime });
    expect((prisma.appointment.updateMany as any).mock.calls[0][0]).toMatchObject({
      where: { id: 'a1', status: { in: ['SCHEDULED', 'CONFIRMED'] } },
      data: { status: 'CHECKED_IN' },
    });
    expect(recordQueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'appointment.checked_in', entryId: 'e1', data: { appointmentId: 'a1', patientId: 'u1' },
    }));
  });

  it('ignores an appointment Klargy doesn’t know', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, refs: { ...body.refs, appointment: 'APT9' } } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
    expect((joinQueueEntry as any).mock.calls[0][1].booked).toBeNull();
  });

  it('places a late arrival as a walk-in, and keeps the booked time for the chip', async () => {
    refs.push({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' });
    const startTime = new Date(Date.now() - 40 * 60 * 1000);
    (prisma.appointment.findFirst as any).mockResolvedValue({ id: 'a1', userId: 'u1', startTime });
    (prisma.appointment.updateMany as any).mockResolvedValue({ count: 1 });
    await postEntry(makeReq({ body: { ...body, refs: { ...body.refs, appointment: 'APT1' } } }), makeRes(), vi.fn());
    expect((joinQueueEntry as any).mock.calls[0][1].booked).toEqual({ appointmentId: 'a1', bookedFor: startTime, bookedPlaceAt: null });
  });

  it('places nobody by booked time when the organisation switched it off', async () => {
    refs.push({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' });
    (prisma.organization.findUnique as any).mockResolvedValueOnce({ bookedArrivalSettings: { enabled: false } });
    const startTime = new Date();
    (prisma.appointment.findFirst as any).mockResolvedValue({ id: 'a1', userId: 'u1', startTime });
    (prisma.appointment.updateMany as any).mockResolvedValue({ count: 1 });
    await postEntry(makeReq({ body: { ...body, refs: { ...body.refs, appointment: 'APT1' } } }), makeRes(), vi.fn());
    expect((joinQueueEntry as any).mock.calls[0][1].booked.bookedPlaceAt).toBeNull();
  });
});

describe('phase 6: hold, resume, clearance, calling into a room, linking a walk-in', () => {
  const byRef = (type: string, id: string, action: string, b: Record<string, unknown> = {}) =>
    makeReq({ params: { type, id, action }, body: b, path: `/entries/by-ref/${type}/${id}/${action}` });
  const entryIs = (status: string, extra: Record<string, unknown> = {}) =>
    (prisma.queueEntry.findFirst as any).mockResolvedValue({
      id: 'e1', status, queueId: 'q1', heldAt: null, awaitingClearance: false, queue: { serviceId: 's1' }, ...extra,
    });
  const staffAt = (serviceId: string) => {
    refs.push({ resourceType: 'staff', resourceId: 'staff1', externalId: 'DR1' });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'staff1' });
    (prisma.servicePointInstance.findMany as any).mockResolvedValue([{ id: 'desk7', servicePointService: { serviceId } }]);
  };

  it('puts the entry being served on hold, and answers 200 without change when it already is', async () => {
    entryIs('SERVING');
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'hold'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(holdEntry).toHaveBeenCalledWith('e1', expect.objectContaining({ origin: ORIGIN }));

    vi.clearAllMocks();
    entryIs('WAITING', { heldAt: new Date() });
    const res2 = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'hold'), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(holdEntry).not.toHaveBeenCalled();
  });

  it('refuses to hold someone who is only waiting', async () => {
    entryIs('WAITING');
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'hold'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_TRANSITION');
  });

  it('resumes a held entry into the room the staff member is signed in to', async () => {
    entryIs('WAITING', { heldAt: new Date() });
    staffAt('s1');
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'resume', { staff: 'DR1' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resumeEntry).toHaveBeenCalledWith('e1', { servicePointInstanceId: 'desk7' }, expect.objectContaining({ actorUserId: 'staff1' }));
  });

  it('calls into the staff member’s room, and answers 409 ENTRY_IN_OTHER_SERVICE when the ticket is elsewhere', async () => {
    entryIs('WAITING');
    staffAt('s1');
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'call', { staff: 'DR1' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(callEntry).toHaveBeenCalledWith('q1', { entryId: 'e1', servicePointInstanceId: 'desk7' }, expect.anything());

    vi.clearAllMocks();
    entryIs('WAITING');
    staffAt('s-other');
    const res2 = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'call', { staff: 'DR1' }), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.json.mock.calls[0][0]).toMatchObject({ code: 'ENTRY_IN_OTHER_SERVICE', service: 's1' });
    expect(callEntry).not.toHaveBeenCalled();
  });

  it('answers 409 AWAITING_CLEARANCE when calling someone who hasn’t paid', async () => {
    entryIs('WAITING', { awaitingClearance: true });
    (callEntry as any).mockRejectedValue(new (QueueActionError as any)(409, 'AWAITING_CLEARANCE', { error: 'unpaid' }));
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'call'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('AWAITING_CLEARANCE');
  });

  it('clears an entry awaiting payment, and does nothing for one that isn’t', async () => {
    entryIs('WAITING', { awaitingClearance: true });
    const res = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'clear'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(clearEntry).toHaveBeenCalledWith('e1', expect.objectContaining({ origin: ORIGIN }));

    vi.clearAllMocks();
    entryIs('SERVED');
    const res2 = makeRes();
    await postEntryByRef(byRef('entry', 'e1', 'clear'), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(clearEntry).not.toHaveBeenCalled();
  });

  it('passes cleared: true to a new ticket, and refuses a non-boolean', async () => {
    const res = makeRes();
    await postEntry(makeReq({ body: { ...body, cleared: true } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect((joinQueueEntry as any).mock.calls[0][1]).toMatchObject({ cleared: true });
    const res2 = makeRes();
    await postEntry(makeReq({ body: { ...body, cleared: 'yes' } }), res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it('gives entry objects held, awaitingClearance, sentBy and the journey with the EMR’s service ids', async () => {
    (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) =>
      where.OR
        ? [
            { id: 'e0', ticketNumber: 'R001', status: 'SERVED', joinedAt: new Date(1), completedAt: new Date(2), journeyId: 'j1', queue: { service: { id: 's1', name: 'GP' } } },
            { id: 'e1', ticketNumber: 'G001', status: 'WAITING', joinedAt: new Date(3), completedAt: null, journeyId: 'j1', queue: { service: { id: 's9', name: 'Cashier' } } },
          ]
        : where.queueId
          ? []
          : (where.id?.in ?? []).map((id: string) => entryRow(id, 'WAITING', { awaitingClearance: true, sentBy: 'patient' }))
    );
    const res = makeRes();
    await postEntry(makeReq({ body }), res, vi.fn());
    const { entry } = res.json.mock.calls[0][0];
    expect(entry).toMatchObject({ held: false, awaitingClearance: true, sentBy: 'patient' });
    expect(entry.journey).toEqual([
      { entryId: 'e0', ticketNumber: 'R001', service: { id: 's1', ref: 'clinic-1', name: 'GP' }, status: 'SERVED', joinedAt: new Date(1), endedAt: new Date(2) },
      { entryId: 'e1', ticketNumber: 'G001', service: { id: 's9', ref: null, name: 'Cashier' }, status: 'WAITING', joinedAt: new Date(3), endedAt: null },
    ]);
  });

  it('links the walk-in being served at the staff member’s desk to the EMR patient and visit', async () => {
    staffAt('s1');
    (prisma.queueEntry.findFirst as any).mockResolvedValue({ id: 'e5', userId: 'walkin', journeyId: 'j5' });
    (prisma.user.findUnique as any).mockResolvedValue({ identityData: null });
    const res = makeRes();
    await postServingLink(
      makeReq({ path: '/entries/serving/link', body: { staff: 'DR1', refs: { patient: 'P7', visit: 'V7' }, patient: { firstName: 'Kofi', lastName: 'Boateng' } } }),
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect((prisma.queueEntry.findFirst as any).mock.calls[0][0].where).toMatchObject({ status: 'SERVING', servicePointInstanceId: { in: ['desk7'] } });
    expect(refs).toContainEqual(expect.objectContaining({ resourceType: 'patient', resourceId: 'walkin', externalId: 'P7' }));
    expect(refs).toContainEqual(expect.objectContaining({ resourceType: 'visit', resourceId: 'j5', externalId: 'V7' }));
    expect((prisma.user.update as any).mock.calls[0][0]).toMatchObject({ where: { id: 'walkin' }, data: { firstName: 'Kofi' } });
  });

  it('answers 404 NO_SERVING_ENTRY when nobody is being served there', async () => {
    staffAt('s1');
    (prisma.queueEntry.findFirst as any).mockResolvedValue(null);
    const res = makeRes();
    await postServingLink(makeReq({ path: '/entries/serving/link', body: { staff: 'DR1', refs: { patient: 'P7', visit: 'V7' } } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('NO_SERVING_ENTRY');
  });
});
