import { systemClock } from './clock.js';
import { loadEnv } from './config/env.js';
import { bootstrapDb } from './db/bootstrap.js';
import { collections } from './db/collections.js';
import { connectDb } from './db/client.js';
import { buildServer } from './http/server.js';
import { systemRng } from './random.js';
import { createRateLimiter } from './ratelimit/factory.js';
import { DeploymentsRepo } from './repositories/deployments.repo.js';
import { ProvisioningSweeper } from './workers/provisioningSweeper.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const handle = await connectDb(env);
  await bootstrapDb(handle.db, env, systemClock);

  const cols = collections(handle.db);
  const rateLimiter = createRateLimiter(env, cols);

  const app = await buildServer({
    env,
    clock: systemClock,
    rng: systemRng,
    db: handle.db,
    rateLimiter,
  });

  const sweeper = new ProvisioningSweeper(
    new DeploymentsRepo(cols),
    systemClock,
    env,
    app.log,
  );
  sweeper.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    sweeper.stop();
    await app.close();
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    { url: env.PUBLIC_BASE_URL, database: env.MONGODB_URI ? 'external' : 'in-process' },
    'listening',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
