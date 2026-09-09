import { deploymentNotReady } from './errors.js';
import type { DeploymentDoc, DeploymentStatus } from '../db/types.js';

/**
 * The single rule that turns stored state plus a deadline into the state a
 * caller should observe. Pure, so the ten-second provisioning window is
 * testable without waiting ten seconds.
 *
 * `terminated` is absorbing: a deployment deleted during provisioning must
 * never later appear as ready, no matter how much time passes.
 */
export function deriveStatus(
  stored: DeploymentStatus,
  readyAt: Date | null,
  now: Date,
): DeploymentStatus {
  if (stored !== 'provisioning') return stored;
  if (readyAt === null) return 'provisioning';
  return now.getTime() >= readyAt.getTime() ? 'ready' : 'provisioning';
}

/** Whether a stored document needs its status written forward. */
export function isDueForPromotion(
  deployment: Pick<DeploymentDoc, 'status' | 'ready_at'>,
  now: Date,
): boolean {
  return (
    deployment.status === 'provisioning' &&
    deployment.ready_at !== null &&
    now.getTime() >= deployment.ready_at.getTime()
  );
}

export function buildEndpointUrl(baseUrl: string, deploymentId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/${deploymentId}`;
}

/** Throws a 409 unless the deployment may serve traffic right now. */
export function assertServable(
  deployment: Pick<DeploymentDoc, '_id' | 'status' | 'ready_at'>,
  now: Date,
): void {
  const effective = deriveStatus(deployment.status, deployment.ready_at, now);
  if (effective !== 'ready') {
    throw deploymentNotReady(deployment._id, effective);
  }
}
