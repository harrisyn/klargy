import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { encrypt } from '../lib/encryption';
import { buildAppUrl } from '../config/appConfig';
import { loadCaller } from '../middleware/tenantScope.middleware';
import { getOrganizationFeatures } from '../middleware/subscription.middleware';
import { BOOKING_PROVIDERS, type BookingProviderName } from '../services/bookingPayments/providers';
import { currencyChangeBlock, getCurrencyConfig, isSupportedCurrency, supportedCurrencies } from '../services/currency.service';
import { collectorFor } from '../services/bookingPayments/bookingPayments.service';
import {
  PayoutError,
  getPayoutSettings,
  payoutBalance,
  readPayoutDetails,
  requestPayout,
  savePayoutDetails,
} from '../services/payoutWallet.service';

/**
 * An organization's payments page: how it takes money for bookings (its own
 * Stripe/Paystack account on paid plans, otherwise collected on its behalf)
 * and the payout wallet for money collected on its behalf.
 */

const CURRENCY = /^[A-Z]{3}$/;

async function orgIdOf(req: Request, res: Response): Promise<string | null> {
  const caller = await loadCaller(req);
  if (!caller?.organizationId) {
    res.status(403).json({ error: 'No organization' });
    return null;
  }
  return caller.organizationId;
}

const fail = (error: unknown, res: Response, next: NextFunction) =>
  error instanceof PayoutError ? res.status(error.status).json({ error: error.message }) : next(error);

export const getPaymentsOverview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await orgIdOf(req, res);
    if (!organizationId) return;
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true, payoutDetails: true } });
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const [own, platformProviders, features, settings, balance, requests, ledger, collector] = await Promise.all([
      prisma.orgPaymentProvider.findMany({ where: { organizationId } }),
      prisma.paymentProviderConfig.count({ where: { isActive: true } }),
      getOrganizationFeatures(organizationId),
      getPayoutSettings(),
      payoutBalance(organizationId, org.currency),
      prisma.payoutRequest.findMany({ where: { organizationId }, orderBy: { requestedAt: 'desc' }, take: 20, select: { id: true, amount: true, currency: true, status: true, note: true, requestedAt: true, reviewedAt: true } }),
      prisma.payoutLedgerEntry.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, amount: true, currency: true, kind: true, reason: true, availableAt: true, createdAt: true } }),
      collectorFor(organizationId, org.currency),
    ]);

    res.json({
      currency: org.currency,
      supportedCurrencies: supportedCurrencies(await getCurrencyConfig()),
      // Who takes booking payments right now: ORG (own keys), PLATFORM (collected for you) or NONE.
      collectedBy: collector?.source ?? 'NONE',
      collectorProvider: collector?.provider ?? null,
      platformCollects: platformProviders > 0,
      canUseOwnKeys: !!features.ownPaymentKeys,
      ownProviders: own.map((p) => ({
        provider: p.provider,
        isActive: p.isActive,
        publicKey: p.publicKey,
        secretKey: '••••••••',
        hasWebhookSecret: !!p.webhookSecret,
        webhookUrl: buildAppUrl(`/api/v1/webhooks/booking/${organizationId}/${p.provider}`),
      })),
      webhookUrls: Object.fromEntries(BOOKING_PROVIDERS.map((p) => [p, buildAppUrl(`/api/v1/webhooks/booking/${organizationId}/${p}`)])),
      payoutDetails: readPayoutDetails(org.payoutDetails),
      payout: { holdDays: settings.holdDays, feePercent: settings.feePercent, minPayout: settings.minPayout, balance },
      requests: requests.map((r) => ({ ...r, amount: Number(r.amount) })),
      ledger: ledger.map((l) => ({ ...l, amount: Number(l.amount) })),
    });
  } catch (error) {
    next(error);
  }
};

export const updatePaymentSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await orgIdOf(req, res);
    if (!organizationId) return;
    const data: { currency?: string; payoutDetails?: string | null } = {};
    if (req.body.currency !== undefined) {
      const c = String(req.body.currency).trim().toUpperCase();
      if (!CURRENCY.test(c)) return res.status(400).json({ error: 'Use a three-letter currency code, like USD or GHS' });
      const current = await prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
      if (current && current.currency !== c) {
        if (!(await isSupportedCurrency(c))) return res.status(400).json({ error: `${c} isn’t a supported currency` });
        // Changing currency with money still held in the old one would strand it.
        const block = await currencyChangeBlock(organizationId);
        if (block) return res.status(409).json({ error: block });
      }
      data.currency = c;
    }
    if (req.body.payoutDetails !== undefined) {
      const details = String(req.body.payoutDetails).trim();
      if (details.length > 1000) return res.status(400).json({ error: 'Keep payout details under 1000 characters' });
      data.payoutDetails = details ? savePayoutDetails(details) : null;
    }
    await prisma.organization.update({ where: { id: organizationId }, data });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

export const saveOwnProvider = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await orgIdOf(req, res);
    if (!organizationId) return;
    const provider = req.params.provider as BookingProviderName;
    if (!BOOKING_PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider' });
    const { publicKey, secretKey, webhookSecret, isActive } = req.body ?? {};

    const existing = await prisma.orgPaymentProvider.findUnique({ where: { organizationId_provider: { organizationId, provider } } });
    const secret = typeof secretKey === 'string' && secretKey.trim() ? secretKey.trim() : null;
    if (!existing && !secret) return res.status(400).json({ error: 'Enter your secret key' });
    if (provider === 'stripe' && secret && !/^(sk|rk)_/.test(secret)) return res.status(400).json({ error: 'That doesn’t look like a Stripe secret key (it starts with sk_ or rk_)' });
    if (provider === 'stripe' && !existing?.webhookSecret && !(typeof webhookSecret === 'string' && webhookSecret.trim())) {
      return res.status(400).json({ error: 'Enter the webhook signing secret (whsec_…) so payments can be confirmed' });
    }

    const data = {
      isActive: isActive === undefined ? true : !!isActive,
      publicKey: typeof publicKey === 'string' ? publicKey.trim() || null : existing?.publicKey ?? null,
      ...(secret ? { secretKey: encrypt(secret) } : {}),
      ...(typeof webhookSecret === 'string' && webhookSecret.trim() ? { webhookSecret: encrypt(webhookSecret.trim()) } : {}),
    };
    await prisma.orgPaymentProvider.upsert({
      where: { organizationId_provider: { organizationId, provider } },
      create: { organizationId, provider, ...data, secretKey: data.secretKey ?? encrypt(secret!) },
      update: data,
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

export const removeOwnProvider = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await orgIdOf(req, res);
    if (!organizationId) return;
    await prisma.orgPaymentProvider.deleteMany({ where: { organizationId, provider: req.params.provider } });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

export const requestOrgPayout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = await loadCaller(req);
    if (!caller?.organizationId) return res.status(403).json({ error: 'No organization' });
    const org = await prisma.organization.findUnique({ where: { id: caller.organizationId }, select: { currency: true } });
    const request = await requestPayout({
      organizationId: caller.organizationId,
      currency: org?.currency ?? 'USD',
      amount: req.body?.amount === undefined || req.body.amount === '' ? undefined : Number(req.body.amount),
      requestedBy: caller.id,
    });
    res.status(201).json({ id: request.id, amount: Number(request.amount), currency: request.currency, status: request.status });
  } catch (error) {
    fail(error, res, next);
  }
};
