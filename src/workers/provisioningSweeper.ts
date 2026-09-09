import type { Env } from '../config/env.js';
import type { Clock } from '../clock.js';
import { buildEndpointUrl } from '../domain/deployment.js';
import type { DeploymentsRepo } from '../repositories/deployments.repo.js';

interface SweeperLogger {
  error(obj: object, msg: string): void;
}

/**
 * Writes due provisioning deadlines forward. Because the promotion is a
 * conditional update, running several sweepers concurrently is safe: only one
 * update matches per deployment, and a deployment terminated in the meantime is
 * skipped entirely.
 */
export class ProvisioningSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deployments: DeploymentsRepo,
    private readonly clock: Clock,
    private readonly env: Env,
    private readonly logger: SweeperLogger,
  ) {}

  /** Returns how many deployments this pass actually promoted. */
  async runOnce(batchSize = 200): Promise<number> {
    const now = this.clock.now();
    const due = await this.deployments.findDueForPromotion(now, batchSize);

    let promoted = 0;
    for (const deployment of due) {
      const url = buildEndpointUrl(this.env.PUBLIC_BASE_URL, deployment._id);
      const result = await this.deployments.promoteIfDue(deployment._id, now, url);
      if (result) promoted += 1;
    }
    return promoted;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.logger.error({ err }, 'provisioning sweeper pass failed');
      });
    }, this.env.SWEEPER_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
