import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { scope, org, webhookEndpoint, integration } from '../middleware/tenantScope.middleware';
import { loadSubscription, requireFeature } from '../middleware/subscription.middleware';
import {
  listWebhookEvents,
  listWebhooks,
  createWebhook,
  updateWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  testWebhook,
  listWebhookDeliveries,
  listAuditLogs,
} from '../controllers/integration.controller';
import {
  listIntegrations,
  createIntegration,
  getIntegration,
  rotateIntegrationKey,
  revokeIntegration,
  setMapping,
} from '../controllers/emrIntegration.controller';

const router = Router();

const admins = [authenticate, authorize('SUPER_ADMIN', 'ORG_ADMIN')];
const ownOrg = scope(org('params.organizationId'));
const ownHook = scope(webhookEndpoint('params.id'));
const ownIntegration = scope(integration('params.id'));
const emrPlan = [loadSubscription, requireFeature('emrIntegration')];

// Mounted at '/', so every route carries its own auth (a router-level
// use() here would apply to every other router mounted at '/').
router.get('/webhook-events', ...admins, listWebhookEvents);
router.get('/orgs/:organizationId/webhooks', ...admins, ownOrg, listWebhooks);
router.post('/orgs/:organizationId/webhooks', ...admins, ownOrg, createWebhook);
router.patch('/webhooks/:id', ...admins, ownHook, updateWebhook);
router.post('/webhooks/:id/rotate-secret', ...admins, ownHook, rotateWebhookSecret);
router.post('/webhooks/:id/test', ...admins, ownHook, testWebhook);
router.get('/webhooks/:id/deliveries', ...admins, ownHook, listWebhookDeliveries);
router.delete('/webhooks/:id', ...admins, ownHook, deleteWebhook);

// EMR connections (Klargy Connect, docs/connect/v1.md). Listing and revoking
// stay open after a downgrade so an admin can still switch a connection off.
router.get('/orgs/:organizationId/emr-integrations', ...admins, ownOrg, listIntegrations);
router.post('/orgs/:organizationId/emr-integrations', ...admins, ownOrg, ...emrPlan, createIntegration);
router.get('/emr-integrations/:id', ...admins, ownIntegration, getIntegration);
router.post('/emr-integrations/:id/rotate-key', ...admins, ownIntegration, ...emrPlan, rotateIntegrationKey);
router.post('/emr-integrations/:id/revoke', ...admins, ownIntegration, revokeIntegration);
router.put('/emr-integrations/:id/mappings', ...admins, ownIntegration, ...emrPlan, setMapping);

router.get('/orgs/:organizationId/audit-logs', ...admins, ownOrg, listAuditLogs);

export default router;
