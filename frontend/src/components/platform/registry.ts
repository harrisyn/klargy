import api from '@/api/client';
import { WHATSAPP_PROVIDERS, PLATFORM_SENDER_IDS } from '@/lib/whatsapp';

// Platform services: every integration the platform admin configures, as
// data. The page builds its tiles and settings forms from these definitions,
// so a new provider is one entry here (plus its server code), not a new page.

export type Area = 'messaging' | 'ai' | 'storage' | 'payments' | 'addons';
export type SourceKey = 'sms' | 'whatsapp' | 'ai' | 'storage' | 'payments' | 'addons';

export interface Field {
  key: string;
  label: string;
  /** secret: stored encrypted and shown masked; blank keeps the saved value. */
  kind?: 'text' | 'secret' | 'toggle' | 'number';
  placeholder?: string;
  hint?: string;
  /** Suggested values for a text field (any other value can be typed). */
  suggestions?: string[];
  /** Must be filled in on every save, even when one is already saved. */
  alwaysRequired?: boolean;
}

export interface ServiceState {
  configured: boolean;
  isActive: boolean;
  values: Record<string, string>;
  secretsMasked: Record<string, string | null>;
  /** One line shown on the tile, e.g. a price. */
  summary?: string;
}

export interface Service {
  id: string;
  area: Area;
  group: string;
  name: string;
  note: string;
  source: SourceKey;
  fields: Field[];
  /** Label of the on/off switch. Omit for settings that have no on/off (prices). */
  activeLabel?: string;
  /** Extra input the Test button needs (a phone number to message). */
  testInput?: { label: string; placeholder: string; optional?: boolean };
  testLabel?: string;
  state(data: any): ServiceState;
  save(values: Record<string, string>, secrets: Record<string, string>, isActive: boolean): Promise<void>;
  test?(values: Record<string, string>, secrets: Record<string, string>, input: string): Promise<string>;
}

export const AREAS: { id: Area; title: string; blurb: string }[] = [
  { id: 'messaging', title: 'Text & WhatsApp', blurb: 'How “you’re nearly up” alerts and reminders are sent.' },
  { id: 'ai', title: 'AI', blurb: 'The model behind AI-assisted analytics. One at a time.' },
  { id: 'storage', title: 'File storage', blurb: 'Where logos and lobby media are kept. One at a time.' },
  { id: 'payments', title: 'Payments', blurb: 'How organizations pay for plans and add-ons.' },
  { id: 'addons', title: 'Add-ons', blurb: 'What extra locations, seats and media packs cost.' },
];

const empty = (): ServiceState => ({ configured: false, isActive: false, values: {}, secretsMasked: {} });

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

const SMS: Record<string, { name: string; note: string; account: string; secret: string; sender: string; senderHint: string }> = {
  twilio: { name: 'Twilio', note: 'Works worldwide. Use a Twilio phone number as the sender.', account: 'Account SID', secret: 'Auth token', sender: 'From number', senderHint: 'e.g. +15005550006' },
  africastalking: {
    name: 'Africa’s Talking',
    note: 'Good coverage and pricing across Africa. Use “sandbox” as the username to test.',
    account: 'Username',
    secret: 'API key',
    sender: 'Sender ID (optional)',
    senderHint: 'An approved short code or sender name',
  },
};

const smsServices: Service[] = Object.entries(SMS).map(([provider, info]) => ({
  id: `sms:${provider}`,
  area: 'messaging',
  group: 'Text messages',
  name: info.name,
  note: `${info.note} Each text uses one of the organization’s message credits. Only one text provider sends at a time.`,
  source: 'sms',
  fields: [
    { key: 'accountId', label: info.account },
    { key: 'secret', label: info.secret, kind: 'secret' },
    { key: 'senderId', label: info.sender, placeholder: info.senderHint },
  ],
  activeLabel: 'Send text messages with this provider',
  testInput: { label: 'Send a test to', placeholder: '+233 20 000 0000' },
  testLabel: 'Send a test',
  state: (d) => {
    const r = d?.providers?.find((p: any) => p.provider === provider);
    if (!r?.configured) return empty();
    return { configured: true, isActive: r.isActive, values: { accountId: r.accountId || '', senderId: r.senderId || '' }, secretsMasked: { secret: r.secretMasked } };
  },
  save: async (v, s, isActive) => {
    await api.saveSmsProvider(provider, { accountId: v.accountId, secret: s.secret || undefined, senderId: v.senderId, isActive });
  },
  test: async (_v, _s, to) => {
    await api.testSmsProvider(provider, to);
    return `Test message sent to ${to}.`;
  },
}));

// ---------------------------------------------------------------------------
// WhatsApp (the platform's shared sender)
// ---------------------------------------------------------------------------

const WA_NAMES: Record<string, string> = { whatsapp_web: 'WhatsApp Web (linked phone)', meta_cloud: 'WhatsApp Cloud API (Meta)', twilio: 'Twilio WhatsApp' };

const whatsappServices: Service[] = PLATFORM_SENDER_IDS.map((id) => WHATSAPP_PROVIDERS.find((p) => p.id === id)!).map((spec) => ({
  id: `wa:${spec.id}`,
  area: 'messaging' as const,
  group: 'WhatsApp (shared number)',
  name: WA_NAMES[spec.id] || spec.label,
  note: `${spec.note} Organizations pick “Klargy shared number” in Settings → WhatsApp to use it, and still choose their own consent and fallback rules. The shared number only sends: replies and STOP messages sent to it aren’t read.${spec.templates ? ' Without approved templates it can only message people inside WhatsApp’s 24-hour window, so a linked phone suits a shared number best.' : ''}`,
  source: 'whatsapp' as const,
  fields: [
    ...spec.fields.map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder, hint: f.hint })),
    ...spec.secrets.map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder, hint: f.hint, kind: 'secret' as const })),
  ],
  activeLabel: 'Offer this as the Klargy shared number',
  testInput: { label: 'Also send a test message to', placeholder: '+233 20 000 0000', optional: true },
  testLabel: 'Test connection',
  state: (d: any): ServiceState =>
    d?.configured && d.provider === spec.id
      ? { configured: true, isActive: d.isEnabled, values: d.settings || {}, secretsMasked: d.secretsMasked || {}, summary: d.orgsUsing ? `${d.orgsUsing} organization${d.orgsUsing === 1 ? '' : 's'} using it` : undefined }
      : empty(),
  save: async (v: Record<string, string>, s: Record<string, string>, isActive: boolean) => {
    await api.savePlatformWhatsApp({ provider: spec.id, isEnabled: isActive, settings: v, secrets: s });
  },
  test: async (_v: Record<string, string>, _s: Record<string, string>, to: string) => {
    const r = await api.testPlatformWhatsApp(to.trim() || undefined);
    return r.message || 'Connected.';
  },
}));

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

const OPENAI_MODELS = ['gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3'];

interface AiMeta {
  label: string;
  keyHint: string;
  modelLabel?: string;
  modelHint: string;
  models?: string[];
  baseUrl?: { label: string; placeholder: string; hint: string };
  apiVersion?: boolean;
  blurb: string;
}

const AI: Record<string, AiMeta> = {
  anthropic: { label: 'Anthropic (Claude)', keyHint: 'sk-ant-…', modelHint: 'Leave empty for the default (claude-opus-5)', blurb: 'Recommended default. Declined requests are automatically retried on a fallback Claude model.' },
  openai: {
    label: 'OpenAI',
    keyHint: 'sk-…',
    modelHint: 'Pick a suggestion or type any model your OpenAI project can use. Leave empty for the default.',
    models: OPENAI_MODELS,
    baseUrl: { label: 'Base URL (optional)', placeholder: 'https://api.openai.com/v1', hint: 'Only for a proxy or gateway. It must support the Responses API, or set OPENAI_API=chat on the server.' },
    blurb: 'Responses API with strict function calling and parallel tool calls; reasoning state is kept between steps without OpenAI storing the conversation. Reasoning effort is set with AI_REASONING_EFFORT.',
  },
  azure_openai: {
    label: 'Azure OpenAI',
    keyHint: 'Key from the Azure OpenAI resource',
    modelLabel: 'Deployment name',
    modelHint: 'The name you gave the model deployment in Azure (not the model name, unless they match)',
    models: OPENAI_MODELS,
    baseUrl: { label: 'Endpoint', placeholder: 'https://my-resource.openai.azure.com', hint: 'The resource endpoint from the Azure portal (Keys and Endpoint)' },
    apiVersion: true,
    blurb: 'Chat Completions against an Azure OpenAI deployment, with the same tool and reasoning handling as OpenAI.',
  },
  gemini: { label: 'Google Gemini', keyHint: 'Google AI Studio API key', modelHint: 'Gemini model name, e.g. from AI Studio', blurb: 'Generative Language API with function calling.' },
  openai_compatible: {
    label: 'OpenAI-compatible endpoint',
    keyHint: 'API key for the endpoint',
    modelHint: 'Model name on that endpoint',
    baseUrl: { label: 'Base URL', placeholder: 'https://api.example.com/v1', hint: 'The URL that /chat/completions is appended to' },
    blurb: 'Mistral, xAI, Groq, DeepSeek, OpenRouter, or a self-hosted server (vLLM, Ollama) that speaks the OpenAI chat API.',
  },
};

// Azure keeps the api-version on the endpoint URL (?api-version=...); the form edits them separately.
function splitApiVersion(baseUrl: string): { baseUrl: string; apiVersion: string } {
  try {
    const url = new URL(baseUrl);
    const apiVersion = url.searchParams.get('api-version') || '';
    url.searchParams.delete('api-version');
    return { baseUrl: url.toString().replace(/\/$/, '').replace(/\?$/, ''), apiVersion };
  } catch {
    return { baseUrl, apiVersion: '' };
  }
}
function joinApiVersion(baseUrl: string, apiVersion: string): string {
  if (!baseUrl || !apiVersion.trim()) return baseUrl;
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion.trim())}`;
}

const aiServices: Service[] = Object.entries(AI).map(([provider, m]) => {
  const finalUrl = (v: Record<string, string>) => (m.apiVersion ? joinApiVersion((v.baseUrl || '').trim(), v.apiVersion || '') : (v.baseUrl || '').trim());
  return {
    id: `ai:${provider}`,
    area: 'ai' as const,
    group: 'AI providers',
    name: m.label,
    note: `${m.blurb} Tenants also need the AI feature in their plan. The model only receives aggregated queue statistics, never names or contact details.`,
    source: 'ai' as const,
    fields: [
      { key: 'apiKey', label: 'API key', kind: 'secret' as const, placeholder: m.keyHint },
      { key: 'model', label: m.modelLabel || 'Model', placeholder: m.modelHint.length < 50 ? m.modelHint : undefined, hint: m.modelHint, suggestions: m.models },
      ...(m.baseUrl ? [{ key: 'baseUrl', label: m.baseUrl.label, placeholder: m.baseUrl.placeholder, hint: m.baseUrl.hint }] : []),
      ...(m.apiVersion ? [{ key: 'apiVersion', label: 'API version', placeholder: '2024-10-21', hint: 'Leave empty for the default' }] : []),
    ],
    activeLabel: 'Use this provider for AI analytics',
    testLabel: 'Test',
    state: (d: any): ServiceState => {
      const r = (d as any[] | undefined)?.find((p) => p.provider === provider);
      if (!r?.configured) return empty();
      const split = m.apiVersion ? splitApiVersion(r.baseUrl || '') : { baseUrl: r.baseUrl || '', apiVersion: '' };
      return { configured: true, isActive: r.isActive, values: { model: r.model || '', baseUrl: split.baseUrl, apiVersion: split.apiVersion }, secretsMasked: { apiKey: r.apiKeyMasked } };
    },
    save: async (v: Record<string, string>, s: Record<string, string>, isActive: boolean) => {
      await api.saveAiProvider(provider, { apiKey: s.apiKey || undefined, model: (v.model || '').trim() || undefined, baseUrl: finalUrl(v) || undefined, isActive });
    },
    test: async (v: Record<string, string>, s: Record<string, string>) => {
      const r = await api.testAiProvider(provider, { apiKey: s.apiKey || undefined, model: (v.model || '').trim() || undefined, baseUrl: finalUrl(v) || undefined });
      if (!r.ok) throw Object.assign(new Error(r.error || 'The test failed.'), { response: { data: { error: r.error || 'The test failed.' } } });
      return `Works: ${r.model || 'the model'} answered${r.latencyMs ? ` in ${r.latencyMs} ms` : ''}.`;
    },
  };
});

// ---------------------------------------------------------------------------
// File storage
// ---------------------------------------------------------------------------

const storageServices: Service[] = [
  {
    id: 'storage:uploadcare',
    area: 'storage',
    group: 'File storage',
    name: 'Uploadcare',
    note: 'Hosted file storage and CDN. Supports large direct uploads from the browser.',
    source: 'storage',
    fields: [
      { key: 'publicKey', label: 'Public key' },
      { key: 'secretKey', label: 'Secret key', kind: 'secret' },
    ],
    activeLabel: 'Store uploads with this provider',
    testLabel: 'Check keys',
    state: (d) => {
      const r = (d as any[] | undefined)?.find((p) => p.provider === 'uploadcare');
      return r?.configured ? { configured: true, isActive: r.isActive, values: { publicKey: r.publicKey || '' }, secretsMasked: { secretKey: r.secretKeyMasked } } : empty();
    },
    save: async (v, s, isActive) => {
      await api.saveFileStorageProvider('uploadcare', { publicKey: v.publicKey, secretKey: s.secretKey || undefined, isActive });
    },
    test: async () => {
      await api.testFileStorageProvider('uploadcare');
      return 'The keys look valid.';
    },
  },
  {
    id: 'storage:s3',
    area: 'storage',
    group: 'File storage',
    name: 'S3-compatible',
    note: 'Amazon S3, MinIO, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, Wasabi and anything else that speaks the S3 API. Files are uploaded through the server and read from the public URL you give, which must serve the bucket (or a CDN in front of it).',
    source: 'storage',
    fields: [
      { key: 'publicKey', label: 'Access key ID' },
      { key: 'secretKey', label: 'Secret access key', kind: 'secret' },
      { key: 'endpoint', label: 'Endpoint', placeholder: 'https://minio.example.com', hint: 'Leave empty for Amazon S3.' },
      { key: 'region', label: 'Region', placeholder: 'eu-west-1', hint: 'MinIO and R2 usually accept us-east-1 or auto.' },
      { key: 'bucket', label: 'Bucket', placeholder: 'klargy-media' },
      { key: 'publicBaseUrl', label: 'Public URL', placeholder: 'https://media.klargy.com', hint: 'Where browsers read files: the bucket URL or a CDN.' },
      { key: 'prefix', label: 'Folder (optional)', placeholder: 'klargy' },
      { key: 'pathStyle', label: 'Path-style addressing', kind: 'toggle', hint: 'On for MinIO and most self-hosted servers. Off for AWS S3 and most hosted services.' },
    ],
    activeLabel: 'Store uploads with this provider',
    testLabel: 'Write a test file',
    state: (d): ServiceState => {
      const r = (d as any[] | undefined)?.find((p) => p.provider === 's3');
      if (!r?.configured) return { ...empty(), values: { pathStyle: 'true' } };
      const s = r.settings || {};
      return {
        configured: true,
        isActive: r.isActive,
        values: { publicKey: r.publicKey || '', endpoint: s.endpoint || '', region: s.region || '', bucket: s.bucket || '', publicBaseUrl: s.publicBaseUrl || '', prefix: s.prefix || '', pathStyle: s.pathStyle === false ? 'false' : 'true' },
        secretsMasked: { secretKey: r.secretKeyMasked },
        summary: s.bucket ? `Bucket ${s.bucket}` : undefined,
      };
    },
    save: async (v, s, isActive) => {
      await api.saveFileStorageProvider('s3', {
        publicKey: v.publicKey,
        secretKey: s.secretKey || undefined,
        isActive,
        settings: { endpoint: v.endpoint, region: v.region, bucket: v.bucket, publicBaseUrl: v.publicBaseUrl, prefix: v.prefix, pathStyle: v.pathStyle !== 'false' },
      });
    },
    test: async () => {
      const r = (await api.testFileStorageProvider('s3')) as { message?: string };
      return r.message || 'Storage works.';
    },
  },
];

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const paymentServices: Service[] = [
  { provider: 'stripe', name: 'Stripe', note: 'Card payments worldwide.' },
  { provider: 'paystack', name: 'Paystack', note: 'Cards and mobile money across Africa.' },
].map(({ provider, name, note }) => ({
  id: `pay:${provider}`,
  area: 'payments' as const,
  group: 'Payments',
  name,
  note: `${note} Enter both secrets each time you save.`,
  source: 'payments' as const,
  fields: [
    { key: 'publicKey', label: 'Public key' },
    { key: 'secretKey', label: 'Secret key', kind: 'secret' as const, alwaysRequired: true },
    { key: 'webhookSecret', label: 'Webhook secret', kind: 'secret' as const, alwaysRequired: true },
  ],
  activeLabel: 'Take payments with this provider',
  testLabel: 'Check keys',
  state: (d: any): ServiceState => {
    const r = (d as any[] | undefined)?.find((p) => p.provider === provider);
    return r?.configured ? { configured: true, isActive: r.isActive, values: { publicKey: r.publicKey || '' }, secretsMasked: { secretKey: r.secretKeyMasked } } : empty();
  },
  save: async (v: Record<string, string>, s: Record<string, string>, isActive: boolean) => {
    await api.savePaymentProvider(provider as 'stripe' | 'paystack', { publicKey: v.publicKey, secretKey: s.secretKey, webhookSecret: s.webhookSecret, isActive });
  },
  test: async () => {
    const r = await api.testPaymentProvider(provider as 'stripe' | 'paystack');
    if (r && r.ok === false) throw Object.assign(new Error(r.error), { response: { data: { error: r.error || 'The keys were rejected.' } } });
    return 'The keys look valid.';
  },
}));

// ---------------------------------------------------------------------------
// Add-on pricing
// ---------------------------------------------------------------------------

const ADDONS: { type: 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA'; name: string; note: string }[] = [
  { type: 'LOCATIONS', name: 'Extra location', note: 'What an organization pays for each location beyond its plan limit.' },
  { type: 'USERS', name: 'Extra staff seat', note: 'What an organization pays for each staff user beyond its plan limit.' },
  { type: 'DISPLAY_MEDIA', name: 'Lobby media pack', note: 'Large uploads, streams and 25 more playlist items for lobby screens.' },
];

const addonServices: Service[] = ADDONS.map(({ type, name, note }) => ({
  id: `addon:${type}`,
  area: 'addons' as const,
  group: 'Add-ons',
  name,
  note,
  source: 'addons' as const,
  fields: [
    { key: 'pricePerUnitMonthly', label: 'Price per unit / month (recurring)', kind: 'number' as const },
    { key: 'pricePerUnitOneOff', label: 'Price per unit (one-off)', kind: 'number' as const },
    { key: 'currency', label: 'Currency', placeholder: 'USD' },
  ],
  state: (d: any): ServiceState => {
    const r = (d as any[] | undefined)?.find((p) => p.resourceType === type);
    if (!r) return empty();
    return {
      configured: true,
      isActive: true,
      values: { pricePerUnitMonthly: String(r.pricePerUnitMonthly ?? ''), pricePerUnitOneOff: String(r.pricePerUnitOneOff ?? ''), currency: r.currency || 'USD' },
      secretsMasked: {},
      summary: `${r.currency || 'USD'} ${Number(r.pricePerUnitMonthly) || 0}/mo · ${Number(r.pricePerUnitOneOff) || 0} once`,
    };
  },
  save: async (v: Record<string, string>) => {
    await api.updateAddOnPricing(type, { pricePerUnitMonthly: parseFloat(v.pricePerUnitMonthly) || 0, pricePerUnitOneOff: parseFloat(v.pricePerUnitOneOff) || 0, currency: (v.currency || 'USD').trim().toUpperCase() });
  },
}));

export const SERVICES: Service[] = [...smsServices, ...whatsappServices, ...aiServices, ...storageServices, ...paymentServices, ...addonServices];

export const serviceById = (id: string | null | undefined) => SERVICES.find((s) => s.id === id);

/** Loads one data source; the services that read from it derive their state from the result. */
export const SOURCES: Record<SourceKey, () => Promise<unknown>> = {
  sms: () => api.listSmsProviders(),
  whatsapp: () => api.getPlatformWhatsApp(),
  ai: () => api.getAiProviders(),
  storage: () => api.getFileStorageProviders(),
  payments: () => api.getPaymentProviders(),
  addons: () => api.getAddOnPricing(),
};
