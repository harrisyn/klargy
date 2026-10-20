'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal,
  AlignStartVertical, AlignVerticalSpaceAround, Circle, Copy, ImagePlus, Maximize2, Redo2, Rows3, Square, Trash2, Undo2, ZoomIn, ZoomOut,
} from 'lucide-react';
import api from '@/api/client';
import { Button, Checkbox, Input, Select } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';
import { placeUnplaced, type MapTable } from './SeatMap';
import {
  HANDLES, align, clamp, distribute, handlePosition, inRectangle, resizeBox, rotationToward,
  type Alignment, type Box, type Handle,
} from './designerGeometry';
import styles from './designer.module.css';

export interface DesignerTable extends MapTable {
  /** Set once saved; new tables have none. */
  saved?: boolean;
  isActive?: boolean;
}

interface Props {
  roomId: string;
  roomName: string;
  /** What a table is called here: table, chair, seat. */
  label: string;
  initial: { layoutWidth: number; layoutHeight: number; layoutImageUrl: string | null; tables: DesignerTable[] };
  onSaved?: () => void;
}

type Gesture =
  | { kind: 'move'; start: { x: number; y: number }; origins: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'resize'; id: string; handle: Handle; origin: Box; moved: boolean }
  | { kind: 'rotate'; id: string; moved: boolean }
  | { kind: 'marquee'; start: { x: number; y: number }; base: string[] };

const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];
let counter = 0;
const tempId = () => `new-${Date.now()}-${++counter}`;
const asBox = (t: DesignerTable): Box => ({ x: t.x ?? 0, y: t.y ?? 0, width: t.width, height: t.height, rotation: t.rotation });

/**
 * Lay out a room: drag tables onto a floor plan (optionally over a picture of
 * the real room), pick several at once, resize and turn them by their handles,
 * line them up, name them and set their seats. Everything can be undone.
 */
export default function FloorPlanDesigner({ roomId, roomName, label, initial, onSaved }: Props) {
  const [size, setSize] = useState({ w: initial.layoutWidth, h: initial.layoutHeight });
  const [imageUrl, setImageUrl] = useState(initial.layoutImageUrl);
  const [tables, setTables] = useState<DesignerTable[]>(() =>
    placeUnplaced(initial.tables.map((t) => ({ ...t, saved: true })), { width: initial.layoutWidth, height: initial.layoutHeight })
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [scale, setScale] = useState(1);
  const [marquee, setMarquee] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  // Undo history lives in a ref (updaters must stay free of side effects); the counter re-renders the buttons.
  const history = useRef<{ past: DesignerTable[][]; future: DesignerTable[][] }>({ past: [], future: [] });
  const [, setHistoryVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [row, setRow] = useState({ count: 8, seats: 1, gap: 20 });
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const lastRecord = useRef({ key: '', at: 0 });

  const selected = useMemo(() => tables.filter((t) => selectedIds.includes(t.id)), [tables, selectedIds]);
  const single = selected.length === 1 ? selected[0] : null;
  const Label = label[0].toUpperCase() + label.slice(1);
  const step = snap ? 10 : 1;

  // --- history
  /** Remember the plan as it is, so the next change can be undone. Edits to one field in quick succession count as one. */
  const record = useCallback((key = '', coalesceMs = 0) => {
    const now = Date.now();
    if (coalesceMs && key && lastRecord.current.key === key && now - lastRecord.current.at < coalesceMs) {
      lastRecord.current.at = now;
      return;
    }
    lastRecord.current = { key, at: now };
    history.current = { past: [...history.current.past.slice(-99), tablesRef.current], future: [] };
    setHistoryVersion((v) => v + 1);
  }, []);

  const step_ = useCallback((from: 'past' | 'future') => {
    const h = history.current;
    const source = from === 'past' ? h.past : h.future;
    if (!source.length) return;
    const target = source[source.length - 1];
    history.current =
      from === 'past'
        ? { past: h.past.slice(0, -1), future: [...h.future, tablesRef.current] }
        : { past: [...h.past, tablesRef.current], future: h.future.slice(0, -1) };
    setTables(target);
    setSelectedIds((ids) => ids.filter((id) => target.some((t) => t.id === id)));
    setDirty(true);
    lastRecord.current = { key: '', at: 0 };
    setHistoryVersion((v) => v + 1);
  }, []);
  const undo = useCallback(() => step_('past'), [step_]);
  const redo = useCallback(() => step_('future'), [step_]);

  /** Change the chosen tables' fields; typing in one field counts as one undo step. */
  const patchMany = useCallback((ids: string[], changes: Partial<DesignerTable>, key?: string) => {
    record(key ? `${key}:${ids.join(',')}` : '', key ? 800 : 0);
    setTables((list) => list.map((t) => (ids.includes(t.id) ? { ...t, ...changes } : t)));
    setDirty(true);
  }, [record]);

  const place = (ids: Map<string, { x: number; y: number }>) => {
    if (!ids.size) return;
    record();
    setTables((list) => list.map((t) => (ids.has(t.id) ? { ...t, ...ids.get(t.id)! } : t)));
    setDirty(true);
  };

  const nextName = (list: DesignerTable[], base = Label) => {
    const taken = new Set(list.map((t) => t.name.toLowerCase()));
    let n = list.length + 1;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  };

  const add = (shape: 'RECT' | 'ROUND') => {
    record();
    const t: DesignerTable = { id: tempId(), name: nextName(tablesRef.current), seats: 4, x: size.w / 2, y: size.h / 2, width: 90, height: 90, rotation: 0, shape, isActive: true };
    setTables((list) => [...list, t]);
    setSelectedIds([t.id]);
    setDirty(true);
  };

  // A row of single seats, for theatre-style rooms, classes or a bar counter.
  const addRow = () => {
    record();
    const count = clamp(Math.floor(row.count) || 1, 1, 100);
    const seats = clamp(Math.floor(row.seats) || 1, 1, 100);
    const list = tablesRef.current;
    const w = seats === 1 ? 44 : 90;
    const stepX = w + clamp(row.gap, 0, 200);
    const startX = Math.max(w / 2 + 20, (size.w - (count - 1) * stepX) / 2);
    const maxY = list.reduce((m, t) => Math.max(m, (t.y ?? 0) + t.height / 2), 40);
    const y = clamp(maxY + 50, 40, size.h - 40);
    const made: DesignerTable[] = [];
    for (let i = 0; i < count; i++) {
      made.push({ id: tempId(), name: nextName([...list, ...made], seats === 1 ? 'Seat' : Label), seats, x: startX + i * stepX, y, width: w, height: w, rotation: 0, shape: seats === 1 ? 'ROUND' : 'RECT', isActive: true });
    }
    setTables([...list, ...made]);
    setSelectedIds(made.map((t) => t.id));
    setDirty(true);
  };

  const duplicate = useCallback(() => {
    const chosen = tablesRef.current.filter((t) => selectedIds.includes(t.id));
    if (!chosen.length) return;
    record();
    const list = [...tablesRef.current];
    const copies: DesignerTable[] = [];
    for (const t of chosen) {
      copies.push({ ...t, id: tempId(), saved: false, name: nextName([...list, ...copies], t.name.replace(/\s*\d+$/, '') || Label), x: clamp((t.x ?? 0) + 40, 0, size.w), y: clamp((t.y ?? 0) + 40, 0, size.h) });
    }
    setTables([...list, ...copies]);
    setSelectedIds(copies.map((t) => t.id));
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, size.w, size.h, record]);

  const remove = useCallback(() => {
    if (!selectedIds.length) return;
    record();
    setTables((list) => list.filter((t) => !selectedIds.includes(t.id)));
    setSelectedIds([]);
    setDirty(true);
  }, [selectedIds, record]);

  // --- pointer: moving, resizing, turning and drawing a selection box
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const capture = (e: React.PointerEvent) => svgRef.current?.setPointerCapture(e.pointerId);

  const onTableDown = (e: React.PointerEvent, t: DesignerTable) => {
    e.stopPropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSelectedIds((ids) => (ids.includes(t.id) ? ids.filter((i) => i !== t.id) : [...ids, t.id]));
      return;
    }
    capture(e);
    const ids = selectedIds.includes(t.id) ? selectedIds : [t.id];
    setSelectedIds(ids);
    gesture.current = {
      kind: 'move',
      start: toSvg(e),
      origins: new Map(tablesRef.current.filter((x) => ids.includes(x.id)).map((x) => [x.id, { x: x.x ?? 0, y: x.y ?? 0 }])),
      moved: false,
    };
  };

  const onHandleDown = (e: React.PointerEvent, t: DesignerTable, handle: Handle) => {
    e.stopPropagation();
    capture(e);
    gesture.current = { kind: 'resize', id: t.id, handle, origin: asBox(t), moved: false };
  };

  const onRotateDown = (e: React.PointerEvent, t: DesignerTable) => {
    e.stopPropagation();
    capture(e);
    gesture.current = { kind: 'rotate', id: t.id, moved: false };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    capture(e);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const start = toSvg(e);
    if (!additive) setSelectedIds([]);
    gesture.current = { kind: 'marquee', start, base: additive ? selectedIds : [] };
    setMarquee({ a: start, b: start });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const p = toSvg(e);
    if (g.kind === 'marquee') {
      setMarquee({ a: g.start, b: p });
      const hit = inRectangle(tablesRef.current.map((t) => ({ id: t.id, ...asBox(t) })), g.start, p);
      setSelectedIds([...new Set([...g.base, ...hit])]);
      return;
    }
    if (!g.moved) {
      // Wait for a real drag before recording, so a plain click isn't an undo step.
      if (g.kind === 'move' && Math.hypot(p.x - g.start.x, p.y - g.start.y) < 3) return;
      g.moved = true;
      record();
    }
    if (g.kind === 'move') {
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      const one = g.origins.size === 1;
      setTables((list) =>
        list.map((t) => {
          const o = g.origins.get(t.id);
          if (!o) return t;
          // A lone table snaps to the grid; a group keeps its spacing and moves in grid steps.
          const x = one ? Math.round((o.x + dx) / step) * step : o.x + Math.round(dx / step) * step;
          const y = one ? Math.round((o.y + dy) / step) * step : o.y + Math.round(dy / step) * step;
          return { ...t, x: clamp(x, 0, size.w), y: clamp(y, 0, size.h) };
        })
      );
    } else if (g.kind === 'resize') {
      const next = resizeBox(g.origin, g.handle, p, { snap, keepRatio: e.shiftKey });
      setTables((list) => list.map((t) => (t.id === g.id ? { ...t, x: next.x, y: next.y, width: next.width, height: next.height } : t)));
    } else if (g.kind === 'rotate') {
      setTables((list) => list.map((t) => (t.id === g.id ? { ...t, rotation: rotationToward({ x: t.x ?? 0, y: t.y ?? 0 }, p, snap && !e.altKey) } : t)));
    }
    setDirty(true);
  };

  const onPointerUp = () => {
    gesture.current = null;
    setMarquee(null);
  };

  // Keep handles a comfortable size however the plan is scaled on screen.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const measure = () => setScale(svg.clientWidth ? size.w / svg.clientWidth : 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [size.w, zoom]);

  // --- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
      if (mod && k === 'y') { e.preventDefault(); return redo(); }
      if (mod && k === 'a') { e.preventDefault(); return setSelectedIds(tablesRef.current.map((t) => t.id)); }
      if (mod && k === 'd') { e.preventDefault(); return duplicate(); }
      if (e.key === 'Escape') return setSelectedIds([]);
      if (!selectedIds.length) return;
      const nudge = e.shiftKey ? 50 : step;
      const move: Record<string, [number, number]> = { ArrowLeft: [-nudge, 0], ArrowRight: [nudge, 0], ArrowUp: [0, -nudge], ArrowDown: [0, nudge] };
      if (move[e.key]) {
        e.preventDefault();
        const [dx, dy] = move[e.key];
        record('nudge', 600);
        setTables((list) => list.map((t) => (selectedIds.includes(t.id) ? { ...t, x: clamp((t.x ?? 0) + dx, 0, size.w), y: clamp((t.y ?? 0) + dy, 0, size.h) } : t)));
        setDirty(true);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, step, size.w, size.h, record, undo, redo, duplicate, remove]);

  const names = useMemo(() => {
    const seen = new Map<string, number>();
    tables.forEach((t) => seen.set(t.name.trim().toLowerCase(), (seen.get(t.name.trim().toLowerCase()) ?? 0) + 1));
    return seen;
  }, [tables]);
  const duplicateName = (t: DesignerTable) => (names.get(t.name.trim().toLowerCase()) ?? 0) > 1;
  const totalSeats = tables.filter((t) => t.isActive !== false).reduce((n, t) => n + t.seats, 0);

  const save = async () => {
    if (tables.some((t) => !t.name.trim())) return toast.error('Every table needs a name.');
    if (tables.some(duplicateName)) return toast.error('Two tables have the same name.');
    setSaving(true);
    try {
      const r = await api.saveRoomLayout(roomId, {
        layoutWidth: size.w,
        layoutHeight: size.h,
        tables: tables.map((t) => ({ id: t.saved ? t.id : undefined, name: t.name.trim(), seats: t.seats, x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation, shape: t.shape, isActive: t.isActive !== false })),
      });
      setTables(placeUnplaced(r.tables.map((t) => ({ ...t, saved: true })), { width: r.layoutWidth, height: r.layoutHeight }));
      setSelectedIds([]);
      history.current = { past: [], future: [] };
      setDirty(false);
      toast.success('Floor plan saved.');
      onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save the floor plan.'));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const r = await api.uploadRoomImage(roomId, file);
      setImageUrl(r.layoutImageUrl);
      toast.success('Picture added behind the plan. Drag tables onto the real layout.');
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t upload the picture.'));
    } finally {
      setUploading(false);
    }
  };

  const dropImage = async () => {
    try {
      await api.removeRoomImage(roomId);
      setImageUrl(null);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t remove the picture.'));
    }
  };

  const zoomBy = (dir: 1 | -1) => setZoom((z) => ZOOMS[clamp(ZOOMS.indexOf(z) + dir, 0, ZOOMS.length - 1)] ?? 1);
  const boxes = () => selected.map((t) => ({ id: t.id, ...asBox(t) }));
  const same = <K extends keyof DesignerTable>(k: K) => (selected.length && selected.every((t) => t[k] === selected[0][k]) ? selected[0][k] : undefined);

  const hs = clamp(11 * scale, 8, 60);
  const alignBtn = (how: Alignment, title: string, Icon: typeof AlignStartVertical) => (
    <Button key={how} type="button" variant="ghost" size="sm" title={title} aria-label={title} onClick={() => place(align(boxes(), how))} disabled={selected.length < 2}><Icon size={14} /></Button>
  );

  return (
    <div className={styles.designer}>
      <div className={styles.toolbar}>
        <Button type="button" variant="secondary" size="sm" onClick={() => add('RECT')}><Square size={14} /> Add {label}</Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => add('ROUND')}><Circle size={14} /> Add round</Button>
        <Button type="button" variant="secondary" size="sm" onClick={duplicate} disabled={!selected.length}><Copy size={14} /> Duplicate</Button>
        <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={!selected.length}><Trash2 size={14} /> Remove</Button>
        <span className={styles.divider} />
        <Button type="button" variant="ghost" size="sm" onClick={undo} disabled={!history.current.past.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={14} /></Button>
        <Button type="button" variant="ghost" size="sm" onClick={redo} disabled={!history.current.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 size={14} /></Button>
        <span className={styles.divider} />
        <Button type="button" variant="ghost" size="sm" onClick={() => zoomBy(-1)} disabled={zoom === ZOOMS[0]} title="Zoom out" aria-label="Zoom out"><ZoomOut size={14} /></Button>
        <span className={styles.zoom} aria-live="polite">{Math.round(zoom * 100)}%</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => zoomBy(1)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} title="Zoom in" aria-label="Zoom in"><ZoomIn size={14} /></Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setZoom(1)} title="Fit to window" aria-label="Fit to window"><Maximize2 size={14} /></Button>
        <span className={styles.spacer} />
        <Checkbox checked={snap} onChange={(e) => setSnap(e.target.checked)} label="Snap to grid" />
        <Button type="button" variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save plan'}</Button>
      </div>

      <div className={styles.body}>
        <div className={styles.canvasWrap}>
          <div className={styles.scroller} style={{ maxHeight: zoom > 1 ? '70vh' : undefined }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${size.w} ${size.h}`}
              className={styles.canvas}
              style={{ width: `${zoom * 100}%`, maxHeight: zoom === 1 ? undefined : 'none' }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerDown={onBackgroundDown}
              aria-label={`Floor plan of ${roomName}`}
            >
              <defs>
                <pattern id="grid" width={snap ? 10 : 50} height={snap ? 10 : 50} patternUnits="userSpaceOnUse">
                  <path d={`M ${snap ? 10 : 50} 0 L 0 0 0 ${snap ? 10 : 50}`} fill="none" stroke="#d9e0e0" strokeWidth="0.6" />
                </pattern>
              </defs>
              <rect width={size.w} height={size.h} fill="#f4f7f6" />
              {imageUrl && <image href={imageUrl} width={size.w} height={size.h} preserveAspectRatio="xMidYMid slice" opacity={0.7} />}
              <rect width={size.w} height={size.h} fill="url(#grid)" />
              {tables.map((t) => {
                const on = selectedIds.includes(t.id);
                const bad = duplicateName(t);
                return (
                  <g
                    key={t.id}
                    transform={`translate(${t.x ?? 0} ${t.y ?? 0}) rotate(${t.rotation})`}
                    className={`${styles.table} ${on ? styles.on : ''} ${bad ? styles.bad : ''} ${t.isActive === false ? styles.off : ''}`}
                    onPointerDown={(e) => onTableDown(e, t)}
                  >
                    {t.shape === 'ROUND' ? <ellipse rx={t.width / 2} ry={t.height / 2} /> : <rect x={-t.width / 2} y={-t.height / 2} width={t.width} height={t.height} rx={8} />}
                    <g transform={`rotate(${-t.rotation})`} pointerEvents="none">
                      <text y={t.height < 60 ? 0 : -4} textAnchor="middle" dominantBaseline="middle" className={styles.tname}>{t.name}</text>
                      {t.height >= 60 && <text y={14} textAnchor="middle" dominantBaseline="middle" className={styles.tseats}>{t.seats} {t.seats === 1 ? 'seat' : 'seats'}</text>}
                    </g>
                    {single?.id === t.id && (
                      <g>
                        <line x1={0} y1={-t.height / 2} x2={0} y2={-t.height / 2 - hs * 2.4} className={styles.stem} />
                        <circle cx={0} cy={-t.height / 2 - hs * 2.4} r={hs * 0.75} className={styles.rotateHandle} onPointerDown={(e) => onRotateDown(e, t)}>
                          <title>Drag to turn (Alt for free turning)</title>
                        </circle>
                        {HANDLES.map((h) => {
                          const pos = handlePosition(t, h);
                          return <rect key={h} x={pos.x - hs / 2} y={pos.y - hs / 2} width={hs} height={hs} rx={hs * 0.2} className={styles.handle} style={{ cursor: CURSORS[h] }} onPointerDown={(e) => onHandleDown(e, t, h)} />;
                        })}
                      </g>
                    )}
                  </g>
                );
              })}
              {marquee && (
                <rect
                  x={Math.min(marquee.a.x, marquee.b.x)}
                  y={Math.min(marquee.a.y, marquee.b.y)}
                  width={Math.abs(marquee.a.x - marquee.b.x)}
                  height={Math.abs(marquee.a.y - marquee.b.y)}
                  className={styles.marquee}
                  pointerEvents="none"
                />
              )}
            </svg>
          </div>
          <p className={styles.hint}>
            {tables.length} {tables.length === 1 ? label : `${label}s`} · {totalSeats} seats · drag to move, drag empty space to select several (or Shift-click), pull the squares to resize and the circle to turn. Arrow keys nudge, Delete removes, Ctrl+Z undoes.
          </p>
        </div>

        <aside className={styles.panel} aria-label="Details">
          {single ? (
            <div className={styles.fields}>
              <h4>{single.name || label}</h4>
              <Input label="Name" value={single.name} onChange={(e) => patchMany([single.id], { name: e.target.value }, 'name')} error={duplicateName(single) ? 'Another one has this name' : undefined} />
              <Input label="Seats" type="number" min={1} max={100} value={single.seats} onChange={(e) => patchMany([single.id], { seats: clamp(Math.floor(Number(e.target.value)) || 1, 1, 100) }, 'seats')} />
              <Select label="Shape" value={single.shape} onChange={(e) => patchMany([single.id], { shape: e.target.value })}>
                <option value="RECT">Square or rectangle</option>
                <option value="ROUND">Round</option>
              </Select>
              <div className={styles.pair}>
                <Input label="Width" type="number" min={20} max={600} value={single.width} onChange={(e) => patchMany([single.id], { width: clamp(Number(e.target.value) || 20, 20, 600) }, 'size')} />
                <Input label="Height" type="number" min={20} max={600} value={single.height} onChange={(e) => patchMany([single.id], { height: clamp(Number(e.target.value) || 20, 20, 600) }, 'size')} />
              </div>
              <Input label="Turn (degrees)" type="number" min={-180} max={180} step={15} value={single.rotation} onChange={(e) => patchMany([single.id], { rotation: clamp(Number(e.target.value) || 0, -180, 180) }, 'turn')} />
              <Checkbox checked={single.isActive !== false} onChange={(e) => patchMany([single.id], { isActive: e.target.checked })} label="In use (untick to take it out of service)" />
            </div>
          ) : selected.length > 1 ? (
            <div className={styles.fields}>
              <h4>{selected.length} {label}s chosen</h4>
              <Input
                label="Seats each"
                type="number"
                min={1}
                max={100}
                value={same('seats') ?? ''}
                placeholder="Mixed"
                onChange={(e) => e.target.value !== '' && patchMany(selectedIds, { seats: clamp(Math.floor(Number(e.target.value)) || 1, 1, 100) }, 'seats')}
              />
              <Select label="Shape" value={String(same('shape') ?? '')} onChange={(e) => e.target.value && patchMany(selectedIds, { shape: e.target.value })}>
                {same('shape') === undefined && <option value="">Mixed</option>}
                <option value="RECT">Square or rectangle</option>
                <option value="ROUND">Round</option>
              </Select>
              <div>
                <div className="field-label">Line up</div>
                <div className={styles.row}>
                  {alignBtn('left', 'Align left edges', AlignStartVertical)}
                  {alignBtn('center', 'Centre horizontally', AlignCenterVertical)}
                  {alignBtn('right', 'Align right edges', AlignEndVertical)}
                  {alignBtn('top', 'Align top edges', AlignStartHorizontal)}
                  {alignBtn('middle', 'Centre vertically', AlignCenterHorizontal)}
                  {alignBtn('bottom', 'Align bottom edges', AlignEndHorizontal)}
                </div>
                <div className={styles.row}>
                  <Button type="button" variant="ghost" size="sm" onClick={() => place(distribute(boxes(), 'x'))} disabled={selected.length < 3} title="Space evenly across"><AlignHorizontalSpaceAround size={14} /> Space across</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => place(distribute(boxes(), 'y'))} disabled={selected.length < 3} title="Space evenly down"><AlignVerticalSpaceAround size={14} /> Space down</Button>
                </div>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={() => patchMany(selectedIds, { width: selected[0].width, height: selected[0].height, rotation: selected[0].rotation })}>Make all the size of the first</Button>
              <Checkbox checked={selected.every((t) => t.isActive !== false)} onChange={(e) => patchMany(selectedIds, { isActive: e.target.checked })} label="In use" />
            </div>
          ) : (
            <p className={styles.empty}>Select a {label} to change its name, seats, shape or size. Drag across empty space to choose several.</p>
          )}

          <div className={styles.fields}>
            <h4>Add a row of seats</h4>
            <div className={styles.pair}>
              <Input label="How many" type="number" min={1} max={100} value={row.count} onChange={(e) => setRow({ ...row, count: Number(e.target.value) })} />
              <Input label="Seats each" type="number" min={1} max={100} value={row.seats} onChange={(e) => setRow({ ...row, seats: Number(e.target.value) })} />
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={addRow}><Rows3 size={14} /> Add row</Button>
          </div>

          <div className={styles.fields}>
            <h4>Room picture and size</h4>
            <p className={styles.small}>Upload a photo or plan of the real room and place the {label}s on top of it.</p>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            <div className={styles.row}>
              <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}><ImagePlus size={14} /> {uploading ? 'Uploading…' : imageUrl ? 'Replace picture' : 'Add picture'}</Button>
              {imageUrl && <Button type="button" variant="ghost" size="sm" onClick={dropImage}>Remove</Button>}
            </div>
            <div className={styles.pair}>
              <Input label="Plan width" type="number" min={200} max={5000} value={size.w} onChange={(e) => { setSize({ ...size, w: clamp(Number(e.target.value) || 200, 200, 5000) }); setDirty(true); }} />
              <Input label="Plan height" type="number" min={200} max={5000} value={size.h} onChange={(e) => { setSize({ ...size, h: clamp(Number(e.target.value) || 200, 200, 5000) }); setDirty(true); }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
