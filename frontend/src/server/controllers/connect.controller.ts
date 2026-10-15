import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/encryption';
import { assertPublicUrl } from '../lib/urlSafety';
import { WEBHOOK_EVENTS } from '../services/webhooks.service';
import { ADMIN_MAPPABLE_TYPES, CONNECT_REF_TYPES } from '../services/externalRefs.service';
import { syncLookupDataSource } from '../services/connectLookup.service';

// Klargy Connect v1 (docs/connect/v1.md): the API another system (an EMR)
// calls with its integration API key. Every handler here runs after
// authenticateIntegration, so req.integration is set.

export const CONTRACT = 'klargy-connect/v1';
/** What an admin may map. Connect calls create the other reference types
 * (patient, visit, encounter) themselves. */
export const MAPPABLE_TYPES = ADMIN_MAPPABLE_TYPES;

const MAX_CATALOG_ITEMS = 5000;
const MAX_TEXT = 200;
const MAX_EMBED_ORIGINS = 10;

/** A refusal sent as `{error, code?, ...extra}`. */
export class ConnectError extends Error {
  constructor(message: string, public status = 400, public code?: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export const badRequest = (message: string) => new ConnectError(message);

export function text(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) throw badRequest(`${field} must be at most ${MAX_TEXT} characters`);
  return trimmed;
}

/** Normalises one catalogue array, keeping only the fields the contract
 * defines. IDs must be unique within their array. */
function catalogList(
  value: unknown,
  name: string,
  pick: (item: Record<string, unknown>, at: string) => Record<string, unknown>
): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${name} must be an array`);
  if (value.length > MAX_CATALOG_ITEMS) throw badRequest(`${name} has more than ${MAX_CATALOG_ITEMS} items`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const at = `${name}[${i}]`;
    if (!raw || typeof raw !== 'object') throw badRequest(`${at} must be an object`);
    const item = pick(raw as Record<string, unknown>, at);
    const id = item.id as string | undefined;
    if (id !== undefined) {
      if (seen.has(id)) throw badRequest(`${at}.id is a duplicate`);
      seen.add(id);
    }
    return item;
  });
}

export function parseCatalog(body: unknown) {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const named = (item: Record<string, unknown>, at: string) => ({
    id: text(item.id, `${at}.id`),
    name: text(item.name, `${at}.name`),
  });
  return {
    locations: catalogList(b.locations, 'locations', named),
    services: catalogList(b.services, 'services', (item, at) => ({
      ...named(item, at),
      locationId: text(item.locationId, `${at}.locationId`, false) ?? null,
      kind: text(item.kind, `${at}.kind`, false) ?? null,
    })),
    servicePoints: catalogList(b.servicePoints, 'servicePoints', (item, at) => ({
      ...named(item, at),
      locationId: text(item.locationId, `${at}.locationId`, false) ?? null,
      kind: text(item.kind, `${at}.kind`, false) ?? null,
    })),
    practitioners: catalogList(b.practitioners, 'practitioners', (item, at) => ({
      ...named(item, at),
      email: text(item.email, `${at}.email`, false)?.toLowerCase() ?? null,
    })),
    registrationFields: catalogList(b.registrationFields, 'registrationFields', (item, at) => ({
      key: text(item.key, `${at}.key`),
      label: text(item.label, `${at}.label`, false) ?? null,
      required: item.required === true,
      type: text(item.type, `${at}.type`, false) ?? 'text',
    })),
  };
}

export type ParsedCatalog = ReturnType<typeof parseCatalog>;

async function embedOriginList(value: unknown): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('embedOrigins must be an array');
  if (value.length > MAX_EMBED_ORIGINS) throw badRequest(`embedOrigins has more than ${MAX_EMBED_ORIGINS} items`);
  return value.map((raw, i) => {
    if (typeof raw !== 'string') throw badRequest(`embedOrigins[${i}] must be a string`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest(`embedOrigins[${i}] is not a valid origin`);
    }
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:')) {
      throw badRequest(`embedOrigins[${i}] must use https`);
    }
    return url.origin;
  });
}

export function handle(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof ConnectError) {
    return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...error.extra });
  }
  const status = (error as { status?: number }).status;
  if (status && status < 500) return res.status(status).json({ error: (error as Error).message });
  next(error);
}

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.integration!.id },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    if (!integration) return res.status(401).json({ error: 'A valid integration API key is required' });
    res.json({
      contract: CONTRACT,
      organization: integration.organization,
      integration: {
        id: integration.id,
        name: integration.name,
        status: integration.status,
        scopes: integration.scopes,
        registered: !!integration.webhookEndpointId,
        catalogPublishedAt: integration.catalogPublishedAt,
      },
    });
  } catch (error) {
    handle(error, res, next);
  }
};

export const registerIntegration = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { system, webhookUrl, lookupUrl, embedOrigins } = req.body || {};
    const url = text(webhookUrl, 'webhookUrl')!;
    await assertPublicUrl(url);
    const lookup = text(lookupUrl, 'lookupUrl', false);
    if (lookup) await assertPublicUrl(lookup);
    const origins = await embedOriginList(embedOrigins);
    const systemName = text(system?.name, 'system.name', false);
    const systemVersion = text(system?.version, 'system.version', false);

    const integration = await prisma.integration.findUnique({
      where: { id: req.integration!.id },
      include: { webhookEndpoint: true },
    });
    if (!integration) return res.status(401).json({ error: 'A valid integration API key is required' });

    const description = `${systemName || integration.name} (EMR connection)`;
    let secret: string;
    let endpointId: string;
    if (integration.webhookEndpoint) {
      // Re-registration keeps the secret, so the other side can always
      // recover it by registering again.
      secret = decrypt(integration.webhookEndpoint.encryptedSecret);
      const updated = await prisma.webhookEndpoint.update({
        where: { id: integration.webhookEndpoint.id },
        data: { url, description, events: [], isActive: true },
      });
      endpointId = updated.id;
    } else {
      secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
      const created = await prisma.webhookEndpoint.create({
        data: {
          organizationId: integration.organizationId,
          url,
          description,
          events: [],
          encryptedSecret: encrypt(secret),
        },
      });
      endpointId = created.id;
    }

    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        webhookEndpointId: endpointId,
        lookupUrl: lookup ?? null,
        embedOrigins: origins,
        systemName: systemName ?? null,
        systemVersion: systemVersion ?? null,
      },
    });
    await syncLookupDataSource(integration.organizationId).catch((e) => console.error('lookup data source sync failed:', e));

    res.json({ integrationId: integration.id, signingSecret: secret, webhookEvents: WEBHOOK_EVENTS });
  } catch (error) {
    handle(error, res, next);
  }
};

export const putCatalog = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const catalog = parseCatalog(req.body);
    await prisma.integration.update({
      where: { id: req.integration!.id },
      data: { catalog: catalog as any, catalogPublishedAt: new Date() },
    });
    res.json({
      received: {
        locations: catalog.locations.length,
        services: catalog.services.length,
        servicePoints: catalog.servicePoints.length,
        practitioners: catalog.practitioners.length,
        registrationFields: catalog.registrationFields.length,
      },
    });
  } catch (error) {
    handle(error, res, next);
  }
};

/** Klargy's own locations, services and service points, each with the
 * external record it's mapped to (or null). Shared with the admin screen. */
export async function klargyCatalog(organizationId: string, integrationId: string) {
  const [locations, services, servicePoints, refs] = await Promise.all([
    prisma.location.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.service.findMany({
      where: { location: { organizationId } },
      select: { id: true, name: true, locationId: true },
      orderBy: { name: 'asc' },
    }),
    prisma.servicePoint.findMany({
      where: { organizationId },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    }),
    prisma.externalReference.findMany({
      where: { integrationId },
      select: { resourceType: true, resourceId: true, externalId: true },
    }),
  ]);
  const ext = (type: string, id: string) =>
    refs.find((r) => r.resourceType === type && r.resourceId === id)?.externalId ?? null;
  return {
    locations: locations.map((l) => ({ ...l, externalId: ext('location', l.id) })),
    services: services.map((s) => ({ ...s, externalId: ext('service', s.id) })),
    servicePoints: servicePoints.map((p) => ({ ...p, externalId: ext('service_point', p.id) })),
  };
}

export const getCatalog = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await klargyCatalog(req.integration!.organizationId, req.integration!.id));
  } catch (error) {
    handle(error, res, next);
  }
};

export const getMappings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The admin's mappings by default; references Connect calls created
    // (patients, visits, encounters) only when asked for by type.
    const type = text(req.query.resourceType, 'resourceType', false);
    if (type && ![...ADMIN_MAPPABLE_TYPES, ...CONNECT_REF_TYPES].includes(type as never)) {
      throw badRequest(`resourceType must be one of: ${[...ADMIN_MAPPABLE_TYPES, ...CONNECT_REF_TYPES].join(', ')}`);
    }
    const refs = await prisma.externalReference.findMany({
      where: { integrationId: req.integration!.id, resourceType: type ?? { in: [...ADMIN_MAPPABLE_TYPES] } },
      select: { resourceType: true, resourceId: true, externalId: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ mappings: refs.map((r) => ({ resourceType: r.resourceType, klargyId: r.resourceId, externalId: r.externalId })) });
  } catch (error) {
    handle(error, res, next);
  }
};
