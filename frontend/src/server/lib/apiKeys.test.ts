import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeApiKey, API_KEY_PREFIX } from './apiKeys';

describe('integration API keys', () => {
  it('generates a prefixed key whose hash and shown prefix match it', () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 40);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(looksLikeApiKey(key)).toBe(true);
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });

  it('rejects values that are not keys', () => {
    expect(looksLikeApiKey(undefined)).toBe(false);
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(looksLikeApiKey(`${API_KEY_PREFIX}short`)).toBe(false);
  });
});
