import prisma from '../lib/prisma';
import { checkLimit } from '../middleware/subscription.middleware';
import { syncInstancesForServicePointService } from '../controllers/servicepoint.controller';

/**
 * Ready-made service flows an admin applies to a location from the flow
 * designer. Applying one creates the services it names (reusing services of
 * the same name at the location), gives each new service one service point
 * (reusing a service point of the same name), adds the flow connections and
 * the template's settings. Applying it again changes nothing.
 */

type PointType = 'RECEPTION' | 'TRIAGE' | 'CONSULTATION' | 'CASHIER' | 'PHARMACY' | 'LAB' | 'IMAGING' | 'OTHER';

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  services: { name: string; pointType: PointType; requiresClearance?: boolean; description: string }[];
  /** from service name -> to service names, in priority order. */
  flows: Record<string, string[]>;
  /** The location's first point of contact (kiosk and QR joins). */
  defaultService: string;
}

export const OUTPATIENT_TEMPLATE: FlowTemplate = {
  id: 'outpatient',
  name: 'Outpatient clinic',
  description:
    'Reception, cashier, triage, consultation, laboratory, imaging and pharmacy in one waiting area. Consultation waits for payment.',
  services: [
    { name: 'Reception', pointType: 'RECEPTION', description: 'First point of contact: registration and the visit.' },
    { name: 'Cashier', pointType: 'CASHIER', description: 'Payments before consultation and for orders.' },
    { name: 'Triage', pointType: 'TRIAGE', description: 'Vital signs before seeing the doctor.' },
    { name: 'Consultation', pointType: 'CONSULTATION', requiresClearance: true, description: 'Seeing the doctor.' },
    { name: 'Laboratory', pointType: 'LAB', description: 'Samples and tests.' },
    { name: 'Imaging', pointType: 'IMAGING', description: 'X-ray, ultrasound and scans.' },
    { name: 'Pharmacy', pointType: 'PHARMACY', description: 'Medicines, then home.' },
  ],
  flows: {
    Reception: ['Cashier', 'Triage', 'Consultation', 'Laboratory', 'Pharmacy'],
    Cashier: ['Triage', 'Laboratory', 'Imaging', 'Pharmacy'],
    Triage: ['Consultation'],
    Consultation: ['Cashier', 'Laboratory', 'Imaging', 'Pharmacy'],
    Laboratory: ['Consultation', 'Pharmacy'],
    Imaging: ['Consultation'],
    Pharmacy: [],
  },
  defaultService: 'Reception',
};

export const FLOW_TEMPLATES: Record<string, FlowTemplate> = { [OUTPATIENT_TEMPLATE.id]: OUTPATIENT_TEMPLATE };

export class TemplateError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface TemplateResult {
  services: { id: string; name: string; created: boolean }[];
  servicePointsCreated: number;
  flowsCreated: number;
  defaultServiceId: string;
}

export async function applyFlowTemplate(template: FlowTemplate, locationId: string): Promise<TemplateResult> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { id: true, organizationId: true } });
  if (!location) throw new TemplateError('Location not found', 404);
  const { organizationId } = location;

  const existing = await prisma.service.findMany({ where: { locationId }, select: { id: true, name: true } });
  const missing = template.services.filter((t) => !existing.some((s) => same(s.name, t.name)));
  if (missing.length) {
    const { current, limit } = await checkLimit(organizationId, 'services');
    if (limit !== null && current + missing.length > limit) {
      throw new TemplateError('Limit reached', 403, {
        error: 'Limit reached',
        message: `This template adds ${missing.length} service(s), which would exceed your plan's limit of ${limit} services (currently at ${current}).`,
        limitType: 'services',
        current,
        limit,
        upgradeRequired: true,
      });
    }
  }

  const ids = new Map<string, string>();
  const services: TemplateResult['services'] = [];
  let servicePointsCreated = 0;
  for (const t of template.services) {
    let serviceId = existing.find((s) => same(s.name, t.name))?.id;
    const created = !serviceId;
    if (!serviceId) {
      serviceId = (
        await prisma.service.create({
          data: { locationId, name: t.name, description: t.description, requiresClearance: !!t.requiresClearance },
          select: { id: true },
        })
      ).id;
    } else if (t.requiresClearance) {
      await prisma.service.update({ where: { id: serviceId }, data: { requiresClearance: true } });
    }
    ids.set(t.name, serviceId);
    services.push({ id: serviceId, name: t.name, created });

    // One service point for a service that has none.
    const linked = await prisma.servicePointService.findFirst({ where: { serviceId, isActive: true }, select: { id: true } });
    if (!linked) {
      const points = await prisma.servicePoint.findMany({ where: { organizationId }, select: { id: true, name: true } });
      let pointId = points.find((p) => same(p.name, t.name))?.id;
      if (!pointId) {
        pointId = (await prisma.servicePoint.create({ data: { organizationId, name: t.name, type: t.pointType }, select: { id: true } })).id;
        servicePointsCreated++;
      }
      const link = await prisma.servicePointService.upsert({
        where: { servicePointId_serviceId: { servicePointId: pointId, serviceId } },
        create: { servicePointId: pointId, serviceId, capacity: 1 },
        update: { isActive: true },
      });
      await syncInstancesForServicePointService(link.id);
    }
  }

  let flowsCreated = 0;
  for (const [from, tos] of Object.entries(template.flows)) {
    const fromServiceId = ids.get(from)!;
    for (const [priority, to] of tos.entries()) {
      const toServiceId = ids.get(to)!;
      const there = await prisma.serviceFlow.findUnique({
        where: { fromServiceId_toServiceId: { fromServiceId, toServiceId } },
        select: { id: true },
      });
      if (there) continue;
      await prisma.serviceFlow.create({ data: { fromServiceId, toServiceId, priority } });
      flowsCreated++;
    }
  }

  const defaultServiceId = ids.get(template.defaultService)!;
  await prisma.location.update({ where: { id: locationId }, data: { defaultServiceId } });
  return { services, servicePointsCreated, flowsCreated, defaultServiceId };
}
