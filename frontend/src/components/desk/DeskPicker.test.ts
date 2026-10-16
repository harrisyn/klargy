import { describe, it, expect } from 'vitest';
import { roomsOfTypes } from './DeskPicker';
import type { DeskInstance } from './useDesk';

const room = (id: string, servicePointType?: string): DeskInstance => ({
  id,
  servicePointId: `sp-${id}`,
  servicePointType,
  instanceNumber: 1,
  displayName: null,
  servicePointName: id,
  isOccupied: false,
  currentService: { id: 's1', name: 'Clinic' },
});

describe('roomsOfTypes', () => {
  const rooms = [room('consult', 'CONSULTATION'), room('front', 'RECEPTION'), room('lab', 'LAB'), room('old')];

  it('offers every room when no kinds are asked for', () => {
    expect(roomsOfTypes(rooms)).toEqual({ items: rooms, fallback: false });
  });

  it('offers only the kinds asked for (a room without a kind counts as other)', () => {
    expect(roomsOfTypes(rooms, ['consultation']).items.map((r) => r.id)).toEqual(['consult']);
    expect(roomsOfTypes(rooms, ['reception', 'lab']).items.map((r) => r.id)).toEqual(['front', 'lab']);
    expect(roomsOfTypes(rooms, ['other']).items.map((r) => r.id)).toEqual(['old']);
  });

  it('falls back to every room when none is of those kinds', () => {
    expect(roomsOfTypes(rooms, ['pharmacy'])).toEqual({ items: rooms, fallback: true });
    expect(roomsOfTypes([], ['pharmacy'])).toEqual({ items: [], fallback: false });
  });
});
