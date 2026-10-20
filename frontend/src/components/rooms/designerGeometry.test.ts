import { describe, it, expect } from 'vitest';
import { align, boundsOf, distribute, inRectangle, resizeBox, rotationToward, type Box } from './designerGeometry';

const box = (over: Partial<Box> = {}): Box => ({ x: 200, y: 200, width: 100, height: 60, rotation: 0, ...over });

describe('resizeBox', () => {
  it('drags the east edge and keeps the west edge where it was', () => {
    const r = resizeBox(box(), 'e', { x: 290, y: 200 });
    expect(r).toMatchObject({ width: 140, height: 60 });
    expect(r.x - r.width / 2).toBeCloseTo(150); // west edge unchanged
  });

  it('drags a corner in both directions', () => {
    const r = resizeBox(box(), 'se', { x: 270, y: 260 });
    expect(r).toMatchObject({ width: 120, height: 90 });
    expect(r.x - r.width / 2).toBeCloseTo(150);
    expect(r.y - r.height / 2).toBeCloseTo(170);
  });

  it('works on a table that is turned: the far side stays fixed in the plan', () => {
    const turned = box({ rotation: 90 }); // its width now runs up and down the plan
    const before = { x: turned.x, y: turned.y - turned.width / 2 }; // top end of the width axis
    // east handle of a 90° table points down the plan
    const r = resizeBox(turned, 'e', { x: 200, y: 280 }, { snap: false });
    expect(r.width).toBeCloseTo(130);
    const top = { x: r.x, y: r.y - r.width / 2 };
    expect(top.x).toBeCloseTo(before.x);
    expect(top.y).toBeCloseTo(before.y);
  });

  it('snaps sizes to the grid and keeps within limits', () => {
    expect(resizeBox(box(), 'e', { x: 283, y: 200 }, { snap: true }).width).toBe(130);
    expect(resizeBox(box(), 'e', { x: 100, y: 200 }).width).toBe(20);
    expect(resizeBox(box(), 'e', { x: 5000, y: 200 }).width).toBe(600);
  });

  it('holds the shape when asked, dragging a corner', () => {
    const r = resizeBox(box(), 'se', { x: 300, y: 230 }, { keepRatio: true });
    expect(r.width / r.height).toBeCloseTo(100 / 60, 1);
  });

  it('a side handle changes only its own dimension', () => {
    const r = resizeBox(box(), 's', { x: 400, y: 260 });
    expect(r.width).toBe(100);
    expect(r.height).toBe(90);
  });
});

describe('rotationToward', () => {
  it('points the top handle at the pointer', () => {
    const c = { x: 100, y: 100 };
    expect(rotationToward(c, { x: 100, y: 0 }, false)).toBe(0);
    expect(rotationToward(c, { x: 200, y: 100 }, false)).toBe(90);
    expect(rotationToward(c, { x: 0, y: 100 }, false)).toBe(-90);
    expect(rotationToward(c, { x: 100, y: 200 }, false)).toBe(180);
  });

  it('snaps to 15 degrees', () => {
    expect(rotationToward({ x: 0, y: 0 }, { x: 100, y: -90 }, true) % 15).toBe(0);
  });
});

describe('selecting and lining up', () => {
  const items = [
    { id: 'a', ...box({ x: 100, y: 100, width: 60, height: 60 }) },
    { id: 'b', ...box({ x: 300, y: 130, width: 60, height: 60 }) },
    { id: 'c', ...box({ x: 600, y: 400, width: 60, height: 60 }) },
  ];

  it('boundsOf grows for a turned table', () => {
    const b = boundsOf(box({ width: 100, height: 20, rotation: 90 }));
    expect(b.right - b.left).toBeCloseTo(20);
    expect(b.bottom - b.top).toBeCloseTo(100);
  });

  it('a drag box picks up the tables it touches', () => {
    expect(inRectangle(items, { x: 0, y: 0 }, { x: 350, y: 200 }).sort()).toEqual(['a', 'b']);
    expect(inRectangle(items, { x: 350, y: 200 }, { x: 0, y: 0 }).sort()).toEqual(['a', 'b']);
    expect(inRectangle(items, { x: 500, y: 300 }, { x: 700, y: 500 })).toEqual(['c']);
  });

  it('aligns on an edge', () => {
    const m = align(items, 'left');
    expect([...m.values()].map((p) => p.x)).toEqual([100, 100, 100]);
    const t = align(items, 'top');
    expect(t.get('b')!.y).toBe(100);
    const bottom = align(items, 'bottom');
    expect(bottom.get('a')!.y).toBe(400);
  });

  it('centres on the group', () => {
    const m = align(items, 'center');
    expect(m.get('a')!.x).toBe(m.get('c')!.x);
  });

  it('does nothing for one table', () => {
    expect(align([items[0]], 'left').size).toBe(0);
  });

  it('spreads three evenly with equal gaps', () => {
    const spread = distribute(items, 'x');
    expect(spread.get('a')!.x).toBe(100);
    expect(spread.get('c')!.x).toBe(600);
    expect(spread.get('b')!.x).toBe(350);
  });

  it('needs three to distribute', () => {
    expect(distribute(items.slice(0, 2), 'x').size).toBe(0);
  });
});
