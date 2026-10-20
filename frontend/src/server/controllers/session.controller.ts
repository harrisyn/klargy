import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { parseTimeToDate, startOfLocalDate, validTimeZone } from '../utils/date';
import { getOrCreateQueueForDate } from '../services/queueEvents.service';

/**
 * Sessions: one-off bookable times made by staff (a tasting evening, a class,
 * a screening) with their own capacity, price and label, beside or instead of
 * the slots generated from opening hours (Service.recurringSlots).
 */

const sessionJson = (s: { id: string; startTime: Date; endTime: Date; capacity: number; bookedCount: number; label: string | null; price: unknown }) => ({
  id: s.id,
  startTime: s.startTime,
  endTime: s.endTime,
  capacity: s.capacity,
  booked: s.bookedCount,
  label: s.label,
  price: s.price == null ? null : Number(s.price),
});

export const listSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await prisma.slot.findMany({
      where: { isSession: true, queue: { serviceId: req.params.id }, endTime: { gte: new Date() } },
      orderBy: { startTime: 'asc' },
      take: 200,
    });
    res.json(sessions.map(sessionJson));
  } catch (error) {
    next(error);
  }
};

export const createSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, startTime, durationMinutes, capacity, price, label } = req.body ?? {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{1,2}:\d{2}$/.test(String(startTime))) {
      return res.status(400).json({ error: 'Choose a date and a start time' });
    }
    const cap = Math.floor(Number(capacity));
    if (!Number.isFinite(cap) || cap < 1 || cap > 100000) return res.status(400).json({ error: 'Capacity must be at least 1' });
    if (price !== undefined && price !== null && price !== '' && !(Number(price) >= 0)) return res.status(400).json({ error: 'The price must be zero or more' });
    const trimmedLabel = String(label ?? '').trim().slice(0, 120);

    const service = await prisma.service.findUnique({ where: { id: req.params.id }, include: { location: { select: { timezone: true } } } });
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const tz = validTimeZone(service.location.timezone);
    const day = startOfLocalDate(String(date), tz);
    if (Number.isNaN(day.getTime())) return res.status(400).json({ error: 'Invalid date' });

    const start = parseTimeToDate(String(startTime), day, tz);
    const minutes = Math.floor(Number(durationMinutes ?? service.slotDuration));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return res.status(400).json({ error: 'Choose how long it lasts' });
    const end = new Date(start.getTime() + minutes * 60_000);
    if (end <= new Date()) return res.status(400).json({ error: 'That time has already passed' });

    const created = await getOrCreateQueueForDate(service.id, day);
    if (!created) return res.status(404).json({ error: 'Service not found' });
    const slot = await prisma.slot.create({
      data: {
        queueId: created.queue.id,
        startTime: start,
        endTime: end,
        capacity: cap,
        isSession: true,
        label: trimmedLabel || null,
        price: price === undefined || price === null || price === '' ? null : Number(price),
      },
    });
    res.status(201).json(sessionJson(slot));
  } catch (error) {
    next(error);
  }
};

export const deleteSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slot = await prisma.slot.findFirst({ where: { id: req.params.slotId, isSession: true, queue: { serviceId: req.params.id } } });
    if (!slot) return res.status(404).json({ error: 'Session not found' });
    if (slot.bookedCount > 0) return res.status(409).json({ error: 'Someone has booked this session. Cancel their bookings first.' });
    await prisma.slot.delete({ where: { id: slot.id } });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
