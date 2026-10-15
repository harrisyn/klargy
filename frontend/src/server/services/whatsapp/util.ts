import { WHATSAPP_VARIABLES, type WhatsAppTemplateKey, type WhatsAppDeliveryStatus } from '../../../lib/whatsapp';

/**
 * A phone number as WhatsApp wants it: digits only, with the country code
 * (233200000000). A number typed locally with a leading 0 gets the org's
 * default country code. Null when it can't be a phone number.
 */
export function normalizeWhatsAppPhone(raw: unknown, defaultCountryCode?: string | null): string | null {
  const s = String(raw ?? '').trim().replace(/^whatsapp:/i, '').replace(/@s\.whatsapp\.net$/i, '');
  if (!s) return null;
  const international = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  const cc = String(defaultCountryCode || '').replace(/\D/g, '');
  if (!international && cc && digits.startsWith('0')) digits = cc + digits.replace(/^0+/, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** A transfer ("sent to") is a QUEUE_JOINED for the new service, with its own template. */
export function templateKeyFor(type: string, opts: { transferred?: boolean } = {}): WhatsAppTemplateKey | null {
  if (type === 'QUEUE_JOINED') return opts.transferred ? 'QUEUE_TRANSFERRED' : 'QUEUE_JOINED';
  if (type === 'TURN_APPROACHING' || type === 'NOW_SERVING' || type === 'QUEUE_DELAYED' || type === 'APPOINTMENT_REMINDER') return type;
  return null;
}

/**
 * Template parameter values in order. WhatsApp rejects empty parameters and
 * ones with new lines, tabs or more than four spaces in a row.
 */
export function renderTemplateParams(variables: string[], values: Record<string, string | number | null | undefined>): string[] {
  return variables.map((key) => {
    const raw = values[key];
    const text = String(raw ?? '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/ {4,}/g, '   ')
      .trim()
      .slice(0, 1000);
    return text || '-';
  });
}

export const isKnownVariable = (key: string) => Object.prototype.hasOwnProperty.call(WHATSAPP_VARIABLES, key);

/** Template statuses that will not send. */
const UNUSABLE = new Set(['REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'UNSUBMITTED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED']);
export const templateUsable = (status?: string) => !UNUSABLE.has(String(status || 'UNKNOWN').toUpperCase());

const RANK: Record<WhatsAppDeliveryStatus, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };
/** Webhooks can arrive out of order: never move a message back (read → delivered). */
export function shouldAdvanceStatus(current: string | null | undefined, next: WhatsAppDeliveryStatus): boolean {
  if (!current) return true;
  if (current === 'FAILED') return false;
  return RANK[next] > (RANK[current as WhatsAppDeliveryStatus] ?? -1);
}

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const inSessionWindow = (lastInboundAt: Date | null | undefined, now = Date.now()) =>
  !!lastInboundAt && now - new Date(lastInboundAt).getTime() < SESSION_WINDOW_MS;

const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT']);
const OPT_IN = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'YES', 'OPTIN', 'OPT IN']);
/** What an inbound message asks for, from its first words. */
export function consentKeyword(text: string | null | undefined): 'OPT_OUT' | 'OPT_IN' | null {
  const t = String(text || '').trim().toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ');
  if (!t) return null;
  if (OPT_OUT.has(t) || OPT_OUT.has(t.replace(/ /g, ''))) return 'OPT_OUT';
  if (OPT_IN.has(t) || OPT_IN.has(t.replace(/ /g, ''))) return 'OPT_IN';
  return null;
}
