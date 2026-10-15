import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 6: hold, resume, the payment gate and desks people return to.

vi.mock('../lib/prisma', () => ({
  default: {
    queue: { findUnique: vi.fn() },
    queueEntry: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    servicePointInstance: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../lib/realtime', () => ({ emitToQueue: vi.fn(), emitToLocation: vi.fn(), emitToQueueAndLocation: vi.fn(), SOCKET_EVENTS: {} }));
vi.mock('../middleware/subscription.middleware', () => ({ checkLimit: vi.fn() }));
vi.mock('./notifications.service', () => ({
  WAITING_ORDER: [],
  CALLABLE_WHERE: { status: 'WAITING', heldAt: null, awaitingClearance: false },
  computePosition: vi.fn(),
}));
vi.mock('./queueEvents.service', () => ({
  recordQueueEvent: vi.fn(),
  startJourney: vi.fn(),
  closeJourneyIfDone: vi.fn(),
  afterQueueChange: vi.fn(),
  afterEntryCalled: vi.fn(),
  transferEntryToService: vi.fn(),
  TransferError: class extends Error {},
}));

import prisma from '../lib/prisma';
import { recordQueueEvent, afterEntryCalled } from './queueEvents.service';
import { callEntry, holdEntry, resumeEntry, clearEntry } from './queueActions.service';

const db = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  db.queue.findUnique.mockResolvedValue({ serviceId: 's1', service: { locationId: 'l1' } });
  db.queueEntry.findMany.mockResolvedValue([]);
  db.servicePointInstance.findMany.mockResolvedValue([]);
  db.queueEntry.updateMany.mockResolvedValue({ count: 1 });
  db.queueEntry.findUniqueOrThrow.mockResolvedValue({ id: 'e1', servicePointInstance: null });
});

describe('holdEntry', () => {
  it('takes the person off the desk, keeps them waiting at the front and announces entry.held', async () => {
    db.queueEntry.findUnique.mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'SERVING', heldAt: null, servicePointInstanceId: 'desk1' });
    expect(await holdEntry('e1', { actorUserId: 'staff1' })).toEqual({ changed: true });
    const { where, data } = db.queueEntry.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 'e1', status: 'SERVING' });
    expect(data).toMatchObject({ status: 'WAITING', deskInstanceId: 'desk1', servicePointInstanceId: null });
    expect(data.heldAt).toBeInstanceOf(Date);
    expect((recordQueueEvent as any).mock.calls[0][0]).toMatchObject({ action: 'entry.held', entryId: 'e1' });
  });

  it('changes nothing for someone already on hold, and refuses someone only waiting', async () => {
    db.queueEntry.findUnique.mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'WAITING', heldAt: new Date() });
    expect(await holdEntry('e1')).toEqual({ changed: false });
    db.queueEntry.findUnique.mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'WAITING', heldAt: null });
    await expect(holdEntry('e1')).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });
});

describe('callEntry', () => {
  it('skips people on hold or awaiting payment when calling next', async () => {
    db.queueEntry.findFirst.mockResolvedValue({ id: 'e2', joinedAt: new Date(), calledAt: null, heldAt: null });
    await callEntry('q1', {});
    const where = db.queueEntry.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ queueId: 'q1', status: 'WAITING', heldAt: null, awaitingClearance: false });
    expect((recordQueueEvent as any).mock.calls[0][0].action).toBe('entry.called');
  });

  it('calls someone returning to this desk first', async () => {
    db.queueEntry.findFirst.mockResolvedValueOnce({ id: 'back', joinedAt: new Date(), calledAt: null, heldAt: null });
    db.queue.findUnique.mockResolvedValueOnce({ serviceId: 's1' });
    // A valid desk for the service.
    db.servicePointInstance.findUnique = vi.fn().mockResolvedValue({
      isActive: true,
      servicePointService: { serviceId: 's1', isActive: true, servicePoint: { isActive: true } },
    });
    await callEntry('q1', { servicePointInstanceId: 'desk1' });
    expect(db.queueEntry.findFirst.mock.calls[0][0].where).toMatchObject({ deskInstanceId: 'desk1' });
  });

  it('refuses to call a chosen patient who hasn’t paid', async () => {
    db.queueEntry.findFirst.mockResolvedValue({ awaitingClearance: true });
    await expect(callEntry('q1', { entryId: 'e1' })).rejects.toMatchObject({ status: 409, code: 'AWAITING_CLEARANCE' });
    expect(db.queueEntry.updateMany).not.toHaveBeenCalled();
  });

  it('calls a chosen patient on hold back as entry.resumed, and tells them again', async () => {
    db.queueEntry.findFirst
      .mockResolvedValueOnce({ awaitingClearance: false })
      .mockResolvedValueOnce({ id: 'e1', joinedAt: new Date(), calledAt: new Date(), heldAt: new Date() });
    const result = await callEntry('q1', { entryId: 'e1' });
    expect(result.resumed).toBe(true);
    const { data } = db.queueEntry.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ status: 'SERVING', heldAt: null, deskInstanceId: null });
    expect(data.calledAt).toBeUndefined();
    expect((recordQueueEvent as any).mock.calls[0][0].action).toBe('entry.resumed');
    expect((afterEntryCalled as any).mock.calls[0][2]).toBeInstanceOf(Date);
  });
});

describe('resumeEntry', () => {
  it('calls them back to the desk they were held at', async () => {
    db.queueEntry.findUnique.mockResolvedValue({ id: 'e1', queueId: 'q1', status: 'WAITING', heldAt: new Date(), deskInstanceId: 'desk1' });
    db.servicePointInstance.findUnique = vi.fn().mockResolvedValue({
      isActive: true,
      servicePointService: { serviceId: 's1', isActive: true, servicePoint: { isActive: true } },
    });
    db.queueEntry.findFirst
      .mockResolvedValueOnce({ awaitingClearance: false })
      .mockResolvedValueOnce({ id: 'e1', joinedAt: new Date(), calledAt: new Date(), heldAt: new Date() });
    expect(await resumeEntry('e1', {})).toEqual({ changed: true });
    expect(db.queueEntry.updateMany.mock.calls[0][0].data.servicePointInstanceId).toBe('desk1');
  });
});

describe('clearEntry', () => {
  it('lets someone awaiting payment into the line once, announcing entry.cleared', async () => {
    db.queueEntry.findUnique.mockResolvedValue({ id: 'e1', queueId: 'q1', awaitingClearance: true });
    expect(await clearEntry('e1')).toEqual({ changed: true });
    expect(db.queueEntry.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'e1', awaitingClearance: true }, data: { awaitingClearance: false } });
    expect((recordQueueEvent as any).mock.calls[0][0].action).toBe('entry.cleared');
    db.queueEntry.findUnique.mockResolvedValue({ id: 'e1', queueId: 'q1', awaitingClearance: false });
    expect(await clearEntry('e1')).toEqual({ changed: false });
  });
});
