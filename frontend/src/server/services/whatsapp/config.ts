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

/** The organisation's WhatsApp settings with credentials decrypted, or null. */
export async function loadWhatsAppConfig(organizationId: string): Promise<LoadedWhatsAppConfig | null> {
  const row = await prisma.whatsAppConfig.findUnique({ where: { organizationId } });
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    isEnabled: row.isEnabled,
    settings: asObject(row.settings),
    secrets: readSecrets(row.secrets),
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
