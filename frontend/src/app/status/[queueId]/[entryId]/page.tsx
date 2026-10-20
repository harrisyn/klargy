'use client';

import { toast, errorMessage } from '@/lib/toast';
import QrCode from '@/components/QrCode';
import React, { useState, useEffect, useCallback, useRef, use } from 'react';
import Link from 'next/link';
import { useSocket } from '@/hooks/useSocket';
import { APP_NAME } from '@/lib/appConfig';
import { useRouter } from 'next/navigation';
import { DoneHere, JourneyTrail, SentToCard, type JourneyStop, type SentTo } from './JourneyPanel';

interface QueueStatus {
  ticketNumber: string;
  position: number | null;
  estimatedWaitTime: number;
  serviceName: string;
  locationName: string;
  locationAddress: string | null;
  status: 'WAITING' | 'SERVING' | 'SERVED' | 'CANCELLED' | 'NO_SHOW';
  /** On hold: off the desk for now, called back by staff. */
  held?: boolean;
  /** Waiting for payment before they can be called. */
  awaitingClearance?: boolean;
  /** The ticket they were sent on to, if any. */
  sentTo?: SentTo | null;
  /** The visit so far, oldest first. */
  journey?: JourneyStop[];
  /** Today's queue: PAUSED while staff (or the system) have paused it. */
  queueStatus?: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  currentlyServing: string | null;
  totalInQueue: number;
  waitingCount: number;
  servingCount: number;
  queueId: string;
  entryId: string;
  joinedAt: string;
  calledAt: string | null;
  /** A booked patient: their appointment time ("10:30", the location's
   * clock) and whether they were placed in line by it. */
  booked?: { at: string; time: string; placed: boolean } | null;
  userName: string;
  /** What we've sent the patient about this ticket, newest first. */
  messages?: { type: string; message: string; sentAt: string }[];
  organization?: {
    logoUrl?: string | null;
    primaryColor?: string | null;
    hidePoweredBy?: boolean;
  } | null;
}

import { API_BASE } from '@/lib/apiBase';

export default function QueueStatusPage({ 
  params 
}: { 
  params: Promise<{ queueId: string; entryId: string }> 
}) {
  const resolvedParams = use(params);
  const { queueId, entryId } = resolvedParams;
  
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const previousPositionRef = useRef<number | null>(null);
  const previousStatusRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  // Self-service identity form state
  const [showIdentityForm, setShowIdentityForm] = useState(false);
  const [identityFormData, setIdentityFormData] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    idNumber: '',
    dateOfBirth: '',
  });
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identitySaved, setIdentitySaved] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  
  const { joinQueue, leaveQueue, onQueueUpdated, onEntryStatusChanged, onNotification } = useSocket();
  const router = useRouter();

  // Play alert sound
  const playAlertSound = useCallback(() => {
    if (!audioRef.current) {
      // Create audio element with a simple beep tone
      audioRef.current = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleA9RsNDbsWgQIHDc4dKHNEpYuuPqq1M1OvO/4cy7VU5Os+XuzGI/PWvY6+iVSjxhyuzrvFw8Q9rq7sllNTf11O3g0mNNSMj1+Nhq');
    }
    audioRef.current.play().catch(() => {
      // Audio play failed - probably blocked by browser
    });
  }, []);

  // Trigger notification on position change
  const triggerNotification = useCallback((data: QueueStatus) => {
    if (notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`Queue Update - ${data.serviceName}`, {
        body: `You're now #${data.position} in line. Estimated wait: ${data.estimatedWaitTime} min`,
        icon: '/favicon.ico',
        tag: 'queue-update',
      });
    }
    
    if (audioEnabled && data.position !== null && data.position <= 3) {
      playAlertSound();
    }
  }, [notificationsEnabled, audioEnabled, playAlertSound]);

  // Special notification when called
  const triggerCalledNotification = useCallback((data: QueueStatus) => {
    if (notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`It's Your Turn! - ${data.serviceName}`, {
        body: `Ticket ${data.ticketNumber}: Please proceed to the service counter now.`,
        icon: '/favicon.ico',
        tag: 'queue-called',
        requireInteraction: true,
      });
    }
    
    playAlertSound();
  }, [notificationsEnabled, playAlertSound]);

  // Fetch status from API
  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/public/status/${queueId}/${entryId}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          setError('Ticket not found. It may have been cancelled or completed.');
          return;
        }
        if (response.status === 403) {
          const errData = await response.json().catch(() => ({}));
          if (errData.error === 'ORGANIZATION_PAUSED') {
            setUnavailable(true);
            setError(errData.message || 'This queue system is temporarily unavailable.');
            return;
          }
        }
        throw new Error('Failed to load status');
      }
      
      const data = await response.json();
      
      // Check if position improved
      if (previousPositionRef.current !== null && data.position !== null) {
        if (data.position < previousPositionRef.current) {
          triggerNotification(data);
        }
      }
      
      // Check if status changed to SERVING
      if (previousStatusRef.current === 'WAITING' && data.status === 'SERVING') {
        triggerCalledNotification(data);
      }
      
      previousPositionRef.current = data.position;
      previousStatusRef.current = data.status;
      setStatus(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load status', err);
      setError('Unable to load queue status. Please check your connection.');
    } finally {
      setLoading(false);
    }
  }, [queueId, entryId, triggerNotification, triggerCalledNotification]);

  // Enable browser notifications
  const enableNotifications = async () => {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        setNotificationsEnabled(true);
      }
    }
  };

  // Enable audio alerts
  const toggleAudio = () => {
    setAudioEnabled(!audioEnabled);
    if (!audioEnabled) {
      // Play a test sound to unlock audio context
      playAlertSound();
    }
  };

  // Load identity data when form is opened
  const loadIdentityData = async () => {
    try {
      const res = await fetch(`${API_BASE}/public/entries/${entryId}/identity`);
      if (res.ok) {
        const data = await res.json();
        setIdentityFormData({
          firstName: data.firstName || '',
          lastName: data.lastName || '',
          phone: data.phone || '',
          idNumber: data.identityData?.idNumber || '',
          dateOfBirth: data.identityData?.dateOfBirth || '',
        });
      }
    } catch (err) {
      console.error('Failed to load identity data', err);
    }
  };

  // Toggle identity form
  const toggleIdentityForm = () => {
    if (!showIdentityForm) {
      loadIdentityData();
    }
    setShowIdentityForm(!showIdentityForm);
    setIdentitySaved(false);
    setIdentityError(null);
  };

  // Handle identity form field change
  const handleIdentityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setIdentityFormData(prev => ({ ...prev, [name]: value }));
    setIdentitySaved(false);
  };

  // Save identity data
  const saveIdentityData = async () => {
    setIdentityLoading(true);
    setIdentityError(null);
    
    try {
      const res = await fetch(`${API_BASE}/public/entries/${entryId}/identity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: identityFormData.firstName,
          lastName: identityFormData.lastName,
          phone: identityFormData.phone,
          identityData: {
            idNumber: identityFormData.idNumber,
            dateOfBirth: identityFormData.dateOfBirth,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      setIdentitySaved(true);
      // Update the displayed name in status
      if (status) {
        setStatus({
          ...status,
          userName: `${identityFormData.firstName} ${identityFormData.lastName}`.trim(),
        });
      }
    } catch (err: any) {
      setIdentityError(err.message || 'Failed to save information');
    } finally {
      setIdentityLoading(false);
    }
  };

  // Initial load and Socket.IO setup
  useEffect(() => {
    loadStatus();
    
    // Join queue room for real-time updates
    joinQueue(queueId);
    
    // Set up polling as fallback (every 30 seconds)
    const interval = setInterval(loadStatus, 30000);
    
    return () => {
      leaveQueue(queueId);
      clearInterval(interval);
    };
  }, [queueId, loadStatus, joinQueue, leaveQueue]);

  // Listen for real-time queue updates
  useEffect(() => {
    const unsubscribeQueue = onQueueUpdated((data) => {
      if (data.queueId === queueId) {
        loadStatus();
      }
    });

    const unsubscribeEntry = onEntryStatusChanged((data) => {
      if (data.queueId === queueId && data.entryId === entryId) {
        loadStatus();
      }
    });

    // A message sent to this ticket shows under Messages straight away.
    const unsubscribeNotification = onNotification((data) => {
      if (data.entryId === entryId) loadStatus();
    });

    return () => {
      unsubscribeQueue();
      unsubscribeEntry();
      unsubscribeNotification();
    };
  }, [queueId, entryId, onQueueUpdated, onEntryStatusChanged, onNotification, loadStatus]);

  // Check if already have notification permissions
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      setNotificationsEnabled(true);
    }
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'WAITING': return '#0f9fa4';
      case 'SERVING': return '#f59e0b';
      case 'SERVED': return '#10b981';
      case 'CANCELLED': case 'NO_SHOW': return '#ef4444';
      default: return '#6b7280';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'WAITING': return 'Waiting';
      case 'SERVING': return "It's Your Turn!";
      case 'SERVED': return 'Completed';
      case 'CANCELLED': return 'Cancelled';
      case 'NO_SHOW': return 'No Show';
      default: return status;
    }
  };

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={bgPattern} />
        <div style={loadingContainer}>
          <div style={spinner} />
          <p style={loadingText}>Loading your status...</p>
        </div>
        <style>{spinnerKeyframes}</style>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div style={pageStyle}>
        <div style={bgPattern} />
        <div style={errorContainer}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke={unavailable ? '#f59e0b' : '#ef4444'} strokeWidth="1.5" style={{ marginBottom: '1rem' }}>
            {unavailable ? (
              <>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </>
            ) : (
              <>
                <circle cx="12" cy="12" r="10" />
                <path d="M15 9l-6 6M9 9l6 6" />
              </>
            )}
          </svg>
          <h1 style={errorTitle}>{unavailable ? 'Temporarily Unavailable' : 'Ticket Not Found'}</h1>
          <p style={errorSubtitle}>{error || 'This ticket may have been cancelled or completed.'}</p>
          <Link href="/locations" style={homeButton}>Find a Location</Link>
        </div>
      </div>
    );
  }

  const isCalled = status.status === 'SERVING';
  const isCompleted = status.status === 'SERVED' || status.status === 'CANCELLED' || status.status === 'NO_SHOW';

  const brandColor = status.organization?.primaryColor || '#0f9fa4';

  const renderLogo = () => (
    status.organization?.logoUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={status.organization.logoUrl} alt="" style={{ height: '40px', maxWidth: '120px', objectFit: 'contain' }} />
    ) : (
      <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
        <rect width="48" height="48" rx="12" fill="white" fillOpacity="0.2" />
        <path d="M14 24C14 18.477 18.477 14 24 14V14C29.523 14 34 18.477 34 24V34H14V24Z" fill="white" fillOpacity="0.9"/>
        <circle cx="24" cy="22" r="4" fill={isCalled ? '#f59e0b' : brandColor}/>
      </svg>
    )
  );

  return (
    <div style={{ 
      ...pageStyle, 
      background: isCalled 
        ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' 
        : isCompleted 
          ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
          : pageStyle.background 
    }}>
      <div style={bgPattern} />
      <style>{spinnerKeyframes}</style>
      
      <div style={contentStyle}>
        {/* Status indicator for called */}
        {isCalled && (
          <div style={calledBanner}>
            <div style={pulsingCircle} />
            <span style={calledText}>It&apos;s Your Turn!</span>
          </div>
        )}

        {/* Header */}
        <div style={headerStyle}>
          <div style={logoBox}>
            {renderLogo()}
          </div>
          <div style={headerInfo}>
            <p style={serviceName}>{status.serviceName}</p>
            <p style={locationName}>{status.locationName}</p>
            {status.locationAddress && (
              <p style={locationAddress}>{status.locationAddress}</p>
            )}
          </div>
        </div>

        {/* Main Status Card */}
        <div style={statusCard}>
          {/* Ticket Number */}
          <div style={ticketSection}>
            <span style={ticketLabel}>Your ticket</span>
            <span style={ticketNumber}>{status.ticketNumber}</span>
            {status.userName && (
              <span style={userName}>{status.userName}</span>
            )}
            {status.booked && (
              <span
                style={bookedChip}
                title={status.booked.placed ? 'You arrived on time, so your place in line follows your booked time.' : undefined}
              >
                Booked {status.booked.time}
              </span>
            )}
          </div>

          {/* Status Badge */}
          <div style={statusBadgeContainer}>
            <div style={{ ...statusBadge, background: `${getStatusColor(status.status)}15`, color: getStatusColor(status.status) }}>
              <span style={{ ...statusDot, background: getStatusColor(status.status) }} />
              <span>{getStatusText(status.status)}</span>
            </div>
          </div>

          {/* On hold / awaiting payment */}
          {status.status === 'WAITING' && status.held && (
            <div role="status" style={pausedBanner}>
              You&apos;re on hold for now. Please stay nearby; staff will call you back.
            </div>
          )}
          {status.status === 'WAITING' && !status.held && status.awaitingClearance && (
            <div role="status" style={pausedBanner}>
              Awaiting payment. Please pay at the cashier; you&apos;ll join the line for {status.serviceName} as soon as it&apos;s cleared.
            </div>
          )}

          {/* Paused banner */}
          {status.status === 'WAITING' && status.queueStatus === 'PAUSED' && (
            <div role="status" style={pausedBanner}>
              {status.serviceName} is paused for now. You keep your place in line. Please stay nearby; we&apos;ll let you know when it reopens.
            </div>
          )}

          {/* Position Display */}
          {status.status === 'WAITING' && status.position !== null && (
            <div style={positionSection}>
              <div style={positionRing}>
                <svg width="160" height="160" viewBox="0 0 160 160">
                  {/* Background circle */}
                  <circle
                    cx="80"
                    cy="80"
                    r="70"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="8"
                  />
                  {/* Progress circle */}
                  <circle
                    cx="80"
                    cy="80"
                    r="70"
                    fill="none"
                    stroke={brandColor}
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={`${((status.totalInQueue - status.position) / status.totalInQueue) * 439.82} 439.82`}
                    transform="rotate(-90 80 80)"
                    style={{ transition: 'stroke-dasharray 0.5s ease' }}
                  />
                </svg>
                <div style={positionContent}>
                  <span style={positionNumber}>{status.position}</span>
                  <span style={positionLabel}>in line</span>
                </div>
              </div>
            </div>
          )}

          {/* Called/Serving State */}
          {isCalled && (
            <div style={calledSection}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p style={calledMessage}>Please proceed to the service counter now</p>
            </div>
          )}

          {/* Completed State */}
          {isCompleted && (
            <div style={completedSection}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p style={completedMessage}>
                {status.status === 'SERVED' ? 'Thank you for visiting!' : 'This ticket has been closed.'}
              </p>
            </div>
          )}

          {/* Wait Time & Info */}
          {status.status === 'WAITING' && (
            <div style={infoGrid}>
              <div style={infoItem}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={brandColor} strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                <div>
                  <span style={infoLabel}>Estimated wait</span>
                  <span style={infoValue}>
                    {status.held ? 'When called back' : status.awaitingClearance ? 'After payment' : `~${status.estimatedWaitTime} min`}
                  </span>
                </div>
              </div>
              <div style={infoItem}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <div>
                  <span style={infoLabel}>Now serving</span>
                  <span style={infoValue}>{status.currentlyServing || 'Starting...'}</span>
                </div>
              </div>
            </div>
          )}

          {/* Queue Stats */}
          {status.status === 'WAITING' && (
            <div style={statsBar}>
              <span style={statItem}>
                <strong>{status.waitingCount}</strong> waiting
              </span>
              <span style={statDivider}>•</span>
              <span style={statItem}>
                <strong>{status.servingCount}</strong> being served
              </span>
            </div>
          )}

          {/* Self-Service Identity Form - only for WAITING status */}
          {status.status === 'WAITING' && (
            <div style={identitySection}>
              <button onClick={toggleIdentityForm} style={identityToggleButton}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span>Add or change your details</span>
                <svg 
                  width="20" 
                  height="20" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2"
                  style={{ transform: showIdentityForm ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showIdentityForm && (
                <div style={identityFormContainer}>
                  <p style={identityFormHint}>
                    Help us serve you better by providing your details. This will save time at the counter.
                  </p>
                  
                  <div style={identityFormGrid}>
                    <div style={identityFormField}>
                      <label style={identityLabel}>First Name</label>
                      <input
                        type="text"
                        name="firstName"
                        value={identityFormData.firstName}
                        onChange={handleIdentityChange}
                        style={identityInput}
                        placeholder="Your first name"
                      />
                    </div>
                    <div style={identityFormField}>
                      <label style={identityLabel}>Last Name</label>
                      <input
                        type="text"
                        name="lastName"
                        value={identityFormData.lastName}
                        onChange={handleIdentityChange}
                        style={identityInput}
                        placeholder="Your last name"
                      />
                    </div>
                    <div style={identityFormField}>
                      <label style={identityLabel}>Phone Number</label>
                      <input
                        type="tel"
                        name="phone"
                        value={identityFormData.phone}
                        onChange={handleIdentityChange}
                        style={identityInput}
                        placeholder="+233 XXX XXX XXX"
                      />
                    </div>
                    <div style={identityFormField}>
                      <label style={identityLabel}>ID Number (Optional)</label>
                      <input
                        type="text"
                        name="idNumber"
                        value={identityFormData.idNumber}
                        onChange={handleIdentityChange}
                        style={identityInput}
                        placeholder="National ID / Passport"
                      />
                    </div>
                    <div style={{...identityFormField, gridColumn: '1 / -1'}}>
                      <label style={identityLabel}>Date of Birth (Optional)</label>
                      <input
                        type="date"
                        name="dateOfBirth"
                        value={identityFormData.dateOfBirth}
                        onChange={handleIdentityChange}
                        style={identityInput}
                      />
                    </div>
                  </div>

                  {identityError && (
                    <div style={identityErrorMessage}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M15 9l-6 6M9 9l6 6" />
                      </svg>
                      {identityError}
                    </div>
                  )}

                  {identitySaved && (
                    <div style={identitySuccessMessage}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                      </svg>
                      Information saved successfully!
                    </div>
                  )}

                  <button
                    onClick={saveIdentityData}
                    disabled={identityLoading}
                    style={{
                      ...identitySaveButton,
                      background: brandColor,
                      opacity: identityLoading ? 0.7 : 1,
                      cursor: identityLoading ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {identityLoading ? (
                      <>
                        <div style={identitySpinner} />
                        Saving...
                      </>
                    ) : (
                      <>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                          <polyline points="17 21 17 13 7 13 7 21" />
                          <polyline points="7 3 7 8 15 8" />
                        </svg>
                        Save Information
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sent on, I'm done here, and the visit so far */}
        {status.sentTo && <SentToCard sentTo={status.sentTo} brandColor={brandColor} />}
        {!status.sentTo && (
          <DoneHere
            queueId={queueId}
            entryId={entryId}
            status={status.status}
            brandColor={brandColor}
            onMoved={(to) => (to ? router.push(to.statusPath) : loadStatus())}
          />
        )}
        {status.journey && <JourneyTrail journey={status.journey} brandColor={brandColor} />}

        {/* Notifications */}
        {status.status === 'WAITING' && !notificationsEnabled && (
          <button onClick={enableNotifications} style={notifyButton}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
            </svg>
            <span>Tell me when I’m nearly up</span>
          </button>
        )}

        {notificationsEnabled && status.status === 'WAITING' && (
          <div style={notifyEnabled}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="#10b981">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>Notifications enabled</span>
          </div>
        )}

        {/* Audio Toggle */}
        {status.status === 'WAITING' && (
          <button onClick={toggleAudio} style={audioButton}>
            {audioEnabled ? (
              <>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" />
                </svg>
                <span>Audio alerts on</span>
              </>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
                <span>Play a sound when I’m called</span>
              </>
            )}
          </button>
        )}

        {/* Actions */}
        <div style={actionButtons}>
          <button onClick={loadStatus} style={refreshButton}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
            <span>Refresh</span>
          </button>
          <button onClick={() => setShowQR(!showQR)} style={shareButton}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3 4a1 1 0 011-1h3a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 2V5h1v1H5zM3 13a1 1 0 011-1h3a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3zm2 2v-1h1v1H5zM13 3a1 1 0 00-1 1v3a1 1 0 001 1h3a1 1 0 001-1V4a1 1 0 00-1-1h-3zm1 2v1h1V5h-1zM11 13a1 1 0 011-1h1v1h-1v1h1a1 1 0 011 1v1h-1v-1h-1a1 1 0 01-1-1v-1zm4-1h1v1h-1v-1zm0 3h1v1h-1v-1zm-2 1h1v1h-1v-1z" />
            </svg>
            <span>Share</span>
          </button>
        </div>

        {/* QR Code Modal */}
        {showQR && (
          <div style={qrModal}>
            <div style={qrModalContent}>
              <button onClick={() => setShowQR(false)} style={qrCloseButton}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <h3 style={qrTitle}>Open this ticket on another phone</h3>
              <p style={qrSubtitle}>Scan this QR code to view ticket status</p>
              <div style={qrCodeContainer}>
                <QrCode value={typeof window !== 'undefined' ? window.location.href : ''} size={200} label="QR code for this ticket" />
              </div>
              <div style={qrTicketInfo}>
                <span style={{ ...qrTicketLabel, color: brandColor }}>Ticket #{status.ticketNumber}</span>
              </div>
              <button
                onClick={() => {
                  if (navigator.share) {
                    navigator.share({
                      title: `Ticket ${status.ticketNumber} - ${status.serviceName}`,
                      text: `Track my queue position for ${status.serviceName}`,
                      url: window.location.href,
                    });
                  } else {
                    navigator.clipboard.writeText(window.location.href);
                    toast.success('Link copied.');
                  }
                }}
                style={{ ...shareUrlButton, background: brandColor }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                </svg>
                <span>Copy Link</span>
              </button>
            </div>
          </div>
        )}

        {/* Messages we've sent them about this ticket */}
        {status.messages && status.messages.length > 0 && (
          <section style={messagesCard} aria-labelledby="ticket-messages">
            <h2 id="ticket-messages" style={messagesTitle}>Messages</h2>
            <ul style={messagesList}>
              {status.messages.map((m, i) => (
                <li key={`${m.sentAt}-${i}`} style={messageItem}>
                  {/* They're already on the page the link points to. */}
                  <p style={messageText}>{m.message.replace(/\s*Track your place: \S+$/, '')}</p>
                  <time style={messageTime} dateTime={m.sentAt}>
                    {new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Joined At */}
        <p style={joinedAtText}>
          Joined at {new Date(status.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>

        {/* Help text */}
        <p style={helpText}>
          This page updates by itself. You don’t need to stay in the waiting area; come back when you’re nearly up.
        </p>

        {!status.organization?.hidePoweredBy && (
          <p style={footerText}>
            Powered by <strong>{APP_NAME}</strong>
          </p>
        )}
      </div>
    </div>
  );
}

// Keyframes for animations
const spinnerKeyframes = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.1); }
  }
  @keyframes bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
  }
`;

// Styles
const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: 'var(--paper, #f2f6f5)',
  position: 'relative',
  overflow: 'hidden',
};

const bgPattern: React.CSSProperties = {
  display: 'none',
};

const contentStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  minHeight: '100vh',
  padding: '1.25rem 1rem 2.5rem',
};

const loadingContainer: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  gap: '1.5rem',
  position: 'relative',
  zIndex: 1,
};

const spinner: React.CSSProperties = {
  width: '40px',
  height: '40px',
  border: '3px solid #e2e6e3',
  borderTopColor: '#0f9fa4',
  borderRadius: '50%',
  animation: 'spin 1s linear infinite',
};

const loadingText: React.CSSProperties = {
  color: '#6b7a86',
  fontSize: '1rem',
};

const errorContainer: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  textAlign: 'center',
  position: 'relative',
  zIndex: 1,
  padding: '2rem',
};

const errorTitle: React.CSSProperties = {
  fontSize: '1.5rem',
  fontWeight: 700,
  color: '#0d2a47',
  marginBottom: '0.5rem',
};

const errorSubtitle: React.CSSProperties = {
  color: '#4f5d69',
  marginBottom: '2rem',
  maxWidth: '320px',
  lineHeight: 1.5,
};

const homeButton: React.CSSProperties = {
  padding: '0.75rem 1.5rem',
  background: '#0f9fa4',
  color: 'white',
  borderRadius: '0.75rem',
  textDecoration: 'none',
  fontWeight: 600,
};

const calledBanner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.875rem 1.5rem',
  background: '#0d2a47',
  borderRadius: '9999px',
  marginBottom: '1.25rem',
};

const pulsingCircle: React.CSSProperties = {
  width: '12px',
  height: '12px',
  borderRadius: '50%',
  background: '#f5c451',
  animation: 'pulse 1s infinite',
};

const calledText: React.CSSProperties = {
  fontWeight: 700,
  fontSize: '1.0625rem',
  color: 'white',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.875rem',
  width: '100%',
  maxWidth: '440px',
  marginBottom: '1rem',
  paddingBottom: '0.75rem',
  borderBottom: '3px solid #0f9fa4',
};

const logoBox: React.CSSProperties = {
  display: 'flex',
};

const headerInfo: React.CSSProperties = {
  textAlign: 'left',
};

const serviceName: React.CSSProperties = {
  fontWeight: 700,
  color: '#0d2a47',
  fontSize: '1.125rem',
  margin: 0,
};

const locationName: React.CSSProperties = {
  color: '#4f5d69',
  fontSize: '0.875rem',
  margin: 0,
};

const locationAddress: React.CSSProperties = {
  color: '#6b7a86',
  fontSize: '0.75rem',
  margin: 0,
};

const statusCard: React.CSSProperties = {
  width: '100%',
  maxWidth: '440px',
  background: 'white',
  borderRadius: '1.25rem',
  padding: '1.5rem',
  border: '1px solid #e2e6e3',
};

const ticketSection: React.CSSProperties = {
  textAlign: 'center',
  marginBottom: '1.5rem',
};

const ticketLabel: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#9ca3af',
  letterSpacing: '0.1em',
  marginBottom: '0.25rem',
};

const ticketNumber: React.CSSProperties = {
  display: 'block',
  fontSize: '2.5rem',
  fontWeight: 800,
  background: 'var(--gradient-ticket)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
};

const userName: React.CSSProperties = {
  display: 'block',
  fontSize: '0.875rem',
  color: '#6b7280',
  marginTop: '0.25rem',
};

const pausedBanner: React.CSSProperties = {
  margin: '0 0 16px',
  padding: '12px 16px',
  borderRadius: '12px',
  background: '#fffbeb',
  border: '1px solid #fde68a',
  color: '#92400e',
  fontSize: '14px',
  lineHeight: 1.5,
  textAlign: 'center',
};

const bookedChip: React.CSSProperties = {
  display: 'inline-block',
  marginTop: '0.5rem',
  padding: '0.25rem 0.75rem',
  borderRadius: '9999px',
  fontSize: '0.8125rem',
  fontWeight: 600,
  background: 'rgba(100, 116, 139, 0.12)',
  color: '#475569',
};

const statusBadgeContainer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  marginBottom: '2rem',
};

const statusBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.5rem 1rem',
  borderRadius: '9999px',
  fontSize: '0.875rem',
  fontWeight: 600,
};

const statusDot: React.CSSProperties = {
  width: '8px',
  height: '8px',
  borderRadius: '50%',
};

const positionSection: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  marginBottom: '2rem',
};

const positionRing: React.CSSProperties = {
  position: 'relative',
  width: '160px',
  height: '160px',
};

const positionContent: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
};

const positionNumber: React.CSSProperties = {
  fontSize: '3rem',
  fontWeight: 800,
  color: '#111827',
  lineHeight: 1,
};

const positionLabel: React.CSSProperties = {
  fontSize: '0.875rem',
  color: '#6b7280',
  marginTop: '0.25rem',
};

const calledSection: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
  padding: '2rem 0',
};

const calledMessage: React.CSSProperties = {
  fontSize: '1.125rem',
  fontWeight: 600,
  color: '#111827',
  textAlign: 'center',
  margin: 0,
};

const completedSection: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
  padding: '2rem 0',
};

const completedMessage: React.CSSProperties = {
  fontSize: '1.125rem',
  fontWeight: 500,
  color: '#6b7280',
  textAlign: 'center',
  margin: 0,
};

const infoGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '1rem',
  marginBottom: '1rem',
};

const infoItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '1rem',
  background: '#f9fafb',
  borderRadius: '0.75rem',
};

const infoLabel: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: '#6b7280',
};

const infoValue: React.CSSProperties = {
  display: 'block',
  fontSize: '1rem',
  fontWeight: 600,
  color: '#111827',
};

const statsBar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.75rem',
  background: '#f3f4f6',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  color: '#6b7280',
};

const statItem: React.CSSProperties = {};

const statDivider: React.CSSProperties = {
  color: '#d1d5db',
};

const notifyButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  width: '100%',
  maxWidth: '440px',
  minHeight: '52px',
  marginTop: '1rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '14px',
  fontWeight: 700,
  fontSize: '1rem',
  cursor: 'pointer',
};

const notifyEnabled: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  width: '100%',
  maxWidth: '400px',
  padding: '1rem',
  marginTop: '1.5rem',
  background: 'rgba(16, 185, 129, 0.1)',
  color: '#10b981',
  borderRadius: '0.75rem',
  fontWeight: 500,
  fontSize: '0.9375rem',
};

const audioButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  minHeight: '48px',
  background: 'white',
  color: '#0d2a47',
  border: '1.5px solid #cdd4d0',
  borderRadius: '14px',
  fontWeight: 600,
  fontSize: '0.9375rem',
  cursor: 'pointer',
  width: '100%',
  maxWidth: '440px',
  marginTop: '0.625rem',
};

const actionButtons: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  width: '100%',
  maxWidth: '400px',
  marginTop: '1rem',
};

const refreshButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  minHeight: '48px',
  background: 'white',
  color: '#0d2a47',
  border: '1.5px solid #cdd4d0',
  borderRadius: '14px',
  fontWeight: 600,
  fontSize: '0.9375rem',
  cursor: 'pointer',
  flex: 1,
};

const shareButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  minHeight: '48px',
  background: 'white',
  color: '#0d2a47',
  border: '1.5px solid #cdd4d0',
  borderRadius: '14px',
  fontWeight: 600,
  fontSize: '0.9375rem',
  cursor: 'pointer',
  flex: 1,
};

const qrModal: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.8)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '1rem',
};

const qrModalContent: React.CSSProperties = {
  background: 'white',
  borderRadius: '1.5rem',
  padding: '2rem',
  maxWidth: '320px',
  width: '100%',
  textAlign: 'center',
  position: 'relative',
};

const qrCloseButton: React.CSSProperties = {
  position: 'absolute',
  top: '1rem',
  right: '1rem',
  background: 'none',
  border: 'none',
  color: '#6b7280',
  cursor: 'pointer',
  padding: '0.25rem',
};

const qrTitle: React.CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 700,
  color: '#111827',
  marginBottom: '0.5rem',
};

const qrSubtitle: React.CSSProperties = {
  fontSize: '0.875rem',
  color: '#6b7280',
  marginBottom: '1.5rem',
};

const qrCodeContainer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  marginBottom: '1.5rem',
};

const qrImage: React.CSSProperties = {
  width: '200px',
  height: '200px',
  borderRadius: '0.75rem',
  border: '1px solid #e5e7eb',
};

const qrTicketInfo: React.CSSProperties = {
  marginBottom: '1.5rem',
};

const qrTicketLabel: React.CSSProperties = {
  fontSize: '1.125rem',
  fontWeight: 600,
  color: '#0f9fa4',
};

const shareUrlButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  width: '100%',
  padding: '0.875rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '0.75rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const messagesCard: React.CSSProperties = {
  width: '100%',
  maxWidth: '440px',
  background: 'white',
  borderRadius: '1.25rem',
  padding: '1.25rem 1.5rem',
  border: '1px solid #e2e6e3',
  marginTop: '1rem',
};

const messagesTitle: React.CSSProperties = {
  fontSize: '0.9375rem',
  fontWeight: 600,
  color: '#1f2a33',
  margin: '0 0 0.5rem',
};

const messagesList: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const messageItem: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '0.75rem',
  padding: '0.625rem 0',
  borderTop: '1px solid #eef1ef',
};

const messageText: React.CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  lineHeight: 1.45,
  color: '#33414c',
};

const messageTime: React.CSSProperties = {
  flexShrink: 0,
  fontSize: '0.75rem',
  color: '#6b7a86',
};

const joinedAtText: React.CSSProperties = {
  color: '#6b7a86',
  fontSize: '0.875rem',
  marginTop: '1.25rem',
};

const helpText: React.CSSProperties = {
  color: '#6b7a86',
  fontSize: '0.8125rem',
  textAlign: 'center',
  maxWidth: '320px',
  lineHeight: 1.5,
  marginTop: '0.25rem',
};

const footerText: React.CSSProperties = {
  color: '#97a3ad',
  fontSize: '0.8125rem',
  marginTop: '1rem',
};

// Identity Form Styles
const identitySection: React.CSSProperties = {
  width: '100%',
  marginTop: '1rem',
  borderTop: '1px solid #e5e7eb',
  paddingTop: '1rem',
};

const identityToggleButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  width: '100%',
  padding: '0.875rem',
  background: '#f3f4f6',
  color: '#374151',
  border: 'none',
  borderRadius: '0.75rem',
  fontWeight: 500,
  cursor: 'pointer',
  fontSize: '0.9375rem',
};

const identityFormContainer: React.CSSProperties = {
  marginTop: '1rem',
  padding: '1rem',
  background: '#f9fafb',
  borderRadius: '0.75rem',
};

const identityFormHint: React.CSSProperties = {
  fontSize: '0.8125rem',
  color: '#6b7280',
  marginBottom: '1rem',
  textAlign: 'center',
};

const identityFormGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.75rem',
};

const identityFormField: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const identityLabel: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 500,
  color: '#4b5563',
};

const identityInput: React.CSSProperties = {
  padding: '0.625rem 0.75rem',
  border: '1px solid #d1d5db',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  color: '#111827',
  background: 'white',
  outline: 'none',
};

const identityErrorMessage: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.75rem',
  padding: '0.625rem 0.875rem',
  background: '#fef2f2',
  color: '#dc2626',
  borderRadius: '0.5rem',
  fontSize: '0.8125rem',
};

const identitySuccessMessage: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.75rem',
  padding: '0.625rem 0.875rem',
  background: '#f0fdf4',
  color: '#16a34a',
  borderRadius: '0.5rem',
  fontSize: '0.8125rem',
};

const identitySaveButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  width: '100%',
  marginTop: '1rem',
  padding: '0.75rem',
  background: '#0f9fa4',
  color: 'white',
  border: 'none',
  borderRadius: '0.5rem',
  fontWeight: 600,
  fontSize: '0.875rem',
};

const identitySpinner: React.CSSProperties = {
  width: '16px',
  height: '16px',
  border: '2px solid rgba(255, 255, 255, 0.3)',
  borderTopColor: 'white',
  borderRadius: '50%',
  animation: 'spin 1s linear infinite',
};
