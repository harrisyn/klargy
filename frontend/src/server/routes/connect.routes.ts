import { Router } from 'express';
import { limits } from '../middleware/rateLimit.middleware';
import { authenticateIntegration, requireScope } from '../middleware/integrationAuth.middleware';
import { getMe, registerIntegration, putCatalog, getCatalog, getMappings } from '../controllers/connect.controller';

// Klargy Connect v1 (docs/connect/v1.md): called by other systems with an
// integration API key, never by staff with a JWT.
const router = Router();

router.use(limits.connect, authenticateIntegration);

router.get('/me', getMe);
router.put('/integration', requireScope('integration:write'), registerIntegration);
router.put('/catalog', requireScope('catalog:write'), putCatalog);
router.get('/catalog', requireScope('catalog:read'), getCatalog);
router.get('/mappings', requireScope('catalog:read'), getMappings);

export default router;
