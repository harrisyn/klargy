import type { Entry, EntryStatus } from './types';

/** Machine-readable `code`s Klargy Connect sends with an error. */
export const CONNECT_ERROR_CODES = [
  // POST /entries, transfer, appointments
  'SERVICE_NOT_MAPPED',
  'QUEUE_CLOSED',
  'PATIENT_REQUIRED',
  'LIMIT_REACHED',
  'VISIT_PATIENT_MISMATCH',
  'ALREADY_IN_QUEUE',
  // Idempotency-Key
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  // By-ref actions
  'ENTRY_NOT_FOUND',
  'NO_OPEN_ENTRY',
  'INVALID_TRANSITION',
  'SERVICE_POINT_NOT_MAPPED',
  'INVALID_SERVICE_POINT',
  'NOT_FOUND',
  // Desk launch
  'ORIGIN_NOT_ALLOWED',
  'STAFF_INACTIVE',
  // Analytics
  'LOCATION_NOT_MAPPED',
] as const;
export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

/** The JSON body of a refusal: `{error, code?, ...}`. */
export interface ConnectErrorBody {
  error: string;
  code?: ConnectErrorCode | (string & {});
  /** LIMIT_REACHED */
  limitType?: string;
  current?: number;
  limit?: number | null;
  /** ALREADY_IN_QUEUE: the patient's open ticket in that queue. */
  entry?: Entry;
  /** INVALID_TRANSITION: the entry's current status. */
  status?: EntryStatus;
  /** 403 when the organisation's plan lacks EMR connections: "emrIntegration". */
  feature?: string;
  [extra: string]: unknown;
}

/** Klargy answered with a non-2xx status. */
export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  /** HTTP status. */
  readonly status: number;
  /** Machine-readable code, when Klargy sent one. */
  readonly code: ConnectErrorCode | (string & {}) | undefined;
  /** The parsed response body (or the raw text when it wasn't JSON). */
  readonly body: ConnectErrorBody | string | null;
  /** Seconds from a `Retry-After` header (429), if any. */
  readonly retryAfter: number | undefined;

  constructor(status: number, body: ConnectErrorBody | string | null, retryAfter?: number) {
    const message =
      body && typeof body === 'object' && typeof body.error === 'string' ? body.error : `Klargy Connect answered HTTP ${status}`;
    super(message);
    this.status = status;
    this.body = body;
    this.code = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : undefined;
    this.retryAfter = retryAfter;
  }

  /** True when this error carries `code`. */
  is(code: ConnectErrorCode): boolean {
    return this.code === code;
  }

  private field<K extends keyof ConnectErrorBody>(key: K): ConnectErrorBody[K] | undefined {
    return this.body && typeof this.body === 'object' ? this.body[key] : undefined;
  }

  /** ALREADY_IN_QUEUE: the open ticket the patient already has. */
  get entry(): Entry | undefined {
    return this.field('entry');
  }

  /** INVALID_TRANSITION: the entry's current status, when Klargy sent it. */
  get entryStatus(): EntryStatus | undefined {
    return this.field('status');
  }

  /** LIMIT_REACHED details. */
  get limitInfo(): { limitType?: string; current?: number; limit?: number | null } | undefined {
    if (!this.is('LIMIT_REACHED')) return undefined;
    return { limitType: this.field('limitType'), current: this.field('current'), limit: this.field('limit') };
  }
}

/** No answer from Klargy: the network failed or the request timed out. */
export class ConnectNetworkError extends Error {
  override readonly name = 'ConnectNetworkError';
  readonly timedOut: boolean;
  override readonly cause: unknown;

  constructor(message: string, timedOut: boolean, cause?: unknown) {
    super(message);
    this.timedOut = timedOut;
    this.cause = cause;
  }
}

/** Narrows `error` to a ConnectError, optionally with a given code. */
export function isConnectError(error: unknown, code?: ConnectErrorCode): error is ConnectError {
  return error instanceof ConnectError && (code === undefined || error.code === code);
}
