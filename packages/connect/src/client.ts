import { randomUUID } from 'node:crypto';
import { CONNECT_BASE_PATH } from './contract';
import { ConnectError, ConnectNetworkError, type ConnectErrorBody } from './errors';
import type {
  Analytics,
  AnalyticsQuery,
  AppointmentInput,
  AppointmentResult,
  CatalogInput,
  CatalogPublishResult,
  ConnectMe,
  CreateEntryInput,
  CreateEntryResult,
  DeskLaunchInput,
  DeskLaunchResult,
  Entry,
  EntryAction,
  EntryActionInput,
  EntryRefType,
  EntryResult,
  KlargyCatalog,
  ListEntriesQuery,
  ListEntriesResult,
  Mapping,
  MappingResourceType,
  PatientInput,
  PriorityInput,
  PutPatientResult,
  RegisterIntegrationInput,
  RegisterIntegrationResult,
  ServiceStatusInput,
  ServingLinkInput,
  ServiceStatusResult,
  TransferInput,
  TransferResult,
} from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KlargyConnectOptions {
  /**
   * The organisation's Klargy address, e.g. `https://acme.klargy.com`. The
   * Connect path (`/api/v1/connect/v1`) is added unless the URL already ends
   * with it.
   */
  baseUrl: string;
  /** `klg_live_…` integration API key. */
  apiKey: string;
  /** Defaults to the global fetch (Node 18+). */
  fetch?: FetchLike;
  /** Per attempt, in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /**
   * Extra attempts for calls that are safe to repeat (GET, PUT, the service
   * status call, and POSTs sent with an Idempotency-Key). Default 2.
   */
  retries?: number;
  /** First backoff delay in milliseconds, doubled per retry. Default 500. */
  retryDelayMs?: number;
  /** Longest wait the client accepts (backoff or Retry-After) before giving up. Default 30 000. */
  maxRetryDelayMs?: number;
}

/** Options for calls that accept an Idempotency-Key. */
export interface IdempotentCallOptions {
  /**
   * Sent as `Idempotency-Key` (at most 255 characters). Defaults to a new
   * UUID per call, so the client's own retries are safe; pass your own to
   * make retries across process restarts safe too, or `false` to send none
   * (the call is then not retried).
   */
  idempotencyKey?: string | false;
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /** Safe to repeat. */
  retry: boolean;
}

interface RawResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (value: string | Date | undefined) => (value instanceof Date ? value.toISOString() : value);
const seg = (value: string) => encodeURIComponent(value);

function normalizeBaseUrl(raw: string): string {
  if (!raw) throw new TypeError('baseUrl is required');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('baseUrl must be an http(s) URL');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(CONNECT_BASE_PATH) ? path : `${path}${CONNECT_BASE_PATH}`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Klargy Connect v1 client (docs/connect/v1.md). One instance per
 * integration key; safe to share.
 */
export class KlargyConnect {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: KlargyConnectOptions) {
    if (!options?.apiKey) throw new TypeError('apiKey is required');
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new TypeError('No fetch available: pass options.fetch');
    this.fetchImpl = options.fetch ? options.fetch : (input, init) => f(input, init);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Phase 1: key, registration, catalogue, mappings
  // -------------------------------------------------------------------------

  /** `GET /me`: checks the key ("Test connection"). */
  async me(): Promise<ConnectMe> {
    return (await this.request<ConnectMe>('GET', '/me', { retry: true })).body;
  }

  /** `PUT /integration`: self-registration. Idempotent; call on every settings save. */
  async registerIntegration(input: RegisterIntegrationInput): Promise<RegisterIntegrationResult> {
    return (await this.request<RegisterIntegrationResult>('PUT', '/integration', { body: input, retry: true })).body;
  }

  /** `PUT /catalog`: replaces the published catalogue. */
  async publishCatalog(catalog: CatalogInput): Promise<CatalogPublishResult> {
    return (await this.request<CatalogPublishResult>('PUT', '/catalog', { body: catalog, retry: true })).body;
  }

  /** `GET /catalog`: Klargy's own locations, services and service points. */
  async getCatalog(): Promise<KlargyCatalog> {
    return (await this.request<KlargyCatalog>('GET', '/catalog', { retry: true })).body;
  }

  /** `GET /mappings`: the admin's mappings, or one resource type's references. */
  async getMappings(query: { resourceType?: MappingResourceType } = {}): Promise<Mapping[]> {
    const res = await this.request<{ mappings: Mapping[] }>('GET', '/mappings', {
      query: { resourceType: query.resourceType },
      retry: true,
    });
    return res.body.mappings;
  }

  // -------------------------------------------------------------------------
  // Phase 2: patients and entries
  // -------------------------------------------------------------------------

  /** `PUT /patients/{patientId}`: creates or updates the Klargy patient. */
  async putPatient(patientId: string, patient: PatientInput): Promise<PutPatientResult> {
    return (await this.request<PutPatientResult>('PUT', `/patients/${seg(patientId)}`, { body: patient, retry: true })).body;
  }

  /** `POST /entries`: issues a ticket for an EMR visit. */
  async createEntry(input: CreateEntryInput, options: IdempotentCallOptions = {}): Promise<CreateEntryResult> {
    const res = await this.request<{ entry: Entry }>('POST', '/entries', this.idempotent(input, options));
    return { entry: res.body.entry, created: res.status === 201, replayed: isReplayed(res.headers) };
  }

  /** `POST /entries/by-ref/{type}/{id}/{action}` for call, complete, cancel, no-show, hold, resume and clear. */
  async entryAction(
    type: EntryRefType,
    id: string,
    action: Exclude<EntryAction, 'transfer' | 'priority'>,
    input: EntryActionInput = {},
    options: IdempotentCallOptions = {}
  ): Promise<EntryResult> {
    const res = await this.request<{ entry: Entry }>('POST', byRefPath(type, id, action), this.idempotent(input, options));
    return { entry: res.body.entry, replayed: isReplayed(res.headers) };
  }

  /** Calls the entry (WAITING to SERVING). `servicePoint` picks the desk. */
  callEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'call', input, options);
  }

  /** Completes the entry (SERVED); the service's flow runs. */
  completeEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'complete', input, options);
  }

  /** Cancels the entry. */
  cancelEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'cancel', input, options);
  }

  /** Marks the entry as not here (NO_SHOW). */
  noShowEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'no-show', input, options);
  }

  /** Puts the entry being served on hold: it leaves the room and keeps its place (`entry.held`). */
  holdEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'hold', input, options);
  }

  /** Calls a held entry back to `servicePoint`, `staff`'s room or the room it was held in (`entry.resumed`). */
  resumeEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'resume', input, options);
  }

  /** Payment settled: lets an entry awaiting clearance into the line (`entry.cleared`). */
  clearEntry(type: EntryRefType, id: string, input?: EntryActionInput, options?: IdempotentCallOptions) {
    return this.entryAction(type, id, 'clear', input, options);
  }

  /**
   * `POST /entries/serving/link`: links the entry being served in `staff`'s
   * room to the EMR's patient, visit (and encounter). 404 NO_SERVING_ENTRY when there is none.
   */
  async linkServingEntry(input: ServingLinkInput, options: IdempotentCallOptions = {}): Promise<EntryResult> {
    const res = await this.request<{ entry: Entry }>('POST', '/entries/serving/link', this.idempotent(input, options));
    return { entry: res.body.entry, replayed: isReplayed(res.headers) };
  }

  /** `POST …/transfer`: completes the entry and issues a ticket for `to` in the same visit. */
  async transferEntry(type: EntryRefType, id: string, input: TransferInput, options: IdempotentCallOptions = {}): Promise<TransferResult> {
    const res = await this.request<{ entry: Entry; from: Entry | null }>(
      'POST',
      byRefPath(type, id, 'transfer'),
      this.idempotent(input, options)
    );
    return { entry: res.body.entry, from: res.body.from ?? null, created: res.status === 201, replayed: isReplayed(res.headers) };
  }

  /** `POST …/priority`: sets the open entry's priority (0 to 100). */
  async setEntryPriority(type: EntryRefType, id: string, input: PriorityInput, options: IdempotentCallOptions = {}): Promise<EntryResult> {
    const res = await this.request<{ entry: Entry }>('POST', byRefPath(type, id, 'priority'), this.idempotent(input, options));
    return { entry: res.body.entry, replayed: isReplayed(res.headers) };
  }

  /** `GET /entries/by-ref/{type}/{id}`: the entry a by-ref action would move, with a fresh `position`. */
  async getEntryByRef(type: EntryRefType, id: string, query: { service?: string } = {}): Promise<Entry> {
    const res = await this.request<{ entry: Entry }>('GET', `/entries/by-ref/${seg(type)}/${seg(id)}`, {
      query: { service: query.service },
      retry: true,
    });
    return res.body.entry;
  }

  /** `GET /entries`: one page of entries changed after `updatedSince`, oldest change first. */
  async listEntries(query: ListEntriesQuery): Promise<ListEntriesResult> {
    const res = await this.request<ListEntriesResult>('GET', '/entries', {
      query: { updatedSince: iso(query.updatedSince), visit: query.visit },
      retry: true,
    });
    return res.body;
  }

  /**
   * Every entry changed after `updatedSince`, page by page, until a page is
   * empty. The same entry can appear twice if it changed again meanwhile.
   * Keep the last `nextUpdatedSince` (passed to `onPage`) for the next run.
   */
  async *iterateEntries(
    query: ListEntriesQuery & { onPage?: (page: ListEntriesResult) => void | Promise<void> }
  ): AsyncGenerator<Entry, void, undefined> {
    let since = iso(query.updatedSince)!;
    for (;;) {
      const page = await this.listEntries({ updatedSince: since, visit: query.visit });
      await query.onPage?.(page);
      if (page.entries.length === 0) return;
      for (const entry of page.entries) yield entry;
      if (page.nextUpdatedSince === since) return;
      since = page.nextUpdatedSince;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: desk
  // -------------------------------------------------------------------------

  /** `POST /desk/launch`: a one-time desk URL for the practitioner signed in to the EMR. Not retried. */
  async launchDesk(input: DeskLaunchInput): Promise<DeskLaunchResult> {
    return (await this.request<DeskLaunchResult>('POST', '/desk/launch', { body: input, retry: false })).body;
  }

  // -------------------------------------------------------------------------
  // Phase 5: appointments, analytics, service status
  // -------------------------------------------------------------------------

  /** `PUT /appointments/{appointmentRef}`: creates or updates the Klargy appointment. */
  async putAppointment(appointmentRef: string, input: AppointmentInput): Promise<AppointmentResult> {
    const res = await this.request<{ appointment: AppointmentResult['appointment'] }>(
      'PUT',
      `/appointments/${seg(appointmentRef)}`,
      { body: input, retry: true }
    );
    return { appointment: res.body.appointment, created: res.status === 201 };
  }

  /** `GET /analytics`: queue numbers for a range (today when no range is given). */
  async getAnalytics(query: AnalyticsQuery = {}): Promise<Analytics> {
    const res = await this.request<Analytics>('GET', '/analytics', {
      query: { from: iso(query.from), to: iso(query.to), location: query.location, service: query.service },
      retry: true,
    });
    return res.body;
  }

  /** `POST /services/{service}/status`: pauses or reopens today's queue. Asking for the current status changes nothing. */
  async setServiceStatus(service: string, input: ServiceStatusInput): Promise<ServiceStatusResult> {
    return (await this.request<ServiceStatusResult>('POST', `/services/${seg(service)}/status`, { body: input, retry: true }))
      .body;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private idempotent(body: unknown, options: IdempotentCallOptions): RequestOptions {
    const key = options.idempotencyKey === false ? undefined : options.idempotencyKey ?? randomUUID();
    return { body, idempotencyKey: key, retry: !!key };
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<RawResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const attempts = options.retry ? this.retries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), { method, headers, body: payload, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        const failure = new ConnectNetworkError(
          timedOut ? `Klargy Connect did not answer within ${this.timeoutMs} ms` : `Could not reach Klargy Connect: ${(error as Error)?.message ?? error}`,
          timedOut,
          error
        );
        if (last || !(await this.backoff(attempt))) throw failure;
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        clearTimeout(timer);
        const failure = new ConnectNetworkError('The response from Klargy Connect was cut off', controller.signal.aborted, error);
        if (last || !(await this.backoff(attempt))) throw failure;
        continue;
      }
      clearTimeout(timer);
      const body = parseBody(text);

      if (response.ok) return { status: response.status, headers: response.headers, body: body as T };

      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      const error = new ConnectError(response.status, body as ConnectErrorBody | string | null, retryAfter);
      const retryable = RETRY_STATUSES.has(response.status) || error.code === 'IDEMPOTENCY_IN_PROGRESS';
      if (last || !retryable || !(await this.backoff(attempt, retryAfter))) throw error;
    }
  }

  /** Waits before the next attempt; false when the wait would be too long. */
  private async backoff(attempt: number, retryAfterSeconds?: number): Promise<boolean> {
    const delay = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : this.retryDelayMs * 2 ** (attempt - 1);
    if (delay > this.maxRetryDelayMs) return false;
    if (delay > 0) await sleep(delay);
    return true;
  }
}

function byRefPath(type: EntryRefType, id: string, action: EntryAction) {
  return `/entries/by-ref/${seg(type)}/${seg(id)}/${seg(action)}`;
}

function isReplayed(headers: Headers) {
  return headers.get('Idempotent-Replayed') === 'true';
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
