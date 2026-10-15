import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { screenName } from '../lib/screenName';
import { recordServicePointEvent } from '../services/servicePointEvents.service';

// Ensure a service-point-to-service assignment has exactly `capacity` active
// ServicePointInstance rows. Creates missing instances and deactivates
// (never deletes) excess ones. Exported so service.controller.ts's bulk
// service creation (Task 6) can reuse it without duplicating the logic.
export async function syncInstancesForServicePointService(servicePointServiceId: string) {
  const link = await prisma.servicePointService.findUnique({
    where: { id: servicePointServiceId },
    include: { instances: true, servicePoint: true },
  });

  if (!link) return;

  const currentCount = link.instances.length;
  const targetCount = link.capacity;

  if (currentCount < targetCount) {
    for (let i = currentCount + 1; i <= targetCount; i++) {
      await prisma.servicePointInstance.create({
        data: {
          servicePointServiceId,
          instanceNumber: i,
          displayName: `${link.servicePoint.displayName || link.servicePoint.name} ${i}`,
          isActive: link.isActive,
        },
      });
    }
  }

  if (currentCount > targetCount) {
    await prisma.servicePointInstance.updateMany({
      where: { servicePointServiceId, instanceNumber: { gt: targetCount } },
      data: { isActive: false },
    });
  }

  await prisma.servicePointInstance.updateMany({
    where: { servicePointServiceId, instanceNumber: { lte: targetCount } },
    data: { isActive: link.isActive },
  });
}

// Get all service point definitions for an organization
export const getServicePoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.params;

    const servicePoints = await prisma.servicePoint.findMany({
      where: { organizationId },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: {
        services: {
          where: { isActive: true },
          select: { serviceId: true },
        },
      },
    });

    res.json(servicePoints.map((sp: typeof servicePoints[number]) => ({
      id: sp.id,
      organizationId: sp.organizationId,
      name: sp.name,
      displayName: sp.displayName,
      type: sp.type,
      isActive: sp.isActive,
      capacity: sp.capacity,
      usedInServicesCount: sp.services.length,
    })));
  } catch (error) {
    next(error);
  }
};

// Get a single service point definition, with its current service assignments
export const getServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const servicePoint = await prisma.servicePoint.findUnique({
      where: { id },
      include: {
        organization: { select: { id: true, name: true } },
        services: {
          where: { isActive: true },
          include: { service: { select: { id: true, name: true, locationId: true } } },
        },
      },
    });

    if (!servicePoint) {
      return res.status(404).json({ error: 'Service point not found' });
    }

    res.json(servicePoint);
  } catch (error) {
    next(error);
  }
};

// Create a service point definition
export const createServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId, name, displayName, type, capacity } = req.body;

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const servicePoint = await prisma.servicePoint.create({
      data: {
        organizationId,
        name,
        displayName: displayName || name,
        type: type || 'OTHER',
        capacity: capacity || 1,
      },
    });

    res.status(201).json(servicePoint);
  } catch (error) {
    next(error);
  }
};

// Update a service point definition
export const updateServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, displayName, type, capacity, isActive } = req.body;

    const servicePoint = await prisma.servicePoint.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(displayName !== undefined && { displayName }),
        ...(type !== undefined && { type }),
        ...(capacity !== undefined && { capacity }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    res.json(servicePoint);
  } catch (error) {
    next(error);
  }
};

// Delete a service point definition
export const deleteServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const activeLinks = await prisma.servicePointService.count({
      where: { servicePointId: id, isActive: true },
    });

    if (activeLinks > 0) {
      return res.status(400).json({
        error: `This service point is still assigned to ${activeLinks} service${activeLinks > 1 ? 's' : ''}. Remove it from those services first.`,
      });
    }

    await prisma.servicePoint.delete({ where: { id } });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Get active service points with current status, scoped by location via
// the services assigned there (ServicePoint itself is org-level now).
export const getActiveServicePoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    const location = await prisma.location.findUnique({
      where: { id: locationId },
      include: { organization: { select: { defaultDisplayMode: true } } },
    });

    const orgDefaultDisplayMode = location?.organization?.defaultDisplayMode || 'TICKET_ONLY';

    const links = await prisma.servicePointService.findMany({
      where: {
        isActive: true,
        servicePoint: { isActive: true },
        service: { locationId, isActive: true },
      },
      include: {
        servicePoint: true,
        service: { select: { name: true, displayMode: true } },
        instances: {
          where: { isActive: true },
          include: {
            servingEntries: {
              where: { status: 'SERVING' },
              include: { user: { select: { firstName: true, lastName: true } } },
            },
          },
          orderBy: { instanceNumber: 'asc' },
        },
      },
      orderBy: [{ servicePoint: { type: 'asc' } }, { servicePoint: { name: 'asc' } }],
    });

    const displayData = links.map((link: typeof links[number]) => {
      const servingInstance = link.instances.find((i: typeof link.instances[number]) => i.servingEntries.length > 0);
      const entry = servingInstance?.servingEntries[0];
      const displayMode = link.service.displayMode || orgDefaultDisplayMode;

      return {
        id: link.servicePoint.id,
        name: link.servicePoint.name,
        displayName: link.servicePoint.displayName || link.servicePoint.name,
        type: link.servicePoint.type,
        displayMode,
        currentlyServing: entry ? {
          ticketNumber: entry.ticketNumber,
          customerName: screenName(displayMode, entry.user.firstName, entry.user.lastName),
          serviceName: link.service.name,
        } : null,
      };
    });

    // A service point linked to multiple services at this location produces
    // one link-row (and thus one entry above) per service. Dedupe by service
    // point id before responding, preferring an entry that's currently
    // serving someone if any of its links has one.
    const dedupedById = new Map<string, typeof displayData[number]>();
    for (const entry of displayData) {
      const existing = dedupedById.get(entry.id);
      if (!existing || (!existing.currentlyServing && entry.currentlyServing)) {
        dedupedById.set(entry.id, entry);
      }
    }

    res.json(Array.from(dedupedById.values()));
  } catch (error) {
    next(error);
  }
};

// Get service points linked to a specific service
export const getServicePointsForService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;

    const links = await prisma.servicePointService.findMany({
      where: { serviceId, isActive: true, servicePoint: { isActive: true } },
      include: {
        servicePoint: true,
        activatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { servicePoint: { name: 'asc' } },
    });

    const servicePoints = links.map((link: typeof links[number]) => ({
      id: link.servicePoint.id,
      name: link.servicePoint.name,
      displayName: link.servicePoint.displayName,
      type: link.servicePoint.type,
      capacity: link.capacity,
      isOccupied: link.isOccupied,
      activatedBy: link.activatedBy,
      activatedAt: link.activatedAt,
      linkId: link.id,
    }));

    res.json(servicePoints);
  } catch (error) {
    next(error);
  }
};

// Link a service point to a service with a desk count
export const linkServicePointToService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { servicePointId, serviceId, capacity } = req.body;

    if (!capacity || capacity < 1) {
      return res.status(400).json({ error: 'capacity is required and must be at least 1' });
    }

    const existing = await prisma.servicePointService.findUnique({
      where: { servicePointId_serviceId: { servicePointId, serviceId } },
    });

    let link;
    if (existing) {
      link = await prisma.servicePointService.update({
        where: { id: existing.id },
        data: { isActive: true, capacity },
      });
    } else {
      link = await prisma.servicePointService.create({
        data: { servicePointId, serviceId, capacity },
      });
    }

    await syncInstancesForServicePointService(link.id);

    res.status(existing ? 200 : 201).json(link);
  } catch (error) {
    next(error);
  }
};

// Unlink a service point from a service
export const unlinkServicePointFromService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { servicePointId, serviceId } = req.body;

    await prisma.servicePointService.updateMany({
      where: { servicePointId, serviceId },
      data: { isActive: false, isOccupied: false, activatedByUserId: null, activatedAt: null }
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Activate (occupy) a service point for a service - operator "sits down"
export const activateServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { servicePointId, serviceId } = req.body;
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check if link exists and is active
    const link = await prisma.servicePointService.findUnique({
      where: { servicePointId_serviceId: { servicePointId, serviceId } }
    });

    if (!link || !link.isActive) {
      return res.status(400).json({ 
        error: 'Service point is not linked to this service. Please link it first in admin settings.' 
      });
    }

    // Check if already occupied by someone else
    if (link.isOccupied && link.activatedByUserId !== userId) {
      const occupier = await prisma.user.findUnique({
        where: { id: link.activatedByUserId! },
        select: { firstName: true, lastName: true }
      });
      return res.status(400).json({ 
        error: `This service point is already occupied by ${occupier?.firstName} ${occupier?.lastName}` 
      });
    }

    // Vacate any other service points the user might be occupying for this service
    await prisma.servicePointService.updateMany({
      where: { 
        serviceId,
        activatedByUserId: userId,
        id: { not: link.id }
      },
      data: { isOccupied: false, activatedByUserId: null, activatedAt: null }
    });

    // Activate this service point
    const updated = await prisma.servicePointService.update({
      where: { id: link.id },
      data: {
        isOccupied: true,
        activatedByUserId: userId,
        activatedAt: new Date()
      },
      include: {
        servicePoint: true,
        activatedBy: { select: { id: true, firstName: true, lastName: true } }
      }
    });

    res.json({
      success: true,
      servicePoint: {
        id: updated.servicePoint.id,
        name: updated.servicePoint.name,
        displayName: updated.servicePoint.displayName,
        isOccupied: updated.isOccupied,
        activatedBy: updated.activatedBy,
        activatedAt: updated.activatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// Vacate (deactivate) a service point - operator "leaves"
export const vacateServicePoint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { servicePointId, serviceId } = req.body;
    const userId = (req as any).user?.userId;

    const link = await prisma.servicePointService.findUnique({
      where: { servicePointId_serviceId: { servicePointId, serviceId } }
    });

    if (!link) {
      return res.status(404).json({ error: 'Service point link not found' });
    }

    // Only the user who activated it or an admin can vacate
    // For now, we allow anyone to vacate
    await prisma.servicePointService.update({
      where: { id: link.id },
      data: {
        isOccupied: false,
        activatedByUserId: null,
        activatedAt: null
      }
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Get all occupied service points for a location (for display)
export const getOccupiedServicePoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    const occupied = await prisma.servicePointService.findMany({
      where: {
        isOccupied: true,
        isActive: true,
        service: { locationId },
        servicePoint: { isActive: true },
      },
      include: {
        servicePoint: true,
        service: { select: { id: true, name: true } },
        activatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.json(occupied.map((link: typeof occupied[number]) => ({
      servicePointId: link.servicePoint.id,
      servicePointName: link.servicePoint.displayName || link.servicePoint.name,
      serviceId: link.service.id,
      serviceName: link.service.name,
      activatedBy: link.activatedBy,
      activatedAt: link.activatedAt,
    })));
  } catch (error) {
    next(error);
  }
};

// Update a service point link's desk count
export const updateServicePointLink = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { linkId } = req.params;
    const { capacity } = req.body;

    if (capacity === undefined || capacity < 1) {
      return res.status(400).json({ error: 'capacity must be at least 1' });
    }

    const updated = await prisma.servicePointService.update({
      where: { id: linkId },
      data: { capacity },
      include: {
        servicePoint: true,
        activatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    await syncInstancesForServicePointService(linkId);

    res.json({
      id: updated.servicePoint.id,
      name: updated.servicePoint.name,
      displayName: updated.servicePoint.displayName,
      type: updated.servicePoint.type,
      capacity: updated.capacity,
      isOccupied: updated.isOccupied,
      activatedBy: updated.activatedBy,
      activatedAt: updated.activatedAt,
      linkId: updated.id,
    });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// Service Point Instances
// ==========================================

// Get all instances for a service point definition, across every service it's assigned to
export const getServicePointInstances = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { servicePointId } = req.params;

    const instances = await prisma.servicePointInstance.findMany({
      where: { servicePointService: { servicePointId } },
      include: {
        occupiedBy: { select: { id: true, firstName: true, lastName: true } },
        servicePointService: { include: { service: { select: { id: true, name: true } } } },
      },
      orderBy: [{ servicePointServiceId: 'asc' }, { instanceNumber: 'asc' }],
    });

    res.json(instances);
  } catch (error) {
    next(error);
  }
};

// Activate an instance (operator claims a desk instance)
export const activateServicePointInstance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const instance = await prisma.servicePointInstance.findUnique({
      where: { id: instanceId },
      include: { servicePointService: { include: { servicePoint: true } } },
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    if (!instance.isActive) {
      return res.status(400).json({ error: 'Instance is not active' });
    }

    if (!instance.servicePointService.servicePoint.isActive || !instance.servicePointService.isActive) {
      return res.status(400).json({ error: 'Service point is not active' });
    }

    // Re-entering your own desk (after a refresh) is fine. Someone else's
    // needs an explicit take-over, since desks left open would otherwise
    // stay locked forever.
    if (instance.isOccupied && instance.occupiedByUserId !== userId && !req.body?.takeOver) {
      const holder = instance.occupiedByUserId
        ? await prisma.user.findUnique({ where: { id: instance.occupiedByUserId }, select: { firstName: true, lastName: true } })
        : null;
      return res.status(409).json({
        error: holder ? `${holder.firstName} ${holder.lastName} is signed in to this desk.` : 'Someone is signed in to this desk.',
        occupied: true,
      });
    }

    const updated = await prisma.servicePointInstance.update({
      where: { id: instanceId },
      data: {
        isOccupied: true,
        occupiedByUserId: userId,
        occupiedAt: new Date(),
      },
      include: {
        occupiedBy: { select: { id: true, firstName: true, lastName: true } },
        servicePointService: {
          include: {
            servicePoint: true,
            service: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Re-entering your own desk changes nothing; taking over someone's
    // desk closes it for them first.
    if (!(instance.isOccupied && instance.occupiedByUserId === userId)) {
      if (instance.isOccupied && instance.occupiedByUserId) {
        await recordServicePointEvent('closed', instance.id, instance.occupiedByUserId, userId);
      }
      await recordServicePointEvent('opened', instance.id, userId, userId);
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

// Vacate an instance (operator releases a desk instance)
export const vacateServicePointInstance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { instanceId } = req.params;
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const instance = await prisma.servicePointInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const isAdmin = ['SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'].includes(user?.role || '');
    if (instance.occupiedByUserId !== userId && !isAdmin) {
      return res.status(403).json({ error: 'You can only vacate your own instance' });
    }

    const updated = await prisma.servicePointInstance.update({
      where: { id: instanceId },
      data: {
        isOccupied: false,
        occupiedByUserId: null,
        occupiedAt: null,
      },
    });

    if (instance.isOccupied && instance.occupiedByUserId) {
      await recordServicePointEvent('closed', instance.id, instance.occupiedByUserId, userId);
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

// Get all instances for a location (for display board), scoped via each
// instance's service, since ServicePoint itself is org-level now.
export const getLocationInstances = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    const instances = await prisma.servicePointInstance.findMany({
      where: {
        isActive: true,
        servicePointService: {
          isActive: true,
          service: { locationId, isActive: true },
          servicePoint: { isActive: true },
        },
      },
      include: {
        servicePointService: {
          include: {
            servicePoint: true,
            service: { select: { id: true, name: true, displayMode: true } },
          },
        },
        occupiedBy: { select: { id: true, firstName: true, lastName: true } },
        servingEntries: {
          where: { status: 'SERVING' },
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
      orderBy: [
        { servicePointService: { servicePoint: { type: 'asc' } } },
        { servicePointService: { servicePoint: { name: 'asc' } } },
        { instanceNumber: 'asc' },
      ],
    });

    const location = await prisma.location.findUnique({
      where: { id: locationId },
      include: { organization: { select: { defaultDisplayMode: true } } },
    });

    const orgDefaultDisplayMode = location?.organization?.defaultDisplayMode || 'TICKET_ONLY';

    const displayData = instances.map((inst: typeof instances[number]) => {
      const entry = inst.servingEntries[0];
      const service = inst.servicePointService.service;
      const displayMode = service?.displayMode || orgDefaultDisplayMode;

      return {
        id: inst.id,
        servicePointId: inst.servicePointService.servicePoint.id,
        instanceNumber: inst.instanceNumber,
        displayName: inst.displayName,
        servicePointType: inst.servicePointService.servicePoint.type,
        servicePointName: inst.servicePointService.servicePoint.displayName || inst.servicePointService.servicePoint.name,
        servicePointCapacity: inst.servicePointService.capacity,
        displayMode,
        isOccupied: inst.isOccupied,
        currentService: service ? { id: service.id, name: service.name } : null,
        occupiedBy: inst.occupiedBy,
        currentlyServing: entry ? {
          ticketNumber: entry.ticketNumber,
          customerName: `${entry.user.firstName} ${entry.user.lastName}`,
        } : null,
      };
    });

    res.json(displayData);
  } catch (error) {
    next(error);
  }
};

// Toggle instance active state (admin only)
export const toggleInstanceActive = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { instanceId } = req.params;
    const { isActive } = req.body;

    const instance = await prisma.servicePointInstance.findUnique({
      where: { id: instanceId },
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const updated = await prisma.servicePointInstance.update({
      where: { id: instanceId },
      data: {
        isActive,
        ...(isActive === false ? {
          isOccupied: false,
          occupiedByUserId: null,
          occupiedAt: null,
        } : {}),
      },
    });

    if (isActive === false && instance.isOccupied && instance.occupiedByUserId) {
      await recordServicePointEvent('closed', instance.id, instance.occupiedByUserId, (req as any).user?.userId ?? null);
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

// Get instances by service (for operator's desk selection)
export const getServiceInstances = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;

    const links = await prisma.servicePointService.findMany({
      where: { serviceId, isActive: true, servicePoint: { isActive: true } },
      include: {
        servicePoint: true,
        instances: {
          where: { isActive: true },
          include: { occupiedBy: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { instanceNumber: 'asc' },
        },
      },
    });

    const instances = links.flatMap((link: typeof links[number]) =>
      link.instances.map((inst: typeof link.instances[number]) => ({
        id: inst.id,
        servicePointId: link.servicePoint.id,
        servicePointName: link.servicePoint.displayName || link.servicePoint.name,
        instanceNumber: inst.instanceNumber,
        displayName: inst.displayName,
        isOccupied: inst.isOccupied,
        occupiedBy: inst.occupiedBy,
      }))
    );

    res.json(instances);
  } catch (error) {
    next(error);
  }
};
