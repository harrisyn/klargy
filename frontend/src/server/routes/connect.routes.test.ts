import { describe, it, expect, vi } from 'vitest';

// Each Connect route must require its scope (docs/connect/v1.md section 1).
vi.mock('../middleware/rateLimit.middleware', () => ({ limits: { connect: (_req: unknown, _res: unknown, next: () => void) => next() } }));
vi.mock('../middleware/integrationAuth.middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/integrationAuth.middleware')>();
  return {
    ...actual,
    authenticateIntegration: vi.fn(),
    requireScope: (scope: string) => Object.assign(actual.requireScope(scope as never), { scope }),
  };
});
vi.mock('../lib/prisma', () => ({ default: {} }));

import router from './connect.routes';
import { CONNECT_SCOPES, requireScope } from '../middleware/integrationAuth.middleware';

function scopeOf(method: string, path: string): string | undefined {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  expect(layer, `${method.toUpperCase()} ${path}`).toBeTruthy();
  return layer.route.stack.map((s: any) => s.handle.scope).find(Boolean);
}

describe('Connect routes', () => {
  it('guards the phase 2 routes with their scopes', () => {
    expect(scopeOf('put', '/patients/:patientId')).toBe('patients:write');
    expect(scopeOf('get', '/entries')).toBe('entries:read');
    expect(scopeOf('post', '/entries')).toBe('entries:write');
    expect(scopeOf('post', '/entries/by-ref/:type/:id/:action')).toBe('entries:write');
  });

  it('gives new keys the phase 2 scopes', () => {
    expect(CONNECT_SCOPES).toEqual(expect.arrayContaining(['patients:write', 'entries:read', 'entries:write']));
  });

  it('refuses a phase 1 key on a phase 2 route', () => {
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    const phase1 = { integration: { id: 'int1', organizationId: 'org1', scopes: ['integration:write', 'catalog:read', 'catalog:write'] } };
    requireScope('entries:write')(phase1 as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
