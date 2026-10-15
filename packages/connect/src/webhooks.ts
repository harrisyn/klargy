import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Entry, EntryPatient, EntryRefs, NamedRef } from './types';

// Klargy's signed requests to the EMR (docs/connect/v1.md sections 4 and 7):
// webhooks and the patient lookup call share one scheme.
//
//   X-Webhook-Id:        delivery id (a retry reuses it), or a new uuid per lookup
//   X-Webhook-Event:     event name, or "patient.lookup"
//   X-Webhook-Timestamp: unix seconds
//   X-Webhook-Signature: sha256=<hex HMAC-SHA256(signingSecret, "<timestamp>.<raw body>")>

export const WEBHOOK_HEADERS = {
  id: 'X-Webhook-Id',
  event: 'X-Webhook-Event',
  timestamp: 'X-Webhook-Timestamp',
  signature: 'X-Webhook-Signature',
} as const;

/** Events Klargy sends to the integration's webhook endpoint. */
export const WEBHOOK_EVENTS = [
  'entry.joined',
  'entry.called',
  'entry.served',
  'entry.cancelled',
  'entry.no_show',
  'entry.transferred',
  'entry.priority_changed',
  'queue.paused',
  'queue.resumed',
  'appointment.created',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.checked_in',
  'journey.completed',
  'servicepoint.opened',
  'servicepoint.closed',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** The admin's "Send test" button. */
export const PING_EVENT = 'ping' as const;
/** X-Webhook-Event of the patient lookup call. */
export const LOOKUP_EVENT = 'patient.lookup' as const;

/** Receivers reject a timestamp further than this from their clock. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface EventOrigin {
  /** staff (someone in Klargy), public (kiosk or phone), integration (a Connect call), system (automatic). */
  type: 'staff' | 'public' | 'integration' | 'system';
  integrationId: string | null;
}

interface WithOrigin {
  origin: EventOrigin;
}

/** Entry events. `refs` is only sent to the integration's own endpoint. */
export type EntryEventData = Omit<Entry, 'refs'> &
  WithOrigin & {
    refs?: EntryRefs;
    /** A by-ref call's `reason`. */
    reason?: string;
    [extra: string]: unknown;
  };

export type EntryTransferredData = EntryEventData & { fromEntryId: string; fromServiceId: string; toServiceId: string };
export type EntryPriorityChangedData = EntryEventData & { priority: number; previousPriority: number };
export type AppointmentCheckedInData = EntryEventData & { appointmentId: string; patientId: string };

/**
 * appointment.created / rescheduled / cancelled. Appointments synced through
 * `PUT /appointments` carry `patientId`, `serviceId`, `startTime`, `endTime`,
 * `status` (and `fromStartTime` when rescheduled); ones booked in Klargy carry
 * `slotStart` (`fromSlotStart` and `toSlotStart` when rescheduled).
 */
export interface AppointmentEventData extends WithOrigin {
  appointmentId: string;
  patientId?: string;
  serviceId?: string;
  startTime?: string;
  endTime?: string | null;
  status?: string;
  fromStartTime?: string;
  slotStart?: string;
  fromSlotStart?: string;
  toSlotStart?: string;
  refs?: Partial<EntryRefs>;
  [extra: string]: unknown;
}

export interface JourneyCompletedData extends WithOrigin {
  journeyId: string;
  completedAt: string;
  /** Minutes. */
  totalDuration: number;
  patient: EntryPatient;
  refs?: { patient: string | null; visit: string | null };
}

export interface ServicePointEventData extends WithOrigin {
  servicePoint: NamedRef;
  /** Whoever sat at the desk. */
  staff: NamedRef;
  refs?: { servicePoint: string | null; staff: string | null };
}

export interface QueueStatusEventData extends WithOrigin {
  queueId: string;
  service: NamedRef;
  location: NamedRef;
  reason: string | null;
  refs?: { service: string | null; location: string | null };
}

export interface WebhookDataMap {
  'entry.joined': EntryEventData;
  'entry.called': EntryEventData;
  'entry.served': EntryEventData;
  'entry.cancelled': EntryEventData;
  'entry.no_show': EntryEventData;
  'entry.transferred': EntryTransferredData;
  'entry.priority_changed': EntryPriorityChangedData;
  'queue.paused': QueueStatusEventData;
  'queue.resumed': QueueStatusEventData;
  'appointment.created': AppointmentEventData;
  'appointment.rescheduled': AppointmentEventData;
  'appointment.cancelled': AppointmentEventData;
  'appointment.checked_in': AppointmentCheckedInData;
  'journey.completed': JourneyCompletedData;
  'servicepoint.opened': ServicePointEventData;
  'servicepoint.closed': ServicePointEventData;
  ping: { message: string };
}

/** A webhook body: `{id, event, createdAt, data}`. Narrow on `event`. */
export type WebhookEvent = {
  [E in keyof WebhookDataMap]: { id: string; event: E; createdAt: string; data: WebhookDataMap[E] };
}[keyof WebhookDataMap];

/**
 * True for events caused by this integration's own Connect calls, which an
 * EMR must ignore (they echo its own changes).
 */
export function isOwnEcho(event: WebhookEvent, integrationId: string): boolean {
  const origin = (event.data as Partial<WithOrigin>).origin;
  return !!origin && origin.type === 'integration' && origin.integrationId === integrationId;
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

export type RawBody = string | Uint8Array;
export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

/** Hex HMAC-SHA256 of `<timestamp>.<raw body>`: what X-Webhook-Signature carries after `sha256=`. */
export function signPayload(secret: string, timestamp: string | number, rawBody: RawBody): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return hmac.digest('hex');
}

/** Headers for a request signed the way Klargy signs, for tests and local tools. */
export function signedHeaders(options: {
  secret: string;
  rawBody: RawBody;
  event: string;
  id?: string;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
}): Record<string, string> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    'Content-Type': 'application/json',
    [WEBHOOK_HEADERS.id]: options.id ?? randomUUID(),
    [WEBHOOK_HEADERS.event]: options.event,
    [WEBHOOK_HEADERS.timestamp]: timestamp,
    [WEBHOOK_HEADERS.signature]: `sha256=${signPayload(options.secret, timestamp, options.rawBody)}`,
  };
}

export type VerificationFailure =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_range'
  | 'invalid_signature'
  | 'unexpected_event'
  | 'invalid_body';

/** A request that isn't Klargy's (401) or whose body is unusable (400). */
export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
  readonly reason: VerificationFailure;

  constructor(reason: VerificationFailure, message: string) {
    super(message);
    this.reason = reason;
  }

  /** What to answer: 400 for a bad body, else 401. */
  get status(): 400 | 401 {
    return this.reason === 'invalid_body' ? 400 : 401;
  }
}

export interface VerifyOptions {
  /** The signing secret `PUT /integration` returned. */
  secret: string;
  /** The request headers (Fetch Headers, Node's IncomingHttpHeaders, or any object). */
  headers: HeaderBag;
  /** The exact bytes received, before any JSON parsing. */
  rawBody: RawBody;
  /** Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** The receiver's clock (a Date, or milliseconds since the epoch). Default now. */
  now?: Date | number;
}

export interface VerifiedRequest {
  id: string;
  event: string;
  /** Unix seconds from X-Webhook-Timestamp. */
  timestamp: number;
}

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return value ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const lower = name.toLowerCase();
  const key = Object.keys(bag).find((k) => k.toLowerCase() === lower);
  const value = key === undefined ? undefined : bag[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Checks the headers and signature of any Klargy-signed request. */
export function verifySignedRequest(options: VerifyOptions): VerifiedRequest {
  if (!options.secret) throw new TypeError('secret is required');
  const id = header(options.headers, WEBHOOK_HEADERS.id);
  const event = header(options.headers, WEBHOOK_HEADERS.event);
  const timestampRaw = header(options.headers, WEBHOOK_HEADERS.timestamp);
  const signature = header(options.headers, WEBHOOK_HEADERS.signature);
  if (!id || !event || !timestampRaw || !signature) {
    throw new WebhookVerificationError('missing_header', 'Missing X-Webhook-Id, X-Webhook-Event, X-Webhook-Timestamp or X-Webhook-Signature');
  }
  if (!/^\d{1,12}$/.test(timestampRaw.trim())) {
    throw new WebhookVerificationError('invalid_timestamp', 'X-Webhook-Timestamp is not unix seconds');
  }
  const timestamp = Number(timestampRaw.trim());
  const nowMs = options.now === undefined ? Date.now() : options.now instanceof Date ? options.now.getTime() : options.now;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowMs / 1000 - timestamp) > tolerance) {
    throw new WebhookVerificationError('timestamp_out_of_range', `X-Webhook-Timestamp is more than ${tolerance} seconds from now`);
  }

  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  const expected = Buffer.from(signPayload(options.secret, timestampRaw.trim(), options.rawBody), 'hex');
  const given = match ? Buffer.from(match[1], 'hex') : null;
  if (!given || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new WebhookVerificationError('invalid_signature', 'X-Webhook-Signature does not match the body');
  }
  return { id, event, timestamp };
}

function parseJson(rawBody: RawBody): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    throw new WebhookVerificationError('invalid_body', 'The body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookVerificationError('invalid_body', 'The body is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verifies a webhook from Klargy and returns its body. Throws
 * WebhookVerificationError (answer `error.status`). De-duplicate on the
 * returned `id` (X-Webhook-Id): a retry reuses it.
 */
export function verifyWebhook(options: VerifyOptions): WebhookEvent {
  const verified = verifySignedRequest(options);
  if (verified.event === LOOKUP_EVENT) {
    throw new WebhookVerificationError('unexpected_event', 'This is a patient lookup request; use verifyLookupRequest');
  }
  const body = parseJson(options.rawBody);
  if (body.event !== verified.event || typeof body.data !== 'object' || body.data === null) {
    throw new WebhookVerificationError('invalid_body', 'The body is not a Klargy event');
  }
  return { ...body, id: typeof body.id === 'string' ? body.id : verified.id } as WebhookEvent;
}
