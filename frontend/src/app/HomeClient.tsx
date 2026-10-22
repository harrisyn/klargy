'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthContext } from '@/contexts/AuthContext';
import DashboardPage from '@/components/pages/DashboardPage';
import LandingPage from '@/components/landing/LandingPage';
import { extractSubdomain, extractCustomDomainCandidate } from '@/lib/subdomain';

export default function HomeClient() {
  const { isAuthenticated, loading } = useAuthContext();
  const router = useRouter();
  // The marketing page belongs on the root domain only. A signed-out visitor
  // on a tenant's own address goes to that organization's sign-in.
  const [isTenantHost, setIsTenantHost] = useState<boolean | null>(null);

  useEffect(() => {
    const host = window.location.host;
    setIsTenantHost(!!extractSubdomain(host) || !!extractCustomDomainCandidate(host));
  }, []);

  useEffect(() => {
    if (!loading && !isAuthenticated && isTenantHost) router.replace('/login');
  }, [loading, isAuthenticated, isTenantHost, router]);

  if (loading || isTenantHost === null) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)' }}>
        <div className="spinner" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  if (isAuthenticated) return <DashboardPage />;
  if (isTenantHost) return null;
  return <LandingPage />;
}
