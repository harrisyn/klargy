import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { ConnectError, badRequest, handle, text } from './connect.controller';
import { parsePatient, resolveService, upsertPatient } from './connectQueue.controller';
import { buildRefs, klargyIdFor } from '../services/externalRefs.service';
import { ORIGIN, QueueAction, getOrCreateQueueForDate, recordQueueEvent, setQueueStatus } from '../services/queueEvents.service';
import { liveStatus, summaryBetween } from '../services/ai/metrics';
import { getEndOfDay, getStartOfDay, validTimeZone } from '../utils/date';
import { industryFeatures } from '../../lib/terms';
import { BookingError } from '../services/booking.service';
import { bookingEnd, seatExisting, seatMap, tableData, withTable, type TableRow } from '../services/tables.service';

// Klargy Connect v1, phase 5 (docs/connect/v1.md section 8): appointments
// booked in the EMR, queue numbers for the EMR's dashboards, and pausing a
// service's queue. Every handler runs after authenticateIntegration.

type Caller = { id: string; organizationId: string };
const caller = (req: Request): Caller => ({ id: req.integration!.id, organizationId: req.integration!.organizationId });
const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === 'P2002';
const MAX_NOTES = 1000;
const MAX_MESSAGE = 300;
const MAX_RANGE_DAYS = 90;

// ---------------------------------------------------------------------------
// PUT /appointments/:appointmentRef
// ---------------------------------------------------------------------------

const APPOINTMENT_STATUSES = ['booked', 'cancelled', 'no_show', 'completed'] as const;
type ConnectAppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Klargy's appointment status as the contract names it. */
export function connectAppointmentStatus(status: string): string {
  switch (status) {
    case 'SCHEDULED':
    case 'CONFIRMED':
      return 'booked';
    case 'CHECKED_IN':
      return 'checked_in';
    case 'NO_SHOW':
      return 'no_show';
    default:
      return status.toLowerCase();
  }
}

function klargyStatus(requested: ConnectAppointmentStatus, current: string | null): string {
  switch (requested) {
    case 'booked':
      // Still booked: keep a confirmation or a check-in Klargy already has.
      return current && ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN'].includes(current) ? current : 'SCHEDULED';
    case 'cancelled':
      return 'CANCELLED';
    case 'no_show':
      return 'NO_SHOW';
    case 'completed':
      return 'COMPLETED';
  }
}

function isoTime(value: unknown, field: string, required: boolean): Date | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw badRequest(`${field} must be an ISO 8601 time`);
  return date;
}

/** People in the booking (seats, covers); optional. */
function parsePartySize(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw badRequest('partySize must be a whole number from 1 to 500');
  return n;
}

/** Which tables or seats the connected system wants for the booking; optional. */
type Seating = { kind: 'clear' } | { kind: 'auto'; roomId: string | null } | { kind: 'pick'; tableIds: string[] };

function parseSeating(body: Record<string, unknown>): Seating | undefined {
  const room = body.room === undefined || body.room === null ? null : text(body.room, 'room', false) ?? null;
  const tables = body.tables;
  if (tables === undefined && room === null) return undefined;
  if (tables === null || (Array.isArray(tables) && tables.length === 0)) return { kind: 'clear' };
  if (tables === undefined || tables === 'auto') return { kind: 'auto', roomId: room };
  if (!Array.isArray(tables) || tables.length > 12 || tables.some((t) => typeof t !== 'string' || !t.trim())) {
    throw badRequest('tables must be "auto", null, or up to 12 table ids from GET /rooms');
  }
  return { kind: 'pick', tableIds: [...new Set((tables as string[]).map((t) => t.trim()))] };
}

/** Tables are for some kinds of business only. */
async function requireTables(organizationId: string) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { industry: true } });
  if (!industryFeatures(org?.industry).tables) {
    throw new ConnectError('Tables and seats aren’t used for this kind of business', 422, 'TABLES_NOT_AVAILABLE');
  }
}

/** A booking that can't get its tables: 409 with a code the connected system can act on. */
function seatingConflict(error: unknown): never {
  if (error instanceof BookingError) throw new ConnectError(error.message, 409, 'TABLE_UNAVAILABLE');
  throw error;
}

/** What the connected system says about money for this booking; optional. */
function parsePayment(value: unknown): { total: number | null; paid: number | null; currency: string | null } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw badRequest('payment must be an object');
  const p = value as Record<string, unknown>;
  const money = (v: unknown, field: string) => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw badRequest(`payment.${field} must be zero or more`);
    return Math.round(n * 100) / 100;
  };
  const currency = p.currency === undefined || p.currency === null ? null : String(p.currency).trim().toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw badRequest('payment.currency must be a three-letter code');
  return { total: money(p.total, 'total'), paid: money(p.paid, 'paid'), currency };
}

function parseAppointment(body: Record<string, unknown>) {
  const refs = (body.refs && typeof body.refs === 'object' ? body.refs : {}) as Record<string, unknown>;
  const startTime = isoTime(body.startTime, 'startTime', true)!;
  const endTime = isoTime(body.endTime, 'endTime', false);
  if (endTime && endTime < startTime) throw badRequest('endTime must not be before startTime');
  const status = (body.status ?? 'booked') as ConnectAppointmentStatus;
  if (!APPOINTMENT_STATUSES.includes(status)) throw badRequest(`status must be one of: ${APPOINTMENT_STATUSES.join(', ')}`);
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') throw badRequest('notes must be a string');
  text(refs.visit, 'refs.visit', false);
  text(body.staff, 'staff', false);
  return {
    seating: parseSeating(body),
    partySize: parsePartySize(body.partySize),
    payment: parsePayment(body.payment),
    patientRef: text(refs.patient, 'refs.patient')!,
    patient: body.patient === undefined || body.patient === null ? undefined : parsePatient(body.patient),
    serviceRef: text(body.service, 'service')!,
    startTime,
    endTime,
    status,
    notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, MAX_NOTES) : null,
  };
}

async function appointmentView(integrationId: string, appointmentId: string) {
  const a = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    include: {
      service: { select: { id: true, name: true, locationId: true } },
      room: { select: { id: true, name: true } },
      tables: { select: { table: { select: { id: true, name: true, seats: true } } } },
    },
  });
  const [refs] = await buildRefs(integrationId, [
    { appointment: a.id, patient: a.userId, service: a.service.id, location: a.service.locationId },
  ]);
  return {
    id: a.id,
    status: connectAppointmentStatus(a.status),
    startTime: a.startTime,
    endTime: a.endTime,
    service: { id: a.service.id, name: a.service.name },
    partySize: a.partySize,
    room: a.room ?? null,
    tables: (a.tables ?? []).map((t) => t.table),
    payment: {
      status: a.paymentStatus === 'PAID' || a.paymentStatus === 'PARTIAL_REFUND' ? 'paid' : a.paymentStatus === 'PENDING' ? 'pending' : a.paymentStatus === 'REFUNDED' ? 'refunded' : 'unpaid',
      total: a.amount == null ? null : Number(a.amount),
      paid: a.amountPaid == null ? null : Number(a.amountPaid),
      currency: a.currency,
    },
    refs,
  };
}

/** Creates or updates the Klargy appointment for an EMR appointment. Klargy's
 * reminders go out for it like any other booked appointment. */
async function upsertAppointment(integration: Caller, appointmentRef: string, input: ReturnType<typeof parseAppointment>, retry = true) {
  const service = await resolveService(integration, input.serviceRef);
  const knownId = await klargyIdFor(integration.id, 'appointment', appointmentRef);
  const existing = knownId
    ? await prisma.appointment.findFirst({
        where: { id: knownId, service: { location: { organizationId: integration.organizationId } } },
      })
    : null;
  const { userId } = await upsertPatient(integration, input.patientRef, input.patient);
  const status = klargyStatus(input.status, existing?.status ?? null);
  const data = {
    userId,
    serviceId: service.id,
    startTime: input.startTime,
    endTime: input.endTime,
    status,
    notes: input.notes,
    ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
    ...(input.payment
      ? {
          amount: input.payment.total,
          amountPaid: input.payment.paid,
          currency: input.payment.currency,
          paymentSource: 'EXTERNAL',
          paymentStatus: input.payment.paid && input.payment.paid > 0 ? 'PAID' : 'NONE',
        }
      : {}),
  };

  // Tables and seats: only for a booking that holds them (a cancelled one lets go), and only where the business has them.
  const wantsSeat = input.seating && input.seating.kind !== 'clear' ? input.seating : null;
  if (wantsSeat) await requireTables(integration.organizationId);
  const party = input.partySize ?? existing?.partySize ?? 1;
  const occupying = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN'].includes(status);
  const seatPick = wantsSeat && occupying ? { tableIds: wantsSeat.kind === 'pick' ? wantsSeat.tableIds : null, roomId: wantsSeat.kind === 'auto' ? wantsSeat.roomId : null } : null;
  const seatedNow: { tables: TableRow[] | null } = { tables: null };
  const seatingOf = (id: string) => ({ id, locationId: service.locationId, start: input.startTime, end: input.endTime, slotDuration: service.slotDuration, partySize: party, timeZone: service.location.timezone });

  let appointmentId: string;
  let created = false;
  let actions: QueueAction[] = [];
  if (existing) {
    const moved = existing.startTime.getTime() !== input.startTime.getTime() || existing.serviceId !== service.id;
    const updateData = { ...data, ...(moved ? { rescheduledAt: new Date() } : {}) };
    // A booking that keeps its tables must still fit them after a new time, length or party.
    let pick = seatPick;
    const changedFit = moved || party !== existing.partySize || (input.endTime?.getTime() ?? null) !== (existing.endTime?.getTime() ?? null);
    const otherService = existing.serviceId !== service.id;
    if (!pick && !input.seating && occupying && changedFit && !otherService) {
      const held = await prisma.bookingTable.findMany({ where: { appointmentId: existing.id }, select: { tableId: true } });
      if (held.length) pick = { tableIds: held.map((h) => h.tableId), roomId: null };
    }
    if (pick) {
      try {
        seatedNow.tables = await prisma.$transaction(async (tx) => {
          await tx.appointment.update({ where: { id: existing.id }, data: updateData });
          const tables = await seatExisting(tx, seatingOf(existing.id), pick!);
          await tx.appointment.update({ where: { id: existing.id }, data: { roomId: tables[0]?.roomId ?? null } });
          return tables;
        });
      } catch (error) {
        seatingConflict(error);
      }
    } else {
      await prisma.appointment.update({ where: { id: existing.id }, data: updateData });
      // Asked to let go, or moved to another service (whose location has other tables).
      if (input.seating?.kind === 'clear' || (otherService && !input.seating)) {
        await prisma.bookingTable.deleteMany({ where: { appointmentId: existing.id } });
        await prisma.appointment.update({ where: { id: existing.id }, data: { roomId: null } });
      }
    }
    appointmentId = existing.id;
    if (status === 'CANCELLED' && existing.status !== 'CANCELLED') actions = ['appointment.cancelled'];
    else if (moved && status !== 'CANCELLED') actions = ['appointment.rescheduled'];
  } else {
    let appointment;
    if (seatPick) {
      try {
        appointment = await withTable(
          {
            tableMode: 'AUTO',
            locationId: service.locationId,
            start: input.startTime,
            end: bookingEnd(input.startTime, input.endTime, service.slotDuration),
            partySize: party,
            online: false,
            timeZone: service.location.timezone,
            roomId: seatPick.roomId,
            tableIds: seatPick.tableIds,
          },
          (db, tables) => {
            seatedNow.tables = tables;
            return db.appointment.create({ data: { ...data, slotId: null, createdBy: null, ...tableData(tables, null) } });
          }
        );
      } catch (error) {
        seatingConflict(error);
      }
    } else {
      appointment = await prisma.appointment.create({ data: { ...data, slotId: null, createdBy: null } });
    }
    try {
      if (knownId) {
        // The reference pointed at an appointment that's gone: repoint it.
        await prisma.externalReference.deleteMany({ where: { integrationId: integration.id, resourceType: 'appointment', externalId: appointmentRef } });
      }
      await prisma.externalReference.create({
        data: {
          integrationId: integration.id,
          organizationId: integration.organizationId,
          resourceType: 'appointment',
          resourceId: appointment.id,
          externalId: appointmentRef,
        },
      });
    } catch (error) {
      await prisma.appointment.delete({ where: { id: appointment.id } }).catch(() => {});
      // Another request created it at the same moment: update theirs.
      if (isUniqueViolation(error) && retry) return upsertAppointment(integration, appointmentRef, input, false);
      throw error;
    }
    appointmentId = appointment.id;
    created = true;
    actions = ['appointment.created'];
  }

  for (const action of actions) {
    await recordQueueEvent({
      action,
      origin: ORIGIN.integration(integration.id),
      organizationId: integration.organizationId,
      data: {
        appointmentId,
        patientId: userId,
        serviceId: service.id,
        startTime: input.startTime,
        endTime: input.endTime,
        status: connectAppointmentStatus(status),
        partySize: party,
        ...(seatedNow.tables
          ? { room: seatedNow.tables[0]?.room ? { id: seatedNow.tables[0].room.id, name: seatedNow.tables[0].room.name } : null, tables: seatedNow.tables.map((t) => ({ id: t.id, name: t.name })) }
          : {}),
        ...(input.payment ? { payment: input.payment } : {}),
        ...(action === 'appointment.rescheduled' && existing ? { fromStartTime: existing.startTime } : {}),
      },
      refSubject: { appointment: appointmentId, patient: userId, service: service.id, location: service.locationId },
    });
  }
  return { appointmentId, created };
}

export const putAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    const appointmentRef = text(req.params.appointmentRef, 'appointmentRef')!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { appointmentId, created } = await upsertAppointment(integration, appointmentRef, parseAppointment(body));
    res.status(created ? 201 : 200).json({ appointment: await appointmentView(integration.id, appointmentId) });
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// GET /rooms and GET /rooms/:room/availability
// ---------------------------------------------------------------------------

const money = (v: unknown) => (v == null ? null : Number(v));
const dayList = (days: string | null) => (days ? days.split(',').map(Number) : null);

/**
 * The organisation's rooms with their rules, rates and floor plans, so a
 * reservations or point-of-sale system can seat people on the same tables.
 * Tables are left out for kinds of business that don't use them.
 */
export const listRooms = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    const locationRef = text(req.query.location, 'location', false);
    const location = locationRef ? await resolveLocation(integration, locationRef) : null;
    const org = await prisma.organization.findUnique({ where: { id: integration.organizationId }, select: { industry: true } });
    const tablesAvailable = industryFeatures(org?.industry).tables;
    const rooms = await prisma.room.findMany({
      where: { location: { organizationId: integration.organizationId }, ...(location ? { locationId: location.id } : {}) },
      include: { location: { select: { id: true, name: true } }, tables: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
      orderBy: [{ locationId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({
      tablesAvailable,
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        active: r.isActive,
        location: r.location,
        onlineBookable: r.onlineBookable,
        partySize: { min: r.minPartySize, max: r.maxPartySize },
        hours: { open: r.openTime, close: r.closeTime, days: dayList(r.activeDays) },
        allowCombine: r.allowCombine,
        rate: { mode: r.priceMode, price: money(r.price), basis: r.priceBasis },
        plan: { width: r.layoutWidth, height: r.layoutHeight, imageUrl: r.layoutImageUrl },
        tables: tablesAvailable
          ? r.tables.map((t) => ({ id: t.id, name: t.name, seats: t.seats, active: t.isActive, x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation, shape: t.shape }))
          : [],
      })),
    });
  } catch (error) {
    handle(error, res, next);
  }
};

/** Which of a room's tables are free for a booking from `start` (to `end`, else an hour and a half). */
export const getRoomAvailability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    await requireTables(integration.organizationId);
    const start = isoTime(req.query.start, 'start', true)!;
    const end = isoTime(req.query.end, 'end', false) ?? new Date(start.getTime() + 90 * 60_000);
    if (end <= start) throw badRequest('end must be after start');
    const party = parsePartySize(req.query.partySize) ?? 1;
    const room = await prisma.room.findFirst({
      where: { id: text(req.params.room, 'room')!, location: { organizationId: integration.organizationId } },
      select: { id: true, location: { select: { timezone: true } } },
    });
    if (!room) throw new ConnectError('No such room', 404, 'ROOM_NOT_FOUND');
    const map = await seatMap(room.id, { start, end, partySize: party, online: false, timeZone: room.location.timezone });
    if (!map) throw new ConnectError('No such room', 404, 'ROOM_NOT_FOUND');
    res.json({
      room: { id: map.room.id, name: map.room.name, plan: { width: map.room.layoutWidth, height: map.room.layoutHeight, imageUrl: map.room.layoutImageUrl } },
      start,
      end,
      partySize: party,
      tables: map.tables.map((t) => ({ id: t.id, name: t.name, seats: t.seats, x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation, shape: t.shape, status: t.status })),
    });
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// GET /analytics
// ---------------------------------------------------------------------------

async function resolveLocation(integration: Caller, value: string) {
  const mapped = await klargyIdFor(integration.id, 'location', value);
  const location = await prisma.location.findFirst({
    where: { id: mapped ?? value, organizationId: integration.organizationId },
    select: { id: true, timezone: true },
  });
  if (!location) throw new ConnectError('That location isn’t matched to a Klargy location', 404, 'LOCATION_NOT_MAPPED');
  return location;
}

type Summary = Awaited<ReturnType<typeof summaryBetween>>['overall'];

const counters = (s: Summary) => ({
  joined: s.joined,
  served: s.served,
  noShows: s.noShows,
  cancelled: s.cancelled,
  noShowRatePct: s.noShowRatePct,
  avgWaitMinutes: s.waitMinutes.avg,
  medianWaitMinutes: s.waitMinutes.median,
  p90WaitMinutes: s.waitMinutes.p90,
  avgServiceMinutes: s.serviceMinutes.avg,
});

export const getAnalytics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    const locationRef = text(req.query.location, 'location', false);
    const serviceRef = text(req.query.service, 'service', false);
    const service = serviceRef ? await resolveService(integration, serviceRef) : null;
    const location = locationRef ? await resolveLocation(integration, locationRef) : null;
    if (service && location && service.locationId !== location.id) {
      throw badRequest('That service isn’t at that location');
    }

    // Days are the location's days.
    const locations = await prisma.location.findMany({
      where: { organizationId: integration.organizationId, ...(service ? { id: service.locationId } : location ? { id: location.id } : {}) },
      select: { id: true, timezone: true },
      orderBy: { createdAt: 'asc' },
    });
    const tz = validTimeZone(locations[0]?.timezone);

    const now = new Date();
    let from = isoTime(req.query.from, 'from', false);
    let to = isoTime(req.query.to, 'to', false);
    if (!from && !to) {
      from = getStartOfDay(now, tz);
      to = getEndOfDay(now, tz);
    } else if (!from) {
      from = getStartOfDay(to!, tz);
    } else if (!to) {
      to = now;
    }
    if (from! > to!) throw badRequest('from must be before to');
    if (to!.getTime() - from!.getTime() > MAX_RANGE_DAYS * 86400000) {
      throw badRequest(`The range can be at most ${MAX_RANGE_DAYS} days`);
    }

    const scope = {
      organizationId: integration.organizationId,
      ...(location ? { locationId: location.id } : {}),
      ...(service ? { serviceId: service.id } : {}),
    };
    const summary = await summaryBetween(scope, from!, to!);

    // Live numbers come from each location's queues for its own today.
    const live = { waiting: 0, serving: 0, longestWaitMinutes: 0 };
    for (const l of locations) {
      const status = await liveStatus({ ...scope, locationId: l.id }, validTimeZone(l.timezone));
      for (const s of status.services) {
        live.waiting += s.waiting;
        live.serving += s.beingServed;
        live.longestWaitMinutes = Math.max(live.longestWaitMinutes, s.longestCurrentWaitMinutes);
      }
    }

    const refs = await buildRefs(integration.id, summary.perService.map((s) => ({ service: s.serviceId })));
    res.json({
      from: from!.toISOString(),
      to: to!.toISOString(),
      overall: counters(summary.overall),
      live,
      services: summary.perService.map((s, i) => ({
        id: s.serviceId,
        ref: refs[i].service ?? null,
        name: s.service,
        ...counters(s),
      })),
    });
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// POST /services/:service/status
// ---------------------------------------------------------------------------

const SERVICE_STATUSES = ['PAUSED', 'ACTIVE'] as const;

/** Pauses or resumes today's queue for a service. Patients waiting hear
 * about a pause once. */
export const postServiceStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    const service = await resolveService(integration, text(req.params.service, 'service')!);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const status = body.status as (typeof SERVICE_STATUSES)[number];
    if (!SERVICE_STATUSES.includes(status)) throw badRequest(`status must be one of: ${SERVICE_STATUSES.join(', ')}`);
    const reason = text(body.reason, 'reason', false) ?? null;
    if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') {
      throw badRequest('message must be a string');
    }
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;
    if (message && message.length > MAX_MESSAGE) throw badRequest(`message must be at most ${MAX_MESSAGE} characters`);

    const today = await getOrCreateQueueForDate(service.id);
    if (!today) throw new ConnectError('That service isn’t matched to a Klargy service', 404, 'SERVICE_NOT_MAPPED');
    const { changed } = await setQueueStatus(today.queue.id, status, {
      origin: ORIGIN.integration(integration.id),
      reason,
      message,
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { id: today.queue.id }, select: { status: true } });
    const [refs] = await buildRefs(integration.id, [{ service: service.id, location: service.locationId }]);
    res.json({
      queueId: today.queue.id,
      status: queue.status,
      changed,
      service: { id: service.id, name: service.name },
      location: { id: service.location.id, name: service.location.name },
      refs,
    });
  } catch (error) {
    handle(error, res, next);
  }
};
