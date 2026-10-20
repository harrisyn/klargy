import prisma from '../lib/prisma';
import { emitToQueue, emitToLocation, SOCKET_EVENTS } from '../lib/realtime';
import { generateTicketNumber, getNextSequence } from '../utils/ticket';
import { getStartOfDay, generateTimeSlots, validTimeZone } from '../utils/date';
import { dispatchWebhook, WebhookEvent } from './webhooks.service';
import { notifyEntry, notifyPositions, queueLineRanks } from './notifications.service';
import { statusUrlFor } from '../config/appConfig';
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
  | 'entry.priority_changed'
  | 'entry.held'
  | 'entry.resumed'
  | 'entry.cleared'
  | 'queue.status_changed'
  | 'queue.paused'
  | 'queue.resumed'
  | 'appointment.created'
  | 'appointment.rescheduled'
  | 'appointment.cancelled'
  | 'appointment.checked_in'
  | 'journey.completed'
  | 'servicepoint.opened'
  | 'servicepoint.closed';

const WEBHOOK_ACTIONS = new Set<string>([
  'entry.joined', 'entry.called', 'entry.served', 'entry.cancelled', 'entry.no_show', 'entry.transferred',
  'entry.priority_changed', 'entry.held', 'entry.resumed', 'entry.cleared', 'queue.paused', 'queue.resumed',
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
  queue: {
    select: {
      id: true,
      service: {
        select: {
          id: true,
          name: true,
          location: { select: { id: true, name: true, organizationId: true, organization: { select: { slug: true } } } },
        },
      },
    },
  },
  servicePointInstance: { select: { servicePointService: { select: { servicePoint: { select: { id: true, name: true } } } } } },
} as const;

/** Who sent an entry to its service, for one made by a transfer. */
export type SentBy = 'staff' | 'patient' | 'integration';

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
  heldAt?: Date | null;
  awaitingClearance?: boolean;
  sentBy?: string | null;
  user: { id: string; firstName: string; lastName: string; phone: string | null; identityData: unknown };
  queue: {
    service: {
      id: string;
      name: string;
      location: { id: string; name: string; organizationId: string; organization?: { slug: string | null } | null };
    };
  };
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
    /** On hold: off the desk, kept at the front, not picked by call next. */
    held: !!entry.heldAt,
    /** Waiting for payment in a service that requires clearance. */
    awaitingClearance: !!entry.awaitingClearance,
    /** Who sent it here, for an entry made by a transfer. */
    sentBy: (entry.sentBy ?? null) as SentBy | null,
    /** The visit's entries, oldest first (see withJourneys). */
    journey: [] as JourneyStep[],
    statusUrl: statusUrlFor(entry.queueId, entry.id, entry.queue.service.location.organization?.slug),
    /** 1-based place in line while WAITING, else null (see withPositions). */
    position: null as number | null,
  };
}

export type EntrySnapshot = ReturnType<typeof toEntrySnapshot>;

/** One stop of a visit: an entry in its journey. `service.ref` is the
 * integration's own id for the service (null outside Connect). */
export interface JourneyStep {
  entryId: string;
  ticketNumber: string;
  service: { id: string; ref: string | null; name: string };
  status: string;
  joinedAt: Date;
  endedAt: Date | null;
}

/** The journey steps of entries, by journey id (an entry with none is its
 * own one-step journey). Oldest first. */
export async function journeySteps(entries: { entryId: string; journeyId: string | null }[]): Promise<Map<string, JourneyStep[]>> {
  const journeyIds = [...new Set(entries.map((e) => e.journeyId).filter((id): id is string => !!id))];
  const loose = entries.filter((e) => !e.journeyId).map((e) => e.entryId);
  if (journeyIds.length === 0 && loose.length === 0) return new Map();
  const rows = await prisma.queueEntry.findMany({
    where: { OR: [...(journeyIds.length ? [{ journeyId: { in: journeyIds } }] : []), ...(loose.length ? [{ id: { in: loose } }] : [])] },
    orderBy: [{ joinedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, ticketNumber: true, status: true, joinedAt: true, completedAt: true, journeyId: true,
      queue: { select: { service: { select: { id: true, name: true } } } },
    },
  });
  const byKey = new Map<string, JourneyStep[]>();
  for (const r of rows ?? []) {
    const key = r.journeyId ?? `entry:${r.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({
      entryId: r.id,
      ticketNumber: r.ticketNumber,
      service: { id: r.queue.service.id, ref: null, name: r.queue.service.name },
      status: r.status,
      joinedAt: r.joinedAt,
      endedAt: r.completedAt,
    });
  }
  return byKey;
}

/** Fills in `journey` (service refs null; see journeyRefs). */
export async function withJourneys<T extends { entryId: string; journeyId: string | null; journey: JourneyStep[] }>(snapshots: T[]): Promise<T[]> {
  if (snapshots.length === 0) return snapshots;
  const steps = await journeySteps(snapshots);
  return snapshots.map((s) => ({ ...s, journey: steps.get(s.journeyId ?? `entry:${s.entryId}`) ?? [] }));
}

/** The same journeys with one integration's ids for their services. */
export async function journeyRefs<T extends { journey: JourneyStep[] }>(integrationId: string, snapshots: T[]): Promise<T[]> {
  const serviceIds = [...new Set(snapshots.flatMap((s) => s.journey.map((j) => j.service.id)))];
  if (serviceIds.length === 0) return snapshots;
  const refs = await buildRefs(integrationId, serviceIds.map((service) => ({ service })));
  const refOf = new Map(serviceIds.map((id, i) => [id, refs[i]?.service ?? null]));
  return snapshots.map((s) => ({
    ...s,
    journey: s.journey.map((j) => ({ ...j, service: { ...j.service, ref: refOf.get(j.service.id) ?? null } })),
  }));
}

/** Fills in `position` for waiting entries: the same order staff call people. */
export async function withPositions<T extends { entryId: string; queueId: string; status: string; position: number | null }>(
  snapshots: T[]
): Promise<T[]> {
  const queueIds = [...new Set(snapshots.filter((s) => s.status === 'WAITING').map((s) => s.queueId))];
  if (queueIds.length === 0) return snapshots;
  const places = new Map<string, number>();
  for (const queueId of queueIds) {
    for (const [id, place] of await queueLineRanks(queueId)) places.set(id, place);
  }
  return snapshots.map((s) => (s.status === 'WAITING' ? { ...s, position: places.get(s.entryId) ?? null } : s));
}

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
  const [positioned] = await withPositions([toEntrySnapshot(entry)]);
  // The journey is extra detail: an event still goes out without it.
  const snapshot = await withJourneys([positioned]).then(([s]) => s, (error) => {
    console.error('journey for entry snapshot failed:', error);
    return positioned;
  });
  return { organizationId: entry.queue.service.location.organizationId, snapshot };
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
    // A transfer's source entry, with its own refs (visit, encounter).
    const fromId = typeof input.data?.fromEntryId === 'string' && snap ? input.data.fromEntryId : null;
    const from = fromId ? (await entrySnapshot(fromId))?.snapshot ?? null : null;
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
      const appointmentRef: RefSubject =
        typeof input.data?.appointmentId === 'string' ? { appointment: input.data.appointmentId } : {};
      const refSubject: RefSubject =
        input.refSubject ??
        (snap
          ? { ...entryRefSubject(snap.snapshot, input.actorUserId), ...appointmentRef }
          : {
              patient: typeof input.data?.patientId === 'string' ? input.data.patientId : null,
              ...appointmentRef,
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
          ...(input.payload ?? { ...(snap?.snapshot ?? {}), ...(input.data ?? {}), ...(from ? { from } : {}) }),
          origin: { type: origin.type, integrationId: origin.integrationId ?? null },
        },
        async (integrationId) => (await buildRefs(integrationId, [refSubject]))[0],
        // The integration's own ids inside the entry: journey services, and
        // the source entry's refs on a transfer.
        snap
          ? async (integrationId) => {
              const [withRefs] = await journeyRefs(integrationId, [snap.snapshot]);
              const extra: Record<string, unknown> = { journey: withRefs.journey };
              if (from) {
                const [fromRefs] = await buildRefs(integrationId, [entryRefSubject(from, null)]);
                const [fromJourney] = await journeyRefs(integrationId, [from]);
                extra.from = { ...fromJourney, refs: fromRefs };
              }
              return extra;
            }
          : undefined
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

export async function afterEntryCalled(entryId: string, servicePointName?: string | null, since?: Date): Promise<void> {
  try {
    await notifyEntry(entryId, 'NOW_SERVING', { servicePointName, since });
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

  // Sessions-only services (events, tickets) have no slots from opening hours.
  const slots = service.recurringSlots === false ? [] : generateTimeSlots(service.startTime, service.endTime, service.slotDuration, day, tz);
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

/** The desk that last saw this visit in a service, if it's still a desk
 * for that service. */
async function lastDeskInJourney(journeyId: string | null, serviceId: string): Promise<string | null> {
  if (!journeyId) return null;
  const last = await prisma.queueEntry.findFirst({
    where: { journeyId, queue: { serviceId }, servicePointInstanceId: { not: null } },
    orderBy: { joinedAt: 'desc' },
    select: { servicePointInstance: { select: { id: true, isActive: true, servicePointService: { select: { serviceId: true } } } } },
  });
  const desk = last?.servicePointInstance;
  return desk && desk.isActive && desk.servicePointService.serviceId === serviceId ? desk.id : null;
}

export class TransferError extends Error {
  constructor(message: string, public status = 400, public code?: 'NOT_FOUND' | 'QUEUE_CLOSED' | 'INVALID_TRANSITION') {
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
  opts: {
    actorUserId?: string | null;
    priority?: number;
    completeSource?: boolean;
    origin?: EventOrigin;
    /** Refuse (409) unless the source is still waiting or being served, and
     * complete it only if it still is, so a race can't double-move it. */
    requireOpenSource?: boolean;
    /** Extra fields for the event (audit log and webhook data). */
    data?: Record<string, unknown>;
    /** Payment already settled: skip the target's clearance gate. */
    cleared?: boolean;
    /** Who is sending them (default: integration for a Connect call, staff
     * when someone acts, none for an automatic flow). */
    sentBy?: SentBy | null;
  } = {}
) {
  const source = await prisma.queueEntry.findUnique({
    where: { id: sourceEntryId },
    include: { queue: { include: { service: { include: { location: true } } } } },
  });
  if (!source) throw new TransferError('Entry not found', 404, 'NOT_FOUND');
  const sourceOpen = source.status === 'WAITING' || source.status === 'SERVING';
  if (opts.requireOpenSource && !sourceOpen) {
    throw new TransferError(`An entry that is ${source.status} can’t be transferred`, 409, 'INVALID_TRANSITION');
  }

  const target = await getOrCreateQueueForDate(toServiceId);
  if (!target) throw new TransferError('Target service not found', 404, 'NOT_FOUND');
  const targetLocation = await prisma.location.findUnique({ where: { id: target.service.locationId } });
  if (!targetLocation || targetLocation.organizationId !== source.queue.service.location.organizationId) {
    throw new TransferError('Target service not found', 404, 'NOT_FOUND');
  }
  if (!target.service.isActive) throw new TransferError('That service is not active', 400, 'QUEUE_CLOSED');
  if (target.queue.status !== 'ACTIVE') {
    throw new TransferError(`The ${target.service.name} queue isn’t taking anyone right now`, 400, 'QUEUE_CLOSED');
  }

  if (opts.completeSource && sourceOpen) {
    const done = await prisma.queueEntry.updateMany({
      where: { id: source.id, status: { in: ['WAITING', 'SERVING'] } },
      data: { status: 'SERVED', completedAt: new Date(), notes: `Transferred to ${target.service.name}` },
    });
    if (done.count !== 1 && opts.requireOpenSource) {
      throw new TransferError('The entry changed status before this could be applied', 409, 'INVALID_TRANSITION');
    }
  }

  const sequence = await getNextSequence(prisma, target.queue.id);
  const ticketNumber = generateTicketNumber(target.service.name.charAt(0).toUpperCase(), sequence);
  const lastEntry = await prisma.queueEntry.findFirst({ where: { queueId: target.queue.id }, orderBy: { sortOrder: 'desc' } });
  const sentBy: SentBy | null =
    opts.sentBy !== undefined
      ? opts.sentBy
      : opts.origin?.type === 'integration'
        ? 'integration'
        : opts.origin?.type === 'system'
          ? null
          : opts.actorUserId
            ? 'staff'
            : null;
  // Back to a service they've already been to this visit (say, back to the
  // doctor with lab results): they return to the desk that saw them.
  const deskInstanceId = await lastDeskInJourney(source.journeyId, toServiceId);

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
      awaitingClearance: !!target.service.requiresClearance && !opts.cleared,
      sentBy,
      deskInstanceId,
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
    data: { ...(opts.data ?? {}), fromEntryId: source.id, fromServiceId: source.queue.serviceId, toServiceId },
  });
  await afterQueueChange(source.queueId);
  await afterQueueChange(target.queue.id);

  return { entry: newEntry, queue: target.queue, service: target.service };
}

// ---------------------------------------------------------------------------
// Pausing and resuming a queue
// ---------------------------------------------------------------------------

export type QueueStatusValue = 'ACTIVE' | 'PAUSED' | 'CLOSED';

/**
 * Sets a queue's status, for staff and for Klargy Connect alike. Only the
 * call that actually changes it does anything else: sockets, the event
 * (queue.paused / queue.resumed, or queue.status_changed for closing), and
 * on a pause one message to everyone waiting. Returns whether it changed.
 */
export async function setQueueStatus(
  queueId: string,
  status: QueueStatusValue,
  ctx: { actorUserId?: string | null; origin?: EventOrigin; reason?: string | null; message?: string | null } = {}
): Promise<{ changed: boolean; previous: QueueStatusValue | null }> {
  const before = await prisma.queue.findUnique({
    where: { id: queueId },
    select: {
      status: true,
      serviceId: true,
      service: { select: { id: true, name: true, location: { select: { id: true, name: true, organizationId: true } } } },
    },
  });
  if (!before) return { changed: false, previous: null };
  if (before.status === status) return { changed: false, previous: before.status };

  const pausedAt = new Date();
  // Conditional on the old status, so two callers can't both "pause" it and
  // patients hear about each pause once.
  const updated = await prisma.queue.updateMany({ where: { id: queueId, status: before.status }, data: { status } });
  if (updated.count !== 1) return { changed: false, previous: before.status };

  const { service } = before;
  const updateData = { queueId, action: 'status_changed', status };
  emitToQueue(queueId, SOCKET_EVENTS.QUEUE_UPDATED, updateData);
  emitToLocation(service.location.id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);

  const reason = ctx.reason ?? null;
  if (status === 'CLOSED') {
    await recordQueueEvent({ action: 'queue.status_changed', actorUserId: ctx.actorUserId, origin: ctx.origin, queueId, data: { status } });
  } else {
    const origin: EventOrigin = ctx.origin ?? (ctx.actorUserId ? ORIGIN.staff : ORIGIN.system);
    await recordQueueEvent({
      action: status === 'PAUSED' ? 'queue.paused' : 'queue.resumed',
      actorUserId: ctx.actorUserId,
      origin,
      queueId,
      organizationId: service.location.organizationId,
      data: { status, previousStatus: before.status, ...(reason ? { reason } : {}) },
      payload: {
        queueId,
        service: { id: service.id, name: service.name },
        location: { id: service.location.id, name: service.location.name },
        reason,
      },
      refSubject: { service: service.id, location: service.location.id },
    });
  }

  if (status === 'PAUSED') {
    try {
      const waiting = await prisma.queueEntry.findMany({ where: { queueId, status: 'WAITING' }, select: { id: true } });
      for (const entry of waiting) {
        await notifyEntry(entry.id, 'QUEUE_DELAYED', { text: ctx.message ?? null, since: pausedAt }).catch((e) =>
          console.error('pause notification failed:', e)
        );
      }
    } catch (error) {
      console.error('pause notifications failed:', error);
    }
  }
  return { changed: true, previous: before.status };
}
