'use client';

import NoOrganization from '@/components/NoOrganization';
import { toast, errorMessage } from '@/lib/toast';
import React, { useEffect, useState, useCallback } from 'react';
import { Layers } from 'lucide-react';
import api from '@/api/client';
import Layout from '@/components/Layout';
import { Checkbox, PageHeader } from '@/components/ui';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription, UpgradePrompt } from '@/contexts/SubscriptionContext';
import type { Service, Location, Organization, ServiceType } from '@/types';
import { AddServiceWizard } from '@/components/services/AddServiceWizard';
import type { WizardData } from '@/components/services/wizardTypes';
import { ServicePointsDeskPicker } from '@/components/services/ServicePointsDeskPicker';
import type { WizardServicePoint } from '@/components/services/wizardTypes';

interface ServicePoint {
  id: string;
  name: string;
  displayName?: string;
  type: string;
  isActive: boolean;
  capacity: number;
}

// Linked service point data from API (flat structure)
interface LinkedServicePoint {
  id: string;           // service point id
  name: string;
  displayName?: string;
  type: string;
  capacity: number;     // Effective capacity (serviceCapacity ?? defaultCapacity)
  isOccupied?: boolean;
  linkId: string;       // ServicePointService id
  // For capacity editing
  serviceCapacity?: number | null;  // Override capacity for this service
  defaultCapacity?: number;  // Original service point capacity
}

interface ServiceFormData {
  name: string;
  description: string;
  type: ServiceType;
  slotDuration: number;
  concurrentLimit: number;
  startTime: string;
  endTime: string;
  activeDays: string;
  requiresClearance: boolean;
}

const ServicesPage: React.FC = () => {
  const { user, isAdmin } = useAuthContext();
  const { canCreate, limits, refresh: refreshSubscription, loading: subscriptionLoading } = useSubscription();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string>('');
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // Services for the selected location have been fetched at least once; until
  // then show the spinner, not the "No Services Yet" / "No locations" states.
  const [dataLoaded, setDataLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [editServicePoints, setEditServicePoints] = useState<WizardServicePoint[]>([]);

  const [formData, setFormData] = useState<ServiceFormData>({
    name: '',
    description: '',
    type: 'GENERAL',
    slotDuration: 15,
    concurrentLimit: 1,
    startTime: '09:00',
    endTime: '17:00',
    activeDays: '1,2,3,4,5',
    requiresClearance: false,
  });

  const loadOrganizations = useCallback(async () => {
    try {
      if (user?.organizationId) {
        const org = await api.getOrganization(user.organizationId);
        setOrganizations([org]);
        setSelectedOrg(org.id);
      } else {
        // No organization on this account (e.g. a superadmin). Never guess an
        // org - render the empty state instead of leaking another tenant's data.
        setOrganizations([]);
        setSelectedOrg('');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [user?.organizationId]);

  const loadLocations = useCallback(async (orgId: string) => {
    try {
      const locs = await api.getLocations(orgId);
      setLocations(locs);
      if (locs.length > 0) {
        setSelectedLocation(locs[0].id);
      } else {
        setSelectedLocation('');
        setServices([]);
        setDataLoaded(true);
      }
    } catch (err) {
      console.error(err);
      setDataLoaded(true);
    }
  }, []);

  const loadServices = useCallback(async (locationId: string) => {
    try {
      const svcs = await api.getServices(locationId);
      setServices(svcs);
    } catch (err) {
      console.error(err);
    } finally {
      setDataLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadOrganizations();
  }, [loadOrganizations]);

  useEffect(() => {
    if (selectedOrg) loadLocations(selectedOrg);
  }, [selectedOrg, loadLocations]);

  useEffect(() => {
    if (selectedLocation) loadServices(selectedLocation);
  }, [selectedLocation, loadServices]);

  const handleWizardSubmit = async (data: WizardData) => {
    const locationIds = data.locationScope === 'all'
      ? locations.map(l => l.id)
      : [data.selectedLocationId];

    await api.createService({
      name: data.name,
      description: data.description,
      type: data.type,
      requiresName: data.requiresName,
      requiresPhone: data.requiresPhone,
      allowAnonymous: data.allowAnonymous,
      requiresClearance: data.requiresClearance,
      displayMode: data.displayMode || undefined,
      slotDuration: data.slotDuration,
      concurrentLimit: data.concurrentLimit,
      activeDays: data.activeDays,
      startTime: data.startTime,
      endTime: data.endTime,
      isActive: data.isActive,
      locationIds,
      servicePoints: data.servicePoints.map(sp => ({ servicePointId: sp.servicePointId, capacity: sp.capacity })),
    });

    await loadServices(selectedLocation);
    await refreshSubscription();
    setShowWizard(false);
  };

  const handleUpdateService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingService) return;

    try {
      await api.updateService(editingService.id, {
        ...formData,
        servicePoints: editServicePoints.map(sp => ({ servicePointId: sp.servicePointId, capacity: sp.capacity })),
      });
      await loadServices(selectedLocation);
      resetForm();
    } catch (err: any) {
      toast.error(errorMessage(err, 'Couldn’t save the service.'));
    }
  };

  const handleDeleteService = async (serviceId: string) => {
    if (!confirm('Are you sure you want to delete this service? This will also delete all associated queues.')) {
      return;
    }

    try {
      await api.deleteService(serviceId);
      await loadServices(selectedLocation);
      setShowDetails(false);
      setSelectedService(null);
    } catch (err: any) {
      toast.error(errorMessage(err, 'Couldn’t delete the service.'));
    }
  };

  const openDetails = (service: Service) => {
    setSelectedService(service);
    setShowDetails(true);
    setShowForm(false);
  };

  const startEdit = async (service: Service) => {
    setEditingService(service);
    setFormData({
      name: service.name,
      description: service.description || '',
      type: service.type,
      slotDuration: service.slotDuration,
      concurrentLimit: service.concurrentLimit,
      startTime: service.startTime || '09:00',
      endTime: service.endTime || '17:00',
      activeDays: service.activeDays || '1,2,3,4,5',
      requiresClearance: !!service.requiresClearance,
    });
    const linked = await api.getServicePointsForService(service.id);
    setEditServicePoints(linked.map((sp: LinkedServicePoint) => ({
      servicePointId: sp.id,
      name: sp.name,
      displayName: sp.displayName,
      capacity: sp.capacity,
    })));
    setShowForm(true);
    setShowDetails(false);
  };

  const resetForm = () => {
    setShowForm(false);
    setShowDetails(false);
    setSelectedService(null);
    setEditingService(null);
    setEditServicePoints([]);
    setFormData({
      name: '',
      description: '',
      type: 'GENERAL',
      slotDuration: 15,
      concurrentLimit: 1,
      startTime: '09:00',
      endTime: '17:00',
      activeDays: '1,2,3,4,5',
      requiresClearance: false,
    });
  };

  const getDayNames = (activeDays: string) => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return activeDays.split(',').map(d => days[parseInt(d)] || d).join(', ');
  };

  const getCurrentLocation = () => {
    return locations.find((l: Location) => l.id === selectedLocation);
  };

  if (!loading && !user?.organizationId) {
    return <NoOrganization />;
  }

  return (
    <Layout>
      <div>
        <PageHeader
          icon={Layers}
          title="Services"
          subtitle="What people queue for. Each service has its own queue, hours and ticket letter."
          actions={
            <button
              onClick={() => setShowWizard(true)}
              style={{
                ...addButton,
                ...(!selectedLocation || !canCreate('services') ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
              }}
              disabled={!selectedLocation || !canCreate('services')}
              title={!canCreate('services') ? 'Service limit reached. Upgrade to add more.' : !selectedLocation ? 'Select a location first' : 'Add a new service'}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Service
            </button>
          }
        />

        {/* Upgrade prompt if limit reached */}
        {!canCreate('services') && (
          <div style={{ padding: '0 24px' }}>
            <UpgradePrompt resource="services" />
          </div>
        )}

        {/* Filters */}
        <div style={filtersBar}>
          {organizations.length > 1 && (
            <div style={filterGroup}>
              <label style={filterLabel}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                Organization
              </label>
              <select
                value={selectedOrg}
                onChange={(e) => setSelectedOrg(e.target.value)}
                style={filterSelect}
              >
                {organizations.map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </div>
          )}

          <div style={filterGroup}>
            <label style={filterLabel}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              Location
            </label>
            <select
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
              style={filterSelect}
            >
              {locations.length === 0 ? (
                <option value="">{dataLoaded ? 'No locations available' : 'Loading…'}</option>
              ) : (
                locations.map(loc => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))
              )}
            </select>
          </div>

          {getCurrentLocation()?.publicCode && (
            <div style={locationInfo}>
              <span style={locationBadge}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                /join/{getCurrentLocation()?.publicCode}
              </span>
            </div>
          )}
        </div>

        {/* Service Details Panel */}
        {showDetails && selectedService && (
          <div style={detailsPanel}>
            <div style={detailsHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <h2 style={detailsTitle}>{selectedService.name}</h2>
                <span style={selectedService.type === 'GENERAL' ? typeBadgeGeneral : typeBadgeIndividual}>
                  {selectedService.type}
                </span>
              </div>
              <button onClick={() => setShowDetails(false)} style={closeButton}>×</button>
            </div>
            
            <div style={detailsBody}>
              {selectedService.description && (
                <p style={serviceDescription}>{selectedService.description}</p>
              )}
              
              <div style={detailsGrid}>
                <div style={detailItem}>
                  <span style={detailLabel}>Slot Duration</span>
                  <span style={detailValue}>{selectedService.slotDuration} minutes</span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>Concurrent Limit</span>
                  <span style={detailValue}>{selectedService.concurrentLimit} at a time</span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>Operating Hours</span>
                  <span style={detailValue}>{selectedService.startTime || '09:00'} - {selectedService.endTime || '17:00'}</span>
                </div>
                <div style={detailItem}>
                  <span style={detailLabel}>Active Days</span>
                  <span style={detailValue}>{getDayNames(selectedService.activeDays || '1,2,3,4,5')}</span>
                </div>
              </div>

              {/* Quick Stats */}
              <div style={statsSection}>
                <h3 style={statsSectionTitle}>Queue Information</h3>
                <div style={statsGrid}>
                  <div style={statCard}>
                    <div style={statIcon}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </div>
                    <div>
                      <div style={statValue}>{selectedService.queues?.length || 0}</div>
                      <div style={statLabel}>Active Queues</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div style={detailsActions}>
              <button onClick={() => startEdit(selectedService)} style={editButtonLarge}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit Service
              </button>
              <button onClick={() => handleDeleteService(selectedService.id)} style={deleteButtonLarge}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Service
              </button>
            </div>
          </div>
        )}

        {/* Edit Service Form */}
        {showForm && (
          <div style={formCard}>
            <div style={formHeader}>
              <h3 style={formTitle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit Service
              </h3>
              <button onClick={resetForm} style={closeButton}>×</button>
            </div>
            <form onSubmit={handleUpdateService} style={formBody}>
              <div style={formGrid}>
                <div style={formField}>
                  <label style={labelStyle}>Service Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., General Consultation"
                    required
                    style={inputStyle}
                  />
                </div>

                <div style={formField}>
                  <label style={labelStyle}>Type</label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as ServiceType })}
                    style={inputStyle}
                  >
                    <option value="GENERAL">General (First come, first served)</option>
                    <option value="INDIVIDUAL">Individual (Appointment-based)</option>
                  </select>
                </div>

                <div style={formField}>
                  <label style={labelStyle}>Slot Duration (minutes)</label>
                  <input
                    type="number"
                    value={formData.slotDuration}
                    onChange={(e) => setFormData({ ...formData, slotDuration: parseInt(e.target.value) })}
                    min={5}
                    style={inputStyle}
                  />
                </div>

                <div style={formField}>
                  <label style={labelStyle}>Concurrent Limit</label>
                  <input
                    type="number"
                    value={formData.concurrentLimit}
                    onChange={(e) => setFormData({ ...formData, concurrentLimit: parseInt(e.target.value) })}
                    min={1}
                    style={inputStyle}
                  />
                </div>

                <div style={formField}>
                  <label style={labelStyle}>Start Time</label>
                  <input
                    type="time"
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    style={inputStyle}
                  />
                </div>

                <div style={formField}>
                  <label style={labelStyle}>End Time</label>
                  <input
                    type="time"
                    value={formData.endTime}
                    onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                    style={inputStyle}
                  />
                </div>
              </div>

              <div style={formFieldFull}>
                <label style={labelStyle}>Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Describe the service..."
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </div>

              <div style={formFieldFull}>
                <Checkbox
                  checked={formData.requiresClearance}
                  onChange={(e) => setFormData({ ...formData, requiresClearance: e.target.checked })}
                  label="Wait for payment before they can be called (shown as “Awaiting payment” until staff or your records system clears it)"
                />
              </div>

              <div style={formFieldFull}>
                <label style={labelStyle}>Desks and rooms</label>
                {editingService && (
                  <ServicePointsDeskPicker
                    organizationId={user?.organizationId || ''}
                    selected={editServicePoints}
                    onChange={setEditServicePoints}
                  />
                )}
              </div>

              <div style={formActions}>
                <button type="submit" style={submitButton}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Save Changes
                </button>
                <button type="button" onClick={resetForm} style={cancelButton}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Services Grid */}
        {loading || (user?.organizationId && !dataLoaded) ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div className="spinner" />
          </div>
        ) : locations.length === 0 ? (
          <div style={emptyState}>
            <div style={emptyIcon}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
            <h3 style={emptyTitle}>No Locations Yet</h3>
            <p style={emptyText}>Create a location first before adding services</p>
            <a href="/admin/locations" style={emptyLink}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              Go to Locations
            </a>
          </div>
        ) : services.length === 0 && !showForm ? (
          <div style={emptyState}>
            <div style={emptyIcon}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            </div>
            <h3 style={emptyTitle}>No Services Yet</h3>
            <p style={emptyText}>Create your first service to start managing queues</p>
            <button onClick={() => setShowWizard(true)} style={emptyButton}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Your First Service
            </button>
          </div>
        ) : (
          <div style={servicesGrid}>
            {services.map(service => (
              <div 
                key={service.id} 
                style={{
                  ...serviceCard,
                  ...(selectedService?.id === service.id ? serviceCardActive : {}),
                }}
                onClick={() => openDetails(service)}
              >
                <div style={cardHeader}>
                  <div style={cardIcon}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="12 2 2 7 12 12 22 7 12 2" />
                      <polyline points="2 17 12 22 22 17" />
                      <polyline points="2 12 12 17 22 12" />
                    </svg>
                  </div>
                  {service.type === 'INDIVIDUAL' && <span style={typeBadgeIndividual}>Appointments</span>}
                </div>
                <h3 style={serviceName}>{service.name}</h3>
                {service.description && <p style={serviceDesc}>{service.description}</p>}
                <div style={serviceDetails}>
                  <div style={detailChip}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    {service.slotDuration} min
                  </div>
                  <div style={detailChip}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    {service.concurrentLimit} at a time
                  </div>
                  <div style={detailChip}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    {service.startTime || '09:00'} - {service.endTime || '17:00'}
                  </div>
                </div>

                <div style={cardClickHint}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  Details
                </div>

                <div style={cardActions} onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => startEdit(service)} style={editButton}>
                    Edit
                  </button>
                  <button onClick={() => handleDeleteService(service.id)} style={deleteButton}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showWizard && user?.organizationId && (
          <AddServiceWizard
            organizationId={user.organizationId}
            locations={locations}
            onClose={() => setShowWizard(false)}
            onSubmit={handleWizardSubmit}
          />
        )}
      </div>
    </Layout>
  );
};

export default ServicesPage;

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

const filtersBar: React.CSSProperties = {
  display: 'flex',
  gap: '1.5rem',
  marginBottom: '1.5rem',
  padding: '1rem 1.25rem',
  background: 'white',
  borderRadius: '12px',
  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)',
  alignItems: 'flex-end',
  flexWrap: 'wrap',
};

const filterGroup: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const filterLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#6b7280',
  
  letterSpacing: '0.5px',
};

const filterSelect: React.CSSProperties = {
  padding: '0.6rem 1rem',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  fontSize: '0.95rem',
  minWidth: '200px',
  cursor: 'pointer',
  background: 'white',
  color: '#374151',
};

const locationInfo: React.CSSProperties = {
  marginLeft: 'auto',
};

const locationBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.5rem 0.875rem',
  background: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)',
  color: '#166534',
  borderRadius: '8px',
  fontSize: '0.875rem',
  fontWeight: 600,
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

const serviceDescription: React.CSSProperties = {
  margin: '0 0 1.5rem',
  color: '#6b7280',
  lineHeight: 1.6,
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

const statsSection: React.CSSProperties = {
  padding: '1.25rem',
  background: '#f9fafb',
  borderRadius: '12px',
};

const statsSectionTitle: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#374151',
};

const statsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '1rem',
};

const statCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '1rem',
  background: 'white',
  borderRadius: '10px',
  border: '1px solid #e5e7eb',
};

const statIcon: React.CSSProperties = {
  width: '40px',
  height: '40px',
  background: 'rgba(15, 159, 164, 0.1)',
  borderRadius: '10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#0f9fa4',
};

const statValue: React.CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 700,
  color: '#111827',
};

const statLabel: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#6b7280',
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
  marginBottom: '2rem',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
  overflow: 'hidden',
};

const formHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1.25rem 1.5rem',
  background: '#f8fafc',
  borderBottom: '1px solid #e5e7eb',
};

const formTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  margin: 0,
  fontSize: '1.1rem',
  color: '#111827',
};

const closeButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: '1.5rem',
  color: '#9ca3af',
  cursor: 'pointer',
  lineHeight: 1,
};

const formBody: React.CSSProperties = {
  padding: '1.5rem',
};

const formGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '1.25rem',
  marginBottom: '1.25rem',
};

const formField: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const formFieldFull: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  marginBottom: '1.25rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: '#374151',
};

const inputStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  fontSize: '0.95rem',
  background: '#f9fafb',
  color: '#111827',
};

const formActions: React.CSSProperties = {
  display: 'flex',
  gap: '1rem',
};

const submitButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.5rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '10px',
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const cancelButton: React.CSSProperties = {
  padding: '0.75rem 1.5rem',
  background: '#f1f5f9',
  color: '#64748b',
  border: 'none',
  borderRadius: '10px',
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const servicesGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
  gap: '1.5rem',
};

const serviceCard: React.CSSProperties = {
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

const serviceCardActive: React.CSSProperties = {
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

const typeBadgeGeneral: React.CSSProperties = {
  padding: '0.35rem 0.75rem',
  background: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)',
  color: '#16a34a',
  borderRadius: '20px',
  fontSize: '0.75rem',
  fontWeight: 600,
  
  letterSpacing: '0.5px',
};

const typeBadgeIndividual: React.CSSProperties = {
  padding: '0.35rem 0.75rem',
  background: 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)',
  color: '#2563eb',
  borderRadius: '20px',
  fontSize: '0.75rem',
  fontWeight: 600,
  
  letterSpacing: '0.5px',
};

const serviceName: React.CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: '1.25rem',
  fontWeight: 600,
  color: '#111827',
};

const serviceDesc: React.CSSProperties = {
  margin: '0 0 1.25rem',
  color: '#6b7280',
  fontSize: '0.9rem',
  lineHeight: 1.5,
};

const serviceDetails: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  padding: '1rem',
  background: '#f8fafc',
  borderRadius: '10px',
  marginBottom: '1rem',
};

const detailChip: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.85rem',
  color: '#6b7280',
};

const cardClickHint: React.CSSProperties = {
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

const emptyState: React.CSSProperties = {
  textAlign: 'center',
  padding: '4rem 2rem',
  background: 'white',
  borderRadius: '16px',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
};

const emptyIcon: React.CSSProperties = {
  width: '100px',
  height: '100px',
  background: 'rgba(15, 159, 164, 0.1)',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: '0 auto 1.5rem',
  color: '#0f9fa4',
};

const emptyTitle: React.CSSProperties = {
  margin: '0 0 0.5rem',
  color: '#111827',
  fontSize: '1.25rem',
};

const emptyText: React.CSSProperties = {
  margin: '0 0 1.5rem',
  color: '#6b7280',
};

const emptyButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.5rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '10px',
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const emptyLink: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.5rem',
  background: '#0f9fa4',
  color: 'white',
  borderRadius: '10px',
  fontSize: '0.95rem',
  fontWeight: 600,
  textDecoration: 'none',
};

// Service Points Styles
const servicePointsButtonLarge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.75rem 1.25rem',
  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
  color: 'white',
  border: 'none',
  borderRadius: '10px',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)',
};

const servicePointsSection: React.CSSProperties = {
  background: 'var(--bg-tertiary, #f9fafb)',
  borderRadius: '12px',
  padding: '1.25rem',
  border: '1px solid var(--border-color, #e5e7eb)',
};

const sectionTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  margin: '0 0 1rem',
  fontSize: '1rem',
  fontWeight: 600,
  color: 'var(--text-primary, #111827)',
};

const emptyServicePoints: React.CSSProperties = {
  textAlign: 'center',
  padding: '2rem 1rem',
  color: 'var(--text-secondary, #6b7280)',
};

const servicePointsList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const servicePointCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '1rem',
  background: 'white',
  borderRadius: '10px',
  border: '1px solid #d1fae5',
  boxShadow: '0 2px 8px rgba(16, 185, 129, 0.1)',
};

const servicePointCardAvailable: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '1rem',
  background: 'white',
  borderRadius: '10px',
  border: '1px solid var(--border-color, #e5e7eb)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)',
};

const servicePointInfo: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
};

const servicePointIcon: React.CSSProperties = {
  width: '40px',
  height: '40px',
  background: 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)',
  borderRadius: '10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#059669',
};

const servicePointIconAvailable: React.CSSProperties = {
  width: '40px',
  height: '40px',
  background: 'var(--bg-tertiary, #f3f4f6)',
  borderRadius: '10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-secondary, #6b7280)',
};

const servicePointName: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.95rem',
  color: 'var(--text-primary, #111827)',
};

const servicePointMeta: React.CSSProperties = {
  fontSize: '0.8rem',
  color: 'var(--text-secondary, #6b7280)',
  marginTop: '0.125rem',
};

const capacityEditWrapper: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginLeft: 'auto',
  marginRight: '0.5rem',
};

const capacityLabel: React.CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--text-secondary, #6b7280)',
  fontWeight: 500,
};

const capacityInput: React.CSSProperties = {
  width: '60px',
  padding: '0.25rem 0.5rem',
  border: '1px solid var(--border, #e5e7eb)',
  borderRadius: '6px',
  fontSize: '0.85rem',
  textAlign: 'center',
};

const resetCapacityButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  background: 'transparent',
  border: '1px solid var(--border, #e5e7eb)',
  borderRadius: '4px',
  color: 'var(--text-secondary, #6b7280)',
  cursor: 'pointer',
  fontSize: '0.9rem',
};

const unlinkButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  color: '#dc2626',
  cursor: 'pointer',
};

const linkButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.5rem 1rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
};
