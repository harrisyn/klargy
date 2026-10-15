'use client';

import React, { useState, useEffect, use, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { APP_NAME } from '@/lib/appConfig';

import { API_BASE } from '@/lib/apiBase';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { termsFor } from '@/lib/terms';
import styles from './join.module.css';

interface IdentityFieldConfig {
  required: boolean;
  label: string;
  type?: string;
}

interface LocationInfo {
  id: string;
  name: string;
  publicCode: string;
  organization: {
    id: string;
    name: string;
    identityFieldsConfig?: Record<string, IdentityFieldConfig>;
    logoUrl?: string | null;
    primaryColor?: string | null;
    hidePoweredBy?: boolean;
    industry?: string | null;
    customerLabel?: string | null;
    customerLabelPlural?: string | null;
  };
  /** Set when the organisation checks an MR or member number with its EMR before issuing a ticket. */
  joinIdentifier?: { type: 'mrNumber' | 'memberNumber'; label: string } | null;
  services: {
    id: string;
    name: string;
    description?: string;
    type: string;
    slotDuration: number;
    startTime: string;
    endTime: string;
  }[];
}

interface JoinResult {
  ticketNumber: string;
  position: number;
  estimatedWait: number;
  queueId: string;
  entryId: string;
  serviceName: string;
  locationName: string;
  sessionId?: string;
}

interface SessionEntry {
  id: string;
  ticketNumber: string;
  status: string;
  position: number;
  serviceName: string;
  queueId: string;
}

type PageMode = 'normal' | 'kiosk' | 'session';

// Session storage key prefix
const SESSION_KEY_PREFIX = 'qms_session_';

export default function JoinQueuePage({ params }: { params: Promise<{ code: string }> }) {
  const resolvedParams = use(params);
  const code = resolvedParams.code;
  const searchParams = useSearchParams();
  
  // Determine mode from URL params
  const urlMode = (searchParams?.get('mode') ?? null) as PageMode | null;
  const kioskAutoReset = parseInt(searchParams?.get('resetTime') || '15', 10); // seconds
  
  // Kiosk and multi-ticket are set by staff in the link (?mode=kiosk), not by visitors.
  const [mode] = useState<PageMode>(urlMode === 'kiosk' || urlMode === 'session' ? urlMode : 'normal');
  const [step, setStep] = useState<'loading' | 'select-service' | 'form' | 'success' | 'error' | 'session-tickets'>('loading');
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string>('');
  const [joinResult, setJoinResult] = useState<JoinResult | null>(null);
  const [sessionEntries, setSessionEntries] = useState<SessionEntry[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [formData, setFormData] = useState<Record<string, string>>({
    name: '',
    phone: '',
    notes: '',
  });
  const [joining, setJoining] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [kioskCountdown, setKioskCountdown] = useState<number | null>(null);
  
  const printRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const locationRef = useRef<LocationInfo | null>(null);
  useEffect(() => { locationRef.current = location; }, [location]);

  // Load or generate session ID
  useEffect(() => {
    if (mode === 'session') {
      const storedSession = localStorage.getItem(`${SESSION_KEY_PREFIX}${code}`);
      if (storedSession) {
        setSessionId(storedSession);
      } else {
        const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem(`${SESSION_KEY_PREFIX}${code}`, newSessionId);
        setSessionId(newSessionId);
      }
    }
  }, [mode, code]);

  // Load session entries when in session mode
  useEffect(() => {
    if (mode === 'session' && sessionId && step === 'session-tickets') {
      loadSessionEntries();
    }
  }, [mode, sessionId, step]);

  const loadSessionEntries = async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${API_BASE}/public/session/${sessionId}/tickets`);
      if (res.ok) {
        const data = await res.json();
        setSessionEntries(Array.isArray(data) ? data : data.entries || []);
      }
    } catch (err) {
      console.error('Failed to load session entries', err);
    }
  };

  useEffect(() => {
    loadLocationInfo();
  }, [code]);

  // Kiosk mode auto-reset countdown
  useEffect(() => {
    if (mode === 'kiosk' && step === 'success') {
      setKioskCountdown(kioskAutoReset);
      countdownRef.current = setInterval(() => {
        setKioskCountdown(prev => {
          if (prev !== null && prev <= 1) {
            resetForNextCustomer();
            return null;
          }
          return prev !== null ? prev - 1 : null;
        });
      }, 1000);
    }
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, [mode, step, kioskAutoReset]);

  const resetForNextCustomer = useCallback(() => {
    // Reset all form data fields
    setFormData({});
    setJoinResult(null);
    setError('');
    setKioskCountdown(null);
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    const loc = locationRef.current;
    if (loc?.services.length === 1) {
      setSelectedServiceId(loc.services[0].id);
      setStep('form');
    } else {
      setSelectedServiceId('');
      setStep('select-service');
    }
  }, []);

  const loadLocationInfo = async () => {
    try {
      const res = await fetch(`${API_BASE}/public/locations/${code}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.error === 'ORGANIZATION_PAUSED') {
          setUnavailable(true);
        }
        throw new Error(errData.message || errData.error || 'Location not found');
      }
      const data: LocationInfo = await res.json();
      setLocation(data);
      
      if (data.services.length === 1) {
        setSelectedServiceId(data.services[0].id);
      }
      
      // In session mode, check if we have existing tickets
      if (mode === 'session' && sessionId) {
        const sessionRes = await fetch(`${API_BASE}/public/session/${sessionId}/tickets`);
        if (sessionRes.ok) {
          const sessionData = await sessionRes.json();
          const list = Array.isArray(sessionData) ? sessionData : sessionData.entries || [];
          if (list.length > 0) {
            setSessionEntries(list);
            setStep('session-tickets');
            return;
          }
        }
      }
      
      // One service: nothing to choose, go straight to the details.
      setStep(data.services.length === 1 ? 'form' : 'select-service');
    } catch (err) {
      console.error('Failed to load location info', err);
      setError(err instanceof Error ? err.message : 'Queue not found or no longer active');
      setStep('error');
    }
  };

  const handleSelectService = (serviceId: string) => {
    setSelectedServiceId(serviceId);
    setStep('form');
  };

  const NAME_FIELDS = ['name', 'fullName', 'firstName', 'lastName', 'customerName', 'patientName'];

  // Get identity fields config from organization, with fallback defaults
  const getIdentityFields = (): Record<string, IdentityFieldConfig> => {
    const orgConfig = location?.organization?.identityFieldsConfig;
    if (orgConfig && Object.keys(orgConfig).length > 0) {
      // Saved configs keep whatever key order they were written in; show
      // names first, then contact details, then org-specific fields.
      // Settings saves an explicit `order`; older configs get names first.
      const entries = Object.entries(orgConfig) as [string, IdentityFieldConfig & { order?: number }][];
      const ORDER = ['name', 'fullName', 'firstName', 'lastName', 'phone', 'email'];
      const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
      const hasOrder = entries.every(([, c]) => typeof c.order === 'number');
      return Object.fromEntries(entries.sort(([a, ca], [b, cb]) => (hasOrder ? ca.order! - cb.order! : rank(a) - rank(b))));
    }
    // Default fallback if no config
    return {
      firstName: { required: true, label: 'First name', type: 'text' },
      lastName: { required: false, label: 'Last name', type: 'text' },
      phone: { required: false, label: 'Phone number', type: 'tel' },
    };
  };

  const handleJoinQueue = async () => {
    const identityFields = getIdentityFields();

    // Staff call people by name, and the server rejects a ticket without one -
    // even when an org's config marks every name field optional.
    const nameKeys = Object.keys(identityFields).filter((k) => NAME_FIELDS.includes(k));
    if (nameKeys.length > 0 && !nameKeys.some((k) => formData[k]?.trim())) {
      setError('Please enter your name so staff can call you.');
      return;
    }
    
    // Validate required fields
    for (const [fieldKey, fieldConfig] of Object.entries(identityFields)) {
      if (fieldKey === location?.joinIdentifier?.type) continue; // asked for as `identifier`
      if (fieldConfig.required && !formData[fieldKey]?.trim()) {
        setError(`Please fill in ${fieldConfig.label.toLowerCase()}.`);
        return;
      }
    }

    const joinIdentifier = location?.joinIdentifier;
    if (joinIdentifier && !formData.identifier?.trim()) {
      setError(`Please enter your ${joinIdentifier.label}.`);
      return;
    }

    if (!selectedServiceId) {
      setError('Please select a service');
      return;
    }

    setJoining(true);
    setError('');

    try {
      // Use session-join endpoint if in session mode
      const endpoint = `${API_BASE}/public/join`;
      
      // Build body data from all form fields
      const bodyData: Record<string, unknown> = {
        serviceId: selectedServiceId,
      };
      
      // Add all form fields (trimmed, excluding empty values)
      for (const [fieldKey, value] of Object.entries(formData)) {
        const trimmedValue = value?.trim();
        if (trimmedValue) {
          bodyData[fieldKey] = trimmedValue;
        }
      }
      
      if (mode === 'session') {
        bodyData.sessionId = sessionId;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.code === 'IDENTIFIER_NOT_MATCHED') {
          // Ask again: clear the number and put them back in that box.
          setFormData((f) => ({ ...f, identifier: '' }));
          setTimeout(() => document.getElementById('field-identifier')?.focus(), 0);
        }
        throw new Error(errData.message || errData.error || 'Failed to join queue');
      }

      const data: JoinResult = await res.json();
      setJoinResult(data);

      // On their own phone, go straight to the live ticket page.
      if (mode === 'normal') {
        window.location.assign(`/status/${data.queueId}/${data.entryId}`);
        return;
      }
      if (mode === 'session') loadSessionEntries();
      
      // In kiosk mode, auto-print the ticket
      if (mode === 'kiosk') {
        setTimeout(() => handlePrintTicket(), 500);
      }
      
      setStep('success');
    } catch (err) {
      console.error('Failed to join queue', err);
      setError(err instanceof Error ? err.message : 'Failed to join queue. Please try again.');
    } finally {
      setJoining(false);
    }
  };

  const handlePrintTicket = useCallback(() => {
    if (isPrinting || !joinResult) return;
    
    setIsPrinting(true);
    
    // Create a new window for printing
    const printWindow = window.open('', '_blank', 'width=400,height=600');
    if (!printWindow) {
      setIsPrinting(false);
      return;
    }
    
    // Capture values to ensure they're available in the template
    const ticketNumber = joinResult.ticketNumber || 'N/A';
    const locationName = joinResult.locationName || location?.name || 'Queue';
    const serviceName = joinResult.serviceName || selectedService?.name || 'Service';
    const position = joinResult.position ?? 0;
    const estimatedWait = joinResult.estimatedWait ?? 0;
    const dateTime = new Date().toLocaleString();
    
    const ticketHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Queue Ticket - ${ticketNumber}</title>
          <style>
            @page {
              size: 80mm auto;
              margin: 5mm;
            }
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            body {
              font-family: 'Courier New', Courier, monospace;
              margin: 0;
              padding: 10mm;
              text-align: center;
              width: 80mm;
              background: white;
            }
            .header {
              font-size: 16pt;
              font-weight: bold;
              margin-bottom: 6mm;
              padding-bottom: 4mm;
              border-bottom: 2px dashed #333;
              letter-spacing: 1mm;
            }
            .location {
              font-size: 12pt;
              font-weight: bold;
              margin-bottom: 2mm;
              color: #000;
            }
            .service {
              font-size: 10pt;
              color: #555;
              margin-bottom: 6mm;
            }
            .ticket-number {
              font-size: 42pt;
              font-weight: bold;
              margin: 6mm 0;
              letter-spacing: 3mm;
              color: #000;
              padding: 4mm 0;
              border: 3px solid #000;
              border-radius: 4mm;
            }
            .info-row {
              display: flex;
              justify-content: space-between;
              font-size: 10pt;
              margin: 2mm 0;
              padding: 0 4mm;
            }
            .info-label {
              color: #666;
            }
            .info-value {
              font-weight: bold;
            }
            .datetime {
              font-size: 9pt;
              color: #666;
              margin-top: 4mm;
            }
            .footer {
              margin-top: 6mm;
              padding-top: 4mm;
              border-top: 2px dashed #333;
              font-size: 9pt;
              color: #555;
              line-height: 1.6;
            }
          </style>
        </head>
        <body>
          <div class="header">QUEUE TICKET</div>
          <div class="location">${locationName}</div>
          <div class="service">${serviceName}</div>
          <div class="ticket-number">${ticketNumber}</div>
          <div class="info-row">
            <span class="info-label">Position:</span>
            <span class="info-value">#${position}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Est. Wait:</span>
            <span class="info-value">~${estimatedWait} min</span>
          </div>
          <div class="datetime">${dateTime}</div>
          <div class="footer">
            Keep this ticket.<br/>
            Listen for your number.<br/>
            Thank you for waiting.
          </div>
        </body>
      </html>
    `;
    
    printWindow.document.write(ticketHtml);
    printWindow.document.close();
    
    printWindow.onload = () => {
      printWindow.focus();
      printWindow.print();
      setTimeout(() => {
        printWindow.close();
        setIsPrinting(false);
      }, 500);
    };
  }, [isPrinting, joinResult, location, selectedServiceId]);

  const selectedService = location?.services.find(s => s.id === selectedServiceId);
  const brandColor = location?.organization?.primaryColor || '#0e8f80';
  const terms = termsFor(location?.organization);
  const kiosk = mode === 'kiosk';

  // Live waits per service, so people can pick the shorter line.
  const [waits, setWaits] = useState<Record<string, { waiting: number; minutes: number }>>({});
  useEffect(() => {
    if (!location?.id) return;
    const load = () => fetch(`${API_BASE}/public/queues/${location.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.swimlanes) return;
        const next: Record<string, { waiting: number; minutes: number }> = {};
        for (const lane of d.swimlanes) {
          const last = lane.waitingList?.[lane.waitingList.length - 1]?.estimatedWait;
          next[lane.serviceId] = { waiting: lane.stats?.waiting ?? 0, minutes: last || (lane.estimatedWaitPerPerson || 0) * (lane.stats?.waiting ?? 0) };
        }
        setWaits(next);
      })
      .catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [location?.id]);

  const waitText = (serviceId: string) => {
    const w = waits[serviceId];
    if (!w) return null;
    if (w.waiting === 0) return 'No wait right now';
    return `${w.waiting} waiting${w.minutes ? ` · about ${w.minutes >= 60 ? `${Math.floor(w.minutes / 60)}h ${w.minutes % 60}m` : `${Math.round(w.minutes)} min`}` : ''}`;
  };

  const header = location && (
    <header className={styles.brand}>
      {location.organization.logoUrl
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={location.organization.logoUrl} alt={location.organization.name} />
        : <strong>{location.organization.name}</strong>}
      {location.name !== location.organization.name && <span>{location.name}</span>}
    </header>
  );

  const renderLoading = () => (
    <div className={styles.center}><span className={styles.spinner} aria-label="Loading" /></div>
  );

  const renderError = () => (
    <div className={styles.card}>
      <h1 className={styles.title}>{unavailable ? 'Not taking new tickets' : 'We couldn’t find this queue'}</h1>
      <p className={styles.lede}>
        {unavailable
          ? 'This location isn’t accepting new tickets online right now. Please ask at the desk.'
          : 'The code may be mistyped or no longer in use. Scan the QR code at the entrance again, or ask at the desk.'}
      </p>
    </div>
  );

  const renderServiceSelection = () => (
    <>
      <div className={styles.intro}>
        <h1 className={styles.title}>What are you here for?</h1>
        <p className={styles.lede}>Pick one and you’ll get a ticket on this {kiosk ? 'screen' : 'phone'}. No app or account needed.</p>
      </div>
      {mode === 'session' && sessionEntries.length > 0 && (
        <button type="button" className={styles.linkish} onClick={() => setStep('session-tickets')}>
          You have {sessionEntries.length} {sessionEntries.length === 1 ? 'ticket' : 'tickets'}. See them
        </button>
      )}
      {location && location.services.length === 0 ? (
        <div className={styles.card}><p className={styles.lede}>No services are open here right now. Please ask at the desk.</p></div>
      ) : (
        <ul className={styles.services}>
          {location?.services.map((s) => (
            <li key={s.id}>
              <button type="button" className={styles.service} onClick={() => handleSelectService(s.id)}>
                <span>
                  <strong>{s.name}</strong>
                  {s.description && <small>{s.description}</small>}
                  <em>{waitText(s.id) || `Open ${s.startTime}–${s.endTime}`}</em>
                </span>
                <ChevronRight size={22} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const renderForm = () => {
    const identityFields = getIdentityFields();
    const joinIdentifier = location?.joinIdentifier;
    return (
      <form className={styles.card} onSubmit={(e) => { e.preventDefault(); handleJoinQueue(); }}>
        {location && location.services.length > 1 && (
          <button type="button" className={styles.back} onClick={() => { setStep('select-service'); setError(''); }}>
            <ChevronLeft size={18} /> {selectedService?.name}
          </button>
        )}
        <h1 className={styles.title}>{location && location.services.length > 1 ? 'Your details' : `Join the ${selectedService?.name || ''} queue`}</h1>
        <p className={styles.lede}>So we can call you when it’s your turn.{waitText(selectedServiceId) ? ` ${waitText(selectedServiceId)}.` : ''}</p>
        <div className={styles.fields}>
          {joinIdentifier && (
            <label className={styles.field} htmlFor="field-identifier">
              <span>Your {joinIdentifier.label}</span>
              <input
                id="field-identifier"
                type="text"
                autoComplete="off"
                value={formData.identifier || ''}
                onChange={(e) => setFormData({ ...formData, identifier: e.target.value })}
                required
              />
              <small className={styles.hint}>We check it with our records before giving you a ticket.</small>
            </label>
          )}
          {Object.entries(identityFields).map(([fieldKey, fieldConfig]) => {
            // Kiosks ask only what's needed: names and required fields.
            if (kiosk && !fieldConfig.required && !NAME_FIELDS.includes(fieldKey)) return null;
            // Already asked for above.
            if (joinIdentifier && fieldKey === joinIdentifier.type) return null;
            const id = `field-${fieldKey}`;
            const type = fieldConfig.type === 'tel' || fieldKey === 'phone' ? 'tel'
              : fieldConfig.type === 'email' || fieldKey === 'email' ? 'email'
              : fieldConfig.type === 'date' ? 'date'
              : fieldConfig.type === 'number' ? 'number' : 'text';
            return (
              <label key={fieldKey} className={styles.field} htmlFor={id}>
                <span>{fieldConfig.label}{!fieldConfig.required && !NAME_FIELDS.includes(fieldKey) && <small> (optional)</small>}</span>
                {fieldConfig.type === 'textarea' ? (
                  <textarea id={id} rows={3} value={formData[fieldKey] || ''} onChange={(e) => setFormData({ ...formData, [fieldKey]: e.target.value })} />
                ) : (
                  <input
                    id={id}
                    type={type}
                    inputMode={type === 'tel' ? 'tel' : undefined}
                    autoComplete={fieldKey === 'firstName' ? 'given-name' : fieldKey === 'lastName' ? 'family-name' : fieldKey === 'name' || fieldKey === 'fullName' ? 'name' : type === 'tel' ? 'tel' : type === 'email' ? 'email' : 'off'}
                    value={formData[fieldKey] || ''}
                    onChange={(e) => setFormData({ ...formData, [fieldKey]: e.target.value })}
                    required={fieldConfig.required}
                  />
                )}
                {fieldKey === 'phone' && !kiosk && <small className={styles.hint}>We’ll text you when you’re nearly up.</small>}
              </label>
            );
          })}
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="submit" className={styles.primary} disabled={joining}>
          {joining ? 'Getting your ticket…' : 'Get my ticket'}
        </button>
        <p className={styles.fine}>Your details are only used to call you and are shared with {location?.organization.name}.</p>
      </form>
    );
  };

  const statusUrl = joinResult ? `/status/${joinResult.queueId}/${joinResult.entryId}` : '';

  const renderSuccess = () => (
    <div className={styles.card}>
      <p className={styles.kicker}>You’re in the queue</p>
      <div className={styles.ticket}>
        <span>Your ticket</span>
        <b>{joinResult?.ticketNumber}</b>
        <small>{joinResult?.serviceName}</small>
      </div>
      <dl className={styles.stats}>
        <div><dt>Ahead of you</dt><dd>{Math.max(0, (joinResult?.position ?? 1) - 1)}</dd></div>
        <div><dt>Estimated wait</dt><dd>about {joinResult?.estimatedWait} min</dd></div>
      </dl>
      {kiosk ? (
        <>
          <p className={styles.lede}>Take your printed ticket and have a seat. Watch the screen for your number.</p>
          <button type="button" className={styles.secondary} onClick={handlePrintTicket} disabled={isPrinting}>{isPrinting ? 'Printing…' : 'Print again'}</button>
          <button type="button" className={styles.primary} onClick={resetForNextCustomer}>
            Done{kioskCountdown !== null ? ` (${kioskCountdown})` : ''}
          </button>
        </>
      ) : (
        <>
          <Link className={styles.primary} href={statusUrl}>Follow my place in the queue</Link>
          {mode === 'session' ? (
            <button type="button" className={styles.secondary} onClick={() => { setStep('select-service'); setFormData({}); setJoinResult(null); }}>Get a ticket for another service</button>
          ) : (
            <p className={styles.fine}>Keep this page open, or bookmark it. You can leave the waiting area; we’ll let you know when you’re nearly up.</p>
          )}
        </>
      )}
    </div>
  );

  const renderSessionTickets = () => (
    <div className={styles.card}>
      <h1 className={styles.title}>Your tickets</h1>
      <ul className={styles.tickets}>
        {sessionEntries.map((e) => (
          <li key={e.id}>
            <Link href={`/status/${e.queueId}/${e.id}`}>
              <b>{e.ticketNumber}</b>
              <span>{e.serviceName}<small>{e.status === 'WAITING' ? `#${e.position} in line` : e.status === 'SERVING' ? 'Being called now' : 'Finished'}</small></span>
              <ChevronRight size={18} />
            </Link>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.secondary} onClick={() => setStep('select-service')}>Get another ticket</button>
    </div>
  );

  return (
    <div className={styles.page} data-kiosk={kiosk} style={{ '--brand': brandColor } as React.CSSProperties}>
      <main className={styles.shell}>
        {header}
        {step === 'loading' && renderLoading()}
        {step === 'error' && renderError()}
        {step === 'select-service' && renderServiceSelection()}
        {step === 'form' && renderForm()}
        {step === 'success' && renderSuccess()}
        {step === 'session-tickets' && renderSessionTickets()}
        {!location?.organization?.hidePoweredBy && <p className={styles.powered}>Queue by {APP_NAME}</p>}
      </main>
    </div>
  );
}
