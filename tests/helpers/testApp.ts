import type { FastifyInstance } from 'fastify';
import { FakeClock } from '../../src/clock.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { bootstrapDb } from '../../src/db/bootstrap.js';
import { collections, type Collections } from '../../src/db/collections.js';
import { seededRng } from '../../src/random.js';
import { DeploymentsRepo } from '../../src/repositories/deployments.repo.js';
import { ProvisioningSweeper } from '../../src/workers/provisioningSweeper.js';
import { buildServer } from '../../src/http/server.js';
import { startMongo, type TestMongo } from './mongo.js';

/** A fixed instant well away from a minute boundary, so window maths is obvious. */
export const T0 = '2026-09-09T12:00:30.000Z';

export interface TestApp {
  app: FastifyInstance;
  cols: Collections;
  clock: FakeClock;
  env: Env;
  sweeper: ProvisioningSweeper;
  demoTenantId: string;
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

  const app = await buildServer({
    env,
    clock,
    rng: seededRng(1_234),
    db: mongo.db,
  });
  await app.ready();

  const sweeper = new ProvisioningSweeper(new DeploymentsRepo(cols), clock, env, {
    error: () => {},
  });

  return {
    app,
    cols,
    clock,
    env,
    sweeper,
    demoTenantId,
    close: async () => {
      sweeper.stop();
      await app.close();
      await mongo.stop();
    },
  };
}
