import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

interface RateLimitOptions {
  name: string;
  windowSeconds: number;
  max: number;
  /** Extra key parts beyond the client IP, e.g. the submitted email. */
  key?: (req: Request) => string | undefined;
}

export const clientIp = (req: Request) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Fixed-window limiter backed by Postgres, so it works across serverless
 * instances. Fails open on a DB error - an outage of the limiter shouldn't
 * take login down with it.
 */
export const rateLimit = ({ name, windowSeconds, max, key }: RateLimitOptions) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return next();
    try {
      const windowMs = windowSeconds * 1000;
      const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
      const extra = key?.(req);
      const bucketKey = `${name}:${clientIp(req)}${extra ? `:${extra.toLowerCase()}` : ''}`;

      const bucket = await prisma.rateLimitBucket.upsert({
        where: { key_windowStart: { key: bucketKey, windowStart } },
        create: { key: bucketKey, windowStart, count: 1 },
        update: { count: { increment: 1 } },
      });

      // Opportunistic cleanup of expired windows (~1% of requests).
      if (Math.random() < 0.01) {
        prisma.rateLimitBucket
          .deleteMany({ where: { windowStart: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
          .catch(() => {});
      }

      if (bucket.count > max) {
        const retryAfter = Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
      }
      next();
    } catch (error) {
      console.error('Rate limiter error (failing open):', error);
      next();
    }
  };

const bodyEmail = (req: Request) => (typeof req.body?.email === 'string' ? req.body.email : undefined);

export const limits = {
  login: rateLimit({ name: 'login', windowSeconds: 15 * 60, max: 10, key: bodyEmail }),
  sendCode: rateLimit({ name: 'send-code', windowSeconds: 60 * 60, max: 5, key: bodyEmail }),
  verifyCode: rateLimit({ name: 'verify-code', windowSeconds: 15 * 60, max: 20 }),
  registerOrg: rateLimit({ name: 'register-org', windowSeconds: 60 * 60, max: 10 }),
  // Generous: one kiosk behind one clinic IP can issue a lot of tickets.
  publicJoin: rateLimit({ name: 'public-join', windowSeconds: 10 * 60, max: 300 }),
  // Per API key (its first characters) rather than per IP: an EMR's servers
  // may sit behind one address with many clinics.
  // Desk launch codes are single use and expire in a minute; this only
  // stops guessing.
  deskLaunch: rateLimit({ name: 'desk-launch', windowSeconds: 60, max: 30 }),
  connect: rateLimit({ name: 'connect', windowSeconds: 60, max: 120, key: (req) => req.headers.authorization?.slice(7, 27) }),
};
