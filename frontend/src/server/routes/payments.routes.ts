import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { loadSubscription, requireFeature } from '../middleware/subscription.middleware';
import {
  getPaymentsOverview,
  updatePaymentSettings,
  saveOwnProvider,
  removeOwnProvider,
  requestOrgPayout,
} from '../controllers/orgPayments.controller';

// An organization's booking payments: its own payment account (paid plans)
// and the payout wallet. Organization admins only.
const router = Router();

router.use(authenticate);
router.use(authorize('ORG_ADMIN'));

router.get('/', getPaymentsOverview);
router.put('/settings', updatePaymentSettings);
// Saving own keys needs the plan; removing them works on any plan so a downgraded org can clear them.
router.put('/providers/:provider', loadSubscription, requireFeature('ownPaymentKeys'), saveOwnProvider);
router.delete('/providers/:provider', removeOwnProvider);
router.post('/payouts', requestOrgPayout);

export default router;
