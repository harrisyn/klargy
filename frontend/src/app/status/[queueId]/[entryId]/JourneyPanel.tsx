'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { API_BASE } from '@/lib/apiBase';

/**
 * The patient's visit on their status page: where they were sent next, the
 * stops so far, and "I'm done here" to move themselves on to one of the next
 * steps the clinic's flow offers (or leave).
 */

export interface JourneyStop {
  entryId: string;
  ticketNumber: string;
  serviceName: string;
  status: string;
  joinedAt: string;
  endedAt: string | null;
  current?: boolean;
}

export interface SentTo {
  serviceName: string;
  ticketNumber: string;
  status: string;
  queueId: string;
  entryId: string;
}

interface NextSteps {
  canMoveOn: boolean;
  canLeave: boolean;
  steps: { serviceId: string; name: string; returning: boolean }[];
}

const STATUS_WORD: Record<string, string> = {
  WAITING: 'Waiting',
  SERVING: 'Now',
  SERVED: 'Done',
  CANCELLED: 'Left',
  NO_SHOW: 'Missed',
};

export const statusPath = (queueId: string, entryId: string) => `/status/${queueId}/${entryId}`;

export function SentToCard({ sentTo, brandColor }: { sentTo: SentTo; brandColor: string }) {
  return (
    <section style={card} aria-label="Your next stop">
      <p style={eyebrow}>Sent to</p>
      <p style={sentName}>{sentTo.serviceName}</p>
      <p style={muted}>Your new ticket is <strong style={{ color: '#0d2a47' }}>{sentTo.ticketNumber}</strong>.</p>
      <Link href={statusPath(sentTo.queueId, sentTo.entryId)} style={{ ...primaryButton, background: brandColor }}>
        Follow your new ticket
      </Link>
    </section>
  );
}

export function JourneyTrail({ journey, brandColor }: { journey: JourneyStop[]; brandColor: string }) {
  if (journey.length < 2) return null;
  return (
    <section style={card} aria-labelledby="journey-title">
      <h2 id="journey-title" style={title}>Your visit today</h2>
      <ol style={trail}>
        {journey.map((stop, i) => {
          const done = stop.status === 'SERVED';
          const open = stop.status === 'WAITING' || stop.status === 'SERVING';
          return (
            <li key={stop.entryId} style={trailItem} aria-current={stop.current ? 'step' : undefined}>
              <span
                aria-hidden="true"
                style={{
                  ...dot,
                  background: open ? brandColor : done ? '#10b981' : '#cdd4d0',
                  boxShadow: stop.current ? `0 0 0 4px ${brandColor}26` : 'none',
                }}
              />
              {i < journey.length - 1 && <span aria-hidden="true" style={line} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ ...stopName, fontWeight: stop.current ? 700 : 600 }}>{stop.serviceName}</p>
                <p style={stopMeta}>
                  {stop.ticketNumber} · {new Date(stop.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <span style={{ ...stopStatus, color: open ? brandColor : done ? '#047857' : '#6b7a86' }}>
                {STATUS_WORD[stop.status] ?? stop.status}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** "I'm done here": the next steps from this stop, and leaving. */
export function DoneHere({
  queueId,
  entryId,
  status,
  brandColor,
  onMoved,
  initialOpen = false,
  initialSteps = null,
}: {
  queueId: string;
  entryId: string;
  status: string;
  brandColor: string;
  onMoved: (to: { statusPath: string } | null) => void;
  initialOpen?: boolean;
  /** For previews: skips the request. */
  initialSteps?: NextSteps | null;
}) {
  const [next, setNext] = useState<NextSteps | null>(initialSteps);
  const [open, setOpen] = useState(initialOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialSteps) return;
    let cancelled = false;
    fetch(`${API_BASE}/public/status/${queueId}/${entryId}/next-steps`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setNext(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [queueId, entryId, status, initialSteps]);

  if (!next || (!next.canMoveOn && !next.canLeave)) return null;
  // Waiting patients can only leave; "done here" is for after being seen.
  const label = next.canMoveOn ? 'I’m done here' : 'I’m leaving';

  const go = async (to: string) => {
    setBusy(to);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/public/status/${queueId}/${entryId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That didn’t work. Please ask at the front desk.');
      setOpen(false);
      onMoved(data.entry ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work.');
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <button type="button" style={{ ...outlineButton, borderColor: brandColor, color: brandColor }} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }

  return (
    <section style={card} aria-labelledby="done-here-title">
      <h2 id="done-here-title" style={title}>{next.canMoveOn ? 'Where are you going next?' : 'Leave the queue?'}</h2>
      {next.canMoveOn && next.steps.length > 0 && (
        <p style={muted}>Only pick a step the staff here asked you to go to.</p>
      )}
      <div style={stepList}>
        {next.canMoveOn &&
          next.steps.map((s) => (
            <button key={s.serviceId} type="button" style={stepButton} onClick={() => go(s.serviceId)} disabled={!!busy}>
              <span>
                {s.name}
                {s.returning && <small style={stepNote}>Back to the room that saw you</small>}
              </span>
              <span aria-hidden="true" style={{ color: brandColor }}>{busy === s.serviceId ? '…' : '›'}</span>
            </button>
          ))}
        {next.canLeave && (
          <button type="button" style={{ ...stepButton, color: '#6b7a86' }} onClick={() => go('leave')} disabled={!!busy}>
            <span>I’m leaving{next.canMoveOn ? ' (nothing else today)' : ''}</span>
            <span aria-hidden="true">{busy === 'leave' ? '…' : '›'}</span>
          </button>
        )}
      </div>
      {error && <p role="alert" style={errorText}>{error}</p>}
      <button type="button" style={linkButton} onClick={() => setOpen(false)} disabled={!!busy}>Not yet</button>
    </section>
  );
}

const card: React.CSSProperties = {
  width: '100%',
  maxWidth: '440px',
  background: 'white',
  borderRadius: '1.25rem',
  padding: '1.25rem 1.5rem',
  border: '1px solid #e2e6e3',
  marginTop: '1rem',
  boxSizing: 'border-box',
};
const title: React.CSSProperties = { fontSize: '0.9375rem', fontWeight: 600, color: '#1f2a33', margin: '0 0 0.5rem' };
const eyebrow: React.CSSProperties = { margin: 0, fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#6b7a86' };
const sentName: React.CSSProperties = { margin: '0.25rem 0', fontSize: '1.375rem', fontWeight: 700, color: '#0d2a47' };
const muted: React.CSSProperties = { margin: '0 0 0.75rem', fontSize: '0.875rem', lineHeight: 1.45, color: '#33414c' };
const primaryButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '48px', borderRadius: '14px',
  color: 'white', fontWeight: 600, fontSize: '0.9375rem', textDecoration: 'none',
};
const outlineButton: React.CSSProperties = {
  width: '100%', maxWidth: '440px', minHeight: '48px', marginTop: '1rem', background: 'white', border: '1.5px solid',
  borderRadius: '14px', fontWeight: 600, fontSize: '0.9375rem', cursor: 'pointer',
};
const stepList: React.CSSProperties = { display: 'grid', gap: '0.5rem' };
const stepButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', minHeight: '52px', padding: '0.5rem 1rem',
  background: '#f7f9f8', border: '1px solid #e2e6e3', borderRadius: '12px', color: '#0d2a47', fontWeight: 600,
  fontSize: '0.9375rem', textAlign: 'left', cursor: 'pointer',
};
const stepNote: React.CSSProperties = { display: 'block', fontWeight: 400, fontSize: '0.75rem', color: '#6b7a86' };
const linkButton: React.CSSProperties = { marginTop: '0.75rem', background: 'none', border: 'none', color: '#6b7a86', fontSize: '0.875rem', cursor: 'pointer', padding: 0 };
const errorText: React.CSSProperties = { margin: '0.75rem 0 0', fontSize: '0.875rem', color: '#b42318' };
const trail: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const trailItem: React.CSSProperties = { position: 'relative', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0' };
const dot: React.CSSProperties = { flexShrink: 0, width: '12px', height: '12px', borderRadius: '50%', zIndex: 1 };
const line: React.CSSProperties = { position: 'absolute', left: '5px', top: '50%', height: '100%', width: '2px', background: '#e2e6e3' };
const stopName: React.CSSProperties = { margin: 0, fontSize: '0.9375rem', color: '#1f2a33' };
const stopMeta: React.CSSProperties = { margin: 0, fontSize: '0.75rem', color: '#6b7a86', fontVariantNumeric: 'tabular-nums' };
const stopStatus: React.CSSProperties = { flexShrink: 0, fontSize: '0.8125rem', fontWeight: 600 };
