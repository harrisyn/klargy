import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// What the provider clients actually send. Stripe's SDK is replaced by a
// recorder; Paystack goes through fetch, which is stubbed.

const stripeCalls = vi.hoisted(() => ({ sessions: [] as any[], refunds: [] as any[], expired: [] as string[] }));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        create: async (p: any) => { stripeCalls.sessions.push(p); return { id: 'cs_1', url: 'https://checkout.stripe.test/c/cs_1' }; },
        expire: async (id: string) => { stripeCalls.expired.push(id); },
      },
    };
    refunds = { create: async (p: any) => { stripeCalls.refunds.push(p); return {}; } };
    webhooks = {};
  },
}));

import { makeBookingClient } from './providers';

const input = {
  appointmentId: 'a1',
  organizationId: 'o1',
  amount: 20.5,
  currency: 'GHS',
  description: 'Haircut at Main',
  customerEmail: 'ada@example.com',
  successUrl: 'https://salon.test/booking/t?paid=1',
  cancelUrl: 'https://salon.test/booking/t',
};

beforeEach(() => {
  stripeCalls.sessions = [];
  stripeCalls.refunds = [];
  stripeCalls.expired = [];
});

describe('Stripe requests', () => {
  const client = makeBookingClient('stripe', 'sk_test_x', 'whsec');

  it('creates a one-off checkout in minor units, tagged with the booking', async () => {
    const r = await client.createCheckout(input);
    expect(r).toEqual({ redirectUrl: 'https://checkout.stripe.test/c/cs_1', reference: 'cs_1' });
    const p = stripeCalls.sessions[0];
    expect(p).toMatchObject({
      mode: 'payment',
      customer_email: 'ada@example.com',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: { kind: 'booking', appointmentId: 'a1', organizationId: 'o1' },
      payment_intent_data: { metadata: { kind: 'booking', appointmentId: 'a1', organizationId: 'o1' } },
    });
    expect(p.line_items[0]).toEqual({ price_data: { currency: 'ghs', product_data: { name: 'Haircut at Main' }, unit_amount: 2050 }, quantity: 1 });
    // Stripe's minimum session lifetime is 30 minutes.
    expect(p.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
  });

  it('refunds the payment intent for the amount, and can expire a session', async () => {
    await client.refund({ reference: 'cs_1', paymentIntentRef: 'pi_1', amount: 12.34, currency: 'GHS' });
    expect(stripeCalls.refunds).toEqual([{ payment_intent: 'pi_1', amount: 1234 }]);
    await client.expire!('cs_1');
    expect(stripeCalls.expired).toEqual(['cs_1']);
  });

  it('cannot refund a payment it never recorded', async () => {
    await expect(client.refund({ reference: 'cs_1', paymentIntentRef: null, amount: 5, currency: 'GHS' })).rejects.toThrow(/no Stripe payment/);
  });
});

describe('Paystack requests', () => {
  const client = makeBookingClient('paystack', 'sk_test_ps', null);
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const ok = (data: unknown) => ({ ok: true, json: async () => ({ status: true, data }) });

  it('initialises a transaction in minor units with the booking in its metadata', async () => {
    fetchMock.mockResolvedValue(ok({ authorization_url: 'https://checkout.paystack.test/abc' }));
    const r = await client.createCheckout(input);
    expect(r.redirectUrl).toBe('https://checkout.paystack.test/abc');
    expect(r.reference).toMatch(/^bk_a1_[0-9a-f]{8}$/);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect(init.headers.Authorization).toBe('Bearer sk_test_ps');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ email: 'ada@example.com', amount: 2050, currency: 'GHS', reference: r.reference, callback_url: input.successUrl });
    expect(body.metadata).toMatchObject({ kind: 'booking', appointmentId: 'a1', organizationId: 'o1' });
  });

  it('refunds by transaction reference', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await client.refund({ reference: 'bk_a1_ab12', amount: 7.5, currency: 'ghs' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.paystack.co/refund');
    expect(JSON.parse(init.body)).toEqual({ transaction: 'bk_a1_ab12', amount: 750, currency: 'GHS' });
  });

  it('turns a Paystack error into an error', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Bad', json: async () => ({ status: false, message: 'Invalid key' }) });
    await expect(client.createCheckout(input)).rejects.toThrow(/Invalid key/);
  });
});
