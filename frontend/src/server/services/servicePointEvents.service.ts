import prisma from '../lib/prisma';
import { recordQueueEvent } from './queueEvents.service';

/**
 * servicepoint.opened / servicepoint.closed (docs/connect/v1.md section 6):
 * someone signed in to or left a room (a desk of a service point), from the
 * Connect desk or anywhere else in Klargy. `staffUserId` is whoever sat at
 * the desk; `actorUserId` whoever made the change (an admin can clear
 * someone else's desk). Never throws.
 */
export async function recordServicePointEvent(
  kind: 'opened' | 'closed',
  instanceId: string,
  staffUserId: string,
  actorUserId: string | null
): Promise<void> {
  try {
    const [instance, staff] = await Promise.all([
      prisma.servicePointInstance.findUnique({
        where: { id: instanceId },
        select: {
          id: true,
          servicePointService: {
            select: { serviceId: true, servicePoint: { select: { id: true, name: true, organizationId: true } } },
          },
        },
      }),
      prisma.user.findUnique({ where: { id: staffUserId }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    if (!instance || !staff) return;
    const point = instance.servicePointService.servicePoint;
    await recordQueueEvent({
      action: kind === 'opened' ? 'servicepoint.opened' : 'servicepoint.closed',
      actorUserId,
      organizationId: point.organizationId,
      data: { servicePointId: point.id, servicePointInstanceId: instance.id, staffUserId: staff.id },
      payload: {
        servicePoint: { id: point.id, name: point.name },
        staff: { id: staff.id, name: `${staff.firstName} ${staff.lastName}`.trim() },
      },
      refSubject: { servicePoint: point.id, staff: staff.id },
    });
  } catch (error) {
    console.error(`recordServicePointEvent(${kind}) failed:`, error);
  }
}
