import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ auditLog: { findMany: vi.fn() }, user: { findMany: vi.fn() } }));
vi.mock('../lib/prisma', () => ({ default: db, prisma: db }));

import { staffNamesFor } from './displayStaff';

beforeEach(() => vi.clearAllMocks());

describe('staffNamesFor (lobby screen: who is seeing them)', () => {
  it('names the person at the desk, else whoever called them', async () => {
    db.auditLog.findMany.mockResolvedValue([
      { entryId: 'e2', actorUserId: 'dr2' },
      { entryId: 'e2', actorUserId: 'older' },
    ]);
    db.user.findMany.mockResolvedValue([{ id: 'dr2', firstName: 'Kofi', lastName: 'Owusu' }]);
    const names = await staffNamesFor([
      { id: 'e1', servicePointInstance: { occupiedBy: { firstName: 'Dr', lastName: 'Mensah' } } },
      { id: 'e2', servicePointInstance: { occupiedBy: null } },
      { id: 'e3', servicePointInstance: null },
    ]);
    expect(names.get('e1')).toBe('Dr Mensah');
    expect(names.get('e2')).toBe('Kofi Owusu');
    expect(names.has('e3')).toBe(false);
    expect(db.auditLog.findMany.mock.calls[0][0].where).toMatchObject({ entryId: { in: ['e2', 'e3'] }, action: 'entry.called' });
    expect(db.user.findMany.mock.calls[0][0].where.role).toEqual({ notIn: ['PATIENT', 'SUPER_ADMIN'] });
  });

  it('asks nothing more when every desk is staffed', async () => {
    await staffNamesFor([{ id: 'e1', servicePointInstance: { occupiedBy: { firstName: 'Ama', lastName: 'Boateng' } } }]);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });
});
