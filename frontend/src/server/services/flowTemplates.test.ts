import { describe, it, expect, vi, beforeEach } from 'vitest';

// The "Outpatient clinic" flow template: creates what's missing, reuses what
// exists, and changes nothing the second time.

const state = vi.hoisted(() => ({
  services: [] as { id: string; name: string; requiresClearance?: boolean }[],
  points: [] as { id: string; name: string; type: string }[],
  links: [] as { id: string; servicePointId: string; serviceId: string }[],
  flows: [] as { fromServiceId: string; toServiceId: string; priority: number }[],
  defaultServiceId: null as string | null,
  industry: undefined as string | undefined,
  rooms: [] as { id: string; locationId: string; name: string; data?: any }[],
  tables: [] as any[],
}));

vi.mock('../lib/prisma', () => {
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  return {
    default: {
      location: {
        findUnique: vi.fn(async () => ({ id: 'l1', organizationId: 'org1', organization: { industry: state.industry } })),
        update: vi.fn(async ({ data }: any) => { state.defaultServiceId = data.defaultServiceId; return {}; }),
      },
      service: {
        findMany: vi.fn(async () => state.services.map((s) => ({ ...s }))),
        create: vi.fn(async ({ data }: any) => { const s = { id: id('svc'), ...data }; state.services.push(s); return s; }),
        update: vi.fn(async ({ where, data }: any) => Object.assign(state.services.find((s) => s.id === where.id)!, data)),
      },
      servicePoint: {
        findMany: vi.fn(async () => state.points),
        create: vi.fn(async ({ data }: any) => { const p = { id: id('sp'), ...data }; state.points.push(p); return p; }),
      },
      servicePointService: {
        findFirst: vi.fn(async ({ where }: any) => state.links.find((l) => l.serviceId === where.serviceId) ?? null),
        upsert: vi.fn(async ({ create }: any) => { const l = { id: id('link'), ...create }; state.links.push(l); return l; }),
      },
      room: {
        findMany: vi.fn(async () => state.rooms.map((r) => ({ id: r.id, name: r.name }))),
        create: vi.fn(async ({ data }: any) => { const r = { id: id('room'), locationId: data.locationId, name: data.name, data }; state.rooms.push(r); return r; }),
      },
      diningTable: {
        findMany: vi.fn(async () => state.tables.map((t) => ({ name: t.name }))),
        createMany: vi.fn(async ({ data }: any) => { state.tables.push(...data); return { count: data.length }; }),
      },
      serviceFlow: {
        findUnique: vi.fn(async ({ where }: any) => {
          const k = where.fromServiceId_toServiceId;
          return state.flows.find((f) => f.fromServiceId === k.fromServiceId && f.toServiceId === k.toServiceId) ?? null;
        }),
        create: vi.fn(async ({ data }: any) => { state.flows.push(data); return data; }),
      },
    },
  };
});
vi.mock('../middleware/subscription.middleware', () => ({ checkLimit: vi.fn(async () => ({ current: 1, limit: 50, allowed: true })) }));
vi.mock('../controllers/servicepoint.controller', () => ({ syncInstancesForServicePointService: vi.fn() }));

import { EVENT_VENUE_TEMPLATE, OUTPATIENT_TEMPLATE, RESTAURANT_TEMPLATE, SALON_TEMPLATE } from './flowTemplates.data';
import { applyFlowTemplate } from './flowTemplates.service';
import { checkLimit } from '../middleware/subscription.middleware';

beforeEach(() => {
  state.services = [{ id: 'existing-cashier', name: 'cashier' }];
  state.points = [{ id: 'sp-rec', name: 'Reception', type: 'RECEPTION' }];
  state.links = [];
  state.flows = [];
  state.defaultServiceId = null;
  state.industry = undefined;
  state.rooms = [];
  state.tables = [];
});

const nameOf = (serviceId: string) => state.services.find((s) => s.id === serviceId)!.name;

describe('applyFlowTemplate (Outpatient clinic)', () => {
  it('creates the missing services and service points, the flow and the settings', async () => {
    const result = await applyFlowTemplate(OUTPATIENT_TEMPLATE, 'l1');
    expect(state.services.map((s) => s.name)).toEqual(['cashier', 'Reception', 'Triage', 'Consultation', 'Laboratory', 'Imaging', 'Pharmacy']);
    expect(result.services.find((s) => s.name === 'Cashier')).toEqual({ id: 'existing-cashier', name: 'Cashier', created: false });
    // Reception reuses the service point of the same name; the other six get one each.
    expect(result.servicePointsCreated).toBe(6);
    expect(state.links).toHaveLength(7);
    expect(state.links.find((l) => nameOf(l.serviceId) === 'Reception')!.servicePointId).toBe('sp-rec');
    expect(state.services.find((s) => s.name === 'Consultation')!.requiresClearance).toBe(true);
    expect(nameOf(state.defaultServiceId!)).toBe('Reception');

    const edges = state.flows.map((f) => `${nameOf(f.fromServiceId)}>${nameOf(f.toServiceId)}`);
    expect(edges).toEqual([
      'Reception>cashier', 'Reception>Triage', 'Reception>Consultation', 'Reception>Laboratory', 'Reception>Pharmacy',
      'cashier>Triage', 'cashier>Laboratory', 'cashier>Imaging', 'cashier>Pharmacy',
      'Triage>Consultation',
      'Consultation>cashier', 'Consultation>Laboratory', 'Consultation>Imaging', 'Consultation>Pharmacy',
      'Laboratory>Consultation', 'Laboratory>Pharmacy',
      'Imaging>Consultation',
    ]);
    expect(result.flowsCreated).toBe(17);
  });

  it('changes nothing the second time', async () => {
    await applyFlowTemplate(OUTPATIENT_TEMPLATE, 'l1');
    const again = await applyFlowTemplate(OUTPATIENT_TEMPLATE, 'l1');
    expect(again.flowsCreated).toBe(0);
    expect(again.servicePointsCreated).toBe(0);
    expect(again.services.every((s) => !s.created)).toBe(true);
    expect(state.services).toHaveLength(7);
    expect(state.flows).toHaveLength(17);
  });

  it('refuses when the plan has no room for the new services', async () => {
    (checkLimit as any).mockResolvedValueOnce({ current: 4, limit: 5, allowed: true });
    await expect(applyFlowTemplate(OUTPATIENT_TEMPLATE, 'l1')).rejects.toMatchObject({ status: 403 });
    expect(state.services).toHaveLength(1);
  });
});

describe('applyFlowTemplate: rooms and tables', () => {
  it('lays out the rooms and tables of a restaurant and makes the host stand take table bookings', async () => {
    state.industry = 'RESTAURANT';
    const r = await applyFlowTemplate(RESTAURANT_TEMPLATE, 'l1');
    expect(state.rooms.map((x) => x.name)).toEqual(['Main dining', 'Terrace', 'Private room']);
    expect(r.roomsCreated).toBe(3);
    expect(r.tablesCreated).toBe(8 + 4 + 1);
    expect(state.tables).toHaveLength(13);
    expect(state.tables.every((t) => t.roomId && t.locationId === 'l1' && t.x != null && t.y != null)).toBe(true);
    expect(state.rooms.find((x) => x.name === 'Private room')!.data).toMatchObject({ minPartySize: 6, allowCombine: false });
    expect(state.services.find((s) => s.name === 'Host stand')).toMatchObject({ bookingUnit: 'PERSON', minPartySize: 1, maxPartySize: 10, tableMode: 'AUTO' });
    expect(r.tablesSkipped).toBe(false);
  });

  it('changes nothing the second time, and leaves a room that is already there alone', async () => {
    state.industry = 'RESTAURANT';
    state.rooms = [{ id: 'mine', locationId: 'l1', name: 'terrace' }];
    const first = await applyFlowTemplate(RESTAURANT_TEMPLATE, 'l1');
    expect(first.roomsCreated).toBe(2); // Terrace already exists: reused, with no tables forced into it
    expect(state.tables.some((t) => t.roomId === 'mine')).toBe(false);
    const again = await applyFlowTemplate(RESTAURANT_TEMPLATE, 'l1');
    expect(again.roomsCreated).toBe(0);
    expect(again.tablesCreated).toBe(0);
    expect(state.tables).toHaveLength(9);
  });

  it('skips a table whose name is already used at the location', async () => {
    state.industry = 'RESTAURANT';
    state.tables = [{ name: 'table 1' }];
    const r = await applyFlowTemplate(RESTAURANT_TEMPLATE, 'l1');
    expect(r.tablesCreated).toBe(12);
  });

  it('never gives tables to a clinic: the rooms and services come, the tables do not', async () => {
    state.industry = 'HEALTHCARE';
    const r = await applyFlowTemplate(RESTAURANT_TEMPLATE, 'l1');
    expect(r.tablesCreated).toBe(0);
    expect(state.tables).toEqual([]);
    expect(r.tablesSkipped).toBe(true);
    expect(state.services.find((s) => s.name === 'Host stand')).not.toHaveProperty('tableMode');
  });

  it('a salon gets chairs and an event hall gets rows of single seats, bookable only at sessions', async () => {
    state.industry = 'SALON';
    await applyFlowTemplate(SALON_TEMPLATE, 'l1');
    expect(state.tables.map((t) => t.name)).toEqual(['Chair 1', 'Chair 2', 'Chair 3', 'Chair 4', 'Chair 5', 'Chair 6']);
    expect(state.services.find((s) => s.name === 'Hair')).toMatchObject({ tableMode: 'AUTO', maxPartySize: 2 });

    state.services = []; state.points = []; state.links = []; state.flows = []; state.rooms = []; state.tables = [];
    state.industry = 'EDUCATION';
    const r = await applyFlowTemplate(EVENT_VENUE_TEMPLATE, 'l1');
    expect(r.tablesCreated).toBe(40);
    expect(state.tables.every((t) => t.seats === 1)).toBe(true);
    expect(state.services.find((s) => s.name === 'Seated session')).toMatchObject({ recurringSlots: false, tableMode: 'AUTO', bookingMode: 'APPOINTMENT' });
  });

  it('a template without rooms behaves as before', async () => {
    const r = await applyFlowTemplate(OUTPATIENT_TEMPLATE, 'l1');
    expect(r).toMatchObject({ roomsCreated: 0, tablesCreated: 0, tablesSkipped: false });
  });
});
