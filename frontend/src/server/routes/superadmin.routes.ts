import { Router } from 'express';
import { listSmsProviders, upsertSmsProvider, testSmsProvider } from '../controllers/smsProvider.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import {
  listOrganizations,
  getOrganization,
  setOrganizationStatus,
  impersonateOrganization,
  updateOrganizationSubscription,
  cancelOrganizationSubscription,
  grantCredits,
  deleteOrganization,
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getDashboardStats,
  getOrganizationUsage,
} from '../controllers/superadmin.controller';
import { getCurrencySettings, updateCurrencySettings, refreshCurrencyRates, setOrganizationCurrency } from '../controllers/currency.controller';
import { getPayoutSettingsHandler, updatePayoutSettingsHandler, listPayoutRequests, decidePayoutRequest, getOrganizationPayouts } from '../controllers/payouts.controller';
import { getOrganizationWallet, adjustOrganizationWallet, bumpOrganizationPlan, endOrganizationPlanBump } from '../controllers/wallet.controller';
import { listPaymentProviders, upsertPaymentProvider, testPaymentProvider } from '../controllers/paymentProvider.controller';
import { listAddOnPricing, updateAddOnPricing } from '../controllers/addOnPricing.controller';
import { listFileStorageProviders, upsertFileStorageProvider, testFileStorageProvider } from '../controllers/fileStorageProvider.controller';
import { listAiProviders, upsertAiProvider, testAiProvider } from '../controllers/ai.controller';
import { getPlatformWhatsApp, savePlatformWhatsApp, testPlatformWhatsApp } from '../controllers/platformWhatsApp.controller';

const router = Router();

// All superadmin routes require SUPER_ADMIN role
router.use(authenticate);
router.use(authorize('SUPER_ADMIN'));

// Dashboard
router.get('/dashboard', getDashboardStats);

// Organization management
router.get('/organizations', listOrganizations);
router.get('/organizations/:id', getOrganization);
router.get('/organizations/:id/usage', getOrganizationUsage);
router.patch('/organizations/:id/status', setOrganizationStatus);
router.post('/organizations/:id/impersonate', impersonateOrganization);
router.patch('/organizations/:id/subscription', updateOrganizationSubscription);
router.post('/organizations/:id/cancel', cancelOrganizationSubscription);
router.post('/organizations/:id/credits/grant', grantCredits);
router.get('/organizations/:id/wallet', getOrganizationWallet);
router.get('/organizations/:id/payouts', getOrganizationPayouts);

// Supported currencies and conversion rates
router.get('/currencies', getCurrencySettings);
router.put('/currencies', updateCurrencySettings);
router.post('/currencies/refresh', refreshCurrencyRates);
router.patch('/organizations/:id/currency', setOrganizationCurrency);

// Money collected on organizations' behalf: settings and payout requests
router.get('/payout-settings', getPayoutSettingsHandler);
router.put('/payout-settings', updatePayoutSettingsHandler);
router.get('/payouts', listPayoutRequests);
router.post('/payouts/:id/decision', decidePayoutRequest);
router.post('/organizations/:id/wallet/adjust', adjustOrganizationWallet);
router.post('/organizations/:id/subscription/bump', bumpOrganizationPlan);
router.post('/organizations/:id/subscription/bump/end', endOrganizationPlanBump);
router.delete('/organizations/:id', deleteOrganization);

// Subscription plan management
router.get('/plans', listPlans);
router.post('/plans', createPlan);
router.patch('/plans/:id', updatePlan);
router.delete('/plans/:id', deletePlan);

// Payment provider configuration
router.get('/payment-providers', listPaymentProviders);
router.put('/payment-providers/:provider', upsertPaymentProvider);
router.post('/payment-providers/:provider/test', testPaymentProvider);

// Add-on pricing configuration
router.get('/addon-pricing', listAddOnPricing);
router.put('/addon-pricing/:resourceType', updateAddOnPricing);

// File storage provider configuration
router.get('/sms-providers', listSmsProviders);
router.put('/sms-providers/:provider', upsertSmsProvider);
router.post('/sms-providers/:provider/test', testSmsProvider);
router.get('/file-storage', listFileStorageProviders);
router.put('/file-storage/:provider', upsertFileStorageProvider);
router.post('/file-storage/:provider/test', testFileStorageProvider);

// Shared WhatsApp sender
router.get('/platform-whatsapp', getPlatformWhatsApp);
router.put('/platform-whatsapp', savePlatformWhatsApp);
router.post('/platform-whatsapp/test', testPlatformWhatsApp);

// AI (LLM) provider configuration
router.get('/ai-providers', listAiProviders);
router.put('/ai-providers/:provider', upsertAiProvider);
router.post('/ai-providers/:provider/test', testAiProvider);

export default router;
