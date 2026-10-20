'use client';

import React from 'react';
import { Input } from '@/components/ui';

export interface CurrencyConfigInfo {
  base: string;
  rates: Record<string, number>;
}

export type CurrencyPriceForm = Record<string, { monthly: string; quarterly: string; yearly: string }>;

interface Stored {
  currency: string;
  priceMonthly: string | number;
  priceQuarterly: string | number;
  priceYearly: string | number;
}

export const toCurrencyPriceForm = (rows?: Stored[]): CurrencyPriceForm =>
  Object.fromEntries((rows ?? []).map((r) => [r.currency, { monthly: String(r.priceMonthly), quarterly: String(r.priceQuarterly), yearly: String(r.priceYearly) }]));

/** Only rows with all three prices filled are hand-set; the rest are converted. */
export const currencyPricesPayload = (form: CurrencyPriceForm) =>
  Object.entries(form)
    .filter(([, v]) => v.monthly !== '' && v.quarterly !== '' && v.yearly !== '')
    .map(([currency, v]) => ({ currency, priceMonthly: Number(v.monthly), priceQuarterly: Number(v.quarterly), priceYearly: Number(v.yearly) }));

const convert = (amount: number, from: string, to: string, rates: Record<string, number>) => {
  if (!rates[from] || !rates[to]) return null;
  return Math.round(((amount * rates[to]) / rates[from]) * 100) / 100;
};

interface Props {
  config: CurrencyConfigInfo;
  planCurrency: string;
  prices: { monthly: number; quarterly: number; yearly: number };
  value: CurrencyPriceForm;
  onChange: (next: CurrencyPriceForm) => void;
}

/** A plan's price in each other supported currency: converted at the platform rate unless set by hand. */
export default function PlanCurrencyPrices({ config, planCurrency, prices, value, onChange }: Props) {
  const others = Object.keys(config.rates).filter((c) => c !== planCurrency).sort();
  if (others.length === 0) return null;

  const set = (cur: string, key: 'monthly' | 'quarterly' | 'yearly', v: string) =>
    onChange({ ...value, [cur]: { ...(value[cur] ?? { monthly: '', quarterly: '', yearly: '' }), [key]: v } });

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <h4 style={{ fontSize: '0.875rem', fontWeight: 700, margin: '0.5rem 0 0' }}>Prices in other currencies</h4>
      <p style={{ fontSize: '0.8125rem', color: 'var(--gray-600)', margin: 0 }}>
        Organizations pay in their own currency. Leave a currency blank and the {planCurrency} price is converted at today’s rate; fill in all three to set it yourself.
      </p>
      {others.map((cur) => {
        const row = value[cur] ?? { monthly: '', quarterly: '', yearly: '' };
        const auto = {
          monthly: convert(prices.monthly, planCurrency, cur, config.rates),
          quarterly: convert(prices.quarterly, planCurrency, cur, config.rates),
          yearly: convert(prices.yearly, planCurrency, cur, config.rates),
        };
        return (
          <div key={cur} style={{ display: 'grid', gridTemplateColumns: '60px repeat(3, 1fr)', gap: '0.5rem', alignItems: 'end' }}>
            <strong style={{ paddingBottom: '0.5rem' }}>{cur}</strong>
            {(['monthly', 'quarterly', 'yearly'] as const).map((k) => (
              <Input
                key={k}
                label={k[0].toUpperCase() + k.slice(1)}
                type="number"
                min="0"
                step="0.01"
                value={row[k]}
                onChange={(e) => set(cur, k, e.target.value)}
                placeholder={auto[k] === null ? 'No rate' : String(auto[k])}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
