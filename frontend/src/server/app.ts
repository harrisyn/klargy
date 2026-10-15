import express, { Application } from 'express';
import cors from 'cors';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { handleStripeWebhook, handlePaystackWebhook } from './controllers/paymentWebhook.controller';
import { whatsappWebhook } from './controllers/whatsapp.controller';
import { corsOrigin } from './lib/cors';
import { getJwtSecret } from './lib/jwt';
import { realtimeRequestScope } from './lib/realtime';
import { APP_URL_CONFIGURED, assertAppUrlConfigured, rememberRequestAppUrl } from './config/appConfig';
import { extractSubdomain } from '../lib/subdomain';

/**
 * The API as an Express app. It no longer listens on its own port: Next.js
 * serves it from src/pages/api/v1/[...path].ts, so the web app and API ship
 * as one deployment (Vercel, or `next start` in a container).
 */
function createApp(): Application {
  // Fail fast on a missing/default JWT secret in production rather than on
  // the first login.
  getJwtSecret();
  // Same for APP_URL: every desk, status and email link is built on it.
  assertAppUrlConfigured();

  const app = express();
  // Behind a proxy/load balancer (Vercel, nginx), so req.ip is the real client
  // IP from X-Forwarded-For - rate limiting keys on it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Real-time events raised while handling a request are flushed before the
  // response ends (serverless functions may freeze right after).
  app.use(realtimeRequestScope);

  // Development without APP_URL: build links on the address the app is
  // reached on (see appConfig.appUrl).
  if (!APP_URL_CONFIGURED && process.env.NODE_ENV !== 'production') {
    app.use((req, _res, next) => {
      rememberRequestAppUrl(req.headers, req.protocol, extractSubdomain);
      next();
    });
  }

  // Webhook routes need the raw body for signature verification, so they're
  // registered before express.json() runs (which would otherwise consume and
  // parse the body, leaving nothing for verifyWebhookSignature to check).
  app.post('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
  app.post('/api/v1/webhooks/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);
  // Each organisation's WhatsApp provider: receipts, replies (JSON from Meta
  // and WhatsApp Web, form posts from Twilio) and Meta's GET verification.
  app.get('/api/v1/webhooks/whatsapp/:orgId', whatsappWebhook);
  app.post('/api/v1/webhooks/whatsapp/:orgId', express.raw({ type: () => true, limit: '1mb' }), whatsappWebhook);

  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString(), version: '2.0.0' });
  });

  app.use('/api/v1', routes);

  app.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);
  return app;
}

// One instance per module load (per server process / warm serverless
// instance). Deliberately not cached on globalThis: in development that kept
// serving the old route table after hot reloads.
export const app: Application = createApp();

export default app;
