import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import crypto from 'crypto';
import { loadCaller, listScopeOrgId, canAssignRole } from '../middleware/tenantScope.middleware';
import { sendInviteEmail } from '../utils/email';
import { returnBaseUrl } from '../lib/cors';

const ROLE_LABELS: Record<string, string> = {
  ORG_ADMIN: 'an admin',
  LOCATION_ADMIN: 'a location admin',
  SERVICE_STAFF: 'staff',
  RECEPTIONIST: 'a receptionist',
};

const DEFAULT_INVITE_TTL_DAYS = 7;

export const createInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { role = 'SERVICE_STAFF', organizationId, expiresAt } = req.body;
    const email = typeof req.body?.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.body.email.trim()) ? req.body.email.trim().toLowerCase() : null;
    if (req.body?.email && !email) return res.status(400).json({ error: 'That email address doesn’t look right.' });

    const caller = await loadCaller(req);
    if (!caller) return res.status(401).json({ error: 'Authentication required' });
    if (role === 'PATIENT' || !canAssignRole(caller.role, role)) {
      return res.status(403).json({ error: 'You cannot invite users with this role' });
    }
    // Tenant admins can only invite into their own org.
    const targetOrgId = caller.role === 'SUPER_ADMIN' ? organizationId : caller.organizationId;
    if (!targetOrgId) {
      return res.status(400).json({ error: 'organizationId is required' });
    }

    const code = crypto.randomBytes(16).toString('hex');
    const expiry = expiresAt
      ? new Date(expiresAt)
      : new Date(Date.now() + DEFAULT_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invite = await prisma.invite.create({
      data: {
        code,
        role,
        organizationId: targetOrgId,
        expiresAt: expiry,
        createdBy: caller.id,
        email,
      },
    });

    let emailed = false;
    if (email) {
      const [org, inviter] = await Promise.all([
        prisma.organization.findUnique({ where: { id: targetOrgId }, select: { name: true, slug: true, logoUrl: true, primaryColor: true, hidePoweredBy: true } }),
        prisma.user.findUnique({ where: { id: caller.id }, select: { firstName: true, lastName: true } }),
      ]);
      const base = await returnBaseUrl(req.headers.origin as string | undefined, org?.slug);
      const result = await sendInviteEmail(email, {
        inviteUrl: `${base}/register?invite=${code}`,
        orgName: org?.name || 'your team',
        inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : 'Your admin',
        roleLabel: ROLE_LABELS[role] || 'staff',
        brand: org ?? undefined,
      }).catch(() => ({ success: false }));
      emailed = !!result?.success;
    }

    res.status(201).json({ invite, emailed });
  } catch (error) {
    next(error);
  }
};

export const getInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.params;
    const invite = await prisma.invite.findUnique({ where: { code } });
    const scopedOrgId = await listScopeOrgId(req);
    if (!invite || (scopedOrgId && invite.organizationId !== scopedOrgId)) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.json({ invite });
  } catch (error) {
    next(error);
  }
};

export const listInvites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scopedOrgId = await listScopeOrgId(req, req.query.organizationId as string | undefined);
    const invites = await prisma.invite.findMany({
      where: scopedOrgId ? { organizationId: scopedOrgId } : {},
      orderBy: { createdAt: 'desc' },
    });
    res.json(invites);
  } catch (error) { next(error); }
};

/** Public: what the accept-invite page needs to render, nothing more. */
export const previewInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.params;
    const invite = await prisma.invite.findUnique({ where: { code } });
    if (!invite || !invite.organizationId) return res.status(404).json({ error: 'Invite not found' });

    const organization = await prisma.organization.findUnique({
      where: { id: invite.organizationId },
      select: { name: true, slug: true, logoUrl: true },
    });
    if (!organization) return res.status(404).json({ error: 'Invite not found' });

    const expired = !!invite.expiresAt && invite.expiresAt.getTime() < Date.now();
    res.json({
      role: invite.role,
      email: invite.email,
      organization,
      status: invite.used ? 'used' : expired ? 'expired' : 'valid',
    });
  } catch (error) {
    next(error);
  }
};

/** Cancels an invite that hasn't been used yet. */
export const revokeInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invite = await prisma.invite.findUnique({ where: { id: req.params.id } });
    const scopedOrgId = await listScopeOrgId(req);
    if (!invite || (scopedOrgId && invite.organizationId !== scopedOrgId)) return res.status(404).json({ error: 'Invite not found' });
    if (invite.used) return res.status(400).json({ error: 'That invite has already been used.' });
    await prisma.invite.delete({ where: { id: invite.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};
