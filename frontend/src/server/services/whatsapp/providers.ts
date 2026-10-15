import { assertPublicUrl } from '../../lib/urlSafety';
import type { WhatsAppDeliveryStatus, WhatsAppProviderId, WhatsAppTemplateMapping } from '../../../lib/whatsapp';

// WhatsApp senders behind one small interface. Each organisation brings its
// own account; credentials arrive decrypted from config.ts.

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  status?: WhatsAppDeliveryStatus;
  error?: string;
  /** The provider's error code, e.g. Meta 131047 or Twilio 63016. */
  code?: string;
  /** The 24-hour window was closed: only a template can be sent. */
  outsideWindow?: boolean;
}

export interface ProviderTemplate {
  name: string;
  language: string;
  status: string;
  category?: string;
  body?: string;
  /** Number of {{n}} parameters in the body. */
  paramCount: number;
  contentSid?: string;
}

export interface WhatsAppProvider {
  name: WhatsAppProviderId;
  /** Business-initiated messages need an approved template outside the 24-hour window. */
  requiresTemplates: boolean;
  sendText(to: string, body: string): Promise<WhatsAppSendResult>;
  sendTemplate(to: string, template: WhatsAppTemplateMapping, params: string[]): Promise<WhatsAppSendResult>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  listTemplates?(): Promise<ProviderTemplate[]>;
}

const TIMEOUT_MS = 15_000;

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

const countParams = (body?: string) => new Set((body || '').match(/\{\{\s*\d+\s*\}\}/g) || []).size;

// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API
// ---------------------------------------------------------------------------

export interface MetaSettings {
  phoneNumberId: string;
  businessAccountId?: string;
  apiVersion?: string;
}
export interface MetaSecrets {
  accessToken: string;
  appSecret?: string;
}

const META_STATUS: Record<string, WhatsAppDeliveryStatus> = { accepted: 'QUEUED', held_for_quality_assessment: 'QUEUED' };

export class MetaCloudProvider implements WhatsAppProvider {
  name = 'meta_cloud' as const;
  requiresTemplates = true;
  constructor(private settings: MetaSettings, private secrets: MetaSecrets, private graphBase = 'https://graph.facebook.com') {}

  private url(path: string) {
    const version = /^v\d+\.\d+$/.test(this.settings.apiVersion || '') ? this.settings.apiVersion : 'v21.0';
    return `${this.graphBase}/${version}/${path}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.secrets.accessToken}`, 'Content-Type': 'application/json' };
  }

  private async send(to: string, message: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const res = await fetch(this.url(`${encodeURIComponent(this.settings.phoneNumberId)}/messages`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await readJson(res);
    if (!res.ok || data.error) {
      const err = data.error || {};
      const code = err.code !== undefined ? String(err.code) : String(res.status);
      const detail = err.error_data?.details || err.message || data.raw || `HTTP ${res.status}`;
      return { success: false, code, error: `WhatsApp ${code}: ${detail}`, outsideWindow: code === '131047' };
    }
    const sent = data.messages?.[0];
    return { success: true, messageId: sent?.id, status: META_STATUS[sent?.message_status] || 'QUEUED' };
  }

  sendText(to: string, body: string) {
    return this.send(to, { type: 'text', text: { preview_url: true, body } });
  }

  sendTemplate(to: string, template: WhatsAppTemplateMapping, params: string[]) {
    return this.send(to, {
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}),
      },
    });
  }

  async testConnection() {
    const res = await fetch(
      this.url(`${encodeURIComponent(this.settings.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`),
      { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    const data = await readJson(res);
    if (!res.ok || data.error) return { ok: false, message: `Meta said: ${data.error?.message || `HTTP ${res.status}`}` };
    const quality = data.quality_rating ? `, quality ${String(data.quality_rating).toLowerCase()}` : '';
    return { ok: true, message: `Connected to ${data.verified_name || 'your number'} (${data.display_phone_number || this.settings.phoneNumberId}${quality}).` };
  }

  async listTemplates(): Promise<ProviderTemplate[]> {
    if (!this.settings.businessAccountId) throw Object.assign(new Error('Add the WhatsApp Business Account ID to load templates.'), { status: 400 });
    const out: ProviderTemplate[] = [];
    let next: string | null = this.url(
      `${encodeURIComponent(this.settings.businessAccountId)}/message_templates?fields=name,language,status,category,components&limit=100`
    );
    for (let page = 0; next && page < 5; page++) {
      const res: Response = await fetch(next, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const data = await readJson(res);
      if (!res.ok || data.error) throw Object.assign(new Error(`Meta said: ${data.error?.message || `HTTP ${res.status}`}`), { status: 502 });
      for (const t of data.data || []) {
        const body = (t.components || []).find((c: any) => c.type === 'BODY')?.text as string | undefined;
        out.push({ name: t.name, language: t.language, status: String(t.status || 'UNKNOWN').toUpperCase(), category: t.category, body, paramCount: countParams(body) });
      }
      next = data.paging?.next || null;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Twilio (WhatsApp sender)
// ---------------------------------------------------------------------------

export interface TwilioSettings {
  accountSid: string;
  from?: string;
  messagingServiceSid?: string;
}
export interface TwilioSecrets {
  authToken: string;
}

export const TWILIO_STATUS: Record<string, WhatsAppDeliveryStatus> = {
  accepted: 'QUEUED',
  queued: 'QUEUED',
  scheduled: 'QUEUED',
  sending: 'QUEUED',
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
  undelivered: 'FAILED',
  canceled: 'FAILED',
};

export class TwilioWhatsAppProvider implements WhatsAppProvider {
  name = 'twilio' as const;
  requiresTemplates = true;
  constructor(
    private settings: TwilioSettings,
    private secrets: TwilioSecrets,
    private statusCallback?: string,
    private apiBase = 'https://api.twilio.com',
    private contentBase = 'https://content.twilio.com'
  ) {}

  private auth() {
    return `Basic ${Buffer.from(`${this.settings.accountSid}:${this.secrets.authToken}`).toString('base64')}`;
  }

  private async send(to: string, fields: Record<string, string>): Promise<WhatsAppSendResult> {
    const form = new URLSearchParams({ To: `whatsapp:+${to}`, ...fields });
    if (this.settings.messagingServiceSid) form.set('MessagingServiceSid', this.settings.messagingServiceSid);
    else if (this.settings.from) form.set('From', `whatsapp:+${this.settings.from.replace(/\D/g, '')}`);
    if (this.statusCallback) form.set('StatusCallback', this.statusCallback);
    const res = await fetch(`${this.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await readJson(res);
    if (!res.ok) {
      const code = data.code !== undefined ? String(data.code) : String(res.status);
      return { success: false, code, error: `Twilio ${code}: ${data.message || data.raw || `HTTP ${res.status}`}`, outsideWindow: code === '63016' };
    }
    return { success: true, messageId: data.sid, status: TWILIO_STATUS[data.status] || 'QUEUED' };
  }

  sendText(to: string, body: string) {
    return this.send(to, { Body: body });
  }

  async sendTemplate(to: string, template: WhatsAppTemplateMapping, params: string[]) {
    if (!template.contentSid) return { success: false, code: 'NO_CONTENT_SID', error: `Template ${template.name} has no Twilio Content SID.` };
    const variables = Object.fromEntries(params.map((value, i) => [String(i + 1), value]));
    return this.send(to, { ContentSid: template.contentSid, ...(params.length ? { ContentVariables: JSON.stringify(variables) } : {}) });
  }

  async testConnection() {
    const res = await fetch(`${this.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}.json`, {
      headers: { Authorization: this.auth() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await readJson(res);
    if (!res.ok) return { ok: false, message: `Twilio said: ${data.message || `HTTP ${res.status}`}` };
    if (!this.settings.from && !this.settings.messagingServiceSid) return { ok: false, message: 'Signed in, but add a WhatsApp sender number or Messaging Service.' };
    return { ok: true, message: `Connected to Twilio account ${data.friendly_name || this.settings.accountSid} (${data.status || 'active'}).` };
  }

  async listTemplates(): Promise<ProviderTemplate[]> {
    const out: ProviderTemplate[] = [];
    let next: string | null = `${this.contentBase}/v1/ContentAndApprovals?PageSize=100`;
    for (let page = 0; next && page < 5; page++) {
      const res: Response = await fetch(next, { headers: { Authorization: this.auth() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const data = await readJson(res);
      if (!res.ok) throw Object.assign(new Error(`Twilio said: ${data.message || `HTTP ${res.status}`}`), { status: 502 });
      for (const c of data.contents || []) {
        const approval = c.approval_requests || {};
        const types = c.types || {};
        const body = types['twilio/text']?.body || Object.values(types).map((t: any) => t?.body).find(Boolean);
        out.push({
          name: approval.name || c.friendly_name,
          language: c.language || 'en',
          status: String(approval.status || 'UNSUBMITTED').toUpperCase(),
          category: approval.category,
          body,
          paramCount: Math.max(countParams(body), Object.keys(c.variables || {}).length),
          contentSid: c.sid,
        });
      }
      next = data.meta?.next_page_url || null;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Web Multi-Device (self-hosted, the provider Serenity uses)
// github.com/aldinokemal/go-whatsapp-web-multidevice
// ---------------------------------------------------------------------------

export interface WhatsAppWebSettings {
  baseUrl: string;
  deviceId?: string;
}
export interface WhatsAppWebSecrets {
  basicAuth?: string;
  webhookSecret?: string;
}

export class WhatsAppWebProvider implements WhatsAppProvider {
  name = 'whatsapp_web' as const;
  requiresTemplates = false;
  constructor(private settings: WhatsAppWebSettings, private secrets: WhatsAppWebSecrets) {}

  private get deviceId() {
    return this.settings.deviceId || 'default';
  }

  private async request(path: string, init: RequestInit = {}) {
    const base = (await assertPublicUrl(this.settings.baseUrl)).toString().replace(/\/$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Device-Id': this.deviceId };
    if (this.secrets.basicAuth) headers.Authorization = `Basic ${Buffer.from(this.secrets.basicAuth).toString('base64')}`;
    const res = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { res, data: await readJson(res) };
  }

  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    const { res, data } = await this.request('/send/message', {
      method: 'POST',
      body: JSON.stringify({ phone: `${to}@s.whatsapp.net`, message: body }),
    });
    if (!res.ok || (data.code && data.code !== 'SUCCESS')) {
      return { success: false, code: String(data.code || res.status), error: `WhatsApp server: ${data.message || data.raw || `HTTP ${res.status}`}` };
    }
    return { success: true, messageId: data.results?.message_id, status: 'SENT' };
  }

  /** A linked phone has no templates; the rendered message is sent as text. */
  async sendTemplate(): Promise<WhatsAppSendResult> {
    return { success: false, code: 'NO_TEMPLATES', error: 'WhatsApp Web sends plain messages, not templates.' };
  }

  async testConnection() {
    const { res, data } = await this.request(`/devices/${encodeURIComponent(this.deviceId)}/status`);
    if (!res.ok) return { ok: false, message: `The WhatsApp server said: ${data.message || `HTTP ${res.status}`}` };
    const r = data.results && typeof data.results === 'object' ? data.results : {};
    const connected = !!(data.connected || data.is_connected || data.status === 'connected' || r.connected || r.is_connected || r.is_logged_in);
    return connected
      ? { ok: true, message: `Device “${this.deviceId}” is linked and connected.` }
      : { ok: false, message: `The server answered, but device “${this.deviceId}” isn’t linked. Scan the QR code on the server first.` };
  }
}

export function buildWhatsAppProvider(
  provider: string,
  settings: Record<string, any>,
  secrets: Record<string, any>,
  statusCallback?: string
): WhatsAppProvider | null {
  if (provider === 'meta_cloud' && settings.phoneNumberId && secrets.accessToken) return new MetaCloudProvider(settings as MetaSettings, secrets as MetaSecrets);
  if (provider === 'twilio' && settings.accountSid && secrets.authToken) return new TwilioWhatsAppProvider(settings as TwilioSettings, secrets as TwilioSecrets, statusCallback);
  if (provider === 'whatsapp_web' && settings.baseUrl) return new WhatsAppWebProvider(settings as WhatsAppWebSettings, secrets);
  return null;
}
