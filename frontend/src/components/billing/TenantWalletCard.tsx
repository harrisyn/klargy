'use client';

import React, { useEffect, useState } from 'react';
import api from '@/api/client';
import type { WalletSummary } from '@/api/client';
import { Card, Button, Select, Badge } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';
import { WalletLedger, money } from './WalletLedger';

interface PlanOption { id: string; name: string; priceMonthly: string; priceQuarterly: string; priceYearly: string; currency: string }

export function TenantWalletCard({ plans, onPlanChanged }: { plans: PlanOption[]; onPlanChanged: () => void }) {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [planId, setPlanId] = useState('');
  const [cycle, setCycle] = useState<'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [paying, setPaying] = useState(false);

  const load = () => api.getMyWallet().then(setWallet).catch((e) => console.error('Failed to load wallet', e));
  useEffect(() => { load(); }, []);

  if (!wallet) return null;
  // Nothing to show for an organization that has never had wallet activity or a bump
  if (wallet.entries.length === 0 && !wallet.walletManaged && !wallet.override) return null;

  const payable = plans.filter((p) => p.currency === wallet.currency && Number(p.priceMonthly) + Number(p.priceQuarterly) + Number(p.priceYearly) > 0);
  const chosen = payable.find((p) => p.id === planId);
  const price = chosen ? Number(cycle === 'yearly' ? chosen.priceYearly : cycle === 'quarterly' ? chosen.priceQuarterly : chosen.priceMonthly) : 0;

  const pay = async () => {
    if (!chosen) return;
    setPaying(true);
    try {
      const result = await api.payPlanFromWallet({ planId: chosen.id, billingCycle: cycle });
      setWallet(result);
      toast.success(`You’re on ${result.planName}. ${money(result.charged, result.currency)} taken from your wallet.`);
      onPlanChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t pay from your wallet.'));
    } finally {
      setPaying(false);
    }
  };

  return (
    <Card style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--gray-900)' }}>Wallet</h3>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--gray-900)' }}>{money(wallet.balance, wallet.currency)}</div>
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--gray-600)', textAlign: 'right' }}>
          {wallet.nextCharge && (
            <div>
              {wallet.nextCharge.amount > 0
                ? `Next charge ${money(wallet.nextCharge.amount, wallet.currency)} on ${new Date(wallet.nextCharge.date).toLocaleDateString()}`
                : `Plan review on ${new Date(wallet.nextCharge.date).toLocaleDateString()}`}
            </div>
          )}
          {wallet.walletManaged && <div style={{ marginTop: '0.25rem' }}>Your plan renews from your wallet automatically.</div>}
        </div>
      </div>

      {wallet.override && (
        <div style={{ marginBottom: '1rem' }}>
          <Badge tone="primary">
            {wallet.override.planName} included until {new Date(wallet.override.until).toLocaleDateString()}
            {wallet.override.endBehavior === 'KEEP_AT_CUSTOM_PRICE' && wallet.override.customPrice !== null
              ? `, then ${money(wallet.override.customPrice, wallet.currency)} per billing period`
              : ', then back to your previous plan'}
          </Badge>
        </div>
      )}

      {payable.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          <Select label="Pay for a plan from your wallet" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Choose a plan…</option>
            {payable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select label="Billing" value={cycle} onChange={(e) => setCycle(e.target.value as typeof cycle)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </Select>
          <Button variant="primary" onClick={pay} disabled={!chosen || paying || price > wallet.balance}>
            {paying ? 'Paying…' : chosen ? `Pay ${money(price, wallet.currency)}` : 'Pay'}
          </Button>
        </div>
      )}

      <WalletLedger entries={wallet.entries} />
    </Card>
  );
}
