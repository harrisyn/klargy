import { BookingError } from './bookingError';
import prisma from '../lib/prisma';
import { emitToQueue, SOCKET_EVENTS } from '../lib/realtime';
import { getStartOfDay, isDayActive, startOfLocalDate } from '../utils/date';
import { serviceTimeZone, getOrCreateQueueForDate, recordQueueEvent, startJourney, afterQueueChange } from './queueEvents.service';
import { bookedArrivalSettings, bookedFields } from './bookedArrival.service';
import { bookingEnd, slotsWithTable, withTable } from './tables.service';
import { roomRefusal } from './rooms.service';
import { generateTicketNumber, getNextSequence } from '../utils/ticket';

/**
 * Appointment booking rules shared by the front desk (appointment.controller)
 * and customers booking on the public page (publicBooking.controller).
 */

// Appointment.status is a plain string column.
export const ACTIVE_STATUSES = ['SCHEDULED', 'CONFIRMED'];
/** A booking that holds its place: confirmed, or waiting for its payment. */
export const HOLD_STATUSES = [...ACTIVE_STATUSES, 'PENDING_PAYMENT'];

/** How many places of a slot a booking uses: its people for seat-based services, else one. */
export const unitsOf = (a: { partySize?: number | null }, service: { bookingUnit?: string | null; tableMode?: string | null }) =>
  // With tables the table is what runs out, not the slot's places.
  service.tableMode === 'AUTO' ? 0 : service.bookingUnit === 'PERSON' ? Math.max(1, a.partySize ?? 1) : 1;

export const appointmentInclude = {
  user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  service: { include: { location: true } },
  slot: true,
  tables: { select: { table: { select: { id: true, name: true, seats: true, area: true } } } },
  room: { select: { id: true, name: true } },
} as const;

export { BookingError };

/** Claims one place in a slot without overbooking under concurrent requests. */
export async function claimSlot(slotId: string, units = 1): Promise<boolean> {
  const slot = await prisma.slot.findUnique({ where: { id: slotId }, select: { capacity: true } });
  if (!slot || units > slot.capacity) return false;
  const { count } = await prisma.slot.updateMany({
    where: { id: slotId, bookedCount: { lte: slot.capacity - units } },
    data: { bookedCount: { increment: units } },
  });
  return count > 0;
}

export async function releaseSlot(slotId: string, units = 1) {
  const { count } = await prisma.slot.updateMany({ where: { id: slotId, bookedCount: { gte: units } }, data: { bookedCount: { decrement: units } } });
  // Counts drifted below what is being released: never go negative.
  if (count === 0) await prisma.slot.updateMany({ where: { id: slotId, bookedCount: { gt: 0 } }, data: { bookedCount: 0 } });
}

export interface SlotsResult {
  queueId?: string;
  date?: Date;
  slots: { id: string; startTime: Date; endTime: Date; available: number; capacity: number; label: string | null; price: number | null; isSession: boolean }[];
  message?: string;
}

/** Open places in a service's day. Creates that day's queue on demand, so future dates are bookable before anyone has joined. */
export interface SlotOptions {
  /** How many people; only matters for services with tables. */
  partySize?: number;
  /** Only tables in this room. */
  roomId?: string | null;
  /** The public page rather than the front desk. */
  online?: boolean;
}

export async function availableSlots(serviceId: string, date?: string, opts: SlotOptions = {}): Promise<SlotsResult> {
  const tz = await serviceTimeZone(serviceId);
  if (date && !/^\d{4}-\d{2}-\d{2}/.test(date)) throw new BookingError('Invalid date');
  const startOfDay = date ? startOfLocalDate(date, tz) : getStartOfDay(new Date(), tz);
  if (Number.isNaN(startOfDay.getTime())) throw new BookingError('Invalid date');
  if (startOfDay < getStartOfDay(new Date(), tz)) return { slots: [], message: 'That date has already passed' };

  const service = await prisma.service.findUnique({ where: { id: serviceId }, include: { room: true, location: { select: { timezone: true } } } });
  if (!service || !service.isActive) return { slots: [], message: 'This service is not active' };
  // A closed day offers only sessions staff made for it.
  const open = isDayActive(startOfDay, service.activeDays, tz);

  const created = await getOrCreateQueueForDate(serviceId, startOfDay);
  if (!created) return { slots: [], message: 'No queue available for this date' };

  let slots = await prisma.slot.findMany({
    where: { queueId: created.queue.id, startTime: { gte: new Date() }, ...(open ? {} : { isSession: true }) },
    orderBy: { startTime: 'asc' },
  });
  const party = Math.max(1, Math.floor(opts.partySize ?? 1));
  if (service.tableMode === 'AUTO') {
    // Only times a table is free for this party, under its room's rules.
    const ok = await slotsWithTable(service.locationId, slots, { partySize: party, online: !!opts.online, timeZone: service.location.timezone, roomId: opts.roomId });
    slots = slots.filter((s) => ok.has(s.id));
  } else if (service.room) {
    // Delivered in a room: its hours, days and who may book still apply.
    slots = slots.filter((s) => !roomRefusal(service.room!, { start: s.startTime, partySize: party, online: !!opts.online, timeZone: service.location.timezone }));
  }
  if (!open && slots.length === 0) return { slots: [], message: `${service.name} isn't open on this day` };
  return {
    queueId: created.queue.id,
    date: startOfDay,
    slots: slots.map((slot) => ({
      id: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      // With tables a listed time has room for the party asked about.
      available: service.tableMode === 'AUTO' ? party : Math.max(0, slot.capacity - slot.bookedCount),
      capacity: service.tableMode === 'AUTO' ? party : slot.capacity,
      label: slot.label,
      price: slot.price == null ? null : Number(slot.price),
      isSession: slot.isSession,
    })),
  };
}

/** Moves an active appointment to another slot of the same service. */
export async function rescheduleAppointmentCore(id: string, newSlotId: string, actorUserId: string | null, opts: { online?: boolean } = {}) {
  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: { slot: true, tables: { select: { tableId: true } }, service: { include: { location: { select: { timezone: true } } } } },
  });
  if (!appointment) throw new BookingError('Appointment not found', 404);
  if (!ACTIVE_STATUSES.includes(appointment.status)) {
    throw new BookingError(`A ${appointment.status.toLowerCase().replace('_', ' ')} appointment can't be rescheduled`);
  }
  const units = unitsOf(appointment, appointment.service);
  if (newSlotId === appointment.slotId) throw new BookingError('That is the current slot');

  const newSlot = await prisma.slot.findUnique({ where: { id: newSlotId }, include: { queue: true } });
  if (!newSlot || newSlot.queue.serviceId !== appointment.serviceId) {
    throw new BookingError('New slot not found for this service', 404);
  }
  if (newSlot.startTime < new Date()) throw new BookingError('That time has already passed');
  if (!(await claimSlot(newSlotId, units))) throw new BookingError('New slot is fully booked');

  let updated;
  try {
    updated = await withTable(
      {
        tableMode: appointment.service.tableMode,
        locationId: appointment.service.locationId,
        start: newSlot.startTime,
        end: bookingEnd(newSlot.startTime, newSlot.endTime, appointment.service.slotDuration),
        partySize: appointment.partySize,
        online: !!opts.online,
        timeZone: appointment.service.location.timezone,
        // Keep to the room they are already in.
        roomId: appointment.tables.length ? appointment.roomId : null,
        excludeAppointmentId: id,
      },
      (db, tables) =>
        db.appointment.update({
          where: { id },
          data: {
            slotId: newSlotId,
            startTime: newSlot.startTime,
            endTime: newSlot.endTime,
            rescheduledAt: new Date(),
            ...(tables.length ? { roomId: tables[0].roomId ?? appointment.service.roomId, tables: { deleteMany: {}, create: tables.map((t) => ({ tableId: t.id })) } } : {}),
          },
          include: appointmentInclude,
        })
    );
  } catch (error) {
    await releaseSlot(newSlotId, units);
    throw error;
  }
  if (appointment.slot) {
    await releaseSlot(appointment.slot.id, units);
    emitToQueue(appointment.slot.queueId, SOCKET_EVENTS.SLOT_RELEASED, { slotId: appointment.slot.id });
  }
  await recordQueueEvent({
    action: 'appointment.rescheduled',
    actorUserId,
    queueId: newSlot.queueId,
    data: { appointmentId: id, fromSlotStart: appointment.startTime, toSlotStart: newSlot.startTime },
  });
  return updated;
}

/** Cancels an active appointment and frees its place. */
export async function cancelAppointmentCore(id: string, actorUserId: string | null) {
  const appointment = await prisma.appointment.findUnique({ where: { id }, include: { slot: true, service: { select: { bookingUnit: true, tableMode: true } } } });
  if (!appointment) throw new BookingError('Appointment not found', 404);

  // Only an active appointment holds a slot place; cancelling twice must
  // not free the place twice.
  const { count } = await prisma.appointment.updateMany({
    where: { id, status: { in: HOLD_STATUSES } },
    data: { status: 'CANCELLED' },
  });
  if (count === 0) throw new BookingError(`This appointment is already ${appointment.status.toLowerCase().replace('_', ' ')}`);
  if (appointment.slot) {
    await releaseSlot(appointment.slot.id, unitsOf(appointment, appointment.service));
    emitToQueue(appointment.slot.queueId, SOCKET_EVENTS.SLOT_RELEASED, { slotId: appointment.slot.id });
  }
  const organizationId = (
    await prisma.service.findUnique({ where: { id: appointment.serviceId }, select: { location: { select: { organizationId: true } } } })
  )?.location.organizationId;
  await recordQueueEvent({
    action: 'appointment.cancelled',
    actorUserId,
    queueId: appointment.slot?.queueId ?? null,
    organizationId,
    data: { appointmentId: id, slotStart: appointment.startTime, patientId: appointment.userId },
  });
  return prisma.appointment.findUnique({ where: { id }, include: appointmentInclude });
}

/** Turns a same-day appointment into a queue entry (the person has arrived). */
export async function checkInAppointmentCore(id: string, actorUserId: string | null) {
  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: { slot: { include: { queue: { include: { service: true } } } }, service: true },
  });
  if (!appointment) throw new BookingError('Appointment not found', 404);
  if (!ACTIVE_STATUSES.includes(appointment.status)) throw new BookingError('This appointment can no longer be checked in');

  // An appointment booked in a connected EMR has no slot: it checks in to
  // its service's queue for the day of the appointment.
  const queue = appointment.slot?.queue ?? (await getOrCreateQueueForDate(appointment.serviceId, appointment.startTime))?.queue;
  if (!queue) throw new BookingError('Appointment not found', 404);
  const service = appointment.slot?.queue.service ?? appointment.service;
  const tz = await serviceTimeZone(queue.serviceId);
  if (getStartOfDay(queue.date, tz).getTime() !== getStartOfDay(new Date(), tz).getTime()) {
    throw new BookingError('Check-in opens on the day of the appointment');
  }
  if (queue.status !== 'ACTIVE') throw new BookingError('This queue isn’t taking anyone right now');

  const { count } = await prisma.appointment.updateMany({
    where: { id, status: { in: ACTIVE_STATUSES } },
    data: { status: 'CHECKED_IN' },
  });
  if (count === 0) throw new BookingError('This appointment was already checked in');

  const sequence = await getNextSequence(prisma, queue.id);
  const ticketNumber = generateTicketNumber(service.name.charAt(0).toUpperCase(), sequence);
  const lastEntry = await prisma.queueEntry.findFirst({ where: { queueId: queue.id }, orderBy: { sortOrder: 'desc' } });
  const organizationId = (
    await prisma.service.findUnique({ where: { id: queue.serviceId }, select: { location: { select: { organizationId: true } } } })
  )?.location.organizationId;
  const settings = organizationId ? await bookedArrivalSettings(organizationId) : null;

  const entry = await prisma.queueEntry.create({
    data: {
      queueId: queue.id,
      userId: appointment.userId,
      ticketNumber,
      // Booked customers arriving on time are placed by their booked time
      // among walk-ins (queueOrder.ts); late ones join as walk-ins. With
      // that setting off, booked customers go ahead of walk-ins as before.
      priority: settings?.enabled ? 0 : 1,
      sortOrder: (lastEntry?.sortOrder || 0) + 1,
      notes: 'Appointment check-in',
      ...(settings ? bookedFields(appointment, settings) : {}),
    },
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
  });

  emitToQueue(queue.id, SOCKET_EVENTS.QUEUE_UPDATED, { queueId: queue.id, action: 'appointment_checkin', entry });
  await startJourney(entry.id);
  await recordQueueEvent({
    action: 'appointment.checked_in',
    actorUserId,
    queueId: queue.id,
    entryId: entry.id,
    data: { appointmentId: id },
  });
  await afterQueueChange(queue.id);

  return { entry, ticketNumber, serviceName: service.name, queueId: queue.id };
}
