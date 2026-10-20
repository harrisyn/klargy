import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = {
  organizationSubscription: { updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  walletLedgerEntry: { create: vi.fn() },
  organization: { update: vi.fn() },
};

vi.mock('../lib/prisma', () => ({
  default: {
    organization: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    subscriptionPlan: { findUnique: vi.fn() },
    walletLedgerEntry: { aggregate: vi.fn(), create: vi.fn() },
    organizationSubscription: { update: vi.fn() },
    $transaction: vi.fn((fn: any) => fn(tx)),
  },
}));

import prisma from '../lib/prisma';
import { settleOrganizationSubscription, enrollFromWallet, applyWalletToSubscription, creditProviderPayment } from './wallet.service';

const NOW = new Date('2026-06-15T00:00:00Z');
const plan = { id: 'pro', name: 'Pro', currency: 'USD', priceMonthly: 50, priceQuarterly: 135, priceYearly: 500, isActive: true };

function subscription(overrides: any = {}) {
  return {
    id: 'sub1',
    planId: 'pro',
    plan,
    status: 'ACTIVE',
    billingCycle: 'monthly',
    currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
    externalProviderSubscriptionId: null,
    walletManaged: true,
    customPrice: null,
    planOverrideUntil: null,
    planOverrideRevertPlanId: null,
    planOverrideRevertPeriodEnd: null,
    planOverrideEndBehavior: null,
    ...overrides,
  };
}

const balance = (n: number) => (prisma.walletLedgerEntry.aggregate as any).mockResolvedValue({ _sum: { amount: n } });

describe('wallet.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.organizationSubscription.updateMany.mockResolvedValue({ count: 1 });
  });

  describe('settleOrganizationSubscription', () => {
    it('renews a lapsed subscription and records one plan charge', async () => {
      (prisma.organization.findUnique as any).mockResolvedValue({ subscription: subscription() });
      balance(80);
      expect(await settleOrganizationSubscription('org1', NOW)).toBe(true);
      expect(tx.walletLedgerEntry.create).toHaveBeenCalledTimes(1);
      expect(tx.walletLedgerEntry.create.mock.calls[0][0].data).toMatchObject({ organizationId: 'org1', amount: -50, currency: 'USD', kind: 'PLAN_CHARGE' });
      expect(tx.organizationSubscription.update.mock.calls[0][0].data.status).toBe('ACTIVE');
    });

    it('does not charge twice when another settle already claimed the period', async () => {
      (prisma.organization.findUnique as any).mockResolvedValue({ subscription: subscription() });
      balance(80);
      tx.organizationSubscription.updateMany.mockResolvedValue({ count: 0 });
      expect(await settleOrganizationSubscription('org1', NOW)).toBe(false);
      expect(tx.walletLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('ignores subscriptions that are not wallet-managed', async () => {
      (prisma.organization.findUnique as any).mockResolvedValue({ subscription: subscription({ walletManaged: false }) });
      expect(await settleOrganizationSubscription('org1', NOW)).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('enrollFromWallet', () => {
    it('refuses when the wallet cannot cover the plan', async () => {
      (prisma.subscriptionPlan.findUnique as any).mockResolvedValue(plan);
      (prisma.organization.findUnique as any).mockResolvedValue({ subscriptionId: null, subscription: null });
      balance(10);
      const result = await enrollFromWallet('org1', 'pro', 'monthly', NOW);
      expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS', balance: 10, price: 50 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates the subscription and debits the wallet', async () => {
      (prisma.subscriptionPlan.findUnique as any).mockResolvedValue(plan);
      (prisma.organization.findUnique as any).mockResolvedValue({ subscriptionId: null, subscription: null });
      tx.organizationSubscription.create.mockResolvedValue({ id: 'new' });
      balance(100);
      const result = await enrollFromWallet('org1', 'pro', 'monthly', NOW);
      expect(result).toMatchObject({ ok: true, charged: 50 });
      expect(tx.organization.update).toHaveBeenCalledWith({ where: { id: 'org1' }, data: { subscriptionId: 'new' } });
      expect(tx.walletLedgerEntry.create.mock.calls[0][0].data.amount).toBe(-50);
    });

    it('lets a provider-billed organization buy a plan from its wallet', async () => {
      (prisma.subscriptionPlan.findUnique as any).mockResolvedValue(plan);
      (prisma.organization.findUnique as any).mockResolvedValue({
        subscriptionId: 'sub1',
        subscription: subscription({ externalProviderSubscriptionId: 'ext1' }),
      });
      balance(100);
      expect(await enrollFromWallet('org1', 'pro', 'monthly', NOW)).toMatchObject({ ok: true, charged: 50 });
      expect(tx.organizationSubscription.update.mock.calls[0][0].data.walletManaged).toBe(true);
    });
  });

  describe('applyWalletToSubscription', () => {
    it('puts a lapsed legacy subscription on the wallet, then settles it', async () => {
      const legacy = subscription({ walletManaged: false });
      (prisma.organization.findUnique as any)
        .mockResolvedValueOnce({ subscription: legacy })
        .mockResolvedValueOnce({ subscription: { ...legacy, walletManaged: true } });
      balance(80);
      expect(await applyWalletToSubscription('org1', NOW)).toBe(true);
      expect((prisma.organizationSubscription.update as any).mock.calls[0][0].data).toEqual({ walletManaged: true });
    });

    it('also applies to provider-billed subscriptions', async () => {
      const prov = subscription({ externalProviderSubscriptionId: 'ext1' });
      (prisma.organization.findUnique as any)
        .mockResolvedValueOnce({ subscription: prov })
        .mockResolvedValueOnce({ subscription: prov });
      balance(80);
      expect(await applyWalletToSubscription('org1', NOW)).toBe(true);
    });
  });

  describe('creditProviderPayment', () => {
    it('credits once and ignores a retried event', async () => {
      (prisma.walletLedgerEntry.create as any)
        .mockResolvedValueOnce({ id: 'e1' })
        .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      const args = { organizationId: 'org1', amount: 50, currency: 'USD', provider: 'stripe', eventId: 'evt_1' };
      expect(await creditProviderPayment(args)).toBe(true);
      expect(await creditProviderPayment(args)).toBe(false);
      expect((prisma.walletLedgerEntry.create as any).mock.calls[0][0].data).toMatchObject({ kind: 'PAYMENT', externalRef: 'stripe:evt_1', amount: 50 });
    });
  });
});
