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
    organization: { findUnique: vi.fn() },
    room: { findMany: vi.fn(), findFirst: vi.fn() },
    bookingTable: { findMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../services/tables.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tables.service')>()),
  withTable: vi.fn(),
  seatExisting: vi.fn(),
  seatMap: vi.fn(),
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
import { BookingError } from '../../services/booking.service';
import { seatExisting, seatMap, withTable } from '../../services/tables.service';
import { putAppointment, getAnalytics, postServiceStatus, listRooms, getRoomAvailability } from '../connectJourney.controller';

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
  slotDuration: 90,
  location: { id: 'l1', name: 'Airport', timezone: 'UTC', organization: { status: 'ACTIVE' } },
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
  (prisma.organization.findUnique as any).mockResolvedValue({ industry: 'RESTAURANT' });
  (prisma.bookingTable.findMany as any).mockResolvedValue([]);
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
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
    partySize: 1,
    paymentStatus: 'NONE',
    amount: null,
    amountPaid: null,
    currency: null,
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
        partySize: 1,
        room: null,
        tables: [],
        payment: { status: 'unpaid', total: null, paid: null, currency: null },
        refs: { appointment: 'APT1', patient: 'P1', service: 'clinic-1', location: 'LOC-1' },
      },
    });
    const event = (recordQueueEvent as any).mock.calls[0][0];
    expect(event).toMatchObject({ action: 'appointment.created', origin: ORIGIN, organizationId: 'org1' });
    expect(event.refSubject).toMatchObject({ appointment: 'a1' });
  });

  it('stores a party size and the payment the connected system reports, and announces both', async () => {
    (prisma.appointment.create as any).mockResolvedValue({ id: 'a1' });
    (prisma.appointment.findUniqueOrThrow as any).mockResolvedValue(row({ partySize: 4, amount: 80, amountPaid: 20, currency: 'GHS', paymentStatus: 'PAID' }));
    const res = makeRes();
    await putAppointment(put({ ...body, partySize: 4, payment: { total: 80, paid: 20, currency: 'ghs' } }), res, vi.fn());
    expect((prisma.appointment.create as any).mock.calls[0][0].data).toMatchObject({ partySize: 4, amount: 80, amountPaid: 20, currency: 'GHS', paymentStatus: 'PAID', paymentSource: 'EXTERNAL' });
    expect(res.json.mock.calls[0][0].appointment).toMatchObject({ partySize: 4, payment: { status: 'paid', total: 80, paid: 20, currency: 'GHS' } });
    expect((recordQueueEvent as any).mock.calls[0][0].data).toMatchObject({ partySize: 4, payment: { total: 80, paid: 20, currency: 'GHS' } });
  });

  it('rejects a party size that is not a whole number of people', async () => {
    const res = makeRes();
    await putAppointment(put({ ...body, partySize: 0 }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
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

describe('PUT /appointments: tables and seats', () => {
  const body = { refs: { patient: 'P1' }, patient: { firstName: 'Ama', lastName: 'Mensah' }, service: 'clinic-1', startTime: '2026-10-20T19:00:00Z', endTime: '2026-10-20T20:30:00Z', status: 'booked', partySize: 4 };
  const put = (b: Record<string, unknown>) => makeReq({ params: { appointmentRef: 'APT1' }, body: b });
  const terrace = { id: 'r1', name: 'Terrace' };
  const table = { id: 't1', name: 'Terrace 1', seats: 4, roomId: 'r1', room: terrace };
  const view = (over: Record<string, unknown> = {}) => ({
    id: 'a1', userId: 'u1', serviceId: 's1', status: 'SCHEDULED', startTime: new Date('2026-10-20T19:00:00Z'), endTime: new Date('2026-10-20T20:30:00Z'),
    service: { id: 's1', name: 'Dining', locationId: 'l1' }, partySize: 4, paymentStatus: 'NONE', amount: null, amountPaid: null, currency: null,
    room: terrace, tables: [{ table: { id: 't1', name: 'Terrace 1', seats: 4 } }], ...over,
  });
  const known = () => {
    refs.push({ resourceType: 'appointment', resourceId: 'a1', externalId: 'APT1' }, { resourceType: 'patient', resourceId: 'u1', externalId: 'P1' });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'u1', identityData: null });
    (prisma.appointment.findFirst as any).mockResolvedValue({ id: 'a1', userId: 'u1', serviceId: 's1', status: 'SCHEDULED', partySize: 4, startTime: new Date('2026-10-20T19:00:00Z'), endTime: new Date('2026-10-20T20:30:00Z') });
  };

  beforeEach(() => {
    (withTable as any).mockImplementation(async (_o: any, create: any) => create(prisma, [table]));
    (prisma.appointment.create as any).mockResolvedValue({ id: 'a1' });
    (prisma.appointment.findUniqueOrThrow as any).mockResolvedValue(view());
  });

  it('seats a new booking automatically and reports the room and tables', async () => {
    const res = makeRes();
    await putAppointment(put({ ...body, tables: 'auto', room: 'r1' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect((withTable as any).mock.calls[0][0]).toMatchObject({ tableMode: 'AUTO', locationId: 'l1', partySize: 4, online: false, roomId: 'r1', tableIds: null, timeZone: 'UTC' });
    expect((prisma.appointment.create as any).mock.calls[0][0].data).toMatchObject({ roomId: 'r1', tables: { create: [{ tableId: 't1' }] } });
    expect(res.json.mock.calls[0][0].appointment).toMatchObject({ room: terrace, tables: [{ id: 't1', name: 'Terrace 1', seats: 4 }] });
    expect((recordQueueEvent as any).mock.calls[0][0].data).toMatchObject({ room: terrace, tables: [{ id: 't1', name: 'Terrace 1' }] });
  });

  it('seats it on the tables it names', async () => {
    await putAppointment(put({ ...body, tables: ['t1', 't1', 't2'] }), makeRes(), vi.fn());
    expect((withTable as any).mock.calls[0][0]).toMatchObject({ tableIds: ['t1', 't2'], roomId: null });
  });

  it('says 409 TABLE_UNAVAILABLE when the tables are not free, and creates nothing', async () => {
    (withTable as any).mockRejectedValue(new BookingError('Sorry, one of those was just taken. Please choose again.', 409));
    const res = makeRes();
    await putAppointment(put({ ...body, tables: ['t1'] }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'TABLE_UNAVAILABLE' });
    expect(refs.some((r) => r.resourceType === 'appointment')).toBe(false);
  });

  it('is refused for a kind of business without tables', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue({ industry: 'HEALTHCARE' });
    const res = makeRes();
    await putAppointment(put({ ...body, tables: 'auto' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].code).toBe('TABLES_NOT_AVAILABLE');
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects tables that are not "auto", null or a list of ids', async () => {
    for (const tables of ['some', 5, [1, 2], Array.from({ length: 13 }, (_, i) => `t${i}`)]) {
      const res = makeRes();
      await putAppointment(put({ ...body, tables }), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('a booking that keeps its tables is checked again when the time changes, in one transaction', async () => {
    known();
    (prisma.bookingTable.findMany as any).mockResolvedValue([{ tableId: 't1' }]);
    (seatExisting as any).mockResolvedValue([table]);
    const res = makeRes();
    await putAppointment(put({ ...body, patient: undefined, startTime: '2026-10-21T19:00:00Z', endTime: '2026-10-21T20:30:00Z' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect((seatExisting as any).mock.calls[0][1]).toMatchObject({ id: 'a1', locationId: 'l1', start: new Date('2026-10-21T19:00:00Z'), partySize: 4, slotDuration: 90 });
    expect((seatExisting as any).mock.calls[0][2]).toEqual({ tableIds: ['t1'], roomId: null });
    expect((recordQueueEvent as any).mock.calls[0][0].action).toBe('appointment.rescheduled');
  });

  it('refuses a new time its tables cannot take, announcing nothing', async () => {
    known();
    (prisma.bookingTable.findMany as any).mockResolvedValue([{ tableId: 't1' }]);
    (seatExisting as any).mockRejectedValue(new BookingError('Sorry, one of those was just taken. Please choose again.', 409));
    const res = makeRes();
    await putAppointment(put({ ...body, patient: undefined, startTime: '2026-10-21T19:00:00Z', endTime: '2026-10-21T20:30:00Z' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('TABLE_UNAVAILABLE');
    expect(recordQueueEvent).not.toHaveBeenCalled();
  });

  it('lets go of the tables when told to, even for a business without tables', async () => {
    known();
    (prisma.organization.findUnique as any).mockResolvedValue({ industry: 'HEALTHCARE' });
    await putAppointment(put({ ...body, patient: undefined, tables: null }), makeRes(), vi.fn());
    expect(prisma.bookingTable.deleteMany).toHaveBeenCalledWith({ where: { appointmentId: 'a1' } });
    expect(seatExisting).not.toHaveBeenCalled();
  });

  it('does not try to seat a cancelled booking', async () => {
    known();
    await putAppointment(put({ ...body, patient: undefined, status: 'cancelled', tables: 'auto' }), makeRes(), vi.fn());
    expect(seatExisting).not.toHaveBeenCalled();
    expect(withTable).not.toHaveBeenCalled();
  });
});

describe('GET /rooms', () => {
  const roomRow = {
    id: 'r1', name: 'Terrace', description: null, isActive: true, onlineBookable: true, minPartySize: 2, maxPartySize: 8, openTime: '18:00', closeTime: '23:00', activeDays: '4,5,6',
    allowCombine: true, priceMode: 'SURCHARGE', price: '10', priceBasis: 'PERSON', layoutWidth: 1000, layoutHeight: 700, layoutImageUrl: null, location: { id: 'l1', name: 'Airport' },
    tables: [{ id: 't1', name: 'Terrace 1', seats: 4, isActive: true, x: 100, y: 120, width: 90, height: 90, rotation: 0, shape: 'ROUND' }],
  };

  it('lists rooms with their rules, rates and floor plans', async () => {
    (prisma.room.findMany as any).mockResolvedValue([roomRow]);
    const res = makeRes();
    await listRooms(makeReq(), res, vi.fn());
    expect(res.json.mock.calls[0][0]).toEqual({
      tablesAvailable: true,
      rooms: [{
        id: 'r1', name: 'Terrace', description: null, active: true, location: { id: 'l1', name: 'Airport' }, onlineBookable: true,
        partySize: { min: 2, max: 8 }, hours: { open: '18:00', close: '23:00', days: [4, 5, 6] }, allowCombine: true,
        rate: { mode: 'SURCHARGE', price: 10, basis: 'PERSON' }, plan: { width: 1000, height: 700, imageUrl: null },
        tables: [{ id: 't1', name: 'Terrace 1', seats: 4, active: true, x: 100, y: 120, width: 90, height: 90, rotation: 0, shape: 'ROUND' }],
      }],
    });
    expect((prisma.room.findMany as any).mock.calls[0][0].where).toEqual({ location: { organizationId: 'org1' } });
  });

  it('narrows to a location by the connected system’s own id, and leaves tables out where the business has none', async () => {
    (prisma.location.findFirst as any).mockResolvedValue({ id: 'l1', timezone: 'UTC' });
    (prisma.organization.findUnique as any).mockResolvedValue({ industry: 'BANKING' });
    (prisma.room.findMany as any).mockResolvedValue([roomRow]);
    const res = makeRes();
    await listRooms(makeReq({ query: { location: 'LOC-1' } }), res, vi.fn());
    expect((prisma.room.findMany as any).mock.calls[0][0].where).toEqual({ location: { organizationId: 'org1' }, locationId: 'l1' });
    expect(res.json.mock.calls[0][0]).toMatchObject({ tablesAvailable: false, rooms: [{ id: 'r1', tables: [] }] });
  });
});

describe('GET /rooms/:room/availability', () => {
  const map = { room: { id: 'r1', name: 'Terrace', layoutWidth: 1000, layoutHeight: 700, layoutImageUrl: null }, tables: [{ id: 't1', name: 'Terrace 1', seats: 4, x: 1, y: 2, width: 90, height: 90, rotation: 0, shape: 'RECT', status: 'taken' }] };
  const req = (query: Record<string, unknown>) => makeReq({ params: { room: 'r1' }, query });

  beforeEach(() => {
    (prisma.room.findFirst as any).mockResolvedValue({ id: 'r1', location: { timezone: 'Africa/Accra' } });
    (seatMap as any).mockResolvedValue(map);
  });

  it('marks each table free, taken or unavailable for the time', async () => {
    const res = makeRes();
    await getRoomAvailability(req({ start: '2026-10-20T19:00:00Z', partySize: '4' }), res, vi.fn());
    expect((seatMap as any).mock.calls[0]).toEqual(['r1', { start: new Date('2026-10-20T19:00:00Z'), end: new Date('2026-10-20T20:30:00Z'), partySize: 4, online: false, timeZone: 'Africa/Accra' }]);
    expect(res.json.mock.calls[0][0]).toMatchObject({ room: { id: 'r1', name: 'Terrace' }, partySize: 4, tables: [{ id: 't1', status: 'taken' }] });
  });

  it('needs a start, a sensible end and a room of the organisation', async () => {
    let res = makeRes();
    await getRoomAvailability(req({}), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    res = makeRes();
    await getRoomAvailability(req({ start: '2026-10-20T19:00:00Z', end: '2026-10-20T18:00:00Z' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    (prisma.room.findFirst as any).mockResolvedValue(null);
    res = makeRes();
    await getRoomAvailability(req({ start: '2026-10-20T19:00:00Z' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('ROOM_NOT_FOUND');
  });

  it('is refused for a business without tables', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue({ industry: 'GOVERNMENT' });
    const res = makeRes();
    await getRoomAvailability(req({ start: '2026-10-20T19:00:00Z' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
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
