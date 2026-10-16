'use client';

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/api/client';
import { Button, Input } from '@/components/ui';
import { AuthShell, AuthAlert, apiErrorMessage } from '@/components/auth/AuthShell';
import { buildAdminUrl } from '@/lib/subdomain';

/** First-run setup: creates the platform's first superadmin. */
export default function SetupPage() {
  const [token, setToken] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.completeSetup({ token: token.trim(), firstName, lastName, email, password });
      setDone(true);
      window.setTimeout(() => {
        window.location.href = buildAdminUrl('/login');
      }, 1500);
    } catch (err) {
      setError(apiErrorMessage(err, 'Setup failed. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Set up your platform"
      subtitle="Create the superadmin account. The setup token is the SETUP_TOKEN environment variable, or, if that isn't set, the token printed in the server log."
    >
      {error && <AuthAlert tone="error">{error}</AuthAlert>}
      {done ? (
        <AuthAlert tone="success">Superadmin created. Taking you to the sign-in page…</AuthAlert>
      ) : (
        <form className="auth-form" onSubmit={handleSubmit}>
          <Input label="Setup token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoFocus required />
          <Input label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
          <Input label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
          <Input label="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <Button type="submit" size="lg" disabled={submitting}>
            {submitting && <Loader2 className="qf-spin" size={18} />}
            <span>{submitting ? 'Creating…' : 'Create superadmin'}</span>
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
