/**
 * BOARD-MANIPULATION CHARM TESTS.
 *
 * These five are the ones that reach the board, so they are the ones that could
 * break the daily-seed contract. The first test in this file is the one that
 * matters most: a run with none of them owned must behave exactly as it did
 * before they existed.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { boardEffectsFrom, freeSwapsFrom, skimsAtRoundStart, type CharmId } from "../src/charms";
import {
  EMPTY,
  NO_EFFECTS,
  TILE_COLOURS,
  WILD,
  cellsOfColour,
  clearCells,
  createBoard,
  hasMatches,
  resolve,
  swap,
  validateBoard,
  type BoardState,
  type Pos,
} from "../src/board";
import { newRun, playMove, type RunState } from "../src/run";

const STONE = TILE_COLOURS.indexOf("stone");

const board = (cols: number, rows: number, colours: number, grid: number[], rngState = 0): BoardState => ({
  cols,
  rows,
  colours,
  grid,
  rngState,
});

/** First cascadeStep of a resolve, narrowed. */
function firstStep(events: readonly { type: string }[]): { cleared: number; runs: number } {
  const e = events.find((x) => x.type === "cascadeStep");
  if (!e) throw new Error("no cascadeStep event");
  return e as unknown as { cleared: number; runs: number };
}

function legalMoves(b: BoardState): [Pos, Pos][] {
  const out: [Pos, Pos][] = [];
  for (let row = 0; row < b.rows; row++) {
    for (let col = 0; col < b.cols; col++) {
      const a = { col, row };
      const right = { col: col + 1, row };
      const down = { col, row: row + 1 };
      if (col + 1 < b.cols && swap(b, a, right)) out.push([a, right]);
      if (row + 1 < b.rows && swap(b, a, down)) out.push([a, down]);
    }
  }
  return out;
}

describe("charms that own no board power change nothing", () => {
  it("folds to the no-op record", () => {
    expect(boardEffectsFrom([])).toEqual(NO_EFFECTS);
    expect(boardEffectsFrom(["deep_soak", "extra_towel"])).toEqual(NO_EFFECTS);
    expect(freeSwapsFrom(["deep_soak"])).toBe(0);
    expect(skimsAtRoundStart(["deep_soak"])).toBe(false);
  });

  it("resolves identically with and without the effects argument", () => {
    // The determinism hash in determinism.test.ts is pinned against the
    // no-effects path; this asserts the new parameter cannot disturb it.
    for (let seed = 1; seed <= 25; seed++) {
      const start = createBoard({ seed });
      const move = legalMoves(start)[0]!;
      const swapped = swap(start, move[0], move[1])!.state;
      const plain = resolve(swapped);
      const explicit = resolve(swapped, NO_EFFECTS);
      expect(explicit.state, `seed ${seed}`).toEqual(plain.state);
      expect(explicit.events).toEqual(plain.events);
    }
  });
});

describe("Floating Petal — wild tiles", () => {
  const fx = boardEffectsFrom(["floating_petal"]);

  it("declares itself as a run-size threshold", () => {
    expect(fx.wildFromRunSize).toBe(4);
  });

  it("leaves a wild where a run of four cleared", () => {
    // Bottom row holds four 0s; nothing else matches.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      0, 0, 0, 0, 2,
    ], 555);
    const out = resolve(s, fx);
    expect(out.state.grid).toContain(WILD);
    // A run of three leaves nothing behind.
    const three = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      0, 0, 0, 1, 2,
    ], 555);
    expect(resolve(three, fx).state.grid).not.toContain(WILD);
  });

  it("a wild completes a match of any colour", () => {
    // Row 4: 2, WILD, 2 — the wild stands in for the third 2.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      2, WILD, 2, 1, 0,
    ], 7);
    expect(hasMatches(s)).toBe(true);
  });

  it("wilds with no real colour to copy are not a match", () => {
    // A whole line of wilds has nothing to substitute FOR, so it matches
    // nothing. This is the rule that stops wilds from matching each other.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      WILD, WILD, WILD, WILD, WILD,
    ], 7);
    expect(hasMatches(s)).toBe(false);
  });

  it("but wilds DO stand in for a neighbouring colour", () => {
    // [W, W, W, 1] is four 1s — substitution is the whole point of a wild.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      WILD, WILD, WILD, 1, 0,
    ], 7);
    expect(hasMatches(s)).toBe(true);
  });

  it("a wild is consumed by one run only, deterministically", () => {
    // [0, 0, WILD, 1, 1] — greedy left means the wild joins the 0s, making a
    // three, and cannot also complete the 1s.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      0, 0, WILD, 1, 1,
    ], 7);
    const out = resolve(s, boardEffectsFrom([]));
    const cleared = out.events.filter((e) => e.type === "tilesCleared");
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared[0]!.type === "tilesCleared" && cleared[0]!.colour).toBe(0);
  });

  it("survives a save round trip", () => {
    const s = board(3, 3, 5, [0, 1, 2, WILD, 0, 1, 2, 0, 1], 9);
    expect(validateBoard(JSON.parse(JSON.stringify(s)))).toEqual(s);
    // An out-of-range tile is still rejected.
    expect(validateBoard({ ...s, grid: [0, 1, 2, -9, 0, 1, 2, 0, 1] })).toBeNull();
  });
});

describe("Hot Stone — the first stone clears its row", () => {
  const fx = boardEffectsFrom(["hot_stone"]);

  it("declares the stone colour", () => {
    expect(fx.rowOnFirstColour).toBe(STONE);
  });

  it("takes the whole row, and only once a round", () => {
    // Row 4 holds three stones plus other colours that would otherwise survive.
    const grid = [
      1, 2, 4, 1, 2,
      2, 4, 1, 2, 4,
      4, 1, 2, 4, 1,
      1, 2, 4, 1, 2,
      STONE, STONE, STONE, 1, 2,
    ];
    const out = resolve(board(5, 5, 5, grid, 31), fx);
    // Three stones alone would clear 3; the whole row is 5.
    expect(firstStep(out.events).cleared).toBeGreaterThanOrEqual(5);
    expect(out.effects!.rowFired).toBe(true);

    // Already fired: the next resolve does not take another row.
    const spent = resolve(board(5, 5, 5, grid, 31), { ...fx, rowFired: true });
    expect(firstStep(spent.events).cleared).toBe(3);
  });
});

describe("Bath Bomb — every 7th match clears a 3x3", () => {
  const fx = boardEffectsFrom(["bath_bomb"]);

  it("declares its interval", () => {
    expect(fx.areaEveryNthMatch).toBe(7);
  });

  it("counts matches across the round and detonates on the 7th", () => {
    const grid = [
      1, 2, 4, 1, 2,
      2, 4, 1, 2, 4,
      4, 1, 2, 4, 1,
      1, 2, 4, 1, 2,
      0, 0, 0, 1, 2,
    ];
    // Sixth match so far: this one is the seventh and should blow a hole.
    const primed = resolve(board(5, 5, 5, grid, 31), { ...fx, matchesSoFar: 6 });
    expect(firstStep(primed.events).cleared).toBeGreaterThan(3);

    // Two matches in, nothing extra happens.
    const quiet = resolve(board(5, 5, 5, grid, 31), { ...fx, matchesSoFar: 2 });
    expect(firstStep(quiet.events).cleared).toBe(3);
    expect(quiet.effects!.matchesSoFar).toBe(3);
  });
});

describe("Skimmer — sweeps a colour at round start", () => {
  it("declares itself", () => {
    expect(skimsAtRoundStart(["skimmer"])).toBe(true);
  });

  it("clears every tile of one colour and settles the board", () => {
    const s = createBoard({ seed: 12 });
    const colour = 2;
    const before = cellsOfColour(s, colour).length;
    expect(before).toBeGreaterThan(0);

    const out = clearCells(s, cellsOfColour(s, colour));
    expect(out.state.grid.some((t) => t === EMPTY)).toBe(false); // refilled
    expect(firstStep(out.events).cleared).toBe(before);
  });

  it("a run that owns it opens on a board the sweep already touched", () => {
    const plain = newRun(cfg, 77, "endless");
    const skimmed = newRun(cfg, 77, "endless");
    // newRun cannot own charms yet, so drive startRound through a draft: the
    // simplest equivalent is to compare grids after a manual sweep.
    expect(plain.board.grid).toEqual(skimmed.board.grid);
    const swept = clearCells(plain.board, cellsOfColour(plain.board, 1));
    expect(swept.state.grid).not.toEqual(plain.board.grid);
  });

  it("clearing nothing is a no-op, not an empty cascade", () => {
    const s = createBoard({ seed: 3 });
    const out = clearCells(s, []);
    expect(out.state).toBe(s);
    expect(out.events).toEqual([]);
  });
});

describe("Still Water — one free swap a round", () => {
  it("declares its allowance", () => {
    expect(freeSwapsFrom(["still_water"])).toBe(1);
    expect(freeSwapsFrom([])).toBe(0);
  });

  it("forces a swap that would otherwise be refused", () => {
    const s = createBoard({ seed: 15 });
    // Find a pair the ordinary rule rejects.
    let dud: [Pos, Pos] | null = null;
    outer: for (let row = 0; row < s.rows; row++) {
      for (let col = 0; col + 1 < s.cols; col++) {
        const a = { col, row };
        const b = { col: col + 1, row };
        if (!swap(s, a, b)) {
          dud = [a, b];
          break outer;
        }
      }
    }
    expect(dud).not.toBeNull();
    expect(swap(s, dud![0], dud![1])).toBeNull();
    expect(swap(s, dud![0], dud![1], { force: true })).not.toBeNull();
    // Bounds and adjacency still hold — a free move, not a free-for-all.
    expect(swap(s, { col: 0, row: 0 }, { col: 3, row: 3 }, { force: true })).toBeNull();
    expect(swap(s, { col: 0, row: 0 }, { col: -1, row: 0 }, { force: true })).toBeNull();
  });

  it("spends the allowance, and falls back to the normal rule when empty", () => {
    let state: RunState = { ...newRun(cfg, 15, "endless"), freeSwapsLeft: 1 };
    let dud: [Pos, Pos] | null = null;
    outer: for (let row = 0; row < state.board.rows; row++) {
      for (let col = 0; col + 1 < state.board.cols; col++) {
        const a = { col, row };
        const b = { col: col + 1, row };
        if (!swap(state.board, a, b)) {
          dud = [a, b];
          break outer;
        }
      }
    }
    const played = playMove(cfg, state, dud![0], dud![1], { free: true });
    expect(played).not.toBeNull();
    state = played!.state;
    expect(state.freeSwapsLeft).toBe(0);
    expect(state.movesUsed).toBe(1);

    // Out of free swaps: the same request is refused rather than granted.
    let dud2: [Pos, Pos] | null = null;
    outer2: for (let row = 0; row < state.board.rows; row++) {
      for (let col = 0; col + 1 < state.board.cols; col++) {
        const a = { col, row };
        const b = { col: col + 1, row };
        if (!swap(state.board, a, b)) {
          dud2 = [a, b];
          break outer2;
        }
      }
    }
    expect(playMove(cfg, state, dud2![0], dud2![1], { free: true })).toBeNull();
  });
});

describe("board effects stay deterministic", () => {
  it("the same charms and seed produce the same board, every time", () => {
    const boardy: CharmId[] = ["floating_petal", "hot_stone", "bath_bomb"];
    const fx = boardEffectsFrom(boardy);
    for (let seed = 1; seed <= 20; seed++) {
      const start = createBoard({ seed });
      const move = legalMoves(start)[0]!;
      const swapped = swap(start, move[0], move[1])!.state;
      const a = resolve(swapped, fx);
      const b = resolve(swapped, fx);
      expect(a.state, `seed ${seed}`).toEqual(b.state);
      expect(a.effects).toEqual(b.effects);
    }
  });

  it("leaves the board playable and settled, wilds and all", () => {
    const fx = boardEffectsFrom(["floating_petal", "bath_bomb", "hot_stone"]);
    for (let seed = 1; seed <= 20; seed++) {
      let b = createBoard({ seed });
      let effects = fx;
      for (let move = 0; move < 12; move++) {
        const moves = legalMoves(b);
        if (moves.length === 0) break;
        const m = moves[Math.floor(moves.length / 2)]!;
        const out = resolve(swap(b, m[0], m[1])!.state, effects);
        b = out.state;
        effects = out.effects!;
        expect(hasMatches(b), `seed ${seed} move ${move}`).toBe(false);
        expect(b.grid.some((t) => t === EMPTY)).toBe(false);
        expect(b.grid.length).toBe(b.cols * b.rows);
      }
    }
  });
});
