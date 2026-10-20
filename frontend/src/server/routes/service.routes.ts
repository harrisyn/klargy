import { Router } from 'express';
import {
  createService,
  getServices,
  getService,
  getServiceSchedule,
  updateService,
  deleteService,
  createServiceFlow,
  getServiceFlows,
} from '../controllers/service.controller';
import { listSessions, createSession, deleteSession } from '../controllers/session.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { scope, location, service } from '../middleware/tenantScope.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'), createService);
// Nested under locations
router.get('/locations/:locationId/services', scope(location('params.locationId')), getServices);

// Direct service access
router.get('/:id', scope(service('params.id')), getService);
router.get('/:id/schedule', scope(service('params.id')), getServiceSchedule);
router.put('/:id', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'), scope(service('params.id')), updateService);
router.delete('/:id', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'), scope(service('params.id')), deleteService);

// One-off sessions (events, classes, tickets)
router.get('/:id/sessions', scope(service('params.id')), listSessions);
router.post('/:id/sessions', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'), scope(service('params.id')), createSession);
router.delete('/:id/sessions/:slotId', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'), scope(service('params.id')), deleteSession);

// Service flows
router.post('/flows', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN'), scope(service('body.fromServiceId'), service('body.toServiceId')), createServiceFlow);
router.get('/:serviceId/flows', scope(service('params.serviceId')), getServiceFlows);

export default router;
