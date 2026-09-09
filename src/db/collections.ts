import type { Collection, Db } from 'mongodb';
import type {
  ApiKeyDoc,
  DeploymentDoc,
  RateLimitBucketDoc,
  TenantDoc,
  UsageEventDoc,
} from './types.js';

export interface Collections {
  tenants: Collection<TenantDoc>;
  deployments: Collection<DeploymentDoc>;
  apiKeys: Collection<ApiKeyDoc>;
  usageEvents: Collection<UsageEventDoc>;
  rateLimitBuckets: Collection<RateLimitBucketDoc>;
}

/** Single place that maps a typed handle onto a physical collection name. */
export function collections(db: Db): Collections {
  return {
    tenants: db.collection<TenantDoc>('tenants'),
    deployments: db.collection<DeploymentDoc>('deployments'),
    apiKeys: db.collection<ApiKeyDoc>('api_keys'),
    usageEvents: db.collection<UsageEventDoc>('usage_events'),
    rateLimitBuckets: db.collection<RateLimitBucketDoc>('rate_limit_buckets'),
  };
}
