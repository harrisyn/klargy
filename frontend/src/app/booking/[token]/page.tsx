'use client';

import React, { use, useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/apiBase';
import { APP_NAME } from '@/lib/appConfig';
import joinStyles from '@/app/join/[code]/join.module.css';
import SlotPicker, { formatDay, formatTime, type PickableSlot } from '@/components/booking/SlotPicker';
import styles from '@/components/booking/booking.module.css';
import { formatMoney } from '@/components/booking/BookingFlow';

interface Booking {
  status: string;
  startTime: string;
  customerName: string;
  serviceId: string;
  serviceName: string;
  locationName: string;
  locationAddress: string | null;
  timezone: string | null;
  organization: { name: string; logoUrl?: string | null; primaryColor?: string | null; hidePoweredBy?: boolean };
  canChange: boolean;
  canCancel: boolean;
  canCheckIn: boolean;
  statusPath: string | null;
  sessionLabel: string | null;
  roomName: string | null;
  tableNames: string[];
  partySize: number;
  showPartySize: boolean;
  payment: {
    status: 'NONE' | 'PENDING' | 'PAID' | 'PARTIAL_REFUND' | 'REFUNDED' | 'EXPIRED' | 'FAILED';
    currency: string | null;
    total: number | null;
    dueNow: number | null;
    paid: number | null;
    refundCutoffHours: number;
    refundNow: number | null;
    expiresAt: string | null;
    resumeUrl: string | null;
  };
  refunded?: number;
}

const STATUS_TEXT: Record<string, string> = {
  PENDING_PAYMENT: 'Waiting for your payment',
  SCHEDULED: 'Booked',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Missed',
  COMPLETED: 'Completed',
};

/** The customer's own booking page: view it, change the time, cancel, or check in on arrival. */
export default function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const [newSlot, setNewSlot] = useState<PickableSlot | null>(null);

  const call = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(`${API_BASE}/public/booking/${token}${path}`, {
        method: body === undefined && !path ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
      return data;
    },
    [token]
  );

  useEffect(() => {
    call('')
      .then(setBooking)
      .catch((e) => (e.status === 404 ? setMissing(true) : setError(e.message)));
  }, [call]);

  // Just back from the payment page: the card provider confirms to us a moment later.
  const awaitingPayment = booking?.status === 'PENDING_PAYMENT';
  useEffect(() => {
    if (!awaitingPayment) return;
    const t = setInterval(() => call('').then(setBooking).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [awaitingPayment, call]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    const p = booking?.payment;
    // The server works out what comes back under the room's or service's terms.
    const note = p?.status === 'PAID' && p.paid
      ? p.refundNow && p.refundNow > 0
        ? p.refundNow >= p.paid
          ? ` You’ll be refunded ${formatMoney(p.paid, p.currency ?? '')}.`
          : ` You’ll be refunded ${formatMoney(p.refundNow, p.currency ?? '')} of the ${formatMoney(p.paid, p.currency ?? '')} you paid.`
        : ` It’s too close to the time for a refund, so ${formatMoney(p.paid, p.currency ?? '')} won’t come back.`
      : '';
    if (!window.confirm(`Cancel this booking?${note}`)) return;
    run(async () => setBooking(await call('/cancel', {})));
  };
  const reschedule = () =>
    run(async () => {
      if (!newSlot) return;
      setBooking(await call('/reschedule', { slotId: newSlot.id }));
      setChanging(false);
      setNewSlot(null);
    });
  const checkIn = () =>
    run(async () => {
      const r = await call('/check-in', {});
      window.location.assign(r.statusPath);
    });

  const brand = booking?.organization.primaryColor || '#0f9fa4';
  const tz = booking?.timezone ?? null;

  return (
    <div className={joinStyles.page} style={{ '--brand': brand } as React.CSSProperties}>
      <main className={joinStyles.shell}>
        {booking && (
          <header className={joinStyles.brand}>
            {booking.organization.logoUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={booking.organization.logoUrl} alt={booking.organization.name} />
              : <strong>{booking.organization.name}</strong>}
            {booking.locationName !== booking.organization.name && <span>{booking.locationName}</span>}
          </header>
        )}

        {!booking && !missing && !error && <div className={joinStyles.center}><span className={joinStyles.spinner} aria-label="Loading" /></div>}

        {missing && (
          <div className={joinStyles.card}>
            <h1 className={joinStyles.title}>We couldn’t find this booking</h1>
            <p className={joinStyles.lede}>The link may be incomplete. Open it again from your confirmation email or contact the business.</p>
          </div>
        )}

        {booking && (
          <div className={joinStyles.card}>
            <p className={joinStyles.kicker}>{STATUS_TEXT[booking.status] ?? booking.status}</p>
            <div className={styles.summary}>
              <strong>{booking.serviceName}</strong>
              <span>{formatDay(booking.startTime, tz)}</span>
              <span>{formatTime(booking.startTime, tz)}</span>
              <span>{booking.locationName}{booking.locationAddress ? `, ${booking.locationAddress}` : ''}</span>
              <span>For {booking.customerName}{booking.showPartySize ? ` · ${booking.partySize} ${booking.partySize === 1 ? 'person' : 'people'}` : ''}</span>
              {booking.sessionLabel && <span>{booking.sessionLabel}</span>}
              {(booking.roomName || booking.tableNames.length > 0) && (
                <span>{[booking.roomName, booking.tableNames.length ? booking.tableNames.join(', ') : null].filter(Boolean).join(' · ')}</span>
              )}
              {booking.payment.total != null && booking.payment.total > 0 && (
                <span>
                  {formatMoney(booking.payment.total, booking.payment.currency ?? '')}
                  {booking.payment.status === 'PAID' || booking.payment.status === 'PARTIAL_REFUND'
                    ? ` · paid ${formatMoney(booking.payment.paid ?? 0, booking.payment.currency ?? '')}${(booking.payment.paid ?? 0) < booking.payment.total ? `, ${formatMoney(booking.payment.total - (booking.payment.paid ?? 0), booking.payment.currency ?? '')} to pay at the venue` : ''}`
                    : booking.payment.status === 'REFUNDED'
                      ? ' · refunded'
                      : booking.payment.status === 'PENDING'
                        ? ` · ${formatMoney(booking.payment.dueNow ?? 0, booking.payment.currency ?? '')} due now`
                        : ' · pay at the venue'}
                </span>
              )}
            </div>
            {awaitingPayment && <p className={joinStyles.lede}>We’re waiting for your payment to come through. This page updates by itself. If you closed the payment page, your place is held for a few minutes, then released.</p>}
            {booking.refunded ? <p className={joinStyles.lede}>Refunded {formatMoney(booking.refunded, booking.payment.currency ?? '')}. It can take a few days to reach your account.</p> : null}

            {error && <p className={joinStyles.error} role="alert">{error}</p>}

            {changing ? (
              <>
                <h2 className={joinStyles.title} style={{ fontSize: '1.25rem' }}>Choose a new time</h2>
                <SlotPicker serviceId={booking.serviceId} selectedSlotId={newSlot?.id} onPick={(s) => setNewSlot(s)} />
                <div className={styles.actions}>
                  <button type="button" className={joinStyles.primary} disabled={busy || !newSlot} onClick={reschedule}>
                    {busy ? 'Saving…' : newSlot ? `Move to ${formatTime(newSlot.startTime, tz)}` : 'Pick a time'}
                  </button>
                  <button type="button" className={joinStyles.secondary} disabled={busy} onClick={() => { setChanging(false); setNewSlot(null); }}>
                    Keep my current time
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.actions}>
                {awaitingPayment && booking.payment.resumeUrl && (
                  <a className={joinStyles.primary} href={booking.payment.resumeUrl}>Continue to payment</a>
                )}
                {booking.status === 'CHECKED_IN' && booking.statusPath && (
                  <a className={joinStyles.primary} href={booking.statusPath}>Follow my place in line</a>
                )}
                {booking.canCheckIn && (
                  <button type="button" className={joinStyles.primary} disabled={busy} onClick={checkIn}>
                    {busy ? 'Checking in…' : 'I’ve arrived: check me in'}
                  </button>
                )}
                {booking.canChange && (
                  <button type="button" className={joinStyles.secondary} disabled={busy} onClick={() => setChanging(true)}>Change time</button>
                )}
                {booking.canCancel && (
                  <button type="button" className={`${joinStyles.secondary} ${styles.danger}`} disabled={busy} onClick={cancel}>Cancel booking</button>
                )}
              </div>
            )}
            {booking.canCheckIn && !changing && <p className={joinStyles.fine}>Check-in opens on the day of your booking.</p>}
          </div>
        )}

        {!booking?.organization.hidePoweredBy && <p className={joinStyles.powered}>Queue by {APP_NAME}</p>}
      </main>
    </div>
  );
}
