import prisma from '../lib/prisma';
import { emitToQueue, emitToLocation, emitToQueueAndLocation, SOCKET_EVENTS } from '../lib/realtime';
import { generateTicketNumber, getNextSequence } from '../utils/ticket';
import { checkLimit } from '../middleware/subscription.middleware';
import { CALLABLE_WHERE, computePosition, waitingLine } from './notifications.service';
import type { BookedFields } from './bookedArrival.service';
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
  | 'INVALID_TRANSITION'
  | 'AWAITING_CLEARANCE';

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

/** Refuses a new ticket (403 LIMIT_REACHED) once the plan's daily or
 * billing-period entry limit is reached. */
export async function checkEntryLimits(organizationId: string) {
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
}

export async function joinQueueEntry(
  queueId: string,
  input: {
    userId: string;
    priority?: number;
    notes?: string | null;
    journeyId?: string | null;
    /** Payment already settled: skip the service's clearance gate. */
    cleared?: boolean;
    /** A booked patient checking in: their appointment and place in line. */
    booked?: BookedFields | null;
  },
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

  await checkEntryLimits(queue.service.location.organizationId);

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
      awaitingClearance: !!queue.service.requiresClearance && !input.cleared,
      ...(input.journeyId ? { journeyId: input.journeyId } : {}),
      ...(input.booked ?? {}),
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

  // Position in the same order staff call people (none while awaiting payment)
  const position = entry.awaitingClearance ? null : Math.max(0, (await computePosition(queueId, entry.id)) - 1) + 1;

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
  if (requestedEntryId) {
    // A chosen patient may be on hold (calling them resumes them), but not
    // one still waiting for payment.
    const chosen = await prisma.queueEntry.findFirst({
      where: { id: requestedEntryId, queueId, status: 'WAITING' },
      select: { awaitingClearance: true },
    });
    if (chosen?.awaitingClearance) {
      throw new QueueActionError(409, 'AWAITING_CLEARANCE', { error: 'They can’t be called until their payment is cleared.', code: 'AWAITING_CLEARANCE' });
    }
  }
  const reservedElsewhere = requestedEntryId ? [] : await entriesReservedForOtherDesks(queueId, servicePointInstanceId || null);
  let claimedId: string | null = null;
  let wasHeld = false;
  for (let attempt = 0; attempt < 5 && !claimedId; attempt++) {
    const select = { id: true, joinedAt: true, calledAt: true, heldAt: true };
    let candidate: { id: string; joinedAt: Date; calledAt: Date | null; heldAt: Date | null } | null;
    if (requestedEntryId) {
      candidate = await prisma.queueEntry.findFirst({ where: { id: requestedEntryId, queueId, status: 'WAITING', awaitingClearance: false }, select });
    } else {
      // Someone returning to this desk goes first, then the line (in the
      // shared line order, with booked patients placed by booked time).
      const line = await waitingLine(queueId);
      candidate =
        (servicePointInstanceId ? line.find((e) => e.deskInstanceId === servicePointInstanceId) : undefined) ??
        line.find((e) => !reservedElsewhere.includes(e.id)) ??
        null;
    }
    if (!candidate) break;
    const claimed = await prisma.queueEntry.updateMany({
      where: { id: candidate.id, status: 'WAITING', awaitingClearance: false },
      data: {
        status: 'SERVING',
        // A resumed entry keeps its first call time and wait.
        ...(candidate.heldAt && candidate.calledAt ? {} : { calledAt: new Date(), waitDuration: minutesSince(candidate.joinedAt) }),
        servicePointInstanceId: servicePointInstanceId || null,
        heldAt: null,
        deskInstanceId: null,
      },
    });
    if (claimed.count === 1) {
      claimedId = candidate.id;
      wasHeld = !!candidate.heldAt;
    } else if (requestedEntryId) break;
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
    action: wasHeld ? 'entry.resumed' : 'entry.called',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId,
    entryId: entry.id,
    data: { ...(ctx.data ?? {}), servicePointId: servicePoint?.id ?? null, servicePointInstanceId: servicePointInstanceId || null },
  });
  await afterEntryCalled(
    entry.id,
    entry.servicePointInstance?.displayName ||
      (servicePoint
        ? [servicePoint.displayName || servicePoint.name, entry.servicePointInstance?.instanceNumber].filter(Boolean).join(' ')
        : null),
    // Called back after a hold: tell them again.
    wasHeld ? new Date(Date.now() - 1000) : undefined
  );
  await afterQueueChange(queueId);

  return { entry, servicePoint, resumed: wasHeld };
}

/** Waiting entries that belong with another desk someone is signed in to
 * (put on hold there, or returning to it): call next elsewhere skips them. */
async function entriesReservedForOtherDesks(queueId: string, deskId: string | null): Promise<string[]> {
  const reserved = await prisma.queueEntry.findMany({
    where: { queueId, ...CALLABLE_WHERE, deskInstanceId: { not: null } },
    select: { id: true, deskInstanceId: true },
  });
  const others = (reserved ?? []).filter((r) => r.deskInstanceId !== deskId);
  if (others.length === 0) return [];
  const occupied = await prisma.servicePointInstance.findMany({
    where: { id: { in: [...new Set(others.map((r) => r.deskInstanceId!))] }, isOccupied: true, isActive: true },
    select: { id: true },
  });
  const taken = new Set((occupied ?? []).map((d) => d.id));
  return others.filter((r) => taken.has(r.deskInstanceId!)).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Hold and clearance
// ---------------------------------------------------------------------------

/**
 * Puts the person being served on hold: they leave the desk (which is free
 * for the next person), stay at the front of the line, and aren't picked by
 * call next. Calling them (resume, or call a chosen patient) brings them
 * back; by default to the same desk. Returns whether anything changed.
 */
export async function holdEntry(entryId: string, ctx: ActionContext = {}): Promise<{ changed: boolean }> {
  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    select: { id: true, queueId: true, status: true, heldAt: true, servicePointInstanceId: true },
  });
  if (!entry) throw new QueueActionError(404, 'NOT_FOUND', { error: 'Entry not found' });
  if (entry.status === 'WAITING' && entry.heldAt) return { changed: false };
  if (entry.status !== 'SERVING') {
    throw new QueueActionError(409, 'INVALID_TRANSITION', { error: 'Only someone being served can be put on hold.' });
  }
  const held = await prisma.queueEntry.updateMany({
    where: { id: entryId, status: 'SERVING' },
    data: { status: 'WAITING', heldAt: new Date(), deskInstanceId: entry.servicePointInstanceId, servicePointInstanceId: null },
  });
  if (held.count !== 1) {
    throw new QueueActionError(409, 'INVALID_TRANSITION', { error: 'The entry changed status before this could be applied' });
  }
  const locationId = await getLocationIdFromQueue(entry.queueId);
  emitToQueueAndLocation(entry.queueId, locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, {
    queueId: entry.queueId, entryId, status: 'WAITING', action: 'held',
  });
  await recordQueueEvent({
    action: 'entry.held',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId: entry.queueId,
    entryId,
    data: { ...(ctx.data ?? {}), servicePointInstanceId: entry.servicePointInstanceId },
  });
  await afterQueueChange(entry.queueId);
  return { changed: true };
}

/** Calls a held entry back: to `servicePointInstanceId` when given, else
 * the desk it was held at (if that desk is still open for the service). */
export async function resumeEntry(entryId: string, input: { servicePointInstanceId?: string | null }, ctx: ActionContext = {}) {
  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    select: { id: true, queueId: true, status: true, heldAt: true, deskInstanceId: true },
  });
  if (!entry) throw new QueueActionError(404, 'NOT_FOUND', { error: 'Entry not found' });
  if (entry.status === 'SERVING') return { changed: false };
  if (entry.status !== 'WAITING' || !entry.heldAt) {
    throw new QueueActionError(409, 'INVALID_TRANSITION', { error: 'Only someone on hold can be resumed.' });
  }
  let desk = input.servicePointInstanceId ?? null;
  if (!desk && entry.deskInstanceId) {
    const held = await prisma.servicePointInstance.findUnique({ where: { id: entry.deskInstanceId }, select: { isActive: true } });
    desk = held?.isActive ? entry.deskInstanceId : null;
  }
  try {
    await callEntry(entry.queueId, { entryId, servicePointInstanceId: desk }, ctx);
  } catch (error) {
    // The old desk no longer serves this service: call them without one.
    if (!(error instanceof QueueActionError) || error.code !== 'INVALID_SERVICE_POINT' || input.servicePointInstanceId) throw error;
    await callEntry(entry.queueId, { entryId, servicePointInstanceId: null }, ctx);
  }
  return { changed: true };
}

/**
 * Clears the payment gate: the entry joins the line (by when they arrived)
 * and can be called. Returns whether anything changed.
 */
export async function clearEntry(entryId: string, ctx: ActionContext = {}): Promise<{ changed: boolean }> {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, select: { id: true, queueId: true, awaitingClearance: true } });
  if (!entry) throw new QueueActionError(404, 'NOT_FOUND', { error: 'Entry not found' });
  if (!entry.awaitingClearance) return { changed: false };
  const cleared = await prisma.queueEntry.updateMany({ where: { id: entryId, awaitingClearance: true }, data: { awaitingClearance: false } });
  if (cleared.count !== 1) return { changed: false };
  const locationId = await getLocationIdFromQueue(entry.queueId);
  emitToQueueAndLocation(entry.queueId, locationId, SOCKET_EVENTS.QUEUE_UPDATED, { queueId: entry.queueId, entryId, action: 'cleared' });
  await recordQueueEvent({
    action: 'entry.cleared',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId: entry.queueId,
    entryId,
    data: ctx.data,
  });
  await afterQueueChange(entry.queueId);
  return { changed: true };
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

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Changes an open entry's priority, which moves it in the waiting line.
 * Returns the previous priority, or null when nothing changed (same value).
 */
export async function setEntryPriority(entryId: string, priority: number, ctx: ActionContext = {}) {
  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    select: { id: true, queueId: true, status: true, priority: true },
  });
  if (!entry) throw new QueueActionError(404, 'NOT_FOUND', { error: 'Entry not found' });
  if (entry.priority === priority) return { previousPriority: null };
  const updated = await prisma.queueEntry.updateMany({
    where: { id: entryId, status: { in: ['WAITING', 'SERVING'] } },
    data: { priority },
  });
  if (updated.count !== 1) {
    throw new QueueActionError(409, 'INVALID_TRANSITION', { error: 'The entry changed status before this could be applied' });
  }

  const locationId = await getLocationIdFromQueue(entry.queueId);
  emitToQueueAndLocation(entry.queueId, locationId, SOCKET_EVENTS.QUEUE_UPDATED, {
    queueId: entry.queueId,
    entryId,
    action: 'reordered',
  });
  await recordQueueEvent({
    action: 'entry.priority_changed',
    actorUserId: ctx.actorUserId,
    origin: ctx.origin,
    queueId: entry.queueId,
    entryId,
    data: { ...(ctx.data ?? {}), priority, previousPriority: entry.priority },
  });
  await afterQueueChange(entry.queueId);
  return { previousPriority: entry.priority };
}
