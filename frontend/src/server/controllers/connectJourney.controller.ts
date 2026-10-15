import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { ConnectError, badRequest, handle, text } from './connect.controller';
import { parsePatient, resolveService, upsertPatient } from './connectQueue.controller';
import { buildRefs, klargyIdFor } from '../services/externalRefs.service';
import { ORIGIN, QueueAction, getOrCreateQueueForDate, recordQueueEvent, setQueueStatus } from '../services/queueEvents.service';
import { liveStatus, summaryBetween } from '../services/ai/metrics';
import { getEndOfDay, getStartOfDay, validTimeZone } from '../utils/date';

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
    include: { service: { select: { id: true, name: true, locationId: true } } },
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
  };

  let appointmentId: string;
  let created = false;
  let actions: QueueAction[] = [];
  if (existing) {
    const moved = existing.startTime.getTime() !== input.startTime.getTime() || existing.serviceId !== service.id;
    await prisma.appointment.update({
      where: { id: existing.id },
      data: { ...data, ...(moved ? { rescheduledAt: new Date() } : {}) },
    });
    appointmentId = existing.id;
    if (status === 'CANCELLED' && existing.status !== 'CANCELLED') actions = ['appointment.cancelled'];
    else if (moved && status !== 'CANCELLED') actions = ['appointment.rescheduled'];
  } else {
    const appointment = await prisma.appointment.create({ data: { ...data, slotId: null, createdBy: null } });
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
