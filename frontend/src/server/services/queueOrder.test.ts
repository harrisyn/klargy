import { describe, it, expect } from 'vitest';
import {
  applyLineOrder,
  bookedPerWalkIn,
  bookedPlaceAt,
  DEFAULT_BOOKED_ARRIVAL,
  lineRanks,
  orderWaiting,
  readBookedArrivalSettings,
  type Orderable,
} from './queueOrder';

// Times on one morning: at(10, 30) is 10:30.
const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 15, h, m));
const walkIn = (id: string, joined: Date, extra: Partial<Orderable> = {}): Orderable => ({ id, priority: 0, sortOrder: 0, joinedAt: joined, bookedPlaceAt: null, ...extra });
const booked = (id: string, slot: Date, arrived: Date, extra: Partial<Orderable> = {}): Orderable => ({ id, priority: 0, sortOrder: 0, joinedAt: arrived, bookedPlaceAt: slot, ...extra });
const ids = (list: Orderable[]) => list.map((e) => e.id);

describe('bookedPlaceAt', () => {
  const settings = DEFAULT_BOOKED_ARRIVAL; // 10 minutes before to 15 after
  it('places an on-time arrival at the booked time, early or late within the window', () => {
    expect(bookedPlaceAt(at(10, 30), at(10, 20), settings)).toEqual(at(10, 30));
    expect(bookedPlaceAt(at(10, 30), at(10, 30), settings)).toEqual(at(10, 30));
    expect(bookedPlaceAt(at(10, 30), at(10, 45), settings)).toEqual(at(10, 30));
  });

  it('treats arrivals outside the window as walk-ins', () => {
    expect(bookedPlaceAt(at(10, 30), at(10, 46), settings)).toBeNull();
    expect(bookedPlaceAt(at(10, 30), at(10, 19), settings)).toBeNull();
  });

  it('places nobody while the setting is off', () => {
    expect(bookedPlaceAt(at(10, 30), at(10, 30), { ...settings, enabled: false })).toBeNull();
  });
});

describe('readBookedArrivalSettings', () => {
  it('fills in defaults and keeps values within limits', () => {
    expect(readBookedArrivalSettings(null)).toEqual(DEFAULT_BOOKED_ARRIVAL);
    expect(readBookedArrivalSettings({ enabled: false, earlyMinutes: -5, lateMinutes: 999, maxBookedShare: 140 })).toEqual({
      enabled: false,
      earlyMinutes: 0,
      lateMinutes: 240,
      maxBookedShare: 100,
    });
    expect(readBookedArrivalSettings({ earlyMinutes: 'x', maxBookedShare: 66.6 })).toMatchObject({ earlyMinutes: 10, maxBookedShare: 67 });
  });
});

describe('bookedPerWalkIn', () => {
  it('turns the share into booked patients per walk-in', () => {
    expect(bookedPerWalkIn(0)).toBe(0);
    expect(bookedPerWalkIn(50)).toBe(1);
    expect(bookedPerWalkIn(67)).toBe(2);
    expect(bookedPerWalkIn(75)).toBe(3);
    expect(bookedPerWalkIn(100)).toBe(Infinity);
  });
});

describe('orderWaiting', () => {
  it('keeps walk-ins in arrival order', () => {
    const line = [walkIn('w2', at(10, 5)), walkIn('w1', at(10, 0)), walkIn('w3', at(10, 10))];
    expect(ids(orderWaiting(line))).toEqual(['w1', 'w2', 'w3']);
  });

  it('puts an early booked arrival at their booked time: behind walk-ins who came before it, ahead of those after', () => {
    const line = [
      walkIn('w1', at(10, 18)),
      booked('b', at(10, 30), at(10, 20)),
      walkIn('w2', at(10, 25)),
      walkIn('w3', at(10, 32)),
    ];
    expect(ids(orderWaiting(line))).toEqual(['w1', 'w2', 'b', 'w3']);
  });

  it('puts a slightly late booked arrival ahead of walk-ins who came after their booked time', () => {
    const line = [walkIn('w1', at(10, 20)), walkIn('w2', at(10, 33)), walkIn('w3', at(10, 38)), booked('b', at(10, 30), at(10, 40))];
    expect(ids(orderWaiting(line, 100))).toEqual(['w1', 'b', 'w2', 'w3']);
  });

  it('treats a late arrival beyond the window (no booked place) as a walk-in', () => {
    const line = [walkIn('w1', at(10, 33)), { ...booked('late', at(10, 0), at(10, 40)), bookedPlaceAt: null }];
    expect(ids(orderWaiting(line))).toEqual(['w1', 'late']);
  });

  it('orders booked patients by booked time among themselves', () => {
    const line = [booked('b2', at(10, 45), at(10, 36)), booked('b1', at(10, 30), at(10, 41))];
    expect(ids(orderWaiting(line))).toEqual(['b1', 'b2']);
  });

  it('caps how many booked patients go ahead of a walk-in who was already waiting (half: one, then the walk-in)', () => {
    // w1 has waited since 10:20; three booked patients for 10:00, 10:05 and
    // 10:10 all arrive later, within their window.
    const line = [
      walkIn('w1', at(10, 20)),
      walkIn('w2', at(10, 21)),
      booked('b1', at(10, 0), at(10, 22)),
      booked('b2', at(10, 5), at(10, 23)),
      booked('b3', at(10, 10), at(10, 24)),
    ];
    expect(ids(orderWaiting(line, 50))).toEqual(['b1', 'w1', 'b2', 'w2', 'b3']);
    expect(ids(orderWaiting(line, 67))).toEqual(['b1', 'b2', 'w1', 'b3', 'w2']);
    expect(ids(orderWaiting(line, 100))).toEqual(['b1', 'b2', 'b3', 'w1', 'w2']);
    expect(ids(orderWaiting(line, 0))).toEqual(['w1', 'w2', 'b1', 'b2', 'b3']);
  });

  it('does not count a booked patient who arrived before the walk-in against the cap', () => {
    const line = [
      booked('b1', at(10, 0), at(9, 55)),
      booked('b2', at(10, 2), at(9, 56)),
      walkIn('w1', at(10, 5)),
    ];
    expect(ids(orderWaiting(line, 0))).toEqual(['b1', 'b2', 'w1']);
  });

  it('never moves anyone ahead of a higher priority', () => {
    const line = [walkIn('urgent', at(10, 40), { priority: 50 }), booked('b', at(10, 0), at(10, 5)), walkIn('w1', at(10, 10))];
    expect(ids(orderWaiting(line))).toEqual(['urgent', 'b', 'w1']);
  });

  it('keeps a hand-made order among walk-ins', () => {
    const line = [walkIn('w1', at(10, 0), { sortOrder: 2 }), walkIn('w2', at(10, 5), { sortOrder: 1 })];
    expect(ids(orderWaiting(line))).toEqual(['w2', 'w1']);
  });
});

describe('applyLineOrder and lineRanks', () => {
  it('re-sorts only the entries with a place in line, in the slots they occupy', () => {
    const listing = [{ id: 'serving' }, { id: 'w1' }, { id: 'held' }, { id: 'b' }, { id: 'w2' }];
    const ranks = lineRanks([{ id: 'b' }, { id: 'w1' }, { id: 'w2' }]);
    expect(ranks.get('b')).toBe(1);
    expect(applyLineOrder(listing, ranks).map((e) => e.id)).toEqual(['serving', 'b', 'held', 'w1', 'w2']);
  });
});
