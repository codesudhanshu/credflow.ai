export type ModelName = 'model-a' | 'model-b';
export const MODEL_NAMES: readonly ModelName[] = ['model-a', 'model-b'];

export type DeploymentStatus = 'provisioning' | 'ready' | 'terminated';

export interface TenantDoc {
  _id: string;
  name: string;
  account_key_hash: string;
  created_at: Date;
}

export interface DeploymentDoc {
  _id: string;
  tenant_id: string;
  model: ModelName;
  status: DeploymentStatus;
  /** Provisioning deadline. Null once the deployment reaches a terminal state. */
  ready_at: Date | null;
  endpoint_url: string | null;
  created_at: Date;
  updated_at: Date;
  terminated_at: Date | null;
}

export interface ApiKeyDoc {
  _id: string;
  deployment_id: string;
  tenant_id: string;
  /** sha256 of the secret — the field auth looks up. */
  key_hash: string;
  key_prefix: string;
  /**
   * Plaintext secret. Present only because the spec requires
   * GET /deployments/:id to return the api_key on every call; a production
   * system stores the hash alone and reveals the secret exactly once.
   */
  secret: string;
  revoked_at: Date | null;
  created_at: Date;
}

/** Immutable billing record. Never updated, never deleted. */
export interface UsageEventDoc {
  _id: string;
  tenant_id: string;
  deployment_id: string;
  api_key_id: string;
  /** Snapshot of the model at request time, not a join. */
  model: ModelName;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  occurred_at: Date;
  request_id: string;
}

export interface RateLimitBucketDoc {
  /** `<api_key_id>:<epoch_minute>` */
  _id: string;
  count: number;
  expires_at: Date;
}
