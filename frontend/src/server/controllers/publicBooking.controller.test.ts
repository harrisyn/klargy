import { describe, it, expect, vi, beforeEach } from 'vitest';

// Customers booking a time (and paying) on the public page.

const db = vi.hoisted(() => {
  const future = new Date(Date.now() + 2 * 86400000);
  return {
    future,
    service: {} as any,
    slot: {} as any,
    users: [] as any[],
    appointments: [] as any[],
    claimed: true,
    claims: [] as number[],
    collector: null as any,
    checkoutFails: false,
    tables: [] as any[],
    busy: [] as string[],
  };
});

function reset() {
  db.service = {
    id: 's1',
    isActive: true,
    bookingMode: 'BOTH',
    bookingUnit: 'BOOKING',
    minPartySize: 1,
    maxPartySize: 8,
    name: 'Haircut',
    slotDuration: 30,
    price: null,
    priceBasis: 'BOOKING',
    paymentMode: 'NONE',
    depositPercent: 30,
    refundCutoffHours: 24,
    location: { id: 'l1', name: 'Main', address: null, timezone: 'UTC', publicCode: 'MAIN', organization: { id: 'o1', name: 'Salon', status: 'ACTIVE', slug: 'salon', currency: 'USD' } },
  };
  db.slot = { id: 'sl1', queueId: 'q1', startTime: db.future, endTime: new Date(db.future.getTime() + 1800000), queue: { serviceId: 's1' }, capacity: 10, bookedCount: 0, price: null };
  db.users = [];
  db.appointments = [];
  db.claimed = true;
  db.claims = [];
  db.collector = null;
  db.checkoutFails = false;
  db.tables = [];
  db.busy = [];
}

vi.mock('../lib/prisma', () => {
  const api: any = {
    $executeRaw: vi.fn(async () => 0),
    diningTable: {
      findMany: vi.fn(async ({ where }: any) => db.tables.filter((t) => (!where.id ? true : where.id.in.includes(t.id)))),
    },
    bookingTable: { findMany: vi.fn(async () => db.busy.map((tableId) => ({ tableId }))) },
    service: { findUnique: vi.fn(async () => db.service) },
    slot: { findUnique: vi.fn(async () => db.slot) },
    user: {
      findUnique: vi.fn(async ({ where }: any) => db.users.find((u) => u.email === where.email) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const u = { id: `u${db.users.length + 1}`, ...data };
        db.users.push(u);
        return u;
      }),
    },
    appointment: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        const a = { id: 'a1', ...data };
        db.appointments.push(a);
        return a;
      }),
      update: vi.fn(async ({ data }: any) => Object.assign(db.appointments[0], data)),
      findUnique: vi.fn(async () => null),
    },
  };
  api.$transaction = async (fn: any) => fn(api);
  return { default: api };
});
vi.mock('../services/booking.service', async () => {
  const actual = await vi.importActual<typeof import('../services/booking.service')>('../services/booking.service');
  return {
    ...actual,
    availableSlots: vi.fn(async () => ({ slots: [] })),
    claimSlot: vi.fn(async (_id: string, units = 1) => { db.claims.push(units); return db.claimed; }),
    releaseSlot: vi.fn(),
    cancelAppointmentCore: vi.fn(),
    rescheduleAppointmentCore: vi.fn(),
    checkInAppointmentCore: vi.fn(),
  };
});
vi.mock('../services/bookingPayments/bookingPayments.service', async () => {
  const actual = await vi.importActual<typeof import('../services/bookingPayments/bookingPayments.service')>('../services/bookingPayments/bookingPayments.service');
  return { ...actual, collectorFor: vi.fn(async () => db.collector), refundBooking: vi.fn(async () => ({ refunded: 0, currency: null })) };
});
vi.mock('../services/queueEvents.service', () => ({ recordQueueEvent: vi.fn(async () => {}) }));
vi.mock('../services/bookingNotifications.service', () => ({
  sendBookingConfirmation: vi.fn(async () => {}),
  manageLinkFor: (t: string, s?: string) => `https://${s ?? 'app'}.test/booking/${t}`,
}));

import { createOnlineBooking, getBookableSlots } from './publicBooking.controller';
import { sendBookingConfirmation } from '../services/bookingNotifications.service';
import { releaseSlot } from '../services/booking.service';

function call(handler: any, req: any) {
  return new Promise<{ status: number; json: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(j: any) { resolve({ status: this.statusCode, json: j }); },
    };
    handler({ params: {}, query: {}, body: {}, ...req }, res, (e: unknown) => resolve({ status: 500, json: { error: String((e as Error)?.stack ?? e) } }));
  });
}

const body = (over: object = {}) => ({ serviceId: 's1', slotId: 'sl1', name: 'Ada Lovelace', email: 'ada@example.com', ...over });

const checkout = vi.fn();
beforeEach(() => {
  reset();
  vi.clearAllMocks();
  checkout.mockReset();
  checkout.mockImplementation(async () => {
    if (db.checkoutFails) throw new Error('provider down');
    return { redirectUrl: 'https://pay.test/c/1', reference: 'cs_1' };
  });
});

describe('online booking', () => {
  it('books an appointment with a private link and confirms by email', async () => {
    const r = await call(createOnlineBooking, { body: body() });
    expect(r.status).toBe(201);
    expect(db.appointments[0]).toMatchObject({ serviceId: 's1', slotId: 'sl1', source: 'ONLINE', partySize: 1 });
    expect(db.appointments[0].manageToken).toMatch(/^[0-9a-f]{48}$/);
    expect(db.users[0]).toMatchObject({ email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', role: 'PATIENT', password: '' });
    expect(sendBookingConfirmation).toHaveBeenCalledWith('a1');
    expect(r.json.checkoutUrl).toBeNull();
  });

  it('needs a name and some way to reach the customer', async () => {
    expect((await call(createOnlineBooking, { body: body({ name: ' ' }) })).status).toBe(400);
    expect((await call(createOnlineBooking, { body: body({ email: '', phone: '' }) })).status).toBe(400);
    expect((await call(createOnlineBooking, { body: body({ email: 'nope' }) })).status).toBe(400);
    expect(db.appointments).toHaveLength(0);
  });

  it('works with just a phone number and sends no confirmation email', async () => {
    const r = await call(createOnlineBooking, { body: body({ email: '', phone: '0700 000 000' }) });
    expect(r.status).toBe(201);
    expect(db.users[0].email).toMatch(/@guest\.qms\.local$/);
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it('refuses walk-in-only services', async () => {
    db.service.bookingMode = 'WALK_IN';
    expect((await call(createOnlineBooking, { body: body() })).status).toBe(403);
    expect((await call(getBookableSlots, { params: { serviceId: 's1' } })).status).toBe(403);
  });

  it('says so when the time was just taken', async () => {
    db.claimed = false;
    const r = await call(createOnlineBooking, { body: body() });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/just taken/);
    expect(db.appointments).toHaveLength(0);
  });

  it('limits how far ahead people can book', async () => {
    const r = await call(getBookableSlots, { params: { serviceId: 's1' }, query: { date: '2099-01-01' } });
    expect(r.status).toBe(400);
  });
});

describe('seats and party size', () => {
  beforeEach(() => {
    db.service.bookingUnit = 'PERSON';
    db.service.minPartySize = 1;
    db.service.maxPartySize = 6;
  });

  it('holds one place per person', async () => {
    const r = await call(createOnlineBooking, { body: body({ partySize: 4 }) });
    expect(r.status).toBe(201);
    expect(db.claims).toEqual([4]);
    expect(db.appointments[0].partySize).toBe(4);
  });

  it('keeps the party within the service’s limits', async () => {
    expect((await call(createOnlineBooking, { body: body({ partySize: 0 }) })).status).toBe(400);
    expect((await call(createOnlineBooking, { body: body({ partySize: 7 }) })).status).toBe(400);
    expect(db.appointments).toHaveLength(0);
  });

  it('says there is no room when the party does not fit', async () => {
    db.claimed = false;
    const r = await call(createOnlineBooking, { body: body({ partySize: 5 }) });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/room for that many/);
  });

  it('ignores party size for services that are not seat-based', async () => {
    db.service.bookingUnit = 'BOOKING';
    await call(createOnlineBooking, { body: body({ partySize: 5 }) });
    expect(db.claims).toEqual([1]);
    expect(db.appointments[0].partySize).toBe(1);
  });
});

describe('paying when booking', () => {
  beforeEach(() => {
    db.service.price = 20;
    db.service.priceBasis = 'PERSON';
    db.service.bookingUnit = 'PERSON';
    db.service.paymentMode = 'DEPOSIT';
    db.service.depositPercent = 25;
    db.collector = { source: 'PLATFORM', provider: 'stripe', client: { createCheckout: checkout } };
  });

  it('holds the place and sends the customer to checkout for the deposit', async () => {
    const r = await call(createOnlineBooking, { body: body({ partySize: 4 }) });
    expect(r.status).toBe(201);
    expect(r.json.checkoutUrl).toBe('https://pay.test/c/1');
    expect(db.appointments[0]).toMatchObject({
      status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
      paymentSource: 'PLATFORM',
      paymentProvider: 'stripe',
      amount: 80,
      amountDue: 20,
      currency: 'USD',
      paymentRef: 'cs_1',
    });
    expect(db.appointments[0].paymentExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(checkout.mock.calls[0][0]).toMatchObject({ amount: 20, currency: 'USD', successUrl: expect.stringContaining('?paid=1') });
    // Confirmed (and emailed) only when the payment arrives.
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it('charges everything up front for full-payment services', async () => {
    db.service.paymentMode = 'FULL';
    await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(checkout.mock.calls[0][0].amount).toBe(40);
  });

  it('uses a session’s own price', async () => {
    db.service.priceBasis = 'BOOKING';
    db.service.paymentMode = 'FULL';
    db.slot.price = 55;
    await call(createOnlineBooking, { body: body({ partySize: 3 }) });
    expect(checkout.mock.calls[0][0].amount).toBe(55);
  });

  it('remembers the checkout page so an abandoned payment can be resumed', async () => {
    await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(db.appointments[0].paymentUrl).toBe('https://pay.test/c/1');
    expect(db.appointments[0].paymentRef).toBe('cs_1');
  });

  it('needs an email to take a Paystack payment, but not a Stripe one', async () => {
    db.collector = { source: 'ORG', provider: 'paystack', client: { createCheckout: checkout } };
    const without = await call(createOnlineBooking, { body: body({ email: '', phone: '0700 000 000', partySize: 2 }) });
    expect(without.status).toBe(400);
    expect(without.json.error).toMatch(/email/);
    expect(db.appointments).toHaveLength(0);
    expect(releaseSlot).toHaveBeenCalledWith('sl1', 2);

    const withEmail = await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(withEmail.status).toBe(201);

    db.appointments = [];
    db.collector = { source: 'PLATFORM', provider: 'stripe', client: { createCheckout: checkout } };
    const stripePhoneOnly = await call(createOnlineBooking, { body: body({ email: '', phone: '0700 000 000', partySize: 2 }) });
    expect(stripePhoneOnly.status).toBe(201);
  });

  it('refuses to take a booking it cannot get paid for', async () => {
    db.collector = null;
    const r = await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(r.status).toBe(503);
    expect(db.appointments).toHaveLength(0);
  });

  it('gives the place back if checkout cannot be started', async () => {
    db.checkoutFails = true;
    const r = await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(r.status).toBe(502);
    expect(db.appointments[0]).toMatchObject({ status: 'CANCELLED', paymentStatus: 'FAILED' });
    expect(releaseSlot).toHaveBeenCalledWith('sl1', 2);
  });
});

describe('tables, rooms and seat choice', () => {
  const room = (over: object = {}) => ({
    id: 'r1', name: 'Terrace', isActive: true, onlineBookable: true, minPartySize: null, maxPartySize: null, openTime: null, closeTime: null, activeDays: null,
    allowCombine: true, priceMode: 'INHERIT', price: null, priceBasis: 'BOOKING', paymentMode: null, depositPercent: null, refundCutoffHours: null, refundTiers: null, ...over,
  });
  const table = (id: string, seats: number, roomRow: any = room(), over: object = {}) => ({
    id, name: `T${id}`, seats, area: null, sortOrder: 0, roomId: roomRow?.id ?? null, room: roomRow, x: 100, y: 100, width: 90, height: 90, rotation: 0, shape: 'RECT', ...over,
  });

  beforeEach(() => {
    db.service.tableMode = 'AUTO';
    db.service.bookingUnit = 'PERSON';
    db.service.locationId = 'l1';
    db.service.room = null;
  });

  it('gives the party the smallest table that fits and records it with its room', async () => {
    db.tables = [table('a', 6), table('b', 2), table('c', 4)];
    const r = await call(createOnlineBooking, { body: body({ partySize: 3 }) });
    expect(r.json.error ?? '').toBe('');
    expect(r.status).toBe(201);
    expect(db.appointments[0].tables).toEqual({ create: [{ tableId: 'c' }] });
    expect(db.appointments[0].roomId).toBe('r1');
    expect(db.claims).toEqual([0]); // tables, not slot places, are what run out
  });

  it('skips tables that are taken, and refuses when nothing is left', async () => {
    db.tables = [table('b', 2), table('c', 4)];
    db.busy = ['c'];
    expect((await call(createOnlineBooking, { body: body({ partySize: 3 }) })).status).toBe(400);
    expect(db.appointments).toHaveLength(0);
    expect(releaseSlot).toHaveBeenCalled();
  });

  it('seats a big party at several nearby tables when the room allows', async () => {
    db.tables = [table('a', 2, room(), { x: 100, y: 100 }), table('b', 2, room(), { x: 150, y: 100 }), table('c', 2, room(), { x: 900, y: 600 })];
    const r = await call(createOnlineBooking, { body: body({ partySize: 4 }) });
    expect(r.status).toBe(201);
    expect(db.appointments[0].tables.create.map((t: any) => t.tableId).sort()).toEqual(['a', 'b']);
  });

  it('uses the tables the customer picked, if they fit and are free', async () => {
    db.tables = [table('a', 2), table('b', 4)];
    const r = await call(createOnlineBooking, { body: body({ partySize: 4, tableIds: ['b'] }) });
    expect(r.status).toBe(201);
    expect(db.appointments[0].tables).toEqual({ create: [{ tableId: 'b' }] });

    db.appointments = [];
    const tooSmall = await call(createOnlineBooking, { body: body({ partySize: 4, tableIds: ['a'] }) });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.json.error).toMatch(/seats 2/);

    db.busy = ['b'];
    const taken = await call(createOnlineBooking, { body: body({ partySize: 4, tableIds: ['b'] }) });
    expect(taken.status).toBe(409);
    expect(db.appointments).toHaveLength(0);
  });

  it('keeps to the room the customer chose', async () => {
    const terrace = room();
    const inside = room({ id: 'r2', name: 'Inside' });
    db.tables = [table('a', 4, terrace), table('b', 4, inside)];
    await call(createOnlineBooking, { body: body({ partySize: 2, roomId: 'r2' }) });
    expect(db.appointments[0].tables).toEqual({ create: [{ tableId: 'b' }] });
    expect(db.appointments[0].roomId).toBe('r2');
  });

  it('does not offer a room that is not open to the public', async () => {
    db.tables = [table('a', 4, room({ onlineBookable: false }))];
    const r = await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(r.status).toBe(400);
    expect(db.appointments).toHaveLength(0);
  });

  it('charges the room’s rate and uses its payment terms', async () => {
    db.service.price = 20;
    db.service.priceBasis = 'PERSON';
    db.service.paymentMode = 'NONE';
    db.collector = { source: 'ORG', provider: 'stripe', client: { createCheckout: checkout } };
    // The terrace adds 5 a head and takes the full amount up front.
    db.tables = [table('a', 4, room({ priceMode: 'SURCHARGE', price: 5, priceBasis: 'PERSON', paymentMode: 'FULL' }))];
    const r = await call(createOnlineBooking, { body: body({ partySize: 2 }) });
    expect(r.status).toBe(201);
    expect(db.appointments[0]).toMatchObject({ amount: 50, amountDue: 50, status: 'PENDING_PAYMENT' });
    expect(checkout.mock.calls[0][0].amount).toBe(50);
  });
});
