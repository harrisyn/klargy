import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supported currencies, conversion rates, and plans priced per currency.

const db = vi.hoisted(() => ({
  setting: null as any,
  orgCurrencies: [] as { currency: string; _count: number }[],
  overrides: [] as any[],
  deleted: [] as string[],
  created: [] as any[],
  counts: { wallet: 0, payouts: 0, requests: 0, holds: 0 },
  sums: { wallet: 0, payouts: 0 },
  providerSub: null as string | null,
}));

vi.mock('../lib/prisma', () => {
  const api: any = {
    platformSetting: {
      findUnique: vi.fn(async () => (db.setting ? { value: db.setting } : null)),
      upsert: vi.fn(async ({ update }: any) => { db.setting = update.value; }),
    },
    organization: {
      groupBy: vi.fn(async () => db.orgCurrencies),
      findUnique: vi.fn(async () => ({ subscription: db.providerSub ? { externalProviderSubscriptionId: db.providerSub } : null })),
    },
    walletLedgerEntry: { count: vi.fn(async () => db.counts.wallet), aggregate: vi.fn(async () => ({ _sum: { amount: db.sums.wallet } })) },
    payoutLedgerEntry: { count: vi.fn(async () => db.counts.payouts), aggregate: vi.fn(async () => ({ _sum: { amount: db.sums.payouts } })) },
    payoutRequest: { count: vi.fn(async () => db.counts.requests) },
    appointment: { count: vi.fn(async () => db.counts.holds) },
    planCurrencyPrice: {
      findMany: vi.fn(async () => db.overrides),
      deleteMany: vi.fn(async ({ where }: any) => { db.deleted.push(where.planId); return {}; }),
      createMany: vi.fn(async ({ data }: any) => { db.created.push(...data); return {}; }),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { default: api };
});

import { convertAmount, currencyChangeBlock, getCurrencyConfig, priceInCurrency, planForCurrency, refreshRatesFromFeed, saveCurrencyConfig, savePlanCurrencyPrices, supportedCurrencies, toBase } from './currency.service';

const config = { base: 'USD', rates: { USD: 1, GHS: 15, NGN: 1500 } };
const plan = { id: 'p1', currency: 'USD', priceMonthly: 10, priceQuarterly: 27, priceYearly: 100 };

beforeEach(() => {
  db.setting = null;
  db.orgCurrencies = [];
  db.overrides = [];
  db.deleted = [];
  db.created = [];
  db.counts = { wallet: 0, payouts: 0, requests: 0, holds: 0 };
  db.sums = { wallet: 0, payouts: 0 };
  db.providerSub = null;
});

describe('conversion', () => {
  it('converts through the base rates', () => {
    expect(convertAmount(10, 'USD', 'GHS', config)).toBe(150);
    expect(convertAmount(150, 'GHS', 'USD', config)).toBe(10);
    expect(convertAmount(15, 'GHS', 'NGN', config)).toBe(1500);
  });
  it('gives up when a rate is missing', () => {
    expect(convertAmount(10, 'USD', 'EUR', config)).toBeNull();
  });
});

describe('plan prices by currency', () => {
  it('leaves a plan alone in its own currency', () => {
    expect(priceInCurrency(plan, 'USD', [], config)).toMatchObject({ currency: 'USD', priceMonthly: 10, priceSource: 'PLAN' });
  });
  it('converts at the platform rate when no price was set by hand', () => {
    expect(priceInCurrency(plan, 'GHS', [], config)).toMatchObject({ currency: 'GHS', priceMonthly: 150, priceQuarterly: 405, priceYearly: 1500, priceSource: 'CONVERTED' });
  });
  it('prefers a hand-set price', () => {
    const own = [{ currency: 'GHS', priceMonthly: 99, priceQuarterly: 270, priceYearly: 999 }];
    expect(priceInCurrency(plan, 'GHS', own, config)).toMatchObject({ currency: 'GHS', priceMonthly: 99, priceYearly: 999, priceSource: 'OVERRIDE' });
  });
  it('keeps the plan’s own price when there is no rate to convert with', () => {
    expect(priceInCurrency(plan, 'EUR', [], config)).toMatchObject({ currency: 'USD', priceMonthly: 10, priceSource: 'PLAN' });
  });
  it('keeps a free plan free', () => {
    expect(priceInCurrency({ ...plan, priceMonthly: 0, priceQuarterly: 0, priceYearly: 0 }, 'NGN', [], config)).toMatchObject({ currency: 'NGN', priceMonthly: 0, priceYearly: 0 });
  });
  it('prices a plan for an organization from the stored rates and overrides', async () => {
    db.setting = { base: 'USD', rates: { USD: 1, GHS: 12 } };
    db.overrides = [{ currency: 'GHS', priceMonthly: 111, priceQuarterly: 300, priceYearly: 1100 }];
    expect((await planForCurrency(plan, 'GHS')).priceMonthly).toBe(111);
    db.overrides = [];
    expect((await planForCurrency(plan, 'GHS')).priceMonthly).toBe(120);
  });
});

describe('platform currencies', () => {
  it('starts with just the base', async () => {
    const c = await getCurrencyConfig();
    expect(c).toEqual({ base: 'USD', rates: { USD: 1 } });
    expect(supportedCurrencies({ base: 'USD', rates: { USD: 1, NGN: 2, GHS: 3 } })).toEqual(['USD', 'GHS', 'NGN']);
  });

  it('saves rates, keeping the base at 1', async () => {
    const saved = await saveCurrencyConfig({ rates: { ghs: 15.5, NGN: '1500', USD: 99 } });
    expect(saved).toEqual({ base: 'USD', rates: { USD: 1, GHS: 15.5, NGN: 1500 } });
  });

  it('rejects bad codes and rates', async () => {
    await expect(saveCurrencyConfig({ rates: { DOLLAR: 2 } })).rejects.toThrow(/three-letter/);
    await expect(saveCurrencyConfig({ rates: { GHS: 0 } })).rejects.toThrow(/more than zero/);
  });

  it('will not drop a currency an organization still uses', async () => {
    db.setting = { base: 'USD', rates: { USD: 1, GHS: 15 } };
    db.orgCurrencies = [{ currency: 'GHS', _count: 3 }];
    await expect(saveCurrencyConfig({ rates: {} })).rejects.toThrow(/GHS is still used by 3/);
  });

  it('stores hand-set plan prices, ignoring the plan’s own currency and refusing unsupported ones', async () => {
    db.setting = { base: 'USD', rates: { USD: 1, GHS: 15 } };
    await savePlanCurrencyPrices('p1', 'USD', [
      { currency: 'USD', priceMonthly: 1, priceQuarterly: 1, priceYearly: 1 },
      { currency: 'GHS', priceMonthly: 99, priceQuarterly: 270, priceYearly: 999 },
    ]);
    expect(db.created).toEqual([{ planId: 'p1', currency: 'GHS', priceMonthly: 99, priceQuarterly: 270, priceYearly: 999 }]);
    await expect(savePlanCurrencyPrices('p1', 'USD', [{ currency: 'EUR', priceMonthly: 1, priceQuarterly: 1, priceYearly: 1 }])).rejects.toThrow(/isn’t a supported/);
  });
});

describe('market rates', () => {
  const feed = (rates: Record<string, number>, over: object = {}) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: 'success', rates, ...over }) })) as unknown as typeof fetch;

  it('updates the rates of the currencies you support and says which the market lacks', async () => {
    db.setting = { base: 'USD', rates: { USD: 1, GHS: 10, NGN: 1000, XXX: 5 } };
    const f = feed({ GHS: 15.123456789, NGN: 1620 });
    const now = new Date('2026-10-22T10:00:00Z');
    const r = await refreshRatesFromFeed(f, now);
    expect(r.updated.sort()).toEqual(['GHS', 'NGN']);
    expect(r.unavailable).toEqual(['XXX']);
    expect(r.config.rates).toEqual({ USD: 1, GHS: 15.123457, NGN: 1620, XXX: 5 });
    expect(r.config.refreshedAt).toBe(now.toISOString());
    expect(db.setting.rates.GHS).toBe(15.123457);
    expect((f as any).mock.calls[0][0]).toBe('https://open.er-api.com/v6/latest/USD');
  });

  it('keeps the old rates when the service fails or answers oddly', async () => {
    db.setting = { base: 'USD', rates: { USD: 1, GHS: 10 } };
    await expect(refreshRatesFromFeed(vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch)).rejects.toThrow(/503/);
    await expect(refreshRatesFromFeed(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).rejects.toThrow(/reach/);
    await expect(refreshRatesFromFeed(feed({}, { result: 'error' }))).rejects.toThrow(/unexpected/);
    expect(db.setting.rates.GHS).toBe(10);
  });

  it('remembers when rates were refreshed across manual edits', async () => {
    db.setting = { base: 'USD', rates: { USD: 1, GHS: 10 }, refreshedAt: '2026-10-22T10:00:00.000Z' };
    const saved = await saveCurrencyConfig({ rates: { GHS: 11 } });
    expect(saved.refreshedAt).toBe('2026-10-22T10:00:00.000Z');
  });

  it('expresses an amount in the base currency', () => {
    expect(toBase(150, 'GHS', config)).toBe(10);
    expect(toBase(10, 'EUR', config)).toBe(0);
  });
});

describe('changing an organization currency', () => {
  it('is free before anything has happened', async () => {
    expect(await currencyChangeBlock('o1')).toBeNull();
  });

  it('is blocked by any wallet or payout history, for the organization itself', async () => {
    db.counts.wallet = 2;
    expect(await currencyChangeBlock('o1')).toMatch(/wallet or payout activity/);
  });

  it('is always blocked by a running card subscription', async () => {
    db.providerSub = 'sub_1';
    expect(await currencyChangeBlock('o1')).toMatch(/card subscription/);
    expect(await currencyChangeBlock('o1', { force: true })).toMatch(/card subscription/);
  });

  it('lets a platform admin change it once the old currency has nothing in it', async () => {
    db.counts.wallet = 5;
    db.counts.payouts = 3;
    expect(await currencyChangeBlock('o1', { force: true })).toBeNull();
  });

  it('keeps a platform admin out while money, a payout or an unpaid booking remains', async () => {
    db.sums.wallet = 12.5;
    expect(await currencyChangeBlock('o1', { force: true })).toMatch(/wallet still holds/);
    db.sums.wallet = 0;
    db.sums.payouts = 40;
    expect(await currencyChangeBlock('o1', { force: true })).toMatch(/payout wallet still holds/);
    db.sums.payouts = 0;
    db.counts.requests = 1;
    expect(await currencyChangeBlock('o1', { force: true })).toMatch(/payout request/);
    db.counts.requests = 0;
    db.counts.holds = 1;
    expect(await currencyChangeBlock('o1', { force: true })).toMatch(/waiting for payment/);
  });
});
