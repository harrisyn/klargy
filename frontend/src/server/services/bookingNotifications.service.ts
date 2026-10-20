import prisma from '../lib/prisma';
import { validTimeZone } from '../utils/date';
import { buildAppUrl } from '../config/appConfig';
import { sendNotificationEmail } from '../utils/email';

const isRealEmail = (email: string) => !email.endsWith('@guest.qms.local');

/** The customer's private link to view, change or cancel a booking. */
export const manageLinkFor = (manageToken: string, slug?: string | null) => buildAppUrl(`/booking/${manageToken}`, slug);

/** Emails the booking confirmation (with the manage link) when the customer left a real address. */
export async function sendBookingConfirmation(appointmentId: string): Promise<void> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      user: { select: { firstName: true, email: true } },
      service: { include: { location: { include: { organization: { select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true, hidePoweredBy: true } } } } } },
    },
  });
  if (!a || !a.manageToken || !isRealEmail(a.user.email)) return;
  const org = a.service.location.organization;
  const tz = validTimeZone(a.service.location.timezone);
  const zone = tz ? { timeZone: tz } : {};
  const day = a.startTime.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long', ...zone });
  const time = a.startTime.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', ...zone });
  const details: Array<[string, string]> = [];
  if (a.service.bookingUnit === 'PERSON') details.push(['Party size', String(a.partySize)]);
  if (a.amount != null && Number(a.amount) > 0) {
    details.push(['Total', `${Number(a.amount).toFixed(2)} ${a.currency ?? ''}`.trim()]);
    if (a.amountPaid != null) details.push(['Paid', `${Number(a.amountPaid).toFixed(2)} ${a.currency ?? ''}`.trim()]);
    const balance = Number(a.amount) - Number(a.amountPaid ?? 0);
    if (balance > 0.005) details.push(['To pay on the day', `${balance.toFixed(2)} ${a.currency ?? ''}`.trim()]);
  }
  await sendNotificationEmail(a.user.email, 'Your booking is confirmed', `Thanks ${a.user.firstName}, you're booked with ${org.name}. Please arrive a few minutes early and check in when you get there.`, {
    brand: org,
    eyebrow: 'Booking confirmed',
    board: { label: day, value: time, caption: a.service.name, side: { label: 'Where', value: a.service.location.name } },
    details,
    action: { href: manageLinkFor(a.manageToken, org.slug), label: 'View, change or cancel' },
    reason: `You're receiving this because you booked with ${org.name}.`,
  }).catch((e) => console.error('Booking confirmation email failed:', e));
}
