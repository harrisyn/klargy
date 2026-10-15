'use client';

import React, { useEffect, useReducer, useRef, useState } from 'react';
import styles from './landing.module.css';

/**
 * The landing hero's lobby: people walk in, tap the kiosk for a ticket,
 * join the line, and are called to a desk when the board shows their
 * number. Driven by a tiny state machine; each figure is positioned with a
 * CSS transform so movement is a transition, not per-frame JS.
 */

const SCENE_W = 1200;
const FLOOR_Y = 318;
const DOOR_X = 64;
const KIOSK_X = 196;
const FRONT_X = 740;
const SLOT_GAP = 62;
const MAX_LINE = 7;
const DESKS = [930, 1040, 1150];
const EXIT_X = SCENE_W + 60;
const TICK_MS = 2600;

const OUTFITS = ['#5b7fa6', '#9cbab9', '#c08a5b', '#6f6a93', '#9c6b6b', '#3b7f99', '#b59a55', '#7a8c9e'];
const SKIN = ['#f1d3b8', '#d9a67e', '#a86f4c', '#6e4630'];

type Phase = 'door' | 'kiosk' | 'line' | 'called' | 'leaving';

interface Person {
  id: number;
  ticket: string;
  outfit: string;
  skin: string;
  phase: Phase;
  slot: number; // line position, 0 = front
  desk: number;
  servedTicks: number;
  walking: boolean;
  hasTicket: boolean;
}

interface State {
  people: Person[];
  nextId: number;
  nextNumber: number;
  board: { ticket: string; desk: number } | null;
  deskBusy: boolean[];
}

const ticketLabel = (n: number) => `C${String(n).padStart(3, '0')}`;

function makePerson(id: number, number: number, phase: Phase, slot = 0): Person {
  return {
    id,
    ticket: ticketLabel(number),
    outfit: OUTFITS[id % OUTFITS.length],
    skin: SKIN[(id * 7) % SKIN.length],
    phase,
    slot,
    desk: -1,
    servedTicks: 0,
    walking: false,
    hasTicket: phase !== 'door',
  };
}

function initialState(): State {
  // Start mid-morning: a line already formed and one person at a desk.
  const people: Person[] = [];
  let id = 1;
  let number = 11;
  const atDesk = makePerson(id++, number++, 'called');
  atDesk.desk = 1;
  atDesk.servedTicks = 1;
  people.push(atDesk);
  for (let slot = 0; slot < 6; slot++) people.push(makePerson(id++, number++, 'line', slot));
  return {
    people,
    nextId: id,
    nextNumber: number,
    board: { ticket: atDesk.ticket, desk: 1 },
    deskBusy: [false, true, false],
  };
}

function tick(state: State): State {
  let { nextId, nextNumber, board } = state;
  const deskBusy = [...state.deskBusy];
  let people = state.people
    .filter((p) => !(p.phase === 'leaving' && p.walking === false && p.servedTicks > 3))
    .map((p) => ({ ...p, walking: false }));

  // Served people leave after a couple of beats, freeing the desk.
  people = people.map((p) => {
    if (p.phase === 'called') {
      if (p.servedTicks >= 4) {
        deskBusy[p.desk] = false;
        return { ...p, phase: 'leaving' as Phase, walking: true, servedTicks: p.servedTicks + 1 };
      }
      return { ...p, servedTicks: p.servedTicks + 1 };
    }
    if (p.phase === 'leaving') return { ...p, servedTicks: p.servedTicks + 1 };
    return p;
  });

  // Call the front of the line to a free desk.
  const freeDesk = deskBusy.findIndex((busy) => !busy);
  const front = people.find((p) => p.phase === 'line' && p.slot === 0);
  if (freeDesk !== -1 && front) {
    deskBusy[freeDesk] = true;
    board = { ticket: front.ticket, desk: freeDesk };
    people = people.map((p) => {
      if (p.id === front.id) return { ...p, phase: 'called' as Phase, desk: freeDesk, servedTicks: 0, walking: true };
      if (p.phase === 'line') return { ...p, slot: p.slot - 1, walking: true };
      return p;
    });
  }

  // Kiosk -> back of the line; door -> kiosk.
  const lineLength = people.filter((p) => p.phase === 'line').length;
  people = people.map((p) => {
    if (p.phase === 'kiosk') return { ...p, phase: 'line' as Phase, slot: lineLength, walking: true };
    if (p.phase === 'door') return { ...p, phase: 'kiosk' as Phase, walking: true, hasTicket: false };
    return p;
  });
  // The kiosk prints the ticket a moment after they arrive (see render).
  people = people.map((p) => (p.phase === 'line' ? { ...p, hasTicket: true } : p));

  // Someone new walks in most beats, while the line has room.
  const waiting = people.filter((p) => p.phase === 'line' || p.phase === 'kiosk').length;
  if (waiting < MAX_LINE && !people.some((p) => p.phase === 'door')) {
    people.push({ ...makePerson(nextId++, nextNumber++, 'door'), hasTicket: false });
  }

  return { people, nextId, nextNumber, board, deskBusy };
}

function xFor(p: Person): number {
  switch (p.phase) {
    case 'door':
      return DOOR_X;
    case 'kiosk':
      return KIOSK_X + 34;
    case 'line':
      return FRONT_X - p.slot * SLOT_GAP;
    case 'called':
      // Stand at the customer side of the counter, clear of the staff member.
      return DESKS[p.desk] - 62;
    case 'leaving':
      return EXIT_X;
  }
}

function Figure({ person }: { person: Person }) {
  const called = person.phase === 'called' || person.phase === 'leaving';
  const x = xFor(person);
  const duration = person.phase === 'called' ? 1.5 : person.phase === 'leaving' ? 2.2 : person.phase === 'line' ? 1.1 : 1.3;
  return (
    <g
      className={styles.figure}
      style={{
        transform: `translate(${x}px, ${FLOOR_Y}px)`,
        transitionDuration: `${duration}s`,
        opacity: person.phase === 'leaving' ? 0 : 1,
      }}
    >
      <g className={person.walking ? styles.walking : undefined}>
        {/* shadow */}
        <ellipse cx="0" cy="0" rx="17" ry="4" fill="rgba(28,39,51,0.12)" />
        {/* legs */}
        <rect x="-9" y="-30" width="7" height="30" rx="3.5" fill="#34404c" />
        <rect x="2" y="-30" width="7" height="30" rx="3.5" fill="#34404c" />
        {/* body */}
        <rect x="-15" y="-74" width="30" height="48" rx="13" fill={called ? 'var(--primary-500)' : person.outfit} />
        {/* phone glow when they have a ticket */}
        {person.hasTicket && !called && <rect x="8" y="-58" width="7" height="11" rx="2" fill="#dcf2f3" opacity="0.9" />}
        {/* head */}
        <circle cx="0" cy="-88" r="12" fill={person.skin} />
      </g>
      {person.hasTicket && person.phase !== 'leaving' && (
        <g className={called ? styles.ticketCalled : styles.ticket} transform="translate(0,-114)">
          <rect x="-22" y="-11" width="44" height="20" rx="5" fill={called ? 'var(--primary-500)' : 'var(--amber-400)'} />
          <text x="0" y="3.5" textAnchor="middle" fontSize="11" fontWeight="700" fill={called ? 'white' : '#0d2a47'}>
            {person.ticket}
          </text>
        </g>
      )}
    </g>
  );
}

function Desk({ x, number, busy }: { x: number; number: number; busy: boolean }) {
  return (
    <g transform={`translate(${x}, ${FLOOR_Y})`}>
      {/* staff member behind the counter */}
      <circle cx="0" cy="-102" r="11" fill={SKIN[(number * 3) % SKIN.length]} />
      <rect x="-14" y="-90" width="28" height="30" rx="11" fill="#1d4f7a" />
      {/* counter */}
      <rect x="-44" y="-62" width="88" height="62" rx="6" fill="#dfe6e3" />
      <rect x="-44" y="-62" width="88" height="8" rx="4" fill="#c7d2cd" />
      <text x="0" y="-26" textAnchor="middle" fontSize="12" fontWeight="600" fill="#5b6977">
        Desk {number}
      </text>
      <circle cx="30" cy="-44" r="4" fill={busy ? 'var(--primary-400)' : '#b8c4cc'} />
    </g>
  );
}

export default function LobbyScene() {
  const [state, dispatch] = useReducer((s: State, a: 'tick') => (a === 'tick' ? tick(s) : s), undefined, initialState);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
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
      if (document.visibilityState === 'visible') dispatch('tick');
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [reduced, visible]);

  const { board } = state;

  return (
    <svg
      ref={ref}
      className={styles.scene}
      viewBox={`0 0 ${SCENE_W} 360`}
      preserveAspectRatio="xMaxYMax slice"
      role="img"
      aria-label="Illustration: people take a ticket at a kiosk, wait in line, and walk to a desk when the board calls their number."
    >
      {/* back wall and floor */}
      <rect x="0" y="0" width={SCENE_W} height={FLOOR_Y} fill="transparent" />
      <rect x="0" y={FLOOR_Y} width={SCENE_W} height={360 - FLOOR_Y} fill="#e3e9e5" />
      <line x1="0" y1={FLOOR_Y} x2={SCENE_W} y2={FLOOR_Y} stroke="#c8d2cc" strokeWidth="2" />
      {Array.from({ length: 16 }, (_, i) => (
        <line key={i} x1={i * 80 + 20} y1={FLOOR_Y + 2} x2={i * 80 - 40} y2="360" stroke="#d5ddd8" strokeWidth="1.5" />
      ))}

      {/* entrance */}
      <g transform={`translate(${DOOR_X - 38}, ${FLOOR_Y - 150})`}>
        <rect width="76" height="150" rx="6" fill="#d7e0dc" />
        <rect x="8" y="8" width="60" height="142" rx="4" fill="#f5f8f6" />
        <rect x="8" y="8" width="60" height="142" rx="4" fill="url(#doorLight)" />
      </g>

      {/* kiosk */}
      <g transform={`translate(${KIOSK_X}, ${FLOOR_Y})`}>
        <rect x="-8" y="-66" width="16" height="66" rx="4" fill="#9aa9b5" />
        <rect x="-26" y="-116" width="52" height="56" rx="8" fill="#0d2a47" />
        <rect x="-19" y="-108" width="38" height="40" rx="4" fill="#243444" />
        {/* QR squares */}
        {[[0, 0], [1, 0], [0, 1], [2, 2], [3, 1], [1, 3], [3, 3], [2, 0], [0, 3]].map(([cx, cy], i) => (
          <rect key={i} x={-14 + cx * 7.5} y={-103 + cy * 7.5} width="6" height="6" rx="1" fill="#dcf2f3" />
        ))}
        <text x="0" y="-122" textAnchor="middle" fontSize="11" fontWeight="600" fill="#5b6977">
          Scan to join
        </text>
      </g>

      {/* now-serving board */}
      <g transform="translate(868, 36)">
        <rect width="304" height="86" rx="10" fill="#0d2a47" />
        <text x="20" y="30" fontSize="13" fontWeight="600" fill="#8fa0ae">
          Now serving
        </text>
        <text key={board?.ticket} className={styles.boardTicket} x="20" y="70" fontSize="36" fontWeight="700" fill="var(--amber-400)">
          {board?.ticket ?? '-'}
        </text>
        <text x="284" y="70" textAnchor="end" fontSize="20" fontWeight="600" fill="#dfe6ea">
          {board ? `Desk ${board.desk + 1}` : ''}
        </text>
        <line x1="136" y1="0" x2="136" y2="-36" stroke="#9aa9b5" strokeWidth="2" />
        <line x1="168" y1="0" x2="168" y2="-36" stroke="#9aa9b5" strokeWidth="2" />
      </g>

      {/* queue guide posts */}
      {[FRONT_X + 34, FRONT_X - 6 * SLOT_GAP - 30].map((x) => (
        <g key={x} transform={`translate(${x}, ${FLOOR_Y})`}>
          <rect x="-3" y="-44" width="6" height="44" rx="3" fill="#9aa9b5" />
          <circle cx="0" cy="-46" r="6" fill="#9aa9b5" />
        </g>
      ))}
      <path
        d={`M ${FRONT_X - 6 * SLOT_GAP - 30} ${FLOOR_Y - 40} Q ${(FRONT_X - 3 * SLOT_GAP)} ${FLOOR_Y - 30} ${FRONT_X + 34} ${FLOOR_Y - 40}`}
        stroke="var(--primary-300)"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
        opacity="0.8"
      />

      {DESKS.map((x, i) => (
        <Desk key={x} x={x} number={i + 1} busy={state.deskBusy[i]} />
      ))}

      {state.people.map((p) => (
        <Figure key={p.id} person={p} />
      ))}

      <defs>
        <linearGradient id="doorLight" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#e6efeb" stopOpacity="0.4" />
        </linearGradient>
      </defs>
    </svg>
  );
}
