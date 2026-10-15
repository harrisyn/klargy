import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_NAME, readRuntimeConfigFromEnv } from './runtimeConfig';

describe('app name', () => {
  const saved = process.env.APP_NAME;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_NAME;
    else process.env.APP_NAME = saved;
  });

  it('is Klargy when APP_NAME is not set', () => {
    delete process.env.APP_NAME;
    expect(DEFAULT_APP_NAME).toBe('Klargy');
    expect(readRuntimeConfigFromEnv().appName).toBe('Klargy');
  });

  it("uses a deployment's own APP_NAME", () => {
    process.env.APP_NAME = 'Acme Queues';
    expect(readRuntimeConfigFromEnv().appName).toBe('Acme Queues');
  });
});
