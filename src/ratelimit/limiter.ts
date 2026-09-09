export const MINUTE_MS = 60_000;

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket capacity — the most requests admissible back-to-back. */
  limit: number;
  /** Sustained rate. Equal to `limit` unless the burst was tuned separately. */
  ratePerMinute: number;
  /** How many more requests would be admitted at this same instant. */
  remaining: number;
  /** Earliest instant at which the next request would be admitted. */
  nextAllowedAt: Date;
}

export interface RateLimiter {
  /** Charges one request against `key` and reports whether it may proceed. */
  consume(key: string, now: Date): Promise<RateLimitDecision>;
}

/**
 * Leaky bucket, metering form — the Generic Cell Rate Algorithm.
 *
 * The bucket's fill level is represented by a single instant, the theoretical
 * arrival time (`tat`): the moment at which the bucket would next be empty if
 * no further requests arrived. Each admitted request pushes `tat` forward by
 * one emission interval; the bucket drains simply by real time passing, so no
 * timer or sweep is needed.
 *
 * A request is admitted while `tat` has not run further ahead than the burst
 * tolerance permits. In metering form an overflowing request is rejected
 * (429) rather than queued — the queueing form of a leaky bucket would delay
 * the request instead, which the spec's "return 429 when exceeded" rules out.
 *
 * Equivalent to a token bucket in which requests are admitted; the difference
 * is that the state is one timestamp rather than a token count plus a refill
 * timestamp, which is what lets a backend update it atomically in place.
 */
export interface GcraConfig {
  /** Time that must elapse between requests at the sustained rate. */
  emissionMs: number;
  /** How far ahead of now `tat` may run — the burst allowance, in ms. */
  burstMs: number;
  /** Bucket capacity, reported to callers as the limit. */
  limit: number;
  /** Kept for reporting: the burst capacity alone does not describe the policy. */
  ratePerMinute: number;
}

export interface GcraParams {
  /** Sustained rate, requests per minute. */
  ratePerMinute: number;
  /** Bucket capacity: how many requests may arrive back-to-back. */
  burst: number;
}

/**
 * `burst = 1` yields zero tolerance — strict smoothing at one request per
 * emission interval. `burst = ratePerMinute` reproduces "100 per minute, and
 * all 100 may arrive at once", which is what this service is configured for.
 *
 * `emissionMs` is rounded to whole milliseconds because backends store `tat`
 * as a BSON date. It is exact for rates that divide 60,000 (the default 100
 * gives 600ms); other rates drift by well under a millisecond per request.
 */
export function gcraConfig({ ratePerMinute, burst }: GcraParams): GcraConfig {
  const emissionMs = Math.round(MINUTE_MS / ratePerMinute);
  return { emissionMs, burstMs: (burst - 1) * emissionMs, limit: burst, ratePerMinute };
}

/**
 * The admission rule, as a pure function. Both backends implement exactly this
 * — the in-memory one by calling it, the MongoDB one by expressing it as an
 * aggregation pipeline so the read and write are a single atomic operation.
 * A differential test drives both through the same sequence to prove they
 * cannot disagree.
 */
export function admit(
  tatBefore: number | null,
  now: number,
  cfg: GcraConfig,
): { allowed: boolean; tat: number } {
  // An idle bucket has fully drained: `tat` never lags behind the present.
  const tatEff = Math.max(tatBefore ?? now, now);
  const allowed = tatEff - cfg.burstMs <= now;
  return { allowed, tat: allowed ? tatEff + cfg.emissionMs : (tatBefore ?? now) };
}

/** Derives the caller-facing decision from the post-update bucket state. */
export function decisionFrom(
  tat: number,
  now: number,
  allowed: boolean,
  cfg: GcraConfig,
): RateLimitDecision {
  return {
    allowed,
    limit: cfg.limit,
    ratePerMinute: cfg.ratePerMinute,
    remaining: Math.max(0, Math.floor((now + cfg.burstMs - tat) / cfg.emissionMs) + 1),
    nextAllowedAt: new Date(Math.max(now, tat - cfg.burstMs)),
  };
}

/**
 * How long a drained bucket is kept before the TTL index removes it. One
 * minute of slack past the point where `tat` falls behind the present, so the
 * sweep never races a bucket that is still holding back a caller.
 */
export function bucketTtlMs(cfg: GcraConfig): number {
  return cfg.burstMs + MINUTE_MS;
}
