import type { NotificationType } from '@prisma/client';
import prisma from '../lib/prisma';
import { consumeCredits, getOrganizationFeatures } from '../middleware/subscription.middleware';
import { getSmsProvider } from './sms';
import { loadWhatsAppConfig, providerFor } from './whatsapp/config';
import { inSessionWindow, normalizeWhatsAppPhone, renderTemplateParams, templateUsable } from './whatsapp/util';
import type { WhatsAppSendResult } from './whatsapp/providers';
import type { WhatsAppTemplateKey } from '../../lib/whatsapp';

// Messages to a person's phone: WhatsApp first when the organisation has it
// switched on and the person may be messaged there, then a text message when
// the org sends texts anyway, or as a fallback when WhatsApp couldn't deliver.

export interface PhoneMessage {
  organizationId: string;
  orgName: string;
  userId: string;
  phone: string | null | undefined;
  type: NotificationType;
  /** Which approved template to use outside the 24-hour window. */
  templateKey: WhatsAppTemplateKey | null;
  /** The standard wording, sent as-is inside the window and by SMS. */
  message: string;
  /** Values for the template's parameters. */
  vars: Record<string, string | number | null | undefined>;
  /** Stored as Notification.queueEntryId: the entry id, or `appointment:<id>`. */
  dedupeKey: string;
  /** The org's "text people" setting. */
  smsEnabled: boolean;
  creditReason: string;
}

export interface WhatsAppAttempt {
  /** WhatsApp was tried (on, allowed by the plan, the person may be messaged). */
  attempted: boolean;
  sent: boolean;
  /** The org wants a text message when WhatsApp can't deliver. */
  fallbackToSms: boolean;
  reason?: string;
}

const NOT_ATTEMPTED = (reason: string): WhatsAppAttempt => ({ attempted: false, sent: false, fallbackToSms: false, reason });

/** Tries WhatsApp and records the attempt (with its delivery status) as a Notification. */
export async function sendWhatsAppNotification(m: PhoneMessage): Promise<WhatsAppAttempt> {
  if (!m.phone) return NOT_ATTEMPTED('no phone');
  const config = await loadWhatsAppConfig(m.organizationId);
  if (!config?.isEnabled) return NOT_ATTEMPTED('off');
  const features = await getOrganizationFeatures(m.organizationId);
  if (!features.whatsappNotifications) return NOT_ATTEMPTED('not in plan');
  const to = normalizeWhatsAppPhone(m.phone, config.defaultCountryCode);
  if (!to) return NOT_ATTEMPTED('invalid phone');

  const contact = await prisma.whatsAppContact.findUnique({
    where: { organizationId_phone: { organizationId: m.organizationId, phone: to } },
  });
  // Someone who replied STOP is never messaged on WhatsApp, and no fallback
  // text is sent in its place.
  if (contact?.optedOutAt && !contact.optedIn) return NOT_ATTEMPTED('opted out');
  if (config.consentMode === 'EXPLICIT' && !contact?.optedIn) return NOT_ATTEMPTED('no consent');

  const provider = providerFor(config);
  if (!provider) return { attempted: true, sent: false, fallbackToSms: config.fallbackToSms, reason: 'incomplete settings' };

  const text = `${m.orgName}: ${m.message}`;
  let result: WhatsAppSendResult;
  try {
    if (!provider.requiresTemplates) {
      result = await provider.sendText(to, text);
    } else if (inSessionWindow(contact?.lastInboundAt)) {
      // They wrote to us in the last 24 hours: a free-form message is allowed.
      result = await provider.sendText(to, text);
    } else {
      const template =
        (m.templateKey && config.templates[m.templateKey]) ||
        (m.templateKey === 'QUEUE_TRANSFERRED' ? config.templates.QUEUE_JOINED : undefined);
      if (template?.name && templateUsable(template.status)) {
        result = await provider.sendTemplate(to, template, renderTemplateParams(template.variables || [], { ...m.vars, org: m.orgName, message: m.message }));
      } else {
        result = {
          success: false,
          code: 'NO_TEMPLATE',
          outsideWindow: true,
          error: `No approved template for ${m.templateKey ?? m.type}, and the 24-hour window is closed.`,
        };
      }
    }
  } catch (err) {
    result = { success: false, code: 'NETWORK', error: err instanceof Error ? err.message : String(err) };
  }

  const now = new Date();
  await prisma.notification.create({
    data: {
      userId: m.userId,
      organizationId: m.organizationId,
      type: m.type,
      channel: 'WHATSAPP',
      message: m.message,
      queueEntryId: m.dedupeKey,
      readAt: now,
      providerMessageId: result.messageId ?? null,
      deliveryStatus: result.success ? result.status ?? 'SENT' : 'FAILED',
      deliveryError: result.success ? null : (result.error ?? 'Not sent').slice(0, 500),
      statusUpdatedAt: now,
    },
  });
  if (!result.success) console.error(`WhatsApp ${m.type} to org ${m.organizationId} not sent:`, result.error);
  return { attempted: true, sent: result.success, fallbackToSms: config.fallbackToSms, reason: result.error };
}

/** A text message through the platform SMS provider, using the org's SMS credits. */
export async function sendSmsNotification(m: Pick<PhoneMessage, 'organizationId' | 'orgName' | 'userId' | 'phone' | 'type' | 'message' | 'dedupeKey' | 'creditReason'>): Promise<boolean> {
  if (!m.phone) return false;
  const provider = await getSmsProvider();
  if (!provider) return false;
  const credit = await consumeCredits(m.organizationId, 'SMS', 1, m.creditReason);
  if (!credit.allowed) return false;
  const sent = await provider.send(m.phone, `${m.orgName}: ${m.message}`);
  if (!sent.success) {
    console.error('SMS send failed:', sent.error);
    return false;
  }
  await prisma.notification.create({
    data: { userId: m.userId, type: m.type, channel: 'SMS', message: m.message, queueEntryId: m.dedupeKey, readAt: new Date() },
  });
  return true;
}

/** WhatsApp, then SMS as the org's settings allow. Returns the channel that delivered. */
export async function deliverToPhone(m: PhoneMessage): Promise<'WHATSAPP' | 'SMS' | null> {
  if (!m.phone) return null;
  let wa: WhatsAppAttempt;
  try {
    wa = await sendWhatsAppNotification(m);
  } catch (err) {
    console.error('WhatsApp notification failed:', err);
    wa = NOT_ATTEMPTED('error');
  }
  if (wa.sent) return 'WHATSAPP';
  const textAllowed = m.smsEnabled || (wa.attempted && wa.fallbackToSms);
  if (textAllowed && (await sendSmsNotification(m))) return 'SMS';
  return null;
}
