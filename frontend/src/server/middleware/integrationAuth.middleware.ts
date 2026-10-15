import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { hashApiKey, looksLikeApiKey } from '../lib/apiKeys';
import { getOrganizationFeatures } from './subscription.middleware';

/**
 * Authentication for Klargy Connect (docs/connect/v1.md): another system
 * calling us with an integration API key instead of a staff user's JWT.
 */

export const CONNECT_SCOPES = [
  'integration:write',
  'catalog:read',
  'catalog:write',
  'patients:write',
  'entries:read',
  'entries:write',
  'desk:launch',
  'appointments:write',
  'analytics:read',
] as const;
export type ConnectScope = (typeof CONNECT_SCOPES)[number];

export interface IntegrationCaller {
  id: string;
  organizationId: string;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      integration?: IntegrationCaller;
    }
  }
}

// lastUsedAt is informational; don't write it on every call.
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

export const authenticateIntegration = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!looksLikeApiKey(key)) {
      return res.status(401).json({ error: 'A valid integration API key is required' });
    }

    const integration = await prisma.integration.findUnique({
      where: { keyHash: hashApiKey(key) },
      select: { id: true, organizationId: true, scopes: true, status: true, lastUsedAt: true },
    });
    if (!integration || integration.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'A valid integration API key is required' });
    }

    const features = await getOrganizationFeatures(integration.organizationId);
    if (!features.emrIntegration) {
      return res.status(403).json({ error: 'Your plan does not include EMR connections', feature: 'emrIntegration' });
    }

    if (!integration.lastUsedAt || Date.now() - integration.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      prisma.integration
        .update({ where: { id: integration.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }

    req.integration = { id: integration.id, organizationId: integration.organizationId, scopes: integration.scopes };
    next();
  } catch (error) {
    next(error);
  }
};

export const requireScope = (scope: ConnectScope) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.integration?.scopes.includes(scope)) {
    return res.status(403).json({ error: `This API key lacks the ${scope} scope` });
  }
  next();
};
