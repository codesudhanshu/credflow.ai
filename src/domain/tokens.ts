import type { Rng } from '../random.js';

export const OUTPUT_TOKEN_MIN = 50;
export const OUTPUT_TOKEN_MAX = 200;

/**
 * The spec's estimate is `round(prompt.length / 4)`, floored at one token: a
 * one-character prompt rounds to zero, and a billable request should never
 * cost nothing on the input side. Empty prompts are rejected by validation
 * before reaching here.
 */
export function countInputTokens(prompt: string): number {
  return Math.max(1, Math.round(prompt.length / 4));
}

export function sampleOutputTokens(rng: Rng): number {
  return rng.intBetween(OUTPUT_TOKEN_MIN, OUTPUT_TOKEN_MAX);
}
