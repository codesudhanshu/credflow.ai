import { createHash } from 'node:crypto';

/**
 * API keys are looked up by hash on a unique index. There is deliberately no
 * timing-safe comparison here: the match happens inside the database as an
 * exact index lookup, and no application branch depends on the secret's bytes,
 * so there is no secret-dependent timing channel in our code to close.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
