import { z } from 'zod';
import { validationFailed } from '../../domain/errors.js';

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RANGE_MS = 30 * DAY_MS;
export const MAX_RANGE_MS = 366 * DAY_MS;

export const UsageQueryParams = z.object({
  api_key: z.string().min(1, 'api_key is required'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  group_by: z.enum(['day', 'model']).default('day'),
});

/** Start of the UTC day after `instant`. */
function nextUtcMidnight(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1),
  );
}

/**
 * Half-open range `[from, to)`. Two adjacent ranges therefore never
 * double-count an event, which in a billing query would mean overbilling.
 *
 * Both bounds are optional. The default window is day-aligned — from midnight
 * 30 days back to the midnight after today — for two reasons: the exclusive
 * upper bound would otherwise drop an event landing on the same instant as
 * `now`, and a day-aligned window produces whole `group_by=day` buckets with no
 * partial bucket at either edge. An explicitly supplied bound is used verbatim.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { from: Date; to: Date } {
  const toDate = to ? new Date(to) : nextUtcMidnight(now);
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - DEFAULT_RANGE_MS);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw validationFailed('`from` and `to` must be ISO 8601 timestamps.');
  }
  if (fromDate.getTime() >= toDate.getTime()) {
    throw validationFailed('`from` must be strictly before `to`.');
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
    throw validationFailed('Range must not exceed 366 days.');
  }
  return { from: fromDate, to: toDate };
}
