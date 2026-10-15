'use client';

import NoOrganization from '@/components/NoOrganization';
import { useTerms } from '@/hooks/useTerms';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { LayoutTemplate, Workflow } from 'lucide-react';
import api from '@/api/client';
import Layout from '@/components/Layout';
import { PageHeader } from '@/components/ui';
import { useAuthContext } from '@/contexts/AuthContext';
import type { Location, Service, ServiceFlow } from '@/types';

interface FlowNode {
  id: string;
  serviceId: string;
  serviceName: string;
  x: number;
  y: number;
  outgoing: { flowId: string; toServiceId: string }[];
  incoming: { flowId: string; fromServiceId: string }[];
}

interface NodePosition {
  x: number;
  y: number;
}

interface DragState {
  isDragging: boolean;
  nodeId: string | null;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

const FlowDesignerPage: React.FC = () => {
  const { user } = useAuthContext();
  const terms = useTerms();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [services, setServices] = useState<Service[]>([]);
  const [flows, setFlows] = useState<ServiceFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof api.getFlowTemplates>>>([]);
  const [applying, setApplying] = useState(false);
  const [templateResult, setTemplateResult] = useState('');
  const [selectedFrom, setSelectedFrom] = useState('');
  const [selectedTo, setSelectedTo] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<string>('');
  
  // Custom node positions (override calculated positions when dragged)
  const [customPositions, setCustomPositions] = useState<{ [key: string]: NodePosition }>({});
  
  // Drag state
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    nodeId: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  });
  
  // Zoom and pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  
  const canvasRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadLocations();
  }, [user]);

  useEffect(() => {
    if (selectedLocation) {
      loadFlows(selectedLocation);
    }
  }, [selectedLocation]);

  const loadLocations = async () => {
    if (!user?.organizationId) {
      // No organization on this account (e.g. a superadmin). Never guess an
      // org - render the empty state instead of leaking another tenant's data.
      setLocations([]);
      setLoading(false);
      return;
    }
    try {
      const locs = await api.getLocations(user.organizationId);
      setLocations(locs);
      if (locs.length > 0) {
        setSelectedLocation(locs[0].id);
      }
    } catch (err) {
      console.error('Failed to load locations', err);
    } finally {
      setLoading(false);
    }
  };

  const loadFlows = async (locationId: string) => {
    try {
      setLoading(true);
      const data = await api.getLocationFlows(locationId);
      setServices(data);
      
      // Extract all flows
      const allFlows: ServiceFlow[] = [];
      data.forEach((svc: any) => {
        svc.flowsFrom?.forEach((flow: any) => {
          allFlows.push({
            ...flow,
            fromService: { id: svc.id, name: svc.name },
          });
        });
      });
      setFlows(allFlows);
      setError('');
    } catch (err) {
      console.error('Failed to load flows', err);
      setError('Failed to load flow data');
    } finally {
      setLoading(false);
    }
  };

  const openTemplates = async () => {
    setTemplateResult('');
    setShowTemplate(true);
    if (templates.length === 0) {
      try {
        setTemplates(await api.getFlowTemplates());
      } catch {
        setError('Couldn’t load the templates.');
      }
    }
  };

  const applyTemplate = async (templateId: string) => {
    if (!selectedLocation) return;
    setApplying(true);
    try {
      const r = await api.applyFlowTemplate(templateId, selectedLocation);
      const added = r.services.filter((s) => s.created).length;
      setTemplateResult(
        added || r.flowsCreated
          ? `Added ${added} service${added === 1 ? '' : 's'}, ${r.servicePointsCreated} service point${r.servicePointsCreated === 1 ? '' : 's'} and ${r.flowsCreated} connection${r.flowsCreated === 1 ? '' : 's'}.`
          : 'Everything in this template was already set up here.'
      );
      await loadFlows(selectedLocation);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string; error?: string } } };
      setError(e.response?.data?.message || e.response?.data?.error || 'Couldn’t apply the template.');
      setShowTemplate(false);
    } finally {
      setApplying(false);
    }
  };

  const handleCreateFlow = async () => {
    if (!selectedFrom || !selectedTo || selectedFrom === selectedTo) {
      setError('Please select different services');
      return;
    }

    try {
      await api.createServiceFlow({
        fromServiceId: selectedFrom,
        toServiceId: selectedTo,
        priority: flows.filter(f => f.fromServiceId === selectedFrom).length,
      });
      
      await loadFlows(selectedLocation);
      setShowModal(false);
      setSelectedFrom('');
      setSelectedTo('');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || 'Failed to create flow');
    }
  };

  const handleDeleteFlow = async (flowId: string) => {
    if (!confirm('Are you sure you want to remove this flow connection?')) return;
    
    try {
      await api.deleteServiceFlow(flowId);
      await loadFlows(selectedLocation);
    } catch (err) {
      console.error('Failed to delete flow', err);
    }
  };

  const handleToggleAutoTransfer = async (flow: ServiceFlow) => {
    try {
      await api.updateServiceFlow(flow.id, {
        autoTransfer: !flow.autoTransfer,
      });
      await loadFlows(selectedLocation);
    } catch (err) {
      console.error('Failed to update flow', err);
    }
  };

  const handleToggleRequired = async (flow: ServiceFlow) => {
    try {
      await api.updateServiceFlow(flow.id, {
        isRequired: !flow.isRequired,
      });
      await loadFlows(selectedLocation);
    } catch (err) {
      console.error('Failed to update flow', err);
    }
  };

  // Calculate node positions in a flow layout
  const calculateLayout = (): Record<string, { x: number; y: number; level: number }> => {
    if (services.length === 0) return {};

    // Find entry points (services with no incoming flows)
    const entryPoints = services.filter(svc => {
      const hasIncoming = flows.some(f => f.toServiceId === svc.id);
      return !hasIncoming;
    });

    // Simple layout algorithm
    const positions: { [key: string]: { x: number; y: number; level: number } } = {};
    const visited = new Set<string>();
    const queue: { id: string; level: number; order: number }[] = [];

    // Start with entry points
    entryPoints.forEach((svc, i) => {
      queue.push({ id: svc.id, level: 0, order: i });
    });

    // If no entry points, start with first service
    if (queue.length === 0 && services.length > 0) {
      queue.push({ id: services[0].id, level: 0, order: 0 });
    }

    const levelCounts: { [level: number]: number } = {};

    while (queue.length > 0) {
      const { id, level, order } = queue.shift()!;
      
      if (visited.has(id)) continue;
      visited.add(id);

      levelCounts[level] = (levelCounts[level] || 0) + 1;
      
      positions[id] = {
        x: level * 280 + 100,
        y: (levelCounts[level] - 1) * 140 + 80,
        level,
      };

      // Find outgoing flows
      const outgoing = flows.filter(f => f.fromServiceId === id);
      outgoing.forEach((flow, i) => {
        if (!visited.has(flow.toServiceId)) {
          queue.push({ id: flow.toServiceId, level: level + 1, order: i });
        }
      });
    }

    // Add remaining services not in flow
    services.forEach((svc, i) => {
      if (!positions[svc.id]) {
        const maxLevel = Math.max(...Object.values(positions).map(p => p.level), 0);
        levelCounts[maxLevel + 1] = (levelCounts[maxLevel + 1] || 0) + 1;
        positions[svc.id] = {
          x: (maxLevel + 1) * 280 + 100,
          y: (levelCounts[maxLevel + 1] - 1) * 140 + 80,
          level: maxLevel + 1,
        };
      }
    });

    return positions;
  };

  const nodePositions = calculateLayout();

  // Get effective position (custom if dragged, otherwise calculated)
  const getNodePosition = (serviceId: string) => {
    return customPositions[serviceId] || nodePositions[serviceId] || { x: 100, y: 100 };
  };

  // Handle node drag start
  const handleNodeMouseDown = (e: React.MouseEvent, serviceId: string) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    e.stopPropagation();
    
    const pos = getNodePosition(serviceId);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    setDragState({
      isDragging: true,
      nodeId: serviceId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: pos.x,
      offsetY: pos.y,
    });
  };

  // Handle mouse move for dragging
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragState.isDragging && dragState.nodeId) {
      const dx = (e.clientX - dragState.startX) / zoom;
      const dy = (e.clientY - dragState.startY) / zoom;
      
      setCustomPositions(prev => ({
        ...prev,
        [dragState.nodeId!]: {
          x: dragState.offsetX + dx,
          y: dragState.offsetY + dy,
        },
      }));
    } else if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      setPan(prev => ({
        x: prev.x + dx,
        y: prev.y + dy,
      }));
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  }, [dragState, zoom, isPanning, panStart]);

  // Handle mouse up to end dragging
  const handleMouseUp = useCallback(() => {
    if (dragState.isDragging) {
      setDragState({
        isDragging: false,
        nodeId: null,
        startX: 0,
        startY: 0,
        offsetX: 0,
        offsetY: 0,
      });
    }
    if (isPanning) {
      setIsPanning(false);
    }
  }, [dragState.isDragging, isPanning]);

  // Handle canvas pan start (middle click or right click)
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    // Middle mouse button or Ctrl+left click for panning
    if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  };

  // Handle zoom with wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(prev => Math.min(2, Math.max(0.25, prev + delta)));
    }
  }, []);

  // Reset view
  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setCustomPositions({});
  };

  // Zoom controls
  const handleZoomIn = () => setZoom(prev => Math.min(2, prev + 0.1));
  const handleZoomOut = () => setZoom(prev => Math.max(0.25, prev - 0.1));

  if (loading && services.length === 0) {
    return (
      <Layout>
        <div className="loading-container">
          <div className="loading-spinner" />
          <p>Loading flow designer...</p>
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
      <div className="flow-designer">
        <PageHeader
          icon={Workflow}
          title={`${terms.Person} flow`}
          subtitle={`Where ${terms.people} go next after each service. Staff see the next step when they finish, or it happens automatically.`}
          actions={
            <div className="header-actions">
              <div className="selector">
                <label>Location</label>
                <select
                  value={selectedLocation}
                  onChange={(e) => setSelectedLocation(e.target.value)}
                >
                  {locations.map(loc => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </div>
              <button className="add-btn" onClick={openTemplates}>
                <LayoutTemplate size={18} />
                Use a template
              </button>
              <button className="add-btn" onClick={() => setShowModal(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Connection
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

        {/* Zoom Controls */}
        <div className="zoom-controls">
          <button className="zoom-btn" onClick={handleZoomOut} title="Zoom Out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="8" y1="11" x2="14" y2="11" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <span className="zoom-level">{Math.round(zoom * 100)}%</span>
          <button className="zoom-btn" onClick={handleZoomIn} title="Zoom In">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button className="zoom-btn reset-btn" onClick={handleResetView} title="Reset View">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>

        {/* Flow Canvas */}
        <div 
          className="canvas-container" 
          ref={containerRef}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onMouseDown={handleCanvasMouseDown}
          onWheel={handleWheel}
          style={{ cursor: isPanning ? 'grabbing' : (dragState.isDragging ? 'grabbing' : 'default') }}
        >
          <div 
            className="canvas" 
            ref={canvasRef}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
            {/* Draw connection lines */}
            <svg className="connections-svg">
              {flows.map(flow => {
                const fromPos = getNodePosition(flow.fromServiceId);
                const toPos = getNodePosition(flow.toServiceId);
                if (!fromPos || !toPos) return null;

                const startX = fromPos.x + 200;
                const startY = fromPos.y + 50;
                const endX = toPos.x;
                const endY = toPos.y + 50;
                
                // Create curved path
                const controlX = (startX + endX) / 2;
                const path = `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`;

                return (
                  <g key={flow.id} className="connection-group">
                    <path
                      d={path}
                      fill="none"
                      stroke={flow.isRequired ? '#f59e0b' : '#94a3b8'}
                      strokeWidth={flow.autoTransfer ? 3 : 2}
                      strokeDasharray={flow.autoTransfer ? '' : '5,5'}
                      className="connection-line"
                    />
                    {/* Arrow head */}
                    <polygon
                      points={`${endX},${endY} ${endX - 10},${endY - 5} ${endX - 10},${endY + 5}`}
                      fill={flow.isRequired ? '#f59e0b' : '#94a3b8'}
                    />
                    {/* Delete button */}
                    <g 
                      className="delete-connection"
                      transform={`translate(${(startX + endX) / 2 - 12}, ${(startY + endY) / 2 - 12})`}
                      onClick={() => handleDeleteFlow(flow.id)}
                    >
                      <circle r="12" cx="12" cy="12" fill="white" stroke="#e5e7eb" />
                      <text x="12" y="16" textAnchor="middle" fill="#ef4444" fontSize="16">×</text>
                    </g>
                  </g>
                );
              })}
            </svg>

            {/* Service nodes */}
            {services.map(service => {
              const pos = getNodePosition(service.id);
              if (!pos) return null;

              const outgoingFlows = flows.filter(f => f.fromServiceId === service.id);
              const incomingFlows = flows.filter(f => f.toServiceId === service.id);
              const isDraggingThis = dragState.isDragging && dragState.nodeId === service.id;

              return (
                <div
                  key={service.id}
                  className={`service-node ${isDraggingThis ? 'dragging' : ''}`}
                  style={{ 
                    left: pos.x, 
                    top: pos.y,
                    cursor: isDraggingThis ? 'grabbing' : 'grab',
                    zIndex: isDraggingThis ? 100 : 1,
                  }}
                  onMouseDown={(e) => handleNodeMouseDown(e, service.id)}
                >
                  <div className="node-header">
                    <span className="node-name">{service.name}</span>
                    <span className={`node-type ${service.type.toLowerCase()}`}>
                      {service.type}
                    </span>
                  </div>
                  <div className="node-body">
                    <div className="node-stat">
                      <span className="stat-label">Incoming</span>
                      <span className="stat-value">{incomingFlows.length}</span>
                    </div>
                    <div className="node-stat">
                      <span className="stat-label">Outgoing</span>
                      <span className="stat-value">{outgoingFlows.length}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Flows List */}
        <div className="flows-list">
          <h2>Flow Connections</h2>
          {flows.length === 0 ? (
            <p className="no-flows">Nothing connected yet. Add a connection to send {terms.people} from one service to the next.</p>
          ) : (
            <div className="flows-grid">
              {flows.map(flow => (
                <div key={flow.id} className="flow-card">
                  <div className="flow-path">
                    <span className="from-service">{flow.fromService?.name || 'Unknown'}</span>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                    <span className="to-service">{flow.toService?.name || 'Unknown'}</span>
                  </div>
                  <div className="flow-options">
                    <button 
                      className={`option-btn ${flow.autoTransfer ? 'active' : ''}`}
                      onClick={() => handleToggleAutoTransfer(flow)}
                      title={`Send ${terms.people} on automatically`}
                    >
                      Auto
                    </button>
                    <button 
                      className={`option-btn ${flow.isRequired ? 'active required' : ''}`}
                      onClick={() => handleToggleRequired(flow)}
                      title="Required step"
                    >
                      Required
                    </button>
                    <button 
                      className="delete-btn"
                      onClick={() => handleDeleteFlow(flow.id)}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Template Modal */}
        {showTemplate && (
          <div className="modal-overlay" onClick={() => !applying && setShowTemplate(false)}>
            <div className="modal template-modal" role="dialog" aria-labelledby="template-title" onClick={e => e.stopPropagation()}>
              <h2 id="template-title">Use a template</h2>
              <p className="modal-desc">
                Sets up a ready-made flow at {locations.find(l => l.id === selectedLocation)?.name || 'this location'}. Services that already exist
                here with the same name are reused; nothing is removed.
              </p>
              {templates.length === 0 && <p className="modal-desc">Loading…</p>}
              {templates.map(t => (
                <div key={t.id} className="template-card">
                  <h3>{t.name}</h3>
                  <p>{t.description}</p>
                  <ul className="template-flows">
                    {Object.entries(t.flows).map(([from, tos]) => (
                      <li key={from}>
                        <strong>{from}</strong>
                        {t.services.find(s => s.name === from)?.requiresClearance && <span className="template-tag">waits for payment</span>}
                        {from === t.defaultService && <span className="template-tag">first point of contact</span>}
                        <span className="template-to">{tos.length ? `→ ${tos.join(', ')}` : '→ exit'}</span>
                      </li>
                    ))}
                  </ul>
                  {templateResult ? (
                    <p className="template-result" role="status">{templateResult}</p>
                  ) : (
                    <div className="modal-actions">
                      <button className="cancel-btn" onClick={() => setShowTemplate(false)} disabled={applying}>Cancel</button>
                      <button className="submit-btn" onClick={() => applyTemplate(t.id)} disabled={applying || !selectedLocation}>
                        {applying ? 'Applying…' : 'Apply to this location'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {templateResult && (
                <div className="modal-actions">
                  <button className="submit-btn" onClick={() => setShowTemplate(false)}>Done</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Add Connection Modal */}
        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Add Flow Connection</h2>
              <p className="modal-desc">Where {terms.people} go after this service.</p>

              <div className="form-group">
                <label>From Service</label>
                <select 
                  value={selectedFrom} 
                  onChange={e => setSelectedFrom(e.target.value)}
                >
                  <option value="">Select source service...</option>
                  {services.map(svc => (
                    <option key={svc.id} value={svc.id}>{svc.name}</option>
                  ))}
                </select>
              </div>

              <div className="arrow-indicator">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
              </div>

              <div className="form-group">
                <label>To Service</label>
                <select 
                  value={selectedTo} 
                  onChange={e => setSelectedTo(e.target.value)}
                >
                  <option value="">Select destination service...</option>
                  {services.filter(s => s.id !== selectedFrom).map(svc => (
                    <option key={svc.id} value={svc.id}>{svc.name}</option>
                  ))}
                </select>
              </div>

              <div className="modal-actions">
                <button className="cancel-btn" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button 
                  className="submit-btn" 
                  onClick={handleCreateFlow}
                  disabled={!selectedFrom || !selectedTo}
                >
                  Create Connection
                </button>
              </div>
            </div>
          </div>
        )}

        <style jsx>{`
          .header-actions {
            display: flex;
            align-items: center;
            gap: 1rem;
          }

          .selector {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
          }

          .selector label {
            font-size: 0.75rem;
            opacity: 0.9;
          }

          .selector select {
            padding: 0.5rem 1rem;
            font-size: 0.9rem;
            border: none;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.95);
            color: var(--text);
            min-width: 160px;
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
          }

          /* Zoom Controls */
          .zoom-controls {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            background: white;
            border-radius: 8px;
            padding: 0.5rem;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            position: sticky;
            top: 0;
            z-index: 10;
            width: fit-content;
            margin-bottom: 1rem;
          }

          .zoom-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border: none;
            background: #f3f4f6;
            border-radius: 6px;
            cursor: pointer;
            color: var(--text);
            transition: all 0.2s;
          }

          .zoom-btn:hover {
            background: #e5e7eb;
            color: var(--primary);
          }

          .zoom-btn.reset-btn {
            margin-left: 0.5rem;
            border-left: 1px solid #e5e7eb;
            padding-left: 0.5rem;
          }

          .zoom-level {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-secondary);
            min-width: 3.5rem;
            text-align: center;
          }

          .canvas-container {
            background: #f8fafc;
            border-radius: 16px;
            margin-bottom: 1.5rem;
            overflow: hidden;
            min-height: 400px;
            user-select: none;
          }

          .canvas {
            position: relative;
            min-height: 400px;
            padding: 2rem;
            transition: transform 0.05s ease-out;
            min-width: 1200px;
          }

          .connections-svg {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
          }

          .connection-group {
            pointer-events: all;
          }

          .connection-line {
            transition: stroke-width 0.2s;
          }

          .delete-connection {
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
          }

          .connection-group:hover .delete-connection {
            opacity: 1;
          }

          .service-node {
            position: absolute;
            width: 200px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
            border-width: 1px;
            border-style: solid;
            border-color: var(--border);
            overflow: hidden;
            transition: box-shadow 0.2s, transform 0.1s;
          }

          .service-node:hover {
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
          }

          .service-node.dragging {
            box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25);
            border-color: var(--primary);
          }

          .node-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 1rem;
            background: #f1f5f9;
            border-bottom: 1px solid var(--border);
          }

          .node-name {
            font-weight: 600;
            font-size: 0.9rem;
          }

          .node-type {
            font-size: 0.65rem;
            padding: 0.125rem 0.375rem;
            border-radius: 4px;
            background: rgba(15, 159, 164, 0.1);
            color: var(--primary);
          }

          .node-body {
            display: flex;
            padding: 0.75rem 1rem;
            gap: 1rem;
          }

          .node-stat {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
          }

          .stat-label {
            font-size: 0.7rem;
            color: var(--text-secondary);
          }

          .stat-value {
            font-size: 1.25rem;
            font-weight: 600;
          }

          .flows-list {
            background: white;
            border-radius: 16px;
            padding: 1.5rem;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
          }

          .flows-list h2 {
            margin: 0 0 1rem;
            font-size: 1.1rem;
          }

          .no-flows {
            color: var(--text-secondary);
            text-align: center;
            padding: 2rem;
          }

          .flows-grid {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }

          .flow-card {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem;
            background: #f8fafc;
            border-radius: 10px;
            border-width: 1px;
            border-style: solid;
            border-color: var(--border);
          }

          .flow-path {
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }

          .from-service,
          .to-service {
            font-weight: 500;
          }

          .flow-options {
            display: flex;
            gap: 0.5rem;
          }

          .option-btn {
            padding: 0.375rem 0.75rem;
            font-size: 0.8rem;
            border: none;
            border-radius: 6px;
            background: #e5e7eb;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.2s;
          }

          .option-btn.active {
            background: #dbeafe;
            color: #2563eb;
          }

          .option-btn.active.required {
            background: #fef3c7;
            color: #d97706;
          }

          .delete-btn {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            border-radius: 6px;
            background: #f3f4f6;
            color: var(--text-secondary);
            cursor: pointer;
          }

          .delete-btn:hover {
            background: #fee2e2;
            color: #dc2626;
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
          }

          .modal {
            background: white;
            border-radius: 16px;
            padding: 2rem;
            max-width: 400px;
            width: 90%;
          }

          .template-modal {
            max-width: 560px;
            max-height: 90vh;
            overflow-y: auto;
          }

          .template-card h3 {
            margin: 0 0 0.25rem;
            font-size: 1.05rem;
          }

          .template-card > p {
            margin: 0 0 0.75rem;
            color: var(--text-secondary);
            font-size: 0.9rem;
          }

          .template-flows {
            list-style: none;
            margin: 0 0 1rem;
            padding: 0;
            display: grid;
            gap: 0.375rem;
            font-size: 0.875rem;
          }

          .template-flows li {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 0.375rem;
            padding: 0.5rem 0.75rem;
            background: var(--gray-50);
            border-radius: 8px;
          }

          .template-to {
            color: var(--text-secondary);
          }

          .template-tag {
            font-size: 0.75rem;
            padding: 0.0625rem 0.5rem;
            border-radius: 999px;
            background: var(--primary-50);
            color: var(--primary-700);
          }

          .template-result {
            padding: 0.75rem;
            border-radius: 10px;
            background: var(--primary-50);
            color: var(--primary-700);
            font-size: 0.9rem;
          }

          .modal h2 {
            margin: 0 0 0.25rem;
          }

          .modal-desc {
            color: var(--text-secondary);
            margin: 0 0 1.5rem;
            font-size: 0.9rem;
          }

          .form-group {
            margin-bottom: 1rem;
          }

          .form-group label {
            display: block;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
          }

          .form-group select {
            width: 100%;
            padding: 0.75rem 1rem;
            font-size: 1rem;
            border-width: 1px;
            border-style: solid;
            border-color: var(--border);
            border-radius: 8px;
          }

          .arrow-indicator {
            display: flex;
            justify-content: center;
            padding: 0.5rem 0;
            color: var(--text-secondary);
          }

          .modal-actions {
            display: flex;
            gap: 0.75rem;
            margin-top: 1.5rem;
          }

          .cancel-btn {
            flex: 1;
            padding: 0.75rem;
            background: #f3f4f6;
            color: var(--text);
            border: none;
            border-radius: 8px;
            font-size: 1rem;
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
            cursor: pointer;
          }

          .submit-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          @media (max-width: 768px) {
            .header-actions {
              flex-direction: column;
            }
          }
        `}</style>
      </div>
    </Layout>
  );
};

export default FlowDesignerPage;
