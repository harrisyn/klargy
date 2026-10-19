'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';

/** Platform admin pages share the app shell; only platform admins get in. */
export default function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || user.role !== 'SUPER_ADMIN')) router.push('/login');
  }, [user, loading, router]);

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center' }}><div className="spinner" /></div>;
  if (!user || user.role !== 'SUPER_ADMIN') return null;
  return <Layout><div className="sa-compact">{children}</div></Layout>;
}
