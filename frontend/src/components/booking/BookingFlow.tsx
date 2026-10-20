'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, Minus, Plus } from 'lucide-react';
import { API_BASE } from '@/lib/apiBase';
import joinStyles from '@/app/join/[code]/join.module.css';
import SlotPicker, { formatDay, formatTime, type PickableSlot, type RoomChoice } from './SlotPicker';
import SeatMap, { SeatMapLegend, type MapTable } from '@/components/rooms/SeatMap';
import styles from './booking.module.css';

export interface BookableService {
  id: string;
  name: string;
  description?: string;
  slotDuration: number;
  bookingUnit?: 'BOOKING' | 'PERSON';
  tableMode?: 'NONE' | 'AUTO';
  minPartySize?: number;
  maxPartySize?: number;
  price?: string | number | null;
  priceBasis?: 'BOOKING' | 'PERSON';
  paymentMode?: 'NONE' | 'DEPOSIT' | 'FULL';
  depositPercent?: number;
}

interface Props {
  service: BookableService;
  orgName: string;
  currency: string;
  /** Called when the customer wants to choose a different service. */
  onBack?: () => void;
}

const TOKENS_KEY = 'qms_my_bookings';

/** Remembers bookings made on this device so people can find them again. */
function rememberBooking(token: string) {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(TOKENS_KEY) || '[]');
    localStorage.setItem(TOKENS_KEY, JSON.stringify([token, ...list.filter((t) => t !== token)].slice(0, 10)));
  } catch {
    /* storage unavailable: the emailed/on-screen link still works */
  }
}

export const formatMoney = (amount: number, currency: string) =>
  `${amount.toLocaleString(undefined, { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })} ${currency}`;

interface Quote {
  total: number;
  dueNow: number;
  roomName: string | null;
}

interface SeatMapData {
  room: { id: string; name: string; layoutWidth: number; layoutHeight: number; layoutImageUrl: string | null };
  tables: MapTable[];
}

const rateLabel = (r: RoomChoice, currency: string) =>
  r.rate.mode === 'INHERIT' || r.rate.price == null
    ? null
    : `${r.rate.mode === 'SURCHARGE' ? '+' : ''}${formatMoney(r.rate.price, currency)} ${r.rate.basis === 'PERSON' ? 'per person' : 'per booking'}${r.rate.mode === 'OVERRIDE' ? '' : ''}`;

/** Choose a time (and party size and where to sit), give contact details, pay if needed, get a private link to manage the booking. */
export default function BookingFlow({ service, orgName, currency, onBack }: Props) {
  const seats = service.bookingUnit === 'PERSON';
  const hasTables = service.tableMode === 'AUTO';
  const min = service.minPartySize ?? 1;
  const max = service.maxPartySize ?? 8;
  const [partySize, setPartySize] = useState(Math.min(max, Math.max(min, 2 >= min ? Math.min(2, max) : min)));
  const [rooms, setRooms] = useState<RoomChoice[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [slot, setSlot] = useState<PickableSlot | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [picking, setPicking] = useState(false);
  const [map, setMap] = useState<SeatMapData | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ token: string; startTime: string; place: string } | null>(null);

  const people = seats ? partySize : 1;
  const dueNow = quote?.dueNow ?? 0;
  const payingNow = dueNow > 0;

  // With one area to choose from there is nothing to choose.
  useEffect(() => {
    if (hasTables && rooms.length === 1 && roomId !== rooms[0].id) setRoomId(rooms[0].id);
    if (roomId && rooms.length > 0 && !rooms.some((r) => r.id === roomId)) setRoomId(null);
  }, [rooms, roomId, hasTables]);

  // What it costs, from the server so rooms' rates and terms are applied the same way as at booking.
  useEffect(() => {
    if (!slot) return setQuote(null);
    let cancelled = false;
    const q = new URLSearchParams({ slotId: slot.id, partySize: String(people), ...(roomId ? { roomId } : {}) });
    fetch(`${API_BASE}/public/booking/services/${service.id}/quote?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => !cancelled && setQuote(b))
      .catch(() => !cancelled && setQuote(null));
    return () => { cancelled = true; };
  }, [slot, people, roomId, service.id]);

  // The floor plan, when the customer wants to pick their own table or seats.
  useEffect(() => {
    if (!picking || !slot || !roomId) return setMap(null);
    let cancelled = false;
    const q = new URLSearchParams({ slotId: slot.id, roomId, partySize: String(people) });
    fetch(`${API_BASE}/public/booking/services/${service.id}/seats?${q}`)
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.error || 'Couldn’t load the floor plan');
        return b as SeatMapData;
      })
      .then((m) => !cancelled && setMap(m))
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setPicking(false); } });
    return () => { cancelled = true; };
  }, [picking, slot, roomId, people, service.id]);

  const chosenSeats = map ? map.tables.filter((t) => chosen.includes(t.id)).reduce((n, t) => n + t.seats, 0) : 0;
  const pickIncomplete = picking && chosen.length > 0 && chosenSeats < people;

  const toggleTable = (id: string) => {
    setError('');
    setChosen((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  };

  const resetChoice = () => {
    setSlot(null);
    setChosen([]);
    setPicking(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot) return setError('Choose a time first.');
    if (pickIncomplete) return setError(`Your choice seats ${chosenSeats}; choose more for ${people}, or let us assign you.`);
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/public/booking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: service.id,
          slotId: slot.id,
          ...form,
          ...(seats ? { partySize } : {}),
          ...(hasTables && roomId ? { roomId } : {}),
          ...(hasTables && picking && chosen.length ? { tableIds: chosen } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'We couldn’t make that booking. Please try again.');
      rememberBooking(body.manageToken);
      if (body.checkoutUrl) {
        // Off to the payment page; it brings them back to their booking.
        window.location.assign(body.checkoutUrl);
        return;
      }
      setDone({
        token: body.manageToken,
        startTime: body.booking?.startTime ?? slot.startTime,
        place: [body.booking?.roomName, body.booking?.tableNames?.length ? body.booking.tableNames.join(', ') : null].filter(Boolean).join(' · '),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We couldn’t make that booking. Please try again.');
      setSubmitting(false);
      // Someone may have taken the table in the meantime: show the plan as it is now.
      if (picking) setChosen([]);
    }
  };

  if (done) {
    return (
      <div className={joinStyles.card}>
        <p className={joinStyles.kicker}>You’re booked</p>
        <div className={styles.summary}>
          <strong>{service.name}</strong>
          <span>{formatDay(done.startTime, timezone)}</span>
          <span>{formatTime(done.startTime, timezone)}</span>
          {seats && <span>{people} {people === 1 ? 'person' : 'people'}</span>}
          {done.place && <span>{done.place}</span>}
        </div>
        <p className={joinStyles.lede}>
          Arrive a few minutes early and check in from your booking page. {form.email ? 'We’ve emailed you this link too.' : 'Save the link below: it’s how you change or cancel.'}
        </p>
        <Link className={joinStyles.primary} href={`/booking/${done.token}`}>View, change or cancel my booking</Link>
        <p className={joinStyles.fine}>Bookmark the next page. Anyone with the link can manage this booking.</p>
      </div>
    );
  }

  return (
    <form className={joinStyles.card} onSubmit={submit}>
      {onBack && (
        <button type="button" className={joinStyles.back} onClick={onBack}>
          <ChevronLeft size={18} /> {service.name}
        </button>
      )}
      <h1 className={joinStyles.title}>Book {service.name}</h1>
      <p className={joinStyles.lede}>Pick a time that suits you. About {service.slotDuration} minutes.</p>

      {seats && (
        <div className={styles.party}>
          <span id="party-label">How many people?</span>
          <div className={styles.stepper} role="group" aria-labelledby="party-label">
            <button type="button" aria-label="One fewer" disabled={partySize <= min} onClick={() => { setPartySize(partySize - 1); resetChoice(); }}><Minus size={18} /></button>
            <output aria-live="polite">{partySize}</output>
            <button type="button" aria-label="One more" disabled={partySize >= max} onClick={() => { setPartySize(partySize + 1); resetChoice(); }}><Plus size={18} /></button>
          </div>
        </div>
      )}

      {hasTables && rooms.length > 1 && (
        <fieldset className={styles.areas}>
          <legend>Where would you like to sit?</legend>
          <label className={roomId === null ? styles.areaOn : styles.area}>
            <input type="radio" name="area" checked={roomId === null} onChange={() => { setRoomId(null); resetChoice(); }} />
            <span><strong>Anywhere</strong><small>Whatever suits you best</small></span>
          </label>
          {rooms.map((r) => (
            <label key={r.id} className={roomId === r.id ? styles.areaOn : styles.area}>
              <input type="radio" name="area" checked={roomId === r.id} onChange={() => { setRoomId(r.id); resetChoice(); }} />
              <span>
                <strong>{r.name}</strong>
                {r.description && <small>{r.description}</small>}
                {rateLabel(r, currency) && <small className={styles.rate}>{rateLabel(r, currency)}</small>}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <SlotPicker
        serviceId={service.id}
        selectedSlotId={slot?.id}
        minAvailable={people}
        partySize={hasTables ? people : undefined}
        roomId={hasTables ? roomId : null}
        currency={currency}
        onRooms={setRooms}
        onPick={(s, tz) => {
          setSlot(s);
          setTimezone(tz);
          setChosen([]);
          setPicking(false);
          setError('');
        }}
      />

      {slot && (
        <>
          <div className={styles.summary} aria-live="polite">
            <strong>{slot.label || formatDay(slot.startTime, timezone)}</strong>
            {slot.label && <span>{formatDay(slot.startTime, timezone)}</span>}
            <span>{formatTime(slot.startTime, timezone)}{seats ? ` · ${people} ${people === 1 ? 'person' : 'people'}` : ''}{quote?.roomName ? ` · ${quote.roomName}` : ''}</span>
            {quote && quote.total > 0 && (
              <span>
                <b>{formatMoney(quote.total, currency)}</b>
                {payingNow && quote.dueNow < quote.total ? ` · pay ${formatMoney(quote.dueNow, currency)} now, the rest at the venue` : payingNow ? ' · paid now' : ' · pay at the venue'}
              </span>
            )}
          </div>

          {hasTables && roomId && (
            <div className={styles.seatChoice}>
              {!picking ? (
                <>
                  <p className={joinStyles.fine} style={{ textAlign: 'left' }}>We’ll give you the best {people > 1 ? 'seats' : 'seat'} free. Or choose your own on the floor plan.</p>
                  <button type="button" className={joinStyles.secondary} onClick={() => setPicking(true)}>Choose my {people > 1 ? 'seats' : 'seat'}</button>
                </>
              ) : (
                <>
                  <strong>Tap {people > 1 ? 'tables or seats' : 'a table or seat'} for {people}</strong>
                  {map ? (
                    <>
                      <SeatMap layout={{ width: map.room.layoutWidth, height: map.room.layoutHeight, imageUrl: map.room.layoutImageUrl }} tables={map.tables} selectedIds={chosen} onToggle={toggleTable} />
                      <SeatMapLegend picking />
                    </>
                  ) : <p className={styles.note}>Loading the floor plan…</p>}
                  <p className={pickIncomplete ? joinStyles.error : joinStyles.fine} style={{ textAlign: 'left' }}>
                    {chosen.length === 0 ? 'Nothing chosen yet: we’ll assign you.' : `You’ve chosen ${chosenSeats} ${chosenSeats === 1 ? 'seat' : 'seats'} for ${people}.`}
                  </p>
                  <button type="button" className={joinStyles.secondary} onClick={() => { setPicking(false); setChosen([]); }}>Assign me automatically instead</button>
                </>
              )}
            </div>
          )}

          <div className={joinStyles.fields}>
            <label className={joinStyles.field} htmlFor="bk-name">
              <span>Your name</span>
              <input id="bk-name" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className={joinStyles.field} htmlFor="bk-phone">
              <span>Phone number <small>(phone or email)</small></span>
              <input id="bk-phone" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <label className={joinStyles.field} htmlFor="bk-email">
              <span>Email <small>({payingNow ? 'needed for your receipt' : 'we’ll send a confirmation'})</small></span>
              <input id="bk-email" type="email" autoComplete="email" required={payingNow} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label className={joinStyles.field} htmlFor="bk-notes">
              <span>Anything we should know? <small>(optional)</small></span>
              <textarea id="bk-notes" rows={2} maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
          </div>
          {error && <p className={joinStyles.error} role="alert">{error}</p>}
          <button type="submit" className={joinStyles.primary} disabled={submitting || pickIncomplete || (!form.phone.trim() && !form.email.trim()) || (payingNow && !form.email.trim())}>
            {submitting ? (payingNow ? 'Taking you to payment…' : 'Booking…') : payingNow ? `Pay ${formatMoney(dueNow, currency)} and confirm` : 'Confirm booking'}
          </button>
          {payingNow && <p className={joinStyles.fine}>We hold your place for 10 minutes while you pay. Payments are handled securely by the card provider.</p>}
          <p className={joinStyles.fine}>Your details are only used for this booking and are shared with {orgName}.</p>
        </>
      )}
      {!slot && error && <p className={joinStyles.error} role="alert">{error}</p>}
    </form>
  );
}
