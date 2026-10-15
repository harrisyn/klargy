'use client';

import React, { useEffect, useState } from 'react';
import { Plus, CreditCard, Pencil, Trash2, Check, X } from 'lucide-react';
import api from '@/api/client';
import { Icon, PageHeader, Card, Badge, Button, Modal, Checkbox, Switch, Input, Textarea, Select } from '@/components/ui';

interface SubscriptionPlan {
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
  features: Record<string, boolean | number>;
  displayOrder: number;
  tierRank: number;
  isActive: boolean;
  isDefault: boolean;
  isRecommended: boolean;
  trialDurationDays: number | null;
  expiredFallbackPlanId: string | null;
  upgradePlanId: string | null;
  creditAllowances?: { creditType: 'AI' | 'EMAIL' | 'SMS'; monthlyAllowance: number | null }[];
  addOnPricingOverrides?: { resourceType: 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA'; pricePerUnitMonthly: string; pricePerUnitOneOff: string }[];
  _count: {
    subscriptions: number;
  };
}

type CreditAllowances = { AI: number | null; EMAIL: number | null; SMS: number | null };

function creditAllowancesToForm(rows: SubscriptionPlan['creditAllowances']): CreditAllowances {
  const form: CreditAllowances = { AI: null, EMAIL: null, SMS: null };
  for (const row of rows || []) {
    form[row.creditType] = row.monthlyAllowance;
  }
  return form;
}

type AddOnOverrideField = { monthly: string; oneOff: string };
type AddOnOverrideForm = { LOCATIONS: AddOnOverrideField; USERS: AddOnOverrideField };

const EMPTY_ADDON_OVERRIDES: AddOnOverrideForm = {
  LOCATIONS: { monthly: '', oneOff: '' },
  USERS: { monthly: '', oneOff: '' },
};

function addOnOverridesToForm(rows: SubscriptionPlan['addOnPricingOverrides']): AddOnOverrideForm {
  const form: AddOnOverrideForm = { LOCATIONS: { monthly: '', oneOff: '' }, USERS: { monthly: '', oneOff: '' } };
  for (const row of rows || []) {
    if (row.resourceType === 'DISPLAY_MEDIA') continue; // priced globally under Add-on pricing
    form[row.resourceType] = { monthly: row.pricePerUnitMonthly, oneOff: row.pricePerUnitOneOff };
  }
  return form;
}

interface AddOnPricingRow {
  resourceType: 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA';
  pricePerUnitMonthly: string;
  pricePerUnitOneOff: string;
}

function formToAddOnOverridesPayload(form: AddOnOverrideForm) {
  const toValue = (field: AddOnOverrideField) =>
    field.monthly.trim() === '' && field.oneOff.trim() === ''
      ? null
      : { pricePerUnitMonthly: parseFloat(field.monthly) || 0, pricePerUnitOneOff: parseFloat(field.oneOff) || 0 };

  return {
    LOCATIONS: toValue(form.LOCATIONS),
    USERS: toValue(form.USERS),
  };
}

const defaultFeatures = [
  // Keys must match what the server enforces (subscription.middleware.ts).
  { key: 'analytics', label: 'Analytics' },
  { key: 'ai', label: 'AI-assisted analytics' },
  { key: 'multiLocation', label: 'More than one location' },
  { key: 'servicePoints', label: 'Desks and rooms' },
  { key: 'serviceFlows', label: 'Journeys between services' },
  { key: 'smsNotifications', label: 'Text message alerts' },
  { key: 'whatsappNotifications', label: 'WhatsApp messages' },
  { key: 'customBranding', label: 'Own logo and colour' },
  { key: 'customDomain', label: 'Custom domain' },
  { key: 'apiAccess', label: 'API and integrations' },
  { key: 'emrIntegration', label: 'EMR connection' },
  { key: 'displayMedia', label: 'Adverts on lobby screens' },
];

export default function PlansPage() {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [globalAddOnPricing, setGlobalAddOnPricing] = useState<AddOnPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: '',
    code: '',
    description: '',
    priceMonthly: 0,
    priceQuarterly: 0,
    priceYearly: 0,
    currency: 'USD',
    maxLocations: null as number | null,
    maxServicesPerLoc: null as number | null,
    maxUsersPerOrg: null as number | null,
    maxQueueEntriesPerDay: null as number | null,
    features: {} as Record<string, boolean | number>,
    displayOrder: 0,
    tierRank: 0,
    isActive: true,
    isDefault: false,
    isRecommended: false,
    trialDurationDays: null as number | null,
    expiredFallbackPlanId: null as string | null,
    upgradePlanId: null as string | null,
    creditAllowances: { AI: null, EMAIL: null, SMS: null } as CreditAllowances,
    addOnPricingOverrides: EMPTY_ADDON_OVERRIDES as AddOnOverrideForm,
  });

  useEffect(() => {
    loadPlans();
    loadGlobalAddOnPricing();
  }, []);

  const loadGlobalAddOnPricing = async () => {
    try {
      const result = await api.getAddOnPricing();
      setGlobalAddOnPricing(result);
    } catch (err) {
      console.error('Failed to load global add-on pricing', err);
    }
  };

  const loadPlans = async () => {
    try {
      setLoading(true);
      const result = await api.getSubscriptionPlans(true);
      setPlans(result);
    } catch (err) {
      console.error('Failed to load plans', err);
      setError('Failed to load subscription plans');
    } finally {
      setLoading(false);
    }
  };

  const openCreateModal = () => {
    setEditingPlan(null);
    setForm({
      name: '',
      code: '',
      description: '',
      priceMonthly: 0,
      priceQuarterly: 0,
      priceYearly: 0,
      currency: 'USD',
      maxLocations: null,
      maxServicesPerLoc: null,
      maxUsersPerOrg: null,
      maxQueueEntriesPerDay: null,
      features: {},
      displayOrder: plans.length,
      tierRank: plans.length,
      isActive: true,
      isDefault: false,
      isRecommended: false,
      trialDurationDays: null,
      expiredFallbackPlanId: null,
      upgradePlanId: null,
      creditAllowances: { AI: null, EMAIL: null, SMS: null },
      addOnPricingOverrides: EMPTY_ADDON_OVERRIDES,
    });
    setShowModal(true);
  };

  const openEditModal = (plan: SubscriptionPlan) => {
    setEditingPlan(plan);
    setForm({
      name: plan.name,
      code: plan.code,
      description: plan.description || '',
      priceMonthly: parseFloat(plan.priceMonthly),
      priceQuarterly: parseFloat(plan.priceQuarterly),
      priceYearly: parseFloat(plan.priceYearly),
      currency: plan.currency,
      maxLocations: plan.maxLocations,
      maxServicesPerLoc: plan.maxServicesPerLoc,
      maxUsersPerOrg: plan.maxUsersPerOrg,
      maxQueueEntriesPerDay: plan.maxQueueEntriesPerDay,
      features: plan.features || {},
      displayOrder: plan.displayOrder,
      tierRank: plan.tierRank,
      isActive: plan.isActive,
      isDefault: plan.isDefault,
      isRecommended: plan.isRecommended,
      trialDurationDays: plan.trialDurationDays,
      expiredFallbackPlanId: plan.expiredFallbackPlanId,
      upgradePlanId: plan.upgradePlanId,
      creditAllowances: creditAllowancesToForm(plan.creditAllowances),
      addOnPricingOverrides: addOnOverridesToForm(plan.addOnPricingOverrides),
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.code) {
      setError('Name and code are required');
      return;
    }

    setSaving(true);
    try {
      if (editingPlan) {
        await api.updateSubscriptionPlan(editingPlan.id, {
          name: form.name,
          description: form.description || undefined,
          priceMonthly: form.priceMonthly,
          priceYearly: form.priceYearly,
          currency: form.currency,
          maxLocations: form.maxLocations,
          maxServicesPerLoc: form.maxServicesPerLoc,
          maxUsersPerOrg: form.maxUsersPerOrg,
          maxQueueEntriesPerDay: form.maxQueueEntriesPerDay,
          features: form.features,
          displayOrder: form.displayOrder,
          isActive: form.isActive,
          isDefault: form.isDefault,
          priceQuarterly: form.priceQuarterly,
          tierRank: form.tierRank,
          isRecommended: form.isRecommended,
          trialDurationDays: form.trialDurationDays,
          expiredFallbackPlanId: form.expiredFallbackPlanId,
          upgradePlanId: form.upgradePlanId,
          creditAllowances: form.creditAllowances,
          addOnPricingOverrides: formToAddOnOverridesPayload(form.addOnPricingOverrides),
        });
      } else {
        await api.createSubscriptionPlan({
          name: form.name,
          code: form.code.toLowerCase().replace(/\s+/g, '-'),
          description: form.description || undefined,
          priceMonthly: form.priceMonthly,
          priceYearly: form.priceYearly,
          currency: form.currency,
          maxLocations: form.maxLocations,
          maxServicesPerLoc: form.maxServicesPerLoc,
          maxUsersPerOrg: form.maxUsersPerOrg,
          maxQueueEntriesPerDay: form.maxQueueEntriesPerDay,
          features: form.features,
          displayOrder: form.displayOrder,
          isDefault: form.isDefault,
          priceQuarterly: form.priceQuarterly,
          tierRank: form.tierRank,
          isRecommended: form.isRecommended,
          trialDurationDays: form.trialDurationDays,
          expiredFallbackPlanId: form.expiredFallbackPlanId,
          upgradePlanId: form.upgradePlanId,
          creditAllowances: form.creditAllowances,
          addOnPricingOverrides: formToAddOnOverridesPayload(form.addOnPricingOverrides),
        });
      }
      setShowModal(false);
      loadPlans();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save plan');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (plan: SubscriptionPlan) => {
    if (!confirm(`Delete "${plan.name}"? This cannot be undone.`)) return;

    try {
      await api.deleteSubscriptionPlan(plan.id);
      loadPlans();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete plan');
    }
  };

  const toggleFeature = (key: string) => {
    setForm(prev => ({
      ...prev,
      features: {
        ...prev.features,
        [key]: !prev.features[key],
      },
    }));
  };

  const formatLimit = (value: number | null) => {
    return value === null ? '∞' : value.toString();
  };

  return (
    <div style={{ maxWidth: '1400px' }}>
      <PageHeader
        title="Plans"
        subtitle="What each plan costs and includes."
        icon={CreditCard}
        actions={
          <Button variant="primary" onClick={openCreateModal}>
            <Icon icon={Plus} size={16} /> Create Plan
          </Button>
        }
      />

      {error && (
        <div style={errorBanner}>
          <span>{error}</span>
          <button onClick={() => setError('')} style={dismissBtn} aria-label="Dismiss">
            <Icon icon={X} size={16} />
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto 1rem' }} />
          <p style={{ color: 'var(--gray-500)' }}>Loading plans...</p>
        </div>
      ) : (
        <div style={plansGrid}>
          {plans.map(plan => (
            <Card key={plan.id} style={{ opacity: plan.isActive ? 1 : 0.65, overflow: 'hidden' }}>
              <div style={planHeader}>
                <div style={planTitleRow}>
                  <h3 style={planName}>{plan.name}</h3>
                  {plan.isDefault && <Badge tone="success">Default</Badge>}
                  {plan.isRecommended && <Badge tone="primary">Recommended</Badge>}
                  {!plan.isActive && <Badge tone="neutral">Inactive</Badge>}
                </div>
                <span style={planCode}>{plan.code}</span>
              </div>

              <div style={priceSection}>
                <div style={priceRow}>
                  <span style={priceLabel}>Monthly</span>
                  <span style={priceValue}>${plan.priceMonthly}</span>
                </div>
                <div style={priceRow}>
                  <span style={priceLabel}>Quarterly</span>
                  <span style={priceValue}>${plan.priceQuarterly}</span>
                </div>
                <div style={priceRow}>
                  <span style={priceLabel}>Yearly</span>
                  <span style={priceValue}>${plan.priceYearly}</span>
                </div>
              </div>

              <div style={sectionPad}>
                <h4 style={sectionTitle}>Limits</h4>
                <div style={limitsGrid}>
                  <div style={limitItem}>
                    <span style={limitValue}>{formatLimit(plan.maxLocations)}</span>
                    <span style={limitLabel}>Locations</span>
                  </div>
                  <div style={limitItem}>
                    <span style={limitValue}>{formatLimit(plan.maxServicesPerLoc)}</span>
                    <span style={limitLabel}>Services/Loc</span>
                  </div>
                  <div style={limitItem}>
                    <span style={limitValue}>{formatLimit(plan.maxUsersPerOrg)}</span>
                    <span style={limitLabel}>Users</span>
                  </div>
                  <div style={limitItem}>
                    <span style={limitValue}>{formatLimit(plan.maxQueueEntriesPerDay)}</span>
                    <span style={limitLabel}>Entries/Day</span>
                  </div>
                </div>
              </div>

              <div style={{ ...sectionPad, borderTop: '1px solid var(--gray-100)' }}>
                <h4 style={sectionTitle}>Features</h4>
                <div style={featuresList}>
                  {defaultFeatures.map(f => (
                    <span
                      key={f.key}
                      style={plan.features?.[f.key] ? featureEnabled : featureDisabled}
                    >
                      <Icon icon={plan.features?.[f.key] ? Check : X} size={11} strokeWidth={3} /> {f.label}
                    </span>
                  ))}
                </div>
              </div>

              <div style={planFooter}>
                <span style={subCount}>{plan._count.subscriptions} orgs</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Button variant="secondary" size="sm" onClick={() => openEditModal(plan)}>
                    <Icon icon={Pencil} size={14} /> Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDelete(plan)}
                    disabled={plan._count.subscriptions > 0}
                    title={plan._count.subscriptions > 0 ? 'Cannot delete plan with active subscriptions' : 'Delete plan'}
                    style={{ color: 'var(--error-600)' }}
                  >
                    <Icon icon={Trash2} size={14} /> Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}

          {plans.length === 0 && (
            <div style={emptyState}>
              <p style={{ marginBottom: '1rem' }}>No subscription plans created yet.</p>
              <Button variant="primary" onClick={openCreateModal}>Create your first plan</Button>
            </div>
          )}
        </div>
      )}

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editingPlan ? 'Edit Plan' : 'Create Plan'}
        maxWidth="680px"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : (editingPlan ? 'Save Changes' : 'Create Plan')}
            </Button>
          </>
        }
      >
        <div style={formStack}>
          <div style={formRow}>
            <Input label="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Professional" />
            <Input label="Code *" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. pro" disabled={!!editingPlan} />
          </div>

          <Textarea
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            style={{ minHeight: '80px' }}
            placeholder="Brief description of this plan"
          />

          <div style={formRow}>
            <Input
              label="Monthly Price ($)"
              type="number"
              value={form.priceMonthly}
              onChange={(e) => setForm({ ...form, priceMonthly: parseFloat(e.target.value) || 0 })}
              min="0"
              step="0.01"
            />
            <Input
              label="Quarterly Price ($)"
              type="number"
              value={form.priceQuarterly}
              onChange={(e) => setForm({ ...form, priceQuarterly: parseFloat(e.target.value) || 0 })}
              min="0"
              step="0.01"
            />
          </div>
          <div style={formRow}>
            <Input
              label="Yearly Price ($)"
              type="number"
              value={form.priceYearly}
              onChange={(e) => setForm({ ...form, priceYearly: parseFloat(e.target.value) || 0 })}
              min="0"
              step="0.01"
            />
            <Input
              label="Trial Duration (days, blank = no limit)"
              type="number"
              value={form.trialDurationDays ?? ''}
              onChange={(e) => setForm({ ...form, trialDurationDays: e.target.value ? parseInt(e.target.value) : null })}
              min="1"
              placeholder="No time limit"
            />
          </div>

          <h4 style={{ ...sectionTitle, marginTop: '0.5rem' }}>Limits (leave empty for unlimited)</h4>
          <div style={formRow}>
            <Input
              label="Max Locations"
              type="number"
              value={form.maxLocations ?? ''}
              onChange={(e) => setForm({ ...form, maxLocations: e.target.value ? parseInt(e.target.value) : null })}
              min="1"
              placeholder="Unlimited"
            />
            <Input
              label="Max Services/Location"
              type="number"
              value={form.maxServicesPerLoc ?? ''}
              onChange={(e) => setForm({ ...form, maxServicesPerLoc: e.target.value ? parseInt(e.target.value) : null })}
              min="1"
              placeholder="Unlimited"
            />
          </div>
          <div style={formRow}>
            <Input
              label="Max Users"
              type="number"
              value={form.maxUsersPerOrg ?? ''}
              onChange={(e) => setForm({ ...form, maxUsersPerOrg: e.target.value ? parseInt(e.target.value) : null })}
              min="1"
              placeholder="Unlimited"
            />
            <Input
              label="Max Queue Entries/Day"
              type="number"
              value={form.maxQueueEntriesPerDay ?? ''}
              onChange={(e) => setForm({ ...form, maxQueueEntriesPerDay: e.target.value ? parseInt(e.target.value) : null })}
              min="1"
              placeholder="Unlimited"
            />
          </div>

          <h4 style={{ ...sectionTitle, marginTop: '0.5rem' }}>Credit Allowances / Month (leave empty for unlimited)</h4>
          <div style={formRow}>
            <Input
              label="AI Credits"
              type="number"
              value={form.creditAllowances.AI ?? ''}
              onChange={(e) => setForm({ ...form, creditAllowances: { ...form.creditAllowances, AI: e.target.value ? parseInt(e.target.value) : null } })}
              min="0"
              placeholder="Unlimited"
            />
            <Input
              label="Email Credits"
              type="number"
              value={form.creditAllowances.EMAIL ?? ''}
              onChange={(e) => setForm({ ...form, creditAllowances: { ...form.creditAllowances, EMAIL: e.target.value ? parseInt(e.target.value) : null } })}
              min="0"
              placeholder="Unlimited"
            />
          </div>
          <div style={formRow}>
            <Input
              label="SMS Credits"
              type="number"
              value={form.creditAllowances.SMS ?? ''}
              onChange={(e) => setForm({ ...form, creditAllowances: { ...form.creditAllowances, SMS: e.target.value ? parseInt(e.target.value) : null } })}
              min="0"
              placeholder="Unlimited"
            />
          </div>

          <h4 style={{ ...sectionTitle, marginTop: '0.5rem' }}>Add-On Price Overrides (blank = use global default)</h4>
          <div style={formRow}>
            <Input
              label="Extra Location - Monthly"
              type="number"
              value={form.addOnPricingOverrides.LOCATIONS.monthly}
              onChange={(e) => setForm({ ...form, addOnPricingOverrides: { ...form.addOnPricingOverrides, LOCATIONS: { ...form.addOnPricingOverrides.LOCATIONS, monthly: e.target.value } } })}
              min="0"
              step="0.01"
              placeholder={`Default: ${globalAddOnPricing.find(p => p.resourceType === 'LOCATIONS')?.pricePerUnitMonthly ?? '0'}`}
            />
            <Input
              label="Extra Location - One-off"
              type="number"
              value={form.addOnPricingOverrides.LOCATIONS.oneOff}
              onChange={(e) => setForm({ ...form, addOnPricingOverrides: { ...form.addOnPricingOverrides, LOCATIONS: { ...form.addOnPricingOverrides.LOCATIONS, oneOff: e.target.value } } })}
              min="0"
              step="0.01"
              placeholder={`Default: ${globalAddOnPricing.find(p => p.resourceType === 'LOCATIONS')?.pricePerUnitOneOff ?? '0'}`}
            />
          </div>
          <div style={formRow}>
            <Input
              label="Extra User - Monthly"
              type="number"
              value={form.addOnPricingOverrides.USERS.monthly}
              onChange={(e) => setForm({ ...form, addOnPricingOverrides: { ...form.addOnPricingOverrides, USERS: { ...form.addOnPricingOverrides.USERS, monthly: e.target.value } } })}
              min="0"
              step="0.01"
              placeholder={`Default: ${globalAddOnPricing.find(p => p.resourceType === 'USERS')?.pricePerUnitMonthly ?? '0'}`}
            />
            <Input
              label="Extra User - One-off"
              type="number"
              value={form.addOnPricingOverrides.USERS.oneOff}
              onChange={(e) => setForm({ ...form, addOnPricingOverrides: { ...form.addOnPricingOverrides, USERS: { ...form.addOnPricingOverrides.USERS, oneOff: e.target.value } } })}
              min="0"
              step="0.01"
              placeholder={`Default: ${globalAddOnPricing.find(p => p.resourceType === 'USERS')?.pricePerUnitOneOff ?? '0'}`}
            />
          </div>

          {(() => {
            const locationPrice = form.addOnPricingOverrides.LOCATIONS.monthly.trim() !== ''
              ? parseFloat(form.addOnPricingOverrides.LOCATIONS.monthly) || 0
              : parseFloat(globalAddOnPricing.find(p => p.resourceType === 'LOCATIONS')?.pricePerUnitMonthly ?? '0') || 0;
            const userPrice = form.addOnPricingOverrides.USERS.monthly.trim() !== ''
              ? parseFloat(form.addOnPricingOverrides.USERS.monthly) || 0
              : parseFloat(globalAddOnPricing.find(p => p.resourceType === 'USERS')?.pricePerUnitMonthly ?? '0') || 0;
            const illustrativeTotal = form.priceMonthly + locationPrice + userPrice;
            return (
              <p style={{ ...sectionTitle, textTransform: 'none' as const, letterSpacing: 'normal', color: 'var(--gray-500)', marginTop: '0.25rem' }}>
                Illustrative price with 1 extra location + 1 extra user: {form.currency} {illustrativeTotal.toFixed(2)}/mo
              </p>
            );
          })()}

          <h4 style={{ ...sectionTitle, marginTop: '0.5rem' }}>Features</h4>
          <div style={featuresGrid}>
            {defaultFeatures.map(f => (
              <Checkbox
                key={f.key}
                label={f.label}
                checked={!!form.features[f.key]}
                onChange={() => toggleFeature(f.key)}
              />
            ))}
          </div>
          <div style={formRow}>
            <Input
              label={form.features.displayMedia ? 'Lobby playlist items included' : 'Lobby playlist items (not included)'}
              type="number"
              min="0"
              disabled={!form.features.displayMedia}
              placeholder="5"
              value={typeof form.features.displayMediaItems === 'number' ? String(form.features.displayMediaItems) : ''}
              onChange={(e) => setForm({ ...form, features: { ...form.features, displayMediaItems: e.target.value === '' ? (undefined as unknown as number) : Math.max(0, parseInt(e.target.value) || 0) } })}
            />
            <Input
              label="Free adverts trial (days) when not included"
              type="number"
              min="0"
              disabled={!!form.features.displayMedia}
              placeholder="14"
              value={typeof form.features.displayMediaTrialDays === 'number' ? String(form.features.displayMediaTrialDays) : ''}
              onChange={(e) => setForm({ ...form, features: { ...form.features, displayMediaTrialDays: e.target.value === '' ? (undefined as unknown as number) : Math.max(0, parseInt(e.target.value) || 0) } })}
            />
          </div>

          <div style={formRow}>
            <Select
              label="Falls back to (when this plan's trial expires)"
              value={form.expiredFallbackPlanId ?? ''}
              onChange={(e) => setForm({ ...form, expiredFallbackPlanId: e.target.value || null })}
            >
              <option value="">Lock down (no fallback)</option>
              {plans.filter(p => p.id !== editingPlan?.id).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
            <Select
              label="Upgrade target"
              value={form.upgradePlanId ?? ''}
              onChange={(e) => setForm({ ...form, upgradePlanId: e.target.value || null })}
            >
              <option value="">No upgrade suggested</option>
              {plans.filter(p => p.id !== editingPlan?.id).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
          <div style={formRow}>
            <Input
              label="Display Order"
              type="number"
              value={form.displayOrder}
              onChange={(e) => setForm({ ...form, displayOrder: parseInt(e.target.value) || 0 })}
              min="0"
            />
            <Input
              label="Tier Rank (for upgrade/recommended comparisons)"
              type="number"
              value={form.tierRank}
              onChange={(e) => setForm({ ...form, tierRank: parseInt(e.target.value) || 0 })}
              min="0"
            />
          </div>

          <div style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap', paddingTop: '0.25rem' }}>
            <Switch label="Active" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            <Switch label="Default for new orgs" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
            <Switch label="Recommended" checked={form.isRecommended} onChange={(e) => setForm({ ...form, isRecommended: e.target.checked })} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Styles
const errorBanner: React.CSSProperties = {
  background: 'var(--error-50)',
  border: '1px solid var(--error-100)',
  borderRadius: 'var(--radius-lg)',
  padding: '1rem',
  marginBottom: '1.5rem',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  color: 'var(--error-600)',
};

const dismissBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--error-600)',
  cursor: 'pointer',
  display: 'inline-flex',
};

const plansGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: '1.5rem',
};

const planHeader: React.CSSProperties = {
  padding: '1.25rem 1.5rem',
  borderBottom: '1px solid var(--gray-100)',
};

const planTitleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.25rem',
  flexWrap: 'wrap' as const,
};

const planName: React.CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 700,
  color: 'var(--gray-900)',
};

const planCode: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
  fontFamily: 'var(--font-mono)',
};

const priceSection: React.CSSProperties = {
  padding: '1rem 1.5rem',
  background: 'var(--gray-50)',
};

const priceRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginBottom: '0.5rem',
};

const priceLabel: React.CSSProperties = {
  color: 'var(--gray-500)',
  fontSize: '0.875rem',
};

const priceValue: React.CSSProperties = {
  color: 'var(--gray-900)',
  fontWeight: 600,
};

const sectionPad: React.CSSProperties = {
  padding: '1rem 1.5rem',
};

const sectionTitle: React.CSSProperties = {
  color: 'var(--gray-500)',
  fontSize: '0.75rem',
  fontWeight: 700,
  letterSpacing: '0.05em',
  marginBottom: '0.75rem',
};

const limitsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '0.75rem',
};

const limitItem: React.CSSProperties = {
  textAlign: 'center' as const,
  padding: '0.5rem',
  background: 'var(--gray-50)',
  borderRadius: 'var(--radius-md)',
};

const limitValue: React.CSSProperties = {
  display: 'block',
  color: 'var(--primary-600)',
  fontSize: '1.25rem',
  fontWeight: 700,
};

const limitLabel: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
};

const featuresList: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: '0.5rem',
};

const featureEnabled: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.25rem 0.5rem',
  background: 'var(--success-100)',
  color: 'var(--success-700)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.75rem',
  fontWeight: 500,
};

const featureDisabled: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.25rem 0.5rem',
  background: 'var(--gray-100)',
  color: 'var(--gray-400)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.75rem',
};

const planFooter: React.CSSProperties = {
  padding: '1rem 1.5rem',
  borderTop: '1px solid var(--gray-100)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const subCount: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.875rem',
};

const emptyState: React.CSSProperties = {
  gridColumn: '1 / -1',
  padding: '3rem',
  textAlign: 'center' as const,
  color: 'var(--gray-500)',
  background: 'white',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-md)',
};

const formStack: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.1rem',
};

const formRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '1rem',
};

const featuresGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '0.75rem 1rem',
};
