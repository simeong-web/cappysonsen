/**
 * RNG TESTS — these pin the daily-seed contract.
 *
 * The literal values below are not arbitrary: they are what mulberry32 emits
 * today. If a change to `rng.ts` makes one of these fail, every daily seed ever
 * played has just been invalidated and every leaderboard score de-synced. Fix
 * the change, never the number.
 */
import { describe, it, expect } from "vitest";
import { rngNext, rngRange, rngInt, rngWeighted } from "../src/rng";

describe("rngNext — pinned output", () => {
  it("emits the exact mulberry32 stream for known seeds", () => {
    const pinned: [seed: number, value: number, state: number][] = [
      [0, 0.26642920868471265, 1831565813],
      [1, 0.6270739405881613, 1831565814],
      [42, 0.6011037519201636, 1831565855],
      [-1, 0.8964226141106337, 1831565812],
      // wraps past 2^31 — this is the case that breaks if the `| 0` is dropped
      [2147483647, 0.4290980885270983, -315917836],
    ];
    for (const [seed, value, state] of pinned) {
      expect(rngNext(seed)).toEqual({ value, state });
    }
  });

  it("emits a pinned sequence when threaded", () => {
    let state = 12345;
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = rngNext(state);
      values.push(r.value);
      state = r.state;
    }
    expect(values).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985,
      0.817934412509203, 0.5094283693470061,
    ]);
    expect(state).toBe(567906818);
  });
});

describe("rngNext — purity", () => {
  it("is a function of its argument alone: same state in, same result out", () => {
    for (const seed of [0, 7, 999, -12345, 2 ** 31]) {
      expect(rngNext(seed)).toEqual(rngNext(seed));
    }
  });

  it("two runs from the same seed produce identical 1000-draw streams", () => {
    const stream = (seed: number): number[] => {
      let s = seed;
      const out: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const r = rngNext(s);
        out.push(r.value);
        s = r.state;
      }
      return out;
    };
    expect(stream(2024)).toEqual(stream(2024));
    expect(stream(2024)).not.toEqual(stream(2025));
  });

  it("stays in [0, 1) and does not immediately repeat", () => {
    let s = 5;
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const r = rngNext(s);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(1);
      seen.add(r.value);
      s = r.state;
    }
    // A short cycle here would mean boards repeating within a single run.
    expect(seen.size).toBeGreaterThan(9900);
  });
});

describe("rngRange", () => {
  it("stays within [min, max) and advances the state like rngNext", () => {
    let s = 31;
    for (let i = 0; i < 2000; i++) {
      const r = rngRange(s, -5, 12.5);
      expect(r.value).toBeGreaterThanOrEqual(-5);
      expect(r.value).toBeLessThan(12.5);
      expect(r.state).toBe(rngNext(s).state); // one draw, same cursor step
      s = r.state;
    }
  });

  it("degenerates cleanly when min === max", () => {
    expect(rngRange(9, 3, 3).value).toBe(3);
  });
});

describe("rngInt", () => {
  it("returns integers in [0, n) and never n", () => {
    let s = 77;
    const hits = new Array<number>(5).fill(0);
    for (let i = 0; i < 5000; i++) {
      const r = rngInt(s, 5);
      expect(Number.isInteger(r.value)).toBe(true);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(5);
      hits[r.value]!++;
      s = r.state;
    }
    // Board refill draws a colour per tile — a dead bucket would mean a colour
    // that never appears.
    for (const h of hits) expect(h).toBeGreaterThan(0);
  });

  it("always returns 0 for n = 1", () => {
    let s = 3;
    for (let i = 0; i < 50; i++) {
      const r = rngInt(s, 1);
      expect(r.value).toBe(0);
      s = r.state;
    }
  });
});

describe("rngWeighted", () => {
  it("is deterministic and returns a valid index", () => {
    const w = [1, 3, 6];
    for (const seed of [0, 1, 500, -900]) {
      const r = rngWeighted(seed, w);
      expect(r).toEqual(rngWeighted(seed, w));
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(w.length);
    }
  });

  it("never picks a zero-weight entry", () => {
    let s = 101;
    for (let i = 0; i < 5000; i++) {
      const r = rngWeighted(s, [0, 5, 0, 5]);
      expect([1, 3]).toContain(r.value);
      s = r.state;
    }
  });

  it("roughly honours the weights", () => {
    let s = 8;
    const hits = [0, 0, 0];
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const r = rngWeighted(s, [1, 2, 7]);
      hits[r.value]!++;
      s = r.state;
    }
    expect(hits[0]! / n).toBeCloseTo(0.1, 1);
    expect(hits[1]! / n).toBeCloseTo(0.2, 1);
    expect(hits[2]! / n).toBeCloseTo(0.7, 1);
  });

  it("falls back to the last index rather than throwing on an all-zero table", () => {
    // Defined behaviour, not an accident: a charm pool that filters down to
    // nothing must degrade to a pick, never to a crash mid-draft.
    expect(rngWeighted(4, [0, 0, 0]).value).toBe(2);
  });
});
