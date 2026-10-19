import { assertPublicUrl } from '../../lib/urlSafety';
import type { WhatsAppProviderSpec } from '../../../lib/whatsapp';

export type SenderInput = { settings?: Record<string, unknown>; secrets?: Record<string, unknown> };

/**
 * Checks a provider's settings and secrets from a form. Blank secrets keep
 * `savedSecrets`. Shared by the organisation and platform WhatsApp settings.
 */
export async function validateSender(
  spec: WhatsAppProviderSpec,
  body: SenderInput,
  savedSecrets: Record<string, string>
): Promise<{ ok: true; settings: Record<string, string>; secrets: Record<string, string> } | { ok: false; error: string }> {
  const settings: Record<string, string> = {};
  for (const f of spec.fields) {
    const value = String(body.settings?.[f.key] ?? '').trim().slice(0, 500);
    if (value) settings[f.key] = value;
    else if (f.required) return { ok: false, error: `Enter the ${f.label.toLowerCase()}.` };
  }
  if (spec.id === 'twilio' && !settings.from && !settings.messagingServiceSid) {
    return { ok: false, error: 'Twilio needs a WhatsApp sender number or a Messaging Service SID.' };
  }
  if (spec.id === 'twilio' && !/^AC[0-9a-f]{32}$/i.test(settings.accountSid)) return { ok: false, error: 'The account SID starts with AC.' };
  if (spec.id === 'whatsapp_web') {
    try {
      await assertPublicUrl(settings.baseUrl);
    } catch (err: any) {
      return { ok: false, error: `Server address: ${err.message}` };
    }
    settings.baseUrl = settings.baseUrl.replace(/\/$/, '');
  }

  const secrets: Record<string, string> = {};
  for (const f of spec.secrets) {
    const value = String(body.secrets?.[f.key] ?? '').trim().slice(0, 2000);
    if (value) secrets[f.key] = value;
    else if (savedSecrets[f.key]) secrets[f.key] = savedSecrets[f.key];
    else if (f.required) return { ok: false, error: `Enter the ${f.label.toLowerCase()}.` };
  }
  return { ok: true, settings, secrets };
}
