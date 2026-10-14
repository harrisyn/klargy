import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

/**
 * Tenant isolation.
 *
 * `authorize()` only checks a caller's role; it says nothing about WHICH org
 * the caller may act on. Every route that takes a resource ID (in params,
 * query or body) must also pass through `scope(...)`, which resolves each
 * referenced resource to its owning organization and 404s unless that
 * matches the caller's own org. SUPER_ADMIN bypasses the check.
 *
 * 404 (not 403) on mismatch, so a caller probing IDs can't tell "exists but
 * not yours" from "doesn't exist" - same philosophy as requireOwnOrganization.
 */

export interface Caller {
  id: string;
  role: string;
  organizationId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

/** Loads (once per request) the caller's current role/org from the DB. The
 * JWT only carries userId+role, and a role in an old token may be stale. */
export async function loadCaller(req: Request): Promise<Caller | null> {
  if (req.caller) return req.caller;
  if (!req.user) return null;
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, role: true, organizationId: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  req.caller = { id: user.id, role: user.role, organizationId: user.organizationId };
  return req.caller;
}

/** Returns the resource's owning orgId, `null` if the referenced resource
 * doesn't exist, or `undefined` if the request doesn't reference it at all
 * (optional field absent) - in which case there's nothing to check. */
type Resolver = (req: Request) => Promise<string | null | undefined>;

type Source = `${'params' | 'body' | 'query'}.${string}`;

function read(req: Request, source: Source): string | undefined {
  const [bag, key] = source.split('.') as ['params' | 'body' | 'query', string];
  const value = (req as any)[bag]?.[key];
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function resolver(lookup: (id: string) => Promise<string | null | undefined>) {
  return (source: Source): Resolver => async (req) => {
    const id = read(req, source);
    if (id === undefined) return undefined;
    return (await lookup(id)) ?? null;
  };
}

export const org = (source: Source): Resolver => async (req) => read(req, source);

export const location = resolver(async (id) =>
  (await prisma.location.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);

export const service = resolver(async (id) =>
  (await prisma.service.findUnique({ where: { id }, select: { location: { select: { organizationId: true } } } }))
    ?.location.organizationId);

export const queue = resolver(async (id) =>
  (await prisma.queue.findUnique({
    where: { id },
    select: { service: { select: { location: { select: { organizationId: true } } } } },
  }))?.service.location.organizationId);

export const entry = resolver(async (id) =>
  (await prisma.queueEntry.findUnique({
    where: { id },
    select: { queue: { select: { service: { select: { location: { select: { organizationId: true } } } } } } },
  }))?.queue.service.location.organizationId);

export const slot = resolver(async (id) =>
  (await prisma.slot.findUnique({
    where: { id },
    select: { queue: { select: { service: { select: { location: { select: { organizationId: true } } } } } } },
  }))?.queue.service.location.organizationId);

export const servicePoint = resolver(async (id) =>
  (await prisma.servicePoint.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);

export const servicePointLink = resolver(async (id) =>
  (await prisma.servicePointService.findUnique({
    where: { id },
    select: { servicePoint: { select: { organizationId: true } } },
  }))?.servicePoint.organizationId);

export const instance = resolver(async (id) =>
  (await prisma.servicePointInstance.findUnique({
    where: { id },
    select: { servicePointService: { select: { servicePoint: { select: { organizationId: true } } } } },
  }))?.servicePointService.servicePoint.organizationId);

export const serviceFlow = resolver(async (id) =>
  (await prisma.serviceFlow.findUnique({
    where: { id },
    select: { fromService: { select: { location: { select: { organizationId: true } } } } },
  }))?.fromService.location.organizationId);

export const appointment = resolver(async (id) =>
  (await prisma.appointment.findUnique({
    where: { id },
    select: { service: { select: { location: { select: { organizationId: true } } } } },
  }))?.service.location.organizationId);

export const dataSource = resolver(async (id) =>
  (await prisma.dataSource.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);

export const fieldMapping = resolver(async (id) =>
  (await prisma.fieldMapping.findUnique({
    where: { id },
    select: { dataSource: { select: { organizationId: true } } },
  }))?.dataSource.organizationId);

export const webhookEndpoint = resolver(async (id) =>
  (await prisma.webhookEndpoint.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);

export const integration = resolver(async (id) =>
  (await prisma.integration.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);

export const displayMedia = resolver(async (id) =>
  (await prisma.displayMedia.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);
export const displayPlaylist = resolver(async (id) =>
  (await prisma.displayPlaylist.findUnique({ where: { id }, select: { organizationId: true } }))?.organizationId);
export const notification = resolver(async (id) =>
  (await prisma.notification.findUnique({
    where: { id },
    select: { user: { select: { organizationId: true } } },
  }))?.user.organizationId);

// A user with no org (e.g. a superadmin account) resolves to "not found" for
// tenant callers, never to "nothing to check".
export const user = resolver(async (id) => {
  const found = await prisma.user.findUnique({ where: { id }, select: { organizationId: true } });
  if (!found) return null;
  return found.organizationId ?? '__no_org__';
});

/** Checks every id in an array body field (e.g. reorder payloads). */
export const each = (field: string, key: string, one: (s: Source) => Resolver): Resolver => async (req) => {
  const items = (req.body as any)?.[field];
  if (!Array.isArray(items) || items.length === 0) return undefined;
  let owner: string | null | undefined;
  for (const item of items) {
    const orgId = await one('body.id')({ body: { id: item?.[key] } } as Request);
    if (orgId === undefined || orgId === null) return null;
    if (owner !== undefined && owner !== orgId) return null;
    owner = orgId;
  }
  return owner;
};

export const scope = (...resolvers: Resolver[]) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const caller = await loadCaller(req);
      if (!caller) return res.status(401).json({ error: 'Authentication required' });
      if (caller.role === 'SUPER_ADMIN') return next();
      if (!caller.organizationId) return res.status(404).json({ error: 'Not found' });

      for (const resolve of resolvers) {
        const orgId = await resolve(req);
        if (orgId === undefined) continue;
        if (orgId !== caller.organizationId) {
          return res.status(404).json({ error: 'Not found' });
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };

/** Returns the org a list endpoint must be filtered to: the caller's own org,
 * or for SUPER_ADMIN whatever they asked for (possibly undefined = all). */
export async function listScopeOrgId(req: Request, requested?: string): Promise<string | undefined> {
  const caller = await loadCaller(req);
  if (!caller) throw Object.assign(new Error('Authentication required'), { status: 401 });
  if (caller.role === 'SUPER_ADMIN') return requested || undefined;
  if (!caller.organizationId) throw Object.assign(new Error('Not found'), { status: 404 });
  return caller.organizationId;
}

// Roles a caller may assign. Nobody but a SUPER_ADMIN can mint another
// SUPER_ADMIN, and tenant admins can only hand out roles below their own.
const ASSIGNABLE: Record<string, string[]> = {
  SUPER_ADMIN: ['SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST', 'PATIENT'],
  ORG_ADMIN: ['ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST', 'PATIENT'],
  LOCATION_ADMIN: ['SERVICE_STAFF', 'RECEPTIONIST', 'PATIENT'],
};

export function canAssignRole(callerRole: string, role: string): boolean {
  return (ASSIGNABLE[callerRole] || []).includes(role);
}
