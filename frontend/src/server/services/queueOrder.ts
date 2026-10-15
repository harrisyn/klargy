/**
 * The order of a waiting line, shared by everything that shows or uses it:
 * call next, a ticket's position, "turn approaching" messages, the desk
 * list, the lobby screen and the status page.
 *
 * Booked patients who arrive on time (within the organisation's window
 * around their appointment) are placed by their booked time instead of
 * their arrival: walk-ins who arrived before that time stay ahead, walk-ins
 * who arrived after it go behind. A share cap keeps walk-ins moving when
 * many booked patients arrive together. Pure functions, no database.
 */

export interface BookedArrivalSettings {
  /** Place booked patients by their booked time. Off: they join as walk-ins. */
  enabled: boolean;
  /** How early (minutes before the booked time) still counts as on time. */
  earlyMinutes: number;
  /** How late (minutes after the booked time) still counts as on time. */
  lateMinutes: number;
  /**
   * At most this share (percent) of the people placed ahead of a waiting
   * walk-in may be booked patients who arrived after them. 50 = one booked
   * patient, then a walk-in; 75 = three, then a walk-in; 100 = no cap;
   * 0 = booked patients never go ahead of a walk-in who arrived first.
   */
  maxBookedShare: number;
}

export const DEFAULT_BOOKED_ARRIVAL: BookedArrivalSettings = {
  enabled: true,
  earlyMinutes: 10,
  lateMinutes: 15,
  maxBookedShare: 50,
};

const intIn = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Organization.bookedArrivalSettings with defaults and limits applied. */
export function readBookedArrivalSettings(raw: unknown): BookedArrivalSettings {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_BOOKED_ARRIVAL;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    earlyMinutes: intIn(s.earlyMinutes, 0, 240, d.earlyMinutes),
    lateMinutes: intIn(s.lateMinutes, 0, 240, d.lateMinutes),
    maxBookedShare: intIn(s.maxBookedShare, 0, 100, d.maxBookedShare),
  };
}

/**
 * Where a booked patient arriving at `arrivedAt` goes in line: their booked
 * time when they are within the window, else null (they join as a walk-in,
 * by arrival). Always null while the setting is off.
 */
export function bookedPlaceAt(bookedFor: Date, arrivedAt: Date, settings: BookedArrivalSettings): Date | null {
  if (!settings.enabled) return null;
  const minute = 60 * 1000;
  const from = bookedFor.getTime() - settings.earlyMinutes * minute;
  const to = bookedFor.getTime() + settings.lateMinutes * minute;
  const at = arrivedAt.getTime();
  return at >= from && at <= to ? new Date(bookedFor) : null;
}

/** How many booked patients may go ahead of one waiting walk-in who arrived
 * before them (Infinity for no cap). */
export function bookedPerWalkIn(maxBookedShare: number): number {
  if (maxBookedShare >= 100) return Infinity;
  if (maxBookedShare <= 0) return 0;
  return Math.round(maxBookedShare / (100 - maxBookedShare));
}

export interface Orderable {
  id: string;
  priority: number;
  sortOrder: number;
  joinedAt: Date;
  /** Placed by this booked time (an on-time booked arrival), else null. */
  bookedPlaceAt?: Date | null;
}

const time = (d: Date | string) => new Date(d).getTime();

/** Walk-in order: priority, then any manual reorder, then arrival. */
function walkInOrder(a: Orderable, b: Orderable) {
  return b.priority - a.priority || a.sortOrder - b.sortOrder || time(a.joinedAt) - time(b.joinedAt) || a.id.localeCompare(b.id);
}

/** Booked order: booked time, then arrival. */
function bookedOrder(a: Orderable, b: Orderable) {
  return time(a.bookedPlaceAt!) - time(b.bookedPlaceAt!) || time(a.joinedAt) - time(b.joinedAt) || a.id.localeCompare(b.id);
}

/**
 * The callable waiting entries of one queue in the order they are called.
 *
 * Higher priority always goes first. Within a priority, walk-ins (and booked
 * patients who arrived outside their window) keep their order (manual
 * reorder, then arrival); each on-time booked patient goes ahead of the
 * first walk-in who arrived after their booked time. A booked patient who
 * arrived after a walk-in but is placed ahead of them "goes ahead" of that
 * walk-in; at most `bookedPerWalkIn(maxBookedShare)` may go ahead of the
 * same walk-in, after which the walk-in is next.
 */
export function orderWaiting<T extends Orderable>(entries: T[], maxBookedShare: number = DEFAULT_BOOKED_ARRIVAL.maxBookedShare): T[] {
  const cap = bookedPerWalkIn(maxBookedShare);
  const priorities = [...new Set(entries.map((e) => e.priority))].sort((a, b) => b - a);
  const out: T[] = [];
  for (const priority of priorities) {
    const group = entries.filter((e) => e.priority === priority);
    const walkIns = group.filter((e) => !e.bookedPlaceAt).sort(walkInOrder);
    const booked = group.filter((e) => !!e.bookedPlaceAt).sort(bookedOrder);
    let w = 0;
    let b = 0;
    let aheadOfWalkIn = 0;
    while (w < walkIns.length || b < booked.length) {
      if (b >= booked.length) {
        out.push(walkIns[w++]);
        continue;
      }
      if (w >= walkIns.length) {
        out.push(booked[b++]);
        continue;
      }
      const walkIn = walkIns[w];
      const next = booked[b];
      if (time(next.bookedPlaceAt!) <= time(walkIn.joinedAt)) {
        const goesAhead = time(next.joinedAt) > time(walkIn.joinedAt);
        if (!goesAhead || aheadOfWalkIn < cap) {
          out.push(next);
          b++;
          if (goesAhead) aheadOfWalkIn++;
          continue;
        }
      }
      out.push(walkIn);
      w++;
      aheadOfWalkIn = 0;
    }
  }
  return out;
}

/** 1-based place in line by entry id. */
export function lineRanks(ordered: { id: string }[]): Map<string, number> {
  return new Map(ordered.map((e, i) => [e.id, i + 1]));
}

/**
 * Re-sorts a listing so the entries that have a place in line (`ranks`)
 * appear in line order, in the slots those entries already occupy; every
 * other entry (serving, on hold, awaiting payment) stays where it was.
 */
export function applyLineOrder<T extends { id: string }>(entries: T[], ranks: Map<string, number>): T[] {
  const slots: number[] = [];
  const ranked: T[] = [];
  entries.forEach((e, i) => {
    if (ranks.has(e.id)) {
      slots.push(i);
      ranked.push(e);
    }
  });
  ranked.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  const out = [...entries];
  slots.forEach((slot, i) => {
    out[slot] = ranked[i];
  });
  return out;
}
