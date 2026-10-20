'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Eye, EyeOff, Check, X } from 'lucide-react';
import { api } from '@/api/client';
import AuthLayout from '@/components/auth/AuthLayout';
import { AuthAlert, apiErrorMessage } from '@/components/auth/AuthShell';
import { buildTenantUrl, buildRootUrl } from '@/lib/subdomain';
import { isReservedSlug } from '@/lib/reservedSlugs';

/**
 * Organization sign-up in two short steps:
 *   1. who you are + the organization (workspace address suggested for you)
 *   2. the 6-digit code we email - entering it creates the workspace
 * then straight into the new workspace, signed in, at /welcome.
 */

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

type SlugState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid';

/** The currency people in a time zone most likely use, or null. */
function guessCurrency(timeZone: string): string | null {
  const byZone: Record<string, string> = {
    'Africa/Accra': 'GHS', 'Africa/Lagos': 'NGN', 'Africa/Nairobi': 'KES', 'Africa/Johannesburg': 'ZAR', 'Africa/Kampala': 'UGX',
    'Africa/Dar_es_Salaam': 'TZS', 'Africa/Kigali': 'RWF', 'Africa/Cairo': 'EGP', 'Europe/London': 'GBP', 'Europe/Dublin': 'EUR',
    'Europe/Paris': 'EUR', 'Europe/Berlin': 'EUR', 'Europe/Madrid': 'EUR', 'Europe/Rome': 'EUR', 'Asia/Kolkata': 'INR',
    'Asia/Dubai': 'AED', 'Australia/Sydney': 'AUD', 'America/Toronto': 'CAD', 'America/New_York': 'USD', 'America/Chicago': 'USD',
    'America/Los_Angeles': 'USD',
  };
  return byZone[timeZone] ?? null;
}

export default function RegisterPage() {
  const [step, setStep] = useState<'details' | 'code' | 'done'>('details');
  const [form, setForm] = useState({ organizationName: '', firstName: '', lastName: '', email: '', password: '' });
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [currency, setCurrency] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugState, setSlugState] = useState<SlugState>('idle');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const checkRef = useRef(0);

  const rootHost = buildRootUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Supported currencies, preselecting the likely one for where the visitor is.
  useEffect(() => {
    api.getPublicCurrencies()
      .then(({ base, currencies: list }) => {
        setCurrencies(list);
        const guess = guessCurrency(Intl.DateTimeFormat().resolvedOptions().timeZone);
        setCurrency(guess && list.includes(guess) ? guess : base);
      })
      .catch(() => {});
  }, []);

  // Suggest the workspace address from the organization name until the
  // person edits it themselves.
  useEffect(() => {
    if (!slugEdited) setSlug(slugify(form.organizationName));
  }, [form.organizationName, slugEdited]);

  useEffect(() => {
    if (!slug) return setSlugState('idle');
    if (slug.length < 3 || isReservedSlug(slug) || slugify(slug) !== slug) return setSlugState('invalid');
    setSlugState('checking');
    const id = ++checkRef.current;
    const t = setTimeout(() => {
      api.getOrgBySlug(slug)
        .then((org) => id === checkRef.current && setSlugState(org ? 'taken' : 'free'))
        .catch(() => id === checkRef.current && setSlugState('free'));
    }, 350);
    return () => clearTimeout(t);
  }, [slug]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const sendCode = async () => {
    await api.sendOTP(form.email.trim());
    setResendIn(45);
  };

  const submitDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 8) return setError('Use at least 8 characters for your password.');
    if (slugState === 'taken') return setError('That workspace address is taken. Choose another.');
    if (slugState === 'invalid') return setError('Workspace addresses use 3 or more lowercase letters, numbers and dashes.');
    setBusy(true);
    try {
      await sendCode();
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err, 'We couldn’t send the code. Check the email address and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) return;
    setError('');
    setBusy(true);
    try {
      await api.verifyOTP(form.email.trim(), code);
      const { token, organization } = await api.registerOrganization({
        organizationName: form.organizationName.trim(),
        email: form.email.trim(),
        adminFirstName: form.firstName.trim(),
        adminLastName: form.lastName.trim(),
        adminPassword: form.password,
        slug: slug || undefined,
        currency: currency || undefined,
      });
      setStep('done');
      // Sign-in lives per address, so carry the session over in the URL
      // fragment (never sent to a server) to the new workspace.
      window.location.href = `${buildTenantUrl(organization.slug, '/welcome')}#session=${encodeURIComponent(token)}`;
    } catch (err) {
      setError(apiErrorMessage(err, 'That code didn’t work. Check it and try again.'));
      setBusy(false);
    }
  };

  // Submit as soon as six digits are in.
  useEffect(() => {
    if (step === 'code' && code.length === 6 && !busy) submitCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const slugHint =
    slugState === 'checking' ? <span className="authx-hint">Checking…</span>
    : slugState === 'taken' ? <span className="authx-hint authx-hint-bad"><X size={13} /> Taken. Try another.</span>
    : slugState === 'invalid' ? <span className="authx-hint authx-hint-bad"><X size={13} /> 3+ lowercase letters, numbers or dashes</span>
    : slugState === 'free' ? <span className="authx-hint authx-hint-ok"><Check size={13} /> Available</span>
    : null;

  return (
    <AuthLayout
      panelTitle="Your queue, live today."
      panelText="Create your workspace, add a location and a service, and people can scan in and join before the end of the day. The free plan covers one location."
      footer={<>Already use it? <Link href="/login">Sign in</Link></>}
    >
      <div className="authx-steps" aria-hidden="true">
        <span data-done="true" />
        <span data-done={step !== 'details'} />
        <span data-done={step === 'done'} />
      </div>

      {step === 'details' && (
        <>
          <h1>Create your workspace</h1>
          <p className="authx-sub">Takes about a minute. No card needed.</p>
          {error && <AuthAlert tone="error">{error}</AuthAlert>}
          <form className="authx-fields" onSubmit={submitDetails}>
            <div className="field">
              <label htmlFor="org" className="field-label">Organization</label>
              <input id="org" value={form.organizationName} onChange={set('organizationName')} placeholder="e.g. Ridge Studio, Ridge Bank, Ridge Clinic" autoComplete="organization" autoFocus required />
              {slug && !editingSlug && (
                <p className="authx-hint">
                  Your address: <strong>{slug}.{rootHost}</strong>{' '}
                  <button type="button" className="authx-linkbtn" onClick={() => setEditingSlug(true)}>Change</button>{' '}
                  {slugHint}
                </p>
              )}
            </div>
            {editingSlug && (
              <div className="field">
                <label htmlFor="slug" className="field-label">Workspace address</label>
                <div className="authx-suffix">
                  <input
                    id="slug"
                    value={slug}
                    onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }}
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <span>.{rootHost}</span>
                </div>
                {slugHint && <p className="authx-hint" style={{ marginTop: 6 }}>{slugHint}</p>}
              </div>
            )}
            <div className="authx-row">
              <div className="field">
                <label htmlFor="first" className="field-label">First name</label>
                <input id="first" value={form.firstName} onChange={set('firstName')} autoComplete="given-name" required />
              </div>
              <div className="field">
                <label htmlFor="last" className="field-label">Last name</label>
                <input id="last" value={form.lastName} onChange={set('lastName')} autoComplete="family-name" required />
              </div>
            </div>
            <div className="field">
              <label htmlFor="email" className="field-label">Work email</label>
              <input id="email" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
            </div>
            {currencies.length > 1 && (
              <div className="field">
                <label htmlFor="currency" className="field-label">Currency</label>
                <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="authx-hint">Used for your plan, your wallet and any prices you charge. You can’t change it once money has moved.</p>
              </div>
            )}
            <div className="field">
              <label htmlFor="password" className="field-label">Password</label>
              <div className="authx-password">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={set('password')}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <p className="authx-hint">At least 8 characters.</p>
            </div>
            <button type="submit" className="authx-submit" disabled={busy}>
              {busy && <Loader2 className="qf-spin" size={18} />}
              {busy ? 'Sending code…' : 'Continue'}
            </button>
            <p style={{ margin: 0, textAlign: 'center', fontSize: '0.8125rem', color: 'var(--gray-500)' }}>
              By continuing you agree to the <Link href="/terms">terms</Link> and <Link href="/privacy">privacy policy</Link>.
            </p>
          </form>
        </>
      )}

      {step !== 'details' && (
        <>
          <h1>Check your email</h1>
          <p className="authx-sub">
            We sent a 6-digit code to <strong>{form.email}</strong>. Enter it to create {form.organizationName || 'your workspace'}.
          </p>
          {error && <AuthAlert tone="error">{error}</AuthAlert>}
          {step === 'done' && <AuthAlert tone="success">Workspace created. Opening it now…</AuthAlert>}
          <form className="authx-fields authx-code" onSubmit={submitCode}>
            <div className="field">
              <label htmlFor="code" className="field-label">Code</label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
                disabled={busy}
              />
            </div>
            <button type="submit" className="authx-submit" disabled={busy || code.length !== 6}>
              {busy && <Loader2 className="qf-spin" size={18} />}
              {busy ? 'Creating your workspace…' : 'Create workspace'}
            </button>
            <div className="authx-label-row" style={{ fontSize: '0.875rem' }}>
              <button type="button" className="authx-linkbtn" onClick={() => { setStep('details'); setCode(''); setError(''); }} disabled={busy}>
                Change email
              </button>
              <button
                type="button"
                className="authx-linkbtn"
                disabled={resendIn > 0 || busy}
                onClick={() => sendCode().catch((err) => setError(apiErrorMessage(err, 'Couldn’t resend the code.')))}
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            </div>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
