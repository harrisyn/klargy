import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { retryDueDeliveries } from '../services/webhooks.service';
import { sendAppointmentReminders } from '../services/reminders.service';
import { createDailyDigest } from '../controllers/ai.controller';
import { sendNotificationEmail } from '../utils/email';
import { buildAppUrl } from '../config/appConfig';
import { sealConfig } from '../lib/dataSourceSecrets';
import { settleDueSubscriptions } from '../services/wallet.service';
import { expireUnpaidBookings } from '../services/bookingPayments/bookingPayments.service';
import { refreshRatesIfScheduled } from '../services/currency.service';

/** Encrypts any data-source secrets still stored in plain text (rows saved
 * before encryption existed). Idempotent: sealed values are left alone. */
async function sealPlaintextDataSourceSecrets() {
  const sources = await prisma.dataSource.findMany({ select: { id: true, config: true } });
  let sealed = 0;
  for (const ds of sources) {
    const next = sealConfig(ds.config, ds.config);
    if (JSON.stringify(next) !== JSON.stringify(ds.config)) {
      await prisma.dataSource.update({ where: { id: ds.id }, data: { config: next as any } });
      sealed++;
    }
  }
  return sealed;
}

// Scheduled jobs, triggered by Vercel Cron (or any scheduler) with
// `Authorization: Bearer $CRON_SECRET`.
const router = Router();

function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const ok =
    !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.use(requireCronSecret);

// Every few minutes: webhook retries + expired-row cleanup.
router.all('/frequent', async (_req, res, next) => {
  try {
    const retried = await retryDueDeliveries();
    const expiredBookings = await expireUnpaidBookings();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [buckets, codes] = await Promise.all([
      prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: dayAgo } } }),
      prisma.verificationCode.deleteMany({ where: { expiresAt: { lt: dayAgo } } }),
    ]);
    res.json({ retried, expiredBookings, cleaned: { rateLimitBuckets: buckets.count, verificationCodes: codes.count } });
  } catch (error) {
    next(error);
  }
});

// Once a day: appointment reminders for tomorrow + AI digests.
router.all('/daily', async (_req, res, next) => {
  try {
    const reminders = await sendAppointmentReminders();
    const walletSettled = await settleDueSubscriptions().catch((e) => { console.error('Wallet settlement failed:', e); return 0; });
    const secretsSealed = await sealPlaintextDataSourceSecrets().catch((e) => { console.error('Sealing data source secrets failed:', e); return 0; });
    const rates = await refreshRatesIfScheduled().catch(() => 'failed' as const);

    const orgs = await prisma.organization.findMany({
      where: { aiEnabled: true, status: 'ACTIVE' },
      select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true, hidePoweredBy: true },
    });
    let digests = 0;
    for (const org of orgs) {
      try {
        const digest = await createDailyDigest(org.id);
        if (!digest) continue;
        digests++;
        const admins = await prisma.user.findMany({
          where: { organizationId: org.id, role: 'ORG_ADMIN', isActive: true },
          select: { email: true },
        });
        const link = buildAppUrl('/analytics', org.slug);
        for (const admin of admins) {
          await sendNotificationEmail(admin.email, `${org.name}: yesterday at a glance`, digest.answer, {
            brand: org,
            eyebrow: 'Daily digest',
            action: { href: link, label: 'Open analytics' },
            reason: `You're receiving this daily digest as an admin of ${org.name}.`,
          });
        }
      } catch (error) {
        console.error(`Digest failed for org ${org.id}:`, error);
      }
    }
    res.json({ reminders, digests, secretsSealed, walletSettled, rates });
  } catch (error) {
    next(error);
  }
});

export default router;
