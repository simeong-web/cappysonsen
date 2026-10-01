/**
 * BOARD ENGINE TESTS — mechanics and invariants.
 *
 * The replay/hash contract lives in determinism.test.ts. This file pins the
 * conventions that contract is built on: draw order, scan order, gravity
 * direction, and the guarantees the board makes to the player (never dealt a
 * dead board, never handed a board that is still matching).
 */
import { describe, it, expect } from "vitest";
import { rngInt } from "../src/sim/rng";
import {
  createBoard,
  swap,
  resolve,
  refill,
  shuffle,
  hasValidMove,
  hasMatches,
  validateBoard,
  fallbackGrid,
  EMPTY,
  MAX_CASCADE_DEPTH,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_COLOURS,
  TILE_COLOURS,
  type BoardState,
  type BoardEvent,
  type Pos,
} from "../src/sim/board";

/** Finds an event and narrows it, so assertions can read its payload directly. */
function eventOf<T extends BoardEvent["type"]>(
  events: readonly BoardEvent[],
  type: T,
): Extract<BoardEvent, { type: T }> {
  const found = events.find((e) => e.type === type);
  if (!found) throw new Error(`expected a "${type}" event, got: ${events.map((e) => e.type).join(", ")}`);
  return found as Extract<BoardEvent, { type: T }>;
}

const board = (cols: number, rows: number, colours: number, grid: number[], rngState = 0): BoardState => ({
  cols,
  rows,
  colours,
  grid,
  rngState,
});

const rowOf = (s: BoardState, row: number): number[] =>
  s.grid.slice(row * s.cols, row * s.cols + s.cols);

describe("createBoard", () => {
  it("deals a board with no pre-existing match and at least one legal move", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = createBoard({ seed });
      expect(hasMatches(s), `seed ${seed} dealt a pre-matched board`).toBe(false);
      expect(hasValidMove(s), `seed ${seed} dealt a dead board`).toBe(true);
    }
  });

  it("fills the whole grid with in-range colours", () => {
    const s = createBoard({ seed: 7 });
    expect(s.grid.length).toBe(DEFAULT_COLS * DEFAULT_ROWS);
    expect(s.cols).toBe(DEFAULT_COLS);
    expect(s.rows).toBe(DEFAULT_ROWS);
    expect(s.colours).toBe(DEFAULT_COLOURS);
    expect(s.colours).toBeLessThanOrEqual(TILE_COLOURS.length);
    for (const t of s.grid) {
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(DEFAULT_COLOURS);
    }
  });

  it("is a pure function of the seed", () => {
    expect(createBoard({ seed: 99 })).toEqual(createBoard({ seed: 99 }));
    expect(createBoard({ seed: 99 }).grid).not.toEqual(createBoard({ seed: 100 }).grid);
  });

  it("advances rngState off the seed, so the first refill does not repeat generation draws", () => {
    const s = createBoard({ seed: 5 });
    expect(s.rngState).not.toBe(5);
  });

  it("produces a pinned board — generation shares the refill draw order", () => {
    // Generation fills column by column, top to bottom, exactly as refill draws
    // (board.ts convention 3). Small board so the pin stays readable.
    const s = createBoard({ seed: 1, cols: 4, rows: 4, colours: 3 });
    expect(s.grid.join("")).toBe("1210002111002200");
    expect(s.rngState).toBe(-759718063);
  });

  it("honours non-default dimensions", () => {
    const s = createBoard({ seed: 3, cols: 5, rows: 9, colours: 4 });
    expect(s.grid.length).toBe(45);
    expect(hasMatches(s)).toBe(false);
    for (const t of s.grid) expect(t).toBeLessThan(4);
  });
});

describe("swap", () => {
  // Diagonal-ish 5x5 with a planted pair, so exactly one swap is interesting.
  const base = (): BoardState =>
    board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      0, 0, 2, 1, 2,
    ], 12345);

  it("rejects a swap that makes no match, leaving the state untouched", () => {
    const s = base();
    expect(swap(s, { col: 0, row: 0 }, { col: 1, row: 0 })).toBeNull();
    expect(s.grid).toEqual(base().grid); // not mutated
  });

  it("rejects non-adjacent and out-of-bounds swaps", () => {
    const s = base();
    expect(swap(s, { col: 0, row: 0 }, { col: 2, row: 0 })).toBeNull();
    expect(swap(s, { col: 0, row: 0 }, { col: 1, row: 1 })).toBeNull(); // diagonal
    expect(swap(s, { col: 0, row: 0 }, { col: 0, row: 0 })).toBeNull(); // itself
    expect(swap(s, { col: -1, row: 0 }, { col: 0, row: 0 })).toBeNull();
    expect(swap(s, { col: 4, row: 4 }, { col: 5, row: 4 })).toBeNull();
  });

  it("accepts a swap that completes a run and reports it", () => {
    // Row 3 holds 0s at columns 1 and 2; a third 0 sits directly below at (0,4).
    // Lifting it into (0,3) completes 0,0,0 along row 3.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 0, 2, 3,
      0, 2, 1, 1, 2,
    ], 999);
    // (0,4)=0 and (1,3)=0,(2,3)=0 — swapping (0,4) up with (0,3)=4 gives
    // row 3 = 0,0,0 -> a match of 3.
    const r = swap(s, { col: 0, row: 4 }, { col: 0, row: 3 });
    expect(r).not.toBeNull();
    expect(r!.events).toEqual([
      { type: "swapped", a: { col: 0, row: 4 }, b: { col: 0, row: 3 } },
    ]);
    expect(hasMatches(r!.state)).toBe(true);
    expect(rowOf(r!.state, 3)).toEqual([0, 0, 0, 2, 3]);
  });

  it("draws no RNG — a rejected probe must not move the seed stream", () => {
    const s = base();
    const accepted = swap(s, { col: 0, row: 0 }, { col: 1, row: 0 });
    expect(accepted).toBeNull();
    const good = createBoard({ seed: 31 });
    let moved: BoardState | null = null;
    outer: for (let row = 0; row < good.rows; row++) {
      for (let col = 0; col < good.cols; col++) {
        const r =
          swap(good, { col, row }, { col: col + 1, row }) ??
          swap(good, { col, row }, { col, row: row + 1 });
        if (r) {
          moved = r.state;
          break outer;
        }
      }
    }
    expect(moved).not.toBeNull();
    expect(moved!.rngState).toBe(good.rngState);
  });
});

describe("refill — CLAUDE.md rule 3 draw order", () => {
  it("draws column by column, top to bottom, one draw per empty cell", () => {
    const E = EMPTY;
    // Holes at (0,0), (0,1), (2,0), (2,2) — deliberately NOT in row-major
    // order, so a row-major implementation lands different colours in
    // different cells and this test fails.
    const s = board(3, 3, 5, [
      E, 1, E,
      E, 2, 3,
      0, 1, E,
    ], 24680);

    // Independently derive what the documented order must produce.
    let rng = s.rngState;
    const expected: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = rngInt(rng, 5);
      rng = r.state;
      expected.push(r.value);
    }
    // If every draw came back the same the test could not tell orders apart.
    expect(new Set(expected).size).toBeGreaterThan(1);

    const out = refill(s);
    const order: Pos[] = [
      { col: 0, row: 0 },
      { col: 0, row: 1 },
      { col: 2, row: 0 },
      { col: 2, row: 2 },
    ];
    order.forEach((p, i) => {
      expect(out.state.grid[p.row * 3 + p.col], `cell ${p.col},${p.row}`).toBe(expected[i]);
    });
    expect(out.state.rngState).toBe(rng);

    // The event reports the same order the draws happened in.
    expect(eventOf(out.events, "refilled").cells.map((c) => c.pos)).toEqual(order);

    // Untouched cells keep their tiles.
    // oxlint-disable-next-line erasing-op -- row * cols + col, spelled out on purpose
    expect(out.state.grid[0 * 3 + 1]).toBe(1);
    expect(out.state.grid[2 * 3 + 0]).toBe(0);
  });

  it("is a no-op with no events on a full board", () => {
    const s = createBoard({ seed: 8 });
    const out = refill(s);
    expect(out.events).toEqual([]);
    expect(out.state).toEqual(s);
  });

  it("leaves no empty cell behind", () => {
    const s = board(4, 4, 5, new Array<number>(16).fill(EMPTY), 77);
    const out = refill(s);
    expect(out.state.grid.some((t) => t === EMPTY)).toBe(false);
  });
});

describe("resolve", () => {
  // Bottom row is a run of three 0s; nothing else matches.
  const matched = (rngState = 555): BoardState =>
    board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      3, 4, 0, 1, 2,
      4, 0, 1, 2, 3,
      0, 0, 0, 1, 2,
    ], rngState);

  it("clears the run and reports size, colour and depth", () => {
    const out = resolve(matched());
    const step = out.events.find((e) => e.type === "cascadeStep");
    expect(step).toEqual({ type: "cascadeStep", depth: 1, runs: 1, cleared: 3 });

    const cleared = out.events.find((e) => e.type === "tilesCleared");
    expect(cleared).toEqual({
      type: "tilesCleared",
      colour: 0,
      size: 3,
      depth: 1,
      cells: [
        { col: 0, row: 4 },
        { col: 1, row: 4 },
        { col: 2, row: 4 },
      ],
    });
  });

  it("drops tiles downward and refills the holes that open at the top", () => {
    const out = resolve(matched());
    // Everything moves toward a larger row index — gravity is downward.
    const fell = eventOf(out.events, "tilesFell");
    expect(fell.moves.length).toBeGreaterThan(0);
    expect(fell.moves.every((m) => m.to.row > m.from.row && m.to.col === m.from.col)).toBe(true);

    expect(eventOf(out.events, "refilled").cells.map((c) => c.pos)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ]);
  });

  it("leaves a board that is stable and playable", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const out = resolve(matched(seed));
      expect(hasMatches(out.state)).toBe(false);
      expect(hasValidMove(out.state)).toBe(true);
      expect(out.state.grid.some((t) => t === EMPTY)).toBe(false);
    }
  });

  it("does nothing to an already-stable board", () => {
    const s = createBoard({ seed: 4 });
    const out = resolve(s);
    expect(out.events).toEqual([]);
    expect(out.state).toEqual(s);
  });

  it("counts an L-shape's shared tile once", () => {
    // Row 2 = 0,0,0 and column 0 rows 2..4 = 0,0,0; they share (0,2).
    // Two runs, three cells each, five distinct tiles cleared.
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      0, 0, 0, 1, 2,
      0, 4, 1, 2, 3,
      0, 2, 4, 1, 2,
    ], 31337);
    const out = resolve(s);
    const step = out.events.find((e) => e.type === "cascadeStep");
    expect(step).toEqual({ type: "cascadeStep", depth: 1, runs: 2, cleared: 5 });
    const sizes = out.events.filter((e) => e.type === "tilesCleared" && e.depth === 1);
    expect(sizes.length).toBe(2);
  });

  it("scans horizontal runs before vertical ones", () => {
    const s = board(5, 5, 5, [
      1, 2, 3, 4, 0,
      2, 3, 4, 0, 1,
      0, 0, 0, 1, 2,
      0, 4, 1, 2, 3,
      0, 2, 4, 1, 2,
    ], 31337);
    const out = resolve(s);
    // The horizontal run sits along row 2; the vertical one runs down column 0.
    const first = eventOf(out.events, "tilesCleared");
    expect(first.cells.every((c) => c.row === 2)).toBe(true);
  });
});

describe("cascade guard", () => {
  it("stops a cascade that would otherwise never end", () => {
    // A one-colour board re-matches on every refill, forever. This is the only
    // way to reach the guard; it exists for corrupt saves, not real play.
    const s = board(5, 5, 1, new Array<number>(25).fill(0), 42);
    const out = resolve(s);

    const steps = out.events.filter((e) => e.type === "cascadeStep");
    expect(steps.length).toBe(MAX_CASCADE_DEPTH);
    expect(eventOf(out.events, "cascadeAborted").depth).toBe(MAX_CASCADE_DEPTH);
  });

  it("normal play never comes close to the guard", () => {
    let deepest = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const s = createBoard({ seed });
      let moved: BoardState | null = null;
      outer: for (let row = 0; row < s.rows; row++) {
        for (let col = 0; col < s.cols; col++) {
          const r =
            swap(s, { col, row }, { col: col + 1, row }) ?? swap(s, { col, row }, { col, row: row + 1 });
          if (r) {
            moved = r.state;
            break outer;
          }
        }
      }
      const out = resolve(moved!);
      expect(out.events.some((e) => e.type === "cascadeAborted")).toBe(false);
      for (const e of out.events) if (e.type === "cascadeStep") deepest = Math.max(deepest, e.depth);
    }
    expect(deepest).toBeGreaterThan(1); // cascades do happen
    expect(deepest).toBeLessThan(MAX_CASCADE_DEPTH / 2);
  });
});

describe("hasValidMove", () => {
  it("spots a board with no legal swap", () => {
    // Plain diagonal stripes: every swap yields a pair, never a triple.
    const grid: number[] = [];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) grid.push((col + row) % 5);
    const dead = board(7, 7, 5, grid, 1);
    expect(hasMatches(dead)).toBe(false);
    expect(hasValidMove(dead)).toBe(false);
  });

  it("does not mutate the board it inspects", () => {
    const s = createBoard({ seed: 17 });
    const before = s.grid.slice();
    hasValidMove(s);
    expect(s.grid).toEqual(before);
  });
});

describe("shuffle", () => {
  const stuck = (): BoardState => {
    const grid: number[] = [];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) grid.push((col + row) % 5);
    return board(7, 7, 5, grid, 2024);
  };

  it("rescues a dead board and reports it", () => {
    const out = shuffle(stuck());
    expect(out.events).toEqual([{ type: "shuffled", reason: "stuck" }]);
    expect(hasMatches(out.state)).toBe(false);
    expect(hasValidMove(out.state)).toBe(true);
  });

  it("preserves the tile multiset — a shuffle rearranges, it does not re-deal", () => {
    const s = stuck();
    const out = shuffle(s);
    const count = (g: number[]): number[] => {
      const c = new Array<number>(5).fill(0);
      for (const t of g) c[t]!++;
      return c;
    };
    expect(count(out.state.grid)).toEqual(count(s.grid));
  });

  it("is deterministic and advances the RNG", () => {
    const a = shuffle(stuck());
    const b = shuffle(stuck());
    expect(a.state).toEqual(b.state);
    expect(a.state.rngState).not.toBe(stuck().rngState);
  });

  it("produces a pinned arrangement — the shuffle order is part of the seed contract", () => {
    // Two players on the same daily seed who both get stuck must be handed the
    // same rescue board. Without this pin, reordering the Fisher-Yates loop
    // would silently desync them: every other shuffle test passes for any
    // permutation order, because they only assert invariants.
    const out = shuffle(stuck());
    expect(out.state.grid.join("")).toBe("3003400144223240413403012441022121103313121402321");
    expect(out.state.rngState).toBe(608194088);
  });

  it("resolve rescues a stuck board on its own", () => {
    const out = resolve(stuck());
    expect(out.events.some((e) => e.type === "shuffled")).toBe(true);
    expect(hasValidMove(out.state)).toBe(true);
  });
});

describe("fallbackGrid — the never-a-dead-board guarantee", () => {
  it("is match-free and playable at every size the game uses", () => {
    for (const [cols, rows, colours] of [
      [DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_COLOURS],
      [5, 5, 5],
      [8, 8, 5],
      [3, 3, 3],
      [7, 9, 4],
    ] as const) {
      const s = board(cols, rows, colours, fallbackGrid(cols, rows, colours), 0);
      expect(hasMatches(s), `${cols}x${rows}x${colours} fallback has a match`).toBe(false);
      expect(hasValidMove(s), `${cols}x${rows}x${colours} fallback is dead`).toBe(true);
    }
  });
});

describe("validateBoard", () => {
  it("accepts a real board unchanged", () => {
    const s = createBoard({ seed: 21 });
    expect(validateBoard(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("rejects anything structurally broken rather than guessing", () => {
    const s = createBoard({ seed: 21 });
    const bad: unknown[] = [
      null,
      "board",
      {},
      { ...s, grid: s.grid.slice(0, 10) }, // wrong length
      { ...s, grid: s.grid.map(() => 99) }, // colour out of range
      { ...s, grid: s.grid.map(() => -1) }, // EMPTY is not a saveable tile
      { ...s, cols: 0 },
      { ...s, cols: 1000 },
      { ...s, colours: TILE_COLOURS.length + 1 },
      { ...s, rngState: "x" },
      { ...s, rngState: Number.NaN },
    ];
    for (const raw of bad) expect(validateBoard(raw)).toBeNull();
  });

  it("coerces rngState back into int32, which is what the RNG contract assumes", () => {
    const s = createBoard({ seed: 21 });
    const out = validateBoard({ ...s, rngState: 2 ** 40 + 7 });
    expect(out).not.toBeNull();
    expect(Number.isInteger(out!.rngState)).toBe(true);
    expect(out!.rngState).toBe((2 ** 40 + 7) | 0);
  });
});
