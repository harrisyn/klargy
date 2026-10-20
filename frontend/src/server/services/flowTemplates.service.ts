import prisma from '../lib/prisma';
import { checkLimit } from '../middleware/subscription.middleware';
import { syncInstancesForServicePointService } from '../controllers/servicepoint.controller';
import { industryFeatures } from '../../lib/terms';
import type { FlowTemplate, TemplateRoom } from './flowTemplates.data';

/**
 * Ready-made service flows an admin applies to a location from the flow
 * designer. Applying one creates the services it names (reusing services of
 * the same name at the location), gives each new service one service point
 * (reusing a service point of the same name), adds the flow connections and
 * the template's settings. A template can also lay out rooms with tables or
 * seats on a floor plan, where the organization's industry has them (a clinic
 * is never given tables). Applying it again changes nothing.
 */

export { FLOW_TEMPLATES, OUTPATIENT_TEMPLATE } from './flowTemplates.data';
export type { FlowTemplate } from './flowTemplates.data';

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
  roomsCreated: number;
  tablesCreated: number;
  /** Tables were left out because this kind of business doesn't use them. */
  tablesSkipped: boolean;
}

/** Rooms and their tables, added where missing. Existing ones (by name, at the location) are left exactly as they are. */
async function layOutRooms(locationId: string, rooms: TemplateRoom[], withTables: boolean) {
  const haveRooms = await prisma.room.findMany({ where: { locationId }, select: { id: true, name: true } });
  const haveTables = new Set((await prisma.diningTable.findMany({ where: { locationId }, select: { name: true } })).map((t) => t.name.trim().toLowerCase()));
  let roomsCreated = 0;
  let tablesCreated = 0;
  for (const [i, r] of rooms.entries()) {
    let roomId = haveRooms.find((x) => same(x.name, r.name))?.id;
    const isNew = !roomId;
    if (!roomId) {
      roomId = (
        await prisma.room.create({
          data: {
            locationId,
            name: r.name,
            description: r.description,
            sortOrder: haveRooms.length + i,
            ...(r.layoutWidth ? { layoutWidth: r.layoutWidth } : {}),
            ...(r.layoutHeight ? { layoutHeight: r.layoutHeight } : {}),
            ...(r.minPartySize ? { minPartySize: r.minPartySize } : {}),
            ...(r.maxPartySize ? { maxPartySize: r.maxPartySize } : {}),
            ...(r.allowCombine === false ? { allowCombine: false } : {}),
          },
          select: { id: true },
        })
      ).id;
      roomsCreated++;
    }
    // Tables only go into a room this template made; a room that was already there keeps its own plan.
    if (!withTables || !isNew) continue;
    const fresh = r.tables.filter((t) => !haveTables.has(t.name.trim().toLowerCase()));
    if (!fresh.length) continue;
    await prisma.diningTable.createMany({
      data: fresh.map((t, n) => ({
        locationId,
        roomId: roomId!,
        name: t.name,
        seats: t.seats,
        sortOrder: n,
        x: t.x,
        y: t.y,
        width: t.width ?? 90,
        height: t.height ?? 90,
        shape: t.shape ?? 'RECT',
        rotation: t.rotation ?? 0,
      })),
    });
    fresh.forEach((t) => haveTables.add(t.name.trim().toLowerCase()));
    tablesCreated += fresh.length;
  }
  return { roomsCreated, tablesCreated };
}

export async function applyFlowTemplate(template: FlowTemplate, locationId: string): Promise<TemplateResult> {
  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { id: true, organizationId: true, organization: { select: { industry: true } } },
  });
  if (!location) throw new TemplateError('Location not found', 404);
  const { organizationId } = location;
  // Tables and floor plans only for the kinds of business that use them (no industry set: all).
  const features = industryFeatures(location.organization?.industry);
  const withTables = features.tables;

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
          data: {
            locationId,
            name: t.name,
            description: t.description,
            requiresClearance: !!t.requiresClearance,
            ...(t.slotDuration ? { slotDuration: t.slotDuration } : {}),
            ...(t.bookingMode ? { bookingMode: t.bookingMode } : {}),
            ...(t.partySize ? { bookingUnit: 'PERSON', minPartySize: t.partySize.min, maxPartySize: t.partySize.max } : {}),
            ...(t.tableMode && withTables ? { tableMode: t.tableMode } : {}),
            ...(t.sessionsOnly ? { recurringSlots: false } : {}),
          },
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
  const laid = template.rooms?.length ? await layOutRooms(locationId, template.rooms, withTables) : { roomsCreated: 0, tablesCreated: 0 };
  const tablesSkipped = !withTables && !!template.rooms?.some((r) => r.tables.length);
  return { services, servicePointsCreated, flowsCreated, defaultServiceId, ...laid, tablesSkipped };
}
