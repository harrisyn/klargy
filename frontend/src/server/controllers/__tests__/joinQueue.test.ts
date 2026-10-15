import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  default: {
    queue: { findUnique: vi.fn() },
    queueEntry: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('../../middleware/subscription.middleware', () => ({
  checkLimit: vi.fn(),
}));

vi.mock('../../lib/realtime', () => ({
  emitToQueue: vi.fn(),
  emitToService: vi.fn(),
  emitToLocation: vi.fn(),
  emitToQueueAndLocation: vi.fn(),
  SOCKET_EVENTS: { QUEUE_UPDATED: 'queue:updated' },
}));

vi.mock('../../utils/ticket', () => ({
  generateTicketNumber: vi.fn(() => 'A-001'),
  getNextSequence: vi.fn(async () => 1),
  generateQRData: vi.fn(() => 'qr-data'),
}));

// Post-join side effects (audit, webhooks, journeys, notifications) are
// covered separately - stub them here.
vi.mock('../../services/queueEvents.service', () => ({
  recordQueueEvent: vi.fn(),
  startJourney: vi.fn(),
  closeJourneyIfDone: vi.fn(),
  afterQueueChange: vi.fn(),
  afterEntryCalled: vi.fn(),
  transferEntryToService: vi.fn(),
  TransferError: class extends Error {},
}));

vi.mock('../../services/notifications.service', () => ({
  WAITING_ORDER: [], CALLABLE_WHERE: { status: 'WAITING', heldAt: null, awaitingClearance: false },
  computePosition: vi.fn(async () => 1),
  notifyEntry: vi.fn(async () => {}),
}));

import prisma from '../../lib/prisma';
import { checkLimit } from '../../middleware/subscription.middleware';
import { joinQueue } from '../queue.controller';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const mockQueue = {
  id: 'queue1',
  status: 'ACTIVE',
  service: {
    id: 'service1',
    name: 'Consultation',
    location: { id: 'loc1', organizationId: 'org1' },
  },
};

describe('joinQueue - subscription limit enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.queue.findUnique as any).mockResolvedValue(mockQueue);
    (prisma.queueEntry.findFirst as any).mockResolvedValue(null);
  });

  it('blocks the join with 403 when the daily queue-entry limit is reached', async () => {
    (checkLimit as any).mockImplementation(async (_orgId: string, limitType: string) =>
      limitType === 'queueEntriesDaily'
        ? { current: 10, limit: 10, allowed: false }
        : { current: 2, limit: 100, allowed: true }
    );

    const req: any = { params: { id: 'queue1' }, body: { userId: 'user1' } };
    const res = makeRes();
    const next = vi.fn();

    await joinQueue(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ limitType: 'queueEntriesDaily', current: 10, limit: 10 }));
    expect(prisma.queueEntry.create).not.toHaveBeenCalled();
  });

  it('blocks the join with 403 when the period queue-entry limit is reached', async () => {
    (checkLimit as any).mockImplementation(async (_orgId: string, limitType: string) =>
      limitType === 'queueEntriesPeriod'
        ? { current: 500, limit: 500, allowed: false }
        : { current: 2, limit: 100, allowed: true }
    );

    const req: any = { params: { id: 'queue1' }, body: { userId: 'user1' } };
    const res = makeRes();
    const next = vi.fn();

    await joinQueue(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ limitType: 'queueEntriesPeriod', current: 500, limit: 500 }));
    expect(prisma.queueEntry.create).not.toHaveBeenCalled();
  });

  it('allows the join through to creation when both limits are under cap', async () => {
    (checkLimit as any).mockResolvedValue({ current: 2, limit: 100, allowed: true });
    (prisma.queueEntry.create as any).mockResolvedValue({
      id: 'entry1',
      queueId: 'queue1',
      userId: 'user1',
      priority: 0,
      joinedAt: new Date(),
      queue: { service: {} },
      user: {},
    });
    (prisma.queueEntry.count as any).mockResolvedValue(0);

    const req: any = { params: { id: 'queue1' }, body: { userId: 'user1' } };
    const res = makeRes();
    const next = vi.fn();

    await joinQueue(req, res, next);

    expect(prisma.queueEntry.create).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
