import { savePlanCurrencyPrices, planForCurrency, CurrencyError } from '../services/currency.service';
import { monthlyRecurringRevenue } from '../services/revenue.service';
import { loadCaller } from '../middleware/tenantScope.middleware';
import { Request, Response, NextFunction } from 'express';
import { signToken } from '../lib/jwt';
import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { staffSeatWhere } from '../middleware/subscription.middleware';

const IMPERSONATION_TOKEN_TTL = '2h';

// =====================================================
// ORGANIZATION MANAGEMENT
// =====================================================

// List all organizations with subscription info
export const listOrganizations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, status, planId, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: Prisma.OrganizationWhereInput = {};
    
    if (search) {
      where.OR = [
        { name: { contains: String(search), mode: 'insensitive' } },
        { email: { contains: String(search), mode: 'insensitive' } },
        { slug: { contains: String(search), mode: 'insensitive' } },
      ];
    }

    if (status || planId) {
      where.subscription = {};
      if (status) {
        where.subscription.status = String(status) as any;
      }
      if (planId) {
        where.subscription.planId = String(planId);
      }
    }

    const [organizations, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        include: {
          subscription: {
            include: {
              plan: true,
            },
          },
          _count: {
            select: {
              locations: true,
              users: { where: { isActive: true, role: { not: 'PATIENT' } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.organization.count({ where }),
    ]);

    res.json({
      organizations,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Get single organization details
export const getOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: {
        subscription: {
          include: {
            plan: true,
          },
        },
        locations: {
          include: {
            _count: {
              select: {
                services: true,
              },
            },
          },
        },
        users: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            createdAt: true,
          },
        },
        customDomain: true,
        _count: {
          select: {
            locations: true,
            users: true,
            dataSources: true,
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

// Pause or reactivate an organization. PAUSED shows a banner in the tenant
// admin app and blocks public join/status pages, without blocking staff
// login - see docs/superpowers/specs/... (org-status design discussion).
export const setOrganizationStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      return res.status(400).json({ error: 'status must be ACTIVE or PAUSED' });
    }

    const organization = await prisma.organization.update({
      where: { id },
      data: { status },
    });

    res.json(organization);
  } catch (error) {
    next(error);
  }
};

// Mint a short-lived session token for one of the org's admins so a
// superadmin can act as them for support purposes, logged for audit.
// Picks the org's ORG_ADMIN (falling back to any user) since that's the
// role tenant Settings pages are gated on.
export const impersonateOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const organization = await prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true },
    });
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    if (!organization.slug) {
      return res.status(400).json({ error: 'Organization has no workspace slug configured' });
    }

    const targetUser = await prisma.user.findFirst({
      where: { organizationId: id, role: 'ORG_ADMIN' },
      orderBy: { createdAt: 'asc' },
    }) || await prisma.user.findFirst({
      where: { organizationId: id },
      orderBy: { createdAt: 'asc' },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'This organization has no users to impersonate' });
    }

    const token = signToken({ userId: targetUser.id, role: targetUser.role }, IMPERSONATION_TOKEN_TTL);

    await prisma.impersonationLog.create({
      data: {
        organizationId: id,
        superAdminId: req.user!.userId,
        impersonatedUserId: targetUser.id,
      },
    });

    res.json({
      token,
      tenantSlug: organization.slug,
      organizationName: organization.name,
      impersonatedUser: {
        email: targetUser.email,
        firstName: targetUser.firstName,
        lastName: targetUser.lastName,
        role: targetUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Update organization subscription
export const updateOrganizationSubscription = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { planId, status, billingCycle, trialEndsAt, externalProviderSubscriptionId } = req.body;

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: { subscription: true },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Calculate period end based on billing cycle
    const currentPeriodStart = new Date();
    const currentPeriodEnd = new Date();
    if (billingCycle === 'yearly') {
      currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
    } else {
      currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
    }

    if (organization.subscription) {
      // Update existing subscription
      const subscription = await prisma.organizationSubscription.update({
        where: { id: organization.subscription.id },
        data: {
          planId: planId || undefined,
          status: status || undefined,
          billingCycle: billingCycle || undefined,
          trialEndsAt: trialEndsAt ? new Date(trialEndsAt) : undefined,
          externalProviderSubscriptionId: externalProviderSubscriptionId || undefined,
          currentPeriodStart: planId ? currentPeriodStart : undefined,
          currentPeriodEnd: planId ? currentPeriodEnd : undefined,
        },
        include: { plan: true },
      });

      res.json(subscription);
    } else {
      // Create new subscription
      if (!planId) {
        return res.status(400).json({ error: 'Plan ID is required for new subscription' });
      }

      const subscription = await prisma.organizationSubscription.create({
        data: {
          planId,
          status: status || 'ACTIVE',
          billingCycle: billingCycle || 'monthly',
          currentPeriodStart,
          currentPeriodEnd,
          trialEndsAt: trialEndsAt ? new Date(trialEndsAt) : null,
          externalProviderSubscriptionId: externalProviderSubscriptionId || null,
        },
        include: { plan: true },
      });

      // Link to organization
      await prisma.organization.update({
        where: { id },
        data: { subscriptionId: subscription.id },
      });

      res.json(subscription);
    }
  } catch (error) {
    next(error);
  }
};

// Cancel organization subscription
export const cancelOrganizationSubscription = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: { subscription: true },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    if (!organization.subscription) {
      return res.status(400).json({ error: 'Organization has no active subscription' });
    }

    const subscription = await prisma.organizationSubscription.update({
      where: { id: organization.subscription.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason || null,
      },
      include: { plan: true },
    });

    res.json(subscription);
  } catch (error) {
    next(error);
  }
};

// Manually grant (or debit) credits for an organization - e.g. a goodwill
// top-up after a support incident. Records a signed CreditLedgerEntry;
// positive amount = grant, negative = debit.
export const grantCredits = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { creditType, amount, reason } = req.body as { creditType: string; amount: number; reason: string };

    if (!CREDIT_TYPES.includes(creditType as any)) {
      return res.status(400).json({ error: 'creditType must be one of AI, EMAIL, SMS' });
    }
    if (!Number.isInteger(amount) || amount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero integer' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const organization = await prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const entry = await prisma.creditLedgerEntry.create({
      data: { organizationId: id, creditType: creditType as any, amount, reason },
    });

    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
};

// Delete organization (with all related data)
export const deleteOrganization = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { confirm } = req.body;

    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Please confirm deletion by sending confirm: "DELETE"' });
    }

    const organization = await prisma.organization.findUnique({
      where: { id },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Delete organization (cascades to locations, users, etc.)
    await prisma.organization.delete({
      where: { id },
    });

    res.json({ message: 'Organization deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// SUBSCRIPTION PLAN MANAGEMENT
// =====================================================

// List all subscription plans
export const listPlans = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { includeInactive } = req.query;

    const where: Prisma.SubscriptionPlanWhereInput = {};
    if (!includeInactive) {
      where.isActive = true;
    }

    const plans = await prisma.subscriptionPlan.findMany({
      where,
      include: {
        _count: {
          select: {
            subscriptions: true,
          },
        },
        creditAllowances: true,
        addOnPricingOverrides: true,
        currencyPrices: true,
      },
      orderBy: { displayOrder: 'asc' },
    });

    res.json(plans);
  } catch (error) {
    next(error);
  }
};

// Create subscription plan
const CREDIT_TYPES = ['AI', 'EMAIL', 'SMS'] as const;
const ADDON_RESOURCE_TYPES = ['LOCATIONS', 'USERS', 'DISPLAY_MEDIA'] as const;

// Upserts (or clears) a plan's add-on price overrides. A null/undefined
// value for a resourceType clears any existing override for that type,
// reverting it to the global AddOnPricing default.
async function upsertAddOnPricingOverrides(
  planId: string,
  overrides: Record<string, { pricePerUnitMonthly: number; pricePerUnitOneOff: number } | null | undefined>
) {
  for (const resourceType of ADDON_RESOURCE_TYPES) {
    if (!(resourceType in overrides)) continue;
    const value = overrides[resourceType];
    if (!value) {
      await prisma.planAddOnPricingOverride.deleteMany({ where: { planId, resourceType } });
      continue;
    }
    await prisma.planAddOnPricingOverride.upsert({
      where: { planId_resourceType: { planId, resourceType } },
      create: { planId, resourceType, pricePerUnitMonthly: value.pricePerUnitMonthly, pricePerUnitOneOff: value.pricePerUnitOneOff },
      update: { pricePerUnitMonthly: value.pricePerUnitMonthly, pricePerUnitOneOff: value.pricePerUnitOneOff },
    });
  }
}

// Upserts the given credit types' monthly allowance for one plan. Only
// touches keys present in `creditAllowances` - omitted types are left as-is.
async function upsertCreditAllowances(planId: string, creditAllowances: Record<string, number | null | undefined>) {
  for (const creditType of CREDIT_TYPES) {
    if (!(creditType in creditAllowances)) continue;
    const monthlyAllowance = creditAllowances[creditType];
    await prisma.planCreditAllowance.upsert({
      where: { planId_creditType: { planId, creditType } },
      create: { planId, creditType, monthlyAllowance: monthlyAllowance ?? null },
      update: { monthlyAllowance: monthlyAllowance ?? null },
    });
  }
}

export const createPlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      code,
      description,
      priceMonthly,
      priceQuarterly,
      priceYearly,
      currency,
      maxLocations,
      maxServicesPerLoc,
      maxUsersPerOrg,
      maxQueueEntriesPerDay,
      features,
      displayOrder,
      tierRank,
      isDefault,
      isRecommended,
      trialDurationDays,
      expiredFallbackPlanId,
      upgradePlanId,
      creditAllowances,
      addOnPricingOverrides,
    } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'Name and code are required' });
    }

    if (expiredFallbackPlanId && expiredFallbackPlanId === code) {
      return res.status(400).json({ error: 'A plan cannot be its own fallback' });
    }

    // Check for duplicate code
    const existing = await prisma.subscriptionPlan.findUnique({
      where: { code },
    });

    if (existing) {
      return res.status(400).json({ error: 'Plan with this code already exists' });
    }

    // If this is set as default, unset other defaults
    if (isDefault) {
      await prisma.subscriptionPlan.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }
    // If this is set as recommended, unset any other recommended plan
    if (isRecommended) {
      await prisma.subscriptionPlan.updateMany({
        where: { isRecommended: true },
        data: { isRecommended: false },
      });
    }

    const plan = await prisma.subscriptionPlan.create({
      data: {
        name,
        code,
        description,
        priceMonthly: priceMonthly || 0,
        priceQuarterly: priceQuarterly || 0,
        priceYearly: priceYearly || 0,
        currency: currency || 'USD',
        maxLocations: maxLocations || null,
        maxServicesPerLoc: maxServicesPerLoc || null,
        maxUsersPerOrg: maxUsersPerOrg || null,
        maxQueueEntriesPerDay: maxQueueEntriesPerDay || null,
        features: features || {},
        displayOrder: displayOrder || 0,
        tierRank: tierRank || 0,
        isDefault: isDefault || false,
        isRecommended: isRecommended || false,
        trialDurationDays: trialDurationDays || null,
        expiredFallbackPlanId: expiredFallbackPlanId || null,
        upgradePlanId: upgradePlanId || null,
      },
    });

    if (creditAllowances) {
      await upsertCreditAllowances(plan.id, creditAllowances);
    }
    if (addOnPricingOverrides) {
      await upsertAddOnPricingOverrides(plan.id, addOnPricingOverrides);
    }
    if (req.body.currencyPrices !== undefined) {
      await savePlanCurrencyPrices(plan.id, plan.currency, req.body.currencyPrices);
    }

    res.status(201).json(plan);
  } catch (error) {
    next(error);
  }
};

// Update subscription plan
export const updatePlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      priceMonthly,
      priceQuarterly,
      priceYearly,
      currency,
      maxLocations,
      maxServicesPerLoc,
      maxUsersPerOrg,
      maxQueueEntriesPerDay,
      features,
      displayOrder,
      tierRank,
      isActive,
      isDefault,
      isRecommended,
      trialDurationDays,
      expiredFallbackPlanId,
      upgradePlanId,
      creditAllowances,
      addOnPricingOverrides,
    } = req.body;

    const existing = await prisma.subscriptionPlan.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    if (expiredFallbackPlanId === id || upgradePlanId === id) {
      return res.status(400).json({ error: 'A plan cannot reference itself as its fallback or upgrade target' });
    }

    // If this is set as default, unset other defaults
    if (isDefault && !existing.isDefault) {
      await prisma.subscriptionPlan.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    // If this is set as recommended, unset any other recommended plan
    if (isRecommended && !existing.isRecommended) {
      await prisma.subscriptionPlan.updateMany({
        where: { isRecommended: true, id: { not: id } },
        data: { isRecommended: false },
      });
    }

    const plan = await prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: name ?? undefined,
        description: description ?? undefined,
        priceMonthly: priceMonthly ?? undefined,
        priceQuarterly: priceQuarterly ?? undefined,
        priceYearly: priceYearly ?? undefined,
        currency: currency ?? undefined,
        maxLocations: maxLocations === null ? null : (maxLocations ?? undefined),
        maxServicesPerLoc: maxServicesPerLoc === null ? null : (maxServicesPerLoc ?? undefined),
        maxUsersPerOrg: maxUsersPerOrg === null ? null : (maxUsersPerOrg ?? undefined),
        maxQueueEntriesPerDay: maxQueueEntriesPerDay === null ? null : (maxQueueEntriesPerDay ?? undefined),
        features: features ?? undefined,
        displayOrder: displayOrder ?? undefined,
        tierRank: tierRank ?? undefined,
        isActive: isActive ?? undefined,
        isDefault: isDefault ?? undefined,
        isRecommended: isRecommended ?? undefined,
        trialDurationDays: trialDurationDays === null ? null : (trialDurationDays ?? undefined),
        expiredFallbackPlanId: expiredFallbackPlanId === null ? null : (expiredFallbackPlanId ?? undefined),
        upgradePlanId: upgradePlanId === null ? null : (upgradePlanId ?? undefined),
      },
    });

    if (creditAllowances) {
      await upsertCreditAllowances(plan.id, creditAllowances);
    }
    if (addOnPricingOverrides) {
      await upsertAddOnPricingOverrides(plan.id, addOnPricingOverrides);
    }
    if (req.body.currencyPrices !== undefined) {
      await savePlanCurrencyPrices(plan.id, plan.currency, req.body.currencyPrices);
    }

    res.json(plan);
  } catch (error) {
    next(error);
  }
};

// Delete subscription plan
export const deletePlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            subscriptions: true,
          },
        },
      },
    });

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    if (plan._count.subscriptions > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete plan with active subscriptions. Deactivate it instead.',
        subscriptionCount: plan._count.subscriptions,
      });
    }

    await prisma.subscriptionPlan.delete({
      where: { id },
    });

    res.json({ message: 'Plan deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// DASHBOARD & ANALYTICS
// =====================================================

// Get superadmin dashboard stats
export const getDashboardStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      totalOrganizations,
      activeSubscriptions,
      trialSubscriptions,
      totalLocations,
      totalUsers,
      planBreakdown,
      recentOrganizations,
    ] = await Promise.all([
      // Total organizations
      prisma.organization.count(),
      
      // Active subscriptions
      prisma.organizationSubscription.count({
        where: { status: 'ACTIVE' },
      }),
      
      // Trial subscriptions
      prisma.organizationSubscription.count({
        where: { status: 'TRIAL' },
      }),
      
      // Total locations
      prisma.location.count(),
      
      // Total staff users (patients excluded)
      prisma.user.count({ where: { isActive: true, role: { not: 'PATIENT' } } }),
      
      // Subscription breakdown by plan
      prisma.subscriptionPlan.findMany({
        include: {
          _count: {
            select: {
              subscriptions: {
                where: { status: { in: ['ACTIVE', 'TRIAL'] } },
              },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      }),
      
      // Recent organizations
      prisma.organization.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          subscription: {
            include: {
              plan: {
                select: { name: true, code: true },
              },
            },
          },
          _count: {
            select: { locations: true, users: true },
          },
        },
      }),
    ]);

    // Monthly recurring revenue, in the base currency (see revenue.service).
    const revenue = await monthlyRecurringRevenue();

    res.json({
      stats: {
        totalOrganizations,
        activeSubscriptions,
        trialSubscriptions,
        cancelledSubscriptions: await prisma.organizationSubscription.count({
          where: { status: 'CANCELLED' },
        }),
        totalLocations,
        totalUsers,
        mrr: revenue.total.toFixed(2),
        mrrCurrency: revenue.currency,
      },
      planBreakdown: planBreakdown.map(p => ({
        id: p.id,
        name: p.name,
        code: p.code,
        activeCount: p._count.subscriptions,
      })),
      recentOrganizations,
    });
  } catch (error) {
    next(error);
  }
};

// Get usage stats for an organization
export const getOrganizationUsage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: {
        subscription: {
          include: { plan: true },
        },
      },
    });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      locationsCount,
      usersCount,
      servicesCount,
      todayEntries,
      monthEntries,
    ] = await Promise.all([
      prisma.location.count({ where: { organizationId: id } }),
      prisma.user.count({ where: staffSeatWhere(id) }),
      prisma.service.count({
        where: { location: { organizationId: id } },
      }),
      // Today's queue entries
      prisma.queueEntry.count({
        where: {
          queue: {
            service: {
              location: { organizationId: id },
            },
          },
          joinedAt: { gte: today },
        },
      }),
      // This month's queue entries
      prisma.queueEntry.count({
        where: {
          queue: {
            service: {
              location: { organizationId: id },
            },
          },
          joinedAt: {
            gte: new Date(today.getFullYear(), today.getMonth(), 1),
          },
        },
      }),
    ]);

    const plan = organization.subscription?.plan;
    
    res.json({
      usage: {
        locations: {
          used: locationsCount,
          limit: plan?.maxLocations || null,
          percentage: plan?.maxLocations ? (locationsCount / plan.maxLocations * 100).toFixed(1) : null,
        },
        users: {
          used: usersCount,
          limit: plan?.maxUsersPerOrg || null,
          percentage: plan?.maxUsersPerOrg ? (usersCount / plan.maxUsersPerOrg * 100).toFixed(1) : null,
        },
        services: {
          used: servicesCount,
          limitPerLocation: plan?.maxServicesPerLoc || null,
        },
        queueEntries: {
          today: todayEntries,
          thisMonth: monthEntries,
          dailyLimit: plan?.maxQueueEntriesPerDay || null,
        },
      },
      plan: plan ? {
        id: plan.id,
        name: plan.name,
        code: plan.code,
        features: plan.features,
      } : null,
      subscription: organization.subscription,
    });
  } catch (error) {
    next(error);
  }
};

/** The plans as the signed-in organization pays for them: in its own currency. Platform admins get the raw plans. */
export const listPlansForCaller = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = await loadCaller(req);
    if (!caller?.organizationId) return listPlans(req, res, next);
    const org = await prisma.organization.findUnique({ where: { id: caller.organizationId }, select: { currency: true } });
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      include: { _count: { select: { subscriptions: true } }, creditAllowances: true, addOnPricingOverrides: true, currencyPrices: true },
      orderBy: { displayOrder: 'asc' },
    });
    res.json(await Promise.all(plans.map((p) => planForCurrency(p, org?.currency))));
  } catch (error) {
    if (error instanceof CurrencyError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};
