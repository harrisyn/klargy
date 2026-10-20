import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  default: {
    organizationAddOn: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    organizationSubscription: { findFirst: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
}));

// Booking payments arrive on the same endpoint; these tests are about plan billing.
vi.mock('../bookingWebhook.controller', () => ({ tryPlatformBookingEvent: vi.fn(async () => 'not-booking') }));
vi.mock('../../services/wallet.service', () => ({
  creditProviderPayment: vi.fn(async () => true),
  enrollFromWallet: vi.fn(async () => ({ ok: true })),
  settleOrganizationSubscription: vi.fn(async () => true),
}));

vi.mock('../../services/payments', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../../services/payments/idempotency', () => ({
  wasAlreadyProcessed: vi.fn(async () => false),
  markProcessed: vi.fn(async () => {}),
}));

import prisma from '../../lib/prisma';
import { getProvider } from '../../services/payments';
import { handleStripeWebhook } from '../paymentWebhook.controller';
import { creditProviderPayment, enrollFromWallet, settleOrganizationSubscription } from '../../services/wallet.service';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq(): any {
  return { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') };
}

describe('paymentWebhook - add-on dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new OrganizationAddOn on a one-off addon checkout_completed event', async () => {
    (getProvider as any).mockResolvedValue({
      verifyWebhookSignature: () => ({
        eventId: 'evt_1',
        type: 'checkout_completed',
        organizationId: 'org1',
        externalSubscriptionId: null,
        currentPeriodEnd: null,
        planId: null,
        billingCycle: null,
        kind: 'addon',
        addOn: { resourceType: 'LOCATIONS', quantity: 2, billingMode: 'one_off' },
      }),
    });

    await handleStripeWebhook(makeReq(), makeRes());

    expect(prisma.organizationAddOn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org1',
        resourceType: 'LOCATIONS',
        quantity: 2,
        billingMode: 'ONE_OFF',
        status: 'ACTIVE',
        externalSubscriptionId: null,
        currentPeriodEnd: null,
      }),
    });
  });

  it('creates a new OrganizationAddOn on a recurring addon checkout_completed event', async () => {
    (getProvider as any).mockResolvedValue({
      verifyWebhookSignature: () => ({
        eventId: 'evt_2',
        type: 'checkout_completed',
        organizationId: 'org1',
        externalSubscriptionId: 'sub_addon_1',
        currentPeriodEnd: null,
        planId: null,
        billingCycle: null,
        kind: 'addon',
        addOn: { resourceType: 'USERS', quantity: 3, billingMode: 'recurring' },
      }),
    });
    (prisma.organizationAddOn.findFirst as any).mockResolvedValue(null);

    await handleStripeWebhook(makeReq(), makeRes());

    expect(prisma.organizationAddOn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org1',
        resourceType: 'USERS',
        quantity: 3,
        billingMode: 'RECURRING',
        status: 'ACTIVE',
        externalSubscriptionId: 'sub_addon_1',
      }),
    });
  });

  it('treats a repeat charge.success on the same recurring subscription as a renewal, not a new purchase', async () => {
    (getProvider as any).mockResolvedValue({
      verifyWebhookSignature: () => ({
        eventId: 'evt_3',
        type: 'checkout_completed',
        organizationId: 'org1',
        externalSubscriptionId: 'sub_addon_1',
        currentPeriodEnd: null,
        planId: null,
        billingCycle: null,
        kind: 'addon',
        addOn: { resourceType: 'USERS', quantity: 3, billingMode: 'recurring' },
      }),
    });
    (prisma.organizationAddOn.findFirst as any).mockResolvedValue({ id: 'addon1', status: 'ACTIVE' });

    await handleStripeWebhook(makeReq(), makeRes());

    expect(prisma.organizationAddOn.update).toHaveBeenCalledWith({
      where: { id: 'addon1' },
      data: expect.objectContaining({ currentPeriodEnd: expect.any(Date) }),
    });
    expect(prisma.organizationAddOn.create).not.toHaveBeenCalled();
  });

  it('cancels the matching OrganizationAddOn on a subscription_cancelled event', async () => {
    (getProvider as any).mockResolvedValue({
      verifyWebhookSignature: () => ({
        eventId: 'evt_4',
        type: 'subscription_cancelled',
        organizationId: null,
        externalSubscriptionId: 'sub_addon_1',
        currentPeriodEnd: null,
        planId: null,
        billingCycle: null,
        kind: 'plan', // provider can't reliably know kind for this event type - dispatch is lookup-based
      }),
    });
    (prisma.organizationAddOn.findFirst as any).mockResolvedValue({ id: 'addon1', status: 'ACTIVE' });

    await handleStripeWebhook(makeReq(), makeRes());

    expect(prisma.organizationAddOn.update).toHaveBeenCalledWith({
      where: { id: 'addon1' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
    expect(prisma.organizationSubscription.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to plan-subscription handling when no add-on matches externalSubscriptionId', async () => {
    (getProvider as any).mockResolvedValue({
      verifyWebhookSignature: () => ({
        eventId: 'evt_5',
        type: 'subscription_cancelled',
        organizationId: null,
        externalSubscriptionId: 'sub_plan_1',
        currentPeriodEnd: null,
        planId: null,
        billingCycle: null,
        kind: 'plan',
      }),
    });
    (prisma.organizationAddOn.findFirst as any).mockResolvedValue(null);
    (prisma.organizationSubscription.findFirst as any).mockResolvedValue(null);

    await handleStripeWebhook(makeReq(), makeRes());

    expect(prisma.organizationAddOn.update).not.toHaveBeenCalled();
    expect(prisma.organizationSubscription.findFirst).toHaveBeenCalledWith({
      where: { externalProviderSubscriptionId: 'sub_plan_1' },
      include: { organizations: true },
    });
  });
});

describe('paymentWebhook - plan payments go through the wallet', () => {
  beforeEach(() => vi.clearAllMocks());

  const planEvent = (over: any = {}) => ({
    eventId: 'evt_p1',
    type: 'checkout_completed',
    organizationId: 'org1',
    externalSubscriptionId: 'sub_ext',
    currentPeriodEnd: null,
    planId: 'pro',
    billingCycle: 'monthly',
    kind: 'plan',
    amount: 50,
    currency: 'USD',
    ...over,
  });

  beforeEach(() => {
    (prisma.organization.findUnique as any).mockResolvedValue({ id: 'org1', subscriptionId: 'sub1', subscription: { id: 'sub1', currentPeriodEnd: new Date(0) } });
  });

  it('credits the payment to the wallet, then buys the plan from it', async () => {
    (getProvider as any).mockResolvedValue({ verifyWebhookSignature: () => planEvent() });
    await handleStripeWebhook(makeReq(), makeRes());
    expect(creditProviderPayment).toHaveBeenCalledWith({ organizationId: 'org1', amount: 50, currency: 'USD', provider: 'stripe', eventId: 'evt_p1' });
    expect(enrollFromWallet).toHaveBeenCalledWith('org1', 'pro', 'monthly');
    expect(prisma.organizationSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub1' },
      data: { provider: 'stripe', externalProviderSubscriptionId: 'sub_ext' },
    });
  });

  it('does not enrol again when the same checkout event is retried', async () => {
    (creditProviderPayment as any).mockResolvedValueOnce(false);
    (getProvider as any).mockResolvedValue({ verifyWebhookSignature: () => planEvent() });
    await handleStripeWebhook(makeReq(), makeRes());
    expect(enrollFromWallet).not.toHaveBeenCalled();
  });

  it('credits a renewal payment and settles the subscription from the wallet', async () => {
    (getProvider as any).mockResolvedValue({
      verifyWebhookSignature: () => planEvent({ eventId: 'evt_r1', type: 'renewal_succeeded', planId: null, billingCycle: null, organizationId: null }),
    });
    (prisma.organizationSubscription.findFirst as any).mockResolvedValue({ organizations: [{ id: 'org1' }] });
    await handleStripeWebhook(makeReq(), makeRes());
    expect(creditProviderPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 50, eventId: 'evt_r1' }));
    expect(settleOrganizationSubscription).toHaveBeenCalledWith('org1', expect.any(Date));
    expect(enrollFromWallet).not.toHaveBeenCalled();
  });
});
