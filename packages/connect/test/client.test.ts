import { describe, expect, it, vi } from 'vitest';
import { ConnectError, ConnectNetworkError, KlargyConnect, isConnectError } from '../src/index';

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A fetch that answers from a queue and records calls. */
function mockFetch(...answers: (Response | Error | (() => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  return { fetch, calls };
}

const KEY = 'klg_live_' + 'a'.repeat(40);
const entry = { entryId: 'e1', ticketNumber: 'G012', status: 'WAITING', refs: { visit: 'V1' } };

function client(fetch: ReturnType<typeof mockFetch>['fetch'], extra: Record<string, unknown> = {}) {
  return new KlargyConnect({ baseUrl: 'https://acme.klargy.com', apiKey: KEY, fetch, retryDelayMs: 0, ...extra });
}

const headersOf = (call: Call) => call.init.headers as Record<string, string>;

describe('KlargyConnect', () => {
  it('adds the Connect path to a workspace URL, and keeps one that has it', () => {
    const { fetch } = mockFetch();
    expect(client(fetch).baseUrl).toBe('https://acme.klargy.com/api/v1/connect/v1');
    expect(new KlargyConnect({ baseUrl: 'https://acme.klargy.com/api/v1/connect/v1/', apiKey: KEY, fetch }).baseUrl).toBe(
      'https://acme.klargy.com/api/v1/connect/v1'
    );
    expect(() => new KlargyConnect({ baseUrl: 'https://x', apiKey: '', fetch })).toThrow(/apiKey/);
  });

  it('sends the key as a bearer token and returns /me', async () => {
    const me = { contract: 'klargy-connect/v1', organization: { id: 'o', name: 'Acme', slug: 'acme' }, integration: {} };
    const { fetch, calls } = mockFetch(json(200, me));
    expect(await client(fetch).me()).toEqual(me);
    expect(calls[0].url).toBe('https://acme.klargy.com/api/v1/connect/v1/me');
    expect(calls[0].init.method).toBe('GET');
    expect(headersOf(calls[0]).Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.body).toBeUndefined();
  });

  it('registers with PUT /integration and publishes the catalogue', async () => {
    const { fetch, calls } = mockFetch(
      json(200, { integrationId: 'i1', signingSecret: 'whsec_x', webhookEvents: ['entry.joined'] }),
      json(200, { received: { locations: 1, services: 0, servicePoints: 0, practitioners: 0, registrationFields: 0 } })
    );
    const c = client(fetch);
    const reg = await c.registerIntegration({ webhookUrl: 'https://emr.example.com/hook', embedOrigins: ['https://emr.example.com'] });
    expect(reg.signingSecret).toBe('whsec_x');
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      webhookUrl: 'https://emr.example.com/hook',
      embedOrigins: ['https://emr.example.com'],
    });
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
    await c.publishCatalog({ locations: [{ id: 'L1', name: 'Airport Clinic' }] });
    expect(calls[1].url).toMatch(/\/catalog$/);
    expect(calls[1].init.method).toBe('PUT');
  });

  it('lists mappings with an optional type and unwraps them', async () => {
    const { fetch, calls } = mockFetch(json(200, { mappings: [{ resourceType: 'patient', klargyId: 'u1', externalId: 'P1' }] }));
    const mappings = await client(fetch).getMappings({ resourceType: 'patient' });
    expect(mappings).toHaveLength(1);
    expect(calls[0].url).toBe('https://acme.klargy.com/api/v1/connect/v1/mappings?resourceType=patient');
  });

  it('encodes path segments', async () => {
    const { fetch, calls } = mockFetch(
      json(200, { patientId: 'P/1', klargyId: 'u1', created: false }),
      json(200, { queueId: 'q', status: 'PAUSED', changed: true })
    );
    const c = client(fetch);
    await c.putPatient('P/1', { firstName: 'Ama', lastName: 'Mensah' });
    expect(calls[0].url).toMatch(/\/patients\/P%2F1$/);
    await c.setServiceStatus('L1:lab', { status: 'PAUSED' });
    expect(calls[1].url).toMatch(/\/services\/L1%3Alab\/status$/);
  });

  it('creates an entry with an Idempotency-Key and reports created and replayed', async () => {
    const { fetch, calls } = mockFetch(json(201, { entry }), json(200, { entry }, { 'Idempotent-Replayed': 'true' }));
    const c = client(fetch);
    const input = { refs: { patient: 'P1', visit: 'V1' }, patient: { firstName: 'Ama', lastName: 'Mensah' }, service: 'S1' };
    const first = await c.createEntry(input, { idempotencyKey: 'visit-V1-S1' });
    expect(first).toEqual({ entry, created: true, replayed: false });
    expect(headersOf(calls[0])['Idempotency-Key']).toBe('visit-V1-S1');
    const again = await c.createEntry(input, { idempotencyKey: 'visit-V1-S1' });
    expect(again).toEqual({ entry, created: false, replayed: true });
  });

  it('generates an Idempotency-Key per call by default, and sends none when told not to', async () => {
    const { fetch, calls } = mockFetch(json(201, { entry }), json(201, { entry }), json(201, { entry }));
    const c = client(fetch);
    const input = { refs: { patient: 'P1', visit: 'V1' }, service: 'S1' };
    await c.createEntry(input);
    await c.createEntry(input);
    const [a, b] = [headersOf(calls[0])['Idempotency-Key'], headersOf(calls[1])['Idempotency-Key']];
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
    await c.createEntry(input, { idempotencyKey: false });
    expect(headersOf(calls[2])['Idempotency-Key']).toBeUndefined();
  });

  it('posts by-ref actions to their paths with the body', async () => {
    const { fetch, calls } = mockFetch(json(200, { entry }), json(200, { entry }), json(200, { entry }), json(200, { entry }));
    const c = client(fetch);
    await c.callEntry('visit', 'V1', { servicePoint: 'R3', staff: 'PR1', service: 'S1' });
    expect(calls[0].url).toMatch(/\/entries\/by-ref\/visit\/V1\/call$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ servicePoint: 'R3', staff: 'PR1', service: 'S1' });
    await c.completeEntry('encounter', 'ENC-9');
    expect(calls[1].url).toMatch(/\/by-ref\/encounter\/ENC-9\/complete$/);
    expect(calls[1].init.body).toBe('{}');
    await c.cancelEntry('entry', 'e1', { reason: 'Left' });
    expect(calls[2].url).toMatch(/\/by-ref\/entry\/e1\/cancel$/);
    await c.noShowEntry('visit', 'V1');
    expect(calls[3].url).toMatch(/\/by-ref\/visit\/V1\/no-show$/);
  });

  it('holds, resumes and clears by ref, and links the entry being served', async () => {
    const { fetch, calls } = mockFetch(json(200, { entry }), json(200, { entry }), json(200, { entry }), json(200, { entry }));
    const c = client(fetch);
    await c.holdEntry('visit', 'V1', { reason: 'Gone for a sample' });
    expect(calls[0].url).toMatch(/\/by-ref\/visit\/V1\/hold$/);
    expect(headersOf(calls[0])['Idempotency-Key']).toBeTruthy();
    await c.resumeEntry('visit', 'V1', { staff: 'PR1' });
    expect(calls[1].url).toMatch(/\/by-ref\/visit\/V1\/resume$/);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ staff: 'PR1' });
    await c.clearEntry('encounter', 'ENC-9');
    expect(calls[2].url).toMatch(/\/by-ref\/encounter\/ENC-9\/clear$/);
    const linked = await c.linkServingEntry({ staff: 'PR2', refs: { patient: 'P1', visit: 'V1' } });
    expect(linked).toEqual({ entry, replayed: false });
    expect(calls[3].url).toMatch(/\/connect\/v1\/entries\/serving\/link$/);
    expect(calls[3].init.method).toBe('POST');
    expect(JSON.parse(calls[3].init.body as string)).toEqual({ staff: 'PR2', refs: { patient: 'P1', visit: 'V1' } });
  });

  it('sends cleared on create and transfer, and reports the journey errors', async () => {
    const { fetch, calls } = mockFetch(
      json(201, { entry }),
      json(201, { entry, from: null }),
      json(409, { error: 'In another service', code: 'ENTRY_IN_OTHER_SERVICE', service: 's-lab' }),
      json(404, { error: 'Nobody is being served', code: 'NO_SERVING_ENTRY' })
    );
    const c = client(fetch);
    await c.createEntry({ service: 'CLIN-GP', refs: { patient: 'P1', visit: 'V1' }, cleared: true });
    expect(JSON.parse(calls[0].init.body as string).cleared).toBe(true);
    await c.transferEntry('visit', 'V1', { to: 'CLIN-GP', cleared: true });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ to: 'CLIN-GP', cleared: true });
    const other = await c.callEntry('visit', 'V1', { staff: 'PR1' }).catch((e) => e);
    expect(other).toBeInstanceOf(ConnectError);
    expect(other.code).toBe('ENTRY_IN_OTHER_SERVICE');
    expect(other.body.service).toBe('s-lab');
    const none = await c.linkServingEntry({ staff: 'PR2', refs: { patient: 'P1', visit: 'V1' } }).catch((e) => e);
    expect(none.status).toBe(404);
    expect(none.code).toBe('NO_SERVING_ENTRY');
  });

  it('transfers and reports the completed entry', async () => {
    const from = { ...entry, status: 'SERVED' };
    const { fetch, calls } = mockFetch(json(201, { entry, from }), json(200, { entry, from: null }));
    const c = client(fetch);
    const moved = await c.transferEntry('visit', 'V1', { to: 'LAB', reason: 'Lab orders' });
    expect(moved).toEqual({ entry, from, created: true, replayed: false });
    expect(calls[0].url).toMatch(/\/by-ref\/visit\/V1\/transfer$/);
    const already = await c.transferEntry('visit', 'V1', { to: 'LAB' });
    expect(already.created).toBe(false);
    expect(already.from).toBeNull();
  });

  it('sets the priority', async () => {
    const { fetch, calls } = mockFetch(json(200, { entry }));
    await client(fetch).setEntryPriority('visit', 'V1', { priority: 50 });
    expect(calls[0].url).toMatch(/\/by-ref\/visit\/V1\/priority$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ priority: 50 });
  });

  it('reads an entry by ref with the service selector as a query', async () => {
    const { fetch, calls } = mockFetch(json(200, { entry }));
    expect(await client(fetch).getEntryByRef('visit', 'V1', { service: 'S1' })).toEqual(entry);
    expect(calls[0].url).toBe('https://acme.klargy.com/api/v1/connect/v1/entries/by-ref/visit/V1?service=S1');
  });

  it('lists entries with a Date and pages until a page is empty', async () => {
    const { fetch, calls } = mockFetch(
      json(200, { entries: [entry, { ...entry, entryId: 'e2' }], nextUpdatedSince: '2026-10-14T10:00:00.000Z' }),
      json(200, { entries: [{ ...entry, entryId: 'e3' }], nextUpdatedSince: '2026-10-14T11:00:00.000Z' }),
      json(200, { entries: [], nextUpdatedSince: '2026-10-14T11:00:00.000Z' })
    );
    const pages: string[] = [];
    const ids: string[] = [];
    for await (const e of client(fetch).iterateEntries({
      updatedSince: new Date('2026-10-14T09:00:00.000Z'),
      visit: 'V1',
      onPage: (p) => void pages.push(p.nextUpdatedSince),
    })) {
      ids.push(e.entryId);
    }
    expect(ids).toEqual(['e1', 'e2', 'e3']);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0].url).searchParams.get('updatedSince')).toBe('2026-10-14T09:00:00.000Z');
    expect(new URL(calls[0].url).searchParams.get('visit')).toBe('V1');
    expect(new URL(calls[1].url).searchParams.get('updatedSince')).toBe('2026-10-14T10:00:00.000Z');
    expect(pages.at(-1)).toBe('2026-10-14T11:00:00.000Z');
  });

  it('launches the desk without retrying', async () => {
    const { fetch, calls } = mockFetch(json(503, { error: 'Down' }));
    await expect(
      client(fetch).launchDesk({ staff: { id: 'PR1', name: 'Ama Owusu' }, returnOrigin: 'https://emr.example.com' })
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/desk\/launch$/);
  });

  it('puts appointments and reports created', async () => {
    const appointment = { id: 'a1', status: 'booked' };
    const { fetch, calls } = mockFetch(json(201, { appointment }), json(200, { appointment }));
    const c = client(fetch);
    const input = { refs: { patient: 'P1' }, service: 'S1', startTime: new Date('2026-10-20T09:15:00Z') };
    expect(await c.putAppointment('APT-1', input)).toEqual({ appointment, created: true });
    expect(JSON.parse(calls[0].init.body as string).startTime).toBe('2026-10-20T09:15:00.000Z');
    expect((await c.putAppointment('APT-1', input)).created).toBe(false);
  });

  it('gets analytics with ISO times', async () => {
    const { fetch, calls } = mockFetch(json(200, { from: 'a', to: 'b', overall: {}, live: {}, services: [] }));
    await client(fetch).getAnalytics({ from: new Date('2026-10-01T00:00:00Z'), to: '2026-10-02T00:00:00Z', service: 'S1' });
    const q = new URL(calls[0].url).searchParams;
    expect(q.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(q.get('to')).toBe('2026-10-02T00:00:00Z');
    expect(q.get('service')).toBe('S1');
    expect(q.has('location')).toBe(false);
  });

  describe('errors', () => {
    it('throws ConnectError with status, code and body', async () => {
      const body = { error: 'That service isn’t matched to a Klargy service', code: 'SERVICE_NOT_MAPPED' };
      const { fetch } = mockFetch(json(404, body));
      const error = await client(fetch)
        .createEntry({ refs: { patient: 'P1', visit: 'V1' }, service: 'nope' })
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConnectError);
      expect(error).toMatchObject({ status: 404, code: 'SERVICE_NOT_MAPPED', body, message: body.error });
      expect(error.is('SERVICE_NOT_MAPPED')).toBe(true);
      expect(isConnectError(error, 'SERVICE_NOT_MAPPED')).toBe(true);
      expect(isConnectError(error, 'QUEUE_CLOSED')).toBe(false);
    });

    it('exposes LIMIT_REACHED details, the open entry for ALREADY_IN_QUEUE and the status for INVALID_TRANSITION', async () => {
      const { fetch } = mockFetch(
        json(403, { error: 'Limit', code: 'LIMIT_REACHED', limitType: 'queueEntriesDaily', current: 50, limit: 50 }),
        json(409, { error: 'Already', code: 'ALREADY_IN_QUEUE', entry }),
        json(409, { error: 'Cancelled', code: 'INVALID_TRANSITION', status: 'CANCELLED' })
      );
      const c = client(fetch);
      const input = { refs: { patient: 'P1', visit: 'V1' }, service: 'S1' };
      const limit = await c.createEntry(input, { idempotencyKey: false }).catch((e) => e);
      expect(limit.limitInfo).toEqual({ limitType: 'queueEntriesDaily', current: 50, limit: 50 });
      const already = await c.createEntry(input, { idempotencyKey: false }).catch((e) => e);
      expect(already.entry).toEqual(entry);
      const invalid = await c.completeEntry('entry', 'e1', {}, { idempotencyKey: false }).catch((e) => e);
      expect(invalid.entryStatus).toBe('CANCELLED');
    });

    it('keeps a non-JSON body as text', async () => {
      const { fetch } = mockFetch(new Response('Bad gateway', { status: 502 }));
      const error = await client(fetch, { retries: 0 }).me().catch((e) => e);
      expect(error).toMatchObject({ status: 502, code: undefined, body: 'Bad gateway' });
    });
  });

  describe('retries', () => {
    it('retries a GET on 503 and on a network failure', async () => {
      const { fetch, calls } = mockFetch(json(503, { error: 'Busy' }), new TypeError('fetch failed'), json(200, { mappings: [] }));
      expect(await client(fetch).getMappings()).toEqual([]);
      expect(calls).toHaveLength(3);
    });

    it('honours Retry-After on 429, and gives up when it is too long', async () => {
      const { fetch, calls } = mockFetch(json(429, { error: 'Slow down' }, { 'Retry-After': '0' }), json(200, { mappings: [] }));
      await client(fetch).getMappings();
      expect(calls).toHaveLength(2);

      const slow = mockFetch(json(429, { error: 'Slow down' }, { 'Retry-After': '120' }));
      const error = await client(slow.fetch).getMappings().catch((e) => e);
      expect(error).toMatchObject({ status: 429, retryAfter: 120 });
      expect(slow.calls).toHaveLength(1);
    });

    it('does not retry a 4xx refusal', async () => {
      const { fetch, calls } = mockFetch(json(400, { error: 'updatedSince is required' }));
      await expect(client(fetch).listEntries({ updatedSince: 'x' })).rejects.toBeInstanceOf(ConnectError);
      expect(calls).toHaveLength(1);
    });

    it('retries a POST only with an Idempotency-Key, reusing the same key', async () => {
      const withKey = mockFetch(new TypeError('socket hang up'), json(409, { error: 'Busy', code: 'IDEMPOTENCY_IN_PROGRESS' }), json(201, { entry }));
      const input = { refs: { patient: 'P1', visit: 'V1' }, service: 'S1' };
      expect((await client(withKey.fetch).createEntry(input)).created).toBe(true);
      expect(withKey.calls).toHaveLength(3);
      const keys = withKey.calls.map((c) => headersOf(c)['Idempotency-Key']);
      expect(new Set(keys).size).toBe(1);
      expect(withKey.calls.map((c) => c.init.body)).toEqual(Array(3).fill(withKey.calls[0].init.body));

      const noKey = mockFetch(new TypeError('socket hang up'));
      await expect(client(noKey.fetch).createEntry(input, { idempotencyKey: false })).rejects.toBeInstanceOf(ConnectNetworkError);
      expect(noKey.calls).toHaveLength(1);
    });

    it('stops after the configured retries', async () => {
      const { fetch, calls } = mockFetch(json(500, { error: 'x' }), json(500, { error: 'x' }));
      await expect(client(fetch, { retries: 1 }).me()).rejects.toMatchObject({ status: 500 });
      expect(calls).toHaveLength(2);
    });

    it('times out an attempt', async () => {
      const hang = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      const c = new KlargyConnect({ baseUrl: 'https://acme.klargy.com', apiKey: KEY, fetch: hang, timeoutMs: 10, retries: 0 });
      const error = await c.me().catch((e) => e);
      expect(error).toBeInstanceOf(ConnectNetworkError);
      expect(error.timedOut).toBe(true);
    });
  });
});
