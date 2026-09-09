import type { Env } from '../config/env.js';
import type { Collections } from '../db/collections.js';
import { gcraConfig, type GcraConfig, type RateLimiter } from './limiter.js';
import { MemoryGcraLimiter } from './memoryGcra.js';
import { MongoGcraLimiter } from './mongoGcra.js';

/**
 * Burst defaults to the per-minute rate, which reproduces the spec's "max 100
 * requests per minute" as "100 may arrive at once, then one slot drains every
 * 600ms". Lowering RATE_LIMIT_BURST tightens smoothing without changing the
 * sustained rate.
 */
export function rateLimitConfig(env: Env): GcraConfig {
  return gcraConfig({
    ratePerMinute: env.RATE_LIMIT_PER_MINUTE,
    burst: env.RATE_LIMIT_BURST ?? env.RATE_LIMIT_PER_MINUTE,
  });
}

export function createRateLimiter(env: Env, cols: Collections): RateLimiter {
  const cfg = rateLimitConfig(env);
  return env.RATE_LIMIT_STORE === 'memory'
    ? new MemoryGcraLimiter(cfg)
    : new MongoGcraLimiter(cols, cfg);
}
