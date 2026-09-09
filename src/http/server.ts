import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import type { Env } from '../config/env.js';
import type { Clock } from '../clock.js';
import type { Rng } from '../random.js';
import type { RateLimiter } from '../ratelimit/limiter.js';
import { newId } from '../ids.js';
import { registerErrorHandler } from './errorHandler.js';
import { deploymentRoutes } from './routes/deployments.routes.js';
import { completionRoutes } from './routes/completions.routes.js';

/**
 * Everything the HTTP layer needs, passed in rather than imported, so tests
 * can substitute a fake clock, a seeded RNG, and an ephemeral database.
 * `db` and `rateLimiter` are optional only so the skeleton can be exercised
 * without them; route plugins that need them assert their presence.
 */
export interface AppDeps {
  env: Env;
  clock: Clock;
  rng: Rng;
  db?: Db;
  rateLimiter?: RateLimiter;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.env.LOG_LEVEL },
    genReqId: (req) => {
      const supplied = req.headers['x-request-id'];
      return typeof supplied === 'string' && supplied.length > 0 ? supplied : newId('req', 12);
    },
  });

  app.decorate('deps', deps);

  app.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', String(req.id));
  });

  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  // Route plugins need a database; the skeleton is usable without one so the
  // transport-level behaviour can be tested in isolation.
  if (deps.db) {
    await app.register(deploymentRoutes, { prefix: '/deployments' });
  }
  if (deps.db && deps.rateLimiter) {
    await app.register(completionRoutes, { prefix: '/v1' });
  }

  return app;
}
