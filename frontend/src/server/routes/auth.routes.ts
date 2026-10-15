import { Router } from 'express';
import { register, login, forgotPassword, resetPassword } from '../controllers/auth.controller';
import { limits } from '../middleware/rateLimit.middleware';
import { exchangeDeskLaunch } from '../controllers/connectDesk.controller';

const router = Router();

router.post('/register', limits.registerOrg, register);
router.post('/login', limits.login, login);
router.post('/forgot-password', limits.sendCode, forgotPassword);
router.post('/reset-password', limits.verifyCode, resetPassword);
// Klargy Connect desk launch: a one-time code from the EMR, not a password.
router.post('/desk-launch', limits.deskLaunch, exchangeDeskLaunch);

export default router;
