import { CONTRACT } from './contract';
import type { Entry } from './types';

// The desk inside the EMR (docs/connect/v1.md section 6): the EMR's page
// frames the URL `POST /desk/launch` returned and talks to it with
// postMessage. Browser-only; no Node APIs.

export { CONTRACT };

/** Message types of the desk protocol, v1. */
export const DESK_MESSAGES = {
  ready: 'klargy:ready',
  deskChanged: 'klargy:desk-changed',
  waiting: 'klargy:waiting',
  entryCalled: 'klargy:entry-called',
  entryUpdated: 'klargy:entry-updated',
  /** The height (px) the bar layout needs; additive in v1. */
  resize: 'klargy:resize',
  /** Host to desk. */
  logout: 'klargy:logout',
} as const;

export type DeskServicePoint = {
  /** Klargy service point (the room). */
  id: string;
  name: string;
  /** The EMR's id for it, or null. */
  externalId: string | null;
};

/** Messages the desk posts to its parent (the EMR). */
export type DeskMessage =
  | { type: 'klargy:ready'; contract: string }
  | { type: 'klargy:desk-changed'; servicePoint: DeskServicePoint | null }
  | { type: 'klargy:waiting'; count: number }
  | { type: 'klargy:entry-called'; entry: Entry }
  | { type: 'klargy:entry-updated'; entry: Entry }
  /** Bar layout only: the frame height the desk needs now, in CSS pixels. */
  | { type: 'klargy:resize'; height: number };

/** How the desk lays itself out: the full panel, or one compact horizontal
 * bar (about 60px tall, taller while a menu is open) for a floating toolbar. */
export type DeskLayout = 'default' | 'bar';

/** The launch URL with the layout set (`layout=bar`), or unchanged for the default. */
export function deskUrl(url: string, layout: DeskLayout = 'default'): string {
  if (layout === 'default') return url;
  const parsed = new URL(url);
  parsed.searchParams.set('layout', layout);
  return parsed.toString();
}

/** Messages the parent may post to the desk. */
export type HostMessage = { type: 'klargy:logout' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The desk message in `data`, or null when it isn't a well-formed one. */
export function parseDeskMessage(data: unknown): DeskMessage | null {
  if (!isObject(data) || typeof data.type !== 'string') return null;
  switch (data.type) {
    case DESK_MESSAGES.ready:
      return typeof data.contract === 'string' ? { type: DESK_MESSAGES.ready, contract: data.contract } : null;
    case DESK_MESSAGES.deskChanged: {
      const sp = data.servicePoint;
      if (sp === null) return { type: DESK_MESSAGES.deskChanged, servicePoint: null };
      if (!isObject(sp) || typeof sp.id !== 'string' || typeof sp.name !== 'string') return null;
      const externalId = typeof sp.externalId === 'string' ? sp.externalId : null;
      return { type: DESK_MESSAGES.deskChanged, servicePoint: { id: sp.id, name: sp.name, externalId } };
    }
    case DESK_MESSAGES.waiting:
      return typeof data.count === 'number' && Number.isFinite(data.count) && data.count >= 0
        ? { type: DESK_MESSAGES.waiting, count: data.count }
        : null;
    case DESK_MESSAGES.resize:
      return typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0
        ? { type: DESK_MESSAGES.resize, height: data.height }
        : null;
    case DESK_MESSAGES.entryCalled:
    case DESK_MESSAGES.entryUpdated:
      return isObject(data.entry) && typeof data.entry.entryId === 'string'
        ? { type: data.type, entry: data.entry as unknown as Entry }
        : null;
    default:
      return null;
  }
}

/** The origin of the desk URL: the only origin to accept messages from or post to. */
export function deskOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('The desk URL must be http(s)');
  return parsed.origin;
}

/** True when a message event really came from the desk frame. */
export function isFromDesk(
  event: { origin: string; source: unknown },
  desk: { origin: string; window: unknown }
): boolean {
  return !!desk.window && event.origin === desk.origin && event.source === desk.window;
}

interface MessageWindow {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

interface FrameLike {
  src: string;
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
  setAttribute?(name: string, value: string): void;
  remove?(): void;
  style?: Partial<CSSStyleDeclaration>;
}

export interface EmbedDeskOptions {
  /** The `url` from `POST /desk/launch`. Load it straight away: the code works once, within 60 seconds. */
  url: string;
  /** An element to create the iframe in, or… */
  container?: HTMLElement;
  /** …an iframe you already have (its src is set to `url`). */
  iframe?: HTMLIFrameElement | FrameLike;
  /** The window to listen on; defaults to the global window. */
  window?: MessageWindow;
  /** Title of a created iframe (for screen readers). */
  title?: string;
  /** `bar` loads the compact one-row layout (adds `layout=bar` to `url`). */
  layout?: DeskLayout;
  onReady?: (message: { contract: string }) => void;
  onDeskChanged?: (servicePoint: DeskServicePoint | null) => void;
  onWaiting?: (count: number) => void;
  onEntryCalled?: (entry: Entry) => void;
  onEntryUpdated?: (entry: Entry) => void;
  /** Bar layout: the height the desk needs (row only, or with a menu open).
   * Size the frame to it, within your own limits. */
  onResize?: (height: number) => void;
  /** Every valid message, after the specific callback. */
  onMessage?: (message: DeskMessage) => void;
}

export interface DeskEmbed {
  readonly iframe: HTMLIFrameElement | FrameLike;
  /** The desk's origin (of `url`). */
  readonly origin: string;
  /** Asks the desk to leave its room and sign out (send when the practitioner signs out of the EMR). */
  logout(): void;
  /** Stops listening, and removes the iframe if embedDesk created it. */
  destroy(): void;
}

/**
 * Frames the Klargy desk and wires the postMessage protocol. Messages are
 * accepted only from the frame's window and the launch URL's origin, and
 * `logout` is posted only to that origin.
 */
export function embedDesk(options: EmbedDeskOptions): DeskEmbed {
  const origin = deskOrigin(options.url);
  const src = deskUrl(options.url, options.layout);
  const win = options.window ?? (typeof window !== 'undefined' ? (window as MessageWindow) : undefined);
  if (!win) throw new TypeError('embedDesk needs a window (pass options.window outside a browser)');

  let created = false;
  let frame: HTMLIFrameElement | FrameLike;
  if (options.iframe) {
    frame = options.iframe;
  } else if (options.container) {
    const doc = options.container.ownerDocument;
    const el = doc.createElement('iframe');
    el.title = options.title ?? 'Klargy desk';
    el.style.border = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    options.container.appendChild(el);
    frame = el;
    created = true;
  } else {
    throw new TypeError('Pass a container or an iframe');
  }

  const listener = (event: MessageEvent) => {
    if (!isFromDesk(event, { origin, window: frame.contentWindow })) return;
    const message = parseDeskMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'klargy:ready':
        options.onReady?.({ contract: message.contract });
        break;
      case 'klargy:desk-changed':
        options.onDeskChanged?.(message.servicePoint);
        break;
      case 'klargy:waiting':
        options.onWaiting?.(message.count);
        break;
      case 'klargy:entry-called':
        options.onEntryCalled?.(message.entry);
        break;
      case 'klargy:entry-updated':
        options.onEntryUpdated?.(message.entry);
        break;
      case 'klargy:resize':
        options.onResize?.(message.height);
        break;
    }
    options.onMessage?.(message);
  };
  win.addEventListener('message', listener);
  frame.src = src;

  let destroyed = false;
  return {
    iframe: frame,
    origin,
    logout() {
      if (destroyed) return;
      const message: HostMessage = { type: DESK_MESSAGES.logout };
      frame.contentWindow?.postMessage(message, origin);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener('message', listener);
      if (created) frame.remove?.();
    },
  };
}
