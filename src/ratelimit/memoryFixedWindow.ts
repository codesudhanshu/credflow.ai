import {
  windowIndex,
  windowResetAt,
  type RateLimitDecision,
  type RateLimiter,
} from './limiter.js';

/**
 * Single-process limiter. Correct only when one instance is running, so it is
 * opt-in via RATE_LIMIT_STORE=memory and exists mainly to show the interface is
 * real and to keep limiter unit tests free of a database.
 */
export class MemoryFixedWindowLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit: number) {}

  async consume(key: string, now: Date): Promise<RateLimitDecision> {
    const current = windowIndex(now);
    const bucket = `${key}:${current}`;
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);

    // Drop everything from earlier windows; the map never grows unbounded.
    for (const existing of this.counts.keys()) {
      const index = Number(existing.slice(existing.lastIndexOf(':') + 1));
      if (index < current) this.counts.delete(existing);
    }

    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt: windowResetAt(now),
    };
  }
}
