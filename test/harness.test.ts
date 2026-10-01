/**
 * HARNESS TESTS — the tuning tools in `debug/`.
 *
 * These are not game logic, but they are the instrument the balance decisions
 * get made with. A bot you cannot reproduce, or one that disagrees with the sim
 * about what a legal move is, would quietly poison every number in the gate.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/sim/config";
import { createBoard, swap, type Pos } from "../src/sim/board";
import { currentRoundScore, newRun, playMove } from "../src/sim/run";
import { legalMoves, pickMove, simulateRun, summarise } from "../debug/bot";

describe("legalMoves", () => {
  it("agrees with the sim about what a legal move is", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const board = createBoard({ seed });
      const found = legalMoves(board);

      // Everything it returns is accepted...
      for (const [a, b] of found) expect(swap(board, a, b)).not.toBeNull();

      // ...and nothing it left out would have been.
      let accepted = 0;
      for (let row = 0; row < board.rows; row++) {
        for (let col = 0; col < board.cols; col++) {
          const a = { col, row };
          if (col + 1 < board.cols && swap(board, a, { col: col + 1, row })) accepted++;
          if (row + 1 < board.rows && swap(board, a, { col, row: row + 1 })) accepted++;
        }
      }
      expect(found.length).toBe(accepted);
      expect(found.length).toBeGreaterThan(0); // createBoard guarantees one
    }
  });
});

describe("bot policies", () => {
  it("greedy really does pick the best-scoring move available", () => {
    // Scored on the projected ROUND total (warmth x bliss), not raw warmth —
    // a move that builds bliss can beat one that clears more tiles, and that
    // is the trade the bot is supposed to be making.
    for (let seed = 1; seed <= 10; seed++) {
      const state = newRun(cfg, seed);
      const greedy = pickMove(cfg, state, "greedy", 1).move!;
      const scoreOf = (m: [Pos, Pos]): number => {
        const played = playMove(cfg, state, m[0], m[1])!;
        return played.state.totalScore + currentRoundScore(cfg, played.state);
      };
      const best = scoreOf(greedy);
      for (const move of legalMoves(state.board)) {
        expect(scoreOf(move)).toBeLessThanOrEqual(best + 1e-9);
      }
    }
  });

  it("greedy is a pure choice — evaluating options commits nothing", () => {
    const state = newRun(cfg, 7);
    const before = structuredClone(state);
    pickMove(cfg, state, "greedy", 1);
    expect(state).toEqual(before);
  });

  it("random threads its own stream rather than reaching for Math.random", () => {
    const state = newRun(cfg, 7);
    const a = pickMove(cfg, state, "random", 99);
    const b = pickMove(cfg, state, "random", 99);
    expect(a).toEqual(b);
    expect(a.rngState).not.toBe(99);
    expect(pickMove(cfg, state, "random", 100).move).toBeDefined();
  });
});

describe("simulateRun", () => {
  it("plays to a real death, not to the move cap", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = simulateRun(cfg, seed, "random", seed * 3);
      expect(r.wallRound).toBeGreaterThanOrEqual(1);
      expect(r.moves).toBeLessThan(4000);
      expect(r.rounds.length).toBe(r.wallRound);
      // Every round but the last was cleared; the last is the wall.
      expect(r.rounds.filter((x) => x.cleared).length).toBe(r.wallRound - 1);
      expect(r.rounds[r.rounds.length - 1]!.cleared).toBe(false);
    }
  });

  it("is reproducible — the whole point of a seeded bot", () => {
    for (let seed = 1; seed <= 8; seed++) {
      expect(simulateRun(cfg, seed, "random", 5)).toEqual(simulateRun(cfg, seed, "random", 5));
    }
    // Greedy evaluates every legal move on every move, so a full run is orders
    // of magnitude dearer than a random one. Three seeds is plenty to catch a
    // policy that is not deterministic — the property does not get truer with
    // more of them, only slower.
    for (let seed = 1; seed <= 3; seed++) {
      expect(simulateRun(cfg, seed, "greedy", 5)).toEqual(simulateRun(cfg, seed, "greedy", 5));
    }
  });

  it("records moves-to-clear inside the round's own budget", () => {
    const r = simulateRun(cfg, 3, "random", 1);
    for (const round of r.rounds) {
      expect(round.movesUsed).toBeGreaterThan(0);
      expect(round.movesUsed).toBeLessThanOrEqual(round.moveBudget);
      if (round.cleared) expect(round.score).toBeGreaterThanOrEqual(round.target);
      else expect(round.score).toBeLessThan(round.target);
    }
  });

  it("a stronger policy gets further, on average", () => {
    const mean = (p: "random" | "greedy"): number => {
      let total = 0;
      for (let seed = 1; seed <= 6; seed++) total += simulateRun(cfg, seed, p, seed).wallRound;
      return total / 6;
    };
    expect(mean("greedy")).toBeGreaterThan(mean("random"));
  });
});

describe("summarise", () => {
  it("reports where runs die without silently dropping any", () => {
    const runs = Array.from({ length: 12 }, (_, i) => simulateRun(cfg, i + 1, "random", i + 1));
    const stats = summarise(runs, "random");
    expect(stats.runs).toBe(12);
    const counted = [...stats.wallHistogram.values()].reduce((a, b) => a + b, 0);
    expect(counted).toBe(12);
    expect(stats.medianWall).toBeGreaterThan(0);
  });

  it("counts every round a run reached, cleared or not", () => {
    const runs = Array.from({ length: 10 }, (_, i) => simulateRun(cfg, i + 1, "random", i + 1));
    const stats = summarise(runs, "random");
    const round1 = stats.perRound.find((p) => p.round === 1)!;
    expect(round1.reached).toBe(10); // everyone plays round 1
    for (const p of stats.perRound) {
      expect(p.cleared).toBeLessThanOrEqual(p.reached);
      expect(p.medianScoreRatio).toBeGreaterThan(0);
    }
  });
});
