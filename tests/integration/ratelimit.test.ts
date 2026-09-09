import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collections, type Collections } from '../../src/db/collections.js';
import { MemoryFixedWindowLimiter } from '../../src/ratelimit/memoryFixedWindow.js';
import { MongoFixedWindowLimiter } from '../../src/ratelimit/mongoFixedWindow.js';
import type { RateLimiter } from '../../src/ratelimit/limiter.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const T = new Date('2026-09-09T12:00:30.000Z');
const NEXT_WINDOW = new Date('2026-09-09T12:01:05.000Z');

describe('fixed window rate limiters', () => {
  let mongo: TestMongo;
  let cols: Collections;

  beforeAll(async () => {
    mongo = await startMongo();
    cols = collections(mongo.db);
    await cols.rateLimitBuckets.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  });

  afterAll(async () => {
    await mongo.stop();
  });

  const suites: Array<[string, () => RateLimiter]> = [
    ['mongo', () => new MongoFixedWindowLimiter(cols, 3)],
    ['memory', () => new MemoryFixedWindowLimiter(3)],
  ];

  for (const [name, make] of suites) {
    describe(name, () => {
      it('allows exactly the configured number of requests', async () => {
        const limiter = make();
        const key = `key_allow_${name}`;
        for (let i = 1; i <= 3; i += 1) {
          const decision = await limiter.consume(key, T);
          expect(decision.allowed).toBe(true);
          expect(decision.remaining).toBe(3 - i);
        }

        const denied = await limiter.consume(key, T);
        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBe(0);
        expect(denied.limit).toBe(3);
      });

      it('reports the start of the next minute as the reset instant', async () => {
        const decision = await make().consume(`key_reset_${name}`, T);
        expect(decision.resetAt.toISOString()).toBe('2026-09-09T12:01:00.000Z');
      });

      it('refills in the next window', async () => {
        const limiter = make();
        const key = `key_refill_${name}`;
        for (let i = 0; i < 4; i += 1) await limiter.consume(key, T);
        expect((await limiter.consume(key, T)).allowed).toBe(false);
        expect((await limiter.consume(key, NEXT_WINDOW)).allowed).toBe(true);
      });

      it('counts each key separately', async () => {
        const limiter = make();
        for (let i = 0; i < 4; i += 1) await limiter.consume(`key_a_${name}`, T);
        expect((await limiter.consume(`key_a_${name}`, T)).allowed).toBe(false);
        expect((await limiter.consume(`key_b_${name}`, T)).allowed).toBe(true);
      });
    });
  }

  it('stores the mongo counter as a BSON int with a TTL expiry', async () => {
    const limiter = new MongoFixedWindowLimiter(cols, 3);
    await limiter.consume('key_types', T);
    const bucket = await cols.rateLimitBuckets.findOne({
      count: { $type: 'int' },
      _id: { $regex: '^key_types:' },
    });
    expect(bucket).not.toBeNull();
    expect(bucket?.expires_at.getTime()).toBeGreaterThan(T.getTime());
  });
});
