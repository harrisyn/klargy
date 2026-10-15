'use client';

import React, { useEffect } from 'react';
import { BellRing, Check, ChevronRight, Loader2, Megaphone, UserX } from 'lucide-react';
import type { Desk } from './useDesk';
import { minutesAgo, personName } from './useDesk';
import PatientCard from './PatientCard';

/**
 * The part of the desk you need while doing something else: who you're
 * serving and the next action. Fits a 320px pop-out window.
 */
export default function DeskPanel({
  desk,
  compact = false,
  onDetails,
  patientCard = !compact,
}: {
  desk: Desk;
  compact?: boolean;
  onDetails?: () => void;
  /** The connected EMR's record for the person being served (when there is one). */
  patientCard?: boolean;
}) {
  const { current, waiting, busy, error, notice, afterComplete, terms } = desk;
  const next = waiting[0];

  return (
    <div className="desk-panel" data-compact={compact}>
      {current ? (
        <section className="desk-current" aria-label="Now serving">
          <div className="desk-current-top">
            <span className="desk-ticket">{current.ticketNumber}</span>
            <div className="desk-who">
              <strong>{personName(current) || `${terms.Person} ${current.ticketNumber}`}</strong>
              <small>Waited {minutesAgo(current.joinedAt) - minutesAgo(current.calledAt)} min · called {minutesAgo(current.calledAt)} min ago</small>
            </div>
          </div>
          <div className="desk-actions">
            <button type="button" className="desk-btn desk-btn-primary" onClick={desk.complete} disabled={!!busy}>
              {busy === 'complete' ? <Loader2 size={17} className="qf-spin" /> : <Check size={17} />} Done
              {!compact && <kbd>D</kbd>}
            </button>
            <button type="button" className="desk-btn" onClick={desk.recall} disabled={!!busy} title="Show and announce the ticket again">
              <Megaphone size={16} /> Call again{!compact && <kbd>A</kbd>}
            </button>
            <button type="button" className="desk-btn desk-btn-quiet" onClick={desk.noShow} disabled={!!busy} title="They didn’t come to the desk">
              <UserX size={16} /> Not here
            </button>
            {onDetails && !compact && (
              <button type="button" className="desk-btn desk-btn-quiet" onClick={onDetails}>Details</button>
            )}
          </div>
          {patientCard && <PatientCard key={current.id} entryId={current.id} />}
        </section>
      ) : afterComplete ? (
        <section className="desk-after" aria-label="Send on">
          <p>Send {personName(afterComplete.entry) || afterComplete.entry.ticketNumber} on to another service?</p>
          <div className="desk-after-options">
            {afterComplete.nextServices.map((s) => (
              <button key={s.serviceId} type="button" className="desk-btn" onClick={() => desk.sendTo(s)} disabled={!!busy}>
                {s.displayName}{s.isRequired && <em>usual next</em>} <ChevronRight size={15} />
              </button>
            ))}
            <button type="button" className="desk-btn desk-btn-quiet" onClick={desk.dismissAfterComplete}>No, they’re finished</button>
          </div>
        </section>
      ) : (
        <section className="desk-idle">
          <p>{waiting.length === 0 ? `Nobody is waiting. You’ll get an alert when a ${terms.person} joins.` : `You’re free.`}</p>
        </section>
      )}

      <button
        type="button"
        className="desk-call"
        onClick={() => desk.callNext()}
        disabled={!!busy || waiting.length === 0}
      >
        {busy === 'call' ? <Loader2 size={20} className="qf-spin" /> : <BellRing size={20} />}
        <span>
          {waiting.length === 0 ? 'Nobody to call' : `Call next${next ? ` · ${next.ticketNumber}` : ''}`}
          <small>{waiting.length} waiting</small>
        </span>
        {!compact && waiting.length > 0 && <kbd>N</kbd>}
      </button>

      {(error || notice) && (
        <p className={error ? 'desk-msg desk-msg-bad' : 'desk-msg'} role={error ? 'alert' : 'status'}>{error || notice}</p>
      )}
    </div>
  );
}

/** N = call next, D = done, A = call again. Ignored while typing. */
export function useDeskShortcuts(desk: Desk, target: Document | null | undefined) {
  useEffect(() => {
    const doc = target || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const key = e.key.toLowerCase();
      if (key === 'n' && !desk.busy && desk.waiting.length > 0) { e.preventDefault(); desk.callNext(); }
      if (key === 'd' && !desk.busy && desk.current) { e.preventDefault(); desk.complete(); }
      if (key === 'a' && !desk.busy && desk.current) { e.preventDefault(); desk.recall(); }
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [desk, target]);
}
