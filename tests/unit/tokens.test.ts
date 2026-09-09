import { describe, expect, it } from 'vitest';
import { seededRng } from '../../src/random.js';
import {
  countInputTokens,
  OUTPUT_TOKEN_MAX,
  OUTPUT_TOKEN_MIN,
  sampleOutputTokens,
} from '../../src/domain/tokens.js';

describe('countInputTokens', () => {
  it('estimates one token per four characters', () => {
    expect(countInputTokens('a'.repeat(40))).toBe(10);
    expect(countInputTokens('a'.repeat(400))).toBe(100);
  });

  it('rounds rather than truncates', () => {
    expect(countInputTokens('a'.repeat(6))).toBe(2); // round(1.5) === 2
    expect(countInputTokens('a'.repeat(5))).toBe(1); // round(1.25) === 1
  });

  it('charges at least one token for a one-character prompt', () => {
    // round(1 / 4) === 0 without the floor, which would make a billable
    // request free on the input side.
    expect(countInputTokens('a')).toBe(1);
  });
});

describe('sampleOutputTokens', () => {
  it('stays inside the documented inclusive range', () => {
    const rng = seededRng(42);
    for (let i = 0; i < 2_000; i += 1) {
      const tokens = sampleOutputTokens(rng);
      expect(tokens).toBeGreaterThanOrEqual(OUTPUT_TOKEN_MIN);
      expect(tokens).toBeLessThanOrEqual(OUTPUT_TOKEN_MAX);
      expect(Number.isInteger(tokens)).toBe(true);
    }
  });

  it('is reproducible from a seed, so metering tests are deterministic', () => {
    const first = [1, 2, 3].map(() => sampleOutputTokens(seededRng(7)));
    const second = [1, 2, 3].map(() => sampleOutputTokens(seededRng(7)));
    expect(first).toEqual(second);
  });
});
