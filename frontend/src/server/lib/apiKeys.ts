import crypto from 'crypto';

// Integration API keys (Klargy Connect). Only a SHA-256 hash is stored; the
// key itself is shown once, when it's created or rotated.

export const API_KEY_PREFIX = 'klg_live_';
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY_LENGTH = 40;
const SHOWN_PREFIX_LENGTH = 12;

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const bytes = crypto.randomBytes(KEY_LENGTH);
  // 256 % 62 != 0, so this is very slightly biased; irrelevant at 40 chars.
  const body = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  const key = `${API_KEY_PREFIX}${body}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, SHOWN_PREFIX_LENGTH) };
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function looksLikeApiKey(value: string | undefined): value is string {
  return !!value && value.startsWith(API_KEY_PREFIX) && value.length === API_KEY_PREFIX.length + KEY_LENGTH;
}
