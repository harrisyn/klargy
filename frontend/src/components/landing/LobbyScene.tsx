'use client';

import React, { useEffect, useReducer, useRef, useState } from 'react';
import styles from './landing.module.css';

/**
 * The landing hero's lobby: people come in, scan the kiosk's code for a
 * ticket, then wait wherever they like - most sit, some stand and chat by the
 * water cooler - and only walk to a desk when their ticket is called out. No
 * one stands in line. Driven by a tiny state machine; each figure is
 * positioned with a CSS transform so movement is a transition, not per-frame
 * JS.
 */

// The room (door to last desk) is SCENE_W wide and is drawn inside a larger
// canvas: OX of empty wall on the left leaves room for the hero text, and the
// wall above the floor holds the windows, clock and waiting display.
const SCENE_W = 1250;
const OX = 500;
const VB_W = 1780;
const VB_H = 740;
/** The part of the room shown below 1280px: door to the last desk, TV hangers to floor. Keep in step with .sceneWrap's aspect-ratio. */
const COMPACT = { x: 500, y: 40, w: 1300, h: 700 };
const FLOOR_Y = 620;
const DOOR_X = 64;
const KIOSK_X = 196;
// Two seating clusters at different depths: a near one (lower, larger) and a
// far one by the wall (higher, smaller), so the room isn't a single line.
interface Seat { x: number; y: number; s: number; far: boolean }
const SEATS: Seat[] = [
  ...[300, 362, 424, 486].map((x) => ({ x, y: FLOOR_Y + 46, s: 1.12, far: false })),
  ...[540, 590, 640, 690].map((x) => ({ x, y: FLOOR_Y + 8, s: 0.88, far: true })),
];
const COOLER_X = 734;
const CLOCK_X = 492;
const CLOCK_Y = 250;
const TV_X = 560;
const TV_Y = 64;
// Spots 0 and 1 are a chatting pair; spot 2 is someone on their own.
const LOITER = [768, 804, 840];
const DESKS = [935, 1060, 1185];
const EXIT_X = SCENE_W + 60;
const TICK_MS = 2600;
const MAX_WAITING = 9;

const OUTFITS = ['#5b7fa6', '#9cbab9', '#c08a5b', '#6f6a93', '#9c6b6b', '#3b7f99', '#b59a55', '#7a8c9e'];
const PANTS = ['#34404c', '#4a4f63', '#5a4a3f'];
const SKIN = ['#f1d3b8', '#d9a67e', '#a86f4c', '#6e4630'];
const HAIR = ['#2b2118', '#5a3a22', '#8a6a3c', '#1c1c1f'];
const GREY_HAIR = '#cfd3d8';
const KID_OUTFITS = ['#e0b84f', '#d98ca3', '#7fbf8e', '#8aa7e0'];

// 'queued' is someone who joined from their phone and isn't in the room (yet).
type Phase = 'door' | 'kiosk' | 'waiting' | 'called' | 'leaving' | 'queued';
type Mode = 'sit' | 'loiter';
type Kind = 'man' | 'woman' | 'elderMan' | 'elderWoman';

// A mix of ages and sexes; `kid` means a child is with them (no ticket of
// their own) and `family` means a partner and two children are too. Indexed by person id so the cast repeats in a steady rhythm.
const PROFILES: { kind: Kind; kid: boolean; family: boolean }[] = [
  { kind: 'woman', kid: true, family: false },
  { kind: 'man', kid: false, family: false },
  { kind: 'elderWoman', kid: false, family: false },
  // A family of four on one ticket: two parents and two children.
  { kind: 'woman', kid: false, family: true },
  { kind: 'man', kid: false, family: false },
  { kind: 'elderMan', kid: false, family: false },
  { kind: 'woman', kid: false, family: false },
  { kind: 'man', kid: true, family: false },
  { kind: 'elderWoman', kid: false, family: false },
  { kind: 'man', kid: false, family: true },
];

interface Person {
  id: number;
  num: number;
  ticket: string;
  kind: Kind;
  kid: boolean;
  outfit: string;
  pants: string;
  skin: string;
  hair: string;
  kidOutfit: string;
  kidSkin: string;
  kidHair: string;
  phase: Phase;
  mode: Mode;
  spot: number; // index into SEATS or LOITER, depending on mode
  desk: number;
  servedTicks: number;
  walkLeft: number; // ticks left in the current walk (drives the bob)
  dist: number; // distance of the current walk (drives the duration)
  hasTicket: boolean;
  booked: boolean; // has an appointment: called ahead of the order
  noShow: boolean; // joined by phone and never turns up
  seated: boolean; // reached the chair and sat down
  front: boolean; // drawn in front of the walkers (near seating cluster)
  family: boolean; // a partner and two children come with them
  arrived: boolean; // at the kiosk (not still walking to it): only then do they hold up their phone
  partnerSeat: number | null; // the chair beside theirs, for a family
}

interface Callout {
  ticket: string;
  desk: number;
  n: number;
}

interface State {
  people: Person[];
  nextId: number;
  nextNumber: number;
  t: number;
  board: { ticket: string; desk: number } | null;
  callout: Callout | null;
  deskBusy: boolean[];
}

const ticketLabel = (n: number) => `C${String(n).padStart(3, '0')}`;
const isElder = (kind: Kind) => kind === 'elderMan' || kind === 'elderWoman';
const isFemale = (kind: Kind) => kind === 'woman' || kind === 'elderWoman';

function makePerson(id: number, num: number, phase: Phase): Person {
  const profile = PROFILES[(id - 1) % PROFILES.length];
  return {
    id,
    num,
    ticket: ticketLabel(num),
    kind: profile.kind,
    kid: profile.kid,
    outfit: OUTFITS[id % OUTFITS.length],
    pants: PANTS[id % PANTS.length],
    skin: SKIN[(id * 7) % SKIN.length],
    hair: isElder(profile.kind) ? GREY_HAIR : HAIR[(id * 5) % HAIR.length],
    kidOutfit: KID_OUTFITS[id % KID_OUTFITS.length],
    kidSkin: SKIN[(id * 3) % SKIN.length],
    kidHair: HAIR[(id * 11) % HAIR.length],
    phase,
    mode: 'sit',
    spot: 0,
    desk: -1,
    servedTicks: 0,
    walkLeft: 0,
    dist: 0,
    hasTicket: phase !== 'door' && phase !== 'kiosk',
    booked: phase !== 'queued' && id % 4 === 2,
    noShow: phase === 'queued',
    seated: false,
    front: false,
    family: profile.family,
    arrived: false,
    partnerSeat: null,
  };
}

function initialState(): State {
  // Mid-morning: one person at a desk, most of the room seated, a pair chatting.
  const people: Person[] = [];
  let id = 1;
  let num = 11;
  const atDesk = makePerson(id++, num++, 'called');
  atDesk.desk = 1;
  atDesk.servedTicks = 1;
  people.push(atDesk);
  const waiting: [Mode, number][] = [['loiter', 0], ['sit', 1], ['sit', 2], ['sit', 4], ['sit', 5], ['loiter', 1], ['sit', 6]];
  for (const [mode, spot] of waiting) {
    const p = makePerson(id++, num++, 'waiting');
    p.mode = mode;
    p.spot = spot;
    p.seated = mode === 'sit';
    p.front = mode === 'sit' && !SEATS[spot].far;
    if (p.family && mode === 'sit') p.partnerSeat = spot + 1;
    people.push(p);
  }
  return {
    people,
    nextId: id,
    nextNumber: num,
    t: 0,
    board: { ticket: atDesk.ticket, desk: 1 },
    callout: null,
    deskBusy: [false, true, false],
  };
}

const hexParts = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mixHex = (a: string, b: string, w: number) => {
  const pb = hexParts(b);
  return '#' + hexParts(a).map((v, i) => Math.round(v + (pb[i] - v) * w).toString(16).padStart(2, '0')).join('');
};

function xFor(p: Person): number {
  switch (p.phase) {
    case 'door':
    case 'queued':
      return DOOR_X;
    case 'kiosk':
      return KIOSK_X + 34;
    case 'waiting':
      return p.mode === 'sit' ? SEATS[p.spot].x : LOITER[p.spot];
    case 'called':
      // Stand at the customer side of the counter, clear of the staff member.
      return DESKS[p.desk] - 62;
    case 'leaving':
      return EXIT_X;
  }
}

interface Pos { x: number; y: number; s: number }

function posFor(p: Person): Pos {
  if (p.phase === 'waiting' && p.mode === 'sit') {
    const { x, y, s } = SEATS[p.spot];
    return { x, y, s };
  }
  return { x: xFor(p), y: FLOOR_Y, s: 1 };
}

const walkSeconds = (dist: number) => Math.min(3.4, 0.9 + dist / 260);
// A seated person takes a beat to notice the call and stand up.
const delayFor = (phase: Phase) => (phase === 'called' ? 0.45 : 0);

/** Moves a person to a new state, recording how far and how long they walk. */
function go(prev: Person, next: Person): Person {
  const a = posFor(prev);
  const b = posFor(next);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const seconds = walkSeconds(dist) + delayFor(next.phase);
  return { ...next, seated: false, arrived: false, dist, walkLeft: dist > 0 ? Math.ceil(seconds / (TICK_MS / 1000)) : 0 };
}

/** Where someone settles after the kiosk: most sit, some prefer to stand and chat. */
function pickSpot(people: Person[], p: Person): { mode: Mode; spot: number; partnerSeat: number | null } {
  const waiting = people.filter((q) => q.phase === 'waiting');
  const takenSeats = new Set(waiting.filter((q) => q.mode === 'sit').flatMap((q) => (q.partnerSeat == null ? [q.spot] : [q.spot, q.partnerSeat])));
  const takenLoiter = new Set(waiting.filter((q) => q.mode === 'loiter').map((q) => q.spot));
  const freeSeats = SEATS.map((_, i) => i).filter((i) => !takenSeats.has(i));
  const freeLoiter = LOITER.map((_, i) => i).filter((i) => !takenLoiter.has(i));
  const prefersToStand = !p.kid && !p.family && !isElder(p.kind) && p.id % 3 === 1;

  if (p.family) {
    // Two chairs side by side in one cluster; failing that, one chair and the partner standing beside it.
    const pair = freeSeats.find((i) => i % 4 !== 3 && !takenSeats.has(i + 1));
    if (pair !== undefined) return { mode: 'sit', spot: pair, partnerSeat: pair + 1 };
  }
  if (prefersToStand && freeLoiter.length > 0) {
    // Join someone already standing, so they have company.
    const withCompany = freeLoiter.find((i) => takenLoiter.has(i ^ 1));
    return { mode: 'loiter', spot: withCompany ?? freeLoiter[0], partnerSeat: null };
  }
  if (freeSeats.length > 0) return { mode: 'sit', spot: freeSeats[(p.id * 5) % freeSeats.length], partnerSeat: null };
  if (freeLoiter.length > 0) return { mode: 'loiter', spot: freeLoiter[0], partnerSeat: null };
  return { mode: 'sit', spot: 0, partnerSeat: null };
}

/** Everyone waiting for a desk, in the order they'll be called: booked first, then by ticket. */
function queueOrder(people: Person[]): Person[] {
  return people
    .filter((p) => p.phase === 'waiting' || p.phase === 'queued')
    .sort((a, b) => Number(b.booked) - Number(a.booked) || a.num - b.num);
}

function tick(state: State): State {
  const t = state.t + 1;
  let { nextId, nextNumber, board } = state;
  let callout: Callout | null = null;
  const deskBusy = [...state.deskBusy];
  let people = state.people
    .filter((p) => p.phase !== 'leaving')
    .map((p) => ({ ...p, walkLeft: Math.max(0, p.walkLeft - 1) }));

  // Served people leave after a few beats, freeing the desk.
  people = people.map((p) => {
    if (p.phase !== 'called') return p;
    if (p.servedTicks >= (p.noShow ? 2 : 4)) {
      deskBusy[p.desk] = false;
      return go(p, { ...p, phase: 'leaving' });
    }
    return { ...p, servedTicks: p.servedTicks + 1 };
  });

  // Call the next ticket to a free desk. Wherever they are, they get up and go.
  const freeDesk = deskBusy.findIndex((busy) => !busy);
  const next = queueOrder(people)[0];
  if (freeDesk !== -1 && next) {
    deskBusy[freeDesk] = true;
    board = { ticket: next.ticket, desk: freeDesk };
    callout = { ticket: next.ticket, desk: freeDesk, n: t };
    people = people.map((p) => (p.id === next.id ? go(p, { ...p, phase: 'called', desk: freeDesk, servedTicks: 0 }) : p));
  }

  // Door -> kiosk; kiosk -> a seat or a standing spot, ticket in hand.
  const settled = people;
  people = people.map((p) => {
    if (p.phase === 'kiosk') {
      const { mode, spot, partnerSeat } = pickSpot(settled, p);
      return go(p, { ...p, phase: 'waiting', mode, spot, partnerSeat, hasTicket: true });
    }
    if (p.phase === 'door') return go(p, { ...p, phase: 'kiosk' });
    return p;
  });

  // Someone new arrives most beats, while the room has space.
  const inRoom = people.filter((p) => p.phase === 'door' || p.phase === 'kiosk' || p.phase === 'waiting').length;
  if (inRoom < MAX_WAITING && !people.some((p) => p.phase === 'door')) {
    people.push(makePerson(nextId++, nextNumber++, 'door'));
  }

  // Now and then someone joins from their phone and never shows up.
  if (t % 8 === 5 && !people.some((p) => p.phase === 'queued')) {
    people.push(makePerson(nextId++, nextNumber++, 'queued'));
  }

  return { people, nextId, nextNumber, t, board, callout, deskBusy };
}

type Action = { type: 'tick' } | { type: 'settle'; id: number };

function reduce(state: State, action: Action): State {
  if (action.type === 'tick') return tick(state);
  // Someone reached their chair (sit down and, in the near cluster, step in front of the walkers) or the kiosk (hold up their phone).
  return {
    ...state,
    people: state.people.map((p) =>
      p.id !== action.id
        ? p
        : p.phase === 'kiosk'
          ? { ...p, arrived: true }
          : p.phase === 'waiting' && p.mode === 'sit'
            ? { ...p, seated: true, front: !SEATS[p.spot].far }
            : p
    ),
  };
}

/** A child walking beside an adult. Drawn at 70% scale. */
function Kid({ outfit, skin, hair, x, scale = 0.7 }: { outfit: string; skin: string; hair: string; x: number; scale?: number }) {
  return (
    <g transform={`translate(${x}, 0) scale(${scale})`}>
      <ellipse cx="0" cy="0" rx="15" ry="4" fill="rgba(28,39,51,0.12)" />
      <rect x="-8" y="-28" width="6.5" height="28" rx="3" fill="#4a4f63" />
      <rect x="1.5" y="-28" width="6.5" height="28" rx="3" fill="#4a4f63" />
      <rect x="-13" y="-62" width="26" height="38" rx="11" fill={outfit} />
      <circle cx="0" cy="-74" r="13" fill={skin} />
      <path d="M -13 -75 A 13 13 0 0 1 13 -75 Q 6 -82 0 -80 Q -6 -82 -13 -75 Z" fill={hair} />
      <circle cx="-4.5" cy="-73" r="1.5" fill="#2b2118" />
      <circle cx="4.5" cy="-73" r="1.5" fill="#2b2118" />
    </g>
  );
}

/** Seated, side-on and facing the screen: upright torso, thighs forward, shins down, phone in hand. */
function SeatedBody({ person, buzzing, gaze }: { person: Person; buzzing: boolean; gaze: { dx: number; dy: number } }) {
  const { kind, skin, hair, pants } = person;
  const female = isFemale(kind);
  const top = person.outfit;
  const edge = 'rgba(13,42,71,0.22)';
  return (
    <g className={styles.sitDown}>
      {/* shin and shoe, thigh going forward */}
      <rect x="15" y="-24" width="8" height="24" rx="4" fill={pants} />
      <ellipse cx="22" cy="-2" rx="9" ry="3.2" fill="#222b34" />
      <rect x="-10" y="-33" width="33" height="12" rx="6" fill={pants} />
      {female && <path d="M -13 -46 L 6 -46 L 22 -33 L 22 -21 L -13 -21 Z" fill={pants} />}
      {/* hair behind the head */}
      {kind === 'woman' && <rect x="-16" y="-101" width="17" height="44" rx="8.5" fill={hair} />}
      {kind === 'elderWoman' && <circle cx="-13" cy="-99" r="7" fill={hair} />}
      {/* torso */}
      <rect x="-16" y="-77" width="22" height="50" rx="10" fill={top} />
      {kind === 'elderWoman' && <rect x="8" y="-45" width="14" height="11" rx="3" fill="#8a5a44" />}
      {kind === 'elderMan' && <path d="M 31 0 L 31 -42 Q 31 -50 25 -48" stroke="#7a5a3a" strokeWidth="3" strokeLinecap="round" fill="none" />}
      {/* head, facing right */}
      <circle cx="-1" cy="-88" r="12" fill={skin} />
      <circle cx="11" cy="-86" r="2.6" fill={skin} />
      {kind === 'elderMan' ? (
        <ellipse cx="-11" cy="-89" rx="3.6" ry="7" fill={hair} />
      ) : (
        <path d="M -13.5 -88 A 12.5 12.5 0 0 1 11.5 -89 L 6 -92 Q -2 -97 -9.5 -88 Z" fill={hair} />
      )}
      <circle cx={5.5 + gaze.dx} cy={-88 + gaze.dy} r="1.5" fill="#2b2118" />
      {person.kid ? (
        <>
          {/* a child on the lap, facing right, held round the middle */}
          <rect x="-2" y="-64" width="15" height="31" rx="7" fill={person.kidOutfit} />
          <rect x="3" y="-39" width="25" height="9" rx="4.5" fill="#4a4f63" />
          <rect x="22" y="-36" width="8" height="24" rx="4" fill="#4a4f63" />
          <ellipse cx="29" cy="-12" rx="6.5" ry="2.8" fill="#222b34" />
          <circle cx="6" cy="-71" r="9.5" fill={person.kidSkin} />
          <circle cx="13.5" cy="-70" r="2" fill={person.kidSkin} />
          <path d="M -3.5 -71 A 9.8 9.8 0 0 1 14.5 -72 L 11 -75 Q 5 -80 -1 -73 Z" fill={person.kidHair} />
          <circle cx="10.5" cy="-71" r="1.3" fill="#2b2118" />
          <rect x="-9" y="-69" width="10" height="27" rx="5" fill={top} stroke={edge} strokeWidth="1" />
          <line x1="-3" y1="-47" x2="9" y2="-42" stroke={top} strokeWidth="8.5" strokeLinecap="round" />
          <circle cx="11" cy="-42" r="4" fill={skin} />
        </>
      ) : (
        <>
          {/* arm up to the phone */}
          <rect x="-9" y="-69" width="10" height="27" rx="5" fill={top} stroke={edge} strokeWidth="1" />
          <line x1="-3" y1="-47" x2="14" y2="-62" stroke={top} strokeWidth="8.5" strokeLinecap="round" />
          <circle cx="15" cy="-63" r="4" fill={skin} />
          <rect
            className={buzzing ? styles.buzz : undefined}
            x="14"
            y="-76"
            width="7"
            height="12"
            rx="2"
            fill={buzzing ? 'var(--amber-400)' : '#dcf2f3'}
            stroke="var(--ink, #0d2a47)"
            strokeWidth="1"
          />
        </>
      )}
    </g>
  );
}

function Body({ person, sitting, called, talking, buzzing, gaze, scanning }: { person: Person; sitting: boolean; called: boolean; talking: boolean; buzzing: boolean; gaze: { dx: number; dy: number }; scanning: boolean }) {
  if (sitting && !called) return <SeatedBody person={person} buzzing={buzzing} gaze={gaze} />;
  const { kind, skin, hair, pants } = person;
  const female = isFemale(kind);
  const elder = isElder(kind);
  const top = called ? 'var(--primary-500)' : person.outfit;
  const shift = sitting ? 6 : 0;
  const halfW = female ? 13 : 15;

  return (
    <g transform={elder && !sitting ? 'rotate(3)' : undefined}>
      {/* legs: standing, or seated with thighs toward the viewer, shins down and feet forward */}
      {sitting ? (
        <>
          <rect x="-10" y="-27" width="9" height="13" rx="4.5" fill={pants} />
          <rect x="1" y="-27" width="9" height="13" rx="4.5" fill={pants} />
          <rect x="-9.5" y="-16" width="7" height="16" rx="3.5" fill={pants} />
          <rect x="2.5" y="-16" width="7" height="16" rx="3.5" fill={pants} />
          <ellipse cx="-5.5" cy="-20" rx="3.5" ry="3" fill="#fff" opacity="0.13" />
          <ellipse cx="5.5" cy="-20" rx="3.5" ry="3" fill="#fff" opacity="0.13" />
          <ellipse cx="-7.5" cy="-1.5" rx="6.5" ry="3" fill="#222b34" />
          <ellipse cx="7.5" cy="-1.5" rx="6.5" ry="3" fill="#222b34" />
        </>
      ) : (
        <>
          <rect x="-9" y="-30" width="7" height="30" rx="3.5" fill={pants} />
          <rect x="2" y="-30" width="7" height="30" rx="3.5" fill={pants} />
          <ellipse cx="-5.5" cy="-1.5" rx="6" ry="3" fill="#222b34" />
          <ellipse cx="5.5" cy="-1.5" rx="6" ry="3" fill="#222b34" />
        </>
      )}
      {/* cane / handbag, only when standing */}
      {!sitting && kind === 'elderMan' && (
        <path d="M 18 0 L 18 -46 Q 18 -54 11 -52" stroke="#7a5a3a" strokeWidth="3" strokeLinecap="round" fill="none" />
      )}
      <g className={talking ? styles.talking : undefined}>
        <g transform={shift ? `translate(0, ${shift})` : undefined}>
          {/* long hair behind the head, or a bun */}
          {kind === 'woman' && <rect x="-13.5" y="-100" width="27" height="40" rx="13" fill={hair} />}
          {kind === 'elderWoman' && <circle cx="0" cy="-102" r="6.5" fill={hair} />}
          {/* torso, with a skirt for women */}
          <rect x={-halfW} y="-74" width={halfW * 2} height="48" rx="13" fill={top} />
          {female && <path d="M -13 -44 L 13 -44 L 19 -20 L -19 -20 Z" fill={called ? 'var(--primary-600)' : pants} />}
          {!sitting && kind === 'elderWoman' && <rect x="13" y="-46" width="12" height="10" rx="2.5" fill="#8a5a44" />}
          {/* phone: pale while waiting, amber and buzzing when they're next */}
          {sitting && person.hasTicket && !called && (
            <rect
              className={buzzing ? styles.buzz : undefined}
              x="8"
              y="-58"
              width="7"
              height="11"
              rx="2"
              fill={buzzing ? 'var(--amber-400)' : '#dcf2f3'}
              opacity="0.95"
            />
          )}
          {/* holding the phone up to the kiosk (it's to their left) */}
          {scanning && (
            <>
              <line x1="-9" y1="-62" x2="-21" y2="-76" stroke={top} strokeWidth="8" strokeLinecap="round" />
              <circle cx="-22" cy="-78" r="4" fill={skin} />
              <rect x="-29" y="-96" width="8" height="14" rx="2" fill="#dcf2f3" stroke="var(--ink, #0d2a47)" strokeWidth="1" />
            </>
          )}
          {/* head */}
          <circle cx="0" cy="-88" r="12" fill={skin} />
          {kind === 'elderMan' ? (
            <>
              <path d="M -12 -86 Q -14 -92 -9 -95 L -8 -86 Z" fill={hair} />
              <path d="M 12 -86 Q 14 -92 9 -95 L 8 -86 Z" fill={hair} />
            </>
          ) : (
            <path d="M -12.5 -88 A 12.5 12.5 0 0 1 12.5 -88 Q 6 -94 0 -93 Q -6 -94 -12.5 -88 Z" fill={hair} />
          )}
          <circle cx={-4 + gaze.dx} cy={-87 + gaze.dy} r="1.4" fill="#2b2118" />
          <circle cx={4 + gaze.dx} cy={-87 + gaze.dy} r="1.4" fill="#2b2118" />
        </g>
      </g>
    </g>
  );
}

function ChatBubble() {
  return (
    <g transform="translate(0, -146)">
      <path d="M -4 8 L 0 14 L 4 8 Z" fill="white" stroke="#c8d2cc" strokeWidth="1" />
      <rect x="-17" y="-10" width="34" height="19" rx="9.5" fill="white" stroke="#c8d2cc" strokeWidth="1" />
      <rect x="-3" y="7" width="6" height="2.5" fill="white" />
      {[-7, 0, 7].map((cx, i) => (
        <circle key={cx} className={styles.chatDot} style={{ animationDelay: `${i * 0.18}s` }} cx={cx} cy="0" r="2.2" fill="#7b8794" />
      ))}
    </g>
  );
}

/** "You're next" notification popping out of someone's phone. */
function NextUpCard({ y }: { y: number }) {
  return (
    <g transform={`translate(0, ${y})`}>
      <g className={styles.notify}>
      <path d="M -4 9 L 0 15 L 4 9 Z" fill="white" stroke="var(--amber-400)" strokeWidth="1.5" />
      <rect x="-40" y="-11" width="80" height="22" rx="11" fill="white" stroke="var(--amber-400)" strokeWidth="1.5" />
      <rect x="-4" y="8" width="8" height="3" fill="white" />
      <rect x="-34" y="-6" width="8" height="12" rx="2" fill="var(--ink, #0d2a47)" />
      <rect x="-32.5" y="-3.5" width="5" height="6" rx="1" fill="var(--amber-400)" />
      <text x="6" y="3.8" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--ink, #0d2a47)">
        You&apos;re next
      </text>
      </g>
    </g>
  );
}

// Where the children play while their parents wait: the mat in the foreground, left of the entrance.
const PLAY: Pos[] = [
  { x: 112, y: FLOOR_Y + 70, s: 0.8 },
  { x: 190, y: FLOOR_Y + 88, s: 0.84 },
];

/** A family's second parent. Looks like a different person from the lead, and the opposite sex. */
function partnerOf(p: Person): Person {
  return {
    ...p,
    kind: isFemale(p.kind) ? 'man' : 'woman',
    outfit: OUTFITS[(p.id + 3) % OUTFITS.length],
    pants: PANTS[(p.id + 1) % PANTS.length],
    hair: HAIR[(p.id * 3) % HAIR.length],
    kid: false,
    family: false,
    hasTicket: true,
  };
}

/** Where a family's partner and two children are: with the lead on the move, and at the play mat while waiting. */
function companionSpots(p: Person): { partner: Pos; kids: Pos[] } {
  const lead = posFor(p);
  if (p.phase === 'waiting') {
    const partner =
      p.mode === 'sit' && p.partnerSeat != null
        ? { x: SEATS[p.partnerSeat].x, y: SEATS[p.partnerSeat].y, s: SEATS[p.partnerSeat].s }
        : { x: lead.x + 40 * lead.s, y: lead.y, s: lead.s };
    return { partner, kids: PLAY };
  }
  // At the desk the counter is on the right, so the family stands to the left of the lead.
  const side = p.phase === 'called' ? -1 : 1;
  return {
    partner: { x: lead.x + 34 * side, y: lead.y, s: 1 },
    kids: [
      { x: lead.x - 30 * side, y: lead.y + 6, s: 0.7 },
      { x: lead.x + 10 * side, y: lead.y + 10, s: 0.65 },
    ],
  };
}

function Figure({ person, chatBubble, talking, nextUp, gaze }: { person: Person; chatBubble: boolean; talking: boolean; nextUp: boolean; gaze: { dx: number; dy: number } }) {
  // Phone joiners who never arrive have no figure.
  if (person.phase === 'queued' || person.noShow) return null;
  const called = person.phase === 'called' || person.phase === 'leaving';
  const duration = person.phase === 'leaving' ? Math.max(2.2, walkSeconds(person.dist)) : walkSeconds(person.dist);
  // Someone only takes the seated pose once they've actually reached the chair.
  const sitting = person.phase === 'waiting' && person.mode === 'sit' && person.seated;
  const pos = posFor(person);
  const chipY = -114;
  const family = person.family ? companionSpots(person) : null;
  const moving = person.walkLeft > 0;
  const settled = person.phase === 'waiting' && !moving;
  const placed = (at: Pos): React.CSSProperties => ({
    transform: `translate(${at.x}px, ${at.y}px) scale(${at.s})`,
    transitionDuration: `${duration}s`,
    transitionDelay: `${delayFor(person.phase)}s`,
    opacity: person.phase === 'leaving' ? 0 : 1,
  });
  return (
    <>
    <g
      className={styles.figure}
      style={placed(pos)}
    >
      <g className={person.walkLeft > 0 ? styles.walking : undefined}>
        {/* shadow */}
        <ellipse cx="0" cy="0" rx="17" ry="4" fill="rgba(28,39,51,0.12)" />
        {/* a child sits on a seated adult's lap; otherwise they walk and stand beside them */}
        {person.kid && !sitting && <Kid x={-24} outfit={person.kidOutfit} skin={person.kidSkin} hair={person.kidHair} />}
        <Body person={person} sitting={sitting} called={called} talking={talking} buzzing={nextUp} gaze={gaze} scanning={person.phase === 'kiosk' && person.arrived} />
      </g>
      {nextUp ? <NextUpCard y={chipY - 30} /> : chatBubble && <ChatBubble />}
      {person.hasTicket && person.phase !== 'leaving' && !chatBubble && !nextUp && (
        <g className={called ? styles.ticketCalled : styles.ticket} transform={`translate(0,${chipY})`}>
          <rect x="-22" y="-11" width="44" height="20" rx="5" fill={called ? 'var(--primary-500)' : person.booked ? '#6f6a93' : 'var(--amber-400)'} />
          <text x="0" y="3.5" textAnchor="middle" fontSize="11" fontWeight="700" fill={called || person.booked ? 'white' : 'var(--ink, #0d2a47)'}>
            {person.ticket}
          </text>
        </g>
      )}
    </g>
    {family && (
      <>
        <g className={styles.figure} style={placed(family.partner)}>
          <g className={moving ? styles.walking : undefined}>
            <ellipse cx="0" cy="0" rx="17" ry="4" fill="rgba(28,39,51,0.12)" />
            <Body person={partnerOf(person)} sitting={sitting && person.partnerSeat != null} called={false} talking={false} buzzing={false} gaze={{ dx: 0, dy: 0 }} scanning={false} />
          </g>
        </g>
        {family.kids.map((at, i) => (
          <g key={i} className={styles.figure} style={placed(at)}>
            <g className={moving ? styles.walking : settled ? styles.playing : undefined} style={settled ? { animationDelay: `${i * 0.45}s` } : undefined}>
              <Kid x={0} scale={1} outfit={i ? KID_OUTFITS[(person.id + 2) % KID_OUTFITS.length] : person.kidOutfit} skin={i ? person.kidSkin : person.kidSkin} hair={i ? HAIR[(person.id * 13) % HAIR.length] : person.kidHair} />
            </g>
          </g>
        ))}
      </>
    )}
    </>
  );
}

const ADS = [
  { tag: 'Pharmacy', lines: ['Flu shots', 'today'], sub: 'Ask at Desk 3. No booking needed.', from: '#0f9fa4', to: '#0a565a' },
  { tag: 'Save time', lines: ['Pay by phone,', 'skip the cashier'], sub: 'Scan the code at any desk.', from: '#6f6a93', to: '#3b3a66' },
  { tag: 'Free Wi-Fi', lines: ['Stay connected', 'while you wait'], sub: 'Network: Guest', from: '#c08a5b', to: '#7a4a2a' },
];
const TICKER = 'Have your ID ready   ·   Tap your phone to see your place in the queue   ·   Free Wi-Fi: Guest   ·   Please keep walkways clear   ·   ';
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4]}`;

/** The waiting-room screen: who's being served, the next positions with wait estimates, and rotating adverts. */
function WaitingDisplay({ board, waiting, total, t, called }: { board: State['board']; waiting: Person[]; total: number; t: number; called: boolean }) {
  const ad = ADS[Math.floor(t / 3) % ADS.length];
  const adIndex = Math.floor(t / 3) % ADS.length;
  return (
    <g transform={`translate(${TV_X}, ${TV_Y})`}>
      {/* ceiling mounts */}
      <line x1="150" y1="0" x2="150" y2={-TV_Y} stroke="#9aa9b5" strokeWidth="3" />
      <line x1="470" y1="0" x2="470" y2={-TV_Y} stroke="#9aa9b5" strokeWidth="3" />
      <rect width="620" height="290" rx="16" fill="#0b1f33" />
      <defs>
        <clipPath id="tvAdClip"><rect x="336" y="8" width="276" height="240" rx="8" /></clipPath>
        <clipPath id="tvTickClip"><rect x="8" y="254" width="604" height="28" rx="6" /></clipPath>
      </defs>
      <rect x="8" y="8" width="320" height="240" rx="8" fill="var(--ink, #0d2a47)" />

      {/* now serving */}
      <text x="24" y="34" fontSize="14" fontWeight="600" fill="#8fa0ae">Now serving</text>
      <g key={`speaker-${called ? board?.ticket : 'idle'}`} transform="translate(292, 18)" opacity={called ? 1 : 0.4}>
        <path d="M 0 5 L 5 5 L 11 0 L 11 14 L 5 9 L 0 9 Z" fill="#8fa0ae" />
        <path className={called ? styles.wave : undefined} d="M 14 4 Q 18 7 14 10" stroke="var(--amber-400)" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path className={called ? styles.wave2 : undefined} d="M 17 1 Q 24 7 17 13" stroke="var(--amber-400)" strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
      {/* join from your phone */}
      <text x="226" y="31" textAnchor="end" fontSize="10" fontWeight="600" fill="#8fa0ae">Join on your phone</text>
      <rect x="236" y="14" width="26" height="26" rx="4" fill="#dcf2f3" />
      {[[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [1, 2], [2, 2]].map(([cx, cy], i) => (
        <rect key={i} x={240 + cx * 7} y={18 + cy * 7} width="5" height="5" rx="1" fill="var(--ink, #0d2a47)" />
      ))}
      <text key={board?.ticket} className={styles.boardTicket} x="24" y="96" fontSize="58" fontWeight="700" fill="var(--amber-400)">
        {board?.ticket ?? '-'}
      </text>
      <text x="312" y="96" textAnchor="end" fontSize="24" fontWeight="600" fill="#dfe6ea">
        {board ? `Desk ${board.desk + 1}` : ''}
      </text>
      <line x1="24" y1="114" x2="312" y2="114" stroke="#23425f" strokeWidth="1.5" />

      {/* positions and wait estimates */}
      <text x="24" y="136" fontSize="12" fontWeight="600" fill="#8fa0ae">Next up</text>
      <text x="312" y="136" textAnchor="end" fontSize="12" fontWeight="600" fill="#8fa0ae">{total} waiting</text>
      {waiting.slice(0, 4).map((p, i) => (
        <g key={p.id} transform={`translate(0, ${146 + i * 25})`}>
          <rect x="24" y="0" width="288" height="21" rx="6" fill={i === 0 ? 'rgba(240,180,41,0.14)' : 'rgba(255,255,255,0.05)'} />
          <text x="36" y="15" fontSize="12" fontWeight="700" fill="#8fa0ae">{ordinal(i + 1)}</text>
          <text x="78" y="15" fontSize="14" fontWeight="700" fill={p.booked ? '#b9b3e6' : i === 0 ? 'var(--amber-400)' : '#dfe6ea'}>{p.ticket}</text>
          {p.booked ? (
            <text x="300" y="15" textAnchor="end" fontSize="12" fontWeight="700" fill="#b9b3e6">Booked</text>
          ) : p.phase === 'queued' ? (
            <text x="300" y="15" textAnchor="end" fontSize="12" fontWeight="600" fill="#8fd6da">On the way</text>
          ) : (
            <text x="300" y="15" textAnchor="end" fontSize="12" fontWeight="600" fill="#c9d3dc">~{(i + 1) * 4} min</text>
          )}
        </g>
      ))}

      {/* rotating adverts */}
      <g clipPath="url(#tvAdClip)">
        <defs>
          <linearGradient id={`adGrad${adIndex}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={ad.from} />
            <stop offset="1" stopColor={ad.to} />
          </linearGradient>
        </defs>
        <g key={adIndex} className={styles.adIn}>
          <rect x="336" y="8" width="276" height="240" fill={`url(#adGrad${adIndex})`} />
          <circle cx="580" cy="60" r="70" fill="#fff" opacity="0.08" />
          <circle cx="360" cy="230" r="50" fill="#fff" opacity="0.06" />
          <rect x="352" y="24" width={ad.tag.length * 7.5 + 18} height="22" rx="11" fill="rgba(0,0,0,0.25)" />
          <text x="361" y="39" fontSize="12" fontWeight="600" fill="#fff">{ad.tag}</text>
          <text x="352" y="140" fontSize="26" fontWeight="700" fill="#fff">{ad.lines[0]}</text>
          <text x="352" y="170" fontSize="26" fontWeight="700" fill="#fff">{ad.lines[1]}</text>
          <text x="352" y="200" fontSize="13" fill="#e2f4f5">{ad.sub}</text>
        </g>
        {ADS.map((_, i) => (
          <circle key={i} cx={352 + i * 14} cy="236" r="3.5" fill="#fff" opacity={i === adIndex ? 0.95 : 0.35} />
        ))}
        <text x="600" y="24" textAnchor="end" fontSize="10" fill="#e2f4f5" opacity="0.7">Advert</text>
      </g>

      {/* ticker */}
      <rect x="8" y="254" width="604" height="28" rx="6" fill="var(--amber-400)" />
      <g clipPath="url(#tvTickClip)">
        <text className={styles.tvTick} x="0" y="273" fontSize="13" fontWeight="600" fill="var(--ink, #0d2a47)" xmlSpace="preserve">{TICKER}</text>
      </g>
    </g>
  );
}

function Window({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect width={w} height={h} rx="6" fill="#cfdad5" />
      <rect x="8" y="8" width={w - 16} height={h - 16} rx="3" fill="url(#windowGlass)" />
      <line x1={w / 2} y1="8" x2={w / 2} y2={h - 8} stroke="#cfdad5" strokeWidth="5" />
      <line x1="8" y1={h * 0.45} x2={w - 8} y2={h * 0.45} stroke="#cfdad5" strokeWidth="5" />
    </g>
  );
}

/** Someone passing along the back of the room: depth, and a sign the place is busy. */
function BgWalker({ id, delay }: { id: number; delay: number }) {
  const person = makePerson(id, 0, 'door');
  return (
    <g transform={`translate(0, ${FLOOR_Y - 44}) scale(0.7)`}>
      <g className={styles.bgWalker} style={{ animationDelay: `${delay}s` }}>
        <g className={styles.walking}>
          <Body person={person} sitting={false} called={false} talking={false} buzzing={false} gaze={{ dx: 0, dy: 0 }} scanning={false} />
        </g>
      </g>
    </g>
  );
}

function WallClock({ x, y, minutes }: { x: number; y: number; minutes: number }) {
  // Hand angles are cumulative so they never spin backwards past 12.
  const handStyle = (deg: number) => ({ transform: `rotate(${deg}deg)` });
  return (
    <g transform={`translate(${x}, ${y})`}>
      <circle r="27" fill="#f5f8f6" stroke="#c8d2cc" strokeWidth="3" />
      {Array.from({ length: 12 }, (_, i) => (
        <line key={i} x1="0" y1="-22" x2="0" y2={i % 3 === 0 ? -17 : -19.5} stroke="#9aa9b5" strokeWidth="1.5" strokeLinecap="round" transform={`rotate(${i * 30})`} />
      ))}
      <line className={styles.hand} style={handStyle(minutes * 0.5)} x1="0" y1="2" x2="0" y2="-12" stroke="var(--ink, #0d2a47)" strokeWidth="3" strokeLinecap="round" />
      <line className={styles.hand} style={handStyle(minutes * 6)} x1="0" y1="3" x2="0" y2="-19" stroke="var(--ink, #0d2a47)" strokeWidth="2" strokeLinecap="round" />
      <circle r="2.5" fill="var(--amber-400)" />
    </g>
  );
}

function Chair({ seat }: { seat: Seat }) {
  // Side view, facing right: backrest at the back, seat running forward.
  return (
    <g transform={`translate(${seat.x}, ${seat.y}) scale(${seat.s})`}>
      <rect x="-23" y="-78" width="8" height="54" rx="4" fill={seat.far ? '#c4cfca' : '#b9c6c1'} />
      <rect x="-23" y="-27" width="46" height="9" rx="4" fill={seat.far ? '#aebcb6' : '#9fb0aa'} />
      <rect x="-19" y="-19" width="5" height="19" rx="2" fill={seat.far ? '#a3b2ac' : '#8c9c97'} />
      <rect x="14" y="-19" width="5" height="19" rx="2" fill={seat.far ? '#a3b2ac' : '#8c9c97'} />
    </g>
  );
}

function WaterCooler({ x }: { x: number }) {
  return (
    <g transform={`translate(${x}, ${FLOOR_Y})`}>
      <ellipse cx="0" cy="-86" rx="12" ry="14" fill="#cfe6ee" stroke="#a9cbd6" strokeWidth="1.5" />
      <rect x="-14" y="-72" width="28" height="72" rx="6" fill="#dfe6e3" />
      <rect x="-14" y="-72" width="28" height="7" rx="3.5" fill="#c7d2cd" />
      <circle cx="-5" cy="-52" r="3" fill="#3b7f99" />
      <circle cx="5" cy="-52" r="3" fill="#c0504d" />
    </g>
  );
}

function Desk({ x, number, serving, callout }: { x: number; number: number; serving: Person | null; callout: Callout | null }) {
  // Keep the call-out inside the scene on the right-most desk.
  const bubbleDx = Math.min(0, SCENE_W - 12 - (x + 56));
  return (
    <g transform={`translate(${x}, ${FLOOR_Y})`}>
      {/* who this desk has called */}
      <rect x="-31" y="-160" width="62" height="26" rx="7" fill="var(--ink, #0d2a47)" />
      {(() => {
        const noShow = !!serving?.noShow && serving.servedTicks >= 1;
        return (
          <text x="0" y="-142" textAnchor="middle" fontSize={noShow ? 12 : serving ? 14 : 11} fontWeight="700" fill={noShow ? '#ff9b8f' : serving ? 'var(--amber-400)' : '#6b7c8a'}>
            {noShow ? 'No show' : serving ? serving.ticket : 'Free'}
          </text>
        );
      })()}
      {/* staff member behind the counter */}
      <circle cx="0" cy="-102" r="11" fill={SKIN[(number * 3) % SKIN.length]} />
      <rect x="-14" y="-90" width="28" height="30" rx="11" fill="var(--primary-700, #1d4f7a)" />
      {/* counter */}
      <rect x="-44" y="-62" width="88" height="62" rx="6" fill="#dfe6e3" />
      <rect x="-44" y="-62" width="88" height="8" rx="4" fill="#c7d2cd" />
      <text x="0" y="-26" textAnchor="middle" fontSize="12" fontWeight="600" fill="#5b6977">
        Desk {number}
      </text>
      <circle cx="30" cy="-44" r="4" fill={serving ? 'var(--primary-400)' : '#b8c4cc'} />
      {/* call-out */}
      {callout && (
        <g key={callout.n} transform={`translate(${bubbleDx}, 0)`}>
          <g className={styles.callout}>
            <path d="M -5 -168 L 0 -161 L 5 -168 Z" fill="white" stroke="#c8d2cc" strokeWidth="1" transform={`translate(${-bubbleDx}, 0)`} />
            <rect x="-56" y="-194" width="112" height="28" rx="14" fill="white" stroke="#c8d2cc" strokeWidth="1" />
            <rect x="-9" y="-168" width="18" height="3" fill="white" transform={`translate(${-bubbleDx}, 0)`} />
            <text x="0" y="-175" textAnchor="middle" fontSize="12.5" fontWeight="700" fill="var(--ink, #0d2a47)">
              {callout.ticket} · Desk {number}
            </text>
          </g>
        </g>
      )}
    </g>
  );
}

export default function LobbyScene() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const sitTimers = useRef(new Map<string, number>());
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const [layout, setLayout] = useState<'wide' | 'compact'>('wide');
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Wide screens show the whole room behind the hero text; smaller ones trim the
  // empty wall either side but keep everything that carries the story (entrance,
  // kiosk, seats, cooler, all three desks and the wall screen), so nothing is cut off.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1280px)');
    const update = () => setLayout(wide.matches ? 'wide' : 'compact');
    update();
    wide.addEventListener?.('change', update);
    return () => wide.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.05 });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || !visible) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') dispatch({ type: 'tick' });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [reduced, visible]);

  const { board, callout, people, t, deskBusy } = state;

  // Someone heading for a chair sits down when they get there, and someone heading for the
  // kiosk holds up their phone when they get there, not before.
  useEffect(() => {
    for (const p of state.people) {
      const toKiosk = p.phase === 'kiosk' && !p.arrived;
      const toChair = p.phase === 'waiting' && p.mode === 'sit' && !p.seated;
      if (!toKiosk && !toChair) continue;
      const key = toKiosk ? `${p.id}-kiosk` : `${p.id}-${p.spot}`;
      if (sitTimers.current.has(key)) continue;
      sitTimers.current.set(key, window.setTimeout(() => dispatch({ type: 'settle', id: p.id }), walkSeconds(p.dist) * 1000 + 150));
    }
  }, [state.people]);
  useEffect(() => {
    const timers = sitTimers.current;
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);

  // With every desk busy, whoever holds the next ticket gets a "You're next"
  // notification on their phone before they're called.
  const order = queueOrder(people);
  const nextUpId = deskBusy.every(Boolean) && order[0]?.phase === 'waiting' ? order[0].id : undefined;
  // Seated people now and then glance up at the wall clock.
  const gazeFor = (p: Person) =>
    p.phase === 'waiting' && p.mode === 'sit' && p.seated && (t + p.id) % 5 === 0
      ? { dx: Math.sign(CLOCK_X - SEATS[p.spot].x) * 1.3, dy: -2.2 }
      : { dx: 0, dy: 0 };
  // Mid-morning, four minutes per beat.
  const clockMinutes = 9 * 60 + 40 + t * 4;
  const waitingList = order;
  const kioskBusy = people.some((p) => p.phase === 'kiosk');
  // Window light warms and cools over a slow day cycle.
  const warm = (1 - Math.cos((2 * Math.PI * t) / 90)) / 2;
  const viewBox = layout === 'wide' ? `0 0 ${VB_W} ${VB_H}` : `${COMPACT.x} ${COMPACT.y} ${COMPACT.w} ${COMPACT.h}`;

  // People standing in the first two loiter spots are a chatting pair; they
  // take turns to "speak".
  const standing = new Map(people.filter((p) => p.phase === 'waiting' && p.mode === 'loiter').map((p) => [p.spot, p]));
  const chatState = (p: Person) => {
    const chatting = p.phase === 'waiting' && p.mode === 'loiter' && p.spot < 2 && standing.has(p.spot ^ 1);
    // Don't talk over a neighbour's "You're next" card.
    return { chatting, speaking: chatting && (t + p.spot) % 2 === 0 && standing.get(p.spot ^ 1)?.id !== nextUpId };
  };

  const renderFigure = (p: Person) => {
    const { chatting, speaking } = chatState(p);
    return <Figure key={p.id} person={p} chatBubble={speaking} talking={chatting} nextUp={p.id === nextUpId} gaze={gazeFor(p)} />;
  };

  return (
    <svg
      ref={ref}
      className={styles.scene}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMax meet"
      // Cropped views clip top and bottom so the wall screen can't spill over the hero text.
      style={layout === 'wide' ? undefined : { clipPath: 'inset(0 -4000px 0 -4000px)' }}
      role="img"
      aria-label="Illustration: people scan a code at the entrance for a ticket, wait in the seats or chat away from the counter, and walk to a desk when their ticket is called out. A wall screen shows who is being served, the next positions with wait times, and adverts."
    >
      {/* wall and floor run well past the edges so the room never looks cropped */}
      <rect x="-4000" y={FLOOR_Y - 90} width="9700" height="90" fill="#e9eeeb" />
      <rect x="-4000" y={FLOOR_Y} width="9700" height={VB_H - FLOOR_Y + 400} fill="#e3e9e5" />
      <line x1="-4000" y1={FLOOR_Y} x2="5700" y2={FLOOR_Y} stroke="#c8d2cc" strokeWidth="2" />
      <line x1="-4000" y1={FLOOR_Y - 90} x2="5700" y2={FLOOR_Y - 90} stroke="#d9e1dd" strokeWidth="2" />

      <g transform={`translate(${OX}, 0)`}>
      {Array.from({ length: 30 }, (_, i) => (
        <line key={i} x1={i * 80 - 500} y1={FLOOR_Y + 2} x2={i * 80 - 560} y2={VB_H} stroke="#d5ddd8" strokeWidth="1.5" />
      ))}
      <path d="M 340 620 L 432 620 L 570 722 L 400 722 Z" fill="#ffd58a" opacity={0.05 + 0.2 * warm} />
      <Window x={330} y={120} w={110} h={240} />
      <WallClock x={CLOCK_X} y={CLOCK_Y} minutes={clockMinutes} />
      <WaitingDisplay board={board} waiting={waitingList} total={waitingList.length} t={t} called={!!callout} />
      {[202, 204, 206].map((id, i) => (
        <BgWalker key={id} id={id} delay={-i * 16} />
      ))}
      {/* waiting-area rugs, one per seating cluster */}
      {[SEATS.filter((x) => x.far), SEATS.filter((x) => !x.far)].map((cluster) => (
        <rect
          key={cluster[0].y}
          x={cluster[0].x - 36 * cluster[0].s}
          y={cluster[0].y + 5 * cluster[0].s}
          width={cluster[cluster.length - 1].x - cluster[0].x + 72 * cluster[0].s}
          height={13 * cluster[0].s}
          rx="6.5"
          fill="#d3ddd7"
        />
      ))}

      {/* the children's play mat, foreground left of the entrance */}
      <g aria-hidden="true">
        <rect x="52" y={FLOOR_Y + 40} width="196" height="78" rx="14" fill="#fff6e0" stroke="#e7d3a1" strokeWidth="1.5" strokeDasharray="5 4" />
        {Array.from({ length: 10 }, (_, k) => (
          <rect
            key={k}
            x={62 + (k % 5) * 35}
            y={FLOOR_Y + 48 + Math.floor(k / 5) * 32}
            width="33"
            height="30"
            rx="5"
            fill={KID_OUTFITS[(k + Math.floor(k / 5)) % KID_OUTFITS.length]}
            opacity="0.55"
          />
        ))}
        {/* blocks and a ball */}
        <rect x="72" y={FLOOR_Y + 84} width="14" height="14" rx="2" fill="#e0b84f" stroke="#a98622" strokeWidth="1" />
        <rect x="88" y={FLOOR_Y + 88} width="14" height="14" rx="2" fill="#d98ca3" stroke="#a15a70" strokeWidth="1" />
        <rect x="78" y={FLOOR_Y + 70} width="14" height="14" rx="2" fill="#8aa7e0" stroke="#5a78b0" strokeWidth="1" />
        <circle cx="228" cy={FLOOR_Y + 98} r="8" fill="#d95f4b" stroke="#a03a2a" strokeWidth="1" />
      </g>

      {/* entrance */}
      <g transform={`translate(${DOOR_X - 38}, ${FLOOR_Y - 150})`}>
        <rect width="76" height="150" rx="6" fill="#d7e0dc" />
        <rect x="8" y="8" width="60" height="142" rx="4" fill="#f5f8f6" />
        <rect x="8" y="8" width="60" height="142" rx="4" fill="url(#doorLight)" />
      </g>

      {/* kiosk */}
      <g transform={`translate(${KIOSK_X}, ${FLOOR_Y})`}>
        <rect x="-8" y="-66" width="16" height="66" rx="4" fill="#9aa9b5" />
        <rect x="-26" y="-116" width="52" height="56" rx="8" fill="var(--ink, #0d2a47)" />
        <rect x="-19" y="-108" width="38" height="40" rx="4" fill={kioskBusy ? '#1f5a57' : '#243444'} />
        {kioskBusy && <rect className={styles.scanBeam} x="-19" y="-108" width="38" height="3" fill="var(--amber-400)" />}
        {/* QR squares */}
        {[[0, 0], [1, 0], [0, 1], [2, 2], [3, 1], [1, 3], [3, 3], [2, 0], [0, 3]].map(([cx, cy], i) => (
          <rect key={i} x={-14 + cx * 7.5} y={-103 + cy * 7.5} width="6" height="6" rx="1" fill="#dcf2f3" />
        ))}
        <text x="0" y="-122" textAnchor="middle" fontSize="11" fontWeight="600" fill="#5b6977">
          Scan to join
        </text>
      </g>

      {/* seating, and a water cooler for those who'd rather stand and talk */}
      {SEATS.filter((seat) => seat.far).map((seat) => (
        <Chair key={`${seat.x}-${seat.y}`} seat={seat} />
      ))}
      <WaterCooler x={COOLER_X} />

      {DESKS.map((x, i) => (
        <Desk
          key={x}
          x={x}
          number={i + 1}
          serving={people.find((p) => p.phase === 'called' && p.desk === i) ?? null}
          callout={callout?.desk === i ? callout : null}
        />
      ))}

      {/* Depth order: walkers and the far cluster, then the near chairs, then people seated in the near cluster. */}
      {people.filter((p) => !p.front).map(renderFigure)}
      {SEATS.filter((seat) => !seat.far).map((seat) => (
        <Chair key={`${seat.x}-${seat.y}`} seat={seat} />
      ))}
      {people.filter((p) => p.front).map(renderFigure)}

      </g>

      <defs>
        <linearGradient id="windowGlass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={mixHex('#eaf5f8', '#fff1d6', warm)} />
          <stop offset="1" stopColor={mixHex('#cfe6ee', '#f6d9a6', warm)} />
        </linearGradient>
        <linearGradient id="doorLight" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#e6efeb" stopOpacity="0.4" />
        </linearGradient>
      </defs>
    </svg>
  );
}
