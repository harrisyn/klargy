import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { scope, location, entry } from '../middleware/tenantScope.middleware';
import { postLookup, getEntryLookup } from '../controllers/connectLookup.controller';

// Staff looking patients up in the connected EMR (Klargy Connect phase 4,
// docs/connect/v1.md section 7).
const router = Router();

const staff = [authenticate, authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN')];

router.post('/', ...staff, scope(location('body.locationId')), postLookup);
router.get('/entries/:entryId', ...staff, scope(entry('params.entryId')), getEntryLookup);

export default router;
