import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { isJoinIdentifierType } from '../services/connectLookup.service';
import bcrypt from 'bcryptjs';
import { signToken } from '../lib/jwt';
import { consumeVerified } from '../lib/verification';
import { readNotificationSettings } from '../services/notifications.service';
import multer from 'multer';
import { slugify, generateUniqueSlug } from '../utils/slug';
import { isReservedSlug } from '../constants/reservedSlugs';
import { getActiveFileStorageProvider } from '../services/fileStorage';
import { getOrganizationFeatures } from '../middleware/subscription.middleware';
import { INDUSTRIES } from '../../lib/terms';

const ALLOWED_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

// Parses the incoming multipart request into memory - nothing touches local
// disk, the buffer goes straight to the configured file storage provider.
// Wraps multer directly (rather than exporting its middleware as-is) so a
// too-large or malformed upload gets a clean 400 instead of falling through
// to the generic error handler.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_SIZE_BYTES },
}).single('logo');

export const logoUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  logoUpload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File too large - max ${MAX_LOGO_SIZE_BYTES / (1024 * 1024)}MB` });
    }
    if (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'File upload failed' });
    }
    next();
  });
};

// Public endpoint: Register a new organization with first admin user
export const registerOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      organizationName,
      email,           // Organization email (optional)
      phone,           // Organization phone (optional)
      slug,            // Optional caller-chosen subdomain slug
      adminEmail,      // Admin email - or use 'email' if adminEmail not provided
      adminPassword,   // Admin password
      adminFirstName,  // Admin first name
      adminLastName,   // Admin last name
    } = req.body;

    // Support both 'email' and 'adminEmail' for backward compatibility
    const actualAdminEmail = (adminEmail || email || '').toLowerCase().trim();

    // Validate required fields
    if (!organizationName || !actualAdminEmail || !adminPassword || !adminFirstName || !adminLastName) {
      return res.status(400).json({ 
        error: 'Missing required fields: organizationName, email, password, firstName, lastName' 
      });
    }

    // The email must have been verified via /public/verify-otp in the last
    // 30 minutes - checked (and consumed) server-side, never trusted from
    // the client. REQUIRE_EMAIL_VERIFICATION=false skips it for local dev.
    if (process.env.REQUIRE_EMAIL_VERIFICATION !== 'false') {
      const verified = await consumeVerified('EMAIL_VERIFY', actualAdminEmail);
      if (!verified) {
        return res.status(400).json({ error: 'Please verify your email before creating your organization' });
      }
    }

    // Check if admin email already exists
    const existingUser = await prisma.user.findUnique({ where: { email: actualAdminEmail } });
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    // Resolve the org's subdomain slug: use the caller's choice if valid,
    // otherwise auto-generate one from the org name.
    let resolvedSlug: string;
    if (slug) {
      const normalized = slugify(slug);
      if (normalized !== slug.toLowerCase()) {
        return res.status(400).json({ error: 'Slug must be lowercase letters, numbers, and hyphens only' });
      }
      if (isReservedSlug(normalized)) {
        return res.status(400).json({ error: 'This slug is reserved and cannot be used' });
      }
      const existingOrgWithSlug = await prisma.organization.findUnique({ where: { slug: normalized } });
      if (existingOrgWithSlug) {
        return res.status(400).json({ error: 'This slug is already taken' });
      }
      resolvedSlug = normalized;
    } else {
      resolvedSlug = await generateUniqueSlug(organizationName);
    }

    // Create organization and admin user in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create organization
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          email: actualAdminEmail, // Use admin email as org email
          phone: phone || null,
          slug: resolvedSlug,
        },
      });

      // Hash password
      const hashedPassword = await bcrypt.hash(adminPassword, 10);

      // Create admin user
      const adminUser = await tx.user.create({
        data: {
          email: actualAdminEmail,
          password: hashedPassword,
          firstName: adminFirstName,
          lastName: adminLastName,
          role: 'ORG_ADMIN',
          organizationId: organization.id,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
        },
      });

      // Assign the default plan (e.g. Free) so every org starts with a real
      // subscription instead of relying on the null-subscription fallback.
      const defaultPlan = await tx.subscriptionPlan.findFirst({ where: { isDefault: true, isActive: true } });
      if (defaultPlan) {
        const now = new Date();
        const trialEndsAt = defaultPlan.trialDurationDays
          ? new Date(now.getTime() + defaultPlan.trialDurationDays * 24 * 60 * 60 * 1000)
          : null;
        const subscription = await tx.organizationSubscription.create({
          data: {
            planId: defaultPlan.id,
            status: defaultPlan.trialDurationDays ? 'TRIAL' : 'ACTIVE',
            billingCycle: 'monthly',
            trialEndsAt,
            currentPeriodStart: now,
            currentPeriodEnd: trialEndsAt || new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()),
          },
        });
        await tx.organization.update({
          where: { id: organization.id },
          data: { subscriptionId: subscription.id },
        });
      }

      return { organization, adminUser };
    });

    // Generate JWT token for auto-login
    const token = signToken({ userId: result.adminUser.id, role: result.adminUser.role });

    res.status(201).json({
      organization: result.organization,
      user: result.adminUser,
      token,
    });
  } catch (error) {
    next(error);
  }
};

// Public endpoint: Get organization details for public pages
export const getPublicOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params;

    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        logoUrl: true,
        primaryColor: true,
        hidePoweredBy: true, industry: true, customerLabel: true, customerLabelPlural: true,
        locations: {
          select: {
            id: true,
            name: true,
            address: true,
            publicCode: true,
            services: {
              where: { isActive: true },
              select: {
                id: true,
                name: true,
                description: true,
              },
            },
          },
        },
      },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json(organization);
  } catch (error) {
    next(error);
  }
};

// Public endpoint: resolve an organization by its subdomain slug
export const getPublicOrganizationBySlug = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug } = req.params;

    const organization = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true, hidePoweredBy: true, industry: true, customerLabel: true, customerLabelPlural: true },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json(organization);
  } catch (error) {
    next(error);
  }
};

export const createOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, phone } = req.body;

    const organization = await prisma.organization.create({
      data: { name, email, phone },
    });

    res.status(201).json(organization);
  } catch (error) {
    next(error);
  }
};

export const getOrganizations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // SUPER_ADMIN sees every org (this route is used by the general orgs
    // list — the dedicated /superadmin/organizations endpoint has its own
    // richer listing, this one stays available for backward compatibility).
    // Any other caller (e.g. ORG_ADMIN) is scoped to only their own org —
    // never return every tenant's org list to a non-superadmin.
    let organizations;
    if (req.user?.role === 'SUPER_ADMIN') {
      organizations = await prisma.organization.findMany({
        include: {
          locations: true,
          _count: { select: { users: true, locations: true } },
        },
      });
    } else {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { organizationId: true },
      });

      if (!user?.organizationId) {
        return res.json([]);
      }

      organizations = await prisma.organization.findMany({
        where: { id: user.organizationId },
        include: {
          locations: true,
          _count: { select: { users: true, locations: true } },
        },
      });
    }

    res.json(organizations);
  } catch (error) {
    next(error);
  }
};

export const getOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: {
        locations: {
          include: { services: true },
        },
        users: {
          select: { id: true, email: true, firstName: true, lastName: true, role: true },
        },
      },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json(organization);
  } catch (error) {
    next(error);
  }
};

export const updateOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, email, phone, slug, identityFieldsConfig, defaultDisplayMode, primaryColor, hidePoweredBy, notificationSettings, industry, customerLabel, customerLabelPlural, joinIdentifierType } = req.body;

    if (primaryColor !== undefined || hidePoweredBy !== undefined) {
      const features = await getOrganizationFeatures(id);
      if (!features.customBranding) {
        return res.status(403).json({
          error: 'Feature not available',
          message: 'Your subscription plan does not include the "customBranding" feature. Please upgrade your plan.',
          feature: 'customBranding',
          upgradeRequired: true,
        });
      }
    }

    // If slug is provided, validate it
    if (slug) {
      // Slug must be lowercase alphanumeric with hyphens
      const slugRegex = /^[a-z0-9-]+$/;
      if (!slugRegex.test(slug)) {
        return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens only' });
      }
      if (isReservedSlug(slug)) {
        return res.status(400).json({ error: 'This slug is reserved and cannot be used' });
      }
      // Check if slug is already taken by another org. Use findUnique for the slug
      // (slug is unique in the schema) and ensure the found org isn't the one being updated.
      const existing = await prisma.organization.findUnique({ where: { slug } });
      if (existing && existing.id !== id) {
        return res.status(400).json({ error: 'This slug is already taken' });
      }
    }

    // Build update data
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (slug !== undefined) updateData.slug = slug || null;
    if (identityFieldsConfig !== undefined) updateData.identityFieldsConfig = identityFieldsConfig;
    if (defaultDisplayMode !== undefined) updateData.defaultDisplayMode = defaultDisplayMode;
    if (primaryColor !== undefined) updateData.primaryColor = primaryColor || null;
    if (hidePoweredBy !== undefined) updateData.hidePoweredBy = Boolean(hidePoweredBy);
    if (notificationSettings !== undefined) updateData.notificationSettings = readNotificationSettings(notificationSettings);
    if (industry !== undefined) {
      if (industry !== null && !INDUSTRIES.some((i) => i.id === industry)) return res.status(400).json({ error: 'Unknown industry' });
      updateData.industry = industry;
    }
    const label = (v: unknown) => (v ? String(v).trim().toLowerCase().slice(0, 30) || null : null);
    if (customerLabel !== undefined) updateData.customerLabel = label(customerLabel);
    if (customerLabelPlural !== undefined) updateData.customerLabelPlural = label(customerLabelPlural);
    if (joinIdentifierType !== undefined) {
      if (joinIdentifierType !== null && !isJoinIdentifierType(joinIdentifierType)) {
        return res.status(400).json({ error: 'joinIdentifierType must be mrNumber, memberNumber or null' });
      }
      updateData.joinIdentifierType = joinIdentifierType;
    }

    const organization = await prisma.organization.update({
      where: { id },
      data: updateData,
    });

    res.json(organization);
  } catch (error) {
    next(error);
  }
};

export const uploadOrganizationLogo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded (expected multipart field "logo")' });
    }
    if (!ALLOWED_LOGO_MIME_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: `File type must be one of: ${ALLOWED_LOGO_MIME_TYPES.join(', ')}` });
    }

    const provider = await getActiveFileStorageProvider();
    if (!provider) {
      return res.status(400).json({ error: 'No file storage provider is configured' });
    }

    const organization = await prisma.organization.findUnique({
      where: { id },
      select: { logoFileId: true },
    });
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    let uploaded;
    try {
      uploaded = await provider.uploadFile(file.buffer, file.originalname, file.mimetype);
    } catch (err) {
      console.error('Logo upload to file storage provider failed:', err);
      return res.status(502).json({ error: 'File storage provider temporarily unavailable. Please try again shortly.' });
    }

    if (organization.logoFileId) {
      try {
        await provider.deleteFile(organization.logoFileId);
      } catch (err) {
        // Non-fatal - the new logo is already uploaded and about to be saved;
        // an orphaned old file just wastes a bit of storage quota.
        console.error(`Failed to delete previous logo file ${organization.logoFileId}:`, err);
      }
    }

    const updated = await prisma.organization.update({
      where: { id },
      data: { logoUrl: uploaded.url, logoFileId: uploaded.fileId },
      select: { id: true, logoUrl: true },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const deleteOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await prisma.organization.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
