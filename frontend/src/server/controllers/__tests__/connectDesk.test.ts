import { describe, it, expect, vi, beforeEach } from 'vitest';

// Klargy Connect phase 3 (docs/connect/v1.md section 6): desk launch codes.

type Ref = { resourceType: string; resourceId: string; externalId: string };
let refs: Ref[] = [];
type Code = { id: string; codeHash: string; integrationId: string; userId: string; origin: string; servicePointId: string | null; expiresAt: Date; usedAt: Date | null };
let codes: Code[] = [];

vi.mock('../../lib/prisma', () => ({
  default: {
    externalReference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    integration: { findUnique: vi.fn() },
    servicePoint: { findFirst: vi.fn() },
    servicePointInstance: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
    queueEntry: { findFirst: vi.fn(), findMany: vi.fn() },
    deskLaunchCode: { deleteMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock('../../middleware/subscription.middleware', () => ({ checkLimit: vi.fn() }));

import prisma from '../../lib/prisma';
import { checkLimit } from '../../middleware/subscription.middleware';
import { verifyToken } from '../../lib/jwt';
import { isLaunchOnlyUser } from '../../lib/connectStaff';
import {
  launchDesk,
  exchangeDeskLaunch,
  getLaunchDesk,
  getLaunchEntry,
  hashLaunchCode,
  LAUNCH_TTL_MS,
} from '../connectDesk.controller';

const integration = { id: 'int1', organizationId: 'org1', scopes: ['desk:launch'] };

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const launchBody = (over: Record<string, unknown> = {}) => ({
  staff: { id: 'DR1', name: 'Ama Owusu', email: 'Ama@Example.com' },
  servicePoint: null,
  returnOrigin: 'https://emr.example.com',
  ...over,
});

async function launch(body: Record<string, unknown> = launchBody()) {
  const res = makeRes();
  const next = vi.fn();
  await launchDesk({ integration, body } as any, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  refs = [{ resourceType: 'service_point', resourceId: 'sp1', externalId: 'ROOM3' }];
  codes = [];
  (prisma.externalReference.findUnique as any).mockImplementation(async ({ where }: any) => {
    if (where.integrationId_resourceType_externalId) {
      const k = where.integrationId_resourceType_externalId;
      const r = refs.find((x) => x.resourceType === k.resourceType && x.externalId === k.externalId);
      return r ? { resourceId: r.resourceId } : null;
    }
    const k = where.integrationId_resourceType_resourceId;
    const r = refs.find((x) => x.resourceType === k.resourceType && x.resourceId === k.resourceId);
    return r ? { externalId: r.externalId } : null;
  });
  (prisma.externalReference.findMany as any).mockImplementation(async ({ where }: any) =>
    refs.filter((r) => where.OR.some((o: any) => o.resourceType === r.resourceType && o.resourceId.in.includes(r.resourceId)))
  );
  (prisma.externalReference.create as any).mockImplementation(async ({ data }: any) => {
    if (refs.some((r) => r.resourceType === data.resourceType && r.externalId === data.externalId)) {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
    refs.push(data);
    return data;
  });
  (prisma.externalReference.upsert as any).mockImplementation(async ({ create }: any) => {
    refs = refs.filter((r) => !(r.resourceType === create.resourceType && r.resourceId === create.resourceId));
    refs.push(create);
    return create;
  });
  (prisma.integration.findUnique as any).mockResolvedValue({
    embedOrigins: ['https://emr.example.com'],
    organization: { slug: 'nyaho' },
  });
  (prisma.user.findFirst as any).mockResolvedValue(null);
  (prisma.user.findUnique as any).mockResolvedValue(null);
  (prisma.user.create as any).mockImplementation(async ({ data }: any) => ({ id: 'new-user', ...data }));
  (checkLimit as any).mockResolvedValue({ allowed: true, current: 2, limit: 5 });
  (prisma.deskLaunchCode.deleteMany as any).mockResolvedValue({ count: 0 });
  (prisma.deskLaunchCode.create as any).mockImplementation(async ({ data }: any) => {
    const row = { id: `launch${codes.length + 1}`, usedAt: null, ...data };
    codes.push(row);
    return row;
  });
  (prisma.deskLaunchCode.updateMany as any).mockImplementation(async ({ where, data }: any) => {
    const row = codes.find((c) => c.codeHash === where.codeHash && c.usedAt === null && c.expiresAt > where.expiresAt.gt);
    if (!row) return { count: 0 };
    row.usedAt = data.usedAt;
    return { count: 1 };
  });
  (prisma.deskLaunchCode.findUnique as any).mockImplementation(async ({ where }: any) => {
    const row = codes.find((c) => (where.codeHash ? c.codeHash === where.codeHash : c.id === where.id));
    if (!row) return null;
    return {
      ...row,
      integration: { id: 'int1', status: 'ACTIVE', organizationId: 'org1' },
      user: { id: row.userId, email: 'ama@example.com', firstName: 'Ama', lastName: 'Owusu', role: 'SERVICE_STAFF', organizationId: 'org1', isActive: true },
    };
  });
});

const codeFrom = (url: string) => new URL(url).searchParams.get('launch')!;

describe('POST /desk/launch: staff', () => {
  it('uses the existing staff reference', async () => {
    refs.push({ resourceType: 'staff', resourceId: 'staff1', externalId: 'DR1' });
    (prisma.user.findFirst as any).mockResolvedValueOnce({ id: 'staff1', isActive: true, role: 'SERVICE_STAFF' });
    const { status, body } = await launch();
    expect(status).toBe(201);
    expect(body.staff).toEqual({ klargyId: 'staff1', created: false });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses a mapped staff member whose account is switched off', async () => {
    refs.push({ resourceType: 'staff', resourceId: 'staff1', externalId: 'DR1' });
    (prisma.user.findFirst as any).mockResolvedValueOnce({ id: 'staff1', isActive: false, role: 'SERVICE_STAFF' });
    const { status, body } = await launch();
    expect(status).toBe(403);
    expect(body.code).toBe('STAFF_INACTIVE');
    expect(prisma.deskLaunchCode.create).not.toHaveBeenCalled();
  });

  it('matches by email among the organisation’s active staff and records the mapping', async () => {
    (prisma.user.findFirst as any).mockResolvedValueOnce({ id: 'staff2' });
    const { body } = await launch();
    expect(body.staff).toEqual({ klargyId: 'staff2', created: false });
    const where = (prisma.user.findFirst as any).mock.calls[0][0].where;
    expect(where).toMatchObject({ email: 'ama@example.com', organizationId: 'org1', isActive: true, role: { notIn: ['PATIENT', 'SUPER_ADMIN'] } });
    expect(refs).toContainEqual(expect.objectContaining({ resourceType: 'staff', resourceId: 'staff2', externalId: 'DR1' }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('registers an unknown practitioner as launch-only service staff and maps them', async () => {
    const { status, body } = await launch();
    expect(status).toBe(201);
    expect(body.staff).toEqual({ klargyId: 'new-user', created: true });
    const data = (prisma.user.create as any).mock.calls[0][0].data;
    expect(data).toMatchObject({ email: 'ama@example.com', firstName: 'Ama', lastName: 'Owusu', role: 'SERVICE_STAFF', organizationId: 'org1' });
    expect(isLaunchOnlyUser(data.identityData)).toBe(true);
    expect(data.password).toMatch(/^\$2[aby]\$/);
    expect(refs).toContainEqual(expect.objectContaining({ resourceType: 'staff', resourceId: 'new-user', externalId: 'DR1' }));
  });

  it('uses a placeholder login when the email belongs to someone else in Klargy', async () => {
    (prisma.user.findUnique as any).mockResolvedValueOnce({ id: 'a-patient' });
    await launch();
    const data = (prisma.user.create as any).mock.calls[0][0].data;
    expect(data.email).toMatch(/^connect_staff_.+@guest\.qms\.local$/);
    expect(data.identityData.email).toBe('ama@example.com');
  });

  it('refuses to register when the plan has no staff seats left', async () => {
    (checkLimit as any).mockResolvedValue({ allowed: false, current: 5, limit: 5 });
    const { status, body } = await launch();
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: 'LIMIT_REACHED', limitType: 'users', current: 5, limit: 5 });
    expect(checkLimit).toHaveBeenCalledWith('org1', 'users');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('uses the other registration when two launches race for a new practitioner', async () => {
    (prisma.externalReference.create as any).mockImplementationOnce(async () => {
      refs.push({ resourceType: 'staff', resourceId: 'winner', externalId: 'DR1' });
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    const { body } = await launch();
    expect(body.staff).toEqual({ klargyId: 'winner', created: false });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'new-user' } });
  });

  it('requires staff.id and staff.name', async () => {
    const { status } = await launch(launchBody({ staff: { id: 'DR1' } }));
    expect(status).toBe(400);
  });
});

describe('POST /desk/launch: origin, room and code', () => {
  it('refuses a returnOrigin that isn’t one of the embedOrigins', async () => {
    const { status, body } = await launch(launchBody({ returnOrigin: 'https://evil.example.com' }));
    expect(status).toBe(400);
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(prisma.deskLaunchCode.create).not.toHaveBeenCalled();
  });

  it('compares origins, not URLs', async () => {
    (prisma.user.findFirst as any).mockResolvedValueOnce({ id: 'staff2' });
    const { status, body } = await launch(launchBody({ returnOrigin: 'https://emr.example.com/patients/1' }));
    expect(status).toBe(201);
    expect(codes[0].origin).toBe('https://emr.example.com');
    expect(body.url).toMatch(/^https?:\/\/nyaho\.[^/]+\/widget\/desk\?launch=/);
  });

  it('stores only a hash of a random code that lasts 60 seconds', async () => {
    const before = Date.now();
    const { body } = await launch();
    const code = codeFrom(body.url);
    expect(code.length).toBeGreaterThanOrEqual(40);
    expect(codes[0].codeHash).toBe(hashLaunchCode(code));
    expect(JSON.stringify(codes[0])).not.toContain(code);
    const expires = new Date(body.expiresAt).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(LAUNCH_TTL_MS - 5);
    expect(expires - before).toBeLessThanOrEqual(LAUNCH_TTL_MS + 1000);
    const second = await launch();
    expect(codeFrom(second.body.url)).not.toBe(code);
  });

  it('resolves servicePoint by EMR id or Klargy id', async () => {
    (prisma.servicePoint.findFirst as any).mockResolvedValue({ id: 'sp1' });
    await launch(launchBody({ servicePoint: 'ROOM3' }));
    expect((prisma.servicePoint.findFirst as any).mock.calls[0][0].where).toEqual({ id: 'sp1', organizationId: 'org1' });
    expect(codes[0].servicePointId).toBe('sp1');
    await launch(launchBody({ servicePoint: 'sp1' }));
    expect((prisma.servicePoint.findFirst as any).mock.calls[1][0].where).toEqual({ id: 'sp1', organizationId: 'org1' });
  });

  it('404s an unknown servicePoint', async () => {
    (prisma.servicePoint.findFirst as any).mockResolvedValue(null);
    const { status, body } = await launch(launchBody({ servicePoint: 'NOPE' }));
    expect(status).toBe(404);
    expect(body.code).toBe('SERVICE_POINT_NOT_MAPPED');
  });
});

async function exchange(code: string) {
  const res = makeRes();
  const next = vi.fn();
  await exchangeDeskLaunch({ body: { code } } as any, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0]?.[0] };
}

describe('POST /auth/desk-launch', () => {
  it('signs the practitioner in once, with the login payload plus the launch', async () => {
    (prisma.servicePoint.findFirst as any).mockResolvedValue({ id: 'sp1' });
    const { body: launched } = await launch(launchBody({ servicePoint: 'ROOM3' }));
    const code = codeFrom(launched.url);

    const first = await exchange(code);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      user: { id: 'new-user', role: 'SERVICE_STAFF', organizationId: 'org1', email: 'ama@example.com' },
      launchId: 'launch1',
      origin: 'https://emr.example.com',
      servicePointId: 'sp1',
    });
    expect(verifyToken(first.body.token)).toMatchObject({ userId: 'new-user', role: 'SERVICE_STAFF' });

    const again = await exchange(code);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_LAUNCH_CODE');
  });

  it('refuses an expired code', async () => {
    const { body } = await launch();
    codes[0].expiresAt = new Date(Date.now() - 1);
    const { status, body: out } = await exchange(codeFrom(body.url));
    expect(status).toBe(400);
    expect(out.code).toBe('INVALID_LAUNCH_CODE');
  });

  it('lets only one of two simultaneous exchanges win', async () => {
    const { body } = await launch();
    const code = codeFrom(body.url);
    const results = await Promise.all([exchange(code), exchange(code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('refuses an unknown code without looking further', async () => {
    const { status } = await exchange('not-a-code');
    expect(status).toBe(400);
    expect(prisma.deskLaunchCode.findUnique).not.toHaveBeenCalled();
  });
});

describe('desk lookups for a launched session', () => {
  async function call(handler: any, params: Record<string, string>, userId = 'new-user') {
    const res = makeRes();
    const next = vi.fn();
    await handler({ params, user: { userId, role: 'SERVICE_STAFF' } } as any, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0]?.[0] };
  }

  beforeEach(async () => {
    const { body } = await launch();
    await exchange(codeFrom(body.url));
  });

  it('gives the room with the EMR’s id', async () => {
    (prisma.servicePointInstance.findFirst as any).mockResolvedValue({
      servicePointService: { servicePoint: { id: 'sp1', name: 'Consulting Room 3' } },
    });
    const { body } = await call(getLaunchDesk, { launchId: 'launch1', instanceId: 'inst1' });
    expect(body).toEqual({ servicePoint: { id: 'sp1', name: 'Consulting Room 3', externalId: 'ROOM3' } });
  });

  it('gives the Connect entry object with refs', async () => {
    refs.push({ resourceType: 'patient', resourceId: 'u1', externalId: 'P1' });
    (prisma.queueEntry.findFirst as any).mockResolvedValue({ id: 'e1' });
    (prisma.queueEntry.findMany as any).mockResolvedValue([
      {
        id: 'e1', ticketNumber: 'G001', status: 'SERVING', queueId: 'q1', journeyId: null, previousEntryId: null,
        joinedAt: new Date(), calledAt: new Date(), servedAt: null, completedAt: null,
        user: { id: 'u1', firstName: 'Kofi', lastName: 'Mensah', phone: null, identityData: null },
        queue: { service: { id: 's1', name: 'GP', location: { id: 'l1', name: 'Airport', organizationId: 'org1' } } },
        servicePointInstance: { servicePointService: { servicePoint: { id: 'sp1', name: 'Consulting Room 3' } } },
      },
    ]);
    const { body } = await call(getLaunchEntry, { launchId: 'launch1', entryId: 'e1' });
    expect(body.entry).toMatchObject({ entryId: 'e1', status: 'SERVING', refs: { patient: 'P1', servicePoint: 'ROOM3', staff: null } });
  });

  it('is only for the person the launch signed in', async () => {
    const { status } = await call(getLaunchDesk, { launchId: 'launch1', instanceId: 'inst1' }, 'someone-else');
    expect(status).toBe(404);
  });
});
