'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import api from '@/api/client';
import type { ServiceSession } from '@/api/client';
import { Button, Input, Select, Checkbox } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';
import type { IndustryFeatures } from '@/lib/terms';

export interface BookingFields {
  bookingUnit: 'BOOKING' | 'PERSON';
  minPartySize: number;
  maxPartySize: number;
  recurringSlots: boolean;
  price: string;
  priceBasis: 'BOOKING' | 'PERSON';
  paymentMode: 'NONE' | 'DEPOSIT' | 'FULL';
  depositPercent: number;
  refundCutoffHours: number;
  refundTiers: { hours: string; percent: string }[];
  tableMode: 'NONE' | 'AUTO';
  roomId: string;
}

export const defaultBookingFields: BookingFields = {
  bookingUnit: 'BOOKING',
  minPartySize: 1,
  maxPartySize: 8,
  recurringSlots: true,
  price: '',
  priceBasis: 'BOOKING',
  paymentMode: 'NONE',
  depositPercent: 30,
  refundCutoffHours: 24,
  refundTiers: [],
  tableMode: 'NONE',
  roomId: '',
};

interface Props {
  value: BookingFields;
  onChange: (next: BookingFields) => void;
  /** Present when editing an existing service: sessions can be added to it. */
  serviceId?: string;
  slotDuration: number;
  currency: string;
  /** What the organization's industry offers: tables and rooms show only where they apply. */
  features: IndustryFeatures;
  /** Rooms at the service's location. */
  rooms: { id: string; name: string }[];
}

const box: React.CSSProperties = { display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' };

/** Seats, price and payment for online booking, plus one-off sessions. */
export default function ServiceBookingFields({ value, onChange, serviceId, slotDuration, currency, features, rooms }: Props) {
  const set = <K extends keyof BookingFields>(k: K, v: BookingFields[K]) => onChange({ ...value, [k]: v });
  const perPerson = value.bookingUnit === 'PERSON';

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div style={box}>
        <Select label="What is booked" value={value.bookingUnit} onChange={(e) => set('bookingUnit', e.target.value as BookingFields['bookingUnit'])} hint={perPerson ? 'Capacity counts people. Customers say how many they are.' : 'Capacity counts bookings.'}>
          <option value="BOOKING">One booking per slot place</option>
          <option value="PERSON">People or seats (tables, tickets)</option>
        </Select>
        {perPerson && (
          <>
            <Input label="Smallest party" type="number" min={1} value={value.minPartySize} onChange={(e) => set('minPartySize', Math.max(1, Number(e.target.value) || 1))} />
            <Input label="Largest party" type="number" min={1} value={value.maxPartySize} onChange={(e) => set('maxPartySize', Math.max(1, Number(e.target.value) || 1))} />
          </>
        )}
      </div>

      <div style={box}>
        <Input label={`Price (${currency})`} type="number" min={0} step="0.01" value={value.price} onChange={(e) => set('price', e.target.value)} placeholder="Free" />
        {perPerson && (
          <Select label="Price is" value={value.priceBasis} onChange={(e) => set('priceBasis', e.target.value as BookingFields['priceBasis'])}>
            <option value="BOOKING">For the whole booking</option>
            <option value="PERSON">Per person</option>
          </Select>
        )}
        <Select label="Customers pay when booking" value={value.paymentMode} onChange={(e) => set('paymentMode', e.target.value as BookingFields['paymentMode'])}>
          <option value="NONE">Nothing, pay at the venue</option>
          <option value="DEPOSIT">A deposit</option>
          <option value="FULL">The full price</option>
        </Select>
        {value.paymentMode === 'DEPOSIT' && (
          <Input label="Deposit (%)" type="number" min={1} max={99} value={value.depositPercent} onChange={(e) => set('depositPercent', Math.min(99, Math.max(1, Number(e.target.value) || 1)))} />
        )}
        {value.paymentMode !== 'NONE' && (
          <Input label="Refund if cancelled at least (hours) before" type="number" min={0} value={value.refundCutoffHours} onChange={(e) => set('refundCutoffHours', Math.max(0, Number(e.target.value) || 0))} hint="Later than that, what was paid is kept." />
        )}
      </div>
      {value.paymentMode !== 'NONE' && (
        <>
          <div>
            <div className="field-label">Refund by notice (optional; replaces the single cutoff above)</div>
            {value.refundTiers.map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 6 }}>
                <Input label="At least (hours)" type="number" min={0} value={t.hours} onChange={(e) => set('refundTiers', value.refundTiers.map((x, j) => (j === i ? { ...x, hours: e.target.value } : x)))} />
                <Input label="Refund (%)" type="number" min={0} max={100} value={t.percent} onChange={(e) => set('refundTiers', value.refundTiers.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
                <Button type="button" variant="ghost" size="sm" onClick={() => set('refundTiers', value.refundTiers.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => set('refundTiers', [...value.refundTiers, { hours: '', percent: '' }])}>Add a notice step</Button>
            {value.refundTiers.length > 0 && <p className="field-hint" style={{ marginTop: 6 }}>For example 48 hours: 100%, 24 hours: 50%. Cancelling later than every step refunds nothing.</p>}
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            Set up how you get paid under Payments. Until you do, customers can’t book this service online. A room can have its own payment and refund terms.
          </p>
        </>
      )}

      {features.tables && perPerson && (
        <Checkbox
          checked={value.tableMode === 'AUTO'}
          onChange={(e) => set('tableMode', e.target.checked ? 'AUTO' : 'NONE')}
          label={`Give each booking ${features.tableLabel === 'seat' ? 'seats' : `a ${features.tableLabel}`}: automatically, or the ${features.tablesLabel} the customer picks on the floor plan (set up under Rooms)`}
        />
      )}
      {features.rooms && rooms.length > 0 && value.tableMode !== 'AUTO' && (
        <Select label={`Delivered in a ${features.roomLabel}`} value={value.roomId} onChange={(e) => set('roomId', e.target.value)} hint={`Its rules and rates apply (hours, who can book, price, refunds).`}>
          <option value="">Not tied to a {features.roomLabel}</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
      )}

      <Checkbox
        checked={!value.recurringSlots}
        onChange={(e) => set('recurringSlots', !e.target.checked)}
        label="Only bookable at sessions I create (an event, class or ticketed night) instead of every day’s opening hours"
      />

      {serviceId ? (
        <SessionsPanel serviceId={serviceId} slotDuration={slotDuration} currency={currency} />
      ) : (
        <p className="field-hint" style={{ margin: 0 }}>Save the service first, then add one-off sessions from its edit form.</p>
      )}
    </div>
  );
}

function SessionsPanel({ serviceId, slotDuration, currency }: { serviceId: string; slotDuration: number; currency: string }) {
  const [sessions, setSessions] = useState<ServiceSession[]>([]);
  const [form, setForm] = useState({ date: '', startTime: '19:00', durationMinutes: String(slotDuration), capacity: '20', price: '', label: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => api.getServiceSessions(serviceId).then(setSessions).catch(() => setSessions([])), [serviceId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setSaving(true);
    try {
      await api.createServiceSession(serviceId, {
        date: form.date,
        startTime: form.startTime,
        durationMinutes: Number(form.durationMinutes) || undefined,
        capacity: Number(form.capacity),
        price: form.price === '' ? null : Number(form.price),
        label: form.label,
      });
      setForm({ ...form, date: '', label: '' });
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t add the session.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteServiceSession(serviceId, id);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t remove the session.'));
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--gray-200)', paddingTop: '1rem' }}>
      <strong style={{ fontSize: '0.9375rem' }}>One-off sessions</strong>
      <p className="field-hint" style={{ margin: '0.25rem 0 0.75rem' }}>An event, class or tasting with its own date, seats and price. They appear on the booking page beside the regular times.</p>
      <div style={box}>
        <Input label="Name (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Chef’s table night" />
        <Input label="Date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <Input label="Starts" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        <Input label="Minutes" type="number" min={1} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />
        <Input label="Seats or places" type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <Input label={`Price (${currency})`} type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="Service price" />
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        <Button type="button" variant="secondary" size="sm" onClick={add} disabled={saving || !form.date || !form.capacity}>{saving ? 'Adding…' : 'Add session'}</Button>
      </div>
      {sessions.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '1rem 0 0', padding: 0, display: 'grid', gap: '0.5rem' }}>
          {sessions.map((s) => (
            <li key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--gray-50)', borderRadius: 8, fontSize: '0.875rem' }}>
              <span>
                <strong>{s.label || 'Session'}</strong> · {new Date(s.startTime).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {s.booked}/{s.capacity} booked
                {s.price != null ? ` · ${s.price} ${currency}` : ''}
              </span>
              <button type="button" aria-label="Remove session" onClick={() => remove(s.id)} disabled={s.booked > 0} title={s.booked > 0 ? 'Has bookings' : 'Remove'} style={{ border: 0, background: 'none', cursor: s.booked > 0 ? 'not-allowed' : 'pointer', opacity: s.booked > 0 ? 0.4 : 1 }}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
