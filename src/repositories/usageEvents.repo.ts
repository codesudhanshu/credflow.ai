import type { MongoServerError } from 'mongodb';
import type { Collections } from '../db/collections.js';
import type { UsageEventDoc } from '../db/types.js';

const DUPLICATE_KEY = 11000;

export class UsageEventsRepo {
  constructor(private readonly cols: Collections) {}

  /**
   * Appends one billing record. The unique index on request_id makes a retried
   * request idempotent: instead of charging twice, the already-stored event is
   * returned so the caller sees the same numbers as the first time.
   */
  async record(doc: UsageEventDoc): Promise<{ event: UsageEventDoc; inserted: boolean }> {
    try {
      await this.cols.usageEvents.insertOne(doc);
      return { event: doc, inserted: true };
    } catch (err) {
      if ((err as MongoServerError).code !== DUPLICATE_KEY) throw err;
      const existing = await this.cols.usageEvents.findOne({ request_id: doc.request_id });
      if (!existing) throw err;
      return { event: existing, inserted: false };
    }
  }
}
