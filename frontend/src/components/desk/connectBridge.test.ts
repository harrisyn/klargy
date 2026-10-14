import { describe, it, expect, vi } from 'vitest';
import { isLogoutRequest, postToHost, readLaunch, saveLaunch, targetOriginFor, type DeskLaunch } from './connectBridge';

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
