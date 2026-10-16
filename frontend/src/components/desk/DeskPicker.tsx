'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { DoorOpen, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import type { Desk, DeskInstance } from './useDesk';
import { deskLabel } from './useDesk';
import { confirmDialog } from '@/lib/dialog';

interface LocationRow { id: string; name: string }

export interface DeskRoomGroup { name: string; items: DeskInstance[] }

/** The desks and rooms the practitioner can sign in to, grouped by
 * service, and signing in to one (asking before taking over someone's).
 * Shared by the picker and the bar layout of the desk widget. A host app
 * (Klargy Connect) can name the room to suggest: its location is opened and
 * its desks come first. */
export function useDeskRooms(desk: Desk, preferServicePointId: string | null = null) {
  const { user } = useAuthContext();
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [instances, setInstances] = useState<DeskInstance[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const currentLocationId = desk.desk?.locationId ?? null;

  useEffect(() => {
    const organizationId = user?.organizationId;
    if (!organizationId) return;
    let cancelled = false;
    (async () => {
      try {
        const locs: LocationRow[] = await api.getLocations(organizationId);
        if (cancelled) return;
        setLocations(locs);
        let saved: string | null = currentLocationId;
        if (!saved) {
          try { saved = localStorage.getItem('qms_operator_location'); } catch { /* private mode */ }
        }
        const ordered = [...locs.filter((l) => l.id === saved), ...locs.filter((l) => l.id !== saved)];
        let chosen = ordered[0]?.id || '';
        // The suggested room may be at another location: open that one.
        if (preferServicePointId && !currentLocationId && locs.length > 1) {
          for (const loc of ordered) {
            const found: DeskInstance[] = await api.getLocationInstances(loc.id).catch(() => []);
            if (cancelled) return;
            if (found.some((i) => i.servicePointId === preferServicePointId)) { chosen = loc.id; break; }
          }
        }
        setLocationId(chosen);
        if (!locs.length) setInstances([]);
      } catch {
        if (!cancelled) setInstances([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.organizationId, preferServicePointId, currentLocationId]);

  const load = useCallback((id: string) => {
    setInstances(null);
    api.getLocationInstances(id).then(setInstances).catch(() => setInstances([]));
  }, []);

  useEffect(() => {
    if (!locationId) return;
    try { localStorage.setItem('qms_operator_location', locationId); } catch { /* private mode */ }
    load(locationId);
  }, [locationId, load]);

  const groups = useMemo<DeskRoomGroup[]>(() => {
    const byService = new Map<string, DeskRoomGroup>();
    (instances || []).forEach((inst) => {
      if (!inst.currentService) return;
      const g = byService.get(inst.currentService.id) || { name: inst.currentService.name, items: [] };
      g.items.push(inst);
      byService.set(inst.currentService.id, g);
    });
    const groups = [...byService.values()];
    if (!preferServicePointId) return groups;
    const hasPreferred = (g: DeskRoomGroup) => g.items.some((i) => i.servicePointId === preferServicePointId);
    return [...groups.filter(hasPreferred), ...groups.filter((g) => !hasPreferred(g))];
  }, [instances, preferServicePointId]);

  // The first free (or already yours) desk of the suggested room.
  const suggestedId = useMemo(() => {
    if (!preferServicePointId) return null;
    const all = groups.flatMap((g) => g.items).filter((i) => i.servicePointId === preferServicePointId);
    return (all.find((i) => i.occupiedBy?.id === user?.id) || all.find((i) => !i.isOccupied) || all[0])?.id ?? null;
  }, [groups, preferServicePointId, user?.id]);

  const choose = async (inst: DeskInstance) => {
    setProblem('');
    const taken = inst.isOccupied && inst.occupiedBy && inst.occupiedBy.id !== user?.id;
    if (taken && !(await confirmDialog({ title: 'Take over this desk?', message: `${inst.occupiedBy!.firstName} ${inst.occupiedBy!.lastName} is signed in to ${deskLabel(inst)}. Taking over signs them out of it.`, confirmLabel: 'Take over' }))) return;
    setPending(inst.id);
    try {
      await desk.signIn(inst, locationId, !!taken);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setProblem(e?.response?.data?.error || 'That desk is in use.');
      load(locationId);
    } finally {
      setPending(null);
    }
  };

  return { userId: user?.id ?? null, locations, locationId, setLocationId, instances, groups, suggestedId, pending, problem, choose };
}

export type DeskRooms = ReturnType<typeof useDeskRooms>;

/** "Where are you working today?" Desks grouped by service, with the
 * suggested room's first free desk focused. */
export default function DeskPicker({ desk, compact = false, preferServicePointId = null }: { desk: Desk; compact?: boolean; preferServicePointId?: string | null }) {
  const { isAdmin } = useAuthContext();
  const { userId, locations, locationId, setLocationId, instances, groups, suggestedId, pending, problem, choose } = useDeskRooms(desk, preferServicePointId);
  const suggested = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { suggested.current?.focus(); }, [suggestedId]);

  return (
    <div className="desk-picker" data-compact={compact}>
      <div className="desk-picker-head">
        <h2>Where are you working?</h2>
        {locations.length > 1 && (
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Location">
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>

      {instances === null ? (
        <div className="desk-picker-loading"><Loader2 className="qf-spin" size={20} /> Loading desks…</div>
      ) : groups.length === 0 ? (
        <div className="desk-picker-empty">
          <DoorOpen size={22} />
          <p>No desks or rooms are set up here yet.{isAdmin && <> <Link href="/admin/service-points">Add one</Link> to start calling.</>}</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.name} className="desk-picker-group">
            <h3>{g.name}</h3>
            <div className="desk-picker-grid">
              {g.items.map((inst) => {
                const mineAlready = !!userId && inst.occupiedBy?.id === userId;
                const taken = inst.isOccupied && !mineAlready;
                const isSuggested = inst.id === suggestedId;
                return (
                  <button key={inst.id} ref={isSuggested ? suggested : undefined} type="button" className="desk-option" data-taken={taken} data-suggested={isSuggested} onClick={() => choose(inst)} disabled={!!pending}>
                    <strong>{deskLabel(inst)}</strong>
                    <small>
                      {pending === inst.id ? 'Signing in…'
                        : mineAlready ? 'You were here'
                        : taken ? `${inst.occupiedBy?.firstName ?? 'Someone'} is here`
                        : isSuggested ? 'Free · suggested'
                        : 'Free'}
                    </small>
                  </button>
                );
              })}
            </div>
          </section>
        ))
      )}
      {(problem || desk.error) && <p className="desk-msg desk-msg-bad" role="alert">{problem || desk.error}</p>}
    </div>
  );
}
