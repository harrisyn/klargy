import prisma from '../lib/prisma';
import { emitToQueue, emitToLocation, emitToQueueAndLocation, SOCKET_EVENTS } from '../lib/realtime';
import { generateTicketNumber, getNextSequence } from '../utils/ticket';
import { checkLimit } from '../middleware/subscription.middleware';
import { WAITING_ORDER, computePosition } from './notifications.service';
import {
  recordQueueEvent,
  startJourney,
  closeJourneyIfDone,
  afterQueueChange,
  afterEntryCalled,
  transferEntryToService,
  TransferError,
  EventOrigin,
} from './queueEvents.service';

/**
 * The queue moves staff make (join, call, serve, cancel, no-show), shared by
 * the staff API and Klargy Connect so both get the same limits, sockets,
 * journeys, notifications, service flows and events.
 */

export type ActionErrorCode =
  | 'NOT_FOUND'
  | 'QUEUE_CLOSED'
  | 'LIMIT_REACHED'
  | 'ALREADY_IN_QUEUE'
  | 'INVALID_SERVICE_POINT'
  | 'NOT_WAITING'
  | 'INVALID_TRANSITION';

/** A refusal; `body` is exactly what the staff API has always sent. */
export class QueueActionError extends Error {
  constructor(public status: number, public code: ActionErrorCode, public body: Record<string, unknown>) {
    super(String(body.message ?? body.error));
  }
}

export interface ActionContext {
  actorUserId?: string | null;
  /** Defaults to staff when there's an actor, else system. */
  origin?: EventOrigin;
  /** Extra fields for the event (audit log and webhook data). */
  data?: Record<string, unknown>;
}

type EntryStatus = 'WAITING' | 'SERVING' | 'SERVED' | 'CANCELLED' | 'NO_SHOW';

const minutesSince = (from: Date | null | undefined) =>
  from ? Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000)) : undefined;

const getLocationIdFromQueue = async (queueId: string): Promise<string | null> => {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    include: { service: { select: { locationId: true } } },
  });
  return queue?.service?.locationId || null;
};

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export async function joinQueueEntry(
  queueId: string,
  input: { userId: string; priority?: number; notes?: string | null; journeyId?: string | null },
  ctx: ActionContext = {},
  hooks: { beforeEvent?: (entryId: string) => Promise<void> } = {}
) {
  const { userId, priority, notes } = input;
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    include: { service: { include: { location: true } } },
  });
  if (!queue) throw new QueueActionError(404, 'NOT_FOUND', { error: 'Queue not found' });
  if (queue.status !== 'ACTIVE') throw new QueueActionError(400, 'QUEUE_CLOSED', { error: 'Queue is not active' });

  const organizationId = queue.service.location.organizationId;
  const [dailyCheck, periodCheck] = await Promise.all([
    checkLimit(organizationId, 'queueEntriesDaily'),
    checkLimit(organizationId, 'queueEntriesPeriod'),
  ]);
  if (!dailyCheck.allowed) {
    throw new QueueActionError(403, 'LIMIT_REACHED', {
      error: 'Limit reached',
      message: `This location has reached its daily queue entry limit (${dailyCheck.limit}). Please try again tomorrow.`,
      limitType: 'queueEntriesDaily',
      current: dailyCheck.current,
      limit: dailyCheck.limit,
    });
  }
  if (!periodCheck.allowed) {
    throw new QueueActionError(403, 'LIMIT_REACHED', {
      error: 'Limit reached',
      message: `This organization has reached its queue entry limit for the current billing period (${periodCheck.limit}).`,
      limitType: 'queueEntriesPeriod',
      current: periodCheck.current,
      limit: periodCheck.limit,
    });
  }

  const existingEntry = await prisma.queueEntry.findFirst({
    where: { queueId, userId, status: { in: ['WAITING', 'SERVING'] } },
  });
  if (existingEntry) {
    throw new QueueActionError(400, 'ALREADY_IN_QUEUE', { error: 'User already in queue', entry: existingEntry });
  }

  const sequence = await getNextSequence(prisma, queueId);
  const ticketNumber = generateTicketNumber(queue.service.name.charAt(0).toUpperCase(), sequence);

  const entry = await prisma.queueEntry.create({
    data: {
      queueId,
      userId,
      ticketNumber,
      priority: priority || 0,
      notes,
      ...(input.journeyId ? { journeyId: input.journeyId } : {}),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, phone: true } },
      queue: { include: { service: true } },
    },
  });
  if (input.journeyId) {
    // Joining a journey already under way (Connect: a later service in the same visit).
    await prisma.customerJourney.update({
      where: { id: input.journeyId },
      data: { queueEntryIds: { push: entry.id }, completedAt: null, totalDuration: null },
    });
  }

  // Position in the same order staff call people
  const position = Math.max(0, (await computePosition(queueId, entry.id)) - 1) + 1;

  const updateData = { queueId, action: 'joined', entry: { ...entry, position } };
  emitToQueue(queueId, SOCKET_EVENTS.QUEUE_UPDATED, updateData);
  emitToLocation(queue.service.location.id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);

  await startJourney(entry.id);
  if (hooks.beforeEvent) await hooks.beforeEvent(entry.id);
  await recordQueueEvent({ action: 'entry.joined', actorUserId: ctx.actorUserId, origin: ctx.origin, queueId, entryId: entry.id });
  await afterQueueChange(queueId);

  return { entry, position };
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

/**
 * Calls the next person waiting (or `entryId`), optionally to a desk.
 * Claims atomically: two desks pressing "Call next" together must not get
 * the same person. The conditional update only succeeds for one of them;
 * the other moves on to the next in line.
 */
export async function callEntry(
  queueId: string,
  input: { servicePointInstanceId?: string | null; entryId?: string | null },
  ctx: ActionContext = {}
) {
  const { servicePointInstanceId } = input;
  const queue = await prisma.queue.findUnique({ where: { id: queueId }, select: { serviceId: true } });
  if (!queue) throw new QueueActionError(404, 'NOT_FOUND', { error: 'Queue not found' });

  if (servicePointInstanceId) {
    const instance = await prisma.servicePointInstance.findUnique({
      where: { id: servicePointInstanceId },
      include: { servicePointService: { include: { servicePoint: true } } },
    });
    if (!instance || !instance.isActive) {
      throw new QueueActionError(400, 'INVALID_SERVICE_POINT', { error: 'Invalid or inactive service point instance' });
    }
    if (!instance.servicePointService.servicePoint.isActive || !instance.servicePointService.isActive) {
      throw new QueueActionError(400, 'INVALID_SERVICE_POINT', { error: 'Invalid or inactive service point' });
    }
    if (instance.servicePointService.serviceId !== queue.serviceId) {
      throw new QueueActionError(400, 'INVALID_SERVICE_POINT', { error: 'Service point instance is not authorized for this service' });
    }
  }

  const requestedEntryId = input.entryId ? String(input.entryId) : null;
  let claimedId: string | null = null;
  for (let attempt = 0; attempt < 5 && !claimedId; attempt++) {
    const candidate = await prisma.queueEntry.findFirst({
      where: { queueId, status: 'WAITING', ...(requestedEntryId ? { id: requestedEntryId } : {}) },
      orderBy: WAITING_ORDER,
      select: { id: true, joinedAt: true },
    });
    if (!candidate) break;
    const claimed = await prisma.queueEntry.updateMany({
      where: { id: candidate.id, status: 'WAITING' },
      data: {
        status: 'SERVING',
        calledAt: new Date(),
        waitDuration: minutesSince(candidate.joinedAt),
        servicePointInstanceId: servicePointInstanceId || null,
      },
    });
    if (claimed.count === 1) claimedId = candidate.id;
    else if (requestedEntryId) break;
  }

  if (!claimedId) {
    throw new QueueActionError(404, 'NOT_WAITING', {
      error: requestedEntryId ? 'They’ve already been called, or have left the queue.' : 'Nobody is waiting.',
    });
  }

  const entry = await prisma.queueEntry.findUniqueOrThrow({
    where: { id: claimedId },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, phone: true } },
      servicePointInstance: { include: { servicePointService: { include: { servicePoint: true } } } },
    },
  });

  const servicePoint = entry.servicePointInstance?.servicePointService?.servicePoint ?? null;

  const locationId = await getLocationIdFromQueue(queueId);
  emitToQueueAndLocation(queueId, locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, {
    queueId,
    entryId: entry.id,
    status: 'SERVING',
    entry: { ...entry, servicePoint },
    servicePoint,
    servicePointInstance: entry.servicePointInstance,
  });

  await recordQueueEvent({
    action: 'entry.called',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId,
    entryId: entry.id,
    data: { servicePointId: servicePoint?.id ?? null, servicePointInstanceId: servicePointInstanceId || null },
  });
  await afterEntryCalled(
    entry.id,
    entry.servicePointInstance?.displayName ||
      (servicePoint
        ? [servicePoint.displayName || servicePoint.name, entry.servicePointInstance?.instanceNumber].filter(Boolean).join(' ')
        : null)
  );
  await afterQueueChange(queueId);

  return { entry, servicePoint };
}

// ---------------------------------------------------------------------------
// Serve, cancel, no-show
// ---------------------------------------------------------------------------

/**
 * Writes a finishing status. Staff may finish an entry from any status; a
 * caller passing `onlyFrom` gets the write only if the entry is still in one
 * of those statuses (INVALID_TRANSITION otherwise), so a race can't
 * overwrite someone else's move.
 */
async function finishEntry<T>(
  entryId: string,
  data: Record<string, unknown>,
  onlyFrom: EntryStatus[] | undefined,
  write: () => Promise<T>,
  read: () => Promise<T>
): Promise<T> {
  if (!onlyFrom) return write();
  const updated = await prisma.queueEntry.updateMany({ where: { id: entryId, status: { in: onlyFrom } }, data });
  if (updated.count !== 1) {
    throw new QueueActionError(409, 'INVALID_TRANSITION', { error: 'The entry changed status before this could be applied' });
  }
  return read();
}

/** Marks an entry served, then runs the service's auto-transfer flow. */
export async function serveEntry(
  queueId: string,
  entryId: string,
  ctx: ActionContext = {},
  opts: { onlyFrom?: EntryStatus[] } = {}
) {
  const existingEntry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    select: { calledAt: true, servedAt: true },
  });

  // Service duration in minutes
  let serviceDuration: number | undefined;
  if (existingEntry?.calledAt) {
    serviceDuration = Math.round((new Date().getTime() - new Date(existingEntry.calledAt).getTime()) / 60000);
  }

  const data = { status: 'SERVED' as const, servedAt: new Date(), completedAt: new Date(), serviceDuration };
  const include = {
    user: { select: { id: true, firstName: true, lastName: true } },
    queue: { include: { service: true } },
  };
  const entry = await finishEntry(
    entryId,
    data,
    opts.onlyFrom,
    () => prisma.queueEntry.update({ where: { id: entryId }, data, include }),
    () => prisma.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include })
  );

  const locationId = await getLocationIdFromQueue(queueId);
  emitToQueueAndLocation(queueId, locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, {
    queueId,
    entryId: entry.id,
    status: 'SERVED',
    entry,
  });

  await recordQueueEvent({
    action: 'entry.served',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId,
    entryId: entry.id,
    data: ctx.data,
  });

  // Auto-transfer to the next service if a flow says so
  const serviceFlow = await prisma.serviceFlow.findFirst({
    where: { fromServiceId: entry.queue.serviceId, autoTransfer: true },
    orderBy: { priority: 'asc' },
  });
  let transferred: Awaited<ReturnType<typeof transferEntryToService>> | null = null;
  if (serviceFlow) {
    try {
      transferred = await transferEntryToService(entry.id, serviceFlow.toServiceId, {
        actorUserId: ctx.actorUserId,
        origin: { type: 'system' },
      });
    } catch (err) {
      if (!(err instanceof TransferError)) throw err;
      // Target queue closed/inactive: the patient is still served here.
    }
  }
  await closeJourneyIfDone(entry.id, ctx);
  await afterQueueChange(queueId);

  return { entry, transferred };
}

/** Cancels an entry or marks it a no-show. */
export async function endEntry(
  queueId: string,
  entryId: string,
  status: 'CANCELLED' | 'NO_SHOW',
  ctx: ActionContext = {},
  opts: { onlyFrom?: EntryStatus[] } = {}
) {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { service: { select: { locationId: true } } },
  });

  const data = { status, completedAt: new Date() };
  const entry = await finishEntry(
    entryId,
    data,
    opts.onlyFrom,
    () => prisma.queueEntry.update({ where: { id: entryId }, data }),
    () => prisma.queueEntry.findUniqueOrThrow({ where: { id: entryId } })
  );

  const updateData = { queueId, entryId: entry.id, status };
  emitToQueue(queueId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, updateData);
  if (queue?.service?.locationId) {
    emitToLocation(queue.service.locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, updateData);
  }

  await recordQueueEvent({
    action: status === 'CANCELLED' ? 'entry.cancelled' : 'entry.no_show',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId,
    entryId: entry.id,
    data: ctx.data,
  });
  await closeJourneyIfDone(entry.id, ctx);
  await afterQueueChange(queueId);

  return entry;
}
