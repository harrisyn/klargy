import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import {
  applyWalletToSubscription,
  enrollFromWallet,
  getWalletBalance,
  recordWalletEntry,
  settleOrganizationSubscription,
} from '../services/wallet.service';
import { cyclePrice, normalizeCycle } from '../lib/walletSettlement';
import { planForCurrency } from '../services/currency.service';

const END_BEHAVIORS = ['REVERT', 'KEEP_AT_CUSTOM_PRICE'] as const;

// The currency an organization's wallet is held in: the organization's own.
async function walletCurrency(organizationId: string): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true, subscription: { select: { plan: { select: { currency: true } } } } },
  });
  return org?.currency ?? org?.subscription?.plan.currency ?? 'USD';
}

async function walletSummary(organizationId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      currency: true,
      subscription: { include: { plan: true } },
    },
  });
  const sub = org?.subscription ?? null;
  const pricedPlan = sub ? await planForCurrency(sub.plan, org?.currency) : null;
  const currency = pricedPlan?.currency ?? org?.currency ?? 'USD';
  const [balance, entries] = await Promise.all([
    getWalletBalance(organizationId, currency),
    prisma.walletLedgerEntry.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  let nextCharge: { amount: number; date: Date } | null = null;
  let override: { until: Date; planName: string; endBehavior: string | null; customPrice: number | null } | null = null;
  if (sub) {
    const cycle = normalizeCycle(sub.billingCycle);
    const price = sub.customPrice !== null ? Number(sub.customPrice) : cyclePrice(
      {
        id: sub.plan.id,
        currency: pricedPlan!.currency,
        priceMonthly: Number(pricedPlan!.priceMonthly),
        priceQuarterly: Number(pricedPlan!.priceQuarterly),
        priceYearly: Number(pricedPlan!.priceYearly),
      },
      cycle
    );
    if (sub.walletManaged && sub.status !== 'CANCELLED') {
      // While an override runs the next charge is when it ends
      nextCharge = { amount: sub.planOverrideUntil ? 0 : price, date: sub.planOverrideUntil ?? sub.currentPeriodEnd };
    }
    if (sub.planOverrideUntil) {
      override = {
        until: sub.planOverrideUntil,
        planName: sub.plan.name,
        endBehavior: sub.planOverrideEndBehavior,
        customPrice: sub.customPrice === null ? null : Number(sub.customPrice),
      };
    }
  }

  return {
    balance,
    currency,
    walletManaged: sub?.walletManaged ?? false,
    nextCharge,
    override,
    entries: entries.map((e) => ({
      id: e.id,
      amount: Number(e.amount),
      currency: e.currency,
      kind: e.kind,
      reason: e.reason,
      createdAt: e.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Superadmin
// ---------------------------------------------------------------------------

export const getOrganizationWallet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const organization = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    res.json(await walletSummary(id));
  } catch (error) {
    next(error);
  }
};

// Credit (positive) or debit (negative) an organization's wallet. A credit
// immediately tries to renew/enrol the subscription from the new funds.
export const adjustOrganizationWallet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { amount, reason, currency } = req.body as { amount: number; reason: string; currency?: string };

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const organization = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
    if (!organization) return res.status(404).json({ error: 'Organization not found' });

    const walletCcy = currency || (await walletCurrency(id));
    const rounded = Math.round(amount * 100) / 100;
    if (rounded < 0) {
      const balance = await getWalletBalance(id, walletCcy);
      if (balance + rounded < 0) {
        return res.status(400).json({ error: `Debit exceeds the wallet balance (${balance.toFixed(2)} ${walletCcy})` });
      }
    }

    await recordWalletEntry({
      organizationId: id,
      amount: rounded,
      currency: walletCcy,
      kind: rounded > 0 ? 'TOPUP' : 'DEBIT',
      reason: String(reason).trim(),
      actorUserId: req.user?.userId,
    });

    const applied = rounded > 0 ? await applyWalletToSubscription(id) : false;
    res.status(201).json({ ...(await walletSummary(id)), subscriptionUpdated: applied });
  } catch (error) {
    next(error);
  }
};

// Move an organization to a plan at no cost until a date. When the date
// passes it either returns to its original plan (REVERT) or stays on the new
// plan at a custom price (KEEP_AT_CUSTOM_PRICE), billed from the wallet.
export const bumpOrganizationPlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { planId, until, endBehavior, customPrice, billingCycle } = req.body as {
      planId: string;
      until: string;
      endBehavior: string;
      customPrice?: number | null;
      billingCycle?: string;
    };

    if (!planId || !until) return res.status(400).json({ error: 'planId and until are required' });
    if (!END_BEHAVIORS.includes(endBehavior as any)) {
      return res.status(400).json({ error: 'endBehavior must be REVERT or KEEP_AT_CUSTOM_PRICE' });
    }
    const untilDate = new Date(until);
    if (Number.isNaN(untilDate.getTime()) || untilDate <= new Date()) {
      return res.status(400).json({ error: 'until must be a future date' });
    }
    if (endBehavior === 'KEEP_AT_CUSTOM_PRICE' && (typeof customPrice !== 'number' || customPrice < 0)) {
      return res.status(400).json({ error: 'customPrice is required to keep the plan at a custom price' });
    }

    const [organization, plan] = await Promise.all([
      prisma.organization.findUnique({ where: { id }, include: { subscription: true } }),
      prisma.subscriptionPlan.findUnique({ where: { id: planId } }),
    ]);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const existing = organization.subscription;

    const now = new Date();
    const cycle = normalizeCycle(billingCycle ?? existing?.billingCycle ?? 'monthly');
    // If a bump is already running, keep the plan it will eventually revert to
    const alreadyBumped = !!existing?.planOverrideUntil;
    const revertPlanId = alreadyBumped ? existing!.planOverrideRevertPlanId : existing?.planId ?? null;
    const revertPeriodEnd = alreadyBumped
      ? existing!.planOverrideRevertPeriodEnd
      : existing && existing.currentPeriodEnd > now
        ? existing.currentPeriodEnd
        : null;

    if (endBehavior === 'REVERT' && !revertPlanId) {
      return res.status(400).json({ error: 'This organization has no current plan to revert to; use KEEP_AT_CUSTOM_PRICE' });
    }

    const data = {
      planId: plan.id,
      status: 'ACTIVE' as const,
      billingCycle: cycle,
      trialEndsAt: null,
      currentPeriodStart: now,
      currentPeriodEnd: untilDate,
      walletManaged: true,
      customPrice: endBehavior === 'KEEP_AT_CUSTOM_PRICE' ? customPrice! : null,
      planOverrideUntil: untilDate,
      planOverrideRevertPlanId: revertPlanId,
      planOverrideRevertPeriodEnd: revertPeriodEnd,
      planOverrideEndBehavior: endBehavior,
      cancelledAt: null,
      cancelReason: null,
    };

    if (existing) {
      await prisma.organizationSubscription.update({ where: { id: existing.id }, data });
    } else {
      const created = await prisma.organizationSubscription.create({ data });
      await prisma.organization.update({ where: { id }, data: { subscriptionId: created.id } });
    }

    res.json(await walletSummary(id));
  } catch (error) {
    next(error);
  }
};

// End a bump early, applying its end behaviour now.
export const endOrganizationPlanBump = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const organization = await prisma.organization.findUnique({ where: { id }, include: { subscription: true } });
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    if (!organization.subscription?.planOverrideUntil) {
      return res.status(400).json({ error: 'This organization has no active plan bump' });
    }
    await settleOrganizationSubscription(id, new Date(organization.subscription.planOverrideUntil.getTime() + 1));
    res.json(await walletSummary(id));
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

async function tenantOrganizationId(req: Request): Promise<string | null> {
  if (!req.user) return null;
  const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { organizationId: true } });
  return user?.organizationId ?? null;
}

export const getMyWallet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const organizationId = await tenantOrganizationId(req);
    if (!organizationId) return res.status(400).json({ error: 'User has no organization' });
    res.json(await walletSummary(organizationId));
  } catch (error) {
    next(error);
  }
};

// Pay for a plan out of the wallet instead of through a payment provider.
export const walletCheckout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const organizationId = await tenantOrganizationId(req);
    if (!organizationId) return res.status(400).json({ error: 'User has no organization' });

    const { planId, billingCycle } = req.body as { planId: string; billingCycle?: string };
    if (!planId) return res.status(400).json({ error: 'planId is required' });

    const result = await enrollFromWallet(organizationId, planId, billingCycle ?? 'monthly');
    if (!result.ok) {
      if (result.code === 'PLAN_NOT_FOUND') return res.status(404).json({ error: 'Plan not found' });
      return res.status(402).json({
        error: `Not enough wallet balance (${result.balance?.toFixed(2)} of ${result.price?.toFixed(2)} ${result.currency})`,
        balance: result.balance,
        price: result.price,
        currency: result.currency,
      });
    }
    res.json({ success: true, ...result, ...(await walletSummary(organizationId)) });
  } catch (error) {
    next(error);
  }
};
