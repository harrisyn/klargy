import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decrypt, encrypt } from '../../lib/encryption';

// Settings → WhatsApp: credentials are encrypted and never sent back, blank
// secrets keep the saved ones, and templates are checked.

const db = vi.hoisted(() => ({
  whatsAppConfig: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  whatsAppContact: { count: vi.fn(async () => 0), findUnique: vi.fn() },
  organization: { findUnique: vi.fn(async () => ({ name: 'Nyaho' })) },
  platformWhatsAppConfig: { findUnique: vi.fn(async () => null) },
}));
vi.mock('../../lib/prisma', () => ({ default: db, prisma: db }));

import { getWhatsAppConfig, upsertWhatsAppConfig, sendWhatsAppTest } from '../whatsapp.controller';

const makeRes = () => {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};
const call = async (handler: any, body: unknown) => {
  const res = makeRes();
  const next = vi.fn();
  await handler({ params: { id: 'org1' }, body }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  db.whatsAppConfig.upsert.mockImplementation(async ({ create, update }: any) => ({ id: 'cfg1', organizationId: 'org1', verifyToken: 'vt', updatedAt: new Date(), ...create, ...update }));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const META = {
  provider: 'meta_cloud',
  isEnabled: true,
  settings: { phoneNumberId: '1065', businessAccountId: '1022' },
  secrets: { accessToken: 'EAAG-secret-token-1234', appSecret: 'app-secret-9876' },
  templates: { QUEUE_JOINED: { name: 'queue_joined', language: 'en_US', variables: ['name', 'ticket'] } },
  defaultCountryCode: '+233',
};

describe('upsertWhatsAppConfig', () => {
  it('encrypts the credentials and only shows them masked', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(null);
    const res = await call(upsertWhatsAppConfig, META);
    const saved = db.whatsAppConfig.upsert.mock.calls[0][0];
    expect(saved.create.secrets).not.toContain('EAAG');
    expect(JSON.parse(decrypt(saved.create.secrets))).toEqual(META.secrets);
    expect(saved.create.defaultCountryCode).toBe('233');
    expect(saved.create.verifyToken).toMatch(/^[\w-]{20,}$/);
    const out = res.json.mock.calls[0][0];
    expect(JSON.stringify(out)).not.toContain('EAAG-secret');
    expect(out.secretsMasked).toEqual({ accessToken: expect.stringMatching(/1234$/), appSecret: expect.stringMatching(/9876$/) });
    expect(out.webhookUrl).toMatch(/\/api\/v1\/webhooks\/whatsapp\/org1$/);
    expect(out.templates.QUEUE_JOINED).toMatchObject({ name: 'queue_joined', status: 'UNKNOWN' });
  });

  it('keeps saved secrets when the fields are left blank', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue({ provider: 'meta_cloud', secrets: encrypt(JSON.stringify(META.secrets)) });
    await call(upsertWhatsAppConfig, { ...META, secrets: { accessToken: '', appSecret: 'new-app-secret' } });
    const saved = db.whatsAppConfig.upsert.mock.calls[0][0];
    expect(JSON.parse(decrypt(saved.update.secrets))).toEqual({ accessToken: 'EAAG-secret-token-1234', appSecret: 'new-app-secret' });
  });

  it('asks for missing credentials and bad template names', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(null);
    let res = await call(upsertWhatsAppConfig, { ...META, secrets: { accessToken: 'x' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe('Enter the app secret.');
    res = await call(upsertWhatsAppConfig, { ...META, templates: { QUEUE_JOINED: { name: 'Queue Joined', language: 'en', variables: [] } } });
    expect(res.json.mock.calls[0][0].error).toMatch(/lowercase/);
    res = await call(upsertWhatsAppConfig, { ...META, templates: { QUEUE_JOINED: { name: 'ok', language: 'en', variables: ['password'] } } });
    expect(res.json.mock.calls[0][0].error).toMatch(/Unknown template value/);
    expect(db.whatsAppConfig.upsert).not.toHaveBeenCalled();
  });

  it('WhatsApp Web gets a webhook secret to paste into the server', async () => {
    vi.stubEnv('ALLOW_PRIVATE_OUTBOUND_URLS', 'true');
    db.whatsAppConfig.findUnique.mockResolvedValue(null);
    const res = await call(upsertWhatsAppConfig, { provider: 'whatsapp_web', isEnabled: true, settings: { baseUrl: 'http://wa.local:3000/' }, secrets: {} });
    const saved = db.whatsAppConfig.upsert.mock.calls[0][0];
    expect(saved.create.settings).toEqual({ baseUrl: 'http://wa.local:3000' });
    const secret = JSON.parse(decrypt(saved.create.secrets)).webhookSecret;
    expect(secret).toMatch(/^[\w-]{20,}$/);
    expect(res.json.mock.calls[0][0].webhookSecret).toBe(secret);
    vi.unstubAllEnvs();
  });

  it('GET says when nothing is set up', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(null);
    const res = await call(getWhatsAppConfig, undefined);
    expect(res.json.mock.calls[0][0]).toEqual({ configured: false, platformAvailable: false, webhookUrl: expect.stringContaining('/webhooks/whatsapp/org1') });
  });
});

describe('sendWhatsAppTest', () => {
  const row = {
    id: 'cfg1', organizationId: 'org1', provider: 'meta_cloud', isEnabled: true, settings: META.settings,
    secrets: encrypt(JSON.stringify(META.secrets)), verifyToken: 'vt', templates: {}, fallbackToSms: true, consentMode: 'EXPLICIT', defaultCountryCode: '233',
  };

  it('outside the window, with no template mapped yet, sends Meta’s hello_world', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(row);
    db.whatsAppContact.findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }), { status: 200 }));
    const res = await call(sendWhatsAppTest, { to: '+233 20 000 0000' });
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, via: 'template', messageId: 'wamid.T' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).template).toEqual({ name: 'hello_world', language: { code: 'en_US' } });
  });

  it('inside the window sends a plain message', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(row);
    db.whatsAppContact.findUnique.mockResolvedValue({ lastInboundAt: new Date() });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.U' }] }), { status: 200 }));
    const res = await call(sendWhatsAppTest, { to: '0200000000' });
    expect(res.json.mock.calls[0][0].via).toBe('text');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).to).toBe('233200000000');
  });

  it('explains a provider rejection', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(row);
    db.whatsAppContact.findUnique.mockResolvedValue({ lastInboundAt: new Date() });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 }));
    const res = await call(sendWhatsAppTest, { to: '+233200000000' });
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0].error).toMatch(/only an approved template can be sent/);
  });
});
