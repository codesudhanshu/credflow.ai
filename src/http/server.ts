import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppDeps } from './deps.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { createDeploymentRoutes } from './routes/deployments.routes.js';
import { createCompletionRoutes } from './routes/completions.routes.js';
import { createUsageRoutes } from './routes/usage.routes.js';

export type { AppDeps };

/**
 * Builds the app without listening, so tests drive real HTTP through supertest
 * without binding a port. `listen()` belongs to the entrypoint alone.
 *
 * Middleware order matters and is deliberate: the correlation id is assigned
 * before anything can log or fail, the body parser runs before any route reads
 * `req.body`, the not-found handler sits after every route, and the error
 * handler is registered last because Express identifies it by arity.
 */
export function buildServer(deps: AppDeps): Express {
  const app = express();

  // Nothing gains from advertising the framework.
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      // Reuse the id already assigned above rather than letting pino mint a
      // second, different one.
      genReqId: (req) => (req as unknown as { requestId: string }).requestId,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (deps.db) {
    app.use('/deployments', createDeploymentRoutes(deps, deps.db));
    app.use('/usage', createUsageRoutes(deps, deps.db));
  }
  if (deps.db && deps.rateLimiter) {
    app.use('/v1', createCompletionRoutes(deps, deps.db, deps.rateLimiter));
  }

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));

  return app;
}
