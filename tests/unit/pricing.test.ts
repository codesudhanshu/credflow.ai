import { describe, expect, it } from 'vitest';
import {
  computeCostMicroUsd,
  formatMicroUsd,
  PRICE_MICRO_USD_PER_TOKEN,
} from '../../src/domain/pricing.js';

describe('pricing', () => {
  it('encodes the published rates exactly, with no remainder', () => {
    // $0.001 / 1000 input tokens  == 1 micro-USD per input token
    // $0.002 / 1000 output tokens == 2 micro-USD per output token
    expect(PRICE_MICRO_USD_PER_TOKEN.input).toBe(1);
    expect(PRICE_MICRO_USD_PER_TOKEN.output).toBe(2);
  });

  it('prices one thousand of each token at $0.003', () => {
    expect(computeCostMicroUsd(1_000, 1_000)).toBe(3_000);
    expect(formatMicroUsd(3_000)).toBe('0.003000');
  });

  it('agrees with the per-1k rates at large volume', () => {
    // 1,000,000 input tokens == $1.00 ; 500,000 output tokens == $1.00
    expect(formatMicroUsd(computeCostMicroUsd(1_000_000, 500_000))).toBe('2.000000');
  });

  it('formats micro-USD by integer arithmetic, never by dividing floats', () => {
    expect(formatMicroUsd(0)).toBe('0.000000');
    expect(formatMicroUsd(1)).toBe('0.000001');
    expect(formatMicroUsd(630)).toBe('0.000630');
    expect(formatMicroUsd(1_234_567)).toBe('1.234567');
    expect(formatMicroUsd(10_000_000)).toBe('10.000000');
  });

  it('stays exact where floating point would drift', () => {
    // 0.1 + 0.2 !== 0.3 in floats; the integer path has no such failure mode.
    let total = 0;
    for (let i = 0; i < 10_000; i += 1) total += computeCostMicroUsd(7, 3);
    expect(total).toBe(130_000);
    expect(Number.isInteger(total)).toBe(true);
  });
});
