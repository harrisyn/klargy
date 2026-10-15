/**
 * The desk's side of the Klargy Connect postMessage protocol
 * (docs/connect/v1.md section 6). A desk opened through a launch talks only
 * to the launch's returnOrigin, never '*', and only takes orders from it.
 * Pure apart from the sessionStorage helpers, so it can be tested alone.
 */

export const CONTRACT = 'klargy-connect/v1';

export interface DeskLaunch {
  launchId: string;
  /** The EMR's origin: the only one the desk posts to or listens to. */
  origin: string;
  /** Klargy service point to preselect in the picker. */
  servicePointId: string | null;
}

export type DeskServicePoint = { id: string; name: string; externalId: string | null };

export type DeskMessage =
  | { type: 'klargy:ready'; contract: string }
  | { type: 'klargy:desk-changed'; servicePoint: DeskServicePoint | null }
  | { type: 'klargy:waiting'; count: number }
  | { type: 'klargy:entry-called'; entry: Record<string, unknown> }
  | { type: 'klargy:entry-updated'; entry: Record<string, unknown> };

const KEY = 'klargy_desk_launch';

/** The origin to post to, or null when there's nowhere safe to post. */
export function targetOriginFor(launch: Pick<DeskLaunch, 'origin'> | null | undefined): string | null {
  if (!launch?.origin || launch.origin === '*' || launch.origin === 'null') return null;
  try {
    const url = new URL(launch.origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin === launch.origin ? launch.origin : null;
  } catch {
    return null;
  }
}

interface PostTarget {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

/** Posts to the EMR window. Returns false (and posts nothing) without a
 * launch, a parent, or a valid origin. */
export function postToHost(parent: PostTarget | null | undefined, launch: DeskLaunch | null, message: DeskMessage): boolean {
  const target = targetOriginFor(launch);
  if (!parent || !target) return false;
  parent.postMessage(message, target);
  return true;
}

/** The parent's request to sign out, when it really came from the EMR. */
export function isLogoutRequest(
  event: { origin: string; source: unknown; data: unknown },
  launch: DeskLaunch | null,
  parent: unknown
): boolean {
  const target = targetOriginFor(launch);
  if (!target || event.origin !== target || event.source !== parent) return false;
  const data = event.data as { type?: unknown } | null;
  return !!data && typeof data === 'object' && data.type === 'klargy:logout';
}

export function readLaunch(storage: Pick<Storage, 'getItem'> | null | undefined = safeSession()): DeskLaunch | null {
  try {
    const raw = storage?.getItem(KEY);
    const launch = raw ? (JSON.parse(raw) as DeskLaunch) : null;
    return launch && typeof launch.launchId === 'string' && targetOriginFor(launch) ? launch : null;
  } catch {
    return null;
  }
}

export function saveLaunch(launch: DeskLaunch, storage: Pick<Storage, 'setItem'> | null | undefined = safeSession()) {
  try {
    storage?.setItem(KEY, JSON.stringify(launch));
  } catch {
    /* storage blocked: the launch lasts until reload */
  }
}

export function clearLaunch(storage: Pick<Storage, 'removeItem'> | null | undefined = safeSession()) {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

function safeSession(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
