'use client';

import React, { useEffect, useState } from 'react';
import api from '@/api/client';
import { Button, Card, Select } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';

/** Superadmin: change an organization's currency, allowed once nothing is held in the old one. */
export function OrgCurrencyCard({ organizationId, current, onChanged }: { organizationId: string; current?: string; onChanged: () => void }) {
  const [options, setOptions] = useState<string[]>([]);
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setValue(current ?? ''); }, [current]);
  useEffect(() => {
    api.getCurrencySettings().then((c) => setOptions(Object.keys(c.rates))).catch(() => {});
  }, []);

  if (!current) return null;

  const save = async () => {
    setBusy(true);
    try {
      await api.setOrganizationCurrency(organizationId, value);
      toast.success(`Currency changed to ${value}.`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t change the currency.'));
      setValue(current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
      <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '0.25rem' }}>Currency</h3>
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8125rem', marginTop: 0 }}>
        Used for this organization’s plan, wallet, add-ons and booking payments. It can only be changed when the wallet and payout wallet are at zero, no payout is open and no card subscription is running.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap' }}>
        <Select label="Currency" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 160 }}>
          {[...new Set([current, ...options])].map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button variant="secondary" onClick={save} disabled={busy || value === current}>{busy ? 'Saving…' : 'Change'}</Button>
      </div>
    </Card>
  );
}
