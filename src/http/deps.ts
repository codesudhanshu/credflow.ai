import type { Db } from 'mongodb';
import type { Env } from '../config/env.js';
import type { Clock } from '../clock.js';
import type { Rng } from '../random.js';
import type { Logger } from '../logger.js';
import type { RateLimiter } from '../ratelimit/limiter.js';

/**
 * Everything the HTTP layer needs, passed in rather than imported, so tests can
 * substitute a fake clock, a seeded RNG, and an ephemeral database.
 *
 * `db` and `rateLimiter` are optional so the transport layer can be exercised
 * without them; each route factory takes what it requires as a non-optional
 * argument, so a route can never be mounted with a missing dependency.
 *
 * Lives in its own module rather than in server.ts because the route factories
 * import it and server.ts imports them.
 */
export interface AppDeps {
  env: Env;
  clock: Clock;
  rng: Rng;
  logger: Logger;
  db?: Db;
  rateLimiter?: RateLimiter;
}
