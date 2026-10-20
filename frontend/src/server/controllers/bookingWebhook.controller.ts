import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { applyBookingEvent } from '../services/bookingPayments/bookingPayments.service';
import { BOOKING_PROVIDERS, makeBookingClient, type BookingProviderName } from '../services/bookingPayments/providers';

/**
 * Payment webhooks for bookings.
 *  - Organization keys: each organization points its own Stripe/Paystack
 *    webhook at /api/v1/webhooks/booking/<organizationId>/<provider>.
 *  - Platform keys: booking events arrive on the platform's existing
 *    /webhooks/stripe and /webhooks/paystack endpoints, which hand them to
 *    tryPlatformBookingEvent before treating the event as a plan payment.
 */

export const handleOrgBookingWebhook = async (req: Request, res: Response) => {
  const provider = req.params.provider as BookingProviderName;
  if (!BOOKING_PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider' });
  const row = await prisma.orgPaymentProvider.findUnique({ where: { organizationId_provider: { organizationId: req.params.organizationId, provider } } });
  if (!row) return res.status(404).json({ error: 'Not configured' });

  const client = makeBookingClient(provider, decrypt(row.secretKey), row.webhookSecret ? decrypt(row.webhookSecret) : null);
  const signature = String(req.headers[provider === 'stripe' ? 'stripe-signature' : 'x-paystack-signature'] ?? '');
  const parsed = client.parseWebhook(req.body as Buffer, signature);
  if (!parsed.verified) return res.status(400).json({ error: 'Invalid webhook signature' });
  if (!parsed.event) return res.status(200).json({ ok: true, ignored: true });

  try {
    const outcome = await applyBookingEvent(`org:${row.organizationId}:${provider}`, parsed.event, row.organizationId);
    return res.status(200).json({ ok: true, outcome });
  } catch (error) {
    console.error('Failed to apply booking payment event:', error);
    return res.status(500).json({ error: 'Failed to process webhook' });
  }
};

/** Handles a booking payment event arriving on the platform's webhook. 'not-booking' means the caller should carry on with plan billing. */
export async function tryPlatformBookingEvent(provider: BookingProviderName, rawBody: Buffer, signature: string): Promise<'handled' | 'not-booking' | 'failed'> {
  const config = await prisma.paymentProviderConfig.findUnique({ where: { provider } });
  if (!config || !config.isActive) return 'not-booking';
  const client = makeBookingClient(provider, decrypt(config.secretKey), decrypt(config.webhookSecret));
  const parsed = client.parseWebhook(rawBody, signature);
  if (!parsed.verified || !parsed.event) return 'not-booking';
  try {
    await applyBookingEvent(`platform:${provider}`, parsed.event);
    return 'handled';
  } catch (error) {
    console.error('Failed to apply platform booking payment event:', error);
    return 'failed';
  }
}
