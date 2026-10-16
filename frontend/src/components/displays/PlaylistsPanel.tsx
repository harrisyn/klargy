'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarRange, Clock, Copy, Film, Image as ImageIcon, Plus, Radio, Trash2, X } from 'lucide-react';
import api from '@/api/client';
import type { DisplayMediaItem, DisplayPlaylist } from '@/api/client';
import { Button, Switch } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';
import { localDay } from '@/lib/localDate';
import { confirmDialog } from '@/lib/dialog';

/**
 * Scheduled playlists: which media plays on which days, at which times and
 * locations, and which wins when two overlap.
 */

interface LocationRow { id: string; name: string }

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];
const PRIORITIES = [
  { value: 1, label: 'Takes over', hint: 'Replaces everything else while it’s on. For promotions and notices.' },
  { value: 2, label: 'Normal', hint: 'Your everyday rotation.' },
  { value: 3, label: 'Filler', hint: 'Only plays when nothing else is scheduled.' },
];

const kindIcon = (k: string) => (k === 'VIDEO' ? <Film size={14} /> : k === 'STREAM' ? <Radio size={14} /> : <ImageIcon size={14} />);

export function describeSchedule(p: DisplayPlaylist) {
  const days = p.days.split(',').filter(Boolean).map(Number);
  const dayText = days.length === 7 ? 'Every day'
    : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'Weekdays'
    : days.length === 2 && days.includes(0) && days.includes(6) ? 'Weekends'
    : DAYS.filter((d) => days.includes(d.n)).map((d) => d.label).join(', ');
  const time = p.startTime || p.endTime ? `${p.startTime || 'opening'}–${p.endTime || 'closing'}` : 'all day';
  return `${dayText}, ${time}`;
}

function PlaylistEditor({
  playlist, media, locations, onChange, onDelete, onDuplicate,
}: {
  playlist: DisplayPlaylist;
  media: DisplayMediaItem[];
  locations: LocationRow[];
  onChange: (p: DisplayPlaylist) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const [draft, setDraft] = useState(playlist);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState('');
  useEffect(() => setDraft(playlist), [playlist]);

  const days = draft.days.split(',').filter(Boolean).map(Number);
  const dirty = JSON.stringify({ ...draft, items: undefined }) !== JSON.stringify({ ...playlist, items: undefined });
  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const items = playlist.items.map((i) => byId.get(i.mediaId)).filter((m): m is DisplayMediaItem => !!m);
  const available = media.filter((m) => !playlist.items.some((i) => i.mediaId === m.id) && (!m.locationId || !draft.locationId || m.locationId === draft.locationId));

  const save = async () => {
    setSaving(true);
    try {
      onChange(await api.updateDisplayPlaylist(playlist.id, {
        name: draft.name, locationId: draft.locationId, days: draft.days, startTime: draft.startTime, endTime: draft.endTime,
        priority: draft.priority, isActive: draft.isActive, startsAt: draft.startsAt, endsAt: draft.endsAt,
      }));
      toast.success('Playlist saved. Screens pick it up within a minute.');
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save the playlist.'));
    } finally {
      setSaving(false);
    }
  };

  const setItems = async (ids: string[]) => {
    try {
      onChange(await api.setDisplayPlaylistItems(playlist.id, ids));
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t update the playlist.'));
    }
  };
  const ids = items.map((m) => m.id);
  const move = (i: number, d: number) => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setItems(next);
  };

  return (
    <article className="pl-card" data-off={!playlist.isActive}>
      <header className="pl-head">
        <div className="pl-title-wrap">
          <input className="pl-name" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Playlist name" />
          <small className="pl-summary">
            {describeSchedule(playlist)} · {locations.find((l) => l.id === playlist.locationId)?.name || 'all locations'} · {PRIORITIES.find((p) => p.value === playlist.priority)?.label} · {items.length} {items.length === 1 ? 'item' : 'items'}
          </small>
        </div>
        <Switch aria-label={draft.isActive ? 'Pause playlist' : 'Turn playlist on'} checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
        <button type="button" className="settings-remove" onClick={onDuplicate} aria-label="Duplicate playlist" title="Duplicate"><Copy size={16} /></button>
        <button type="button" className="settings-remove" onClick={onDelete} aria-label="Delete playlist" title="Delete"><Trash2 size={16} /></button>
      </header>

      <div className="pl-schedule">
        <div className="pl-row">
          <span className="pl-label">Days</span>
          <div className="welcome-chips" role="group" aria-label="Days">
            {DAYS.map((d) => (
              <button
                key={d.n}
                type="button"
                className="welcome-chip welcome-day"
                aria-pressed={days.includes(d.n)}
                onClick={() => {
                  const next = days.includes(d.n) ? days.filter((x) => x !== d.n) : [...days, d.n];
                  setDraft({ ...draft, days: next.sort().join(',') });
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="pl-row">
          <span className="pl-label"><Clock size={14} /> Time</span>
          <label className="pl-inline">From <input type="time" value={draft.startTime || ''} onChange={(e) => setDraft({ ...draft, startTime: e.target.value || null })} /></label>
          <label className="pl-inline">to <input type="time" value={draft.endTime || ''} onChange={(e) => setDraft({ ...draft, endTime: e.target.value || null })} /></label>
          <small className="muted">Leave blank for all day. An end before the start runs overnight.</small>
        </div>
        <div className="pl-row">
          <span className="pl-label"><CalendarRange size={14} /> Dates</span>
          <label className="pl-inline">From <input type="date" value={draft.startsAt ? localDay(new Date(draft.startsAt)) : ''} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : null })} /></label>
          <label className="pl-inline">until <input type="date" value={draft.endsAt ? localDay(new Date(new Date(draft.endsAt).getTime() - 1)) : ''} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null })} /></label>
        </div>
        <div className="pl-row">
          <span className="pl-label">Where</span>
          <select value={draft.locationId || ''} onChange={(e) => setDraft({ ...draft, locationId: e.target.value || null })}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name} only</option>)}
          </select>
          <span className="pl-label pl-label-2">Priority</span>
          <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} title={PRIORITIES.find((p) => p.value === draft.priority)?.hint}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <p className="pl-hint">{PRIORITIES.find((p) => p.value === draft.priority)?.hint}</p>
        {dirty && (
          <div className="pl-save">
            <span>Unsaved changes</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft(playlist)}>Undo</Button>
            <Button size="sm" onClick={save} disabled={saving || days.length === 0}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        )}
      </div>

      <div className="pl-items">
        {items.length === 0 ? <p className="muted">Nothing in this playlist yet. Add from your media library.</p> : (
          <ol>
            {items.map((m, i) => (
              <li key={m.id}>
                <span className="pl-thumb">
                  {m.kind === 'IMAGE'
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={m.url} alt="" />
                    : kindIcon(m.kind)}
                </span>
                <span className="pl-title">{m.title}</span>
                <span className="pl-kind">{kindIcon(m.kind)} {m.kind === 'IMAGE' ? `${m.durationSeconds}s` : m.kind === 'STREAM' ? `${m.durationSeconds}s` : 'to the end'}</span>
                <div className="settings-field-order">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${m.title} up`}><ArrowUp size={14} /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={`Move ${m.title} down`}><ArrowDown size={14} /></button>
                </div>
                <button type="button" className="settings-remove" onClick={() => setItems(ids.filter((x) => x !== m.id))} aria-label={`Take ${m.title} out of this playlist`}><X size={15} /></button>
              </li>
            ))}
          </ol>
        )}
        {available.length > 0 && (
          <div className="pl-add">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add from media library">
              <option value="">Add from media library…</option>
              {available.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
            <Button size="sm" variant="secondary" disabled={!adding} onClick={() => { setItems([...ids, adding]); setAdding(''); }}><Plus size={14} /> Add</Button>
          </div>
        )}
      </div>
    </article>
  );
}

export default function PlaylistsPanel({ media, locations }: { media: DisplayMediaItem[]; locations: LocationRow[] }) {
  const [playlists, setPlaylists] = useState<DisplayPlaylist[] | null>(null);

  useEffect(() => {
    api.listDisplayPlaylists().then(setPlaylists).catch(() => { setPlaylists([]); toast.error('Couldn’t load playlists.'); });
  }, []);

  const replace = (p: DisplayPlaylist) => setPlaylists((list) => list?.map((x) => (x.id === p.id ? p : x)) || null);

  const create = async (from?: DisplayPlaylist) => {
    try {
      const p = await api.createDisplayPlaylist(from ? {
        name: `${from.name} (copy)`, locationId: from.locationId, days: from.days, startTime: from.startTime, endTime: from.endTime,
        priority: from.priority, startsAt: from.startsAt, endsAt: from.endsAt,
      } : { name: playlists?.length ? 'New playlist' : 'Every day' });
      const withItems = from ? await api.setDisplayPlaylistItems(p.id, from.items.map((i) => i.mediaId)) : p;
      setPlaylists((list) => [...(list || []), withItems]);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t create the playlist.'));
    }
  };

  const remove = async (p: DisplayPlaylist) => {
    if (!(await confirmDialog({ title: `Delete “${p.name}”?`, message: 'The media stays in your library.', tone: 'danger' }))) return;
    try {
      await api.deleteDisplayPlaylist(p.id);
      setPlaylists((list) => list?.filter((x) => x.id !== p.id) || null);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t delete it.'));
    }
  };

  return (
    <section className="settings-panel pl-panel">
      <div className="today-panel-head">
        <h2>Playlists</h2>
        <Button size="sm" onClick={() => create()}><Plus size={15} /> New playlist</Button>
      </div>
      <p className="settings-lede">
        Choose what plays on which days and at what times. Reuse a playlist on several days, for example Monday and Thursday, by picking both.
        When two are on at once, the higher priority plays. Times are each location’s local time.
      </p>
      {playlists === null ? <div className="spinner" /> : playlists.length === 0 ? (
        <div className="displays-empty">
          <CalendarRange size={22} />
          <p>No playlists yet, so everything in your media library plays, all day, every day. Make a playlist to schedule it.</p>
        </div>
      ) : (
        <div className="pl-list">
          {playlists.map((p) => (
            <PlaylistEditor
              key={p.id}
              playlist={p}
              media={media}
              locations={locations}
              onChange={replace}
              onDelete={() => remove(p)}
              onDuplicate={() => create(p)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
