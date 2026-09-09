/** Injected so that metered token counts are deterministic under test. */
export interface Rng {
  /** Uniform integer in [min, max], both inclusive. */
  intBetween(min: number, max: number): number;
}

export const systemRng: Rng = {
  intBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  },
};

/** mulberry32 — small, fast, and reproducible from a seed. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    intBetween(min, max) {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
      return min + Math.floor(unit * (max - min + 1));
    },
  };
}
