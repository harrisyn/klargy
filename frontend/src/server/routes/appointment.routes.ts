import { Router } from 'express';
import {
  createAppointment,
  getAppointments,
  getAppointment,
  getUserAppointments,
  rescheduleAppointment,
  cancelAppointment,
  checkInAppointment,
  getAvailableSlots,
  searchPatients,
  setAppointmentTables,
} from '../controllers/appointment.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { scope, user, service, slot, appointment, location } from '../middleware/tenantScope.middleware';

const router = Router();

router.use(authenticate);

// Every appointment operation is a front-desk / admin action.
const STAFF = ['SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST'];
router.use(authorize(...STAFF));

router.get('/patients/search', searchPatients);

// Appointment CRUD
router.post('/', scope(user('body.userId'), service('body.serviceId'), slot('body.slotId')), createAppointment);
router.get('/', scope(user('query.userId'), service('query.serviceId'), location('query.locationId')), getAppointments);
router.get('/user/:userId', scope(user('params.userId')), getUserAppointments);
router.get('/service/:serviceId/slots', scope(service('params.serviceId')), getAvailableSlots);
router.get('/:id', scope(appointment('params.id')), getAppointment);

// Appointment operations
router.patch('/:id/reschedule', scope(appointment('params.id'), slot('body.newSlotId')), rescheduleAppointment);
router.patch('/:id/cancel', scope(appointment('params.id')), cancelAppointment);
router.put('/:id/tables', scope(appointment('params.id')), setAppointmentTables);
router.post('/:id/check-in', scope(appointment('params.id')), checkInAppointment);

export default router;
