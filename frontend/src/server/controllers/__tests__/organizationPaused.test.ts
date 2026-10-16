import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  default: {
    location: { findUnique: vi.fn() },
    service: { findUnique: vi.fn() },
    queueEntry: { findUnique: vi.fn() },
  },
}));

import prisma from '../../lib/prisma';
import { getLocationByCode } from '../location.controller';
import { publicJoinQueueWithSession } from '../queue.controller';
import { getPublicStatus } from '../queue.controller';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('getLocationByCode - paused organization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks with 403 when the organization is paused', async () => {
    (prisma.location.findUnique as any).mockResolvedValue({
      id: 'loc1',
      organization: { id: 'org1', status: 'PAUSED' },
      services: [],
    });
    const req: any = { params: { code: 'AIRPORTMAIN' } };
    const res = makeRes();
    await getLocationByCode(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'ORGANIZATION_PAUSED' }));
  });

  it('returns the location normally when the organization is active', async () => {
    const location = { id: 'loc1', organization: { id: 'org1', status: 'ACTIVE' }, services: [] };
    (prisma.location.findUnique as any).mockResolvedValue(location);
    const req: any = { params: { code: 'AIRPORTMAIN' } };
    const res = makeRes();
    await getLocationByCode(req, res, vi.fn());
    expect(res.status).not.toHaveBeenCalledWith(403);
    // No WhatsApp set up (the mocked prisma has none): no WhatsApp prompt on the join form.
    expect(res.json).toHaveBeenCalledWith({ ...location, joinIdentifier: null, whatsapp: null });
  });
});

describe('publicJoinQueueWithSession - paused organization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks with 403 when the organization is paused', async () => {
    (prisma.service.findUnique as any).mockResolvedValue({
      id: 'service1',
      isActive: true,
      location: { id: 'loc1', organization: { status: 'PAUSED' } },
    });
    const req: any = { body: { serviceId: 'service1', name: 'Jane Doe' } };
    const res = makeRes();
    await publicJoinQueueWithSession(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'ORGANIZATION_PAUSED' }));
  });
});

describe('getPublicStatus - paused organization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks with 403 when the organization is paused', async () => {
    (prisma.queueEntry.findUnique as any).mockResolvedValue({
      id: 'entry1',
      queueId: 'queue1',
      queue: {
        service: {
          location: { organization: { status: 'PAUSED' } },
        },
        entries: [],
      },
    });
    const req: any = { params: { queueId: 'queue1', entryId: 'entry1' } };
    const res = makeRes();
    await getPublicStatus(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'ORGANIZATION_PAUSED' }));
  });
});
