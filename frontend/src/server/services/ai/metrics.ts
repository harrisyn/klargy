import prisma from '../../lib/prisma';
import { getStartOfDay, getEndOfDay } from '../../utils/date';

/**
 * Aggregate queue statistics for one organization. These functions feed
 * both the AI tools and the statistical forecast/alerts, and they only ever
 * return counts, durations, rates and service/location names - never a
 * patient's name, phone, email or identifier. That's what makes it safe to
 * hand their output to an external LLM (see /privacy).
 */

const MAX_RANGE_DAYS = 180;
const MAX_ROWS = 50_000;

export interface Scope {
  organizationId: string;
  locationId?: string;
  serviceId?: string;
}

function entryWhere(scope: Scope, from: Date, to: Date) {
  return {
    joinedAt: { gte: from, lte: to },
    queue: {
      ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
      service: {
        location: { organizationId: scope.organizationId, ...(scope.locationId ? { id: scope.locationId } : {}) },
      },
    },
  };
}

export function parseRange(startDate?: unknown, endDate?: unknown, defaultDays = 7) {
  const end = endDate ? getEndOfDay(new Date(String(endDate))) : getEndOfDay(new Date());
  let start = startDate ? getStartOfDay(new Date(String(startDate))) : getStartOfDay(new Date(end.getTime() - (defaultDays - 1) * 86400000));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Invalid date');
  if ((end.getTime() - start.getTime()) / 86400000 > MAX_RANGE_DAYS) {
    start = getStartOfDay(new Date(end.getTime() - MAX_RANGE_DAYS * 86400000));
  }
  return { start, end };
}

const minutesBetween = (a?: Date | null, b?: Date | null) =>
  a && b ? Math.max(0, (b.getTime() - a.getTime()) / 60000) : null;

const round = (n: number | null, digits = 1) => (n === null || Number.isNaN(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);

function stats(values: number[]) {
  if (values.length === 0) return { avg: null, median: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { avg: round(values.reduce((s, v) => s + v, 0) / values.length), median: round(at(0.5)), p90: round(at(0.9)) };
}

async function loadEntries(scope: Scope, from: Date, to: Date) {
  return prisma.queueEntry.findMany({
    where: entryWhere(scope, from, to),
    select: {
      status: true,
      joinedAt: true,
      calledAt: true,
      completedAt: true,
      waitDuration: true,
      serviceDuration: true,
      previousEntryId: true,
      queue: { select: { serviceId: true, service: { select: { name: true, location: { select: { name: true } } } } } },
    },
    take: MAX_ROWS,
  });
}

type Entry = Awaited<ReturnType<typeof loadEntries>>[number];

const waitOf = (e: Entry) => e.waitDuration ?? minutesBetween(e.joinedAt, e.calledAt);
const serviceTimeOf = (e: Entry) => e.serviceDuration ?? (e.status === 'SERVED' ? minutesBetween(e.calledAt, e.completedAt) : null);

function summarize(entries: Entry[]) {
  const count = (s: string) => entries.filter((e) => e.status === s).length;
  const waits = entries.map(waitOf).filter((v): v is number => v !== null);
  const serviceTimes = entries.map(serviceTimeOf).filter((v): v is number => v !== null && v > 0);
  const finished = count('SERVED') + count('NO_SHOW') + count('CANCELLED');
  return {
    joined: entries.length,
    served: count('SERVED'),
    cancelled: count('CANCELLED'),
    noShows: count('NO_SHOW'),
    stillWaitingOrServing: count('WAITING') + count('SERVING'),
    noShowRatePct: finished ? round((count('NO_SHOW') / finished) * 100) : null,
    waitMinutes: stats(waits),
    serviceMinutes: stats(serviceTimes),
  };
}

export async function listSites(organizationId: string) {
  const locations = await prisma.location.findMany({
    where: { organizationId },
    select: { id: true, name: true, services: { select: { id: true, name: true, isActive: true, slotDuration: true } } },
    orderBy: { name: 'asc' },
  });
  return { locations };
}

export async function periodSummary(scope: Scope, startDate?: unknown, endDate?: unknown) {
  const { start, end } = parseRange(startDate, endDate);
  const entries = await loadEntries(scope, start, end);

  const byService = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = e.queue.serviceId;
    if (!byService.has(key)) byService.set(key, []);
    byService.get(key)!.push(e);
  }
  const perService = [...byService.entries()].map(([serviceId, list]) => ({
    serviceId,
    service: list[0].queue.service.name,
    location: list[0].queue.service.location.name,
    ...summarize(list),
  }));

  const byDay = new Map<string, number>();
  for (const e of entries) {
    const d = e.joinedAt.toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    overall: summarize(entries),
    busiestDay: busiest ? { date: busiest[0], joined: busiest[1] } : null,
    perService: perService.sort((a, b) => b.joined - a.joined),
    truncated: entries.length >= MAX_ROWS,
  };
}

/** Overall and per-service counters for entries that joined between two
 * exact instants (Klargy Connect analytics, where "today" is the
 * location's day rather than the server's). */
export async function summaryBetween(scope: Scope, from: Date, to: Date) {
  const entries = await loadEntries(scope, from, to);
  const byService = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!byService.has(e.queue.serviceId)) byService.set(e.queue.serviceId, []);
    byService.get(e.queue.serviceId)!.push(e);
  }
  return {
    overall: summarize(entries),
    perService: [...byService.entries()]
      .map(([serviceId, list]) => ({ serviceId, service: list[0].queue.service.name, ...summarize(list) }))
      .sort((a, b) => b.joined - a.joined),
    truncated: entries.length >= MAX_ROWS,
  };
}

export async function hourlyPattern(scope: Scope, days = 28) {
  const { start, end } = parseRange(undefined, undefined, Math.min(Math.max(days, 1), 90));
  const entries = await loadEntries(scope, start, end);
  const dayCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, arrivals: 0, waits: [] as number[] }));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => ({ day, arrivals: 0, waits: [] as number[] }));
  for (const e of entries) {
    const h = hours[e.joinedAt.getHours()];
    const w = weekdays[e.joinedAt.getDay()];
    h.arrivals++;
    w.arrivals++;
    const wait = waitOf(e);
    if (wait !== null) { h.waits.push(wait); w.waits.push(wait); }
  }
  return {
    days: dayCount,
    byHour: hours
      .filter((h) => h.arrivals > 0)
      .map((h) => ({ hour: h.hour, avgArrivalsPerDay: round(h.arrivals / dayCount), avgWaitMinutes: stats(h.waits).avg })),
    byWeekday: weekdays.map((w) => ({
      day: w.day,
      avgArrivalsPerDay: round(w.arrivals / Math.max(1, dayCount / 7)),
      avgWaitMinutes: stats(w.waits).avg,
    })),
  };
}

export async function dailyTrend(scope: Scope, days = 14) {
  const { start, end } = parseRange(undefined, undefined, Math.min(Math.max(days, 1), 90));
  const entries = await loadEntries(scope, start, end);
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const d = e.joinedAt.toISOString().slice(0, 10);
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(e);
  }
  return {
    days: [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, list]) => {
        const s = summarize(list);
        return { date, joined: s.joined, served: s.served, noShows: s.noShows, avgWaitMinutes: s.waitMinutes.avg };
      }),
  };
}

export async function transfers(scope: Scope, startDate?: unknown, endDate?: unknown) {
  const { start, end } = parseRange(startDate, endDate);
  const moved = await prisma.queueEntry.findMany({
    where: { ...entryWhere(scope, start, end), previousEntryId: { not: null } },
    select: { previousEntryId: true, joinedAt: true, calledAt: true, queue: { select: { service: { select: { name: true } } } } },
    take: MAX_ROWS,
  });
  const previous = await prisma.queueEntry.findMany({
    where: { id: { in: moved.map((m) => m.previousEntryId!) } },
    select: { id: true, completedAt: true, queue: { select: { service: { select: { name: true } } } } },
  });
  const prevById = new Map(previous.map((p) => [p.id, p]));

  const routes = new Map<string, { from: string; to: string; count: number; gaps: number[] }>();
  for (const m of moved) {
    const prev = prevById.get(m.previousEntryId!);
    if (!prev) continue;
    const key = `${prev.queue.service.name} -> ${m.queue.service.name}`;
    if (!routes.has(key)) routes.set(key, { from: prev.queue.service.name, to: m.queue.service.name, count: 0, gaps: [] });
    const r = routes.get(key)!;
    r.count++;
    const gap = minutesBetween(m.joinedAt, m.calledAt);
    if (gap !== null) r.gaps.push(gap);
  }
  return {
    period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    totalTransfers: moved.length,
    routes: [...routes.values()]
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ from: r.from, to: r.to, count: r.count, avgWaitAtNextServiceMinutes: stats(r.gaps).avg })),
  };
}

/** Today's queues. `timeZone` makes "today" a location's day; without it
 * the server's. */
export async function liveStatus(scope: Scope, timeZone?: string) {
  const today = getStartOfDay(new Date(), timeZone);
  const queues = await prisma.queue.findMany({
    where: {
      date: today,
      ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
      service: { location: { organizationId: scope.organizationId, ...(scope.locationId ? { id: scope.locationId } : {}) } },
    },
    select: {
      id: true,
      status: true,
      serviceId: true,
      service: { select: { name: true, location: { select: { id: true, name: true } } } },
      entries: { where: { status: { in: ['WAITING', 'SERVING'] } }, select: { status: true, joinedAt: true } },
    },
  });
  const now = Date.now();
  return {
    asOf: new Date(now).toISOString(),
    services: queues.map((q) => {
      const waiting = q.entries.filter((e) => e.status === 'WAITING');
      return {
        serviceId: q.serviceId,
        service: q.service.name,
        location: q.service.location.name,
        locationId: q.service.location.id,
        queueStatus: q.status,
        waiting: waiting.length,
        beingServed: q.entries.length - waiting.length,
        longestCurrentWaitMinutes: waiting.length
          ? Math.round(Math.max(...waiting.map((e) => (now - e.joinedAt.getTime()) / 60000)))
          : 0,
      };
    }),
  };
}

export async function appointmentStats(scope: Scope, startDate?: unknown, endDate?: unknown) {
  const { start, end } = parseRange(startDate, endDate);
  const rows = await prisma.appointment.groupBy({
    by: ['status'],
    where: {
      startTime: { gte: start, lte: end },
      service: {
        ...(scope.serviceId ? { id: scope.serviceId } : {}),
        location: { organizationId: scope.organizationId, ...(scope.locationId ? { id: scope.locationId } : {}) },
      },
    },
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  const missed = await prisma.appointment.count({
    where: {
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startTime: { gte: start, lt: new Date(Math.min(end.getTime(), Date.now())) },
      service: { location: { organizationId: scope.organizationId, ...(scope.locationId ? { id: scope.locationId } : {}) } },
    },
  });
  return {
    period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    byStatus,
    pastAppointmentsNeverCheckedIn: missed,
  };
}
