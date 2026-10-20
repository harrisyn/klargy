import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import Stripe from 'stripe';
import { makeBookingClient } from './providers';

// The provider clients against the real signature schemes: Stripe's own
// library signs and checks (no network), Paystack's HMAC is computed here the
// way Paystack documents it.

const SECRET = 'whsec_test_secret';

function stripeEvent(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${type}`, object: 'event', type, data: { object } });
  const header = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { body: Buffer.from(payload), header };
}

const session = (over: Record<string, unknown> = {}) => ({
  id: 'cs_test_1',
  object: 'checkout.session',
  payment_status: 'paid',
  payment_intent: 'pi_1',
  amount_total: 2050,
  currency: 'ghs',
  metadata: { kind: 'booking', appointmentId: 'a1', organizationId: 'o1' },
  ...over,
});

describe('Stripe booking webhooks', () => {
  const client = makeBookingClient('stripe', 'sk_test_x', SECRET);

  it('reads a paid booking checkout (amounts back in major units)', () => {
    const { body, header } = stripeEvent('checkout.session.completed', session());
    expect(client.parseWebhook(body, header)).toEqual({
      verified: true,
      event: { eventId: 'evt_checkout.session.completed', type: 'paid', appointmentId: 'a1', reference: 'cs_test_1', paymentIntentRef: 'pi_1', amount: 20.5, currency: 'GHS' },
    });
  });

  it('reads an expired checkout', () => {
    const { body, header } = stripeEvent('checkout.session.expired', session({ payment_status: 'unpaid' }));
    expect(client.parseWebhook(body, header).event).toMatchObject({ type: 'expired', appointmentId: 'a1', reference: 'cs_test_1' });
  });

  it('does not treat an unpaid completed session as paid', () => {
    const { body, header } = stripeEvent('checkout.session.completed', session({ payment_status: 'unpaid' }));
    expect(client.parseWebhook(body, header)).toEqual({ verified: true, event: null });
  });

  it('passes plan and add-on checkouts by (verified, but not a booking)', () => {
    const { body, header } = stripeEvent('checkout.session.completed', session({ metadata: { kind: 'addon', organizationId: 'o1' } }));
    expect(client.parseWebhook(body, header)).toEqual({ verified: true, event: null });
    const plan = stripeEvent('invoice.paid', { id: 'in_1', object: 'invoice' });
    expect(client.parseWebhook(plan.body, plan.header)).toEqual({ verified: true, event: null });
  });

  it('rejects a wrong signature, a tampered body and a missing secret', () => {
    const { body, header } = stripeEvent('checkout.session.completed', session());
    expect(client.parseWebhook(body, 't=1,v1=deadbeef').verified).toBe(false);
    expect(client.parseWebhook(Buffer.from(body.toString().replace('2050', '9999')), header).verified).toBe(false);
    expect(makeBookingClient('stripe', 'sk_test_x', null).parseWebhook(body, header).verified).toBe(false);
    expect(makeBookingClient('stripe', 'sk_test_x', 'whsec_other').parseWebhook(body, header).verified).toBe(false);
  });
});

describe('Paystack booking webhooks', () => {
  const KEY = 'sk_test_paystack';
  const client = makeBookingClient('paystack', KEY, null);
  const sign = (body: string) => crypto.createHmac('sha512', KEY).update(body).digest('hex');
  const charge = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ event: 'charge.success', data: { id: 991, reference: 'bk_a1_ab12', amount: 2000, currency: 'GHS', metadata: { kind: 'booking', appointmentId: 'a1', organizationId: 'o1' }, ...over } });

  it('reads a successful booking charge', () => {
    const body = charge();
    expect(client.parseWebhook(Buffer.from(body), sign(body))).toEqual({
      verified: true,
      event: { eventId: '991', type: 'paid', appointmentId: 'a1', reference: 'bk_a1_ab12', paymentIntentRef: 'bk_a1_ab12', amount: 20, currency: 'GHS' },
    });
  });

  it('passes charges that are not bookings', () => {
    const body = charge({ metadata: { kind: 'addon' } });
    expect(client.parseWebhook(Buffer.from(body), sign(body))).toEqual({ verified: true, event: null });
  });

  it('rejects bad signatures and bodies that are not JSON', () => {
    const body = charge();
    expect(client.parseWebhook(Buffer.from(body), 'nope').verified).toBe(false);
    expect(client.parseWebhook(Buffer.from(body + ' '), sign(body)).verified).toBe(false);
    const junk = 'not json';
    expect(client.parseWebhook(Buffer.from(junk), sign(junk)).verified).toBe(false);
  });
});
