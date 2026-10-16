import { describe, it, expect, vi, beforeEach } from 'vitest';

// Klargy Connect phase 4 on the public side: "Require an MR or member number
// to join" on the kiosk and join page, and the messages on the status page.

const db = vi.hoisted(() => ({
  service: { findUnique: vi.fn() },
  user: { create: vi.fn() },
  queueEntry: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  notification: { findMany: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ default: db, prisma: db }));
vi.mock('../../lib/realtime', () => ({
  emitToQueue: vi.fn(), emitToService: vi.fn(), emitToLocation: vi.fn(), emitToQueueAndLocation: vi.fn(),
  SOCKET_EVENTS: { QUEUE_UPDATED: 'queue:updated' },
}));
vi.mock('../../utils/ticket', () => ({
  generateTicketNumber: vi.fn(() => 'G014'),
  getNextSequence: vi.fn(async () => 14),
  generateQRData: vi.fn(() => 'qr'),
}));
vi.mock('../../services/waitEstimate', () => ({ estimateWaitMinutes: vi.fn(async () => 10) }));
vi.mock('../../services/queueEvents.service', () => ({
  recordQueueEvent: vi.fn(), startJourney: vi.fn(), closeJourneyIfDone: vi.fn(), afterQueueChange: vi.fn(),
  afterEntryCalled: vi.fn(), transferEntryToService: vi.fn(), TransferError: class extends Error {},
  getOrCreateQueueForDate: vi.fn(async () => ({ queue: { id: 'q1', status: 'ACTIVE' } })),
  serviceTimeZone: vi.fn(), ORIGIN: { public: { type: 'public' } }, journeySteps: vi.fn(async () => new Map()),
}));
vi.mock('../../services/notifications.service', () => ({
  WAITING_ORDER: [], CALLABLE_WHERE: { status: 'WAITING', heldAt: null, awaitingClearance: false }, computePosition: vi.fn(async () => 1), notifyEntry: vi.fn(async () => {}),
  queueLineRanks: vi.fn(async () => new Map([['e1', 1]])),
}));
vi.mock('../../services/connectLookup.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/connectLookup.service')>()),
  joinIdentifierFor: vi.fn(),
  lookupPatient: vi.fn(),
  locationRefFor: vi.fn(async () => 'LOC-1'),
}));

import { LookupError, joinIdentifierFor, lookupPatient } from '../../services/connectLookup.service';
import { publicJoinQueueWithSession, getPublicStatus } from '../queue.controller';

const required = { type: 'mrNumber', label: 'MR number', integration: { id: 'int1' } };

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const join = (body: Record<string, unknown>) => ({ body: { serviceId: 's1', name: 'Ama Mensah', ...body } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  db.service.findUnique.mockResolvedValue({
    id: 's1', name: 'GP', isActive: true, locationId: 'l1',
    location: { id: 'l1', name: 'Airport', organizationId: 'org1', organization: { id: 'org1', status: 'ACTIVE', joinIdentifierType: 'mrNumber' } },
  });
  db.user.create.mockResolvedValue({ id: 'u1' });
  db.queueEntry.findFirst.mockResolvedValue(null);
  db.queueEntry.create.mockImplementation(async ({ data }: any) => ({ id: 'e1', joinedAt: new Date(), status: 'WAITING', ...data }));
  (joinIdentifierFor as any).mockResolvedValue(required);
  (lookupPatient as any).mockResolvedValue({ matched: true, patient: { firstName: 'Ama' }, candidates: [] });
});

describe('joining with "Require an MR or member number to join" on', () => {
  it('checks the number with the EMR as a public lookup, then issues the ticket', async () => {
    const res = makeRes();
    await publicJoinQueueWithSession(join({ identifier: ' NH-1 ' }), res, vi.fn());
    expect(lookupPatient).toHaveBeenCalledWith(required.integration, { identifierType: 'mrNumber', identifier: 'NH-1', context: 'public', locationRef: 'LOC-1' });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.user.create.mock.calls[0][0].data.identityData).toEqual({ mrNumber: 'NH-1' });
    expect(db.queueEntry.create.mock.calls[0][0].data.notes).toBeNull();
  });

  it('turns away a number the EMR doesn’t know with 422 IDENTIFIER_NOT_MATCHED', async () => {
    (lookupPatient as any).mockResolvedValue({ matched: false, patient: null, candidates: [] });
    const res = makeRes();
    await publicJoinQueueWithSession(join({ identifier: 'NH-404' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'IDENTIFIER_NOT_MATCHED' });
    expect(res.json.mock.calls[0][0].error).toMatch(/MR number/);
    expect(db.queueEntry.create).not.toHaveBeenCalled();
  });

  it('asks for the number when it is missing', async () => {
    const res = makeRes();
    await publicJoinQueueWithSession(join({}), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Please enter your MR number.', code: 'IDENTIFIER_REQUIRED' });
  });

  it('lets them join when the EMR can’t be reached, noting the number wasn’t verified', async () => {
    (lookupPatient as any).mockRejectedValue(new LookupError('Couldn’t reach the connected system', 'LOOKUP_FAILED'));
    const res = makeRes();
    await publicJoinQueueWithSession(join({ identifier: 'NH-1', notes: 'Wheelchair' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    const notes = db.queueEntry.create.mock.calls[0][0].data.notes;
    expect(notes).toMatch(/^Wheelchair\n/);
    expect(notes).toMatch(/Identifier not verified/);
  });

  it('asks nothing when the setting is off', async () => {
    (joinIdentifierFor as any).mockResolvedValue(null);
    const res = makeRes();
    await publicJoinQueueWithSession(join({}), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(lookupPatient).not.toHaveBeenCalled();
  });
});

describe('getPublicStatus messages', () => {
  it('returns the in-app messages for this ticket only, newest first, without identity', async () => {
    db.queueEntry.findUnique.mockResolvedValue({
      id: 'e1', queueId: 'q1', status: 'WAITING', priority: 0, joinedAt: new Date(), calledAt: null, ticketNumber: 'G014',
      user: { firstName: 'Ama', lastName: 'Mensah' },
      queue: { service: { name: 'GP', slotDuration: 10, concurrentLimit: 1, location: { name: 'Airport', address: null, organization: { status: 'ACTIVE' } } }, entries: [] },
    });
    const sent = [{ type: 'QUEUE_JOINED', message: 'Your ticket for GP is G014.', sentAt: new Date('2026-10-15T09:00:00Z') }];
    db.notification.findMany.mockResolvedValue(sent);
    const res = makeRes();
    await getPublicStatus({ params: { queueId: 'q1', entryId: 'e1' } } as any, res, vi.fn());
    expect(db.notification.findMany).toHaveBeenCalledWith({
      where: { queueEntryId: 'e1', channel: 'IN_APP' },
      orderBy: { sentAt: 'desc' },
      take: 20,
      select: { type: true, message: true, sentAt: true },
    });
    expect(res.json.mock.calls[0][0].messages).toEqual(sent);
  });
});
