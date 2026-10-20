import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pricing, confirming payments from webhooks, expiring unpaid holds, refunds.

const db = vi.hoisted(() => ({
  appt: {} as any,
  processed: new Set<string>(),
  claimOk: true,
  refunds: [] as any[],
  expired: [] as string[],
}));

vi.mock('../../lib/encryption', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock('../../lib/prisma', () => ({
  default: {
    appointment: {
      findUnique: vi.fn(async () => db.appt),
      update: vi.fn(async ({ data }: any) => Object.assign(db.appt, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (db.appt.status !== where.status) return { count: 0 };
        Object.assign(db.appt, data);
        return { count: 1 };
      }),
      findMany: vi.fn(async () => (db.appt.status === 'PENDING_PAYMENT' && db.appt.paymentExpiresAt < new Date() ? [db.appt] : [])),
    },
    paymentProviderConfig: { findUnique: vi.fn(async () => ({ provider: 'stripe', secretKey: 'sk', webhookSecret: 'wh' })), findMany: vi.fn(async () => []) },
    orgPaymentProvider: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../../middleware/subscription.middleware', () => ({ getOrganizationFeatures: vi.fn(async () => ({ ownPaymentKeys: true })) }));
vi.mock('../payments/idempotency', () => ({
  wasAlreadyProcessed: vi.fn(async (scope: string, id: string) => db.processed.has(`${scope}:${id}`)),
  markProcessed: vi.fn(async (scope: string, id: string) => { db.processed.add(`${scope}:${id}`); }),
}));
vi.mock('../booking.service', async () => {
  const actual = await vi.importActual<typeof import('../booking.service')>('../booking.service');
  return { ...actual, claimSlot: vi.fn(async () => db.claimOk), releaseSlot: vi.fn(async () => {}) };
});
vi.mock('../payoutWallet.service', () => ({ recordPlatformSale: vi.fn(async () => {}), recordPlatformRefund: vi.fn(async () => {}) }));
vi.mock('../bookingNotifications.service', () => ({ sendBookingConfirmation: vi.fn(async () => {}) }));
vi.mock('../queueEvents.service', () => ({ recordQueueEvent: vi.fn(async () => {}) }));
vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers');
  return {
    ...actual,
    makeBookingClient: vi.fn(() => ({
      name: 'stripe',
      refund: vi.fn(async (r: any) => { db.refunds.push(r); }),
      expire: vi.fn(async (ref: string) => { db.expired.push(ref); }),
    })),
  };
});

import { applyBookingEvent, expireUnpaidBookings, refundBooking } from './bookingPayments.service';
import { recordPlatformSale, recordPlatformRefund } from '../payoutWallet.service';
import { sendBookingConfirmation } from '../bookingNotifications.service';
import { recordQueueEvent } from '../queueEvents.service';
import { releaseSlot, claimSlot } from '../booking.service';

const HOUR = 3_600_000;

function pending(over: object = {}) {
  return {
    id: 'a1',
    slotId: 'sl1',
    status: 'PENDING_PAYMENT',
    paymentStatus: 'PENDING',
    paymentSource: 'PLATFORM',
    paymentProvider: 'stripe',
    paymentRef: 'cs_1',
    paymentIntentRef: null,
    paymentExpiresAt: new Date(Date.now() + 10 * 60_000),
    amount: 80,
    amountDue: 20,
    amountPaid: null,
    currency: 'USD',
    partySize: 4,
    startTime: new Date(Date.now() + 48 * HOUR),
    service: { bookingUnit: 'PERSON', refundCutoffHours: 24, location: { organizationId: 'o1' } },
    ...over,
  };
}
const paid = (over: object = {}) => ({ eventId: 'evt_1', type: 'paid' as const, appointmentId: 'a1', reference: 'cs_1', paymentIntentRef: 'pi_1', amount: 20, currency: 'USD', ...over });

beforeEach(() => {
  db.appt = pending();
  db.processed = new Set();
  db.claimOk = true;
  db.refunds = [];
  db.expired = [];
  vi.clearAllMocks();
});

describe('payment webhooks', () => {
  it('confirms the booking, credits the payout wallet and emails the customer', async () => {
    expect(await applyBookingEvent('platform:stripe', paid())).toBe('applied');
    expect(db.appt).toMatchObject({ status: 'SCHEDULED', paymentStatus: 'PAID', amountPaid: 20, paymentIntentRef: 'pi_1', paymentExpiresAt: null });
    expect(recordPlatformSale).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'o1', amount: 20, currency: 'USD', ref: 'cs_1' }));
    expect(sendBookingConfirmation).toHaveBeenCalledWith('a1');
    // Integrations hear about the booking once it is paid, with the party and the money.
    expect(recordQueueEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'appointment.created', data: expect.objectContaining({ partySize: 4, payment: { total: 80, paid: 20, currency: 'USD' } }) }));
  });

  it('does not touch the payout wallet for an organization’s own keys', async () => {
    db.appt = pending({ paymentSource: 'ORG' });
    await applyBookingEvent('org:o1:stripe', paid(), 'o1');
    expect(db.appt.paymentStatus).toBe('PAID');
    expect(recordPlatformSale).not.toHaveBeenCalled();
  });

  it('applies a repeated event once', async () => {
    await applyBookingEvent('platform:stripe', paid());
    expect(await applyBookingEvent('platform:stripe', paid())).toBe('duplicate');
    expect(recordPlatformSale).toHaveBeenCalledTimes(1);
  });

  it('ignores an event whose reference is not the one we issued', async () => {
    expect(await applyBookingEvent('platform:stripe', paid({ reference: 'cs_other' }))).toBe('ignored');
    expect(db.appt.status).toBe('PENDING_PAYMENT');
  });

  it('ignores an event meant for another organization’s keys', async () => {
    expect(await applyBookingEvent('org:o2:stripe', paid(), 'o2')).toBe('ignored');
    expect(db.appt.status).toBe('PENDING_PAYMENT');
  });

  it('revives a booking paid just after its hold lapsed, if the place is still free', async () => {
    db.appt = pending({ status: 'CANCELLED', paymentStatus: 'EXPIRED' });
    await applyBookingEvent('platform:stripe', paid());
    expect(claimSlot).toHaveBeenCalledWith('sl1', 4);
    expect(db.appt).toMatchObject({ status: 'SCHEDULED', paymentStatus: 'PAID' });
  });

  it('refunds a late payment when the place has gone', async () => {
    db.appt = pending({ status: 'CANCELLED', paymentStatus: 'EXPIRED' });
    db.claimOk = false;
    await applyBookingEvent('platform:stripe', paid());
    expect(db.appt.status).toBe('CANCELLED');
    expect(db.refunds).toEqual([expect.objectContaining({ amount: 20, reference: 'cs_1', paymentIntentRef: 'pi_1' })]);
    expect(db.appt.paymentStatus).toBe('REFUNDED');
  });
});

describe('unpaid holds', () => {
  it('frees the places of bookings whose payment never came', async () => {
    db.appt = pending({ paymentExpiresAt: new Date(Date.now() - 60_000) });
    expect(await expireUnpaidBookings()).toBe(1);
    expect(db.appt).toMatchObject({ status: 'CANCELLED', paymentStatus: 'EXPIRED' });
    expect(releaseSlot).toHaveBeenCalledWith('sl1', 4);
    expect(db.expired).toEqual(['cs_1']);
  });

  it('leaves holds that have not lapsed', async () => {
    expect(await expireUnpaidBookings()).toBe(0);
    expect(db.appt.status).toBe('PENDING_PAYMENT');
  });
});

describe('refunds', () => {
  const paidAppt = (over: object = {}) => pending({ status: 'SCHEDULED', paymentStatus: 'PAID', amountPaid: 20, paymentIntentRef: 'pi_1', ...over });

  it('refunds in full when cancelled before the cutoff', async () => {
    db.appt = paidAppt();
    const r = await refundBooking('a1', { policy: 'CUTOFF' });
    expect(r.refunded).toBe(20);
    expect(db.appt.paymentStatus).toBe('REFUNDED');
    expect(recordPlatformRefund).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 'a1', amount: 20 }));
  });

  it('keeps the deposit when cancelled inside the cutoff', async () => {
    db.appt = paidAppt({ startTime: new Date(Date.now() + 5 * HOUR) });
    expect((await refundBooking('a1', { policy: 'CUTOFF' })).refunded).toBe(0);
    expect(db.refunds).toHaveLength(0);
    expect(db.appt.paymentStatus).toBe('PAID');
  });

  it('refunds staff cancellations in full whatever the timing', async () => {
    db.appt = paidAppt({ startTime: new Date(Date.now() + 1 * HOUR) });
    expect((await refundBooking('a1', { policy: 'FULL' })).refunded).toBe(20);
  });

  it('refunds nothing for a booking that was never paid', async () => {
    expect((await refundBooking('a1', { policy: 'FULL' })).refunded).toBe(0);
  });
});
