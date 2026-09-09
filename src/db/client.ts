import { MongoClient, type Db } from 'mongodb';
import type { Env } from '../config/env.js';

export interface DbHandle {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

/**
 * Connects to MONGODB_URI when configured. When it is not, boots an in-process
 * MongoDB so `npm run dev` works with nothing installed. A standalone instance
 * is enough: every mutation in this service is a single-document update, so no
 * code path opens a transaction.
 */
export async function connectDb(env: Env): Promise<DbHandle> {
  if (env.MONGODB_URI) {
    const client = new MongoClient(env.MONGODB_URI);
    await client.connect();
    return {
      client,
      db: client.db(env.MONGODB_DB),
      close: async () => {
        await client.close();
      },
    };
  }

  const memory = await startInProcessMongo();
  const client = new MongoClient(memory.uri);
  await client.connect();
  return {
    client,
    db: client.db(env.MONGODB_DB),
    close: async () => {
      await client.close();
      await memory.stop();
    },
  };
}

async function startInProcessMongo(): Promise<{ uri: string; stop(): Promise<void> }> {
  try {
    // Imported lazily so a production bundle never loads the dev dependency.
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create();
    return {
      uri: server.getUri(),
      stop: async () => {
        await server.stop();
      },
    };
  } catch (cause) {
    throw new Error(
      'MONGODB_URI is not set and the in-process MongoDB could not start. ' +
        'Set MONGODB_URI to any MongoDB instance, or run `docker compose up -d mongo`.',
      { cause },
    );
  }
}
