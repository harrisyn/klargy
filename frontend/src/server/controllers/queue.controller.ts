import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { screenName } from '../lib/screenName';
import { estimateWaitMinutes } from '../services/waitEstimate';
import { emitToQueue, emitToService, emitToLocation, emitToQueueAndLocation, SOCKET_EVENTS } from '../lib/realtime';
import { generateTicketNumber, getNextSequence, generateQRData } from '../utils/ticket';
import { getStartOfDay, startOfLocalDate, validTimeZone } from '../utils/date';
import { v4 as uuidv4 } from 'uuid';
import { CALLABLE_WHERE, WAITING_ORDER, computePosition, notifyEntry } from '../services/notifications.service';
import { recordWhatsAppOptIn } from '../services/whatsapp/webhook';
import {
  recordQueueEvent,
  startJourney,
  closeJourneyIfDone,
  afterQueueChange,
  afterEntryCalled,
  transferEntryToService,
  TransferError,
  setQueueStatus,
  getOrCreateQueueForDate,
  journeySteps,
  serviceTimeZone,
  ORIGIN,
} from '../services/queueEvents.service';
import {
  joinQueueEntry,
  callEntry,
  serveEntry,
  endEntry,
  holdEntry,
  resumeEntry,
  clearEntry,
  QueueActionError,
} from '../services/queueActions.service';
import { successorOf } from './publicJourney.controller';
import { staffNamesFor } from '../services/displayStaff';
import { LookupError, joinIdentifierFor, locationRefFor, lookupPatient } from '../services/connectLookup.service';

const actorId = (req: Request) => req.user?.userId ?? null;
const minutesSince = (from: Date | null | undefined) =>
  from ? Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000)) : undefined;

// Helper to get locationId from a queue
const getLocationIdFromQueue = async (queueId: string): Promise<string | null> => {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    include: { service: { select: { locationId: true } } }
  });
  return queue?.service?.locationId || null;
};

// Create or get queue for a service on a specific date
export const createQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, date } = req.body;
    const tz = await serviceTimeZone(serviceId);
    const result = await getOrCreateQueueForDate(serviceId, date ? startOfLocalDate(String(date), tz) : new Date());
    if (!result) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const queue = await prisma.queue.findUniqueOrThrow({ where: { id: result.queue.id }, include: { slots: true } });

    res.status(201).json(queue);
  } catch (error) {
    next(error);
  }
};

// Get queue status with entries
export const getQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const queue = await prisma.queue.findUnique({
      where: { id },
      include: {
        service: {
          include: { location: true },
        },
        slots: {
          orderBy: { startTime: 'asc' },
        },
        entries: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: [{ priority: 'desc' }, { joinedAt: 'asc' }],
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, phone: true },
            },
          },
        },
      },
    });

    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    // Calculate queue stats
    const waiting = queue.entries.filter(e => e.status === 'WAITING').length;
    const serving = queue.entries.filter(e => e.status === 'SERVING').length;
    const served = queue.entries.filter(e => e.status === 'SERVED').length;

    res.json({
      ...queue,
      stats: { waiting, serving, served, total: queue.entries.length },
    });
  } catch (error) {
    next(error);
  }
};

// Get queues for a service
export const getServiceQueues = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;
    const { date } = req.query;

    const whereClause: any = { serviceId };
    if (date) {
      whereClause.date = new Date(date as string);
    }

    const queues = await prisma.queue.findMany({
      where: whereClause,
      include: {
        _count: { select: { entries: true, slots: true } },
      },
      orderBy: { date: 'desc' },
    });

    res.json(queues);
  } catch (error) {
    next(error);
  }
};

// Join queue - add user to queue
export const joinQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, priority, notes } = req.body;
    const { entry, position } = await joinQueueEntry(req.params.id, { userId, priority, notes }, { actorUserId: actorId(req) });
    res.status(201).json({
      ...entry,
      position,
      qrData: generateQRData(entry),
    });
  } catch (error) {
    if (error instanceof QueueActionError) return res.status(error.status).json(error.body);
    next(error);
  }
};

// Call next in queue (mark as serving)
export const callNext = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // Claim atomically (see callNextWithServicePoint).
    let claimedId: string | null = null;
    for (let attempt = 0; attempt < 5 && !claimedId; attempt++) {
      const candidate = await prisma.queueEntry.findFirst({
        where: { queueId: id, ...CALLABLE_WHERE },
        orderBy: WAITING_ORDER,
        select: { id: true, joinedAt: true },
      });
      if (!candidate) break;
      const claimed = await prisma.queueEntry.updateMany({
        where: { id: candidate.id, ...CALLABLE_WHERE },
        data: { status: 'SERVING', calledAt: new Date(), waitDuration: minutesSince(candidate.joinedAt), deskInstanceId: null },
      });
      if (claimed.count === 1) claimedId = candidate.id;
    }

    if (!claimedId) {
      return res.status(404).json({ error: 'Nobody is waiting.' });
    }

    const entry = await prisma.queueEntry.findUniqueOrThrow({
      where: { id: claimedId },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
      },
    });

    // Emit real-time update to both queue and location rooms
    const locationId = await getLocationIdFromQueue(id);
    emitToQueueAndLocation(id, locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, {
      queueId: id,
      entryId: entry.id,
      status: 'SERVING',
      entry,
    });

    await recordQueueEvent({ action: 'entry.called', actorUserId: actorId(req), queueId: id, entryId: entry.id });
    await afterEntryCalled(entry.id);
    await afterQueueChange(id);

    res.json(entry);
  } catch (error) {
    next(error);
  }
};

// Mark entry as served
export const markServed = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, entryId } = req.params;
    const { entry } = await serveEntry(id, entryId, { actorUserId: actorId(req) });
    res.json(entry);
  } catch (error) {
    next(error);
  }
};

// Cancel queue entry
export const cancelEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, entryId } = req.params;
    res.json(await endEntry(id, entryId, 'CANCELLED', { actorUserId: actorId(req) }));
  } catch (error) {
    next(error);
  }
};

// Mark as no-show
export const markNoShow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, entryId } = req.params;
    res.json(await endEntry(id, entryId, 'NO_SHOW', { actorUserId: actorId(req) }));
  } catch (error) {
    next(error);
  }
};

// Move entry to different queue (manual transfer)
export const moveEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entryId, targetQueueId, priority } = req.body;

    const targetQueue = await prisma.queue.findUnique({ where: { id: targetQueueId }, select: { serviceId: true } });
    if (!targetQueue) {
      return res.status(404).json({ error: 'Target queue not found' });
    }

    const { entry } = await transferEntryToService(entryId, targetQueue.serviceId, {
      actorUserId: actorId(req),
      priority,
      completeSource: true,
    });
    res.json(entry);
  } catch (error) {
    if (error instanceof TransferError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

// Send an entry (typically one just served) on to another service.
export const transferEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entryId } = req.params;
    const { serviceId, priority } = req.body;
    if (!serviceId) return res.status(400).json({ error: 'serviceId is required' });

    const result = await transferEntryToService(entryId, serviceId, {
      actorUserId: actorId(req),
      priority,
      completeSource: true,
    });
    res.status(201).json({
      entry: result.entry,
      ticketNumber: result.entry.ticketNumber,
      serviceName: result.service.name,
      queueId: result.queue.id,
    });
  } catch (error) {
    if (error instanceof TransferError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

const actionError = (res: Response, error: QueueActionError) => res.status(error.status).json(error.body);

// Put the person being served on hold (the desk is free for the next one).
export const holdQueueEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { changed } = await holdEntry(req.params.entryId, { actorUserId: actorId(req) });
    res.json({ changed });
  } catch (error) {
    if (error instanceof QueueActionError) return actionError(res, error);
    next(error);
  }
};

// Call someone on hold back (to this desk, or the desk they were held at).
export const resumeQueueEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { changed } = await resumeEntry(
      req.params.entryId,
      { servicePointInstanceId: req.body?.servicePointInstanceId || null },
      { actorUserId: actorId(req) }
    );
    res.json({ changed });
  } catch (error) {
    if (error instanceof QueueActionError) return actionError(res, error);
    next(error);
  }
};

// Mark someone waiting for payment as paid, so they can be called.
export const clearQueueEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { changed } = await clearEntry(req.params.entryId, { actorUserId: actorId(req) });
    res.json({ changed });
  } catch (error) {
    if (error instanceof QueueActionError) return actionError(res, error);
    next(error);
  }
};

// Get wait time estimate
export const getWaitTime = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const queue = await prisma.queue.findUnique({
      where: { id },
      include: {
        service: true,
        entries: {
          where: { status: { in: ['WAITING', 'SERVING'] } },
        },
      },
    });

    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    const waiting = queue.entries.filter(e => e.status === 'WAITING').length;
    const slotDuration = queue.service.slotDuration;
    const concurrentLimit = queue.service.concurrentLimit;

    // From how long service actually takes here, across the desks open now
    const estimatedMinutes = await estimateWaitMinutes(queue.service, waiting);

    res.json({
      queueId: id,
      waitingCount: waiting,
      estimatedWaitMinutes: estimatedMinutes,
      slotDuration,
      concurrentLimit,
    });
  } catch (error) {
    next(error);
  }
};

// Update queue status (pause, resume, close)
export const updateQueueStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['ACTIVE', 'PAUSED', 'CLOSED'].includes(status)) {
      return res.status(400).json({ error: 'status must be ACTIVE, PAUSED or CLOSED' });
    }

    // Sockets, events (queue.paused / queue.resumed) and, on a pause, a
    // message to everyone waiting.
    await setQueueStatus(id, status, { actorUserId: actorId(req) });
    const queue = await prisma.queue.findUnique({ where: { id }, include: { service: { select: { locationId: true } } } });
    if (!queue) return res.status(404).json({ error: 'Queue not found' });

    res.json(queue);
  } catch (error) {
    next(error);
  }
};

// Public join queue - creates a guest user and adds to queue (no auth required)
export const publicJoinQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, phone, notes, ...otherFields } = req.body;
    
    // Extract name from various possible fields (supports custom identity field configs)
    const name = req.body.name || req.body.fullName || 
      (req.body.firstName && req.body.lastName ? `${req.body.firstName} ${req.body.lastName}` : null) ||
      req.body.firstName || req.body.customerName || req.body.patientName;

    if (!serviceId || !name) {
      return res.status(400).json({ error: serviceId ? 'Please enter your name so staff can call you.' : 'Please choose a service.' });
    }

    // Get service and verify it's active
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: { location: { include: { organization: { select: { status: true } } } } },
    });

    if (!service || !service.isActive) {
      return res.status(404).json({ error: 'Service not found or inactive' });
    }

    if (service.location.organization.status === 'PAUSED') {
      return res.status(403).json({
        error: 'ORGANIZATION_PAUSED',
        message: 'This queue system is temporarily unavailable. Please check back later.',
      });
    }

    // Today's queue for this service, in the location's own day
    const { queue } = (await getOrCreateQueueForDate(serviceId))!;

    if (queue.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Queue is not accepting new entries at this time' });
    }

    // Generate a unique guest email for this entry
    const guestId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const guestEmail = `${guestId}@guest.qms.local`;

    // Create guest user
    const guestUser = await prisma.user.create({
      data: {
        email: guestEmail,
        password: '', // No password for guest
        firstName: name.split(' ')[0] || name,
        lastName: name.split(' ').slice(1).join(' ') || '',
        phone: phone || null,
        role: 'PATIENT',
        organizationId: service.location.organizationId,
      },
    });
    if (phone && req.body.whatsappOptIn === true) {
      await recordWhatsAppOptIn(service.location.organizationId, phone, 'join_form').catch((e) => console.error('WhatsApp opt-in not saved:', e));
    }

    // Generate ticket number
    const sequence = await getNextSequence(prisma, queue.id);
    const servicePrefix = service.name.charAt(0).toUpperCase();
    const ticketNumber = generateTicketNumber(servicePrefix, sequence);

    // Create queue entry
    const entry = await prisma.queueEntry.create({
      data: {
        queueId: queue.id,
        userId: guestUser.id,
        ticketNumber,
        priority: 0,
        notes: notes || null,
        awaitingClearance: service.requiresClearance,
      },
    });

    // Position in the same order staff call people (0-based here, +1 below)
    const position = Math.max(0, (await computePosition(queue.id, entry.id)) - 1);

    // Estimate wait time (rough: position * average slot duration)
    const estimatedWait = await estimateWaitMinutes(service, position + 1);

    // Emit real-time update to both queue and location rooms
    const updateData = {
      queueId: queue.id,
      action: 'entry_joined',
      entry: { id: entry.id, ticketNumber, status: entry.status },
    };
    emitToQueue(queue.id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);
    emitToLocation(service.location.id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);

    await startJourney(entry.id);
    await recordQueueEvent({ action: 'entry.joined', origin: ORIGIN.public, queueId: queue.id, entryId: entry.id, data: { source: 'public' } });
    await notifyEntry(entry.id, 'QUEUE_JOINED').catch((e) => console.error('join notification failed:', e));
    await afterQueueChange(queue.id);

    res.status(201).json({
      ticketNumber: entry.ticketNumber,
      position: position + 1,
      estimatedWait,
      queueId: queue.id,
      entryId: entry.id,
      serviceName: service.name,
      locationName: service.location.name,
      joinedAt: entry.joinedAt,
      qrData: generateQRData(entry),
    });
  } catch (error) {
    next(error);
  }
};

// Generate ticket with QR code
export const generateTicket = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, entryId } = req.params;

    const entry = await prisma.queueEntry.findUnique({
      where: { id: entryId },
      include: {
        queue: {
          include: {
            service: {
              include: { location: true },
            },
          },
        },
        user: {
          select: { firstName: true, lastName: true },
        },
      },
    });

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    // Position in the same order staff call people (0-based here, +1 below)
    const position = Math.max(0, (await computePosition(id, entry.id)) - 1);

    res.json({
      ticketNumber: entry.ticketNumber,
      position: entry.status === 'WAITING' ? position + 1 : null,
      status: entry.status,
      serviceName: entry.queue.service.name,
      locationName: entry.queue.service.location.name,
      queueDate: entry.queue.date,
      joinedAt: entry.joinedAt,
      qrData: generateQRData(entry),
      userName: `${entry.user.firstName} ${entry.user.lastName}`,
    });
  } catch (error) {
    next(error);
  }
};

// Public status endpoint - no auth required
export const getPublicStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { queueId, entryId } = req.params;

    const entry = await prisma.queueEntry.findUnique({
      where: { id: entryId },
      include: {
        queue: {
          include: {
            service: {
              include: {
                location: {
                  include: {
                    organization: {
                      select: { logoUrl: true, primaryColor: true, hidePoweredBy: true, industry: true, customerLabel: true, customerLabelPlural: true, status: true },
                    },
                  },
                },
              },
            },
            entries: {
              where: { status: { in: ['WAITING', 'SERVING'] } },
              orderBy: [{ priority: 'desc' }, { joinedAt: 'asc' }],
              select: {
                id: true,
                ticketNumber: true,
                status: true,
                priority: true,
                joinedAt: true,
                heldAt: true,
                awaitingClearance: true,
              },
            },
          },
        },
        user: {
          select: { firstName: true, lastName: true },
        },
      },
    });

    if (!entry || entry.queueId !== queueId) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    if (entry.queue.service.location.organization.status === 'PAUSED') {
      return res.status(403).json({
        error: 'ORGANIZATION_PAUSED',
        message: 'This queue system is temporarily unavailable. Please check back later.',
      });
    }

    const queue = entry.queue;
    const allEntries = queue.entries;

    // Find currently serving entry
    const currentlyServing = allEntries.find(e => e.status === 'SERVING');

    // Calculate position for waiting entries
    let position: number | null = null;
    if (entry.status === 'WAITING' && !entry.heldAt && !entry.awaitingClearance) {
      position = allEntries.filter(e => 
        e.status === 'WAITING' && !e.heldAt && !e.awaitingClearance && (
          e.priority > entry.priority ||
          (e.priority === entry.priority && e.joinedAt < entry.joinedAt)
        )
      ).length + 1;
    }

    // Estimate wait time based on position and service configuration
    const slotDuration = queue.service.slotDuration;
    const concurrentLimit = queue.service.concurrentLimit;
    const estimatedWaitTime = position ? await estimateWaitMinutes(queue.service, position) : 0;

    // Count totals
    const waitingCount = allEntries.filter(e => e.status === 'WAITING').length;
    const servingCount = allEntries.filter(e => e.status === 'SERVING').length;

    // What we've told the patient about this ticket (in-app copies only; the
    // email and SMS copies say the same thing). No identity in these.
    const messages = await prisma.notification.findMany({
      where: { queueEntryId: entry.id, channel: 'IN_APP' },
      orderBy: { sentAt: 'desc' },
      take: 20,
      select: { type: true, message: true, sentAt: true },
    });

    // Where they were sent next, and the visit so far (no names).
    const sent = await successorOf(entry.id);
    const journey = (await journeySteps([{ entryId: entry.id, journeyId: entry.journeyId }])).get(entry.journeyId ?? `entry:${entry.id}`) ?? [];

    res.json({
      ticketNumber: entry.ticketNumber,
      status: entry.status,
      held: !!entry.heldAt,
      awaitingClearance: entry.awaitingClearance,
      sentTo: sent
        ? { serviceName: sent.queue.service.name, ticketNumber: sent.ticketNumber, status: sent.status, queueId: sent.queueId, entryId: sent.id }
        : null,
      journey: journey.map(({ entryId: id, ticketNumber, service, status, joinedAt, endedAt }) => ({
        entryId: id, ticketNumber, serviceName: service.name, status, joinedAt, endedAt, current: id === entry.id,
      })),
      queueStatus: queue.status,
      position,
      estimatedWaitTime,
      serviceName: queue.service.name,
      locationName: queue.service.location.name,
      locationAddress: queue.service.location.address,
      organization: queue.service.location.organization,
      currentlyServing: currentlyServing?.ticketNumber || null,
      totalInQueue: waitingCount + servingCount,
      waitingCount,
      servingCount,
      queueId,
      entryId,
      joinedAt: entry.joinedAt,
      calledAt: entry.calledAt,
      userName: `${entry.user.firstName} ${entry.user.lastName}`.trim(),
      messages,
    });
  } catch (error) {
    next(error);
  }
};

// Reorder queue entries (drag-and-drop)
export const reorderEntries = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { entries } = req.body; // Array of { id, sortOrder }

    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'entries must be an array' });
    }

    // Get queue to find locationId
    const queue = await prisma.queue.findUnique({
      where: { id },
      select: { service: { select: { locationId: true } } }
    });

    // Update all entries in a transaction
    await prisma.$transaction(
      entries.map(({ id: entryId, sortOrder }: { id: string; sortOrder: number }) =>
        prisma.queueEntry.update({
          where: { id: entryId },
          data: { sortOrder },
        })
      )
    );

    // Emit update to both queue and location rooms
    const updateData = {
      queueId: id,
      action: 'reordered',
    };
    emitToQueue(id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);
    if (queue?.service?.locationId) {
      emitToLocation(queue.service.locationId, SOCKET_EVENTS.QUEUE_UPDATED, updateData);
    }
    await recordQueueEvent({ action: 'entry.reordered', actorUserId: actorId(req), queueId: id, data: { entries } });
    await afterQueueChange(id);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Call next with service point assignment
export const callNextWithServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entry, servicePoint } = await callEntry(
      req.params.id,
      { servicePointInstanceId: req.body?.servicePointInstanceId, entryId: req.body?.entryId },
      { actorUserId: actorId(req) }
    );
    res.json({ ...entry, servicePoint });
  } catch (error) {
    if (error instanceof QueueActionError) return res.status(error.status).json(error.body);
    next(error);
  }
};

// Get queue entries with enhanced sorting (for operator view)
export const getQueueEntriesForOperator = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const queue = await prisma.queue.findUnique({
      where: { id },
      include: {
        service: {
          include: { 
            location: true,
            flowsFrom: {
              include: {
                toService: {
                  select: { id: true, name: true },
                },
              },
              orderBy: { priority: 'asc' },
            },
          },
        },
        entries: {
          where: { status: { in: ['WAITING', 'SERVING'] } },
          orderBy: [
            { status: 'asc' }, // SERVING first
            { priority: 'desc' },
            { sortOrder: 'asc' },
            { joinedAt: 'asc' },
          ],
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, phone: true },
            },
            servicePointInstance: {
              include: { servicePointService: { include: { servicePoint: true } } },
            },
          },
        },
      },
    });

    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    // Split entries into serving and waiting
    const attachServicePoint = (e: typeof queue.entries[number]) => ({
      ...e,
      servicePoint: e.servicePointInstance?.servicePointService?.servicePoint
        ? {
            id: e.servicePointInstance.servicePointService.servicePoint.id,
            name: e.servicePointInstance.servicePointService.servicePoint.name,
            displayName: e.servicePointInstance.servicePointService.servicePoint.displayName,
          }
        : null,
    });

    const serving = queue.entries.filter(e => e.status === 'SERVING').map(attachServicePoint);
    // On hold first (they keep their place at the front), then the line,
    // then anyone still waiting for payment (not callable yet).
    const rank = (e: typeof queue.entries[number]) => (e.heldAt ? 0 : e.awaitingClearance ? 2 : 1);
    const waiting = queue.entries
      .filter(e => e.status === 'WAITING')
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
      .map(({ e }) => attachServicePoint(e));

    // Get next service suggestions
    const nextServices = queue.service.flowsFrom.map(flow => ({
      serviceId: flow.toService.id,
      serviceName: flow.toService.name,
      displayName: flow.displayName || flow.toService.name,
      isRequired: flow.isRequired,
      autoTransfer: flow.autoTransfer,
    }));

    res.json({
      queue: {
        id: queue.id,
        status: queue.status,
        date: queue.date,
        service: queue.service,
      },
      serving,
      waiting,
      nextServices,
      stats: {
        waiting: waiting.length,
        serving: serving.length,
        total: queue.entries.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Public join with session tracking
/** The service a join with no service chosen goes to: the location's first
 * point of contact (Location.defaultServiceId), when it's set and active. */
export async function defaultServiceFor(locationId: unknown): Promise<string | null> {
  if (typeof locationId !== 'string' || !locationId) return null;
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { defaultServiceId: true } });
  if (!location?.defaultServiceId) return null;
  const service = await prisma.service.findFirst({
    where: { id: location.defaultServiceId, locationId, isActive: true },
    select: { id: true },
  });
  return service?.id ?? null;
}

export const publicJoinQueueWithSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone, notes, sessionId } = req.body;
    // No service chosen (kiosk or QR at the entrance): the location's first
    // point of contact.
    const serviceId: string | null = req.body.serviceId || (await defaultServiceFor(req.body.locationId));
    
    // Extract name from various possible fields (supports custom identity field configs)
    const name = req.body.name || req.body.fullName || 
      (req.body.firstName && req.body.lastName ? `${req.body.firstName} ${req.body.lastName}` : null) ||
      req.body.firstName || req.body.customerName || req.body.patientName;

    if (!serviceId || !name) {
      return res.status(400).json({ error: serviceId ? 'Please enter your name so staff can call you.' : 'Please choose a service.' });
    }

    // Generate session ID if not provided
    const userSessionId = sessionId || uuidv4();

    // Get service and verify it's active
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: { location: { include: { organization: { select: { id: true, status: true, joinIdentifierType: true } } } } },
    });

    if (!service || !service.isActive) {
      return res.status(404).json({ error: 'Service not found or inactive' });
    }

    if (service.location.organization.status === 'PAUSED') {
      return res.status(403).json({
        error: 'ORGANIZATION_PAUSED',
        message: 'This queue system is temporarily unavailable. Please check back later.',
      });
    }

    // Today's queue for this service, in the location's own day
    const { queue } = (await getOrCreateQueueForDate(serviceId))!;

    if (queue.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Queue is not accepting new entries at this time' });
    }

    // "Require an MR or member number to join": the connected EMR checks it.
    // If the EMR can't be reached they still get a ticket, marked unchecked.
    const identity: Record<string, string> = {};
    let identifierNote: string | null = null;
    const required = await joinIdentifierFor(service.location.organization);
    if (required) {
      const value = typeof req.body.identifier === 'string' ? req.body.identifier.trim().slice(0, 100) : '';
      if (!value) return res.status(400).json({ error: `Please enter your ${required.label}.`, code: 'IDENTIFIER_REQUIRED' });
      try {
        const result = await lookupPatient(required.integration, {
          identifierType: required.type,
          identifier: value,
          context: 'public',
          locationRef: await locationRefFor(required.integration.id, service.locationId),
        });
        if (!result.matched) {
          return res.status(422).json({
            error: `We couldn’t find that ${required.label}. Check it and try again, or ask at the front desk.`,
            code: 'IDENTIFIER_NOT_MATCHED',
          });
        }
      } catch (error) {
        if (!(error instanceof LookupError)) throw error;
        identifierNote = `Identifier not verified: the records system couldn’t be reached to check ${required.label} ${value}.`;
      }
      identity[required.type] = value;
    }

    // Generate a unique guest email for this entry
    const guestId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const guestEmail = `${guestId}@guest.qms.local`;

    // Create guest user
    const guestUser = await prisma.user.create({
      data: {
        email: guestEmail,
        password: '', // No password for guest
        firstName: name.split(' ')[0] || name,
        lastName: name.split(' ').slice(1).join(' ') || '',
        phone: phone || null,
        role: 'PATIENT',
        organizationId: service.location.organizationId,
        ...(Object.keys(identity).length ? { identityData: identity } : {}),
      },
    });
    if (phone && req.body.whatsappOptIn === true) {
      await recordWhatsAppOptIn(service.location.organizationId, phone, 'join_form').catch((e) => console.error('WhatsApp opt-in not saved:', e));
    }

    // Generate ticket number
    const sequence = await getNextSequence(prisma, queue.id);
    const servicePrefix = service.name.charAt(0).toUpperCase();
    const ticketNumber = generateTicketNumber(servicePrefix, sequence);

    // Get next sort order
    const lastEntry = await prisma.queueEntry.findFirst({
      where: { queueId: queue.id },
      orderBy: { sortOrder: 'desc' },
    });
    const nextSortOrder = (lastEntry?.sortOrder || 0) + 1;

    // Create queue entry with session
    const entry = await prisma.queueEntry.create({
      data: {
        queueId: queue.id,
        userId: guestUser.id,
        ticketNumber,
        priority: 0,
        sortOrder: nextSortOrder,
        sessionId: userSessionId,
        notes: [notes, identifierNote].filter(Boolean).join('\n') || null,
        awaitingClearance: service.requiresClearance,
      },
    });

    // Position in the same order staff call people (0-based here, +1 below)
    const position = Math.max(0, (await computePosition(queue.id, entry.id)) - 1);

    // Estimate wait time (rough: position * average slot duration)
    const estimatedWait = await estimateWaitMinutes(service, position + 1);

    // Emit real-time update to both queue and location rooms
    const updateData = {
      queueId: queue.id,
      action: 'entry_joined',
      entry: { id: entry.id, ticketNumber, status: entry.status },
    };
    emitToQueue(queue.id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);
    emitToLocation(service.location.id, SOCKET_EVENTS.QUEUE_UPDATED, updateData);

    await startJourney(entry.id);
    await recordQueueEvent({ action: 'entry.joined', origin: ORIGIN.public, queueId: queue.id, entryId: entry.id, data: { source: 'public' } });
    await notifyEntry(entry.id, 'QUEUE_JOINED').catch((e) => console.error('join notification failed:', e));
    await afterQueueChange(queue.id);

    res.status(201).json({
      ticketNumber: entry.ticketNumber,
      position: position + 1,
      estimatedWait,
      queueId: queue.id,
      entryId: entry.id,
      sessionId: userSessionId,
      serviceName: service.name,
      locationName: service.location.name,
      joinedAt: entry.joinedAt,
      qrData: generateQRData(entry),
    });
  } catch (error) {
    next(error);
  }
};

// Get all tickets for a session (for returning users)
export const getSessionTickets = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;

    const entries = await prisma.queueEntry.findMany({
      where: { sessionId },
      include: {
        queue: {
          include: {
            service: {
              include: { location: true },
            },
          },
        },
        user: {
          select: { firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // For each entry, calculate current position if waiting
    const entriesWithPosition = await Promise.all(
      entries.map(async (entry) => {
        let position: number | null = null;
        if (entry.status === 'WAITING') {
          position = await prisma.queueEntry.count({
            where: {
              queueId: entry.queueId,
              status: 'WAITING',
              OR: [
                { sortOrder: { lt: entry.sortOrder } },
                {
                  sortOrder: entry.sortOrder,
                  joinedAt: { lt: entry.joinedAt },
                },
              ],
            },
          }) + 1;
        }

        return {
          id: entry.id,
          ticketNumber: entry.ticketNumber,
          status: entry.status,
          position,
          estimatedWait: position ? await estimateWaitMinutes(entry.queue.service, position) : 0,
          serviceName: entry.queue.service.name,
          locationName: entry.queue.service.location.name,
          queueId: entry.queueId,
          joinedAt: entry.joinedAt,
          calledAt: entry.calledAt,
          servedAt: entry.servedAt,
          userName: `${entry.user.firstName} ${entry.user.lastName}`.trim(),
        };
      })
    );

    res.json(entriesWithPosition);
  } catch (error) {
    next(error);
  }
};

// Complete entry and get next service suggestions
export const completeWithNextSuggestions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, entryId } = req.params;

    const currentQueue = await prisma.queue.findUnique({ where: { id }, select: { serviceId: true } });
    const todayHere = getStartOfDay(new Date(), currentQueue ? await serviceTimeZone(currentQueue.serviceId) : undefined);
    const existing = await prisma.queueEntry.findUnique({ where: { id: entryId }, select: { calledAt: true } });
    const entry = await prisma.queueEntry.update({
      where: { id: entryId },
      data: {
        status: 'SERVED',
        servedAt: new Date(),
        completedAt: new Date(),
        serviceDuration: minutesSince(existing?.calledAt),
      },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true },
        },
        queue: {
          include: {
            service: {
              include: {
                location: true,
                flowsFrom: {
                  include: {
                    toService: {
                      include: {
                        location: true,
                        queues: {
                          where: {
                            date: todayHere,
                            status: 'ACTIVE',
                          },
                          include: {
                            _count: {
                              select: {
                                entries: { where: { status: 'WAITING' } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  orderBy: { priority: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    // Emit real-time update to both queue and location rooms
    const locationId = entry.queue.service.location.id;
    const updateData = {
      queueId: id,
      entryId: entry.id,
      status: 'SERVED',
      entry,
    };
    emitToQueue(id, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, updateData);
    emitToLocation(locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, updateData);
    await recordQueueEvent({ action: 'entry.served', actorUserId: actorId(req), queueId: id, entryId: entry.id });
    await afterQueueChange(id);

    // Check for auto-transfer
    const autoTransferFlow = entry.queue.service.flowsFrom.find(f => f.autoTransfer);
    if (autoTransferFlow) {
      try {
        const result = await transferEntryToService(entry.id, autoTransferFlow.toServiceId, {
          actorUserId: actorId(req),
          origin: ORIGIN.system,
        });
        return res.json({
          entry,
          autoTransferred: true,
          nextTicket: {
            ticketNumber: result.entry.ticketNumber,
            serviceName: result.service.name,
            queueId: result.queue.id,
            entryId: result.entry.id,
          },
        });
      } catch (err) {
        if (!(err instanceof TransferError)) throw err;
        // Target not accepting patients - fall through to manual suggestions.
      }
    }
    await closeJourneyIfDone(entry.id, { actorUserId: actorId(req) });

    // Build next service suggestions
    const nextServices = entry.queue.service.flowsFrom.map(flow => ({
      serviceId: flow.toService.id,
      serviceName: flow.toService.name,
      displayName: flow.displayName || flow.toService.name,
      isRequired: flow.isRequired,
      queueInfo: flow.toService.queues[0] ? {
        queueId: flow.toService.queues[0].id,
        waitingCount: flow.toService.queues[0]._count.entries,
        estimatedWait: flow.toService.queues[0]._count.entries * flow.toService.slotDuration,
      } : null,
    }));

    res.json({
      entry,
      autoTransferred: false,
      nextServices,
    });
  } catch (error) {
    next(error);
  }
};

// Get all active queues for a location (for display boards with swimlanes)
export const getLocationQueues = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    // Get the location with organization's default display mode
    const locationData = await prisma.location.findUnique({
      where: { id: locationId },
      include: {
        organization: {
          select: { defaultDisplayMode: true }
        }
      }
    });
    const today = getStartOfDay(new Date(), validTimeZone(locationData?.timezone));
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
    
    const orgDefaultDisplayMode = locationData?.organization?.defaultDisplayMode || 'TICKET_ONLY';

    // Get all services for this location (we will load service point links separately)
    const services = await prisma.service.findMany({
      where: { 
        locationId,
        isActive: true,
      },
      include: {
        // NOTE: don't include the join relation here — load ServicePointService entries separately
        queues: {
          where: { date: today },
          include: {
            entries: {
              where: { 
                status: { in: ['WAITING', 'SERVING'] }
              },
              orderBy: [
                { status: 'asc' }, // SERVING first
                { priority: 'desc' },
                { sortOrder: 'asc' },
                { joinedAt: 'asc' }
              ],
              include: {
                user: {
                  select: { id: true, firstName: true, lastName: true }
                },
                servicePointInstance: {
                  include: {
                    servicePointService: {
                      include: { servicePoint: { select: { id: true, name: true, displayName: true } } }
                    },
                    occupiedBy: { select: { firstName: true, lastName: true } },
                  }
                }
              },
              take: 20, // Limit entries per queue for display
            },
            _count: {
              select: { entries: true }
            }
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Load active ServicePointService mappings for this location so we can map active service points
    // to each service without relying on a nested include that may not be available in older clients.
    const spLinks = await prisma.servicePointService.findMany({
      where: {
        isActive: true,
        servicePoint: { isActive: true },
        service: { locationId, isActive: true },
      },
      include: {
        servicePoint: { select: { id: true, name: true, displayName: true, isActive: true } },
        service: { select: { id: true } },
      },
    });

    // Create quick lookup: serviceId -> array of active service points
    const serviceToPoints: Record<string, { id: string; name: string; displayName?: string }[]> = {};
    for (const link of spLinks) {
      const svcId = link.serviceId;
      if (!serviceToPoints[svcId]) serviceToPoints[svcId] = [];
      if (link.servicePoint && link.servicePoint.isActive) {
        serviceToPoints[svcId].push({
          id: link.servicePoint.id,
          name: link.servicePoint.name,
          displayName: link.servicePoint.displayName || undefined,
        });
      }
    }

    // Get historical service durations for each service (last 30 days)
    const historicalData = await prisma.queueEntry.groupBy({
      by: ['queueId'],
      where: {
        status: 'SERVED',
        serviceDuration: { not: null },
        queue: {
          date: { gte: thirtyDaysAgo },
          service: { locationId }
        }
      },
      _avg: {
        serviceDuration: true
      }
    });

    // Map historical averages to services via queues
    const serviceAvgDurations: Record<string, number> = {};

    // Who's seeing each called person, shown with the room.
    const staffNames = await staffNamesFor(
      services.flatMap((s) => s.queues[0]?.entries.filter((e) => e.status === 'SERVING') ?? [])
    );

    // Format response for display
    const swimlanes = await Promise.all(services.map(async (service) => {
      const queue = service.queues[0]; // Today's queue
      
      // Count active service points linked to this service (from the separate mapping)
      const activeServicePoints = (serviceToPoints[service.id] || []).length;
      
      // Calculate average service duration from historical data or use default
      let avgServiceDuration = service.slotDuration; // Default
      
      if (queue) {
        // Try to get historical average for this service
        const historicalAvg = await prisma.queueEntry.aggregate({
          where: {
            queue: { serviceId: service.id },
            status: 'SERVED',
            serviceDuration: { not: null },
            completedAt: { gte: thirtyDaysAgo }
          },
          _avg: {
            serviceDuration: true
          }
        });
        
        if (historicalAvg._avg.serviceDuration) {
          avgServiceDuration = Math.round(historicalAvg._avg.serviceDuration);
        }
      }

      const entries = queue?.entries || [];
      const serving = entries.filter(e => e.status === 'SERVING');
      const waiting = entries.filter(e => e.status === 'WAITING');
      
      // Calculate estimated wait for each position in queue
      // Formula: (position / max(activeServicePoints, 1)) * avgServiceDuration
      const effectiveServicePoints = Math.max(activeServicePoints, 1);
      
      return {
        serviceId: service.id,
        serviceName: service.name,
        serviceType: service.type,
        displayMode: service.displayMode || orgDefaultDisplayMode, // Use service override or org default
        queueId: queue?.id || null,
        queueStatus: queue?.status || 'NO_QUEUE',
        activeServicePoints,
        avgServiceDuration,
        stats: {
          serving: serving.length,
          waiting: waiting.length,
          total: queue?._count?.entries || 0,
        },
        currentlyServing: serving.map(e => ({
          id: e.id,
          ticketNumber: e.ticketNumber,
          customerName: screenName(service.displayMode || orgDefaultDisplayMode, e.user.firstName, e.user.lastName),
          servicePoint: e.servicePointInstance?.servicePointService?.servicePoint
            ? (e.servicePointInstance.servicePointService.servicePoint.displayName || e.servicePointInstance.servicePointService.servicePoint.name)
            : null,
          staffName: staffNames.get(e.id) ?? null,
          calledAt: e.calledAt,
        })),
        waitingList: waiting.slice(0, 10).map((e, index) => {
          // Calculate estimated wait for this position
          // Account for currently serving entries completing
          const positionInQueue = index + 1;
          const estimatedWait = Math.round(
            ((positionInQueue + serving.length) / effectiveServicePoints) * avgServiceDuration
          );
          
          return {
            id: e.id,
            ticketNumber: e.ticketNumber,
            customerName: screenName(service.displayMode || orgDefaultDisplayMode, e.user.firstName, e.user.lastName),
            position: positionInQueue,
            joinedAt: e.joinedAt,
            estimatedWait,
          };
        }),
        estimatedWaitPerPerson: Math.round(avgServiceDuration / effectiveServicePoints),
      };
    }));

    res.json({
      locationId,
      defaultDisplayMode: orgDefaultDisplayMode,
      timestamp: new Date().toISOString(),
      swimlanes,
    });
  } catch (error) {
    next(error);
  }
};

// Get public entry identity data
export const getPublicEntryIdentity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entryId } = req.params;

    const entry = await prisma.queueEntry.findUnique({
      where: { id: entryId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            identityData: true,
          },
        },
      },
    });

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({
      entryId: entry.id,
      userId: entry.user.id,
      firstName: entry.user.firstName,
      lastName: entry.user.lastName,
      phone: entry.user.phone,
      email: entry.user.email,
      identityData: entry.user.identityData || {},
    });
  } catch (error) {
    next(error);
  }
};

// Update public entry identity data (self-service)
export const updatePublicEntryIdentity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entryId } = req.params;
    const { firstName, lastName, phone, identityData } = req.body;

    // Find the entry and verify it's still WAITING
    const entry = await prisma.queueEntry.findUnique({
      where: { id: entryId },
      include: {
        user: true,
      },
    });

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    // Only allow updates for WAITING entries (not after being called)
    if (entry.status !== 'WAITING') {
      return res.status(400).json({ 
        error: 'Cannot update information after being called. Please speak with the staff.',
      });
    }

    // Build update data
    const updateData: any = {};
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (phone !== undefined) updateData.phone = phone;
    
    // Merge identity data with existing
    if (identityData !== undefined) {
      const existingIdentity = (entry.user.identityData as Record<string, any>) || {};
      updateData.identityData = {
        ...existingIdentity,
        ...identityData,
      };
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: entry.userId },
      data: updateData,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        identityData: true,
      },
    });

    res.json({
      message: 'Information updated successfully',
      user: updatedUser,
    });
  } catch (error) {
    next(error);
  }
};
/** Calls the current ticket again: lobby screens flash and announce it,
 * and the person gets the "it's your turn" message again. */
export const recallEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, entryId } = req.params;
    const updated = await prisma.queueEntry.updateMany({
      where: { id: entryId, queueId: id, status: 'SERVING' },
      data: { calledAt: new Date() },
    });
    if (updated.count === 0) return res.status(400).json({ error: 'Only someone being served can be called again.' });
    const entry = await prisma.queueEntry.findUniqueOrThrow({
      where: { id: entryId },
      include: { servicePointInstance: { include: { servicePointService: { include: { servicePoint: true } } } } },
    });
    const sp = entry.servicePointInstance?.servicePointService?.servicePoint ?? null;
    const locationId = await getLocationIdFromQueue(id);
    emitToQueueAndLocation(id, locationId, SOCKET_EVENTS.ENTRY_STATUS_CHANGED, { queueId: id, entryId, status: 'SERVING', action: 'recalled' });
    await afterEntryCalled(
      entry.id,
      entry.servicePointInstance?.displayName ||
        (sp ? [sp.displayName || sp.name, entry.servicePointInstance?.instanceNumber].filter(Boolean).join(' ') : null)
    );
    res.json({ ok: true, calledAt: entry.calledAt });
  } catch (error) {
    next(error);
  }
};
