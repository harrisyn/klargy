import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetaCloudProvider, TwilioWhatsAppProvider, WhatsAppWebProvider, buildWhatsAppProvider } from './providers';
import {
  consentKeyword,
  inSessionWindow,
  normalizeWhatsAppPhone,
  renderTemplateParams,
  shouldAdvanceStatus,
  templateKeyFor,
  templateUsable,
} from './util';

// Each provider's HTTP calls, against a mocked fetch.

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit & { headers: Record<string, string> } };
};

describe('Meta WhatsApp Cloud API', () => {
  const meta = new MetaCloudProvider({ phoneNumberId: '1065', businessAccountId: '1022', apiVersion: 'v21.0' }, { accessToken: 'EAAG-token', appSecret: 's' });

  it('sends an approved template with its body parameters', async () => {
    fetchMock.mockResolvedValue(reply(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC', message_status: 'accepted' }] }));
    const result = await meta.sendTemplate('233200000000', { name: 'queue_joined', language: 'en_US', variables: ['ticket', 'service'] }, ['C014', 'Consultation']);
    expect(result).toEqual({ success: true, messageId: 'wamid.ABC', status: 'QUEUED' });
    const { url, init } = lastCall();
    expect(url).toBe('https://graph.facebook.com/v21.0/1065/messages');
    expect(init.headers.Authorization).toBe('Bearer EAAG-token');
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '233200000000',
      type: 'template',
      template: {
        name: 'queue_joined',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'C014' }, { type: 'text', text: 'Consultation' }] }],
      },
    });
  });

  it('sends free-form text', async () => {
    fetchMock.mockResolvedValue(reply(200, { messages: [{ id: 'wamid.T' }] }));
    await meta.sendText('233200000000', 'Hello');
    expect(JSON.parse(String(lastCall().init.body))).toMatchObject({ type: 'text', text: { body: 'Hello', preview_url: true } });
  });

  it('reports a closed 24-hour window (131047)', async () => {
    fetchMock.mockResolvedValue(reply(400, { error: { code: 131047, message: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } } }));
    const result = await meta.sendText('233200000000', 'Hello');
    expect(result).toMatchObject({ success: false, code: '131047', outsideWindow: true });
    expect(result.error).toContain('More than 24 hours');
  });

  it('lists templates with their parameter count', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        data: [
          { name: 'queue_joined', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, ticket {{2}} for {{3}}.' }] },
          { name: 'promo', language: 'en', status: 'REJECTED', components: [] },
        ],
      })
    );
    const list = await meta.listTemplates();
    expect(lastCall().url).toContain('/v21.0/1022/message_templates?');
    expect(list).toEqual([
      { name: 'queue_joined', language: 'en_US', status: 'APPROVED', category: 'UTILITY', body: 'Hi {{1}}, ticket {{2}} for {{3}}.', paramCount: 3 },
      { name: 'promo', language: 'en', status: 'REJECTED', category: undefined, body: undefined, paramCount: 0 },
    ]);
  });

  it('tests the connection by reading the phone number', async () => {
    fetchMock.mockResolvedValue(reply(200, { verified_name: 'Nyaho Clinic', display_phone_number: '+233 20 000 0000', quality_rating: 'GREEN' }));
    expect(await meta.testConnection()).toEqual({ ok: true, message: 'Connected to Nyaho Clinic (+233 20 000 0000, quality green).' });
  });
});

describe('Twilio WhatsApp', () => {
  const twilio = new TwilioWhatsAppProvider(
    { accountSid: 'AC00000000000000000000000000000000', from: '+14155238886' },
    { authToken: 'tok' },
    'https://klargy.example/api/v1/webhooks/whatsapp/org1'
  );

  it('sends a Content template with numbered variables and a status callback', async () => {
    fetchMock.mockResolvedValue(reply(201, { sid: 'SM123', status: 'queued' }));
    const result = await twilio.sendTemplate(
      '233200000000',
      { name: 'queue_joined', language: 'en', variables: ['ticket', 'service'], contentSid: 'HX0123456789abcdef0123456789abcdef' },
      ['C014', 'Consultation']
    );
    expect(result).toEqual({ success: true, messageId: 'SM123', status: 'QUEUED' });
    const { url, init } = lastCall();
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC00000000000000000000000000000000:tok').toString('base64')}`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('To')).toBe('whatsapp:+233200000000');
    expect(form.get('From')).toBe('whatsapp:+14155238886');
    expect(form.get('ContentSid')).toBe('HX0123456789abcdef0123456789abcdef');
    expect(JSON.parse(form.get('ContentVariables')!)).toEqual({ 1: 'C014', 2: 'Consultation' });
    expect(form.get('StatusCallback')).toBe('https://klargy.example/api/v1/webhooks/whatsapp/org1');
  });

  it('needs a Content SID for a template', async () => {
    const result = await twilio.sendTemplate('233200000000', { name: 'x', language: 'en', variables: [] }, []);
    expect(result).toMatchObject({ success: false, code: 'NO_CONTENT_SID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a closed window (63016)', async () => {
    fetchMock.mockResolvedValue(reply(400, { code: 63016, message: 'Failed to send freeform message because you are outside the allowed window.' }));
    expect(await twilio.sendText('233200000000', 'Hi')).toMatchObject({ success: false, code: '63016', outsideWindow: true });
  });
});

describe('WhatsApp Web (go-whatsapp-web-multidevice, as in Serenity)', () => {
  beforeEach(() => vi.stubEnv('ALLOW_PRIVATE_OUTBOUND_URLS', 'true'));
  afterEach(() => vi.unstubAllEnvs());
  const web = new WhatsAppWebProvider({ baseUrl: 'http://wa.internal:3000', deviceId: 'clinic' }, { basicAuth: 'admin:pw' });

  it('posts /send/message to the phone JID with the device header and basic auth', async () => {
    fetchMock.mockResolvedValue(reply(200, { code: 'SUCCESS', results: { message_id: '3EB0ABC' } }));
    expect(await web.sendText('233200000000', 'Nyaho: hello')).toEqual({ success: true, messageId: '3EB0ABC', status: 'SENT' });
    const { url, init } = lastCall();
    expect(url).toBe('http://wa.internal:3000/send/message');
    expect(init.headers['X-Device-Id']).toBe('clinic');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('admin:pw').toString('base64')}`);
    expect(JSON.parse(String(init.body))).toEqual({ phone: '233200000000@s.whatsapp.net', message: 'Nyaho: hello' });
  });

  it('reports a device that is not linked', async () => {
    fetchMock.mockResolvedValue(reply(200, { code: 'SUCCESS', results: { is_connected: true, is_logged_in: false } }));
    // is_connected counts as linked, matching Serenity's adapter.
    expect((await web.testConnection()).ok).toBe(true);
    fetchMock.mockResolvedValue(reply(200, { code: 'SUCCESS', results: {} }));
    expect((await web.testConnection()).ok).toBe(false);
  });

  it('needs no templates', () => {
    expect(web.requiresTemplates).toBe(false);
  });
});

describe('buildWhatsAppProvider', () => {
  it('needs the required credentials', () => {
    expect(buildWhatsAppProvider('meta_cloud', { phoneNumberId: '1' }, {})).toBeNull();
    expect(buildWhatsAppProvider('meta_cloud', { phoneNumberId: '1' }, { accessToken: 't' })?.name).toBe('meta_cloud');
    expect(buildWhatsAppProvider('twilio', { accountSid: 'AC1' }, { authToken: 't' })?.name).toBe('twilio');
    expect(buildWhatsAppProvider('whatsapp_web', { baseUrl: 'https://wa.example' }, {})?.name).toBe('whatsapp_web');
    expect(buildWhatsAppProvider('nope', {}, {})).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes phone numbers to digits with the country code', () => {
    expect(normalizeWhatsAppPhone('+233 20 000 0000')).toBe('233200000000');
    expect(normalizeWhatsAppPhone('00233200000000')).toBe('233200000000');
    expect(normalizeWhatsAppPhone('020 000 0000', '233')).toBe('233200000000');
    expect(normalizeWhatsAppPhone('whatsapp:+14155238886')).toBe('14155238886');
    expect(normalizeWhatsAppPhone('233200000000@s.whatsapp.net')).toBe('233200000000');
    expect(normalizeWhatsAppPhone('12')).toBeNull();
    expect(normalizeWhatsAppPhone('')).toBeNull();
  });

  it('fills template parameters in order, never empty, on one line', () => {
    expect(renderTemplateParams(['ticket', 'position', 'servicePoint', 'message'], { ticket: 'C014', position: 2, message: 'Line one\nline two' })).toEqual([
      'C014',
      '2',
      '-',
      'Line one line two',
    ]);
  });

  it('maps notification types to template keys, with transfers separate', () => {
    expect(templateKeyFor('QUEUE_JOINED')).toBe('QUEUE_JOINED');
    expect(templateKeyFor('QUEUE_JOINED', { transferred: true })).toBe('QUEUE_TRANSFERRED');
    expect(templateKeyFor('NOW_SERVING')).toBe('NOW_SERVING');
    expect(templateKeyFor('APPOINTMENT_CANCELLED')).toBeNull();
  });

  it('only uses templates that can send', () => {
    expect(templateUsable('APPROVED')).toBe(true);
    expect(templateUsable(undefined)).toBe(true);
    expect(templateUsable('PENDING')).toBe(false);
    expect(templateUsable('rejected')).toBe(false);
  });

  it('reads STOP and START', () => {
    expect(consentKeyword(' stop ')).toBe('OPT_OUT');
    expect(consentKeyword('Unsubscribe.')).toBe('OPT_OUT');
    expect(consentKeyword('opt out')).toBe('OPT_OUT');
    expect(consentKeyword('START')).toBe('OPT_IN');
    expect(consentKeyword('please stop by the desk')).toBeNull();
  });

  it('never moves a delivery status backwards', () => {
    expect(shouldAdvanceStatus(null, 'SENT')).toBe(true);
    expect(shouldAdvanceStatus('SENT', 'DELIVERED')).toBe(true);
    expect(shouldAdvanceStatus('READ', 'DELIVERED')).toBe(false);
    expect(shouldAdvanceStatus('DELIVERED', 'FAILED')).toBe(true);
    expect(shouldAdvanceStatus('FAILED', 'READ')).toBe(false);
  });

  it('knows the 24-hour window', () => {
    const now = Date.now();
    expect(inSessionWindow(new Date(now - 23 * 3600_000), now)).toBe(true);
    expect(inSessionWindow(new Date(now - 25 * 3600_000), now)).toBe(false);
    expect(inSessionWindow(null, now)).toBe(false);
  });
});
