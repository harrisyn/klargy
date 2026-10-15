import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/** The same development-only default docker-compose.yml uses. */
export const DEV_MASTER_ENCRYPTION_KEY = 'dev-only-master-encryption-key-change-in-production';
let warnedDevKey = false;

function getMasterKey(): Buffer {
  let raw = process.env.MASTER_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MASTER_ENCRYPTION_KEY is not set. Set it to a random secret (openssl rand -hex 32) and keep it the same ' +
          'across deploys: it encrypts payment keys, integration credentials and webhook secrets at rest.'
      );
    }
    // Development (npm run dev without Docker): the docker-compose default, so
    // secrets saved locally stay readable between the two setups.
    if (!warnedDevKey) {
      warnedDevKey = true;
      console.warn('MASTER_ENCRYPTION_KEY is not set: using the development-only default. Set it in .env for anything shared.');
    }
    raw = DEV_MASTER_ENCRYPTION_KEY;
  }
  // Derive a stable 32-byte key from whatever-length secret is provided
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypts a plaintext string. Output format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts a string produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key = getMasterKey();
  const [ivB64, authTagB64, encryptedB64] = ciphertext.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Masks a secret for display, keeping only the last 4 characters visible.
 */
export function mask(secret: string): string {
  if (secret.length <= 4) {
    return '•'.repeat(secret.length);
  }
  return '•'.repeat(secret.length - 4) + secret.slice(-4);
}
