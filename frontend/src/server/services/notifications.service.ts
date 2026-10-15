import prisma from '../lib/prisma';
import { emitToUser, emitToQueue, SOCKET_EVENTS } from '../lib/realtime';
import { consumeCredits } from '../middleware/subscription.middleware';
import { sendNotificationEmail } from '../utils/email';
import { getSmsProvider } from './sms';
import { statusUrlFor } from '../config/appConfig';
import { orderWaiting, readBookedArrivalSettings, lineRanks } from './queueOrder';

export type QueueNotificationType = 'QUEUE_JOINED' | 'TURN_APPROACHING' | 'NOW_SERVING' | 'QUEUE_DELAYED';

export interface NotificationSettings {
  turnApproachingAt: number;
  email: boolean;
  sms: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  turnApproachingAt: 3,
  email: true,
  sms: false,
};

export function readNotificationSettings(raw: unknown): NotificationSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationSettings>;
  return {
    turnApproachingAt:
      typeof s.turnApproachingAt === 'number' && s.turnApproachingAt >= 1 && s.turnApproachingAt <= 20
        ? Math.floor(s.turnApproachingAt)
        : DEFAULT_NOTIFICATION_SETTINGS.turnApproachingAt,
    email: typeof s.email === 'boolean' ? s.email : DEFAULT_NOTIFICATION_SETTINGS.email,
    sms: typeof s.sms === 'boolean' ? s.sms : DEFAULT_NOTIFICATION_SETTINGS.sms,
  };
}

// The database half of the waiting-line order: priority first, then manual
// reorder, then arrival. Booked patients placed by their booked time are
// fitted in afterwards (see waitingLine and queueOrder.ts), so use
// waitingLine wherever a position is shown or the next patient is called.
export const WAITING_ORDER = [
  { priority: 'desc' as const },
  { sortOrder: 'asc' as const },
  { joinedAt: 'asc' as const },
];

// Who "Call next" can pick, and who has a place in line: waiting, not on
// hold, and not waiting for payment (a service that requires clearance).
export const CALLABLE_WHERE = { status: 'WAITING' as const, heldAt: null, awaitingClearance: false };

// Walk-in patients get a synthetic guest address - never email those.
const isRealEmail = (email: string) => !email.endsWith('@guest.qms.local');

export function buildMessage(
  type: QueueNotificationType,
  ctx: { ticket: string; service: string; position?: number; servicePoint?: string | null; statusUrl?: string; text?: string | null }
): { heading: string; message: string } {
  switch (type) {
    case 'QUEUE_DELAYED':
      return {
        heading: `${ctx.service} is paused`,
        message: ctx.text || `${ctx.service} is paused for now. Please stay nearby; we'll let you know when it reopens.`,
      };
    case 'QUEUE_JOINED':
      return {
        heading: `You're in the queue: ${ctx.ticket}`,
        message:
          `Your ticket for ${ctx.service} is ${ctx.ticket}. We'll let you know when your turn is close.` +
          (ctx.statusUrl ? ` Track your place: ${ctx.statusUrl}` : ''),
      };
    case 'TURN_APPROACHING':
      return ctx.position === 1
        ? { heading: `You're next: ${ctx.ticket}`, message: `You're next for ${ctx.service}. Please make your way over.` }
        : {
            heading: `Almost your turn: ${ctx.ticket}`,
            message: `You're number ${ctx.position} in line for ${ctx.service}. Please stay nearby.`,
          };
    case 'NOW_SERVING':
      return {
        heading: `Now serving ${ctx.ticket}`,
        message: ctx.servicePoint
          ? `It's your turn for ${ctx.service}. Please go to ${ctx.servicePoint}.`
          : `It's your turn for ${ctx.service}. Please proceed.`,
      };
  }
}

/**
 * Sends one queue notification for an entry across the org's enabled
 * channels. Idempotent per (entry, type) - a second call is a no-op - so
 * callers can fire it on every queue change without spamming patients.
 */
export async function notifyEntry(
  entryId: string,
  type: QueueNotificationType,
  extra: {
    position?: number;
    servicePointName?: string | null;
    /** Our own wording instead of the standard message (QUEUE_DELAYED). */
    text?: string | null;
    /** Only a message of this type sent at or after this time counts as a
     * repeat, for messages that may go out again later (one per pause). */
    since?: Date;
  } = {}
): Promise<void> {
  const already = await prisma.notification.findFirst({
    where: { queueEntryId: entryId, type, ...(extra.since ? { sentAt: { gte: extra.since } } : {}) },
    select: { id: true },
  });
  if (already) return;

  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    include: {
      user: { select: { id: true, email: true, phone: true } },
      queue: {
        include: {
          service: {
            select: {
              name: true,
              location: { select: { organization: { select: { id: true, name: true, slug: true, notificationSettings: true } } } },
            },
          },
        },
      },
    },
  });
  if (!entry) return;

  const org = entry.queue.service.location.organization;
  const settings = readNotificationSettings(org.notificationSettings);
  const { heading, message } = buildMessage(type, {
    ticket: entry.ticketNumber,
    service: entry.queue.service.name,
    position: extra.position,
    servicePoint: extra.servicePointName,
    text: extra.text,
    statusUrl: statusUrlFor(entry.queueId, entry.id, org.slug),
  });

  const inApp = await prisma.notification.create({
    data: { userId: entry.user.id, type, channel: 'IN_APP', message, queueEntryId: entry.id },
  });
  emitToUser(entry.user.id, SOCKET_EVENTS.NOTIFICATION_SENT, inApp);
  // Public status pages subscribe per queue, not per user.
  emitToQueue(entry.queueId, SOCKET_EVENTS.NOTIFICATION_SENT, { entryId: entry.id, type, message });

  if (settings.email && isRealEmail(entry.user.email)) {
    const credit = await consumeCredits(org.id, 'EMAIL', 1, `queue notification ${type}`);
    if (credit.allowed) {
      const sent = await sendNotificationEmail(entry.user.email, heading, message, org.name);
      if (sent.success) {
        await prisma.notification.create({
          data: { userId: entry.user.id, type, channel: 'EMAIL', message, queueEntryId: entry.id, readAt: new Date() },
        });
      }
    }
  }

  if (settings.sms && entry.user.phone) {
    const provider = await getSmsProvider();
    if (provider) {
      const credit = await consumeCredits(org.id, 'SMS', 1, `queue notification ${type}`);
      if (credit.allowed) {
        const sent = await provider.send(entry.user.phone, `${org.name}: ${message}`);
        if (sent.success) {
          await prisma.notification.create({
            data: { userId: entry.user.id, type, channel: 'SMS', message, queueEntryId: entry.id, readAt: new Date() },
          });
        } else {
          console.error('SMS send failed:', sent.error);
        }
      }
    }
  }
}

/** After any change to a queue, tells everyone now within the org's
 * "turn approaching" threshold (once each). */
export async function notifyPositions(queueId: string): Promise<void> {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { service: { select: { location: { select: { organization: { select: { notificationSettings: true } } } } } } },
  });
  if (!queue) return;
  const { turnApproachingAt } = readNotificationSettings(queue.service.location.organization.notificationSettings);

  const waiting = (await waitingLine(queueId)).slice(0, turnApproachingAt);
  for (const [index, entry] of waiting.entries()) {
    await notifyEntry(entry.id, 'TURN_APPROACHING', { position: index + 1 });
  }
}

/** 1-based position of a waiting entry in the same order staff call people
 * (0 when it has no place: on hold, waiting for payment, or not waiting). */
export async function computePosition(queueId: string, entryId: string): Promise<number> {
  return (await queueLineRanks(queueId)).get(entryId) ?? 0;
}

const LINE_SELECT = {
  id: true,
  priority: true,
  sortOrder: true,
  joinedAt: true,
  calledAt: true,
  heldAt: true,
  deskInstanceId: true,
  bookedPlaceAt: true,
} as const;

/** The organisation's booked-arrival settings for a queue. */
export async function bookedArrivalForQueue(queueId: string) {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { service: { select: { location: { select: { organization: { select: { bookedArrivalSettings: true } } } } } } },
  });
  return readBookedArrivalSettings(queue?.service?.location?.organization?.bookedArrivalSettings);
}

/**
 * Who can be called in a queue, in the order they are called: priority,
 * then booked patients fitted in by their booked time among walk-ins
 * (queueOrder.ts). The one order behind call next, positions, the desk,
 * the lobby screen and the status page.
 */
export async function waitingLine(queueId: string) {
  const [entries, settings] = await Promise.all([
    prisma.queueEntry.findMany({ where: { queueId, ...CALLABLE_WHERE }, orderBy: WAITING_ORDER, select: LINE_SELECT }),
    bookedArrivalForQueue(queueId),
  ]);
  // Switched off: everyone is in line by arrival, including booked patients
  // placed while it was on.
  const line = settings.enabled ? entries ?? [] : (entries ?? []).map((e) => ({ ...e, bookedPlaceAt: null }));
  return orderWaiting(line, settings.maxBookedShare);
}

/** 1-based place in line of each callable entry of a queue. */
export async function queueLineRanks(queueId: string): Promise<Map<string, number>> {
  return lineRanks(await waitingLine(queueId));
}
