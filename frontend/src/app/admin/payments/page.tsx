'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/api/client';
import type { PaymentsOverview } from '@/api/client';
import Layout from '@/components/Layout';
import { Badge, Button, Card, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { money } from '@/components/billing/WalletLedger';
import { toast, errorMessage } from '@/lib/toast';
import { confirmDialog } from '@/lib/dialog';

const PROVIDERS = [
  { id: 'stripe' as const, name: 'Stripe', keyHint: 'sk_live_… or sk_test_…', needsWebhookSecret: true },
  { id: 'paystack' as const, name: 'Paystack', keyHint: 'sk_live_… or sk_test_…', needsWebhookSecret: false },
];

const STATUS_TONE = { REQUESTED: 'warning', PAID: 'success', REJECTED: 'error' } as const;
const STATUS_TEXT = { REQUESTED: 'In review', PAID: 'Paid', REJECTED: 'Rejected' } as const;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function OwnProviderForm({ provider, overview, onChange }: { provider: (typeof PROVIDERS)[number]; overview: PaymentsOverview; onChange: () => void }) {
  const existing = overview.ownProviders.find((p) => p.provider === provider.id);
  const [publicKey, setPublicKey] = useState(existing?.publicKey ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const url = existing?.webhookUrl ?? overview.webhookUrls[provider.id];

  const save = async () => {
    setSaving(true);
    try {
      await api.saveOwnPaymentProvider(provider.id, { publicKey, secretKey: secretKey || undefined, webhookSecret: webhookSecret || undefined, isActive: true });
      setSecretKey('');
      setWebhookSecret('');
      toast.success(`${provider.name} saved.`);
      onChange();
    } catch (err) {
      toast.error(errorMessage(err, `Couldn’t save ${provider.name}.`));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: `Remove ${provider.name}?`, message: 'Customers will be charged through the platform account instead, if one is available.', tone: 'danger' }))) return;
    try {
      await api.removeOwnPaymentProvider(provider.id);
      onChange();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t remove it.'));
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--gray-200)', paddingTop: '1rem', marginTop: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <strong>{provider.name}</strong>
        {existing ? <Badge tone={existing.isActive ? 'success' : 'neutral'}>{existing.isActive ? 'Connected' : 'Off'}</Badge> : <Badge tone="neutral">Not connected</Badge>}
      </div>
      <div style={{ display: 'grid', gap: '0.75rem', maxWidth: 560 }}>
        {provider.id === 'stripe' && <Input label="Publishable key" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="pk_live_…" />}
        <Input
          label="Secret key"
          type="password"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          placeholder={existing ? 'Saved. Enter a new one to replace it' : provider.keyHint}
          autoComplete="off"
        />
        {provider.needsWebhookSecret && (
          <Input
            label="Webhook signing secret"
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={existing?.hasWebhookSecret ? 'Saved. Enter a new one to replace it' : 'whsec_…'}
            autoComplete="off"
          />
        )}
        <div className="field-hint" style={{ lineHeight: 1.5 }}>
          In your {provider.name} dashboard, add a webhook to <code style={{ wordBreak: 'break-all' }}>{url}</code>
          {provider.id === 'stripe' ? ' for the events checkout.session.completed and checkout.session.expired.' : ' (it sends charge.success).'}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Button variant="primary" onClick={save} disabled={saving || (!existing && !secretKey)}>{saving ? 'Saving…' : existing ? 'Save changes' : `Connect ${provider.name}`}</Button>
          {existing && <Button variant="ghost" onClick={remove}>Remove</Button>}
        </div>
      </div>
    </div>
  );
}

export default function PaymentsPage() {
  const [overview, setOverview] = useState<PaymentsOverview | null>(null);
  const [error, setError] = useState('');
  const [currency, setCurrency] = useState('');
  const [details, setDetails] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const o = await api.getPaymentsOverview();
      setOverview(o);
      setCurrency(o.currency);
      setDetails(o.payoutDetails);
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t load your payments.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (body: { currency?: string; payoutDetails?: string }, ok: string) => {
    setBusy(true);
    try {
      await api.updatePaymentSettings(body);
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save.'));
    } finally {
      setBusy(false);
    }
  };

  const requestPayout = async () => {
    setBusy(true);
    try {
      await api.requestPayout(amount ? Number(amount) : undefined);
      setAmount('');
      toast.success('Payout requested. We’ll review it and send the money.');
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t request a payout.'));
    } finally {
      setBusy(false);
    }
  };

  const b = overview?.payout.balance;
  const collectedText = !overview
    ? ''
    : overview.collectedBy === 'ORG'
      ? `Customers pay your own ${overview.collectorProvider === 'paystack' ? 'Paystack' : 'Stripe'} account directly.`
      : overview.collectedBy === 'PLATFORM'
        ? 'We collect on your behalf and hold each payment for review before it can be paid out to you.'
        : 'Online payment isn’t available yet. Connect your own account below, or ask the platform to switch on payments.';

  return (
    <Layout>
      <PageHeader title="Payments" subtitle="Take payment when customers book, and see the money we hold for you." />
      {error && <p role="alert" style={{ color: 'var(--danger, #a3371f)' }}>{error}</p>}
      {!overview && !error && <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner" /></div>}

      {overview && b && (
        <div style={{ display: 'grid', gap: '1.25rem', maxWidth: 900 }}>
          <Card style={{ padding: '1.25rem' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '0.5rem' }}>How you get paid</h3>
            <p style={{ color: 'var(--gray-700)', marginBottom: '1rem' }}>
              <Badge tone={overview.collectedBy === 'NONE' ? 'warning' : 'success'}>{overview.collectedBy === 'ORG' ? 'Your account' : overview.collectedBy === 'PLATFORM' ? 'We collect for you' : 'Not set up'}</Badge>{' '}
              {collectedText}
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap' }}>
              <Select label="Your currency" value={currency} onChange={(e) => setCurrency(e.target.value)} hint="Used for your plan, wallet and booking prices" style={{ width: 200 }}>
                {[...new Set([overview.currency, ...overview.supportedCurrencies])].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Button variant="secondary" disabled={busy || currency === overview.currency} onClick={() => saveSettings({ currency }, 'Currency saved.')}>Save</Button>
            </div>
            <p className="field-hint" style={{ marginTop: '0.75rem' }}>
              Set prices and what customers pay up front on each service (Services → edit → Online booking and payment).
            </p>
          </Card>

          <Card style={{ padding: '1.25rem' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '0.25rem' }}>Your own payment account</h3>
            {overview.canUseOwnKeys ? (
              <>
                <p style={{ color: 'var(--gray-600)', fontSize: '0.875rem' }}>Connect Stripe or Paystack and customers pay you directly. Nothing is held, and there is no payout step.</p>
                {PROVIDERS.map((p) => <OwnProviderForm key={p.id} provider={p} overview={overview} onChange={load} />)}
              </>
            ) : (
              <p style={{ color: 'var(--gray-600)', fontSize: '0.875rem' }}>
                Using your own Stripe or Paystack account is part of the paid plans. <Link href="/admin/billing">See plans</Link>. Until then we collect for you, and you can request payouts below.
              </p>
            )}
          </Card>

          <Card style={{ padding: '1.25rem' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '0.25rem' }}>Payout wallet</h3>
            <p style={{ color: 'var(--gray-600)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              Payments we collect for you wait {overview.payout.holdDays} day{overview.payout.holdDays === 1 ? '' : 's'} for review, then you can request a payout.
              {overview.payout.feePercent > 0 ? ` We keep ${overview.payout.feePercent}% of each payment.` : ''}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {[
                ['Available now', b.available],
                ['Held for review', b.pending],
                ['Payout in review', b.inReview],
                ['Paid out', b.paidOut],
              ].map(([label, value]) => (
                <div key={label as string} style={{ padding: '0.75rem', borderRadius: 10, background: 'var(--gray-50)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-600)' }}>{label}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{money(value as number, b.currency)}</div>
                </div>
              ))}
            </div>

            <Textarea
              label="Where should we send your money?"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              placeholder="Bank name, account name and number, or mobile money number"
              hint="Only the platform team sees this."
            />
            <div style={{ marginTop: '0.5rem' }}>
              <Button variant="secondary" disabled={busy || details === overview.payoutDetails} onClick={() => saveSettings({ payoutDetails: details }, 'Payout details saved.')}>Save details</Button>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap', marginTop: '1.25rem' }}>
              <Input label="Amount to pay out" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(b.available)} hint={overview.payout.minPayout > 0 ? `At least ${money(overview.payout.minPayout, b.currency)}` : 'Leave empty for everything available'} style={{ width: 200 }} />
              <Button variant="primary" onClick={requestPayout} disabled={busy || b.available <= 0}>Request payout</Button>
            </div>

            {overview.requests.length > 0 && (
              <>
                <h4 style={{ fontSize: '0.875rem', fontWeight: 700, margin: '1.5rem 0 0.5rem' }}>Payout requests</h4>
                <table className="data-table" style={{ width: '100%' }}>
                  <thead><tr><th>Requested</th><th>Amount</th><th>Status</th><th>Note</th></tr></thead>
                  <tbody>
                    {overview.requests.map((r) => (
                      <tr key={r.id}>
                        <td>{day(r.requestedAt)}</td>
                        <td>{money(r.amount, r.currency)}</td>
                        <td><Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge></td>
                        <td>{r.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {overview.ledger.length > 0 && (
              <>
                <h4 style={{ fontSize: '0.875rem', fontWeight: 700, margin: '1.5rem 0 0.5rem' }}>Activity</h4>
                <table className="data-table" style={{ width: '100%' }}>
                  <thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Available</th></tr></thead>
                  <tbody>
                    {overview.ledger.map((l) => (
                      <tr key={l.id}>
                        <td>{day(l.createdAt)}</td>
                        <td>{l.reason}</td>
                        <td style={{ color: l.amount < 0 ? 'var(--danger, #a3371f)' : undefined }}>{money(l.amount, l.currency)}</td>
                        <td>{new Date(l.availableAt) > new Date() ? `from ${day(l.availableAt)}` : 'Now'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </div>
      )}
    </Layout>
  );
}
