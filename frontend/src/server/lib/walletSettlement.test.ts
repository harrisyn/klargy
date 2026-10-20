import { describe, it, expect } from 'vitest';
import { resolveSettlement, SettlementInput, PlanPricing } from './walletSettlement';

const NOW = new Date('2026-06-15T00:00:00Z');
const PAST = new Date('2026-06-01T00:00:00Z');
const FUTURE = new Date('2026-07-01T00:00:00Z');

const pro: PlanPricing = { id: 'pro', currency: 'USD', priceMonthly: 50, priceQuarterly: 135, priceYearly: 500 };
const starter: PlanPricing = { id: 'starter', currency: 'USD', priceMonthly: 20, priceQuarterly: 55, priceYearly: 200 };

function sub(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    status: 'ACTIVE',
    billingCycle: 'monthly',
    currentPeriodEnd: PAST,
    hasProviderSubscription: false,
    walletManaged: true,
    customPrice: null,
    planOverrideUntil: null,
    planOverrideRevertPlanId: null,
    planOverrideRevertPeriodEnd: null,
    planOverrideEndBehavior: null,
    plan: pro,
    revertPlan: null,
    ...overrides,
  };
}

describe('resolveSettlement', () => {
  it('gives provider-billed subscriptions a grace period before renewing or flagging', () => {
    const justLapsed = new Date('2026-06-13T00:00:00Z');
    expect(resolveSettlement(sub({ hasProviderSubscription: true, currentPeriodEnd: justLapsed }), NOW, 0)).toEqual({ patch: null, charge: null });
    expect(resolveSettlement(sub({ hasProviderSubscription: true, currentPeriodEnd: PAST }), NOW, 0).patch).toEqual({ status: 'PAST_DUE' });
  });

  it('renews provider-billed subscriptions from the wallet like any other', () => {
    expect(resolveSettlement(sub({ hasProviderSubscription: true }), NOW, 60).charge?.amount).toBe(50);
  });

  it('leaves subscriptions that were never on the wallet alone', () => {
    expect(resolveSettlement(sub({ walletManaged: false }), NOW, 1000)).toEqual({ patch: null, charge: null });
  });

  it('does nothing while the period is still running', () => {
    expect(resolveSettlement(sub({ currentPeriodEnd: FUTURE }), NOW, 1000)).toEqual({ patch: null, charge: null });
  });

  it('renews from the wallet when the period has lapsed and funds cover it', () => {
    const r = resolveSettlement(sub(), NOW, 60);
    expect(r.charge).toEqual({ amount: 50, currency: 'USD', reason: 'Plan renewal (monthly)' });
    expect(r.patch).toMatchObject({ status: 'ACTIVE', currentPeriodStart: NOW });
    expect(r.patch!.currentPeriodEnd).toEqual(new Date('2026-07-15T00:00:00Z'));
  });

  it('charges the cycle price for yearly subscriptions', () => {
    const r = resolveSettlement(sub({ billingCycle: 'yearly' }), NOW, 600);
    expect(r.charge?.amount).toBe(500);
    expect(r.patch!.currentPeriodEnd).toEqual(new Date('2027-06-15T00:00:00Z'));
  });

  it('flags PAST_DUE without extending when funds are short', () => {
    const r = resolveSettlement(sub(), NOW, 10);
    expect(r.charge).toBeNull();
    expect(r.patch).toEqual({ status: 'PAST_DUE' });
  });

  it('re-enrols an EXPIRED subscription once the wallet is topped up', () => {
    const r = resolveSettlement(sub({ status: 'EXPIRED', currentPeriodEnd: FUTURE }), NOW, 50);
    expect(r.charge?.amount).toBe(50);
    expect(r.patch?.status).toBe('ACTIVE');
  });

  it('never revives a CANCELLED subscription', () => {
    expect(resolveSettlement(sub({ status: 'CANCELLED' }), NOW, 1000)).toEqual({ patch: null, charge: null });
  });

  it('uses the custom price instead of the plan price', () => {
    const r = resolveSettlement(sub({ customPrice: 30 }), NOW, 35);
    expect(r.charge?.amount).toBe(30);
  });

  it('extends for free when the price is zero', () => {
    const r = resolveSettlement(sub({ customPrice: 0 }), NOW, 0);
    expect(r.charge).toBeNull();
    expect(r.patch?.status).toBe('ACTIVE');
  });

  describe('plan override ending', () => {
    const base = {
      planOverrideUntil: PAST,
      planOverrideRevertPlanId: 'starter',
      planOverrideRevertPeriodEnd: FUTURE,
      revertPlan: starter,
    };

    it('does nothing before the override ends', () => {
      const r = resolveSettlement(sub({ ...base, planOverrideUntil: FUTURE, planOverrideEndBehavior: 'REVERT', currentPeriodEnd: FUTURE }), NOW, 0);
      expect(r).toEqual({ patch: null, charge: null });
    });

    it('REVERT returns to the original plan and its paid period without charging', () => {
      const r = resolveSettlement(sub({ ...base, planOverrideEndBehavior: 'REVERT', customPrice: 0 }), NOW, 0);
      expect(r.charge).toBeNull();
      expect(r.patch).toMatchObject({
        planId: 'starter',
        customPrice: null,
        planOverrideUntil: null,
        planOverrideEndBehavior: null,
        currentPeriodEnd: FUTURE,
      });
    });

    it('REVERT charges the original plan if its paid period had also lapsed', () => {
      const r = resolveSettlement(sub({ ...base, planOverrideRevertPeriodEnd: PAST, planOverrideEndBehavior: 'REVERT' }), NOW, 25);
      expect(r.charge).toEqual({ amount: 20, currency: 'USD', reason: 'Plan renewal (monthly)' });
      expect(r.patch?.planId).toBe('starter');
    });

    it('KEEP_AT_CUSTOM_PRICE stays on the plan and bills the custom price from the wallet', () => {
      const r = resolveSettlement(sub({ ...base, planOverrideEndBehavior: 'KEEP_AT_CUSTOM_PRICE', customPrice: 15 }), NOW, 40);
      expect(r.charge?.amount).toBe(15);
      expect(r.patch?.planId).toBeUndefined();
      expect(r.patch).toMatchObject({ planOverrideUntil: null, status: 'ACTIVE' });
    });

    it('KEEP_AT_CUSTOM_PRICE goes PAST_DUE when the wallet cannot pay', () => {
      const r = resolveSettlement(sub({ ...base, planOverrideEndBehavior: 'KEEP_AT_CUSTOM_PRICE', customPrice: 15 }), NOW, 5);
      expect(r.charge).toBeNull();
      expect(r.patch).toMatchObject({ status: 'PAST_DUE', planOverrideUntil: null });
    });
  });
});
