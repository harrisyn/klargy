import { describe, it, expect, vi, beforeEach } from 'vitest';

// Patients moving themselves on from their status page ("I'm done here").

const db = vi.hoisted(() => ({
  queueEntry: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  serviceFlow: { findMany: vi.fn() },
  service: { findUniqueOrThrow: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ default: db }));
vi.mock('../../services/notifications.service', () => ({ notifyEntry: vi.fn(async () => {}) }));
vi.mock('../../services/queueEvents.service', () => ({
  ORIGIN: { public: { type: 'public' } },
  TransferError: class extends Error {},
  transferEntryToService: vi.fn(),
}));
vi.mock('../../services/queueActions.service', () => ({
  QueueActionError: class extends Error {},
  checkEntryLimits: vi.fn(),
  endEntry: vi.fn(),
  serveEntry: vi.fn(),
}));

import { transferEntryToService } from '../../services/queueEvents.service';
import { endEntry, serveEntry } from '../../services/queueActions.service';
import { getPublicNextSteps, postPublicMove } from '../publicJourney.controller';
import { getStartOfDay } from '../../utils/date';

const res = () => {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r;
};
const req = (body: Record<string, unknown> = {}) => ({ params: { queueId: 'q1', entryId: 'e1' }, body }) as any;

const entry = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'e1', queueId: 'q1', status, journeyId: 'j1', completedAt: null,
  queue: {
    date: getStartOfDay(new Date(), 'UTC'),
    service: { id: 's-rec', name: 'Reception', location: { id: 'l1', timezone: 'UTC', organization: { status: 'ACTIVE' } } },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.serviceFlow.findMany.mockResolvedValue([
    { displayName: null, toService: { id: 's-cash', name: 'Cashier' } },
    { displayName: null, toService: { id: 's-cons', name: 'Consultation' } },
  ]);
  db.queueEntry.findMany.mockResolvedValue([{ queue: { serviceId: 's-rec' } }, { queue: { serviceId: 's-cons' } }]);
  db.queueEntry.findFirst.mockResolvedValue(null);
  db.service.findUniqueOrThrow.mockResolvedValue({ location: { organizationId: 'org1' } });
  (transferEntryToService as any).mockResolvedValue({ entry: { id: 'e2' }, service: { name: 'Consultation' } });
  db.queueEntry.findUniqueOrThrow.mockResolvedValue({ id: 'e2', queueId: 'q2', ticketNumber: 'C004', awaitingClearance: true });
});

describe('GET next-steps', () => {
  it('lists the flow’s next steps once they’ve been seen, marking a service they return to', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('SERVED'));
    const r = res();
    await getPublicNextSteps(req(), r, vi.fn());
    expect(r.json.mock.calls[0][0]).toEqual({
      canMoveOn: true,
      canLeave: true,
      steps: [
        { serviceId: 's-cash', name: 'Cashier', returning: false },
        { serviceId: 's-cons', name: 'Consultation', returning: true },
      ],
    });
  });

  it('only offers leaving while still waiting, and nothing once they’ve been sent on', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('WAITING'));
    const r = res();
    await getPublicNextSteps(req(), r, vi.fn());
    expect(r.json.mock.calls[0][0]).toEqual({ canMoveOn: false, canLeave: true, steps: [] });

    db.queueEntry.findUnique.mockResolvedValue(entry('SERVED'));
    db.queueEntry.findFirst.mockResolvedValue({ id: 'e2' });
    const r2 = res();
    await getPublicNextSteps(req(), r2, vi.fn());
    expect(r2.json.mock.calls[0][0]).toEqual({ canMoveOn: false, canLeave: false, steps: [] });
  });

  it('answers 404 for an entry that isn’t in that queue (not its own status link)', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('SERVED', { queueId: 'other' }));
    const r = res();
    await getPublicNextSteps(req(), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(404);
  });
});

describe('POST move', () => {
  it('sends them to a next step as the patient, through the clearance gate', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('SERVING'));
    const r = res();
    await postPublicMove(req({ to: 's-cons' }), r, vi.fn());
    expect(transferEntryToService).toHaveBeenCalledWith('e1', 's-cons', {
      origin: { type: 'public' },
      sentBy: 'patient',
      completeSource: true,
      requireOpenSource: true,
    });
    expect(r.status).toHaveBeenCalledWith(201);
    expect(r.json.mock.calls[0][0].entry).toEqual({
      entryId: 'e2', queueId: 'q2', ticketNumber: 'C004', serviceName: 'Consultation', awaitingClearance: true, statusPath: '/status/q2/e2',
    });
  });

  it('refuses a service that isn’t a next step from here', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('SERVING'));
    const r = res();
    await postPublicMove(req({ to: 's-pharmacy' }), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json.mock.calls[0][0].code).toBe('NOT_A_NEXT_STEP');
    expect(transferEntryToService).not.toHaveBeenCalled();
  });

  it('refuses moving on before being seen', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('WAITING'));
    const r = res();
    await postPublicMove(req({ to: 's-cons' }), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json.mock.calls[0][0].code).toBe('NOT_MOVABLE');
  });

  it('“I’m leaving” cancels a waiting ticket and finishes one being served', async () => {
    db.queueEntry.findUnique.mockResolvedValue(entry('WAITING'));
    await postPublicMove(req({ to: 'leave' }), res(), vi.fn());
    expect((endEntry as any).mock.calls[0].slice(0, 3)).toEqual(['q1', 'e1', 'CANCELLED']);
    db.queueEntry.findUnique.mockResolvedValue(entry('SERVING'));
    await postPublicMove(req({ to: 'leave' }), res(), vi.fn());
    expect((serveEntry as any).mock.calls[0].slice(0, 2)).toEqual(['q1', 'e1']);
  });
});
