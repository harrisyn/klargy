import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import {
  listRooms,
  createRoom,
  getRoom,
  updateRoom,
  deleteRoom,
  saveLayout,
  uploadRoomImage,
  removeRoomImage,
  roomImageMiddleware,
  listDesks,
  setRoomDesks,
  getFloor,
  getRoomSeatMap,
} from '../controllers/rooms.controller';

// Rooms within a location: rules, rates, tables on a floor plan, desks.
// Administrators set them up; the host's floor view is open to staff too.
const router = Router();

router.use(authenticate);

const admin = authorize('SUPER_ADMIN', 'ORG_ADMIN', 'LOCATION_ADMIN');
router.get('/', admin, listRooms);
router.get('/desks', admin, listDesks);
router.post('/', admin, createRoom);
router.get('/:id', admin, getRoom);
router.put('/:id', admin, updateRoom);
router.delete('/:id', admin, deleteRoom);
router.put('/:id/layout', admin, saveLayout);
router.post('/:id/image', admin, roomImageMiddleware, uploadRoomImage);
router.delete('/:id/image', admin, removeRoomImage);
router.put('/:id/desks', admin, setRoomDesks);
router.get('/:id/floor', getFloor);
router.get('/:id/seat-map', getRoomSeatMap);

export default router;
