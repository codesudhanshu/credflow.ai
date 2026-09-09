export type ErrorCode =
  | 'validation_failed'
  | 'invalid_api_key'
  | 'key_deployment_mismatch'
  | 'not_found'
  | 'deployment_not_ready'
  | 'rate_limit_exceeded'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  invalid_api_key: 401,
  key_deployment_mismatch: 403,
  not_found: 404,
  deployment_not_ready: 409,
  rate_limit_exceeded: 429,
  internal_error: 500,
};

/**
 * Every expected failure in the system is an AppError. `code` is the stable
 * contract; `message` is for humans and may change freely.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.headers = headers;
  }
}

export function validationFailed(message: string): AppError {
  return new AppError('validation_failed', message);
}

export function invalidApiKey(message = 'API key is missing or invalid.'): AppError {
  return new AppError('invalid_api_key', message);
}

export function keyDeploymentMismatch(deploymentId: string): AppError {
  return new AppError(
    'key_deployment_mismatch',
    `This API key is not authorized for deployment ${deploymentId}.`,
  );
}

export function notFound(what: string): AppError {
  return new AppError('not_found', `${what} not found.`);
}

export function deploymentNotReady(deploymentId: string, effectiveStatus: string): AppError {
  return new AppError(
    'deployment_not_ready',
    `Deployment ${deploymentId} is ${effectiveStatus}; it must be ready to serve requests.`,
  );
}

export function rateLimitExceeded(
  limit: number,
  retryAfterSeconds: number,
  resetAtEpochSeconds: number,
): AppError {
  return new AppError(
    'rate_limit_exceeded',
    `Rate limit of ${limit} requests per minute exceeded.`,
    {
      'retry-after': String(retryAfterSeconds),
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetAtEpochSeconds),
    },
  );
}
