import { describe, it, expect, vi, beforeEach } from 'vitest';

// A host moving a booking to a table in another room: the price follows the
// room, the host agrees first, and an overpayment goes back to the customer.

const mocks = vi.hoisted(() => ({
  reassign: vi.fn(),
  refund: vi.fn(),
  updates: [] as { where: any; data: any }[],
}));

vi.mock('../lib/prisma', () => ({
  default: {
    appointment: {
      update: vi.fn(async (a: any) => { mocks.updates.push(a); return {}; }),
      findUnique: vi.fn(async () => ({ id: 'a1', amount: 80 })),
    },
  },
}));
vi.mock('../middleware/tenantScope.middleware', () => ({ loadCaller: vi.fn(), listScopeOrgId: vi.fn() }));
vi.mock('../services/queueEvents.service', () => ({ recordQueueEvent: vi.fn(), serviceTimeZone: vi.fn() }));
vi.mock('../services/bookingPayments/bookingPayments.service', () => ({ refundBooking: mocks.refund }));
vi.mock('../services/tables.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/tables.service')>()),
  reassignTables: mocks.reassign,
}));

import { PriceChangeError } from '../services/tables.service';
import { BookingError } from '../services/bookingError';
import { setAppointmentTables } from './appointment.controller';

const call = async (body: object) => {
  const r: any = { code: 200 };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  const next = vi.fn();
  await setAppointmentTables({ params: { id: 'a1' }, body } as any, r, next);
  return { r, next };
};

beforeEach(() => {
  mocks.reassign.mockReset();
  mocks.refund.mockReset();
  mocks.updates.length = 0;
});

describe('setAppointmentTables', () => {
  const cheaper = { from: 80, to: 50, paid: 80, diff: -30, refund: 30, balance: 0 };
  const dearer = { from: 50, to: 80, paid: 50, diff: 30, refund: 0, balance: 30 };

  it('moves a booking whose price does not change, with no money involved', async () => {
    mocks.reassign.mockResolvedValue({ tables: [{ id: 't1', name: 'T1', seats: 2 }], priceChange: null });
    const { r } = await call({ tableIds: ['t1'] });
    expect(r.code).toBe(200);
    expect(r.body.priceChange).toBeNull();
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });

  it('answers 409 with the new price when the host has not agreed', async () => {
    mocks.reassign.mockRejectedValue(new PriceChangeError('Moving them changes the price.', dearer));
    const { r } = await call({ tableIds: ['t1'] });
    expect(r.code).toBe(409);
    expect(r.body).toMatchObject({ error: 'Moving them changes the price.', priceChange: dearer });
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('passes the host’s agreement on', async () => {
    mocks.reassign.mockResolvedValue({ tables: [], priceChange: dearer });
    await call({ tableIds: ['t1'], confirmPrice: true });
    expect(mocks.reassign).toHaveBeenCalledWith('a1', ['t1'], { confirmPrice: true });
    await call({ tableIds: ['t1'], confirmPrice: 'yes' });
    expect(mocks.reassign).toHaveBeenLastCalledWith('a1', ['t1'], { confirmPrice: false });
  });

  it('a dearer room records nothing more here (the service did) and refunds nothing', async () => {
    mocks.reassign.mockResolvedValue({ tables: [], priceChange: dearer });
    const { r } = await call({ tableIds: ['t1'], confirmPrice: true });
    expect(r.body.priceChange).toEqual(dearer);
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });

  it('a cheaper room records the lower price first, then refunds the difference', async () => {
    mocks.reassign.mockResolvedValue({ tables: [], priceChange: cheaper });
    mocks.refund.mockResolvedValue({ refunded: 30, currency: 'GHS' });
    const { r } = await call({ tableIds: ['t1'], confirmPrice: true });
    expect(mocks.updates).toEqual([{ where: { id: 'a1' }, data: { amount: 50 } }]);
    expect(mocks.refund).toHaveBeenCalledWith('a1', { policy: 'AMOUNT', amount: 30 });
    expect(r.body.priceChange).toEqual(cheaper);
  });

  it('a cheaper room for a booking nothing was paid on just lowers the price', async () => {
    mocks.reassign.mockResolvedValue({ tables: [], priceChange: { ...cheaper, paid: 0, refund: 0 } });
    await call({ tableIds: ['t1'], confirmPrice: true });
    expect(mocks.updates).toEqual([{ where: { id: 'a1' }, data: { amount: 50 } }]);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('if the refund fails they are still moved, the host is told, and a second move settles it', async () => {
    mocks.reassign.mockResolvedValue({ tables: [], priceChange: cheaper });
    mocks.refund.mockRejectedValue(new BookingError('The refund didn’t go through.', 502));
    const { r } = await call({ tableIds: ['t1'], confirmPrice: true });
    expect(r.code).toBe(502);
    expect(r.body.error).toMatch(/moved, but the 30\.00 refund didn’t go through/);
    expect(r.body.error).toMatch(/Move them again to retry/);
    // The lower price is already recorded, so the booking shows as overpaid until it is settled.
    expect(mocks.updates).toEqual([{ where: { id: 'a1' }, data: { amount: 50 } }]);
  });

  it('settles an overpayment even when the price itself had already moved', async () => {
    mocks.reassign.mockResolvedValue({ tables: [], priceChange: { from: 50, to: 50, paid: 80, diff: 0, refund: 30, balance: 0 } });
    mocks.refund.mockResolvedValue({ refunded: 30, currency: 'GHS' });
    await call({ tableIds: ['t1'], confirmPrice: true });
    expect(mocks.refund).toHaveBeenCalledWith('a1', { policy: 'AMOUNT', amount: 30 });
  });

  it('answers with the refusal when the tables cannot be had', async () => {
    mocks.reassign.mockRejectedValue(new BookingError('Sorry, one of those was just taken. Please choose again.', 409));
    const { r } = await call({ tableIds: ['t1'] });
    expect(r.code).toBe(409);
    expect(r.body.error).toMatch(/just taken/);
  });
});
