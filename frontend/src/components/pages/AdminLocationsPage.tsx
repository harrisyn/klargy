'use client';

import NoOrganization from '@/components/NoOrganization';
import { toast, errorMessage } from '@/lib/toast';
import React, { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription, UpgradePrompt } from '@/contexts/SubscriptionContext';
import Layout from '@/components/Layout';
import { Icon, PageHeader } from '@/components/ui';

interface Location {
  id: string;
  name: string;
  address?: string;
  timezone: string;
  publicCode?: string;
  externalReference?: string;
  defaultServiceId?: string | null;
  services?: any[];
}

interface Organization {
  id: string;
  name: string;
}

export default function AdminLocationsPage() {
  const { user, isAdmin } = useAuthContext();
  const { canCreate, limits, refresh: refreshSubscription, loading: subscriptionLoading } = useSubscription();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    timezone: 'UTC',
    publicCode: '',
    externalReference: '',
    defaultServiceId: '',
  });
  // The services of the location being edited (for "first point of contact").
  const [editServices, setEditServices] = useState<{ id: string; name: string }[]>([]);
  const [copySuccess, setCopySuccess] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin) {
      loadOrgs();
    } else {
      setLoading(false);
    }
  }, [isAdmin, user]);

  const loadOrgs = async () => {
    setLoading(true);
    try {
      if (user?.organizationId) {
        const org = await api.getOrganization(user.organizationId);
        setOrgs([org]);
        setOrgId(org.id);
        // Stay in the loading state until loadLocations finishes, so the
        // "No locations yet" empty state never flashes before data arrives.
        return;
      } else {
        // No organization on this account (e.g. a superadmin). Never guess an
        // org - render the empty state instead of leaking another tenant's data.
        setOrgs([]);
        setOrgId(null);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (orgId) loadLocations(orgId);
  }, [orgId]);

  const loadLocations = async (organizationId: string) => {
    setLoading(true);
    try {
      const data = await api.getLocations(organizationId);
      setLocations(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId) return;

    try {
      await api.createLocation(orgId, {
        name: formData.name,
        address: formData.address || undefined,
        timezone: formData.timezone,
      });
      
      if (formData.publicCode) {
        const locs = await api.getLocations(orgId);
        const newLoc = locs.find((l: Location) => l.name === formData.name);
        if (newLoc) {
          await api.updateLocation(newLoc.id, { publicCode: formData.publicCode });
        }
      }
      
      await loadLocations(orgId);
      await refreshSubscription(); // Refresh subscription to update limits
      resetForm();
    } catch (err: any) {
      toast.error(errorMessage(err, 'Couldn’t add the location.'));
    }
  };

  const handleUpdateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLocation) return;

    try {
      await api.updateLocation(editingLocation.id, {
        name: formData.name,
        address: formData.address || undefined,
        timezone: formData.timezone,
        publicCode: formData.publicCode || null,
        externalReference: formData.externalReference || null,
        defaultServiceId: formData.defaultServiceId || null,
      });
      await loadLocations(orgId!);
      resetForm();
    } catch (err: any) {
      toast.error(errorMessage(err, 'Couldn’t save the location.'));
    }
  };

  const handleDeleteLocation = async (locId: string) => {
    if (!confirm('Are you sure you want to delete this location? This will also delete all services and queues associated with it.')) {
      return;
    }

    try {
      await api.deleteLocation(locId);
      await loadLocations(orgId!);
      setShowDetails(false);
      setSelectedLocation(null);
    } catch (err: any) {
      toast.error(errorMessage(err, 'Couldn’t delete the location.'));
    }
  };

  const openDetails = (loc: Location) => {
    setSelectedLocation(loc);
    setShowDetails(true);
    setShowForm(false);
  };

  const startEdit = (loc: Location) => {
    setEditingLocation(loc);
    setFormData({
      name: loc.name,
      address: loc.address || '',
      timezone: loc.timezone,
      publicCode: loc.publicCode || '',
      externalReference: loc.externalReference || '',
      defaultServiceId: loc.defaultServiceId || '',
    });
    setEditServices([]);
    api.getServices(loc.id).then(setEditServices).catch(() => setEditServices([]));
    setShowForm(true);
    setShowDetails(false);
  };

  const resetForm = () => {
    setShowForm(false);
    setShowDetails(false);
    setSelectedLocation(null);
    setEditingLocation(null);
    setFormData({ name: '', address: '', timezone: 'UTC', publicCode: '', externalReference: '', defaultServiceId: '' });
  };

  const getBaseUrl = () => typeof window !== 'undefined' ? window.location.origin : '';

  const getLocationUrl = (loc: Location, mode?: 'kiosk' | 'display') => {
    if (!loc.publicCode && mode !== 'display') return null;
    const baseUrl = getBaseUrl();
    if (mode === 'kiosk') return `${baseUrl}/join/${loc.publicCode}?mode=kiosk`;
    if (mode === 'display') return `${baseUrl}/display/${loc.id}`;
    return `${baseUrl}/join/${loc.publicCode}`;
  };

  const copyToClipboard = async (text: string, locId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(locId);
      setTimeout(() => setCopySuccess(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!isAdmin) {
    return (
      <Layout>
        <div style={{ padding: 20 }}>Admins only</div>
      </Layout>
    );
  }

  if (!loading && !user?.organizationId) {
    return <NoOrganization />;
  }

  return (
    <Layout>
      <div>
        <PageHeader
          icon={MapPin}
          title="Locations"
          subtitle="Each place people come to. Every location gets its own join code, QR poster and lobby screen."
          actions={
            <button
              onClick={() => { resetForm(); setShowForm(true); }}
              style={{
                ...addButton,
                ...(canCreate('locations') ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
              }}
              disabled={!canCreate('locations')}
              title={canCreate('locations') ? 'Add a new location' : 'Location limit reached. Upgrade to add more.'}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
              </svg>
              Add Location
            </button>
          }
        />

        {/* Upgrade prompt if limit reached */}
        {!canCreate('locations') && (
          <div style={{ padding: '0 24px' }}>
            <UpgradePrompt resource="locations" />
          </div>
        )}

        {/* Org selector - only show if multiple orgs */}
        {orgs.length > 1 && (
          <div style={filterBar}>
            <div style={filterGroup}>
              <label style={filterLabel}>Organization</label>
              <select 
                value={orgId ?? ''} 
                onChange={(e) => setOrgId(e.target.value)}
                style={selectStyle}
              >
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* Location Details Panel */}
        {showDetails && selectedLocation && (
          <div style={detailsPanel}>
            <div style={detailsHeader}>
              <h2 style={detailsTitle}>{selectedLocation.name}</h2>
              <button onClick={() => setShowDetails(false)} style={closeButton}>×</button>
            </div>
            
            <div style={detailsBody}>
              <div style={detailsGrid}>
                <div style={detailItem}>
                  <span style={detailLabel}>Address</span>
                  <span style={detailValue}>{selectedLocation.address || 'Not set'}</span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>Timezone</span>
                  <span style={detailValue}>{selectedLocation.timezone}</span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>Public Code</span>
                  <span style={detailValue}>
                    {selectedLocation.publicCode ? (
                      <span style={publicCodeBadge}>{selectedLocation.publicCode}</span>
                    ) : (
                      'Not assigned'
                    )}
                  </span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>External Reference</span>
                  <span style={detailValue}>
                    {selectedLocation.externalReference || 'Not set'}
                  </span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>Services</span>
                  <span style={detailValue}>
                    {selectedLocation.services?.length || 0} service{(selectedLocation.services?.length || 0) !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {/* Public URL Section */}
              <div style={urlSection}>
                <h3 style={urlSectionTitle}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  Access URLs
                </h3>
                <p style={urlDescription}>Share these URLs for different access modes.</p>
                
                {/* Join URL */}
                {selectedLocation.publicCode && (
                  <div style={urlRow}>
                    <div style={urlRowLabel}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="8.5" cy="7" r="4" />
                        <line x1="20" y1="8" x2="20" y2="14" />
                        <line x1="23" y1="11" x2="17" y2="11" />
                      </svg>
                      Join Page
                    </div>
                    <div style={urlBox}>
                      <code style={urlCode}>{getLocationUrl(selectedLocation)}</code>
                      <button 
                        onClick={() => copyToClipboard(getLocationUrl(selectedLocation)!, `join-${selectedLocation.id}`)} 
                        style={copyButtonSmall}
                      >
                        {copySuccess === `join-${selectedLocation.id}` ? '✓' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
                
                {/* Kiosk URL */}
                {selectedLocation.publicCode && (
                  <div style={urlRow}>
                    <div style={urlRowLabel}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      Kiosk Mode
                    </div>
                    <div style={urlBox}>
                      <code style={urlCode}>{getLocationUrl(selectedLocation, 'kiosk')}</code>
                      <button 
                        onClick={() => copyToClipboard(getLocationUrl(selectedLocation, 'kiosk')!, `kiosk-${selectedLocation.id}`)} 
                        style={copyButtonSmall}
                      >
                        {copySuccess === `kiosk-${selectedLocation.id}` ? '✓' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
                
                {/* Display URL */}
                <div style={urlRow}>
                  <div style={urlRowLabel}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <path d="M8 21h8" />
                      <path d="M12 17v4" />
                    </svg>
                    TV Display
                  </div>
                  <div style={urlBox}>
                    <code style={urlCode}>{getLocationUrl(selectedLocation, 'display')}</code>
                    <button 
                      onClick={() => copyToClipboard(getLocationUrl(selectedLocation, 'display')!, `display-${selectedLocation.id}`)} 
                      style={copyButtonSmall}
                    >
                      {copySuccess === `display-${selectedLocation.id}` ? '✓' : 'Copy'}
                    </button>
                  </div>
                </div>
                
                <div style={quickLinks}>
                  {selectedLocation.publicCode && (
                    <a 
                      href={getLocationUrl(selectedLocation)!} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={quickLink}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                      Open Join
                    </a>
                  )}
                  {selectedLocation.publicCode && (
                    <a 
                      href={getLocationUrl(selectedLocation, 'kiosk')!} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={quickLink}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      Open Kiosk
                    </a>
                  )}
                  <a 
                    href={getLocationUrl(selectedLocation, 'display')!}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={quickLink}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <path d="M8 21h8" />
                      <path d="M12 17v4" />
                    </svg>
                    Open Display
                  </a>
                  <a 
                    href={`/admin/qr?location=${selectedLocation.id}`}
                    style={quickLink}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                    </svg>
                    QR Code
                  </a>
                </div>
              </div>
            </div>

            <div style={detailsActions}>
              <button onClick={() => startEdit(selectedLocation)} style={editButtonLarge}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit Location
              </button>
              <button onClick={() => handleDeleteLocation(selectedLocation.id)} style={deleteButtonLarge}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Location
              </button>
            </div>
          </div>
        )}

        {/* Create/Edit Form */}
        {showForm && (
          <div style={formCard}>
            <div style={formHeader}>
              <h2 style={formTitle}>
                {editingLocation ? 'Edit Location' : 'Create New Location'}
              </h2>
              <button onClick={resetForm} style={closeButton}>×</button>
            </div>
            <form onSubmit={editingLocation ? handleUpdateLocation : handleCreateLocation}>
              <div style={formGrid}>
                <div style={formField}>
                  <label style={labelStyle}>Location Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Main Branch, Downtown Clinic"
                    required
                    style={inputStyle}
                  />
                </div>
                <div style={formField}>
                  <label style={labelStyle}>Address</label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    placeholder="123 Main Street, City"
                    style={inputStyle}
                  />
                </div>
                <div style={formField}>
                  <label style={labelStyle}>Timezone</label>
                  <select
                    value={formData.timezone}
                    onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                    style={inputStyle}
                  >
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">America/New_York</option>
                    <option value="America/Los_Angeles">America/Los_Angeles</option>
                    <option value="Europe/London">Europe/London</option>
                    <option value="Europe/Paris">Europe/Paris</option>
                    <option value="Asia/Tokyo">Asia/Tokyo</option>
                    <option value="Asia/Singapore">Asia/Singapore</option>
                    <option value="Africa/Lagos">Africa/Lagos</option>
                    <option value="Africa/Accra">Africa/Accra</option>
                  </select>
                </div>
                <div style={formField}>
                  <label style={labelStyle}>Public Join Code</label>
                  <input
                    type="text"
                    value={formData.publicCode}
                    onChange={(e) => setFormData({ ...formData, publicCode: e.target.value.toUpperCase() })}
                    placeholder="e.g., MAINBRANCH"
                    style={inputStyle}
                  />
                  <p style={helpText}>
                    Customers can join queues at: <strong>/join/{formData.publicCode || '[code]'}</strong>
                  </p>
                </div>
                {editingLocation && (
                  <div style={formField}>
                    <label style={labelStyle}>First point of contact</label>
                    <select
                      value={formData.defaultServiceId}
                      onChange={(e) => setFormData({ ...formData, defaultServiceId: e.target.value })}
                      style={inputStyle}
                    >
                      <option value="">None: people choose a service</option>
                      {editServices.map((svc) => (
                        <option key={svc.id} value={svc.id}>{svc.name}</option>
                      ))}
                    </select>
                    <p style={helpText}>
                      Kiosk and QR joins go straight here (usually Reception) instead of asking which service.
                    </p>
                  </div>
                )}
                <div style={formField}>
                  <label style={labelStyle}>External Reference (Optional)</label>
                  <input
                    type="text"
                    value={formData.externalReference}
                    onChange={(e) => setFormData({ ...formData, externalReference: e.target.value })}
                    placeholder="e.g., ERP Location ID, HIS code"
                    style={inputStyle}
                  />
                  <p style={helpText}>
                    Integration ID for external systems (ERP, HIS, etc.)
                  </p>
                </div>
              </div>
              <div style={formActions}>
                <button type="button" onClick={resetForm} style={cancelButton}>
                  Cancel
                </button>
                <button type="submit" style={submitButton}>
                  {editingLocation ? 'Save Changes' : 'Create Location'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Locations List */}
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div className="spinner" />
          </div>
        ) : (
          <div style={locationsGrid}>
            {locations.length === 0 && !showForm && (
              <div style={emptyState}>
                <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'center' }}>
                  <Icon icon={MapPin} size={48} color="#0f9fa4" strokeWidth={1.5} />
                </div>
                <h3 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', marginBottom: '0.5rem' }}>No locations yet</h3>
                <p style={{ color: '#6b7280', marginBottom: '1rem' }}>Create your first location to start managing queues.</p>
                <button onClick={() => setShowForm(true)} style={submitButton}>
                  Create First Location
                </button>
              </div>
            )}
            
            {locations.map(loc => (
              <div 
                key={loc.id} 
                style={{
                  ...locationCard,
                  ...(selectedLocation?.id === loc.id ? locationCardActive : {}),
                }}
                onClick={() => openDetails(loc)}
              >
                <div style={cardHeader}>
                  <div style={cardIcon}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                  </div>
                  {loc.publicCode && (
                    <span style={publicCodeBadge}>/join/{loc.publicCode}</span>
                  )}
                </div>
                
                <h3 style={cardTitle}>{loc.name}</h3>
                {loc.address && <p style={cardAddress}>{loc.address}</p>}
                
                <div style={cardMeta}>
                  <span style={metaItem}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    {loc.timezone}
                  </span>
                  <span style={metaItem}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="12 2 2 7 12 12 22 7 12 2" />
                      <polyline points="2 17 12 22 22 17" />
                      <polyline points="2 12 12 17 22 12" />
                    </svg>
                    {loc.services?.length || 0} {(loc.services?.length || 0) === 1 ? 'service' : 'services'}
                  </span>
                </div>

                {loc.publicCode && (
                  <div style={cardUrlPreview}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    Show the join link
                  </div>
                )}

                <div style={cardActions} onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => startEdit(loc)} style={editButton}>
                    Edit
                  </button>
                  <button onClick={() => handleDeleteLocation(loc.id)} style={deleteButton}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

// Styles
const addButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.25rem',
  background: 'white',
  color: 'var(--primary)',
  border: 'none',
  borderRadius: '10px',
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const filterBar: React.CSSProperties = {
  display: 'flex',
  gap: '1.5rem',
  marginBottom: '1.5rem',
  padding: '1rem 1.25rem',
  background: 'white',
  borderRadius: '12px',
  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)',
};

const filterGroup: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const filterLabel: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#6b7280',
  
  letterSpacing: '0.5px',
};

const selectStyle: React.CSSProperties = {
  padding: '0.6rem 1rem',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
  fontSize: '0.95rem',
  minWidth: '200px',
  cursor: 'pointer',
  background: 'white',
  color: '#374151',
};

const detailsPanel: React.CSSProperties = {
  background: 'white',
  borderRadius: '16px',
  marginBottom: '1.5rem',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
  overflow: 'hidden',
};

const detailsHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1.25rem 1.5rem',
  borderBottom: '1px solid #e5e7eb',
  background: '#f8fafc',
};

const detailsTitle: React.CSSProperties = {
  margin: 0,
  fontSize: '1.25rem',
  fontWeight: 600,
  color: '#111827',
};

const detailsBody: React.CSSProperties = {
  padding: '1.5rem',
};

const detailsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '1rem',
  marginBottom: '1.5rem',
};

const detailItem: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const detailLabel: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#6b7280',
  
  letterSpacing: '0.5px',
};

const detailValue: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#111827',
};

const urlSection: React.CSSProperties = {
  padding: '1.25rem',
  background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)',
  borderRadius: '12px',
  border: '1px solid #bbf7d0',
};

const urlSectionTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  margin: '0 0 0.5rem',
  fontSize: '1rem',
  fontWeight: 600,
  color: '#166534',
};

const urlDescription: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: '0.875rem',
  color: '#15803d',
};

const urlRow: React.CSSProperties = {
  marginBottom: '0.75rem',
};

const urlRowLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#166534',
  marginBottom: '0.375rem',
  
  letterSpacing: '0.025em',
};

const urlBox: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.5rem 0.75rem',
  background: 'white',
  borderRadius: '6px',
  border: '1px solid #bbf7d0',
};

const urlCode: React.CSSProperties = {
  flex: 1,
  fontSize: '0.8125rem',
  color: '#166534',
  wordBreak: 'break-all',
  fontFamily: 'monospace',
};

const copyButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.5rem 1rem',
  background: '#166534',
  color: 'white',
  border: 'none',
  borderRadius: '6px',
  fontSize: '0.8125rem',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const copyButtonSmall: React.CSSProperties = {
  padding: '0.375rem 0.75rem',
  background: '#166534',
  color: 'white',
  border: 'none',
  borderRadius: '4px',
  fontSize: '0.75rem',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const quickLinks: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap',
  marginTop: '1rem',
  paddingTop: '1rem',
  borderTop: '1px dashed #bbf7d0',
};

const quickLink: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.8125rem',
  color: '#166534',
  textDecoration: 'none',
  fontWeight: 500,
  padding: '0.375rem 0.75rem',
  background: 'rgba(22, 101, 52, 0.1)',
  borderRadius: '6px',
};

const detailsActions: React.CSSProperties = {
  display: 'flex',
  gap: '1rem',
  padding: '1rem 1.5rem',
  borderTop: '1px solid #e5e7eb',
  background: '#f9fafb',
};

const editButtonLarge: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.5rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  fontSize: '0.9375rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const deleteButtonLarge: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.5rem',
  background: 'white',
  color: '#dc2626',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  fontSize: '0.9375rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const formCard: React.CSSProperties = {
  background: 'white',
  borderRadius: '16px',
  marginBottom: '1.5rem',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
  overflow: 'hidden',
};

const formHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1.25rem 1.5rem',
  borderBottom: '1px solid #e5e7eb',
  background: '#f8fafc',
};

const formTitle: React.CSSProperties = {
  margin: 0,
  fontSize: '1.125rem',
  fontWeight: 600,
  color: '#111827',
};

const closeButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: '1.5rem',
  color: '#9ca3af',
  cursor: 'pointer',
  padding: '0.25rem',
  lineHeight: 1,
};

const formGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '1.25rem',
  padding: '1.5rem',
};

const formField: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 500,
  color: '#374151',
};

const inputStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
  fontSize: '0.95rem',
  background: '#f9fafb',
  color: '#111827',
};

const helpText: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#6b7280',
  marginTop: '0.25rem',
};

const formActions: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.75rem',
  padding: '1rem 1.5rem',
  borderTop: '1px solid #e5e7eb',
  background: '#f9fafb',
};

const cancelButton: React.CSSProperties = {
  padding: '0.75rem 1.5rem',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
  background: 'white',
  color: '#374151',
  fontWeight: 500,
  cursor: 'pointer',
  fontSize: '0.9375rem',
};

const submitButton: React.CSSProperties = {
  padding: '0.75rem 1.5rem',
  borderRadius: '8px',
  border: 'none',
  background: '#0f9fa4',
  color: 'white',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: '0.9375rem',
};

const locationsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: '1.5rem',
};

const emptyState: React.CSSProperties = {
  gridColumn: '1 / -1',
  textAlign: 'center',
  padding: '3rem',
  background: 'white',
  borderRadius: '16px',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
};

const locationCard: React.CSSProperties = {
  background: 'white',
  borderRadius: '16px',
  padding: '1.5rem',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
  cursor: 'pointer',
  transition: 'all 0.2s',
  borderWidth: '2px',
  borderStyle: 'solid',
  borderColor: 'transparent',
};

const locationCardActive: React.CSSProperties = {
  borderColor: '#0f9fa4',
  boxShadow: '0 8px 30px rgba(15, 159, 164, 0.2)',
};

const cardHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: '1rem',
};

const cardIcon: React.CSSProperties = {
  width: '48px',
  height: '48px',
  background: 'rgba(15, 159, 164, 0.1)',
  borderRadius: '12px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#0f9fa4',
};

const publicCodeBadge: React.CSSProperties = {
  display: 'inline-block',
  padding: '0.25rem 0.625rem',
  background: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)',
  color: '#166534',
  borderRadius: '6px',
  fontSize: '0.75rem',
  fontWeight: 600,
};

const cardTitle: React.CSSProperties = {
  margin: '0 0 0.375rem',
  fontSize: '1.125rem',
  fontWeight: 600,
  color: '#111827',
};

const cardAddress: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: '0.875rem',
  color: '#6b7280',
};

const cardMeta: React.CSSProperties = {
  display: 'flex',
  gap: '1rem',
  marginBottom: '1rem',
};

const metaItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.8125rem',
  color: '#6b7280',
};

const cardUrlPreview: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.75rem',
  color: '#0b7f84',
  marginBottom: '1rem',
};

const cardActions: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  paddingTop: '1rem',
  borderTop: '1px solid #f3f4f6',
};

const editButton: React.CSSProperties = {
  flex: 1,
  padding: '0.5rem 1rem',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
  background: 'white',
  color: '#374151',
  fontWeight: 500,
  cursor: 'pointer',
  fontSize: '0.875rem',
};

const deleteButton: React.CSSProperties = {
  flex: 1,
  padding: '0.5rem 1rem',
  borderRadius: '8px',
  border: '1px solid #fecaca',
  background: '#fef2f2',
  color: '#dc2626',
  fontWeight: 500,
  cursor: 'pointer',
  fontSize: '0.875rem',
};
