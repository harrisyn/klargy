'use client';

import React, { useCallback, useEffect, useState } from 'react';
import api from '@/api/client';
import type { PayoutRequestRow } from '@/api/client';
import { Badge, Button, Card, Input, PageHeader, Select } from '@/components/ui';
import { money } from '@/components/billing/WalletLedger';
import { toast, errorMessage } from '@/lib/toast';
import { confirmDialog } from '@/lib/dialog';

const STATUS_TONE = { REQUESTED: 'warning', PAID: 'success', REJECTED: 'error' } as const;
const STATUS_TEXT = { REQUESTED: 'To review', PAID: 'Paid', REJECTED: 'Rejected' } as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Money collected on organizations' behalf: hold and fee settings, and the payout requests to review. */
export default function PayoutsPage() {
  const [settings, setSettings] = useState({ holdDays: '7', feePercent: '0', minPayout: '0' });
  const [saved, setSaved] = useState(true);
  const [rows, setRows] = useState<PayoutRequestRow[]>([]);
  const [filter, setFilter] = useState('REQUESTED');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.getPayoutSettings(), api.listPayoutRequests(filter || undefined)]);
      setSettings({ holdDays: String(s.holdDays), feePercent: String(s.feePercent), minPayout: String(s.minPayout) });
      setRows(r);
      setSaved(true);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t load payouts.'));
    }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async () => {
    try {
      await api.updatePayoutSettings({ holdDays: Number(settings.holdDays), feePercent: Number(settings.feePercent), minPayout: Number(settings.minPayout) });
      toast.success('Payout settings saved. They apply to new payments.');
      setSaved(true);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save.'));
    }
  };

  const decide = async (row: PayoutRequestRow, action: 'PAID' | 'REJECTED') => {
    const ok = await confirmDialog({
      title: action === 'PAID' ? `Mark ${money(row.amount, row.currency)} as paid?` : 'Reject this payout?',
      message:
        action === 'PAID'
          ? `Only do this after you have sent ${money(row.amount, row.currency)} to ${row.organization.name}. The note is shown to them (put the transfer reference there).`
          : 'The money goes back to their available balance. Add a note so they know why.',
      tone: action === 'REJECTED' ? 'danger' : undefined,
    });
    if (!ok) return;
    setBusy(row.id);
    try {
      await api.decidePayout(row.id, action, notes[row.id]);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save the decision.'));
    } finally {
      setBusy(null);
    }
  };

  const set = (k: keyof typeof settings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSettings({ ...settings, [k]: e.target.value });
    setSaved(false);
  };

  return (
    <>
      <PageHeader title="Payouts" subtitle="Money collected on organizations’ behalf, held for review, then paid out on request." />
      <div style={{ display: 'grid', gap: '1.25rem', maxWidth: 1000 }}>
        <Card style={{ padding: '1.25rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '0.25rem' }}>Hold and fee</h3>
          <p style={{ color: 'var(--gray-600)', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Applies to payments made through the platform’s payment account. Organizations that connect their own account on a paid plan are paid directly and never appear here.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
            <Input label="Hold before payout (days)" type="number" min="0" max="90" value={settings.holdDays} onChange={set('holdDays')} style={{ width: 190 }} />
            <Input label="Platform fee (%)" type="number" min="0" max="100" step="0.1" value={settings.feePercent} onChange={set('feePercent')} style={{ width: 150 }} />
            <Input label="Smallest payout" type="number" min="0" step="0.01" value={settings.minPayout} onChange={set('minPayout')} style={{ width: 150 }} />
            <Button variant="primary" onClick={saveSettings} disabled={saved}>Save</Button>
          </div>
        </Card>

        <Card style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '1rem', flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 700 }}>Payout requests</h3>
            <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter requests">
              <option value="REQUESTED">To review</option>
              <option value="PAID">Paid</option>
              <option value="REJECTED">Rejected</option>
              <option value="">All</option>
            </Select>
          </div>
          {rows.length === 0 && <p style={{ color: 'var(--gray-600)' }}>Nothing here.</p>}
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {rows.map((r) => (
              <div key={r.id} style={{ border: '1px solid var(--gray-200)', borderRadius: 12, padding: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <strong>{r.organization.name}</strong> <Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
                    <div style={{ fontSize: '0.8125rem', color: 'var(--gray-600)' }}>Requested {when(r.requestedAt)}{r.reviewedAt ? ` · decided ${when(r.reviewedAt)}` : ''}</div>
                  </div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{money(r.amount, r.currency)}</div>
                </div>
                <div style={{ margin: '0.75rem 0', padding: '0.625rem 0.75rem', background: 'var(--gray-50)', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: '0.875rem' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-600)' }}>Send to</div>
                  {r.details || 'No payout details saved.'}
                </div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--gray-600)' }}>
                  Their wallet now: {money(r.orgBalance.available, r.currency)} available · {money(r.orgBalance.pending, r.currency)} held · {money(r.orgBalance.paidOut, r.currency)} paid out so far
                </div>
                {r.status === 'REQUESTED' ? (
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
                    <Input label="Note to them" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} placeholder="Transfer reference, or why it was rejected" style={{ minWidth: 280 }} />
                    <Button variant="primary" disabled={busy === r.id} onClick={() => decide(r, 'PAID')}>Mark paid</Button>
                    <Button variant="ghost" disabled={busy === r.id} onClick={() => decide(r, 'REJECTED')}>Reject</Button>
                  </div>
                ) : (
                  r.note && <div style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>Note: {r.note}</div>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
