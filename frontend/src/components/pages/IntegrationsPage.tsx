'use client';

import React, { useEffect, useState } from 'react';
import { Copy, KeyRound, Plug, Send, Trash2, Webhook } from 'lucide-react';
import api, { WebhookDelivery, WebhookEndpoint } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import { Badge, Button, Checkbox, EmptyState, Input, Modal, PageHeader, Switch } from '@/components/ui';
import { apiErrorMessage } from '@/components/auth/AuthShell';
import EmrConnectionsPanel from './EmrConnectionsPanel';
import { confirmDialog } from '@/lib/dialog';

const EVENT_LABELS: Record<string, string> = {
  'entry.joined': 'Someone joined a queue',
  'entry.called': 'Ticket called',
  'entry.served': 'Service completed',
  'entry.cancelled': 'Ticket cancelled',
  'entry.no_show': 'No-show',
  'entry.transferred': 'Sent to next service',
  'entry.priority_changed': 'Priority changed',
  'queue.paused': 'Queue paused',
  'queue.resumed': 'Queue reopened',
  'appointment.created': 'Appointment booked',
  'appointment.rescheduled': 'Appointment rescheduled',
  'appointment.cancelled': 'Appointment cancelled',
  'appointment.checked_in': 'Appointment checked in',
  'journey.completed': 'Visit finished',
  'servicepoint.opened': 'Signed in to a room or desk',
  'servicepoint.closed': 'Left a room or desk',
};

const statusTone = (status?: string) => (status === 'SUCCEEDED' ? 'success' : status === 'FAILED' ? 'error' : 'warning');

function SecretNotice({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title="Signing secret" maxWidth="520px" footer={<Button onClick={onClose}>I&apos;ve saved it</Button>}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          Your receiver uses this secret to check each request really came from us. Copy it now; it won&apos;t be shown again.
        </p>
        <div className="secret-box">
          <span style={{ flex: 1 }}>{secret}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigator.clipboard.writeText(secret).then(() => setCopied(true)).catch(() => {})}
          >
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
          Each request carries <code>X-Webhook-Timestamp</code> and <code>X-Webhook-Signature: sha256=…</code>, the hex
          HMAC-SHA256 of <code>timestamp + &quot;.&quot; + body</code> keyed with this secret.
        </p>
      </div>
    </Modal>
  );
}

function EndpointModal({ endpoint, events, onClose, onSaved }: {
  endpoint: WebhookEndpoint | 'new' | null;
  events: string[];
  onClose: () => void;
  onSaved: (e: WebhookEndpoint, secret?: string) => void;
}) {
  const { user } = useAuthContext();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [allEvents, setAllEvents] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!endpoint) return;
    if (endpoint === 'new') {
      setUrl(''); setDescription(''); setSelected([]); setAllEvents(true);
    } else {
      setUrl(endpoint.url); setDescription(endpoint.description || '');
      setSelected(endpoint.events); setAllEvents(endpoint.events.length === 0);
    }
    setError('');
  }, [endpoint]);

  if (!endpoint) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allEvents && selected.length === 0) return setError('Pick at least one event, or send all events.');
    setSaving(true);
    setError('');
    const payload = { url, description, events: allEvents ? [] : selected };
    try {
      if (endpoint === 'new') {
        const created = await api.createWebhook(user!.organizationId!, payload);
        onSaved(created, created.secret);
      } else {
        onSaved(await api.updateWebhook(endpoint.id, payload));
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save this endpoint.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={endpoint === 'new' ? 'Add webhook endpoint' : 'Edit webhook endpoint'}
      maxWidth="600px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="webhook-form" disabled={saving}>{saving ? 'Saving…' : 'Save endpoint'}</Button>
        </>
      }
    >
      <form id="webhook-form" className="stack" onSubmit={submit}>
        {error && <div className="inline-alert inline-alert-error" role="alert">{error}</div>}
        <Input label="Endpoint URL" type="url" placeholder="https://emr.example.com/hooks/queue" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} hint="Optional, e.g. which system this feeds" />
        <Switch label="Send every event" checked={allEvents} onChange={(e) => setAllEvents(e.target.checked)} />
        {!allEvents && (
          <div className="checkbox-grid">
            {events.map((ev) => (
              <Checkbox
                key={ev}
                label={EVENT_LABELS[ev] || ev}
                checked={selected.includes(ev)}
                onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))}
              />
            ))}
          </div>
        )}
      </form>
    </Modal>
  );
}

function DeliveriesModal({ endpoint, onClose }: { endpoint: WebhookEndpoint | null; onClose: () => void }) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  useEffect(() => {
    if (!endpoint) return;
    setDeliveries(null);
    api.getWebhookDeliveries(endpoint.id).then(setDeliveries).catch(() => setDeliveries([]));
  }, [endpoint]);
  if (!endpoint) return null;

  return (
    <Modal open onClose={onClose} title="Recent deliveries" maxWidth="760px">
      {!deliveries ? (
        <div className="spinner" />
      ) : deliveries.length === 0 ? (
        <p className="muted">Nothing has been sent to this endpoint yet.</p>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>When</th><th>Event</th><th>Result</th><th>Attempts</th></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{new Date(d.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' })}</td>
                  <td className="mono">{d.event}</td>
                  <td>
                    <Badge tone={statusTone(d.status)}>{d.status === 'PENDING' ? 'Retrying' : d.status === 'SUCCEEDED' ? 'Delivered' : 'Failed'}</Badge>
                    {d.lastError && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>{d.lastError}</div>}
                  </td>
                  <td>{d.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export default function IntegrationsPage() {
  const { user } = useAuthContext();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
  const [viewing, setViewing] = useState<WebhookEndpoint | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    if (!user?.organizationId) return;
    setLoading(true);
    try {
      const [list, evs] = await Promise.all([api.getWebhooks(user.organizationId), api.getWebhookEvents()]);
      setEndpoints(list);
      setEvents(evs);
    } catch (err) {
      setNotice({ tone: 'error', text: apiErrorMessage(err, 'Could not load webhooks.') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [user?.organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try { await action(); } finally { setBusyId(null); }
  };

  const test = (e: WebhookEndpoint) => run(e.id, async () => {
    try {
      const r = await api.testWebhook(e.id);
      setNotice(r.status === 'SUCCEEDED'
        ? { tone: 'success', text: `Test delivered to ${e.url} (HTTP ${r.responseCode}).` }
        : { tone: 'error', text: `Test failed: ${r.error || 'no response'}. We'll retry it automatically.` });
      await load();
    } catch (err) {
      setNotice({ tone: 'error', text: apiErrorMessage(err, 'Test failed.') });
    }
  });

  const toggle = (e: WebhookEndpoint) => run(e.id, async () => {
    const updated = await api.updateWebhook(e.id, { isActive: !e.isActive });
    setEndpoints((list) => list.map((x) => (x.id === e.id ? { ...x, ...updated } : x)));
  });

  const rotate = async (e: WebhookEndpoint) => {
    if (!(await confirmDialog({ title: 'Create a new signing secret?', message: 'The old one stops working immediately.', confirmLabel: 'Create secret' }))) return;
    await run(e.id, async () => {
      const r = await api.rotateWebhookSecret(e.id);
      setSecret(r.secret);
    });
  };

  const remove = async (e: WebhookEndpoint) => {
    if (!(await confirmDialog({ title: 'Delete this endpoint?', message: `Deliveries to ${e.url} stop straight away.`, tone: 'danger' }))) return;
    await run(e.id, async () => {
      await api.deleteWebhook(e.id);
      setEndpoints((list) => list.filter((x) => x.id !== e.id));
    });
  };

  return (
    <Layout>
      <PageHeader
        icon={Plug}
        title="Integrations"
        subtitle="Send queue events to your EMR or other systems as they happen."
        actions={<Button variant="secondary" onClick={() => setEditing('new')}><Webhook size={18} /> Add endpoint</Button>}
      />

      {notice && (
        <div className={`inline-alert inline-alert-${notice.tone}`} role="status" style={{ marginBottom: '1rem' }}>
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <EmrConnectionsPanel />

      <div className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Webhook endpoints</h2>
          <span className="muted" style={{ fontSize: '0.8125rem' }}>Failed deliveries are retried for about 15 hours.</span>
        </div>
        {loading ? (
          <div className="panel-body"><div className="spinner" /></div>
        ) : endpoints.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No endpoints yet"
            description="Add an endpoint to get a signed POST whenever someone joins, is called, completes a service or moves to the next one."
            action={{ label: 'Add endpoint', onClick: () => setEditing('new') }}
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Endpoint</th><th>Events</th><th>Last delivery</th><th>Enabled</th><th /></tr></thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="cell-strong mono">{e.url}</div>
                      {e.description && <div className="muted">{e.description}</div>}
                    </td>
                    <td>{e.events.length === 0 ? 'All events' : `${e.events.length} selected`}</td>
                    <td>
                      {e.lastDelivery ? (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewing(e)}>
                          <Badge tone={statusTone(e.lastDelivery.status)}>
                            {e.lastDelivery.status === 'SUCCEEDED' ? 'Delivered' : e.lastDelivery.status === 'FAILED' ? 'Failed' : 'Retrying'}
                          </Badge>
                        </button>
                      ) : (
                        <span className="muted">Never</span>
                      )}
                    </td>
                    <td><Switch aria-label="Enabled" checked={e.isActive} disabled={busyId === e.id} onChange={() => toggle(e)} /></td>
                    <td className="cell-actions">
                      <Button size="sm" variant="secondary" onClick={() => test(e)} disabled={busyId === e.id}><Send size={14} /> Test</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => setViewing(e)}>Log</Button>
                      <Button size="sm" variant="ghost" onClick={() => rotate(e)} aria-label="Rotate secret"><KeyRound size={14} /></Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(e)} aria-label="Delete"><Trash2 size={14} /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <EndpointModal
        endpoint={editing}
        events={events}
        onClose={() => setEditing(null)}
        onSaved={(saved, newSecret) => {
          setEditing(null);
          if (newSecret) setSecret(newSecret);
          load();
        }}
      />
      <DeliveriesModal endpoint={viewing} onClose={() => setViewing(null)} />
      {secret && <SecretNotice secret={secret} onClose={() => setSecret(null)} />}
    </Layout>
  );
}
