'use client';

import React, { useEffect, useState } from 'react';
import { Copy, KeyRound, Link2, Stethoscope } from 'lucide-react';
import api, { EmrIntegration, EmrIntegrationDetail, EmrMappableType } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { Badge, Button, EmptyState, Input, Modal, Select } from '@/components/ui';
import { apiErrorMessage } from '@/components/auth/AuthShell';

// EMR connections (Klargy Connect, docs/connect/v1.md): an API key the EMR
// uses to register itself and publish its catalogue, and the screen where an
// admin matches Klargy records to the EMR's.

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null;

function ApiKeyNotice({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title="API key" maxWidth="560px" footer={<Button onClick={onClose}>I&apos;ve saved it</Button>}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          Paste this key into your EMR&apos;s queue management settings. Copy it now; it won&apos;t be shown again.
        </p>
        <div className="secret-box">
          <span style={{ flex: 1, wordBreak: 'break-all' }}>{apiKey}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigator.clipboard.writeText(apiKey).then(() => setCopied(true)).catch(() => {})}
          >
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
          Your EMR also needs this workspace&apos;s address: <code>{typeof window !== 'undefined' ? window.location.origin : ''}</code>
        </p>
      </div>
    </Modal>
  );
}

function CreateModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: EmrIntegration & { apiKey: string }) => void;
}) {
  const { user } = useAuthContext();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setName(''); setError(''); } }, [open]);
  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      onCreated(await api.createEmrIntegration(user!.organizationId!, name.trim()));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create this connection.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Connect an EMR"
      maxWidth="520px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="emr-form" disabled={saving || !name.trim()}>{saving ? 'Creating…' : 'Create API key'}</Button>
        </>
      }
    >
      <form id="emr-form" className="stack" onSubmit={submit}>
        {error && <div className="inline-alert inline-alert-error" role="alert">{error}</div>}
        <Input label="Name" placeholder="Serenity" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required hint="Which system this key is for" />
      </form>
    </Modal>
  );
}

type Row = { id: string; name: string; detail?: string; externalId: string | null };
type Option = { id: string; name: string; kind?: string | null };

// What the EMR says each of its services is (Klargy Connect catalogue `kind`).
const KIND_LABELS: Record<string, string> = {
  clinic: 'Clinic',
  lab: 'Laboratory',
  imaging: 'Imaging',
  pharmacy: 'Pharmacy',
  cashier: 'Cashier',
};
const KIND_ORDER = ['clinic', 'lab', 'imaging', 'pharmacy', 'cashier'];
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
const kindRank = (kind: string) => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);

/** Options grouped by kind (clinics first), or one plain list when the EMR
 * sends no kinds. */
function groupByKind(options: Option[]): { kind: string | null; options: Option[] }[] {
  if (!options.some((o) => o.kind)) return [{ kind: null, options }];
  const groups = new Map<string, Option[]>();
  for (const o of options) {
    const kind = o.kind || 'other';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push(o);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => kindRank(a) - kindRank(b) || a.localeCompare(b))
    .map(([kind, list]) => ({ kind, options: [...list].sort((x, y) => x.name.localeCompare(y.name)) }));
}

function MappingSection({ title, type, rows, options, onChange, busy }: {
  title: string;
  type: EmrMappableType;
  rows: Row[];
  options: Option[];
  onChange: (type: EmrMappableType, row: Row, externalId: string | null) => void;
  busy: string | null;
}) {
  if (rows.length === 0) return null;
  const takenBy = new Map(rows.filter((r) => r.externalId).map((r) => [r.externalId!, r.id]));
  const groups = groupByKind(options);
  const kindOf = new Map(options.filter((o) => o.kind).map((o) => [o.id, o.kind!]));
  const renderOption = (o: Option, r: Row) => (
    <option key={o.id} value={o.id} disabled={takenBy.has(o.id) && takenBy.get(o.id) !== r.id}>
      {o.name}
    </option>
  );
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <h3 style={{ margin: 0, fontSize: '0.9375rem' }}>{title}</h3>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>In Klargy</th><th>In your EMR</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="cell-strong">{r.name}</div>
                  {r.detail && <div className="muted">{r.detail}</div>}
                </td>
                <td style={{ minWidth: 240 }}>
                  <Select
                    aria-label={`Match for ${r.name}`}
                    value={r.externalId ?? ''}
                    disabled={busy === `${type}:${r.id}`}
                    onChange={(e) => onChange(type, r, e.target.value || null)}
                  >
                    <option value="">Not matched</option>
                    {groups.map((g) =>
                      g.kind ? (
                        <optgroup key={g.kind} label={kindLabel(g.kind)}>
                          {g.options.map((o) => renderOption(o, r))}
                        </optgroup>
                      ) : (
                        g.options.map((o) => renderOption(o, r))
                      )
                    )}
                  </Select>
                  {r.externalId && kindOf.has(r.externalId) && (
                    <div style={{ marginTop: '0.25rem' }}><Badge tone="neutral">{kindLabel(kindOf.get(r.externalId)!)}</Badge></div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MappingModal({ integrationId, onClose }: { integrationId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<EmrIntegrationDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!integrationId) return;
    setDetail(null);
    setError('');
    api.getEmrIntegration(integrationId).then(setDetail).catch((err) => setError(apiErrorMessage(err, 'Could not load this connection.')));
  }, [integrationId]);

  if (!integrationId) return null;

  const listKey: Record<EmrMappableType, keyof EmrIntegrationDetail['klargy']> = {
    location: 'locations', service: 'services', service_point: 'servicePoints', staff: 'staff',
  };

  const change = async (type: EmrMappableType, row: Row, externalId: string | null) => {
    setBusy(`${type}:${row.id}`);
    setError('');
    try {
      await api.setEmrMapping(integrationId, { resourceType: type, resourceId: row.id, externalId });
      setDetail((d) => d && {
        ...d,
        klargy: {
          ...d.klargy,
          [listKey[type]]: (d.klargy[listKey[type]] as Row[]).map((x) => (x.id === row.id ? { ...x, externalId } : x)),
        },
      });
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save that match.'));
    } finally {
      setBusy(null);
    }
  };

  const ext = detail?.externalCatalog;
  const locationName = (id: string) => detail?.klargy.locations.find((l) => l.id === id)?.name;

  return (
    <Modal open onClose={onClose} title={detail ? `Match records with ${detail.systemName || detail.name}` : 'Match records'} maxWidth="820px">
      {error && <div className="inline-alert inline-alert-error" role="alert" style={{ marginBottom: '1rem' }}>{error}</div>}
      {!detail ? (
        !error && <div className="spinner" />
      ) : !ext ? (
        <p className="muted">
          Your EMR hasn&apos;t published its locations, services and rooms yet. Save its queue management settings to publish them, then come back here.
        </p>
      ) : (
        <div className="stack" style={{ gap: '1.5rem' }}>
          <p className="muted" style={{ margin: 0 }}>
            Choose the record in your EMR that each Klargy record stands for. Changes save straight away.
            Staff without a match are matched by email, or added, when they first open the queue desk from the EMR.
          </p>
          <MappingSection title="Locations" type="location" rows={detail.klargy.locations} options={ext.locations} onChange={change} busy={busy} />
          <MappingSection
            title="Services"
            type="service"
            rows={detail.klargy.services.map((s) => ({ ...s, detail: locationName(s.locationId) }))}
            options={ext.services}
            onChange={change}
            busy={busy}
          />
          <MappingSection title="Service points" type="service_point" rows={detail.klargy.servicePoints} options={ext.servicePoints} onChange={change} busy={busy} />
          <MappingSection
            title="Staff"
            type="staff"
            rows={detail.klargy.staff.map((s) => ({ ...s, detail: s.email }))}
            options={ext.practitioners.map((p) => ({ id: p.id, name: p.email ? `${p.name} (${p.email})` : p.name }))}
            onChange={change}
            busy={busy}
          />
        </div>
      )}
    </Modal>
  );
}

export default function EmrConnectionsPanel() {
  const { user } = useAuthContext();
  const { hasFeature } = useSubscription();
  const allowed = hasFeature('emrIntegration');
  const [list, setList] = useState<EmrIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    if (!user?.organizationId) return;
    setLoading(true);
    try {
      setList(await api.getEmrIntegrations(user.organizationId));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load EMR connections.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [user?.organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError('');
    try { await action(); } catch (err) { setError(apiErrorMessage(err, 'That did not work.')); } finally { setBusyId(null); }
  };

  const rotate = (i: EmrIntegration) => run(i.id, async () => {
    if (!window.confirm(`Create a new API key for ${i.name}? The old key stops working immediately, so update your EMR straight after.`)) return;
    const r = await api.rotateEmrIntegrationKey(i.id);
    setApiKey(r.apiKey);
    await load();
  });

  const revoke = (i: EmrIntegration) => run(i.id, async () => {
    if (!window.confirm(`Disconnect ${i.name}? Its key stops working and it stops receiving events. Matches are kept.`)) return;
    await api.revokeEmrIntegration(i.id);
    await load();
  });

  const status = (i: EmrIntegration) => {
    if (i.status === 'REVOKED') return <Badge tone="error">Disconnected</Badge>;
    if (!i.registered) return <Badge tone="warning">Waiting for EMR</Badge>;
    return <Badge tone="success">Connected</Badge>;
  };

  return (
    <div className="panel" style={{ marginBottom: '1.5rem' }}>
      <div className="panel-header">
        <h2 className="panel-title">EMR connections</h2>
        {allowed && list.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}><Stethoscope size={14} /> Connect an EMR</Button>
        )}
      </div>
      {error && <div className="panel-body"><div className="inline-alert inline-alert-error" role="alert">{error}</div></div>}
      {loading ? (
        <div className="panel-body"><div className="spinner" /></div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title={allowed ? 'No EMR connected' : 'EMR connections aren’t on your plan'}
          description={allowed
            ? 'Create an API key for your EMR so queue events, rooms and staff stay in step between the two.'
            : 'Upgrade your plan to connect an EMR such as Serenity.'}
          action={allowed ? { label: 'Connect an EMR', onClick: () => setCreating(true) } : undefined}
        />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Connection</th><th>Status</th><th>Catalogue</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className="cell-strong">{i.name}</div>
                    <div className="muted mono">
                      {i.keyPrefix}…{i.systemName ? ` · ${i.systemName}${i.systemVersion ? ` ${i.systemVersion}` : ''}` : ''}
                    </div>
                  </td>
                  <td>{status(i)}</td>
                  <td>{when(i.catalogPublishedAt) ?? <span className="muted">Not published</span>}</td>
                  <td>{when(i.lastUsedAt) ?? <span className="muted">Never</span>}</td>
                  <td className="cell-actions">
                    <Button size="sm" variant="secondary" onClick={() => setMapping(i.id)}><Link2 size={14} /> Match</Button>
                    {allowed && (
                      <Button size="sm" variant="ghost" onClick={() => rotate(i)} disabled={busyId === i.id} aria-label="New API key">
                        <KeyRound size={14} />
                      </Button>
                    )}
                    {i.status === 'ACTIVE' && (
                      <Button size="sm" variant="ghost" onClick={() => revoke(i)} disabled={busyId === i.id}>Disconnect</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setApiKey(created.apiKey);
          load();
        }}
      />
      <MappingModal integrationId={mapping} onClose={() => { setMapping(null); load(); }} />
      {apiKey && <ApiKeyNotice apiKey={apiKey} onClose={() => setApiKey(null)} />}
    </div>
  );
}
