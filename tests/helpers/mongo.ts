import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';

export interface TestMongo {
  db: Db;
  client: MongoClient;
  stop(): Promise<void>;
  uri: string;
}

/**
 * One ephemeral mongod per test file. Standalone is sufficient because the
 * service never opens a transaction.
 */
export async function startMongo(dbName = 'usage_platform_test'): Promise<TestMongo> {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  await client.connect();
  return {
    uri: server.getUri(),
    client,
    db: client.db(dbName),
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
}
