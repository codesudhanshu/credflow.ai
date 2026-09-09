import type { Collections } from '../db/collections.js';
import { sha256Hex } from '../crypto.js';
import { invalidApiKey } from '../domain/errors.js';
import { formatMicroUsd, PRICE_PER_1K_USD } from '../domain/pricing.js';
import type { ApiKeysRepo } from '../repositories/apiKeys.repo.js';

export type GroupBy = 'day' | 'model';

export interface UsageQuery {
  apiKey: string;
  from: Date;
  to: Date;
  groupBy: GroupBy;
}

export interface UsageAmounts {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_micro_usd: number;
  cost_usd: string;
}

export interface UsageBucket extends UsageAmounts {
  key: string;
}

export interface UsageReport {
  api_key_prefix: string;
  range: { from: string; to: string };
  group_by: GroupBy;
  pricing: { input_per_1k_usd: string; output_per_1k_usd: string };
  totals: UsageAmounts;
  breakdown: UsageBucket[];
}

interface GroupRow {
  _id: Date | string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
}

export class UsageService {
  constructor(
    private readonly cols: Collections,
    private readonly apiKeys: ApiKeysRepo,
  ) {}

  async report(query: UsageQuery): Promise<UsageReport> {
    const key = await this.apiKeys.findByHash(sha256Hex(query.apiKey));
    if (!key) throw invalidApiKey('Unknown API key.');

    // $dateTrunc buckets in UTC inside the database; grouping by model is the
    // same pipeline with a different group key.
    const groupKey =
      query.groupBy === 'day'
        ? { $dateTrunc: { date: '$occurred_at', unit: 'day', timezone: 'UTC' } }
        : '$model';

    const rows = await this.cols.usageEvents
      .aggregate<GroupRow>([
        {
          $match: {
            api_key_id: key._id,
            occurred_at: { $gte: query.from, $lt: query.to },
          },
        },
        {
          $group: {
            _id: groupKey,
            requests: { $sum: 1 },
            input_tokens: { $sum: '$input_tokens' },
            output_tokens: { $sum: '$output_tokens' },
            cost_micro_usd: { $sum: '$cost_micro_usd' },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const breakdown = rows.map((row) => ({ key: bucketKey(row._id), ...amounts(row) }));

    // Totals are folded from the same rows, so the breakdown and the totals can
    // never disagree.
    const totals = amounts(
      rows.reduce<GroupRow>(
        (acc, row) => ({
          _id: null,
          requests: acc.requests + row.requests,
          input_tokens: acc.input_tokens + row.input_tokens,
          output_tokens: acc.output_tokens + row.output_tokens,
          cost_micro_usd: acc.cost_micro_usd + row.cost_micro_usd,
        }),
        { _id: null, requests: 0, input_tokens: 0, output_tokens: 0, cost_micro_usd: 0 },
      ),
    );

    return {
      api_key_prefix: key.key_prefix,
      range: { from: query.from.toISOString(), to: query.to.toISOString() },
      group_by: query.groupBy,
      pricing: {
        input_per_1k_usd: PRICE_PER_1K_USD.input,
        output_per_1k_usd: PRICE_PER_1K_USD.output,
      },
      totals,
      breakdown,
    };
  }
}

function bucketKey(id: Date | string | null): string {
  if (id instanceof Date) return id.toISOString().slice(0, 10);
  return String(id);
}

function amounts(row: GroupRow): UsageAmounts {
  return {
    requests: row.requests,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.input_tokens + row.output_tokens,
    cost_micro_usd: row.cost_micro_usd,
    cost_usd: formatMicroUsd(row.cost_micro_usd),
  };
}
