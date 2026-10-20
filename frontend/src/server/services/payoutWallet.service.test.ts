import { describe, it, expect, vi, beforeEach } from 'vitest';

// The payout wallet: sales wait out a review hold, then can be paid out.

const db = vi.hoisted(() => ({
  settings: { holdDays: 7, feePercent: 10, minPayout: 5 } as Record<string, number>,
  entries: [] as any[],
  requests: [] as any[],
  details: 'Bank X, 123' as string | null,
}));

vi.mock('../lib/encryption', () => ({ encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1') }));

vi.mock('../lib/prisma', () => {
  const sum = (rows: any[]) => ({ _sum: { amount: rows.reduce((t, r) => t + Number(r.amount), 0) } });
  const inWindow = (e: any, w: any) => (w.lte ? e.availableAt <= w.lte : w.gt ? e.availableAt > w.gt : true);
  const api: any = {
    platformSetting: { findUnique: vi.fn(async () => ({ value: db.settings })) },
    organization: { findUnique: vi.fn(async () => ({ payoutDetails: db.details ? `enc(${db.details})` : null })) },
    payoutLedgerEntry: {
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) if (!d.externalRef || !db.entries.some((e) => e.externalRef === d.externalRef)) db.entries.push({ id: `e${db.entries.length}`, createdAt: new Date(), ...d });
      }),
      create: vi.fn(async ({ data }: any) => { db.entries.push({ id: `e${db.entries.length}`, createdAt: new Date(), ...data }); }),
      aggregate: vi.fn(async ({ where }: any) => sum(db.entries.filter((e) => e.organizationId === where.organizationId && e.currency === where.currency && inWindow(e, where.availableAt)))),
      findFirst: vi.fn(async ({ where }: any) => db.entries.find((e) => e.appointmentId === where.appointmentId && e.kind === where.kind) ?? null),
    },
    payoutRequest: {
      create: vi.fn(async ({ data }: any) => { const r = { id: `r${db.requests.length + 1}`, status: 'REQUESTED', ...data }; db.requests.push(r); return r; }),
      findUnique: vi.fn(async ({ where }: any) => db.requests.find((r) => r.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const r = db.requests.find((x) => x.id === where.id && x.status === where.status);
        if (r) Object.assign(r, data);
        return { count: r ? 1 : 0 };
      }),
      aggregate: vi.fn(async ({ where }: any) => sum(db.requests.filter((r) => r.organizationId === where.organizationId && r.status === where.status))),
    },
    $executeRaw: vi.fn(async () => 0),
  };
  api.$transaction = async (fn: any) => fn(api);
  return { default: api };
});

import { payoutBalance, recordPlatformSale, recordPlatformRefund, requestPayout, reviewPayout, getPayoutSettings } from './payoutWallet.service';

const DAY = 86_400_000;
const sale = (ref: string, amount: number, now: Date, appointmentId = 'a1') =>
  recordPlatformSale({ organizationId: 'o1', appointmentId, amount, currency: 'USD', ref, now });

beforeEach(() => {
  db.entries = [];
  db.requests = [];
  db.details = 'Bank X, 123';
  db.settings = { holdDays: 7, feePercent: 10, minPayout: 5 };
});

describe('payout wallet', () => {
  it('holds a sale (less the platform fee) as pending for the review period, then makes it available', async () => {
    const t0 = new Date('2026-10-20T10:00:00Z');
    await sale('ref1', 100, t0);
    expect(await payoutBalance('o1', 'USD', t0)).toMatchObject({ pending: 90, available: 0 });
    expect(await payoutBalance('o1', 'USD', new Date(t0.getTime() + 6 * DAY))).toMatchObject({ pending: 90, available: 0 });
    expect(await payoutBalance('o1', 'USD', new Date(t0.getTime() + 8 * DAY))).toMatchObject({ pending: 0, available: 90 });
  });

  it('records a sale only once, however often the webhook repeats', async () => {
    const t0 = new Date();
    await sale('ref1', 50, t0);
    await sale('ref1', 50, t0);
    expect(db.entries.filter((e) => e.kind === 'SALE')).toHaveLength(1);
  });

  it('nets a refund inside the hold against the pending sale', async () => {
    const t0 = new Date('2026-10-20T10:00:00Z');
    await sale('ref1', 100, t0);
    await recordPlatformRefund({ organizationId: 'o1', appointmentId: 'a1', amount: 100, currency: 'USD', ref: 'ref1', now: new Date(t0.getTime() + DAY) });
    expect(await payoutBalance('o1', 'USD', new Date(t0.getTime() + DAY))).toMatchObject({ pending: 0, available: 0 });
    expect(await payoutBalance('o1', 'USD', new Date(t0.getTime() + 30 * DAY))).toMatchObject({ pending: 0, available: 0 });
  });

  it('takes a refund after the hold out of what is available', async () => {
    const t0 = new Date('2026-10-20T10:00:00Z');
    await sale('ref1', 100, t0);
    const later = new Date(t0.getTime() + 10 * DAY);
    await recordPlatformRefund({ organizationId: 'o1', appointmentId: 'a1', amount: 40, currency: 'USD', ref: 'ref1', now: later });
    // 90 net of fee, less 40 refunded, plus 4 of the fee given back.
    expect((await payoutBalance('o1', 'USD', later)).available).toBe(54);
  });

  it('pays out only what is available, reserving it while the request is reviewed', async () => {
    const t0 = new Date(Date.now() - 10 * DAY);
    await sale('ref1', 100, t0);
    await expect(requestPayout({ organizationId: 'o1', currency: 'USD', amount: 500 })).rejects.toThrow(/only request what is available/);
    const req = await requestPayout({ organizationId: 'o1', currency: 'USD', amount: 60 });
    expect(Number(req.amount)).toBe(60);
    expect(await payoutBalance('o1', 'USD')).toMatchObject({ available: 30, inReview: 60 });

    await reviewPayout({ id: req.id, action: 'PAID', note: 'Transfer 991' });
    expect(await payoutBalance('o1', 'USD')).toMatchObject({ available: 30, inReview: 0, paidOut: 60 });
  });

  it('returns the money when a request is rejected, and decides each request once', async () => {
    const t0 = new Date(Date.now() - 10 * DAY);
    await sale('ref1', 100, t0);
    const req = await requestPayout({ organizationId: 'o1', currency: 'USD' });
    expect((await payoutBalance('o1', 'USD')).available).toBe(0);
    await reviewPayout({ id: req.id, action: 'REJECTED', note: 'Details unclear' });
    expect((await payoutBalance('o1', 'USD')).available).toBe(90);
    await expect(reviewPayout({ id: req.id, action: 'PAID' })).rejects.toThrow(/already rejected/);
  });

  it('needs payout details and respects the minimum', async () => {
    const t0 = new Date(Date.now() - 10 * DAY);
    await sale('ref1', 100, t0);
    db.details = null;
    await expect(requestPayout({ organizationId: 'o1', currency: 'USD' })).rejects.toThrow(/payout details/);
    db.details = 'Bank X';
    await expect(requestPayout({ organizationId: 'o1', currency: 'USD', amount: 2 })).rejects.toThrow(/smallest payout/);
  });

  it('falls back to sensible defaults', async () => {
    db.settings = {} as any;
    expect(await getPayoutSettings()).toEqual({ holdDays: 7, feePercent: 0, minPayout: 0 });
  });
});
