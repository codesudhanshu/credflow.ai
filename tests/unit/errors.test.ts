import { describe, expect, it } from 'vitest';
import {
  AppError,
  deploymentNotReady,
  invalidApiKey,
  keyDeploymentMismatch,
  notFound,
  rateLimitExceeded,
  validationFailed,
} from '../../src/domain/errors.js';

describe('error taxonomy', () => {
  it('maps each code to the status code the spec requires', () => {
    expect(invalidApiKey().statusCode).toBe(401);
    expect(keyDeploymentMismatch('dep_1').statusCode).toBe(403);
    expect(deploymentNotReady('dep_1', 'provisioning').statusCode).toBe(409);
    expect(rateLimitExceeded(100, 30, 1_800_000_000).statusCode).toBe(429);
    expect(validationFailed('bad').statusCode).toBe(400);
    expect(notFound('Deployment dep_1').statusCode).toBe(404);
  });

  it('carries rate-limit headers on the 429', () => {
    const err = rateLimitExceeded(100, 30, 1_800_000_000);
    expect(err.headers['retry-after']).toBe('30');
    expect(err.headers['x-ratelimit-limit']).toBe('100');
    expect(err.headers['x-ratelimit-remaining']).toBe('0');
    expect(err.headers['x-ratelimit-reset']).toBe('1800000000');
  });

  it('names the deployment and its effective state in the 409 message', () => {
    const err = deploymentNotReady('dep_abc', 'terminated');
    expect(err.message).toContain('dep_abc');
    expect(err.message).toContain('terminated');
  });

  it('is a real Error subclass so instanceof works in the error handler', () => {
    expect(invalidApiKey()).toBeInstanceOf(Error);
    expect(invalidApiKey()).toBeInstanceOf(AppError);
  });
});
