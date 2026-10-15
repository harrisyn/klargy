import { Router } from 'express';
import { limits } from '../middleware/rateLimit.middleware';
import { authenticateIntegration, requireScope } from '../middleware/integrationAuth.middleware';
import { getMe, registerIntegration, putCatalog, getCatalog, getMappings } from '../controllers/connect.controller';
import { putPatient, postEntry, postEntryByRef, getEntryByRef, listEntries } from '../controllers/connectQueue.controller';
import { launchDesk } from '../controllers/connectDesk.controller';

// Klargy Connect v1 (docs/connect/v1.md): called by other systems with an
// integration API key, never by staff with a JWT.
const router = Router();

router.use(limits.connect, authenticateIntegration);

router.get('/me', getMe);
router.put('/integration', requireScope('integration:write'), registerIntegration);
router.put('/catalog', requireScope('catalog:write'), putCatalog);
router.get('/catalog', requireScope('catalog:read'), getCatalog);
router.get('/mappings', requireScope('catalog:read'), getMappings);

router.put('/patients/:patientId', requireScope('patients:write'), putPatient);
router.get('/entries', requireScope('entries:read'), listEntries);
router.post('/entries', requireScope('entries:write'), postEntry);
router.get('/entries/by-ref/:type/:id', requireScope('entries:read'), getEntryByRef);
router.post('/entries/by-ref/:type/:id/:action', requireScope('entries:write'), postEntryByRef);

router.post('/desk/launch', requireScope('desk:launch'), launchDesk);

export default router;
