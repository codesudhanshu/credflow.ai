import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('applies working defaults when nothing is configured', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.PROVISIONING_MS).toBe(10_000);
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(100);
    expect(env.RATE_LIMIT_STORE).toBe('mongo');
    expect(env.MONGODB_URI).toBeUndefined();
  });

  it('coerces numeric strings, because process.env is all strings', () => {
    const env = loadEnv({ PORT: '8080', PROVISIONING_MS: '250' });
    expect(env.PORT).toBe(8080);
    expect(env.PROVISIONING_MS).toBe(250);
  });

  it('fails fast with a readable message on a bad value', () => {
    expect(() => loadEnv({ RATE_LIMIT_STORE: 'redis' })).toThrow(/RATE_LIMIT_STORE/);
    expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow(/PORT/);
  });
});
