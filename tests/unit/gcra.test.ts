import { describe, expect, it } from 'vitest';
import { admit, decisionFrom, gcraConfig, MINUTE_MS } from '../../src/ratelimit/limiter.js';

const T0 = new Date('2026-09-09T12:00:30.000Z').getTime();

describe('gcraConfig', () => {
  it('derives an exact emission interval for the configured rate', () => {
    const cfg = gcraConfig({ ratePerMinute: 100, burst: 100 });
    expect(cfg.emissionMs).toBe(600); // 60_000 / 100
    expect(cfg.burstMs).toBe(59_400); // (100 - 1) * 600
    expect(cfg.limit).toBe(100);
  });

  it('gives a burst of one zero tolerance — strict smoothing', () => {
    const cfg = gcraConfig({ ratePerMinute: 100, burst: 1 });
    expect(cfg.burstMs).toBe(0);
  });

  it('lets burst be tuned independently of the sustained rate', () => {
    // 60/min sustained, but 600 may arrive at once.
    const cfg = gcraConfig({ ratePerMinute: 60, burst: 600 });
    expect(cfg.emissionMs).toBe(1_000);
    expect(cfg.burstMs).toBe(599_000);
    expect(cfg.limit).toBe(600);
  });
});

describe('admit — the leaky bucket admission rule', () => {
  const cfg = gcraConfig({ ratePerMinute: 100, burst: 100 });

  /** Replays a burst of `n` requests all arriving at the same instant. */
  function burst(n: number, at = T0): Array<{ allowed: boolean; tat: number }> {
    let tat: number | null = null;
    const results: Array<{ allowed: boolean; tat: number }> = [];
    for (let i = 0; i < n; i += 1) {
      const result = admit(tat, at, cfg);
      tat = result.tat;
      results.push(result);
    }
    return results;
  }

  it('admits exactly the capacity back-to-back, then rejects', () => {
    const results = burst(101);
    expect(results.slice(0, 100).every((r) => r.allowed)).toBe(true);
    expect(results[100]!.allowed).toBe(false);
  });

  it('leaves the bucket untouched when it rejects', () => {
    const results = burst(103);
    // A rejected request must not push `tat` forward, or a client hammering a
    // full bucket would extend its own lockout indefinitely.
    expect(results[100]!.tat).toBe(results[101]!.tat);
    expect(results[101]!.tat).toBe(results[102]!.tat);
  });

  it('drains at the sustained rate — one slot per emission interval', () => {
    const full = burst(100);
    const tat = full[99]!.tat;

    // Full bucket: nothing more right now.
    expect(admit(tat, T0, cfg).allowed).toBe(false);
    // One emission interval later, exactly one slot has drained.
    expect(admit(tat, T0 + 600, cfg).allowed).toBe(true);
    // Half an interval is not enough.
    expect(admit(tat, T0 + 599, cfg).allowed).toBe(false);
  });

  it('refills completely once the bucket has fully drained', () => {
    const tat = burst(100)[99]!.tat;
    expect(admit(tat, T0 + 60_000, cfg).allowed).toBe(true);
    expect(burst(101, T0 + 120_000).slice(0, 100).every((r) => r.allowed)).toBe(true);
  });

  /** Replays continuous traffic and returns the instants that were admitted. */
  function hammer(durationMs: number, stepMs: number): number[] {
    let tat: number | null = null;
    const admitted: number[] = [];
    for (let t = T0; t < T0 + durationMs; t += stepMs) {
      const result = admit(tat, t, cfg);
      tat = result.tat;
      if (result.allowed) admitted.push(t);
    }
    return admitted;
  }

  it('bounds sustained traffic by capacity plus rate times elapsed time', () => {
    const tenMinutes = 10 * 60_000;
    const admitted = hammer(tenMinutes, 100);

    // The leaky bucket's guarantee: over any interval, admissions cannot
    // exceed the burst capacity plus what drains at the sustained rate.
    const ceiling = cfg.limit + (tenMinutes / MINUTE_MS) * 100;
    expect(admitted.length).toBeLessThanOrEqual(ceiling);
    // And it does deliver the sustained rate rather than throttling below it.
    expect(admitted.length).toBeGreaterThan(ceiling * 0.95);
  });

  it('spaces admissions at least one emission interval apart once the burst is spent', () => {
    // This is the property a fixed window does not have. A fixed window can
    // admit 100 requests in a millisecond, twice, either side of a boundary.
    // Here, once the allowance is consumed, no two admissions can ever land
    // closer together than the emission interval — the traffic is smoothed
    // for as long as the caller keeps pushing.
    const admitted = hammer(10 * 60_000, 100);
    const tail = admitted.slice(cfg.limit + 50); // well past the initial burst

    const gaps = tail.slice(1).map((t, i) => t - tail[i]!);
    expect(gaps.length).toBeGreaterThan(500);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(cfg.emissionMs);
  });

  it('smooths strictly when burst is one', () => {
    const strict = gcraConfig({ ratePerMinute: 100, burst: 1 });
    let tat: number | null = null;

    const first = admit(tat, T0, strict);
    expect(first.allowed).toBe(true);
    tat = first.tat;

    expect(admit(tat, T0, strict).allowed).toBe(false);
    expect(admit(tat, T0 + 599, strict).allowed).toBe(false);
    expect(admit(tat, T0 + 600, strict).allowed).toBe(true);
  });
});

describe('decisionFrom', () => {
  const cfg = gcraConfig({ ratePerMinute: 100, burst: 100 });

  it('counts down the remaining burst allowance', () => {
    const first = admit(null, T0, cfg);
    expect(decisionFrom(first.tat, T0, first.allowed, cfg).remaining).toBe(99);
  });

  it('reports zero remaining on a full bucket', () => {
    let tat: number | null = null;
    for (let i = 0; i < 100; i += 1) tat = admit(tat, T0, cfg).tat;
    const rejected = admit(tat, T0, cfg);
    const decision = decisionFrom(rejected.tat, T0, rejected.allowed, cfg);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('points nextAllowedAt at the instant one slot drains', () => {
    let tat: number | null = null;
    for (let i = 0; i < 100; i += 1) tat = admit(tat, T0, cfg).tat;
    const rejected = admit(tat, T0, cfg);
    const decision = decisionFrom(rejected.tat, T0, rejected.allowed, cfg);
    // One emission interval, not a whole minute — the caller may retry in 600ms.
    expect(decision.nextAllowedAt.getTime()).toBe(T0 + 600);
  });

  it('never reports nextAllowedAt in the past', () => {
    const first = admit(null, T0, cfg);
    const decision = decisionFrom(first.tat, T0, first.allowed, cfg);
    expect(decision.nextAllowedAt.getTime()).toBe(T0);
  });
});
