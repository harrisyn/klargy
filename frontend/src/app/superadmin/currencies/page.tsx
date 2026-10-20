'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import api from '@/api/client';
import type { CurrencySettings } from '@/api/client';
import { Button, Card, Input, PageHeader } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';

/** The currencies organizations can use and what one unit of the base currency is worth in each. */
export default function CurrenciesPage() {
  const [data, setData] = useState<CurrencySettings | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [newCode, setNewCode] = useState('');
  const [newRate, setNewRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [auto, setAuto] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getCurrencySettings();
      setData(d);
      setAuto(d.autoRefresh);
      setRates(Object.fromEntries(Object.entries(d.rates).map(([c, r]) => [c, String(r)])));
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t load currencies.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner" /></div>;
  const base = data.base;
  const codes = Object.keys(rates).sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  const dirty = JSON.stringify(Object.fromEntries(Object.entries(rates).map(([c, r]) => [c, Number(r)]))) !== JSON.stringify(data.rates);

  const add = () => {
    const code = newCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return toast.error('Use a three-letter code, like GHS or NGN.');
    if (!(Number(newRate) > 0)) return toast.error('Enter what one ' + base + ' is worth in ' + code + '.');
    setRates({ ...rates, [code]: newRate });
    setNewCode('');
    setNewRate('');
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.refreshCurrencyRates();
      toast.success(`Updated ${r.updated.length} rate${r.updated.length === 1 ? '' : 's'} from the market.${r.unavailable.length ? ` No market rate for ${r.unavailable.join(', ')}; enter ${r.unavailable.length === 1 ? 'it' : 'them'} by hand.` : ''}`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t refresh the rates.'));
    } finally {
      setRefreshing(false);
    }
  };

  const toggleAuto = async (on: boolean) => {
    setAuto(on);
    try {
      await api.updateCurrencySettings(Object.fromEntries(Object.entries(data!.rates).filter(([c]) => c !== data!.base)), on);
      toast.success(on ? 'Rates will refresh every day.' : 'Automatic refresh is off.');
    } catch (err) {
      setAuto(!on);
      toast.error(errorMessage(err, 'Couldn’t change that.'));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateCurrencySettings(Object.fromEntries(codes.filter((c) => c !== base).map((c) => [c, Number(rates[c])])));
      toast.success('Currencies saved.');
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Currencies" subtitle={`Which currencies organizations can use, and what 1 ${base} is worth in each.`} />
      <div style={{ display: 'grid', gap: '1.25rem', maxWidth: 760 }}>
        {data.missingRates.length > 0 && (
          <Card style={{ padding: '1rem', background: 'var(--warning-50, #fff7e6)' }}>
            <strong>Add a rate for {data.missingRates.join(', ')}.</strong> Plans or organizations already use {data.missingRates.length === 1 ? 'it' : 'them'}, and prices can’t be converted to or from {data.missingRates.length === 1 ? 'it' : 'them'} until you do.
          </Card>
        )}
        <Card style={{ padding: '1.25rem' }}>
          <p style={{ color: 'var(--gray-600)', fontSize: '0.875rem', marginTop: 0 }}>
            Each organization picks one currency when it signs up. Its plan, wallet and booking payments are in that currency. A plan’s price in another currency is converted at these rates unless you set it by hand on the plan.
          </p>
          <table className="data-table" style={{ width: '100%' }}>
            <thead><tr><th>Currency</th><th>1 {base} =</th><th>Used by</th><th /></tr></thead>
            <tbody>
              {codes.map((c) => {
                const use = data.usage[c];
                const inUse = !!use && (use.organizations > 0 || use.plans > 0);
                return (
                  <tr key={c}>
                    <td><strong>{c}</strong>{c === base && ' (base)'}</td>
                    <td>
                      {c === base ? '1' : (
                        <Input aria-label={`Rate for ${c}`} type="number" min="0" step="any" value={rates[c]} onChange={(e) => setRates({ ...rates, [c]: e.target.value })} style={{ width: 160 }} />
                      )}
                    </td>
                    <td>{use ? `${use.organizations} organization${use.organizations === 1 ? '' : 's'}, ${use.plans} plan${use.plans === 1 ? '' : 's'}` : 'New'}</td>
                    <td>
                      {c !== base && (
                        <button
                          type="button"
                          aria-label={`Remove ${c}`}
                          title={inUse ? 'In use' : 'Remove'}
                          disabled={inUse}
                          onClick={() => { const { [c]: _gone, ...rest } = rates; setRates(rest); }}
                          style={{ border: 0, background: 'none', cursor: inUse ? 'not-allowed' : 'pointer', opacity: inUse ? 0.4 : 1 }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap', marginTop: '1.25rem' }}>
            <Input label="Add a currency" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase().slice(0, 3))} placeholder="GHS" style={{ width: 120 }} />
            <Input label={`1 ${base} =`} type="number" min="0" step="any" value={newRate} onChange={(e) => setNewRate(e.target.value)} placeholder="15.5" style={{ width: 160 }} />
            <Button variant="secondary" onClick={add}>Add</Button>
            <div style={{ flex: 1 }} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.875rem' }}>
              <input type="checkbox" checked={auto} disabled={dirty} onChange={(e) => toggleAuto(e.target.checked)} /> Refresh every day
            </label>
            <Button variant="secondary" onClick={refresh} disabled={refreshing || dirty} title={dirty ? 'Save your changes first' : undefined}>{refreshing ? 'Refreshing…' : 'Refresh from market rates'}</Button>
            <Button variant="primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
          <p className="field-hint" style={{ marginTop: '0.75rem' }}>
            Rates apply to new prices straight away. “Refresh from market rates” pulls today’s rates for the currencies above{data.refreshedAt ? ` (last refreshed ${new Date(data.refreshedAt).toLocaleString()})` : ''}; tick “Refresh every day” to have it done for you, or edit rates by hand. Bookings already paid and wallet balances are not re-converted.
          </p>
        </Card>
      </div>
    </>
  );
}
