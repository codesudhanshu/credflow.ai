import type { Document } from 'mongodb';
import type { Collections } from '../db/collections.js';
import {
  bucketTtlMs,
  decisionFrom,
  type GcraConfig,
  type RateLimitDecision,
  type RateLimiter,
} from './limiter.js';

/**
 * Leaky bucket (GCRA) with the bucket held in MongoDB — one document per API
 * key, keyed by the key's id.
 *
 * The whole read-decide-write cycle is a single `findOneAndUpdate` using an
 * aggregation pipeline, so it is atomic without a transaction and without an
 * optimistic-retry loop: concurrent requests for the same key are serialized
 * by the document write, and none of them can observe a stale bucket. The
 * alternative — read, compute in application code, then compare-and-set —
 * would cost a second round trip and would retry hardest exactly when a
 * caller is hammering one key, which is the case that matters.
 *
 * The pipeline restates the rule from `admit()` in MQL. A differential test
 * drives this backend and the in-memory one through the same request sequence
 * and asserts identical decisions, so the two cannot silently diverge.
 *
 * One document per key, expired by a TTL index once the bucket has drained —
 * unlike a fixed-window counter, which needs one document per key per window.
 */
export class MongoGcraLimiter implements RateLimiter {
  constructor(
    private readonly cols: Collections,
    private readonly cfg: GcraConfig,
  ) {}

  async consume(key: string, now: Date): Promise<RateLimitDecision> {
    const doc = await this.cols.rateLimitBuckets.findOneAndUpdate(
      { _id: key },
      this.pipeline(now),
      { upsert: true, returnDocument: 'after' },
    );

    if (!doc) {
      // findOneAndUpdate with upsert and returnDocument 'after' always yields a
      // document; this guards the type rather than a reachable state.
      throw new Error(`rate limit bucket ${key} vanished during update`);
    }

    return decisionFrom(doc.tat.getTime(), now.getTime(), doc.allowed, this.cfg);
  }

  /**
   * `$add` and `$subtract` treat a number alongside a date as milliseconds, so
   * the bucket state stays a readable BSON date throughout.
   */
  private pipeline(now: Date): Document[] {
    const { emissionMs, burstMs } = this.cfg;
    return [
      {
        // An idle bucket has fully drained: tat never lags behind the present.
        $set: { _tatEff: { $max: [{ $ifNull: ['$tat', now] }, now] } },
      },
      {
        // Admit while tat has not run further ahead than the burst allowance.
        $set: { allowed: { $lte: [{ $subtract: ['$_tatEff', burstMs] }, now] } },
      },
      {
        // A rejected request must leave the bucket untouched, or a client
        // hammering a full bucket would extend its own lockout.
        $set: {
          tat: {
            $cond: [
              '$allowed',
              { $add: ['$_tatEff', emissionMs] },
              { $ifNull: ['$tat', now] },
            ],
          },
        },
      },
      { $set: { expires_at: { $add: ['$tat', bucketTtlMs(this.cfg)] } } },
      { $unset: '_tatEff' },
    ];
  }
}
