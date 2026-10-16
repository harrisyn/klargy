import prisma from '../lib/prisma';
import { validTimeZone } from '../utils/date';
import { consumeCredits } from '../middleware/subscription.middleware';
import { sendNotificationEmail } from '../utils/email';
import { deliverToPhone } from './phoneDelivery';
import { readNotificationSettings } from './notifications.service';

const isRealEmail = (email: string) => !email.endsWith('@guest.qms.local');

/**
 * Reminds patients about tomorrow's appointments (APPOINTMENT_REMINDER),
 * once per appointment: the Notification row's queueEntryId holds
 * `appointment:<id>` as the dedupe key. Channels follow the org's
 * notification settings; each message uses a credit.
 */
export async function sendAppointmentReminders(): Promise<number> {
  // Runs once a day. A rolling 12-36 hour window gives every appointment one
  // reminder roughly a day ahead, whatever timezone its location is in (the
  // dedupe key stops repeats).
  const from = new Date(Date.now() + 12 * 3600000);
  const to = new Date(Date.now() + 36 * 3600000);
  const appointments = await prisma.appointment.findMany({
    where: {
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startTime: { gte: from, lt: to },
    },
    include: {
      user: { select: { id: true, email: true, phone: true, firstName: true } },
      service: {
        select: {
          name: true,
          location: { select: { name: true, timezone: true, organization: { select: { id: true, name: true, notificationSettings: true, status: true } } } },
        },
      },
    },
    take: 5000,
  });

  let sent = 0;
  for (const appt of appointments) {
    const org = appt.service.location.organization;
    if (org.status !== 'ACTIVE') continue;
    const dedupeKey = `appointment:${appt.id}`;
    const already = await prisma.notification.findFirst({ where: { queueEntryId: dedupeKey, type: 'APPOINTMENT_REMINDER' } });
    if (already) continue;

    const settings = readNotificationSettings(org.notificationSettings);
    const tz = validTimeZone(appt.service.location.timezone);
    const zone = tz ? { timeZone: tz } : {};
    const day = appt.startTime.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long', ...zone });
    const time = appt.startTime.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', ...zone });
    const message = `Reminder: your ${appt.service.name} appointment at ${appt.service.location.name} is on ${day} at ${time}. Please check in when you arrive.`;

    let emailed = false;
    if (settings.email && isRealEmail(appt.user.email)) {
      const credit = await consumeCredits(org.id, 'EMAIL', 1, 'appointment reminder');
      if (credit.allowed && (await sendNotificationEmail(appt.user.email, 'Appointment reminder', message, org.name)).success) {
        emailed = true;
      }
    }
    // WhatsApp (when on), then SMS; each records its own Notification row.
    const phoneChannel = appt.user.phone
      ? await deliverToPhone({
          organizationId: org.id,
          orgName: org.name,
          userId: appt.user.id,
          phone: appt.user.phone,
          type: 'APPOINTMENT_REMINDER',
          templateKey: 'APPOINTMENT_REMINDER',
          message,
          vars: { name: appt.user.firstName, service: appt.service.name, location: appt.service.location.name, date: day, time },
          dedupeKey,
          smsEnabled: settings.sms,
          creditReason: 'appointment reminder',
        })
      : null;
    const delivered = emailed || !!phoneChannel;

    // One row marks the reminder as handled (the dedupe key), even when
    // nothing could be delivered; the phone channels wrote their own.
    if (emailed || !phoneChannel) {
      await prisma.notification.create({
        data: {
          userId: appt.user.id,
          type: 'APPOINTMENT_REMINDER',
          channel: emailed ? 'EMAIL' : 'IN_APP',
          message,
          queueEntryId: dedupeKey,
        },
      });
    }
    if (delivered) sent++;
  }
  return sent;
}
