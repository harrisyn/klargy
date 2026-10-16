import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import {
  needsSetup,
  announceSetupToken,
  isValidSetupToken,
  clearSetupToken,
  resetSetupCache,
} from '../services/setup.service';

const MIN_PASSWORD_LENGTH = 8;

export const getSetupStatus = async (_req: Request, res: Response) => {
  try {
    const open = await needsSetup();
    if (open) void announceSetupToken();
    res.json({ needsSetup: open });
  } catch (error) {
    console.error('Setup status error:', error);
    res.status(500).json({ error: 'Could not check setup status' });
  }
};

/** Creates the first superadmin. Only works while none exists. */
export const completeSetup = async (req: Request, res: Response) => {
  try {
    if (!(await needsSetup())) {
      return res.status(403).json({ error: 'Setup is already complete' });
    }
    const { token, email, password, firstName, lastName } = req.body ?? {};
    if (!(await isValidSetupToken(token))) {
      return res.status(401).json({ error: 'Invalid setup token' });
    }
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Email, password, first name and last name are required' });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    const normalizedEmail = String(email).trim();
    if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: await bcrypt.hash(String(password), 10),
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        role: 'SUPER_ADMIN',
      },
    });
    await clearSetupToken();
    resetSetupCache(true);
    res.status(201).json({ email: user.email });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ error: 'Setup failed' });
  }
};
