import { describe, it, expect, vi, beforeEach } from 'vitest';

// First-run setup: the superadmin is created once, with the setup token, and
// the endpoint closes afterwards.

const db = vi.hoisted(() => ({
  superadmins: 0,
  tokenRow: null as null | { id: string; encryptedToken: string },
  users: [] as any[],
}));

vi.mock('../lib/prisma', () => ({
  default: {
    user: {
      count: vi.fn(async () => db.superadmins),
      findUnique: vi.fn(async ({ where }: any) => db.users.find((u) => u.email === where.email) ?? null),
      create: vi.fn(async ({ data }: any) => {
        db.users.push(data);
        if (data.role === 'SUPER_ADMIN') db.superadmins++;
        return data;
      }),
    },
    setupToken: {
      findUnique: vi.fn(async () => db.tokenRow),
      findUniqueOrThrow: vi.fn(async () => db.tokenRow),
      createMany: vi.fn(async ({ data }: any) => {
        db.tokenRow ??= data[0];
      }),
      deleteMany: vi.fn(async () => {
        db.tokenRow = null;
      }),
    },
  },
}));

import bcrypt from 'bcryptjs';
import { decrypt } from '../lib/encryption';
import { getSetupStatus, completeSetup } from './setup.controller';
import { resetSetupCache, announceSetupToken } from '../services/setup.service';

function call(handler: any, body?: any) {
  return new Promise<{ status: number; json: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(j: any) {
        resolve({ status: this.statusCode, json: j });
      },
    };
    handler({ body }, res);
  });
}

const form = (token: string, over: object = {}) => ({
  token,
  email: 'root@example.com',
  password: 'a-long-passphrase',
  firstName: 'Root',
  lastName: 'Admin',
  ...over,
});

beforeEach(() => {
  db.superadmins = 0;
  db.tokenRow = null;
  db.users = [];
  delete process.env.SETUP_TOKEN;
  resetSetupCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('first-run setup', () => {
  it('reports setup needed until a superadmin exists', async () => {
    expect((await call(getSetupStatus)).json).toEqual({ needsSetup: true });
  });

  it('stores a generated token encrypted, then creates a hashed superadmin and removes the token', async () => {
    await announceSetupToken();
    const stored = db.tokenRow!.encryptedToken;
    const token = decrypt(stored);
    expect(stored).not.toContain(token);

    expect((await call(completeSetup, form('wrong'))).status).toBe(401);
    expect(db.users).toHaveLength(0);

    const ok = await call(completeSetup, form(token));
    expect(ok.status).toBe(201);
    expect(db.users[0].role).toBe('SUPER_ADMIN');
    expect(db.users[0].password).not.toBe('a-long-passphrase');
    expect(await bcrypt.compare('a-long-passphrase', db.users[0].password)).toBe(true);
    expect(db.tokenRow).toBeNull();

    expect((await call(getSetupStatus)).json).toEqual({ needsSetup: false });
    expect((await call(completeSetup, form(token, { email: 'two@example.com' }))).status).toBe(403);
  });

  it('accepts SETUP_TOKEN from the environment without storing anything', async () => {
    process.env.SETUP_TOKEN = 'from-the-env';
    expect((await call(completeSetup, form('nope'))).status).toBe(401);
    expect((await call(completeSetup, form('from-the-env'))).status).toBe(201);
    expect(db.tokenRow).toBeNull();
  });

  it('rejects short passwords', async () => {
    process.env.SETUP_TOKEN = 'tok';
    expect((await call(completeSetup, form('tok', { password: 'short' }))).status).toBe(400);
  });
});
