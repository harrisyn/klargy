import prisma from '../../lib/prisma';
import { decrypt, encrypt } from '../../lib/encryption';
import { buildAppUrl } from '../../config/appConfig';
import { buildWhatsAppProvider, type WhatsAppProvider } from './providers';
import type { WhatsAppTemplateMapping } from '../../../lib/whatsapp';

export interface LoadedWhatsAppConfig {
  id: string;
  organizationId: string;
  provider: string;
  isEnabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  verifyToken: string;
  templates: Record<string, WhatsAppTemplateMapping>;
  fallbackToSms: boolean;
  consentMode: 'EXPLICIT' | 'IMPLIED';
  defaultCountryCode: string | null;
  /** Sending through the platform's shared number rather than the org's own account. */
  viaPlatform?: boolean;
}

const asObject = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

export function readSecrets(stored: string | null | undefined): Record<string, string> {
  if (!stored) return {};
  try {
    return asObject(JSON.parse(decrypt(stored)));
  } catch (err) {
    console.error('WhatsApp credentials could not be read:', err);
    return {};
  }
}

export const writeSecrets = (secrets: Record<string, string>) => encrypt(JSON.stringify(secrets));

export interface PlatformWhatsApp {
  provider: string;
  isEnabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

/** The platform's shared WhatsApp sender (Platform services), credentials decrypted. */
export async function loadPlatformWhatsApp(): Promise<PlatformWhatsApp | null> {
  const row = await prisma.platformWhatsAppConfig.findUnique({ where: { id: 'platform' } });
  if (!row) return null;
  return { provider: row.provider, isEnabled: row.isEnabled, settings: asObject(row.settings), secrets: readSecrets(row.secrets) };
}

/** The organisation's WhatsApp settings with credentials decrypted, or null. */
export async function loadWhatsAppConfig(organizationId: string): Promise<LoadedWhatsAppConfig | null> {
  const row = await prisma.whatsAppConfig.findUnique({ where: { organizationId } });
  if (!row) return null;
  // "Klargy shared number": send with the platform's account. The org keeps
  // its own consent, fallback and country settings.
  const platform = row.provider === 'platform' ? await loadPlatformWhatsApp() : null;
  const usePlatform = !!platform?.isEnabled;
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: usePlatform ? platform!.provider : row.provider,
    isEnabled: row.isEnabled,
    settings: usePlatform ? platform!.settings : asObject(row.settings),
    secrets: usePlatform ? platform!.secrets : readSecrets(row.secrets),
    viaPlatform: usePlatform,
    verifyToken: row.verifyToken,
    templates: asObject(row.templates) as Record<string, WhatsAppTemplateMapping>,
    fallbackToSms: row.fallbackToSms,
    consentMode: row.consentMode === 'IMPLIED' ? 'IMPLIED' : 'EXPLICIT',
    defaultCountryCode: row.defaultCountryCode,
  };
}

/** Where the provider posts delivery receipts and replies for this organisation. */
export const whatsappWebhookUrl = (organizationId: string) => buildAppUrl(`/api/v1/webhooks/whatsapp/${organizationId}`);

export function providerFor(config: LoadedWhatsAppConfig): WhatsAppProvider | null {
  return buildWhatsAppProvider(config.provider, config.settings, config.secrets, whatsappWebhookUrl(config.organizationId));
}

/** The platform's own sender, for its test button. */
export async function buildPlatformProvider(): Promise<WhatsAppProvider | null> {
  const p = await loadPlatformWhatsApp();
  return p ? buildWhatsAppProvider(p.provider, p.settings, p.secrets) : null;
}
