'use client';

import { toast, errorMessage } from '@/lib/toast';
import React, { useEffect, useState } from 'react';
import { CheckCircle2, CreditCard, XCircle } from 'lucide-react';
import api from '@/api/client';
import Layout from '@/components/Layout';
import { Button, Card, Badge, PageHeader, Icon, UsageBar, Input, Select } from '@/components/ui';
import { confirmDialog } from '@/lib/dialog';
import { TenantWalletCard } from '@/components/billing/TenantWalletCard';

interface Plan {
  id: string;
  name: string;
  code: string;
  description: string | null;
  priceMonthly: string;
  priceQuarterly: string;
  priceYearly: string;
  currency: string;
  maxLocations: number | null;
  maxServicesPerLoc: number | null;
  maxUsersPerOrg: number | null;
  maxQueueEntriesPerDay: number | null;
  features: Record<string, boolean>;
  tierRank: number;
  isDefault: boolean;
  isRecommended: boolean;
}

interface UsageLimit {
  current: number;
  limit: number | null;
  allowed: boolean;
}

interface SubscriptionData {
  subscription: {
    planId: string;
    planName: string;
    planCode: string;
    status: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
  } | null;
  activeProviders: ('stripe' | 'paystack')[];
  upgradePlan: { id: string; name: string } | null;
  isExpiredNoFallback: boolean;
  limits?: {
    locations: UsageLimit;
    services: UsageLimit;
    users: UsageLimit;
    queueEntriesDaily: UsageLimit;
    queueEntriesPeriod: UsageLimit;
  };
  credits?: {
    AI: UsageLimit;
    EMAIL: UsageLimit;
    SMS: UsageLimit;
  };
}

const CREDIT_LABELS: Record<'AI' | 'EMAIL' | 'SMS', string> = {
  AI: 'AI credits',
  EMAIL: 'Email credits',
  SMS: 'SMS credits',
};

interface AddOnPricingRow {
  resourceType: AddOnKind;
  pricePerUnitMonthly: string;
  pricePerUnitOneOff: string;
  currency: string;
}

interface OrganizationAddOn {
  id: string;
  resourceType: AddOnKind;
  quantity: number;
  billingMode: 'RECURRING' | 'ONE_OFF';
  status: 'ACTIVE' | 'CANCELLED';
  currentPeriodEnd: string | null;
}

type AddOnKind = 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA';

const ADDON_LABELS: Record<AddOnKind, string> = {
  LOCATIONS: 'Extra locations',
  USERS: 'Extra staff',
  DISPLAY_MEDIA: 'Lobby media pack',
};
const ADDON_NOTES: Partial<Record<AddOnKind, string>> = {
  DISPLAY_MEDIA: 'Large videos (up to 500MB), YouTube, Vimeo and live streams on your lobby screens, and 25 more playlist items per pack.',
};

type BillingCycle = 'monthly' | 'quarterly' | 'yearly';

const CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, quarterly: 3, yearly: 12 };

// Only keys the server enforces are listed; anything else is not shown.
const FEATURE_LABELS: Record<string, string> = {
  analytics: 'Analytics',
  ai: 'AI-assisted analytics',
  multiLocation: 'More than one location',
  servicePoints: 'Desks and rooms',
  serviceFlows: 'Journeys between services',
  smsNotifications: 'Text message alerts',
  whatsappNotifications: 'WhatsApp messages',
  ownPaymentKeys: 'Your own payment account for bookings',
  customBranding: 'Own logo and colour',
  customDomain: 'Custom domain',
  apiAccess: 'API and integrations',
  emrIntegration: 'Connected systems (CRM, POS, EMR)',
  displayMedia: 'Adverts on lobby screens',
  // legacy keys from the old plan editor
  multipleLocations: 'More than one location',
  whiteLabel: 'Own logo and colour',
};

function priceForCycle(plan: Plan, cycle: BillingCycle): number {
  if (cycle === 'quarterly') return Number(plan.priceQuarterly);
  if (cycle === 'yearly') return Number(plan.priceYearly);
  return Number(plan.priceMonthly);
}

function savingsPercent(plan: Plan, cycle: BillingCycle): number | null {
  const monthly = Number(plan.priceMonthly);
  if (monthly === 0 || cycle === 'monthly') return null;
  const cyclePrice = priceForCycle(plan, cycle);
  const equivalentMonthlyTotal = monthly * CYCLE_MONTHS[cycle];
  if (equivalentMonthlyTotal === 0) return null;
  const pct = Math.round((1 - cyclePrice / equivalentMonthlyTotal) * 100);
  return pct > 0 ? pct : null;
}

export default function BillingPage() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [addOnPricing, setAddOnPricing] = useState<AddOnPricingRow[]>([]);
  const [myAddOns, setMyAddOns] = useState<OrganizationAddOn[]>([]);
  const [addOnForms, setAddOnForms] = useState<Record<AddOnKind, { quantity: number; billingMode: 'recurring' | 'one_off' }>>({
    LOCATIONS: { quantity: 1, billingMode: 'recurring' },
    USERS: { quantity: 1, billingMode: 'recurring' },
    DISPLAY_MEDIA: { quantity: 1, billingMode: 'one_off' },
  });
  const [addOnCheckoutPending, setAddOnCheckoutPending] = useState<AddOnKind | null>(null);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [subData, plansData, pricingData, addOnsData] = await Promise.all([
        api.getMySubscription(),
        api.getPlans(),
        api.getMyAddOnPricing(),
        api.getMyAddOns(),
      ]);
      setData(subData);
      setPlans(plansData);
      setAddOnPricing(pricingData);
      setMyAddOns(addOnsData);
    } catch (err) {
      console.error('Failed to load billing info', err);
    } finally {
      setLoading(false);
    }
  };

  const handlePurchaseAddOn = (resourceType: AddOnKind) => {
    setAddOnCheckoutPending(resourceType);
  };

  const handleAddOnCheckout = async (resourceType: AddOnKind, provider: 'stripe' | 'paystack') => {
    const form = addOnForms[resourceType];
    try {
      const { redirectUrl } = await api.createAddOnCheckout({
        resourceType,
        quantity: form.quantity,
        billingMode: form.billingMode,
        provider,
      });
      window.location.href = redirectUrl;
    } catch (err) {
      console.error('Add-on checkout failed', err);
      toast.error('Checkout didn’t start. Try again.');
    }
  };

  const handleCancelAddOn = async (id: string) => {
    if (!(await confirmDialog({ title: 'Cancel this add-on?', message: 'Its extra capacity is removed immediately.', confirmLabel: 'Cancel add-on', cancelLabel: 'Keep it', tone: 'danger' }))) return;
    try {
      await api.cancelAddOn(id);
      await load();
    } catch (err) {
      console.error('Failed to cancel add-on', err);
      toast.error('Couldn’t cancel the add-on. Try again.');
    }
  };

  const handleChoosePlan = async (planId: string) => {
    const plan = plans.find(p => p.id === planId);
    const isFree = plan && Number(plan.priceMonthly) === 0 && Number(plan.priceQuarterly) === 0 && Number(plan.priceYearly) === 0;
    if (isFree) {
      try {
        await api.switchToFreePlan(planId);
        await load();
      } catch (err) {
        console.error('Failed to switch plan', err);
        toast.error('Couldn’t switch plans. Try again.');
      }
      return;
    }
    setCheckoutPlanId(planId);
  };

  const handleCheckout = async (provider: 'stripe' | 'paystack') => {
    if (!checkoutPlanId) return;
    try {
      const { redirectUrl } = await api.createSubscriptionCheckout({
        planId: checkoutPlanId,
        provider,
        billingCycle,
      });
      window.location.href = redirectUrl;
    } catch (err) {
      console.error('Checkout failed', err);
      toast.error('Checkout didn’t start. Try again.');
    }
  };

  if (loading) {
    return (
      <Layout>
        <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading...</div>
      </Layout>
    );
  }

  const currentPlanCode = data?.subscription?.planCode;
  const currentPlanId = data?.subscription?.planId;
  const currentPlanTierRank = plans.find(p => p.code === currentPlanCode)?.tierRank ?? -1;
  const activeProviders = data?.activeProviders || [];

  return (
    <Layout>
      <div>
        <PageHeader
          icon={CreditCard}
          title="Billing"
          subtitle={
            data?.subscription
              ? `You’re on the ${data.subscription.planName} plan${data.subscription.status && data.subscription.status !== 'ACTIVE' ? ` (${data.subscription.status.toLowerCase().replace('_', ' ')})` : ''}.`
              : 'No active subscription'
          }
        />

        <TenantWalletCard plans={plans} onPlanChanged={load} />

        {data?.limits && (
          <Card style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--gray-900)' }}>Usage</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1.25rem' }}>
              <UsageBar label="Locations" current={data.limits.locations.current} limit={data.limits.locations.limit} />
              <UsageBar label="Staff" current={data.limits.users.current} limit={data.limits.users.limit} />
              <UsageBar label="Services" current={data.limits.services.current} limit={data.limits.services.limit} />
              <UsageBar label="Joins today" current={data.limits.queueEntriesDaily.current} limit={data.limits.queueEntriesDaily.limit} />
              <UsageBar label="Joins this billing period" current={data.limits.queueEntriesPeriod.current} limit={data.limits.queueEntriesPeriod.limit} />
              {data.credits && (['AI', 'EMAIL', 'SMS'] as const)
                .filter(type => data.credits![type].limit !== null)
                .map(type => (
                  <UsageBar key={type} label={CREDIT_LABELS[type]} current={data.credits![type].current} limit={data.credits![type].limit} />
                ))}
            </div>
          </Card>
        )}

        {addOnPricing.length > 0 && (
          <Card style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--gray-900)' }}>Add-Ons</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem', marginBottom: myAddOns.length > 0 ? '1.25rem' : 0 }}>
              {addOnPricing.map(pricing => {
                const form = addOnForms[pricing.resourceType] || { quantity: 1, billingMode: 'one_off' as const };
                const unitPrice = form.billingMode === 'recurring' ? Number(pricing.pricePerUnitMonthly) : Number(pricing.pricePerUnitOneOff);
                const total = unitPrice * form.quantity;
                return (
                  <div key={pricing.resourceType} style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius-lg)', padding: '1rem' }}>
                    <h4 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--gray-900)' }}>
                      {ADDON_LABELS[pricing.resourceType]}
                    </h4>
                    {ADDON_NOTES[pricing.resourceType] && (
                      <p style={{ fontSize: '0.8125rem', color: 'var(--gray-600)', margin: '-0.375rem 0 0.75rem', lineHeight: 1.5 }}>{ADDON_NOTES[pricing.resourceType]}</p>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <Input
                        label="Quantity"
                        type="number"
                        min="1"
                        value={form.quantity}
                        onChange={e => setAddOnForms(prev => ({ ...prev, [pricing.resourceType]: { ...form, quantity: Math.max(1, parseInt(e.target.value) || 1) } }))}
                      />
                      <Select
                        label="Pay"
                        value={form.billingMode}
                        onChange={e => setAddOnForms(prev => ({ ...prev, [pricing.resourceType]: { ...form, billingMode: e.target.value as 'recurring' | 'one_off' } }))}
                      >
                        <option value="recurring">Every month</option>
                        <option value="one_off">Once, keep forever</option>
                      </Select>
                    </div>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--gray-500)', marginBottom: '0.75rem' }}>
                      {pricing.currency} {total.toFixed(2)}{form.billingMode === 'recurring' ? '/mo' : ' one-time'}
                    </p>

                    {addOnCheckoutPending === pricing.resourceType ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {(data?.activeProviders || []).includes('stripe') && (
                          <Button variant="primary" size="sm" onClick={() => handleAddOnCheckout(pricing.resourceType, 'stripe')}>Pay with Stripe</Button>
                        )}
                        {(data?.activeProviders || []).includes('paystack') && (
                          <Button variant="primary" size="sm" onClick={() => handleAddOnCheckout(pricing.resourceType, 'paystack')}>Pay with Paystack</Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setAddOnCheckoutPending(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <Button variant="secondary" size="sm" disabled={(data?.activeProviders || []).length === 0} onClick={() => handlePurchaseAddOn(pricing.resourceType)}>
                        Purchase
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            {myAddOns.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {myAddOns.map(addOn => (
                  <div key={addOn.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.625rem 0.875rem', background: 'var(--gray-50)', borderRadius: 'var(--radius-md)' }}>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--gray-700)' }}>
                      {addOn.quantity}x {ADDON_LABELS[addOn.resourceType]} <Badge tone={addOn.billingMode === 'RECURRING' ? 'primary' : 'neutral'}>{addOn.billingMode === 'RECURRING' ? 'Recurring' : 'One-off'}</Badge>
                    </span>
                    {addOn.billingMode === 'RECURRING' && (
                      <Button variant="ghost" size="sm" onClick={() => handleCancelAddOn(addOn.id)} style={{ color: 'var(--error-600)' }}>
                        <Icon icon={XCircle} size={14} /> Cancel
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {data?.isExpiredNoFallback && (
          <Card style={{ padding: '1.25rem', marginBottom: '1.5rem', background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b' }}>
            Your trial has ended. Choose a plan below to restore full access — your existing data is safe and untouched.
          </Card>
        )}

        {activeProviders.length === 0 && (
          <Card style={{ padding: '1.25rem', marginBottom: '1.5rem', background: '#fffbeb', border: '1px solid #fcd34d' }}>
            No payment providers are configured yet. Please check back later.
          </Card>
        )}

        {data?.upgradePlan && data.upgradePlan.id !== currentPlanId && (() => {
          const upgradeTargetPlan = plans.find(p => p.id === data.upgradePlan!.id);
          const upgradeTargetIsFree = upgradeTargetPlan
            ? Number(upgradeTargetPlan.priceMonthly) === 0 && Number(upgradeTargetPlan.priceQuarterly) === 0 && Number(upgradeTargetPlan.priceYearly) === 0
            : true;
          const upgradeDisabled = !upgradeTargetIsFree && activeProviders.length === 0;
          return (
            <Card style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem', background: '#edf8f8', border: '1px solid #a5dfe1', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#0a676c', fontSize: '0.875rem' }}>
                Need more room to grow? <strong>Upgrade to {data.upgradePlan.name}</strong> for higher limits and more features.
              </span>
              <Button variant="primary" size="sm" disabled={upgradeDisabled} onClick={() => handleChoosePlan(data.upgradePlan!.id)}>Upgrade to {data.upgradePlan.name}</Button>
            </Card>
          );
        })()}

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
          {(['monthly', 'quarterly', 'yearly'] as BillingCycle[]).map(cycle => {
            const bestSavings = plans.length > 0
              ? Math.max(...plans.map(p => savingsPercent(p, cycle) ?? 0))
              : 0;
            return (
              <button
                key={cycle}
                onClick={() => setBillingCycle(cycle)}
                className="btn btn-sm"
                style={{ background: billingCycle === cycle ? '#0f9fa4' : '#f3f4f6', color: billingCycle === cycle ? 'white' : '#374151', display: 'flex', alignItems: 'center', gap: '0.375rem' }}
              >
                {cycle === 'monthly' ? 'Monthly' : cycle === 'quarterly' ? 'Quarterly' : 'Yearly'}
                {bestSavings > 0 && (
                  <span style={{ fontSize: '0.6875rem', fontWeight: 700, background: billingCycle === cycle ? 'rgba(255,255,255,0.25)' : '#dcfce7', color: billingCycle === cycle ? 'white' : '#16a34a', padding: '0.0625rem 0.375rem', borderRadius: '999px' }}>
                    Save {bestSavings}%
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          {plans.map(plan => {
            const price = priceForCycle(plan, billingCycle);
            const isFree = Number(plan.priceMonthly) === 0 && Number(plan.priceQuarterly) === 0 && Number(plan.priceYearly) === 0;
            const isCurrent = plan.code === currentPlanCode;
            const showRecommended = plan.isRecommended && currentPlanTierRank < plan.tierRank;
            const savings = savingsPercent(plan, billingCycle);
            const cycleSuffix = billingCycle === 'yearly' ? '/yr' : billingCycle === 'quarterly' ? '/qtr' : '/mo';

            const limitRows: { label: string; value: number | null }[] = [
              { label: 'Locations', value: plan.maxLocations },
              { label: 'Services each', value: plan.maxServicesPerLoc },
              { label: 'Staff', value: plan.maxUsersPerOrg },
              { label: 'Joins a day', value: plan.maxQueueEntriesPerDay },
            ];
            const featureBullets = Object.entries(plan.features)
              .filter(([, enabled]) => enabled)
              .filter(([key]) => FEATURE_LABELS[key]).map(([key]) => FEATURE_LABELS[key])
              .filter((label, i, all) => all.indexOf(label) === i)
              .slice(0, 4);

            return (
              <Card
                key={plan.id}
                style={{
                  padding: '1rem',
                  border: showRecommended ? '2px solid #0f9fa4' : undefined,
                  position: 'relative',
                }}
              >
                {showRecommended && (
                  <div style={{ position: 'absolute', top: '-0.625rem', left: '1rem' }}>
                    <Badge tone="primary">Recommended</Badge>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.25rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{plan.name}</h3>
                  {isCurrent && <Badge tone="primary">Current</Badge>}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.375rem', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '1.375rem', fontWeight: 700 }}>
                    {isFree ? 'Free' : `${plan.currency} ${price}`}
                  </span>
                  {!isFree && <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{cycleSuffix}</span>}
                  {savings && (
                    <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#16a34a', background: '#dcfce7', padding: '0.0625rem 0.375rem', borderRadius: '999px' }}>
                      Save {savings}%
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.375rem', marginBottom: '0.75rem', fontSize: '0.75rem' }}>
                  {limitRows.filter(r => r.value !== null).map(r => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280' }}>
                      <span>{r.label}</span>
                      <strong style={{ color: '#111827' }}>{r.value}</strong>
                    </div>
                  ))}
                </div>

                {featureBullets.length > 0 && (
                  <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1rem', fontSize: '0.75rem', color: '#4b5563' }}>
                    {featureBullets.map(f => <li key={f}>{f}</li>)}
                  </ul>
                )}

                {checkoutPlanId === plan.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {activeProviders.includes('stripe') && (
                      <Button variant="primary" size="sm" onClick={() => handleCheckout('stripe')}>Pay with Stripe</Button>
                    )}
                    {activeProviders.includes('paystack') && (
                      <Button variant="primary" size="sm" onClick={() => handleCheckout('paystack')}>Pay with Paystack</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setCheckoutPlanId(null)}>Cancel</Button>
                  </div>
                ) : (
                  <Button
                    variant={isCurrent ? 'secondary' : 'primary'}
                    size="sm"
                    disabled={isCurrent || (!isFree && activeProviders.length === 0)}
                    onClick={() => handleChoosePlan(plan.id)}
                  >
                    {isCurrent ? <><Icon icon={CheckCircle2} size={14} /> Current Plan</> : isFree ? 'Switch to Free' : 'Subscribe'}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </Layout>
  );
}
