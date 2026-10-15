'use client';

import NoOrganization from '@/components/NoOrganization';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Building2, ContactRound, MonitorSmartphone, Bell, Palette, Globe, Lock, Upload, ArrowUp, ArrowDown, X, Plus,
  CheckCircle2, RefreshCw, Copy, AlertTriangle, CalendarClock,
} from 'lucide-react';
import api from '@/api/client';
import type { CustomDomainInfo } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import Layout from '@/components/Layout';
import { PageHeader, Button, Switch } from '@/components/ui';
import { buildTenantUrl } from '@/lib/subdomain';
import { isReservedSlug } from '@/lib/reservedSlugs';
import { APP_NAME } from '@/lib/appConfig';
import { INDUSTRIES, termsFor, defaultPersonFor, pluralize, type Terms } from '@/lib/terms';

interface IdentityField {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

type FieldConfig = Record<string, { required: boolean; label: string; type?: string; order?: number }>;

interface Organization {
  id: string;
  name: string;
  slug?: string;
  email?: string;
  phone?: string;
  identityFieldsConfig?: FieldConfig;
  defaultDisplayMode?: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  hidePoweredBy?: boolean;
  notificationSettings?: { turnApproachingAt: number; email: boolean; sms: boolean };
  industry?: string | null;
  customerLabel?: string | null;
  customerLabelPlural?: string | null;
  joinIdentifierType?: string | null;
  bookedArrivalSettings?: Partial<Arrival> | null;
}

interface Arrival { enabled: boolean; earlyMinutes: number; lateMinutes: number; maxBookedShare: number }
const DEFAULT_ARRIVAL: Arrival = { enabled: true, earlyMinutes: 10, lateMinutes: 15, maxBookedShare: 50 };
// Share of the people placed ahead of a walk-in who may be booked patients that arrived after them.
const SHARE_CHOICES = [
  { value: 0, label: 'None: walk-ins who arrived first always stay ahead' },
  { value: 50, label: 'Half: one booked patient, then one walk-in' },
  { value: 67, label: 'Two thirds: two booked patients, then one walk-in' },
  { value: 75, label: 'Three quarters: three booked patients, then one walk-in' },
  { value: 100, label: 'No limit: booked patients always go by their booked time' },
];
const minutesIn = (value: string) => Math.min(240, Math.max(0, Math.round(Number(value) || 0)));

type Section = 'general' | 'patient' | 'screens' | 'notifications' | 'arrivals' | 'branding' | 'domain';

const sectionsFor = (t: Terms): { id: Section; label: string; hint: string; icon: typeof Building2 }[] => [
  { id: 'general', label: 'Organization', hint: 'Name, type, contact and workspace address', icon: Building2 },
  { id: 'patient', label: `${t.Person} details`, hint: 'What people are asked when they join', icon: ContactRound },
  { id: 'screens', label: 'Screen privacy', hint: `How ${t.people} appear on lobby screens`, icon: MonitorSmartphone },
  { id: 'notifications', label: 'Notifications', hint: 'Turn-approaching alerts by email and SMS', icon: Bell },
  { id: 'arrivals', label: 'Booked arrivals', hint: `Where ${t.people} with an appointment join the line`, icon: CalendarClock },
  { id: 'branding', label: 'Branding', hint: 'Logo and colour on public pages', icon: Palette },
  { id: 'domain', label: 'Custom domain', hint: 'Use your own web address', icon: Globe },
];

const STANDARD_FIELDS: IdentityField[] = [
  { key: 'firstName', label: 'First name', type: 'text', required: true },
  { key: 'lastName', label: 'Last name', type: 'text', required: false },
  { key: 'phone', label: 'Phone number', type: 'tel', required: false },
  { key: 'email', label: 'Email address', type: 'email', required: false },
  { key: 'mrNumber', label: 'MR number', type: 'text', required: false },
  { key: 'patientId', label: 'Reference number', type: 'text', required: false },
  { key: 'nationalId', label: 'National ID', type: 'text', required: false },
  { key: 'dateOfBirth', label: 'Date of birth', type: 'date', required: false },
  { key: 'gender', label: 'Gender', type: 'select', required: false },
  { key: 'insuranceId', label: 'Insurance ID', type: 'text', required: false },
];
const TYPE_LABEL: Record<string, string> = { text: 'Text', tel: 'Phone', email: 'Email', date: 'Date', number: 'Number', select: 'Choice' };
const NAME_ORDER = ['name', 'fullName', 'firstName', 'lastName', 'phone', 'email'];

const DISPLAY_MODES = [
  { value: 'TICKET_ONLY', label: 'Ticket number only', note: 'Most private. Recommended for clinics.' },
  { value: 'NAME_AND_TICKET', label: 'Number and short name', note: 'First name and initial, so people spot their call faster.' },
  { value: 'FULL_INFO', label: 'Number, full name and service', note: 'Only where names on a screen are acceptable.' },
];

const COLOR_PRESETS = ['#0f9fa4', '#2563eb', '#7c3aed', '#c2410c', '#15803d', '#be123c', '#0d2a47'];

function fieldsFromConfig(config?: FieldConfig): IdentityField[] {
  if (!config || Object.keys(config).length === 0) {
    return STANDARD_FIELDS.slice(0, 3).map((f) => ({ ...f }));
  }
  const entries = Object.entries(config);
  const hasOrder = entries.every(([, c]) => typeof c.order === 'number');
  const rank = (k: string) => (NAME_ORDER.includes(k) ? NAME_ORDER.indexOf(k) : NAME_ORDER.length);
  entries.sort(([a, ca], [b, cb]) => (hasOrder ? (ca.order! - cb.order!) : rank(a) - rank(b)));
  return entries.map(([key, c]) => ({ key, label: c.label || key, type: c.type || 'text', required: !!c.required }));
}

const toKey = (label: string) =>
  label
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');

export default function AdminSettingsPage() {
  const { user, isAdmin, loading: authLoading, refreshUser } = useAuthContext();
  const { hasFeature } = useSubscription();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<Section>('general');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [general, setGeneral] = useState({ name: '', slug: '', email: '', phone: '', industry: 'HEALTHCARE', customerLabel: '' });
  const [fields, setFields] = useState<IdentityField[]>([]);
  const [newField, setNewField] = useState({ label: '', type: 'text' });
  const [displayMode, setDisplayMode] = useState('TICKET_ONLY');
  const [notify, setNotify] = useState({ turnApproachingAt: 3, email: true, sms: false });
  const [arrival, setArrival] = useState<Arrival>(DEFAULT_ARRIVAL);
  const [brand, setBrand] = useState({ primaryColor: '', hidePoweredBy: false });
  // '' = off; 'mrNumber' | 'memberNumber' = checked with the EMR before a ticket is issued.
  const [joinIdentifier, setJoinIdentifier] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [snapshot, setSnapshot] = useState('');

  const [customDomain, setCustomDomain] = useState<CustomDomainInfo | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainMessage, setDomainMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const current = useMemo(
    () => JSON.stringify({ general, fields, displayMode, notify, brand, joinIdentifier, arrival }),
    [general, fields, displayMode, notify, brand, joinIdentifier, arrival]
  );
  const dirty = snapshot !== '' && current !== snapshot;

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin || !user?.organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const org: Organization = await api.getOrganization(user.organizationId!);
        setOrganization(org);
        const g = { name: org.name || '', slug: org.slug || '', email: org.email || '', phone: org.phone || '', industry: org.industry || 'OTHER', customerLabel: org.customerLabel || '' };
        const f = fieldsFromConfig(org.identityFieldsConfig);
        const d = org.defaultDisplayMode || 'TICKET_ONLY';
        const n = { turnApproachingAt: 3, email: true, sms: false, ...(org.notificationSettings || {}) };
        const b = { primaryColor: org.primaryColor || '', hidePoweredBy: !!org.hidePoweredBy };
        const j = org.joinIdentifierType || '';
        const a = { ...DEFAULT_ARRIVAL, ...(org.bookedArrivalSettings || {}) };
        setGeneral(g); setFields(f); setDisplayMode(d); setNotify(n); setBrand(b); setJoinIdentifier(j); setArrival(a);
        setSnapshot(JSON.stringify({ general: g, fields: f, displayMode: d, notify: n, brand: b, joinIdentifier: j, arrival: a }));
      } catch {
        setMessage({ type: 'error', text: 'Couldn’t load your settings. Refresh to try again.' });
      } finally {
        setLoading(false);
      }
      api.getCustomDomain(user.organizationId!).then(setCustomDomain).catch(() => {});
    })();
  }, [authLoading, isAdmin, user?.organizationId]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const terms = termsFor(general);
  const SECTIONS = sectionsFor(terms);
  const slugChanged = !!organization && (organization.slug || '') !== general.slug;
  const slugProblem =
    general.slug && isReservedSlug(general.slug) ? 'That address is reserved.'
    : general.slug && general.slug.length < 3 ? 'Use at least 3 characters.'
    : '';

  const save = async () => {
    if (!organization) return;
    if (slugProblem) return setMessage({ type: 'error', text: slugProblem });
    if (!fields.some((f) => ['firstName', 'name', 'fullName'].includes(f.key))) {
      return setMessage({ type: 'error', text: `Keep a name field so staff can call ${terms.people}.` });
    }
    setSaving(true);
    setMessage(null);
    try {
      const identityFieldsConfig: FieldConfig = {};
      fields.forEach((f, order) => { identityFieldsConfig[f.key] = { required: f.required, label: f.label, type: f.type, order }; });
      const updated = await api.updateOrganization(organization.id, {
        name: general.name,
        slug: general.slug || undefined,
        email: general.email || undefined,
        phone: general.phone || undefined,
        industry: general.industry,
        customerLabel: general.customerLabel.trim() || null,
        customerLabelPlural: general.customerLabel.trim() ? pluralize(general.customerLabel.trim()) : null,
        identityFieldsConfig,
        defaultDisplayMode: displayMode,
        notificationSettings: notify,
        bookedArrivalSettings: arrival,
        joinIdentifierType: joinIdentifier || null,
        // Branding fields are plan-gated server-side; sending them (even as
        // null) on a plan without customBranding rejects the whole save.
        ...(hasFeature('customBranding') ? { primaryColor: brand.primaryColor || null, hidePoweredBy: brand.hidePoweredBy } : {}),
      } as any);
      if (slugChanged && general.slug) {
        // Sign-in is tied to the address; take them to the new one rather
        // than leaving them on an address that no longer resolves.
        window.location.href = buildTenantUrl(general.slug, '/login');
        return;
      }
      setOrganization(updated);
      setSnapshot(current);
      refreshUser().catch(() => {});
      setMessage({ type: 'success', text: 'Settings saved.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || err.response?.data?.message || 'Couldn’t save. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const move = (index: number, delta: number) =>
    setFields((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const addField = (field: IdentityField) => setFields((list) => (list.some((f) => f.key === field.key) ? list : [...list, { ...field }]));

  const addCustomField = () => {
    const key = toKey(newField.label);
    if (!key) return;
    if (fields.some((f) => f.key === key)) return setMessage({ type: 'error', text: `There’s already a “${newField.label}” field.` });
    setFields((list) => [...list, { key, label: newField.label.trim(), type: newField.type, required: false }]);
    setNewField({ label: '', type: 'text' });
  };

  const uploadLogo = async () => {
    if (!organization || !logoFile) return;
    setUploadingLogo(true);
    try {
      const result = await api.uploadOrganizationLogo(organization.id, logoFile);
      setOrganization({ ...organization, logoUrl: result.logoUrl });
      setLogoFile(null);
      setMessage({ type: 'success', text: 'Logo updated.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Couldn’t upload the logo.' });
    } finally {
      setUploadingLogo(false);
    }
  };

  const domainAction = async (fn: () => Promise<void>) => {
    setDomainBusy(true);
    setDomainMessage(null);
    try { await fn(); } catch (err: any) {
      setDomainMessage({ type: 'error', text: err.response?.data?.message || err.response?.data?.error || 'That didn’t work. Try again.' });
    } finally { setDomainBusy(false); }
  };

  if (loading) {
    return <Layout><div style={{ padding: '3rem', textAlign: 'center' }}><div className="spinner" /></div></Layout>;
  }
  if (!organization) {
    if (!user?.organizationId) return <NoOrganization />;
    return <Layout><div className="inline-alert inline-alert-error">{message?.text || 'Couldn’t load your settings. Refresh to try again.'}</div></Layout>;
  }

  const standardAvailable = STANDARD_FIELDS.filter((f) => !fields.some((x) => x.key === f.key));
  const accent = brand.primaryColor || '#0f9fa4';

  return (
    <Layout>
      <PageHeader title="Settings" subtitle={`How your organization appears to ${terms.people} and staff.`} />

      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => {
            const SIcon = s.icon;
            return (
              <button key={s.id} type="button" className="settings-nav-item" aria-current={section === s.id ? 'true' : undefined} onClick={() => { setSection(s.id); setMessage(null); }}>
                <SIcon size={18} aria-hidden="true" />
                <span>
                  <strong>{s.label}</strong>
                  <small>{s.hint}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="settings-panel">
          {section === 'general' && (
            <section aria-labelledby="s-general">
              <h2 id="s-general">Organization</h2>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>Organization name</span>
                  <input value={general.name} onChange={(e) => setGeneral({ ...general, name: e.target.value })} required />
                </label>
                <label className="settings-field">
                  <span>Contact email</span>
                  <input type="email" value={general.email} onChange={(e) => setGeneral({ ...general, email: e.target.value })} placeholder="frontdesk@yourclinic.com" />
                </label>
                <label className="settings-field">
                  <span>Phone</span>
                  <input type="tel" value={general.phone} onChange={(e) => setGeneral({ ...general, phone: e.target.value })} />
                </label>
              </div>

              <h3>What kind of place is it?</h3>
              <div className="settings-chips" role="radiogroup" aria-label="Organization type">
                {INDUSTRIES.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    role="radio"
                    aria-checked={general.industry === i.id}
                    className="welcome-chip"
                    onClick={() => setGeneral({ ...general, industry: i.id })}
                  >
                    {i.label}
                  </button>
                ))}
              </div>
              <label className="settings-field settings-narrow-wide">
                <span>What do you call the people in your queues?</span>
                <input
                  value={general.customerLabel}
                  maxLength={30}
                  onChange={(e) => setGeneral({ ...general, customerLabel: e.target.value })}
                  placeholder={defaultPersonFor(general.industry)}
                />
                <small>Used on every screen, message and report, e.g. “{terms.People} waiting”. Leave blank for “{defaultPersonFor(general.industry)}”.</small>
              </label>

              <h3>Workspace address</h3>
              <div className="settings-suffix">
                <input
                  aria-label="Workspace address"
                  value={general.slug}
                  onChange={(e) => setGeneral({ ...general, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                />
                <span>{buildTenantUrl('x').replace(/^https?:\/\/x/, '').replace(/\/$/, '')}</span>
              </div>
              {slugProblem ? (
                <p className="settings-note settings-note-bad">{slugProblem}</p>
              ) : slugChanged ? (
                <p className="settings-warn"><AlertTriangle size={16} /> Everyone will sign in at <strong>{general.slug}</strong> after you save, and the old address stops working. You’ll be taken there to sign in again.</p>
              ) : (
                <p className="settings-note">Staff sign in here. QR codes keep working if you change it.</p>
              )}

              <h3>Organization ID</h3>
              <p className="settings-note">Needed when connecting other systems.</p>
              <div className="settings-copy">
                <code>{organization.id}</code>
                <button type="button" onClick={() => navigator.clipboard.writeText(organization.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                  <Copy size={15} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </section>
          )}

          {section === 'patient' && (
            <section aria-labelledby="s-patient">
              <h2 id="s-patient">{terms.Person} details</h2>
              <p className="settings-lede">{terms.People} fill these in, in this order, when they join a queue. Keep it short; every extra field slows the line at the door.</p>
              <ol className="settings-fields">
                {fields.map((f, i) => {
                  const isName = ['firstName', 'name', 'fullName'].includes(f.key);
                  return (
                    <li key={f.key}>
                      <div className="settings-field-order">
                        <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${f.label} up`}><ArrowUp size={15} /></button>
                        <button type="button" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label={`Move ${f.label} down`}><ArrowDown size={15} /></button>
                      </div>
                      <div className="settings-field-name">
                        <strong>{f.label}</strong>
                        <small>{TYPE_LABEL[f.type] || f.type}{isName ? ', always asked' : ''}</small>
                      </div>
                      <Switch
                        label="Required"
                        checked={isName || f.required}
                        disabled={isName}
                        onChange={() => setFields((list) => list.map((x) => (x.key === f.key ? { ...x, required: !x.required } : x)))}
                      />
                      <button
                        type="button"
                        className="settings-remove"
                        onClick={() => setFields((list) => list.filter((x) => x.key !== f.key))}
                        disabled={isName}
                        aria-label={`Remove ${f.label}`}
                        title={isName ? `${terms.People} are always asked their name` : `Remove ${f.label}`}
                      >
                        <X size={16} />
                      </button>
                    </li>
                  );
                })}
              </ol>

              {standardAvailable.length > 0 && (
                <>
                  <h3>Add a field</h3>
                  <div className="settings-chips">
                    {standardAvailable.map((f) => (
                      <button key={f.key} type="button" className="welcome-chip" onClick={() => addField(f)}>
                        <Plus size={15} /> {f.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <h3>Your own field</h3>
              <div className="settings-inline">
                <input
                  aria-label="New field name"
                  placeholder="e.g. Referring doctor"
                  value={newField.label}
                  onChange={(e) => setNewField({ ...newField, label: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomField(); } }}
                />
                <select aria-label="Field type" value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value })}>
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="email">Email</option>
                  <option value="tel">Phone</option>
                </select>
                <Button type="button" variant="secondary" onClick={addCustomField} disabled={!newField.label.trim()}>Add</Button>
              </div>

              <h3>Check them against your records</h3>
              <label className="settings-field settings-narrow">
                <span>Require an MR or member number to join</span>
                <select value={joinIdentifier} onChange={(e) => setJoinIdentifier(e.target.value)}>
                  <option value="">Off</option>
                  <option value="mrNumber">Ask for their MR number</option>
                  <option value="memberNumber">Ask for their member number</option>
                </select>
                <small>
                  On the kiosk and the join page. Only works when an EMR connection can look {terms.people} up. A number it
                  doesn’t know is turned away; if the EMR can’t be reached, they still get a ticket marked “identifier not verified”.
                </small>
              </label>
            </section>
          )}

          {section === 'screens' && (
            <section aria-labelledby="s-screens">
              <h2 id="s-screens">Screen privacy</h2>
              <p className="settings-lede">Choose what the lobby screen shows when someone is called. Screens are seen by everyone in the room.</p>
              <div className="mode-cards" role="radiogroup" aria-labelledby="s-screens">
                {DISPLAY_MODES.map((mode) => (
                  <label key={mode.value} className="mode-card" data-selected={displayMode === mode.value}>
                    <input type="radio" name="displayMode" value={mode.value} checked={displayMode === mode.value} onChange={() => setDisplayMode(mode.value)} />
                    <div className="mode-preview" aria-hidden="true">
                      <span className="mode-ticket">C014</span>
                      <span className="mode-who">
                        {mode.value === 'NAME_AND_TICKET' && 'Kofi B.'}
                        {mode.value === 'FULL_INFO' && <>Kofi Boateng<small>Consultation</small></>}
                      </span>
                      <span className="mode-desk">Room 2</span>
                    </div>
                    <strong>{mode.label}</strong>
                    <small>{mode.note}</small>
                  </label>
                ))}
              </div>
              <p className="settings-note">Adverts, the ticker and what plays between calls are managed under <a href="/admin/displays">Display screens</a>.</p>
            </section>
          )}

          {section === 'notifications' && (
            <section aria-labelledby="s-notify">
              <h2 id="s-notify">Notifications</h2>
              <p className="settings-lede">{terms.People} always see live updates on their ticket page. Email and SMS go out as well, using your plan’s message credits.</p>
              <label className="settings-field settings-narrow">
                <span>Tell {terms.people} when they’re this many places from the front</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={notify.turnApproachingAt}
                  onChange={(e) => setNotify({ ...notify, turnApproachingAt: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })}
                />
                <small>Each {terms.person} is told once. 3 works for most places.</small>
              </label>
              <div className="settings-switches">
                <Switch label={`Email ${terms.people} who give an email address`} checked={notify.email} onChange={(e) => setNotify({ ...notify, email: e.target.checked })} />
                <Switch label={`Text ${terms.people} who give a phone number`} checked={notify.sms} onChange={(e) => setNotify({ ...notify, sms: e.target.checked })} />
              </div>
            </section>
          )}

          {section === 'arrivals' && (
            <section aria-labelledby="s-arrivals">
              <h2 id="s-arrivals">Booked arrivals</h2>
              <p className="settings-lede">
                When a {terms.person} with an appointment checks in on time, they take their place in line by their booked
                time: anyone who arrived before that time stays ahead, anyone who arrived after it goes behind. Nobody who has
                already been called is passed. Late arrivals join the line like everyone else.
              </p>
              <div className="settings-switches">
                <Switch label={`Place booked ${terms.people} by their booked time`} checked={arrival.enabled} onChange={(e) => setArrival({ ...arrival, enabled: e.target.checked })} />
              </div>
              <label className="settings-field settings-narrow">
                <span>On time from this many minutes before the booked time</span>
                <input type="number" min={0} max={240} value={arrival.earlyMinutes} disabled={!arrival.enabled} onChange={(e) => setArrival({ ...arrival, earlyMinutes: minutesIn(e.target.value) })} />
              </label>
              <label className="settings-field settings-narrow">
                <span>…until this many minutes after it</span>
                <input type="number" min={0} max={240} value={arrival.lateMinutes} disabled={!arrival.enabled} onChange={(e) => setArrival({ ...arrival, lateMinutes: minutesIn(e.target.value) })} />
                <small>Anyone arriving outside this window joins as a walk-in. 10 before and 15 after suits most clinics.</small>
              </label>
              <label className="settings-field">
                <span>How many booked {terms.people} may go ahead of a walk-in who was already waiting</span>
                <select value={arrival.maxBookedShare} disabled={!arrival.enabled} onChange={(e) => setArrival({ ...arrival, maxBookedShare: Number(e.target.value) })}>
                  {(SHARE_CHOICES.some((c) => c.value === arrival.maxBookedShare)
                    ? SHARE_CHOICES
                    : [...SHARE_CHOICES, { value: arrival.maxBookedShare, label: `${arrival.maxBookedShare}% booked` }]
                  ).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <small>Keeps walk-ins moving when several booked patients arrive together.</small>
              </label>
              {!arrival.enabled && (
                <p className="settings-note">Off: appointments checked in by staff go ahead of walk-ins, and appointments checked in from a connected system join by arrival.</p>
              )}
            </section>
          )}

          {section === 'branding' && (
            <section aria-labelledby="s-brand">
              <h2 id="s-brand">Branding</h2>
              <p className="settings-lede">Your logo and colour on the sign-in page, the ticket pages and the lobby screen.</p>
              {!hasFeature('customBranding') ? (
                <p className="settings-locked"><Lock size={18} /> Branding isn’t included in your plan. <a href="/admin/billing">See plans</a></p>
              ) : (
                <div className="brand-layout">
                  <div>
                    <h3>Logo</h3>
                    <div className="brand-logo-row">
                      <div className="brand-logo-box">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {organization.logoUrl ? <img src={organization.logoUrl} alt="Current logo" /> : <span>No logo yet</span>}
                      </div>
                      <label className="brand-upload">
                        <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => setLogoFile(e.target.files?.[0] || null)} />
                        <span>{logoFile ? logoFile.name : 'Choose a file'}</span>
                      </label>
                      <Button type="button" variant="secondary" disabled={!logoFile || uploadingLogo} onClick={uploadLogo}>
                        <Upload size={16} /> {uploadingLogo ? 'Uploading…' : 'Upload'}
                      </Button>
                    </div>
                    <p className="settings-note">PNG, SVG or JPG. A wide logo on a transparent background works best.</p>

                    <h3>Colour</h3>
                    <div className="brand-swatches" role="radiogroup" aria-label="Brand colour">
                      {COLOR_PRESETS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          role="radio"
                          aria-checked={accent.toLowerCase() === c}
                          aria-label={c}
                          className="brand-swatch"
                          style={{ background: c }}
                          onClick={() => setBrand({ ...brand, primaryColor: c })}
                        />
                      ))}
                      <label className="brand-custom">
                        <input type="color" value={accent} onChange={(e) => setBrand({ ...brand, primaryColor: e.target.value })} aria-label="Custom colour" />
                        <span>{accent}</span>
                      </label>
                    </div>
                    <div className="settings-switches">
                      <Switch label={`Hide “Powered by ${APP_NAME}”`} checked={brand.hidePoweredBy} onChange={(e) => setBrand({ ...brand, hidePoweredBy: e.target.checked })} />
                    </div>
                  </div>
                  <figure className="brand-preview" aria-label="Preview">
                    <div className="brand-preview-card">
                      <p>Your ticket</p>
                      <b style={{ color: accent }}>C014</b>
                      <span className="brand-preview-btn" style={{ background: accent }}>Join queue</span>
                    </div>
                    <figcaption>Preview of the ticket page</figcaption>
                  </figure>
                </div>
              )}
            </section>
          )}

          {section === 'domain' && (
            <section aria-labelledby="s-domain">
              <h2 id="s-domain">Custom domain</h2>
              <p className="settings-lede">Serve your sign-in and ticket pages from your own address, such as queue.yourclinic.com.</p>
              {!hasFeature('customDomain') ? (
                <p className="settings-locked"><Lock size={18} /> Custom domains aren’t included in your plan. <a href="/admin/billing">See plans</a></p>
              ) : (
                <>
                  {domainMessage && <div className={`inline-alert inline-alert-${domainMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginBottom: '1rem' }}>{domainMessage.text}</div>}
                  {!customDomain ? (
                    <div className="settings-inline">
                      <input aria-label="Domain" value={domainInput} onChange={(e) => setDomainInput(e.target.value)} placeholder="queue.yourclinic.com" />
                      <Button type="button" disabled={!domainInput.trim() || domainBusy} onClick={() => domainAction(async () => {
                        setCustomDomain(await api.setCustomDomain(organization.id, domainInput.trim()));
                        setDomainInput('');
                        setDomainMessage({ type: 'success', text: 'Domain added. Add the DNS record below, then check it.' });
                      })}>
                        <Globe size={16} /> {domainBusy ? 'Adding…' : 'Add domain'}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="domain-status">
                        <strong>{customDomain.domain}</strong>
                        <span data-verified={customDomain.status === 'VERIFIED'}>
                          {customDomain.status === 'VERIFIED' ? <><CheckCircle2 size={14} /> Connected</> : 'Waiting for DNS'}
                        </span>
                      </p>
                      {customDomain.status !== 'VERIFIED' && (
                        <div className="domain-dns">
                          <p>At your domain provider, add this record:</p>
                          <dl>
                            <dt>Type</dt><dd>CNAME</dd>
                            <dt>Name</dt><dd>{customDomain.domain}</dd>
                            <dt>Points to</dt><dd>{customDomain.cnameTarget}</dd>
                          </dl>
                          <p className="settings-note">Changes can take from a few minutes to a few hours to show up.</p>
                        </div>
                      )}
                      <div className="settings-inline" style={{ marginTop: '1rem' }}>
                        {customDomain.status !== 'VERIFIED' && (
                          <Button type="button" disabled={domainBusy} onClick={() => domainAction(async () => {
                            setCustomDomain(await api.verifyCustomDomain(organization.id));
                            setDomainMessage({ type: 'success', text: 'Connected. Your pages now load at this address.' });
                          })}>
                            <RefreshCw size={16} /> {domainBusy ? 'Checking…' : 'Check DNS'}
                          </Button>
                        )}
                        <Button type="button" variant="secondary" disabled={domainBusy} onClick={() => domainAction(async () => {
                          await api.deleteCustomDomain(organization.id);
                          setCustomDomain(null);
                          setDomainMessage({ type: 'success', text: 'Custom domain removed.' });
                        })}>
                          Remove domain
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {section !== 'domain' && (
            <div className="settings-savebar" data-dirty={dirty}>
              <span role="status">
                {message ? (
                  <span className={message.type === 'error' ? 'settings-note-bad' : 'settings-note-ok'}>{message.text}</span>
                ) : dirty ? 'You have unsaved changes.' : 'All changes saved.'}
              </span>
              <Button type="button" onClick={save} disabled={saving || !dirty}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
