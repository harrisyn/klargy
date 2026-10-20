import prisma from '../lib/prisma';
import { getCurrencyConfig, planForCurrency, toBase } from './currency.service';

/**
 * Monthly recurring revenue across active subscriptions, in the base
 * currency. Each organization pays in its own currency (its plan priced
 * there), so each is converted before adding up. Yearly and quarterly plans
 * count as a twelfth and a third.
 */
export async function monthlyRecurringRevenue(): Promise<{ total: number; currency: string }> {
  const [config, subscriptions] = await Promise.all([
    getCurrencyConfig(),
    prisma.organizationSubscription.findMany({ where: { status: 'ACTIVE' }, include: { plan: true } }),
  ]);
  const orgs = await prisma.organization.findMany({ where: { subscriptionId: { in: subscriptions.map((s) => s.id) } }, select: { subscriptionId: true, currency: true } });
  const currencyOf = new Map(orgs.map((o) => [o.subscriptionId, o.currency]));

  let total = 0;
  for (const sub of subscriptions) {
    const priced = await planForCurrency(sub.plan, currencyOf.get(sub.id) ?? sub.plan.currency);
    const monthly =
      sub.billingCycle === 'yearly' ? Number(priced.priceYearly) / 12 : sub.billingCycle === 'quarterly' ? Number(priced.priceQuarterly) / 3 : Number(priced.priceMonthly);
    total += toBase(monthly, priced.currency, config);
  }
  return { total: Math.round(total * 100) / 100, currency: config.base };
}
