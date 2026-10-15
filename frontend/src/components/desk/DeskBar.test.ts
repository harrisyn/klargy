import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeskBarView, type DeskBarRooms } from './DeskBar';
import type { Desk, DeskEntry, DeskInstance } from './useDesk';

// The bar layout of the desk widget (/widget/desk?layout=bar): one row with
// the room, who's being served, the waiting count and the actions.

const room = (id: string, name: string, extra: Partial<DeskInstance> = {}): DeskInstance => ({
  id,
  servicePointId: `sp-${id}`,
  instanceNumber: 1,
  displayName: null,
  servicePointName: name,
  isOccupied: false,
  currentService: { id: 'svc-opd', name: 'OPD' },
  ...extra,
});

const entry = (ticketNumber: string, extra: Partial<DeskEntry> = {}): DeskEntry => ({
  id: `e-${ticketNumber}`,
  ticketNumber,
  status: 'WAITING',
  joinedAt: new Date().toISOString(),
  ...extra,
});

function fakeDesk(overrides: Partial<Desk> = {}): Desk {
  const noop = vi.fn();
  const waiting = (overrides.waiting ?? []) as Desk['waiting'];
  return {
    callable: waiting.filter((e) => !e.heldAt && !e.awaitingClearance),
    hold: noop,
    clear: noop,
    ready: true,
    desk: { instanceId: 'r1', serviceId: 'svc-opd', locationId: 'loc1', label: 'Room 1', serviceName: 'OPD', userId: 'u1' },
    data: { queue: { id: 'q1', status: 'ACTIVE' }, serving: [], waiting: [], nextServices: [] },
    current: null,
    waiting: [],
    otherDesks: [],
    busy: null,
    error: '',
    notice: '',
    afterComplete: null,
    terms: { person: 'patient', people: 'patients', Person: 'Patient', People: 'Patients' },
    setError: noop,
    dismissAfterComplete: noop,
    signIn: noop,
    leave: noop,
    callNext: noop,
    recall: noop,
    complete: noop,
    sendTo: noop,
    transfer: noop,
    noShow: noop,
    reorder: noop,
    refresh: noop,
    finishOther: noop,
    ...overrides,
  } as unknown as Desk;
}

const rooms = (overrides: Partial<DeskBarRooms> = {}): DeskBarRooms => {
  const instances = [room('r1', 'Room 1'), room('r2', 'Room 2', { isOccupied: true, occupiedBy: { id: 'u2', firstName: 'Kofi', lastName: 'Mensah' } })];
  return {
    userId: 'u1',
    locations: [{ id: 'loc1', name: 'Main' }],
    locationId: 'loc1',
    setLocationId: vi.fn(),
    instances,
    groups: [{ name: 'OPD', items: instances }],
    pending: null,
    problem: '',
    choose: vi.fn(),
    ...overrides,
  };
};

const render = (desk: Desk, extra: Partial<Parameters<typeof DeskBarView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(DeskBarView, { desk, rooms: rooms(), loadServices: async () => [], onSignOut: vi.fn(), ...extra })
  );

describe('DeskBarView', () => {
  it('shows the room, the person being served, the waiting count and every action in one row', () => {
    const current = entry('G012', { status: 'SERVING', user: { id: 'p1', firstName: 'Ama', lastName: 'Owusu' } });
    const html = render(fakeDesk({ current, waiting: [entry('G013'), entry('G014')] }));
    expect(html).toContain('class="desk-bar"');
    expect(html).toMatch(/<select class="desk-bar-room" aria-label="Room"/);
    expect(html).toMatch(/<option value="r1" selected="">Room 1<\/option>/);
    expect(html).toContain('Room 2 · Kofi is here');
    expect(html).toContain('<span class="desk-bar-ticket">G012</span>');
    expect(html).toContain('Ama Owusu');
    expect(html).toContain('2 waiting');
    for (const label of ['Call next', 'Recall', 'Complete', 'No-show', 'Transfer']) expect(html).toContain(label);
    expect(html).toContain('aria-label="More"');
    // Nothing open below the row.
    expect(html).not.toContain('desk-bar-panel');
  });

  it('says when nobody is being served and turns off the actions that need someone', () => {
    const html = render(fakeDesk({ waiting: [entry('G013')] }));
    expect(html).toContain('No one being served');
    expect(html).toMatch(/<button type="button" class="desk-btn desk-btn-primary desk-bar-call"(?![^>]*disabled)[^>]*>/);
    expect(html).toMatch(/title="Show and announce the ticket again" disabled=""|disabled=""[^>]*title="Show and announce the ticket again"/);
  });

  it('turns off Call next when nobody is waiting', () => {
    const html = render(fakeDesk());
    expect(html).toContain('0 waiting');
    expect(html).toMatch(/desk-bar-call" disabled=""/);
  });

  it('asks for a room before anything else when not signed in to one', () => {
    const html = render(fakeDesk({ desk: null, data: null }));
    expect(html).toContain('Pick your room…');
    expect(html).toContain('Pick the room you’re working in to start calling.');
    expect(html).not.toContain('Call next');
  });

  it('opens menus below the row: More holds the narrow-screen actions, leaving and signing out', () => {
    const html = render(fakeDesk({ current: entry('G012', { status: 'SERVING' }) }), { initialPanel: 'more' });
    expect(html).toContain('class="desk-bar-panel desk-bar-menu"');
    expect(html).toContain('class="desk-bar-narrow"');
    expect(html).toContain('Leave room');
    expect(html).toContain('Sign out');
  });

  it('shows the transfer list while it loads', () => {
    const html = render(fakeDesk({ current: entry('G012', { status: 'SERVING' }) }), { initialPanel: 'transfer' });
    expect(html).toContain('aria-label="Transfer to"');
    expect(html).toContain('Loading services…');
  });

  it('offers the next services after completing, and shows notices under the row', () => {
    const html = render(fakeDesk({
      afterComplete: { entry: entry('G012'), nextServices: [{ serviceId: 's2', serviceName: 'Lab', displayName: 'Laboratory', isRequired: true }] },
      notice: 'G011 marked as not here.',
    }));
    expect(html).toContain('Send G012 on to another service?');
    expect(html).toContain('Laboratory');
    expect(html).toContain('No, they’re finished');
    expect(html).toContain('G011 marked as not here.');
  });

  it('puts the person being served on hold from the row', () => {
    const html = render(fakeDesk({ current: entry('G012', { status: 'SERVING' }) }));
    expect(html).toContain('Hold');
    expect(html).toContain('aria-label="Call a specific patient"');
  });

  it('lists who can be called by hand: on hold first, awaiting payment marked and not callable', () => {
    const waiting = [
      entry('G010', { heldAt: new Date().toISOString(), deskInstanceId: 'r1' }),
      entry('G013'),
      entry('C001', { awaitingClearance: true }),
    ];
    const html = render(fakeDesk({ waiting }), { initialPanel: 'pick' });
    expect(html).toContain('aria-label="Call a specific patient"');
    expect(html).toContain('On hold here');
    expect(html).toContain('Call back');
    expect(html).toContain('Awaiting payment');
    expect(html).toContain('Mark paid');
    expect(html.indexOf('G010')).toBeLessThan(html.indexOf('C001'));
  });

  it('turns off Call next when everyone waiting is on hold or awaiting payment', () => {
    const html = render(fakeDesk({ waiting: [entry('C001', { awaitingClearance: true })] }));
    expect(html).toContain('1 waiting');
    expect(html).toMatch(/desk-bar-call" disabled=""/);
  });
});
