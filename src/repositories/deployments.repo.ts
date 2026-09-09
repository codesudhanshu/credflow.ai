import type { Collections } from '../db/collections.js';
import type { DeploymentDoc } from '../db/types.js';

/**
 * Every state change is a single conditional update. Concurrency is settled by
 * the query filter, not by an application-level read-modify-write, so two
 * sweepers or a sweeper racing a DELETE cannot both win.
 */
export class DeploymentsRepo {
  constructor(private readonly cols: Collections) {}

  async insert(doc: DeploymentDoc): Promise<DeploymentDoc> {
    await this.cols.deployments.insertOne(doc);
    return doc;
  }

  async findById(id: string): Promise<DeploymentDoc | null> {
    return this.cols.deployments.findOne({ _id: id });
  }

  /**
   * provisioning -> ready, only if the deadline has passed. Returns the updated
   * document, or null when the filter did not match (already ready, already
   * terminated, or not yet due).
   */
  async promoteIfDue(
    id: string,
    now: Date,
    endpointUrl: string,
  ): Promise<DeploymentDoc | null> {
    return this.cols.deployments.findOneAndUpdate(
      { _id: id, status: 'provisioning', ready_at: { $lte: now } },
      {
        $set: {
          status: 'ready',
          endpoint_url: endpointUrl,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    );
  }

  /**
   * Anything -> terminated. `terminated` is absorbing, so the filter excludes
   * it and a repeat DELETE is a no-op rather than a rewrite.
   */
  async terminate(id: string, now: Date): Promise<DeploymentDoc | null> {
    return this.cols.deployments.findOneAndUpdate(
      { _id: id, status: { $ne: 'terminated' } },
      {
        $set: {
          status: 'terminated',
          terminated_at: now,
          ready_at: null,
          endpoint_url: null,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    );
  }

  /** Candidates for the sweeper. Served by the { status, ready_at } index. */
  async findDueForPromotion(now: Date, limit: number): Promise<DeploymentDoc[]> {
    return this.cols.deployments
      .find({ status: 'provisioning', ready_at: { $lte: now } })
      .limit(limit)
      .toArray();
  }
}
