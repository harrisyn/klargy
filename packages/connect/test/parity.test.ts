import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONNECT_ERROR_CODES, CONNECT_SCOPES, CONTRACT, LOOKUP_IDENTIFIER_TYPES, WEBHOOK_EVENTS, WEBHOOK_HEADERS } from '../src/index';
import { DESK_MESSAGES, ROOM_TYPES } from '../src/desk';

// The Klargy app keeps its own copy of the protocol (its Docker build only
// sees frontend/). These checks fail when the two drift apart. They run only
// inside the repository.

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../../../frontend/src');
const read = (path: string) => readFileSync(join(app, path), 'utf8');
const inRepo = existsSync(app);

const quoted = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => m[1]);
const arrayLiteral = (source: string, name: string) => {
  const body = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source)?.[1] ?? '';
  return quoted(body, /'([^']+)'/g);
};

describe.skipIf(!inRepo)('parity with the Klargy app', () => {
  it('has the same contract string and desk message types', () => {
    const bridge = read('components/desk/connectBridge.ts');
    expect(bridge).toContain(`CONTRACT = '${CONTRACT}'`);
    const types = new Set(quoted(bridge, /'(klargy:[a-z-]+)'/g));
    expect([...types].sort()).toEqual(Object.values(DESK_MESSAGES).sort());
    expect(arrayLiteral(bridge, 'ROOM_TYPES')).toEqual([...ROOM_TYPES]);
  });

  it('lists the same webhook events and signs with the same headers', () => {
    const webhooks = read('server/services/webhooks.service.ts');
    expect(arrayLiteral(webhooks, 'WEBHOOK_EVENTS')).toEqual([...WEBHOOK_EVENTS]);
    expect(webhooks).toContain('`${timestamp}.${body}`');
    for (const name of Object.values(WEBHOOK_HEADERS)) expect(webhooks).toContain(`'${name}'`);
    const lookup = read('server/services/connectLookup.service.ts');
    expect(arrayLiteral(lookup, 'LOOKUP_IDENTIFIER_TYPES')).toEqual([...LOOKUP_IDENTIFIER_TYPES]);
    expect(lookup).toContain("'X-Webhook-Event': 'patient.lookup'");
  });

  it('gives keys the same scopes', () => {
    const auth = read('server/middleware/integrationAuth.middleware.ts');
    expect(arrayLiteral(auth, 'CONNECT_SCOPES')).toEqual([...CONNECT_SCOPES]);
  });

  it('knows every error code the Connect controllers send', () => {
    const dir = join(app, 'server/controllers');
    const sent = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => /^connect(Queue|Desk|Journey)?\.controller\.ts$/.test(f))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const code of quoted(source, /new ConnectError\([\s\S]*?,\s*\d{3},\s*'([A-Z_]+)'/g)) sent.add(code);
    }
    expect(sent.size).toBeGreaterThan(10);
    for (const code of sent) expect(CONNECT_ERROR_CODES).toContain(code);
  });
});
