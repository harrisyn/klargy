import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { emitToQueue, SOCKET_EVENTS } from '../lib/realtime';
import { getStartOfDay, getEndOfDay, isDayActive, startOfLocalDate, validTimeZone } from '../utils/date';
import { serviceTimeZone } from '../services/queueEvents.service';
import { bookedArrivalSettings, bookedFields } from '../services/bookedArrival.service';
import { generateTicketNumber, getNextSequence } from '../utils/ticket';
import { listScopeOrgId, loadCaller } from '../middleware/tenantScope.middleware';
import {
  recordQueueEvent,
  startJourney,
  afterQueueChange,
  getOrCreateQueueForDate,
} from '../services/queueEvents.service';

// Appointment.status is a plain string column.
const ACTIVE_STATUSES = ['SCHEDULED', 'CONFIRMED'];

const actorId = (req: Request) => req.user?.userId ?? null;

const appointmentInclude = {
  user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  service: { include: { location: true } },
  slot: true,
} as const;

/** Claims one place in a slot without overbooking under concurrent requests. */
async function claimSlot(slotId: string): Promise<boolean> {
  const slot = await prisma.slot.findUnique({ where: { id: slotId }, select: { capacity: true } });
  if (!slot) return false;
  const { count } = await prisma.slot.updateMany({
    where: { id: slotId, bookedCount: { lt: slot.capacity } },
    data: { bookedCount: { increment: 1 } },
  });
  return count > 0;
}

async function releaseSlot(slotId: string) {
  await prisma.slot.updateMany({ where: { id: slotId, bookedCount: { gt: 0 } }, data: { bookedCount: { decrement: 1 } } });
}

/**
 * Books an appointment. Reception either picks an existing patient
 * (`userId`) or registers a new one inline (`patient`).
 */
export const createAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, serviceId, slotId, notes, patient } = req.body;
    const caller = await loadCaller(req);
    if (!caller) return res.status(401).json({ error: 'Authentication required' });
    if (!serviceId || !slotId) return res.status(400).json({ error: 'serviceId and slotId are required' });

    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { queue: { include: { service: { include: { location: true } } } } },
    });
    if (!slot || slot.queue.serviceId !== serviceId) {
      return res.status(404).json({ error: 'Slot not found for this service' });
    }
    if (slot.startTime < new Date()) {
      return res.status(400).json({ error: 'That time has already passed' });
    }
    const organizationId = slot.queue.service.location.organizationId;

    let patientId: string | undefined = userId;
    if (!patientId) {
      if (!patient?.firstName || !patient?.lastName) {
        return res.status(400).json({ error: 'Choose someone from the list, or enter their first and last name' });
      }
      const created = await prisma.user.create({
        data: {
          // Patients booked by reception can't log in; the address only has
          // to be unique. Same scheme as walk-in guests.
          email: patient.email?.trim().toLowerCase() ||
            `guest_${Date.now()}_${Math.random().toString(36).slice(2, 11)}@guest.qms.local`,
          password: '',
          firstName: patient.firstName.trim(),
          lastName: patient.lastName.trim(),
          phone: patient.phone?.trim() || null,
          role: 'PATIENT',
          organizationId,
        },
      });
      patientId = created.id;
    }

    const existing = await prisma.appointment.findFirst({
      where: { userId: patientId, slotId, status: { in: ACTIVE_STATUSES } },
    });
    if (existing) {
      return res.status(400).json({ error: 'They already have an appointment in that slot' });
    }

    if (!(await claimSlot(slotId))) {
      return res.status(400).json({ error: 'That slot is fully booked' });
    }

    const appointment = await prisma.appointment.create({
      data: {
        userId: patientId,
        serviceId,
        slotId,
        startTime: slot.startTime,
        endTime: slot.endTime,
        createdBy: caller.id,
        notes: notes || null,
      },
      include: appointmentInclude,
    });

    await recordQueueEvent({
      action: 'appointment.created',
      actorUserId: caller.id,
      queueId: slot.queueId,
      organizationId,
      data: { appointmentId: appointment.id, slotStart: slot.startTime, patientId },
    });

    res.status(201).json(appointment);
  } catch (error) {
    next(error);
  }
};

export const getAppointments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, serviceId, locationId, date, status } = req.query;

    const whereClause: any = {};
    const scopedOrgId = await listScopeOrgId(req);
    const serviceFilter: any = {};
    if (scopedOrgId) serviceFilter.location = { organizationId: scopedOrgId };
    if (locationId) serviceFilter.locationId = locationId as string;
    if (Object.keys(serviceFilter).length) whereClause.service = serviceFilter;

    if (userId) whereClause.userId = userId as string;
    if (serviceId) whereClause.serviceId = serviceId as string;
    if (status) whereClause.status = status as string;
    if (date) {
      // "That day" is the location's day.
      const tz = locationId
        ? validTimeZone((await prisma.location.findUnique({ where: { id: locationId as string }, select: { timezone: true } }))?.timezone)
        : serviceId ? await serviceTimeZone(serviceId as string) : undefined;
      const day = startOfLocalDate(String(date), tz);
      whereClause.startTime = { gte: day, lte: getEndOfDay(day, tz) };
    }

    const appointments = await prisma.appointment.findMany({
      where: whereClause,
      include: appointmentInclude,
      orderBy: { startTime: 'asc' },
      take: 500,
    });

    res.json(appointments);
  } catch (error) {
    next(error);
  }
};

export const getAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: appointmentInclude,
    });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    res.json(appointment);
  } catch (error) {
    next(error);
  }
};

export const getUserAppointments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { upcoming } = req.query;

    const whereClause: any = { userId };
    if (upcoming === 'true') {
      whereClause.startTime = { gte: new Date() };
      whereClause.status = { in: ACTIVE_STATUSES };
    }

    const appointments = await prisma.appointment.findMany({
      where: whereClause,
      include: appointmentInclude,
      orderBy: { startTime: 'asc' },
    });

    res.json(appointments);
  } catch (error) {
    next(error);
  }
};

export const rescheduleAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { newSlotId } = req.body;

    const appointment = await prisma.appointment.findUnique({ where: { id }, include: { slot: true } });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (!ACTIVE_STATUSES.includes(appointment.status)) {
      return res.status(400).json({ error: `A ${appointment.status.toLowerCase()} appointment can't be rescheduled` });
    }
    if (newSlotId === appointment.slotId) return res.status(400).json({ error: 'That is the current slot' });

    const newSlot = await prisma.slot.findUnique({ where: { id: newSlotId }, include: { queue: true } });
    if (!newSlot || newSlot.queue.serviceId !== appointment.serviceId) {
      return res.status(404).json({ error: 'New slot not found for this service' });
    }
    if (newSlot.startTime < new Date()) return res.status(400).json({ error: 'That time has already passed' });
    if (!(await claimSlot(newSlotId))) return res.status(400).json({ error: 'New slot is fully booked' });

    const updated = await prisma.appointment.update({
      where: { id },
      data: { slotId: newSlotId, startTime: newSlot.startTime, endTime: newSlot.endTime, rescheduledAt: new Date() },
      include: appointmentInclude,
    });
    if (appointment.slot) {
      await releaseSlot(appointment.slot.id);
      emitToQueue(appointment.slot.queueId, SOCKET_EVENTS.SLOT_RELEASED, { slotId: appointment.slot.id });
    }
    await recordQueueEvent({
      action: 'appointment.rescheduled',
      actorUserId: actorId(req),
      queueId: newSlot.queueId,
      data: { appointmentId: id, fromSlotStart: appointment.startTime, toSlotStart: newSlot.startTime },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const cancelAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const appointment = await prisma.appointment.findUnique({ where: { id }, include: { slot: true } });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    // Only an active appointment holds a slot place; cancelling twice must
    // not free the place twice.
    const { count } = await prisma.appointment.updateMany({
      where: { id, status: { in: ACTIVE_STATUSES } },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) {
      return res.status(400).json({ error: `This appointment is already ${appointment.status.toLowerCase()}` });
    }
    if (appointment.slot) {
      await releaseSlot(appointment.slot.id);
      emitToQueue(appointment.slot.queueId, SOCKET_EVENTS.SLOT_RELEASED, { slotId: appointment.slot.id });
    }
    const organizationId = (await prisma.service.findUnique({
      where: { id: appointment.serviceId },
      select: { location: { select: { organizationId: true } } },
    }))?.location.organizationId;
    await recordQueueEvent({
      action: 'appointment.cancelled',
      actorUserId: actorId(req),
      queueId: appointment.slot?.queueId ?? null,
      organizationId,
      data: { appointmentId: id, slotStart: appointment.startTime, patientId: appointment.userId },
    });

    res.json(await prisma.appointment.findUnique({ where: { id }, include: appointmentInclude }));
  } catch (error) {
    next(error);
  }
};

// Check-in: turns a same-day appointment into a (priority) queue entry.
export const checkInAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { slot: { include: { queue: { include: { service: true } } } }, service: true },
    });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (!ACTIVE_STATUSES.includes(appointment.status)) {
      return res.status(400).json({ error: 'This appointment can no longer be checked in' });
    }

    // An appointment booked in a connected EMR has no slot: it checks in to
    // its service's queue for the day of the appointment.
    const queue = appointment.slot?.queue ?? (await getOrCreateQueueForDate(appointment.serviceId, appointment.startTime))?.queue;
    if (!queue) return res.status(404).json({ error: 'Appointment not found' });
    const service = appointment.slot?.queue.service ?? appointment.service;
    const tz = await serviceTimeZone(queue.serviceId);
    if (getStartOfDay(queue.date, tz).getTime() !== getStartOfDay(new Date(), tz).getTime()) {
      return res.status(400).json({ error: 'Check-in opens on the day of the appointment' });
    }
    if (queue.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'This queue isn’t taking anyone right now' });
    }

    const { count } = await prisma.appointment.updateMany({
      where: { id, status: { in: ACTIVE_STATUSES } },
      data: { status: 'CHECKED_IN' },
    });
    if (count === 0) return res.status(400).json({ error: 'This appointment was already checked in' });

    const sequence = await getNextSequence(prisma, queue.id);
    const ticketNumber = generateTicketNumber(service.name.charAt(0).toUpperCase(), sequence);
    const lastEntry = await prisma.queueEntry.findFirst({ where: { queueId: queue.id }, orderBy: { sortOrder: 'desc' } });
    const organizationId = (await prisma.service.findUnique({
      where: { id: queue.serviceId },
      select: { location: { select: { organizationId: true } } },
    }))?.location.organizationId;
    const settings = organizationId ? await bookedArrivalSettings(organizationId) : null;

    const entry = await prisma.queueEntry.create({
      data: {
        queueId: queue.id,
        userId: appointment.userId,
        ticketNumber,
        // Booked patients arriving on time are placed by their booked time
        // among walk-ins (queueOrder.ts); late ones join as walk-ins. With
        // that setting off, booked patients go ahead of walk-ins as before.
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
      actorUserId: actorId(req),
      queueId: queue.id,
      entryId: entry.id,
      data: { appointmentId: id },
    });
    await afterQueueChange(queue.id);

    res.json({ entry, ticketNumber, serviceName: service.name, queueId: queue.id });
  } catch (error) {
    next(error);
  }
};

// Available slots for a service on a date. Creates that day's queue on
// demand, so future dates are bookable before anyone has joined.
export const getAvailableSlots = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;
    const { date } = req.query;

    const tz = await serviceTimeZone(serviceId);
    if (date && !/^\d{4}-\d{2}-\d{2}/.test(String(date))) return res.status(400).json({ error: 'Invalid date' });
    const startOfDay = date ? startOfLocalDate(String(date), tz) : getStartOfDay(new Date(), tz);
    if (Number.isNaN(startOfDay.getTime())) return res.status(400).json({ error: 'Invalid date' });
    if (startOfDay < getStartOfDay(new Date(), tz)) {
      return res.json({ slots: [], message: 'That date has already passed' });
    }

    const service = await prisma.service.findUnique({ where: { id: serviceId } });
    if (!service || !service.isActive) return res.json({ slots: [], message: 'This service is not active' });
    if (!isDayActive(startOfDay, service.activeDays, tz)) {
      return res.json({ slots: [], message: `${service.name} isn't open on this day` });
    }

    const created = await getOrCreateQueueForDate(serviceId, startOfDay);
    if (!created) return res.json({ slots: [], message: 'No queue available for this date' });

    const slots = await prisma.slot.findMany({
      where: { queueId: created.queue.id, startTime: { gte: new Date() } },
      orderBy: { startTime: 'asc' },
    });

    res.json({
      queueId: created.queue.id,
      date: startOfDay,
      slots: slots.map((slot) => ({
        id: slot.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        available: Math.max(0, slot.capacity - slot.bookedCount),
        capacity: slot.capacity,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// Reception patient lookup (name, phone or email), scoped to the caller's org.
export const searchPatients = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const organizationId = await listScopeOrgId(req);

    const patients = await prisma.user.findMany({
      where: {
        role: 'PATIENT',
        ...(organizationId ? { organizationId } : {}),
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, phone: true, email: true, identityData: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    res.json(
      patients.map((p) => ({ ...p, email: p.email.endsWith('@guest.qms.local') ? null : p.email }))
    );
  } catch (error) {
    next(error);
  }
};
