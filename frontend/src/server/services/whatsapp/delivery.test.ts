import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt } from '../../lib/encryption';

// Sending through the notification pipeline (WhatsApp first, SMS as the org
// allows) and the provider webhooks, with the provider HTTP mocked.

const db = vi.hoisted(() => ({
  whatsAppConfig: { findUnique: vi.fn() },
  whatsAppContact: { findUnique: vi.fn(), upsert: vi.fn() },
  notification: { create: vi.fn(async ({ data }: any) => ({ id: 'n-new', ...data })), findFirst: vi.fn(), update: vi.fn() },
  organization: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ default: db, prisma: db }));

const features = vi.hoisted(() => ({ whatsappNotifications: true }));
vi.mock('../../middleware/subscription.middleware', () => ({
  consumeCredits: vi.fn(async () => ({ allowed: true })),
  getOrganizationFeatures: vi.fn(async () => ({ ...features })),
}));

const smsSend = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('../sms', () => ({ getSmsProvider: vi.fn(async () => ({ name: 'test', send: smsSend })) }));
// notifications.service is only needed for readNotificationSettings.
vi.mock('../notifications.service', () => ({
  readNotificationSettings: (raw: any) => ({ turnApproachingAt: 3, email: true, sms: false, ...(raw || {}) }),
}));

import { deliverToPhone, type PhoneMessage } from '../phoneDelivery';
import { handleWhatsAppWebhook, verifyTwilioSignature, recordWhatsAppOptIn } from './webhook';
import { whatsappWebhookUrl } from './config';

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const META_SECRETS = { accessToken: 'EAAG-token', appSecret: 'meta-app-secret' };
function configRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg1',
    organizationId: 'org1',
    provider: 'meta_cloud',
    isEnabled: true,
    settings: { phoneNumberId: '1065', businessAccountId: '1022' },
    secrets: encrypt(JSON.stringify(META_SECRETS)),
    verifyToken: 'verify-me',
    templates: {
      QUEUE_JOINED: { name: 'queue_joined', language: 'en_US', status: 'APPROVED', variables: ['name', 'ticket', 'statusUrl'] },
      NOW_SERVING: { name: 'now_serving', language: 'en_US', status: 'PENDING', variables: ['ticket'] },
    },
    fallbackToSms: true,
    consentMode: 'EXPLICIT',
    defaultCountryCode: '233',
    ...over,
  };
}

const message = (over: Partial<PhoneMessage> = {}): PhoneMessage => ({
  organizationId: 'org1',
  orgName: 'Nyaho',
  userId: 'u1',
  phone: '020 000 0000',
  type: 'QUEUE_JOINED',
  templateKey: 'QUEUE_JOINED',
  message: 'Your ticket for Consultation is C014.',
  vars: { name: 'Ama', ticket: 'C014', statusUrl: 'https://nyaho.example/status/q/e' },
  dedupeKey: 'e1',
  smsEnabled: false,
  creditReason: 'queue notification QUEUE_JOINED',
  ...over,
});

const optedIn = (over: Record<string, unknown> = {}) => ({ organizationId: 'org1', phone: '233200000000', optedIn: true, optedOutAt: null, lastInboundAt: null, ...over });
const created = (channel: string) => db.notification.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.channel === channel);

beforeEach(() => {
  vi.clearAllMocks();
  features.whatsappNotifications = true;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  db.whatsAppConfig.findUnique.mockResolvedValue(configRow());
  db.whatsAppContact.findUnique.mockResolvedValue(optedIn());
  db.organization.findUnique.mockResolvedValue({ name: 'Nyaho', notificationSettings: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('deliverToPhone: WhatsApp first', () => {
  it('outside the 24-hour window sends the approved template, records the message id, and sends no text', async () => {
    fetchMock.mockResolvedValue(reply(200, { messages: [{ id: 'wamid.1', message_status: 'accepted' }] }));
    expect(await deliverToPhone(message({ smsEnabled: true }))).toBe('WHATSAPP');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.to).toBe('233200000000'); // local number + the org's country code
    expect(body.template.name).toBe('queue_joined');
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(['Ama', 'C014', 'https://nyaho.example/status/q/e']);
    expect(created('WHATSAPP')).toEqual([
      expect.objectContaining({ organizationId: 'org1', providerMessageId: 'wamid.1', deliveryStatus: 'QUEUED', deliveryError: null, queueEntryId: 'e1', type: 'QUEUE_JOINED' }),
    ]);
    expect(smsSend).not.toHaveBeenCalled();
  });

  it('inside the window sends the standard wording as text', async () => {
    db.whatsAppContact.findUnique.mockResolvedValue(optedIn({ lastInboundAt: new Date(Date.now() - 3600_000) }));
    fetchMock.mockResolvedValue(reply(200, { messages: [{ id: 'wamid.2' }] }));
    expect(await deliverToPhone(message({ type: 'NOW_SERVING', templateKey: 'NOW_SERVING' }))).toBe('WHATSAPP');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ type: 'text', text: { body: 'Nyaho: Your ticket for Consultation is C014.' } });
  });

  it('a transfer uses its own template, or the joined one when it has none', async () => {
    fetchMock.mockResolvedValue(reply(200, { messages: [{ id: 'wamid.3' }] }));
    await deliverToPhone(message({ templateKey: 'QUEUE_TRANSFERRED' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).template.name).toBe('queue_joined');
  });

  it('with no usable template outside the window, records the failure and falls back to SMS', async () => {
    // NOW_SERVING's template is still PENDING.
    expect(await deliverToPhone(message({ type: 'NOW_SERVING', templateKey: 'NOW_SERVING' }))).toBe('SMS');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(created('WHATSAPP')[0]).toMatchObject({ deliveryStatus: 'FAILED', deliveryError: expect.stringContaining('24-hour window') });
    expect(smsSend).toHaveBeenCalledWith('020 000 0000', 'Nyaho: Your ticket for Consultation is C014.');
    expect(created('SMS')).toHaveLength(1);
  });

  it('falls back to SMS when the provider rejects the message', async () => {
    fetchMock.mockResolvedValue(reply(400, { error: { code: 131026, message: 'Message undeliverable' } }));
    expect(await deliverToPhone(message())).toBe('SMS');
    expect(created('WHATSAPP')[0]).toMatchObject({ deliveryStatus: 'FAILED', deliveryError: 'WhatsApp 131026: Message undeliverable' });
  });

  it('sends nothing more when the org turned the SMS fallback off and does not text people', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(configRow({ fallbackToSms: false }));
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    expect(await deliverToPhone(message())).toBeNull();
    expect(smsSend).not.toHaveBeenCalled();
  });

  it('never messages someone without consent (explicit), and texts only when the org texts anyway', async () => {
    db.whatsAppContact.findUnique.mockResolvedValue(null);
    expect(await deliverToPhone(message())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(await deliverToPhone(message({ smsEnabled: true }))).toBe('SMS');
  });

  it('implied consent messages any number that has not opted out', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(configRow({ consentMode: 'IMPLIED' }));
    db.whatsAppContact.findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue(reply(200, { messages: [{ id: 'wamid.4' }] }));
    expect(await deliverToPhone(message())).toBe('WHATSAPP');
  });

  it('respects STOP: no WhatsApp and no fallback text', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(configRow({ consentMode: 'IMPLIED' }));
    db.whatsAppContact.findUnique.mockResolvedValue(optedIn({ optedIn: false, optedOutAt: new Date() }));
    expect(await deliverToPhone(message())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(smsSend).not.toHaveBeenCalled();
  });

  it('does nothing on WhatsApp when the channel is off or not in the plan', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(configRow({ isEnabled: false }));
    expect(await deliverToPhone(message())).toBeNull();
    db.whatsAppConfig.findUnique.mockResolvedValue(configRow());
    features.whatsappNotifications = false;
    expect(await deliverToPhone(message({ smsEnabled: true }))).toBe('SMS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a linked phone (WhatsApp Web) always sends text, no templates', async () => {
    vi.stubEnv('ALLOW_PRIVATE_OUTBOUND_URLS', 'true');
    db.whatsAppConfig.findUnique.mockResolvedValue(
      configRow({ provider: 'whatsapp_web', settings: { baseUrl: 'http://wa.local:3000' }, secrets: encrypt(JSON.stringify({ webhookSecret: 'w' })), templates: {} })
    );
    fetchMock.mockResolvedValue(reply(200, { code: 'SUCCESS', results: { message_id: '3EB0' } }));
    expect(await deliverToPhone(message())).toBe('WHATSAPP');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://wa.local:3000/send/message');
    vi.unstubAllEnvs();
  });
});

const sign = (body: string, secret: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const post = (body: string, headers: Record<string, string>, requestUrl = 'https://x/api/v1/webhooks/whatsapp/org1') =>
  handleWhatsAppWebhook('org1', { method: 'POST', headers, query: {}, rawBody: Buffer.from(body), requestUrl });

describe('webhooks: Meta', () => {
  const statusBody = (status: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.1', status, ...extra }] } }] }] });

  it('answers the verification handshake only with the right token', async () => {
    const get = (token: string) =>
      handleWhatsAppWebhook('org1', { method: 'GET', headers: {}, rawBody: Buffer.from(''), requestUrl: '', query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' } });
    expect(await get('verify-me')).toEqual({ status: 200, body: '1158201444' });
    expect((await get('wrong')).status).toBe(403);
  });

  it('rejects a bad or missing signature', async () => {
    const body = statusBody('delivered');
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { 'x-hub-signature-256': sign(body, 'not-the-secret') })).status).toBe(401);
    expect(db.notification.update).not.toHaveBeenCalled();
  });

  it('stores the delivery status on the notification', async () => {
    db.notification.findFirst.mockResolvedValueOnce({ id: 'n1', deliveryStatus: 'SENT', type: 'QUEUE_JOINED', queueEntryId: 'e1', userId: 'u1', message: 'm' });
    const body = statusBody('read');
    expect(await post(body, { 'x-hub-signature-256': sign(body, 'meta-app-secret') })).toEqual({ status: 200, body: 'OK' });
    expect(db.notification.findFirst.mock.calls[0][0].where).toEqual({ providerMessageId: 'wamid.1', organizationId: 'org1', channel: 'WHATSAPP' });
    expect(db.notification.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: expect.objectContaining({ deliveryStatus: 'READ' }) });
  });

  it('ignores a late "delivered" after "read"', async () => {
    db.notification.findFirst.mockResolvedValueOnce({ id: 'n1', deliveryStatus: 'READ' });
    const body = statusBody('delivered');
    await post(body, { 'x-hub-signature-256': sign(body, 'meta-app-secret') });
    expect(db.notification.update).not.toHaveBeenCalled();
  });

  it('a failed message falls back to SMS once', async () => {
    db.notification.findFirst
      .mockResolvedValueOnce({ id: 'n1', deliveryStatus: 'SENT', type: 'NOW_SERVING', queueEntryId: 'e1', userId: 'u1', message: 'It’s your turn.' })
      .mockResolvedValueOnce(null); // no SMS sent yet
    db.user.findUnique.mockResolvedValue({ phone: '+233200000000' });
    const body = statusBody('failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
    await post(body, { 'x-hub-signature-256': sign(body, 'meta-app-secret') });
    expect(db.notification.update.mock.calls[0][0].data).toMatchObject({ deliveryStatus: 'FAILED', deliveryError: '131026: Message undeliverable' });
    expect(smsSend).toHaveBeenCalledWith('+233200000000', 'Nyaho: It’s your turn.');
    expect(created('SMS')[0]).toMatchObject({ type: 'NOW_SERVING', queueEntryId: 'e1' });
  });

  it('STOP opts the number out and confirms; any message opens the window', async () => {
    fetchMock.mockResolvedValue(reply(200, { messages: [{ id: 'wamid.r' }] }));
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '233200000000', type: 'text', text: { body: 'STOP' } }] } }] }] });
    await post(body, { 'x-hub-signature-256': sign(body, 'meta-app-secret') });
    const upsert = db.whatsAppContact.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ organizationId_phone: { organizationId: 'org1', phone: '233200000000' } });
    expect(upsert.update).toMatchObject({ optedIn: false, optedOutAt: expect.any(Date), lastInboundAt: expect.any(Date) });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).text.body).toContain('Reply START');
  });
});

describe('webhooks: Twilio', () => {
  const twilioRow = configRow({ provider: 'twilio', settings: { accountSid: 'AC1', from: '+14155238886' }, secrets: encrypt(JSON.stringify({ authToken: 'twilio-token' })) });
  const twilioSign = (url: string, params: URLSearchParams, token: string) => {
    const keys = [...params.keys()].sort();
    return crypto.createHmac('sha1', token).update(url + keys.map((k) => k + params.get(k)).join('')).digest('base64');
  };

  it('checks X-Twilio-Signature over the URL and sorted parameters', () => {
    const params = new URLSearchParams({ To: 'whatsapp:+1', MessageStatus: 'delivered', MessageSid: 'SM1' });
    const good = twilioSign('https://k.example/hook', params, 'tok');
    expect(verifyTwilioSignature('https://k.example/hook', params, good, 'tok')).toBe(true);
    expect(verifyTwilioSignature('https://k.example/other', params, good, 'tok')).toBe(false);
    params.set('MessageStatus', 'read');
    expect(verifyTwilioSignature('https://k.example/hook', params, good, 'tok')).toBe(false);
  });

  it('records a status callback signed for our webhook URL', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(twilioRow);
    db.notification.findFirst.mockResolvedValueOnce({ id: 'n2', deliveryStatus: 'QUEUED' });
    const params = new URLSearchParams({ MessageSid: 'SM1', MessageStatus: 'delivered', To: 'whatsapp:+233200000000' });
    const res = await post(params.toString(), { 'x-twilio-signature': twilioSign(whatsappWebhookUrl('org1'), params, 'twilio-token') });
    expect(res).toEqual({ status: 200, body: '<Response></Response>' });
    expect(db.notification.update.mock.calls[0][0].data).toMatchObject({ deliveryStatus: 'DELIVERED' });
  });

  it('rejects an unsigned post', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(twilioRow);
    expect((await post('MessageSid=SM1&MessageStatus=read', {})).status).toBe(401);
  });
});

describe('webhooks: WhatsApp Web', () => {
  it('reads a signed delivery receipt', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(
      configRow({ provider: 'whatsapp_web', settings: { baseUrl: 'https://wa.example' }, secrets: encrypt(JSON.stringify({ webhookSecret: 'web-secret' })) })
    );
    db.notification.findFirst.mockResolvedValueOnce({ id: 'n3', deliveryStatus: 'SENT' });
    const body = JSON.stringify({ event: 'message.ack', payload: { ids: ['3EB0ABC'], receipt_type: 'read' } });
    expect((await post(body, { 'x-hub-signature-256': sign(body, 'web-secret') })).status).toBe(200);
    expect(db.notification.findFirst.mock.calls[0][0].where.providerMessageId).toBe('3EB0ABC');
    expect(db.notification.update.mock.calls[0][0].data).toMatchObject({ deliveryStatus: 'READ' });
  });
});

describe('recordWhatsAppOptIn', () => {
  it('records consent from the join form with the org’s country code', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue({ defaultCountryCode: '233' });
    await recordWhatsAppOptIn('org1', '020 000 0000', 'join_form');
    expect(db.whatsAppContact.upsert.mock.calls[0][0]).toMatchObject({
      where: { organizationId_phone: { organizationId: 'org1', phone: '233200000000' } },
      update: { optedIn: true, optedOutAt: null, source: 'join_form' },
    });
  });

  it('records nothing for an org without WhatsApp', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(null);
    await recordWhatsAppOptIn('org1', '+233200000000', 'join_form');
    expect(db.whatsAppContact.upsert).not.toHaveBeenCalled();
  });
});
