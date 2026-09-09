export const WINDOW_MS = 60_000;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Start of the next window — when the caller's budget refills. */
  resetAt: Date;
}

export interface RateLimiter {
  /** Counts one request against `key` and reports whether it may proceed. */
  consume(key: string, now: Date): Promise<RateLimitDecision>;
}

export function windowIndex(now: Date): number {
  return Math.floor(now.getTime() / WINDOW_MS);
}

export function windowResetAt(now: Date): Date {
  return new Date((windowIndex(now) + 1) * WINDOW_MS);
}
