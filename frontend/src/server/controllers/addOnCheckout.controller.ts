import { Request, Response, NextFunction } from 'express';
import { ADDON_RESOURCE_TYPES } from '../services/payments/types';
import prisma from '../lib/prisma';
import { getProvider, ProviderNotActiveError } from '../services/payments';
import { ProviderName, AddOnResourceType, AddOnBillingMode } from '../services/payments/types';
import { returnBaseUrl } from '../lib/cors';
import { convertAmount, getCurrencyConfig } from '../services/currency.service';

// Resolves the per-unit price for one add-on purchase: a plan-specific
// override takes precedence over the global default. See
// docs/superpowers/specs/2026-08-25-plan-builder-design.md.
export async function resolveAddOnUnitPrice(
  planId: string | null,
  resourceType: AddOnResourceType,
  billingMode: AddOnBillingMode,
  targetCurrency?: string | null
): Promise<{ unitPrice: number; currency: string } | null> {
  const base = await resolveBaseAddOnUnitPrice(planId, resourceType, billingMode);
  if (!base || !targetCurrency || targetCurrency === base.currency) return base;
  const converted = convertAmount(base.unitPrice, base.currency, targetCurrency, await getCurrencyConfig());
  return converted === null ? base : { unitPrice: converted, currency: targetCurrency };
}

async function resolveBaseAddOnUnitPrice(
  planId: string | null,
  resourceType: AddOnResourceType,
  billingMode: AddOnBillingMode
): Promise<{ unitPrice: number; currency: string } | null> {
  if (planId) {
    const override = await prisma.planAddOnPricingOverride.findUnique({
      where: { planId_resourceType: { planId, resourceType } },
    });
    if (override) {
      const globalForCurrency = await prisma.addOnPricing.findUnique({ where: { resourceType } });
      return {
        unitPrice: Number(billingMode === 'recurring' ? override.pricePerUnitMonthly : override.pricePerUnitOneOff),
        currency: globalForCurrency?.currency ?? 'USD',
      };
    }
  }

  const pricing = await prisma.addOnPricing.findUnique({ where: { resourceType } });
  if (!pricing) return null;
  return {
    unitPrice: Number(billingMode === 'recurring' ? pricing.pricePerUnitMonthly : pricing.pricePerUnitOneOff),
    currency: pricing.currency,
  };
}

export const createAddOnCheckout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { resourceType, quantity, billingMode, provider } = req.body as {
      resourceType: AddOnResourceType;
      quantity: number;
      billingMode: AddOnBillingMode;
      provider: ProviderName;
    };

    if (!ADDON_RESOURCE_TYPES.includes(resourceType)) {
      return res.status(400).json({ error: 'Unknown add-on' });
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
    if (billingMode !== 'recurring' && billingMode !== 'one_off') {
      return res.status(400).json({ error: 'billingMode must be recurring or one_off' });
    }
    if (!provider) {
      return res.status(400).json({ error: 'provider is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { organizationId: true },
    });
    if (!user?.organizationId) {
      return res.status(400).json({ error: 'User has no organization' });
    }

    const organization = await prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { currency: true, subscription: { select: { planId: true } } },
    });
    const planId = organization?.subscription?.planId ?? null;

    const pricing = await resolveAddOnUnitPrice(planId, resourceType, billingMode, organization?.currency);
    if (!pricing) {
      return res.status(500).json({ error: 'Add-on pricing is not configured' });
    }

    let paymentProvider;
    try {
      paymentProvider = await getProvider(provider);
    } catch (err) {
      if (err instanceof ProviderNotActiveError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const { unitPrice, currency } = pricing;
    const org = await prisma.organization.findUnique({ where: { id: user.organizationId }, select: { slug: true } });
    const frontendUrl = await returnBaseUrl(req.headers?.origin, org?.slug);

    let redirectUrl: string;
    try {
      const result = await paymentProvider.createAddOnCheckoutSession({
        organizationId: user.organizationId,
        resourceType,
        quantity,
        billingMode,
        unitPrice,
        currency,
        successUrl: `${frontendUrl}/admin/billing?addon=success`,
        cancelUrl: `${frontendUrl}/admin/billing?addon=cancelled`,
      });
      redirectUrl = result.redirectUrl;
    } catch (err) {
      // Don't leak raw provider errors (e.g. a revoked key) to the tenant.
      // Full detail is logged server-side for the operator to diagnose.
      console.error(`Add-on checkout session creation failed for provider "${provider}":`, err);
      return res.status(502).json({ error: 'Payment provider temporarily unavailable. Please try again shortly.' });
    }

    res.json({ redirectUrl });
  } catch (error) {
    next(error);
  }
};

export const listMyAddOns = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { organizationId: true },
    });
    if (!user?.organizationId) {
      return res.json([]);
    }

    const addOns = await prisma.organizationAddOn.findMany({
      where: { organizationId: user.organizationId, status: 'ACTIVE' },
      orderBy: { purchasedAt: 'desc' },
    });

    res.json(addOns);
  } catch (error) {
    next(error);
  }
};

export const cancelAddOn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { organizationId: true },
    });
    if (!user?.organizationId) {
      return res.status(400).json({ error: 'User has no organization' });
    }

    const addOn = await prisma.organizationAddOn.findUnique({ where: { id } });
    if (!addOn || addOn.organizationId !== user.organizationId) {
      return res.status(404).json({ error: 'Add-on not found' });
    }
    if (addOn.billingMode !== 'RECURRING') {
      return res.status(400).json({ error: 'One-off add-ons cannot be cancelled' });
    }
    if (addOn.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Add-on is already cancelled' });
    }

    if (addOn.provider && addOn.externalSubscriptionId) {
      const paymentProvider = await getProvider(addOn.provider as ProviderName);
      await paymentProvider.cancelSubscription(addOn.externalSubscriptionId);
    }

    const updated = await prisma.organizationAddOn.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
};
