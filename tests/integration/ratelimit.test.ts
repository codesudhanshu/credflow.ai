import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, type Collections } from '../../src/db/collections.js';
import { gcraConfig, type RateLimiter } from '../../src/ratelimit/limiter.js';
import { MemoryGcraLimiter } from '../../src/ratelimit/memoryGcra.js';
import { MongoGcraLimiter } from '../../src/ratelimit/mongoGcra.js';
import { seededRng } from '../../src/random.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

// 100/min sustained (a 600ms emission interval) with a capacity of 3, so a
// burst is three requests and one slot drains every 600ms.
const CFG = gcraConfig({ ratePerMinute: 100, burst: 3 });

const T0 = new Date('2026-09-09T12:00:30.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe('leaky bucket rate limiter (GCRA)', () => {
  let mongo: TestMongo;
  let cols: Collections;

  beforeAll(async () => {
    mongo = await startMongo();
    cols = collections(mongo.db);
    await cols.rateLimitBuckets.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  });

  beforeEach(async () => {
    await cols.rateLimitBuckets.deleteMany({});
  });

  afterAll(async () => {
    await mongo.stop();
  });

  const backends: Array<[string, () => RateLimiter]> = [
    ['mongo', () => new MongoGcraLimiter(cols, CFG)],
    ['memory', () => new MemoryGcraLimiter(CFG)],
  ];

  for (const [name, make] of backends) {
    describe(name, () => {
      it('admits a burst up to capacity, then rejects', async () => {
        const limiter = make();
        const key = `key_burst_${name}`;

        for (let i = 1; i <= 3; i += 1) {
          const decision = await limiter.consume(key, T0);
          expect(decision.allowed).toBe(true);
          expect(decision.remaining).toBe(3 - i);
          expect(decision.limit).toBe(3);
        }

        const denied = await limiter.consume(key, T0);
        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBe(0);
      });

      it('drains one slot per emission interval rather than resetting a window', async () => {
        const limiter = make();
        const key = `key_drain_${name}`;
        for (let i = 0; i < 3; i += 1) await limiter.consume(key, T0);

        // Still full a moment later.
        expect((await limiter.consume(key, at(599))).allowed).toBe(false);
        // Exactly one slot has drained, and only one.
        expect((await limiter.consume(key, at(600))).allowed).toBe(true);
        expect((await limiter.consume(key, at(600))).allowed).toBe(false);
        // The next slot arrives one interval later, not at a window boundary.
        expect((await limiter.consume(key, at(1_200))).allowed).toBe(true);
      });

      it('does not extend a caller lockout when it rejects', async () => {
        const limiter = make();
        const key = `key_nopunish_${name}`;
        for (let i = 0; i < 3; i += 1) await limiter.consume(key, T0);

        // Hammer a full bucket. A rejected request must not push the bucket
        // forward, or a retrying client would lock itself out indefinitely.
        for (let i = 0; i < 50; i += 1) {
          expect((await limiter.consume(key, T0)).allowed).toBe(false);
        }

        // One interval after the burst, a slot is still available on schedule.
        expect((await limiter.consume(key, at(600))).allowed).toBe(true);
      });

      it('points nextAllowedAt at the next draining slot, not a window end', async () => {
        const limiter = make();
        const key = `key_next_${name}`;
        for (let i = 0; i < 3; i += 1) await limiter.consume(key, T0);

        const denied = await limiter.consume(key, T0);
        // 600ms, not "wait until the top of the next minute".
        expect(denied.nextAllowedAt.toISOString()).toBe(at(600).toISOString());
      });

      it('refills fully once the bucket has drained', async () => {
        const limiter = make();
        const key = `key_refill_${name}`;
        for (let i = 0; i < 4; i += 1) await limiter.consume(key, T0);

        const afterDrain = await limiter.consume(key, at(60_000));
        expect(afterDrain.allowed).toBe(true);
        expect(afterDrain.remaining).toBe(2);
      });

      it('meters each key independently', async () => {
        const limiter = make();
        for (let i = 0; i < 4; i += 1) await limiter.consume(`key_a_${name}`, T0);
        expect((await limiter.consume(`key_a_${name}`, T0)).allowed).toBe(false);
        expect((await limiter.consume(`key_b_${name}`, T0)).allowed).toBe(true);
      });

      it('smooths strictly when capacity is one', async () => {
        const strict = gcraConfig({ ratePerMinute: 100, burst: 1 });
        const limiter =
          name === 'mongo' ? new MongoGcraLimiter(cols, strict) : new MemoryGcraLimiter(strict);
        const key = `key_strict_${name}`;

        expect((await limiter.consume(key, T0)).allowed).toBe(true);
        expect((await limiter.consume(key, T0)).allowed).toBe(false);
        expect((await limiter.consume(key, at(599))).allowed).toBe(false);
        expect((await limiter.consume(key, at(600))).allowed).toBe(true);
      });
    });
  }

  /**
   * The MongoDB backend restates the admission rule as an aggregation pipeline
   * so the whole cycle is one atomic operation; the in-memory one calls the
   * shared `admit()`. That is two implementations of one rule, so drive both
   * through the same irregular sequence and require identical answers.
   */
  it('both backends agree on every decision across a long irregular sequence', async () => {
    const mongoLimiter = new MongoGcraLimiter(cols, CFG);
    const memoryLimiter = new MemoryGcraLimiter(CFG);
    const rng = seededRng(20_260_909);
    const keys = ['key_diff_a', 'key_diff_b', 'key_diff_c'];

    let elapsed = 0;
    let rejections = 0;

    for (let step = 0; step < 300; step += 1) {
      // Gaps small enough that per-key arrivals outpace the 600ms drain and the
      // buckets genuinely saturate, with a periodic jump that drains them fully
      // so the sequence covers both sides of the rule.
      elapsed += rng.intBetween(0, 250);
      if (step % 40 === 39) elapsed += 5_000;

      const key = keys[rng.intBetween(0, keys.length - 1)]!;
      const now = at(elapsed);

      const fromMongo = await mongoLimiter.consume(key, now);
      const fromMemory = await memoryLimiter.consume(key, now);

      expect(fromMongo.allowed, `step ${step} on ${key}`).toBe(fromMemory.allowed);
      expect(fromMongo.remaining, `step ${step} on ${key}`).toBe(fromMemory.remaining);
      expect(fromMongo.nextAllowedAt.toISOString(), `step ${step} on ${key}`).toBe(
        fromMemory.nextAllowedAt.toISOString(),
      );

      if (!fromMongo.allowed) rejections += 1;
    }

    // Guard against a vacuous pass: the sequence must actually exercise both
    // admission and rejection.
    expect(rejections).toBeGreaterThan(20);
    expect(rejections).toBeLessThan(280);
  });

  it('keeps one bucket document per key, as a readable date, with a TTL', async () => {
    const limiter = new MongoGcraLimiter(cols, CFG);
    await limiter.consume('key_shape', T0);
    await limiter.consume('key_shape', at(50));
    await limiter.consume('key_shape', at(120_000));

    // A fixed-window counter would have left one document per key per window.
    expect(await cols.rateLimitBuckets.countDocuments({ _id: 'key_shape' })).toBe(1);

    const bucket = await cols.rateLimitBuckets.findOne({ _id: 'key_shape' });
    expect(bucket?.tat).toBeInstanceOf(Date);
    expect(bucket?.expires_at.getTime()).toBeGreaterThan(bucket!.tat.getTime());
    // The pipeline's working field must not survive into the stored document —
    // the collection validator forbids unknown properties, so a leak would
    // have thrown, but assert it directly too.
    expect(Object.keys(bucket!).sort()).toEqual(['_id', 'allowed', 'expires_at', 'tat']);
  });
});
