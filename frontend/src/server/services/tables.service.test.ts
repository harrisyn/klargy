import { describe, it, expect, vi, beforeEach } from 'vitest';

// Choosing tables: the smallest that fits, nearby groups for big parties,
// a room's rules, the customer's own pick, and what a floor plan shows.

const db = vi.hoisted(() => ({ appt: null as any, updates: [] as any[], tables: [] as any[], busy: [] as { tableId: string; appointment: { startTime: Date; endTime: Date | null } }[], rooms: [] as any[] }));

vi.mock('../lib/prisma', () => {
  const api: any = {
    $executeRaw: vi.fn(async () => 0),
    diningTable: {
      findMany: vi.fn(async ({ where }: any) => db.tables.filter((t) => t.isActive !== false && (!where?.id ? true : where.id.in.includes(t.id)))),
    },
    bookingTable: { findMany: vi.fn(async () => db.busy), deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
    appointment: { findUnique: vi.fn(async () => db.appt), update: vi.fn(async (a: any) => { db.updates.push(a.data); return {}; }) },
    room: { findUnique: vi.fn(async ({ where }: any) => db.rooms.find((r) => r.id === where.id) ?? null), findMany: vi.fn(async () => db.rooms) },
  };
  api.$transaction = async (fn: any) => fn(api);
  return { default: api };
});

import prisma from '../lib/prisma';
import { PriceChangeError, reassignTables, seatParty, chooseTables, roomChoices, seatMap, slotsWithTable, tableAllowed, type TableRow } from './tables.service';
import type { Room } from './rooms.service';

const room = (over: Partial<Room> = {}): Room => ({
  id: 'r1', name: 'Terrace', isActive: true, onlineBookable: true, minPartySize: null, maxPartySize: null, openTime: null, closeTime: null, activeDays: null,
  allowCombine: true, priceMode: 'INHERIT', price: null, priceBasis: 'BOOKING', paymentMode: null, depositPercent: null, refundCutoffHours: null, refundTiers: null, ...over,
});
const table = (id: string, seats: number, over: Partial<TableRow> = {}): TableRow => ({
  id, name: `T${id}`, seats, area: null, sortOrder: 0, roomId: 'r1', room: room(), x: 0, y: 0, width: 90, height: 90, rotation: 0, shape: 'RECT', ...over,
});

const start = new Date('2026-10-23T19:00:00Z');
const end = new Date('2026-10-23T20:30:00Z');
const ctx = (over: object = {}) => ({ start, partySize: 2, online: true, timeZone: 'UTC', ...over });

beforeEach(() => {
  db.tables = [];
  db.busy = [];
  db.rooms = [];
  db.appt = null;
  db.updates = [];
});

describe('seatParty', () => {
  it('gives the smallest single table that fits', () => {
    const t = seatParty([table('a', 6), table('b', 2), table('c', 4)], ctx({ partySize: 3 }));
    expect(t?.map((x) => x.id)).toEqual(['c']);
  });

  it('puts a party that no table holds at the nearest tables whose seats add up', () => {
    const near1 = table('n1', 2, { x: 100, y: 100 });
    const near2 = table('n2', 2, { x: 160, y: 100 });
    const far = table('f', 2, { x: 900, y: 600 });
    const t = seatParty([far, near1, near2], ctx({ partySize: 4 }));
    expect(t?.map((x) => x.id).sort()).toEqual(['n1', 'n2']);
  });

  it('does not combine in a room that does not allow it, or across rooms', () => {
    const noCombine = room({ allowCombine: false });
    expect(seatParty([table('a', 2, { room: noCombine }), table('b', 2, { room: noCombine })], ctx({ partySize: 4 }))).toBeNull();
    const other = room({ id: 'r2', name: 'Inside' });
    expect(seatParty([table('a', 2), table('b', 2, { roomId: 'r2', room: other })], ctx({ partySize: 4 }))).toBeNull();
  });

  it('respects room rules: staff-only rooms, party limits, hours', () => {
    expect(seatParty([table('a', 4, { room: room({ onlineBookable: false }) })], ctx())).toBeNull();
    expect(seatParty([table('a', 4, { room: room({ onlineBookable: false }) })], ctx({ online: false }))?.[0].id).toBe('a');
    expect(seatParty([table('a', 8, { room: room({ minPartySize: 6 }) })], ctx())).toBeNull();
    expect(seatParty([table('a', 8, { room: room({ openTime: '12:00', closeTime: '15:00' }) })], ctx())).toBeNull();
  });

  it('can be asked for one room only', () => {
    const inside = room({ id: 'r2', name: 'Inside' });
    const tables = [table('a', 2), table('b', 4, { roomId: 'r2', room: inside })];
    expect(seatParty(tables, ctx({ roomId: 'r2' }))?.[0].id).toBe('b');
    expect(tableAllowed(tables[0], ctx({ roomId: 'r2' }))).toBe(false);
  });

  it('treats a table outside any room as unrestricted', () => {
    expect(seatParty([table('a', 4, { roomId: null, room: null })], ctx())?.[0].id).toBe('a');
  });
});

describe('chooseTables', () => {
  const input = (over: object = {}) => ({ locationId: 'l1', end, ...ctx(), ...over });
  const rows = (...ts: TableRow[]) => { db.tables = ts; };

  it('assigns automatically, skipping tables busy at that time', async () => {
    rows(table('a', 2), table('b', 4));
    db.busy = [{ tableId: 'a', appointment: { startTime: start, endTime: end } }];
    expect((await chooseTables(prisma as never, input({ partySize: 2 }))).map((t) => t.id)).toEqual(['b']);
  });

  it('says so when nothing fits', async () => {
    rows(table('a', 2));
    await expect(chooseTables(prisma as never, input({ partySize: 5 }))).rejects.toThrow(/isn’t a table free for that many/);
  });

  it('uses the tables the customer picked when they are free, in one room and big enough', async () => {
    rows(table('a', 2), table('b', 2), table('c', 4, { roomId: 'r2', room: room({ id: 'r2' }) }));
    expect((await chooseTables(prisma as never, input({ partySize: 4, tableIds: ['a', 'b'] }))).map((t) => t.id).sort()).toEqual(['a', 'b']);
    await expect(chooseTables(prisma as never, input({ partySize: 4, tableIds: ['a'] }))).rejects.toThrow(/seats 2/);
    await expect(chooseTables(prisma as never, input({ partySize: 4, tableIds: ['a', 'c'] }))).rejects.toThrow(/one room/);
    await expect(chooseTables(prisma as never, input({ tableIds: ['ghost'] }))).rejects.toThrow(/isn’t available/);
  });

  it('refuses a picked table that was just taken', async () => {
    rows(table('a', 4));
    db.busy = [{ tableId: 'a', appointment: { startTime: start, endTime: end } }];
    await expect(chooseTables(prisma as never, input({ tableIds: ['a'] }))).rejects.toThrow(/just taken/);
  });

  it('refuses a picked table the room’s rules do not allow', async () => {
    rows(table('a', 4, { room: room({ onlineBookable: false }) }));
    await expect(chooseTables(prisma as never, input({ tableIds: ['a'] }))).rejects.toThrow(/can’t be booked online/);
  });
});

describe('availability', () => {
  it('lists the slots a table is free for, applying each slot’s own time', async () => {
    db.tables = [table('a', 4)];
    const slots = [
      { id: 's1', startTime: new Date('2026-10-23T18:00:00Z'), endTime: new Date('2026-10-23T19:00:00Z') },
      { id: 's2', startTime: new Date('2026-10-23T19:00:00Z'), endTime: new Date('2026-10-23T20:00:00Z') },
    ];
    db.busy = [{ tableId: 'a', appointment: { startTime: new Date('2026-10-23T19:15:00Z'), endTime: new Date('2026-10-23T20:00:00Z') } }];
    const ok = await slotsWithTable('l1', slots, { partySize: 2, online: true, timeZone: 'UTC' });
    expect([...ok]).toEqual(['s1']);
  });

  it('offers the rooms that can seat a party, with their rate', async () => {
    db.rooms = [
      { id: 'r1', name: 'Terrace', description: 'Outside', priceMode: 'SURCHARGE', price: 5, priceBasis: 'PERSON', allowCombine: false, minPartySize: null, maxPartySize: null, tables: [{ seats: 4 }, { seats: 2 }] },
      { id: 'r2', name: 'Private', description: null, priceMode: 'INHERIT', price: null, priceBasis: 'BOOKING', allowCombine: true, minPartySize: 6, maxPartySize: null, tables: [{ seats: 4 }, { seats: 4 }] },
    ];
    const four = await roomChoices('l1', 4);
    expect(four.map((r) => r.name)).toEqual(['Terrace']);
    expect(four[0].rate).toEqual({ mode: 'SURCHARGE', price: 5, basis: 'PERSON' });
    expect((await roomChoices('l1', 9)).map((r) => r.name)).toEqual([]);
    expect((await roomChoices('l1', 7)).map((r) => r.name)).toEqual(['Private']);
    expect((await roomChoices('l1', 6)).map((r) => r.name)).toEqual(['Private']);
  });

  it('draws the floor plan with free, taken and unavailable tables', async () => {
    db.rooms = [{ ...room(), layoutWidth: 1000, layoutHeight: 700, layoutImageUrl: 'https://img/room.png', tables: [
      { id: 'a', name: 'A', seats: 2, x: 10, y: 20, width: 90, height: 90, rotation: 0, shape: 'ROUND' },
      { id: 'b', name: 'B', seats: 4, x: 200, y: 20, width: 90, height: 90, rotation: 0, shape: 'RECT' },
    ] }];
    db.busy = [{ tableId: 'b', appointment: { startTime: start, endTime: end } }];
    const map = await seatMap('r1', { ...ctx(), end });
    expect(map!.room).toMatchObject({ layoutWidth: 1000, layoutImageUrl: 'https://img/room.png' });
    expect(map!.tables.map((t) => [t.id, t.status])).toEqual([['a', 'free'], ['b', 'taken']]);

    db.rooms = [{ ...db.rooms[0], onlineBookable: false }];
    expect((await seatMap('r1', { ...ctx(), end }))!.tables.every((t) => t.status === 'unavailable')).toBe(true);
    expect((await seatMap('ghost', { ...ctx(), end }))).toBeNull();
  });
});

describe('moving a booking to another room', () => {
  const booked = (over: object = {}) => ({
    id: 'a1', partySize: 2, startTime: start, endTime: end, status: 'SCHEDULED', roomId: 'r1', amount: 50, amountPaid: 50, slot: { price: null },
    service: { locationId: 'l1', slotDuration: 90, roomId: null, price: 50, priceBasis: 'BOOKING', paymentMode: 'FULL', depositPercent: 30, refundCutoffHours: 24, refundTiers: null, room: null, location: { timezone: 'UTC' } },
    ...over,
  });
  const premium = room({ id: 'r2', name: 'Chef’s table', priceMode: 'SURCHARGE', price: 30 as any });

  beforeEach(() => {
    db.tables = [{ id: 'p', name: 'P1', seats: 2, area: null, sortOrder: 0, roomId: 'r2', room: premium, x: 0, y: 0, width: 90, height: 90, rotation: 0, shape: 'RECT', isActive: true }];
  });

  it('asks the host before changing the price, and changes nothing', async () => {
    db.appt = booked();
    await expect(reassignTables('a1', ['p'])).rejects.toBeInstanceOf(PriceChangeError);
    expect(db.updates).toEqual([]);
  });

  it('applies a dearer room after the host agrees: the new total is recorded, the balance shown', async () => {
    db.appt = booked();
    const r = await reassignTables('a1', ['p'], { confirmPrice: true });
    expect(r.priceChange).toMatchObject({ from: 50, to: 80, balance: 30, refund: 0 });
    expect(db.updates[0]).toMatchObject({ roomId: 'r2', amount: 80 });
  });

  it('a cheaper room leaves the amount for the caller to settle once the refund has gone through', async () => {
    db.appt = booked({ amount: 80, amountPaid: 80, roomId: 'r2', service: { ...booked().service, price: 50 } });
    db.tables = [{ id: 'q', name: 'Q1', seats: 2, area: null, sortOrder: 0, roomId: 'r1', room: room(), x: 0, y: 0, width: 90, height: 90, rotation: 0, shape: 'RECT', isActive: true }];
    const r = await reassignTables('a1', ['q'], { confirmPrice: true });
    expect(r.priceChange).toMatchObject({ from: 80, to: 50, refund: 30 });
    expect(db.updates[0]).toEqual({ roomId: 'r1' });
  });

  it('does not touch the price of a booking that has none', async () => {
    db.appt = booked({ amount: null, amountPaid: null });
    const r = await reassignTables('a1', ['p']);
    expect(r.priceChange).toBeNull();
    expect(db.updates[0]).toEqual({ roomId: 'r2' });
  });

  it('refuses while the booking is waiting for payment at the old price', async () => {
    db.appt = booked({ status: 'PENDING_PAYMENT', amountPaid: null });
    await expect(reassignTables('a1', ['p'], { confirmPrice: true })).rejects.toThrow(/waiting for payment/);
  });

  it('retries a failed refund: an overpaid booking in the right room is still settled', async () => {
    db.appt = booked({ amount: 50, amountPaid: 80, roomId: 'r1' });
    db.tables = [{ id: 'q', name: 'Q1', seats: 2, area: null, sortOrder: 0, roomId: 'r1', room: room(), x: 0, y: 0, width: 90, height: 90, rotation: 0, shape: 'RECT', isActive: true }];
    const r = await reassignTables('a1', ['q'], { confirmPrice: true });
    expect(r.priceChange).toMatchObject({ refund: 30 });
  });
});

describe('module loading', () => {
  it('works whichever of booking.service and tables.service is loaded first', async () => {
    vi.resetModules();
    await import('./booking.service');
    const tables = await import('./tables.service');
    const { BookingError } = await import('./bookingError');
    expect(new tables.PriceChangeError('x', {} as never)).toBeInstanceOf(BookingError);
    // Loading booking.service pulls in much of the server, which is slow on a busy machine.
  }, 30_000);
});
