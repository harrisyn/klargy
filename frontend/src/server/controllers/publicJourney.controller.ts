import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { notifyEntry } from '../services/notifications.service';
import { ORIGIN, TransferError, transferEntryToService } from '../services/queueEvents.service';
import { QueueActionError, checkEntryLimits, endEntry, serveEntry } from '../services/queueActions.service';
import { getStartOfDay, validTimeZone } from '../utils/date';

/**
 * Patients moving themselves on from their status page ("I'm done here"):
 * only to the next steps the location's service flow offers from where they
 * are, or out ("I'm leaving"). Addressed by the status link itself
 * (/status/<queueId>/<entryId>), so only someone holding that link can do it.
 */

async function statusEntry(queueId: string, entryId: string) {
  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      queueId: true,
      status: true,
      journeyId: true,
      completedAt: true,
      queue: {
        select: {
          date: true,
          service: {
            select: {
              id: true,
              name: true,
              location: { select: { id: true, timezone: true, organization: { select: { status: true } } } },
            },
          },
        },
      },
    },
  });
  if (!entry || entry.queueId !== queueId) return null;
  return entry;
}

type StatusEntry = NonNullable<Awaited<ReturnType<typeof statusEntry>>>;

/** The ticket this one was sent on to, if any (newest). */
export async function successorOf(entryId: string) {
  return prisma.queueEntry.findFirst({
    where: { previousEntryId: entryId },
    orderBy: { joinedAt: 'desc' },
    select: { id: true, queueId: true, ticketNumber: true, status: true, queue: { select: { service: { select: { name: true } } } } },
  });
}

/** Whether the patient can still move on from this ticket: they're being
 * served, or were served today and haven't been sent anywhere since. */
async function canMoveOn(entry: StatusEntry): Promise<boolean> {
  if (entry.queue.service.location.organization.status === 'PAUSED') return false;
  if (entry.status === 'SERVING') return true;
  if (entry.status !== 'SERVED') return false;
  const today = getStartOfDay(new Date(), validTimeZone(entry.queue.service.location.timezone));
  if (entry.queue.date.getTime() !== today.getTime()) return false;
  return !(await successorOf(entry.id));
}

/** The next steps from the entry's service (the location's service flow), in
 * flow order. `returning` marks a service already visited this visit (they
 * go back to the desk that saw them). */
async function nextSteps(entry: StatusEntry) {
  const flows = await prisma.serviceFlow.findMany({
    where: { fromServiceId: entry.queue.service.id, toService: { isActive: true, locationId: entry.queue.service.location.id } },
    orderBy: { priority: 'asc' },
    select: { displayName: true, toService: { select: { id: true, name: true } } },
  });
  const visited = entry.journeyId
    ? new Set(
        (
          await prisma.queueEntry.findMany({
            where: { journeyId: entry.journeyId },
            select: { queue: { select: { serviceId: true } } },
          })
        ).map((e) => e.queue.serviceId)
      )
    : new Set<string>();
  return flows.map((f) => ({
    serviceId: f.toService.id,
    name: f.displayName || f.toService.name,
    returning: visited.has(f.toService.id),
  }));
}

export const getPublicNextSteps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = await statusEntry(req.params.queueId, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const movable = await canMoveOn(entry);
    res.json({
      canMoveOn: movable,
      canLeave: movable || entry.status === 'WAITING',
      steps: movable ? await nextSteps(entry) : [],
    });
  } catch (error) {
    next(error);
  }
};

/** POST { to: <serviceId> | "leave" } */
export const postPublicMove = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = await statusEntry(req.params.queueId, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!to) return res.status(400).json({ error: 'Choose where you’re going next.' });
    const movable = await canMoveOn(entry);

    if (to === 'leave') {
      if (entry.status === 'WAITING') {
        await endEntry(entry.queueId, entry.id, 'CANCELLED', { origin: ORIGIN.public, data: { reason: 'Left (patient)' } }, { onlyFrom: ['WAITING'] });
      } else if (entry.status === 'SERVING') {
        await serveEntry(entry.queueId, entry.id, { origin: ORIGIN.public }, { onlyFrom: ['SERVING'] });
      } else if (!movable) {
        return res.status(409).json({ error: 'This ticket is already closed.', code: 'NOT_MOVABLE' });
      }
      return res.json({ left: true, entry: null });
    }

    if (!movable) {
      const sentTo = await successorOf(entry.id);
      return res.status(409).json({
        error: sentTo ? `You’ve already been sent to ${sentTo.queue.service.name}.` : 'You can choose your next step once you’ve been seen here.',
        code: 'NOT_MOVABLE',
      });
    }
    const steps = await nextSteps(entry);
    const step = steps.find((s) => s.serviceId === to);
    if (!step) return res.status(400).json({ error: 'That isn’t one of the next steps from here.', code: 'NOT_A_NEXT_STEP' });

    try {
      await checkEntryLimits((await prisma.service.findUniqueOrThrow({ where: { id: to }, select: { location: { select: { organizationId: true } } } })).location.organizationId);
      const result = await transferEntryToService(entry.id, to, {
        origin: ORIGIN.public,
        sentBy: 'patient',
        completeSource: true,
        requireOpenSource: entry.status !== 'SERVED',
      });
      await notifyEntry(result.entry.id, 'QUEUE_JOINED').catch((e) => console.error('join notification failed:', e));
      const created = await prisma.queueEntry.findUniqueOrThrow({
        where: { id: result.entry.id },
        select: { id: true, queueId: true, ticketNumber: true, awaitingClearance: true },
      });
      return res.status(201).json({
        entry: {
          entryId: created.id,
          queueId: created.queueId,
          ticketNumber: created.ticketNumber,
          serviceName: result.service.name,
          awaitingClearance: created.awaitingClearance,
          statusPath: `/status/${created.queueId}/${created.id}`,
        },
      });
    } catch (error) {
      if (error instanceof TransferError) return res.status(error.status === 400 ? 409 : error.status).json({ error: error.message, code: error.code });
      if (error instanceof QueueActionError) return res.status(error.status).json(error.body);
      throw error;
    }
  } catch (error) {
    next(error);
  }
};
