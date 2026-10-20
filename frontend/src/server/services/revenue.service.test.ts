import { describe, it, expect, vi, beforeEach } from 'vitest';

// Monthly recurring revenue: each organization pays in its own currency, the
// total is in the base currency.

const db = vi.hoisted(() => ({ subs: [] as any[], orgs: [] as any[], overrides: [] as any[] }));

vi.mock('../lib/prisma', () => ({
  default: {
    platformSetting: { findUnique: vi.fn(async () => ({ value: { base: 'USD', rates: { USD: 1, GHS: 15, NGN: 1500 } } })) },
    organizationSubscription: { findMany: vi.fn(async () => db.subs) },
    organization: { findMany: vi.fn(async () => db.orgs) },
    planCurrencyPrice: { findMany: vi.fn(async ({ where }: any) => db.overrides.filter((o) => o.planId === where.planId && o.currency === where.currency)) },
  },
}));

import { monthlyRecurringRevenue } from './revenue.service';

const plan = { id: 'p1', currency: 'USD', priceMonthly: 30, priceQuarterly: 81, priceYearly: 300 };
const sub = (id: string, billingCycle: string, p = plan) => ({ id, billingCycle, plan: p });

beforeEach(() => {
  db.subs = [];
  db.orgs = [];
  db.overrides = [];
});

describe('monthlyRecurringRevenue', () => {
  it('adds monthly, quarterly and yearly plans as a month’s worth each', async () => {
    db.subs = [sub('s1', 'monthly'), sub('s2', 'quarterly'), sub('s3', 'yearly')];
    db.orgs = [{ subscriptionId: 's1', currency: 'USD' }, { subscriptionId: 's2', currency: 'USD' }, { subscriptionId: 's3', currency: 'USD' }];
    expect(await monthlyRecurringRevenue()).toEqual({ total: 30 + 27 + 25, currency: 'USD' });
  });

  it('converts what organizations pay in other currencies back to the base', async () => {
    db.subs = [sub('s1', 'monthly'), sub('s2', 'monthly')];
    db.orgs = [{ subscriptionId: 's1', currency: 'GHS' }, { subscriptionId: 's2', currency: 'USD' }];
    // 30 USD -> 450 GHS (converted) -> 30 USD again; plus 30 USD.
    expect((await monthlyRecurringRevenue()).total).toBe(60);
  });

  it('counts a hand-set price in the organization’s currency', async () => {
    db.subs = [sub('s1', 'monthly')];
    db.orgs = [{ subscriptionId: 's1', currency: 'GHS' }];
    db.overrides = [{ planId: 'p1', currency: 'GHS', priceMonthly: 300, priceQuarterly: 810, priceYearly: 3000 }];
    expect((await monthlyRecurringRevenue()).total).toBe(20);
  });

  it('is zero with no subscriptions', async () => {
    expect(await monthlyRecurringRevenue()).toEqual({ total: 0, currency: 'USD' });
  });
});
