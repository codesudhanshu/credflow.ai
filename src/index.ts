import { systemClock } from './clock.js';
import { loadEnv } from './config/env.js';
import { bootstrapDb } from './db/bootstrap.js';
import { collections } from './db/collections.js';
import { connectDb } from './db/client.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';
import { systemRng } from './random.js';
import { createRateLimiter } from './ratelimit/factory.js';
import { DeploymentsRepo } from './repositories/deployments.repo.js';
import { ProvisioningSweeper } from './workers/provisioningSweeper.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  const handle = await connectDb(env);
  await bootstrapDb(handle.db, env, systemClock);

  const cols = collections(handle.db);
  const app = buildServer({
    env,
    clock: systemClock,
    rng: systemRng,
    logger,
    db: handle.db,
    rateLimiter: createRateLimiter(env, cols),
  });

  const sweeper = new ProvisioningSweeper(
    new DeploymentsRepo(cols),
    systemClock,
    env,
    logger,
  );
  sweeper.start();

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { url: env.PUBLIC_BASE_URL, database: env.MONGODB_URI ? 'external' : 'in-process' },
      'listening',
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    sweeper.stop();
    // Stop accepting connections, let in-flight requests finish, then release
    // the database — metering writes on the response path must not be cut off.
    server.close(() => {
      void handle.close().then(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
