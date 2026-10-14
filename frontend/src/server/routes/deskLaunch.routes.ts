import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getLaunchDesk, getLaunchEntry } from '../controllers/connectDesk.controller';

// For a desk opened through a Klargy Connect launch (docs/connect/v1.md
// section 6): the launched staff member's own session looks up the EMR's ids
// it passes to the EMR window.
const router = Router();

router.use(authenticate);
router.get('/:launchId/desks/:instanceId', getLaunchDesk);
router.get('/:launchId/entries/:entryId', getLaunchEntry);

export default router;
