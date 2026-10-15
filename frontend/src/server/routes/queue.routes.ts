import { Router } from 'express';
import {
  createQueue,
  getQueue,
  getServiceQueues,
  joinQueue,
  callNext,
  markServed,
  cancelEntry,
  markNoShow,
  moveEntry,
  getWaitTime,
  updateQueueStatus,
  generateTicket,
  reorderEntries,
  callNextWithServicePoint,
  recallEntry,
  getQueueEntriesForOperator,
  completeWithNextSuggestions,
  transferEntry,
  holdQueueEntry,
  resumeQueueEntry,
  clearQueueEntry,
} from '../controllers/queue.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { scope, queue, entry, service, user, instance, each } from '../middleware/tenantScope.middleware';

const router = Router();
const q = queue('params.id');
const e = entry('params.entryId');

router.use(authenticate);

// Queue management
router.post('/', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST'), scope(service('body.serviceId')), createQueue);
router.get('/service/:serviceId', scope(service('params.serviceId')), getServiceQueues);
router.get('/:id', scope(q), getQueue);
router.get('/:id/operator', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST'), scope(q), getQueueEntriesForOperator);
router.patch('/:id/status', authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF'), scope(q), updateQueueStatus);

// Queue operations
router.post('/:id/join', scope(q, user('body.userId')), joinQueue);
router.post('/:id/call-next', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q), callNext);
router.post('/:id/call-next-sp', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST'), scope(q, instance('body.servicePointInstanceId')), callNextWithServicePoint);
router.patch('/:id/reorder', authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, each('entries', 'id', entry)), reorderEntries);
router.patch('/:id/entry/:entryId/serve', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, e), markServed);
router.post('/:id/entry/:entryId/recall', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST'), scope(q, e), recallEntry);
router.patch('/:id/entry/:entryId/complete', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST'), scope(q, e), completeWithNextSuggestions);
router.patch('/:id/entry/:entryId/cancel', scope(q, e), cancelEntry);
router.patch('/:id/entry/:entryId/no-show', authorize('SERVICE_STAFF', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, e), markNoShow);
router.post('/:id/entry/:entryId/hold', authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, e), holdQueueEntry);
router.post('/:id/entry/:entryId/resume', authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, e, instance('body.servicePointInstanceId')), resumeQueueEntry);
router.post('/:id/entry/:entryId/clear', authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, e), clearQueueEntry);
router.post('/:id/entry/:entryId/transfer', authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, e, service('body.serviceId')), transferEntry);
router.patch('/:id/move', authorize('SERVICE_STAFF', 'RECEPTIONIST', 'LOCATION_ADMIN', 'ORG_ADMIN', 'SUPER_ADMIN'), scope(q, entry('body.entryId'), queue('body.targetQueueId')), moveEntry);

// Queue info
router.get('/:id/waittime', scope(q), getWaitTime);
router.get('/:id/ticket/:entryId', scope(q, e), generateTicket);

export default router;
