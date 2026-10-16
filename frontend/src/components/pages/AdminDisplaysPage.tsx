'use client';

import { localDay } from '@/lib/localDate';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUp, ArrowDown, ExternalLink, Film, Radio, Image as ImageIcon, Link2, Trash2, Upload, Plus, X, CalendarRange,
} from 'lucide-react';
import api from '@/api/client';
import type { DisplayConfig, DisplayMediaItem, DisplayEntitlement } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import Layout from '@/components/Layout';
import { PageHeader, Button, Switch } from '@/components/ui';
import PlaylistsPanel from '@/components/displays/PlaylistsPanel';
import { confirmDialog } from '@/lib/dialog';

interface LocationRow { id: string; name: string; publicCode?: string | null }

const DEFAULT_CONFIG: DisplayConfig = {
  ticker: { enabled: false, messages: [], speed: 'normal' },
  media: { enabled: false, mode: 'interstitial', everySeconds: 90 },
  callFlash: true,
};

const EVERY = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 90, label: '90 seconds' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const STREAM_URL = /(youtube\.com|youtu\.be|vimeo\.com)\/|\.m3u8(\?|#|$)/i;
const kindForLink = (url: string): DisplayMediaItem['kind'] => (STREAM_URL.test(url) ? 'STREAM' : VIDEO_EXT.test(url) ? 'VIDEO' : 'IMAGE');

const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)) : 0);

/** Where this organization stands on lobby adverts, and how to get more. */
function PlanNote({ e }: { e: DisplayEntitlement }) {
  const used = `${e.itemsUsed} of ${e.maxItems} playlist items used`;
  if (e.status === 'trial_available') return <p className="displays-plan">Try adverts free for {e.trialDays} days, with up to {e.maxItems} items. The trial starts when you add the first one.</p>;
  if (e.status === 'trial') return <p className="displays-plan">Free trial: {daysLeft(e.trialEndsAt)} {daysLeft(e.trialEndsAt) === 1 ? 'day' : 'days'} left · {used}. <a href="/admin/billing">Keep adverts after the trial</a></p>;
  if (e.status === 'trial_ended') return <p className="displays-plan" data-tone="bad">Your free trial has ended, so screens aren’t playing media (the ticker still runs). <a href="/admin/billing">Upgrade or get a lobby media pack</a></p>;
  if (e.status === 'included') return <p className="displays-plan">{used}. Files up to 4MB. <a href="/admin/billing">A lobby media pack</a> adds big videos, live streams and 25 more items.</p>;
  return <p className="displays-plan">Lobby media pack: {used}. Large videos and streams included.</p>;
}

/** Uploads straight from the browser to Uploadcare, reporting progress. */
function uploadDirect(file: File, publicKey: string, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('UPLOADCARE_PUB_KEY', publicKey);
    form.append('UPLOADCARE_STORE', '0'); // our server stores it once registered
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://upload.uploadcare.com/base/');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && body.file) resolve(body.file);
        else reject(new Error('The upload was refused. Check the file and try again.'));
      } catch { reject(new Error('The upload didn’t finish. Try again.')); }
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.send(form);
  });
}

const toDateInput = (iso?: string | null) => (iso ? localDay(new Date(iso)) : '');
const fromDateInput = (value: string, endOfDay: boolean) => (value ? new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString() : null);
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

function scheduleLabel(item: DisplayMediaItem) {
  const now = Date.now();
  if (item.endsAt && new Date(item.endsAt).getTime() < now) return { text: `Ended ${shortDate(item.endsAt)}`, tone: 'muted' };
  if (item.startsAt && new Date(item.startsAt).getTime() > now) return { text: `Starts ${shortDate(item.startsAt)}`, tone: 'warn' };
  if (item.endsAt) return { text: `Until ${shortDate(item.endsAt)}`, tone: 'ok' };
  return null;
}

export default function AdminDisplaysPage() {
  const { user, loading: authLoading } = useAuthContext();
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [config, setConfig] = useState<DisplayConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState('');
  const [media, setMedia] = useState<DisplayMediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newMessage, setNewMessage] = useState('');

  const [addMode, setAddMode] = useState<'upload' | 'link'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [everywhere, setEverywhere] = useState(true);
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [entitlement, setEntitlement] = useState<DisplayEntitlement | null>(null);
  const refreshEntitlement = () => api.getDisplayEntitlement().then(setEntitlement).catch(() => {});
  const [addError, setAddError] = useState('');
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [tab, setTab] = useState<'screen' | 'playlists' | 'library'>('screen');

  const location = locations.find((l) => l.id === locationId);
  const dirty = saved !== '' && JSON.stringify(config) !== saved;

  useEffect(() => {
    if (authLoading) return;
    if (!user?.organizationId) { setLoading(false); return; }
    refreshEntitlement();
    Promise.all([api.getLocations(user.organizationId), api.listDisplayMedia()])
      .then(([locs, items]) => {
        setLocations(locs);
        setMedia(items);
        if (locs[0]) setLocationId(locs[0].id);
        else setLoading(false);
      })
      .catch(() => { setMessage({ type: 'error', text: 'Couldn’t load your screens. Refresh to try again.' }); setLoading(false); });
  }, [authLoading, user?.organizationId]);

  useEffect(() => {
    if (!locationId) return;
    setLoading(true);
    api.getDisplayConfig(locationId)
      .then((c) => { setConfig(c); setSaved(JSON.stringify(c)); })
      .catch(() => setMessage({ type: 'error', text: 'Couldn’t load this screen’s settings.' }))
      .finally(() => setLoading(false));
  }, [locationId]);

  // What plays at this location: org-wide items plus its own, in playlist order.
  const playlist = useMemo(
    () => media.filter((m) => !m.locationId || m.locationId === locationId),
    [media, locationId]
  );

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const next = await api.updateDisplayConfig(locationId, config);
      setConfig(next);
      setSaved(JSON.stringify(next));
      setMessage({ type: 'success', text: 'Saved. Screens update within a few seconds.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Couldn’t save. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const addTickerMessage = () => {
    const text = newMessage.trim();
    if (!text) return;
    setConfig({ ...config, ticker: { ...config.ticker, messages: [...config.ticker.messages, text].slice(0, 20) } });
    setNewMessage('');
  };

  const addMedia = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    setAdding(true);
    try {
      const fields = { title: title.trim() || undefined, locationId: everywhere ? null : locationId };
      let item: DisplayMediaItem;
      if (addMode === 'upload') {
        if (!file) throw new Error('Choose a file to upload.');
        const config = await api.getDisplayUploadConfig();
        if (file.size <= config.serverMaxBytes) {
          item = await api.uploadDisplayMedia(file, fields);
        } else if (config.direct && file.size <= config.direct.maxBytes) {
          // Too big to pass through our server: send it straight to storage.
          setProgress(0);
          const fileId = await uploadDirect(file, config.direct.publicKey, setProgress);
          item = await api.registerDirectUpload({ fileId, mimeType: file.type, size: file.size, ...fields } as Parameters<typeof api.registerDirectUpload>[0]);
        } else {
          throw new Error(config.direct ? 'That file is over 500MB. Use a shorter video, or add it by link.' : config.largeFilesNeedPack ? 'Files over 4MB come with a lobby media pack (see Billing). Or add the video by link.' : 'That file is over 4MB. Add it by link instead, or ask your platform admin to set up file storage.');
        }
      } else {
        item = await api.createDisplayMedia({ ...fields, url: link.trim(), kind: kindForLink(link.trim()) });
      }
      setMedia((list) => [...list, item]);
      setFile(null); setLink(''); setTitle('');
      refreshEntitlement();
    } catch (err: any) {
      setAddError(err.response?.data?.error || err.message || 'Couldn’t add that. Try again.');
    } finally {
      setAdding(false);
      setProgress(null);
    }
  };

  const patch = async (id: string, change: Partial<DisplayMediaItem>) => {
    setMedia((list) => list.map((m) => (m.id === id ? { ...m, ...change } : m)));
    try {
      const updated = await api.updateDisplayMedia(id, change);
      setMedia((list) => list.map((m) => (m.id === id ? updated : m)));
    } catch {
      setMessage({ type: 'error', text: 'That change didn’t save. Refresh and try again.' });
    }
  };

  const remove = async (item: DisplayMediaItem) => {
    if (!(await confirmDialog({ title: `Remove “${item.title}”?`, message: 'It comes off every screen that plays it.', confirmLabel: 'Remove', tone: 'danger' }))) return;
    const before = media;
    setMedia((list) => list.filter((m) => m.id !== item.id));
    try { await api.deleteDisplayMedia(item.id); refreshEntitlement(); } catch {
      setMedia(before);
      setMessage({ type: 'error', text: 'Couldn’t remove it. Try again.' });
    }
  };

  // Moves an item past its neighbour in this location's playlist, keeping
  // the rest of the org's order intact.
  const move = async (item: DisplayMediaItem, delta: number) => {
    const at = playlist.findIndex((m) => m.id === item.id);
    const other = playlist[at + delta];
    if (!other) return;
    const next = [...media];
    const i = next.findIndex((m) => m.id === item.id);
    const j = next.findIndex((m) => m.id === other.id);
    [next[i], next[j]] = [next[j], next[i]];
    setMedia(next);
    try { await api.reorderDisplayMedia(next.map((m) => m.id)); } catch {
      setMessage({ type: 'error', text: 'Couldn’t reorder. Try again.' });
    }
  };

  const screenUrl = location ? `/display/${location.publicCode || location.id}` : '';

  if (!loading && locations.length === 0) {
    return (
      <Layout>
        <PageHeader title="Display screens" subtitle="What the lobby TV shows." />
        <div className="settings-panel"><p className="settings-lede">Add a location first. Each location gets its own screen.</p></div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title="Display screens"
        subtitle="What the lobby TV shows between calls: a ticker along the bottom, and your own adverts and videos."
        actions={screenUrl ? (
          <a className="btn btn-secondary" href={screenUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open screen</a>
        ) : undefined}
      />

      {locations.length > 1 && (
        <div className="displays-location">
          <label htmlFor="display-location">Screen at</label>
          <select id="display-location" value={locationId} onChange={async (e) => {
            const next = e.target.value;
            if (dirty && !(await confirmDialog({ title: 'Leave without saving?', message: 'This screen’s changes will be lost.', confirmLabel: 'Leave', cancelLabel: 'Stay', tone: 'danger' }))) return;
            setLocationId(next);
          }}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}

      <div className="tabs displays-page-tabs" role="tablist">
        {([['screen', 'Screen'], ['playlists', 'Playlists'], ['library', 'Media library']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'playlists' ? (
        <PlaylistsPanel media={media} locations={locations} />
      ) : loading ? (
        <div style={{ padding: '3rem', textAlign: 'center' }}><div className="spinner" /></div>
      ) : (
        <div className="displays" data-tab={tab}>
          {tab === 'screen' && <section className="settings-panel">
            <h2>Between calls</h2>
            <p className="settings-lede">A new call always takes over the screen, so nobody misses their turn while something is playing.</p>
            <Switch
              label="Play adverts and videos on this screen"
              checked={config.media.enabled}
              onChange={(e) => setConfig({ ...config, media: { ...config.media, enabled: e.target.checked } })}
            />
            <div className="mode-cards displays-modes" role="radiogroup" aria-label="How media plays">
              {([
                { value: 'interstitial', label: 'Full screen, when it’s quiet', note: 'Takes over the screen after a quiet spell, then goes back to the queue.' },
                { value: 'split', label: 'Beside the queue', note: 'Plays all the time in a panel next to the queue. Portrait posters fit best.' },
              ] as const).map((m) => (
                <label key={m.value} className="mode-card" data-selected={config.media.mode === m.value} data-disabled={!config.media.enabled}>
                  <input
                    type="radio"
                    name="media-mode"
                    checked={config.media.mode === m.value}
                    disabled={!config.media.enabled}
                    onChange={() => setConfig({ ...config, media: { ...config.media, mode: m.value } })}
                  />
                  <div className={`displays-thumb displays-thumb-${m.value}`} aria-hidden="true">
                    <span className="displays-thumb-queue"><i /><i /><i /></span>
                    <span className="displays-thumb-media"><ImageIcon size={16} /></span>
                  </div>
                  <strong>{m.label}</strong>
                  <small>{m.note}</small>
                </label>
              ))}
            </div>
            {config.media.enabled && config.media.mode === 'interstitial' && (
              <label className="settings-field displays-every">
                <span>Start after</span>
                <select
                  value={config.media.everySeconds}
                  onChange={(e) => setConfig({ ...config, media: { ...config.media, everySeconds: Number(e.target.value) } })}
                >
                  {EVERY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  {!EVERY.some((o) => o.value === config.media.everySeconds) && <option value={config.media.everySeconds}>{config.media.everySeconds} seconds</option>}
                </select>
                <small>with no new calls.</small>
              </label>
            )}
            <div className="settings-switches">
              <Switch
                label="Show each new call full screen for a few seconds"
                checked={config.callFlash}
                onChange={(e) => setConfig({ ...config, callFlash: e.target.checked })}
              />
            </div>

            <h3>Ticker</h3>
            <Switch
              label="Scroll messages along the bottom of the screen"
              checked={config.ticker.enabled}
              onChange={(e) => setConfig({ ...config, ticker: { ...config.ticker, enabled: e.target.checked } })}
            />
            {config.ticker.enabled && (
              <>
                {config.ticker.messages.length > 0 && (
                  <ul className="settings-fields displays-messages">
                    {config.ticker.messages.map((m, i) => (
                      <li key={`${i}-${m}`}>
                        <span className="settings-field-name">{m}</span>
                        <button
                          type="button"
                          className="settings-remove"
                          aria-label={`Remove “${m}”`}
                          onClick={() => setConfig({ ...config, ticker: { ...config.ticker, messages: config.ticker.messages.filter((_, x) => x !== i) } })}
                        >
                          <X size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="settings-inline displays-add-message">
                  <input
                    value={newMessage}
                    maxLength={200}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTickerMessage(); } }}
                    placeholder="e.g. Flu jabs available this week. Ask at reception."
                    aria-label="New ticker message"
                  />
                  <Button type="button" variant="secondary" onClick={addTickerMessage} disabled={!newMessage.trim()}><Plus size={16} /> Add</Button>
                </div>
                <label className="settings-field displays-speed">
                  <span>Speed</span>
                  <select value={config.ticker.speed} onChange={(e) => setConfig({ ...config, ticker: { ...config.ticker, speed: e.target.value as DisplayConfig['ticker']['speed'] } })}>
                    <option value="slow">Slow</option>
                    <option value="normal">Normal</option>
                    <option value="fast">Fast</option>
                  </select>
                </label>
                {config.ticker.messages.length > 0 && (
                  <div className="displays-ticker-preview" aria-hidden="true">
                    <span>{config.ticker.messages.join('   •   ')}</span>
                  </div>
                )}
              </>
            )}

            <div className="settings-savebar" data-dirty={dirty}>
              <span role="status">
                {message ? (
                  <span className={message.type === 'error' ? 'settings-note-bad' : 'settings-note-ok'}>{message.text}</span>
                ) : dirty ? 'You have unsaved changes.' : 'All changes saved.'}
              </span>
              <Button type="button" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </section>}

          {tab === 'library' && <section className="settings-panel">
            <h2>Media library</h2>
            <p className="settings-lede">
              Everything you can show on screens. Playlists decide when each item plays; with no playlists, the whole library plays in this order. Images and streams stay up for the time you set; videos play to the end.
            </p>
            {entitlement && <PlanNote e={entitlement} />}

            {!config.media.enabled && playlist.length > 0 && (
              <p className="settings-warn">This screen isn’t playing media. Turn on “Play adverts and videos” and save.</p>
            )}
            {playlist.length === 0 ? (
              <div className="displays-empty">
                <Film size={22} />
                <p>Nothing here yet. Add a poster, a promotion or a short video below.</p>
              </div>
            ) : (
              <ul className="displays-list">
                {playlist.map((item, index) => {
                  const schedule = scheduleLabel(item);
                  return (
                    <li key={item.id} data-inactive={!item.isActive}>
                      <div className="settings-field-order">
                        <button type="button" onClick={() => move(item, -1)} disabled={index === 0} aria-label={`Move ${item.title} up`}><ArrowUp size={14} /></button>
                        <button type="button" onClick={() => move(item, 1)} disabled={index === playlist.length - 1} aria-label={`Move ${item.title} down`}><ArrowDown size={14} /></button>
                      </div>
                      <div className="displays-preview">
                        {item.kind === 'VIDEO'
                          ? <video src={item.url} muted preload="metadata" />
                          : item.kind === 'STREAM'
                            ? <span className="displays-stream"><Radio size={20} /> Stream</span>
                            // eslint-disable-next-line @next/next/no-img-element
                            : <img src={item.url} alt="" />}
                        {item.kind === 'VIDEO' && <Film size={14} className="displays-kind" />}
                      </div>
                      <div className="displays-meta">
                        <input
                          className="displays-title"
                          defaultValue={item.title}
                          aria-label="Title"
                          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== item.title) patch(item.id, { title: v }); }}
                        />
                        <div className="displays-tags">
                          <span>{item.locationId ? 'This location only' : 'All locations'}</span>
                          {item.kind !== 'VIDEO' ? (
                            <label className="displays-duration">
                              <input
                                type="number"
                                min={3}
                                max={600}
                                defaultValue={item.durationSeconds}
                                aria-label="Seconds on screen"
                                onBlur={(e) => { const v = Number(e.target.value); if (v && v !== item.durationSeconds) patch(item.id, { durationSeconds: v }); }}
                              />
                              sec
                            </label>
                          ) : <span>Plays to the end</span>}
                          {schedule && <span data-tone={schedule.tone}>{schedule.text}</span>}
                          <button type="button" className="displays-link" onClick={() => setScheduling(scheduling === item.id ? null : item.id)}>
                            <CalendarRange size={14} /> {item.startsAt || item.endsAt ? 'Change dates' : 'Set dates'}
                          </button>
                        </div>
                        {scheduling === item.id && (
                          <div className="displays-schedule">
                            <label>From <input type="date" defaultValue={toDateInput(item.startsAt)} onChange={(e) => patch(item.id, { startsAt: fromDateInput(e.target.value, false) })} /></label>
                            <label>Until <input type="date" defaultValue={toDateInput(item.endsAt)} onChange={(e) => patch(item.id, { endsAt: fromDateInput(e.target.value, true) })} /></label>
                            <small>Leave blank to run with no end date.</small>
                          </div>
                        )}
                      </div>
                      <Switch
                        aria-label={item.isActive ? `Pause ${item.title}` : `Play ${item.title}`}
                        checked={!!item.isActive}
                        onChange={(e) => patch(item.id, { isActive: e.target.checked })}
                      />
                      <button type="button" className="settings-remove" onClick={() => remove(item)} aria-label={`Remove ${item.title}`}><Trash2 size={16} /></button>
                    </li>
                  );
                })}
              </ul>
            )}

            <form className="displays-add" onSubmit={addMedia}>
              <div className="tabs displays-tabs" role="tablist">
                <button type="button" className="tab" role="tab" aria-selected={addMode === 'upload'} onClick={() => setAddMode('upload')}><Upload size={15} /> Upload</button>
                <button type="button" className="tab" role="tab" aria-selected={addMode === 'link'} onClick={() => setAddMode('link')}><Link2 size={15} /> Add by link</button>
              </div>
              {addMode === 'upload' ? (
                <label className="displays-drop">
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                  <Upload size={18} />
                  <span>{file ? file.name : 'Choose an image or a short video'}</span>
                  <small>PNG, JPG, WebP, GIF, MP4 or WebM. Large videos upload straight to storage when it’s set up.</small>
                </label>
              ) : (
                <label className="settings-field">
                  <span>Link to an image, video or stream</span>
                  <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/spring-promo.mp4" />
                  <small>A direct link to an image or .mp4/.webm file. YouTube, Vimeo and live (.m3u8) streams need a lobby media pack.</small>
                </label>
              )}
              <div className="settings-grid">
                <label className="settings-field">
                  <span>Title</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Free blood pressure checks" maxLength={120} />
                </label>
                <fieldset className="settings-field displays-where">
                  <span>Show at</span>
                  <label><input type="radio" checked={everywhere} onChange={() => setEverywhere(true)} /> All locations</label>
                  <label><input type="radio" checked={!everywhere} onChange={() => setEverywhere(false)} /> {location?.name || 'This location'} only</label>
                </fieldset>
              </div>
              {addError && <div className="inline-alert inline-alert-error" role="alert">{addError}</div>}
              <Button type="submit" disabled={adding || !!(entitlement && (!entitlement.allowed || entitlement.itemsUsed >= entitlement.maxItems)) || (addMode === 'upload' ? !file : !link.trim())}>
                {progress !== null ? `Uploading ${progress}%` : adding ? 'Adding…' : 'Add to library'}
              </Button>
            </form>
          </section>}
        </div>
      )}
    </Layout>
  );
}
