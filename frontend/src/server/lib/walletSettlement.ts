export type BillingCycle = 'monthly' | 'quarterly' | 'yearly';

export interface PlanPricing {
  id: string;
  currency: string;
  priceMonthly: number;
  priceQuarterly: number;
  priceYearly: number;
}

export interface SettlementInput {
  status: string; // SubscriptionStatus, kept as string to avoid a Prisma import in a pure lib file
  billingCycle: string;
  currentPeriodEnd: Date;
  hasProviderSubscription: boolean;
  walletManaged: boolean;
  customPrice: number | null;
  planOverrideUntil: Date | null;
  planOverrideRevertPlanId: string | null;
  planOverrideRevertPeriodEnd: Date | null;
  planOverrideEndBehavior: string | null;
  plan: PlanPricing;
  // The plan an expiring REVERT override returns to (null if it was deleted)
  revertPlan: PlanPricing | null;
}

// What to write to the subscription row and, if money moves, the ledger.
export interface SettlementPatch {
  planId?: string;
  status?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  customPrice?: null;
  planOverrideUntil?: null;
  planOverrideRevertPlanId?: null;
  planOverrideRevertPeriodEnd?: null;
  planOverrideEndBehavior?: null;
}

export interface SettlementResult {
  patch: SettlementPatch | null;
  charge: { amount: number; currency: string; reason: string } | null;
}

export const PROVIDER_GRACE_DAYS = 3;

export function normalizeCycle(cycle: string): BillingCycle {
  return cycle === 'yearly' ? 'yearly' : cycle === 'quarterly' ? 'quarterly' : 'monthly';
}

export function cyclePrice(plan: PlanPricing, cycle: BillingCycle): number {
  return cycle === 'yearly' ? plan.priceYearly : cycle === 'quarterly' ? plan.priceQuarterly : plan.priceMonthly;
}

export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + (cycle === 'yearly' ? 12 : cycle === 'quarterly' ? 3 : 1));
  return d;
}

// Decides how a wallet-managed subscription moves on, given the current time
// and the organization's wallet balance (in the plan's currency). Pure: the
// caller writes the patch and the charge. Payments - card checkouts, provider
// renewals, superadmin credits - all land in the wallet first, and the wallet
// buys the plan. A subscription with a provider behind it gets a few days of
// grace at period end, since the provider's renewal payment can arrive late.
//
// Order matters: an expired override is resolved first (revert, or keep at
// the custom price), and the resulting subscription is then run through the
// normal renewal step.
export function resolveSettlement(input: SettlementInput, now: Date, walletBalance: number): SettlementResult {
  if (!input.walletManaged) {
    return { patch: null, charge: null };
  }

  let plan = input.plan;
  let periodEnd = input.currentPeriodEnd;
  const status = input.status;
  let customPrice = input.customPrice;
  const patch: SettlementPatch = {};

  if (input.planOverrideUntil && input.planOverrideUntil <= now) {
    patch.planOverrideUntil = null;
    patch.planOverrideRevertPlanId = null;
    patch.planOverrideRevertPeriodEnd = null;
    patch.planOverrideEndBehavior = null;

    if (input.planOverrideEndBehavior === 'REVERT' && input.revertPlan) {
      plan = input.revertPlan;
      patch.planId = plan.id;
      patch.customPrice = null;
      customPrice = null;
      // Back to wherever the original plan's paid period had got to
      periodEnd = input.planOverrideRevertPeriodEnd ?? now;
      patch.currentPeriodEnd = periodEnd;
    } else {
      // KEEP_AT_CUSTOM_PRICE (or a REVERT whose plan is gone): stay put and
      // start paying - the free window is over, so the period is due now.
      periodEnd = now;
      patch.currentPeriodEnd = now;
    }
  }

  const graceMs = input.hasProviderSubscription ? PROVIDER_GRACE_DAYS * 24 * 60 * 60 * 1000 : 0;
  const lapsed = periodEnd.getTime() + graceMs <= now.getTime();
  const needsEnrolment = status === 'EXPIRED' || status === 'PAST_DUE';
  if (!lapsed && !(needsEnrolment && walletBalance > 0)) {
    return { patch: Object.keys(patch).length ? patch : null, charge: null };
  }
  // A cancelled subscription stays cancelled unless a superadmin re-enrols it.
  if (status === 'CANCELLED' || status === 'TRIAL') {
    return { patch: Object.keys(patch).length ? patch : null, charge: null };
  }

  const cycle = normalizeCycle(input.billingCycle);
  const price = customPrice ?? cyclePrice(plan, cycle);

  if (price <= 0) {
    patch.status = 'ACTIVE';
    patch.currentPeriodStart = now;
    patch.currentPeriodEnd = addCycle(now, cycle);
    return { patch, charge: null };
  }

  if (walletBalance >= price) {
    patch.status = 'ACTIVE';
    patch.currentPeriodStart = now;
    patch.currentPeriodEnd = addCycle(now, cycle);
    return {
      patch,
      charge: { amount: price, currency: plan.currency, reason: `Plan renewal (${cycle})` },
    };
  }

  // Can't pay: flag it rather than silently extending for free.
  if (status === 'ACTIVE') patch.status = 'PAST_DUE';
  return { patch: Object.keys(patch).length ? patch : null, charge: null };
}
