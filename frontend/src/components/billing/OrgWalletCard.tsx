'use client';

import React, { useEffect, useState } from 'react';
import api from '@/api/client';
import type { WalletSummary } from '@/api/client';
import { Card, Button, Input, Select, Badge } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';
import { confirmDialog } from '@/lib/dialog';
import { WalletLedger, money } from './WalletLedger';

interface PlanRow { id: string; name: string; currency: string }

const row: React.CSSProperties = { display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap' };
const heading: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 700, color: 'var(--gray-900)', margin: '1.25rem 0 0.5rem' };

// Superadmin: credit/debit the organization's wallet and give it a plan for
// free until a date (reverting afterwards, or staying on at a custom price).
export function OrgWalletCard({ organizationId, onChanged }: { organizationId: string; onChanged: () => void }) {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [adjust, setAdjust] = useState({ amount: '', reason: '' });
  const [bump, setBump] = useState({ planId: '', until: '', endBehavior: 'REVERT' as 'REVERT' | 'KEEP_AT_CUSTOM_PRICE', customPrice: '', billingCycle: 'monthly' });

  const load = () => api.getOrganizationWallet(organizationId).then(setWallet).catch((e) => console.error('Failed to load wallet', e));
  useEffect(() => {
    load();
    api.getSubscriptionPlans().then((r: any) => setPlans(Array.isArray(r) ? r : r.plans ?? [])).catch(() => {});
  }, [organizationId]);

  const submitAdjust = async () => {
    const amount = Number(adjust.amount);
    if (!amount || !adjust.reason.trim()) return toast.error('Enter an amount and a reason.');
    setBusy(true);
    try {
      const result = await api.adjustOrganizationWallet(organizationId, { amount, reason: adjust.reason.trim() });
      setWallet(result);
      setAdjust({ amount: '', reason: '' });
      toast.success(result.subscriptionUpdated ? 'Wallet credited and the plan was renewed from it.' : 'Wallet updated.');
      if (result.subscriptionUpdated) onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t update the wallet.'));
    } finally {
      setBusy(false);
    }
  };

  const submitBump = async () => {
    if (!bump.planId || !bump.until) return toast.error('Choose a plan and an end date.');
    const keep = bump.endBehavior === 'KEEP_AT_CUSTOM_PRICE';
    if (keep && bump.customPrice === '') return toast.error('Enter the custom price.');
    setBusy(true);
    try {
      setWallet(await api.bumpOrganizationPlan(organizationId, {
        planId: bump.planId,
        until: new Date(`${bump.until}T23:59:59`).toISOString(),
        endBehavior: bump.endBehavior,
        customPrice: keep ? Number(bump.customPrice) : null,
        billingCycle: bump.billingCycle,
      }));
      toast.success('Plan updated at no cost.');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t change the plan.'));
    } finally {
      setBusy(false);
    }
  };

  const endBump = async () => {
    if (!(await confirmDialog({ title: 'End the free plan now?', message: 'Its end behaviour applies immediately.', confirmLabel: 'End now' }))) return;
    setBusy(true);
    try {
      setWallet(await api.endOrganizationPlanBump(organizationId));
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t end the free plan.'));
    } finally {
      setBusy(false);
    }
  };

  if (!wallet) return null;

  return (
    <Card style={{ padding: '1.5rem', marginBottom: '2rem' }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--gray-900)', marginBottom: '0.25rem' }}>Wallet &amp; plan bump</h3>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{money(wallet.balance, wallet.currency)}</div>
      <p style={{ fontSize: '0.8125rem', color: 'var(--gray-600)', marginTop: '0.25rem' }}>
        A credit renews or re-enrols the organization&apos;s plan from the wallet whenever it&apos;s due.
      </p>

      <h4 style={heading}>Credit or debit</h4>
      <div style={row}>
        <Input label={`Amount in ${wallet.currency} (negative to debit)`} type="number" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} placeholder="e.g. 100" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input label="Reason" value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} placeholder="e.g. Bank transfer received" />
        </div>
        <Button variant="primary" onClick={submitAdjust} disabled={busy}>Apply</Button>
      </div>

      <h4 style={heading}>Give a plan at no cost</h4>
      {wallet.override && (
        <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone="primary">
            {wallet.override.planName} free until {new Date(wallet.override.until).toLocaleDateString()} ·{' '}
            {wallet.override.endBehavior === 'KEEP_AT_CUSTOM_PRICE' ? `then ${money(wallet.override.customPrice ?? 0, wallet.currency)}` : 'then reverts'}
          </Badge>
          <Button variant="secondary" size="sm" onClick={endBump} disabled={busy}>End now</Button>
        </div>
      )}
      <div style={row}>
        <Select label="Plan" value={bump.planId} onChange={(e) => setBump({ ...bump, planId: e.target.value })}>
          <option value="">Choose a plan…</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input label="Free until" type="date" value={bump.until} onChange={(e) => setBump({ ...bump, until: e.target.value })} />
        <Select label="Afterwards" value={bump.endBehavior} onChange={(e) => setBump({ ...bump, endBehavior: e.target.value as typeof bump.endBehavior })}>
          <option value="REVERT">Return to original plan</option>
          <option value="KEEP_AT_CUSTOM_PRICE">Stay on this plan at a custom price</option>
        </Select>
        {bump.endBehavior === 'KEEP_AT_CUSTOM_PRICE' && (
          <>
            <Input label={`Custom price (${wallet.currency})`} type="number" value={bump.customPrice} onChange={(e) => setBump({ ...bump, customPrice: e.target.value })} />
            <Select label="Per" value={bump.billingCycle} onChange={(e) => setBump({ ...bump, billingCycle: e.target.value })}>
              <option value="monthly">Month</option>
              <option value="quarterly">Quarter</option>
              <option value="yearly">Year</option>
            </Select>
          </>
        )}
        <Button variant="primary" onClick={submitBump} disabled={busy}>Apply</Button>
      </div>

      <h4 style={heading}>Ledger</h4>
      <WalletLedger entries={wallet.entries} />
    </Card>
  );
}
