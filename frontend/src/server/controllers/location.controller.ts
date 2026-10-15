import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { joinIdentifierFor } from '../services/connectLookup.service';
import { extractSubdomain, extractCustomDomainCandidate } from '../../lib/subdomain';

export const createLocation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.params;
    const { name, address, timezone, publicCode } = req.body;

    const location = await prisma.location.create({
      data: {
        organizationId,
        name,
        address,
        timezone: timezone || 'UTC',
        publicCode: publicCode || null,
      },
    });

    res.status(201).json(location);
  } catch (error) {
    next(error);
  }
};

export const getLocations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.params;

    const locations = await prisma.location.findMany({
      where: { organizationId },
      include: {
        services: true,
        _count: { select: { services: true } },
      },
    });

    res.json(locations);
  } catch (error) {
    next(error);
  }
};

export const getLocation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const location = await prisma.location.findUnique({
      where: { id },
      include: {
        organization: true,
        services: {
          include: {
            practitioners: {
              include: { user: { select: { id: true, firstName: true, lastName: true } } },
            },
          },
        },
      },
    });

    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    res.json(location);
  } catch (error) {
    next(error);
  }
};

export const updateLocation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, address, timezone, publicCode } = req.body;

    const location = await prisma.location.update({
      where: { id },
      data: { name, address, timezone, publicCode },
    });

    res.json(location);
  } catch (error) {
    next(error);
  }
};

export const deleteLocation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await prisma.location.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// Public listing of locations with publicCode for customers
/** Which organization's address this request came in on, if any. */
async function tenantOrgIdFromHost(req: Request): Promise<string | null> {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const slug = extractSubdomain(host);
  if (slug && slug !== 'admin') {
    return (await prisma.organization.findUnique({ where: { slug }, select: { id: true } }))?.id ?? null;
  }
  const domain = extractCustomDomainCandidate(host);
  if (domain) {
    return (await prisma.customDomain.findFirst({ where: { domain, status: 'VERIFIED' }, select: { organizationId: true } }))?.organizationId ?? null;
  }
  return null;
}

// Lists the locations of the organization whose address this is. There is
// no cross-organization directory: on the root domain this is empty.
export const getPublicLocations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await tenantOrgIdFromHost(req);
    if (!organizationId) return res.json([]);
    const locations = await prisma.location.findMany({
      where: { publicCode: { not: null }, organizationId, organization: { status: 'ACTIVE' } },
      select: { id: true, name: true, publicCode: true, organization: { select: { id: true, name: true } }, _count: { select: { services: true } } },
    });

    res.json(locations);
  } catch (error) {
    next(error);
  }
};

// Get location by public code (for public join page)
export const getLocationByCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.params;

    const location = await prisma.location.findUnique({
      where: { publicCode: code },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            identityFieldsConfig: true,  // Include identity fields config for public join form
            logoUrl: true,
            primaryColor: true,
            hidePoweredBy: true, industry: true, customerLabel: true, customerLabelPlural: true,
            status: true,
            joinIdentifierType: true,
          }
        },
        services: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            description: true,
            type: true,
            slotDuration: true,
            startTime: true,
            endTime: true,
            activeDays: true,
          },
        },
      },
    });

    if (!location) {
      return res.status(404).json({ error: 'Location not found or join code is invalid' });
    }

    if (location.organization.status === 'PAUSED') {
      return res.status(403).json({
        error: 'ORGANIZATION_PAUSED',
        message: 'This queue system is temporarily unavailable. Please check back later.',
      });
    }

    // Asked for on the join form only when an EMR connection can check it.
    const { joinIdentifierType, ...organization } = location.organization;
    const required = await joinIdentifierFor({ id: location.organization.id, joinIdentifierType });
    res.json({
      ...location,
      organization,
      joinIdentifier: required ? { type: required.type, label: required.label } : null,
    });
  } catch (error) {
    next(error);
  }
};

// Get public location info by internal ID (for display boards)
export const getPublicLocationInfo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        name: true,
        address: true,
        timezone: true,
        publicCode: true,
        organization: {
          select: { id: true, name: true, logoUrl: true, primaryColor: true, hidePoweredBy: true, industry: true, customerLabel: true, customerLabelPlural: true },
        },
        _count: { select: { services: true } },
      },
    });

    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Count distinct service points, not link rows - a service point linked
    // to multiple services at this location must only count once (mirrors
    // the dedupe in servicepoint.controller.ts's getActiveServicePoints).
    const distinctServicePointLinks = await prisma.servicePointService.findMany({
      where: { isActive: true, service: { locationId } },
      select: { servicePointId: true },
      distinct: ['servicePointId'],
    });
    const servicePointsCount = distinctServicePointLinks.length;

    res.json({
      ...location,
      _count: { ...location._count, servicePoints: servicePointsCount },
    });
  } catch (error) {
    next(error);
  }
};
