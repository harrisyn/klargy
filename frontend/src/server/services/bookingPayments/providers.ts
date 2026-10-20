import crypto from 'crypto';
import Stripe from 'stripe';

/**
 * Card payments for bookings, one small client per provider. Built from
 * either an organization's own keys or the platform's (money collected on an
 * organization's behalf). Unrelated to services/payments, which bills
 * organizations for their plan.
 */

export type BookingProviderName = 'stripe' | 'paystack';
export const BOOKING_PROVIDERS: BookingProviderName[] = ['stripe', 'paystack'];

export interface BookingCheckoutInput {
  appointmentId: string;
  organizationId: string;
  /** Major units, e.g. 12.50 */
  amount: number;
  currency: string;
  description: string;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface BookingCheckout {
  redirectUrl: string;
  /** Stripe's session id / Paystack's reference; stored as Appointment.paymentRef. */
  reference: string;
}

export interface BookingPaymentEvent {
  eventId: string;
  type: 'paid' | 'expired';
  appointmentId: string;
  reference: string;
  paymentIntentRef?: string | null;
  /** Major units actually paid. */
  amount?: number | null;
  currency?: string | null;
}

export interface BookingWebhookResult {
  /** The signature checked out. */
  verified: boolean;
  /** Set when the event is about a booking payment; other valid events leave this null. */
  event: BookingPaymentEvent | null;
}

export interface BookingProviderClient {
  name: BookingProviderName;
  createCheckout(input: BookingCheckoutInput): Promise<BookingCheckout>;
  parseWebhook(rawBody: Buffer, signatureHeader: string): BookingWebhookResult;
  refund(input: { reference: string; paymentIntentRef?: string | null; amount: number; currency: string }): Promise<void>;
  /** Best effort: stop an unpaid checkout from being paid after its hold lapsed. */
  expire?(reference: string): Promise<void>;
}

const minor = (amount: number) => Math.round(amount * 100);
const major = (amount: number | null | undefined) => (amount == null ? null : amount / 100);

class StripeBookingClient implements BookingProviderClient {
  name = 'stripe' as const;
  private client: Stripe;
  constructor(secretKey: string, private webhookSecret: string | null) {
    this.client = new Stripe(secretKey);
  }

  async createCheckout(i: BookingCheckoutInput): Promise<BookingCheckout> {
    const metadata = { kind: 'booking', appointmentId: i.appointmentId, organizationId: i.organizationId };
    const session = await this.client.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: { currency: i.currency.toLowerCase(), product_data: { name: i.description }, unit_amount: minor(i.amount) },
          quantity: 1,
        },
      ],
      ...(i.customerEmail ? { customer_email: i.customerEmail } : {}),
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
      // Stripe's minimum; our own hold is shorter and a late payment is handled.
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      metadata,
      payment_intent_data: { metadata },
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { redirectUrl: session.url, reference: session.id };
  }

  parseWebhook(rawBody: Buffer, signatureHeader: string): BookingWebhookResult {
    if (!this.webhookSecret) return { verified: false, event: null };
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch {
      return { verified: false, event: null };
    }
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.expired') return { verified: true, event: null };
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.kind !== 'booking' || !session.metadata.appointmentId) return { verified: true, event: null };
    if (event.type === 'checkout.session.expired') {
      return { verified: true, event: { eventId: event.id, type: 'expired', appointmentId: session.metadata.appointmentId, reference: session.id } };
    }
    if (session.payment_status !== 'paid') return { verified: true, event: null };
    return {
      verified: true,
      event: {
        eventId: event.id,
        type: 'paid',
        appointmentId: session.metadata.appointmentId,
        reference: session.id,
        paymentIntentRef: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null),
        amount: major(session.amount_total),
        currency: session.currency?.toUpperCase() ?? null,
      },
    };
  }

  async refund({ paymentIntentRef, amount }: { reference: string; paymentIntentRef?: string | null; amount: number; currency: string }) {
    if (!paymentIntentRef) throw new Error('This payment has no Stripe payment to refund');
    await this.client.refunds.create({ payment_intent: paymentIntentRef, amount: minor(amount) });
  }

  async expire(reference: string) {
    await this.client.checkout.sessions.expire(reference);
  }
}

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

class PaystackBookingClient implements BookingProviderClient {
  name = 'paystack' as const;
  // Paystack signs webhooks with the account's secret key.
  constructor(private secretKey: string) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: unknown };
    if (!res.ok || json.status === false) throw new Error(`Paystack API error: ${json.message || res.statusText}`);
    return json.data as T;
  }

  async createCheckout(i: BookingCheckoutInput): Promise<BookingCheckout> {
    const reference = `bk_${i.appointmentId}_${crypto.randomBytes(4).toString('hex')}`;
    const data = await this.request<{ authorization_url: string }>('/transaction/initialize', {
      // Paystack insists on an email; customers who gave only a phone get a placeholder.
      email: i.customerEmail || `${i.appointmentId}@guest.qms.local`,
      amount: minor(i.amount),
      currency: i.currency.toUpperCase(),
      reference,
      callback_url: i.successUrl,
      metadata: { kind: 'booking', appointmentId: i.appointmentId, organizationId: i.organizationId, cancel_action: i.cancelUrl, custom_fields: [{ display_name: 'Booking', variable_name: 'booking', value: i.description }] },
    });
    return { redirectUrl: data.authorization_url, reference };
  }

  parseWebhook(rawBody: Buffer, signatureHeader: string): BookingWebhookResult {
    const expected = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { verified: false, event: null };
    let event: { event?: string; data?: { id?: number | string; reference?: string; amount?: number; currency?: string; metadata?: { kind?: string; appointmentId?: string } } };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { verified: false, event: null };
    }
    const data = event.data;
    if (event.event !== 'charge.success' || data?.metadata?.kind !== 'booking' || !data.metadata.appointmentId || !data.reference) {
      return { verified: true, event: null };
    }
    return {
      verified: true,
      event: {
        eventId: data.id ? String(data.id) : `charge.success-${data.reference}`,
        type: 'paid',
        appointmentId: data.metadata.appointmentId,
        reference: data.reference,
        paymentIntentRef: data.reference,
        amount: major(data.amount),
        currency: data.currency?.toUpperCase() ?? null,
      },
    };
  }

  async refund({ reference, amount, currency }: { reference: string; paymentIntentRef?: string | null; amount: number; currency: string }) {
    await this.request('/refund', { transaction: reference, amount: minor(amount), currency: currency.toUpperCase() });
  }
}

export function makeBookingClient(name: BookingProviderName, secretKey: string, webhookSecret: string | null): BookingProviderClient {
  return name === 'stripe' ? new StripeBookingClient(secretKey, webhookSecret) : new PaystackBookingClient(secretKey);
}
