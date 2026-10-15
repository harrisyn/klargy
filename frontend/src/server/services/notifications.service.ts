import prisma from '../lib/prisma';
import { emitToUser, emitToQueue, SOCKET_EVENTS } from '../lib/realtime';
import { consumeCredits } from '../middleware/subscription.middleware';
import { sendNotificationEmail } from '../utils/email';
import { getSmsProvider } from './sms';
import { statusUrlFor } from '../config/appConfig';

export type QueueNotificationType = 'QUEUE_JOINED' | 'TURN_APPROACHING' | 'NOW_SERVING';

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

// Waiting-line order used everywhere a "position" is shown or the next
// patient is called: priority first, then manual reorder, then arrival.
export const WAITING_ORDER = [
  { priority: 'desc' as const },
  { sortOrder: 'asc' as const },
  { joinedAt: 'asc' as const },
];

// Walk-in patients get a synthetic guest address - never email those.
const isRealEmail = (email: string) => !email.endsWith('@guest.qms.local');

export function buildMessage(
  type: QueueNotificationType,
  ctx: { ticket: string; service: string; position?: number; servicePoint?: string | null; statusUrl?: string }
): { heading: string; message: string } {
  switch (type) {
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
  extra: { position?: number; servicePointName?: string | null } = {}
): Promise<void> {
  const already = await prisma.notification.findFirst({
    where: { queueEntryId: entryId, type },
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

  const waiting = await prisma.queueEntry.findMany({
    where: { queueId, status: 'WAITING' },
    orderBy: WAITING_ORDER,
    take: turnApproachingAt,
    select: { id: true },
  });
  for (const [index, entry] of waiting.entries()) {
    await notifyEntry(entry.id, 'TURN_APPROACHING', { position: index + 1 });
  }
}

/** 1-based position of a waiting entry in the same order staff call people. */
export async function computePosition(queueId: string, entryId: string): Promise<number> {
  const waiting = await prisma.queueEntry.findMany({
    where: { queueId, status: 'WAITING' },
    orderBy: WAITING_ORDER,
    select: { id: true },
  });
  const index = waiting.findIndex((e) => e.id === entryId);
  return index === -1 ? 0 : index + 1;
}
