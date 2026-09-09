import type { Collections } from '../db/collections.js';
import type { ApiKeyDoc } from '../db/types.js';

export class ApiKeysRepo {
  constructor(private readonly cols: Collections) {}

  async insert(doc: ApiKeyDoc): Promise<ApiKeyDoc> {
    await this.cols.apiKeys.insertOne(doc);
    return doc;
  }

  /** Authentication: one exact lookup on a unique index. */
  async findByHash(keyHash: string): Promise<ApiKeyDoc | null> {
    return this.cols.apiKeys.findOne({ key_hash: keyHash, revoked_at: null });
  }

  async findByDeploymentId(deploymentId: string): Promise<ApiKeyDoc | null> {
    return this.cols.apiKeys.findOne({ deployment_id: deploymentId, revoked_at: null });
  }
}
