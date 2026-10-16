import crypto from 'crypto';
import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/encryption';

// First-run setup: a fresh database has no superadmin, so the app shows /setup
// where the first one is created. The page is authorised by a setup token:
//   - SETUP_TOKEN from the environment, if set; otherwise
//   - a random token generated once, stored encrypted in the database and
//     printed to the server log.
// The stored token is removed once the superadmin exists.

const TOKEN_ROW_ID = 'platform';
const RECHECK_MS = 5_000;

let superadminExists = false; // once true it stays true for this process
let lastCheck = 0;
let lastResult = false;
let announced = false;

/** True while the platform has no superadmin (cached briefly; the proxy calls this per request). */
export async function needsSetup(): Promise<boolean> {
  if (superadminExists) return false;
  if (Date.now() - lastCheck < RECHECK_MS) return lastResult;
  const count = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
  lastCheck = Date.now();
  lastResult = count === 0;
  if (!lastResult) superadminExists = true;
  return lastResult;
}

/** Forgets cached state; `created` marks the superadmin as existing. */
export function resetSetupCache(created = false) {
  superadminExists = created;
  lastCheck = 0;
  lastResult = false;
  announced = false;
}

async function expectedToken(): Promise<string> {
  const fromEnv = process.env.SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const existing = await prisma.setupToken.findUnique({ where: { id: TOKEN_ROW_ID } });
  if (existing) return decrypt(existing.encryptedToken);
  const token = crypto.randomBytes(24).toString('hex');
  // A concurrent request may win the insert; read back whichever token was stored.
  await prisma.setupToken.createMany({ data: [{ id: TOKEN_ROW_ID, encryptedToken: encrypt(token) }], skipDuplicates: true });
  const stored = await prisma.setupToken.findUniqueOrThrow({ where: { id: TOKEN_ROW_ID } });
  return decrypt(stored.encryptedToken);
}

/** Prints the generated token to the server log, once per process. */
export async function announceSetupToken(): Promise<void> {
  if (announced || process.env.SETUP_TOKEN?.trim()) return;
  announced = true;
  try {
    const token = await expectedToken();
    console.log(
      `\n=== FIRST-RUN SETUP ===\nNo superadmin exists yet. Open /setup and enter this setup token:\n  ${token}\n(or set SETUP_TOKEN in the environment)\n=======================\n`
    );
  } catch (err) {
    announced = false;
    console.error('Could not prepare the setup token:', err);
  }
}

const digest = (v: string) => crypto.createHash('sha256').update(v).digest();

export async function isValidSetupToken(candidate: unknown): Promise<boolean> {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const expected = await expectedToken();
  return crypto.timingSafeEqual(digest(candidate.trim()), digest(expected));
}

export async function clearSetupToken(): Promise<void> {
  await prisma.setupToken.deleteMany({ where: { id: TOKEN_ROW_ID } });
}
