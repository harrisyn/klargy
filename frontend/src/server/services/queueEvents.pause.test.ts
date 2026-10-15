import { describe, it, expect, vi, beforeEach } from 'vitest';

// Klargy Connect phase 5: pausing a queue tells everyone waiting once per
// pause and announces queue.paused / queue.resumed.

vi.mock('../lib/prisma', () => ({
  default: {
    queue: { findUnique: vi.fn(), updateMany: vi.fn() },
    queueEntry: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    externalReference: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('./notifications.service', () => ({ WAITING_ORDER: [], notifyEntry: vi.fn().mockResolvedValue(undefined), notifyPositions: vi.fn() }));
vi.mock('./webhooks.service', () => ({ dispatchWebhook: vi.fn() }));
vi.mock('../lib/realtime', () => ({ emitToQueue: vi.fn(), emitToLocation: vi.fn(), SOCKET_EVENTS: { QUEUE_UPDATED: 'queue:updated' } }));

import prisma from '../lib/prisma';
import { notifyEntry } from './notifications.service';
import { dispatchWebhook } from './webhooks.service';
import { emitToQueue } from '../lib/realtime';
import { setQueueStatus, ORIGIN } from './queueEvents.service';

const queue = (status: string) => ({
  status,
  serviceId: 's1',
  service: { id: 's1', name: 'Laboratory', location: { id: 'l1', name: 'Airport', organizationId: 'org1' } },
});

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.queue.updateMany as any).mockResolvedValue({ count: 1 });
  (prisma.queueEntry.findMany as any).mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
});

describe('setQueueStatus', () => {
  it('pauses, tells each waiting patient once for this pause, and sends queue.paused', async () => {
    (prisma.queue.findUnique as any).mockResolvedValue(queue('ACTIVE'));
    const before = Date.now();
    const out = await setQueueStatus('q1', 'PAUSED', { origin: ORIGIN.integration('int1'), reason: 'Analyser down', message: 'Please wait.' });
    expect(out).toEqual({ changed: true, previous: 'ACTIVE' });
    expect((prisma.queue.updateMany as any).mock.calls[0][0]).toEqual({ where: { id: 'q1', status: 'ACTIVE' }, data: { status: 'PAUSED' } });
    expect(emitToQueue).toHaveBeenCalledWith('q1', 'queue:updated', { queueId: 'q1', action: 'status_changed', status: 'PAUSED' });
    expect(notifyEntry).toHaveBeenCalledTimes(2);
    const [entryId, type, extra] = (notifyEntry as any).mock.calls[0];
    expect([entryId, type, extra.text]).toEqual(['e1', 'QUEUE_DELAYED', 'Please wait.']);
    expect(extra.since.getTime()).toBeGreaterThanOrEqual(before);

    const [org, event, data] = (dispatchWebhook as any).mock.calls[0];
    expect([org, event]).toEqual(['org1', 'queue.paused']);
    expect(data).toEqual({
      queueId: 'q1',
      service: { id: 's1', name: 'Laboratory' },
      location: { id: 'l1', name: 'Airport' },
      reason: 'Analyser down',
      origin: { type: 'integration', integrationId: 'int1' },
    });
  });

  it('does nothing for the same status, or when someone else changed it first', async () => {
    (prisma.queue.findUnique as any).mockResolvedValue(queue('PAUSED'));
    expect(await setQueueStatus('q1', 'PAUSED')).toEqual({ changed: false, previous: 'PAUSED' });
    (prisma.queue.findUnique as any).mockResolvedValue(queue('ACTIVE'));
    (prisma.queue.updateMany as any).mockResolvedValue({ count: 0 });
    expect((await setQueueStatus('q1', 'PAUSED')).changed).toBe(false);
    expect(notifyEntry).not.toHaveBeenCalled();
    expect(dispatchWebhook).not.toHaveBeenCalled();
  });

  it('sends queue.resumed from staff without messaging patients, and only an audit entry for closing', async () => {
    (prisma.queue.findUnique as any).mockResolvedValue(queue('PAUSED'));
    await setQueueStatus('q1', 'ACTIVE', { actorUserId: 'staff1' });
    expect((dispatchWebhook as any).mock.calls[0][1]).toBe('queue.resumed');
    expect((dispatchWebhook as any).mock.calls[0][2].origin).toEqual({ type: 'staff', integrationId: null });
    expect(notifyEntry).not.toHaveBeenCalled();

    (dispatchWebhook as any).mockClear();
    (prisma.queue.findUnique as any).mockResolvedValue(queue('ACTIVE'));
    await setQueueStatus('q1', 'CLOSED', { actorUserId: 'staff1' });
    expect(dispatchWebhook).not.toHaveBeenCalled();
    expect((prisma.auditLog.create as any).mock.calls.at(-1)[0].data.action).toBe('queue.status_changed');
  });
});
