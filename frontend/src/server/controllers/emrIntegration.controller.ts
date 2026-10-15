import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { generateApiKey } from '../lib/apiKeys';
import { loadCaller } from '../middleware/tenantScope.middleware';
import { CONNECT_SCOPES } from '../middleware/integrationAuth.middleware';
import { MAPPABLE_TYPES, klargyCatalog } from './connect.controller';
import { syncLookupDataSource } from '../services/connectLookup.service';

// Admin side of EMR connections (Klargy Connect): create an integration and
// its API key, rotate or revoke the key, and map Klargy records to the
// records the other system published in its catalogue.

type MappableType = (typeof MAPPABLE_TYPES)[number];

// Which catalogue array holds the external records for each mappable type.
const CATALOG_KEY: Record<MappableType, string> = {
  location: 'locations',
  service: 'services',
  service_point: 'servicePoints',
  staff: 'practitioners',
};

const publicIntegration = (i: {
  id: string;
  name: string;
  kind: string;
  status: string;
  keyPrefix: string;
  systemName: string | null;
  systemVersion: string | null;
  webhookEndpointId: string | null;
  embedOrigins: string[];
  catalogPublishedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) => ({
  id: i.id,
  name: i.name,
  kind: i.kind,
  status: i.status,
  keyPrefix: i.keyPrefix,
  systemName: i.systemName,
  systemVersion: i.systemVersion,
  registered: !!i.webhookEndpointId,
  embedOrigins: i.embedOrigins,
  catalogPublishedAt: i.catalogPublishedAt,
  lastUsedAt: i.lastUsedAt,
  createdAt: i.createdAt,
});

export const listIntegrations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.integration.findMany({
      where: { organizationId: req.params.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(list.map(publicIntegration));
  } catch (error) {
    next(error);
  }
};

export const createIntegration = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be at most 100 characters' });
    const caller = await loadCaller(req);
    const { key, hash, prefix } = generateApiKey();
    const integration = await prisma.integration.create({
      data: {
        organizationId: req.params.organizationId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: [...CONNECT_SCOPES],
        embedOrigins: [],
        createdById: caller?.id ?? null,
      },
    });
    // The API key is only ever shown once, here (and on rotate).
    res.status(201).json({ ...publicIntegration(integration), apiKey: key });
  } catch (error) {
    next(error);
  }
};

export const getIntegration = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    const [klargy, staffRefs, staff] = await Promise.all([
      klargyCatalog(integration.organizationId, integration.id),
      prisma.externalReference.findMany({
        where: { integrationId: integration.id, resourceType: 'staff' },
        select: { resourceId: true, externalId: true },
      }),
      prisma.user.findMany({
        where: { organizationId: integration.organizationId, isActive: true, role: { not: 'PATIENT' } },
        select: { id: true, firstName: true, lastName: true, email: true },
        orderBy: { firstName: 'asc' },
      }),
    ]);
    res.json({
      ...publicIntegration(integration),
      externalCatalog: integration.catalog ?? null,
      klargy: {
        ...klargy,
        staff: staff.map((u) => ({
          id: u.id,
          name: `${u.firstName} ${u.lastName}`.trim(),
          email: u.email,
          externalId: staffRefs.find((r) => r.resourceId === u.id)?.externalId ?? null,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const rotateIntegrationKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key, hash, prefix } = generateApiKey();
    const integration = await prisma.integration.update({
      where: { id: req.params.id },
      data: { keyHash: hash, keyPrefix: prefix, status: 'ACTIVE' },
    });
    await syncLookupDataSource(integration.organizationId).catch((e) => console.error('lookup data source sync failed:', e));
    res.json({ ...publicIntegration(integration), apiKey: key });
  } catch (error) {
    next(error);
  }
};

/** Revoking stops the key working and stops events to the other system.
 * Mappings are kept, so a rotated key picks up where it left off. */
export const revokeIntegration = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = await prisma.integration.update({
      where: { id: req.params.id },
      data: { status: 'REVOKED' },
    });
    if (integration.webhookEndpointId) {
      await prisma.webhookEndpoint.update({ where: { id: integration.webhookEndpointId }, data: { isActive: false } });
    }
    await syncLookupDataSource(integration.organizationId).catch((e) => console.error('lookup data source sync failed:', e));
    res.json(publicIntegration(integration));
  } catch (error) {
    next(error);
  }
};

async function klargyRecordInOrg(type: MappableType, id: string, organizationId: string): Promise<boolean> {
  switch (type) {
    case 'location':
      return !!(await prisma.location.findFirst({ where: { id, organizationId }, select: { id: true } }));
    case 'service':
      return !!(await prisma.service.findFirst({ where: { id, location: { organizationId } }, select: { id: true } }));
    case 'service_point':
      return !!(await prisma.servicePoint.findFirst({ where: { id, organizationId }, select: { id: true } }));
    case 'staff':
      return !!(await prisma.user.findFirst({
        where: { id, organizationId, role: { not: 'PATIENT' } },
        select: { id: true },
      }));
  }
}

/** PUT body: {resourceType, resourceId, externalId}; externalId null unmaps. */
export const setMapping = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { resourceType, resourceId, externalId } = req.body || {};
    if (!MAPPABLE_TYPES.includes(resourceType)) {
      return res.status(400).json({ error: `resourceType must be one of: ${MAPPABLE_TYPES.join(', ')}` });
    }
    if (typeof resourceId !== 'string' || !resourceId) return res.status(400).json({ error: 'resourceId is required' });
    if (externalId !== null && (typeof externalId !== 'string' || !externalId)) {
      return res.status(400).json({ error: 'externalId must be a string, or null to remove the mapping' });
    }

    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    const type = resourceType as MappableType;
    if (!(await klargyRecordInOrg(type, resourceId, integration.organizationId))) {
      return res.status(404).json({ error: 'That record was not found' });
    }

    const key = { integrationId: integration.id, resourceType: type, resourceId };
    if (externalId === null) {
      await prisma.externalReference.deleteMany({ where: key });
      return res.json({ resourceType: type, klargyId: resourceId, externalId: null });
    }

    const published = ((integration.catalog as Record<string, { id?: string }[]> | null)?.[CATALOG_KEY[type]]) ?? [];
    if (!published.some((item) => item?.id === externalId)) {
      return res.status(400).json({ error: 'That record is not in the catalogue the other system published' });
    }

    const taken = await prisma.externalReference.findFirst({
      where: { integrationId: integration.id, resourceType: type, externalId, NOT: { resourceId } },
      select: { id: true },
    });
    if (taken) return res.status(409).json({ error: 'That record is already matched to something else' });

    await prisma.externalReference.upsert({
      where: { integrationId_resourceType_resourceId: key },
      create: { ...key, organizationId: integration.organizationId, externalId },
      update: { externalId },
    });
    res.json({ resourceType: type, klargyId: resourceId, externalId });
  } catch (error) {
    next(error);
  }
};
