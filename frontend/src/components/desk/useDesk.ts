'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSocket } from '@/hooks/useSocket';
import { useTerms } from '@/hooks/useTerms';

/**
 * Everything a staff member needs at a desk: which desk they're signed in
 * to, who they're serving, who's waiting, and the actions. Shared by the
 * full console, the pop-out window and the embeddable widget. Windows on
 * the same origin stay in step through localStorage + BroadcastChannel.
 */

export interface DeskSelection {
  instanceId: string;
  serviceId: string;
  locationId: string;
  label: string;
  serviceName: string;
  userId: string;
}

export interface DeskEntry {
  id: string;
  ticketNumber: string;
  status: string;
  joinedAt: string;
  calledAt?: string | null;
  priority?: number;
  servicePointInstanceId?: string | null;
  servicePoint?: { id: string; name: string; displayName?: string | null } | null;
  servicePointInstance?: { instanceNumber?: number; displayName?: string | null } | null;
  /** On hold: off the desk, at the front of the line, called back by hand. */
  heldAt?: string | null;
  /** Waiting for payment (a service that requires clearance): not callable. */
  awaitingClearance?: boolean;
  /** The desk they belong with (held there, or returning to it). */
  deskInstanceId?: string | null;
  /** A booked patient: their appointment time; bookedPlaceAt is set when
   * they arrived on time and are placed in line by it. */
  bookedFor?: string | null;
  bookedPlaceAt?: string | null;
  user?: { id: string; firstName: string; lastName: string; phone?: string | null } | null;
}

export interface NextService {
  serviceId: string;
  serviceName: string;
  displayName: string;
  isRequired?: boolean;
  autoTransfer?: boolean;
}

interface OperatorData {
  queue: { id: string; status: string };
  serving: DeskEntry[];
  waiting: DeskEntry[];
  nextServices: NextService[];
}

export interface DeskInstance {
  id: string;
  servicePointId?: string;
  /** RECEPTION, TRIAGE, CONSULTATION, CASHIER, PHARMACY, LAB, IMAGING or OTHER. */
  servicePointType?: string;
  instanceNumber: number;
  displayName: string | null;
  servicePointName: string;
  servicePointCapacity?: number;
  isOccupied: boolean;
  occupiedBy?: { id: string; firstName: string; lastName: string } | null;
  currentService: { id: string; name: string } | null;
}

const KEY = 'qms_desk';
const CHANNEL = 'qms-desk';

export const deskLabel = (inst: DeskInstance) =>
  inst.displayName || ((inst.servicePointCapacity ?? 1) > 1 ? `${inst.servicePointName} ${inst.instanceNumber}` : inst.servicePointName);

export const personName = (e?: DeskEntry | null) =>
  e?.user ? `${e.user.firstName} ${e.user.lastName}`.trim() : '';

export const isCallable = (e: DeskEntry) => !e.heldAt && !e.awaitingClearance;

/** "Booked 10:30" for a booked patient (in this device's time), else ''. */
export const bookedLabel = (e?: DeskEntry | null) =>
  e?.bookedFor ? `Booked ${new Date(e.bookedFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}` : '';

/** Tooltip for the booked chip: placed by booked time, or arrived outside the window. */
export const bookedTitle = (e?: DeskEntry | null) =>
  !e?.bookedFor ? '' : e.bookedPlaceAt ? 'Arrived on time: placed in line by their booked time' : 'Arrived outside their appointment window: in line by arrival';

export const minutesAgo = (iso?: string | null) =>
  iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : 0;

function readStored(userId?: string): DeskSelection | null {
  try {
    const raw = localStorage.getItem(KEY);
    const desk = raw ? (JSON.parse(raw) as DeskSelection) : null;
    return desk && (!userId || desk.userId === userId) ? desk : null;
  } catch {
    return null;
  }
}

function errorText(err: unknown, fallback: string) {
  const e = err as { response?: { data?: { error?: string; message?: string } } };
  return e?.response?.data?.error || e?.response?.data?.message || fallback;
}

/** What the practitioner just did to an entry, for a host app (Klargy
 * Connect): `called` when they called someone, `updated` when an entry was
 * served, sent on, cancelled, marked as not here, put on hold or called back
 * from hold. */
export type DeskEntryEvent = 'called' | 'updated';

export interface UseDeskOptions {
  onEntryEvent?: (kind: DeskEntryEvent, entryId: string) => void;
}

export function useDesk(options: UseDeskOptions = {}) {
  const { user } = useAuthContext();
  const onEntryEvent = useRef(options.onEntryEvent);
  useEffect(() => { onEntryEvent.current = options.onEntryEvent; });
  const report = useCallback((kind: DeskEntryEvent, entryId?: string | null) => {
    if (entryId) onEntryEvent.current?.(kind, entryId);
  }, []);
  const terms = useTerms();
  const { joinQueue, leaveQueue, onQueueUpdated, onEntryStatusChanged } = useSocket();

  const [desk, setDesk] = useState<DeskSelection | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<OperatorData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [afterComplete, setAfterComplete] = useState<{ entry: DeskEntry; nextServices: NextService[] } | null>(null);

  const channel = useRef<BroadcastChannel | null>(null);
  const queueIdRef = useRef<string | null>(null);

  // Restore the desk this person was signed in to.
  useEffect(() => {
    if (!user) return;
    setDesk(readStored(user.id));
    setReady(true);
  }, [user]);

  const refresh = useCallback(async () => {
    const id = queueIdRef.current;
    if (!id) return;
    try {
      setData(await api.getQueueForOperator(id));
    } catch (err) {
      setError(errorText(err, 'Couldn’t refresh the queue.'));
    }
  }, []);

  // Load today's queue for the desk's service.
  useEffect(() => {
    if (!desk) {
      setData(null);
      queueIdRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const queue = await api.createQueue(desk.serviceId);
        if (cancelled) return;
        queueIdRef.current = queue.id;
        await refresh();
      } catch (err) {
        if (!cancelled) setError(errorText(err, 'Couldn’t open today’s queue.'));
      }
    })();
    return () => { cancelled = true; };
  }, [desk, refresh]);

  // Live updates, plus a nudge from other windows of this app.
  useEffect(() => {
    const id = data?.queue.id;
    if (!id) return;
    joinQueue(id);
    const offA = onQueueUpdated(() => refresh());
    const offB = onEntryStatusChanged(() => refresh());
    return () => { offA(); offB(); leaveQueue(id); };
  }, [data?.queue.id, joinQueue, leaveQueue, onQueueUpdated, onEntryStatusChanged, refresh]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(CHANNEL);
    channel.current = bc;
    bc.onmessage = (ev) => {
      if (ev.data === 'refresh') refresh();
      if (ev.data === 'desk') setDesk(readStored(user?.id));
    };
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setDesk(readStored(user?.id)); };
    window.addEventListener('storage', onStorage);
    return () => { bc.close(); window.removeEventListener('storage', onStorage); };
  }, [refresh, user?.id]);

  const nudge = () => channel.current?.postMessage('refresh');

  const mine = useMemo(
    () => (data?.serving || []).filter((e) => e.servicePointInstanceId === desk?.instanceId),
    [data, desk?.instanceId]
  );
  const current = mine[0] || null;
  const waiting = useMemo(() => data?.waiting || [], [data]);
  // Who "Call next" can pick: not on hold and not waiting for payment.
  const callable = useMemo(() => waiting.filter((e) => isCallable(e)), [waiting]);
  const otherDesks = (data?.serving || []).filter((e) => e.servicePointInstanceId !== desk?.instanceId);

  // Tell people who've switched to another app that someone is waiting.
  const lastWaiting = useRef<number | null>(null);
  useEffect(() => {
    const n = waiting.length;
    const prev = lastWaiting.current;
    lastWaiting.current = n;
    if (prev === null || n <= prev || !desk) return;
    if (typeof document !== 'undefined' && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const note = new Notification(`${n} ${n === 1 ? terms.person : terms.people} waiting`, {
        body: `${desk.serviceName} · ${desk.label}`,
        tag: 'qms-desk',
      });
      note.onclick = () => { window.focus(); note.close(); };
    }
  }, [waiting.length, desk, terms]);

  const run = useCallback(async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try {
      await fn();
      await refresh();
      nudge();
    } catch (err) {
      setError(errorText(err, 'That didn’t work. Try again.'));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const signIn = useCallback(async (inst: DeskInstance, locationId: string, takeOver = false) => {
    if (!user || !inst.currentService) return;
    setBusy('signin');
    setError('');
    try {
      if (desk && desk.instanceId !== inst.id) await api.vacateServicePointInstance(desk.instanceId).catch(() => {});
      await api.activateServicePointInstance(inst.id, inst.currentService.id, takeOver);
      const next: DeskSelection = {
        instanceId: inst.id,
        serviceId: inst.currentService.id,
        locationId,
        label: deskLabel(inst),
        serviceName: inst.currentService.name,
        userId: user.id,
      };
      localStorage.setItem(KEY, JSON.stringify(next));
      setDesk(next);
      channel.current?.postMessage('desk');
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e?.response?.status === 409) throw err;
      setError(errorText(err, 'Couldn’t sign in to that desk.'));
    } finally {
      setBusy(null);
    }
  }, [desk, user]);

  const leave = useCallback(async () => {
    if (!desk) return;
    setBusy('leave');
    try { await api.vacateServicePointInstance(desk.instanceId); } catch { /* already free */ }
    localStorage.removeItem(KEY);
    setDesk(null);
    setAfterComplete(null);
    channel.current?.postMessage('desk');
    setBusy(null);
  }, [desk]);

  const queueId = data?.queue.id;

  const callNext = useCallback((entryId?: string) => run('call', async () => {
    if (!queueId || !desk) return;
    setAfterComplete(null);
    // Calling back someone on hold is a resume: the host hears entry-updated
    // (as for the hold), not a new call.
    const wasHeld = !!entryId && !!data?.waiting.find((e) => e.id === entryId)?.heldAt;
    const called = await api.callNextWithServicePoint(queueId, desk.instanceId, entryId);
    report(wasHeld ? 'updated' : 'called', called?.id);
  }), [run, queueId, desk, report, data]);

  const recall = useCallback(() => run('recall', async () => {
    if (!queueId || !current) return;
    await api.recallEntry(queueId, current.id);
    setNotice(`Called ${current.ticketNumber} again.`);
  }), [run, queueId, current]);

  const complete = useCallback(() => run('complete', async () => {
    if (!queueId || !current) return;
    const entry = current;
    const result = await api.completeEntryWithSuggestions(queueId, entry.id);
    report('updated', entry.id);
    if (result.autoTransferred) {
      report('updated', result.nextTicket?.entryId);
      setNotice(`${personName(entry) || entry.ticketNumber} was sent on to ${result.nextTicket?.serviceName} as ${result.nextTicket?.ticketNumber}.`);
    } else if (result.nextServices?.length) {
      setAfterComplete({ entry, nextServices: result.nextServices });
    }
  }), [run, queueId, current, report]);

  const sendTo = useCallback((service: NextService) => run('send', async () => {
    if (!queueId || !afterComplete) return;
    const result = await api.transferEntry(queueId, afterComplete.entry.id, service.serviceId);
    report('updated', result.entry?.id);
    setNotice(`${personName(afterComplete.entry) || afterComplete.entry.ticketNumber} is now ${result.ticketNumber} at ${result.serviceName || service.displayName}.`);
    setAfterComplete(null);
  }), [run, queueId, afterComplete, report]);

  // Send the person being served straight on to another service (their
  // ticket here is finished and they get a new one there).
  const transfer = useCallback((service: { serviceId: string; displayName: string }) => run('transfer', async () => {
    if (!queueId || !current) return;
    const entry = current;
    const result = await api.transferEntry(queueId, entry.id, service.serviceId);
    report('updated', entry.id);
    report('updated', result.entry?.id);
    setNotice(`${personName(entry) || entry.ticketNumber} is now ${result.ticketNumber} at ${result.serviceName || service.displayName}.`);
  }), [run, queueId, current, report]);

  // Take the person being served off the desk for now (waiting for a result,
  // a relative): they stay at the front, and the desk can call the next one.
  const hold = useCallback(() => run('hold', async () => {
    if (!queueId || !current) return;
    const entry = current;
    await api.holdEntry(queueId, entry.id);
    report('updated', entry.id);
    setNotice(`${personName(entry) || entry.ticketNumber} is on hold. Call them back from the waiting list when they’re ready.`);
  }), [run, queueId, current, report]);

  // Someone waiting for payment has paid (cashier, or a staff member checked).
  const clear = useCallback((entry: DeskEntry) => run('clear', async () => {
    if (!queueId) return;
    await api.clearEntry(queueId, entry.id);
    setNotice(`${personName(entry) || entry.ticketNumber} is marked as paid and can be called.`);
  }), [run, queueId]);

  const noShow = useCallback(() => run('noshow', async () => {
    if (!queueId || !current) return;
    await api.markNoShow(queueId, current.id);
    report('updated', current.id);
    setNotice(`${current.ticketNumber} marked as not here.`);
  }), [run, queueId, current, report]);

  // Someone served at another desk (or no desk) who was never finished.
  const finishOther = useCallback((entry: DeskEntry) => run('finish', async () => {
    if (!queueId) return;
    await api.completeEntryWithSuggestions(queueId, entry.id);
    report('updated', entry.id);
    setNotice(`${entry.ticketNumber} marked as done.`);
  }), [run, queueId, report]);

  const reorder = useCallback((ids: string[]) => run('reorder', async () => {
    if (!queueId) return;
    await api.reorderQueueEntries(queueId, ids.map((id, i) => ({ id, sortOrder: i + 1 })));
  }), [run, queueId]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  return {
    ready, desk, data, current, waiting, callable, otherDesks, busy, error, notice, afterComplete, terms,
    setError, dismissAfterComplete: () => setAfterComplete(null),
    signIn, leave, callNext, recall, complete, sendTo, transfer, hold, clear, noShow, reorder, refresh, finishOther,
  };
}

export type Desk = ReturnType<typeof useDesk>;
