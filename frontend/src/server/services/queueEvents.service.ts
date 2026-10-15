import prisma from '../lib/prisma';
import { emitToQueue, emitToLocation, SOCKET_EVENTS } from '../lib/realtime';
import { generateTicketNumber, getNextSequence } from '../utils/ticket';
import { getStartOfDay, generateTimeSlots, validTimeZone } from '../utils/date';
import { dispatchWebhook, WebhookEvent } from './webhooks.service';
import { notifyEntry, notifyPositions } from './notifications.service';
import { buildRefs, RefSubject } from './externalRefs.service';

/**
 * One place every queue state change goes through after it's written:
 * the audit log (PRD 7), outbound EMR webhooks (PRD 5.3), customer journey
 * bookkeeping, and patient notifications. Side effects here must never fail
 * the staff action that triggered them, so everything is caught and logged.
 */

export type QueueAction =
  | 'entry.joined'
  | 'entry.called'
  | 'entry.served'
  | 'entry.cancelled'
  | 'entry.no_show'
  | 'entry.transferred'
  | 'entry.reordered'
  | 'queue.status_changed'
  | 'appointment.created'
  | 'appointment.rescheduled'
  | 'appointment.cancelled'
  | 'appointment.checked_in'
  | 'journey.completed'
  | 'servicepoint.opened'
  | 'servicepoint.closed';

const WEBHOOK_ACTIONS = new Set<string>([
  'entry.joined', 'entry.called', 'entry.served', 'entry.cancelled', 'entry.no_show', 'entry.transferred',
  'appointment.created', 'appointment.rescheduled', 'appointment.cancelled', 'appointment.checked_in',
  'journey.completed', 'servicepoint.opened', 'servicepoint.closed',
]);

/** Who caused an event (docs/connect/v1.md section 4). */
export type EventOrigin =
  | { type: 'staff' | 'public' | 'system'; integrationId?: null }
  | { type: 'integration'; integrationId: string };

export const ORIGIN = {
  staff: { type: 'staff' } as EventOrigin,
  public: { type: 'public' } as EventOrigin,
  system: { type: 'system' } as EventOrigin,
  integration: (integrationId: string): EventOrigin => ({ type: 'integration', integrationId }),
};

interface QueueEventInput {
  action: QueueAction;
  actorUserId?: string | null;
  queueId?: string | null;
  entryId?: string | null;
  organizationId?: string | null;
  data?: Record<string, unknown>;
  /** Defaults to staff when there's an actor, else system. */
  origin?: EventOrigin;
  /** Replaces the entry snapshot as the webhook data (non-entry events). */
  payload?: Record<string, unknown>;
  /** Replaces the Klargy ids translated into `refs`. */
  refSubject?: RefSubject;
}

/** What an entry's webhook data and Connect responses are built from. */
export const ENTRY_SNAPSHOT_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, phone: true, identityData: true } },
  queue: { select: { id: true, service: { select: { id: true, name: true, location: { select: { id: true, name: true, organizationId: true } } } } } },
  servicePointInstance: { select: { servicePointService: { select: { servicePoint: { select: { id: true, name: true } } } } } },
} as const;

type SnapshotEntry = {
  id: string;
  ticketNumber: string;
  status: string;
  queueId: string;
  journeyId: string | null;
  previousEntryId: string | null;
  joinedAt: Date;
  calledAt: Date | null;
  servedAt: Date | null;
  completedAt: Date | null;
  user: { id: string; firstName: string; lastName: string; phone: string | null; identityData: unknown };
  queue: { service: { id: string; name: string; location: { id: string; name: string; organizationId: string } } };
  servicePointInstance: { servicePointService: { servicePoint: { id: string; name: string } } } | null;
};

export function toEntrySnapshot(entry: SnapshotEntry) {
  const servicePoint = entry.servicePointInstance?.servicePointService.servicePoint ?? null;
  return {
    entryId: entry.id,
    ticketNumber: entry.ticketNumber,
    status: entry.status,
    queueId: entry.queueId,
    service: { id: entry.queue.service.id, name: entry.queue.service.name },
    location: { id: entry.queue.service.location.id, name: entry.queue.service.location.name },
    servicePoint: servicePoint ? { id: servicePoint.id, name: servicePoint.name } : null,
    journeyId: entry.journeyId,
    previousEntryId: entry.previousEntryId,
    joinedAt: entry.joinedAt,
    calledAt: entry.calledAt,
    servedAt: entry.servedAt,
    completedAt: entry.completedAt,
    patient: entry.user,
  };
}

export type EntrySnapshot = ReturnType<typeof toEntrySnapshot>;

/** The Klargy ids in an entry snapshot that `refs` translates. */
export function entryRefSubject(snapshot: EntrySnapshot, actorUserId?: string | null): RefSubject {
  return {
    patient: snapshot.patient?.id,
    visit: snapshot.journeyId,
    encounter: snapshot.entryId,
    service: snapshot.service.id,
    location: snapshot.location.id,
    servicePoint: snapshot.servicePoint?.id ?? null,
    staff: actorUserId ?? null,
  };
}

export async function entrySnapshot(entryId: string) {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, include: ENTRY_SNAPSHOT_INCLUDE });
  if (!entry) return null;
  return { organizationId: entry.queue.service.location.organizationId, snapshot: toEntrySnapshot(entry) };
}

async function queueContext(queueId: string) {
  const q = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { service: { select: { id: true, location: { select: { id: true, organizationId: true } } } } },
  });
  return q ? { organizationId: q.service.location.organizationId, serviceId: q.service.id, locationId: q.service.location.id } : null;
}

export async function recordQueueEvent(input: QueueEventInput): Promise<void> {
  try {
    const snap = input.entryId && !input.payload ? await entrySnapshot(input.entryId) : null;
    const queueCtx = !snap && input.queueId ? await queueContext(input.queueId) : null;
    const organizationId = input.organizationId ?? snap?.organizationId ?? queueCtx?.organizationId ?? null;
    if (!organizationId) return;
    const origin: EventOrigin = input.origin ?? (input.actorUserId ? ORIGIN.staff : ORIGIN.system);

    await prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        queueId: input.queueId ?? snap?.snapshot.queueId ?? null,
        entryId: input.entryId ?? null,
        data: (origin.type === 'integration' ? { ...(input.data ?? {}), origin } : input.data ?? undefined) as any,
      },
    });

    if (WEBHOOK_ACTIONS.has(input.action)) {
      const refSubject: RefSubject =
        input.refSubject ??
        (snap
          ? entryRefSubject(snap.snapshot, input.actorUserId)
          : {
              patient: typeof input.data?.patientId === 'string' ? input.data.patientId : null,
              visit: null,
              encounter: null,
              service: queueCtx?.serviceId ?? null,
              location: queueCtx?.locationId ?? null,
              servicePoint: null,
              staff: input.actorUserId ?? null,
            });
      await dispatchWebhook(
        organizationId,
        input.action as WebhookEvent,
        {
          ...(input.payload ?? { ...(snap?.snapshot ?? {}), ...(input.data ?? {}) }),
          origin: { type: origin.type, integrationId: origin.integrationId ?? null },
        },
        async (integrationId) => (await buildRefs(integrationId, [refSubject]))[0]
      );
    }
  } catch (error) {
    console.error(`recordQueueEvent(${input.action}) failed:`, error);
  }
}

// ---------------------------------------------------------------------------
// Customer journeys: one per patient visit, spanning every queue they pass
// through. Started on join, extended on transfer, closed once nothing in it
// is still waiting or being served.
// ---------------------------------------------------------------------------

export async function startJourney(entryId: string): Promise<void> {
  try {
    const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, select: { userId: true, journeyId: true } });
    if (!entry || entry.journeyId) return;
    const journey = await prisma.customerJourney.create({
      data: { userId: entry.userId, queueEntryIds: [entryId] },
    });
    await prisma.queueEntry.update({ where: { id: entryId }, data: { journeyId: journey.id } });
  } catch (error) {
    console.error('startJourney failed:', error);
  }
}

/** Closes the entry's journey once nothing in it is waiting or being served,
 * and announces it (journey.completed) when this call is what closed it. */
export async function closeJourneyIfDone(
  entryId: string,
  ctx: { actorUserId?: string | null; origin?: EventOrigin } = {}
): Promise<void> {
  try {
    const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, select: { journeyId: true } });
    if (!entry?.journeyId) return;
    const journey = await prisma.customerJourney.findUnique({ where: { id: entry.journeyId } });
    if (!journey) return;
    const open = await prisma.queueEntry.count({
      where: { id: { in: journey.queueEntryIds }, status: { in: ['WAITING', 'SERVING'] } },
    });
    if (open > 0) return;
    const completedAt = new Date();
    const totalDuration = Math.round((completedAt.getTime() - journey.startedAt.getTime()) / 60000);
    // Only the call that actually closes it announces it.
    const closed = await prisma.customerJourney.updateMany({
      where: { id: journey.id, completedAt: null },
      data: { completedAt, totalDuration },
    });
    if (closed.count !== 1) return;

    const owner = await prisma.queueEntry.findUnique({
      where: { id: entryId },
      select: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, identityData: true } },
        queue: { select: { service: { select: { location: { select: { organizationId: true } } } } } },
      },
    });
    if (!owner) return;
    await recordQueueEvent({
      action: 'journey.completed',
      actorUserId: ctx.actorUserId,
      origin: ctx.origin,
      organizationId: owner.queue.service.location.organizationId,
      entryId,
      data: { journeyId: journey.id, totalDuration },
      payload: { journeyId: journey.id, completedAt, totalDuration, patient: owner.user },
      refSubject: { patient: owner.user.id, visit: journey.id },
    });
  } catch (error) {
    console.error('closeJourneyIfDone failed:', error);
  }
}

/** Runs everything that should follow an entry leaving the waiting line
 * (called, served, cancelled, no-show): positions shift for everyone else. */
export async function afterQueueChange(queueId: string): Promise<void> {
  try {
    await notifyPositions(queueId);
  } catch (error) {
    console.error('afterQueueChange failed:', error);
  }
}

export async function afterEntryCalled(entryId: string, servicePointName?: string | null): Promise<void> {
  try {
    await notifyEntry(entryId, 'NOW_SERVING', { servicePointName });
  } catch (error) {
    console.error('afterEntryCalled failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/** The location's timezone for a service, if it's a real one. */
export async function serviceTimeZone(serviceId: string): Promise<string | undefined> {
  const s = await prisma.service.findUnique({ where: { id: serviceId }, select: { location: { select: { timezone: true } } } });
  return validTimeZone(s?.location?.timezone);
}

/**
 * Today's (or a given day's) queue for a service, created on first use with
 * its appointment slots. "Today" and the opening hours are the location's
 * local time. Safe when two people join at the same moment.
 */
export async function getOrCreateQueueForDate(serviceId: string, date: Date = new Date()) {
  const service = await prisma.service.findUnique({ where: { id: serviceId }, include: { location: { select: { timezone: true } } } });
  if (!service) return null;
  const tz = validTimeZone(service.location?.timezone);
  const day = getStartOfDay(date, tz);
  const existing = await prisma.queue.findFirst({ where: { serviceId, date: day } });
  if (existing) return { queue: existing, service, tz };

  const slots = generateTimeSlots(service.startTime, service.endTime, service.slotDuration, day, tz);
  try {
    const queue = await prisma.queue.create({
      data: {
        serviceId,
        date: day,
        slots: {
          create: slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime, capacity: service.concurrentLimit })),
        },
      },
    });
    return { queue, service, tz };
  } catch (error) {
    // Someone else created it between our read and write.
    if ((error as { code?: string }).code === 'P2002') {
      const queue = await prisma.queue.findFirst({ where: { serviceId, date: day } });
      if (queue) return { queue, service, tz };
    }
    throw error;
  }
}

export class TransferError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * Sends a patient on to another service: new ticket in today's queue for
 * that service, linked back to the source entry and the same journey and
 * public session (so the patient's status page follows them).
 */
export async function transferEntryToService(
  sourceEntryId: string,
  toServiceId: string,
  opts: { actorUserId?: string | null; priority?: number; completeSource?: boolean; origin?: EventOrigin } = {}
) {
  const source = await prisma.queueEntry.findUnique({
    where: { id: sourceEntryId },
    include: { queue: { include: { service: { include: { location: true } } } } },
  });
  if (!source) throw new TransferError('Entry not found', 404);

  const target = await getOrCreateQueueForDate(toServiceId);
  if (!target) throw new TransferError('Target service not found', 404);
  const targetLocation = await prisma.location.findUnique({ where: { id: target.service.locationId } });
  if (!targetLocation || targetLocation.organizationId !== source.queue.service.location.organizationId) {
    throw new TransferError('Target service not found', 404);
  }
  if (!target.service.isActive) throw new TransferError('That service is not active');
  if (target.queue.status !== 'ACTIVE') throw new TransferError(`The ${target.service.name} queue isn’t taking anyone right now`);

  if (opts.completeSource && (source.status === 'WAITING' || source.status === 'SERVING')) {
    await prisma.queueEntry.update({
      where: { id: source.id },
      data: { status: 'SERVED', completedAt: new Date(), notes: `Transferred to ${target.service.name}` },
    });
  }

  const sequence = await getNextSequence(prisma, target.queue.id);
  const ticketNumber = generateTicketNumber(target.service.name.charAt(0).toUpperCase(), sequence);
  const lastEntry = await prisma.queueEntry.findFirst({ where: { queueId: target.queue.id }, orderBy: { sortOrder: 'desc' } });

  const newEntry = await prisma.queueEntry.create({
    data: {
      queueId: target.queue.id,
      userId: source.userId,
      ticketNumber,
      priority: opts.priority ?? source.priority,
      sortOrder: (lastEntry?.sortOrder || 0) + 1,
      sessionId: source.sessionId,
      journeyId: source.journeyId,
      previousEntryId: source.id,
      notes: `Transferred from ${source.queue.service.name}`,
    },
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
  });

  if (source.journeyId) {
    await prisma.customerJourney.update({
      where: { id: source.journeyId },
      data: { queueEntryIds: { push: newEntry.id }, completedAt: null, totalDuration: null },
    }).catch(() => {});
  } else {
    await startJourney(source.id);
    const refreshed = await prisma.queueEntry.findUnique({ where: { id: source.id }, select: { journeyId: true } });
    if (refreshed?.journeyId) {
      await prisma.customerJourney.update({
        where: { id: refreshed.journeyId },
        data: { queueEntryIds: { push: newEntry.id } },
      });
      await prisma.queueEntry.update({ where: { id: newEntry.id }, data: { journeyId: refreshed.journeyId } });
    }
  }

  const transitionData = { fromQueueId: source.queueId, toQueueId: target.queue.id, entry: newEntry };
  emitToQueue(source.queueId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, {
    queueId: source.queueId, entryId: source.id, status: 'SERVED', action: 'transferred',
  });
  emitToLocation(source.queue.service.locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, {
    queueId: source.queueId, entryId: source.id, status: 'SERVED', action: 'transferred',
  });
  emitToQueue(target.queue.id, SOCKET_EVENTS.SERVICEFLOW_TRANSITION, transitionData);
  emitToLocation(target.service.locationId, SOCKET_EVENTS.SERVICEFLOW_TRANSITION, transitionData);

  await recordQueueEvent({
    action: 'entry.transferred',
    actorUserId: opts.actorUserId,
    origin: opts.origin,
    queueId: target.queue.id,
    entryId: newEntry.id,
    data: { fromEntryId: source.id, fromServiceId: source.queue.serviceId, toServiceId },
  });
  await afterQueueChange(source.queueId);
  await afterQueueChange(target.queue.id);

  return { entry: newEntry, queue: target.queue, service: target.service };
}
