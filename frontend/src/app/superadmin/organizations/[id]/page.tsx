'use client';

import React, { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, X, UserCog, PauseCircle, PlayCircle } from 'lucide-react';
import api from '@/api/client';
import { Icon, Card, Badge, Button, UsageBar, Input, Select } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { buildTenantUrl } from '@/lib/subdomain';
import { confirmDialog, promptDialog } from '@/lib/dialog';
import { OrgWalletCard } from '@/components/billing/OrgWalletCard';
import { OrgCurrencyCard } from '@/components/billing/OrgCurrencyCard';

interface OrganizationDetail {
  id: string;
  name: string;
  slug: string | null;
  email: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'PAUSED';
  defaultDisplayMode?: string;
  identityFieldsConfig?: Record<string, { required: boolean; label: string }> | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  hidePoweredBy?: boolean;
  customDomain?: { domain: string; status: 'PENDING' | 'VERIFIED' } | null;
  createdAt: string;
  updatedAt: string;
  subscription?: {
    id: string;
    status: string;
    billingCycle: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    trialEndsAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    plan?: {
      id: string;
      name: string;
      code: string;
      priceMonthly: string;
      priceYearly: string;
      features: Record<string, boolean>;
    };
  };
  locations: Array<{
    id: string;
    name: string;
    address: string | null;
    publicCode: string | null;
    _count: { services: number; servicePoints: number };
  }>;
  users: Array<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    createdAt: string;
  }>;
  _count: {
    locations: number;
    users: number;
    dataSources: number;
  };
}

interface UsageData {
  usage: {
    locations: { used: number; limit: number | null; percentage: string | null };
    users: { used: number; limit: number | null; percentage: string | null };
    services: { used: number; limitPerLocation: number | null };
    queueEntries: { today: number; thisMonth: number; dailyLimit: number | null };
  };
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

const ROLE_TONE: Record<string, BadgeTone> = {
  ORG_ADMIN: 'primary',
  LOCATION_ADMIN: 'primary',
  SERVICE_STAFF: 'success',
};

export default function OrganizationDetailPage({
  params
}: {
  params: Promise<{ id: string }>
}) {
  const resolvedParams = use(params);
  const { id } = resolvedParams;
  const router = useRouter();

  const [org, setOrg] = useState<OrganizationDetail | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [granting, setGranting] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const [creditForm, setCreditForm] = useState<{ creditType: 'AI' | 'EMAIL' | 'SMS'; amount: string; reason: string }>({
    creditType: 'AI',
    amount: '',
    reason: '',
  });

  useEffect(() => {
    loadOrganization();
  }, [id]);

  const loadOrganization = async () => {
    try {
      setLoading(true);
      const [orgData, usageData] = await Promise.all([
        api.getSuperadminOrganization(id),
        api.getSuperadminOrganizationUsage(id),
      ]);
      setOrg(orgData);
      setUsage(usageData);
    } catch (err) {
      console.error('Failed to load organization', err);
      setError('Failed to load organization');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelSubscription = async () => {
    const reason = await promptDialog({
      title: 'Cancel this subscription?',
      message: 'The organization loses access at the end of its billing period.',
      label: 'Reason (optional)',
      multiline: true,
      confirmLabel: 'Cancel subscription',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (reason === null) return;

    setCancelling(true);
    try {
      await api.cancelOrganizationSubscription(id, reason || undefined);
      loadOrganization();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to cancel subscription');
    } finally {
      setCancelling(false);
    }
  };

  const handleGrantCredits = async () => {
    const amount = parseInt(creditForm.amount, 10);
    if (!amount || !creditForm.reason.trim()) {
      setError('Amount and reason are required to grant credits');
      return;
    }

    setGranting(true);
    try {
      await api.grantCredits(id, { creditType: creditForm.creditType, amount, reason: creditForm.reason.trim() });
      setCreditForm({ creditType: 'AI', amount: '', reason: '' });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to grant credits');
    } finally {
      setGranting(false);
    }
  };

  const handleToggleStatus = async () => {
    if (!org) return;
    const nextStatus = org.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    if (nextStatus === 'PAUSED' && !(await confirmDialog({ title: 'Pause this organization?', message: 'Their staff can still sign in, but customers can’t join queues or check ticket status until you reactivate it.', confirmLabel: 'Pause' }))) return;

    setStatusUpdating(true);
    try {
      await api.setOrganizationStatus(id, nextStatus);
      loadOrganization();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update organization status');
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleImpersonate = async () => {
    if (!(await confirmDialog({ title: `Sign in as an admin of ${org?.name}?`, message: 'This will be logged.', confirmLabel: 'Sign in' }))) return;
    setImpersonating(true);
    try {
      const result = await api.impersonateOrganization(id);
      const superAdminToken = localStorage.getItem('token') || '';
      const hash = [
        `impersonate=${encodeURIComponent(result.token)}`,
        `superToken=${encodeURIComponent(superAdminToken)}`,
        `orgId=${encodeURIComponent(id)}`,
        `orgName=${encodeURIComponent(result.organizationName)}`,
      ].join('&');
      window.location.href = `${buildTenantUrl(result.tenantSlug, '/')}#${hash}`;
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to impersonate organization');
      setImpersonating(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirmDialog({
      title: `Delete ${org?.name ?? 'this organization'}?`,
      message: 'This is irreversible. It deletes all of its data, including locations, services, users and queue history.',
      requireText: 'DELETE',
      confirmLabel: 'Delete organization',
      tone: 'danger',
    }))) return;

    setDeleting(true);
    try {
      await api.deleteSuperadminOrganization(id);
      router.push('/superadmin/organizations');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete organization');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div style={loadingContainer}>
        <div className="spinner" />
        <p style={{ color: 'var(--gray-500)' }}>Loading organization...</p>
      </div>
    );
  }

  if (!org) {
    return (
      <div style={errorContainer}>
        <p style={{ color: 'var(--error-600)' }}>{error || 'Organization not found'}</p>
        <Link href="/superadmin/organizations">
          <Button variant="primary">← Back to Organizations</Button>
        </Link>
      </div>
    );
  }

  return (
    <div style={pageContainer}>
      <header style={header}>
        <div style={headerLeft}>
          <Link href="/superadmin/organizations" style={backLink}>
            <Icon icon={ArrowLeft} size={14} /> Back
          </Link>
          <div>
            <h1 style={pageTitle}>{org.name}</h1>
            <p style={subtitle}>{org.slug || org.email || 'No identifier'}</p>
          </div>
        </div>
        <div style={headerActions}>
          <Badge tone={org.status === 'PAUSED' ? 'warning' : 'success'}>{org.status === 'PAUSED' ? 'Paused' : 'Active'}</Badge>
          <Badge tone={getStatusTone(org.subscription?.status)}>{org.subscription?.status || 'No Plan'}</Badge>
          <Button variant="secondary" size="sm" onClick={handleImpersonate} disabled={impersonating}>
            <Icon icon={UserCog} size={14} /> {impersonating ? 'Signing in...' : 'Impersonate'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleToggleStatus}
            disabled={statusUpdating}
            style={org.status === 'PAUSED' ? { color: 'var(--success-600)' } : { color: 'var(--warning-600)' }}
          >
            <Icon icon={org.status === 'PAUSED' ? PlayCircle : PauseCircle} size={14} />
            {statusUpdating ? 'Updating...' : org.status === 'PAUSED' ? 'Reactivate' : 'Pause'}
          </Button>
        </div>
      </header>

      {error && (
        <div style={errorBanner}>
          <span>{error}</span>
          <button onClick={() => setError('')} style={dismissBtn} aria-label="Dismiss">
            <Icon icon={X} size={16} />
          </button>
        </div>
      )}

      <div style={contentGrid}>
        {/* Organization Info */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Organization Details</h2>
          </div>
          <div style={cardBody}>
            <div style={infoGrid}>
              <div style={infoItem}>
                <span style={infoLabel}>Name</span>
                <span style={infoValue}>{org.name}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Slug</span>
                <span style={infoValue}>{org.slug || '—'}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Email</span>
                <span style={infoValue}>{org.email || '—'}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Phone</span>
                <span style={infoValue}>{org.phone || '—'}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Created</span>
                <span style={infoValue}>{new Date(org.createdAt).toLocaleDateString()}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Updated</span>
                <span style={infoValue}>{new Date(org.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Configuration */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Configuration</h2>
          </div>
          <div style={cardBody}>
            <div style={infoGrid}>
              <div style={infoItem}>
                <span style={infoLabel}>Display Mode</span>
                <span style={infoValue}>{org.defaultDisplayMode || 'TICKET_ONLY'}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Identity Fields</span>
                <span style={infoValue}>
                  {org.identityFieldsConfig ? Object.keys(org.identityFieldsConfig).length : 0} configured
                </span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Logo</span>
                {org.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={org.logoUrl} alt="Logo" style={{ height: '28px', maxWidth: '100px', objectFit: 'contain' }} />
                ) : (
                  <span style={infoValue}>Not set</span>
                )}
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Primary Color</span>
                <span style={{ ...infoValue, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {org.primaryColor ? (
                    <>
                      <span style={{ width: '16px', height: '16px', borderRadius: '4px', background: org.primaryColor, border: '1px solid var(--gray-200)' }} />
                      {org.primaryColor}
                    </>
                  ) : 'Default'}
                </span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Powered-By Badge</span>
                <span style={infoValue}>{org.hidePoweredBy ? 'Hidden' : 'Shown'}</span>
              </div>
              <div style={infoItem}>
                <span style={infoLabel}>Custom Domain</span>
                <span style={infoValue}>
                  {org.customDomain ? (
                    <>
                      {org.customDomain.domain}{' '}
                      <Badge tone={org.customDomain.status === 'VERIFIED' ? 'success' : 'warning'}>
                        {org.customDomain.status === 'VERIFIED' ? 'Verified' : 'Pending'}
                      </Badge>
                    </>
                  ) : 'Not configured'}
                </span>
              </div>
            </div>
          </div>
        </Card>

        {/* Subscription Info */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Subscription</h2>
            {org.subscription && org.subscription.status !== 'CANCELLED' && (
              <Button variant="secondary" size="sm" onClick={handleCancelSubscription} disabled={cancelling} style={{ color: 'var(--warning-600)' }}>
                {cancelling ? 'Cancelling...' : 'Cancel'}
              </Button>
            )}
          </div>
          <div style={cardBody}>
            {org.subscription ? (
              <div style={infoGrid}>
                <div style={infoItem}>
                  <span style={infoLabel}>Plan</span>
                  <span style={infoValue}>{org.subscription.plan?.name || 'Unknown'}</span>
                </div>
                <div style={infoItem}>
                  <span style={infoLabel}>Billing</span>
                  <span style={infoValue}>{org.subscription.billingCycle}</span>
                </div>
                <div style={infoItem}>
                  <span style={infoLabel}>Price</span>
                  <span style={infoValue}>
                    ${org.subscription.billingCycle === 'yearly'
                      ? org.subscription.plan?.priceYearly
                      : org.subscription.plan?.priceMonthly}/
                    {org.subscription.billingCycle === 'yearly' ? 'yr' : 'mo'}
                  </span>
                </div>
                <div style={infoItem}>
                  <span style={infoLabel}>Period End</span>
                  <span style={infoValue}>
                    {new Date(org.subscription.currentPeriodEnd).toLocaleDateString()}
                  </span>
                </div>
                {org.subscription.trialEndsAt && (
                  <div style={infoItem}>
                    <span style={infoLabel}>Trial Ends</span>
                    <span style={infoValue}>
                      {new Date(org.subscription.trialEndsAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
                {org.subscription.cancelledAt && (
                  <>
                    <div style={infoItem}>
                      <span style={infoLabel}>Cancelled At</span>
                      <span style={infoValue}>
                        {new Date(org.subscription.cancelledAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div style={infoItem}>
                      <span style={infoLabel}>Cancel Reason</span>
                      <span style={infoValue}>{org.subscription.cancelReason || '—'}</span>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p style={noData}>No active subscription</p>
            )}
          </div>
        </Card>

        {/* Usage Stats */}
        {usage && (
          <Card style={{ overflow: 'hidden' }}>
            <div style={cardHeader}>
              <h2 style={cardTitle}>Usage</h2>
            </div>
            <div style={cardBody}>
              <div style={usageGrid}>
                <UsageBar label="Locations" current={usage.usage.locations.used} limit={usage.usage.locations.limit} />
                <UsageBar label="Users" current={usage.usage.users.used} limit={usage.usage.users.limit} />
                <UsageBar label="Queue Entries Today" current={usage.usage.queueEntries.today} limit={usage.usage.queueEntries.dailyLimit} />
                <div>
                  <div style={usageHeader}>
                    <span style={usageLabel}>Entries This Month</span>
                    <span style={usageValue}>{usage.usage.queueEntries.thisMonth}</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Locations */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Locations ({org.locations.length})</h2>
          </div>
          <div style={cardBody}>
            {org.locations.length > 0 ? (
              <div style={listContainer}>
                {org.locations.map(loc => (
                  <div key={loc.id} style={listItem}>
                    <div style={listItemMain}>
                      <span style={listItemName}>{loc.name}</span>
                      <span style={listItemMeta}>{loc.address || 'No address'}</span>
                    </div>
                    <div style={listItemStats}>
                      <span>{loc._count.services} services</span>
                      <span>{loc._count.servicePoints} desks</span>
                      {loc.publicCode && <span style={publicCodeBadge}>{loc.publicCode}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={noData}>No locations</p>
            )}
          </div>
        </Card>

        {/* Users */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={cardHeader}>
            <h2 style={cardTitle}>Users ({org.users.length})</h2>
          </div>
          <div style={cardBody}>
            {org.users.length > 0 ? (
              <div style={listContainer}>
                {org.users.map(user => (
                  <div key={user.id} style={listItem}>
                    <div style={listItemMain}>
                      <span style={listItemName}>{user.firstName} {user.lastName}</span>
                      <span style={listItemMeta}>{user.email}</span>
                    </div>
                    <Badge tone={ROLE_TONE[user.role] || 'neutral'}>{user.role.replace('_', ' ')}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p style={noData}>No users</p>
            )}
          </div>
        </Card>
      </div>

      <OrgCurrencyCard organizationId={id} current={(org as { currency?: string } | null)?.currency} onChanged={loadOrganization} />

      <OrgWalletCard organizationId={id} onChanged={loadOrganization} />

      {/* Grant Credits */}
      <Card style={{ padding: '1.5rem', marginBottom: '2rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--gray-900)', marginBottom: '1rem' }}>Grant Credits</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto', gap: '0.75rem', alignItems: 'end' }}>
          <Select
            label="Credit type"
            value={creditForm.creditType}
            onChange={(e) => setCreditForm({ ...creditForm, creditType: e.target.value as 'AI' | 'EMAIL' | 'SMS' })}
          >
            <option value="AI">AI</option>
            <option value="EMAIL">Email</option>
            <option value="SMS">SMS</option>
          </Select>
          <Input
            label="Amount (negative to debit)"
            type="number"
            value={creditForm.amount}
            onChange={(e) => setCreditForm({ ...creditForm, amount: e.target.value })}
            placeholder="e.g. 100"
          />
          <Input
            label="Reason"
            value={creditForm.reason}
            onChange={(e) => setCreditForm({ ...creditForm, reason: e.target.value })}
            placeholder="e.g. Goodwill top-up after support incident"
          />
          <Button variant="primary" onClick={handleGrantCredits} disabled={granting}>
            {granting ? 'Granting...' : 'Grant'}
          </Button>
        </div>
      </Card>

      {/* Danger Zone */}
      <div style={dangerCard}>
        <h3 style={dangerTitle}>Danger Zone</h3>
        <p style={dangerText}>
          Deleting this organization will permanently remove all data including locations, services,
          users, queue history, and settings. This action cannot be undone.
        </p>
        <Button variant="secondary" onClick={handleDelete} disabled={deleting} style={deleteBtn}>
          {deleting ? 'Deleting...' : 'Delete Organization'}
        </Button>
      </div>
    </div>
  );
}

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
  maxWidth: '1200px',
  margin: 0,
};

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: '2rem',
  gap: '1rem',
  flexWrap: 'wrap' as const,
};

const headerLeft: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const backLink: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  color: 'var(--gray-400)',
  textDecoration: 'none',
  fontSize: '0.875rem',
  fontWeight: 500,
};

const pageTitle: React.CSSProperties = {
  fontSize: '2rem',
  fontWeight: 700,
  color: 'var(--gray-900)',
};

const subtitle: React.CSSProperties = {
  color: 'var(--gray-500)',
  fontSize: '1rem',
};

const headerActions: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
};

const errorBanner: React.CSSProperties = {
  background: 'var(--error-50)',
  border: '1px solid var(--error-100)',
  borderRadius: 'var(--radius-lg)',
  padding: '1rem',
  marginBottom: '1.5rem',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  color: 'var(--error-600)',
};

const dismissBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--error-600)',
  cursor: 'pointer',
  display: 'inline-flex',
};

const contentGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))',
  gap: '1.5rem',
  marginBottom: '2rem',
};

const cardHeader: React.CSSProperties = {
  padding: '1rem 1.5rem',
  borderBottom: '1px solid var(--gray-100)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const cardTitle: React.CSSProperties = {
  fontSize: '1rem',
  fontWeight: 700,
  color: 'var(--gray-900)',
};

const cardBody: React.CSSProperties = {
  padding: '1.5rem',
};

const infoGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '1.1rem',
};

const infoItem: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const infoLabel: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
  fontWeight: 600,
  letterSpacing: '0.03em',
};

const infoValue: React.CSSProperties = {
  color: 'var(--gray-900)',
  fontSize: '0.9375rem',
};

const noData: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontStyle: 'italic' as const,
};

const usageGrid: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

const usageHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginBottom: '0.5rem',
};

const usageLabel: React.CSSProperties = {
  color: 'var(--gray-500)',
  fontSize: '0.875rem',
};

const usageValue: React.CSSProperties = {
  color: 'var(--gray-900)',
  fontSize: '0.875rem',
  fontWeight: 600,
};

const listContainer: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const listItem: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.75rem 0.9rem',
  background: 'var(--gray-50)',
  borderRadius: 'var(--radius-lg)',
  flexWrap: 'wrap' as const,
  gap: '0.5rem',
};

const listItemMain: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const listItemName: React.CSSProperties = {
  color: 'var(--gray-900)',
  fontWeight: 600,
};

const listItemMeta: React.CSSProperties = {
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
};

const listItemStats: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  alignItems: 'center',
  color: 'var(--gray-400)',
  fontSize: '0.75rem',
};

const publicCodeBadge: React.CSSProperties = {
  background: 'var(--primary-50)',
  color: 'var(--primary-700)',
  padding: '0.125rem 0.5rem',
  borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)',
};

const dangerCard: React.CSSProperties = {
  background: 'var(--error-50)',
  border: '1px solid var(--error-100)',
  borderRadius: 'var(--radius-xl)',
  padding: '1.5rem',
  marginTop: '0.5rem',
};

const dangerTitle: React.CSSProperties = {
  color: 'var(--error-600)',
  fontSize: '1.125rem',
  fontWeight: 700,
  marginBottom: '0.75rem',
};

const dangerText: React.CSSProperties = {
  color: 'var(--error-600)',
  fontSize: '0.875rem',
  marginBottom: '1rem',
  lineHeight: 1.6,
};

const deleteBtn: React.CSSProperties = {
  background: 'var(--error-600)',
  color: '#fff',
  border: 'none',
};
