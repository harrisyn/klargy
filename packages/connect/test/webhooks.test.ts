import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_HEADERS,
  WebhookVerificationError,
  isOwnEcho,
  lookupMatch,
  lookupNoMatch,
  lookupResponseFor,
  signPayload,
  signedHeaders,
  verifyLookupRequest,
  verifyWebhook,
  type WebhookEvent,
} from '../src/index';

const SECRET = 'whsec_' + 'b'.repeat(48);
const NOW = new Date('2026-10-14T13:05:00.000Z');
const TS = Math.floor(NOW.getTime() / 1000);

const event = {
  id: 'd1',
  event: 'entry.called',
  createdAt: NOW.toISOString(),
  data: {
    entryId: 'e1',
    ticketNumber: 'G012',
    status: 'SERVING',
    origin: { type: 'integration', integrationId: 'int-1' },
    refs: { patient: 'P1', visit: 'V1' },
  },
};
const raw = JSON.stringify(event);

function failure(fn: () => unknown): WebhookVerificationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error;
    throw error;
  }
  throw new Error('expected a WebhookVerificationError');
}

describe('signPayload', () => {
  it('is the hex HMAC-SHA256 of "<timestamp>.<raw body>", as Klargy computes it', () => {
    const expected = createHmac('sha256', SECRET).update(`${TS}.${raw}`).digest('hex');
    expect(signPayload(SECRET, TS, raw)).toBe(expected);
    expect(signPayload(SECRET, String(TS), Buffer.from(raw))).toBe(expected);
    expect(signPayload(SECRET, TS, new TextEncoder().encode(raw))).toBe(expected);
  });
});

describe('verifyWebhook', () => {
  const headers = signedHeaders({ secret: SECRET, rawBody: raw, event: 'entry.called', id: 'd1', timestamp: TS });

  it('accepts a signed delivery and returns the typed body', () => {
    const verified = verifyWebhook({ secret: SECRET, headers, rawBody: raw, now: NOW });
    expect(verified).toEqual(event);
    if (verified.event === 'entry.called') expect(verified.data.ticketNumber).toBe('G012');
  });

  it('reads headers in any case, from Headers, Node-style objects or arrays', () => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(verifyWebhook({ secret: SECRET, headers: lower, rawBody: raw, now: NOW }).id).toBe('d1');
    expect(verifyWebhook({ secret: SECRET, headers: new Headers(headers), rawBody: Buffer.from(raw), now: NOW }).id).toBe('d1');
    const arrays = { ...lower, 'x-webhook-signature': [lower['x-webhook-signature']] };
    expect(verifyWebhook({ secret: SECRET, headers: arrays, rawBody: raw, now: NOW.getTime() }).id).toBe('d1');
  });

  it('rejects a changed body, a wrong secret and a malformed signature with 401', () => {
    const tampered = failure(() => verifyWebhook({ secret: SECRET, headers, rawBody: raw.replace('G012', 'G013'), now: NOW }));
    expect(tampered.reason).toBe('invalid_signature');
    expect(tampered.status).toBe(401);
    expect(failure(() => verifyWebhook({ secret: 'whsec_other', headers, rawBody: raw, now: NOW })).reason).toBe('invalid_signature');
    const bad = { ...headers, [WEBHOOK_HEADERS.signature]: 'md5=abc' };
    expect(failure(() => verifyWebhook({ secret: SECRET, headers: bad, rawBody: raw, now: NOW })).reason).toBe('invalid_signature');
  });

  it('rejects missing headers', () => {
    const { [WEBHOOK_HEADERS.signature]: _drop, ...rest } = headers;
    expect(failure(() => verifyWebhook({ secret: SECRET, headers: rest, rawBody: raw, now: NOW })).reason).toBe('missing_header');
  });

  it('enforces the 5 minute window both ways, and a custom tolerance', () => {
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
    expect(verifyWebhook({ secret: SECRET, headers, rawBody: raw, now: at(300) }).id).toBe('d1');
    expect(verifyWebhook({ secret: SECRET, headers, rawBody: raw, now: at(-300) }).id).toBe('d1');
    expect(failure(() => verifyWebhook({ secret: SECRET, headers, rawBody: raw, now: at(301) })).reason).toBe('timestamp_out_of_range');
    expect(failure(() => verifyWebhook({ secret: SECRET, headers, rawBody: raw, now: at(-301) })).reason).toBe('timestamp_out_of_range');
    expect(failure(() => verifyWebhook({ secret: SECRET, headers, rawBody: raw, now: at(61), toleranceSeconds: 60 })).status).toBe(401);
    const junk = { ...headers, [WEBHOOK_HEADERS.timestamp]: '2026-10-14' };
    expect(failure(() => verifyWebhook({ secret: SECRET, headers: junk, rawBody: raw, now: NOW })).reason).toBe('invalid_timestamp');
  });

  it('rejects a signed body that is not the event in the header (400)', () => {
    const other = signedHeaders({ secret: SECRET, rawBody: raw, event: 'entry.served', timestamp: TS });
    const error = failure(() => verifyWebhook({ secret: SECRET, headers: other, rawBody: raw, now: NOW }));
    expect(error.reason).toBe('invalid_body');
    expect(error.status).toBe(400);
    const notJson = 'not json';
    const h = signedHeaders({ secret: SECRET, rawBody: notJson, event: 'ping', timestamp: TS });
    expect(failure(() => verifyWebhook({ secret: SECRET, headers: h, rawBody: notJson, now: NOW })).status).toBe(400);
  });

  it('refuses a lookup request', () => {
    const body = JSON.stringify({ identifierType: 'mrNumber', identifier: 'NH-1', context: 'staff', locationRef: null });
    const h = signedHeaders({ secret: SECRET, rawBody: body, event: 'patient.lookup', timestamp: TS });
    expect(failure(() => verifyWebhook({ secret: SECRET, headers: h, rawBody: body, now: NOW })).reason).toBe('unexpected_event');
  });

  it('accepts the admin ping', () => {
    const ping = JSON.stringify({ id: 'd2', event: 'ping', createdAt: NOW.toISOString(), data: { message: 'Test delivery' } });
    const h = signedHeaders({ secret: SECRET, rawBody: ping, event: 'ping', id: 'd2', timestamp: TS });
    expect(verifyWebhook({ secret: SECRET, headers: h, rawBody: ping, now: NOW }).event).toBe('ping');
  });

  it('spots echoes of the integration’s own calls', () => {
    expect(isOwnEcho(event as WebhookEvent, 'int-1')).toBe(true);
    expect(isOwnEcho(event as WebhookEvent, 'int-2')).toBe(false);
    const staff = { ...event, data: { ...event.data, origin: { type: 'staff', integrationId: null } } } as WebhookEvent;
    expect(isOwnEcho(staff, 'int-1')).toBe(false);
  });
});

describe('verifyLookupRequest', () => {
  const lookup = (body: Record<string, unknown>, event = 'patient.lookup') => {
    const rawBody = JSON.stringify(body);
    return { secret: SECRET, rawBody, headers: signedHeaders({ secret: SECRET, rawBody, event, id: 'l1', timestamp: TS }), now: NOW };
  };

  it('returns the request', () => {
    const req = verifyLookupRequest(lookup({ identifierType: 'mrNumber', identifier: ' NH-004512 ', context: 'staff', locationRef: 'LOC1' }));
    expect(req).toEqual({
      id: 'l1',
      timestamp: TS,
      identifierType: 'mrNumber',
      identifier: 'NH-004512',
      context: 'staff',
      locationRef: 'LOC1',
    });
  });

  it('rejects another event, a bad signature (401) and a bad body (400)', () => {
    expect(failure(() => verifyLookupRequest(lookup({ identifierType: 'mrNumber', identifier: 'x', context: 'staff' }, 'entry.called'))).reason).toBe(
      'unexpected_event'
    );
    const signed = lookup({ identifierType: 'mrNumber', identifier: 'x', context: 'staff' });
    expect(failure(() => verifyLookupRequest({ ...signed, secret: 'whsec_wrong' })).status).toBe(401);
    expect(failure(() => verifyLookupRequest(lookup({ identifierType: 'email', identifier: 'x', context: 'staff' }))).status).toBe(400);
    expect(failure(() => verifyLookupRequest(lookup({ identifierType: 'phone', identifier: '', context: 'staff' }))).status).toBe(400);
    expect(failure(() => verifyLookupRequest(lookup({ identifierType: 'phone', identifier: '1', context: 'kiosk' }))).status).toBe(400);
    expect(failure(() => verifyLookupRequest(lookup({ identifierType: 'patientRef', identifier: 'P1', context: 'public' }))).status).toBe(400);
  });

  it('rejects a stale lookup', () => {
    const signed = lookup({ identifierType: 'mrNumber', identifier: 'x', context: 'staff' });
    expect(failure(() => verifyLookupRequest({ ...signed, now: new Date(NOW.getTime() + 6 * 60_000) })).reason).toBe('timestamp_out_of_range');
  });
});

describe('lookup responses', () => {
  const patient = {
    ref: 'P1',
    displayName: 'Ama Mensah',
    firstName: 'Ama',
    mrNumber: 'NH-004512',
    birthDate: '1988-04-02',
    phoneMasked: '024••••19',
    cover: { payer: 'NHIS', status: 'active' as const, expiresOn: '2027-01-31', checkedVia: 'payer' as const },
    flags: ['has_open_visit'],
  };

  it('builds the staff answers', () => {
    expect(lookupMatch(patient)).toEqual({ matched: true, patient, candidates: [] });
    expect(lookupNoMatch()).toEqual({ matched: false, patient: null, candidates: [] });
    const many = Array.from({ length: 7 }, (_, i) => ({ ref: `P${i}`, displayName: `Patient ${i}` }));
    expect(lookupNoMatch(many).candidates).toHaveLength(5);
  });

  it('keeps only matched and the first name in public context', () => {
    expect(lookupResponseFor({ context: 'public' }, lookupMatch(patient))).toEqual({
      matched: true,
      patient: { firstName: 'Ama' },
      candidates: [],
    });
    expect(lookupResponseFor('public', lookupNoMatch([{ ref: 'P1', displayName: 'Ama' }]))).toEqual({
      matched: false,
      patient: null,
      candidates: [],
    });
    expect(lookupResponseFor('staff', lookupMatch(patient))).toEqual(lookupMatch(patient));
  });
});
