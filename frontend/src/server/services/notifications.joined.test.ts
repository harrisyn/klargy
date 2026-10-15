import { describe, it, expect, vi, beforeEach } from 'vitest';

// The "you've joined" message links to the patient's live status page.

const db = vi.hoisted(() => ({
  notification: { findFirst: vi.fn(), create: vi.fn(async ({ data }: any) => ({ id: 'n1', ...data })) },
  queueEntry: { findUnique: vi.fn() },
}));
vi.mock('../lib/prisma', () => ({ default: db, prisma: db }));
vi.mock('../lib/realtime', () => ({ emitToUser: vi.fn(), emitToQueue: vi.fn(), SOCKET_EVENTS: { NOTIFICATION_SENT: 'notification.sent' } }));
vi.mock('../middleware/subscription.middleware', () => ({ consumeCredits: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../utils/email', () => ({ sendNotificationEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('./sms', () => ({ getSmsProvider: vi.fn(async () => ({ send: vi.fn(async () => ({ success: true })) })) }));

import { emitToQueue } from '../lib/realtime';
import { buildMessage, notifyEntry } from './notifications.service';

beforeEach(() => vi.clearAllMocks());

describe('QUEUE_JOINED', () => {
  it('ends with a link to track their place', () => {
    const { message } = buildMessage('QUEUE_JOINED', { ticket: 'C014', service: 'GP Consultation', statusUrl: 'https://nyaho.example.com/status/q1/e1' });
    expect(message).toBe(
      "Your ticket for GP Consultation is C014. We'll let you know when your turn is close. Track your place: https://nyaho.example.com/status/q1/e1"
    );
  });

  it('is sent with the status page on the organisation’s address, and told to the status page live', async () => {
    db.notification.findFirst.mockResolvedValue(null);
    db.queueEntry.findUnique.mockResolvedValue({
      id: 'e1', queueId: 'q1', ticketNumber: 'C014',
      user: { id: 'u1', email: 'connect_x@guest.qms.local', phone: null },
      queue: { service: { name: 'GP Consultation', location: { organization: { id: 'org1', name: 'Nyaho', slug: 'nyaho', notificationSettings: null } } } },
    });
    await notifyEntry('e1', 'QUEUE_JOINED');
    const inApp = db.notification.create.mock.calls[0][0].data;
    expect(inApp).toMatchObject({ channel: 'IN_APP', type: 'QUEUE_JOINED', queueEntryId: 'e1' });
    expect(inApp.message).toMatch(/Track your place: https?:\/\/nyaho\.[^/]+\/status\/q1\/e1$/);
    expect(emitToQueue).toHaveBeenCalledWith('q1', 'notification.sent', expect.objectContaining({ entryId: 'e1', type: 'QUEUE_JOINED' }));
    // A Connect patient's placeholder address is never emailed.
    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });
});
