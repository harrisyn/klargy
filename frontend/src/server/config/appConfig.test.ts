import { afterEach, describe, expect, it, vi } from 'vitest';

// APP_URL: links are built on it; development without it follows the request,
// production without it fails loudly.

const load = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  return import('./appConfig');
};
const sub = (host: string) => (host.split(':')[0].endsWith('.localhost') ? host.split('.')[0] : null);

afterEach(() => vi.unstubAllEnvs());

describe('appUrl', () => {
  it('uses APP_URL when it is set, whatever the request', async () => {
    const c = await load({ APP_URL: 'https://klargy.example/', FRONTEND_URL: '', NODE_ENV: 'production' });
    c.rememberRequestAppUrl({ host: 'evil.test' }, 'http', sub);
    expect(c.appUrl()).toBe('https://klargy.example');
    expect(c.buildAppUrl('/status/q/e', 'nyaho')).toBe('https://nyaho.klargy.example/status/q/e');
    expect(() => c.assertAppUrlConfigured()).not.toThrow();
  });

  it('fails loudly in production when it is missing', async () => {
    const c = await load({ APP_URL: '', FRONTEND_URL: '', NODE_ENV: 'production' });
    expect(() => c.assertAppUrlConfigured()).toThrow(/APP_URL is not set/);
    expect(() => c.buildAppUrl('/widget/desk', 'nyaho')).toThrow(/APP_URL is not set/);
  });

  it('follows the address the app is reached on in development, without the tenant subdomain', async () => {
    const c = await load({ APP_URL: '', FRONTEND_URL: '', NODE_ENV: 'development' });
    expect(c.appUrl()).toBe('http://localhost:8003');
    c.rememberRequestAppUrl({ host: 'nyaho.localhost:3000' }, 'http', sub);
    expect(c.appUrl()).toBe('http://localhost:3000');
    expect(c.buildAppUrl('/widget/desk?launch=x', 'nyaho')).toBe('http://nyaho.localhost:3000/widget/desk?launch=x');
    c.rememberRequestAppUrl({ host: 'localhost:3000', 'x-forwarded-proto': 'javascript' }, 'http', sub);
    expect(c.appUrl()).toBe('http://localhost:3000');
  });
});
