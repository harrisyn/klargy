import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { mask } from '../lib/encryption';
import { buildAppUrl } from '../config/appConfig';
import { loadWhatsAppConfig, providerFor, readSecrets, whatsappWebhookUrl, writeSecrets } from '../services/whatsapp/config';
import { inSessionWindow, isKnownVariable, normalizeWhatsAppPhone, renderTemplateParams, templateUsable } from '../services/whatsapp/util';
import { handleWhatsAppWebhook } from '../services/whatsapp/webhook';
import { validateSender } from '../services/whatsapp/validate';
import {
  WHATSAPP_TEMPLATE_KEYS,
  providerSpec,
  type WhatsAppTemplateMapping,
} from '../../lib/whatsapp';

// Settings → WhatsApp: each organisation's own WhatsApp sender, its
// templates, a connection test and a test message. Org admins only.

const randomToken = () => crypto.randomBytes(24).toString('base64url');

const SAMPLE_VALUES = {
  name: 'Ama',
  ticket: 'C014',
  service: 'Consultation',
  position: 2,
  servicePoint: 'Room 2',
  location: 'Main clinic',
  date: 'Monday 2 March',
  time: '09:30',
};

type ConfigRow = NonNullable<Awaited<ReturnType<typeof prisma.whatsAppConfig.findUnique>>>;

async function view(organizationId: string, row: ConfigRow | null) {
  const webhookUrl = whatsappWebhookUrl(organizationId);
  // Whether the "Klargy shared number" choice can be offered.
  const platformAvailable = !!(await prisma.platformWhatsAppConfig.findUnique({ where: { id: 'platform' }, select: { isEnabled: true } }))?.isEnabled;
  if (!row) return { configured: false, webhookUrl, platformAvailable };
  const spec = providerSpec(row.provider);
  const secrets = readSecrets(row.secrets);
  const secretsMasked: Record<string, string | null> = {};
  for (const f of spec?.secrets || []) secretsMasked[f.key] = secrets[f.key] ? mask(secrets[f.key]) : null;
  const [optedIn, optedOut] = await Promise.all([
    prisma.whatsAppContact.count({ where: { organizationId, optedIn: true } }),
    prisma.whatsAppContact.count({ where: { organizationId, optedIn: false, optedOutAt: { not: null } } }),
  ]);
  return {
    configured: true,
    platformAvailable,
    provider: row.provider,
    isEnabled: row.isEnabled,
    settings: row.settings,
    secretsMasked,
    // Shown so the admin can paste them into Meta / the WhatsApp server.
    verifyToken: row.provider === 'meta_cloud' ? row.verifyToken : null,
    webhookSecret: row.provider === 'whatsapp_web' ? secrets.webhookSecret ?? null : null,
    webhookUrl,
    templates: row.templates,
    fallbackToSms: row.fallbackToSms,
    consentMode: row.consentMode,
    defaultCountryCode: row.defaultCountryCode,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
    contacts: { optedIn, optedOut },
    updatedAt: row.updatedAt,
  };
}

export const getWhatsAppConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.whatsAppConfig.findUnique({ where: { organizationId: req.params.id } });
    res.json(await view(req.params.id, row));
  } catch (error) {
    next(error);
  }
};

function cleanTemplates(raw: unknown, provider: string): { templates: Record<string, WhatsAppTemplateMapping>; error?: string } {
  const out: Record<string, WhatsAppTemplateMapping> = {};
  const src = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    const t = src[key];
    if (!t || !String(t.name || '').trim()) continue;
    const name = String(t.name).trim();
    const language = String(t.language || 'en').trim();
    if (provider === 'meta_cloud' && !/^[a-z0-9_]{1,512}$/.test(name)) {
      return { templates: out, error: `Template names are lowercase letters, numbers and underscores (“${name}”).` };
    }
    if (!/^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(language)) return { templates: out, error: `“${language}” isn’t a language code, e.g. en or en_US.` };
    const variables = Array.isArray(t.variables) ? t.variables.map(String).slice(0, 10) : [];
    const unknown = variables.find((v: string) => !isKnownVariable(v));
    if (unknown) return { templates: out, error: `Unknown template value “${unknown}”.` };
    const contentSid = String(t.contentSid || '').trim();
    if (provider === 'twilio' && !/^HX[0-9a-f]{32}$/i.test(contentSid)) {
      return { templates: out, error: `Pick the Twilio Content SID (HX…) for ${name}.` };
    }
    out[key] = {
      name,
      language,
      variables,
      status: String(t.status || 'UNKNOWN').toUpperCase().slice(0, 30),
      ...(contentSid ? { contentSid } : {}),
      ...(t.category ? { category: String(t.category).slice(0, 30) } : {}),
    };
  }
  return { templates: out };
}

export const upsertWhatsAppConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.params.id;
    const body = req.body || {};
    const spec = providerSpec(String(body.provider || ''));
    if (!spec) return res.status(400).json({ error: 'Choose a WhatsApp provider.' });
    const existing = await prisma.whatsAppConfig.findUnique({ where: { organizationId } });
    const sameProvider = existing?.provider === spec.id;

    // Blank secrets keep what's saved (for the same provider).
    const saved = sameProvider ? readSecrets(existing?.secrets) : {};
    const checked = await validateSender(spec, body, saved);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const { settings, secrets } = checked;
    if (spec.id === 'whatsapp_web') secrets.webhookSecret = saved.webhookSecret || randomToken();

    const { templates, error } = spec.templates ? cleanTemplates(body.templates, spec.id) : { templates: {} };
    if (error) return res.status(400).json({ error });

    const countryCode = String(body.defaultCountryCode ?? '').replace(/\D/g, '').slice(0, 4) || null;
    const data = {
      provider: spec.id,
      isEnabled: Boolean(body.isEnabled),
      settings: settings as Prisma.InputJsonValue,
      secrets: writeSecrets(secrets),
      templates: templates as unknown as Prisma.InputJsonValue,
      fallbackToSms: body.fallbackToSms === undefined ? true : Boolean(body.fallbackToSms),
      consentMode: body.consentMode === 'IMPLIED' ? 'IMPLIED' : 'EXPLICIT',
      defaultCountryCode: countryCode,
      // A different sender hasn't been tested yet.
      ...(sameProvider ? {} : { lastTestedAt: null, lastTestOk: null, lastTestMessage: null }),
    };
    const row = await prisma.whatsAppConfig.upsert({
      where: { organizationId },
      create: { organizationId, verifyToken: randomToken(), ...data },
      update: data,
    });
    res.json(await view(organizationId, row));
  } catch (error) {
    next(error);
  }
};

export const deleteWhatsAppConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: req.params.id } });
    res.json({ configured: false, webhookUrl: whatsappWebhookUrl(req.params.id) });
  } catch (error) {
    next(error);
  }
};

/** Checks the saved credentials with the provider; remembers the outcome. */
export const testWhatsAppConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadWhatsAppConfig(req.params.id);
    if (!config) return res.status(400).json({ error: 'Save the settings first.' });
    const provider = providerFor(config);
    let result: { ok: boolean; message: string };
    try {
      result = provider ? await provider.testConnection() : { ok: false, message: 'The settings are incomplete.' };
    } catch (err: any) {
      result = { ok: false, message: `Couldn’t reach the provider: ${err.message}` };
    }
    await prisma.whatsAppConfig.update({
      where: { organizationId: req.params.id },
      data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message.slice(0, 500) },
    });
    res.status(result.ok ? 200 : 502).json(result.ok ? result : { error: result.message, ...result });
  } catch (error) {
    next(error);
  }
};

/**
 * Sends a real message to the number given. Inside the 24-hour window (or on
 * a linked phone) a plain message; otherwise the "joined the queue" template
 * with sample values, or Meta's hello_world when none is mapped yet.
 */
export const sendWhatsAppTest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.params.id;
    const config = await loadWhatsAppConfig(organizationId);
    if (!config) return res.status(400).json({ error: 'Save the settings first.' });
    const to = normalizeWhatsAppPhone(req.body?.to, config.defaultCountryCode);
    if (!to) return res.status(400).json({ error: 'Enter a phone number in international format, e.g. +233 20 000 0000.' });
    const provider = providerFor(config);
    if (!provider) return res.status(400).json({ error: 'The settings are incomplete.' });
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const contact = await prisma.whatsAppContact.findUnique({ where: { organizationId_phone: { organizationId, phone: to } } });

    const text = `${org?.name ?? 'Test'}: Test message: WhatsApp notifications are set up and working.`;
    let via: 'text' | 'template';
    let result;
    try {
      if (!provider.requiresTemplates || inSessionWindow(contact?.lastInboundAt)) {
        via = 'text';
        result = await provider.sendText(to, text);
      } else {
        via = 'template';
        const mapped = config.templates.QUEUE_JOINED;
        const template: WhatsAppTemplateMapping | null =
          mapped?.name && templateUsable(mapped.status) ? mapped
          : config.provider === 'meta_cloud' ? { name: 'hello_world', language: 'en_US', variables: [] }
          : null;
        if (!template) {
          return res.status(400).json({
            error: 'Map an approved template to “Joined the queue” first, or send a message to your WhatsApp number from this phone and try again within 24 hours.',
          });
        }
        result = await provider.sendTemplate(
          to,
          template,
          renderTemplateParams(template.variables || [], { ...SAMPLE_VALUES, org: org?.name, statusUrl: buildAppUrl('/status'), message: text })
        );
      }
    } catch (err: any) {
      return res.status(502).json({ error: `Couldn’t reach the provider: ${err.message}` });
    }
    if (!result.success) {
      const hint = result.outsideWindow ? ' The number hasn’t written to you in the last 24 hours, so only an approved template can be sent.' : '';
      return res.status(502).json({ error: `${result.error || 'The provider rejected the message.'}${hint}` });
    }
    res.json({ ok: true, via, messageId: result.messageId ?? null });
  } catch (error) {
    next(error);
  }
};

/** Loads the templates from the provider, and refreshes the status of mapped ones. */
export const syncWhatsAppTemplates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadWhatsAppConfig(req.params.id);
    if (!config) return res.status(400).json({ error: 'Save the settings first.' });
    const provider = providerFor(config);
    if (!provider?.listTemplates) return res.status(400).json({ error: 'This provider has no templates.' });
    let available;
    try {
      available = await provider.listTemplates();
    } catch (err: any) {
      return res.status(err.status || 502).json({ error: err.message });
    }
    const templates = { ...config.templates };
    for (const [key, t] of Object.entries(templates)) {
      const match = available.find((a) => (t.contentSid ? a.contentSid === t.contentSid : a.name === t.name && a.language === t.language));
      templates[key] = { ...t, status: match ? match.status : 'MISSING', ...(match?.category ? { category: match.category } : {}) };
    }
    await prisma.whatsAppConfig.update({ where: { organizationId: req.params.id }, data: { templates: templates as unknown as Prisma.InputJsonValue } });
    res.json({ available, templates });
  } catch (error) {
    next(error);
  }
};

/** Public: delivery receipts, replies and Meta's verification, per organisation. */
export const whatsappWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const result = await handleWhatsAppWebhook(req.params.orgId, {
      method: req.method,
      headers: req.headers,
      query: req.query as Record<string, unknown>,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''),
      requestUrl: `${proto}://${host}${req.originalUrl}`,
    });
    res.status(result.status).type(result.body.startsWith('<') ? 'text/xml' : 'text/plain').send(result.body);
  } catch (error) {
    next(error);
  }
};
