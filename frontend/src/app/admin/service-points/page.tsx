'use client';

import NoOrganization from '@/components/NoOrganization';
import React, { useEffect, useState, useCallback } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Building2, Syringe, Stethoscope, Wallet, Pill, FlaskConical, Camera, MapPin } from 'lucide-react';
import api from '@/api/client';
import Layout from '@/components/Layout';
import { useAuthContext } from '@/contexts/AuthContext';
import { Icon, PageHeader } from '@/components/ui';
import type { ServicePoint, ServicePointType } from '@/types';
import { confirmDialog } from '@/lib/dialog';

const SERVICE_POINT_TYPES: { value: ServicePointType; label: string; icon: LucideIcon }[] = [
  { value: 'RECEPTION', label: 'Reception', icon: Building2 },
  { value: 'TRIAGE', label: 'Triage', icon: Syringe },
  { value: 'CONSULTATION', label: 'Consultation', icon: Stethoscope },
  { value: 'CASHIER', label: 'Cashier', icon: Wallet },
  { value: 'PHARMACY', label: 'Pharmacy', icon: Pill },
  { value: 'LAB', label: 'Laboratory', icon: FlaskConical },
  { value: 'IMAGING', label: 'Imaging', icon: Camera },
  { value: 'OTHER', label: 'Other', icon: MapPin },
];

const ServicePointsPage: React.FC = () => {
  const { user } = useAuthContext();
  const [servicePoints, setServicePoints] = useState<ServicePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPoint, setEditingPoint] = useState<ServicePoint | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    displayName: '',
    type: 'OTHER' as ServicePointType,
    capacity: 1,
    isActive: true,
  });

  useEffect(() => {
    loadServicePoints();
  }, [user]);

  const loadServicePoints = async () => {
    if (!user?.organizationId) {
      setServicePoints([]);
      setLoading(false);
      return;
    }
    try {
      const points = await api.getServicePoints(user.organizationId);
      setServicePoints(points);
      setError('');
    } catch (err) {
      console.error('Failed to load service points', err);
      setError('Failed to load service points');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenModal = (point?: ServicePoint) => {
    if (point) {
      setEditingPoint(point);
      setFormData({
        name: point.name,
        displayName: point.displayName || '',
        type: point.type,
        capacity: point.capacity,
        isActive: point.isActive,
      });
    } else {
      setEditingPoint(null);
      setFormData({
        name: '',
        displayName: '',
        type: 'OTHER',
        capacity: 1,
        isActive: true,
      });
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingPoint(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      if (editingPoint) {
        await api.updateServicePoint(editingPoint.id, formData);
      } else {
        if (!user?.organizationId) return;
        await api.createServicePoint({
          organizationId: user.organizationId,
          ...formData,
        });
      }

      await loadServicePoints();
      handleCloseModal();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || 'Failed to save service point');
    }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({ title: 'Delete this service point?', tone: 'danger' }))) return;

    try {
      await api.deleteServicePoint(id);
      await loadServicePoints();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || 'Failed to delete service point');
    }
  };

  const handleToggleActive = async (point: ServicePoint) => {
    try {
      await api.updateServicePoint(point.id, { isActive: !point.isActive });
      await loadServicePoints();
    } catch (err) {
      console.error('Failed to toggle active state', err);
    }
  };

  const getTypeInfo = (type: ServicePointType) => {
    return SERVICE_POINT_TYPES.find(t => t.value === type) || SERVICE_POINT_TYPES[7];
  };

  if (loading) {
    return (
      <Layout>
        <div className="loading-container">
          <div className="loading-spinner" />
          <p>Loading service points...</p>
        </div>
        <style jsx>{`
          .loading-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 400px;
            color: var(--text-secondary);
          }
          .loading-spinner {
            width: 48px;
            height: 48px;
            border: 4px solid var(--border);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </Layout>
    );
  }

  if (!user?.organizationId) {
    return <NoOrganization />;
  }

  return (
    <Layout>
      <div className="service-points-page">
        <PageHeader
          icon={Building2}
          title="Desks & rooms"
          subtitle="Where staff sit to call people: counters, desks and rooms. Link each to the services it handles."
          actions={
            <div className="header-actions">
              <button className="add-btn" onClick={() => handleOpenModal()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Service Point
              </button>
            </div>
          }
        />

        {error && (
          <div className="error-alert">
            {error}
            <button onClick={() => setError('')} className="close-btn">×</button>
          </div>
        )}

        {/* Service Points Grid */}
        {servicePoints.length === 0 ? (
          <div className="empty-state">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <h3>No Service Points</h3>
            <p>Create service points to define where customers are served</p>
            <button className="add-btn" onClick={() => handleOpenModal()}>
              Add First Service Point
            </button>
          </div>
        ) : (
          <div className="points-grid">
            {servicePoints.map(point => {
              const typeInfo = getTypeInfo(point.type);
              return (
                <div 
                  key={point.id} 
                  className={`point-card ${!point.isActive ? 'inactive' : ''}`}
                >
                  <div className="point-header">
                    <span className="point-icon"><Icon icon={typeInfo.icon} size={28} color="#0f9fa4" /></span>
                    <div className="point-title">
                      <h3>{point.name}</h3>
                      {point.displayName && point.displayName !== point.name && (
                        <span className="display-name">Display: {point.displayName}</span>
                      )}
                    </div>
                    <div className="point-actions">
                      <button 
                        className={`toggle-btn ${point.isActive ? 'active' : ''}`}
                        onClick={() => handleToggleActive(point)}
                        title={point.isActive ? 'Deactivate' : 'Activate'}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {point.isActive ? (
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                          ) : (
                            <circle cx="12" cy="12" r="10" />
                          )}
                          {point.isActive && <polyline points="22 4 12 14.01 9 11.01" />}
                        </svg>
                      </button>
                      <button 
                        className="edit-btn"
                        onClick={() => handleOpenModal(point)}
                        title="Edit"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button 
                        className="delete-btn"
                        onClick={() => handleDelete(point.id)}
                        title="Delete"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  
                  <div className="point-details">
                    <div className="detail">
                      <span className="label">Type</span>
                      <span className="value">{typeInfo.label}</span>
                    </div>
                    <div className="detail">
                      <span className="label">Capacity</span>
                      <span className="value">{point.capacity}</span>
                    </div>
                    <div className="detail">
                      <span className="label">Status</span>
                      <span className={`status ${point.isActive ? 'active' : 'inactive'}`}>
                        {point.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="detail">
                      <span className="label">Used In</span>
                      <span className="value">{point.usedInServicesCount ?? 0} service{point.usedInServicesCount === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Modal */}
        {showModal && (
          <div className="modal-overlay" onClick={handleCloseModal}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>{editingPoint ? 'Edit Service Point' : 'Add Service Point'}</h2>
              
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Reception Desk 1"
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Display Name</label>
                  <input
                    type="text"
                    value={formData.displayName}
                    onChange={e => setFormData({ ...formData, displayName: e.target.value })}
                    placeholder="Friendly name for display boards"
                  />
                </div>

                <div className="form-group">
                  <label>Type</label>
                  <div className="type-grid">
                    {SERVICE_POINT_TYPES.map(type => (
                      <button
                        key={type.value}
                        type="button"
                        className={`type-option ${formData.type === type.value ? 'selected' : ''}`}
                        onClick={() => setFormData({ ...formData, type: type.value })}
                      >
                        <span className="type-icon"><Icon icon={type.icon} size={18} /></span>
                        <span>{type.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Capacity</label>
                    <input
                      type="number"
                      min="1"
                      value={formData.capacity}
                      onChange={e => setFormData({ ...formData, capacity: parseInt(e.target.value) || 1 })}
                    />
                  </div>

                  <div className="form-group">
                    <label>Active</label>
                    <div className="toggle-wrapper">
                      <input
                        type="checkbox"
                        id="isActive"
                        checked={formData.isActive}
                        onChange={e => setFormData({ ...formData, isActive: e.target.checked })}
                      />
                      <label htmlFor="isActive" className="toggle-label">
                        {formData.isActive ? 'Yes' : 'No'}
                      </label>
                    </div>
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" className="cancel-btn" onClick={handleCloseModal}>
                    Cancel
                  </button>
                  <button type="submit" className="submit-btn">
                    {editingPoint ? 'Save Changes' : 'Create Service Point'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        <style jsx>{`
          .header-actions {
            display: flex;
            align-items: center;
            gap: 1rem;
          }

          .add-btn {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.75rem 1.25rem;
            background: white;
            color: var(--primary);
            border: none;
            border-radius: 10px;
            font-size: 0.95rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }

          .add-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          }

          .error-alert {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #fef2f2;
            border-width: 1px;
            border-style: solid;
            border-color: #fecaca;
            color: #dc2626;
            padding: 1rem;
            border-radius: 12px;
            margin-bottom: 1.5rem;
          }

          .close-btn {
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: inherit;
            padding: 0;
            line-height: 1;
          }

          .empty-state {
            text-align: center;
            padding: 4rem 2rem;
            background: white;
            border-radius: 16px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
          }

          .empty-state svg {
            margin-bottom: 1rem;
            color: var(--text-secondary);
          }

          .empty-state h3 {
            margin: 0 0 0.5rem;
            font-size: 1.25rem;
          }

          .empty-state p {
            margin: 0 0 1.5rem;
            color: var(--text-secondary);
          }

          .points-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
            gap: 1.25rem;
          }

          .point-card {
            background: white;
            border-radius: 12px;
            padding: 1.25rem;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
            transition: all 0.2s;
          }

          .point-card:hover {
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
          }

          .point-card.inactive {
            opacity: 0.6;
          }

          .point-header {
            display: flex;
            align-items: flex-start;
            gap: 0.75rem;
            margin-bottom: 1rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border);
          }

          .point-icon {
            font-size: 2rem;
          }

          .point-title {
            flex: 1;
          }

          .point-title h3 {
            margin: 0;
            font-size: 1.1rem;
            font-weight: 600;
          }

          .display-name {
            font-size: 0.8rem;
            color: var(--text-secondary);
          }

          .point-actions {
            display: flex;
            gap: 0.25rem;
          }

          .point-actions button {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .toggle-btn {
            background: #f3f4f6;
            color: var(--text-secondary);
          }

          .toggle-btn.active {
            background: #dcfce7;
            color: #16a34a;
          }

          .edit-btn {
            background: #f3f4f6;
            color: var(--text-secondary);
          }

          .edit-btn:hover {
            background: rgba(15, 159, 164, 0.1);
            color: var(--primary);
          }

          .delete-btn {
            background: #f3f4f6;
            color: var(--text-secondary);
          }

          .delete-btn:hover {
            background: #fee2e2;
            color: #dc2626;
          }

          .point-details {
            display: flex;
            gap: 1.5rem;
          }

          .detail {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
          }

          .detail .label {
            font-size: 0.75rem;
            color: var(--text-secondary);
          }

          .detail .value {
            font-weight: 500;
          }

          .detail .status {
            font-size: 0.85rem;
            font-weight: 500;
          }

          .detail .status.active {
            color: #16a34a;
          }

          .detail .status.inactive {
            color: var(--text-secondary);
          }

          /* Modal */
          .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            padding: 1rem;
          }

          .modal {
            background: white;
            border-radius: 16px;
            padding: 2rem;
            max-width: 500px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
          }

          .modal h2 {
            margin: 0 0 1.5rem;
            font-size: 1.25rem;
          }

          .form-group {
            margin-bottom: 1.25rem;
          }

          .form-group label {
            display: block;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
            color: var(--text);
          }

          .form-group input[type="text"],
          .form-group input[type="number"] {
            width: 100%;
            padding: 0.75rem 1rem;
            font-size: 1rem;
            border-width: 1px;
            border-style: solid;
            border-color: var(--border);
            border-radius: 8px;
          }

          .form-group input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
          }

          .type-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 0.5rem;
          }

          .type-option {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.25rem;
            padding: 0.75rem 0.5rem;
            background: #f8fafc;
            border-width: 1px;
            border-style: solid;
            border-color: var(--border);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 0.75rem;
          }

          .type-option:hover {
            border-color: var(--primary);
          }

          .type-option.selected {
            background: rgba(15, 159, 164, 0.1);
            border-color: var(--primary);
            color: var(--primary);
          }

          .type-icon {
            font-size: 1.25rem;
          }

          .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
          }

          .toggle-wrapper {
            display: flex;
            align-items: center;
            gap: 0.5rem;
          }

          .toggle-wrapper input[type="checkbox"] {
            width: 18px;
            height: 18px;
          }

          .toggle-label {
            font-weight: 400 !important;
            margin: 0 !important;
          }

          .modal-actions {
            display: flex;
            gap: 0.75rem;
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
          }

          .cancel-btn {
            flex: 1;
            padding: 0.75rem;
            background: #f3f4f6;
            color: var(--text);
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
          }

          .submit-btn {
            flex: 1;
            padding: 0.75rem;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
          }

          .submit-btn:hover {
            background: var(--primary-dark);
          }

          @media (max-width: 768px) {
            .header-actions {
              flex-direction: column;
            }

            .type-grid {
              grid-template-columns: repeat(2, 1fr);
            }

            .form-row {
              grid-template-columns: 1fr;
            }
          }
        `}</style>
      </div>
    </Layout>
  );
};

export default ServicePointsPage;
