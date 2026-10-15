import { Router } from 'express';
import authRoutes from './auth.routes';
import organizationRoutes from './organization.routes';
import locationRoutes from './location.routes';
import serviceRoutes from './service.routes';
import queueRoutes from './queue.routes';
import appointmentRoutes from './appointment.routes';
import notificationRoutes from './notification.routes';
import userRoutes from './user.routes';
import analyticsRoutes from './analytics.routes';
import inviteRoutes from './invite.routes';
import servicepointRoutes from './servicepoint.routes';
import serviceflowRoutes from './serviceflow.routes';
import datasourceRoutes from './datasource.routes';
import superadminRoutes from './superadmin.routes';
import integrationRoutes from './integration.routes';
import connectRoutes from './connect.routes';
import deskLaunchRoutes from './deskLaunch.routes';
import connectLookupRoutes from './connectLookup.routes';
import cronRoutes from './cron.routes';
import aiRoutes from './ai.routes';
import onboardingRoutes from './onboarding.routes';
import displayRoutes from './display.routes';
import { getPublicDisplayContent } from '../controllers/display.controller';
import { limits } from '../middleware/rateLimit.middleware';
import { authenticate } from '../middleware/auth.middleware';
import { getMySubscription } from '../middleware/subscription.middleware';
import { previewInvite } from '../controllers/invite.controller';
import { getPublicLocations, getLocationByCode, getPublicLocationInfo } from '../controllers/location.controller';
import {
  publicJoinQueueWithSession,
  getPublicStatus,
  getSessionTickets,
  getLocationQueues,
  updatePublicEntryIdentity,
  getPublicEntryIdentity,
} from '../controllers/queue.controller';
import { getActiveServicePoints } from '../controllers/servicepoint.controller';
import {
  registerOrganization,
  getPublicOrganizationBySlug,
  getPublicOrganization,
} from '../controllers/organization.controller';
import { getOrganizationByDomain } from '../controllers/customDomain.controller';
import { getPublicLocationServices } from '../controllers/service.controller';
import { sendOTP, verifyOTPCode } from '../controllers/auth.controller';
import { createCheckoutSession, switchToFreePlan } from '../controllers/subscriptionCheckout.controller';
import { createAddOnCheckout, listMyAddOns, cancelAddOn } from '../controllers/addOnCheckout.controller';
import { listAddOnPricing } from '../controllers/addOnPricing.controller';
import { listPlans } from '../controllers/superadmin.controller';

const router = Router();

router.use('/auth', authRoutes);

// Public endpoints (no auth required)
router.get('/public/locations', getPublicLocations);
router.get('/public/locations/:code', getLocationByCode);
router.post('/public/join', limits.publicJoin, publicJoinQueueWithSession);
router.get('/public/status/:queueId/:entryId', getPublicStatus);
router.get('/public/session/:sessionId/tickets', getSessionTickets);
router.get('/public/display/:locationId', getActiveServicePoints);
router.get('/public/display/:locationId/content', getPublicDisplayContent);
router.get('/public/location-info/:locationId', getPublicLocationInfo);
router.get('/public/queues/:locationId', getLocationQueues);
router.post('/public/register-org', limits.registerOrg, registerOrganization);
router.patch('/public/entries/:entryId/identity', updatePublicEntryIdentity);
router.get('/public/entries/:entryId/identity', getPublicEntryIdentity);
router.get('/public/orgs/by-slug/:slug', getPublicOrganizationBySlug);
router.get('/public/orgs/by-domain/:domain', getOrganizationByDomain);
router.get('/public/orgs/:orgId', getPublicOrganization);
router.get('/public/orgs/:orgId/locations/:locationId/services', getPublicLocationServices);
router.get('/public/invites/:code', previewInvite);

// OTP verification (org sign-up)
router.post('/public/send-otp', limits.sendCode, sendOTP);
router.post('/public/verify-otp', limits.verifyCode, verifyOTPCode);

// Subscription / billing (any authenticated tenant user)
router.get('/subscription', authenticate, getMySubscription);
router.post('/tenant/subscription/checkout', authenticate, createCheckoutSession);
router.post('/tenant/subscription/switch/:planId', authenticate, switchToFreePlan);
router.post('/tenant/addons/checkout', authenticate, createAddOnCheckout);
router.get('/tenant/addons', authenticate, listMyAddOns);
router.delete('/tenant/addons/:id', authenticate, cancelAddOn);
// Read-only pricing for any authenticated user - tenants need this to render
// the purchase UI. Reuses the superadmin controller's listAddOnPricing.
router.get('/tenant/addon-pricing', authenticate, listAddOnPricing);
// Read-only plan listing for any authenticated user (not superadmin-only -
// tenants need this to render the pricing page).
router.get('/plans', authenticate, listPlans);

router.use('/cron', cronRoutes);
router.use('/connect/v1', connectRoutes);
router.use('/desk-launches', deskLaunchRoutes);
router.use('/connect-lookup', connectLookupRoutes);
router.use('/orgs', organizationRoutes);
router.use('/locations', locationRoutes);
router.use('/invites', inviteRoutes);
router.use('/services', serviceRoutes);
router.use('/service-points', servicepointRoutes);
router.use('/service-flows', serviceflowRoutes);
router.use('/queues', queueRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/users', userRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/ai', aiRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/display', displayRoutes);
router.use('/superadmin', superadminRoutes);
// Mounted at '/' - these carry their own per-route auth.
router.use('/', datasourceRoutes);
router.use('/', integrationRoutes);

export default router;
