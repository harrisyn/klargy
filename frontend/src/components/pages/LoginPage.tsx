'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, X, Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuthContext } from '@/contexts/AuthContext';
import { extractSubdomain, extractCustomDomainCandidate, buildTenantUrl, buildRootUrl } from '@/lib/subdomain';
import { api } from '@/api/client';
import AuthLayout from '@/components/auth/AuthLayout';
import { AuthAlert } from '@/components/auth/AuthShell';

type SlugStatus = 'idle' | 'checking' | 'found' | 'not-found';

interface Branding {
  name: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
}

const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [hostChecked, setHostChecked] = useState(false);
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [slugStatus, setSlugStatus] = useState<SlugStatus>('idle');
  const [foundOrgName, setFoundOrgName] = useState('');
  const [redirecting, setRedirecting] = useState(false);
  const [branding, setBranding] = useState<Branding | null>(null);
  const { login } = useAuthContext();
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const host = window.location.host;
    const sub = extractSubdomain(host);
    if (sub) {
      setSubdomain(sub);
      setHostChecked(true);
      return;
    }
    // Not a <slug>.APP_DOMAIN host - it might still be a verified custom
    // domain an org has pointed at this app. Resolve it the same way.
    const candidate = extractCustomDomainCandidate(host);
    if (!candidate) {
      setHostChecked(true);
      return;
    }
    api.getOrgByDomain(candidate)
      .then((org) => setSubdomain(org?.slug ?? null))
      .catch(() => setSubdomain(null))
      .finally(() => setHostChecked(true));
  }, []);

  useEffect(() => {
    if (!subdomain || subdomain === 'admin') return;
    api.getOrgBySlug(subdomain)
      .then((org) => org && setBranding({ name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor }))
      .catch(() => {});
  }, [subdomain]);

  // Live-validate the workspace address as it's typed, so a typo shows up
  // before the redirect (and the workspace-not-found bounce).
  useEffect(() => {
    const slug = workspaceSlug.trim().toLowerCase();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!slug) {
      setSlugStatus('idle');
      setFoundOrgName('');
      return;
    }
    setSlugStatus('checking');
    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const org = await api.getOrgBySlug(slug);
        if (requestId !== requestIdRef.current) return;
        setSlugStatus(org ? 'found' : 'not-found');
        setFoundOrgName(org?.name ?? '');
      } catch {
        if (requestId !== requestIdRef.current) return;
        setSlugStatus('idle');
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [workspaceSlug]);

  const handleFindWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    const slug = workspaceSlug.trim().toLowerCase();
    if (!slug || slugStatus === 'not-found') return;
    setRedirecting(true);
    window.location.href = buildTenantUrl(slug, '/login');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const options = subdomain === 'admin' ? { adminLogin: true } : subdomain ? { slug: subdomain } : undefined;
      const success = await login(email, password, options);
      if (success) router.push('/');
      else setError('That email and password don’t match an account here.');
    } catch (err: unknown) {
      const message = (err as Error).message;
      setError(message === 'Invalid credentials' ? 'That email and password don’t match an account here.' : message || 'Sign-in failed. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const isAdmin = subdomain === 'admin';
  const isLookupStep = hostChecked && !subdomain;
  const rootHost = buildRootUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');

  const panelText = isAdmin
    ? 'Manage organizations, plans and platform settings.'
    : isLookupStep
      ? 'Each organization has its own address. Tell us yours and we’ll take you to its sign-in.'
      : `Sign in to run today’s queues${branding?.name ? ` at ${branding.name}` : ''}.`;

  return (
    <AuthLayout
      orgName={isAdmin ? 'Platform admin' : branding?.name}
      logoUrl={branding?.logoUrl}
      accentColor={branding?.primaryColor}
      panelText={panelText}
      footer={
        isLookupStep ? (
          <>New here? <Link href="/register">Create an organization</Link></>
        ) : !isAdmin ? (
          <>People joining your queues don’t need an account. They scan the QR code at your location.</>
        ) : undefined
      }
    >
      {!hostChecked ? (
        <Loader2 className="qf-spin" size={22} aria-label="Loading" />
      ) : isLookupStep ? (
        <>
          <h1>Find your workspace</h1>
          <p className="authx-sub">Enter your organization’s address.</p>
          <form onSubmit={handleFindWorkspace} className="authx-fields">
            <div className="field">
              <label htmlFor="workspace" className="field-label">Workspace address</label>
              <div className="authx-suffix">
                <input
                  id="workspace"
                  type="text"
                  value={workspaceSlug}
                  onChange={(e) => setWorkspaceSlug(e.target.value)}
                  placeholder="your-business"
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  required
                />
                <span>.{rootHost}</span>
              </div>
              {slugStatus === 'checking' && <p className="authx-hint">Checking…</p>}
              {slugStatus === 'found' && (
                <p className="authx-hint authx-hint-ok"><Check size={13} /> {foundOrgName}</p>
              )}
              {slugStatus === 'not-found' && (
                <p className="authx-hint authx-hint-bad"><X size={13} /> No workspace at that address. Check the spelling.</p>
              )}
            </div>
            <button type="submit" className="authx-submit" disabled={!workspaceSlug.trim() || slugStatus !== 'found' || redirecting}>
              {redirecting ? <Loader2 className="qf-spin" size={18} /> : null}
              {redirecting ? `Opening ${foundOrgName || 'workspace'}…` : 'Continue'}
            </button>
          </form>
        </>
      ) : (
        <>
          <h1>{isAdmin ? 'Platform sign in' : 'Sign in'}</h1>
          <p className="authx-sub">{isAdmin ? 'Super admin accounts only.' : 'Use the email your admin invited you with.'}</p>
          {error && <AuthAlert tone="error">{error}</AuthAlert>}
          <form onSubmit={handleSubmit} className="authx-fields">
            <div className="field">
              <label htmlFor="email" className="field-label">Email</label>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
            </div>
            <div className="field">
              <div className="authx-label-row">
                <label htmlFor="password" className="field-label">Password</label>
                <Link href="/forgot-password">Forgot password?</Link>
              </div>
              <div className="authx-password">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button type="submit" className="authx-submit" disabled={loading}>
              {loading && <Loader2 className="qf-spin" size={18} />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
            {subdomain && !isAdmin && (
              <a href={buildRootUrl('/login')} className="authx-hint" style={{ textAlign: 'center' }}>
                Not {branding?.name || 'your workspace'}? Find another
              </a>
            )}
          </form>
        </>
      )}
    </AuthLayout>
  );
};

export default LoginPage;
