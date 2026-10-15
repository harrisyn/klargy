'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { History, ScrollText } from 'lucide-react';
import api, { AuditLogEntry } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import { Button, EmptyState, PageHeader, Select } from '@/components/ui';
import { apiErrorMessage } from '@/components/auth/AuthShell';

const ACTION_LABELS: Record<string, string> = {
  'entry.joined': 'Joined queue',
  'entry.called': 'Called',
  'entry.served': 'Served',
  'entry.cancelled': 'Cancelled',
  'entry.no_show': 'No-show',
  'entry.transferred': 'Sent to next service',
  'entry.reordered': 'Queue reordered',
  'entry.priority_changed': 'Priority changed',
  'queue.status_changed': 'Queue status changed',
  'queue.paused': 'Queue paused',
  'queue.resumed': 'Queue reopened',
  'appointment.created': 'Appointment booked',
  'appointment.rescheduled': 'Appointment rescheduled',
  'appointment.cancelled': 'Appointment cancelled',
  'appointment.checked_in': 'Appointment checked in',
};

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'entry.', label: 'Queue entries' },
  { value: 'entry.transferred', label: 'Transfers' },
  { value: 'appointment.', label: 'Appointments' },
  { value: 'queue.', label: 'Queue status' },
];

function describe(log: AuditLogEntry): string {
  const d = log.data || {};
  if (log.action === 'queue.status_changed' && d.status) return `Set to ${String(d.status).toLowerCase()}`;
  if (log.action === 'appointment.rescheduled' && d.toSlotStart) {
    return `Moved to ${new Date(String(d.toSlotStart)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  if ((log.action === 'appointment.created' || log.action === 'appointment.cancelled') && d.slotStart) {
    return new Date(String(d.slotStart)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (log.action === 'entry.joined' && d.source === 'public') return 'Self-service (QR / kiosk)';
  return '';
}

export default function AuditLogPage() {
  const { user } = useAuthContext();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (before?: string) => {
    if (!user?.organizationId) return;
    setLoading(true);
    try {
      const res = await api.getAuditLogs(user.organizationId, { action: filter || undefined, before, limit: 50 });
      setLogs((current) => (before ? [...current, ...res.logs] : res.logs));
      setCursor(res.nextCursor);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the audit log.'));
    } finally {
      setLoading(false);
    }
  }, [user?.organizationId, filter]);

  useEffect(() => { load(); }, [load]);

  return (
    <Layout>
      <PageHeader
        icon={ScrollText}
        title="Audit log"
        subtitle="Every queue movement, transfer and appointment change, with who did it."
      />

      <div className="toolbar">
        <Select label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </Select>
      </div>

      {error && <div className="inline-alert inline-alert-error" role="alert" style={{ marginBottom: '1rem' }}>{error}</div>}

      <div className="panel">
        {!loading && logs.length === 0 ? (
          <EmptyState icon={History} title="Nothing recorded yet" description="Actions appear here as staff and the public use your queues." />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>When</th><th>What</th><th>Ticket</th><th>By</th><th>Details</th></tr></thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {new Date(log.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="cell-strong">{ACTION_LABELS[log.action] || log.action}</td>
                    <td>
                      {log.entry ? (
                        <><span className="mono">{log.entry.ticketNumber}</span> <span className="muted">· {log.entry.serviceName}</span></>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{log.actor ? `${log.actor.firstName} ${log.actor.lastName}` : <span className="muted">Public / system</span>}</td>
                    <td className="muted" style={{ minWidth: 200 }}>{describe(log)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loading && <div className="panel-body"><div className="spinner" /></div>}
        {!loading && cursor && (
          <div className="panel-body" style={{ textAlign: 'center' }}>
            <Button variant="secondary" onClick={() => load(cursor)}>Load older</Button>
          </div>
        )}
      </div>
    </Layout>
  );
}
