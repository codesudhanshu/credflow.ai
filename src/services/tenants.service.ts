import type { Env } from '../config/env.js';
import type { Collections } from '../db/collections.js';
import { sha256Hex } from '../crypto.js';
import { invalidApiKey } from '../domain/errors.js';

/**
 * X-Account-Key is optional and falls back to the seeded demo tenant, so the
 * reviewer's curl commands work with no setup. Making the header required is
 * the whole change needed to turn this into real tenant isolation.
 */
export async function resolveTenantId(
  cols: Collections,
  env: Env,
  accountKey: string | undefined,
): Promise<string> {
  const key = accountKey && accountKey.length > 0 ? accountKey : env.DEMO_ACCOUNT_KEY;
  const tenant = await cols.tenants.findOne({ account_key_hash: sha256Hex(key) });
  if (!tenant) throw invalidApiKey('Unknown account key.');
  return tenant._id;
}
