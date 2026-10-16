import { describe, it, expect, vi, beforeEach } from 'vitest';

// Klargy Connect phase 2 event envelope: origin, servicePoint, refs (only to
// the integration's own endpoint) and journey.completed.

vi.mock('../lib/prisma', () => ({
  default: {
    queueEntry: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    queue: { findUnique: vi.fn() },
    customerJourney: { findUnique: vi.fn(), updateMany: vi.fn() },
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
import { recordQueueEvent, closeJourneyIfDone, ORIGIN } from './queueEvents.service';
import { dispatchWebhook } from './webhooks.service';

const endpoints = [
  { id: 'plain', events: [], integration: null },
  { id: 'emr', events: [], integration: { id: 'int1' } },
];

const entry = {
  id: 'e1',
  ticketNumber: 'G012',
  status: 'SERVING',
  queueId: 'q1',
  journeyId: 'j1',
  previousEntryId: null,
  joinedAt: new Date(),
  calledAt: new Date(),
  servedAt: null,
  completedAt: null,
  user: { id: 'u1', firstName: 'Ama', lastName: 'Mensah', phone: null, identityData: null },
  queue: { service: { id: 's1', name: 'GP', location: { id: 'l1', name: 'Airport', organizationId: 'org1' } } },
  servicePointInstance: { servicePointService: { servicePoint: { id: 'sp1', name: 'Consulting Room 3' } } },
};

const externalRefs = [
  { resourceType: 'patient', resourceId: 'u1', externalId: 'P1' },
  { resourceType: 'visit', resourceId: 'j1', externalId: 'V1' },
  { resourceType: 'service', resourceId: 's1', externalId: 'clinic-1' },
  { resourceType: 'service_point', resourceId: 'sp1', externalId: 'ROOM3' },
  { resourceType: 'staff', resourceId: 'staff1', externalId: 'DR1' },
];

const deliveries = () =>
  Object.fromEntries((prisma.webhookDelivery.create as any).mock.calls.map((c: any) => [c[0].data.endpointId, c[0].data.payload]));

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.webhookEndpoint.findMany as any).mockResolvedValue(endpoints);
  (prisma.queueEntry.findUnique as any).mockResolvedValue(entry);
  (prisma.externalReference.findMany as any).mockImplementation(async ({ where }: any) =>
    externalRefs.filter((r) => where.OR.some((o: any) => o.resourceType === r.resourceType && o.resourceId.in.includes(r.resourceId)))
  );
});

describe('dispatchWebhook', () => {
  it('adds refs only for the endpoint an integration owns', async () => {
    const refsFor = vi.fn().mockResolvedValue({ patient: 'P1' });
    await dispatchWebhook('org1', 'entry.called', { entryId: 'e1' }, refsFor);
    const sent = deliveries();
    expect(sent.plain.data).toEqual({ entryId: 'e1' });
    expect(sent.emr.data).toEqual({ entryId: 'e1', refs: { patient: 'P1' } });
    expect(refsFor).toHaveBeenCalledWith('int1');
  });
});

describe('recordQueueEvent', () => {
  it('gives every entry event the patient’s status page and place in line', async () => {
    (prisma.queueEntry.findUnique as any).mockResolvedValue({
      ...entry,
      status: 'WAITING',
      queue: { service: { ...entry.queue.service, location: { ...entry.queue.service.location, organization: { slug: 'nyaho' } } } },
    });
    (prisma.queueEntry.findMany as any).mockResolvedValue([{ id: 'e0' }, { id: 'e9' }, { id: 'e1' }]);
    await recordQueueEvent({ action: 'entry.joined', queueId: 'q1', entryId: 'e1' });
    const sent = deliveries();
    for (const payload of [sent.plain, sent.emr]) {
      expect(payload.data.statusUrl).toMatch(/^https?:\/\/nyaho\.[^/]+\/status\/q1\/e1$/);
      expect(payload.data.position).toBe(3);
    }
    expect((prisma.queueEntry.findMany as any).mock.calls[0][0].where).toEqual({ queueId: 'q1', status: 'WAITING', heldAt: null, awaitingClearance: false });
  });

  it('sends origin, servicePoint and the integration’s refs, with the actor as staff', async () => {
    await recordQueueEvent({ action: 'entry.called', actorUserId: 'staff1', queueId: 'q1', entryId: 'e1' });
    const sent = deliveries();
    expect(sent.emr.data).toMatchObject({
      entryId: 'e1',
      servicePoint: { id: 'sp1', name: 'Consulting Room 3' },
      origin: { type: 'staff', integrationId: null },
      refs: {
        patient: 'P1', visit: 'V1', encounter: null, service: 'clinic-1', location: null, servicePoint: 'ROOM3', staff: 'DR1',
      },
    });
    expect(sent.plain.data.refs).toBeUndefined();
    expect(sent.plain.data.origin).toEqual({ type: 'staff', integrationId: null });
  });

  it('marks events with no actor as system, and passes public and integration origins through', async () => {
    const originOf = async (input: Parameters<typeof recordQueueEvent>[0]) => {
      vi.clearAllMocks();
      (prisma.webhookEndpoint.findMany as any).mockResolvedValue(endpoints);
      await recordQueueEvent(input);
      return deliveries().emr.data.origin;
    };
    expect(await originOf({ action: 'entry.served', entryId: 'e1' })).toEqual({ type: 'system', integrationId: null });
    expect(await originOf({ action: 'entry.joined', entryId: 'e1', origin: ORIGIN.public })).toEqual({ type: 'public', integrationId: null });
    expect(await originOf({ action: 'entry.cancelled', entryId: 'e1', origin: ORIGIN.integration('int1') })).toEqual({
      type: 'integration',
      integrationId: 'int1',
    });
    // Integration calls are recorded in the audit log too.
    expect((prisma.auditLog.create as any).mock.calls[0][0].data.data).toEqual({ origin: { type: 'integration', integrationId: 'int1' } });
  });
});

describe('closeJourneyIfDone', () => {
  beforeEach(() => {
    (prisma.queueEntry.findUnique as any).mockImplementation(async ({ select }: any) =>
      select.journeyId ? { journeyId: 'j1' } : { user: entry.user, queue: entry.queue }
    );
    (prisma.customerJourney.findUnique as any).mockResolvedValue({
      id: 'j1', startedAt: new Date(Date.now() - 30 * 60000), queueEntryIds: ['e1'],
    });
    (prisma.queueEntry.count as any).mockResolvedValue(0);
  });

  it('sends journey.completed with patient and visit refs when it closes the journey', async () => {
    (prisma.customerJourney.updateMany as any).mockResolvedValue({ count: 1 });
    await closeJourneyIfDone('e1', { origin: ORIGIN.integration('int1') });
    expect((prisma.customerJourney.updateMany as any).mock.calls[0][0].where).toEqual({ id: 'j1', completedAt: null });
    const sent = deliveries();
    expect(sent.emr.event).toBe('journey.completed');
    expect(sent.emr.data).toMatchObject({
      journeyId: 'j1',
      totalDuration: 30,
      patient: { id: 'u1' },
      origin: { type: 'integration', integrationId: 'int1' },
      refs: { patient: 'P1', visit: 'V1' },
    });
    expect(Object.keys(sent.emr.data.refs)).toEqual(['patient', 'visit']);
    expect(sent.plain.data.refs).toBeUndefined();
  });

  it('sends nothing when the journey was already closed or still has someone waiting', async () => {
    (prisma.customerJourney.updateMany as any).mockResolvedValue({ count: 0 });
    await closeJourneyIfDone('e1');
    (prisma.queueEntry.count as any).mockResolvedValue(1);
    await closeJourneyIfDone('e1');
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});

describe('phase 6 entry fields', () => {
  it('sends held, awaitingClearance, sentBy, the journey (with the EMR’s service ids) and a transfer’s source entry with its refs', async () => {
    (prisma.queueEntry.findUnique as any).mockImplementation(async ({ where }: any) =>
      where.id === 'e0'
        ? { ...entry, id: 'e0', status: 'SERVED', ticketNumber: 'R001' }
        : { ...entry, status: 'WAITING', awaitingClearance: true, sentBy: 'patient', heldAt: null, previousEntryId: 'e0' }
    );
    (prisma.queueEntry.findMany as any).mockImplementation(async ({ where }: any) =>
      where.OR
        ? [
            { id: 'e0', ticketNumber: 'R001', status: 'SERVED', joinedAt: new Date(1), completedAt: new Date(2), journeyId: 'j1', queue: { service: { id: 's1', name: 'GP' } } },
            { id: 'e1', ticketNumber: 'G012', status: 'WAITING', joinedAt: new Date(3), completedAt: null, journeyId: 'j1', queue: { service: { id: 's2', name: 'Cashier' } } },
          ]
        : []
    );
    await recordQueueEvent({ action: 'entry.transferred', entryId: 'e1', origin: ORIGIN.public, data: { fromEntryId: 'e0', fromServiceId: 's1', toServiceId: 's2' } });
    const sent = deliveries();
    expect(sent.emr.data).toMatchObject({ held: false, awaitingClearance: true, sentBy: 'patient', origin: { type: 'public', integrationId: null } });
    expect(sent.emr.data.journey.map((j: any) => j.service)).toEqual([
      { id: 's1', ref: 'clinic-1', name: 'GP' },
      { id: 's2', ref: null, name: 'Cashier' },
    ]);
    expect(sent.emr.data.from).toMatchObject({ entryId: 'e0', status: 'SERVED', refs: { visit: 'V1', patient: 'P1', encounter: null } });
    // Other endpoints get the same shape without any EMR ids.
    expect(sent.plain.data.from.refs).toBeUndefined();
    expect(sent.plain.data.journey[0].service.ref).toBeNull();
  });
});

