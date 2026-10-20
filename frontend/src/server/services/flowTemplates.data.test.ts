import { describe, it, expect } from 'vitest';
import { FLOW_TEMPLATES } from './flowTemplates.data';
import { INDUSTRIES, industryFeatures } from '../../lib/terms';
import { flowStages } from '../../components/flow/FlowTemplatePicker';

describe('flow templates', () => {
  const templates = Object.values(FLOW_TEMPLATES);

  it.each(templates.map((t) => [t.id, t] as const))('%s only references its own services and starts at a real one', (_id, t) => {
    const names = new Set(t.services.map((s) => s.name));
    expect(names.size).toBe(t.services.length);
    expect(names.has(t.defaultService)).toBe(true);
    for (const [from, tos] of Object.entries(t.flows)) {
      expect(names.has(from)).toBe(true);
      for (const to of tos) expect(names.has(to)).toBe(true);
    }
    // Every service is reachable from the first point of contact.
    expect(flowStages(t).flat().sort()).toEqual([...names].sort());
  });

  it('covers every industry with at least one template', () => {
    for (const i of INDUSTRIES) {
      expect(templates.some((t) => t.industries.includes(i.id))).toBe(true);
    }
  });

  it('keeps wording neutral outside healthcare', () => {
    for (const t of templates.filter((t) => !t.industries.includes('HEALTHCARE') || t.industries.length > 1)) {
      if (t.id === 'outpatient') continue;
      expect(JSON.stringify(t)).not.toMatch(/patient|doctor|clinic/i);
    }
  });

  describe('rooms and tables', () => {
    const withRooms = templates.filter((t) => t.rooms?.length);

    it('has some', () => {
      expect(withRooms.map((t) => t.id)).toEqual(expect.arrayContaining(['restaurant', 'salon', 'event-venue']));
    });

    it.each(withRooms.map((t) => [t.id, t] as const))('%s: a tidy floor plan', (_id, t) => {
      const roomNames = t.rooms!.map((r) => r.name.toLowerCase());
      expect(new Set(roomNames).size).toBe(roomNames.length);
      // Table names are unique across the location, so across all the template's rooms.
      const tableNames = t.rooms!.flatMap((r) => r.tables.map((x) => x.name.toLowerCase()));
      expect(new Set(tableNames).size).toBe(tableNames.length);
      for (const r of t.rooms!) {
        const w = r.layoutWidth ?? 1000;
        const h = r.layoutHeight ?? 700;
        expect(r.tables.length).toBeGreaterThan(0);
        for (const x of r.tables) {
          expect(x.seats).toBeGreaterThanOrEqual(1);
          expect(x.x - (x.width ?? 90) / 2).toBeGreaterThanOrEqual(0);
          expect(x.x + (x.width ?? 90) / 2).toBeLessThanOrEqual(w);
          expect(x.y - (x.height ?? 90) / 2).toBeGreaterThanOrEqual(0);
          expect(x.y + (x.height ?? 90) / 2).toBeLessThanOrEqual(h);
        }
        // No two tables sit on top of each other.
        for (const [i, a] of r.tables.entries()) {
          for (const b of r.tables.slice(i + 1)) {
            const overlap = Math.abs(a.x - b.x) < ((a.width ?? 90) + (b.width ?? 90)) / 2 && Math.abs(a.y - b.y) < ((a.height ?? 90) + (b.height ?? 90)) / 2;
            expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
          }
        }
      }
    });

    it('only for kinds of business that use tables, never a clinic or bank', () => {
      for (const t of withRooms) expect(t.industries.some((i) => industryFeatures(i).tables)).toBe(true);
      for (const t of templates.filter((x) => x.industries.every((i) => !industryFeatures(i).tables))) {
        expect(t.rooms ?? []).toEqual([]);
        expect(t.services.some((s) => s.tableMode)).toBe(false);
      }
    });

    it('a service that is given tables has tables to give, and seats enough for its biggest party', () => {
      for (const t of templates) {
        for (const s of t.services.filter((x) => x.tableMode)) {
          expect(t.rooms?.length).toBeGreaterThan(0);
          const biggest = Math.max(...t.rooms!.flatMap((r) => (r.allowCombine === false ? r.tables.map((x) => x.seats) : [r.tables.reduce((n, x) => n + x.seats, 0)])));
          expect(biggest).toBeGreaterThanOrEqual(s.partySize?.max ?? 1);
        }
      }
    });
  });
});
