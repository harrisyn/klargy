import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { getEndOfDay, startOfLocalDate, validTimeZone } from '../utils/date';
import { serviceTimeZone } from '../services/queueEvents.service';
import { listScopeOrgId, loadCaller } from '../middleware/tenantScope.middleware';
import {
  ACTIVE_STATUSES,
  BookingError,
  appointmentInclude,
  availableSlots,
  cancelAppointmentCore,
  checkInAppointmentCore,
  claimSlot,
  releaseSlot,
  rescheduleAppointmentCore,
  unitsOf,
} from '../services/booking.service';
import { refundBooking } from '../services/bookingPayments/bookingPayments.service';
import { PriceChangeError, bookingEnd, reassignTables, tableData, withTable } from '../services/tables.service';
import { recordQueueEvent } from '../services/queueEvents.service';

const actorId = (req: Request) => req.user?.userId ?? null;

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
    // Seat-based services take a party size; the front desk can book any size up to the slot's room.
    const svc = slot.queue.service;
    const partySize = svc.bookingUnit === 'PERSON' ? Math.max(1, Math.floor(Number(req.body.partySize ?? 1)) || 1) : 1;
    const units = unitsOf({ partySize }, svc);

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

    if (!(await claimSlot(slotId, units))) {
      return res.status(400).json({ error: units > 1 ? 'There isn’t room for that many in that slot' : 'That slot is fully booked' });
    }

    // With tables the booking is given one (or the ones the host picked) and created in one step.
    let appointment;
    try {
      appointment = await withTable(
        {
          tableMode: svc.tableMode,
          locationId: svc.locationId,
          start: slot.startTime,
          end: bookingEnd(slot.startTime, slot.endTime, svc.slotDuration),
          partySize,
          online: false,
          timeZone: svc.location.timezone,
          roomId: typeof req.body.roomId === 'string' ? req.body.roomId : null,
          tableIds: Array.isArray(req.body.tableIds) ? req.body.tableIds.filter((v: unknown): v is string => typeof v === 'string') : null,
        },
        (db, tables) =>
          db.appointment.create({
            data: {
              userId: patientId!,
              serviceId,
              slotId,
              startTime: slot.startTime,
              endTime: slot.endTime,
              createdBy: caller.id,
              partySize,
              notes: notes || null,
              ...tableData(tables, svc.roomId),
            },
            include: appointmentInclude,
          })
      );
    } catch (error) {
      await releaseSlot(slotId, units);
      throw error;
    }

    await recordQueueEvent({
      action: 'appointment.created',
      actorUserId: caller.id,
      queueId: slot.queueId,
      organizationId,
      data: { appointmentId: appointment.id, slotStart: slot.startTime, patientId, partySize },
    });

    res.status(201).json(appointment);
  } catch (error) {
    next(error);
  }
};

/**
 * Staff move a booking to other tables or seats (or take them off). A move into
 * a room with a different rate changes the price: without `confirmPrice` the
 * answer is a 409 saying what it would become; with it, an overpayment is
 * refunded and a balance is shown on the booking.
 */
export const setAppointmentTables = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tableIds: string[] = Array.isArray(req.body?.tableIds) ? req.body.tableIds.filter((v: unknown): v is string => typeof v === 'string') : [];
    const moved = await reassignTables(req.params.id, tableIds, { confirmPrice: req.body?.confirmPrice === true });
    const change = moved.priceChange;
    if (change && (change.diff < 0 || change.refund > 0)) {
      // The new price is recorded first, so a refund that fails leaves the booking visibly overpaid and a second move settles it.
      await prisma.appointment.update({ where: { id: req.params.id }, data: { amount: change.to } });
      if (change.refund > 0) {
        try {
          await refundBooking(req.params.id, { policy: 'AMOUNT', amount: change.refund });
        } catch (error) {
          const why = error instanceof BookingError ? ` ${error.message}` : '';
          throw new BookingError(`They’ve been moved, but the ${change.refund.toFixed(2)} refund didn’t go through.${why} Move them again to retry it.`, 502);
        }
      }
    }
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: appointmentInclude });
    res.json({ ...appointment, priceChange: change });
  } catch (error) {
    if (error instanceof PriceChangeError) return res.status(409).json({ error: error.message, priceChange: error.change });
    sendBookingError(error, res, next);
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

const sendBookingError = (error: unknown, res: Response, next: NextFunction) =>
  error instanceof BookingError ? res.status(error.status).json({ error: error.message }) : next(error);

export const rescheduleAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await rescheduleAppointmentCore(req.params.id, req.body.newSlotId, actorId(req)));
  } catch (error) {
    sendBookingError(error, res, next);
  }
};

export const cancelAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // A paid online booking cancelled by staff is refunded in full; if the refund fails it stays booked.
    await refundBooking(req.params.id, { policy: 'FULL' });
    res.json(await cancelAppointmentCore(req.params.id, actorId(req)));
  } catch (error) {
    sendBookingError(error, res, next);
  }
};

// Check-in: turns a same-day appointment into a (priority) queue entry.
export const checkInAppointment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await checkInAppointmentCore(req.params.id, actorId(req)));
  } catch (error) {
    sendBookingError(error, res, next);
  }
};

// Available slots for a service on a date. Creates that day's queue on
// demand, so future dates are bookable before anyone has joined.
export const getAvailableSlots = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const party = Math.floor(Number(req.query.partySize ?? 1));
    res.json(
      await availableSlots(req.params.serviceId, req.query.date ? String(req.query.date) : undefined, {
        partySize: Number.isFinite(party) && party > 0 ? party : 1,
        roomId: typeof req.query.roomId === 'string' ? req.query.roomId : null,
        online: false,
      })
    );
  } catch (error) {
    sendBookingError(error, res, next);
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
