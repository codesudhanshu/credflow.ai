import type { Env } from '../config/env.js';
import type { Clock } from '../clock.js';
import type { ApiKeyDoc, DeploymentDoc, ModelName } from '../db/types.js';
import { buildEndpointUrl, isDueForPromotion } from '../domain/deployment.js';
import { notFound } from '../domain/errors.js';
import { keyPrefix, newApiKeySecret, newId } from '../ids.js';
import { sha256Hex } from '../crypto.js';
import type { ApiKeysRepo } from '../repositories/apiKeys.repo.js';
import type { DeploymentsRepo } from '../repositories/deployments.repo.js';

export class DeploymentsService {
  constructor(
    private readonly deployments: DeploymentsRepo,
    private readonly apiKeys: ApiKeysRepo,
    private readonly clock: Clock,
    private readonly env: Env,
  ) {}

  /**
   * Creates the deployment and its key in one call. The provisioning deadline
   * is persisted rather than scheduled, so a restart cannot lose it.
   */
  async create(tenantId: string, model: ModelName): Promise<DeploymentDoc> {
    const now = this.clock.now();
    const deploymentId = newId('dep');

    const deployment = await this.deployments.insert({
      _id: deploymentId,
      tenant_id: tenantId,
      model,
      status: 'provisioning',
      ready_at: new Date(now.getTime() + this.env.PROVISIONING_MS),
      endpoint_url: null,
      created_at: now,
      updated_at: now,
      terminated_at: null,
    });

    const secret = newApiKeySecret();
    await this.apiKeys.insert({
      _id: newId('key'),
      deployment_id: deploymentId,
      tenant_id: tenantId,
      key_hash: sha256Hex(secret),
      key_prefix: keyPrefix(secret),
      secret,
      revoked_at: null,
      created_at: now,
    });

    return deployment;
  }

  /**
   * Reads a deployment, first writing its status forward if the provisioning
   * deadline has passed. This read-time promotion is the safety net that keeps
   * observable state correct even if the sweeper is not running.
   */
  async get(id: string): Promise<{ deployment: DeploymentDoc; apiKey: ApiKeyDoc | null }> {
    const now = this.clock.now();
    const stored = await this.deployments.findById(id);
    if (!stored) throw notFound(`Deployment ${id}`);

    let deployment = stored;
    if (isDueForPromotion(stored, now)) {
      const promoted = await this.deployments.promoteIfDue(
        id,
        now,
        buildEndpointUrl(this.env.PUBLIC_BASE_URL, id),
      );
      // A null result means someone else changed the row first — a concurrent
      // DELETE, most likely — so re-read rather than assume.
      deployment = promoted ?? (await this.deployments.findById(id)) ?? stored;
    }

    const apiKey =
      deployment.status === 'ready' ? await this.apiKeys.findByDeploymentId(id) : null;
    return { deployment, apiKey };
  }

  /** Idempotent: terminating an already-terminated deployment is not an error. */
  async terminate(id: string): Promise<DeploymentDoc> {
    const now = this.clock.now();
    const updated = await this.deployments.terminate(id, now);
    if (updated) return updated;

    const existing = await this.deployments.findById(id);
    if (!existing) throw notFound(`Deployment ${id}`);
    return existing;
  }
}
