import { Router } from 'express';
import {
  createOrganization,
  getOrganizations,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  uploadOrganizationLogo,
  logoUploadMiddleware,
} from '../controllers/organization.controller';
import {
  getCustomDomain,
  setCustomDomain,
  verifyCustomDomain,
  deleteCustomDomain,
} from '../controllers/customDomain.controller';
import {
  getWhatsAppConfig,
  upsertWhatsAppConfig,
  deleteWhatsAppConfig,
  testWhatsAppConfig,
  sendWhatsAppTest,
  syncWhatsAppTemplates,
} from '../controllers/whatsapp.controller';
import { authenticate, authorize, requireOwnOrganization } from '../middleware/auth.middleware';
import { loadSubscription, requireFeature } from '../middleware/subscription.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('SUPER_ADMIN'), createOrganization);
router.get('/', authorize('SUPER_ADMIN', 'ORG_ADMIN'), getOrganizations);
router.get('/:id', requireOwnOrganization, getOrganization);
router.put('/:id', authorize('SUPER_ADMIN', 'ORG_ADMIN'), requireOwnOrganization, updateOrganization);
router.post(
  '/:id/logo',
  authorize('SUPER_ADMIN', 'ORG_ADMIN'),
  requireOwnOrganization,
  loadSubscription,
  requireFeature('customBranding'),
  logoUploadMiddleware,
  uploadOrganizationLogo
);
router.get('/:id/custom-domain', authorize('SUPER_ADMIN', 'ORG_ADMIN'), requireOwnOrganization, getCustomDomain);
router.put(
  '/:id/custom-domain',
  authorize('SUPER_ADMIN', 'ORG_ADMIN'),
  requireOwnOrganization,
  loadSubscription,
  requireFeature('customDomain'),
  setCustomDomain
);
router.post('/:id/custom-domain/verify', authorize('SUPER_ADMIN', 'ORG_ADMIN'), requireOwnOrganization, verifyCustomDomain);
router.delete('/:id/custom-domain', authorize('SUPER_ADMIN', 'ORG_ADMIN'), requireOwnOrganization, deleteCustomDomain);

// WhatsApp: the org's own sender. Reading and removing it work on any plan
// (so a downgraded org can still see and clear it); the rest needs the plan.
const orgAdmin = [authorize('SUPER_ADMIN', 'ORG_ADMIN'), requireOwnOrganization];
const whatsappPlan = [loadSubscription, requireFeature('whatsappNotifications')];
router.get('/:id/whatsapp', ...orgAdmin, getWhatsAppConfig);
router.put('/:id/whatsapp', ...orgAdmin, ...whatsappPlan, upsertWhatsAppConfig);
router.delete('/:id/whatsapp', ...orgAdmin, deleteWhatsAppConfig);
router.post('/:id/whatsapp/test', ...orgAdmin, ...whatsappPlan, testWhatsAppConfig);
router.post('/:id/whatsapp/send-test', ...orgAdmin, ...whatsappPlan, sendWhatsAppTest);
router.post('/:id/whatsapp/templates/sync', ...orgAdmin, ...whatsappPlan, syncWhatsAppTemplates);

router.delete('/:id', authorize('SUPER_ADMIN'), deleteOrganization);

export default router;
