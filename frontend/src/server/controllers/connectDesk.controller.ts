import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { normalizeEmail } from '../lib/verification';
import { buildAppUrl } from '../config/appConfig';
import { launchOnlyIdentity } from '../lib/connectStaff';
import { checkLimit } from '../middleware/subscription.middleware';
import { ConnectError, CONTRACT, badRequest, handle, text } from './connect.controller';
import { entryViews } from './connectQueue.controller';
import { klargyIdFor, linkRef } from '../services/externalRefs.service';

// Klargy Connect v1, phase 3 (docs/connect/v1.md section 6): the staff desk
// opened inside the other system. The EMR's server asks for a one-time code
// for the practitioner signed in to it; the desk page exchanges the code for
// a normal staff session.

export const LAUNCH_TTL_MS = 60 * 1000;
// Launch rows are kept after use: the launched desk looks up references
// through its launch for as long as its session lasts (24 hours).
const LAUNCH_RETENTION_MS = 48 * 60 * 60 * 1000;

type Caller = { id: string; organizationId: string };
const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === 'P2002';

export const hashLaunchCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

/** `returnOrigin` as an origin, or null when it isn't one. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] || name, lastName: parts.slice(1).join(' ') };
}

const STAFF_SELECT = { id: true, isActive: true, role: true } as const;

/**
 * The Klargy staff member for an EMR practitioner: by the existing staff
 * reference, else by email among the organisation's active staff (and the
 * reference is recorded), else a newly registered SERVICE_STAFF user who can
 * only sign in through a desk launch.
 */
export async function resolveLaunchStaff(
  integration: Caller,
  staff: { id: string; name: string; email?: string }
): Promise<{ userId: string; created: boolean }> {
  const knownId = await klargyIdFor(integration.id, 'staff', staff.id);
  if (knownId) {
    const known = await prisma.user.findFirst({
      where: { id: knownId, organizationId: integration.organizationId, role: { notIn: ['PATIENT', 'SUPER_ADMIN'] } },
      select: STAFF_SELECT,
    });
    if (known) {
      if (!known.isActive) {
        throw new ConnectError('This staff member’s Klargy account is switched off', 403, 'STAFF_INACTIVE');
      }
      return { userId: known.id, created: false };
    }
  }

  const email = staff.email ? normalizeEmail(staff.email) : null;
  if (email) {
    const match = await prisma.user.findFirst({
      where: {
        email,
        organizationId: integration.organizationId,
        isActive: true,
        role: { notIn: ['PATIENT', 'SUPER_ADMIN'] },
      },
      select: { id: true },
    });
    if (match) {
      await linkRef(integration, 'staff', match.id, staff.id);
      return { userId: match.id, created: false };
    }
  }

  const seats = await checkLimit(integration.organizationId, 'users');
  if (!seats.allowed) {
    throw new ConnectError('The plan has no staff seats left to register this practitioner', 403, 'LIMIT_REACHED', {
      limitType: 'users',
      current: seats.current,
      limit: seats.limit,
    });
  }

  // The practitioner's own email when nobody in Klargy has it yet (it may
  // belong to a patient, or to someone in another organisation), else an
  // internal placeholder; the EMR's email is kept in identityData either way.
  const emailFree = email ? !(await prisma.user.findUnique({ where: { email }, select: { id: true } })) : false;
  const { firstName, lastName } = splitName(staff.name);
  const user = await prisma.user.create({
    data: {
      email: emailFree && email ? email : `connect_staff_${crypto.randomUUID()}@guest.qms.local`,
      // Never a usable password: these staff only come in through the EMR.
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      firstName,
      lastName,
      role: 'SERVICE_STAFF',
      organizationId: integration.organizationId,
      identityData: launchOnlyIdentity(integration.id, email) as object,
    },
    select: { id: true },
  });

  try {
    if (knownId) {
      // The reference pointed at someone who's gone: repoint it.
      await linkRef(integration, 'staff', user.id, staff.id);
    } else {
      await prisma.externalReference.create({
        data: {
          integrationId: integration.id,
          organizationId: integration.organizationId,
          resourceType: 'staff',
          resourceId: user.id,
          externalId: staff.id,
        },
      });
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A launch for the same practitioner registered them a moment ago.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    const winner = await klargyIdFor(integration.id, 'staff', staff.id);
    if (!winner) throw error;
    return { userId: winner, created: false };
  }
  return { userId: user.id, created: true };
}

function parseStaff(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('staff must be an object');
  const s = value as Record<string, unknown>;
  const email = text(s.email, 'staff.email', false)?.toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('staff.email is not an email address');
  return { id: text(s.id, 'staff.id')!, name: text(s.name, 'staff.name')!, email };
}

/** POST /connect/v1/desk/launch */
export const launchDesk = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration: Caller = { id: req.integration!.id, organizationId: req.integration!.organizationId };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const staff = parseStaff(body.staff);
    const servicePointRef = text(body.servicePoint, 'servicePoint', false);
    const originRaw = text(body.returnOrigin, 'returnOrigin')!;

    const record = await prisma.integration.findUnique({
      where: { id: integration.id },
      select: { embedOrigins: true, organization: { select: { slug: true } } },
    });
    if (!record) return res.status(401).json({ error: 'A valid integration API key is required' });
    const origin = normalizeOrigin(originRaw);
    if (!origin || !record.embedOrigins.includes(origin)) {
      throw new ConnectError('returnOrigin is not one of this integration’s embedOrigins', 400, 'ORIGIN_NOT_ALLOWED');
    }

    let servicePointId: string | null = null;
    if (servicePointRef) {
      const mapped = await klargyIdFor(integration.id, 'service_point', servicePointRef);
      const point = await prisma.servicePoint.findFirst({
        where: { id: mapped ?? servicePointRef, organizationId: integration.organizationId },
        select: { id: true },
      });
      if (!point) {
        throw new ConnectError('That service point isn’t matched to a Klargy service point', 404, 'SERVICE_POINT_NOT_MAPPED');
      }
      servicePointId = point.id;
    }

    const { userId, created } = await resolveLaunchStaff(integration, staff);

    await prisma.deskLaunchCode.deleteMany({
      where: { integrationId: integration.id, createdAt: { lt: new Date(Date.now() - LAUNCH_RETENTION_MS) } },
    });
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LAUNCH_TTL_MS);
    await prisma.deskLaunchCode.create({
      data: { codeHash: hashLaunchCode(code), integrationId: integration.id, userId, origin, servicePointId, expiresAt },
    });

    res.status(201).json({
      url: buildAppUrl(`/widget/desk?launch=${code}`, record.organization.slug),
      expiresAt: expiresAt.toISOString(),
      staff: { klargyId: userId, created },
    });
  } catch (error) {
    handle(error, res, next);
  }
};

const invalidCode = (res: Response) =>
  res.status(400).json({ error: 'This desk link has expired or was already used. Open the desk again from your EMR.', code: 'INVALID_LAUNCH_CODE' });

/**
 * POST /auth/desk-launch {code}: public. Uses the code up (once, within its
 * minute) and signs the practitioner in, with the same response as a staff
 * login plus where the desk may talk to.
 */
export const exchangeDeskLaunch = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code || code.length > 200) return invalidCode(res);
    const codeHash = hashLaunchCode(code);
    const now = new Date();

    // Claim it atomically: of two simultaneous exchanges only one wins.
    const claimed = await prisma.deskLaunchCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return invalidCode(res);

    const launch = await prisma.deskLaunchCode.findUnique({
      where: { codeHash },
      include: {
        integration: { select: { status: true, organizationId: true } },
        user: { select: { id: true, email: true, firstName: true, lastName: true, role: true, organizationId: true, isActive: true } },
      },
    });
    const user = launch?.user;
    if (
      !launch ||
      !user ||
      launch.integration.status !== 'ACTIVE' ||
      !user.isActive ||
      user.role === 'PATIENT' ||
      user.organizationId !== launch.integration.organizationId
    ) {
      return invalidCode(res);
    }

    res.json({
      token: signToken({ userId: user.id, role: user.role }),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
      },
      launchId: launch.id,
      origin: launch.origin,
      servicePointId: launch.servicePointId,
      contract: CONTRACT,
    });
  } catch (error) {
    next(error);
  }
};

/** The launch a signed-in desk is using: its own, used, integration still on. */
async function launchFor(req: Request, res: Response) {
  const launch = await prisma.deskLaunchCode.findUnique({
    where: { id: req.params.launchId },
    include: { integration: { select: { id: true, status: true, organizationId: true } } },
  });
  if (!launch || launch.userId !== req.user?.userId || !launch.usedAt || launch.integration.status !== 'ACTIVE') {
    res.status(404).json({ error: 'Launch not found' });
    return null;
  }
  return launch;
}

/** GET /desk-launches/:launchId/desks/:instanceId: the room behind a desk,
 * with the EMR's id for it. */
export const getLaunchDesk = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const launch = await launchFor(req, res);
    if (!launch) return;
    const instance = await prisma.servicePointInstance.findFirst({
      where: { id: req.params.instanceId, servicePointService: { servicePoint: { organizationId: launch.integration.organizationId } } },
      select: { servicePointService: { select: { servicePoint: { select: { id: true, name: true } } } } },
    });
    if (!instance) return res.status(404).json({ error: 'Desk not found' });
    const point = instance.servicePointService.servicePoint;
    const ref = await prisma.externalReference.findUnique({
      where: {
        integrationId_resourceType_resourceId: { integrationId: launch.integrationId, resourceType: 'service_point', resourceId: point.id },
      },
      select: { externalId: true },
    });
    res.json({ servicePoint: { id: point.id, name: point.name, externalId: ref?.externalId ?? null } });
  } catch (error) {
    next(error);
  }
};

/** GET /desk-launches/:launchId/entries/:entryId: the Connect entry object
 * (with the integration's refs), for the desk to pass to the EMR. */
export const getLaunchEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const launch = await launchFor(req, res);
    if (!launch) return;
    const inOrg = await prisma.queueEntry.findFirst({
      where: { id: req.params.entryId, queue: { service: { location: { organizationId: launch.integration.organizationId } } } },
      select: { id: true },
    });
    const [entry] = inOrg ? await entryViews(launch.integrationId, [inOrg.id]) : [];
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json({ entry });
  } catch (error) {
    next(error);
  }
};
