/**
 * Deterministic RNG (mulberry32) as PURE STEP FUNCTIONS over a plain number.
 *
 * Ported verbatim from Emberkeep's `src/rng.ts` — the arithmetic below is the
 * contract. Do not "clean it up": every `| 0`, `>>>` and `Math.imul` is there to
 * pin the result to 32-bit integer semantics that behave identically on every
 * engine. A change here silently desynchronises every daily seed ever played.
 *
 * Why not a closure/class: the RNG state must live inside the run state so that
 * (a) save/load reproduces the exact same future rolls, and (b) two players on
 * the same daily seed get a bit-identical board sequence. A number in the state
 * object serializes for free; a closure doesn't.
 *
 * Usage pattern (thread the state through):
 *   let r = rngNext(s.rngState);        // { value: 0..1, state: next }
 *   const roll = r.value;
 *   r = rngNext(r.state);
 */

export interface RngResult {
  value: number; // uniform in [0, 1)
  state: number; // pass into the next call
}

export function rngNext(state: number): RngResult {
  let t = (state + 0x6d2b79f5) | 0;
  const nextState = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: nextState };
}

/** Uniform float in [min, max). */
export function rngRange(state: number, min: number, max: number): RngResult {
  const r = rngNext(state);
  return { value: min + r.value * (max - min), state: r.state };
}

/** Integer in [0, n). */
export function rngInt(state: number, n: number): RngResult {
  const r = rngNext(state);
  return { value: Math.min(n - 1, Math.floor(r.value * n)), state: r.state };
}

/** Weighted index pick: returns an index into `weights`. */
export function rngWeighted(state: number, weights: readonly number[]): RngResult {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = rngNext(state);
  let roll = r.value * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return { value: i, state: r.state };
  }
  return { value: weights.length - 1, state: r.state };
}
