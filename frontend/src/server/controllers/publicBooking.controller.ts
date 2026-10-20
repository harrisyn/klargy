import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { validTimeZone } from '../utils/date';
import { termsFor } from '../../lib/terms';
import { recordQueueEvent } from '../services/queueEvents.service';
import { manageLinkFor, sendBookingConfirmation } from '../services/bookingNotifications.service';
import {
  ACTIVE_STATUSES,
  HOLD_STATUSES,
  BookingError,
  availableSlots,
  cancelAppointmentCore,
  checkInAppointmentCore,
  claimSlot,
  releaseSlot,
  rescheduleAppointmentCore,
  unitsOf,
} from '../services/booking.service';
import { PAYMENT_HOLD_MINUTES, collectorFor, paymentTerms, quoteBooking, refundBooking, refundDue } from '../services/bookingPayments/bookingPayments.service';
import { bookingEnd, roomChoices, seatMap, tableData, withTable } from '../services/tables.service';
import { roomRefusal, type Room } from '../services/rooms.service';

/**
 * Customers booking a time on the public page. No account: the booking is
 * identified by a private link (manageToken) they get on screen and by email.
 * Services with a price can take payment when booking. A service with tables
 * gives each booking one (or several) that fit, or the ones the customer picks
 * on the room's floor plan; rooms can have their own rules and rates.
 */

const MAX_DAYS_AHEAD = 60;
const BOOKABLE = ['APPOINTMENT', 'BOTH'];

const fail = (error: unknown, res: Response, next: NextFunction) =>
  error instanceof BookingError ? res.status(error.status).json({ error: error.message }) : next(error);

const orgSelect = {
  id: true,
  name: true,
  status: true,
  logoUrl: true,
  primaryColor: true,
  hidePoweredBy: true,
  industry: true,
  customerLabel: true,
  customerLabelPlural: true,
  slug: true,
  currency: true,
} as const;

/** A service customers may book: active, bookable, in an active organisation. */
async function bookableService(serviceId: string) {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { room: true, location: { include: { organization: { select: orgSelect } } } },
  });
  if (!service || !service.isActive || service.location.organization.status !== 'ACTIVE') {
    throw new BookingError('This service is not available for booking', 404);
  }
  if (!BOOKABLE.includes(service.bookingMode)) throw new BookingError('This service does not take bookings online', 403);
  return service;
}

type BookableService = Awaited<ReturnType<typeof bookableService>>;

/** What the booking page needs to know about a service's terms. */
function serviceTerms(service: BookableService) {
  return {
    bookingUnit: service.bookingUnit,
    tableMode: service.tableMode,
    minPartySize: service.minPartySize,
    maxPartySize: service.maxPartySize,
    price: service.price == null ? null : Number(service.price),
    priceBasis: service.priceBasis,
    paymentMode: service.paymentMode,
    depositPercent: service.depositPercent,
    refundCutoffHours: service.refundCutoffHours,
    currency: service.location.organization.currency,
  };
}

const partyFrom = (value: unknown, service: BookableService): number => {
  if (service.bookingUnit !== 'PERSON') return 1;
  const n = Math.floor(Number(value ?? 1));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

const idParam = (v: unknown) => (typeof v === 'string' && v ? v : null);

export const getBookableSlots = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = await bookableService(req.params.serviceId);
    const date = req.query.date ? String(req.query.date) : undefined;
    if (date) {
      const t = new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime();
      if (Number.isNaN(t)) throw new BookingError('Invalid date');
      if (t > Date.now() + MAX_DAYS_AHEAD * 86400000) throw new BookingError(`Bookings open up to ${MAX_DAYS_AHEAD} days ahead`);
    }
    const partySize = partyFrom(req.query.partySize, service);
    const result = await availableSlots(service.id, date, { partySize, roomId: idParam(req.query.roomId), online: true });
    // Rooms the customer can choose between (seating areas), with what each costs extra.
    const rooms = service.tableMode === 'AUTO' ? await roomChoices(service.locationId, partySize) : [];
    res.json({ ...result, timezone: validTimeZone(service.location.timezone) ?? null, maxDaysAhead: MAX_DAYS_AHEAD, terms: serviceTerms(service), rooms });
  } catch (error) {
    fail(error, res, next);
  }
};

/** The floor plan of a room with each table free or taken at the chosen time, for picking a table or seat. */
export const getSeatMap = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = await bookableService(req.params.serviceId);
    if (service.tableMode !== 'AUTO') throw new BookingError('This service doesn’t use tables', 404);
    const slotId = idParam(req.query.slotId);
    const roomId = idParam(req.query.roomId);
    if (!slotId || !roomId) throw new BookingError('Choose a time and an area first');
    const slot = await prisma.slot.findUnique({ where: { id: slotId }, include: { queue: true } });
    if (!slot || slot.queue.serviceId !== service.id) throw new BookingError('That time is no longer available', 404);
    const room = await prisma.room.findFirst({ where: { id: roomId, locationId: service.locationId, isActive: true, onlineBookable: true }, select: { id: true } });
    if (!room) throw new BookingError('That area isn’t available', 404);
    const map = await seatMap(roomId, {
      start: slot.startTime,
      end: bookingEnd(slot.startTime, slot.endTime, service.slotDuration),
      partySize: partyFrom(req.query.partySize, service),
      online: true,
      timeZone: service.location.timezone,
    });
    if (!map) throw new BookingError('That area isn’t available', 404);
    res.json(map);
  } catch (error) {
    fail(error, res, next);
  }
};

/** The room a booking would be in for a quote: the one asked for, else the service's own. */
async function roomForQuote(service: BookableService, roomId: string | null): Promise<Room | null> {
  if (roomId) {
    const room = await prisma.room.findFirst({ where: { id: roomId, locationId: service.locationId, isActive: true, onlineBookable: true } });
    if (!room) throw new BookingError('That area isn’t available', 404);
    return room as unknown as Room;
  }
  return (service.room as unknown as Room | null) ?? null;
}

/** What a booking would cost and what is paid now, for the page to show before the customer commits. */
export const quoteOnlineBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = await bookableService(req.params.serviceId);
    const partySize = partyFrom(req.query.partySize, service);
    const slotId = idParam(req.query.slotId);
    const slot = slotId ? await prisma.slot.findUnique({ where: { id: slotId }, include: { queue: true } }) : null;
    if (slot && slot.queue.serviceId !== service.id) throw new BookingError('That time is no longer available', 404);
    const room = await roomForQuote(service, idParam(req.query.roomId));
    const terms = paymentTerms(service, room);
    const price = quoteBooking({ service, slotPrice: slot?.price, room, partySize, terms });
    res.json({ ...price, currency: service.location.organization.currency, paymentMode: terms.paymentMode, roomName: room?.name ?? null });
  } catch (error) {
    fail(error, res, next);
  }
};

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** What the customer's own page shows. */
async function bookingView(token: string) {
  const a = await prisma.appointment.findUnique({
    where: { manageToken: token },
    include: {
      user: { select: { firstName: true, lastName: true } },
      service: { include: { location: { include: { organization: { select: orgSelect } } } } },
      slot: { select: { queueId: true, label: true } },
      tables: { select: { table: { select: { name: true } } } },
      room: true,
    },
  });
  if (!a) return null;
  const loc = a.service.location;
  const org = loc.organization;
  const open = ACTIVE_STATUSES.includes(a.status);
  const upcoming = a.startTime.getTime() > Date.now();
  // The ticket made by checking in, for the live status page.
  const entry = a.status === 'CHECKED_IN'
    ? await prisma.queueEntry.findFirst({ where: { userId: a.userId, queue: { serviceId: a.serviceId }, notes: 'Appointment check-in' }, orderBy: { joinedAt: 'desc' }, select: { id: true, queueId: true } })
    : null;
  const num = (d: unknown) => (d == null ? null : Number(d));
  const terms = paymentTerms(a.service, a.room);
  const paid = Number(a.amountPaid ?? 0);
  return {
    id: a.id,
    status: a.status,
    startTime: a.startTime,
    endTime: a.endTime,
    notes: a.notes,
    customerName: `${a.user.firstName} ${a.user.lastName}`.trim(),
    serviceId: a.serviceId,
    serviceName: a.service.name,
    sessionLabel: a.slot?.label ?? null,
    roomName: a.room?.name ?? null,
    tableNames: a.tables.map((t) => t.table.name),
    bookingMode: a.service.bookingMode,
    partySize: a.partySize,
    showPartySize: a.service.bookingUnit === 'PERSON',
    payment: {
      status: a.paymentStatus,
      currency: a.currency,
      total: num(a.amount),
      dueNow: num(a.amountDue),
      paid: num(a.amountPaid),
      refundCutoffHours: terms.refundCutoffHours,
      // What would come back if they cancelled right now.
      refundNow: a.paymentStatus === 'PAID' && paid > 0 ? refundDue({ startTime: a.startTime, room: a.room, service: a.service }, paid) : null,
      expiresAt: a.paymentExpiresAt,
      // Where to carry on paying while the place is held.
      resumeUrl: a.status === 'PENDING_PAYMENT' && a.paymentExpiresAt && a.paymentExpiresAt.getTime() > Date.now() ? a.paymentUrl : null,
    },
    locationName: loc.name,
    locationAddress: loc.address ?? null,
    locationCode: loc.publicCode ?? null,
    timezone: validTimeZone(loc.timezone) ?? null,
    organization: {
      name: org.name,
      logoUrl: org.logoUrl,
      primaryColor: org.primaryColor,
      hidePoweredBy: org.hidePoweredBy,
      industry: org.industry,
      customerLabel: org.customerLabel,
      customerLabelPlural: org.customerLabelPlural,
    },
    canChange: open && upcoming,
    canCancel: (open && upcoming) || a.status === 'PENDING_PAYMENT',
    canCheckIn: open,
    statusPath: entry ? `/status/${entry.queueId}/${entry.id}` : null,
  };
}

export const createOnlineBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, slotId, name, phone, email, notes } = req.body ?? {};
    if (typeof serviceId !== 'string' || typeof slotId !== 'string') throw new BookingError('Choose a service and a time');
    const fullName = String(name ?? '').trim();
    const contactEmail = String(email ?? '').trim().toLowerCase();
    const contactPhone = String(phone ?? '').trim();
    if (!fullName) throw new BookingError('Please enter your name');
    if (!contactEmail && !contactPhone) throw new BookingError('Please give a phone number or an email so we can reach you');
    if (contactEmail && !isEmail(contactEmail)) throw new BookingError('That email address doesn’t look right');
    if (fullName.length > 120 || String(notes ?? '').length > 500) throw new BookingError('That’s too long');

    const service = await bookableService(serviceId);
    const slot = await prisma.slot.findUnique({ where: { id: slotId }, include: { queue: true } });
    if (!slot || slot.queue.serviceId !== service.id) throw new BookingError('That time is no longer available', 404);
    if (slot.startTime < new Date()) throw new BookingError('That time has already passed');
    if (slot.startTime.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400000) throw new BookingError(`Bookings open up to ${MAX_DAYS_AHEAD} days ahead`);
    const org = service.location.organization;

    // How many people. Seat-based services ask; others are always one booking.
    let partySize = 1;
    if (service.bookingUnit === 'PERSON') {
      partySize = Math.floor(Number(req.body.partySize ?? 1));
      if (!Number.isFinite(partySize) || partySize < service.minPartySize || partySize > service.maxPartySize) {
        throw new BookingError(`Please choose between ${service.minPartySize} and ${service.maxPartySize} people`);
      }
    }
    const units = unitsOf({ partySize }, service);
    const timeZone = service.location.timezone;
    const wantedRoomId = idParam(req.body.roomId);
    // Tables or seats the customer picked on the floor plan; none means "assign me".
    const wantedTableIds: string[] | null = Array.isArray(req.body.tableIds) ? req.body.tableIds.filter((v: unknown): v is string => typeof v === 'string').slice(0, 12) : null;

    // A service delivered in a room has to meet that room's rules.
    if (service.room && service.tableMode !== 'AUTO') {
      const why = roomRefusal(service.room, { start: slot.startTime, partySize, online: true, timeZone });
      if (why) throw new BookingError(why);
    }

    // Who can take payment, if the booking turns out to cost something.
    const collector = await collectorFor(org.id, org.currency);

    // The same person (email) booking again reuses their record; otherwise a
    // guest record that can't log in, like walk-ins.
    let userId: string | undefined;
    if (contactEmail) {
      const existing = await prisma.user.findUnique({ where: { email: contactEmail }, select: { id: true, role: true, organizationId: true } });
      if (existing && existing.role === 'PATIENT' && existing.organizationId === org.id) userId = existing.id;
    }
    const [firstName, ...rest] = fullName.split(/\s+/);
    if (!userId) {
      const takenElsewhere = contactEmail ? await prisma.user.findUnique({ where: { email: contactEmail }, select: { id: true } }) : null;
      userId = (
        await prisma.user.create({
          data: {
            email: contactEmail && !takenElsewhere ? contactEmail : `guest_${Date.now()}_${crypto.randomBytes(5).toString('hex')}@guest.qms.local`,
            password: '',
            firstName,
            lastName: rest.join(' '),
            phone: contactPhone || null,
            role: 'PATIENT',
            organizationId: org.id,
          },
          select: { id: true },
        })
      ).id;
    }

    if (await prisma.appointment.findFirst({ where: { userId, slotId, status: { in: HOLD_STATUSES } }, select: { id: true } })) {
      throw new BookingError('You already have a booking at that time');
    }
    if (!(await claimSlot(slotId, units))) {
      throw new BookingError(service.bookingUnit === 'PERSON' ? 'Sorry, there isn’t room for that many at that time. Please choose another.' : 'Sorry, that time was just taken. Please choose another.');
    }

    const manageToken = crypto.randomBytes(24).toString('hex');
    let appointment: { id: string };
    let price = { total: 0, dueNow: 0, roomAmount: 0 };
    let paying = false;
    try {
      // The tables (and so the room, its rules and its rate) are chosen and the booking
      // created together, so two customers can't be given the same table.
      appointment = await withTable(
        {
          tableMode: service.tableMode,
          locationId: service.locationId,
          start: slot.startTime,
          end: bookingEnd(slot.startTime, slot.endTime, service.slotDuration),
          partySize,
          online: true,
          timeZone,
          roomId: wantedRoomId,
          tableIds: wantedTableIds,
        },
        async (db, tables) => {
          const room = (tables[0]?.room ?? service.room ?? null) as Room | null;
          const terms = paymentTerms(service, room);
          price = quoteBooking({ service, slotPrice: slot.price, room, partySize, terms });
          paying = price.dueNow > 0;
          if (paying && !collector) throw new BookingError('Online payment isn’t set up for this business yet. Please contact them to book.', 503);
          // Paystack can't take a payment without an email address, and it is where the receipt goes.
          if (paying && collector?.provider === 'paystack' && !contactEmail) {
            throw new BookingError('Please give an email address: it’s needed to take the payment and send your receipt.');
          }
          return db.appointment.create({
            data: {
              userId: userId!,
              serviceId: service.id,
              slotId,
              startTime: slot.startTime,
              endTime: slot.endTime,
              notes: String(notes ?? '').trim() || null,
              source: 'ONLINE',
              manageToken,
              partySize,
              ...tableData(tables, service.roomId),
              ...(price.total > 0 ? { amount: price.total, amountDue: price.dueNow || null, currency: org.currency } : {}),
              ...(paying
                ? {
                    status: 'PENDING_PAYMENT',
                    paymentStatus: 'PENDING',
                    paymentSource: collector!.source,
                    paymentProvider: collector!.provider,
                    paymentExpiresAt: new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000),
                  }
                : {}),
            },
            select: { id: true },
          });
        }
      );
    } catch (error) {
      await releaseSlot(slotId, units);
      throw error;
    }

    const link = manageLinkFor(manageToken, org.slug);
    let checkoutUrl: string | null = null;
    if (paying) {
      try {
        const checkout = await collector!.client.createCheckout({
          appointmentId: appointment.id,
          organizationId: org.id,
          amount: price.dueNow,
          currency: org.currency,
          description: `${service.name} at ${service.location.name}${service.bookingUnit === 'PERSON' ? ` (${partySize} ${partySize === 1 ? 'person' : 'people'})` : ''}`,
          customerEmail: contactEmail || null,
          successUrl: `${link}?paid=1`,
          cancelUrl: link,
        });
        checkoutUrl = checkout.redirectUrl;
        await prisma.appointment.update({ where: { id: appointment.id }, data: { paymentRef: checkout.reference, paymentUrl: checkout.redirectUrl } });
      } catch (error) {
        console.error('Could not start the booking payment:', error);
        await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'CANCELLED', paymentStatus: 'FAILED' } });
        await releaseSlot(slotId, units);
        throw new BookingError('We couldn’t start the payment. Please try again in a moment.', 502);
      }
    }

    // A booking waiting for payment is announced once it is paid (see confirmPaid).
    if (!paying) {
      await recordQueueEvent({
        action: 'appointment.created',
        actorUserId: null,
        queueId: slot.queueId,
        organizationId: org.id,
        data: { appointmentId: appointment.id, slotStart: slot.startTime, patientId: userId, source: 'ONLINE', partySize, ...(price.total > 0 ? { payment: { total: price.total, paid: 0, currency: org.currency } } : {}) },
      });
    }

    // Paid bookings are confirmed (and emailed) when the payment arrives.
    if (!paying && contactEmail) void sendBookingConfirmation(appointment.id);

    res.status(201).json({ manageToken, checkoutUrl, booking: await bookingView(manageToken), terms: termsFor(org) });
  } catch (error) {
    fail(error, res, next);
  }
};

export const getOnlineBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const view = await bookingView(req.params.token);
    if (!view) return res.status(404).json({ error: 'Booking not found' });
    res.json(view);
  } catch (error) {
    next(error);
  }
};

async function appointmentIdFor(token: string): Promise<string> {
  const a = await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true } });
  if (!a) throw new BookingError('Booking not found', 404);
  return a.id;
}

export const cancelOnlineBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = await appointmentIdFor(req.params.token);
    const current = await prisma.appointment.findUnique({ where: { id }, select: { startTime: true } });
    if (current && current.startTime.getTime() < Date.now()) throw new BookingError('This time has already passed');
    // Money back first (per the service's or room's cancellation terms); if that fails the booking stays.
    const refund = await refundBooking(id, { policy: 'CUTOFF' });
    await cancelAppointmentCore(id, null);
    res.json({ ...(await bookingView(req.params.token)), refunded: refund.refunded });
  } catch (error) {
    fail(error, res, next);
  }
};

export const rescheduleOnlineBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = await appointmentIdFor(req.params.token);
    if (typeof req.body?.slotId !== 'string') throw new BookingError('Choose a new time');
    const target = await prisma.slot.findUnique({ where: { id: req.body.slotId }, include: { queue: { select: { serviceId: true } } } });
    if (target) await bookableService(target.queue.serviceId);
    await rescheduleAppointmentCore(id, req.body.slotId, null, { online: true });
    res.json(await bookingView(req.params.token));
  } catch (error) {
    fail(error, res, next);
  }
};

export const checkInOnlineBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = await appointmentIdFor(req.params.token);
    const result = await checkInAppointmentCore(id, null);
    res.json({ ...result, statusPath: `/status/${result.queueId}/${result.entry.id}` });
  } catch (error) {
    fail(error, res, next);
  }
};
