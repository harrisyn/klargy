import prisma from '../lib/prisma';
import { bookedPlaceAt, readBookedArrivalSettings, type BookedArrivalSettings } from './queueOrder';

/** What a booked patient's queue entry records about their appointment. */
export interface BookedFields {
  appointmentId: string;
  bookedFor: Date;
  /** Their booked time when they arrived on time, else null (a walk-in). */
  bookedPlaceAt: Date | null;
}

export async function bookedArrivalSettings(organizationId: string): Promise<BookedArrivalSettings> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { bookedArrivalSettings: true } });
  return readBookedArrivalSettings(org?.bookedArrivalSettings);
}

/**
 * The fields for the entry of a booked patient arriving at `arrivedAt`
 * (docs/guides/outpatient-journey.md, "Booked patients on arrival"): the
 * appointment and its time always (the "Booked 10:30" chip), and the place
 * in line by booked time only when the setting is on and they are within
 * the window around it.
 */
export function bookedFields(
  appointment: { id: string; startTime: Date },
  settings: BookedArrivalSettings,
  arrivedAt: Date = new Date()
): BookedFields {
  return {
    appointmentId: appointment.id,
    bookedFor: appointment.startTime,
    bookedPlaceAt: bookedPlaceAt(appointment.startTime, arrivedAt, settings),
  };
}
