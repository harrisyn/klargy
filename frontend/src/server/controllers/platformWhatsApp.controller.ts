import { Request, Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { mask } from '../lib/encryption';
import { readSecrets, writeSecrets, buildPlatformProvider } from '../services/whatsapp/config';
import { validateSender } from '../services/whatsapp/validate';
import { normalizeWhatsAppPhone } from '../services/whatsapp/util';
import { PLATFORM_SENDER_IDS, providerSpec } from '../../lib/whatsapp';

// Platform services → Text & WhatsApp: the shared WhatsApp sender that
// organisations can choose in Settings → WhatsApp. One sender at a time.

async function view() {
  const row = await prisma.platformWhatsAppConfig.findUnique({ where: { id: 'platform' } });
  if (!row) return { configured: false, isEnabled: false, provider: null, settings: {}, secretsMasked: {}, updatedAt: null };
  const secrets = readSecrets(row.secrets);
  const secretsMasked: Record<string, string | null> = {};
  for (const f of providerSpec(row.provider)?.secrets || []) secretsMasked[f.key] = secrets[f.key] ? mask(secrets[f.key]) : null;
  const orgsUsing = await prisma.whatsAppConfig.count({ where: { provider: 'platform' } });
  return { configured: true, isEnabled: row.isEnabled, provider: row.provider, settings: row.settings, secretsMasked, orgsUsing, updatedAt: row.updatedAt };
}

export const getPlatformWhatsApp = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await view());
  } catch (error) {
    next(error);
  }
};

export const savePlatformWhatsApp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body || {};
    const provider = String(body.provider || '');
    const spec = providerSpec(provider);
    if (!spec || !PLATFORM_SENDER_IDS.includes(spec.id)) return res.status(400).json({ error: 'Choose a WhatsApp provider.' });
    const existing = await prisma.platformWhatsAppConfig.findUnique({ where: { id: 'platform' } });
    const saved = existing?.provider === spec.id ? readSecrets(existing.secrets) : {};
    const checked = await validateSender(spec, body, saved);
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const data = {
      provider: spec.id,
      isEnabled: Boolean(body.isEnabled),
      settings: checked.settings as Prisma.InputJsonValue,
      secrets: writeSecrets(checked.secrets),
    };
    await prisma.platformWhatsAppConfig.upsert({ where: { id: 'platform' }, create: { id: 'platform', ...data }, update: data });
    res.json(await view());
  } catch (error) {
    next(error);
  }
};

/** Checks the saved credentials; with `to`, also sends a real message. */
export const testPlatformWhatsApp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = await buildPlatformProvider();
    if (!provider) return res.status(400).json({ ok: false, error: 'Save the settings first.' });
    const check = await provider.testConnection().catch((err: Error) => ({ ok: false, message: err.message }));
    if (!check.ok) return res.status(400).json({ ok: false, error: check.message });

    const rawTo = String(req.body?.to || '').trim();
    if (!rawTo) return res.json({ ok: true, message: check.message });
    const to = normalizeWhatsAppPhone(rawTo, null);
    if (!to) return res.status(400).json({ ok: false, error: 'Enter the number in international format, e.g. +233 20 000 0000.' });
    const sent = await provider.sendText(to, 'Test message: the shared WhatsApp number is set up and working.');
    if (!sent.success) return res.status(502).json({ ok: false, error: sent.error || 'WhatsApp rejected the message.' });
    res.json({ ok: true, message: `${check.message} Test message sent.` });
  } catch (error) {
    next(error);
  }
};
