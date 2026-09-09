import { z } from 'zod';
import type { ApiKeyDoc, DeploymentDoc } from '../../db/types.js';

export const CreateDeploymentBody = z.object({
  model: z.enum(['model-a', 'model-b']),
});

export const DeploymentIdParams = z.object({
  id: z.string().min(1),
});

/**
 * endpoint_url and api_key exist only in the ready state — a provisioning or
 * terminated deployment must not leak a usable credential.
 */
export function serializeDeployment(
  deployment: DeploymentDoc,
  apiKey: ApiKeyDoc | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    deployment_id: deployment._id,
    model: deployment.model,
    status: deployment.status,
    created_at: deployment.created_at.toISOString(),
    terminated_at: deployment.terminated_at?.toISOString() ?? null,
  };

  if (deployment.status !== 'ready') return base;

  return {
    ...base,
    endpoint_url: deployment.endpoint_url,
    api_key: apiKey?.secret ?? null,
  };
}
