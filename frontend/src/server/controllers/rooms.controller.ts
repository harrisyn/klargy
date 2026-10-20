import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import prisma from '../lib/prisma';
import { loadCaller } from '../middleware/tenantScope.middleware';
import { getActiveFileStorageProvider } from '../services/fileStorage';
import { industryFeatures } from '../../lib/terms';
import { bookingEnd, seatMap } from '../services/tables.service';
import { parseRefundTiers } from '../services/rooms.service';

/**
 * Rooms within a location, and what is in them: tables or seats on a floor
 * plan, and desks (service point instances). Each room can have its own
 * rules and rates. Offered according to the organization's industry: rooms
 * for everyone, tables and floor plans only where they make sense.
 */

const PRICE_MODES = ['INHERIT', 'OVERRIDE', 'SURCHARGE'];
const BASES = ['BOOKING', 'PERSON'];
const PAYMENT_MODES = ['NONE', 'DEPOSIT', 'FULL'];
const SHAPES = ['RECT', 'ROUND'];
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

class RoomError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const fail = (error: unknown, res: Response, next: NextFunction) => {
  if (error instanceof RoomError) return res.status(error.status).json({ error: error.message });
  if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Another room or table here already has that name.' });
  next(error);
};

/** The caller's organization, and whether its industry offers rooms and tables. */
async function context(req: Request) {
  const caller = await loadCaller(req);
  if (!caller) throw new RoomError('Authentication required', 401);
  const org = caller.organizationId
    ? await prisma.organization.findUnique({ where: { id: caller.organizationId }, select: { id: true, industry: true } })
    : null;
  return { caller, org, features: industryFeatures(org?.industry) };
}

async function ownedLocation(req: Request, locationId: string) {
  const { org, features } = await context(req);
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { id: true, organizationId: true, timezone: true } });
  if (!location || (org && location.organizationId !== org.id)) throw new RoomError('Location not found', 404);
  if (!features.rooms) throw new RoomError('Rooms aren’t available for this kind of business.', 403);
  return { location, features };
}

async function ownedRoom(req: Request, roomId: string) {
  const { org, features } = await context(req);
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { location: { select: { organizationId: true, timezone: true } } } });
  if (!room || (org && room.location.organizationId !== org.id)) throw new RoomError('Room not found', 404);
  if (!features.rooms) throw new RoomError('Rooms aren’t available for this kind of business.', 403);
  return { room, features };
}

const num = (v: unknown, field: string, min: number, max: number, integer = false): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new RoomError(`${field} must be ${integer ? 'a whole number ' : 'a number '}from ${min} to ${max}`);
  return n;
};
const optNum = (v: unknown, field: string, min: number, max: number, integer = false) => (v === undefined || v === null || v === '' ? null : num(v, field, min, max, integer));

/** Reads and checks the editable fields of a room; only what was sent. */
function roomFields(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 80) throw new RoomError('Give the room a name (up to 80 characters)');
    out.name = name;
  }
  if (body.description !== undefined) out.description = String(body.description ?? '').trim().slice(0, 500) || null;
  if (body.sortOrder !== undefined) out.sortOrder = num(body.sortOrder, 'Order', 0, 10000, true);
  if (body.isActive !== undefined) out.isActive = !!body.isActive;
  if (body.onlineBookable !== undefined) out.onlineBookable = !!body.onlineBookable;
  if (body.allowCombine !== undefined) out.allowCombine = !!body.allowCombine;
  if (body.minPartySize !== undefined) out.minPartySize = optNum(body.minPartySize, 'Smallest party', 1, 1000, true);
  if (body.maxPartySize !== undefined) out.maxPartySize = optNum(body.maxPartySize, 'Largest party', 1, 1000, true);
  if (out.minPartySize && out.maxPartySize && Number(out.minPartySize) > Number(out.maxPartySize)) throw new RoomError('The smallest party can’t be bigger than the largest');
  for (const k of ['openTime', 'closeTime'] as const) {
    if (body[k] !== undefined) {
      const v = String(body[k] ?? '').trim();
      if (v && !HHMM.test(v)) throw new RoomError('Times look like 18:00');
      out[k] = v || null;
    }
  }
  if ((out.openTime && !out.closeTime) || (!out.openTime && out.closeTime)) {
    if (body.openTime !== undefined && body.closeTime !== undefined) throw new RoomError('Set both an opening and a closing time, or neither');
  }
  if (body.activeDays !== undefined) {
    const v = String(body.activeDays ?? '').trim();
    if (v && !/^[0-6](,[0-6])*$/.test(v)) throw new RoomError('Days are numbers 0 (Sunday) to 6, separated by commas');
    out.activeDays = v || null;
  }
  if (body.priceMode !== undefined) {
    if (!PRICE_MODES.includes(String(body.priceMode))) throw new RoomError('Rate must be INHERIT, OVERRIDE or SURCHARGE');
    out.priceMode = String(body.priceMode);
  }
  if (body.price !== undefined) out.price = optNum(body.price, 'Price', 0, 1e9);
  if (body.priceBasis !== undefined) {
    if (!BASES.includes(String(body.priceBasis))) throw new RoomError('Price basis must be BOOKING or PERSON');
    out.priceBasis = String(body.priceBasis);
  }
  if (body.paymentMode !== undefined) {
    const v = body.paymentMode === null || body.paymentMode === '' ? null : String(body.paymentMode);
    if (v !== null && !PAYMENT_MODES.includes(v)) throw new RoomError('Payment must be NONE, DEPOSIT or FULL');
    out.paymentMode = v;
  }
  if (body.depositPercent !== undefined) out.depositPercent = optNum(body.depositPercent, 'Deposit', 1, 99, true);
  if (body.refundCutoffHours !== undefined) out.refundCutoffHours = optNum(body.refundCutoffHours, 'Refund notice', 0, 720, true);
  if (body.refundTiers !== undefined) out.refundTiers = Array.isArray(body.refundTiers) && body.refundTiers.length ? parseRefundTiers(body.refundTiers) : null;
  if ((out.priceMode === 'OVERRIDE' || out.priceMode === 'SURCHARGE') && out.price == null && body.price !== undefined) throw new RoomError('Set the room’s price');
  return out;
}

const roomJson = (r: Record<string, unknown> & { price?: unknown }) => ({ ...r, price: r.price == null ? null : Number(r.price) });

export const listRooms = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const locationId = String(req.query.locationId ?? '');
    if (!locationId) throw new RoomError('locationId is required');
    const { features } = await ownedLocation(req, locationId);
    const rooms = await prisma.room.findMany({
      where: { locationId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { tables: true, instances: true, services: true } }, tables: { where: { isActive: true }, select: { seats: true } } },
    });
    res.json({ features, rooms: rooms.map(({ tables, ...r }) => ({ ...roomJson(r), seats: tables.reduce((n, t) => n + t.seats, 0) })) });
  } catch (error) {
    fail(error, res, next);
  }
};

export const createRoom = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const locationId = String(req.body?.locationId ?? '');
    await ownedLocation(req, locationId);
    const data = roomFields(req.body ?? {});
    if (!data.name) throw new RoomError('Give the room a name');
    const room = await prisma.room.create({ data: { ...(data as { name: string }), locationId } });
    res.status(201).json(roomJson(room));
  } catch (error) {
    fail(error, res, next);
  }
};

export const getRoom = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room, features } = await ownedRoom(req, req.params.id);
    const [tables, desks] = await Promise.all([
      features.tables ? prisma.diningTable.findMany({ where: { roomId: room.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) : [],
      prisma.servicePointInstance.findMany({ where: { roomId: room.id }, select: { id: true } }),
    ]);
    res.json({ features, room: roomJson(room), tables, deskIds: desks.map((d) => d.id) });
  } catch (error) {
    fail(error, res, next);
  }
};

export const updateRoom = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ownedRoom(req, req.params.id);
    const room = await prisma.room.update({ where: { id: req.params.id }, data: roomFields(req.body ?? {}) });
    res.json(roomJson(room));
  } catch (error) {
    fail(error, res, next);
  }
};

export const deleteRoom = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ownedRoom(req, req.params.id);
    // Its tables, desks and services stay (they just leave the room).
    await prisma.room.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    fail(error, res, next);
  }
};

interface TableInput {
  id?: string;
  name: string;
  seats: number;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  shape: string;
  isActive: boolean;
  sortOrder: number;
}

function parseTables(value: unknown, width: number, height: number): TableInput[] {
  if (!Array.isArray(value)) throw new RoomError('tables must be a list');
  if (value.length > 500) throw new RoomError('A room can have up to 500 tables or seats');
  const names = new Set<string>();
  return value.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const name = String(t.name ?? '').trim();
    if (!name || name.length > 40) throw new RoomError('Every table needs a name (up to 40 characters)');
    if (names.has(name.toLowerCase())) throw new RoomError(`There are two tables called “${name}”`);
    names.add(name.toLowerCase());
    const shape = String(t.shape ?? 'RECT');
    if (!SHAPES.includes(shape)) throw new RoomError('Shape must be RECT or ROUND');
    return {
      id: typeof t.id === 'string' && t.id ? t.id : undefined,
      name,
      seats: num(t.seats, `Seats for ${name}`, 1, 100, true),
      x: t.x == null ? null : num(t.x, 'x', -width, width * 2),
      y: t.y == null ? null : num(t.y, 'y', -height, height * 2),
      width: num(t.width ?? 90, 'Width', 10, 1000),
      height: num(t.height ?? 90, 'Height', 10, 1000),
      rotation: num(t.rotation ?? 0, 'Rotation', -360, 360),
      shape,
      isActive: t.isActive === undefined ? true : !!t.isActive,
      sortOrder: i,
    };
  });
}

/** Saves the floor plan: the canvas size and the room's tables (added, moved, resized, removed) in one go. */
export const saveLayout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room, features } = await ownedRoom(req, req.params.id);
    if (!features.tables) throw new RoomError(`Tables aren’t available for this kind of business.`, 403);
    const width = num(req.body?.layoutWidth ?? room.layoutWidth, 'Width', 200, 5000, true);
    const height = num(req.body?.layoutHeight ?? room.layoutHeight, 'Height', 200, 5000, true);
    const incoming = parseTables(req.body?.tables ?? [], width, height);

    await prisma.$transaction(async (tx) => {
      const existing = await tx.diningTable.findMany({ where: { roomId: room.id }, select: { id: true } });
      const keep = new Set(incoming.filter((t) => t.id).map((t) => t.id!));
      for (const t of incoming.filter((t) => t.id && !existing.some((e) => e.id === t.id))) {
        throw new RoomError(`A table in this plan isn’t part of the room (${t.name}).`);
      }
      // Removing a table that still has upcoming bookings would orphan them: those are switched off instead.
      for (const gone of existing.filter((e) => !keep.has(e.id))) {
        const upcoming = await tx.bookingTable.count({ where: { tableId: gone.id, appointment: { startTime: { gte: new Date() }, status: { in: ['PENDING_PAYMENT', 'SCHEDULED', 'CONFIRMED', 'CHECKED_IN'] } } } });
        if (upcoming > 0) await tx.diningTable.update({ where: { id: gone.id }, data: { isActive: false } });
        else await tx.diningTable.delete({ where: { id: gone.id } });
      }
      for (const t of incoming) {
        const data = { name: t.name, seats: t.seats, x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation, shape: t.shape, isActive: t.isActive, sortOrder: t.sortOrder };
        if (t.id) await tx.diningTable.update({ where: { id: t.id }, data });
        else await tx.diningTable.create({ data: { ...data, locationId: room.locationId, roomId: room.id } });
      }
      await tx.room.update({ where: { id: room.id }, data: { layoutWidth: width, layoutHeight: height } });
    });
    res.json({ tables: await prisma.diningTable.findMany({ where: { roomId: room.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }), layoutWidth: width, layoutHeight: height });
  } catch (error) {
    fail(error, res, next);
  }
};

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } }).single('image');
export const roomImageMiddleware = (req: Request, res: Response, next: NextFunction) => {
  imageUpload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `Picture too large: ${MAX_IMAGE_BYTES / (1024 * 1024)}MB at most` });
    if (err) return res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed' });
    next();
  });
};

/** A picture of the real room, shown behind the floor plan. */
export const uploadRoomImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room } = await ownedRoom(req, req.params.id);
    const file = req.file;
    if (!file) throw new RoomError('No picture uploaded (expected the field “image”)');
    if (!IMAGE_TYPES.includes(file.mimetype)) throw new RoomError(`The picture must be ${IMAGE_TYPES.map((t) => t.replace('image/', '')).join(', ')}`);
    const provider = await getActiveFileStorageProvider();
    if (!provider) throw new RoomError('No file storage is set up yet. Ask the platform team to switch one on.');
    let uploaded;
    try {
      uploaded = await provider.uploadFile(file.buffer, file.originalname, file.mimetype);
    } catch (err) {
      console.error('Room picture upload failed:', err);
      throw new RoomError('File storage is temporarily unavailable. Please try again.', 502);
    }
    if (room.layoutImageFileId) await provider.deleteFile(room.layoutImageFileId).catch((e: unknown) => console.error('Failed to delete the old room picture:', e));
    const updated = await prisma.room.update({ where: { id: room.id }, data: { layoutImageUrl: uploaded.url, layoutImageFileId: uploaded.fileId }, select: { layoutImageUrl: true } });
    res.json(updated);
  } catch (error) {
    fail(error, res, next);
  }
};

export const removeRoomImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room } = await ownedRoom(req, req.params.id);
    if (room.layoutImageFileId) {
      const provider = await getActiveFileStorageProvider();
      await provider?.deleteFile(room.layoutImageFileId).catch((e: unknown) => console.error('Failed to delete the room picture:', e));
    }
    await prisma.room.update({ where: { id: room.id }, data: { layoutImageUrl: null, layoutImageFileId: null } });
    res.json({ ok: true });
  } catch (error) {
    fail(error, res, next);
  }
};

/** Desks (service point instances) at a location, with the room each is in. */
export const listDesks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const locationId = String(req.query.locationId ?? '');
    await ownedLocation(req, locationId);
    const rows = await prisma.servicePointInstance.findMany({
      where: { servicePointService: { service: { locationId } } },
      include: { servicePointService: { select: { servicePoint: { select: { name: true, displayName: true } }, service: { select: { name: true } } } } },
      orderBy: [{ servicePointService: { servicePoint: { name: 'asc' } } }, { instanceNumber: 'asc' }],
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.displayName || `${r.servicePointService.servicePoint.displayName || r.servicePointService.servicePoint.name} ${r.instanceNumber}`,
        serviceName: r.servicePointService.service.name,
        roomId: r.roomId,
      }))
    );
  } catch (error) {
    fail(error, res, next);
  }
};

/** Puts exactly these desks in the room (desks it had before leave). */
export const setRoomDesks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room } = await ownedRoom(req, req.params.id);
    const ids: string[] = Array.isArray(req.body?.instanceIds) ? req.body.instanceIds.filter((v: unknown): v is string => typeof v === 'string') : [];
    const valid = await prisma.servicePointInstance.findMany({ where: { id: { in: ids }, servicePointService: { service: { locationId: room.locationId } } }, select: { id: true } });
    if (valid.length !== ids.length) throw new RoomError('One of those desks isn’t at this location', 404);
    await prisma.$transaction([
      prisma.servicePointInstance.updateMany({ where: { roomId: room.id, id: { notIn: ids } }, data: { roomId: null } }),
      prisma.servicePointInstance.updateMany({ where: { id: { in: ids } }, data: { roomId: room.id } }),
    ]);
    res.json({ ok: true, count: ids.length });
  } catch (error) {
    fail(error, res, next);
  }
};

/**
 * The host's view: the room's floor plan with each table free or taken at a
 * moment, and the day's bookings at its tables.
 */
export const getFloor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room, features } = await ownedRoom(req, req.params.id);
    if (!features.tables) throw new RoomError('Tables aren’t available for this kind of business.', 403);
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    if (Number.isNaN(at.getTime())) throw new RoomError('Invalid time');
    const minutes = Math.min(480, Math.max(15, Math.floor(Number(req.query.minutes ?? 90)) || 90));
    const map = await seatMap(room.id, { start: at, end: bookingEnd(at, null, minutes), partySize: 1, online: false, timeZone: room.location.timezone });
    const dayStart = new Date(at.getTime() - 12 * 3_600_000);
    const dayEnd = new Date(at.getTime() + 12 * 3_600_000);
    const bookings = await prisma.bookingTable.findMany({
      where: { table: { roomId: room.id }, appointment: { startTime: { gte: dayStart, lt: dayEnd }, status: { in: ['PENDING_PAYMENT', 'SCHEDULED', 'CONFIRMED', 'CHECKED_IN'] } } },
      select: { tableId: true, appointment: { select: { id: true, startTime: true, endTime: true, partySize: true, status: true, user: { select: { firstName: true, lastName: true } }, service: { select: { slotDuration: true } } } } },
      orderBy: { appointment: { startTime: 'asc' } },
    });
    res.json({
      ...map,
      at,
      bookings: bookings.map((b) => ({
        tableId: b.tableId,
        appointmentId: b.appointment.id,
        startTime: b.appointment.startTime,
        endTime: bookingEnd(b.appointment.startTime, b.appointment.endTime, b.appointment.service.slotDuration),
        partySize: b.appointment.partySize,
        status: b.appointment.status,
        name: `${b.appointment.user.firstName} ${b.appointment.user.lastName}`.trim(),
      })),
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/** Staff: the floor plan of a room for choosing a booking's tables at a given time. */
export const getRoomSeatMap = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room, features } = await ownedRoom(req, req.params.id);
    if (!features.tables) throw new RoomError('Tables aren’t available for this kind of business.', 403);
    const start = new Date(String(req.query.start ?? ''));
    if (Number.isNaN(start.getTime())) throw new RoomError('Invalid time');
    const minutes = Math.min(480, Math.max(15, Math.floor(Number(req.query.minutes ?? 90)) || 90));
    const map = await seatMap(room.id, {
      start,
      end: bookingEnd(start, null, minutes),
      partySize: Math.max(1, Math.floor(Number(req.query.partySize ?? 1)) || 1),
      online: false,
      timeZone: room.location.timezone,
      excludeAppointmentId: typeof req.query.excludeAppointmentId === 'string' ? req.query.excludeAppointmentId : undefined,
    });
    res.json(map);
  } catch (error) {
    fail(error, res, next);
  }
};
