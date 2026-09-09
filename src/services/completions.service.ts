import type { Env } from '../config/env.js';
import type { Clock } from '../clock.js';
import type { Rng } from '../random.js';
import { sha256Hex } from '../crypto.js';
import { newId } from '../ids.js';
import { assertServable, buildEndpointUrl, isDueForPromotion } from '../domain/deployment.js';
import { invalidApiKey, keyDeploymentMismatch, rateLimitExceeded } from '../domain/errors.js';
import { computeCostMicroUsd } from '../domain/pricing.js';
import { countInputTokens, sampleOutputTokens } from '../domain/tokens.js';
import type { ApiKeysRepo } from '../repositories/apiKeys.repo.js';
import type { DeploymentsRepo } from '../repositories/deployments.repo.js';
import type { UsageEventsRepo } from '../repositories/usageEvents.repo.js';
import type { RateLimitDecision, RateLimiter } from '../ratelimit/limiter.js';
import { CompletionBody } from '../http/schemas/completions.schema.js';

export interface CompletionRequest {
  deploymentId: string;
  bearerToken: string | null;
  body: unknown;
  idempotencyKey: string | null;
}

export interface CompletionResult {
  body: { output: string; input_tokens: number; output_tokens: number };
  rateLimit: RateLimitDecision;
}

export class CompletionsService {
  constructor(
    private readonly apiKeys: ApiKeysRepo,
    private readonly deployments: DeploymentsRepo,
    private readonly usage: UsageEventsRepo,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly rng: Rng,
    private readonly env: Env,
  ) {}

  /**
   * The order of these checks is deliberate; see the design doc, section 6.
   * Authentication, then rate limit, then authorization, then resource state.
   * Authorization precedes state so that a caller holding the wrong key learns
   * nothing about whether the deployment exists or what state it is in.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const now = this.clock.now();

    // 1-2. Authenticate.
    if (!req.bearerToken) throw invalidApiKey();
    const key = await this.apiKeys.findByHash(sha256Hex(req.bearerToken));
    if (!key) throw invalidApiKey();

    // 3. Rate limit. The limit belongs to an identity, not to a resource, so it
    //    is charged before we look at which deployment was addressed.
    const decision = await this.limiter.consume(key._id, now);
    if (!decision.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((decision.nextAllowedAt.getTime() - now.getTime()) / 1_000),
      );
      throw rateLimitExceeded(
        decision.ratePerMinute,
        decision.limit,
        retryAfter,
        Math.floor(decision.nextAllowedAt.getTime() / 1_000),
      );
    }

    // 4. Authorize. A key is bound to exactly one deployment, so this single
    //    comparison also covers a deployment id that does not exist — which is
    //    why an unknown id is a 403 here and not a 404.
    if (key.deployment_id !== req.deploymentId) {
      throw keyDeploymentMismatch(req.deploymentId);
    }

    // 5. Resource state, promoting first if the deadline has passed.
    const stored = await this.deployments.findById(req.deploymentId);
    if (!stored) throw keyDeploymentMismatch(req.deploymentId);

    let deployment = stored;
    if (isDueForPromotion(stored, now)) {
      deployment =
        (await this.deployments.promoteIfDue(
          stored._id,
          now,
          buildEndpointUrl(this.env.PUBLIC_BASE_URL, stored._id),
        )) ?? stored;
    }
    assertServable(deployment, now);

    // 6. Only now validate the payload — the caller is known and permitted.
    const { prompt } = CompletionBody.parse(req.body);

    // 7. Mocked inference.
    const inputTokens = countInputTokens(prompt);
    const outputTokens = sampleOutputTokens(this.rng);

    // 8. Meter before answering. A request that cannot be recorded is not
    //    answered either, so recorded usage always matches served requests.
    const { event } = await this.usage.record({
      _id: newId('evt'),
      tenant_id: key.tenant_id,
      deployment_id: deployment._id,
      api_key_id: key._id,
      model: deployment.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_micro_usd: computeCostMicroUsd(inputTokens, outputTokens),
      occurred_at: now,
      request_id: req.idempotencyKey ?? newId('req'),
    });

    // The stored event is the source of truth, so a retried request replays
    // the original numbers rather than freshly sampled ones.
    return {
      body: {
        output: 'mocked response',
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
      },
      rateLimit: decision,
    };
  }
}
