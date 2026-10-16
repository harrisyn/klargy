'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, BellRing, Check, ChevronDown, ChevronRight, Ellipsis, Loader2, LogOut, Megaphone, PauseCircle, UserX, X } from 'lucide-react';
import api from '@/api/client';
import { Badge } from '@/components/ui';
import type { Desk, DeskEntry, DeskInstance } from './useDesk';
import { bookedLabel, bookedTitle, deskLabel, minutesAgo, personName } from './useDesk';
import { useDeskRooms, type DeskRoomGroup } from './DeskPicker';
import type { RoomType } from './connectBridge';

/**
 * The desk as one horizontal bar (`/widget/desk?layout=bar`), for a host
 * app's floating toolbar: the room, who's being served, how many are
 * waiting, and the actions. Menus open below the row; the widget tells the
 * host how tall it needs to be (klargy:resize). Same actions as the panel.
 */

export interface TransferOption {
  serviceId: string;
  displayName: string;
  /** The service's flow suggests it next. */
  usual?: boolean;
}

export interface DeskBarRooms {
  userId: string | null;
  locations: { id: string; name: string }[];
  locationId: string;
  setLocationId: (id: string) => void;
  instances: DeskInstance[] | null;
  groups: DeskRoomGroup[];
  pending: string | null;
  problem: string;
  choose: (inst: DeskInstance) => void | Promise<void>;
  /** The host's kinds of room matched none here, so every room is listed. */
  typeFallback?: boolean;
}

type Panel = 'transfer' | 'more' | 'pick' | null;

const roomOptionLabel = (inst: DeskInstance, userId: string | null) => {
  const taken = inst.isOccupied && inst.occupiedBy && inst.occupiedBy.id !== userId;
  return taken ? `${deskLabel(inst)} · ${inst.occupiedBy?.firstName ?? 'someone'} is here` : deskLabel(inst);
};

/** The bar itself, given the desk and its rooms (no data loading of its own
 * apart from the transfer list), so it can be rendered on its own. */
export function DeskBarView({
  desk,
  rooms,
  loadServices,
  onSignOut,
  initialPanel = null,
}: {
  desk: Desk;
  rooms: DeskBarRooms;
  /** Services the person being served can be sent on to. */
  loadServices: () => Promise<TransferOption[]>;
  onSignOut: () => void;
  initialPanel?: Panel;
}) {
  const { current, waiting, callable, busy, error, notice, afterComplete, terms } = desk;
  const [openPanel, setPanel] = useState<Panel>(initialPanel);
  // Transfer needs someone to transfer.
  const panel = openPanel === 'transfer' && !current ? null : openPanel;
  // The transfer list, for the room's service (a new room, a new list).
  const serviceId = desk.desk?.serviceId ?? null;
  const [loaded, setLoaded] = useState<{ serviceId: string | null; list: TransferOption[] } | null>(null);
  const services = loaded && loaded.serviceId === serviceId ? loaded.list : null;
  const [servicesFailed, setServicesFailed] = useState(false);
  const signedIn = !!desk.desk;
  const count = desk.data ? waiting.length : null;
  const next = callable[0];

  const toggle = (which: Exclude<Panel, null>) => setPanel(panel === which ? null : which);
  const act = (fn: () => unknown) => () => { setPanel(null); fn(); };

  // Load the services on first opening the transfer list.
  useEffect(() => {
    if (panel !== 'transfer' || services || servicesFailed) return;
    let cancelled = false;
    loadServices()
      .then((list) => { if (!cancelled) setLoaded({ serviceId, list }); })
      .catch(() => { if (!cancelled) setServicesFailed(true); });
    return () => { cancelled = true; };
  }, [panel, services, servicesFailed, loadServices, serviceId]);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel]);

  const pickRoom = (id: string) => {
    const inst = rooms.instances?.find((i) => i.id === id);
    if (inst) rooms.choose(inst);
  };

  const currentInList = !!desk.desk && !!rooms.instances?.some((i) => i.id === desk.desk!.instanceId);
  const message = rooms.problem || error || notice;

  return (
    <div className="desk-bar" data-panel={panel ?? 'none'}>
      <div className="desk-bar-row">
        <select
          className="desk-bar-room"
          aria-label="Room"
          value={desk.desk?.instanceId ?? ''}
          onChange={(e) => pickRoom(e.target.value)}
          disabled={!!rooms.pending || busy === 'signin'}
        >
          {!signedIn && <option value="" disabled>{rooms.instances === null ? 'Loading rooms…' : rooms.groups.length ? 'Pick your room…' : 'No rooms set up'}</option>}
          {signedIn && !currentInList && <option value={desk.desk!.instanceId}>{desk.desk!.label}</option>}
          {rooms.groups.map((g) => (
            <optgroup key={g.name} label={g.name}>
              {g.items.map((inst) => <option key={inst.id} value={inst.id}>{roomOptionLabel(inst, rooms.userId)}</option>)}
            </optgroup>
          ))}
        </select>

        {signedIn ? (
          <>
            <div className="desk-bar-now" aria-label="Now serving">
              {current ? (
                <>
                  <span className="desk-bar-ticket">{current.ticketNumber}</span>
                  <span className="desk-bar-name" title={personName(current) || undefined}>{personName(current) || `${terms.Person} ${current.ticketNumber}`}</span>
                </>
              ) : (
                <span className="desk-bar-none">No one being served</span>
              )}
            </div>

            <Badge tone={count ? 'primary' : 'neutral'} className="desk-bar-waiting" aria-live="polite">
              {count === null ? '…' : count} waiting
            </Badge>

            <div className="desk-bar-actions">
              <div className="desk-bar-split">
                <button
                  type="button"
                  className="desk-btn desk-btn-primary desk-bar-call"
                  onClick={act(() => desk.callNext())}
                  disabled={!!busy || callable.length === 0}
                  title={next ? `Call ${next.ticketNumber}` : waiting.length ? 'Nobody can be called yet' : 'Nobody is waiting'}
                >
                  {busy === 'call' ? <Loader2 size={16} className="qf-spin" /> : <BellRing size={16} />}
                  <span>Call next</span>
                </button>
                <button
                  type="button"
                  className="desk-btn desk-btn-primary desk-bar-call desk-bar-pick"
                  onClick={() => toggle('pick')}
                  disabled={!!busy && panel !== 'pick'}
                  aria-expanded={panel === 'pick'}
                  aria-label={`Call a specific ${terms.person}`}
                  title={`Call a specific ${terms.person}`}
                >
                  <ChevronDown size={16} />
                </button>
              </div>
              <button type="button" className="desk-btn" onClick={act(desk.recall)} disabled={!!busy || !current} title="Show and announce the ticket again">
                {busy === 'recall' ? <Loader2 size={16} className="qf-spin" /> : <Megaphone size={16} />}
                <span className="desk-bar-label">Recall</span>
              </button>
              <button type="button" className="desk-btn" onClick={act(desk.complete)} disabled={!!busy || !current} title="Finished with them">
                {busy === 'complete' ? <Loader2 size={16} className="qf-spin" /> : <Check size={16} />}
                <span className="desk-bar-label">Complete</span>
              </button>
              <button type="button" className="desk-btn desk-bar-wide" onClick={act(desk.hold)} disabled={!!busy || !current} title="Off the desk for now; they keep their place at the front">
                {busy === 'hold' ? <Loader2 size={16} className="qf-spin" /> : <PauseCircle size={16} />} <span className="desk-bar-label-wide">Hold</span>
              </button>
              <button type="button" className="desk-btn desk-btn-quiet desk-bar-wide" onClick={act(desk.noShow)} disabled={!!busy || !current} title="They didn’t come to the desk">
                <UserX size={16} /> <span className="desk-bar-label-wide">No-show</span>
              </button>
              <button
                type="button"
                className="desk-btn desk-bar-wide"
                onClick={() => toggle('transfer')}
                disabled={!!busy || !current}
                aria-expanded={panel === 'transfer'}
                title="Send them on to another service"
              >
                <ArrowRightLeft size={16} /> <span className="desk-bar-label-wide">Transfer</span>
              </button>
              <button
                type="button"
                className="desk-btn desk-btn-quiet desk-bar-more"
                onClick={() => toggle('more')}
                aria-expanded={panel === 'more'}
                aria-label="More"
                title="More"
              >
                {panel === 'more' ? <X size={16} /> : <Ellipsis size={16} />}
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="desk-bar-hint">{rooms.pending ? 'Signing in…' : rooms.typeFallback ? 'No rooms of the kind used here, so all rooms are listed. Pick yours to start calling.' : 'Pick the room you’re working in to start calling.'}</span>
            <div className="desk-bar-actions">
              <button type="button" className="desk-btn desk-btn-quiet desk-bar-more" onClick={() => toggle('more')} aria-expanded={panel === 'more'} aria-label="More" title="More">
                {panel === 'more' ? <X size={16} /> : <Ellipsis size={16} />}
              </button>
            </div>
          </>
        )}
      </div>

      {panel === 'transfer' && current && (
        <section className="desk-bar-panel" aria-label="Transfer to">
          <p>Send {personName(current) || current.ticketNumber} to:</p>
          {servicesFailed ? (
            <p className="desk-bar-muted">Couldn’t load the services. <button type="button" className="link-button" onClick={() => setServicesFailed(false)}>Try again</button></p>
          ) : services === null ? (
            <p className="desk-bar-muted"><Loader2 size={15} className="qf-spin" /> Loading services…</p>
          ) : services.length === 0 ? (
            <p className="desk-bar-muted">There are no other services here to send them to.</p>
          ) : (
            <div className="desk-after-options">
              {services.map((s) => (
                <button key={s.serviceId} type="button" className="desk-btn" onClick={act(() => desk.transfer(s))} disabled={!!busy}>
                  {s.displayName}{s.usual && <em>usual next</em>} <ChevronRight size={15} />
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {panel === 'pick' && signedIn && (
        <section className="desk-bar-panel" aria-label={`Call a specific ${terms.person}`}>
          {waiting.length === 0 ? (
            <p className="desk-bar-muted">Nobody is waiting.</p>
          ) : (
            <>
              <p>Call a specific {terms.person}{current ? ' (finish with the one you’re serving first, or put them on hold)' : ''}:</p>
              <ul className="desk-bar-pick-list">
                {waiting.map((e) => (
                  <PickRow key={e.id} entry={e} desk={desk} disabled={!!busy || !!current} onCall={act(() => desk.callNext(e.id))} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {panel === 'more' && (
        <section className="desk-bar-panel desk-bar-menu" aria-label="More">
          {signedIn && (
            <div className="desk-bar-narrow">
              <button type="button" className="desk-btn" onClick={act(desk.hold)} disabled={!!busy || !current}>
                <PauseCircle size={16} /> Hold
              </button>
              <button type="button" className="desk-btn desk-btn-quiet" onClick={act(desk.noShow)} disabled={!!busy || !current}>
                <UserX size={16} /> No-show
              </button>
              <button type="button" className="desk-btn" onClick={() => setPanel('transfer')} disabled={!!busy || !current}>
                <ArrowRightLeft size={16} /> Transfer
              </button>
            </div>
          )}
          {rooms.locations.length > 1 && (
            <label className="desk-bar-location">
              <span>Location</span>
              <select value={rooms.locationId} onChange={(e) => rooms.setLocationId(e.target.value)}>
                {rooms.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          <div className="desk-bar-menu-end">
            {signedIn && (
              <button type="button" className="desk-btn desk-btn-quiet" onClick={act(desk.leave)} disabled={!!busy}>
                Leave room
              </button>
            )}
            <button type="button" className="desk-btn desk-btn-quiet" onClick={act(onSignOut)}>
              <LogOut size={16} /> Sign out
            </button>
          </div>
        </section>
      )}

      {afterComplete && (
        <section className="desk-bar-panel" aria-label="Send on">
          <p>Send {personName(afterComplete.entry) || afterComplete.entry.ticketNumber} on to another service?</p>
          <div className="desk-after-options">
            {afterComplete.nextServices.map((s) => (
              <button key={s.serviceId} type="button" className="desk-btn" onClick={() => desk.sendTo(s)} disabled={!!busy}>
                {s.displayName}{s.isRequired && <em>usual next</em>} <ChevronRight size={15} />
              </button>
            ))}
            <button type="button" className="desk-btn desk-btn-quiet" onClick={desk.dismissAfterComplete}>No, they’re finished</button>
          </div>
        </section>
      )}

      {message && (
        <p className={rooms.problem || error ? 'desk-msg desk-msg-bad desk-bar-msg' : 'desk-msg desk-bar-msg'} role={rooms.problem || error ? 'alert' : 'status'}>{message}</p>
      )}
    </div>
  );
}

/** One person in the "Call a specific patient" list: on hold, waiting, or
 * awaiting payment (not callable until cleared). */
function PickRow({ entry, desk, disabled, onCall }: { entry: DeskEntry; desk: Desk; disabled: boolean; onCall: () => void }) {
  const held = !!entry.heldAt;
  const unpaid = !!entry.awaitingClearance;
  const heldHere = held && entry.deskInstanceId === desk.desk?.instanceId;
  return (
    <li className="desk-bar-pick-row" data-state={held ? 'held' : unpaid ? 'unpaid' : 'waiting'}>
      <b>{entry.ticketNumber}</b>
      <span className="desk-bar-pick-name">{personName(entry) || `${desk.terms.Person} ${entry.ticketNumber}`}</span>
      {entry.bookedFor && <Badge tone="neutral" title={bookedTitle(entry)}>{bookedLabel(entry)}</Badge>}
      {held ? (
        <Badge tone="primary">{heldHere ? 'On hold here' : 'On hold'}</Badge>
      ) : unpaid ? (
        <Badge tone="warning">Awaiting payment</Badge>
      ) : (
        <small>{minutesAgo(entry.joinedAt)} min</small>
      )}
      {unpaid ? (
        <button type="button" className="desk-btn desk-btn-quiet" onClick={() => desk.clear(entry)} disabled={!!desk.busy} title="They’ve paid: let them into the line">
          Mark paid
        </button>
      ) : (
        <button type="button" className="desk-btn" onClick={onCall} disabled={disabled} title={held ? 'Call them back to your room' : `Call ${entry.ticketNumber} now`}>
          <BellRing size={15} /> {held ? 'Call back' : 'Call'}
        </button>
      )}
    </li>
  );
}

/** The bar with its data: the rooms of the practitioner's location and the
 * services they can transfer to (the flow's usual next ones first). */
export default function DeskBar({ desk, onSignOut, preferServicePointId = null, roomTypes = [] }: { desk: Desk; onSignOut: () => void; preferServicePointId?: string | null; roomTypes?: readonly RoomType[] }) {
  const rooms = useDeskRooms(desk, preferServicePointId, roomTypes);
  const locationId = desk.desk?.locationId;
  const serviceId = desk.desk?.serviceId;
  const nextServices = desk.data?.nextServices;

  const loadServices = useCallback(async (): Promise<TransferOption[]> => {
    if (!locationId) return [];
    const all: { id: string; name: string; isActive?: boolean }[] = await api.getServices(locationId);
    const usual = (nextServices || []).filter((s) => s.serviceId !== serviceId);
    const usualIds = new Set(usual.map((s) => s.serviceId));
    return [
      ...usual.map((s) => ({ serviceId: s.serviceId, displayName: s.displayName, usual: true })),
      ...all
        .filter((s) => s.id !== serviceId && s.isActive !== false && !usualIds.has(s.id))
        .map((s) => ({ serviceId: s.id, displayName: s.name })),
    ];
  }, [locationId, serviceId, nextServices]);

  return <DeskBarView desk={desk} rooms={rooms} loadServices={loadServices} onSignOut={onSignOut} />;
}
