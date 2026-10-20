import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// docs/connect/openapi.yaml must describe every Connect route, with its
// scope, and every webhook event (docs/connect/v1.md).
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
import { WEBHOOK_EVENTS } from '../services/webhooks.service';

const SPEC = path.resolve(__dirname, '../../../../docs/connect/openapi.yaml');
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

/** `paths` of the spec as "METHOD /path" -> the operation's text. A small
 * reader for this file's layout (two-space indents), not a YAML parser. */
function operations(spec: string): Map<string, string> {
  const section = spec.slice(spec.indexOf('\npaths:\n'), spec.indexOf('\nwebhooks:\n'));
  const ops = new Map<string, string>();
  let currentPath = '';
  let current: { key: string; lines: string[] } | null = null;
  for (const line of section.split('\n')) {
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    const m = /^ {4}([a-z]+):\s*$/.exec(line);
    if (p) currentPath = p[1];
    if (p || (m && METHODS.includes(m[1]))) {
      if (current) ops.set(current.key, current.lines.join('\n'));
      current = m ? { key: `${m[1].toUpperCase()} ${currentPath}`, lines: [] } : null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) ops.set(current.key, current.lines.join('\n'));
  return ops;
}

const routes = () =>
  (router as any).stack
    .filter((l: any) => l.route)
    .flatMap((l: any) =>
      Object.keys(l.route.methods).map((method) => ({
        key: `${method.toUpperCase()} ${l.route.path.replace(/:(\w+)/g, '{$1}')}`,
        scope: l.route.stack.map((s: any) => s.handle.scope).find(Boolean) as string | undefined,
      }))
    );

describe.skipIf(!existsSync(SPEC))('Connect OpenAPI description', () => {
  const spec = existsSync(SPEC) ? readFileSync(SPEC, 'utf8') : '';
  const ops = operations(spec);

  it('is valid YAML that tools can read, and every $ref points at something', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const doc = require('js-yaml').load(spec) as Record<string, any>;
    expect(Object.keys(doc.paths).length).toBeGreaterThan(10);
    const refs = [...spec.matchAll(/\$ref: '#\/([^']+)'/g)].map((m) => m[1].split('/'));
    for (const ref of refs) {
      let node: any = doc;
      for (const part of ref) node = node?.[part];
      expect(node, `$ref #/${ref.join('/')}`).toBeDefined();
    }
  });

  it('describes every Connect route and names its scope', () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(10);
    for (const { key, scope } of all) {
      expect(ops.has(key), `${key} in openapi.yaml`).toBe(true);
      if (scope) expect(ops.get(key), `${key} names scope ${scope}`).toContain(`Scope \`${scope}\``);
    }
  });

  it('describes nothing the server does not serve', () => {
    const served = new Set(routes().map((r: { key: string }) => r.key));
    for (const key of ops.keys()) {
      // transfer, priority, hold, resume and clear are documented separately from the generic {action} route.
      const generic = key.replace(/\/(transfer|priority|hold|resume|clear)$/, '/{action}');
      expect(served.has(key) || served.has(generic), `${key} is served`).toBe(true);
    }
  });

  it('lists every webhook event, the ping and the lookup call', () => {
    const webhooks = spec.slice(spec.indexOf('\nwebhooks:\n'), spec.indexOf('\ncomponents:\n'));
    const names = [...webhooks.matchAll(/^ {2}([a-z_.]+):/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual([...WEBHOOK_EVENTS, 'ping', 'patient.lookup'].sort());
  });
});
