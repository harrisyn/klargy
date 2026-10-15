import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { ConnectError, badRequest, handle, text } from './connect.controller';
import { buildRefs, klargyIdFor, linkRef } from '../services/externalRefs.service';
import {
  ENTRY_SNAPSHOT_INCLUDE,
  ORIGIN,
  TransferError,
  recordQueueEvent,
  transferEntryToService,
  entryRefSubject,
  getOrCreateQueueForDate,
  toEntrySnapshot,
  withPositions,
  withJourneys,
  journeyRefs,
  startJourney,
} from '../services/queueEvents.service';
import { notifyEntry } from '../services/notifications.service';
import { recordWhatsAppOptIn } from '../services/whatsapp/webhook';
import {
  QueueActionError,
  callEntry,
  checkEntryLimits,
  endEntry,
  joinQueueEntry,
  serveEntry,
  setEntryPriority,
  holdEntry,
  resumeEntry,
  clearEntry,
} from '../services/queueActions.service';

// Klargy Connect v1, phase 2 (docs/connect/v1.md section 5): patients and
// queue entries addressed by the other system's own ids. Every handler runs
// after authenticateIntegration, so req.integration is set.

type Caller = { id: string; organizationId: string };
type Result = { status: number; body: unknown };

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY = 255;
const MAX_IDENTIFIERS = 20;
const MAX_NOTES = 1000;
const MAX_PAGE = 500;
const OPEN = ['WAITING', 'SERVING'] as const;

const caller = (req: Request): Caller => ({ id: req.integration!.id, organizationId: req.integration!.organizationId });
const originOf = (c: Caller) => ORIGIN.integration(c.id);
const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === 'P2002';

// ---------------------------------------------------------------------------
// Entry objects: the same shape as webhook `data` (without `origin`, which
// belongs to an event), with this integration's `refs`.
// ---------------------------------------------------------------------------

export async function entryViews(integrationId: string, entryIds: string[]) {
  if (entryIds.length === 0) return [];
  const rows = await prisma.queueEntry.findMany({ where: { id: { in: entryIds } }, include: ENTRY_SNAPSHOT_INCLUDE });
  const byId = new Map(rows.map((r) => [r.id, toEntrySnapshot(r)]));
  const snapshots = await journeyRefs(
    integrationId,
    await withJourneys(await withPositions(entryIds.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s)))
  );
  const refs = await buildRefs(integrationId, snapshots.map((s) => entryRefSubject(s, null)));
  return snapshots.map((s, i) => ({ ...s, refs: refs[i] }));
}

const entryView = async (integrationId: string, entryId: string) => (await entryViews(integrationId, [entryId]))[0];

// ---------------------------------------------------------------------------
// Idempotency-Key: the first successful response to a key is replayed for
// 24 hours. Failures aren't stored, so the same key can be retried.
// ---------------------------------------------------------------------------

async function idempotent(req: Request, res: Response, run: () => Promise<Result>) {
  const raw = req.get('Idempotency-Key');
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    const result = await run();
    return res.status(result.status).json(result.body);
  }
  if (key.length > MAX_IDEMPOTENCY_KEY) throw badRequest(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY} characters`);

  const integrationId = req.integration!.id;
  const requestHash = crypto
    .createHash('sha256')
    .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? {})}`)
    .digest('hex');
  await prisma.connectIdempotencyKey.deleteMany({
    where: { integrationId, createdAt: { lt: new Date(Date.now() - IDEMPOTENCY_TTL_MS) } },
  });

  let rowId: string;
  try {
    rowId = (await prisma.connectIdempotencyKey.create({ data: { integrationId, key, requestHash } })).id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await prisma.connectIdempotencyKey.findUnique({ where: { integrationId_key: { integrationId, key } } });
    if (!existing) throw new ConnectError('Retry the request', 409, 'IDEMPOTENCY_IN_PROGRESS');
    if (existing.requestHash !== requestHash) {
      throw new ConnectError('This Idempotency-Key was used for a different request', 422, 'IDEMPOTENCY_KEY_REUSED');
    }
    if (existing.statusCode === 0) {
      throw new ConnectError('A request with this Idempotency-Key is still being processed', 409, 'IDEMPOTENCY_IN_PROGRESS');
    }
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(existing.statusCode).json(existing.response);
  }

  let result: Result;
  try {
    result = await run();
  } catch (error) {
    await prisma.connectIdempotencyKey.delete({ where: { id: rowId } }).catch(() => {});
    throw error;
  }
  if (result.status < 300) {
    await prisma.connectIdempotencyKey.update({
      where: { id: rowId },
      data: { statusCode: result.status, response: JSON.parse(JSON.stringify(result.body)) },
    });
  } else {
    await prisma.connectIdempotencyKey.delete({ where: { id: rowId } }).catch(() => {});
  }
  return res.status(result.status).json(result.body);
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

interface PatientInput {
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  identifiers?: Record<string, string>;
  /** The patient agreed to WhatsApp messages from this organisation. */
  whatsappOptIn?: boolean;
}

export function parsePatient(value: unknown, field = 'patient'): PatientInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${field} must be an object`);
  const p = value as Record<string, unknown>;
  const out: PatientInput = {
    firstName: text(p.firstName, `${field}.firstName`)!,
    lastName: text(p.lastName, `${field}.lastName`)!,
  };
  if ('phone' in p) out.phone = text(p.phone, `${field}.phone`, false) ?? null;
  if (p.whatsappOptIn !== undefined && p.whatsappOptIn !== null) {
    if (typeof p.whatsappOptIn !== 'boolean') throw badRequest(`${field}.whatsappOptIn must be true or false`);
    out.whatsappOptIn = p.whatsappOptIn;
  }
  if ('email' in p) {
    const email = text(p.email, `${field}.email`, false)?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest(`${field}.email is not an email address`);
    out.email = email;
  }
  if (p.identifiers !== undefined && p.identifiers !== null) {
    if (typeof p.identifiers !== 'object' || Array.isArray(p.identifiers)) throw badRequest(`${field}.identifiers must be an object`);
    const entries = Object.entries(p.identifiers as Record<string, unknown>);
    if (entries.length > MAX_IDENTIFIERS) throw badRequest(`${field}.identifiers has more than ${MAX_IDENTIFIERS} keys`);
    out.identifiers = {};
    for (const [k, v] of entries) {
      if (k.length > 50) throw badRequest(`${field}.identifiers keys must be at most 50 characters`);
      if (v === null || v === undefined || v === '') continue;
      if (typeof v !== 'string' && typeof v !== 'number') throw badRequest(`${field}.identifiers.${k} must be a string`);
      out.identifiers[k] = text(String(v), `${field}.identifiers.${k}`)!;
    }
  }
  return out;
}

/** What we keep about the patient beyond name and phone. The email the
 * other system sends is kept here, not as the login email. */
function identityData(existing: unknown, input: PatientInput) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  return {
    ...base,
    ...(input.identifiers ?? {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
  };
}

/**
 * The Klargy patient for an external patient id, created (as a PATIENT user
 * in the integration's organisation, like a walk-in) when there isn't one.
 * `input` updates the details when given.
 */
export async function upsertPatient(
  integration: Caller,
  externalId: string,
  input: PatientInput | undefined
): Promise<{ userId: string; created: boolean }> {
  const result = await upsertPatientRecord(integration, externalId, input);
  if (input?.whatsappOptIn === true && input.phone) {
    await recordWhatsAppOptIn(integration.organizationId, input.phone, 'connect').catch((e) => console.error('WhatsApp opt-in not saved:', e));
  }
  return result;
}

async function upsertPatientRecord(
  integration: Caller,
  externalId: string,
  input: PatientInput | undefined
): Promise<{ userId: string; created: boolean }> {
  const knownId = await klargyIdFor(integration.id, 'patient', externalId);
  const known = knownId
    ? await prisma.user.findFirst({
        where: { id: knownId, organizationId: integration.organizationId },
        select: { id: true, identityData: true },
      })
    : null;

  if (known) {
    if (input) {
      await prisma.user.update({
        where: { id: known.id },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          identityData: identityData(known.identityData, input) as object,
        },
      });
    }
    return { userId: known.id, created: false };
  }

  if (!input) throw new ConnectError('patient is required for a patient Klargy hasn’t seen before', 422, 'PATIENT_REQUIRED');

  // Never a real mailbox (notifications skip @guest.qms.local) and never a
  // usable password: these people don't sign in to Klargy.
  const user = await prisma.user.create({
    data: {
      email: `connect_${crypto.randomUUID()}@guest.qms.local`,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? null,
      role: 'PATIENT',
      organizationId: integration.organizationId,
      identityData: identityData(null, input) as object,
    },
    select: { id: true },
  });

  try {
    if (knownId) {
      // The reference pointed at a user that's gone: repoint it.
      await linkRef(integration, 'patient', user.id, externalId);
    } else {
      await prisma.externalReference.create({
        data: {
          integrationId: integration.id,
          organizationId: integration.organizationId,
          resourceType: 'patient',
          resourceId: user.id,
          externalId,
        },
      });
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another request created this patient at the same moment: use theirs.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    const winner = await klargyIdFor(integration.id, 'patient', externalId);
    if (!winner) throw error;
    return { userId: winner, created: false };
  }
  return { userId: user.id, created: true };
}

export const putPatient = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const externalId = text(req.params.patientId, 'patientId')!;
    const input = parsePatient(req.body, 'body');
    const { userId, created } = await upsertPatient(caller(req), externalId, input);
    res.status(created ? 201 : 200).json({ patientId: externalId, klargyId: userId, created });
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// POST /entries
// ---------------------------------------------------------------------------

/** `cleared` (phase 6): true when the patient has already paid, so a
 * service that requires clearance lets them straight into the line. */
function clearedFlag(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw badRequest('cleared must be true or false');
  return value;
}

function refString(refs: Record<string, unknown>, key: string, required: boolean) {
  return text(refs[key], `refs.${key}`, required);
}

/** A Klargy service in the caller's organisation, by mapped external id or
 * by Klargy id. */
export async function resolveService(integration: Caller, value: string) {
  const mapped = await klargyIdFor(integration.id, 'service', value);
  const service = await prisma.service.findFirst({
    where: { id: mapped ?? value, location: { organizationId: integration.organizationId } },
    include: { location: { include: { organization: { select: { status: true } } } } },
  });
  if (!service) {
    throw new ConnectError('That service isn’t matched to a Klargy service', 404, 'SERVICE_NOT_MAPPED');
  }
  return service;
}

export const queueClosed = (message = 'Today’s queue for this service isn’t taking anyone right now') =>
  new ConnectError(message, 409, 'QUEUE_CLOSED');

async function journeyForVisit(integration: Caller, visitId: string) {
  const journeyId = await klargyIdFor(integration.id, 'visit', visitId);
  return journeyId ? prisma.customerJourney.findUnique({ where: { id: journeyId } }) : null;
}

/** Ties a new journey to the visit. If another request tied the visit to a
 * journey first, the entry moves into that one. */
async function linkVisit(integration: Caller, visitId: string, entryId: string) {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, select: { journeyId: true } });
  if (!entry?.journeyId) return;
  try {
    await prisma.externalReference.create({
      data: {
        integrationId: integration.id,
        organizationId: integration.organizationId,
        resourceType: 'visit',
        resourceId: entry.journeyId,
        externalId: visitId,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await klargyIdFor(integration.id, 'visit', visitId);
    if (!winner || winner === entry.journeyId) return;
    await prisma.queueEntry.update({ where: { id: entryId }, data: { journeyId: winner } });
    await prisma.customerJourney.update({
      where: { id: winner },
      data: { queueEntryIds: { push: entryId }, completedAt: null, totalDuration: null },
    });
    await prisma.customerJourney.delete({ where: { id: entry.journeyId } }).catch(() => {});
  }
}

/** A ticket issued for a known appointment checks the appointment in
 * (phase 5). An unknown or already closed appointment is ignored. */
async function checkInAppointment(integration: Caller, appointmentRef: string, entryId: string) {
  const appointmentId = await klargyIdFor(integration.id, 'appointment', appointmentRef);
  if (!appointmentId) return;
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, service: { location: { organizationId: integration.organizationId } } },
    select: { id: true, userId: true },
  });
  if (!appointment) return;
  const { count } = await prisma.appointment.updateMany({
    where: { id: appointment.id, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
    data: { status: 'CHECKED_IN' },
  });
  if (count !== 1) return;
  await recordQueueEvent({
    action: 'appointment.checked_in',
    origin: originOf(integration),
    entryId,
    data: { appointmentId: appointment.id, patientId: appointment.userId },
  });
}

async function createEntry(req: Request): Promise<Result> {
  const integration = caller(req);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const refs = (body.refs && typeof body.refs === 'object' ? body.refs : {}) as Record<string, unknown>;
  const patientRef = refString(refs, 'patient', true)!;
  const visitRef = refString(refs, 'visit', true)!;
  const encounterRef = refString(refs, 'encounter', false);
  const appointmentRef = refString(refs, 'appointment', false);
  const serviceRef = text(body.service, 'service')!;
  const patientInput = body.patient === undefined || body.patient === null ? undefined : parsePatient(body.patient);
  const priority = body.priority === undefined || body.priority === null ? 0 : body.priority;
  if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 100) {
    throw badRequest('priority must be a whole number from 0 to 100');
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') throw badRequest('notes must be a string');
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, MAX_NOTES) : null;
  const cleared = clearedFlag(body.cleared);

  const service = await resolveService(integration, serviceRef);

  // The visit's open entry for this service, if it has one, is the answer.
  const journey = await journeyForVisit(integration, visitRef);
  if (journey) {
    const open = await prisma.queueEntry.findFirst({
      where: { id: { in: journey.queueEntryIds }, status: { in: [...OPEN] }, queue: { serviceId: service.id } },
      orderBy: { joinedAt: 'asc' },
      select: { id: true },
    });
    if (open) {
      if (encounterRef) await linkRef(integration, 'encounter', open.id, encounterRef);
      if (appointmentRef) await checkInAppointment(integration, appointmentRef, open.id);
      // Paid since the ticket was issued: the gate opens.
      if (cleared) await clearEntry(open.id, { origin: originOf(integration) });
      return { status: 200, body: { entry: await entryView(integration.id, open.id) } };
    }
  }

  if (service.location.organization.status === 'PAUSED' || !service.isActive) throw queueClosed();
  const today = await getOrCreateQueueForDate(service.id);
  if (!today || today.queue.status !== 'ACTIVE') throw queueClosed();

  const { userId } = await upsertPatient(integration, patientRef, patientInput);
  if (journey && journey.userId !== userId) {
    throw new ConnectError('That visit belongs to a different patient', 409, 'VISIT_PATIENT_MISMATCH');
  }

  try {
    const { entry } = await joinQueueEntry(
      today.queue.id,
      { userId, priority: priority as number, notes, journeyId: journey?.id ?? null, cleared },
      { origin: originOf(integration) },
      {
        // References first, so entry.joined already carries them.
        beforeEvent: async (entryId) => {
          if (!journey) await linkVisit(integration, visitRef, entryId);
          if (encounterRef) await linkRef(integration, 'encounter', entryId, encounterRef);
        },
      }
    );
    // The patient hears they're in, exactly as when they join themselves.
    await notifyEntry(entry.id, 'QUEUE_JOINED').catch((e) => console.error('join notification failed:', e));
    if (appointmentRef) await checkInAppointment(integration, appointmentRef, entry.id);
    return { status: 201, body: { entry: await entryView(integration.id, entry.id) } };
  } catch (error) {
    if (!(error instanceof QueueActionError)) throw error;
    switch (error.code) {
      case 'LIMIT_REACHED': {
        const { message, limitType, current, limit } = error.body;
        throw new ConnectError(String(message), 403, 'LIMIT_REACHED', { limitType, current, limit });
      }
      case 'ALREADY_IN_QUEUE': {
        const existing = error.body.entry as { id: string };
        throw new ConnectError('This patient already has an open ticket in that queue for another visit', 409, 'ALREADY_IN_QUEUE', {
          entry: await entryView(integration.id, existing.id),
        });
      }
      case 'QUEUE_CLOSED':
        throw queueClosed();
      default:
        throw new ConnectError(error.message, error.status, error.code);
    }
  }
}

export const postEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await idempotent(req, res, () => createEntry(req));
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// POST /entries/by-ref/:type/:id/:action
// ---------------------------------------------------------------------------

const ACTIONS = {
  call: { status: 'SERVING', from: ['WAITING'] },
  complete: { status: 'SERVED', from: ['WAITING', 'SERVING'] },
  cancel: { status: 'CANCELLED', from: ['WAITING', 'SERVING'] },
  'no-show': { status: 'NO_SHOW', from: ['WAITING', 'SERVING'] },
} as const;
type ActionName = keyof typeof ACTIONS;
/** Phase 5 and 6 actions that don't just set a status. */
const OTHER_ACTIONS = ['transfer', 'priority', 'hold', 'resume', 'clear'] as const;
const ACTION_NAMES = [...Object.keys(ACTIONS), ...OTHER_ACTIONS];
const REF_TYPES = ['visit', 'encounter', 'entry'] as const;
type RefType = (typeof REF_TYPES)[number];

const entryNotFound = () => new ConnectError('No such entry', 404, 'ENTRY_NOT_FOUND');

async function entryInOrg(integration: Caller, entryId: string) {
  return prisma.queueEntry.findFirst({
    where: { id: entryId, queue: { service: { location: { organizationId: integration.organizationId } } } },
    select: { id: true, status: true, queueId: true, heldAt: true, awaitingClearance: true, queue: { select: { serviceId: true } } },
  });
}

/** The entry a by-ref call addresses. For a visit: the entry being served,
 * else the one waiting longest, among `serviceId`'s entries when given. */
async function resolveEntry(
  integration: Caller,
  type: RefType,
  id: string,
  serviceId?: string | string[] | null,
  opts: { preferHeld?: boolean } = {}
) {
  if (type !== 'visit') {
    const entryId = type === 'entry' ? id : await klargyIdFor(integration.id, 'encounter', id);
    const entry = entryId ? await entryInOrg(integration, entryId) : null;
    if (!entry) throw entryNotFound();
    return entry;
  }
  const journey = await journeyForVisit(integration, id);
  const open = journey
    ? await prisma.queueEntry.findMany({
        where: {
          id: { in: journey.queueEntryIds },
          status: { in: [...OPEN] },
          ...(serviceId ? { queue: { serviceId: Array.isArray(serviceId) ? { in: serviceId } : serviceId } } : {}),
        },
        orderBy: { joinedAt: 'asc' },
        select: { id: true },
      })
    : [];
  const rows = await Promise.all(open.map((o) => entryInOrg(integration, o.id)));
  const entry =
    (opts.preferHeld ? rows.find((e) => e?.status === 'WAITING' && e.heldAt) : undefined) ??
    rows.find((e) => e?.status === 'SERVING') ??
    rows.find((e) => e?.status === 'WAITING');
  if (!entry) {
    throw new ConnectError(
      serviceId ? 'That visit has no waiting or serving entry for that service' : 'That visit has no waiting or serving entry',
      404,
      'NO_OPEN_ENTRY'
    );
  }
  return entry;
}

/** The optional `service` that narrows a visit's by-ref call to one
 * service's entries (phase 5): an EMR or Klargy service id. */
async function serviceSelector(integration: Caller, value: unknown, field = 'service') {
  const ref = text(value, field, false);
  return ref ? (await resolveService(integration, ref)).id : null;
}

/** The desk (service point instance) to call to: the named service point's
 * desk for this service, preferring the one the staff member sits at, then
 * a free one. */
async function resolveDesk(integration: Caller, value: string, serviceId: string, staffUserId: string | null) {
  const mapped = await klargyIdFor(integration.id, 'service_point', value);
  const point = await prisma.servicePoint.findFirst({
    where: { id: mapped ?? value, organizationId: integration.organizationId },
    select: { id: true },
  });
  if (!point) throw new ConnectError('That service point isn’t matched to a Klargy service point', 404, 'SERVICE_POINT_NOT_MAPPED');
  const link = await prisma.servicePointService.findFirst({
    where: { servicePointId: point.id, serviceId, isActive: true, servicePoint: { isActive: true } },
    include: { instances: { where: { isActive: true }, orderBy: { instanceNumber: 'asc' } } },
  });
  const desks = link?.instances ?? [];
  const desk =
    (staffUserId && desks.find((d) => d.occupiedByUserId === staffUserId)) || desks.find((d) => !d.isOccupied) || desks[0];
  if (!desk) throw new ConnectError('That service point doesn’t serve this entry’s service', 422, 'INVALID_SERVICE_POINT');
  return desk.id;
}

async function staffUserFor(integration: Caller, value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const userId = await klargyIdFor(integration.id, 'staff', value);
  if (!userId) return null;
  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId: integration.organizationId, role: { not: 'PATIENT' } },
    select: { id: true },
  });
  return user?.id ?? null;
}

/** The desks a staff member is signed in to right now, with their service. */
async function staffDesks(userId: string) {
  const desks = await prisma.servicePointInstance.findMany({
    where: { occupiedByUserId: userId, isOccupied: true, isActive: true, servicePointService: { isActive: true, servicePoint: { isActive: true } } },
    orderBy: { occupiedAt: 'desc' },
    select: { id: true, servicePointService: { select: { serviceId: true } } },
  });
  return (desks ?? []).map((d) => ({ id: d.id, serviceId: d.servicePointService.serviceId }));
}

const inOtherService = (entryServiceId: string) =>
  new ConnectError(
    'That patient’s open ticket is in another service than the staff member’s room. Transfer it there first.',
    409,
    'ENTRY_IN_OTHER_SERVICE',
    { service: entryServiceId }
  );

/**
 * The entry a call or resume addresses and the desk to call it to (phase 6):
 * `servicePoint` picks the room; else `staff` calls into the room that staff
 * member is signed in to, choosing the visit's entry in that room's service.
 * Without either (or when the staff member is in no room) there's no desk.
 */
async function entryAndDesk(
  integration: Caller,
  type: RefType,
  ref: string,
  body: Record<string, unknown>,
  actorUserId: string | null,
  opts: { preferHeld?: boolean } = {}
) {
  const servicePointRef = text(body.servicePoint, 'servicePoint', false);
  const narrowed = await serviceSelector(integration, body.service);
  const desks = !servicePointRef && actorUserId ? await staffDesks(actorUserId) : [];
  let entry: Awaited<ReturnType<typeof resolveEntry>>;
  if (type === 'visit' && !narrowed && desks.length) {
    try {
      entry = await resolveEntry(integration, type, ref, desks.map((d) => d.serviceId), opts);
    } catch (error) {
      if (!(error instanceof ConnectError) || error.code !== 'NO_OPEN_ENTRY') throw error;
      entry = await resolveEntry(integration, type, ref, null, opts);
    }
  } else {
    entry = await resolveEntry(integration, type, ref, narrowed, opts);
  }
  let desk: string | null = null;
  if (servicePointRef) {
    desk = await resolveDesk(integration, servicePointRef, entry.queue.serviceId, actorUserId);
  } else if (desks.length) {
    const here = desks.find((d) => d.serviceId === entry.queue.serviceId);
    if (!here) throw inOtherService(entry.queue.serviceId);
    desk = here.id;
  }
  return { entry, desk };
}

function priorityValue(value: unknown, required: boolean): number | undefined {
  if (value === undefined || value === null) {
    if (required) throw badRequest('priority is required');
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw badRequest('priority must be a whole number from 0 to 100');
  }
  return value as number;
}

function refusal(error: QueueActionError): never {
  if (error.code === 'NOT_WAITING' || error.code === 'INVALID_TRANSITION') {
    throw new ConnectError('The entry changed status before this could be applied', 409, 'INVALID_TRANSITION');
  }
  if (error.code === 'INVALID_SERVICE_POINT') throw new ConnectError(error.message, 422, 'INVALID_SERVICE_POINT');
  if (error.code === 'AWAITING_CLEARANCE') throw new ConnectError('This entry is awaiting payment and can’t be called until it is cleared', 409, 'AWAITING_CLEARANCE');
  if (error.code === 'LIMIT_REACHED') {
    const { message, limitType, current, limit } = error.body;
    throw new ConnectError(String(message), 403, 'LIMIT_REACHED', { limitType, current, limit });
  }
  throw new ConnectError(error.message, error.status, error.code);
}

/** POST …/transfer (phase 5): completes the entry and issues a ticket for
 * `to` in the same visit. */
async function transferByRef(integration: Caller, type: RefType, id: string, body: Record<string, unknown>): Promise<Result> {
  const toRef = text(body.to, 'to')!;
  const priority = priorityValue(body.priority, false);
  const encounterRef = text(body.encounter, 'encounter', false);
  const staffRef = text(body.staff, 'staff', false);
  const reason = text(body.reason, 'reason', false);
  const cleared = clearedFlag(body.cleared);
  const fromServiceId = await serviceSelector(integration, body.service);
  const target = await resolveService(integration, toRef);

  // Already there: the visit's open entry in `to` is the answer, so retries
  // (and a second automation run) change nothing.
  let journeyId: string | null | undefined;
  if (type === 'visit') {
    journeyId = (await journeyForVisit(integration, id))?.id;
  } else {
    const entryId = type === 'entry' ? id : await klargyIdFor(integration.id, 'encounter', id);
    journeyId = entryId
      ? (await prisma.queueEntry.findUnique({ where: { id: entryId }, select: { journeyId: true } }))?.journeyId
      : null;
  }
  if (journeyId) {
    const journey = await prisma.customerJourney.findUnique({ where: { id: journeyId }, select: { queueEntryIds: true } });
    const there = journey
      ? await prisma.queueEntry.findFirst({
          where: { id: { in: journey.queueEntryIds }, status: { in: [...OPEN] }, queue: { serviceId: target.id } },
          orderBy: { joinedAt: 'asc' },
          select: { id: true },
        })
      : null;
    if (there) {
      if (encounterRef) await linkRef(integration, 'encounter', there.id, encounterRef);
      if (cleared) await clearEntry(there.id, { origin: originOf(integration) });
      return { status: 200, body: { entry: await entryView(integration.id, there.id), from: null } };
    }
  }

  const source = await resolveEntry(integration, type, id, fromServiceId);
  if (!(OPEN as readonly string[]).includes(source.status)) {
    throw new ConnectError(`An entry that is ${source.status} can’t be transferred`, 409, 'INVALID_TRANSITION', {
      status: source.status,
    });
  }

  if (target.location.organization.status === 'PAUSED' || !target.isActive) throw queueClosed();
  const today = await getOrCreateQueueForDate(target.id);
  if (!today || today.queue.status !== 'ACTIVE') throw queueClosed();

  const patient = await prisma.queueEntry.findUnique({ where: { id: source.id }, select: { userId: true } });
  const elsewhere = patient
    ? await prisma.queueEntry.findFirst({
        where: { queueId: today.queue.id, userId: patient.userId, status: { in: [...OPEN] } },
        select: { id: true },
      })
    : null;
  if (elsewhere) {
    throw new ConnectError('This patient already has an open ticket in that queue for another visit', 409, 'ALREADY_IN_QUEUE', {
      entry: await entryView(integration.id, elsewhere.id),
    });
  }

  const actorUserId = await staffUserFor(integration, staffRef);
  let newEntryId: string;
  try {
    await checkEntryLimits(integration.organizationId);
    const { entry } = await transferEntryToService(source.id, target.id, {
      actorUserId,
      priority,
      completeSource: true,
      requireOpenSource: true,
      origin: originOf(integration),
      data: reason ? { reason } : undefined,
      cleared,
    });
    newEntryId = entry.id;
  } catch (error) {
    if (error instanceof QueueActionError) refusal(error);
    if (!(error instanceof TransferError)) throw error;
    if (error.code === 'QUEUE_CLOSED') throw queueClosed();
    if (error.code === 'INVALID_TRANSITION') throw new ConnectError(error.message, 409, 'INVALID_TRANSITION');
    throw new ConnectError(error.message, error.status, error.code);
  }
  if (encounterRef) await linkRef(integration, 'encounter', newEntryId, encounterRef);
  // The patient hears about the new ticket, as when they first joined.
  await notifyEntry(newEntryId, 'QUEUE_JOINED').catch((e) => console.error('join notification failed:', e));
  const [entry, from] = await entryViews(integration.id, [newEntryId, source.id]);
  return { status: 201, body: { entry, from } };
}

/** POST …/priority (phase 5). */
async function priorityByRef(integration: Caller, type: RefType, id: string, body: Record<string, unknown>): Promise<Result> {
  const priority = priorityValue(body.priority, true)!;
  const encounterRef = text(body.encounter, 'encounter', false);
  const staffRef = text(body.staff, 'staff', false);
  const reason = text(body.reason, 'reason', false);
  const entry = await resolveEntry(integration, type, id, await serviceSelector(integration, body.service));
  if (encounterRef) await linkRef(integration, 'encounter', entry.id, encounterRef);
  if (!(OPEN as readonly string[]).includes(entry.status)) {
    throw new ConnectError(`The priority of an entry that is ${entry.status} can’t be changed`, 409, 'INVALID_TRANSITION', {
      status: entry.status,
    });
  }
  try {
    await setEntryPriority(entry.id, priority, {
      actorUserId: await staffUserFor(integration, staffRef),
      origin: originOf(integration),
      data: reason ? { reason } : undefined,
    });
  } catch (error) {
    if (error instanceof QueueActionError) refusal(error);
    throw error;
  }
  return { status: 200, body: { entry: await entryView(integration.id, entry.id) } };
}

/** POST …/hold, …/resume, …/clear (phase 6). Each returns 200 and changes
 * nothing when the entry is already in that state. */
async function gateByRef(
  integration: Caller,
  action: 'hold' | 'resume' | 'clear',
  type: RefType,
  ref: string,
  body: Record<string, unknown>
): Promise<Result> {
  const encounterRef = text(body.encounter, 'encounter', false);
  const staffRef = text(body.staff, 'staff', false);
  const reason = text(body.reason, 'reason', false);
  const actorUserId = await staffUserFor(integration, staffRef);
  const ctx = { actorUserId, origin: originOf(integration), data: reason ? { reason } : undefined };

  let entry: Awaited<ReturnType<typeof resolveEntry>>;
  let desk: string | null = null;
  if (action === 'resume') {
    ({ entry, desk } = await entryAndDesk(integration, type, ref, body, actorUserId, { preferHeld: true }));
  } else {
    entry = await resolveEntry(integration, type, ref, await serviceSelector(integration, body.service));
  }
  if (encounterRef) await linkRef(integration, 'encounter', entry.id, encounterRef);

  const refuse = (what: string) => {
    throw new ConnectError(`An entry that is ${entry.status}${entry.heldAt ? ' (on hold)' : ''} can’t be ${what}`, 409, 'INVALID_TRANSITION', {
      status: entry.status,
    });
  };
  try {
    if (action === 'hold') {
      if (!(entry.status === 'WAITING' && entry.heldAt)) {
        if (entry.status !== 'SERVING') refuse('put on hold');
        await holdEntry(entry.id, ctx);
      }
    } else if (action === 'resume') {
      if (entry.status !== 'SERVING') {
        if (!(entry.status === 'WAITING' && entry.heldAt)) refuse('resumed');
        await resumeEntry(entry.id, { servicePointInstanceId: desk }, ctx);
      }
    } else if (entry.awaitingClearance) {
      if (entry.status !== 'WAITING') refuse('cleared');
      await clearEntry(entry.id, ctx);
    }
  } catch (error) {
    if (!(error instanceof QueueActionError)) throw error;
    refusal(error);
  }
  return { status: 200, body: { entry: await entryView(integration.id, entry.id) } };
}

async function moveEntry(req: Request): Promise<Result> {
  const integration = caller(req);
  const { type, id, action } = req.params;
  if (!REF_TYPES.includes(type as RefType)) throw badRequest(`type must be one of: ${REF_TYPES.join(', ')}`);
  if (!ACTION_NAMES.includes(action)) throw badRequest(`action must be one of: ${ACTION_NAMES.join(', ')}`);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const ref = text(id, 'id')!;
  if (action === 'transfer') return transferByRef(integration, type as RefType, ref, body);
  if (action === 'priority') return priorityByRef(integration, type as RefType, ref, body);
  if (action === 'hold' || action === 'resume' || action === 'clear') return gateByRef(integration, action, type as RefType, ref, body);

  const step = ACTIONS[action as ActionName];
  const encounterRef = text(body.encounter, 'encounter', false);
  const staffRef = text(body.staff, 'staff', false);
  const reason = text(body.reason, 'reason', false);
  const actorUserId = await staffUserFor(integration, staffRef);

  let entry: Awaited<ReturnType<typeof resolveEntry>>;
  let desk: string | null = null;
  if (action === 'call') {
    ({ entry, desk } = await entryAndDesk(integration, type as RefType, ref, body, actorUserId));
  } else {
    entry = await resolveEntry(integration, type as RefType, ref, await serviceSelector(integration, body.service));
  }
  if (encounterRef) await linkRef(integration, 'encounter', entry.id, encounterRef);

  // Already there: nothing to do, so retries are safe.
  if (entry.status === step.status) return { status: 200, body: { entry: await entryView(integration.id, entry.id) } };
  if (!(step.from as readonly string[]).includes(entry.status)) {
    throw new ConnectError(`An entry that is ${entry.status} can’t be moved with ${action}`, 409, 'INVALID_TRANSITION', {
      status: entry.status,
    });
  }

  const ctx = { actorUserId, origin: originOf(integration), data: reason ? { reason } : undefined };
  const onlyFrom = [...step.from];
  try {
    if (action === 'call') {
      await callEntry(entry.queueId, { entryId: entry.id, servicePointInstanceId: desk }, ctx);
    } else if (action === 'complete') {
      await serveEntry(entry.queueId, entry.id, ctx, { onlyFrom });
    } else {
      await endEntry(entry.queueId, entry.id, step.status as 'CANCELLED' | 'NO_SHOW', ctx, { onlyFrom });
    }
  } catch (error) {
    if (!(error instanceof QueueActionError)) throw error;
    refusal(error);
  }
  return { status: 200, body: { entry: await entryView(integration.id, entry.id) } };
}

export const postEntryByRef = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await idempotent(req, res, () => moveEntry(req));
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// POST /entries/serving/link (phase 6)
// ---------------------------------------------------------------------------

/**
 * Links a walk-in to the EMR: the entry being served right now at the desk
 * the staff member is signed in to gets the EMR's patient and visit (and
 * encounter, when given). For a receptionist who started a visit in the EMR
 * for the person in front of them.
 */
async function linkServing(req: Request): Promise<Result> {
  const integration = caller(req);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const staffRef = text(body.staff, 'staff')!;
  const refs = (body.refs && typeof body.refs === 'object' ? body.refs : {}) as Record<string, unknown>;
  const patientRef = refString(refs, 'patient', true)!;
  const visitRef = refString(refs, 'visit', true)!;
  const encounterRef = refString(refs, 'encounter', false);
  const patientInput = body.patient === undefined || body.patient === null ? undefined : parsePatient(body.patient);

  const noServing = () =>
    new ConnectError('Nobody is being served at that staff member’s desk', 404, 'NO_SERVING_ENTRY');
  const userId = await staffUserFor(integration, staffRef);
  if (!userId) throw noServing();
  const desks = await staffDesks(userId);
  const serving = desks.length
    ? await prisma.queueEntry.findFirst({
        where: {
          status: 'SERVING',
          servicePointInstanceId: { in: desks.map((d) => d.id) },
          queue: { service: { location: { organizationId: integration.organizationId } } },
        },
        orderBy: { calledAt: 'desc' },
        select: { id: true, userId: true, journeyId: true },
      })
    : null;
  if (!serving) throw noServing();

  // The visit belongs to one patient: one already linked to someone else's
  // journey can't be linked here.
  const knownJourney = await klargyIdFor(integration.id, 'visit', visitRef);
  if (knownJourney && knownJourney !== serving.journeyId) {
    const other = await prisma.customerJourney.findUnique({ where: { id: knownJourney }, select: { userId: true } });
    const knownPatient = await klargyIdFor(integration.id, 'patient', patientRef);
    if (other && other.userId !== serving.userId && other.userId !== knownPatient) {
      throw new ConnectError('That visit belongs to a different patient', 409, 'VISIT_PATIENT_MISMATCH');
    }
  }

  // The person at the desk is this EMR patient from now on.
  await linkRef(integration, 'patient', serving.userId, patientRef);
  if (patientInput) {
    const existing = await prisma.user.findUnique({ where: { id: serving.userId }, select: { identityData: true } });
    await prisma.user.update({
      where: { id: serving.userId },
      data: {
        firstName: patientInput.firstName,
        lastName: patientInput.lastName,
        ...(patientInput.phone !== undefined ? { phone: patientInput.phone } : {}),
        identityData: identityData(existing?.identityData, patientInput) as object,
      },
    });
  }
  let journeyId = serving.journeyId;
  if (!journeyId) {
    await startJourney(serving.id);
    journeyId = (await prisma.queueEntry.findUnique({ where: { id: serving.id }, select: { journeyId: true } }))?.journeyId ?? null;
  }
  if (journeyId) await linkRef(integration, 'visit', journeyId, visitRef);
  if (encounterRef) await linkRef(integration, 'encounter', serving.id, encounterRef);
  return { status: 200, body: { entry: await entryView(integration.id, serving.id) } };
}

export const postServingLink = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await idempotent(req, res, () => linkServing(req));
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// GET /entries/by-ref/:type/:id
// ---------------------------------------------------------------------------

/** The entry a by-ref action would move, without moving it. */
export const getEntryByRef = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    const { type, id } = req.params;
    if (!REF_TYPES.includes(type as RefType)) throw badRequest(`type must be one of: ${REF_TYPES.join(', ')}`);
    const entry = await resolveEntry(integration, type as RefType, text(id, 'id')!, await serviceSelector(integration, req.query.service));
    res.json({ entry: await entryView(integration.id, entry.id) });
  } catch (error) {
    handle(error, res, next);
  }
};

// ---------------------------------------------------------------------------
// GET /entries
// ---------------------------------------------------------------------------

export const listEntries = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = caller(req);
    const sinceRaw = text(req.query.updatedSince, 'updatedSince')!;
    const since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) throw badRequest('updatedSince must be an ISO 8601 time');
    const visitRef = text(req.query.visit, 'visit', false);

    let onlyIds: string[] | undefined;
    if (visitRef) {
      const journey = await journeyForVisit(integration, visitRef);
      if (!journey) return res.json({ entries: [], nextUpdatedSince: since.toISOString() });
      onlyIds = journey.queueEntryIds;
    }

    const rows = await prisma.queueEntry.findMany({
      where: {
        updatedAt: { gt: since },
        queue: { service: { location: { organizationId: integration.organizationId } } },
        ...(onlyIds ? { id: { in: onlyIds } } : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: MAX_PAGE,
      select: { id: true, updatedAt: true },
    });

    // A full page may stop part-way through entries changed at the same
    // instant; leave those for the next page so none are skipped.
    let page = rows;
    if (rows.length === MAX_PAGE) {
      const last = rows[rows.length - 1].updatedAt.getTime();
      const trimmed = rows.filter((r) => r.updatedAt.getTime() < last);
      if (trimmed.length > 0) page = trimmed;
    }

    res.json({
      entries: await entryViews(integration.id, page.map((r) => r.id)),
      nextUpdatedSince: (page.length ? page[page.length - 1].updatedAt : since).toISOString(),
    });
  } catch (error) {
    handle(error, res, next);
  }
};
