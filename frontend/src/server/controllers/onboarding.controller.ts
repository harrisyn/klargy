import { currencyChangeBlock, isSupportedCurrency } from '../services/currency.service';
import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { loadCaller } from '../middleware/tenantScope.middleware';
import { checkLimit } from '../middleware/subscription.middleware';
import { syncInstancesForServicePointService } from './servicepoint.controller';
import { INDUSTRIES } from '../../lib/terms';

/**
 * First-run setup for a new organization: one request creates a location,
 * its services, and a desk/room for each service already linked to it, so
 * staff can call patients the moment setup finishes.
 */

const TYPE_BY_NAME: Record<string, string> = {
  reception: 'RECEPTION',
  registration: 'RECEPTION',
  triage: 'TRIAGE',
  consultation: 'CONSULTATION',
  doctor: 'CONSULTATION',
  lab: 'LAB',
  laboratory: 'LAB',
  pharmacy: 'PHARMACY',
  cashier: 'CASHIER',
  billing: 'CASHIER',
  imaging: 'IMAGING',
  'x-ray': 'IMAGING',
};

const DESK_NAME_BY_TYPE: Record<string, string> = {
  RECEPTION: 'Reception desk',
  TRIAGE: 'Triage room',
  CONSULTATION: 'Consulting room',
  LAB: 'Lab counter',
  PHARMACY: 'Pharmacy counter',
  CASHIER: 'Cashier desk',
  IMAGING: 'Imaging room',
  OTHER: 'Desk',
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function publicCodeFrom(name: string) {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'MAIN';
  return base;
}

async function uniquePublicCode(name: string) {
  const base = publicCodeFrom(name);
  for (let i = 0; i < 50; i++) {
    const code = i === 0 ? base : `${base}${i + 1}`;
    const taken = await prisma.location.findFirst({ where: { publicCode: code }, select: { id: true } });
    if (!taken) return code;
  }
  return `${base}${Date.now().toString(36).toUpperCase()}`;
}

export const getOnboardingStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = await loadCaller(req);
    if (!caller?.organizationId) return res.status(404).json({ error: 'Not found' });
    const [locations, services, desks, entries] = await Promise.all([
      prisma.location.count({ where: { organizationId: caller.organizationId } }),
      prisma.service.count({ where: { location: { organizationId: caller.organizationId } } }),
      prisma.servicePoint.count({ where: { organizationId: caller.organizationId } }),
      prisma.queueEntry.count({ where: { queue: { service: { location: { organizationId: caller.organizationId } } } } }),
    ]);
    const firstLocation = await prisma.location.findFirst({
      where: { organizationId: caller.organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, publicCode: true },
    });
    res.json({ locations, services, desks, entries, firstLocation, needsSetup: locations === 0 || services === 0 });
  } catch (error) {
    next(error);
  }
};

export const quickStart = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = await loadCaller(req);
    if (!caller?.organizationId) return res.status(404).json({ error: 'Not found' });
    const organizationId = caller.organizationId;

    const locationName = String(req.body?.locationName || '').trim();
    const serviceNames: string[] = Array.isArray(req.body?.services)
      ? [...new Set<string>(req.body.services.map((s: unknown) => String(s).trim()).filter(Boolean))].slice(0, 8)
      : [];
    const startTime = TIME.test(req.body?.startTime) ? req.body.startTime : '09:00';
    const endTime = TIME.test(req.body?.endTime) ? req.body.endTime : '17:00';
    const activeDays = /^[0-6](,[0-6])*$/.test(req.body?.activeDays || '') ? req.body.activeDays : '1,2,3,4,5';

    if (!locationName) return res.status(400).json({ error: 'Give your location a name.' });
    if (serviceNames.length === 0) return res.status(400).json({ error: 'Choose at least one service.' });
    if (startTime >= endTime) return res.status(400).json({ error: 'Closing time must be after opening time.' });

    const [locLimit, svcLimit] = await Promise.all([checkLimit(organizationId, 'locations'), checkLimit(organizationId, 'services')]);
    if (!locLimit.allowed) return res.status(403).json({ error: 'Your plan’s location limit is reached.', upgradeRequired: true });
    if (svcLimit.limit !== null && svcLimit.current + serviceNames.length > svcLimit.limit) {
      return res.status(403).json({
        error: `Your plan includes ${svcLimit.limit === 1 ? 'one service' : `${svcLimit.limit} services`}. Choose ${Math.max(0, svcLimit.limit - svcLimit.current)} or fewer, or upgrade for more.`,
        upgradeRequired: true,
      });
    }

    const industry = INDUSTRIES.some((i) => i.id === req.body?.industry) ? String(req.body.industry) : null;
    if (industry) await prisma.organization.update({ where: { id: organizationId }, data: { industry } });

    // Currency for prices, the wallet and booking payments; settable until money moves in it.
    const wantedCurrency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : '';
    if (wantedCurrency) {
      const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
      if (org && org.currency !== wantedCurrency) {
        if (!(await isSupportedCurrency(wantedCurrency))) return res.status(400).json({ error: `${wantedCurrency} isn’t a supported currency` });
        const block = await currencyChangeBlock(organizationId);
        if (block) return res.status(409).json({ error: block });
        await prisma.organization.update({ where: { id: organizationId }, data: { currency: wantedCurrency } });
      }
    }

    const publicCode = await uniquePublicCode(locationName);
    const location = await prisma.location.create({
      data: { organizationId, name: locationName, publicCode, timezone: String(req.body?.timezone || 'UTC').slice(0, 64) },
    });

    const created = [];
    for (const name of serviceNames) {
      const type = TYPE_BY_NAME[name.toLowerCase()] || 'OTHER';
      const service = await prisma.service.create({
        data: { locationId: location.id, name, startTime, endTime, activeDays, requiresName: true },
      });
      const desk = await prisma.servicePoint.create({
        data: {
          organizationId,
          name: type === 'OTHER' ? `${name} desk` : DESK_NAME_BY_TYPE[type],
          type: type as any,
          capacity: 1,
        },
      });
      const link = await prisma.servicePointService.create({
        data: { servicePointId: desk.id, serviceId: service.id, capacity: 1 },
      });
      await syncInstancesForServicePointService(link.id);
      created.push({ id: service.id, name: service.name, desk: desk.name });
    }

    res.status(201).json({ location: { id: location.id, name: location.name, publicCode }, services: created });
  } catch (error) {
    next(error);
  }
};
