'use client';

import React from 'react';
import type { WalletSummary } from '@/api/client';

export const money = (amount: number, currency: string) =>
  `${amount < 0 ? '-' : ''}${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const KIND_LABEL: Record<string, string> = { TOPUP: 'Credit', DEBIT: 'Debit', PLAN_CHARGE: 'Plan charge', PAYMENT: 'Card payment' };

export function WalletLedger({ entries }: { entries: WalletSummary['entries'] }) {
  if (entries.length === 0) {
    return <p style={{ fontSize: '0.8125rem', color: 'var(--gray-500)' }}>No wallet activity yet.</p>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--gray-500)' }}>
            <th style={{ padding: '0.375rem 0.5rem' }}>Date</th>
            <th style={{ padding: '0.375rem 0.5rem' }}>Type</th>
            <th style={{ padding: '0.375rem 0.5rem' }}>Details</th>
            <th style={{ padding: '0.375rem 0.5rem', textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} style={{ borderTop: '1px solid var(--gray-200)' }}>
              <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleDateString()}</td>
              <td style={{ padding: '0.5rem' }}>{KIND_LABEL[e.kind] ?? e.kind}</td>
              <td style={{ padding: '0.5rem' }}>{e.reason}</td>
              <td style={{ padding: '0.5rem', textAlign: 'right', fontWeight: 600, color: e.amount < 0 ? 'var(--gray-900)' : 'var(--success-600, #16a34a)' }}>
                {e.amount > 0 ? '+' : ''}{money(e.amount, e.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
