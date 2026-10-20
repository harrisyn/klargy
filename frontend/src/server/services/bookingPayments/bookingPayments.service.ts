import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getOrganizationFeatures } from '../../middleware/subscription.middleware';
import { wasAlreadyProcessed, markProcessed } from '../payments/idempotency';
import { BookingError, HOLD_STATUSES, claimSlot, releaseSlot, unitsOf } from '../booking.service';
import { recordPlatformRefund, recordPlatformSale } from '../payoutWallet.service';
import { sendBookingConfirmation } from '../bookingNotifications.service';
import { recordQueueEvent } from '../queueEvents.service';
import { paymentTerms, refundPercent } from '../rooms.service';
import {
  BOOKING_PROVIDERS,
  makeBookingClient,
  type BookingPaymentEvent,
  type BookingProviderClient,
  type BookingProviderName,
} from './providers';

/**
 * Taking payment for online bookings. Two ways the money moves:
 *  - ORG: the organization's own Stripe/Paystack keys (paid plans). The money
 *    goes straight to them.
 *  - PLATFORM: the platform's account collects it and credits the
 *    organization's payout wallet after a review hold (payoutWallet.service).
 */

/** How long an unpaid booking holds its place. */
export const PAYMENT_HOLD_MINUTES = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;

export { quoteBooking, paymentTerms, refundPercent } from '../rooms.service';

export interface Collector {
  source: 'ORG' | 'PLATFORM';
  provider: BookingProviderName;
  client: BookingProviderClient;
}

const PAYSTACK_CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES'];

/** Who takes the money for this organization right now, or null if nobody can. */
export async function collectorFor(organizationId: string, currency: string): Promise<Collector | null> {
  const own = await prisma.orgPaymentProvider.findMany({ where: { organizationId, isActive: true } });
  if (own.length) {
    const features = await getOrganizationFeatures(organizationId);
    if (features.ownPaymentKeys) {
      // Prefer the provider that suits the currency.
      const preferred = own.find((p) => (p.provider === 'paystack') === PAYSTACK_CURRENCIES.includes(currency.toUpperCase())) ?? own[0];
      return {
        source: 'ORG',
        provider: preferred.provider as BookingProviderName,
        client: makeBookingClient(preferred.provider as BookingProviderName, decrypt(preferred.secretKey), preferred.webhookSecret ? decrypt(preferred.webhookSecret) : null),
      };
    }
  }
  const platform = await prisma.paymentProviderConfig.findMany({ where: { isActive: true } });
  if (!platform.length) return null;
  const preferred = platform.find((p) => (p.provider === 'paystack') === PAYSTACK_CURRENCIES.includes(currency.toUpperCase())) ?? platform[0];
  if (!BOOKING_PROVIDERS.includes(preferred.provider as BookingProviderName)) return null;
  return {
    source: 'PLATFORM',
    provider: preferred.provider as BookingProviderName,
    client: makeBookingClient(preferred.provider as BookingProviderName, decrypt(preferred.secretKey), decrypt(preferred.webhookSecret)),
  };
}

/** The client that took an existing booking's payment (for refunds and expiry). */
async function collectorForAppointment(a: { paymentSource: string | null; paymentProvider: string | null; service: { location: { organizationId: string } } }): Promise<BookingProviderClient | null> {
  const name = a.paymentProvider as BookingProviderName | null;
  if (!name) return null;
  if (a.paymentSource === 'ORG') {
    const row = await prisma.orgPaymentProvider.findUnique({ where: { organizationId_provider: { organizationId: a.service.location.organizationId, provider: name } } });
    return row ? makeBookingClient(name, decrypt(row.secretKey), row.webhookSecret ? decrypt(row.webhookSecret) : null) : null;
  }
  const row = await prisma.paymentProviderConfig.findUnique({ where: { provider: name } });
  return row ? makeBookingClient(name, decrypt(row.secretKey), decrypt(row.webhookSecret)) : null;
}

/** Parses a provider webhook with every key set that could have signed it. */
export function parseBookingEvent(clients: BookingProviderClient[], rawBody: Buffer, signature: string): { verified: boolean; event: BookingPaymentEvent | null } {
  for (const client of clients) {
    const r = client.parseWebhook(rawBody, signature);
    if (r.verified) return r;
  }
  return { verified: false, event: null };
}

type AppointmentForPayment = NonNullable<Awaited<ReturnType<typeof loadForEvent>>>;

const loadForEvent = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    include: { slot: true, room: true, service: { include: { location: { select: { organizationId: true } } } } },
  });

/**
 * Applies a verified payment event. Idempotent on (scope, eventId); `scope`
 * names whose webhook it came from ("platform:stripe", "org:<id>:stripe").
 */
export async function applyBookingEvent(scope: string, event: BookingPaymentEvent, expectedOrganizationId?: string): Promise<'applied' | 'duplicate' | 'ignored'> {
  if (await wasAlreadyProcessed(scope, event.eventId)) return 'duplicate';
  const appointment = await loadForEvent(event.appointmentId);
  // The reference must be the one we issued: a forged id can't confirm someone else's booking.
  if (!appointment || appointment.paymentRef !== event.reference) return 'ignored';
  if (expectedOrganizationId && appointment.service.location.organizationId !== expectedOrganizationId) return 'ignored';

  if (event.type === 'expired') {
    await expireOne(appointment);
  } else {
    await confirmPaid(appointment, event);
  }
  await markProcessed(scope, event.eventId);
  return 'applied';
}

async function confirmPaid(a: AppointmentForPayment, event: BookingPaymentEvent) {
  if (a.paymentStatus === 'PAID') return;
  const organizationId = a.service.location.organizationId;
  const paid = round2(event.amount ?? Number(a.amountDue ?? 0));
  const currency = (event.currency ?? a.currency ?? 'USD').toUpperCase();

  let revived = false;
  if (a.status === 'CANCELLED') {
    // Paid after the hold lapsed: honour it if the place is still free, else give the money back.
    const units = unitsOf(a, a.service);
    if (a.slotId && (await claimSlot(a.slotId, units))) revived = true;
    else {
      await prisma.appointment.update({ where: { id: a.id }, data: { paymentStatus: 'PAID', amountPaid: paid, paymentIntentRef: event.paymentIntentRef ?? null } });
      if (a.paymentSource === 'PLATFORM') await recordPlatformSale({ organizationId, appointmentId: a.id, amount: paid, currency, ref: a.paymentRef! });
      await refundBooking(a.id, { policy: 'FULL', reason: 'The time was taken before payment arrived' });
      return;
    }
  }

  await prisma.appointment.update({
    where: { id: a.id },
    data: {
      ...(a.status === 'PENDING_PAYMENT' || revived ? { status: 'SCHEDULED' } : {}),
      paymentStatus: 'PAID',
      amountPaid: paid,
      paymentIntentRef: event.paymentIntentRef ?? null,
      paymentExpiresAt: null,
    },
  });
  if (a.paymentSource === 'PLATFORM') await recordPlatformSale({ organizationId, appointmentId: a.id, amount: paid, currency, ref: a.paymentRef! });
  await recordQueueEvent({
    action: 'appointment.created',
    actorUserId: null,
    queueId: a.slot?.queueId ?? null,
    organizationId,
    data: {
      appointmentId: a.id,
      slotStart: a.startTime,
      patientId: a.userId,
      source: 'ONLINE',
      partySize: a.partySize,
      payment: { total: a.amount == null ? null : Number(a.amount), paid, currency },
    },
  });
  await sendBookingConfirmation(a.id);
}

async function expireOne(a: AppointmentForPayment) {
  const { count } = await prisma.appointment.updateMany({
    where: { id: a.id, status: 'PENDING_PAYMENT' },
    data: { status: 'CANCELLED', paymentStatus: 'EXPIRED' },
  });
  if (count === 0) return false;
  if (a.slotId) await releaseSlot(a.slotId, unitsOf(a, a.service));
  const client = await collectorForAppointment(a).catch(() => null);
  if (client?.expire && a.paymentRef) await client.expire(a.paymentRef).catch(() => {});
  return true;
}

/** Frees the places held by bookings whose payment never came. Run from cron. */
export async function expireUnpaidBookings(now = new Date()): Promise<number> {
  const due = await prisma.appointment.findMany({
    where: { status: 'PENDING_PAYMENT', paymentExpiresAt: { lt: now } },
    include: { slot: true, room: true, service: { include: { location: { select: { organizationId: true } } } } },
    take: 200,
  });
  let n = 0;
  for (const a of due) if (await expireOne(a)) n++;
  return n;
}

/** What would come back if this paid booking were cancelled at `now`: the room's terms, else the service's. */
export function refundDue(
  a: { startTime: Date; room: Parameters<typeof paymentTerms>[1]; service: Parameters<typeof paymentTerms>[0] },
  paid: number,
  now = new Date()
): number {
  const hoursLeft = (a.startTime.getTime() - now.getTime()) / 3_600_000;
  const percent = refundPercent(paymentTerms(a.service, a.room), hoursLeft);
  return Math.round(((paid * percent) / 100) * 100) / 100;
}

export interface RefundOutcome {
  refunded: number;
  currency: string | null;
}

/**
 * Gives money back for a paid booking. `CUTOFF` follows the service's rule
 * (refund only if cancelled early enough); `FULL` refunds everything paid.
 * Throws if the provider refuses, so the caller can stop before cancelling.
 */
export async function refundBooking(appointmentId: string, opts: { policy: 'FULL' | 'CUTOFF' | 'AMOUNT'; amount?: number; reason?: string; now?: Date }): Promise<RefundOutcome> {
  const a = await loadForEvent(appointmentId);
  if (!a || a.paymentStatus !== 'PAID' || !a.paymentRef) return { refunded: 0, currency: a?.currency ?? null };
  const paid = Number(a.amountPaid ?? 0);
  if (!(paid > 0)) return { refunded: 0, currency: a.currency };

  const now = opts.now ?? new Date();
  const refund = opts.policy === 'FULL' ? paid : opts.policy === 'AMOUNT' ? Math.min(paid, round2(opts.amount ?? 0)) : refundDue(a, paid, now);
  if (refund <= 0) return { refunded: 0, currency: a.currency };

  const client = await collectorForAppointment(a);
  if (!client) throw new BookingError('We couldn’t reach the payment provider to refund this booking. Please contact the business.');
  const currency = (a.currency ?? 'USD').toUpperCase();
  try {
    await client.refund({ reference: a.paymentRef, paymentIntentRef: a.paymentIntentRef, amount: refund, currency });
  } catch (error) {
    console.error('Booking refund failed:', error);
    throw new BookingError('The refund didn’t go through. Please try again, or contact the business.', 502);
  }
  // A part-refund for a price drop leaves the booking paid for what it still costs.
  await prisma.appointment.update({
    where: { id: a.id },
    data: opts.policy === 'AMOUNT' && refund < paid
      ? { amountPaid: round2(paid - refund) }
      : { paymentStatus: refund >= paid ? 'REFUNDED' : 'PARTIAL_REFUND' },
  });
  if (a.paymentSource === 'PLATFORM') {
    await recordPlatformRefund({ organizationId: a.service.location.organizationId, appointmentId: a.id, amount: refund, currency, ref: a.paymentRef });
  }
  return { refunded: refund, currency };
}

export { HOLD_STATUSES };
