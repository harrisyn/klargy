import prisma from '../lib/prisma';
import {
  PlanPricing,
  SettlementInput,
  addCycle,
  cyclePrice,
  normalizeCycle,
  resolveSettlement,
} from '../lib/walletSettlement';
import { planForCurrency } from './currency.service';

const toPricing = (plan: {
  id: string;
  currency: string;
  priceMonthly: unknown;
  priceQuarterly: unknown;
  priceYearly: unknown;
}): PlanPricing => ({
  id: plan.id,
  currency: plan.currency,
  priceMonthly: Number(plan.priceMonthly),
  priceQuarterly: Number(plan.priceQuarterly),
  priceYearly: Number(plan.priceYearly),
});

export async function getWalletBalance(organizationId: string, currency: string): Promise<number> {
  const result = await prisma.walletLedgerEntry.aggregate({
    where: { organizationId, currency },
    _sum: { amount: true },
  });
  return Number(result._sum.amount ?? 0);
}

export async function recordWalletEntry(params: {
  organizationId: string;
  amount: number;
  currency: string;
  kind: 'TOPUP' | 'DEBIT' | 'PLAN_CHARGE' | 'PAYMENT';
  reason: string;
  actorUserId?: string | null;
  externalRef?: string | null;
}) {
  return prisma.walletLedgerEntry.create({
    data: {
      organizationId: params.organizationId,
      amount: params.amount,
      currency: params.currency,
      kind: params.kind,
      reason: params.reason,
      actorUserId: params.actorUserId ?? null,
      externalRef: params.externalRef ?? null,
    },
  });
}

// Credits a payment-provider payment to the wallet. Idempotent on the
// provider event, so a retried webhook can't credit twice. Returns false if
// this event was already credited.
export async function creditProviderPayment(params: {
  organizationId: string;
  amount: number;
  currency: string;
  provider: string;
  eventId: string;
}): Promise<boolean> {
  try {
    await recordWalletEntry({
      organizationId: params.organizationId,
      amount: params.amount,
      currency: params.currency,
      kind: 'PAYMENT',
      reason: `Card payment (${params.provider})`,
      externalRef: `${params.provider}:${params.eventId}`,
    });
    return true;
  } catch (error: any) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
}

// Runs the wallet lifecycle for one organization's subscription: ends an
// expired plan override, then renews/enrols from the wallet when the period
// has lapsed. Safe to call repeatedly (reads, cron, after a top-up) - the
// period-end compare-and-set means two racing callers charge only once.
// Returns true if anything changed.
export async function settleOrganizationSubscription(organizationId: string, now = new Date()): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true, subscription: { include: { plan: true } } },
  });
  const sub = org?.subscription;
  if (!sub || !sub.walletManaged) return false;

  const revertPlanRow = sub.planOverrideRevertPlanId
    ? await prisma.subscriptionPlan.findUnique({ where: { id: sub.planOverrideRevertPlanId } })
    : null;

  const input: SettlementInput = {
    status: sub.status,
    billingCycle: sub.billingCycle,
    currentPeriodEnd: sub.currentPeriodEnd,
    hasProviderSubscription: !!sub.externalProviderSubscriptionId,
    walletManaged: sub.walletManaged,
    customPrice: sub.customPrice === null ? null : Number(sub.customPrice),
    planOverrideUntil: sub.planOverrideUntil,
    planOverrideRevertPlanId: sub.planOverrideRevertPlanId,
    planOverrideRevertPeriodEnd: sub.planOverrideRevertPeriodEnd,
    planOverrideEndBehavior: sub.planOverrideEndBehavior,
    plan: toPricing(await planForCurrency(sub.plan, org?.currency)),
    revertPlan: revertPlanRow ? toPricing(await planForCurrency(revertPlanRow, org?.currency)) : null,
  };

  // The wallet currency to check is the currency of the plan the charge would
  // be against (the revert plan if the override is about to be undone).
  const chargePlan =
    input.planOverrideUntil && input.planOverrideUntil <= now && input.planOverrideEndBehavior === 'REVERT' && input.revertPlan
      ? input.revertPlan
      : input.plan;
  const balance = await getWalletBalance(organizationId, chargePlan.currency);
  const { patch, charge } = resolveSettlement(input, now, balance);
  if (!patch) return false;

  return prisma.$transaction(async (tx) => {
    // Compare-and-set on the period end so a concurrent settle can't charge twice.
    const claimed = await tx.organizationSubscription.updateMany({
      where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd, status: sub.status as any },
      data: { currentPeriodEnd: sub.currentPeriodEnd },
    });
    if (claimed.count === 0) return false;
    // planId is a relation scalar, so it can't go through updateMany
    await tx.organizationSubscription.update({ where: { id: sub.id }, data: patch as any });
    if (charge) {
      await tx.walletLedgerEntry.create({
        data: {
          organizationId,
          amount: -charge.amount,
          currency: charge.currency,
          kind: 'PLAN_CHARGE',
          reason: charge.reason,
        },
      });
    }
    return true;
  });
}

// Same as settleOrganizationSubscription, for callers that only hold the
// subscription row (the read-path expiry check).
export async function settleBySubscriptionId(subscriptionId: string, now = new Date()): Promise<boolean> {
  const org = await prisma.organization.findFirst({ where: { subscriptionId }, select: { id: true } });
  return org ? settleOrganizationSubscription(org.id, now) : false;
}

export type EnrollResult =
  | { ok: true; planId: string; planName: string; charged: number; currency: string; currentPeriodEnd: Date }
  | { ok: false; code: 'PLAN_NOT_FOUND' | 'INSUFFICIENT_FUNDS'; balance?: number; price?: number; currency?: string };

// Tenant pays for a plan out of its wallet (the alternative to a provider
// checkout). Creates or updates the subscription and puts it on the wallet.
export async function enrollFromWallet(organizationId: string, planId: string, billingCycle: string, now = new Date()): Promise<EnrollResult> {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) return { ok: false, code: 'PLAN_NOT_FOUND' };

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { subscriptionId: true, subscription: true, currency: true },
  });
  const cycle = normalizeCycle(billingCycle);
  const priced = await planForCurrency(plan, org?.currency);
  const pricing = toPricing(priced);
  const price = cyclePrice(pricing, cycle);
  const balance = await getWalletBalance(organizationId, priced.currency);
  if (balance < price) {
    return { ok: false, code: 'INSUFFICIENT_FUNDS', balance, price, currency: priced.currency };
  }
  const periodEnd = addCycle(now, cycle);

  await prisma.$transaction(async (tx) => {
    const data = {
      planId: plan.id,
      status: 'ACTIVE' as const,
      billingCycle: cycle,
      trialEndsAt: null,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      walletManaged: true,
      customPrice: null,
      planOverrideUntil: null,
      planOverrideRevertPlanId: null,
      planOverrideRevertPeriodEnd: null,
      planOverrideEndBehavior: null,
    };
    if (org?.subscriptionId) {
      await tx.organizationSubscription.update({ where: { id: org.subscriptionId }, data });
    } else {
      const created = await tx.organizationSubscription.create({ data });
      await tx.organization.update({ where: { id: organizationId }, data: { subscriptionId: created.id } });
    }
    if (price > 0) {
      await tx.walletLedgerEntry.create({
        data: {
          organizationId,
          amount: -price,
          currency: priced.currency,
          kind: 'PLAN_CHARGE',
          reason: `${plan.name} plan (${cycle})`,
        },
      });
    }
  });

  return { ok: true, planId: plan.id, planName: plan.name, charged: price, currency: priced.currency, currentPeriodEnd: periodEnd };
}

// After a superadmin top-up: put a lapsed, provider-less subscription on the
// wallet so the new funds renew/enrol it, then settle.
export async function applyWalletToSubscription(organizationId: string, now = new Date()): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { subscription: true },
  });
  const sub = org?.subscription;
  if (!sub) return false;
  const lapsed = sub.currentPeriodEnd <= now || sub.status === 'EXPIRED' || sub.status === 'PAST_DUE';
  if (!lapsed) return false;
  if (sub.status === 'CANCELLED') return false;
  if (!sub.walletManaged) {
    await prisma.organizationSubscription.update({ where: { id: sub.id }, data: { walletManaged: true } });
  }
  return settleOrganizationSubscription(organizationId, now);
}

// Cron: settle every wallet-managed subscription that has lapsed or whose
// override has ended.
export async function settleDueSubscriptions(now = new Date()): Promise<number> {
  const due = await prisma.organization.findMany({
    where: {
      subscription: {
        walletManaged: true,
        status: { in: ['ACTIVE', 'PAST_DUE', 'EXPIRED'] },
        OR: [{ currentPeriodEnd: { lte: now } }, { planOverrideUntil: { lte: now } }, { status: { in: ['PAST_DUE', 'EXPIRED'] } }],
      },
    },
    select: { id: true },
  });
  let changed = 0;
  for (const { id } of due) {
    try {
      if (await settleOrganizationSubscription(id, now)) changed++;
    } catch (error) {
      console.error(`Wallet settlement failed for org ${id}:`, error);
    }
  }
  return changed;
}
