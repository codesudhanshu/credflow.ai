import {
  admit,
  decisionFrom,
  type GcraConfig,
  type RateLimitDecision,
  type RateLimiter,
} from './limiter.js';

/**
 * Leaky bucket (GCRA) held in process memory. Correct only for a single
 * instance, so it is opt-in via RATE_LIMIT_STORE=memory; it exists to keep the
 * `RateLimiter` seam honest and to give the limiter tests a backend that needs
 * no database.
 *
 * Unlike the MongoDB backend, this one calls the shared `admit()` rule
 * directly.
 */
export class MemoryGcraLimiter implements RateLimiter {
  /** api key id -> theoretical arrival time, in epoch milliseconds. */
  private readonly tats = new Map<string, number>();

  constructor(private readonly cfg: GcraConfig) {}

  async consume(key: string, now: Date): Promise<RateLimitDecision> {
    const nowMs = now.getTime();
    const { allowed, tat } = admit(this.tats.get(key) ?? null, nowMs, this.cfg);
    this.tats.set(key, tat);
    this.dropDrainedBuckets(nowMs);
    return decisionFrom(tat, nowMs, allowed, this.cfg);
  }

  /** A bucket whose tat has fallen behind the present holds no state worth keeping. */
  private dropDrainedBuckets(nowMs: number): void {
    for (const [key, tat] of this.tats) {
      if (tat <= nowMs) this.tats.delete(key);
    }
  }
}
