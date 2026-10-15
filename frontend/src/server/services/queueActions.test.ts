import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  default: {
    queue: { findUnique: vi.fn() },
    queueEntry: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    serviceFlow: { findFirst: vi.fn() },
    customerJourney: { update: vi.fn() },
  },
}));
vi.mock('../lib/realtime', () => ({
  emitToQueue: vi.fn(),
  emitToLocation: vi.fn(),
  emitToQueueAndLocation: vi.fn(),
  SOCKET_EVENTS: {},
}));
vi.mock('../middleware/subscription.middleware', () => ({ checkLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('../utils/ticket', () => ({ generateTicketNumber: () => 'G001', getNextSequence: async () => 1 }));
vi.mock('./notifications.service', () => ({ WAITING_ORDER: [], CALLABLE_WHERE: { status: 'WAITING', heldAt: null, awaitingClearance: false }, computePosition: vi.fn(async () => 1) }));
vi.mock('./queueEvents.service', () => ({
  recordQueueEvent: vi.fn(),
  startJourney: vi.fn(),
  closeJourneyIfDone: vi.fn(),
  afterQueueChange: vi.fn(),
  afterEntryCalled: vi.fn(),
  transferEntryToService: vi.fn().mockResolvedValue({ entry: { id: 'e2' } }),
  TransferError: class extends Error {},
}));

import prisma from '../lib/prisma';
import { recordQueueEvent, closeJourneyIfDone, transferEntryToService } from './queueEvents.service';
import { serveEntry, endEntry, joinQueueEntry, setEntryPriority, QueueActionError } from './queueActions.service';

const origin = { type: 'integration' as const, integrationId: 'int1' };

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.queue.findUnique as any).mockResolvedValue({ service: { locationId: 'l1' } });
  (prisma.queueEntry.findUnique as any).mockResolvedValue({ calledAt: new Date(), servedAt: null });
  (prisma.queueEntry.update as any).mockResolvedValue({ id: 'e1', queue: { serviceId: 's1' } });
  (prisma.queueEntry.findUniqueOrThrow as any).mockResolvedValue({ id: 'e1', queue: { serviceId: 's1' } });
});

describe('serveEntry', () => {
  it('runs the auto-transfer as a system event and closes the journey with the caller’s origin', async () => {
    (prisma.serviceFlow.findFirst as any).mockResolvedValue({ toServiceId: 's2' });
    await serveEntry('q1', 'e1', { actorUserId: 'staff1' });
    expect(transferEntryToService).toHaveBeenCalledWith('e1', 's2', { actorUserId: 'staff1', origin: { type: 'system' } });
    expect((recordQueueEvent as any).mock.calls[0][0]).toMatchObject({ action: 'entry.served', actorUserId: 'staff1' });
    expect((closeJourneyIfDone as any).mock.calls[0]).toEqual(['e1', { actorUserId: 'staff1' }]);
  });

  it('writes only from the allowed statuses when asked, and refuses a raced entry', async () => {
    (prisma.serviceFlow.findFirst as any).mockResolvedValue(null);
    (prisma.queueEntry.updateMany as any).mockResolvedValue({ count: 0 });
    await expect(serveEntry('q1', 'e1', { origin }, { onlyFrom: ['WAITING', 'SERVING'] })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      status: 409,
    });
    expect((prisma.queueEntry.updateMany as any).mock.calls[0][0].where).toEqual({ id: 'e1', status: { in: ['WAITING', 'SERVING'] } });
    expect(prisma.queueEntry.update).not.toHaveBeenCalled();
    expect(recordQueueEvent).not.toHaveBeenCalled();
  });
});

describe('endEntry', () => {
  it('records the event with the caller’s origin and extra data', async () => {
    (prisma.queueEntry.updateMany as any).mockResolvedValue({ count: 1 });
    await endEntry('q1', 'e1', 'NO_SHOW', { origin, data: { reason: 'Left' } }, { onlyFrom: ['WAITING'] });
    expect((recordQueueEvent as any).mock.calls[0][0]).toMatchObject({ action: 'entry.no_show', origin, data: { reason: 'Left' } });
  });
});

describe('joinQueueEntry', () => {
  it('adds the entry to an existing journey and runs the hook before the event', async () => {
    (prisma.queue.findUnique as any).mockResolvedValue({ status: 'ACTIVE', service: { name: 'GP', location: { id: 'l1', organizationId: 'org1' } } });
    (prisma.queueEntry.findFirst as any).mockResolvedValue(null);
    (prisma.queueEntry.create as any).mockResolvedValue({ id: 'e9' });
    const order: string[] = [];
    (recordQueueEvent as any).mockImplementation(async () => order.push('event'));
    await joinQueueEntry('q1', { userId: 'u1', journeyId: 'j1' }, { origin }, { beforeEvent: async () => void order.push('hook') });
    expect((prisma.queueEntry.create as any).mock.calls[0][0].data.journeyId).toBe('j1');
    expect((prisma.customerJourney.update as any).mock.calls[0][0]).toEqual({
      where: { id: 'j1' },
      data: { queueEntryIds: { push: 'e9' }, completedAt: null, totalDuration: null },
    });
    expect(order).toEqual(['hook', 'event']);
    expect((recordQueueEvent as any).mock.calls[0][0].origin).toEqual(origin);
  });

  it('refuses a closed queue with the staff API’s message', async () => {
    (prisma.queue.findUnique as any).mockResolvedValue({ status: 'PAUSED', service: { location: {} } });
    const err = await joinQueueEntry('q1', { userId: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(QueueActionError);
    expect(err).toMatchObject({ status: 400, code: 'QUEUE_CLOSED', body: { error: 'Queue is not active' } });
  });
});

describe('setEntryPriority', () => {
  it('moves an open entry and announces entry.priority_changed with the old value', async () => {
    (prisma.queueEntry.findUnique as any).mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'WAITING', priority: 0 });
    (prisma.queueEntry.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.queue.findUnique as any).mockResolvedValue({ service: { locationId: 'l1' } });
    expect(await setEntryPriority('e1', 70, { origin })).toEqual({ previousPriority: 0 });
    expect((prisma.queueEntry.updateMany as any).mock.calls[0][0]).toEqual({
      where: { id: 'e1', status: { in: ['WAITING', 'SERVING'] } },
      data: { priority: 70 },
    });
    expect(recordQueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'entry.priority_changed', entryId: 'e1', origin, data: { priority: 70, previousPriority: 0 },
    }));
  });

  it('does nothing for the same value, and refuses an entry that is no longer open', async () => {
    (prisma.queueEntry.findUnique as any).mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'WAITING', priority: 70 });
    expect(await setEntryPriority('e1', 70)).toEqual({ previousPriority: null });
    expect(recordQueueEvent).not.toHaveBeenCalled();

    (prisma.queueEntry.findUnique as any).mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'SERVED', priority: 0 });
    (prisma.queueEntry.updateMany as any).mockResolvedValue({ count: 0 });
    await expect(setEntryPriority('e1', 50)).rejects.toBeInstanceOf(QueueActionError);
  });
});
