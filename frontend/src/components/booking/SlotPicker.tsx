'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '@/lib/apiBase';
import styles from './booking.module.css';

export interface RoomChoice {
  id: string;
  name: string;
  description: string | null;
  rate: { mode: string; price: number | null; basis: string };
  seats: number;
  hasLayout: boolean;
}

export interface PickableSlot {
  id: string;
  startTime: string;
  endTime: string;
  available: number;
  /** Set on a one-off session (an event, class or tickets). */
  label?: string | null;
  price?: number | null;
}

interface Props {
  serviceId: string;
  selectedSlotId?: string | null;
  onPick: (slot: PickableSlot, timezone: string | null) => void;
  /** Days offered from today; the server enforces its own limit. */
  days?: number;
  /** Only times with at least this many places left (a party size). */
  minAvailable?: number;
  /** Shown beside session prices. */
  currency?: string;
  /** Services with tables: the party and the area, so only times with a table are listed. */
  partySize?: number;
  roomId?: string | null;
  /** The areas the customer can choose between, as the server lists them for this party. */
  onRooms?: (rooms: RoomChoice[]) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const formatTime = (iso: string, timeZone?: string | null) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });

export const formatDay = (iso: string, timeZone?: string | null) =>
  new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(timeZone ? { timeZone } : {}) });

/** Pick a day, then one of its open times. */
export default function SlotPicker({ serviceId, selectedSlotId, onPick, days = 14, minAvailable = 1, currency, partySize, roomId, onRooms }: Props) {
  const dayList = useMemo(() => {
    const out: { iso: string; weekday: string; date: string }[] = [];
    const base = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      out.push({ iso: isoDay(d), weekday: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }), date: d.toLocaleDateString([], { day: 'numeric', month: 'short' }) });
    }
    return out;
  }, [days]);

  const [day, setDay] = useState(dayList[0].iso);
  const [slots, setSlots] = useState<PickableSlot[] | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSlots(null);
    setMessage('');
    fetch(`${API_BASE}/public/booking/services/${serviceId}/slots?date=${day}${partySize ? `&partySize=${partySize}` : ''}${roomId ? `&roomId=${encodeURIComponent(roomId)}` : ''}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Couldn’t load times');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setTimezone(body.timezone ?? null);
        setSlots(body.slots as PickableSlot[]);
        if (Array.isArray(body.rooms)) onRooms?.(body.rooms as RoomChoice[]);
        setMessage(body.message ?? '');
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setSlots([]);
        setMessage(e.message);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, day, partySize, roomId]);

  return (
    <div className={styles.picker}>
      <div className={styles.days} role="tablist" aria-label="Choose a day">
        {dayList.map((d) => (
          <button
            key={d.iso}
            type="button"
            role="tab"
            aria-selected={day === d.iso}
            className={day === d.iso ? styles.dayOn : styles.day}
            onClick={() => setDay(d.iso)}
          >
            <span>{d.weekday}</span>
            <strong>{d.date}</strong>
          </button>
        ))}
      </div>

      {slots === null ? (
        <p className={styles.note}>Loading times…</p>
      ) : slots.filter((s) => s.available >= minAvailable).length === 0 ? (
        <p className={styles.note}>
          {slots.length > 0 && minAvailable > 1 ? `Nothing with room for ${minAvailable} on this day. Try another day, or fewer people.` : message || 'Nothing left on this day. Try another.'}
        </p>
      ) : (
        <div className={styles.slots} role="listbox" aria-label="Available times">
          {slots.filter((s) => s.available >= minAvailable).map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={selectedSlotId === s.id}
              className={selectedSlotId === s.id ? styles.slotOn : styles.slot}
              onClick={() => onPick(s, timezone)}
            >
              {formatTime(s.startTime, timezone)}
              {s.label && <small className={styles.slotLabel}>{s.label}{s.price != null && currency ? ` · ${s.price} ${currency}` : ''}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
