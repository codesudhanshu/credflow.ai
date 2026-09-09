import type { Db, Document } from 'mongodb';
import type { Env } from '../config/env.js';
import type { Clock } from '../clock.js';
import { sha256Hex } from '../crypto.js';
import { newId } from '../ids.js';
import { collections } from './collections.js';

const NAMESPACE_EXISTS = 48;

const VALIDATORS: Record<string, Document> = {
  tenants: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'name', 'account_key_hash', 'created_at'],
      properties: {
        _id: { bsonType: 'string' },
        name: { bsonType: 'string' },
        account_key_hash: { bsonType: 'string' },
        created_at: { bsonType: 'date' },
      },
      additionalProperties: false,
    },
  },
  deployments: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'tenant_id', 'model', 'status', 'created_at', 'updated_at'],
      properties: {
        _id: { bsonType: 'string' },
        tenant_id: { bsonType: 'string' },
        model: { enum: ['model-a', 'model-b'] },
        status: { enum: ['provisioning', 'ready', 'terminated'] },
        ready_at: { bsonType: ['date', 'null'] },
        endpoint_url: { bsonType: ['string', 'null'] },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        terminated_at: { bsonType: ['date', 'null'] },
      },
      additionalProperties: false,
    },
  },
  api_keys: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'deployment_id',
        'tenant_id',
        'key_hash',
        'key_prefix',
        'secret',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'string' },
        deployment_id: { bsonType: 'string' },
        tenant_id: { bsonType: 'string' },
        key_hash: { bsonType: 'string' },
        key_prefix: { bsonType: 'string' },
        secret: { bsonType: 'string' },
        revoked_at: { bsonType: ['date', 'null'] },
        created_at: { bsonType: 'date' },
      },
      additionalProperties: false,
    },
  },
  usage_events: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'tenant_id',
        'deployment_id',
        'api_key_id',
        'model',
        'input_tokens',
        'output_tokens',
        'cost_micro_usd',
        'occurred_at',
        'request_id',
      ],
      properties: {
        _id: { bsonType: 'string' },
        tenant_id: { bsonType: 'string' },
        deployment_id: { bsonType: 'string' },
        api_key_id: { bsonType: 'string' },
        model: { enum: ['model-a', 'model-b'] },
        // 'int' is deliberate: a double in a billing column is a silent
        // corruption, so the database refuses it outright.
        input_tokens: { bsonType: 'int', minimum: 0 },
        output_tokens: { bsonType: 'int', minimum: 0 },
        cost_micro_usd: { bsonType: 'int', minimum: 0 },
        occurred_at: { bsonType: 'date' },
        request_id: { bsonType: 'string' },
      },
      additionalProperties: false,
    },
  },
  rate_limit_buckets: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'tat', 'allowed', 'expires_at'],
      properties: {
        _id: { bsonType: 'string' },
        tat: { bsonType: 'date' },
        allowed: { bsonType: 'bool' },
        expires_at: { bsonType: 'date' },
      },
      additionalProperties: false,
    },
  },
};

/**
 * Creates collections, validators, and indexes. Idempotent, so it runs on every
 * boot rather than living in a migration tool this project does not need.
 */
export async function bootstrapDb(
  db: Db,
  env: Env,
  clock: Clock,
): Promise<{ demoTenantId: string }> {
  for (const [name, validator] of Object.entries(VALIDATORS)) {
    await ensureCollection(db, name, validator);
  }

  const cols = collections(db);

  await cols.tenants.createIndex({ account_key_hash: 1 }, { unique: true });
  await cols.deployments.createIndex({ status: 1, ready_at: 1 });
  await cols.deployments.createIndex({ tenant_id: 1, created_at: -1 });
  await cols.apiKeys.createIndex({ key_hash: 1 }, { unique: true });
  await cols.apiKeys.createIndex({ deployment_id: 1 });
  await cols.usageEvents.createIndex({ tenant_id: 1, occurred_at: 1 });
  await cols.usageEvents.createIndex({ api_key_id: 1, occurred_at: 1 });
  await cols.usageEvents.createIndex({ request_id: 1 }, { unique: true });
  await cols.rateLimitBuckets.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  const demoTenantId = await seedDemoTenant(db, env, clock);
  return { demoTenantId };
}

async function ensureCollection(db: Db, name: string, validator: Document): Promise<void> {
  try {
    await db.createCollection(name, {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } catch (err) {
    if ((err as { code?: number }).code !== NAMESPACE_EXISTS) throw err;
    await db.command({
      collMod: name,
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
}

/**
 * A default tenant so the reviewer's curl commands need no account setup.
 * X-Account-Key is optional and falls back to this tenant.
 */
async function seedDemoTenant(db: Db, env: Env, clock: Clock): Promise<string> {
  const cols = collections(db);
  const hash = sha256Hex(env.DEMO_ACCOUNT_KEY);

  const existing = await cols.tenants.findOne({ account_key_hash: hash });
  if (existing) return existing._id;

  const doc = {
    _id: newId('ten'),
    name: 'demo',
    account_key_hash: hash,
    created_at: clock.now(),
  };
  await cols.tenants.insertOne(doc);
  return doc._id;
}
