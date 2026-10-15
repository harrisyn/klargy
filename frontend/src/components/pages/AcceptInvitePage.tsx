'use client';

import React, { useEffect, useState } from 'react';
import { ArrowRight, Loader2, Users } from 'lucide-react';
import { api } from '@/api/client';
import { Button, Input } from '@/components/ui';
import { AuthShell, AuthAlert, apiErrorMessage } from '@/components/auth/AuthShell';
import { buildTenantUrl, buildRootUrl } from '@/lib/subdomain';

type Preview = Awaited<ReturnType<typeof api.previewInvite>>;

const ROLE_LABELS: Record<string, string> = {
  ORG_ADMIN: 'Organization admin',
  LOCATION_ADMIN: 'Location admin',
  SERVICE_STAFF: 'Service staff',
  RECEPTIONIST: 'Receptionist',
};

export default function AcceptInvitePage({ code }: { code: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.previewInvite(code)
      .then((p) => {
        setPreview(p);
        // Invites sent by email arrive with the address already known.
        if (p.email) setForm((f) => ({ ...f, email: f.email || p.email! }));
      })
      .catch(() => setLoadError('This invite link is not valid. Check that you copied the whole link, or ask your admin for a new one.'));
  }, [code]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('Passwords do not match.');

    setSubmitting(true);
    try {
      const result = await api.acceptInvite({
        inviteToken: code,
        email: form.email,
        password: form.password,
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone || undefined,
      });
      setDone(true);
      const slug = result.organizationSlug || preview?.organization.slug;
      window.setTimeout(() => {
        window.location.href = slug ? buildTenantUrl(slug, '/login') : buildRootUrl('/login');
      }, 1500);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create your account. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <AuthShell title="Invite not found" footer={<a href={buildRootUrl('/login')}>Go to sign in</a>}>
        <AuthAlert tone="error">{loadError}</AuthAlert>
      </AuthShell>
    );
  }

  if (!preview) {
    return (
      <AuthShell title="Checking your invite">
        <Loader2 className="qf-spin" size={22} color="#0f9fa4" aria-label="Loading" />
      </AuthShell>
    );
  }

  const { organization } = preview;
  const loginUrl = organization.slug ? buildTenantUrl(organization.slug, '/login') : buildRootUrl('/login');

  if (preview.status !== 'valid') {
    return (
      <AuthShell
        title={preview.status === 'used' ? 'Invite already used' : 'Invite expired'}
        brandName={organization.name}
        logoUrl={organization.logoUrl}
        footer={<a href={loginUrl}>Sign in to {organization.name}</a>}
      >
        <AuthAlert tone="error">
          {preview.status === 'used'
            ? 'This invite has already been used to create an account. If that was you, sign in instead.'
            : `This invite has expired. Ask an admin at ${organization.name} to send you a new one.`}
        </AuthAlert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Join ${organization.name}`}
      subtitle="Create your staff account to start managing queues."
      brandName={organization.name}
      logoUrl={organization.logoUrl}
      footer={<>Already have an account? <a href={loginUrl}>Sign in</a></>}
    >
      <div className="auth-meta">
        <Users size={16} aria-hidden="true" />
        <span>You&apos;re joining as <strong>{ROLE_LABELS[preview.role] || preview.role}</strong></span>
      </div>

      {error && <AuthAlert tone="error">{error}</AuthAlert>}
      {done && <AuthAlert tone="success">Account created. Taking you to sign in…</AuthAlert>}

      <form className="auth-form" onSubmit={handleSubmit}>
        <div className="auth-row">
          <Input label="First name" value={form.firstName} onChange={set('firstName')} autoComplete="given-name" required />
          <Input label="Last name" value={form.lastName} onChange={set('lastName')} autoComplete="family-name" required />
        </div>
        <Input label="Work email" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
        <Input label="Phone" type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" hint="Optional" />
        <Input label="Password" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" hint="At least 8 characters" required />
        <Input label="Confirm password" type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        <Button type="submit" size="lg" disabled={submitting || done}>
          {submitting && <Loader2 className="qf-spin" size={18} />}
          <span>{submitting ? 'Creating account…' : 'Create account'}</span>
          {!submitting && <ArrowRight size={18} aria-hidden="true" />}
        </Button>
      </form>
    </AuthShell>
  );
}
