import { describe, expect, it, vi } from 'vitest';
import { CONTRACT, DESK_MESSAGES, deskOrigin, deskUrl, embedDesk, parseDeskMessage } from '../src/desk';

const URL_ = 'https://acme.klargy.com/widget/desk?launch=abc';
const ORIGIN = 'https://acme.klargy.com';
const entry = { entryId: 'e1', ticketNumber: 'G012', status: 'SERVING', refs: { visit: 'V1' } };

/** A window and an iframe without a DOM. */
function fakes() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const win = {
    addEventListener: vi.fn((_type: 'message', l: (event: MessageEvent) => void) => void listeners.add(l)),
    removeEventListener: vi.fn((_type: 'message', l: (event: MessageEvent) => void) => void listeners.delete(l)),
  };
  const frameWindow = { postMessage: vi.fn() };
  const iframe = { src: '', contentWindow: frameWindow };
  const dispatch = (data: unknown, origin = ORIGIN, source: unknown = frameWindow) =>
    listeners.forEach((l) => l({ data, origin, source } as MessageEvent));
  return { win, iframe, frameWindow, dispatch, listeners };
}

describe('parseDeskMessage', () => {
  it('parses every desk message', () => {
    expect(parseDeskMessage({ type: 'klargy:ready', contract: CONTRACT })).toEqual({ type: 'klargy:ready', contract: 'klargy-connect/v1' });
    expect(parseDeskMessage({ type: 'klargy:desk-changed', servicePoint: { id: 'sp1', name: 'Room 3', externalId: 'R3' } })).toEqual({
      type: 'klargy:desk-changed',
      servicePoint: { id: 'sp1', name: 'Room 3', externalId: 'R3' },
    });
    expect(parseDeskMessage({ type: 'klargy:desk-changed', servicePoint: null })).toEqual({ type: 'klargy:desk-changed', servicePoint: null });
    expect(parseDeskMessage({ type: 'klargy:desk-changed', servicePoint: { id: 'sp1', name: 'Room 3' } })).toMatchObject({
      servicePoint: { externalId: null },
    });
    expect(parseDeskMessage({ type: 'klargy:waiting', count: 4 })).toEqual({ type: 'klargy:waiting', count: 4 });
    expect(parseDeskMessage({ type: 'klargy:entry-called', entry })).toEqual({ type: 'klargy:entry-called', entry });
    expect(parseDeskMessage({ type: 'klargy:entry-updated', entry })).toEqual({ type: 'klargy:entry-updated', entry });
    expect(parseDeskMessage({ type: 'klargy:resize', height: 64 })).toEqual({ type: 'klargy:resize', height: 64 });
  });

  it('rejects anything else', () => {
    for (const data of [
      null,
      'klargy:ready',
      [],
      { type: 'klargy:ready' },
      { type: 'klargy:waiting', count: -1 },
      { type: 'klargy:waiting', count: '3' },
      { type: 'klargy:entry-called', entry: {} },
      { type: 'klargy:desk-changed', servicePoint: { id: 1 } },
      { type: 'klargy:logout' },
      { type: 'klargy:resize' },
      { type: 'klargy:resize', height: 0 },
      { type: 'klargy:resize', height: -10 },
      { type: 'klargy:resize', height: '64' },
      { type: 'klargy:resize', height: Number.POSITIVE_INFINITY },
      { type: 'other' },
    ]) {
      expect(parseDeskMessage(data)).toBeNull();
    }
  });

  it('names the protocol messages', () => {
    expect(Object.values(DESK_MESSAGES)).toEqual([
      'klargy:ready',
      'klargy:desk-changed',
      'klargy:waiting',
      'klargy:entry-called',
      'klargy:entry-updated',
      'klargy:resize',
      'klargy:logout',
    ]);
  });
});

describe('deskOrigin', () => {
  it('is the launch URL’s origin', () => {
    expect(deskOrigin(URL_)).toBe(ORIGIN);
    expect(deskOrigin('http://localhost:8003/widget/desk?launch=x')).toBe('http://localhost:8003');
    expect(() => deskOrigin('javascript:alert(1)')).toThrow();
  });
});

describe('deskUrl', () => {
  it('adds layout=bar and keeps the launch code', () => {
    expect(deskUrl(URL_, 'bar')).toBe('https://acme.klargy.com/widget/desk?launch=abc&layout=bar');
    expect(deskUrl('https://acme.klargy.com/widget/desk?launch=abc&layout=x', 'bar')).toBe('https://acme.klargy.com/widget/desk?launch=abc&layout=bar');
  });

  it('leaves the URL alone for the default layout', () => {
    expect(deskUrl(URL_)).toBe(URL_);
    expect(deskUrl(URL_, 'default')).toBe(URL_);
  });
});

describe('embedDesk', () => {
  it('loads the URL and dispatches messages from the desk to the callbacks', () => {
    const { win, iframe, dispatch } = fakes();
    const on = {
      onReady: vi.fn(),
      onDeskChanged: vi.fn(),
      onWaiting: vi.fn(),
      onEntryCalled: vi.fn(),
      onEntryUpdated: vi.fn(),
      onMessage: vi.fn(),
    };
    const desk = embedDesk({ url: URL_, iframe, window: win, ...on });
    expect(iframe.src).toBe(URL_);
    expect(desk.origin).toBe(ORIGIN);

    dispatch({ type: 'klargy:ready', contract: CONTRACT });
    dispatch({ type: 'klargy:desk-changed', servicePoint: null });
    dispatch({ type: 'klargy:waiting', count: 2 });
    dispatch({ type: 'klargy:entry-called', entry });
    dispatch({ type: 'klargy:entry-updated', entry });

    expect(on.onReady).toHaveBeenCalledWith({ contract: CONTRACT });
    expect(on.onDeskChanged).toHaveBeenCalledWith(null);
    expect(on.onWaiting).toHaveBeenCalledWith(2);
    expect(on.onEntryCalled).toHaveBeenCalledWith(entry);
    expect(on.onEntryUpdated).toHaveBeenCalledWith(entry);
    expect(on.onMessage).toHaveBeenCalledTimes(5);
  });

  it('loads the bar layout and passes on the height it asks for', () => {
    const { win, iframe, dispatch } = fakes();
    const onResize = vi.fn();
    const onMessage = vi.fn();
    embedDesk({ url: URL_, iframe, window: win, layout: 'bar', onResize, onMessage });
    expect(iframe.src).toBe(`${URL_}&layout=bar`);
    dispatch({ type: 'klargy:resize', height: 60 });
    dispatch({ type: 'klargy:resize', height: 248 });
    dispatch({ type: 'klargy:resize', height: 60 }, 'https://evil.example.com');
    dispatch({ type: 'klargy:resize', height: -1 });
    expect(onResize.mock.calls).toEqual([[60], [248]]);
    expect(onMessage).toHaveBeenCalledWith({ type: 'klargy:resize', height: 248 });
  });

  it('ignores messages from another origin, another window, or malformed ones', () => {
    const { win, iframe, dispatch } = fakes();
    const onWaiting = vi.fn();
    embedDesk({ url: URL_, iframe, window: win, onWaiting });
    dispatch({ type: 'klargy:waiting', count: 1 }, 'https://evil.example.com');
    dispatch({ type: 'klargy:waiting', count: 1 }, ORIGIN, { postMessage: vi.fn() });
    dispatch({ type: 'klargy:waiting', count: 'many' });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('posts logout to the desk origin only, and stops after destroy', () => {
    const { win, iframe, frameWindow, dispatch, listeners } = fakes();
    const onWaiting = vi.fn();
    const desk = embedDesk({ url: URL_, iframe, window: win, onWaiting });
    desk.logout();
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: 'klargy:logout' }, ORIGIN);
    desk.destroy();
    expect(listeners.size).toBe(0);
    dispatch({ type: 'klargy:waiting', count: 1 });
    desk.logout();
    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('creates an iframe in a container and removes it on destroy', () => {
    const { win } = fakes();
    const created = { src: '', title: '', style: {} as Record<string, string>, contentWindow: { postMessage: vi.fn() }, remove: vi.fn() };
    const container = { ownerDocument: { createElement: vi.fn(() => created) }, appendChild: vi.fn() };
    const desk = embedDesk({ url: URL_, container: container as unknown as HTMLElement, window: win });
    expect(container.ownerDocument.createElement).toHaveBeenCalledWith('iframe');
    expect(container.appendChild).toHaveBeenCalledWith(created);
    expect(created.src).toBe(URL_);
    expect(created.title).toBe('Klargy desk');
    desk.destroy();
    expect(created.remove).toHaveBeenCalled();
  });

  it('needs a container or an iframe', () => {
    expect(() => embedDesk({ url: URL_, window: fakes().win })).toThrow(/container or an iframe/);
  });
});
