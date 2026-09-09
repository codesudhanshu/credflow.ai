import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { collections } from '../../db/collections.js';
import { ApiKeysRepo } from '../../repositories/apiKeys.repo.js';
import { DeploymentsRepo } from '../../repositories/deployments.repo.js';
import { UsageEventsRepo } from '../../repositories/usageEvents.repo.js';
import { CompletionsService } from '../../services/completions.service.js';
import type { RateLimitDecision } from '../../ratelimit/limiter.js';
import { CompletionParams, parseBearer } from '../schemas/completions.schema.js';

function setRateLimitHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  void reply.header('x-ratelimit-limit', String(decision.limit));
  void reply.header('x-ratelimit-remaining', String(decision.remaining));
  // With a leaky bucket there is no window to wait out — the useful value is
  // when the next slot drains, which for an unthrottled caller is now.
  void reply.header(
    'x-ratelimit-reset',
    String(Math.floor(decision.nextAllowedAt.getTime() / 1_000)),
  );
}

export const completionRoutes: FastifyPluginAsync = async (app) => {
  const { env, clock, rng, db, rateLimiter } = app.deps;
  if (!db || !rateLimiter) {
    throw new Error('completionRoutes requires a database and a rate limiter');
  }

  const cols = collections(db);
  const service = new CompletionsService(
    new ApiKeysRepo(cols),
    new DeploymentsRepo(cols),
    new UsageEventsRepo(cols),
    rateLimiter,
    clock,
    rng,
    env,
  );

  app.post('/:deployment_id/completions', async (req, reply) => {
    const { deployment_id } = CompletionParams.parse(req.params);
    const idempotencyKey = req.headers['idempotency-key'];

    const result = await service.complete({
      deploymentId: deployment_id,
      bearerToken: parseBearer(req.headers.authorization),
      body: req.body,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
    });

    setRateLimitHeaders(reply, result.rateLimit);
    return result.body;
  });
};
