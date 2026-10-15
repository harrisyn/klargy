import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { FLOW_TEMPLATES, TemplateError, applyFlowTemplate } from '../services/flowTemplates.service';

// Get all service flows for a location's services
export const getLocationFlows = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { locationId } = req.params;

    // Get all services for this location
    const services = await prisma.service.findMany({
      where: { locationId },
      include: {
        flowsFrom: {
          include: {
            toService: {
              select: { id: true, name: true, type: true },
            },
          },
          orderBy: { priority: 'asc' },
        },
        flowsTo: {
          include: {
            fromService: {
              select: { id: true, name: true, type: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    res.json(services);
  } catch (error) {
    next(error);
  }
};

// Get flows for a specific service
export const getServiceFlows = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;

    const flows = await prisma.serviceFlow.findMany({
      where: {
        OR: [
          { fromServiceId: serviceId },
          { toServiceId: serviceId },
        ],
      },
      include: {
        fromService: {
          select: { id: true, name: true, type: true },
        },
        toService: {
          select: { id: true, name: true, type: true },
        },
      },
      orderBy: { priority: 'asc' },
    });

    const outgoing = flows.filter(f => f.fromServiceId === serviceId);
    const incoming = flows.filter(f => f.toServiceId === serviceId);

    res.json({ outgoing, incoming });
  } catch (error) {
    next(error);
  }
};

// Create a service flow
export const createServiceFlow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fromServiceId, toServiceId, priority, displayName, condition, autoTransfer, isRequired } = req.body;

    // Verify both services exist and are in the same location
    const [fromService, toService] = await Promise.all([
      prisma.service.findUnique({ where: { id: fromServiceId } }),
      prisma.service.findUnique({ where: { id: toServiceId } }),
    ]);

    if (!fromService || !toService) {
      return res.status(404).json({ error: 'One or both services not found' });
    }

    if (fromService.locationId !== toService.locationId) {
      return res.status(400).json({ error: 'Services must be in the same location' });
    }

    // Check if flow already exists
    const existingFlow = await prisma.serviceFlow.findUnique({
      where: {
        fromServiceId_toServiceId: {
          fromServiceId,
          toServiceId,
        },
      },
    });

    if (existingFlow) {
      return res.status(400).json({ error: 'Flow between these services already exists' });
    }

    const flow = await prisma.serviceFlow.create({
      data: {
        fromServiceId,
        toServiceId,
        priority: priority || 0,
        displayName: displayName || null,
        condition: condition || null,
        autoTransfer: autoTransfer || false,
        isRequired: isRequired || false,
      },
      include: {
        fromService: {
          select: { id: true, name: true, type: true },
        },
        toService: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    res.status(201).json(flow);
  } catch (error) {
    next(error);
  }
};

// Update a service flow
export const updateServiceFlow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { priority, displayName, condition, autoTransfer, isRequired } = req.body;

    const flow = await prisma.serviceFlow.update({
      where: { id },
      data: {
        ...(priority !== undefined && { priority }),
        ...(displayName !== undefined && { displayName }),
        ...(condition !== undefined && { condition }),
        ...(autoTransfer !== undefined && { autoTransfer }),
        ...(isRequired !== undefined && { isRequired }),
      },
      include: {
        fromService: {
          select: { id: true, name: true, type: true },
        },
        toService: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    res.json(flow);
  } catch (error) {
    next(error);
  }
};

// Delete a service flow
export const deleteServiceFlow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await prisma.serviceFlow.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Bulk update flows (for drag-and-drop reordering in flow designer)
export const updateFlowOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { flows } = req.body; // Array of { id, priority }

    if (!Array.isArray(flows)) {
      return res.status(400).json({ error: 'flows must be an array' });
    }

    await prisma.$transaction(
      flows.map(({ id, priority }: { id: string; priority: number }) =>
        prisma.serviceFlow.update({
          where: { id },
          data: { priority },
        })
      )
    );

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Get next suggested services for a patient after completing current service
export const getNextServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId } = req.params;

    const flows = await prisma.serviceFlow.findMany({
      where: { fromServiceId: serviceId },
      include: {
        toService: {
          include: {
            queues: {
              where: {
                date: new Date(new Date().setHours(0, 0, 0, 0)),
                status: 'ACTIVE',
              },
              include: {
                _count: {
                  select: {
                    entries: { where: { status: 'WAITING' } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { priority: 'asc' },
    });

    const suggestions = flows.map(flow => ({
      serviceId: flow.toService.id,
      serviceName: flow.toService.name,
      displayName: flow.displayName || flow.toService.name,
      isRequired: flow.isRequired,
      autoTransfer: flow.autoTransfer,
      queueInfo: flow.toService.queues[0] ? {
        queueId: flow.toService.queues[0].id,
        waitingCount: flow.toService.queues[0]._count.entries,
        estimatedWait: flow.toService.queues[0]._count.entries * flow.toService.slotDuration,
      } : null,
    }));

    res.json(suggestions);
  } catch (error) {
    next(error);
  }
};

// Ready-made flows (flow designer "Use a template").
export const listFlowTemplates = async (_req: Request, res: Response) => {
  res.json(
    Object.values(FLOW_TEMPLATES).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      services: t.services.map((s) => ({ name: s.name, requiresClearance: !!s.requiresClearance })),
      flows: t.flows,
      defaultService: t.defaultService,
    }))
  );
};

export const applyFlowTemplateToLocation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const template = FLOW_TEMPLATES[req.params.templateId];
    if (!template) return res.status(404).json({ error: 'No such template' });
    const { locationId } = req.body ?? {};
    if (typeof locationId !== 'string' || !locationId) return res.status(400).json({ error: 'locationId is required' });
    res.json(await applyFlowTemplate(template, locationId));
  } catch (error) {
    if (error instanceof TemplateError) return res.status(error.status).json({ error: error.message, ...error.body });
    next(error);
  }
};
