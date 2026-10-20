'use client';

import { toast, errorMessage } from '@/lib/toast';
import { useTerms } from '@/hooks/useTerms';
import React, { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Plug, Database, FileText, Link2, Package, Search, Pause, Play, Pencil, Trash2 } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import { Icon, PageHeader } from '@/components/ui';
import { confirmDialog } from '@/lib/dialog';

interface FieldMapping {
  id: string;
  sourcePath: string;
  targetField: string;
  transform?: string;
}

interface DataSource {
  id: string;
  name: string;
  description?: string;
  type: 'API' | 'DATABASE' | 'FILE' | 'WEBHOOK' | 'INTEGRATION';
  config: Record<string, unknown>;
  isActive: boolean;
  fieldMappings: FieldMapping[];
  createdAt: string;
}

interface IdentityFieldConfig {
  name: string;
  label: string;
  required: boolean;
  type: string;
}

interface OrganizationSettings {
  identityFieldsConfig?: IdentityFieldConfig[];
}

const DATA_SOURCE_TYPES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'API', label: 'REST API', icon: Plug },
  { value: 'DATABASE', label: 'Database', icon: Database },
  { value: 'FILE', label: 'File Import', icon: FileText },
  { value: 'WEBHOOK', label: 'Webhook', icon: Link2 },
];

// Set up by a system connection (Klargy Connect), not from this page.
const typeLabel = (type: string) => (type === 'INTEGRATION' ? 'Connected system' : type);

const TRANSFORM_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'trim', label: 'Trim whitespace' },
  { value: 'toNumber', label: 'Convert to number' },
  { value: 'toString', label: 'Convert to string' },
  { value: 'toDate', label: 'Parse as date' },
  { value: 'formatPhone', label: 'Format phone number' },
];

const COMMON_IDENTITY_FIELDS = [
  'mrNumber',
  'patientId',
  'insuranceId',
  'nationalId',
  'firstName',
  'lastName',
  'dateOfBirth',
  'gender',
  'address',
  'email',
  'alternatePhone',
  'emergencyContact',
  'allergies',
  'medicalConditions',
  'lastVisitDate',
  'primaryPhysician',
];

export default function AdminDataSourcesPage() {
  const { user, isAdmin } = useAuthContext();
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingSource, setEditingSource] = useState<DataSource | null>(null);
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; data?: unknown } | null>(null);
  const [testing, setTesting] = useState(false);
  const [customIdentityFields, setCustomIdentityFields] = useState<IdentityFieldConfig[]>([]);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'API' as 'API' | 'DATABASE' | 'FILE' | 'WEBHOOK',
    isActive: true,
    config: {
      url: '',
      authType: 'none',
      authToken: '',
      authUsername: '',
      authPassword: '',
      apiKeyHeader: '',
      apiKey: '',
      searchEndpoint: '',
      searchParam: 'phone',
    },
  });

  const [mappingForm, setMappingForm] = useState({
    sourcePath: '',
    targetField: '',
    transform: '',
  });

  useEffect(() => {
    if (isAdmin && user?.organizationId) {
      loadDataSources();
      loadOrganizationSettings();
    } else {
      setLoading(false);
    }
  }, [isAdmin, user?.organizationId]);

  const loadOrganizationSettings = async () => {
    if (!user?.organizationId) return;
    try {
      const org = await api.getOrganization(user.organizationId);
      if (org.identityFieldsConfig) {
        setCustomIdentityFields(org.identityFieldsConfig as IdentityFieldConfig[]);
      }
    } catch (err) {
      console.error('Failed to load organization settings:', err);
    }
  };

  const loadDataSources = async () => {
    if (!user?.organizationId) return;
    setLoading(true);
    try {
      const data = await api.getDataSources(user.organizationId);
      setDataSources(data);
    } catch (err) {
      console.error('Failed to load data sources:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.organizationId) return;

    try {
      const config: Record<string, unknown> = {
        url: formData.config.url,
        searchEndpoint: formData.config.searchEndpoint,
        searchParam: formData.config.searchParam,
      };

      // Add auth config based on type
      if (formData.config.authType === 'bearer') {
        config.auth = { type: 'bearer', token: formData.config.authToken };
      } else if (formData.config.authType === 'basic') {
        config.auth = { 
          type: 'basic', 
          username: formData.config.authUsername, 
          password: formData.config.authPassword 
        };
      } else if (formData.config.authType === 'apiKey') {
        config.auth = { 
          type: 'apiKey', 
          headerName: formData.config.apiKeyHeader, 
          apiKey: formData.config.apiKey 
        };
      }

      if (editingSource) {
        await api.updateDataSource(editingSource.id, {
          name: formData.name,
          description: formData.description || undefined,
          type: formData.type,
          config,
          isActive: formData.isActive,
        });
      } else {
        await api.createDataSource(user.organizationId, {
          name: formData.name,
          description: formData.description || undefined,
          type: formData.type,
          config,
          isActive: formData.isActive,
        });
      }

      resetForm();
      loadDataSources();
    } catch (err) {
      console.error('Failed to save data source:', err);
      toast.error('Couldn’t save the data source.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog({ title: 'Delete this data source?', tone: 'danger' }))) return;
    
    try {
      await api.deleteDataSource(id);
      loadDataSources();
      if (selectedSource?.id === id) {
        setSelectedSource(null);
      }
    } catch (err) {
      console.error('Failed to delete data source:', err);
      toast.error('Couldn’t delete the data source.');
    }
  };

  const handleTest = async (source: DataSource) => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testDataSource(source.id);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ 
        success: false, 
        message: err.response?.data?.error || 'Test failed' 
      });
    } finally {
      setTesting(false);
    }
  };

  const handleToggleActive = async (source: DataSource) => {
    try {
      await api.updateDataSource(source.id, { isActive: !source.isActive });
      loadDataSources();
    } catch (err) {
      console.error('Failed to toggle data source:', err);
    }
  };

  const handleAddMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSource) return;

    try {
      await api.createFieldMapping(selectedSource.id, {
        sourcePath: mappingForm.sourcePath,
        targetField: mappingForm.targetField,
        transform: mappingForm.transform || undefined,
      });
      setMappingForm({ sourcePath: '', targetField: '', transform: '' });
      loadDataSources();
      // Refresh selected source
      const updated = await api.getDataSource(selectedSource.id);
      setSelectedSource(updated);
    } catch (err) {
      console.error('Failed to add mapping:', err);
      toast.error('Couldn’t add the field mapping.');
    }
  };

  const handleDeleteMapping = async (mappingId: string) => {
    try {
      await api.deleteFieldMapping(mappingId);
      loadDataSources();
      if (selectedSource) {
        const updated = await api.getDataSource(selectedSource.id);
        setSelectedSource(updated);
      }
    } catch (err) {
      console.error('Failed to delete mapping:', err);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      type: 'API',
      isActive: true,
      config: {
        url: '',
        authType: 'none',
        authToken: '',
        authUsername: '',
        authPassword: '',
        apiKeyHeader: '',
        apiKey: '',
        searchEndpoint: '',
        searchParam: 'phone',
      },
    });
    setEditingSource(null);
    setShowForm(false);
  };

  const openEditForm = (source: DataSource) => {
    if (source.type === 'INTEGRATION') return;
    const config = source.config as Record<string, unknown>;
    const auth = config.auth as Record<string, string> | undefined;
    
    setFormData({
      name: source.name,
      description: source.description || '',
      type: source.type as Exclude<DataSource['type'], 'INTEGRATION'>,
      isActive: source.isActive,
      config: {
        url: (config.url as string) || '',
        authType: auth?.type || 'none',
        authToken: auth?.type === 'bearer' ? auth.token || '' : '',
        authUsername: auth?.type === 'basic' ? auth.username || '' : '',
        authPassword: auth?.type === 'basic' ? auth.password || '' : '',
        apiKeyHeader: auth?.type === 'apiKey' ? auth.headerName || '' : '',
        apiKey: auth?.type === 'apiKey' ? auth.apiKey || '' : '',
        searchEndpoint: (config.searchEndpoint as string) || '',
        searchParam: (config.searchParam as string) || 'phone',
      },
    });
    setEditingSource(source);
    setShowForm(true);
  };

  if (!isAdmin) {
    return (
      <Layout>
        <div className="access-denied">
          <h2>Access Denied</h2>
          <p>You don&apos;t have permission to access this page.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="page-container">
        <PageHeader
          icon={Database}
          title="Data sources"
          subtitle="Look people up in your own systems (records, CRM, databases) from the desk."
          actions={
            <button className="btn-primary" onClick={() => setShowForm(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Data Source
            </button>
          }
        />

        {loading ? (
          <div className="loading">Loading data sources...</div>
        ) : (
          <div className="content-grid">
            <div className="sources-list">
              {dataSources.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"><Icon icon={Plug} size={40} color="#0f9fa4" strokeWidth={1.5} /></div>
                  <h3>No data sources configured</h3>
                  <p>Add a data source to connect external systems and enrich customer data.</p>
                </div>
              ) : (
                dataSources.map(source => (
                  <div 
                    key={source.id} 
                    className={`source-card ${selectedSource?.id === source.id ? 'selected' : ''} ${!source.isActive ? 'inactive' : ''}`}
                    onClick={() => setSelectedSource(source)}
                  >
                    <div className="source-header">
                      <span className="source-icon">
                        <Icon icon={DATA_SOURCE_TYPES.find(t => t.value === source.type)?.icon || (source.type === 'INTEGRATION' ? Link2 : Package)} size={22} color="#0f9fa4" />
                      </span>
                      <div className="source-info">
                        <h3>{source.name}</h3>
                        <span className="source-type">{typeLabel(source.type)}</span>
                      </div>
                      <div className="source-status">
                        <span className={`status-badge ${source.isActive ? 'active' : 'inactive'}`}>
                          {source.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </div>
                    {source.description && (
                      <p className="source-description">{source.description}</p>
                    )}
                    <div className="source-meta">
                      <span>{source.fieldMappings.length} field mappings</span>
                    </div>
                    <div className="source-actions">
                      <button 
                        className="btn-icon" 
                        onClick={(e) => { e.stopPropagation(); handleTest(source); }}
                        title="Test connection"
                      >
                        <Icon icon={Search} size={16} />
                      </button>
                      <button
                        className="btn-icon"
                        onClick={(e) => { e.stopPropagation(); handleToggleActive(source); }}
                        title={source.isActive ? 'Deactivate' : 'Activate'}
                      >
                        <Icon icon={source.isActive ? Pause : Play} size={16} />
                      </button>
                      {source.type !== 'INTEGRATION' && (
                        <button
                          className="btn-icon"
                          onClick={(e) => { e.stopPropagation(); openEditForm(source); }}
                          title="Edit"
                        >
                          <Icon icon={Pencil} size={16} />
                        </button>
                      )}
                      <button
                        className="btn-icon danger"
                        onClick={(e) => { e.stopPropagation(); handleDelete(source.id); }}
                        title="Delete"
                      >
                        <Icon icon={Trash2} size={16} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {selectedSource && (
              <div className="source-details">
                <div className="details-header">
                  <h2>{selectedSource.name}</h2>
                  <button className="btn-close" onClick={() => setSelectedSource(null)}>×</button>
                </div>

                {testResult && (
                  <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                    <strong>{testResult.success ? '✓ Success' : '✗ Failed'}</strong>
                    <p>{testResult.message}</p>
                    {testResult.data != null && (
                      <pre>{JSON.stringify(testResult.data, null, 2)}</pre>
                    )}
                  </div>
                )}

                <div className="config-section">
                  <h3>Configuration</h3>
                  <div className="config-display">
                    <div className="config-item">
                      <label>Type</label>
                      <span>{typeLabel(selectedSource.type)}</span>
                    </div>
                    {selectedSource.type === 'API' && (
                      <>
                        <div className="config-item">
                          <label>URL</label>
                          <span>{(selectedSource.config as any).url || 'Not configured'}</span>
                        </div>
                        <div className="config-item">
                          <label>Search Endpoint</label>
                          <span>{(selectedSource.config as any).searchEndpoint || '/'}</span>
                        </div>
                        <div className="config-item">
                          <label>Search Parameter</label>
                          <span>{(selectedSource.config as any).searchParam || 'phone'}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="mappings-section">
                  <h3>Field Mappings</h3>
                  <p className="section-hint">Map response fields to customer identity fields</p>

                  <form className="mapping-form" onSubmit={handleAddMapping}>
                    <input
                      type="text"
                      placeholder="Source path (e.g., data.patient.mrn)"
                      value={mappingForm.sourcePath}
                      onChange={e => setMappingForm({ ...mappingForm, sourcePath: e.target.value })}
                      required
                    />
                    <select
                      value={mappingForm.targetField}
                      onChange={e => setMappingForm({ ...mappingForm, targetField: e.target.value })}
                      required
                    >
                      <option value="">Select target field</option>
                      <optgroup label="Standard Fields">
                        {COMMON_IDENTITY_FIELDS.map(field => (
                          <option key={field} value={field}>{field}</option>
                        ))}
                      </optgroup>
                      {customIdentityFields.length > 0 && (
                        <optgroup label="Custom Organization Fields">
                          {customIdentityFields.map(field => (
                            <option key={field.name} value={field.name}>
                              {field.label || field.name} {field.required ? '*' : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <option value="custom">Other custom field...</option>
                    </select>
                    <select
                      value={mappingForm.transform}
                      onChange={e => setMappingForm({ ...mappingForm, transform: e.target.value })}
                    >
                      {TRANSFORM_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <button type="submit" className="btn-add">Add</button>
                  </form>

                  <div className="mappings-list">
                    {selectedSource.fieldMappings.length === 0 ? (
                      <p className="no-mappings">No field mappings configured</p>
                    ) : (
                      selectedSource.fieldMappings.map(mapping => (
                        <div key={mapping.id} className="mapping-item">
                          <div className="mapping-path">
                            <code>{mapping.sourcePath}</code>
                            <span className="arrow">→</span>
                            <code>{mapping.targetField}</code>
                          </div>
                          {mapping.transform && (
                            <span className="transform-badge">{mapping.transform}</span>
                          )}
                          <button 
                            className="btn-remove" 
                            onClick={() => handleDeleteMapping(mapping.id)}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {showForm && (
          <div className="modal-overlay" onClick={() => resetForm()}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{editingSource ? 'Edit Data Source' : 'Add Data Source'}</h2>
                <button className="btn-close" onClick={resetForm}>×</button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g. Records system"
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Brief description of this data source"
                    rows={2}
                  />
                </div>

                <div className="form-group">
                  <label>Type *</label>
                  <div className="type-selector">
                    {DATA_SOURCE_TYPES.map(type => (
                      <button
                        key={type.value}
                        type="button"
                        className={`type-option ${formData.type === type.value ? 'selected' : ''}`}
                        onClick={() => setFormData({ ...formData, type: type.value as any })}
                      >
                        <span className="type-icon"><Icon icon={type.icon} size={18} /></span>
                        <span>{type.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {formData.type === 'API' && (
                  <>
                    <div className="form-group">
                      <label>API Base URL *</label>
                      <input
                        type="url"
                        value={formData.config.url}
                        onChange={e => setFormData({ 
                          ...formData, 
                          config: { ...formData.config, url: e.target.value } 
                        })}
                        placeholder="https://api.example.com"
                        required
                      />
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>Search Endpoint</label>
                        <input
                          type="text"
                          value={formData.config.searchEndpoint}
                          onChange={e => setFormData({ 
                            ...formData, 
                            config: { ...formData.config, searchEndpoint: e.target.value } 
                          })}
                          placeholder="/patients/search"
                        />
                      </div>
                      <div className="form-group">
                        <label>Search Parameter</label>
                        <input
                          type="text"
                          value={formData.config.searchParam}
                          onChange={e => setFormData({ 
                            ...formData, 
                            config: { ...formData.config, searchParam: e.target.value } 
                          })}
                          placeholder="phone"
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Authentication</label>
                      <select
                        value={formData.config.authType}
                        onChange={e => setFormData({ 
                          ...formData, 
                          config: { ...formData.config, authType: e.target.value } 
                        })}
                      >
                        <option value="none">None</option>
                        <option value="bearer">Bearer Token</option>
                        <option value="basic">Basic Auth</option>
                        <option value="apiKey">API Key</option>
                      </select>
                    </div>

                    {formData.config.authType === 'bearer' && (
                      <div className="form-group">
                        <label>Bearer Token</label>
                        <input
                          type="password"
                          value={formData.config.authToken}
                          onChange={e => setFormData({ 
                            ...formData, 
                            config: { ...formData.config, authToken: e.target.value } 
                          })}
                          placeholder="Enter token"
                        />
                      </div>
                    )}

                    {formData.config.authType === 'basic' && (
                      <div className="form-row">
                        <div className="form-group">
                          <label>Username</label>
                          <input
                            type="text"
                            value={formData.config.authUsername}
                            onChange={e => setFormData({ 
                              ...formData, 
                              config: { ...formData.config, authUsername: e.target.value } 
                            })}
                          />
                        </div>
                        <div className="form-group">
                          <label>Password</label>
                          <input
                            type="password"
                            value={formData.config.authPassword}
                            onChange={e => setFormData({ 
                              ...formData, 
                              config: { ...formData.config, authPassword: e.target.value } 
                            })}
                          />
                        </div>
                      </div>
                    )}

                    {formData.config.authType === 'apiKey' && (
                      <div className="form-row">
                        <div className="form-group">
                          <label>Header Name</label>
                          <input
                            type="text"
                            value={formData.config.apiKeyHeader}
                            onChange={e => setFormData({ 
                              ...formData, 
                              config: { ...formData.config, apiKeyHeader: e.target.value } 
                            })}
                            placeholder="X-API-Key"
                          />
                        </div>
                        <div className="form-group">
                          <label>API Key</label>
                          <input
                            type="password"
                            value={formData.config.apiKey}
                            onChange={e => setFormData({ 
                              ...formData, 
                              config: { ...formData.config, apiKey: e.target.value } 
                            })}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {formData.type === 'WEBHOOK' && (
                  <div className="webhook-info">
                    <p>Webhook endpoint will be created automatically. External systems can POST data to enrich customer records.</p>
                  </div>
                )}

                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={formData.isActive}
                      onChange={e => setFormData({ ...formData, isActive: e.target.checked })}
                    />
                    Active
                  </label>
                </div>

                <div className="form-actions">
                  <button type="button" className="btn-secondary" onClick={resetForm}>Cancel</button>
                  <button type="submit" className="btn-primary">
                    {editingSource ? 'Save Changes' : 'Create Data Source'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        <style jsx>{`
          .btn-primary {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.75rem 1.5rem;
            background: white;
            color: var(--primary);
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }

          .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          }

          .content-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
          }

          .sources-list {
            display: flex;
            flex-direction: column;
            gap: 1rem;
          }

          .source-card {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 16px;
            padding: 1.25rem;
            cursor: pointer;
            transition: all 0.2s;
          }

          .source-card:hover {
            border-color: var(--primary-500);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
          }

          .source-card.selected {
            border-color: var(--primary-500);
            background: #f0f7ff;
          }

          .source-card.inactive {
            opacity: 0.6;
          }

          .source-header {
            display: flex;
            align-items: center;
            gap: 1rem;
          }

          .source-icon {
            font-size: 2rem;
          }

          .source-info {
            flex: 1;
          }

          .source-info h3 {
            margin: 0;
            font-size: 1.1rem;
            color: #1f2937;
          }

          .source-type {
            font-size: 0.85rem;
            color: #6b7280;
          }

          .status-badge {
            padding: 0.25rem 0.75rem;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
          }

          .status-badge.active {
            background: #dcfce7;
            color: #16a34a;
          }

          .status-badge.inactive {
            background: #f3f4f6;
            color: #6b7280;
          }

          .source-description {
            margin: 0.75rem 0 0;
            color: #4b5563;
            font-size: 0.9rem;
          }

          .source-meta {
            margin-top: 0.75rem;
            font-size: 0.85rem;
            color: #9ca3af;
          }

          .source-actions {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
            padding-top: 1rem;
            border-top: 1px solid #e5e7eb;
          }

          .btn-icon {
            padding: 0.5rem;
            background: #f3f4f6;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .btn-icon:hover {
            background: #e5e7eb;
          }

          .btn-icon.danger:hover {
            background: #fee2e2;
          }

          .source-details {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 16px;
            padding: 1.5rem;
          }

          .details-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid #e5e7eb;
          }

          .details-header h2 {
            margin: 0;
            font-size: 1.5rem;
          }

          .btn-close {
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: #9ca3af;
          }

          .test-result {
            padding: 1rem;
            border-radius: 10px;
            margin-bottom: 1.5rem;
          }

          .test-result.success {
            background: #dcfce7;
            color: #166534;
          }

          .test-result.error {
            background: #fee2e2;
            color: #dc2626;
          }

          .test-result pre {
            margin-top: 0.5rem;
            padding: 0.5rem;
            background: rgba(0,0,0,0.05);
            border-radius: 6px;
            font-size: 0.8rem;
            overflow-x: auto;
          }

          .config-section, .mappings-section {
            margin-bottom: 1.5rem;
          }

          .config-section h3, .mappings-section h3 {
            margin: 0 0 1rem;
            font-size: 1.1rem;
            color: #374151;
          }

          .section-hint {
            margin: -0.5rem 0 1rem;
            font-size: 0.9rem;
            color: #6b7280;
          }

          .config-display {
            display: grid;
            gap: 0.75rem;
          }

          .config-item {
            display: flex;
            gap: 1rem;
          }

          .config-item label {
            min-width: 140px;
            font-weight: 500;
            color: #6b7280;
          }

          .config-item span {
            color: #1f2937;
          }

          .mapping-form {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
          }

          .mapping-form input, .mapping-form select {
            flex: 1;
            padding: 0.5rem 0.75rem;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            font-size: 0.9rem;
          }

          .btn-add {
            padding: 0.5rem 1rem;
            background: var(--primary-500);
            color: white;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
          }

          .mappings-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }

          .mapping-item {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 0.75rem 1rem;
            background: #f9fafb;
            border-radius: 8px;
          }

          .mapping-path {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 0.5rem;
          }

          .mapping-path code {
            background: #e5e7eb;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.85rem;
          }

          .arrow {
            color: #9ca3af;
          }

          .transform-badge {
            background: #dbeafe;
            color: #2563eb;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.8rem;
          }

          .btn-remove {
            background: none;
            border: none;
            color: #dc2626;
            font-size: 1.25rem;
            cursor: pointer;
          }

          .no-mappings {
            color: #9ca3af;
            font-style: italic;
          }

          .empty-state {
            text-align: center;
            padding: 3rem;
            background: #f9fafb;
            border-radius: 16px;
          }

          .empty-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
          }

          .empty-state h3 {
            margin: 0 0 0.5rem;
            color: #1f2937;
          }

          .empty-state p {
            margin: 0;
            color: #6b7280;
          }

          .loading {
            text-align: center;
            padding: 3rem;
            color: #6b7280;
          }

          .access-denied {
            text-align: center;
            padding: 3rem;
          }

          /* Modal styles */
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
            padding: 2rem;
          }

          .modal {
            background: white;
            border-radius: 20px;
            width: 100%;
            max-width: 600px;
            max-height: 90vh;
            overflow-y: auto;
          }

          .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1.5rem;
            border-bottom: 1px solid #e5e7eb;
          }

          .modal-header h2 {
            margin: 0;
          }

          .modal form {
            padding: 1.5rem;
          }

          .form-group {
            margin-bottom: 1.25rem;
          }

          .form-group label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
            color: #374151;
          }

          .form-group input, .form-group textarea, .form-group select {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1px solid #d1d5db;
            border-radius: 10px;
            font-size: 1rem;
          }

          .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
          }

          .type-selector {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 0.5rem;
          }

          .type-option {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.25rem;
            padding: 0.75rem;
            background: #f3f4f6;
            border: 2px solid transparent;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .type-option:hover {
            background: #e5e7eb;
          }

          .type-option.selected {
            border-color: var(--primary-500);
            background: #eff6ff;
          }

          .type-icon {
            font-size: 1.5rem;
          }

          .checkbox-group label {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            cursor: pointer;
          }

          .checkbox-group input[type="checkbox"] {
            width: auto;
          }

          .webhook-info {
            padding: 1rem;
            background: #fef3c7;
            border-radius: 10px;
            color: #92400e;
          }

          .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 1rem;
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid #e5e7eb;
          }

          .btn-secondary {
            padding: 0.75rem 1.5rem;
            background: #f3f4f6;
            color: #374151;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
          }

          @media (max-width: 1024px) {
            .content-grid {
              grid-template-columns: 1fr;
            }

            .type-selector {
              grid-template-columns: repeat(2, 1fr);
            }
          }
        `}</style>
      </div>
    </Layout>
  );
}
