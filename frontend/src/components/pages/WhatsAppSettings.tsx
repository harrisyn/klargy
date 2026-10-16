'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Lock, MessageCircle, Plus, RefreshCw, Send, X, Plug, AlertTriangle } from 'lucide-react';
import api from '@/api/client';
import type { WhatsAppProviderTemplate, WhatsAppSettingsInfo, WhatsAppTemplateMappingInfo } from '@/api/client';
import { Button, Switch } from '@/components/ui';
import {
  WHATSAPP_PROVIDERS,
  WHATSAPP_TEMPLATE_INFO,
  WHATSAPP_TEMPLATE_KEYS,
  WHATSAPP_VARIABLES,
  providerSpec,
  type WhatsAppProviderId,
} from '@/lib/whatsapp';
import { confirmDialog } from '@/lib/dialog';

interface Form {
  provider: WhatsAppProviderId;
  isEnabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  templates: Record<string, WhatsAppTemplateMappingInfo>;
  fallbackToSms: boolean;
  consentMode: 'EXPLICIT' | 'IMPLIED';
  defaultCountryCode: string;
}

const EMPTY: Form = {
  provider: 'meta_cloud',
  isEnabled: false,
  settings: {},
  secrets: {},
  templates: {},
  fallbackToSms: true,
  consentMode: 'EXPLICIT',
  defaultCountryCode: '',
};

const formFrom = (info: WhatsAppSettingsInfo): Form =>
  info.configured
    ? {
        provider: (info.provider as WhatsAppProviderId) || 'meta_cloud',
        isEnabled: !!info.isEnabled,
        settings: { ...(info.settings || {}) },
        secrets: {},
        templates: { ...(info.templates || {}) },
        fallbackToSms: info.fallbackToSms !== false,
        consentMode: info.consentMode === 'IMPLIED' ? 'IMPLIED' : 'EXPLICIT',
        defaultCountryCode: info.defaultCountryCode || '',
      }
    : { ...EMPTY };

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad'> = { APPROVED: 'ok', PENDING: 'warn', UNKNOWN: 'warn', REJECTED: 'bad', PAUSED: 'bad', DISABLED: 'bad', MISSING: 'bad' };
const statusLabel = (s?: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : 'Not checked');

const errorText = (err: any, fallback: string) => err?.response?.data?.error || err?.response?.data?.message || fallback;

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wa-copy">
      <span>{label}</span>
      <div className="settings-copy">
        <code>{value}</code>
        <button type="button" onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
          <Copy size={15} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function WhatsAppSettings({ organizationId, allowed, person }: { organizationId: string; allowed: boolean; person: string }) {
  const [info, setInfo] = useState<WhatsAppSettingsInfo | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [snapshot, setSnapshot] = useState('');
  const [available, setAvailable] = useState<WhatsAppProviderTemplate[] | null>(null);
  const [busy, setBusy] = useState<'' | 'load' | 'save' | 'test' | 'send' | 'sync' | 'remove'>('load');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    api.getWhatsApp(organizationId)
      .then((data) => {
        setInfo(data);
        const f = formFrom(data);
        setForm(f);
        setSnapshot(JSON.stringify(f));
      })
      .catch(() => setMessage({ type: 'error', text: 'Couldn’t load your WhatsApp settings. Refresh to try again.' }))
      .finally(() => setBusy(''));
  }, [organizationId]);

  const spec = providerSpec(form.provider)!;
  const dirty = useMemo(() => snapshot !== '' && JSON.stringify(form) !== snapshot, [form, snapshot]);
  const savedProvider = info?.configured ? info.provider : null;

  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    setBusy(kind);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ type: 'error', text: errorText(err, 'That didn’t work. Try again.') });
    } finally {
      setBusy('');
    }
  };

  const apply = (data: WhatsAppSettingsInfo) => {
    setInfo(data);
    const f = formFrom(data);
    setForm(f);
    setSnapshot(JSON.stringify(f));
  };

  const save = () =>
    run('save', async () => {
      apply(await api.saveWhatsApp(organizationId, form));
      setMessage({ type: 'success', text: 'WhatsApp settings saved.' });
    });

  const setTemplate = (key: string, patch: Partial<WhatsAppTemplateMappingInfo> | null) =>
    setForm((f) => {
      const templates = { ...f.templates };
      if (patch === null) delete templates[key];
      else {
        const base: WhatsAppTemplateMappingInfo = templates[key] ?? { name: '', language: 'en', variables: [] };
        templates[key] = { ...base, ...patch };
      }
      return { ...f, templates };
    });

  const pickTemplate = (key: string, value: string) => {
    if (!value) return setTemplate(key, null);
    const t = available?.find((a) => `${a.name}|${a.language}|${a.contentSid || ''}` === value);
    if (!t) return;
    const current = form.templates[key]?.variables || [];
    const suggested = WHATSAPP_TEMPLATE_INFO[key as keyof typeof WHATSAPP_TEMPLATE_INFO].suggested;
    const variables = Array.from({ length: t.paramCount }, (_, i) => current[i] || suggested[i] || 'ticket');
    setTemplate(key, { name: t.name, language: t.language, status: t.status, category: t.category, contentSid: t.contentSid, variables });
  };

  if (!allowed) {
    return (
      <section aria-labelledby="s-whatsapp">
        <h2 id="s-whatsapp">WhatsApp</h2>
        <p className="settings-lede">Send queue updates and appointment reminders from your own WhatsApp number.</p>
        <p className="settings-locked"><Lock size={18} /> WhatsApp messages aren’t included in your plan. <a href="/admin/billing">See plans</a></p>
      </section>
    );
  }

  if (busy === 'load') return <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner" /></div>;

  const state = !info?.configured ? 'Not set up' : info.isEnabled ? 'On' : 'Off';

  return (
    <section aria-labelledby="s-whatsapp" className="wa">
      <h2 id="s-whatsapp">WhatsApp</h2>
      <p className="settings-lede">
        Send queue updates and appointment reminders from your own WhatsApp number. {person} still see live updates on their ticket page,
        and messages go out from your account, not your plan’s message credits.
      </p>

      <p className="domain-status wa-status">
        <strong><MessageCircle size={16} aria-hidden="true" /> {savedProvider ? providerSpec(savedProvider)?.label : 'WhatsApp'}</strong>
        <span data-verified={state === 'On'}>{state === 'On' ? <><CheckCircle2 size={14} /> On</> : state}</span>
        {info?.lastTestedAt && (
          <small data-ok={!!info.lastTestOk}>{info.lastTestOk ? 'Connection checked' : 'Last check failed'}: {info.lastTestMessage}</small>
        )}
      </p>

      {message && <div className={`inline-alert inline-alert-${message.type}`} role="status" style={{ marginBottom: '1rem' }}>{message.text}</div>}

      <h3>Provider</h3>
      <div className="mode-cards wa-providers" role="radiogroup" aria-label="WhatsApp provider">
        {WHATSAPP_PROVIDERS.map((p) => (
          <label key={p.id} className="mode-card" data-selected={form.provider === p.id}>
            <input type="radio" name="wa-provider" value={p.id} checked={form.provider === p.id} onChange={() => setForm({ ...form, provider: p.id, settings: p.id === savedProvider ? { ...(info?.settings || {}) } : {}, secrets: {}, templates: p.id === savedProvider ? { ...(info?.templates || {}) } : {} })} />
            <strong>{p.label}</strong>
            <small>{p.note}</small>
          </label>
        ))}
      </div>

      <h3>Account details</h3>
      <div className="settings-grid">
        {spec.fields.map((f) => (
          <label key={f.key} className="settings-field">
            <span>{f.label}{!f.required && <small> (optional)</small>}</span>
            <input value={form.settings[f.key] || ''} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, settings: { ...form.settings, [f.key]: e.target.value } })} />
            {f.hint && <small>{f.hint}</small>}
          </label>
        ))}
        {spec.secrets.map((f) => {
          const saved = form.provider === savedProvider ? info?.secretsMasked?.[f.key] : null;
          return (
            <label key={f.key} className="settings-field">
              <span>{f.label}{!f.required && <small> (optional)</small>}</span>
              <input
                type="password"
                autoComplete="off"
                value={form.secrets[f.key] || ''}
                placeholder={saved ? `Saved ${saved.slice(-8)}. Leave blank to keep it.` : f.placeholder}
                onChange={(e) => setForm({ ...form, secrets: { ...form.secrets, [f.key]: e.target.value } })}
              />
              {f.hint && <small>{f.hint}</small>}
            </label>
          );
        })}
      </div>
      <p className="settings-note"><Lock size={13} aria-hidden="true" /> Tokens and secrets are encrypted and never shown again after you save.</p>

      <h3>Webhook</h3>
      <p className="settings-note">
        {form.provider === 'meta_cloud' && 'In your Meta app, under WhatsApp → Configuration, set the callback URL and verify token below, and subscribe to the messages field. Delivery receipts and replies (including STOP) come back here.'}
        {form.provider === 'twilio' && 'Delivery receipts come back here on their own. In Twilio, set this as the “When a message comes in” URL of your WhatsApp sender so replies (including STOP) reach us.'}
        {form.provider === 'whatsapp_web' && 'On the WhatsApp server, set WHATSAPP_WEBHOOK to this URL and WHATSAPP_WEBHOOK_SECRET to the secret below.'}
      </p>
      {info && <CopyField label="Callback URL" value={info.webhookUrl} />}
      {form.provider === 'meta_cloud' && info?.verifyToken && <CopyField label="Verify token" value={info.verifyToken} />}
      {form.provider === 'whatsapp_web' && info?.webhookSecret && <CopyField label="Webhook secret" value={info.webhookSecret} />}
      {form.provider !== savedProvider && <p className="settings-note">Save to get the {form.provider === 'meta_cloud' ? 'verify token' : form.provider === 'whatsapp_web' ? 'webhook secret' : 'settings'} for this provider.</p>}

      <h3>Who gets messages</h3>
      <div className="settings-grid">
        <label className="settings-field">
          <span>Consent</span>
          <select value={form.consentMode} onChange={(e) => setForm({ ...form, consentMode: e.target.value as Form['consentMode'] })}>
            <option value="EXPLICIT">Only people who opt in</option>
            <option value="IMPLIED">Anyone who gives a number</option>
          </select>
          <small>
            {form.consentMode === 'EXPLICIT'
              ? `${person} tick “Send me updates on WhatsApp” when they join, or message you START.`
              : `The join form says updates come on WhatsApp. Anyone can reply STOP to opt out.`}
          </small>
        </label>
        <label className="settings-field">
          <span>Country code for local numbers</span>
          <input value={form.defaultCountryCode} inputMode="numeric" maxLength={5} placeholder="233" onChange={(e) => setForm({ ...form, defaultCountryCode: e.target.value.replace(/[^\d+]/g, '') })} />
          <small>So 020 000 0000 becomes +233 20 000 0000.</small>
        </label>
      </div>
      {info?.contacts && (info.contacts.optedIn > 0 || info.contacts.optedOut > 0) && (
        <p className="settings-note">{info.contacts.optedIn} {info.contacts.optedIn === 1 ? 'number has' : 'numbers have'} opted in; {info.contacts.optedOut} opted out.</p>
      )}
      <div className="settings-switches">
        <Switch label={`Send ${person.toLowerCase()} their updates on WhatsApp`} checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} />
        <Switch label="Send a text message instead when WhatsApp can’t deliver" checked={form.fallbackToSms} onChange={(e) => setForm({ ...form, fallbackToSms: e.target.checked })} />
      </div>
      <p className="settings-note">When WhatsApp delivers, no text message is sent for the same update. Text messages use your plan’s message credits.</p>

      {spec.templates ? (
        <>
          <h3>Templates</h3>
          <p className="settings-note wa-window">
            <AlertTriangle size={15} aria-hidden="true" /> WhatsApp only lets businesses start a conversation with a template it has approved.
            Within 24 hours of a person writing to you, the standard wording is sent instead. Without an approved template, that update goes by text (if on) or not at all.
          </p>
          <div className="wa-template-actions">
            <Button type="button" variant="secondary" size="sm" disabled={busy !== '' || form.provider !== savedProvider} onClick={() => run('sync', async () => {
              const result = await api.syncWhatsAppTemplates(organizationId);
              setAvailable(result.available);
              setForm((f) => ({ ...f, templates: { ...f.templates, ...Object.fromEntries(Object.entries(result.templates).map(([k, t]) => [k, { ...f.templates[k], status: t.status }])) } }));
              setMessage({ type: 'success', text: `Loaded ${result.available.length} template${result.available.length === 1 ? '' : 's'} from ${spec.label}.` });
            })}>
              <RefreshCw size={15} /> {busy === 'sync' ? 'Loading…' : 'Load templates'}
            </Button>
            {form.provider !== savedProvider && <small>Save the account details first.</small>}
          </div>
          <ul className="wa-templates">
            {WHATSAPP_TEMPLATE_KEYS.map((key) => {
              const t = form.templates[key];
              const meta = WHATSAPP_TEMPLATE_INFO[key];
              const tone = t ? STATUS_TONE[String(t.status || 'UNKNOWN')] ?? 'warn' : undefined;
              return (
                <li key={key}>
                  <div className="wa-template-head">
                    <div>
                      <strong>{meta.label}</strong>
                      <small>{meta.example}</small>
                    </div>
                    {t ? <span className="wa-pill" data-tone={tone}>{statusLabel(t.status)}</span> : <span className="wa-pill">No template</span>}
                  </div>
                  <div className="wa-template-body">
                    {available ? (
                      <select aria-label={`Template for ${meta.label}`} value={t ? `${t.name}|${t.language}|${t.contentSid || ''}` : ''} onChange={(e) => pickTemplate(key, e.target.value)}>
                        <option value="">No template</option>
                        {t && !available.some((a) => a.name === t.name && a.language === t.language) && <option value={`${t.name}|${t.language}|${t.contentSid || ''}`}>{t.name} ({t.language})</option>}
                        {available.map((a) => (
                          <option key={`${a.name}|${a.language}|${a.contentSid || ''}`} value={`${a.name}|${a.language}|${a.contentSid || ''}`}>
                            {a.name} ({a.language}) · {statusLabel(a.status)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input aria-label={`Template name for ${meta.label}`} placeholder="Template name, e.g. queue_joined" value={t?.name || ''} onChange={(e) => (e.target.value ? setTemplate(key, { name: e.target.value, status: 'UNKNOWN' }) : setTemplate(key, null))} />
                    )}
                    {t && (
                      <input className="wa-lang" aria-label={`Language for ${meta.label}`} value={t.language} onChange={(e) => setTemplate(key, { language: e.target.value })} placeholder="en_US" />
                    )}
                    {t && form.provider === 'twilio' && !available && (
                      <input aria-label={`Content SID for ${meta.label}`} value={t.contentSid || ''} onChange={(e) => setTemplate(key, { contentSid: e.target.value.trim() })} placeholder="HX…" />
                    )}
                  </div>
                  {t && (
                    <div className="wa-params">
                      {t.variables.map((v, i) => (
                        <span key={i} className="wa-param">
                          <b>{`{{${i + 1}}}`}</b>
                          <select aria-label={`Value ${i + 1} for ${meta.label}`} value={v} onChange={(e) => setTemplate(key, { variables: t.variables.map((x, j) => (j === i ? e.target.value : x)) })}>
                            {Object.entries(WHATSAPP_VARIABLES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                          </select>
                          <button type="button" aria-label={`Remove value ${i + 1}`} onClick={() => setTemplate(key, { variables: t.variables.filter((_, j) => j !== i) })}><X size={14} /></button>
                        </span>
                      ))}
                      {t.variables.length < 10 && (
                        <button type="button" className="displays-link" onClick={() => setTemplate(key, { variables: [...t.variables, meta.suggested[t.variables.length] || 'ticket'] })}>
                          <Plus size={14} /> Add a value
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <h3>Messages</h3>
          <p className="settings-note">A linked phone sends the standard wording as ordinary messages, so there are no templates to set up. Keep the phone online and linked.</p>
        </>
      )}

      <h3>Send a test message</h3>
      <div className="settings-inline">
        <input aria-label="Phone number for the test" type="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+233 20 000 0000" />
        <Button type="button" variant="secondary" disabled={busy !== '' || !testTo.trim() || !info?.configured || dirty} onClick={() => run('send', async () => {
          const result = await api.sendWhatsAppTest(organizationId, testTo);
          setMessage({ type: 'success', text: result.via === 'template' ? 'Sent as a template. Check WhatsApp on that phone.' : 'Sent. Check WhatsApp on that phone.' });
        })}>
          <Send size={16} /> {busy === 'send' ? 'Sending…' : 'Send test'}
        </Button>
      </div>
      <p className="settings-note">
        {spec.templates
          ? `Uses your saved settings. To a number that hasn’t written to you in 24 hours, the “Joined the queue” template is sent${form.provider === 'meta_cloud' ? ' (or Meta’s hello_world)' : ''}.`
          : 'Uses your saved settings and sends a plain message from the linked phone.'}
      </p>

      <div className="settings-savebar" data-dirty={dirty}>
        <span role="status">{dirty ? 'You have unsaved changes.' : info?.configured ? 'All changes saved.' : 'Not set up yet.'}</span>
        <div className="wa-bar-actions">
          {info?.configured && (
            <Button type="button" variant="ghost" disabled={busy !== ''} onClick={async () => {
              if (!(await confirmDialog({ title: 'Remove WhatsApp?', message: 'Messages go back to email and text only.', confirmLabel: 'Remove', tone: 'danger' }))) return;
              run('remove', async () => {
                apply(await api.deleteWhatsApp(organizationId));
                setAvailable(null);
                setMessage({ type: 'success', text: 'WhatsApp removed.' });
              });
            }}>Remove</Button>
          )}
          <Button type="button" variant="secondary" disabled={busy !== '' || !info?.configured || dirty} onClick={() => run('test', async () => {
            try {
              const result = await api.testWhatsApp(organizationId);
              setMessage({ type: 'success', text: result.message });
            } finally {
              setInfo(await api.getWhatsApp(organizationId));
            }
          })}>
            <Plug size={16} /> {busy === 'test' ? 'Checking…' : 'Test connection'}
          </Button>
          <Button type="button" onClick={save} disabled={busy !== '' || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </section>
  );
}
