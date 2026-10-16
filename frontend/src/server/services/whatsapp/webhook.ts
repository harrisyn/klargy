import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { loadWhatsAppConfig, providerFor, whatsappWebhookUrl, type LoadedWhatsAppConfig } from './config';
import { TWILIO_STATUS } from './providers';
import { consentKeyword, normalizeWhatsAppPhone, shouldAdvanceStatus } from './util';
import { sendSmsNotification } from '../phoneDelivery';
import { readNotificationSettings } from '../notifications.service';
import { getOrganizationFeatures } from '../../middleware/subscription.middleware';
import type { WhatsAppDeliveryStatus } from '../../../lib/whatsapp';

// Delivery receipts and replies from the organisation's WhatsApp provider.
// One URL per organisation: /api/v1/webhooks/whatsapp/:orgId. Every request
// is checked against that organisation's own secret before it is read.

export interface StatusEvent {
  messageId: string;
  status: WhatsAppDeliveryStatus;
  error?: string;
}
export interface InboundEvent {
  /** Digits with country code. */
  from: string;
  text: string;
}
export interface ParsedWebhook {
  statuses: StatusEvent[];
  inbound: InboundEvent[];
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Meta (and go-whatsapp-web-multidevice): X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body). */
export function verifyHubSignature(rawBody: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(header.trim().toLowerCase(), expected);
}

/** Twilio: X-Twilio-Signature = base64(HMAC-SHA1(auth token, URL + each POST param name and value, sorted by name)). */
export function verifyTwilioSignature(url: string, params: URLSearchParams, header: string | undefined, authToken: string | undefined): boolean {
  if (!authToken || !header) return false;
  const keys = [...new Set(params.keys())].sort();
  const data = url + keys.map((k) => params.getAll(k).map((v) => k + v).join('')).join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  return safeEqual(header.trim(), expected);
}

const META_STATUS: Record<string, WhatsAppDeliveryStatus> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };

export function parseMetaWebhook(body: any): ParsedWebhook {
  const out: ParsedWebhook = { statuses: [], inbound: [] };
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const s of value.statuses || []) {
        const status = META_STATUS[s.status];
        if (!s.id || !status) continue;
        const err = (s.errors || [])[0];
        out.statuses.push({ messageId: s.id, status, error: err ? `${err.code}: ${err.error_data?.details || err.title || err.message}` : undefined });
      }
      for (const m of value.messages || []) {
        const from = normalizeWhatsAppPhone(m.from);
        if (!from) continue;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? '';
        out.inbound.push({ from, text });
      }
    }
  }
  return out;
}

export function parseTwilioWebhook(params: URLSearchParams): ParsedWebhook {
  const out: ParsedWebhook = { statuses: [], inbound: [] };
  const messageStatus = params.get('MessageStatus') || '';
  if (messageStatus && messageStatus !== 'received') {
    const status = TWILIO_STATUS[messageStatus];
    const sid = params.get('MessageSid');
    if (status && sid) {
      const code = params.get('ErrorCode');
      out.statuses.push({ messageId: sid, status, error: code ? `${code}: ${params.get('ErrorMessage') || 'delivery failed'}` : undefined });
    }
    return out;
  }
  const from = normalizeWhatsAppPhone(params.get('From'));
  if (from) out.inbound.push({ from, text: params.get('Body') || params.get('ButtonText') || '' });
  return out;
}

/** go-whatsapp-web-multidevice webhooks: a message, or a "message.ack" receipt
 * (newer servers wrap either in {event, payload}). */
export function parseWhatsAppWebWebhook(body: any): ParsedWebhook {
  const out: ParsedWebhook = { statuses: [], inbound: [] };
  const event = String(body?.event || '');
  const p = body?.payload && typeof body.payload === 'object' ? body.payload : body;
  if (event === 'message.ack' || p?.receipt_type) {
    const kind = String(p.receipt_type || '').toLowerCase();
    const status: WhatsAppDeliveryStatus | null = kind === 'read' || kind === 'read-self' ? 'READ' : kind === 'delivered' || kind === '' ? 'DELIVERED' : null;
    if (status) for (const id of p.ids || (p.id ? [p.id] : [])) out.statuses.push({ messageId: String(id), status });
    return out;
  }
  if (p?.is_from_me || p?.from_me) return out;
  const fromRaw = String(p?.from || p?.sender_id || p?.chat_id || '').split('@')[0].split(':')[0];
  const from = normalizeWhatsAppPhone(fromRaw);
  const text = p?.message?.text ?? p?.body ?? (typeof p?.message === 'string' ? p.message : '');
  if (from && (text || p?.message)) out.inbound.push({ from, text: String(text || '') });
  return out;
}

/** Records a delivery status, and sends the text fallback when a message failed. */
export async function applyStatus(config: LoadedWhatsAppConfig, ev: StatusEvent): Promise<void> {
  const notification = await prisma.notification.findFirst({
    where: { providerMessageId: ev.messageId, organizationId: config.organizationId, channel: 'WHATSAPP' },
  });
  if (!notification || !shouldAdvanceStatus(notification.deliveryStatus, ev.status)) return;
  await prisma.notification.update({
    where: { id: notification.id },
    data: { deliveryStatus: ev.status, statusUpdatedAt: new Date(), ...(ev.error ? { deliveryError: ev.error.slice(0, 500) } : {}) },
  });
  if (ev.status !== 'FAILED') return;

  // Accepted, then not delivered: send a text instead when the org wants that
  // (or texts people anyway), unless one already went for this message.
  const org = await prisma.organization.findUnique({
    where: { id: config.organizationId },
    select: { name: true, notificationSettings: true },
  });
  if (!org || !(config.fallbackToSms || readNotificationSettings(org.notificationSettings).sms)) return;
  if (notification.queueEntryId) {
    const texted = await prisma.notification.findFirst({
      where: { queueEntryId: notification.queueEntryId, type: notification.type, channel: 'SMS' },
      select: { id: true },
    });
    if (texted) return;
  }
  const user = await prisma.user.findUnique({ where: { id: notification.userId }, select: { phone: true } });
  await sendSmsNotification({
    organizationId: config.organizationId,
    orgName: org.name,
    userId: notification.userId,
    phone: user?.phone,
    type: notification.type,
    message: notification.message,
    dedupeKey: notification.queueEntryId ?? `whatsapp:${notification.id}`,
    creditReason: `WhatsApp fallback ${notification.type}`,
  });
}

const REPLY = {
  OPT_OUT: (org: string) => `You won’t get WhatsApp messages from ${org} any more. Reply START to turn them back on.`,
  OPT_IN: (org: string) => `You’ll get updates from ${org} here on WhatsApp. Reply STOP at any time to turn them off.`,
};

/** A message from a person: opens the 24-hour window, and STOP/START change their consent. */
export async function applyInbound(config: LoadedWhatsAppConfig, ev: InboundEvent): Promise<void> {
  const now = new Date();
  const keyword = consentKeyword(ev.text);
  const consent =
    keyword === 'OPT_OUT' ? { optedIn: false, optedOutAt: now }
    : keyword === 'OPT_IN' ? { optedIn: true, optedInAt: now, optedOutAt: null }
    : {};
  await prisma.whatsAppContact.upsert({
    where: { organizationId_phone: { organizationId: config.organizationId, phone: ev.from } },
    create: { organizationId: config.organizationId, phone: ev.from, lastInboundAt: now, source: 'inbound', ...consent },
    update: { lastInboundAt: now, ...consent },
  });
  if (!keyword) return;
  const org = await prisma.organization.findUnique({ where: { id: config.organizationId }, select: { name: true } });
  const provider = providerFor(config);
  if (!provider || !org) return;
  // They just wrote, so a free-form reply is allowed.
  await provider.sendText(ev.from, REPLY[keyword](org.name)).catch((err) => console.error('WhatsApp consent reply failed:', err));
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  rawBody: Buffer;
  /** The URL as the provider called it (Twilio signs it). */
  requestUrl: string;
}

const header = (h: WebhookRequest['headers'], name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Handles one webhook call for an organisation: returns the HTTP reply. */
export async function handleWhatsAppWebhook(organizationId: string, req: WebhookRequest): Promise<{ status: number; body: string }> {
  const config = await loadWhatsAppConfig(organizationId);
  if (!config) return { status: 404, body: 'Not found' };

  // Meta's one-off subscription check.
  if (req.method === 'GET') {
    const mode = String(req.query['hub.mode'] ?? '');
    const token = String(req.query['hub.verify_token'] ?? '');
    const challenge = String(req.query['hub.challenge'] ?? '');
    if (config.provider === 'meta_cloud' && mode === 'subscribe' && token && safeEqual(token, config.verifyToken)) {
      return { status: 200, body: challenge };
    }
    return { status: 403, body: 'Forbidden' };
  }

  let parsed: ParsedWebhook;
  if (config.provider === 'twilio') {
    const params = new URLSearchParams(req.rawBody.toString('utf8'));
    const signature = header(req.headers, 'x-twilio-signature');
    const urls = [whatsappWebhookUrl(organizationId), req.requestUrl];
    if (!urls.some((u) => verifyTwilioSignature(u, params, signature, config.secrets.authToken))) return { status: 401, body: 'Invalid signature' };
    parsed = parseTwilioWebhook(params);
  } else {
    const secret = config.provider === 'meta_cloud' ? config.secrets.appSecret : config.secrets.webhookSecret;
    if (!verifyHubSignature(req.rawBody, header(req.headers, 'x-hub-signature-256'), secret)) return { status: 401, body: 'Invalid signature' };
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody.toString('utf8') || '{}');
    } catch {
      return { status: 400, body: 'Invalid JSON' };
    }
    parsed = config.provider === 'meta_cloud' ? parseMetaWebhook(body) : parseWhatsAppWebWebhook(body);
  }

  for (const ev of parsed.statuses) await applyStatus(config, ev);
  for (const ev of parsed.inbound) await applyInbound(config, ev);
  return { status: 200, body: config.provider === 'twilio' ? '<Response></Response>' : 'OK' };
}

/** Consent given on the join form or by staff. Only recorded when the org has WhatsApp set up. */
export async function recordWhatsAppOptIn(organizationId: string, phone: unknown, source: 'join_form' | 'staff' | 'connect'): Promise<void> {
  const config = await prisma.whatsAppConfig.findUnique({ where: { organizationId }, select: { defaultCountryCode: true } });
  if (!config) return;
  const to = normalizeWhatsAppPhone(phone, config.defaultCountryCode);
  if (!to) return;
  const now = new Date();
  await prisma.whatsAppContact.upsert({
    where: { organizationId_phone: { organizationId, phone: to } },
    create: { organizationId, phone: to, optedIn: true, optedInAt: now, source },
    update: { optedIn: true, optedInAt: now, optedOutAt: null, source },
  });
}

/**
 * What the join form shows about WhatsApp: ASK (a "send me updates on
 * WhatsApp" box, for explicit consent), NOTICE (a line saying updates come on
 * WhatsApp, reply STOP to stop), or null when the org doesn't use it.
 */
export async function whatsappJoinPrompt(organizationId: string): Promise<'ASK' | 'NOTICE' | null> {
  const config = await prisma.whatsAppConfig.findUnique({ where: { organizationId }, select: { isEnabled: true, consentMode: true } });
  if (!config?.isEnabled) return null;
  if (!(await getOrganizationFeatures(organizationId)).whatsappNotifications) return null;
  return config.consentMode === 'IMPLIED' ? 'NOTICE' : 'ASK';
}
