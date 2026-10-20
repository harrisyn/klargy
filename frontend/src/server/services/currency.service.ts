import prisma from '../lib/prisma';

/**
 * Supported currencies and their conversion rates, set by the superadmin.
 * Each organization has one currency (Organization.currency); subscription
 * prices, its wallet and its booking payments are in it. A plan's price in
 * another currency is either set by hand (PlanCurrencyPrice) or the plan's
 * own price converted at these rates.
 */

const SETTINGS_KEY = 'currencies';
const CODE = /^[A-Z]{3}$/;

export interface CurrencyConfig {
  /** The currency the rates are quoted against; its rate is always 1. */
  base: string;
  /** How many units of each currency equal one unit of the base. */
  rates: Record<string, number>;
  /** When the rates were last pulled from the market feed, if ever. */
  refreshedAt?: string;
  /** Pull market rates every day (the daily cron) instead of only on request. */
  autoRefresh?: boolean;
}

export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = { base: 'USD', rates: { USD: 1 } };

export class CurrencyError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getCurrencyConfig(): Promise<CurrencyConfig> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const v = (row?.value ?? {}) as Partial<CurrencyConfig>;
  const base = typeof v.base === 'string' && CODE.test(v.base) ? v.base : DEFAULT_CURRENCY_CONFIG.base;
  const rates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(v.rates ?? {})) {
    if (CODE.test(code) && Number.isFinite(rate) && Number(rate) > 0) rates[code] = Number(rate);
  }
  rates[base] = 1;
  return { base, rates, ...(typeof v.refreshedAt === 'string' ? { refreshedAt: v.refreshedAt } : {}), ...(v.autoRefresh ? { autoRefresh: true } : {}) };
}

export const supportedCurrencies = (config: CurrencyConfig) => Object.keys(config.rates).sort((a, b) => (a === config.base ? -1 : b === config.base ? 1 : a.localeCompare(b)));

/** Saves the full set of rates. The base keeps rate 1; a currency still used by an organization can't be dropped. */
export async function saveCurrencyConfig(input: { rates: Record<string, unknown>; autoRefresh?: boolean }): Promise<CurrencyConfig> {
  const current = await getCurrencyConfig();
  const next: Record<string, number> = { [current.base]: 1 };
  for (const [rawCode, rawRate] of Object.entries(input.rates ?? {})) {
    const code = rawCode.trim().toUpperCase();
    if (!CODE.test(code)) throw new CurrencyError(`“${rawCode}” isn’t a three-letter currency code`);
    if (code === current.base) continue;
    const rate = Number(rawRate);
    if (!Number.isFinite(rate) || rate <= 0) throw new CurrencyError(`The rate for ${code} must be more than zero`);
    next[code] = rate;
  }
  const dropped = Object.keys(current.rates).filter((c) => !(c in next));
  if (dropped.length) {
    const inUse = await prisma.organization.groupBy({ by: ['currency'], where: { currency: { in: dropped } }, _count: true });
    if (inUse.length) throw new CurrencyError(`${inUse[0].currency} is still used by ${inUse[0]._count} organization(s), so it can’t be removed`, 409);
  }
  const autoRefresh = input.autoRefresh === undefined ? !!current.autoRefresh : !!input.autoRefresh;
  const config: CurrencyConfig = { base: current.base, rates: next, ...(current.refreshedAt ? { refreshedAt: current.refreshedAt } : {}), ...(autoRefresh ? { autoRefresh: true } : {}) };
  await prisma.platformSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: config as object }, update: { value: config as object } });
  return config;
}

export async function isSupportedCurrency(code: string): Promise<boolean> {
  return code in (await getCurrencyConfig()).rates;
}

/** Converts between two currencies at the platform rates, or null when a rate is missing. */
export function convertAmount(amount: number, from: string, to: string, config: CurrencyConfig): number | null {
  if (from === to) return amount;
  const a = config.rates[from];
  const b = config.rates[to];
  if (!a || !b) return null;
  return round2((amount * b) / a);
}

export interface PlanPriceFields {
  currency: string;
  priceMonthly: unknown;
  priceQuarterly: unknown;
  priceYearly: unknown;
}

export interface PlanCurrencyOverride {
  currency: string;
  priceMonthly: unknown;
  priceQuarterly: unknown;
  priceYearly: unknown;
}

/**
 * The plan priced in `currency`: a hand-set price if there is one, else the
 * plan's price converted at the platform rate, else (no rate) the plan as it
 * is. `priceSource` says which.
 */
export function priceInCurrency<T extends PlanPriceFields>(
  plan: T,
  currency: string | null | undefined,
  overrides: PlanCurrencyOverride[],
  config: CurrencyConfig
): T & { priceSource: 'PLAN' | 'OVERRIDE' | 'CONVERTED' } {
  if (!currency || currency === plan.currency) return { ...plan, priceSource: 'PLAN' };
  const own = overrides.find((o) => o.currency === currency);
  if (own) {
    return { ...plan, currency, priceMonthly: Number(own.priceMonthly), priceQuarterly: Number(own.priceQuarterly), priceYearly: Number(own.priceYearly), priceSource: 'OVERRIDE' };
  }
  const monthly = convertAmount(Number(plan.priceMonthly), plan.currency, currency, config);
  const quarterly = convertAmount(Number(plan.priceQuarterly), plan.currency, currency, config);
  const yearly = convertAmount(Number(plan.priceYearly), plan.currency, currency, config);
  if (monthly === null || quarterly === null || yearly === null) return { ...plan, priceSource: 'PLAN' };
  return { ...plan, currency, priceMonthly: monthly, priceQuarterly: quarterly, priceYearly: yearly, priceSource: 'CONVERTED' };
}

/** The plan as an organization pays for it, in the organization's currency. */
export async function planForCurrency<T extends PlanPriceFields & { id: string; currencyPrices?: PlanCurrencyOverride[] }>(plan: T, currency: string | null | undefined) {
  if (!currency || currency === plan.currency) return { ...plan, priceSource: 'PLAN' as const };
  const [config, overrides] = await Promise.all([
    getCurrencyConfig(),
    plan.currencyPrices ? Promise.resolve(plan.currencyPrices) : prisma.planCurrencyPrice.findMany({ where: { planId: plan.id, currency } }),
  ]);
  return priceInCurrency(plan, currency, overrides, config);
}

/**
 * Why an organization's currency can't be changed any more, or null when it can.
 * Money already held in the old currency (wallet, payouts) or a live card
 * subscription would be stranded.
 */
export async function currencyChangeBlock(organizationId: string, opts: { force?: boolean } = {}): Promise<string | null> {
  const [wallet, payouts, org] = await Promise.all([
    prisma.walletLedgerEntry.count({ where: { organizationId } }),
    prisma.payoutLedgerEntry.count({ where: { organizationId } }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { subscription: { select: { externalProviderSubscriptionId: true } } } }),
  ]);
  if (org?.subscription?.externalProviderSubscriptionId) return 'A card subscription is billing in the current currency. Cancel it first.';
  if (!opts.force) {
    if (wallet > 0 || payouts > 0) return 'This organization already has wallet or payout activity in its current currency. Ask support to change it.';
    return null;
  }
  // A platform admin may change it once nothing is held in the old currency.
  const [walletSum, payoutSum, openPayouts, holds] = await Promise.all([
    prisma.walletLedgerEntry.aggregate({ where: { organizationId }, _sum: { amount: true } }),
    prisma.payoutLedgerEntry.aggregate({ where: { organizationId }, _sum: { amount: true } }),
    prisma.payoutRequest.count({ where: { organizationId, status: 'REQUESTED' } }),
    prisma.appointment.count({ where: { service: { location: { organizationId } }, paymentStatus: 'PENDING' } }),
  ]);
  if (Math.abs(Number(walletSum._sum.amount ?? 0)) > 0.005) return 'The wallet still holds money in the current currency. Bring it to zero first.';
  if (Math.abs(Number(payoutSum._sum.amount ?? 0)) > 0.005) return 'The payout wallet still holds money in the current currency. Pay it out first.';
  if (openPayouts > 0) return 'A payout request is still open.';
  if (holds > 0) return 'A booking is waiting for payment in the current currency.';
  return null;
}

export async function organizationCurrency(organizationId: string): Promise<string | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
  return org?.currency ?? null;
}

/** Replaces a plan's hand-set prices. Rows for the plan's own currency are ignored; blanks mean "convert". */
export async function savePlanCurrencyPrices(planId: string, planCurrency: string, rows: unknown): Promise<void> {
  if (!Array.isArray(rows)) return;
  const config = await getCurrencyConfig();
  const clean: { currency: string; priceMonthly: number; priceQuarterly: number; priceYearly: number }[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const currency = String(r.currency ?? '').trim().toUpperCase();
    if (!currency || currency === planCurrency) continue;
    if (!(currency in config.rates)) throw new CurrencyError(`${currency} isn’t a supported currency`);
    const nums = [r.priceMonthly, r.priceQuarterly, r.priceYearly].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) throw new CurrencyError(`Prices in ${currency} must be zero or more`);
    clean.push({ currency, priceMonthly: nums[0], priceQuarterly: nums[1], priceYearly: nums[2] });
  }
  await prisma.$transaction([
    prisma.planCurrencyPrice.deleteMany({ where: { planId } }),
    ...(clean.length ? [prisma.planCurrencyPrice.createMany({ data: clean.map((c) => ({ ...c, planId })) })] : []),
  ]);
}

const RATE_FEED = 'https://open.er-api.com/v6/latest';

/**
 * Pulls today's market rates for the currencies you support. Only rates for
 * currencies already in the list change; the rest are reported so you can
 * decide. Prices already paid and wallet balances are never re-converted.
 */
export async function refreshRatesFromFeed(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ updated: string[]; unavailable: string[]; config: CurrencyConfig }> {
  const current = await getCurrencyConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let body: { result?: string; rates?: Record<string, number> };
  try {
    const res = await fetchImpl(`${RATE_FEED}/${current.base}`, { signal: controller.signal });
    if (!res.ok) throw new CurrencyError(`The rate service answered ${res.status}. Try again later or enter rates by hand.`, 502);
    body = (await res.json()) as typeof body;
  } catch (error) {
    if (error instanceof CurrencyError) throw error;
    throw new CurrencyError('Couldn’t reach the rate service. Try again later or enter rates by hand.', 502);
  } finally {
    clearTimeout(timer);
  }
  if (body.result !== 'success' || !body.rates) throw new CurrencyError('The rate service sent something unexpected. Enter rates by hand.', 502);

  const rates = { ...current.rates };
  const updated: string[] = [];
  const unavailable: string[] = [];
  for (const code of Object.keys(current.rates)) {
    if (code === current.base) continue;
    const rate = Number(body.rates[code]);
    if (Number.isFinite(rate) && rate > 0) {
      rates[code] = Math.round(rate * 1e6) / 1e6;
      updated.push(code);
    } else {
      unavailable.push(code);
    }
  }
  const config: CurrencyConfig = { base: current.base, rates, refreshedAt: now.toISOString(), ...(current.autoRefresh ? { autoRefresh: true } : {}) };
  await prisma.platformSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: config as object }, update: { value: config as object } });
  return { updated, unavailable, config };
}

/** An amount in one currency expressed in the base currency; unconvertible amounts count as zero. */
export function toBase(amount: number, from: string, config: CurrencyConfig): number {
  return convertAmount(amount, from, config.base, config) ?? 0;
}

/** Daily job: pulls market rates when the platform admin switched that on. Never throws. */
export async function refreshRatesIfScheduled(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<'refreshed' | 'off' | 'failed'> {
  const config = await getCurrencyConfig();
  if (!config.autoRefresh) return 'off';
  try {
    await refreshRatesFromFeed(fetchImpl, now);
    return 'refreshed';
  } catch (error) {
    console.error('Scheduled rate refresh failed (rates unchanged):', error instanceof Error ? error.message : error);
    return 'failed';
  }
}
