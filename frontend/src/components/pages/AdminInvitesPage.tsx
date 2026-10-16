'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Mail, Send, Trash2, UserPlus } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription, UpgradePrompt } from '@/contexts/SubscriptionContext';
import Layout from '@/components/Layout';
import { Button, PageHeader } from '@/components/ui';
import { confirmDialog } from '@/lib/dialog';

/**
 * The team: who has access and what they can do, plus invites waiting to
 * be accepted. Invites go by email, or as a link to share another way.
 */

interface Member { id: string; email: string; firstName: string; lastName: string; role: string; isActive: boolean }
interface Invite { id: string; code: string; role: string; email?: string | null; used: boolean; expiresAt: string | null; createdAt: string }

const ROLES = [
  { id: 'SERVICE_STAFF', label: 'Staff', hint: 'Signs in to a desk and calls people.' },
  { id: 'RECEPTIONIST', label: 'Receptionist', hint: 'Adds people to queues, books and checks in appointments.' },
  { id: 'LOCATION_ADMIN', label: 'Location admin', hint: 'Runs services and desks.' },
  { id: 'ORG_ADMIN', label: 'Admin', hint: 'Everything, including billing and settings.' },
];
const ASSIGNABLE: Record<string, string[]> = {
  SUPER_ADMIN: ['ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST'],
  ORG_ADMIN: ['ORG_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST'],
  LOCATION_ADMIN: ['SERVICE_STAFF', 'RECEPTIONIST'],
};
const roleLabel = (id: string) => ROLES.find((r) => r.id === id)?.label || id.toLowerCase().replace('_', ' ');

function errorText(err: unknown, fallback: string) {
  const e = err as { response?: { data?: { error?: string } } };
  return e?.response?.data?.error || fallback;
}

export default function AdminInvitesPage() {
  const { user } = useAuthContext();
  const { limits, refresh } = useSubscription();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SERVICE_STAFF');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const assignable = ASSIGNABLE[user?.role || ''] || [];
  const canManage = user?.role === 'ORG_ADMIN' || user?.role === 'SUPER_ADMIN';

  const load = () => {
    if (!user?.organizationId) return;
    api.getUsers({ organizationId: user.organizationId })
      .then((list: Member[]) => setMembers(list.filter((m) => m.role !== 'PATIENT')))
      .catch(() => setMembers([]));
    if (canManage) api.getInvites().then(setInvites).catch(() => setInvites([]));
  };
  useEffect(load, [user?.organizationId, canManage]);

  const pending = useMemo(
    () => invites.filter((i) => !i.used && (!i.expiresAt || new Date(i.expiresAt).getTime() > Date.now())),
    [invites]
  );
  const atSeatLimit = limits.users.limit !== null && limits.users.current + pending.length >= limits.users.limit;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const linkFor = (inv: Invite) => `${origin}/register?invite=${inv.code}`;
  const copy = (inv: Invite) => navigator.clipboard.writeText(linkFor(inv)).then(() => { setCopied(inv.id); setTimeout(() => setCopied(null), 1500); });

  const invite = async (e: React.FormEvent, byLink = false) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.createInvite({ role, email: byLink ? undefined : email.trim() || undefined, organizationId: user?.organizationId });
      setInvites((list) => [res.invite, ...list]);
      if (byLink || !email.trim()) {
        await navigator.clipboard.writeText(linkFor(res.invite)).catch(() => {});
        setMessage({ tone: 'ok', text: 'Invite link copied. Send it however you like; it works once and expires in 7 days.' });
      } else {
        setMessage(res.emailed
          ? { tone: 'ok', text: `Invite sent to ${email.trim()}.` }
          : { tone: 'bad', text: 'The invite was created but the email didn’t send. Copy the link from the list below instead.' });
        setEmail('');
      }
    } catch (err) {
      setMessage({ tone: 'bad', text: errorText(err, 'Couldn’t create the invite.') });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inv: Invite) => {
    if (!(await confirmDialog({ title: `Cancel the invite${inv.email ? ` for ${inv.email}` : ''}?`, message: 'The link will stop working.', confirmLabel: 'Cancel invite', cancelLabel: 'Keep it', tone: 'danger' }))) return;
    try {
      await api.revokeInvite(inv.id);
      setInvites((list) => list.filter((i) => i.id !== inv.id));
    } catch (err) {
      setMessage({ tone: 'bad', text: errorText(err, 'Couldn’t cancel it.') });
    }
  };

  const change = async (m: Member, patch: { role?: string; isActive?: boolean }) => {
    if (patch.isActive === false && !(await confirmDialog({ title: `Remove ${m.firstName}’s access?`, message: 'They won’t be able to sign in. You can restore it later.', confirmLabel: 'Remove access', tone: 'danger' }))) return;
    const before = members;
    setMembers((list) => list?.map((x) => (x.id === m.id ? { ...x, ...patch } : x)) || null);
    try {
      await api.updateUser(m.id, patch);
      refresh?.();
    } catch (err) {
      setMembers(before);
      setMessage({ tone: 'bad', text: errorText(err, 'That change didn’t save.') });
    }
  };

  const active = (members || []).filter((m) => m.isActive);
  const inactive = (members || []).filter((m) => !m.isActive);

  return (
    <Layout>
      <PageHeader title="Staff" subtitle="Who can sign in, and what they can do." />

      {canManage && (
        <section className="panel staff-invite">
          <h2><UserPlus size={18} /> Invite someone</h2>
          {atSeatLimit ? <UpgradePrompt resource="users" /> : (
            <form onSubmit={(e) => invite(e)}>
              <label className="settings-field staff-email">
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@yourteam.com" />
              </label>
              <label className="settings-field">
                <span>Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.filter((r) => assignable.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>
              <div className="staff-invite-actions">
                <Button type="submit" disabled={busy || !email.trim()}><Send size={16} /> Send invite</Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={(e) => invite(e as unknown as React.FormEvent, true)}><Copy size={16} /> Copy a link instead</Button>
              </div>
              <p className="staff-role-hint">{ROLES.find((r) => r.id === role)?.hint}</p>
            </form>
          )}
          {message && <p className={message.tone === 'bad' ? 'desk-msg desk-msg-bad' : 'desk-msg'} role="status">{message.text}</p>}
        </section>
      )}

      {canManage && pending.length > 0 && (
        <section className="panel staff-section">
          <h2>Waiting to accept</h2>
          <ul className="staff-list">
            {pending.map((inv) => (
              <li key={inv.id}>
                <span className="staff-avatar staff-avatar-pending"><Mail size={15} /></span>
                <div className="staff-who">
                  <strong>{inv.email || 'Invite link'}</strong>
                  <small>{roleLabel(inv.role)} · expires {inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'never'}</small>
                </div>
                <Button variant="secondary" size="sm" onClick={() => copy(inv)}><Copy size={14} /> {copied === inv.id ? 'Copied' : 'Copy link'}</Button>
                <button type="button" className="settings-remove" onClick={() => revoke(inv)} aria-label="Cancel invite"><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel staff-section">
        <div className="today-panel-head">
          <h2>Team</h2>
          {limits.users.limit !== null && <span className="muted">{limits.users.current} of {limits.users.limit} seats</span>}
        </div>
        {members === null ? <div className="spinner" /> : (
          <ul className="staff-list">
            {active.map((m) => {
              const self = m.id === user?.id;
              const editable = canManage && !self && assignable.includes(m.role);
              return (
                <li key={m.id}>
                  <span className="staff-avatar">{m.firstName?.[0]}{m.lastName?.[0]}</span>
                  <div className="staff-who">
                    <strong>{m.firstName} {m.lastName}{self && <em> (you)</em>}</strong>
                    <small>{m.email}</small>
                  </div>
                  {editable ? (
                    <select value={m.role} onChange={(e) => change(m, { role: e.target.value })} aria-label={`Role for ${m.firstName}`}>
                      {ROLES.filter((r) => assignable.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  ) : <span className="staff-role">{roleLabel(m.role)}</span>}
                  {editable ? (
                    <button type="button" className="settings-remove" onClick={() => change(m, { isActive: false })} aria-label={`Remove ${m.firstName}'s access`} title="Remove access"><Trash2 size={16} /></button>
                  ) : <span className="staff-spacer" />}
                </li>
              );
            })}
          </ul>
        )}
        {canManage && inactive.length > 0 && (
          <details className="staff-inactive">
            <summary>{inactive.length} without access</summary>
            <ul className="staff-list">
              {inactive.map((m) => (
                <li key={m.id}>
                  <span className="staff-avatar staff-avatar-pending">{m.firstName?.[0]}{m.lastName?.[0]}</span>
                  <div className="staff-who"><strong>{m.firstName} {m.lastName}</strong><small>{m.email}</small></div>
                  <Button variant="secondary" size="sm" onClick={() => change(m, { isActive: true })}>Restore access</Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </Layout>
  );
}
