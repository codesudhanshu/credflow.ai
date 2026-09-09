/**
 * Prices are held per token in micro-USD (millionths of a dollar) so that
 * every cost in the system is an exact integer:
 *   $0.001 per 1,000 input tokens  = 1 micro-USD per input token
 *   $0.002 per 1,000 output tokens = 2 micro-USD per output token
 * No float ever enters the billing path.
 */
export const PRICE_MICRO_USD_PER_TOKEN = {
  input: 1,
  output: 2,
} as const;

/** Echoed in the usage response so a bill can be audited without the docs. */
export const PRICE_PER_1K_USD = {
  input: '0.001',
  output: '0.002',
} as const;

export const MICRO_USD_PER_USD = 1_000_000;

export function computeCostMicroUsd(inputTokens: number, outputTokens: number): number {
  return (
    inputTokens * PRICE_MICRO_USD_PER_TOKEN.input +
    outputTokens * PRICE_MICRO_USD_PER_TOKEN.output
  );
}

/**
 * Renders micro-USD as a fixed six-decimal string by integer division and
 * string padding — deliberately not `(n / 1e6).toFixed(6)`, which would round
 * a float.
 */
export function formatMicroUsd(microUsd: number): string {
  const sign = microUsd < 0 ? '-' : '';
  const magnitude = Math.abs(microUsd);
  const dollars = Math.floor(magnitude / MICRO_USD_PER_USD);
  const fraction = String(magnitude % MICRO_USD_PER_USD).padStart(6, '0');
  return `${sign}${dollars}.${fraction}`;
}
