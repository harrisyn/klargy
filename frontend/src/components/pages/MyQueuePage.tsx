'use client';

import { toast, errorMessage } from '@/lib/toast';
import React, { useEffect, useState, useCallback } from 'react';
import { useAuthContext } from '@/contexts/AuthContext';
import api from '@/api/client';
import Layout from '@/components/Layout';
import TicketDisplay from '@/components/TicketDisplay';
import { useSocket } from '@/hooks/useSocket';
import type { QueueEntry, Service } from '@/types';

const MyQueuePage: React.FC = () => {
  const { user } = useAuthContext();
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [selectedService, setSelectedService] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const { joinUser, onEntryStatusChanged, onNotification } = useSocket();

  const loadMyEntries = useCallback(async () => {
    try {
      setLoading(false);
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  }, [user]);

  const loadServices = useCallback(async () => {
    try {
      // Avoid calling admin-only /orgs endpoint. Use user's organizationId when available
      // otherwise fall back to public locations so non-admins don't get a 403.
      if (user?.organizationId) {
        const locations = await api.getLocations(user.organizationId);
        if (locations.length > 0) {
          const serviceList = await api.getServices(locations[0].id);
          setServices(serviceList);
        }
      } else {
        const publicLocations = await api.getPublicLocations();
        if (publicLocations.length > 0) {
          const serviceList = await api.getServices(publicLocations[0].id);
          setServices(serviceList);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadMyEntries();
      loadServices();
      joinUser(user.id);
    }
  }, [user, loadMyEntries, loadServices, joinUser]);

  useEffect(() => {
    const unsubStatus = onEntryStatusChanged((data) => {
      setEntries(prev => prev.map(e => 
        e.id === data.entryId ? { ...e, status: data.status as QueueEntry['status'] } : e
      ));
    });

    const unsubNotify = onNotification((notification) => {
      toast(notification.message);
    });

    return () => {
      unsubStatus();
      unsubNotify();
    };
  }, [onEntryStatusChanged, onNotification]);

  const handleJoinQueue = async () => {
    if (!selectedService || !user) return;

    setJoining(true);
    setError('');

    try {
      const queue = await api.createQueue(selectedService);
      const entry = await api.joinQueue(queue.id, user.id);
      setEntries([...entries, entry]);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || 'Failed to join queue');
    } finally {
      setJoining(false);
    }
  };

  const activeEntries = entries.filter(e => e.status === 'WAITING' || e.status === 'SERVING');

  return (
    <Layout>
      <div className="my-queue-page">
        {/* Page Header */}
        <div className="page-header">
          <div className="header-content">
            <div className="header-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </div>
            <div>
              <h1 className="page-title">My Queue Status</h1>
              <p className="page-subtitle">Track your position and get notified when you&apos;re up</p>
            </div>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="alert alert-error">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        {/* Active Entries */}
        {activeEntries.length > 0 ? (
          <div className="entries-section">
            <h2 className="section-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Active Tickets
            </h2>
            <div className="entries-grid">
              {activeEntries.map(entry => (
                <TicketDisplay key={entry.id} entry={entry} position={entry.position} />
              ))}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
                <path d="M8 14h.01" />
                <path d="M12 14h.01" />
                <path d="M16 14h.01" />
              </svg>
            </div>
            <h2>You&apos;re not in any queue</h2>
            <p>Join a queue to track your position in real-time</p>

            <div className="join-form">
              <div className="form-row">
                <div className="select-wrapper">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                  <select
                    value={selectedService}
                    onChange={(e) => setSelectedService(e.target.value)}
                    className="service-select"
                  >
                    <option value="">Select a service...</option>
                    {services.map(service => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={handleJoinQueue}
                  disabled={!selectedService || joining}
                  className={`join-btn ${joining ? 'loading' : ''}`}
                >
                  {joining ? (
                    <>
                      <div className="btn-spinner" />
                      Joining...
                    </>
                  ) : (
                    <>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="8.5" cy="7" r="4" />
                        <line x1="20" y1="8" x2="20" y2="14" />
                        <line x1="23" y1="11" x2="17" y2="11" />
                      </svg>
                      Join Queue
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* History Section */}
        {entries.filter(e => e.status === 'SERVED').length > 0 && (
          <div className="history-section">
            <h3 className="section-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              Recent History
            </h3>
            <div className="history-list">
              {entries.filter(e => e.status === 'SERVED').slice(0, 5).map(entry => (
                <div key={entry.id} className="history-item">
                  <div className="history-left">
                    <span className="history-ticket">{entry.ticketNumber}</span>
                    <span className="history-status">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Served
                    </span>
                  </div>
                  <span className="history-time">
                    {entry.completedAt ? new Date(entry.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <style jsx>{`
          .my-queue-page {
            max-width: 900px;
            margin: 0 auto;
            animation: fadeIn 0.3s ease-out;
          }

          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }

          .page-header {
            background: var(--primary);
            border-radius: 16px;
            padding: 2rem;
            margin-bottom: 2rem;
            color: white;
          }

          .header-content {
            display: flex;
            align-items: center;
            gap: 1rem;
          }

          .header-icon {
            width: 56px;
            height: 56px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(10px);
          }

          .page-title {
            margin: 0;
            font-size: 1.75rem;
            font-weight: 700;
          }

          .page-subtitle {
            margin: 0.25rem 0 0;
            opacity: 0.9;
          }

          .alert {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 1rem 1.25rem;
            border-radius: 12px;
            margin-bottom: 1.5rem;
            font-weight: 500;
          }

          .alert-error {
            background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
            border: 1px solid #fecaca;
            color: #dc2626;
          }

          .entries-section {
            margin-bottom: 2rem;
          }

          .section-title {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin: 0 0 1.25rem;
            font-size: 1.1rem;
            color: var(--text);
          }

          .entries-grid {
            display: grid;
            gap: 1.5rem;
          }

          .empty-state {
            background: white;
            padding: 3rem 2rem;
            border-radius: 20px;
            text-align: center;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
          }

          .empty-icon {
            width: 100px;
            height: 100px;
            background: rgba(15, 159, 164, 0.1);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            color: var(--primary);
          }

          .empty-state h2 {
            margin: 0 0 0.5rem;
            color: var(--text);
            font-size: 1.5rem;
          }

          .empty-state p {
            margin: 0 0 2rem;
            color: var(--text-secondary);
          }

          .join-form {
            max-width: 500px;
            margin: 0 auto;
          }

          .form-row {
            display: flex;
            gap: 1rem;
          }

          .select-wrapper {
            flex: 1;
            position: relative;
            display: flex;
            align-items: center;
          }

          .select-wrapper svg {
            position: absolute;
            left: 1rem;
            color: var(--text-secondary);
            pointer-events: none;
          }

          .service-select {
            width: 100%;
            padding: 0.875rem 1rem 0.875rem 2.75rem;
            font-size: 1rem;
            border: 2px solid var(--border);
            border-radius: 12px;
            background: white;
            cursor: pointer;
            transition: all 0.2s;
          }

          .service-select:hover {
            border-color: var(--primary);
          }

          .service-select:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px rgba(15, 159, 164, 0.15);
          }

          .join-btn {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.875rem 1.5rem;
            font-size: 1rem;
            font-weight: 600;
            background: var(--success-600);
            color: white;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .join-btn:hover:not(:disabled) {
            background: var(--success-700);
          }

          .join-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          .join-btn.loading {
            background: #64748b;
          }

          .btn-spinner {
            width: 18px;
            height: 18px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }

          @keyframes spin {
            to { transform: rotate(360deg); }
          }

          .history-section {
            margin-top: 3rem;
          }

          .history-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }

          .history-item {
            background: white;
            padding: 1rem 1.25rem;
            border-radius: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
            transition: all 0.2s;
          }

          .history-item:hover {
            transform: translateX(4px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          }

          .history-left {
            display: flex;
            align-items: center;
            gap: 1rem;
          }

          .history-ticket {
            font-family: 'Courier New', monospace;
            font-weight: 700;
            font-size: 1rem;
            color: var(--text);
            background: #f1f5f9;
            padding: 0.35rem 0.75rem;
            border-radius: 6px;
          }

          .history-status {
            display: flex;
            align-items: center;
            gap: 0.35rem;
            color: #16a34a;
            font-size: 0.85rem;
            font-weight: 500;
          }

          .history-time {
            color: var(--text-secondary);
            font-size: 0.9rem;
          }

          @media (max-width: 640px) {
            .page-header {
              padding: 1.5rem;
            }

            .header-content {
              flex-direction: column;
              text-align: center;
            }

            .page-title {
              font-size: 1.5rem;
            }

            .form-row {
              flex-direction: column;
            }

            .join-btn {
              width: 100%;
              justify-content: center;
            }
          }
        `}</style>
      </div>
    </Layout>
  );
};

export default MyQueuePage;
