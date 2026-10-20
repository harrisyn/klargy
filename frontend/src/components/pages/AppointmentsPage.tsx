'use client';

import { useTerms } from '@/hooks/useTerms';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarPlus, Check, Clock, Search, UserPlus } from 'lucide-react';
import api, { Appointment, AvailableSlot, PatientSummary } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import { Badge, Button, EmptyState, Input, Modal, PageHeader, Select, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { apiErrorMessage } from '@/components/auth/AuthShell';
import { confirmDialog } from '@/lib/dialog';
import SeatMap, { SeatMapLegend } from '@/components/rooms/SeatMap';
import { industryFeatures } from '@/lib/terms';
import type { FloorMap } from '@/api/client';

interface LocationOption { id: string; name: string }
interface ServiceOption { id: string; name: string; locationId: string; isActive: boolean }

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATUS: Record<Appointment['status'], { label: string; tone: BadgeTone }> = {
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warning' },
  SCHEDULED: { label: 'Scheduled', tone: 'primary' },
  CONFIRMED: { label: 'Confirmed', tone: 'primary' },
  CHECKED_IN: { label: 'Checked in', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  NO_SHOW: { label: 'No-show', tone: 'warning' },
};

const isActive = (a: Appointment) => a.status === 'SCHEDULED' || a.status === 'CONFIRMED';

/** Loads bookable slots for a service/date and renders them as a picker. */
function SlotPicker({ serviceId, date, value, onChange, excludeSlotId }: {
  serviceId: string;
  date: string;
  value: string;
  onChange: (slotId: string) => void;
  excludeSlotId?: string;
}) {
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serviceId || !date) return;
    let cancelled = false;
    setLoading(true);
    setMessage('');
    api.getAvailableSlots(serviceId, date)
      .then((res) => {
        if (cancelled) return;
        setSlots(res.slots);
        setMessage(res.slots.length === 0 ? res.message || 'No times left on this day.' : '');
      })
      .catch((err) => !cancelled && setMessage(apiErrorMessage(err, 'Could not load times.')))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [serviceId, date]);

  if (!serviceId) return <p className="muted">Choose a service to see available times.</p>;
  if (loading) return <div className="spinner spinner-sm" />;
  if (message) return <p className="muted">{message}</p>;

  return (
    <div className="slot-grid" role="group" aria-label="Available times">
      {slots.map((slot) => (
        <button
          key={slot.id}
          type="button"
          className="slot-option"
          aria-pressed={value === slot.id}
          disabled={slot.available === 0 || slot.id === excludeSlotId}
          onClick={() => onChange(slot.id)}
        >
          {formatTime(slot.startTime)}
          <small>{slot.available === 0 ? 'Full' : `${slot.available} left`}</small>
        </button>
      ))}
    </div>
  );
}

function BookAppointmentModal({ open, onClose, onBooked, locations, services, defaults }: {
  open: boolean;
  onClose: () => void;
  onBooked: (a: Appointment) => void;
  locations: LocationOption[];
  services: ServiceOption[];
  defaults: { locationId: string; date: string };
}) {
  const terms = useTerms();
  const [locationId, setLocationId] = useState(defaults.locationId);
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(defaults.date);
  const [slotId, setSlotId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [newPatient, setNewPatient] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLocationId(defaults.locationId);
    setDate(defaults.date);
    setServiceId(''); setSlotId(''); setQuery(''); setResults([]); setPatient(null);
    setIsNew(false); setNewPatient({ firstName: '', lastName: '', phone: '', email: '' }); setNotes(''); setError('');
    // Reset only when the modal opens, not when the page filters behind it change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (isNew || query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      api.searchPatients(query.trim()).then(setResults).catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, isNew]);

  const locationServices = services.filter((s) => s.locationId === locationId && s.isActive);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!slotId) return setError('Pick a time.');
    if (!isNew && !patient) return setError(`Find the ${terms.person}, or add them as a new ${terms.person}.`);
    if (isNew && (!newPatient.firstName.trim() || !newPatient.lastName.trim())) return setError(`Enter the ${terms.person}’s first and last name.`);
    setSaving(true);
    try {
      const appt = await api.createAppointment({
        serviceId,
        slotId,
        notes: notes || undefined,
        ...(isNew
          ? { patient: { ...newPatient, phone: newPatient.phone || undefined, email: newPatient.email || undefined } }
          : { userId: patient!.id }),
      });
      onBooked(appt);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not book this appointment.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Book appointment"
      maxWidth="600px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="book-appointment" disabled={saving}>{saving ? 'Booking…' : 'Book appointment'}</Button>
        </>
      }
    >
      <form id="book-appointment" className="stack" onSubmit={submit}>
        {error && <div className="inline-alert inline-alert-error" role="alert">{error}</div>}
        <div className="auth-row">
          <Select label="Location" value={locationId} onChange={(e) => { setLocationId(e.target.value); setServiceId(''); setSlotId(''); }}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Service" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSlotId(''); }} required>
            <option value="">Choose a service</option>
            {locationServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <Input label="Date" type="date" min={todayISO()} value={date} onChange={(e) => { setDate(e.target.value); setSlotId(''); }} required />
        <div className="field">
          <span className="field-label">Time</span>
          <SlotPicker serviceId={serviceId} date={date} value={slotId} onChange={setSlotId} />
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="field-label">{terms.Person}</span>
            <Button variant="ghost" size="sm" onClick={() => { setIsNew(!isNew); setPatient(null); }}>
              {isNew ? <><Search size={14} /> Find an existing {terms.person}</> : <><UserPlus size={14} /> New {terms.person}</>}
            </Button>
          </div>
          {isNew ? (
            <div className="stack" style={{ gap: '0.75rem' }}>
              <div className="auth-row">
                <Input label="First name" value={newPatient.firstName} onChange={(e) => setNewPatient({ ...newPatient, firstName: e.target.value })} required />
                <Input label="Last name" value={newPatient.lastName} onChange={(e) => setNewPatient({ ...newPatient, lastName: e.target.value })} required />
              </div>
              <div className="auth-row">
                <Input label="Phone" type="tel" value={newPatient.phone} onChange={(e) => setNewPatient({ ...newPatient, phone: e.target.value })} hint="Used for SMS updates" />
                <Input label="Email" type="email" value={newPatient.email} onChange={(e) => setNewPatient({ ...newPatient, email: e.target.value })} hint="Optional" />
              </div>
            </div>
          ) : patient ? (
            <div className="auth-meta" style={{ marginBottom: 0, justifyContent: 'space-between' }}>
              <span><strong>{patient.firstName} {patient.lastName}</strong>{patient.phone ? ` · ${patient.phone}` : ''}</span>
              <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>Change</Button>
            </div>
          ) : (
            <>
              <input
                type="search"
                placeholder="Search by name, phone or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Search ${terms.people}`}
              />
              {results.length > 0 && (
                <div className="result-list">
                  {results.map((p) => (
                    <button key={p.id} type="button" className="result-item" onClick={() => setPatient(p)}>
                      <span className="cell-strong">{p.firstName} {p.lastName}</span>
                      <span className="muted">{p.phone || p.email || ''}</span>
                    </button>
                  ))}
                </div>
              )}
              {query.trim().length >= 2 && results.length === 0 && (
                <p className="field-hint">No match. Use &ldquo;New {terms.person}&rdquo; to add them.</p>
              )}
            </>
          )}
        </div>

        <Textarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} hint="Optional, visible to staff" />
      </form>
    </Modal>
  );
}

function RescheduleModal({ appointment, onClose, onDone }: {
  appointment: Appointment | null;
  onClose: () => void;
  onDone: (a: Appointment) => void;
}) {
  const [date, setDate] = useState(todayISO());
  const [slotId, setSlotId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!appointment) return;
    const d = new Date(appointment.startTime);
    setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    setSlotId('');
    setError('');
  }, [appointment]);

  if (!appointment) return null;

  const submit = async () => {
    if (!slotId) return setError('Pick a new time.');
    setSaving(true);
    try {
      onDone(await api.rescheduleAppointment(appointment.id, slotId));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not reschedule.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reschedule ${appointment.user.firstName} ${appointment.user.lastName}`}
      maxWidth="560px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Move appointment'}</Button>
        </>
      }
    >
      <div className="stack">
        {error && <div className="inline-alert inline-alert-error" role="alert">{error}</div>}
        <p className="muted" style={{ margin: 0 }}>
          Currently {appointment.service.name}, {new Date(appointment.startTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
        </p>
        <Input label="New date" type="date" min={todayISO()} value={date} onChange={(e) => { setDate(e.target.value); setSlotId(''); }} />
        <SlotPicker serviceId={appointment.serviceId} date={date} value={slotId} onChange={setSlotId} excludeSlotId={appointment.slot?.id} />
      </div>
    </Modal>
  );
}

export default function AppointmentsPage() {
  const { user } = useAuthContext();
  const terms = useTerms();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [locationId, setLocationId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [booking, setBooking] = useState(false);
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Appointment | null>(null);
  const features = industryFeatures(user?.organization?.industry);

  useEffect(() => {
    if (!user?.organizationId) return;
    api.getLocations(user.organizationId).then(async (locs: LocationOption[]) => {
      setLocations(locs);
      if (locs[0]) setLocationId((current) => current || locs[0].id);
      const perLocation = await Promise.all(locs.map((l) => api.getServices(l.id).catch(() => [])));
      setServices(perLocation.flat());
    });
  }, [user?.organizationId]);

  const load = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      setAppointments(await api.getAppointments({ locationId, date, serviceId: serviceId || undefined }));
    } catch (err) {
      setNotice({ tone: 'error', text: apiErrorMessage(err, 'Could not load appointments.') });
    } finally {
      setLoading(false);
    }
  }, [locationId, date, serviceId]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => (statusFilter === 'active' ? appointments.filter((a) => a.status !== 'CANCELLED') : appointments),
    [appointments, statusFilter]
  );
  const isToday = date === todayISO();

  const replace = (a: Appointment) => setAppointments((list) => list.map((x) => (x.id === a.id ? a : x)));

  const checkIn = async (a: Appointment) => {
    setBusyId(a.id);
    try {
      const res = await api.checkInAppointment(a.id);
      replace({ ...a, status: 'CHECKED_IN' });
      setNotice({ tone: 'success', text: `${a.user.firstName} ${a.user.lastName} is checked in with ticket ${res.ticketNumber}.` });
    } catch (err) {
      setNotice({ tone: 'error', text: apiErrorMessage(err, 'Could not check in.') });
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (a: Appointment) => {
    if (!(await confirmDialog({ title: 'Cancel this appointment?', message: `${a.user.firstName} ${a.user.lastName}'s appointment at ${formatTime(a.startTime)} will be cancelled.`, confirmLabel: 'Cancel appointment', cancelLabel: 'Keep it', tone: 'danger' }))) return;
    setBusyId(a.id);
    try {
      replace(await api.cancelAppointment(a.id));
      setNotice({ tone: 'success', text: 'Appointment cancelled. The time is free again.' });
    } catch (err) {
      setNotice({ tone: 'error', text: apiErrorMessage(err, 'Could not cancel.') });
    } finally {
      setBusyId(null);
    }
  };

  const locationServices = services.filter((s) => s.locationId === locationId);

  return (
    <Layout>
      <PageHeader
        icon={CalendarDays}
        title="Appointments"
        subtitle={`Book ${terms.people} into future slots, reschedule, and check them in when they arrive.`}
        actions={
          <Button variant="secondary" onClick={() => setBooking(true)} disabled={!locationId}>
            <CalendarPlus size={18} /> Book appointment
          </Button>
        }
      />

      <div className="toolbar">
        <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Select label="Location" value={locationId} onChange={(e) => { setLocationId(e.target.value); setServiceId(''); }}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">All services</option>
          {locationServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select label="Show" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'active' | 'all')}>
          <option value="active">Hide cancelled</option>
          <option value="all">Everything</option>
        </Select>
      </div>

      {notice && (
        <div className={`inline-alert inline-alert-${notice.tone}`} role="status" style={{ marginBottom: '1rem' }}>
          {notice.tone === 'success' && <Check size={18} />}
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="panel">
        {loading ? (
          <div className="panel-body"><div className="spinner" /></div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No appointments"
            description={isToday ? 'Nothing is booked for today at this location.' : 'Nothing is booked for this day.'}
            action={{ label: 'Book appointment', onClick: () => setBooking(true) }}
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Time</th><th>{terms.Person}</th><th>Service</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.id}>
                    <td className="cell-strong" style={{ whiteSpace: 'nowrap' }}>{formatTime(a.startTime)}</td>
                    <td>
                      <div className="cell-strong">{a.user.firstName} {a.user.lastName}{(a.partySize ?? 1) > 1 ? ` · ${a.partySize} people` : ''}</div>
                      {a.user.phone && <div className="muted">{a.user.phone}</div>}
                      {a.notes && <div className="muted" style={{ fontSize: '0.8125rem' }}>{a.notes}</div>}
                    </td>
                    <td>{a.service.name}</td>
                    <td>
                      <Badge tone={STATUS[a.status]?.tone ?? 'neutral'}>{STATUS[a.status]?.label ?? a.status}</Badge>{a.source === 'ONLINE' && <Badge tone="neutral">Booked online</Badge>}
                      {a.paymentStatus && a.paymentStatus !== 'NONE' && a.amount != null && (
                        <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
                          {a.paymentStatus === 'PAID' || a.paymentStatus === 'PARTIAL_REFUND' ? `Paid ${Number(a.amountPaid ?? 0).toFixed(2)} of ${Number(a.amount).toFixed(2)} ${a.currency ?? ''}` : a.paymentStatus === 'REFUNDED' ? 'Refunded' : a.paymentStatus === 'PENDING' ? 'Payment pending' : `Payment ${a.paymentStatus.toLowerCase()}`}
                        </div>
                      )}
                      {a.tables && a.tables.length > 0 && (
                        <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
                          {a.room ? `${a.room.name}: ` : ''}{a.tables.map((t) => t.table.name).join(', ')}
                        </div>
                      )}
                      {a.rescheduledAt && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>Rescheduled</div>}
                    </td>
                    <td className="cell-actions">
                      {isActive(a) && (
                        <>
                          {isToday && (
                            <Button size="sm" onClick={() => checkIn(a)} disabled={busyId === a.id}>Check in</Button>
                          )}
                          {features.tables && a.room && (
                            <Button size="sm" variant="secondary" onClick={() => setMoving(a)} disabled={busyId === a.id}>{`Change ${features.tableLabel}`}</Button>
                          )}
                          <Button size="sm" variant="secondary" onClick={() => setRescheduling(a)} disabled={busyId === a.id}>Reschedule</Button>
                          <Button size="sm" variant="ghost" onClick={() => cancel(a)} disabled={busyId === a.id}>Cancel</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {moving && (
        <ChangeTablesModal
          appointment={moving}
          label={features.tableLabel}
          onClose={() => setMoving(null)}
          onSaved={() => { setMoving(null); setNotice({ tone: 'success', text: 'Table changed.' }); load(); }}
        />
      )}

      <BookAppointmentModal
        open={booking}
        onClose={() => setBooking(false)}
        locations={locations}
        services={services}
        defaults={{ locationId, date: date < todayISO() ? todayISO() : date }}
        onBooked={(a) => {
          setBooking(false);
          setNotice({ tone: 'success', text: `Booked ${a.user.firstName} ${a.user.lastName} for ${new Date(a.startTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` });
          load();
        }}
      />
      <RescheduleModal
        appointment={rescheduling}
        onClose={() => setRescheduling(null)}
        onDone={(a) => {
          setRescheduling(null);
          setNotice({ tone: 'success', text: `Moved to ${new Date(a.startTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` });
          load();
        }}
      />
    </Layout>
  );
}

/** Move a booking to other tables or seats, picking them on the room's floor plan. */
function ChangeTablesModal({ appointment, label, onClose, onSaved }: { appointment: Appointment; label: string; onClose: () => void; onSaved: () => void }) {
  const [map, setMap] = useState<FloorMap | null>(null);
  const [chosen, setChosen] = useState<string[]>(appointment.tables?.map((t) => t.table.id) ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const party = appointment.partySize ?? 1;

  useEffect(() => {
    if (!appointment.room) return;
    api.getRoomSeatMap(appointment.room.id, { start: appointment.startTime, partySize: party, excludeAppointmentId: appointment.id })
      .then(setMap)
      .catch((e) => setError(apiErrorMessage(e, 'Couldn’t load the floor plan.')));
  }, [appointment, party]);

  const seats = map ? map.tables.filter((t) => chosen.includes(t.id)).reduce((n, t) => n + t.seats, 0) : 0;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      try {
        await api.setAppointmentTables(appointment.id, chosen);
      } catch (err) {
        // A room with a different rate changes the price: say so and let the host decide.
        const change = (err as { response?: { status?: number; data?: { priceChange?: { from: number; to: number; paid: number; refund: number; balance: number } } } }).response;
        if (change?.status !== 409 || !change.data?.priceChange) throw err;
        const c = change.data.priceChange;
        const cur = appointment.currency ?? '';
        const effect = c.refund > 0 ? `${c.refund.toFixed(2)} ${cur} of what they paid will be refunded.` : c.balance > 0 ? `They will owe ${c.balance.toFixed(2)} ${cur} more, to be settled at the venue.` : '';
        const ok = await confirmDialog({ title: 'This changes the price', message: `That room takes the booking from ${c.from.toFixed(2)} to ${c.to.toFixed(2)} ${cur}. ${effect}`.trim(), confirmLabel: 'Move and reprice', cancelLabel: 'Keep it where it is' });
        if (!ok) { setSaving(false); return; }
        await api.setAppointmentTables(appointment.id, chosen, true);
      }
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Couldn’t move them.'));
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${appointment.user.firstName} ${appointment.user.lastName}: ${label}`}
      maxWidth="960px"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving || chosen.length === 0 || seats < party}>{saving ? 'Saving…' : 'Move here'}</Button></>}
    >
      {error && <p role="alert" style={{ color: 'var(--danger, #a3371f)' }}>{error}</p>}
      {map ? (
        <>
          <SeatMap
            layout={{ width: map.room.layoutWidth, height: map.room.layoutHeight, imageUrl: map.room.layoutImageUrl }}
            tables={map.tables}
            selectedIds={chosen}
            onToggle={(id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
          />
          <SeatMapLegend picking />
          <p className="muted">A party of {party}: you have chosen {seats} {seats === 1 ? 'seat' : 'seats'}{seats < party ? ' (choose more)' : ''}.</p>
        </>
      ) : <div className="spinner" />}
    </Modal>
  );
}
