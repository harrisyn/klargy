'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, CheckCircle2, Gift, DollarSign, MapPin, Users, Plus, Search, LayoutDashboard } from 'lucide-react';
import api from '@/api/client';
import { Icon, PageHeader, Card, Badge, Button } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';

interface DashboardStats {
  stats: {
    totalOrganizations: number;
    activeSubscriptions: number;
    trialSubscriptions: number;
    cancelledSubscriptions: number;
    totalLocations: number;
    totalUsers: number;
    mrr: string;
    mrrCurrency?: string;
  };
  planBreakdown: Array<{
    id: string;
    name: string;
    code: string;
    activeCount: number;
  }>;
  recentOrganizations: Array<{
    id: string;
    name: string;
    email: string;
    createdAt: string;
    subscription?: {
      status: string;
      plan?: { name: string; code: string };
    };
    _count: { locations: number; users: number };
  }>;
}

export default function SuperadminDashboard() {
  const [data, setData] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const result = await api.getSuperadminDashboard();
      setData(result);
    } catch (err) {
      console.error('Failed to load dashboard', err);
      setError('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={loadingContainer}>
        <div className="spinner" />
        <p style={{ color: 'var(--gray-500)' }}>Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorContainer}>
        <p style={{ color: 'var(--error-600)' }}>{error}</p>
        <Button variant="primary" onClick={loadDashboard}>Retry</Button>
      </div>
    );
  }

  const { stats, planBreakdown, recentOrganizations } = data!;

  return (
    <div style={pageContainer}>
      <PageHeader title="Platform overview" subtitle="Every organization on the platform, at a glance." icon={LayoutDashboard} />

      <section className="today-numbers sa-numbers" aria-label="Platform totals">
        <div><b>{stats.totalOrganizations}</b><span>organizations</span></div>
        <div><b>{stats.activeSubscriptions}</b><span>paying or active plans</span></div>
        <div><b>{stats.trialSubscriptions}</b><span>on a trial</span></div>
        <div><b>{stats.mrrCurrency ?? 'USD'} {stats.mrr}</b><span>monthly revenue</span></div>
        <div><b>{stats.totalLocations}</b><span>locations</span></div>
        <div><b>{stats.totalUsers}</b><span>people with accounts</span></div>
      </section>

      {/* Main Content */}
      <div style={contentGrid}>
        {/* Plan Breakdown */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Organizations by plan</h2>
            <Link href="/superadmin/plans" style={cardLink}>Manage Plans →</Link>
          </div>
          <div style={planList}>
            {planBreakdown.map(plan => (
              <div key={plan.id} style={planItem}>
                <div style={planInfo}>
                  <span style={planName}>{plan.name}</span>
                  <span style={planCode}>{plan.code}</span>
                </div>
                <div style={planCount}>
                  <span style={countValue}>{plan.activeCount}</span>
                  <span style={countLabel}>orgs</span>
                </div>
              </div>
            ))}
            {planBreakdown.length === 0 && (
              <div style={emptyState}>
                <p>No subscription plans created yet.</p>
                <Link href="/superadmin/plans" style={createLink}>Create your first plan →</Link>
              </div>
            )}
          </div>
        </Card>

        {/* Recent Organizations */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Newest organizations</h2>
            <Link href="/superadmin/organizations" style={cardLink}>View All →</Link>
          </div>
          <div style={orgList}>
            {recentOrganizations.map(org => (
              <Link key={org.id} href={`/superadmin/organizations/${org.id}`} style={orgItem}>
                <div style={orgInfo}>
                  <span style={orgName}>{org.name}</span>
                  <span style={orgEmail}>{org.email || 'No email'}</span>
                </div>
                <div style={orgMeta}>
                  <Badge tone={getStatusTone(org.subscription?.status)}>{org.subscription?.status || 'No Plan'}</Badge>
                  <span style={orgStats}>
                    {org._count.locations} {org._count.locations === 1 ? 'location' : 'locations'}, {org._count.users} {org._count.users === 1 ? 'person' : 'people'}
                  </span>
                </div>
              </Link>
            ))}
            {recentOrganizations.length === 0 && (
              <div style={emptyState}>
                <p>No organizations yet.</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card style={{ padding: '1.5rem' }}>
        <h3 style={actionsTitle}>Quick Actions</h3>
        <div style={actionsGrid}>
          <Link href="/superadmin/plans" style={actionBtn}>
            <Icon icon={Plus} size={16} />
            <span>Create Plan</span>
          </Link>
          <Link href="/superadmin/organizations" style={actionBtn}>
            <Icon icon={Search} size={16} />
            <span>Search Orgs</span>
          </Link>
        </div>
      </Card>
    </div>
  );
}

const getStatusTone = (status?: string): BadgeTone => {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'TRIAL':
      return 'primary';
    case 'PAST_DUE':
      return 'warning';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'error';
    default:
      return 'neutral';
  }
};

// Styles
const loadingContainer: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '50vh',
  gap: '1rem',
};

const errorContainer: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '50vh',
  gap: '1rem',
};

const pageContainer: React.CSSProperties = {
  maxWidth: '1400px',
  margin: 0,
};

const statsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: '1rem',
  marginBottom: '1.5rem',
};

const statCard: React.CSSProperties = {
  padding: '1.5rem',
  display: 'flex',
  alignItems: 'center',
  gap: '1rem',
};

const statIconWrap: React.CSSProperties = {
  width: '48px',
  height: '48px',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--primary-50)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const statContent: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

const statValue: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 700,
  color: 'var(--gray-900)',
};

const statLabel: React.CSSProperties = {
  fontSize: '0.875rem',
  color: 'var(--gray-500)',
};

const contentGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
  gap: '1.5rem',
  marginBottom: '1.5rem',
};

const cardHeader: React.CSSProperties = {
  padding: '1.25rem 1.5rem',
  borderBottom: '1px solid var(--gray-100)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const cardTitle: React.CSSProperties = {
  fontSize: '1.125rem',
  fontWeight: 700,
  color: 'var(--gray-900)',
};

const cardLink: React.CSSProperties = {
  color: 'var(--primary-600)',
  textDecoration: 'none',
  fontSize: '0.875rem',
  fontWeight: 500,
};

const planList: React.CSSProperties = {
  padding: '0.75rem',
};

const planItem: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1rem',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--gray-50)',
  marginBottom: '0.5rem',
};

const planInfo: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const planName: React.CSSProperties = {
  color: 'var(--gray-900)',
  fontWeight: 600,
};

const planCode: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
  fontFamily: 'var(--font-mono)',
};

const planCount: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.25rem',
};

const countValue: React.CSSProperties = {
  fontSize: '1.5rem',
  fontWeight: 700,
  color: 'var(--primary-600)',
};

const countLabel: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
};

const orgList: React.CSSProperties = {
  padding: '0.75rem',
};

const orgItem: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1rem',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--gray-50)',
  marginBottom: '0.5rem',
  textDecoration: 'none',
  cursor: 'pointer',
  transition: 'background var(--transition-fast)',
};

const orgInfo: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const orgName: React.CSSProperties = {
  color: 'var(--gray-900)',
  fontWeight: 600,
};

const orgEmail: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.875rem',
};

const orgMeta: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: '0.375rem',
};

const orgStats: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
};

const emptyState: React.CSSProperties = {
  padding: '2rem',
  textAlign: 'center' as const,
  color: 'var(--gray-400)',
};

const createLink: React.CSSProperties = {
  color: 'var(--primary-600)',
  textDecoration: 'none',
  display: 'block',
  marginTop: '0.5rem',
};

const actionsTitle: React.CSSProperties = {
  fontSize: '1rem',
  fontWeight: 700,
  color: 'var(--gray-900)',
  marginBottom: '1rem',
};

const actionsGrid: React.CSSProperties = {
  display: 'flex',
  gap: '1rem',
  flexWrap: 'wrap' as const,
};

const actionBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.25rem',
  background: 'var(--primary-50)',
  border: '1px solid var(--primary-100)',
  borderRadius: 'var(--radius-lg)',
  color: 'var(--primary-700)',
  textDecoration: 'none',
  fontSize: '0.875rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'all var(--transition-fast)',
};
