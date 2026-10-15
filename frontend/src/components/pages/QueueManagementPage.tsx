'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Bell, GripVertical, LogOut, PictureInPicture2, RefreshCw, Repeat, Code2 } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import { Badge, Button, Modal, PageHeader } from '@/components/ui';
import WaitAlerts from '@/components/ai/WaitAlerts';
import DeskPanel, { useDeskShortcuts } from '@/components/desk/DeskPanel';
import DeskPicker from '@/components/desk/DeskPicker';
import { useDesk, minutesAgo, personName, type DeskEntry } from '@/components/desk/useDesk';
import { usePopOut } from '@/components/desk/usePopOut';

/**
 * The staff desk: sign in to a desk, call the next person, finish or send
 * them on. Pops out into an always-on-top window for people who work in
 * another app all day.
 */

type IdentityConfig = Record<string, { required: boolean; label: string; type?: string }>;

type Source = { id: string; name: string; type: string };

function DetailsModal({ entry, locationId, onClose }: { entry: DeskEntry; locationId?: string; onClose: () => void }) {
  const { user } = useAuthContext();
  const [values, setValues] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<IdentityConfig>({});
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [person, org] = await Promise.all([
          entry.user?.id ? api.getUser(entry.user.id) : Promise.resolve({}),
          user?.organizationId ? api.getOrganization(user.organizationId) : Promise.resolve({}),
        ]);
        setValues((person as { identityData?: Record<string, string> }).identityData || {});
        setConfig(((org as { identityFieldsConfig?: IdentityConfig }).identityFieldsConfig) || {});
        if (user?.organizationId) {
          api.getDataSources(user.organizationId)
            // The connected EMR (Klargy Connect) first: it knows them best.
            .then((list: (Source & { isActive: boolean })[]) =>
              setSources(list.filter((s) => s.isActive).sort((a, b) => Number(b.type === 'INTEGRATION') - Number(a.type === 'INTEGRATION'))))
            .catch(() => setSources([]));
        }
      } catch {
        setProblem('Couldn’t load their details.');
      } finally {
        setLoading(false);
      }
    })();
  }, [entry.user?.id, user?.organizationId]);

  const fields = Object.entries(config).filter(([key]) => !['firstName', 'lastName', 'name', 'fullName', 'phone', 'email'].includes(key));

  const lookUp = async (source: Source) => {
    // A connected EMR can find them by its own id even without a phone number.
    const connected = source.type === 'INTEGRATION';
    if (!entry.user?.phone && !connected) return setProblem('They didn’t give a phone number, so there’s nothing to look up.');
    setFetching(source.id);
    setProblem('');
    try {
      const result = await api.fetchFromDataSource(source.id, {
        identifier: entry.user?.phone || undefined,
        identifierType: 'phone',
        ...(connected ? { userId: entry.user?.id, locationId } : {}),
      });
      if (result.mapped) setValues((v) => ({ ...v, ...result.mapped }));
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setProblem(e?.response?.data?.error || 'The lookup didn’t return anything.');
    } finally {
      setFetching(null);
    }
  };

  const save = async () => {
    if (!entry.user?.id) return;
    setSaving(true);
    try {
      await api.updateUserIdentity(entry.user.id, values);
      onClose();
    } catch {
      setProblem('Couldn’t save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${entry.ticketNumber} · ${personName(entry)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save details'}</Button></>}
    >
      {loading ? <div className="spinner" /> : (
        <div className="desk-details">
          <dl>
            <dt>Phone</dt><dd>{entry.user?.phone || '—'}</dd>
            <dt>Joined</dt><dd>{new Date(entry.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd>
          </dl>
          {sources.length > 0 && (
            <div className="desk-details-lookup">
              {sources.map((s) => (
                <Button key={s.id} variant="secondary" size="sm" onClick={() => lookUp(s)} disabled={!!fetching}>
                  <RefreshCw size={14} /> {fetching === s.id ? 'Looking up…' : `Look up in ${s.name}`}
                </Button>
              ))}
            </div>
          )}
          {fields.length === 0 ? (
            <p className="muted">No extra details are collected. Add fields under Settings.</p>
          ) : (
            <div className="settings-grid">
              {fields.map(([key, f]) => (
                <label key={key} className="settings-field">
                  <span>{f.label}</span>
                  <input type={f.type === 'date' ? 'date' : 'text'} value={values[key] || ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
                </label>
              ))}
            </div>
          )}
          {problem && <div className="inline-alert inline-alert-error" role="alert">{problem}</div>}
        </div>
      )}
    </Modal>
  );
}

export default function QueueManagementPage() {
  const desk = useDesk();
  const { pipWindow, open: popOut, supported: pipSupported } = usePopOut();
  const [details, setDetails] = useState<DeskEntry | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [notifyState, setNotifyState] = useState<NotificationPermission | 'unsupported'>('default');
  const [showEmbed, setShowEmbed] = useState(false);

  useDeskShortcuts(desk, null);
  useDeskShortcuts(desk, pipWindow?.document);

  useEffect(() => {
    setNotifyState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  // Waiting count in the tab title, so it's visible from other tabs.
  useEffect(() => {
    if (!desk.desk) return;
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = desk.waiting.length ? `(${desk.waiting.length}) ${base}` : base;
    return () => { document.title = document.title.replace(/^\(\d+\)\s*/, ''); };
  }, [desk.waiting.length, desk.desk]);

  const { terms } = desk;
  const waiting = desk.waiting;
  const embedSnippet = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `<script src="${origin}/embed/desk.js" async></script>`;
  }, []);

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = waiting.map((e) => e.id);
    const from = ids.indexOf(dragId);
    ids.splice(from, 1);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setDragId(null);
    desk.reorder(ids);
  };

  if (!desk.ready) {
    return <Layout><div style={{ padding: '3rem', textAlign: 'center' }}><div className="spinner" /></div></Layout>;
  }

  if (!desk.desk) {
    return (
      <Layout>
        <PageHeader title="Your desk" subtitle={`Sign in to a desk or room to start calling ${terms.people}.`} />
        <div className="panel"><DeskPicker desk={desk} /></div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title={desk.desk.label}
        subtitle={`${desk.desk.serviceName} · ${waiting.length} waiting`}
        actions={
          <div className="desk-header-actions">
            <Button variant="secondary" onClick={popOut} title={pipSupported ? 'Keep your desk on top while you use other apps' : 'Open your desk in a small window'}>
              <PictureInPicture2 size={16} /> {pipWindow ? 'Popped out' : 'Pop out'}
            </Button>
            <Button variant="ghost" onClick={desk.leave} disabled={!!desk.busy}><LogOut size={16} /> Leave desk</Button>
          </div>
        }
      />

      <WaitAlerts locationId={desk.desk.locationId} />

      {notifyState === 'default' && (
        <div className="desk-banner">
          <Bell size={18} />
          <span>Get an alert when someone joins, even while you’re in another app.</span>
          <Button size="sm" variant="secondary" onClick={() => Notification.requestPermission().then(setNotifyState)}>Turn on alerts</Button>
        </div>
      )}

      <div className="desk-layout">
        <div className="desk-main">
          {pipWindow ? (
            <div className="panel desk-popped">
              <PictureInPicture2 size={22} />
              <p>Your desk is in the pop-out window. It stays on top of your other apps.</p>
              <Button variant="secondary" size="sm" onClick={() => pipWindow.close()}>Bring it back</Button>
            </div>
          ) : (
            <div className="panel desk-panel-wrap">
              <DeskPanel desk={desk} onDetails={desk.current ? () => setDetails(desk.current) : undefined} />
            </div>
          )}
          <p className="desk-hint">
            Shortcuts: <kbd>N</kbd> call next · <kbd>D</kbd> done · <kbd>A</kbd> call again.{' '}
            <button type="button" className="link-button" onClick={() => setShowEmbed(true)}><Code2 size={14} /> Use this desk inside another app</button>
          </p>
        </div>

        <aside className="desk-side">
          <section className="panel">
            <div className="desk-side-head">
              <h2>Waiting</h2>
              <span>{waiting.length ? 'Drag to change the order' : ''}</span>
            </div>
            {waiting.length === 0 ? (
              <p className="muted desk-empty">Nobody is waiting for {desk.desk.serviceName}.</p>
            ) : (
              <ol className="desk-queue">
                {waiting.map((e, i) => (
                  <li
                    key={e.id}
                    draggable
                    data-dragging={dragId === e.id}
                    onDragStart={() => setDragId(e.id)}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(ev) => ev.preventDefault()}
                    onDrop={() => drop(e.id)}
                  >
                    <GripVertical size={16} className="desk-grip" aria-hidden="true" />
                    <span className="desk-pos">{i + 1}</span>
                    <b>{e.ticketNumber}</b>
                    <span className="desk-queue-name">{personName(e)}</span>
                    {e.heldAt ? (
                      <Badge tone="primary">On hold</Badge>
                    ) : e.awaitingClearance ? (
                      <Badge tone="warning">Awaiting payment</Badge>
                    ) : (
                      <small>{minutesAgo(e.joinedAt)} min</small>
                    )}
                    {e.awaitingClearance ? (
                      <button type="button" className="desk-call-one" onClick={() => desk.clear(e)} disabled={!!desk.busy} title="They’ve paid: let them into the line">Mark paid</button>
                    ) : (
                      <button type="button" className="desk-call-one" onClick={() => desk.callNext(e.id)} disabled={!!desk.busy} title={e.heldAt ? 'Call them back' : `Call ${e.ticketNumber} now`}>{e.heldAt ? 'Call back' : 'Call'}</button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {desk.otherDesks.length > 0 && (
            <section className="panel">
              <div className="desk-side-head"><h2>At other desks</h2></div>
              <ul className="desk-others">
                {desk.otherDesks.map((e) => (
                  <li key={e.id}>
                    <b>{e.ticketNumber}</b>
                    <span>{personName(e)}</span>
                    <small>{e.servicePointInstance?.displayName || e.servicePoint?.displayName || e.servicePoint?.name || 'No desk'}</small>
                    {!e.servicePointInstanceId && (
                      <button type="button" className="desk-call-one" onClick={() => desk.finishOther(e)} disabled={!!desk.busy} title="Nobody's desk has them. Mark them as done.">Done</button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="desk-switch">
            <button type="button" className="link-button" onClick={desk.leave}><Repeat size={14} /> Switch desk</button>
            {' · '}
            <Link href={`/display/${desk.desk.locationId}`} target="_blank">Open the lobby screen</Link>
          </p>
        </aside>
      </div>

      {details && <DetailsModal entry={details} locationId={desk.desk.locationId} onClose={() => setDetails(null)} />}

      <Modal open={showEmbed} onClose={() => setShowEmbed(false)} title="Use your desk inside another app">
        <div className="desk-embed">
          <p>Paste this into any web app your team already uses, such as your records system or help desk. It adds a small desk button in the corner. Staff sign in once, pick their desk, and can call the next {terms.person} without leaving that app.</p>
          <pre><code>{embedSnippet}</code></pre>
          <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(embedSnippet)}>Copy code</Button>
          <p className="muted">Or open <a href="/widget/desk" target="_blank" rel="noreferrer">the desk widget</a> on its own and install it from your browser’s menu to keep it in its own window.</p>
        </div>
      </Modal>

      {pipWindow && createPortal(
        <div className="desk-pip">
          <header>
            <strong>{desk.desk.label}</strong>
            <span>{desk.desk.serviceName}</span>
          </header>
          <DeskPanel desk={desk} compact />
        </div>,
        pipWindow.document.body
      )}
    </Layout>
  );
}
