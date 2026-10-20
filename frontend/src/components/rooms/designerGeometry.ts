/**
 * The maths behind the floor-plan designer: resizing and turning a table by its
 * handles (which works on tables that are already rotated), choosing tables
 * with a drag box, and lining them up. Pure, so it can be tested.
 */

export interface Box {
  /** Centre of the table on the plan. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const MIN_SIZE = 20;
export const MAX_SIZE = 600;

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Where a handle sits on an un-rotated table, relative to its centre. */
export function handlePosition(box: Pick<Box, 'width' | 'height'>, handle: Handle): { x: number; y: number } {
  const hw = box.width / 2;
  const hh = box.height / 2;
  return { x: handle.includes('e') ? hw : handle.includes('w') ? -hw : 0, y: handle.includes('s') ? hh : handle.includes('n') ? -hh : 0 };
}

/** A plan point seen from the table's own (turned) frame, centred on the table. */
function toLocal(box: Box, p: { x: number; y: number }) {
  const r = rad(-box.rotation);
  const dx = p.x - box.x;
  const dy = p.y - box.y;
  return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * Drag a handle to a plan point: the opposite edge or corner stays where it
 * is. Sizes snap to the grid and stay within limits; `keepRatio` holds the
 * shape when a corner is dragged.
 */
export function resizeBox(box: Box, handle: Handle, point: { x: number; y: number }, opts: { snap?: boolean; keepRatio?: boolean } = {}): Box {
  const step = opts.snap ? 10 : 1;
  const l = toLocal(box, point);
  const hw = box.width / 2;
  const hh = box.height / 2;
  const east = handle.includes('e');
  const west = handle.includes('w');
  const south = handle.includes('s');
  const north = handle.includes('n');
  const sideways = east || west;
  const vertical = south || north;

  let w = box.width;
  let h = box.height;
  if (east) w = l.x + hw;
  if (west) w = hw - l.x;
  if (south) h = l.y + hh;
  if (north) h = hh - l.y;
  if (opts.keepRatio && sideways && vertical) {
    const s = Math.max(w / box.width, h / box.height);
    w = box.width * s;
    h = box.height * s;
  }
  if (sideways) w = clamp(Math.round(w / step) * step, MIN_SIZE, MAX_SIZE);
  if (vertical) h = clamp(Math.round(h / step) * step, MIN_SIZE, MAX_SIZE);

  // The opposite side stays put, so the centre moves by half the change.
  const cx = east ? -hw + w / 2 : west ? hw - w / 2 : 0;
  const cy = south ? -hh + h / 2 : north ? hh - h / 2 : 0;
  const r = rad(box.rotation);
  return {
    x: box.x + cx * Math.cos(r) - cy * Math.sin(r),
    y: box.y + cx * Math.sin(r) + cy * Math.cos(r),
    width: w,
    height: h,
    rotation: box.rotation,
  };
}

/** The turn (degrees, -180 to 180) that points a table's top handle at a plan point. */
export function rotationToward(box: Pick<Box, 'x' | 'y'>, point: { x: number; y: number }, snap: boolean): number {
  let deg = (Math.atan2(point.y - box.y, point.x - box.x) * 180) / Math.PI + 90;
  if (snap) deg = Math.round(deg / 15) * 15;
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;
  return Math.round(deg) === -180 ? 180 : Math.round(deg);
}

export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The smallest upright rectangle around a (possibly turned) table. */
export function boundsOf(box: Box): Bounds {
  const r = rad(box.rotation);
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const hx = (box.width / 2) * c + (box.height / 2) * s;
  const hy = (box.width / 2) * s + (box.height / 2) * c;
  return { left: box.x - hx, right: box.x + hx, top: box.y - hy, bottom: box.y + hy };
}

/** Tables a drag box touches. */
export function inRectangle<T extends Box & { id: string }>(items: T[], a: { x: number; y: number }, b: { x: number; y: number }): string[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return items
    .filter((t) => {
      const bb = boundsOf(t);
      return bb.left <= right && bb.right >= left && bb.top <= bottom && bb.bottom >= top;
    })
    .map((t) => t.id);
}

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** New centres that line the tables up on the chosen edge or middle of the group. */
export function align<T extends Box & { id: string }>(items: T[], how: Alignment): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length < 2) return out;
  const bs = items.map((t) => ({ t, b: boundsOf(t) }));
  const left = Math.min(...bs.map(({ b }) => b.left));
  const right = Math.max(...bs.map(({ b }) => b.right));
  const top = Math.min(...bs.map(({ b }) => b.top));
  const bottom = Math.max(...bs.map(({ b }) => b.bottom));
  for (const { t, b } of bs) {
    let { x, y } = t;
    if (how === 'left') x = left + (t.x - b.left);
    if (how === 'right') x = right - (b.right - t.x);
    if (how === 'center') x = (left + right) / 2;
    if (how === 'top') y = top + (t.y - b.top);
    if (how === 'bottom') y = bottom - (b.bottom - t.y);
    if (how === 'middle') y = (top + bottom) / 2;
    out.set(t.id, { x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/** New centres that spread the tables evenly between the two outermost ones. */
export function distribute<T extends Box & { id: string }>(items: T[], axis: 'x' | 'y'): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length < 3) return out;
  const sorted = [...items].sort((p, q) => p[axis] - q[axis]);
  const first = boundsOf(sorted[0]);
  const last = boundsOf(sorted[sorted.length - 1]);
  const size = (t: T) => {
    const b = boundsOf(t);
    return axis === 'x' ? b.right - b.left : b.bottom - b.top;
  };
  const span = axis === 'x' ? last.right - first.left : last.bottom - first.top;
  const gap = (span - sorted.reduce((n, t) => n + size(t), 0)) / (sorted.length - 1);
  let cursor = axis === 'x' ? first.left : first.top;
  for (const t of sorted) {
    const s = size(t);
    const centre = Math.round(cursor + s / 2);
    out.set(t.id, axis === 'x' ? { x: centre, y: t.y } : { x: t.x, y: centre });
    cursor += s + gap;
  }
  return out;
}
