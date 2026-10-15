import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { checkLimit } from '../middleware/subscription.middleware';
import { syncInstancesForServicePointService } from './servicepoint.controller';

export const createService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      description,
      type,
      slotDuration,
      concurrentLimit,
      activeDays,
      startTime,
      endTime,
      requiresName,
      requiresPhone,
      allowAnonymous,
      displayMode,
      isActive,
      requiresClearance,
      locationIds,
      servicePoints,
    } = req.body;

    if (!Array.isArray(locationIds) || locationIds.length === 0) {
      return res.status(400).json({ error: 'At least one locationId is required' });
    }

    // Resolve the caller's own organization - never trust the org implied by
    // caller-controlled locationIds/servicePointIds for authorization or limit checks.
    const callerUserId = (req as any).user?.userId;
    if (!callerUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const callerUser = await prisma.user.findUnique({ where: { id: callerUserId }, select: { organizationId: true } });
    if (!callerUser?.organizationId) {
      return res.status(403).json({ error: 'User is not associated with an organization' });
    }
    const organizationId = callerUser.organizationId;

    // Verify every requested location belongs to the caller's own organization.
    const locations = await prisma.location.findMany({ where: { id: { in: locationIds }, organizationId } });
    if (locations.length !== locationIds.length) {
      return res.status(404).json({ error: 'One or more locations not found in your organization' });
    }

    if (servicePoints && Array.isArray(servicePoints) && servicePoints.length > 0) {
      const spIds = servicePoints.map((sp: { servicePointId: string }) => sp.servicePointId);
      const ownedServicePoints = await prisma.servicePoint.findMany({
        where: { id: { in: spIds }, organizationId },
        select: { id: true },
      });
      if (ownedServicePoints.length !== new Set(spIds).size) {
        return res.status(404).json({ error: 'One or more service points not found in your organization' });
      }
    }

    const { current, limit } = await checkLimit(organizationId, 'services');
    // 'services' never resolves to a null limit (only queueEntriesDaily/
    // queueEntriesPeriod can be unlimited) - checkLimit's return type is
    // shared across all limit types, hence the assertion.
    if (current + locationIds.length > (limit as number)) {
      return res.status(403).json({
        error: 'Limit reached',
        message: `Creating ${locationIds.length} service(s) would exceed your plan's limit of ${limit} services (currently at ${current}).`,
        limitType: 'services',
        current,
        limit,
        upgradeRequired: true,
      });
    }

    if (servicePoints && Array.isArray(servicePoints)) {
      for (const sp of servicePoints) {
        if (!sp.servicePointId || !sp.capacity || sp.capacity < 1) {
          return res.status(400).json({ error: 'Each service point assignment needs a servicePointId and a capacity of at least 1' });
        }
      }
    }

    const createdServices = await prisma.$transaction(async (tx) => {
      const results: Awaited<ReturnType<typeof tx.service.create>>[] = [];
      for (const locationId of locationIds) {
        const service = await tx.service.create({
          data: {
            locationId,
            name,
            description,
            type: type || 'GENERAL',
            slotDuration: slotDuration || 15,
            concurrentLimit: concurrentLimit || 1,
            activeDays: activeDays || '1,2,3,4,5',
            startTime: startTime || '09:00',
            endTime: endTime || '17:00',
            requiresName: requiresName ?? true,
            requiresPhone: requiresPhone ?? false,
            allowAnonymous: allowAnonymous ?? false,
            displayMode: displayMode || null,
            isActive: isActive ?? true,
            requiresClearance: requiresClearance === true,
          },
        });

        if (servicePoints && Array.isArray(servicePoints)) {
          for (const sp of servicePoints) {
            await tx.servicePointService.create({
              data: { servicePointId: sp.servicePointId, serviceId: service.id, capacity: sp.capacity },
            });
          }
        }

        results.push(service);
      }
      return results;
    });

    // Instance sync happens outside the transaction (it's not itself
    // transactional business logic, just desk-row bookkeeping).
    if (servicePoints && Array.isArray(servicePoints)) {
      for (const service of createdServices) {
        const links = await prisma.servicePointService.findMany({ where: { serviceId: service.id } });
        for (const link of links) {
          await syncInstancesForServicePointService(link.id);
        }
      }
    }

    res.status(201).json({ services: createdServices });
  } catch (error) {
    next(error);
  }
};

export const getServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    const services = await prisma.service.findMany({
      where: { locationId, isActive: true },
      include: {
        practitioners: {
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
        _count: { select: { queues: true, appointments: true } },
      },
    });

    res.json(services);
  } catch (error) {
    next(error);
  }
};

export const getService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const service = await prisma.service.findUnique({
      where: { id },
      include: {
        location: true,
        practitioners: {
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        },
        flowsFrom: { include: { toService: true } },
        flowsTo: { include: { fromService: true } },
      },
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(service);
  } catch (error) {
    next(error);
  }
};

export const getServiceSchedule = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const service = await prisma.service.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slotDuration: true,
        concurrentLimit: true,
        activeDays: true,
        startTime: true,
        endTime: true,
      },
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(service);
  } catch (error) {
    next(error);
  }
};

export const updateService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { servicePoints } = req.body;
    // Only these fields are editable here - spreading the raw body would let a
    // caller repoint locationId at another org's location.
    const UPDATABLE = [
      'name', 'description', 'type', 'slotDuration', 'concurrentLimit', 'activeDays', 'startTime',
      'endTime', 'requiresName', 'requiresPhone', 'allowAnonymous', 'displayMode', 'isActive', 'requiresClearance',
    ];
    const updates: Record<string, unknown> = {};
    for (const key of UPDATABLE) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Validate the servicePoints payload BEFORE writing anything, so a bad
    // request never commits the service's other field changes first.
    if (servicePoints && Array.isArray(servicePoints)) {
      for (const sp of servicePoints) {
        if (!sp.servicePointId || !sp.capacity || sp.capacity < 1) {
          return res.status(400).json({ error: 'Each service point assignment needs a servicePointId and a capacity of at least 1' });
        }
      }
    }

    if (servicePoints && Array.isArray(servicePoints) && servicePoints.length > 0) {
      const owner = await prisma.service.findUnique({
        where: { id },
        select: { location: { select: { organizationId: true } } },
      });
      const spIds: string[] = servicePoints.map((sp: { servicePointId: string }) => sp.servicePointId);
      const owned = await prisma.servicePoint.count({
        where: { id: { in: spIds }, organizationId: owner?.location.organizationId },
      });
      if (!owner || owned !== new Set(spIds).size) {
        return res.status(404).json({ error: 'One or more service points not found in your organization' });
      }
    }

    const service = await prisma.service.update({
      where: { id },
      data: updates,
    });

    if (servicePoints && Array.isArray(servicePoints)) {
      // Fetch ALL links (active or not) - a previously-deactivated link must be found
      // and reactivated here, not recreated, or it collides with the unique constraint
      // on (servicePointId, serviceId).
      const existingLinks = await prisma.servicePointService.findMany({
        where: { serviceId: id },
      });

      const requestedIds = new Set(servicePoints.map((sp: { servicePointId: string }) => sp.servicePointId));

      // Deactivate links that are no longer selected (skip already-inactive ones)
      for (const link of existingLinks) {
        if (link.isActive && !requestedIds.has(link.servicePointId)) {
          await prisma.servicePointService.update({
            where: { id: link.id },
            data: { isActive: false, isOccupied: false, activatedByUserId: null, activatedAt: null },
          });
        }
      }

      // Create or update the requested links
      for (const sp of servicePoints) {
        const existing = existingLinks.find((l: typeof existingLinks[number]) => l.servicePointId === sp.servicePointId);
        let linkId: string;
        if (existing) {
          await prisma.servicePointService.update({
            where: { id: existing.id },
            data: { isActive: true, capacity: sp.capacity },
          });
          linkId = existing.id;
        } else {
          const created = await prisma.servicePointService.create({
            data: { servicePointId: sp.servicePointId, serviceId: id, capacity: sp.capacity },
          });
          linkId = created.id;
        }
        await syncInstancesForServicePointService(linkId);
      }
    }

    res.json(service);
  } catch (error) {
    next(error);
  }
};

export const deleteService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await prisma.service.update({
      where: { id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// Service Flow management
export const createServiceFlow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fromServiceId, toServiceId, condition, autoTransfer } = req.body;

    const flow = await prisma.serviceFlow.create({
      data: {
        fromServiceId,
        toServiceId,
        condition,
        autoTransfer: autoTransfer || false,
      },
      include: {
        fromService: true,
        toService: true,
      },
    });

    res.status(201).json(flow);
  } catch (error) {
    next(error);
  }
};

export const getServiceFlows = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;

    const flows = await prisma.serviceFlow.findMany({
      where: {
        OR: [{ fromServiceId: serviceId }, { toServiceId: serviceId }],
      },
      include: {
        fromService: true,
        toService: true,
      },
    });

    res.json(flows);
  } catch (error) {
    next(error);
  }
};

// Public endpoint: Get services for a location (for public kiosk/tablet view)
export const getPublicLocationServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, locationId } = req.params;

    // Verify location belongs to organization
    const location = await prisma.location.findFirst({
      where: {
        id: locationId,
        organizationId: orgId,
      },
      include: {
        organization: {
          select: { id: true, name: true },
        },
      },
    });

    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Get active services with queue requirements
    const services = await prisma.service.findMany({
      where: {
        locationId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        slotDuration: true,
        startTime: true,
        endTime: true,
        requiresName: true,
        requiresPhone: true,
        allowAnonymous: true,
      },
      orderBy: { name: 'asc' },
    });

    res.json({
      location: {
        id: location.id,
        name: location.name,
        address: location.address,
      },
      organization: location.organization,
      services,
    });
  } catch (error) {
    next(error);
  }
};
