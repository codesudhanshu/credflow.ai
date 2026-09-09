import { Router, type Response } from 'express';
import type { Db } from 'mongodb';
import { collections } from '../../db/collections.js';
import { ApiKeysRepo } from '../../repositories/apiKeys.repo.js';
import { DeploymentsRepo } from '../../repositories/deployments.repo.js';
import { UsageEventsRepo } from '../../repositories/usageEvents.repo.js';
import { CompletionsService } from '../../services/completions.service.js';
import type { RateLimitDecision, RateLimiter } from '../../ratelimit/limiter.js';
import type { AppDeps } from '../deps.js';
import { singleHeader } from '../headers.js';
import { CompletionParams, parseBearer } from '../schemas/completions.schema.js';

function setRateLimitHeaders(res: Response, decision: RateLimitDecision): void {
  res.setHeader('x-ratelimit-limit', String(decision.limit));
  res.setHeader('x-ratelimit-remaining', String(decision.remaining));
  // With a leaky bucket there is no window to wait out — the useful value is
  // when the next slot drains, which for an unthrottled caller is now.
  res.setHeader(
    'x-ratelimit-reset',
    String(Math.floor(decision.nextAllowedAt.getTime() / 1_000)),
  );
}

export function createCompletionRoutes(
  deps: AppDeps,
  db: Db,
  rateLimiter: RateLimiter,
): Router {
  const { env, clock, rng } = deps;
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

  const router = Router();

  router.post('/:deployment_id/completions', async (req, res) => {
    const { deployment_id } = CompletionParams.parse(req.params);

    const result = await service.complete({
      deploymentId: deployment_id,
      bearerToken: parseBearer(singleHeader(req.headers.authorization)),
      body: req.body,
      idempotencyKey: singleHeader(req.headers['idempotency-key']) ?? null,
    });

    setRateLimitHeaders(res, result.rateLimit);
    res.json(result.body);
  });

  return router;
}
