import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { loadCaller, listScopeOrgId, canAssignRole } from '../middleware/tenantScope.middleware';
import { isLaunchOnlyUser, LAUNCH_ONLY_KEY } from '../lib/connectStaff';

// A caller may only manage users whose current role they could assign -
// e.g. a LOCATION_ADMIN can't edit or deactivate an ORG_ADMIN.
async function assertCanManage(req: Request, targetId: string) {
  const caller = await loadCaller(req);
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } });
  if (!caller || !target) return { ok: false as const, status: 404, error: 'User not found' };
  if (caller.id !== targetId && !canAssignRole(caller.role, target.role)) {
    return { ok: false as const, status: 403, error: 'You cannot manage a user with this role' };
  }
  return { ok: true as const, caller, target };
}

export const getUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId, role } = req.query;

    const whereClause: any = {};
    const scopedOrgId = await listScopeOrgId(req, organizationId as string | undefined);
    if (scopedOrgId) whereClause.organizationId = scopedOrgId;
    if (role) whereClause.role = role;

    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
        organizationId: true,
        createdAt: true,
      },
    });

    res.json(users);
  } catch (error) {
    next(error);
  }
};

export const getUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
        organization: true,
        identityData: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
};

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, firstName, lastName, phone, role = 'PATIENT', organizationId } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'email, password, firstName and lastName are required' });
    }
    const caller = await loadCaller(req);
    if (!caller) return res.status(401).json({ error: 'Authentication required' });
    if (!canAssignRole(caller.role, role)) {
      return res.status(403).json({ error: 'You cannot assign this role' });
    }
    // Tenant callers always create users in their own org, whatever the body says.
    const targetOrgId = caller.role === 'SUPER_ADMIN' ? organizationId || null : caller.organizationId;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        phone,
        role,
        organizationId: targetOrgId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
};

export const updateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, phone, role, isActive } = req.body;

    const check = await assertCanManage(req, id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    if (role !== undefined && role !== check.target.role) {
      if (check.caller.id === id) {
        return res.status(403).json({ error: 'You cannot change your own role' });
      }
      if (!canAssignRole(check.caller.role, role)) {
        return res.status(403).json({ error: 'You cannot assign this role' });
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: { firstName, lastName, phone, role, isActive },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const check = await assertCanManage(req, id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    if (check.caller.id === id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        organizationId: true,
        organization: true,
        isActive: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
};

// Assign practitioner to service
export const assignPractitioner = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, serviceId } = req.body;

    const practitioner = await prisma.practitioner.create({
      data: { userId, serviceId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        service: true,
      },
    });

    res.status(201).json(practitioner);
  } catch (error) {
    next(error);
  }
};

export const removePractitioner = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, serviceId } = req.params;

    await prisma.practitioner.delete({
      where: {
        userId_serviceId: { userId, serviceId },
      },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// Update user identity data
export const updateUserIdentity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { identityData } = req.body;

    if (!identityData || typeof identityData !== 'object') {
      return res.status(400).json({ error: 'identityData must be an object' });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Merge with existing identity data
    const existingData = (user.identityData as Record<string, unknown>) || {};
    const mergedData = { ...existingData, ...identityData };
    // The Connect "desk launch only" mark can't be edited away here.
    if (isLaunchOnlyUser(existingData)) mergedData[LAUNCH_ONLY_KEY] = true;

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { identityData: mergedData },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        identityData: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
};
