'use client';

import React from 'react';
import styles from './seatmap.module.css';

export interface MapTable {
  id: string;
  name: string;
  seats: number;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  shape: string;
  /** free: can be picked. taken: someone has it then. unavailable: the room's rules don't allow it. */
  status?: 'free' | 'taken' | 'unavailable';
}

export interface MapLayout {
  width: number;
  height: number;
  imageUrl: string | null;
}

/** Gives tables that were never placed a spot on a tidy grid, so they still show up. */
export function placeUnplaced<T extends Pick<MapTable, 'x' | 'y' | 'width' | 'height'>>(tables: T[], layout: Pick<MapLayout, 'width' | 'height'>): (T & { x: number; y: number })[] {
  const cell = Math.max(0, ...tables.map((t) => Math.max(t.width, t.height))) + 30 || 120;
  const cols = Math.max(1, Math.floor((layout.width - 40) / cell));
  let i = 0;
  return tables.map((t) => {
    if (t.x != null && t.y != null) return t as T & { x: number; y: number };
    const col = i % cols;
    const row = Math.floor(i / cols);
    i++;
    return { ...t, x: 40 + cell / 2 + col * cell, y: 40 + cell / 2 + row * cell };
  });
}

interface Props {
  layout: MapLayout;
  tables: MapTable[];
  selectedIds?: string[];
  /** Makes free tables pickable. */
  onToggle?: (id: string) => void;
  /** A line under a table's name (a guest and party, in the host's view). */
  notes?: Record<string, string>;
  /** Largest height on screen. */
  maxHeight?: number;
}

/** A room's floor plan: the real picture behind, tables on top, coloured by whether they can be picked. */
export default function SeatMap({ layout, tables, selectedIds = [], onToggle, notes, maxHeight = 520 }: Props) {
  const placed = placeUnplaced(tables, layout);
  const selected = new Set(selectedIds);
  return (
    <div className={styles.frame} style={{ maxHeight }}>
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className={styles.svg} role="group" aria-label="Floor plan" preserveAspectRatio="xMidYMid meet" style={{ maxHeight }}>
        <rect x={0} y={0} width={layout.width} height={layout.height} className={styles.floor} />
        {layout.imageUrl && <image href={layout.imageUrl} x={0} y={0} width={layout.width} height={layout.height} preserveAspectRatio="xMidYMid slice" opacity={0.85} />}
        {placed.map((t) => {
          const status = t.status ?? 'free';
          const on = selected.has(t.id);
          const pickable = !!onToggle && (status === 'free' || on);
          const cls = on ? styles.selected : status === 'taken' ? styles.taken : status === 'unavailable' ? styles.unavailable : styles.free;
          return (
            <g
              key={t.id}
              transform={`translate(${t.x} ${t.y}) rotate(${t.rotation})`}
              className={`${cls} ${pickable ? styles.pickable : ''}`}
              role={onToggle ? 'button' : undefined}
              aria-pressed={onToggle ? on : undefined}
              aria-disabled={onToggle ? !pickable : undefined}
              aria-label={`${t.name}, seats ${t.seats}, ${on ? 'chosen' : status}`}
              tabIndex={pickable ? 0 : undefined}
              onClick={pickable ? () => onToggle!(t.id) : undefined}
              onKeyDown={pickable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle!(t.id)) : undefined}
            >
              {t.shape === 'ROUND' ? (
                <ellipse rx={t.width / 2} ry={t.height / 2} className={styles.shape} />
              ) : (
                <rect x={-t.width / 2} y={-t.height / 2} width={t.width} height={t.height} rx={8} className={styles.shape} />
              )}
              {/* Text stays upright however the table is turned. */}
              <g transform={`rotate(${-t.rotation})`}>
                <text y={notes?.[t.id] ? -6 : 0} textAnchor="middle" dominantBaseline="middle" className={styles.name}>{t.name}</text>
                <text y={notes?.[t.id] ? 8 : 16} textAnchor="middle" dominantBaseline="middle" className={styles.seatsText}>{notes?.[t.id] ?? `${t.seats} ${t.seats === 1 ? 'seat' : 'seats'}`}</text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function SeatMapLegend({ picking }: { picking?: boolean }) {
  return (
    <ul className={styles.legend} aria-label="Key">
      <li><span className={styles.swFree} /> Free</li>
      {picking && <li><span className={styles.swSelected} /> Your choice</li>}
      <li><span className={styles.swTaken} /> Taken</li>
      <li><span className={styles.swUnavailable} /> Not available</li>
    </ul>
  );
}
