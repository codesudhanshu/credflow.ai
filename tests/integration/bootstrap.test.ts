import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { loadEnv } from '../../src/config/env.js';
import { bootstrapDb } from '../../src/db/bootstrap.js';
import { collections } from '../../src/db/collections.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

describe('bootstrapDb', () => {
  let mongo: TestMongo;
  const env = loadEnv({ LOG_LEVEL: 'silent' });
  const clock = new FakeClock('2026-09-09T12:00:30.000Z');

  beforeAll(async () => {
    mongo = await startMongo();
    await bootstrapDb(mongo.db, env, clock);
  });

  afterAll(async () => {
    await mongo.stop();
  });

  it('is idempotent — a second run changes nothing and does not throw', async () => {
    const first = await bootstrapDb(mongo.db, env, clock);
    const second = await bootstrapDb(mongo.db, env, clock);
    expect(second.demoTenantId).toBe(first.demoTenantId);
    expect(await collections(mongo.db).tenants.countDocuments({})).toBe(1);
  });

  it('creates the indexes the query plans depend on', async () => {
    const cols = collections(mongo.db);
    const usageIndexes = await cols.usageEvents.indexes();
    const keys = usageIndexes.map((i) => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ tenant_id: 1, occurred_at: 1 }));
    expect(keys).toContain(JSON.stringify({ api_key_id: 1, occurred_at: 1 }));

    const requestIdIndex = usageIndexes.find((i) => i.key.request_id === 1);
    expect(requestIdIndex?.unique).toBe(true);

    const keyIndexes = await cols.apiKeys.indexes();
    expect(keyIndexes.find((i) => i.key.key_hash === 1)?.unique).toBe(true);

    const bucketIndexes = await cols.rateLimitBuckets.indexes();
    expect(bucketIndexes.find((i) => i.key.expires_at === 1)?.expireAfterSeconds).toBe(0);
  });

  it('rejects a usage event whose token count is not a BSON int', async () => {
    const cols = collections(mongo.db);
    await expect(
      cols.usageEvents.insertOne({
        _id: 'evt_bad',
        tenant_id: 'ten_x',
        deployment_id: 'dep_x',
        api_key_id: 'key_x',
        model: 'model-a',
        input_tokens: 1.5,
        output_tokens: 100,
        cost_micro_usd: 201,
        occurred_at: clock.now(),
        request_id: 'req_bad',
      }),
    ).rejects.toThrow(/validation/i);
  });

  it('rejects a deployment in an unknown status', async () => {
    const cols = collections(mongo.db);
    await expect(
      cols.deployments.insertOne({
        _id: 'dep_bad',
        tenant_id: 'ten_x',
        model: 'model-a',
        // Deliberately invalid: the database, not just Zod, must refuse this.
        status: 'starting' as unknown as 'ready',
        ready_at: null,
        endpoint_url: null,
        created_at: clock.now(),
        updated_at: clock.now(),
        terminated_at: null,
      }),
    ).rejects.toThrow(/validation/i);
  });

  it('stores an integer token count as a BSON int', async () => {
    const cols = collections(mongo.db);
    await cols.usageEvents.insertOne({
      _id: 'evt_ok',
      tenant_id: 'ten_x',
      deployment_id: 'dep_x',
      api_key_id: 'key_x',
      model: 'model-a',
      input_tokens: 10,
      output_tokens: 100,
      cost_micro_usd: 210,
      occurred_at: clock.now(),
      request_id: 'req_ok',
    });

    const asInt = await cols.usageEvents.countDocuments({
      _id: 'evt_ok',
      input_tokens: { $type: 'int' },
      cost_micro_usd: { $type: 'int' },
    });
    expect(asInt).toBe(1);
  });
});
