import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { BookingError } from './bookingError';
import { paymentTerms, priceChange, quoteBooking, rateNote, roomRefusal, type PriceChange, type Room } from './rooms.service';

/**
 * Tables (or chairs, seats, courts, suites) that bookings are given. A table
 * sits in a room, which can have its own rules and rates and a floor plan, or
 * straight in the location. Every service at the location draws on the same
 * tables, so two services can't book one at the same time. With a service's
 * tableMode AUTO a booking is given the smallest free table that fits its
 * party; a big party gets several nearby ones when none is big enough; and a
 * customer or host can pick the tables on the floor plan instead.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

/** A booking in these states is sitting at its table (or about to be). */
const OCCUPYING = ['PENDING_PAYMENT', 'SCHEDULED', 'CONFIRMED', 'CHECKED_IN'];
const MAX_COMBINED = 12;

export interface TableRow {
  id: string;
  name: string;
  seats: number;
  area: string | null;
  sortOrder: number;
  roomId: string | null;
  room: Room | null;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  shape: string;
}

const tableSelect = {
  id: true,
  name: true,
  seats: true,
  area: true,
  sortOrder: true,
  roomId: true,
  room: true,
  x: true,
  y: true,
  width: true,
  height: true,
  rotation: true,
  shape: true,
} as const;

/** Who is booking and when, so a room's rules can be applied. */
export interface Context {
  start: Date;
  partySize: number;
  /** The public page (rooms may be staff-only) rather than the front desk. */
  online: boolean;
  timeZone?: string | null;
  /** Only tables in this room. */
  roomId?: string | null;
  /** The customer's or host's own choice of tables, instead of automatic assignment. */
  tableIds?: string[] | null;
}

/** Serialises table choices per location, so two bookings can't take the same table. */
export async function lockLocation(tx: Prisma.TransactionClient, locationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'tables:' + locationId}))`;
}

const bySize = (a: TableRow, b: TableRow) => a.seats - b.seats || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** The room's rules (hours, who may book, party limits) let this table be used; says nothing about its seats. */
export function tableAllowed(table: TableRow, ctx: Pick<Context, 'start' | 'partySize' | 'online' | 'timeZone' | 'roomId'>): boolean {
  if (ctx.roomId && table.roomId !== ctx.roomId) return false;
  if (table.room && roomRefusal(table.room, ctx)) return false;
  return true;
}

/** A single table seats the party and the rules allow it. */
export const tableFits = (table: TableRow, ctx: Context): boolean => table.seats >= ctx.partySize && tableAllowed(table, ctx);

const distance = (a: TableRow, b: TableRow) => {
  if (a.x == null || a.y == null || b.x == null || b.y == null) return Math.abs(a.sortOrder - b.sortOrder) * 100;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

/**
 * The tables to give a party from the free ones: the smallest single table that fits,
 * else (where the room allows it) the nearest group in one room whose seats add up.
 * Null when the party can't be seated.
 */
export function seatParty(free: TableRow[], ctx: Context): TableRow[] | null {
  const allowed = free.filter((t) => tableAllowed(t, ctx)).sort(bySize);
  const single = allowed.find((t) => t.seats >= ctx.partySize);
  if (single) return [single];

  let best: { tables: TableRow[]; spread: number } | null = null;
  const rooms = new Map<string, TableRow[]>();
  for (const t of allowed) {
    if (t.roomId && t.room?.allowCombine) rooms.set(t.roomId, [...(rooms.get(t.roomId) ?? []), t]);
  }
  for (const group of rooms.values()) {
    if (group.reduce((n, t) => n + t.seats, 0) < ctx.partySize) continue;
    for (const anchor of group) {
      const nearest = [...group].sort((a, b) => distance(anchor, a) - distance(anchor, b));
      const chosen: TableRow[] = [];
      let seats = 0;
      let spread = 0;
      for (const t of nearest) {
        chosen.push(t);
        seats += t.seats;
        spread += distance(anchor, t);
        if (seats >= ctx.partySize || chosen.length >= MAX_COMBINED) break;
      }
      if (seats < ctx.partySize) continue;
      if (!best || spread < best.spread || (spread === best.spread && chosen.length < best.tables.length)) best = { tables: chosen, spread };
    }
  }
  return best?.tables ?? null;
}

/** Ids of these tables that hold a booking overlapping [start, end). */
export async function busyTableIds(db: Db, input: { tableIds: string[]; start: Date; end: Date; excludeAppointmentId?: string }): Promise<Set<string>> {
  if (input.tableIds.length === 0) return new Set();
  const rows = await db.bookingTable.findMany({
    where: {
      tableId: { in: input.tableIds },
      appointment: {
        status: { in: OCCUPYING },
        startTime: { lt: input.end },
        OR: [{ endTime: { gt: input.start } }, { endTime: null, startTime: { gte: input.start } }],
        ...(input.excludeAppointmentId ? { id: { not: input.excludeAppointmentId } } : {}),
      },
    },
    select: { tableId: true },
  });
  return new Set(rows.map((r) => r.tableId));
}

/** Active tables free for the whole of [start, end). */
export async function freeTables(db: Db, input: { locationId: string; start: Date; end: Date; excludeAppointmentId?: string }): Promise<TableRow[]> {
  const tables = (await db.diningTable.findMany({ where: { locationId: input.locationId, isActive: true }, select: tableSelect })) as unknown as TableRow[];
  const taken = await busyTableIds(db, { tableIds: tables.map((t) => t.id), start: input.start, end: input.end, excludeAppointmentId: input.excludeAppointmentId });
  return tables.filter((t) => !taken.has(t.id)).sort(bySize);
}

/**
 * Chooses the tables for a booking: the ones asked for (checked), else automatically.
 * Throws a message the customer can act on.
 */
export async function chooseTables(db: Db, input: Context & { locationId: string; end: Date; excludeAppointmentId?: string }): Promise<TableRow[]> {
  const free = await freeTables(db, input);
  const chosenIds = [...new Set(input.tableIds ?? [])];
  if (chosenIds.length > 0) {
    if (chosenIds.length > MAX_COMBINED) throw new BookingError(`Choose up to ${MAX_COMBINED} tables or seats.`);
    const picked = chosenIds.map((id) => free.find((t) => t.id === id));
    const all = (await db.diningTable.findMany({ where: { id: { in: chosenIds }, locationId: input.locationId, isActive: true }, select: { id: true } })).map((t) => t.id);
    if (all.length !== chosenIds.length) throw new BookingError('One of those tables isn’t available.', 404);
    if (picked.some((t) => !t)) throw new BookingError('Sorry, one of those was just taken. Please choose again.', 409);
    const tables = picked as TableRow[];
    if (new Set(tables.map((t) => t.roomId)).size > 1) throw new BookingError('Choose tables in one room.');
    for (const t of tables) {
      if (!tableAllowed(t, input)) {
        const why = t.room ? roomRefusal(t.room, input) : null;
        throw new BookingError(why ?? `${t.name} can’t take this booking.`);
      }
    }
    if (tables.reduce((n, t) => n + t.seats, 0) < input.partySize) throw new BookingError(`That seats ${tables.reduce((n, t) => n + t.seats, 0)}, and the booking is for ${input.partySize}. Choose more.`);
    return tables;
  }
  const seated = seatParty(free, input);
  if (!seated) {
    throw new BookingError(
      input.roomId ? 'There isn’t room in that area at that time. Please choose another time or area.' : input.partySize > 1 ? 'There isn’t a table free for that many at that time. Please choose another time.' : 'There isn’t a table free at that time. Please choose another time.'
    );
  }
  return seated;
}

/**
 * Runs `create` with the tables to give the booking. For services without
 * tables it just runs (with none). With tables it chooses and creates in one
 * locked transaction, so two bookings can't take the same table.
 */
export async function withTable<T>(
  opts: Context & { tableMode: string; locationId: string; end: Date; excludeAppointmentId?: string },
  create: (db: Db, tables: TableRow[]) => Promise<T>
): Promise<T> {
  if (opts.tableMode !== 'AUTO') return create(prisma, []);
  return prisma.$transaction(async (tx) => {
    await lockLocation(tx, opts.locationId);
    return create(tx, await chooseTables(tx, opts));
  });
}

/** How long a booking holds its table: until its end time, else the service's length. */
export const bookingEnd = (start: Date, end: Date | null | undefined, minutes: number) => end ?? new Date(start.getTime() + minutes * 60_000);

/** Prisma data that records the booking's tables and room. */
export const tableData = (tables: TableRow[], serviceRoomId: string | null) => ({
  roomId: tables[0]?.roomId ?? serviceRoomId,
  ...(tables.length ? { tables: { create: tables.map((t) => ({ tableId: t.id })) } } : {}),
});

/**
 * Which slots have tables for this party. One query for the day, then checked
 * slot by slot, applying each room's rules to the slot's start.
 */
export async function slotsWithTable(
  locationId: string,
  slots: { id: string; startTime: Date; endTime: Date }[],
  ctx: Omit<Context, 'start'>
): Promise<Set<string>> {
  const ok = new Set<string>();
  if (slots.length === 0) return ok;
  const tables = (await prisma.diningTable.findMany({ where: { locationId, isActive: true }, select: tableSelect })) as unknown as TableRow[];
  if (tables.length === 0) return ok;
  const from = new Date(Math.min(...slots.map((s) => s.startTime.getTime())));
  const to = new Date(Math.max(...slots.map((s) => s.endTime.getTime())));
  const busy = await prisma.bookingTable.findMany({
    where: {
      tableId: { in: tables.map((t) => t.id) },
      appointment: {
        status: { in: OCCUPYING },
        startTime: { lt: to },
        OR: [{ endTime: { gt: from } }, { endTime: null, startTime: { gte: from } }],
      },
    },
    select: { tableId: true, appointment: { select: { startTime: true, endTime: true } } },
  });
  for (const s of slots) {
    const taken = new Set(
      busy.filter((b) => b.appointment.startTime < s.endTime && (b.appointment.endTime ? b.appointment.endTime > s.startTime : b.appointment.startTime >= s.startTime)).map((b) => b.tableId)
    );
    if (seatParty(tables.filter((t) => !taken.has(t.id)), { ...ctx, start: s.startTime })) ok.add(s.id);
  }
  return ok;
}

export interface RoomChoice {
  id: string;
  name: string;
  description: string | null;
  rate: { mode: string; price: number | null; basis: string };
  /** The biggest party this room can seat. */
  seats: number;
  hasLayout: boolean;
}

/** Rooms the public page can offer for a party: active, bookable online, with room for them. */
export async function roomChoices(locationId: string, partySize: number): Promise<RoomChoice[]> {
  const rooms = await prisma.room.findMany({
    where: { locationId, isActive: true, onlineBookable: true },
    include: { tables: { where: { isActive: true }, select: { seats: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rooms
    .map((r) => {
      const biggest = Math.max(0, ...r.tables.map((t) => t.seats));
      const total = r.tables.reduce((n, t) => n + t.seats, 0);
      return { r, capacity: r.allowCombine ? total : biggest };
    })
    .filter(({ r, capacity }) => capacity >= partySize && (!r.minPartySize || partySize >= r.minPartySize) && (!r.maxPartySize || partySize <= r.maxPartySize))
    .map(({ r, capacity }) => ({ id: r.id, name: r.name, description: r.description, rate: rateNote(r), seats: capacity, hasLayout: r.tables.length > 0 }));
}

export interface SeatMapTable {
  id: string;
  name: string;
  seats: number;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  shape: string;
  /** free: can be picked. taken: someone has it then. unavailable: the room's rules don't allow it for this booking. */
  status: 'free' | 'taken' | 'unavailable';
}

export interface SeatMap {
  room: { id: string; name: string; layoutWidth: number; layoutHeight: number; layoutImageUrl: string | null };
  tables: SeatMapTable[];
}

/** A room's floor plan with each table marked free, taken or unavailable for a booking at this time. */
export async function seatMap(roomId: string, ctx: Context & { end: Date; excludeAppointmentId?: string }): Promise<SeatMap | null> {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { tables: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } } });
  if (!room) return null;
  const taken = await busyTableIds(prisma, { tableIds: room.tables.map((t) => t.id), start: ctx.start, end: ctx.end, excludeAppointmentId: ctx.excludeAppointmentId });
  const rule = roomRefusal(room, ctx);
  return {
    room: { id: room.id, name: room.name, layoutWidth: room.layoutWidth, layoutHeight: room.layoutHeight, layoutImageUrl: room.layoutImageUrl },
    tables: room.tables.map((t) => ({
      id: t.id,
      name: t.name,
      seats: t.seats,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      rotation: t.rotation,
      shape: t.shape,
      status: rule ? 'unavailable' : taken.has(t.id) ? 'taken' : 'free',
    })),
  };
}

/** An existing booking, as far as choosing its tables goes. */
export interface Seating {
  id: string;
  locationId: string;
  start: Date;
  end: Date | null;
  slotDuration: number;
  partySize: number;
  timeZone?: string | null;
}

/**
 * Gives an existing booking (possibly at new times or for a new party) its
 * tables, replacing the ones it holds: the ones named, else chosen
 * automatically. Runs inside the caller's transaction, under the location's
 * lock, and throws a BookingError when they can't be had, so the caller's other
 * changes roll back with it. Tables are chosen as the front desk (staff-only
 * rooms allowed).
 */
export async function seatExisting(tx: Prisma.TransactionClient, a: Seating, pick: { tableIds?: string[] | null; roomId?: string | null }): Promise<TableRow[]> {
  await lockLocation(tx, a.locationId);
  const tables = await chooseTables(tx, {
    locationId: a.locationId,
    start: a.start,
    end: bookingEnd(a.start, a.end, a.slotDuration),
    partySize: a.partySize,
    online: false,
    timeZone: a.timeZone,
    tableIds: pick.tableIds?.length ? pick.tableIds : null,
    roomId: pick.roomId ?? null,
    excludeAppointmentId: a.id,
  });
  await tx.bookingTable.deleteMany({ where: { appointmentId: a.id } });
  await tx.bookingTable.createMany({ data: tables.map((t) => ({ appointmentId: a.id, tableId: t.id })) });
  return tables;
}

/** Thrown when a move would change what the booking costs and the host hasn't agreed to that yet. */
export class PriceChangeError extends BookingError {
  constructor(message: string, public change: PriceChange) {
    super(message, 409);
  }
}

export interface MoveResult {
  tables: { id: string; name: string; seats: number }[];
  /** Set when the move changed the price: the host agreed to it. */
  priceChange: PriceChange | null;
}

/**
 * Staff move a booking to other tables. They must belong to the location, seat
 * the party and be free. Moving to a table in another room applies that room's
 * rate: a booking with a price on it is repriced, and the host must agree
 * (`confirmPrice`) before the price changes. Money owed is shown, not charged;
 * money overpaid is refunded by the caller once the move has been saved.
 */
export async function reassignTables(appointmentId: string, tableIds: string[], opts: { confirmPrice?: boolean; auto?: boolean; roomId?: string | null } = {}): Promise<MoveResult> {
  return prisma.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        slot: { select: { price: true } },
        service: { select: { locationId: true, slotDuration: true, roomId: true, price: true, priceBasis: true, paymentMode: true, depositPercent: true, refundCutoffHours: true, refundTiers: true, room: true, location: { select: { timezone: true } } } },
      },
    });
    if (!a) throw new BookingError('Appointment not found', 404);
    let tables: TableRow[] = [];
    if (tableIds.length > 0 || opts.auto) {
      tables = await seatExisting(
        tx,
        { id: a.id, locationId: a.service.locationId, start: a.startTime, end: a.endTime, slotDuration: a.service.slotDuration, partySize: a.partySize, timeZone: a.service.location.timezone },
        { tableIds, roomId: opts.roomId }
      );
    } else {
      await tx.bookingTable.deleteMany({ where: { appointmentId: a.id } });
    }
    const roomId = tables[0]?.roomId ?? a.service.roomId;
    const room = tables[0]?.room ?? a.service.room;

    // A booking that carries a price is repriced under the room it is moving to. A price the
    // connected system reported (paymentSource EXTERNAL) is theirs, so it is left alone.
    let change: PriceChange | null = null;
    let nextAmount: number | null = null;
    // (An earlier move whose refund failed leaves the booking overpaid; moving again settles it.)
    if (a.amount != null && a.paymentSource !== 'EXTERNAL' && (roomId !== a.roomId || Number(a.amountPaid ?? 0) > Number(a.amount))) {
      const terms = paymentTerms(a.service, room);
      const quote = quoteBooking({ service: a.service, slotPrice: a.slot?.price, room, partySize: a.partySize, terms });
      change = priceChange(Number(a.amount), quote.total, Number(a.amountPaid ?? 0));
      nextAmount = quote.total;
      if (change) {
        if (a.status === 'PENDING_PAYMENT') {
          throw new BookingError('This booking is waiting for payment at its current price. Let it finish, or cancel it, before moving it to a room that costs differently.');
        }
        if (!opts.confirmPrice) {
          throw new PriceChangeError('Moving them changes the price.', change);
        }
      }
    }

    // Paying more is recorded now; a refund is recorded once it has gone through.
    const raise = change != null && nextAmount != null && change.diff > 0;
    await tx.appointment.update({ where: { id: a.id }, data: { roomId, ...(raise ? { amount: nextAmount } : {}) } });
    return { tables: tables.map((t) => ({ id: t.id, name: t.name, seats: t.seats })), priceChange: change };
  });
}
