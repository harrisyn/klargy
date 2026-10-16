import { describe, it, expect, vi, beforeEach } from 'vitest';

// servicepoint.opened / servicepoint.closed (docs/connect/v1.md section 6).

vi.mock('../lib/prisma', () => ({
  default: {
    servicePointInstance: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    webhookEndpoint: { findMany: vi.fn() },
    webhookDelivery: {
      create: vi.fn(async ({ data }: any) => ({ id: `d-${data.endpointId}`, ...data })),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    externalReference: { findMany: vi.fn() },
  },
}));
vi.mock('./notifications.service', () => ({ WAITING_ORDER: [], CALLABLE_WHERE: { status: 'WAITING', heldAt: null, awaitingClearance: false }, notifyEntry: vi.fn(), notifyPositions: vi.fn(),
  queueLineRanks: vi.fn(async (queueId: string) => {
    const { default: db } = await import('../lib/prisma');
    const rows = ((await (db as any).queueEntry.findMany({ where: { queueId, status: 'WAITING', heldAt: null, awaitingClearance: false }, select: { id: true } })) ?? []) as { id: string }[];
    return new Map(rows.map((e, i) => [e.id, i + 1]));
  }), }));
vi.mock('../lib/realtime', () => ({ emitToQueue: vi.fn(), emitToLocation: vi.fn(), SOCKET_EVENTS: {} }));

import prisma from '../lib/prisma';
import { recordServicePointEvent } from './servicePointEvents.service';
import { WEBHOOK_EVENTS } from './webhooks.service';
import { activateServicePointInstance, vacateServicePointInstance } from '../controllers/servicepoint.controller';

const instanceRow = {
  id: 'inst1',
  servicePointService: { serviceId: 's1', servicePoint: { id: 'sp1', name: 'Consulting Room 3', organizationId: 'org1' } },
};
const users: Record<string, { id: string; firstName: string; lastName: string; role?: string }> = {
  doc: { id: 'doc', firstName: 'Ama', lastName: 'Owusu' },
  other: { id: 'other', firstName: 'Kwame', lastName: 'Boateng' },
};
const externalRefs = [
  { resourceType: 'service_point', resourceId: 'sp1', externalId: 'ROOM3' },
  { resourceType: 'staff', resourceId: 'doc', externalId: 'DR1' },
];

const sent = () =>
  (prisma.webhookDelivery.create as any).mock.calls.map((c: any) => ({ endpoint: c[0].data.endpointId, ...c[0].data.payload }));

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.webhookEndpoint.findMany as any).mockResolvedValue([
    { id: 'plain', events: [], integration: null },
    { id: 'emr', events: [], integration: { id: 'int1' } },
  ]);
  (prisma.user.findUnique as any).mockImplementation(async ({ where }: any) => users[where.id] ?? null);
  (prisma.externalReference.findMany as any).mockImplementation(async ({ where }: any) =>
    externalRefs.filter((r) => where.OR.some((o: any) => o.resourceType === r.resourceType && o.resourceId.in.includes(r.resourceId)))
  );
});

describe('recordServicePointEvent', () => {
  it('is a webhook event', () => {
    expect(WEBHOOK_EVENTS).toEqual(expect.arrayContaining(['servicepoint.opened', 'servicepoint.closed']));
  });

  it('sends the room, the staff member, origin, and refs only to the integration', async () => {
    (prisma.servicePointInstance.findUnique as any).mockResolvedValue(instanceRow);
    await recordServicePointEvent('opened', 'inst1', 'doc', 'doc');
    const [plain, emr] = sent();
    const data = {
      servicePoint: { id: 'sp1', name: 'Consulting Room 3' },
      staff: { id: 'doc', name: 'Ama Owusu' },
      origin: { type: 'staff', integrationId: null },
    };
    expect(plain).toMatchObject({ endpoint: 'plain', event: 'servicepoint.opened', data });
    expect(plain.data.refs).toBeUndefined();
    expect(emr).toMatchObject({ endpoint: 'emr', event: 'servicepoint.opened', data: { ...data, refs: { servicePoint: 'ROOM3', staff: 'DR1' } } });
  });
});

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const events = () => sent().filter((d: any) => d.endpoint === 'emr').map((d: any) => `${d.event}:${d.data.staff.id}`);

describe('signing in to and leaving a desk', () => {
  const occupied = (by: string | null) => ({
    id: 'inst1', isActive: true, isOccupied: !!by, occupiedByUserId: by,
    servicePointService: { isActive: true, servicePoint: { isActive: true } },
  });

  beforeEach(() => {
    (prisma.servicePointInstance.update as any).mockResolvedValue({});
  });

  it('opens a free desk', async () => {
    (prisma.servicePointInstance.findUnique as any).mockResolvedValueOnce(occupied(null)).mockResolvedValue(instanceRow);
    await activateServicePointInstance({ params: { instanceId: 'inst1' }, user: { userId: 'doc' }, body: {} } as any, makeRes(), vi.fn());
    expect(events()).toEqual(['servicepoint.opened:doc']);
  });

  it('closes it for the previous person on a take-over', async () => {
    (prisma.servicePointInstance.findUnique as any).mockResolvedValueOnce(occupied('other')).mockResolvedValue(instanceRow);
    await activateServicePointInstance({ params: { instanceId: 'inst1' }, user: { userId: 'doc' }, body: { takeOver: true } } as any, makeRes(), vi.fn());
    expect(events()).toEqual(['servicepoint.closed:other', 'servicepoint.opened:doc']);
  });

  it('says nothing when someone re-enters their own desk', async () => {
    (prisma.servicePointInstance.findUnique as any).mockResolvedValueOnce(occupied('doc')).mockResolvedValue(instanceRow);
    await activateServicePointInstance({ params: { instanceId: 'inst1' }, user: { userId: 'doc' }, body: {} } as any, makeRes(), vi.fn());
    expect(events()).toEqual([]);
  });

  it('closes a desk that is left', async () => {
    (prisma.servicePointInstance.findUnique as any).mockResolvedValueOnce(occupied('doc')).mockResolvedValue(instanceRow);
    await vacateServicePointInstance({ params: { instanceId: 'inst1' }, user: { userId: 'doc' } } as any, makeRes(), vi.fn());
    expect(events()).toEqual(['servicepoint.closed:doc']);
  });
});
