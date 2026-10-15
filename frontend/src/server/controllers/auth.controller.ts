import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { verifyCode, issueToken, consumeToken, normalizeEmail } from '../lib/verification';
import { sendOTPEmail, sendPasswordResetEmail } from '../utils/email';
import { buildAppUrl } from '../config/appConfig';
import { isLaunchOnlyUser } from '../lib/connectStaff';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Staff registration. Always invite-based: the invite fixes both the org and
 * the role, so nothing about privileges comes from the request body.
 * (REGISTRATION_MODE=open was never safe - it let anyone self-assign any
 * role, including SUPER_ADMIN - and has been removed.)
 */
export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, firstName, lastName, phone, inviteToken } = req.body;

    if (!inviteToken) {
      return res.status(403).json({ error: 'Registration is invite-only. Please use the invite link you were sent.' });
    }
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Email, password, first name and last name are required' });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const invite = await prisma.invite.findUnique({ where: { code: inviteToken } });
    if (!invite || !invite.organizationId) return res.status(403).json({ error: 'Invalid invite link' });
    if (invite.used) return res.status(403).json({ error: 'This invite has already been used' });
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ error: 'This invite has expired. Ask your admin for a new one.' });
    }

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.$transaction(async (tx) => {
      // Claim the invite atomically so two simultaneous sign-ups can't both use it.
      const claimed = await tx.invite.updateMany({ where: { id: invite.id, used: false }, data: { used: true } });
      if (claimed.count === 0) throw Object.assign(new Error('This invite has already been used'), { status: 403 });

      return tx.user.create({
        data: {
          email: normalizedEmail,
          password: hashedPassword,
          firstName,
          lastName,
          phone: phone || null,
          role: invite.role,
          organizationId: invite.organizationId,
        },
        select: { id: true, email: true, firstName: true, lastName: true, role: true, organizationId: true },
      });
    });

    const org = await prisma.organization.findUnique({
      where: { id: invite.organizationId },
      select: { slug: true },
    });

    res.status(201).json({ user, organizationSlug: org?.slug ?? null });
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, slug, adminLogin } = req.body;
    if (!email || !password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });

    // Guest (patient) users have an empty password and can never log in.
    if (!user || !user.password || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Staff an EMR registered through Klargy Connect only ever reach the
    // desk through that EMR (a desk launch), never with a password.
    if (isLaunchOnlyUser(user.identityData)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Subdomain-scoped login: every login must declare which context it's
    // authenticating against (a tenant slug or the admin subdomain) — an
    // unscoped login request is rejected rather than falling back to the
    // pre-multitenancy unrestricted behavior.
    if (adminLogin) {
      if (user.role !== 'SUPER_ADMIN') {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    } else if (slug) {
      const org = await prisma.organization.findUnique({ where: { slug } });
      if (!org || user.organizationId !== org.id) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken({ userId: user.id, role: user.role });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Send OTP for email verification
export const sendOTP = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const result = await sendOTPEmail(normalizeEmail(email));
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to send verification email' });
    }

    res.json({
      success: true,
      message: 'Verification code sent to your email',
      ...(process.env.NODE_ENV !== 'production' && { dev: true }),
    });
  } catch (error) {
    next(error);
  }
};

// Verify OTP code. Marks the code verified server-side; registerOrganization
// then consumes that record rather than trusting a client flag.
export const verifyOTPCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }

    const result = await verifyCode('EMAIL_VERIFY', email, code);
    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, verified: true, message: 'Email verified successfully' });
  } catch (error) {
    next(error);
  }
};

// Always responds the same way, whether or not the email exists, so this
// can't be used to discover which emails have accounts.
export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    const response = { success: true, message: 'If an account exists for that email, a reset link is on its way.' };
    if (!email) return res.json(response);

    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { email: true, password: true, isActive: true, role: true, identityData: true, organization: { select: { slug: true } } },
    });
    if (!user || !user.password || !user.isActive || isLaunchOnlyUser(user.identityData)) return res.json(response);

    const token = await issueToken('PASSWORD_RESET', user.email, 60);
    // Send the link to the subdomain the user actually logs in on.
    const subdomain = user.role === 'SUPER_ADMIN' ? 'admin' : user.organization?.slug;
    const resetUrl = buildAppUrl(`/reset-password?token=${token}`, subdomain);
    await sendPasswordResetEmail(user.email, resetUrl);

    res.json(response);
  } catch (error) {
    next(error);
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const email = await consumeToken('PASSWORD_RESET', token);
    if (!email) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }

    await prisma.user.update({
      where: { email },
      data: { password: await bcrypt.hash(password, 10) },
    });

    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (error) {
    next(error);
  }
};
