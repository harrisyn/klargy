import { describe, it, expect, vi, beforeEach } from 'vitest';

// The "Outpatient clinic" flow template: creates what's missing, reuses what
// exists, and changes nothing the second time.

const state = vi.hoisted(() => ({
  services: [] as { id: string; name: string; requiresClearance?: boolean }[],
  points: [] as { id: string; name: string; type: string }[],
  links: [] as { id: string; servicePointId: string; serviceId: string }[],
  flows: [] as { fromServiceId: string; toServiceId: string; priority: number }[],
  defaultServiceId: null as string | null,
}));

vi.mock('../lib/prisma', () => {
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  return {
    default: {
      location: {
        findUnique: vi.fn(async () => ({ id: 'l1', organizationId: 'org1' })),
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

import { OUTPATIENT_TEMPLATE, applyFlowTemplate } from './flowTemplates.service';
import { checkLimit } from '../middleware/subscription.middleware';

beforeEach(() => {
  state.services = [{ id: 'existing-cashier', name: 'cashier' }];
  state.points = [{ id: 'sp-rec', name: 'Reception', type: 'RECEPTION' }];
  state.links = [];
  state.flows = [];
  state.defaultServiceId = null;
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
