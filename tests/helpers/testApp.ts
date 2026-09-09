import type { Express } from 'express';
import { FakeClock } from '../../src/clock.js';
import { createLogger } from '../../src/logger.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { bootstrapDb } from '../../src/db/bootstrap.js';
import { collections, type Collections } from '../../src/db/collections.js';
import { seededRng } from '../../src/random.js';
import { DeploymentsRepo } from '../../src/repositories/deployments.repo.js';
import { createRateLimiter } from '../../src/ratelimit/factory.js';
import { ProvisioningSweeper } from '../../src/workers/provisioningSweeper.js';
import { buildServer } from '../../src/http/server.js';
import { startMongo, type TestMongo } from './mongo.js';

/** A fixed instant well away from a minute boundary, so window maths is obvious. */
export const T0 = '2026-09-09T12:00:30.000Z';

export interface TestApp {
  app: Express;
  cols: Collections;
  clock: FakeClock;
  env: Env;
  sweeper: ProvisioningSweeper;
  demoTenantId: string;
  /**
   * Clears every collection except the seeded tenant and rewinds the clock, so
   * one mongod can serve a whole test file instead of one per test.
   */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestApp(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<TestApp> {
  const mongo: TestMongo = await startMongo();
  const env = loadEnv({ LOG_LEVEL: 'silent', ...overrides });
  const clock = new FakeClock(T0);

  const { demoTenantId } = await bootstrapDb(mongo.db, env, clock);
  const cols = collections(mongo.db);
  const rateLimiter = createRateLimiter(env, cols);

  const logger = createLogger(env);
  const app = buildServer({
    env,
    clock,
    rng: seededRng(1_234),
    logger,
    db: mongo.db,
    rateLimiter,
  });

  const sweeper = new ProvisioningSweeper(new DeploymentsRepo(cols), clock, env, logger);

  return {
    app,
    cols,
    clock,
    env,
    sweeper,
    demoTenantId,
    reset: async () => {
      await Promise.all([
        cols.deployments.deleteMany({}),
        cols.apiKeys.deleteMany({}),
        cols.usageEvents.deleteMany({}),
        cols.rateLimitBuckets.deleteMany({}),
      ]);
      clock.set(T0);
    },
    close: async () => {
      // Nothing to close on the app itself: buildServer never listens, so
      // supertest opens and closes an ephemeral socket per request.
      sweeper.stop();
      await mongo.stop();
    },
  };
}
