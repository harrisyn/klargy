import { describe, it, expect, vi } from 'vitest';
import {
  deskLayoutFrom,
  isLogoutRequest,
  postToHost,
  readLaunch,
  resizeReporter,
  saveLaunch,
  targetOriginFor,
  withoutLaunchCode,
  type DeskLaunch,
  type DeskMessage,
} from './connectBridge';

// The desk talks only to the launch's returnOrigin (docs/connect/v1.md
// section 6).

const launch: DeskLaunch = { launchId: 'l1', origin: 'https://emr.example.com', servicePointId: null };

describe('targetOriginFor', () => {
  it('is the launch origin', () => {
    expect(targetOriginFor(launch)).toBe('https://emr.example.com');
  });

  it('is never a wildcard or anything but an origin', () => {
    expect(targetOriginFor(null)).toBeNull();
    expect(targetOriginFor({ origin: '*' })).toBeNull();
    expect(targetOriginFor({ origin: 'null' })).toBeNull();
    expect(targetOriginFor({ origin: '' })).toBeNull();
    expect(targetOriginFor({ origin: 'https://emr.example.com/path' })).toBeNull();
    expect(targetOriginFor({ origin: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('postToHost', () => {
  it('posts to the launch origin only', () => {
    const parent = { postMessage: vi.fn() };
    expect(postToHost(parent, launch, { type: 'klargy:waiting', count: 3 })).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'klargy:waiting', count: 3 }, 'https://emr.example.com');
  });

  it('posts nothing without a launch or a parent', () => {
    const parent = { postMessage: vi.fn() };
    expect(postToHost(parent, null, { type: 'klargy:ready', contract: 'klargy-connect/v1' })).toBe(false);
    expect(postToHost(null, launch, { type: 'klargy:ready', contract: 'klargy-connect/v1' })).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});

describe('isLogoutRequest', () => {
  const parent = {};
  it('accepts klargy:logout from the launch origin and the parent window', () => {
    expect(isLogoutRequest({ origin: 'https://emr.example.com', source: parent, data: { type: 'klargy:logout' } }, launch, parent)).toBe(true);
  });

  it('ignores other origins, other windows and other messages', () => {
    expect(isLogoutRequest({ origin: 'https://evil.example.com', source: parent, data: { type: 'klargy:logout' } }, launch, parent)).toBe(false);
    expect(isLogoutRequest({ origin: 'https://emr.example.com', source: {}, data: { type: 'klargy:logout' } }, launch, parent)).toBe(false);
    expect(isLogoutRequest({ origin: 'https://emr.example.com', source: parent, data: 'klargy:logout' }, launch, parent)).toBe(false);
    expect(isLogoutRequest({ origin: 'https://emr.example.com', source: parent, data: { type: 'klargy:logout' } }, null, parent)).toBe(false);
  });
});

describe('launch storage', () => {
  it('round-trips and rejects a stored launch with a bad origin', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveLaunch(launch, storage);
    expect(readLaunch(storage)).toEqual(launch);
    saveLaunch({ ...launch, origin: '*' }, storage);
    expect(readLaunch(storage)).toBeNull();
  });
});

describe('bar layout', () => {
  it('is chosen with layout=bar only', () => {
    expect(deskLayoutFrom('?launch=abc&layout=bar')).toBe('bar');
    expect(deskLayoutFrom('?layout=bar')).toBe('bar');
    expect(deskLayoutFrom('?launch=abc')).toBe('default');
    expect(deskLayoutFrom('?layout=wide')).toBe('default');
    expect(deskLayoutFrom('')).toBe('default');
  });

  it('survives removing the one-time launch code', () => {
    const after = withoutLaunchCode('?launch=abc&layout=bar');
    expect(after).toBe('?layout=bar');
    expect(deskLayoutFrom(after)).toBe('bar');
    expect(withoutLaunchCode('?launch=abc')).toBe('');
    expect(withoutLaunchCode('?layout=bar&launch=abc&popup=1')).toBe('?layout=bar&popup=1');
  });
});

describe('resizeReporter', () => {
  it('posts klargy:resize to the launch origin once per change, in whole pixels', () => {
    const parent = { postMessage: vi.fn() };
    const report = resizeReporter((message: DeskMessage) => postToHost(parent, launch, message));
    report(60);
    report(60);
    report(247.3);
    report(60.0);
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: 'klargy:resize', height: 60 }, 'https://emr.example.com'],
      [{ type: 'klargy:resize', height: 248 }, 'https://emr.example.com'],
      [{ type: 'klargy:resize', height: 60 }, 'https://emr.example.com'],
    ]);
  });

  it('ignores nonsense heights and retries after a post that went nowhere', () => {
    const post = vi.fn(() => false);
    const report = resizeReporter(post);
    report(0);
    report(Number.NaN);
    expect(post).not.toHaveBeenCalled();
    report(60);
    report(60);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
