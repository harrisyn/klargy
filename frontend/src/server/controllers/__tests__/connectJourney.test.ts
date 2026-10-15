import { describe, it, expect, vi, beforeEach } from 'vitest';

// Klargy Connect phase 5 (docs/connect/v1.md section 8): appointment sync,
// analytics and pausing a service's queue.

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
    service: { findFirst: vi.fn() },
    location: { findFirst: vi.fn(), findMany: vi.fn() },
    user: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    appointment: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    queue: { findUniqueOrThrow: vi.fn() },
  },
}));

vi.mock('../../services/queueEvents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/queueEvents.service')>()),
  getOrCreateQueueForDate: vi.fn(),
  recordQueueEvent: vi.fn(),
  setQueueStatus: vi.fn(),
}));

vi.mock('../../services/ai/metrics', () => ({ summaryBetween: vi.fn(), liveStatus: vi.fn() }));

import prisma from '../../lib/prisma';
import { getOrCreateQueueForDate, recordQueueEvent, setQueueStatus } from '../../services/queueEvents.service';
import { liveStatus, summaryBetween } from '../../services/ai/metrics';
import { putAppointment, getAnalytics, postServiceStatus } from '../connectJourney.controller';

const integration = { id: 'int1', organizationId: 'org1', scopes: [] };
const ORIGIN = { type: 'integration', integrationId: 'int1' };

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const makeReq = (over: Record<string, unknown> = {}) => ({ integration, params: {}, query: {}, body: {}, ...over }) as any;

const service = {
  id: 's1',
  name: 'GP',
  isActive: true,
  locationId: 'l1',
  location: { id: 'l1', name: 'Airport', organization: { status: 'ACTIVE' } },
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
  (prisma.service.findFirst as any).mockImplementation(async ({ where }: any) => (where.id === 's1' ? service : null));
  (prisma.user.create as any).mockResolvedValue({ id: 'u1' });
  (prisma.user.findFirst as any).mockResolvedValue(null);
});

describe('PUT /appointments/:appointmentRef', () => {
  const body = {
    refs: { patient: 'P1', visit: null },
    patient: { firstName: 'Ama', lastName: 'Mensah', phone: '+233200000000' },
    service: 'clinic-1',
    startTime: '2026-10-20T09:15:00Z',
    endTime: '2026-10-20T09:30:00Z',
    status: 'booked',
    staff: 'DR1',
    notes: null,
  };
  const put = (b: Record<string, unknown>) => makeReq({ params: { appointmentRef: 'APT1' }, body: b });
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    userId: 'u1',
    serviceId: 's1',
    status: 'SCHEDULED',
    startTime: new Date('2026-10-20T09:15:00Z'),
    endTime: new Date('2026-10-20T09:30:00Z'),
    service: { id: 's1', name: 'GP', locationId: 'l1' },
    ...over,
  });

  it('creates an appointment without a Klargy slot, links it and announces it', async () => {
    (prisma.appointment.create as any).mockResolvedValue({ id: 'a1' });
    (prisma.appointment.findUniqueOrThrow as any).mockResolvedValue(row());
    const res = makeRes();
    await putAppointment(put(body), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect((prisma.appointment.create as any).mock.calls[0][0].data).toMatchObject({
      userId: 'u1', serviceId: 's1', slotId: null, createdBy: null, status: 'SCHEDULED',
      startTime: new Date('2026-10-20T09:15:00Z'),
    });
    expect(refs).toContainEqual(expect.objectContaining({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' }));
    expect(res.json.mock.calls[0][0]).toEqual({
      appointment: {
        id: 'a1',
        status: 'booked',
        startTime: new Date('2026-10-20T09:15:00Z'),
        endTime: new Date('2026-10-20T09:30:00Z'),
        service: { id: 's1', name: 'GP' },
        refs: { appointment: 'APT1', patient: 'P1', service: 'clinic-1', location: 'LOC-1' },
      },
    });
    const event = (recordQueueEvent as any).mock.calls[0][0];
    expect(event).toMatchObject({ action: 'appointment.created', origin: ORIGIN, organizationId: 'org1' });
    expect(event.refSubject).toMatchObject({ appointment: 'a1' });
  });

  it('updates a known appointment: a new time is a reschedule, a cancellation is announced once', async () => {
    refs.push({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' }, { resourceType: 'patient', resourceId: 'u1', externalId: 'P1' });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'u1', identityData: null });
    (prisma.appointment.findFirst as any).mockResolvedValue(row());
    (prisma.appointment.findUniqueOrThrow as any).mockResolvedValue(row({ startTime: new Date('2026-10-21T10:00:00Z') }));
    const res = makeRes();
    await putAppointment(put({ ...body, patient: undefined, startTime: '2026-10-21T10:00:00Z', endTime: null }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
    expect((recordQueueEvent as any).mock.calls[0][0].action).toBe('appointment.rescheduled');

    (recordQueueEvent as any).mockClear();
    (prisma.appointment.findUniqueOrThrow as any).mockResolvedValue(row({ status: 'CANCELLED' }));
    const res2 = makeRes();
    await putAppointment(put({ ...body, patient: undefined, status: 'cancelled' }), res2, vi.fn());
    expect((prisma.appointment.update as any).mock.calls[1][0].data.status).toBe('CANCELLED');
    expect((recordQueueEvent as any).mock.calls[0][0].action).toBe('appointment.cancelled');
    expect(res2.json.mock.calls[0][0].appointment.status).toBe('cancelled');

    (recordQueueEvent as any).mockClear();
    (prisma.appointment.findFirst as any).mockResolvedValue(row({ status: 'CANCELLED' }));
    await putAppointment(put({ ...body, patient: undefined, status: 'cancelled' }), makeRes(), vi.fn());
    expect(recordQueueEvent).not.toHaveBeenCalled();
  });

  it('keeps a check-in when the EMR still says booked, and records no-shows', async () => {
    refs.push({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' }, { resourceType: 'patient', resourceId: 'u1', externalId: 'P1' });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'u1', identityData: null });
    (prisma.appointment.findFirst as any).mockResolvedValue(row({ status: 'CHECKED_IN' }));
    (prisma.appointment.findUniqueOrThrow as any).mockResolvedValue(row({ status: 'CHECKED_IN' }));
    await putAppointment(put({ ...body, patient: undefined }), makeRes(), vi.fn());
    expect((prisma.appointment.update as any).mock.calls[0][0].data.status).toBe('CHECKED_IN');
    await putAppointment(put({ ...body, patient: undefined, status: 'no_show' }), makeRes(), vi.fn());
    expect((prisma.appointment.update as any).mock.calls[1][0].data.status).toBe('NO_SHOW');
  });

  it('answers 404 SERVICE_NOT_MAPPED, 422 PATIENT_REQUIRED and 400 for bad input', async () => {
    let res = makeRes();
    await putAppointment(put({ ...body, service: 'nope' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('SERVICE_NOT_MAPPED');

    res = makeRes();
    await putAppointment(put({ ...body, patient: undefined }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].code).toBe('PATIENT_REQUIRED');

    for (const b of [
      { ...body, startTime: 'tomorrow' },
      { ...body, startTime: undefined },
      { ...body, status: 'confirmed' },
      { ...body, endTime: '2026-10-20T08:00:00Z' },
      { ...body, refs: {} },
    ]) {
      res = makeRes();
      await putAppointment(put(b), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });
});

describe('GET /analytics', () => {
  const summary = (joined: number) => ({
    joined,
    served: 3,
    cancelled: 1,
    noShows: 1,
    stillWaitingOrServing: 0,
    noShowRatePct: 20,
    waitMinutes: { avg: 12.5, median: 10, p90: 30 },
    serviceMinutes: { avg: 8, median: 7, p90: 15 },
  });

  beforeEach(() => {
    (prisma.location.findMany as any).mockResolvedValue([
      { id: 'l1', timezone: 'Africa/Accra' },
      { id: 'l2', timezone: 'Europe/London' },
    ]);
    (summaryBetween as any).mockResolvedValue({
      overall: summary(5),
      perService: [{ serviceId: 's1', service: 'GP', ...summary(5) }],
      truncated: false,
    });
    (liveStatus as any).mockImplementation(async (scope: any) => ({
      services: [{ waiting: scope.locationId === 'l1' ? 4 : 1, beingServed: 1, longestCurrentWaitMinutes: scope.locationId === 'l1' ? 25 : 40 }],
    }));
  });

  it('defaults to today in the location’s timezone and gives overall, live and per-service numbers', async () => {
    const res = makeRes();
    await getAnalytics(makeReq({ query: {} }), res, vi.fn());
    const out = res.json.mock.calls[0][0];
    const [, from, to] = (summaryBetween as any).mock.calls[0];
    expect(to.getTime() - from.getTime()).toBe(86400000 - 1);
    expect(out.from).toBe(from.toISOString());
    expect(out.overall).toEqual({
      joined: 5, served: 3, noShows: 1, cancelled: 1, noShowRatePct: 20,
      avgWaitMinutes: 12.5, medianWaitMinutes: 10, p90WaitMinutes: 30, avgServiceMinutes: 8,
    });
    expect(out.live).toEqual({ waiting: 5, serving: 2, longestWaitMinutes: 40 });
    expect((liveStatus as any).mock.calls.map((c: any[]) => c[1])).toEqual(['Africa/Accra', 'Europe/London']);
    expect(out.services).toEqual([expect.objectContaining({ id: 's1', ref: 'clinic-1', name: 'GP', joined: 5, avgWaitMinutes: 12.5 })]);
  });

  it('scopes to a service or location by EMR id', async () => {
    const res = makeRes();
    await getAnalytics(makeReq({ query: { service: 'clinic-1', from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' } }), res, vi.fn());
    expect((summaryBetween as any).mock.calls[0][0]).toEqual({ organizationId: 'org1', serviceId: 's1' });
    expect((prisma.location.findMany as any).mock.calls[0][0].where).toMatchObject({ id: 'l1' });

    (prisma.location.findFirst as any).mockResolvedValue({ id: 'l1', timezone: 'Africa/Accra' });
    await getAnalytics(makeReq({ query: { location: 'LOC-1' } }), makeRes(), vi.fn());
    expect((summaryBetween as any).mock.calls[1][0]).toEqual({ organizationId: 'org1', locationId: 'l1' });
  });

  it('refuses ranges over 90 days, reversed ranges, bad dates and unknown locations', async () => {
    for (const query of [
      { from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      { from: 'yesterday' },
    ]) {
      const res = makeRes();
      await getAnalytics(makeReq({ query }), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    (prisma.location.findFirst as any).mockResolvedValue(null);
    const res = makeRes();
    await getAnalytics(makeReq({ query: { location: 'LOC-9' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('LOCATION_NOT_MAPPED');
  });
});

describe('POST /services/:service/status', () => {
  const post = (b: Record<string, unknown>, svc = 'clinic-1') => makeReq({ params: { service: svc }, body: b });

  beforeEach(() => {
    (getOrCreateQueueForDate as any).mockResolvedValue({ queue: { id: 'q1', status: 'ACTIVE' } });
    (setQueueStatus as any).mockResolvedValue({ changed: true, previous: 'ACTIVE' });
    (prisma.queue.findUniqueOrThrow as any).mockResolvedValue({ status: 'PAUSED' });
  });

  it('pauses today’s queue with the reason and the message to patients', async () => {
    const res = makeRes();
    await postServiceStatus(post({ status: 'PAUSED', reason: 'Clinic closed', message: 'Dr Mensah is delayed.' }), res, vi.fn());
    expect(setQueueStatus).toHaveBeenCalledWith('q1', 'PAUSED', { origin: ORIGIN, reason: 'Clinic closed', message: 'Dr Mensah is delayed.' });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toEqual({
      queueId: 'q1',
      status: 'PAUSED',
      changed: true,
      service: { id: 's1', name: 'GP' },
      location: { id: 'l1', name: 'Airport' },
      refs: { service: 'clinic-1', location: 'LOC-1' },
    });
  });

  it('reports a repeat as unchanged', async () => {
    (setQueueStatus as any).mockResolvedValue({ changed: false, previous: 'PAUSED' });
    const res = makeRes();
    await postServiceStatus(post({ status: 'PAUSED' }), res, vi.fn());
    expect(res.json.mock.calls[0][0]).toMatchObject({ changed: false, status: 'PAUSED' });
  });

  it('refuses an unknown status and an unmapped service', async () => {
    let res = makeRes();
    await postServiceStatus(post({ status: 'CLOSED' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    res = makeRes();
    await postServiceStatus(post({ status: 'PAUSED' }, 'nope'), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('SERVICE_NOT_MAPPED');
    expect(setQueueStatus).not.toHaveBeenCalled();
  });
});
