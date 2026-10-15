'use client';

import QrCode from '@/components/QrCode';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { LayoutGrid, Users, Sun, Moon, Volume2, VolumeX, Maximize, Minimize, ChevronLeft } from 'lucide-react';
import api from '@/api/client';
import type { DisplayConfig, DisplayMediaItem } from '@/api/client';
import { useSocket } from '@/hooks/useSocket';
import type { Location } from '@/types';
import { APP_NAME } from '@/lib/appConfig';
import { termsFor } from '@/lib/terms';
import styles from './display.module.css';

/**
 * The lobby TV. Shows who is being called and who is next, and between
 * calls can play the organization's adverts and videos (managed under
 * Admin → Display screens). A new call always interrupts media.
 */

interface BrandedLocation extends Location {
  organization?: { id: string; name: string; logoUrl?: string | null; primaryColor?: string | null; hidePoweredBy?: boolean; industry?: string | null; customerLabel?: string | null; customerLabelPlural?: string | null };
}

interface DisplayServicePoint {
  id: string;
  name: string;
  displayName?: string;
  type: string;
  displayMode: string;
  currentlyServing: { ticketNumber: string; customerName: string | null; serviceName: string; staffName?: string | null } | null;
}

interface QueueSwimlane {
  serviceId: string;
  serviceName: string;
  displayMode: string;
  queueId: string | null;
  activeServicePoints: number;
  stats: { serving: number; waiting: number; total: number };
  currentlyServing: { id: string; ticketNumber: string; customerName: string | null; servicePoint: string | null; staffName?: string | null; calledAt: string }[];
  waitingList: { id: string; ticketNumber: string; customerName: string | null; position: number; estimatedWait: number }[];
  estimatedWaitPerPerson: number;
}

interface Call {
  key: string;
  ticketNumber: string;
  customerName: string | null;
  where: string | null;
  staffName?: string | null;
  serviceName: string;
}

type ViewMode = 'services' | 'desks' | 'single';

/** "Dr Owusu, Consulting Room 3": who's seeing them, when known, and where. */
const whereWith = (staffName: string | null | undefined, where: string | null | undefined) =>
  [staffName, where].filter(Boolean).join(', ');

const DEFAULT_CONFIG: DisplayConfig = {
  ticker: { enabled: false, messages: [], speed: 'normal' },
  media: { enabled: false, mode: 'interstitial', everySeconds: 90 },
  callFlash: true,
};
const FLASH_MS = 9000;
const VIDEO_CAP_MS = 5 * 60 * 1000;
const CONTENT_REFRESH_MS = 60 * 1000; // picks up playlist start/end times
const TICKER_SECONDS_PER_CHAR = { slow: 0.32, normal: 0.22, fast: 0.15 };

const formatWait = (minutes: number) => {
  if (minutes < 1) return 'now';
  if (minutes < 60) return `about ${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `about ${h}h ${m}m` : `about ${h}h`;
};

/** YouTube or Vimeo links as an autoplaying, muted, chrome-less embed. */
function embedUrl(url: string, muted: boolean): string | null {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&mute=${muted ? 1 : 0}&controls=0&loop=1&playlist=${yt[1]}&playsinline=1&rel=0&modestbranding=1`;
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1&muted=${muted ? 1 : 0}&background=1&loop=1`;
  return null;
}

/** An HLS (.m3u8) live stream: native in Safari, hls.js elsewhere. */
function HlsVideo({ url, muted, fit, onError }: { url: string; muted: boolean; fit: 'cover' | 'contain'; onError: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const failed = useRef(onError);
  failed.current = onError;
  useEffect(() => {
    const onError = () => failed.current();
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return;
    }
    let hls: { destroy(): void } | null = null;
    let cancelled = false;
    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) { onError(); return; }
      const h = new Hls({ lowLatencyMode: true });
      h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) onError(); });
      h.loadSource(url);
      h.attachMedia(video);
      hls = h;
    }).catch(onError);
    return () => { cancelled = true; hls?.destroy(); };
  }, [url]);
  return <video ref={ref} className={styles.mediaEl} style={{ objectFit: fit }} autoPlay muted={muted} playsInline />;
}

/** Plays one image, video or stream, then calls onDone. */
function MediaPlayer({ item, muted, onDone, fit }: { item: DisplayMediaItem; muted: boolean; onDone: () => void; fit: 'cover' | 'contain' }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    // Streams never end by themselves: show them for their set time.
    const ms = item.kind === 'VIDEO' ? VIDEO_CAP_MS : Math.max(3, item.durationSeconds) * 1000;
    const t = setTimeout(() => done.current(), ms);
    return () => clearTimeout(t);
  }, [item]);

  if (item.kind === 'STREAM') {
    const embed = embedUrl(item.url, muted);
    if (embed) {
      return <iframe className={styles.mediaEl} src={embed} title={item.title} allow="autoplay; encrypted-media; picture-in-picture" style={{ border: 0 }} />;
    }
    return <HlsVideo url={item.url} muted={muted} fit={fit} onError={() => done.current()} />;
  }
  if (item.kind === 'VIDEO') {
    return (
      <video
        className={styles.mediaEl}
        style={{ objectFit: fit }}
        src={item.url}
        autoPlay
        muted={muted}
        playsInline
        onEnded={() => done.current()}
        onError={() => done.current()}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.mediaEl} style={{ objectFit: fit }} src={item.url} alt={item.title} onError={() => done.current()} />;
}

export default function TVDisplayPage() {
  const params = useParams() ?? {};
  const locationParam = params.locationId as string;
  const searchParams = useSearchParams();

  const [location, setLocation] = useState<BrandedLocation | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [servicePoints, setServicePoints] = useState<DisplayServicePoint[]>([]);
  const [swimlanes, setSwimlanes] = useState<QueueSwimlane[]>([]);
  const [config, setConfig] = useState<DisplayConfig>(DEFAULT_CONFIG);
  const [media, setMedia] = useState<DisplayMediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const [viewMode, setViewMode] = useState<ViewMode>('services');
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const [flash, setFlash] = useState<Call | null>(null);
  const [recentKey, setRecentKey] = useState<string | null>(null);
  const [interstitial, setInterstitial] = useState<DisplayMediaItem | null>(null);
  const [splitIndex, setSplitIndex] = useState(0);
  const [splitCycle, setSplitCycle] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const seenCalls = useRef<Set<string> | null>(null);
  const flashQueue = useRef<Call[]>([]);
  const lastActivity = useRef(Date.now());
  const mediaCursor = useRef(0);

  const { joinLocation, onQueueUpdated, onEntryStatusChanged, onLocationUpdated } = useSocket();

  const focusSp = searchParams?.get('servicePoint') || searchParams?.get('sp') || null;
  const focusQueue = searchParams?.get('queue') || searchParams?.get('q') || null;

  // ---- data ----

  const resolve = useCallback(async () => {
    try {
      const byCode = await api.getLocationByCode(locationParam);
      if (byCode?.id) {
        setLocation(byCode);
        return byCode.id as string;
      }
    } catch { /* not a public code */ }
    try {
      const info = await api.getPublicLocationInfo(locationParam);
      if (info) {
        setLocation(info);
        return locationParam;
      }
    } catch { /* not an id either */ }
    return null;
  }, [locationParam]);

  const fetchQueues = useCallback(async (id: string) => {
    try {
      const [displayData, queuesData] = await Promise.all([
        api.getDisplayData(id),
        api.getLocationQueues(id).catch(() => ({ swimlanes: [] })),
      ]);
      const points: DisplayServicePoint[] = displayData || [];
      setServicePoints(focusSp ? points.filter((p) => p.id === focusSp) : points);
      setSwimlanes(queuesData.swimlanes || []);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [focusSp]);

  const fetchContent = useCallback(async (id: string) => {
    try {
      const content = await api.getDisplayContent(id);
      setConfig(content.config || DEFAULT_CONFIG);
      setMedia(content.media || []);
    } catch { /* keep what's showing */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await resolve();
      if (cancelled) return;
      if (!id) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setLocationId(id);
      await Promise.all([fetchQueues(id), fetchContent(id)]);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [resolve, fetchQueues, fetchContent]);

  useEffect(() => {
    if (focusQueue) {
      setSelectedQueueId(focusQueue);
      setViewMode('single');
    }
  }, [focusQueue]);

  // Live updates, with slow polling as a safety net.
  useEffect(() => {
    if (!locationId) return;
    joinLocation(locationId);
    const refresh = () => fetchQueues(locationId);
    const offQueue = onQueueUpdated(refresh);
    const offEntry = onEntryStatusChanged(refresh);
    const offLocation = onLocationUpdated(() => fetchContent(locationId));
    const poll = setInterval(refresh, 30000);
    const contentPoll = setInterval(() => fetchContent(locationId), CONTENT_REFRESH_MS);
    return () => {
      offQueue(); offEntry(); offLocation();
      clearInterval(poll); clearInterval(contentPoll);
    };
  }, [locationId, joinLocation, onQueueUpdated, onEntryStatusChanged, onLocationUpdated, fetchQueues, fetchContent]);

  // ---- calls ----

  const calls: Call[] = useMemo(() => {
    if (swimlanes.length > 0) {
      return swimlanes
        .flatMap((lane) => lane.currentlyServing.map((e) => ({
          key: e.id,
          ticketNumber: e.ticketNumber,
          customerName: e.customerName,
          where: e.servicePoint,
          staffName: e.staffName ?? null,
          serviceName: lane.serviceName,
          calledAt: e.calledAt,
        })))
        .sort((a, b) => (b.calledAt || '').localeCompare(a.calledAt || ''));
    }
    return servicePoints
      .filter((sp) => sp.currentlyServing)
      .map((sp) => ({
        key: `${sp.id}:${sp.currentlyServing!.ticketNumber}`,
        ticketNumber: sp.currentlyServing!.ticketNumber,
        customerName: sp.currentlyServing!.customerName,
        where: sp.displayName || sp.name,
        staffName: sp.currentlyServing!.staffName ?? null,
        serviceName: sp.currentlyServing!.serviceName,
      }));
  }, [swimlanes, servicePoints]);

  const announce = useCallback((call: Call) => {
    if (!audioEnabled || typeof window === 'undefined' || !window.speechSynthesis) return;
    const spoken = call.ticketNumber.split('').join(' ');
    const u = new SpeechSynthesisUtterance(call.where ? `Ticket ${spoken}, please go to ${call.where}` : `Now serving ticket ${spoken}`);
    u.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [audioEnabled]);

  const showNextFlash = useCallback(() => {
    const next = flashQueue.current.shift() || null;
    setFlash(next);
    if (next) announce(next);
  }, [announce]);

  // Spot calls we haven't seen. The first load only records what's there.
  useEffect(() => {
    if (loading) return;
    const keys = new Set(calls.map((c) => c.key));
    if (seenCalls.current === null) {
      seenCalls.current = keys;
      return;
    }
    const fresh = calls.filter((c) => !seenCalls.current!.has(c.key));
    seenCalls.current = keys;
    if (fresh.length === 0) return;

    lastActivity.current = Date.now();
    setInterstitial(null); // a call always wins over media
    setRecentKey(fresh[0].key);
    if (config.callFlash) {
      flashQueue.current.push(...fresh.reverse());
      if (!flash) showNextFlash();
    } else {
      fresh.forEach(announce);
    }
  }, [calls, loading, config.callFlash, flash, showNextFlash, announce]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(showNextFlash, FLASH_MS);
    return () => clearTimeout(t);
  }, [flash, showNextFlash]);

  useEffect(() => {
    if (!recentKey) return;
    const t = setTimeout(() => setRecentKey(null), 30000);
    return () => clearTimeout(t);
  }, [recentKey]);

  // ---- media ----

  const mediaOn = config.media.enabled && media.length > 0;
  const splitMode = mediaOn && config.media.mode === 'split';
  const interstitialMode = mediaOn && config.media.mode === 'interstitial';

  // Clock, plus the between-calls timer.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(new Date());
      if (!interstitialMode || interstitial || flash) return;
      if (Date.now() - lastActivity.current >= config.media.everySeconds * 1000) {
        const item = media[mediaCursor.current % media.length];
        mediaCursor.current += 1;
        setInterstitial(item);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [interstitialMode, interstitial, flash, media, config.media.everySeconds]);

  const endInterstitial = useCallback(() => {
    lastActivity.current = Date.now();
    setInterstitial(null);
  }, []);

  useEffect(() => {
    if (!interstitialMode) setInterstitial(null);
  }, [interstitialMode]);

  const advanceSplit = useCallback(() => {
    setSplitIndex((i) => (media.length ? (i + 1) % media.length : 0));
    setSplitCycle((c) => c + 1);
  }, [media.length]);

  // ---- chrome ----

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen?.();
    else document.exitFullscreen?.();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Controls and cursor fade out when nobody's touching the screen.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setControlsVisible(true);
      clearTimeout(t);
      t = setTimeout(() => setControlsVisible(false), 4000);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('touchstart', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('touchstart', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  // ---- render ----

  if (notFound) {
    return (
      <div className={styles.screen} data-theme="dark">
        <div className={styles.centerMessage}>
          <h1>Display not found</h1>
          <p>There’s no location with the code <code>{locationParam}</code>. Open the screen link from Admin → Display screens, or check the address.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.screen} data-theme="dark">
        <div className={styles.centerMessage}><div className={styles.spinner} aria-label="Loading" /></div>
      </div>
    );
  }

  const accent = location?.organization?.primaryColor || '#0f9fa4';
  const terms = termsFor(location?.organization);
  const joinCode = location?.publicCode;
  const joinUrl = joinCode && typeof window !== 'undefined' ? `${window.location.origin}/join/${joinCode}` : null;
  const pickedLane = swimlanes.find((s) => s.queueId === selectedQueueId);
  // One service: give it the whole screen rather than one wide card.
  const selectedLane = pickedLane || (swimlanes.length === 1 && viewMode === 'services' ? swimlanes[0] : undefined);
  const waitingTotal = swimlanes.reduce((n, l) => n + l.stats.waiting, 0);
  const tickerText = config.ticker.enabled ? config.ticker.messages : [];
  const tickerChars = tickerText.join('   ').length || 1;
  const tickerDuration = Math.max(20, tickerChars * TICKER_SECONDS_PER_CHAR[config.ticker.speed]);
  const splitItem = splitMode ? media[splitIndex % media.length] : null;

  const laneView = (
    swimlanes.length === 0 ? (
      <div className={styles.empty}>
        <h2>No queues are open right now</h2>
        {joinUrl && <p>You can still scan the code to see today’s services.</p>}
      </div>
    ) : (
      <div className={styles.lanes} data-count={Math.min(swimlanes.length, 6)}>
        {swimlanes.map((lane) => {
          const lastWait = lane.waitingList[lane.waitingList.length - 1]?.estimatedWait;
          return (
            <button
              key={lane.serviceId}
              type="button"
              className={styles.lane}
              onClick={() => { if (lane.queueId) { setSelectedQueueId(lane.queueId); setViewMode('single'); } }}
            >
              <div className={styles.laneHead}>
                <h2>{lane.serviceName}</h2>
                <span>
                  {lane.stats.waiting === 0 ? 'No wait' : `${lane.stats.waiting} waiting`}
                  {lane.stats.waiting > 0 && lane.estimatedWaitPerPerson > 0 && ` · ${formatWait(lastWait || lane.estimatedWaitPerPerson * lane.stats.waiting)}`}
                </span>
              </div>
              {lane.currentlyServing.length > 0 ? (
                <ul className={styles.serving}>
                  {lane.currentlyServing.map((e) => (
                    <li key={e.id} data-recent={recentKey === e.id}>
                      <b>{e.ticketNumber}</b>
                      <span className={styles.servingWho}>
                        {e.customerName && <span>{e.customerName}</span>}
                        {(e.servicePoint || e.staffName) && <small>{whereWith(e.staffName, e.servicePoint)}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.laneIdle}>Ready for the next {terms.person}</p>
              )}
              {lane.waitingList.length > 0 && (
                <div className={styles.next}>
                  <span>Next</span>
                  {lane.waitingList.slice(0, 5).map((e) => <i key={e.id}>{e.ticketNumber}</i>)}
                  {lane.waitingList.length > 5 && <em>+{lane.waitingList.length - 5}</em>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    )
  );

  const deskView = (
    servicePoints.length === 0 ? (
      <div className={styles.empty}>
        <h2>No desks or rooms are set up</h2>
        <p>Add them under Setup → Desks &amp; rooms.</p>
      </div>
    ) : (
      <div className={styles.desks}>
        {servicePoints.map((sp) => (
          <div key={sp.id} className={styles.desk} data-active={!!sp.currentlyServing}>
            <h2>{sp.displayName || sp.name}</h2>
            {sp.currentlyServing ? (
              <>
                <b>{sp.currentlyServing.ticketNumber}</b>
                {sp.currentlyServing.customerName && <span>{sp.currentlyServing.customerName}</span>}
                <small>{whereWith(sp.currentlyServing.staffName, sp.currentlyServing.serviceName)}</small>
              </>
            ) : (
              <p>Ready</p>
            )}
          </div>
        ))}
      </div>
    )
  );

  const singleView = selectedLane && (
    <div className={styles.single}>
      {pickedLane && swimlanes.length > 1 && (
        <button type="button" className={styles.back} onClick={() => { setViewMode('services'); setSelectedQueueId(null); }}>
          <ChevronLeft size={20} /> All services
        </button>
      )}
      <section>
        <h2 className={styles.sectionLabel}>Now serving</h2>
        {selectedLane.currentlyServing.length > 0 ? (
          <div className={styles.bigTickets}>
            {selectedLane.currentlyServing.map((e) => (
              <div key={e.id} className={styles.bigTicket} data-recent={recentKey === e.id}>
                <b>{e.ticketNumber}</b>
                {e.customerName && <span>{e.customerName}</span>}
                {(e.servicePoint || e.staffName) && <small>{whereWith(e.staffName, e.servicePoint)}</small>}
              </div>
            ))}
          </div>
        ) : <p className={styles.laneIdle}>Ready for the next {terms.person}</p>}
      </section>
      <section>
        <h2 className={styles.sectionLabel}>
          {selectedLane.stats.waiting === 0 ? 'Nobody waiting' : `Next · ${selectedLane.stats.waiting} waiting`}
        </h2>
        <ol className={styles.waitList}>
          {selectedLane.waitingList.map((e) => (
            <li key={e.id}><span>{e.position}</span><b>{e.ticketNumber}</b>{e.customerName && <em>{e.customerName}</em>}</li>
          ))}
        </ol>
      </section>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={styles.screen}
      data-theme={theme}
      data-idle={!controlsVisible}
      style={{ '--accent': accent } as React.CSSProperties}
    >
      <header className={styles.header}>
        <div className={styles.brand}>
          {location?.organization?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={location.organization.logoUrl} alt="" />
          )}
          <div>
            <h1>{location?.name || 'Queue'}</h1>
            <p>{selectedLane ? selectedLane.serviceName : waitingTotal > 0 ? `${waitingTotal} waiting` : location?.organization?.name}</p>
          </div>
        </div>
        <div className={styles.headerRight}>
          {joinUrl && (
            <div className={styles.join}>
              <span>Scan to join<br />the queue</span>
              <QrCode value={joinUrl} size={64} className={styles.joinQr} label="QR code to join the queue" />
            </div>
          )}
          <div className={styles.clock}>
            <b>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
            <span>{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          </div>
        </div>
      </header>

      <div className={styles.body} data-split={splitMode}>
        <main className={styles.main}>
          {offline && <div className={styles.offline}>Reconnecting…</div>}
          {viewMode !== 'desks' && selectedLane ? singleView : viewMode === 'desks' ? deskView : laneView}
        </main>
        {splitItem && (
          <aside className={styles.split} aria-label={splitItem.title}>
            <MediaPlayer key={`${splitItem.id}:${splitCycle}`} item={splitItem} muted={!audioEnabled} fit="contain" onDone={advanceSplit} />
          </aside>
        )}
      </div>

      {(tickerText.length > 0 || !location?.organization?.hidePoweredBy) && (
        <footer className={styles.ticker}>
          {tickerText.length > 0 ? (
            <div className={styles.tickerTrack} style={{ animationDuration: `${tickerDuration}s` }}>
              {[0, 1].map((copy) => (
                <span key={copy} aria-hidden={copy === 1}>
                  {tickerText.map((m, i) => <span key={i} className={styles.tickerItem}>{m}</span>)}
                </span>
              ))}
            </div>
          ) : <div />}
          {!location?.organization?.hidePoweredBy && <span className={styles.powered}>{APP_NAME}</span>}
        </footer>
      )}

      {interstitial && (
        <div className={styles.interstitial}>
          <MediaPlayer key={interstitial.id + mediaCursor.current} item={interstitial} muted={!audioEnabled} fit="contain" onDone={endInterstitial} />
          {calls.length > 0 && (
            <div className={styles.interstitialCalls}>
              <span>Now serving</span>
              {calls.slice(0, 4).map((c) => <b key={c.key}>{c.ticketNumber}{c.where && <small> {c.where}</small>}</b>)}
            </div>
          )}
        </div>
      )}

      {flash && (
        <div className={styles.flash} role="alert" key={flash.key}>
          <p>Now calling</p>
          <b>{flash.ticketNumber}</b>
          {flash.customerName && <span className={styles.flashName}>{flash.customerName}</span>}
          <span className={styles.flashWhere}>{flash.where ? <>Please go to <strong>{flash.where}</strong>{flash.staffName && <> to see <strong>{flash.staffName}</strong></>}</> : flash.staffName || flash.serviceName}</span>
        </div>
      )}

      <div className={styles.controls} data-visible={controlsVisible}>
        <button type="button" aria-pressed={viewMode !== 'desks'} onClick={() => { setViewMode('services'); setSelectedQueueId(null); }} title="By service"><LayoutGrid size={20} /></button>
        <button type="button" aria-pressed={viewMode === 'desks'} onClick={() => { setViewMode('desks'); setSelectedQueueId(null); }} title="By desk"><Users size={20} /></button>
        <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? 'Light screen' : 'Dark screen'}>
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        <button type="button" aria-pressed={audioEnabled} onClick={() => setAudioEnabled(!audioEnabled)} title={audioEnabled ? 'Mute announcements and video' : 'Turn on announcements and video sound'}>
          {audioEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
        </button>
        <button type="button" onClick={toggleFullscreen} title={isFullscreen ? 'Exit full screen' : 'Full screen'}>
          {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
        </button>
      </div>
    </div>
  );
}
