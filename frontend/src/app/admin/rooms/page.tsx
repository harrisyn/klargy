'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { DoorOpen, LayoutDashboard, Monitor, Pencil, Plus, Trash2, CalendarClock } from 'lucide-react';
import api from '@/api/client';
import type { FloorMap, RoomRow, RoomTableRow } from '@/api/client';
import Layout from '@/components/Layout';
import { useAuthContext } from '@/contexts/AuthContext';
import { Badge, Button, Card, Checkbox, EmptyState, Input, Modal, PageHeader, Select, Textarea } from '@/components/ui';
import FloorPlanDesigner from '@/components/rooms/FloorPlanDesigner';
import SeatMap, { SeatMapLegend } from '@/components/rooms/SeatMap';
import { industryFeatures } from '@/lib/terms';
import { confirmDialog } from '@/lib/dialog';
import { toast, errorMessage } from '@/lib/toast';
import type { Location } from '@/types';

type ListedRoom = RoomRow & { seats: number; _count: { tables: number; instances: number; services: number } };

interface Form {
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  onlineBookable: boolean;
  allowCombine: boolean;
  minPartySize: string;
  maxPartySize: string;
  openTime: string;
  closeTime: string;
  days: number[];
  priceMode: 'INHERIT' | 'OVERRIDE' | 'SURCHARGE';
  price: string;
  priceBasis: 'BOOKING' | 'PERSON';
  paymentMode: '' | 'NONE' | 'DEPOSIT' | 'FULL';
  depositPercent: string;
  refundCutoffHours: string;
  tiers: { hours: string; percent: string }[];
}

const EMPTY: Form = {
  name: '', description: '', sortOrder: 0, isActive: true, onlineBookable: true, allowCombine: true, minPartySize: '', maxPartySize: '', openTime: '', closeTime: '', days: [],
  priceMode: 'INHERIT', price: '', priceBasis: 'BOOKING', paymentMode: '', depositPercent: '', refundCutoffHours: '', tiers: [],
};

const DAYS = [{ n: 1, l: 'Mon' }, { n: 2, l: 'Tue' }, { n: 3, l: 'Wed' }, { n: 4, l: 'Thu' }, { n: 5, l: 'Fri' }, { n: 6, l: 'Sat' }, { n: 0, l: 'Sun' }];

const fromRoom = (r: RoomRow): Form => ({
  name: r.name, description: r.description ?? '', sortOrder: r.sortOrder, isActive: r.isActive, onlineBookable: r.onlineBookable, allowCombine: r.allowCombine,
  minPartySize: r.minPartySize == null ? '' : String(r.minPartySize), maxPartySize: r.maxPartySize == null ? '' : String(r.maxPartySize),
  openTime: r.openTime ?? '', closeTime: r.closeTime ?? '', days: r.activeDays ? r.activeDays.split(',').map(Number) : [],
  priceMode: r.priceMode, price: r.price == null ? '' : String(r.price), priceBasis: r.priceBasis, paymentMode: r.paymentMode ?? '',
  depositPercent: r.depositPercent == null ? '' : String(r.depositPercent), refundCutoffHours: r.refundCutoffHours == null ? '' : String(r.refundCutoffHours),
  tiers: (r.refundTiers ?? []).map((t) => ({ hours: String(t.hours), percent: String(t.percent) })),
});

const toBody = (f: Form) => ({
  name: f.name.trim(), description: f.description, sortOrder: f.sortOrder, isActive: f.isActive, onlineBookable: f.onlineBookable, allowCombine: f.allowCombine,
  minPartySize: f.minPartySize, maxPartySize: f.maxPartySize, openTime: f.openTime, closeTime: f.closeTime, activeDays: [...f.days].sort().join(','),
  priceMode: f.priceMode, price: f.priceMode === 'INHERIT' ? null : f.price, priceBasis: f.priceBasis, paymentMode: f.paymentMode || null,
  depositPercent: f.depositPercent, refundCutoffHours: f.refundCutoffHours,
  refundTiers: f.tiers.filter((t) => t.hours !== '' && t.percent !== '').map((t) => ({ hours: Number(t.hours), percent: Number(t.percent) })),
});

const rateText = (r: RoomRow, currency?: string) =>
  r.priceMode === 'INHERIT' || r.price == null
    ? 'Service price'
    : `${r.priceMode === 'SURCHARGE' ? '+' : ''}${r.price}${currency ? ` ${currency}` : ''} ${r.priceBasis === 'PERSON' ? 'per person' : 'per booking'}${r.priceMode === 'OVERRIDE' ? ' (replaces the service price)' : ''}`;

export default function RoomsPage() {
  const { user } = useAuthContext();
  const features = industryFeatures(user?.organization?.industry);
  const currency = user?.organization?.currency;
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [rooms, setRooms] = useState<ListedRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [designing, setDesigning] = useState<{ room: RoomRow; tables: RoomTableRow[] } | null>(null);
  const [deskRoom, setDeskRoom] = useState<ListedRoom | null>(null);
  const [floorRoom, setFloorRoom] = useState<ListedRoom | null>(null);

  useEffect(() => {
    if (!user?.organizationId) return setLoading(false);
    api.getLocations(user.organizationId).then((l: Location[]) => {
      setLocations(l);
      if (l[0]) setLocationId(l[0].id);
      else setLoading(false);
    }).catch(() => setLoading(false));
  }, [user?.organizationId]);

  const load = useCallback(async () => {
    if (!locationId) return;
    try {
      setRooms((await api.listRooms(locationId)).rooms as ListedRoom[]);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t load the rooms.'));
    } finally {
      setLoading(false);
    }
  }, [locationId]);
  useEffect(() => { load(); }, [load]);

  if (user && !features.rooms) {
    return (
      <Layout>
        <PageHeader title="Rooms" />
        <EmptyState icon={DoorOpen} title="Rooms aren’t part of your setup" description="Rooms are offered for the kinds of business that use them." />
      </Layout>
    );
  }

  const openEditor = (r: ListedRoom | null) => {
    setForm(r ? fromRoom(r) : { ...EMPTY, sortOrder: rooms.length });
    setEditing({ id: r?.id ?? null });
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editing?.id) await api.updateRoom(editing.id, toBody(form) as never);
      else await api.createRoom({ ...toBody(form), locationId, name: form.name.trim() } as never);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save the room.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: ListedRoom) => {
    if (!(await confirmDialog({ title: `Delete ${r.name}?`, message: `Its ${features.tables ? `${features.tablesLabel}, ` : ''}desks and services stay, but leave the room and lose its rules and rates.`, tone: 'danger' }))) return;
    try {
      await api.deleteRoom(r.id);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t delete the room.'));
    }
  };

  const openDesigner = async (r: ListedRoom) => {
    try {
      const d = await api.getRoom(r.id);
      setDesigning({ room: d.room, tables: d.tables });
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t open the floor plan.'));
    }
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const Tables = features.tablesLabel[0].toUpperCase() + features.tablesLabel.slice(1);

  return (
    <Layout>
      <PageHeader
        title="Rooms"
        subtitle={features.tables ? `Rooms hold ${features.tablesLabel} and desks, and can have their own rules and rates. Lay each one out as a floor plan.` : 'Group desks into rooms, with their own rules and rates.'}
        actions={<Button variant="primary" onClick={() => openEditor(null)} disabled={!locationId}><Plus size={16} /> New room</Button>}
      />

      {locations.length > 1 && (
        <div style={{ maxWidth: 320, marginBottom: '1rem' }}>
          <Select label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner" /></div>
      ) : rooms.length === 0 ? (
        <EmptyState icon={DoorOpen} title="No rooms yet" description={features.tables ? `Add a room, then set its rules and rates and place its ${features.tablesLabel}.` : 'Add a room, then set its rules and rates and put desks in it.'} action={{ label: 'New room', onClick: () => openEditor(null) }} />
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {rooms.map((r) => (
            <Card key={r.id} style={{ padding: '1rem', display: 'grid', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'start' }}>
                <div>
                  <strong style={{ fontSize: '1.0625rem' }}>{r.name}</strong>
                  {r.description && <div style={{ fontSize: '0.8125rem', color: 'var(--gray-600)' }}>{r.description}</div>}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {!r.isActive && <Badge tone="neutral">Closed</Badge>}
                  <Badge tone={r.onlineBookable ? 'success' : 'warning'}>{r.onlineBookable ? 'Bookable online' : 'Staff only'}</Badge>
                </div>
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--gray-700)', display: 'grid', gap: 2 }}>
                <span>Rate: {rateText(r, currency)}</span>
                {(r.minPartySize || r.maxPartySize) && <span>Parties of {r.minPartySize ?? 1} to {r.maxPartySize ?? 'any'}</span>}
                {r.openTime && r.closeTime && <span>Bookable {r.openTime} to {r.closeTime}</span>}
                <span>
                  {features.tables && `${r._count.tables} ${features.tablesLabel} · ${r.seats} seats · `}
                  {r._count.instances} desk{r._count.instances === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" onClick={() => openEditor(r)}><Pencil size={13} /> Rules and rates</Button>
                {features.tables && <Button size="sm" variant="secondary" onClick={() => openDesigner(r)}><LayoutDashboard size={13} /> Floor plan</Button>}
                {features.tables && r._count.tables > 0 && <Button size="sm" variant="secondary" onClick={() => setFloorRoom(r)}><CalendarClock size={13} /> Tonight</Button>}
                <Button size="sm" variant="secondary" onClick={() => setDeskRoom(r)}><Monitor size={13} /> Desks</Button>
                <Button size="sm" variant="ghost" onClick={() => remove(r)} aria-label={`Delete ${r.name}`}><Trash2 size={13} /></Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Rules and rates */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Room rules and rates' : 'New room'}
        maxWidth="720px"
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving || !form.name.trim()}>{saving ? 'Saving…' : 'Save room'}</Button></>}
      >
        <div style={{ display: 'grid', gap: '1rem' }}>
          <Input label="Name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={features.tables ? 'Terrace, Main dining room, Private room' : 'Consulting room 1'} />
          <Textarea label="Description (shown to customers choosing a room)" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
          <Checkbox checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} label="Open (untick to close the room to all bookings)" />

          <h4 style={{ margin: '0.5rem 0 0' }}>Rules</h4>
          <Checkbox checked={form.onlineBookable} onChange={(e) => set('onlineBookable', e.target.checked)} label="Customers can book it online (untick for staff-only rooms)" />
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Input label="Smallest party" type="number" min={1} value={form.minPartySize} onChange={(e) => set('minPartySize', e.target.value)} placeholder="Any" />
            <Input label="Largest party" type="number" min={1} value={form.maxPartySize} onChange={(e) => set('maxPartySize', e.target.value)} placeholder="Any" />
            <Input label="Bookable from" type="time" value={form.openTime} onChange={(e) => set('openTime', e.target.value)} />
            <Input label="Bookable until" type="time" value={form.closeTime} onChange={(e) => set('closeTime', e.target.value)} />
          </div>
          <div>
            <div className="field-label">Days (none ticked: the service’s days)</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {DAYS.map((d) => (
                <Checkbox key={d.n} checked={form.days.includes(d.n)} onChange={(e) => set('days', e.target.checked ? [...form.days, d.n] : form.days.filter((x) => x !== d.n))} label={d.l} />
              ))}
            </div>
          </div>
          {features.tables && <Checkbox checked={form.allowCombine} onChange={(e) => set('allowCombine', e.target.checked)} label={`A big party may be given several nearby ${features.tablesLabel} when none is big enough`} />}

          <h4 style={{ margin: '0.5rem 0 0' }}>Rates</h4>
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <Select label="Price" value={form.priceMode} onChange={(e) => set('priceMode', e.target.value as Form['priceMode'])}>
              <option value="INHERIT">The service’s price</option>
              <option value="SURCHARGE">The service’s price plus a charge</option>
              <option value="OVERRIDE">A price for this room instead</option>
            </Select>
            {form.priceMode !== 'INHERIT' && (
              <>
                <Input label={`${form.priceMode === 'SURCHARGE' ? 'Extra charge' : 'Price'} (${currency ?? ''})`} type="number" min={0} step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} />
                <Select label="Charged" value={form.priceBasis} onChange={(e) => set('priceBasis', e.target.value as Form['priceBasis'])}>
                  <option value="BOOKING">Per booking</option>
                  <option value="PERSON">Per person</option>
                </Select>
              </>
            )}
          </div>
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <Select label="Payment when booking" value={form.paymentMode} onChange={(e) => set('paymentMode', e.target.value as Form['paymentMode'])}>
              <option value="">Same as the service</option>
              <option value="NONE">Nothing, pay at the venue</option>
              <option value="DEPOSIT">A deposit</option>
              <option value="FULL">The full price</option>
            </Select>
            {form.paymentMode === 'DEPOSIT' && <Input label="Deposit (%)" type="number" min={1} max={99} value={form.depositPercent} onChange={(e) => set('depositPercent', e.target.value)} />}
            <Input label="Full refund if cancelled this many hours before" type="number" min={0} value={form.refundCutoffHours} onChange={(e) => set('refundCutoffHours', e.target.value)} placeholder="Same as the service" />
          </div>
          <div>
            <div className="field-label">Refund by notice (optional; replaces the single cutoff)</div>
            {form.tiers.map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 6 }}>
                <Input label="At least (hours)" type="number" min={0} value={t.hours} onChange={(e) => set('tiers', form.tiers.map((x, j) => (j === i ? { ...x, hours: e.target.value } : x)))} />
                <Input label="Refund (%)" type="number" min={0} max={100} value={t.percent} onChange={(e) => set('tiers', form.tiers.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
                <Button type="button" variant="ghost" size="sm" onClick={() => set('tiers', form.tiers.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => set('tiers', [...form.tiers, { hours: '', percent: '' }])}>Add a notice step</Button>
            {form.tiers.length > 0 && <p className="field-hint" style={{ marginTop: 6 }}>For example 48 hours: 100%, 24 hours: 50%. Cancelling later than every step refunds nothing.</p>}
          </div>
        </div>
      </Modal>

      {/* Floor plan designer */}
      <Modal open={!!designing} onClose={() => { setDesigning(null); load(); }} title={designing ? `${designing.room.name}: floor plan` : ''} maxWidth="1180px">
        {designing && (
          <FloorPlanDesigner
            roomId={designing.room.id}
            roomName={designing.room.name}
            label={features.tableLabel}
            initial={{
              layoutWidth: designing.room.layoutWidth,
              layoutHeight: designing.room.layoutHeight,
              layoutImageUrl: designing.room.layoutImageUrl,
              tables: designing.tables.map((t) => ({ ...t })),
            }}
            onSaved={load}
          />
        )}
      </Modal>

      {deskRoom && <DesksModal room={deskRoom} locationId={locationId} onClose={() => { setDeskRoom(null); load(); }} />}
      {floorRoom && <FloorModal room={floorRoom} onClose={() => setFloorRoom(null)} />}
      <span hidden>{Tables}</span>
    </Layout>
  );
}

/** Which desks (service point instances) are in the room. */
function DesksModal({ room, locationId, onClose }: { room: ListedRoom; locationId: string; onClose: () => void }) {
  const [desks, setDesks] = useState<{ id: string; name: string; serviceName: string; roomId: string | null }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listDesks(locationId).then((d) => {
      setDesks(d);
      setPicked(new Set(d.filter((x) => x.roomId === room.id).map((x) => x.id)));
    }).catch((e) => toast.error(errorMessage(e, 'Couldn’t load the desks.')));
  }, [locationId, room.id]);

  const save = async () => {
    setSaving(true);
    try {
      await api.setRoomDesks(room.id, [...picked]);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save.'));
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`${room.name}: desks`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>Save</Button></>}>
      {desks.length === 0 ? (
        <p>This location has no desks yet. Add them under Desks &amp; rooms.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {desks.map((d) => (
            <Checkbox
              key={d.id}
              checked={picked.has(d.id)}
              onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })}
              label={`${d.name} (${d.serviceName})${d.roomId && d.roomId !== room.id ? ' · in another room' : ''}`}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

/** The host's view: who has which table, now or at a chosen time. */
function FloorModal({ room, onClose }: { room: ListedRoom; onClose: () => void }) {
  const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [at, setAt] = useState(toLocalInput(new Date()));
  const [map, setMap] = useState<FloorMap | null>(null);

  useEffect(() => {
    api.getRoomFloor(room.id, new Date(at).toISOString()).then(setMap).catch((e) => toast.error(errorMessage(e, 'Couldn’t load the floor.')));
  }, [room.id, at]);

  const notes: Record<string, string> = {};
  const startMs = new Date(at).getTime();
  map?.bookings?.forEach((b) => {
    const t = new Date(b.startTime).getTime();
    if (t <= startMs + 90 * 60000 && new Date(b.endTime).getTime() > startMs) notes[b.tableId] = `${b.name || 'Booked'} · ${b.partySize}`;
  });

  return (
    <Modal open onClose={onClose} title={`${room.name}: who is where`} maxWidth="980px">
      <div style={{ display: 'grid', gap: 12 }}>
        <Input label="Time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ maxWidth: 260 }} />
        {map ? (
          <>
            <SeatMap layout={{ width: map.room.layoutWidth, height: map.room.layoutHeight, imageUrl: map.room.layoutImageUrl }} tables={map.tables} notes={notes} />
            <SeatMapLegend />
            {map.bookings && map.bookings.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.875rem' }}>
                {map.bookings.map((b) => (
                  <li key={`${b.appointmentId}-${b.tableId}`}>
                    {new Date(b.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {map.tables.find((t) => t.id === b.tableId)?.name} · {b.name} ({b.partySize}) · {b.status.toLowerCase().replace('_', ' ')}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : <div className="spinner" />}
      </div>
    </Modal>
  );
}
