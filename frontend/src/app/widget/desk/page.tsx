'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, LogOut, Repeat } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import DeskPanel, { useDeskShortcuts } from '@/components/desk/DeskPanel';
import DeskPicker from '@/components/desk/DeskPicker';
import DeskBar from '@/components/desk/DeskBar';
import { useDesk, type DeskEntryEvent } from '@/components/desk/useDesk';
import {
  CONTRACT,
  clearLaunch,
  deskLayoutFrom,
  isLogoutRequest,
  postToHost,
  readLaunch,
  resizeReporter,
  roomTypesFrom,
  roomTypesRequest,
  saveLaunch,
  withoutLaunchCode,
  type DeskLaunch,
  type DeskLayout,
  type DeskMessage,
  type RoomType,
} from '@/components/desk/connectBridge';
import { extractSubdomain } from '@/lib/subdomain';

/**
 * The desk on its own: for the pop-out window in browsers without
 * Picture-in-Picture, for embedding in other apps (see /embed/desk.js), for
 * installing as a small app from the browser menu, and inside an EMR through
 * Klargy Connect (opened with ?launch=<code>, docs/connect/v1.md section 6).
 * `?layout=bar` lays it out as one compact bar for a host's floating
 * toolbar; the bar reports the height it needs with klargy:resize.
 * `?roomTypes=consultation,triage` (and the klargy:room-types message)
 * limits the room picker to those kinds of room.
 */

function WidgetSignIn() {
  const { login } = useAuthContext();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const slug = extractSubdomain(window.location.host);
      await login(email, password, slug && slug !== 'admin' ? { slug } : undefined);
    } catch {
      setError('That email and password don’t match an account here.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="widget-signin" onSubmit={submit}>
      <h1>Sign in to your desk</h1>
      <label className="settings-field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
      <label className="settings-field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      {error && <p className="desk-msg desk-msg-bad" role="alert">{error}</p>}
      <button type="submit" className="desk-call" disabled={busy}>{busy ? <Loader2 size={18} className="qf-spin" /> : null}<span>Sign in</span></button>
    </form>
  );
}

const parentWindow = () => (typeof window !== 'undefined' && window.parent !== window ? window.parent : null);

function WidgetDesk({ launch, layout, onSignedOut }: { launch: DeskLaunch | null; layout: DeskLayout; onSignedOut: () => void }) {
  const { logout, isStaff } = useAuthContext();
  // The kinds of room the EMR offers here: from the URL (`roomTypes=`), then
  // from klargy:room-types whenever the practitioner moves to another area.
  const [roomTypes, setRoomTypes] = useState<RoomType[]>(() => (typeof window !== 'undefined' ? roomTypesFrom(window.location.search) : []));

  const post = useCallback((message: DeskMessage) => postToHost(parentWindow(), launch, message), [launch]);

  // Klargy Connect: pass the entry, with the EMR's ids, to the EMR.
  const onEntryEvent = useCallback((kind: DeskEntryEvent, entryId: string) => {
    if (!launch) return;
    api.getLaunchEntry(launch.launchId, entryId)
      .then(({ entry }) => post({ type: kind === 'called' ? 'klargy:entry-called' : 'klargy:entry-updated', entry }))
      .catch(() => { /* the EMR also gets the webhook */ });
  }, [launch, post]);

  const desk = useDesk({ onEntryEvent });
  useDeskShortcuts(desk, null);
  const instanceId = desk.desk?.instanceId ?? null;
  const deskRef = useRef(desk);
  useEffect(() => { deskRef.current = desk; });

  const announced = useRef(false);
  useEffect(() => {
    if (!launch || announced.current) return;
    announced.current = true;
    post({ type: 'klargy:ready', contract: CONTRACT });
  }, [launch, post]);

  // Which room the practitioner is in, once known and whenever it changes.
  const lastRoom = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!launch || !desk.ready) return;
    const key = instanceId ?? 'none';
    if (lastRoom.current === key) return;
    lastRoom.current = key;
    if (!instanceId) {
      post({ type: 'klargy:desk-changed', servicePoint: null });
      return;
    }
    api.getLaunchDesk(launch.launchId, instanceId)
      .then(({ servicePoint }) => { if (lastRoom.current === key) post({ type: 'klargy:desk-changed', servicePoint }); })
      .catch(() => { /* not this organisation's desk any more */ });
  }, [launch, desk.ready, instanceId, post]);

  const waitingCount = desk.data ? desk.waiting.length : null;
  const lastWaiting = useRef<string | null>(null);
  useEffect(() => {
    document.title = desk.waiting.length ? `(${desk.waiting.length}) Desk` : 'Desk';
    const parent = parentWindow();
    if (!launch) {
      // The /embed/desk.js button shows the count.
      parent?.postMessage({ type: 'qms-desk', waiting: desk.waiting.length }, '*');
      return;
    }
    if (!instanceId || waitingCount === null) return;
    const key = `${instanceId}:${waitingCount}`;
    if (lastWaiting.current === key) return;
    lastWaiting.current = key;
    post({ type: 'klargy:waiting', count: waitingCount });
  }, [desk.waiting.length, waitingCount, instanceId, launch, post]);

  const signOut = useCallback(async () => {
    await deskRef.current.leave();
    if (launch && lastRoom.current !== 'none') {
      lastRoom.current = 'none';
      post({ type: 'klargy:desk-changed', servicePoint: null });
    }
    clearLaunch();
    logout();
    if (launch) onSignedOut();
  }, [launch, logout, onSignedOut, post]);

  // The EMR signs the practitioner out of the desk with them.
  useEffect(() => {
    if (!launch) return;
    const onMessage = (e: MessageEvent) => {
      if (isLogoutRequest(e, launch, parentWindow())) {
        signOut();
        return;
      }
      const types = roomTypesRequest(e, launch, parentWindow());
      if (types) setRoomTypes((current) => (current.join(',') === types.join(',') ? current : types));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [launch, signOut]);

  if (!isStaff) {
    return <div className="widget-msg"><p>This account can’t call from a desk. Ask an admin for staff access.</p><button type="button" className="link-button" onClick={signOut}>Sign out</button></div>;
  }
  if (!desk.ready) return <div className="widget-msg"><Loader2 className="qf-spin" /></div>;
  if (layout === 'bar') return <DeskBar desk={desk} onSignOut={signOut} preferServicePointId={launch?.servicePointId ?? null} roomTypes={roomTypes} />;
  if (!desk.desk) return <DeskPicker desk={desk} compact preferServicePointId={launch?.servicePointId ?? null} roomTypes={roomTypes} />;

  return (
    <>
      <header className="widget-head">
        <div>
          <strong>{desk.desk.label}</strong>
          <span>{desk.desk.serviceName}</span>
        </div>
        <button type="button" onClick={desk.leave} title="Switch desk" aria-label="Switch desk"><Repeat size={16} /></button>
        <button type="button" onClick={signOut} title="Leave desk and sign out" aria-label="Leave desk and sign out"><LogOut size={16} /></button>
      </header>
      <DeskPanel desk={desk} compact patientCard={!!launch} />
    </>
  );
}

type LaunchState =
  | { status: 'checking' | 'exchanging' | 'failed' | 'signed-out' }
  | { status: 'none' }
  | { status: 'ready'; launch: DeskLaunch };

export default function WidgetDeskPage() {
  const { isAuthenticated, loading, signInWithLaunch } = useAuthContext();
  const [state, setState] = useState<LaunchState>({ status: 'checking' });
  const [layout, setLayout] = useState<DeskLayout>('default');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    // Read from the address, which keeps it after the code is removed.
    setLayout(deskLayoutFrom(window.location.search));
    const code = params.get('launch');
    if (!code) {
      const stored = readLaunch();
      setState(stored ? { status: 'ready', launch: stored } : { status: 'none' });
      return;
    }
    // The code works once: a reload must not send it again.
    window.history.replaceState(null, '', `${window.location.pathname}${withoutLaunchCode(window.location.search)}${window.location.hash}`);
    setState({ status: 'exchanging' });
    signInWithLaunch(code)
      .then((launch) => {
        saveLaunch(launch);
        setState({ status: 'ready', launch });
      })
      .catch(() => {
        clearLaunch();
        setState({ status: 'failed' });
      });
  }, [signInWithLaunch]);

  const onSignedOut = useCallback(() => setState({ status: 'signed-out' }), []);
  const launch = state.status === 'ready' ? state.launch : null;

  // The bar tells the host how tall it needs to be (row only, or with a
  // menu open), including after signing out, so the host can size the frame.
  const main = useRef<HTMLElement | null>(null);
  const [reportTo, setReportTo] = useState<DeskLaunch | null>(null);
  if (launch && launch !== reportTo) setReportTo(launch);
  useEffect(() => {
    const el = main.current;
    if (layout !== 'bar' || !reportTo || !el || typeof ResizeObserver === 'undefined') return;
    const report = resizeReporter((message) => postToHost(parentWindow(), reportTo, message));
    const measure = () => report(el.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [layout, reportTo]);

  let body: React.ReactNode;
  if (state.status === 'checking' || state.status === 'exchanging' || (loading && state.status !== 'failed')) {
    body = <div className="widget-msg"><Loader2 className="qf-spin" /></div>;
  } else if (state.status === 'failed') {
    body = <div className="widget-msg"><p>This desk link has expired or was already used. Open the desk again from your records system.</p></div>;
  } else if (state.status === 'signed-out') {
    body = <div className="widget-msg"><p>You’ve left the desk and signed out.</p></div>;
  } else if (isAuthenticated) {
    body = <WidgetDesk launch={launch} layout={layout} onSignedOut={onSignedOut} />;
  } else if (launch) {
    // Opened from an EMR, and the session has ended: only the EMR can sign
    // this person in again.
    body = <div className="widget-msg"><p>Your desk session has ended. Open the desk again from your records system.</p></div>;
  } else {
    body = <WidgetSignIn />;
  }

  return <main ref={main} className="widget" data-layout={layout}>{body}</main>;
}
