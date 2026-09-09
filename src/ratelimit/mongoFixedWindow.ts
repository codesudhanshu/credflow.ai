import type { Collections } from '../db/collections.js';
import {
  windowIndex,
  windowResetAt,
  WINDOW_MS,
  type RateLimitDecision,
  type RateLimiter,
} from './limiter.js';

/**
 * Fixed-window counter kept in MongoDB. One round trip per request, correct
 * across processes, and old buckets are removed by a TTL index rather than a
 * cleanup job. An in-process Map would be faster but would make the limit
 * per-instance rather than per-key, which would contradict the multi-instance
 * guarantee the rest of the service provides.
 *
 * Known limitation: a fixed window allows up to 2x the limit across a window
 * boundary. A sliding window or token bucket is the production answer.
 */
export class MongoFixedWindowLimiter implements RateLimiter {
  constructor(
    private readonly cols: Collections,
    private readonly limit: number,
  ) {}

  async consume(key: string, now: Date): Promise<RateLimitDecision> {
    const resetAt = windowResetAt(now);
    const doc = await this.cols.rateLimitBuckets.findOneAndUpdate(
      { _id: `${key}:${windowIndex(now)}` },
      {
        $inc: { count: 1 },
        // One extra window of grace so the TTL sweep never races a live bucket.
        $setOnInsert: { expires_at: new Date(resetAt.getTime() + WINDOW_MS) },
      },
      { upsert: true, returnDocument: 'after' },
    );

    const count = doc?.count ?? 1;
    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt,
    };
  }
}
