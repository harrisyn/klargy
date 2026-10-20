import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { CurrencyError, currencyChangeBlock, getCurrencyConfig, isSupportedCurrency, refreshRatesFromFeed, saveCurrencyConfig, supportedCurrencies } from '../services/currency.service';

const fail = (error: unknown, res: Response, next: NextFunction) =>
  error instanceof CurrencyError ? res.status(error.status).json({ error: error.message }) : next(error);

/** Public: the currencies an organization can choose when signing up. */
export const getPublicCurrencies = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getCurrencyConfig();
    res.json({ base: config.base, currencies: supportedCurrencies(config) });
  } catch (error) {
    next(error);
  }
};

/** Superadmin: the currencies, their rates against the base, and how much each is used. */
export const getCurrencySettings = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getCurrencyConfig();
    const [orgs, plans] = await Promise.all([
      prisma.organization.groupBy({ by: ['currency'], _count: true }),
      prisma.subscriptionPlan.groupBy({ by: ['currency'], _count: true }),
    ]);
    res.json({
      base: config.base,
      rates: config.rates,
      refreshedAt: config.refreshedAt ?? null,
      autoRefresh: !!config.autoRefresh,
      usage: Object.fromEntries(
        supportedCurrencies(config).map((c) => [
          c,
          { organizations: orgs.find((o) => o.currency === c)?._count ?? 0, plans: plans.find((p) => p.currency === c)?._count ?? 0 },
        ])
      ),
      // Currencies already in use but without a rate: prices can't be converted to or from them.
      missingRates: [...new Set([...orgs.map((o) => o.currency), ...plans.map((p) => p.currency)])].filter((c) => !(c in config.rates)),
    });
  } catch (error) {
    next(error);
  }
};

export const updateCurrencySettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await saveCurrencyConfig({ rates: req.body?.rates ?? {}, autoRefresh: typeof req.body?.autoRefresh === 'boolean' ? req.body.autoRefresh : undefined });
    res.json({ base: config.base, rates: config.rates, autoRefresh: !!config.autoRefresh });
  } catch (error) {
    fail(error, res, next);
  }
};

/** Superadmin: pull today's market rates for the supported currencies. */
export const refreshCurrencyRates = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { updated, unavailable, config } = await refreshRatesFromFeed();
    res.json({ updated, unavailable, base: config.base, rates: config.rates, refreshedAt: config.refreshedAt });
  } catch (error) {
    fail(error, res, next);
  }
};

/** Superadmin: change an organization's currency when nothing is held in the old one. */
export const setOrganizationCurrency = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wanted = String(req.body?.currency ?? '').trim().toUpperCase();
    if (!(await isSupportedCurrency(wanted))) return res.status(400).json({ error: `${wanted || 'That'} isn’t a supported currency` });
    const org = await prisma.organization.findUnique({ where: { id: req.params.id }, select: { currency: true } });
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (org.currency === wanted) return res.json({ currency: wanted });
    const block = await currencyChangeBlock(req.params.id, { force: true });
    if (block) return res.status(409).json({ error: block });
    await prisma.organization.update({ where: { id: req.params.id }, data: { currency: wanted } });
    res.json({ currency: wanted });
  } catch (error) {
    fail(error, res, next);
  }
};
