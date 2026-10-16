import { describe, it, expect, vi, beforeEach } from 'vitest';

// The one waiting-line order behind call next, positions, the desk, the
// lobby screen and the status page: the database order with booked
// patients fitted in by booked time (queueOrder.ts).

const db = vi.hoisted(() => ({
  queue: { findUnique: vi.fn() },
  queueEntry: { findMany: vi.fn() },
}));
vi.mock('../lib/prisma', () => ({ default: db, prisma: db }));
vi.mock('../lib/realtime', () => ({ emitToUser: vi.fn(), emitToQueue: vi.fn(), SOCKET_EVENTS: {} }));
vi.mock('../middleware/subscription.middleware', () => ({ consumeCredits: vi.fn() }));
vi.mock('../utils/email', () => ({ sendNotificationEmail: vi.fn() }));
vi.mock('./sms', () => ({ getSmsProvider: vi.fn() }));

import { computePosition, queueLineRanks, waitingLine } from './notifications.service';

const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 15, h, m));
const row = (id: string, joinedAt: Date, bookedPlaceAt: Date | null = null) => ({
  id, priority: 0, sortOrder: 0, joinedAt, calledAt: null, heldAt: null, deskInstanceId: null, bookedPlaceAt,
});
const settings = (bookedArrivalSettings: unknown) =>
  db.queue.findUnique.mockResolvedValue({ service: { location: { organization: { bookedArrivalSettings } } } });

beforeEach(() => {
  vi.clearAllMocks();
  // Database order: by arrival.
  db.queueEntry.findMany.mockResolvedValue([row('w1', at(10, 25)), row('w2', at(10, 33)), row('b', at(10, 40), at(10, 30))]);
});

describe('waitingLine', () => {
  it('reads only callable entries and fits booked patients in by booked time', async () => {
    settings(null);
    expect((await waitingLine('q1')).map((e) => e.id)).toEqual(['w1', 'b', 'w2']);
    expect(db.queueEntry.findMany.mock.calls[0][0].where).toEqual({ queueId: 'q1', status: 'WAITING', heldAt: null, awaitingClearance: false });
  });

  it('puts everyone in by arrival while the setting is off', async () => {
    settings({ enabled: false });
    expect((await waitingLine('q1')).map((e) => e.id)).toEqual(['w1', 'w2', 'b']);
  });

  it('gives the same order to positions', async () => {
    settings(null);
    expect(await computePosition('q1', 'b')).toBe(2);
    expect(await computePosition('q1', 'gone')).toBe(0);
    expect([...(await queueLineRanks('q1'))]).toEqual([['w1', 1], ['b', 2], ['w2', 3]]);
  });
});
