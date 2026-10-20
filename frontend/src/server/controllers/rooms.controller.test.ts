import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rooms are offered to every kind of business; tables and floor plans only
// where they make sense, according to the organization's industry.

const db = vi.hoisted(() => ({ industry: 'RESTAURANT' as string | null, tables: [] as any[], created: [] as any[] }));

vi.mock('../middleware/tenantScope.middleware', () => ({ loadCaller: vi.fn(async () => ({ id: 'u1', role: 'ORG_ADMIN', organizationId: 'o1' })) }));
vi.mock('../services/fileStorage', () => ({ getActiveFileStorageProvider: vi.fn(async () => null) }));
vi.mock('../lib/prisma', () => {
  const room = { id: 'r1', locationId: 'l1', name: 'Terrace', layoutWidth: 1000, layoutHeight: 700, layoutImageFileId: null, location: { organizationId: 'o1', timezone: 'UTC' } };
  const api: any = {
    organization: { findUnique: vi.fn(async () => ({ id: 'o1', industry: db.industry })) },
    location: { findUnique: vi.fn(async () => ({ id: 'l1', organizationId: 'o1', timezone: 'UTC' })) },
    room: {
      findUnique: vi.fn(async () => room),
      findMany: vi.fn(async () => [{ id: 'r1', name: 'Terrace', price: null, _count: { tables: 0, instances: 0, services: 0 }, tables: [] }]),
      create: vi.fn(async ({ data }: any) => { db.created.push(data); return { id: 'r2', price: null, ...data }; }),
      update: vi.fn(async () => room),
    },
    diningTable: {
      findMany: vi.fn(async () => db.tables),
      create: vi.fn(async ({ data }: any) => data),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    bookingTable: { count: vi.fn(async () => 0) },
  };
  api.$transaction = async (fn: any) => fn(api);
  return { default: api };
});

import { createRoom, listRooms, saveLayout } from './rooms.controller';

const call = async (handler: any, req: any) => {
  const r: any = { code: 200 };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  await handler({ params: {}, query: {}, body: {}, user: { userId: 'u1' }, ...req }, r, (e: unknown) => { throw e; });
  return r;
};

beforeEach(() => {
  db.industry = 'RESTAURANT';
  db.tables = [];
  db.created = [];
});

describe('industry gating', () => {
  it.each([['RESTAURANT', true], ['SALON', true], ['OTHER', true], ['HEALTHCARE', false], ['BANKING', false], ['GOVERNMENT', false], ['RETAIL', false]])('%s: tables offered = %s', async (industry, tables) => {
    db.industry = industry as string;
    const r = await call(listRooms, { query: { locationId: 'l1' } });
    expect(r.body.features).toMatchObject({ rooms: true, tables });
  });

  it('refuses a floor plan for a business without tables', async () => {
    db.industry = 'HEALTHCARE';
    const r = await call(saveLayout, { params: { id: 'r1' }, body: { tables: [{ name: 'T1', seats: 2 }] } });
    expect(r.code).toBe(403);
    expect(r.body.error).toMatch(/Tables aren’t available/);
  });

  it('still lets a clinic make rooms with their own rules and rates', async () => {
    db.industry = 'HEALTHCARE';
    const r = await call(createRoom, { body: { locationId: 'l1', name: 'Private room', onlineBookable: false, priceMode: 'SURCHARGE', price: 20, openTime: '08:00', closeTime: '17:00', activeDays: '1,2,3,4,5' } });
    expect(r.code).toBe(201);
    expect(db.created[0]).toMatchObject({ name: 'Private room', onlineBookable: false, priceMode: 'SURCHARGE', price: 20, openTime: '08:00', closeTime: '17:00', activeDays: '1,2,3,4,5' });
  });
});

describe('room rules are checked', () => {
  const make = (body: object) => call(createRoom, { body: { locationId: 'l1', name: 'R', ...body } });

  it('rejects bad hours, days, parties and rates', async () => {
    expect((await make({ openTime: '25:00', closeTime: '23:00' })).code).toBe(400);
    expect((await make({ openTime: '18:00' , closeTime: '' })).code).toBe(400);
    expect((await make({ activeDays: '9' })).code).toBe(400);
    expect((await make({ minPartySize: 6, maxPartySize: 2 })).code).toBe(400);
    expect((await make({ priceMode: 'FREE' })).code).toBe(400);
    expect((await make({ priceMode: 'SURCHARGE', price: -3 })).code).toBe(400);
    expect((await make({ paymentMode: 'LATER' })).code).toBe(400);
  });

  it('keeps clean refund tiers', async () => {
    const r = await make({ refundTiers: [{ hours: 24, percent: 50 }, { hours: 72, percent: 100 }, { hours: -1, percent: 10 }] });
    expect(r.code).toBe(201);
    expect(db.created[0].refundTiers).toEqual([{ hours: 72, percent: 100 }, { hours: 24, percent: 50 }]);
  });
});

describe('floor plan', () => {
  it('rejects duplicate names, bad shapes and too many tables', async () => {
    expect((await call(saveLayout, { params: { id: 'r1' }, body: { tables: [{ name: 'A', seats: 2 }, { name: 'a', seats: 2 }] } })).code).toBe(400);
    expect((await call(saveLayout, { params: { id: 'r1' }, body: { tables: [{ name: 'A', seats: 2, shape: 'TRIANGLE' }] } })).code).toBe(400);
    expect((await call(saveLayout, { params: { id: 'r1' }, body: { tables: [{ name: 'A', seats: 0 }] } })).code).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `T${i}`, seats: 1 }));
    expect((await call(saveLayout, { params: { id: 'r1' }, body: { tables: many } })).code).toBe(400);
  });

  it('saves a plan', async () => {
    const r = await call(saveLayout, { params: { id: 'r1' }, body: { layoutWidth: 800, layoutHeight: 500, tables: [{ name: 'A', seats: 2, x: 10, y: 20, shape: 'ROUND', rotation: 45 }] } });
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ layoutWidth: 800, layoutHeight: 500 });
  });
});
