import crypto from 'crypto';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { assertPublicUrl } from '../lib/urlSafety';

export const WEBHOOK_EVENTS = [
  'entry.joined',
  'entry.called',
  'entry.served',
  'entry.cancelled',
  'entry.no_show',
  'entry.transferred',
  'entry.priority_changed',
  'entry.held',
  'entry.resumed',
  'entry.cleared',
  'queue.paused',
  'queue.resumed',
  'appointment.created',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.checked_in',
  'journey.completed',
  'servicepoint.opened',
  'servicepoint.closed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 6;
// Delay before attempt n+1, in minutes.
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const TIMEOUT_MS = 5000;

/** Signature receivers verify: hex HMAC-SHA256 of `${timestamp}.${body}`. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** EMR ids for an event, for one integration (Klargy Connect `refs`). */
export type RefsResolver = (integrationId: string) => Promise<Record<string, string | null>>;

/**
 * Queues and attempts a delivery to every endpoint subscribed to the event.
 * An endpoint owned by an integration (Klargy Connect) also gets `refs`:
 * that integration's own ids for the records in the event. Other endpoints
 * never see another system's ids.
 */
export async function dispatchWebhook(
  organizationId: string,
  event: WebhookEvent,
  data: unknown,
  refsFor?: RefsResolver,
  /** More fields for an integration's own endpoint (its ids inside the data). */
  extraFor?: (integrationId: string) => Promise<Record<string, unknown>>
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId, isActive: true },
    include: { integration: { select: { id: true } } },
  });
  const targets = endpoints.filter((e) => e.events.length === 0 || e.events.includes(event));
  if (targets.length === 0) return;

  const createdAt = new Date().toISOString();
  const deliveries = await Promise.all(
    targets.map(async (endpoint) => {
      let body = data;
      if (refsFor && endpoint.integration && data && typeof data === 'object') {
        body = { ...(data as object), refs: await refsFor(endpoint.integration.id) };
      }
      if (extraFor && endpoint.integration && body && typeof body === 'object') {
        body = { ...(body as object), ...(await extraFor(endpoint.integration.id)) };
      }
      const payload = { event, createdAt, data: body };
      return prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, event, payload: payload as any } });
    })
  );
  await Promise.allSettled(deliveries.map((d) => attemptDelivery(d.id)));
}

export async function attemptDelivery(deliveryId: string): Promise<'SUCCEEDED' | 'PENDING' | 'FAILED'> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status !== 'PENDING') return (delivery?.status as any) ?? 'FAILED';

  const attempts = delivery.attempts + 1;
  const body = JSON.stringify({ id: delivery.id, ...(delivery.payload as object) });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let responseCode: number | null = null;
  let error: string | null = null;
  try {
    await assertPublicUrl(delivery.endpoint.url);
    const secret = decrypt(delivery.endpoint.encryptedSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'queue-webhooks/1',
          'X-Webhook-Id': delivery.id,
          'X-Webhook-Event': delivery.event,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': `sha256=${signPayload(secret, timestamp, body)}`,
        },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      responseCode = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const succeeded = !error;
  const status = succeeded ? 'SUCCEEDED' : attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
  const delay = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts,
      status,
      responseCode,
      lastError: error?.slice(0, 500) ?? null,
      nextAttemptAt: status === 'PENDING' ? new Date(Date.now() + delay * 60_000) : null,
    },
  });
  return status;
}

/** Retries deliveries whose backoff has elapsed. Called by the cron endpoint. */
export async function retryDueDeliveries(limit = 50): Promise<number> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  await Promise.allSettled(due.map((d) => attemptDelivery(d.id)));
  return due.length;
}
