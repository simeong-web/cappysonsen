/**
 * SCORING — ACCEPTANCE TESTS.
 *
 * The literals here were read out of `docs/onsen_balance.xlsx` after Excel
 * recalculated it. They are the contract (CLAUDE.md: "treat their numbers as
 * the contract"). If one fails, either config.ts drifted from the sheet or the
 * pipeline changed shape — fix the code, or retune the sheet and copy the new
 * numbers here deliberately. Never nudge a literal to make a test pass.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg, roundTarget, isLongSoak } from "../src/config";
import {
  baseDelta,
  blissOf,
  emptyRoundScore,
  fold,
  roundTotal,
  scoreTrigger,
  summariseSteps,
  type ScoreContext,
  type StepSummary,
} from "../src/scoring";
import { createBoard, resolve, swap, type BoardEvent, type Pos } from "../src/board";
import { rngInt } from "../src/rng";

// ── The sheet's Assumptions that the sim itself does not hold ──────────────
// These model an average board; the engine has no notion of them. They are
// repeated here so the derived rows can be recomputed and checked.
const SHEET = {
  matchP3: 0.7,
  matchP4: 0.22,
  matchP5: 0.08,
  tiles5Plus: 5.4,
  cascadeSteps: 0.6,
  cascadeTiles: 3.3,
  skill: 0.8,
  // Derived rows, as Excel computed them.
  tilesInMatch: 3.412,
  tilesPerMove: 5.392,
  warmthPerMove: 64.22,
  blissPerMove: 0.12,
  roundBliss: 3.4,
};

const step = (s: Partial<StepSummary> & { depth: number }): StepSummary => ({
  tiles: 0,
  tilesByColour: [],
  runs: [],
  ...s,
});

const ctxFor = (trigger: ScoreContext["trigger"], over: Partial<ScoreContext> = {}): ScoreContext => ({
  config: cfg,
  trigger,
  round: 1,
  isLongSoak: false,
  moveBudget: cfg.round.moveBudget,
  movesUsed: 1,
  movesLeft: cfg.round.moveBudget - 1,
  charms: [],
  stepsThisRound: 0,
  matchesThisRound: 0,
  clearedByColour: [],
  matchesByColour: [],
  streakColour: null,
  streakLength: 0,
  ...over,
});

describe("acceptance — config mirrors the workbook", () => {
  it("carries the Assumptions sheet's scoring values", () => {
    expect(cfg.scoring.warmthPerTile).toBe(10); // B14
    expect(cfg.scoring.match4Bonus).toBe(25); // B15
    expect(cfg.scoring.match5Bonus).toBe(60); // B16
    expect(cfg.scoring.blissPerCascadeStep).toBe(0.2); // B17
    expect(cfg.round.moveBudget).toBe(20); // B20
    expect(cfg.round.targetBase).toBe(1400); // B30
    expect(cfg.round.targetGrowth).toBe(1.6); // B31
    expect(cfg.round.longSoakEvery).toBe(3); // B34
  });

  it("reproduces the sheet's derived rows from those values", () => {
    const tilesInMatch = 3 * SHEET.matchP3 + 4 * SHEET.matchP4 + SHEET.tiles5Plus * SHEET.matchP5;
    expect(tilesInMatch).toBeCloseTo(SHEET.tilesInMatch, 9); // B47

    const tilesPerMove = tilesInMatch + SHEET.cascadeSteps * SHEET.cascadeTiles;
    expect(tilesPerMove).toBeCloseTo(SHEET.tilesPerMove, 9); // B48

    const warmthPerMove =
      tilesPerMove * cfg.scoring.warmthPerTile +
      SHEET.matchP4 * cfg.scoring.match4Bonus +
      SHEET.matchP5 * cfg.scoring.match5Bonus;
    expect(warmthPerMove).toBeCloseTo(SHEET.warmthPerMove, 9); // B49

    const blissPerMove = SHEET.cascadeSteps * cfg.scoring.blissPerCascadeStep;
    expect(blissPerMove).toBeCloseTo(SHEET.blissPerMove, 9); // B50

    const roundBliss = 1 + blissPerMove * cfg.round.moveBudget;
    expect(roundBliss).toBeCloseTo(SHEET.roundBliss, 9); // B51
  });
});

describe("acceptance — round targets pin to the Rounds sheet", () => {
  it("matches column H for rounds 1-15", () => {
    // Read out of Excel after a full recalculation.
    const sheet = [
      1400, 2240, 3584.000000000001, 5734.4000000000015, 9175.04, 14680.064000000004,
      23488.10240000001, 37580.96384000001, 60129.54214400003, 96207.26743040004,
      153931.6278886401, 246290.60462182414, 394064.9673949186, 630503.9478318698,
      1008806.3165309919,
    ];
    sheet.forEach((expected, i) => {
      expect(roundTarget(cfg, i + 1), `round ${i + 1}`).toBeCloseTo(expected, 6);
    });
  });

  it("is closed form — a target needs no simulation to compute", () => {
    // The /daily/N pages and the share grid both need this without replaying.
    expect(roundTarget(cfg, 9)).toBeCloseTo(cfg.round.targetBase * cfg.round.targetGrowth ** 8, 6);
  });

  it("flags every 3rd round as a Long Soak", () => {
    const soaks = [];
    for (let r = 1; r <= 15; r++) if (isLongSoak(cfg, r)) soaks.push(r);
    expect(soaks).toEqual([3, 6, 9, 12, 15]);
  });
});

describe("acceptance — the model round scores what the sheet says", () => {
  it("reaches the sheet's round-1 expected score", () => {
    // The sheet's average round: 20 moves, 5.392 tiles cleared per move with
    // the match-4/5 bonus mix, and 0.6 follow-on cascade steps per move.
    // Rebuilt here through the real pipeline, one move at a time.
    const moves = cfg.round.moveBudget;
    let total = emptyRoundScore();

    for (let m = 1; m <= moves; m++) {
      // The move's own clear (depth 1 — no cascade bliss).
      total = fold(
        total,
        scoreTrigger(
          ctxFor({
            kind: "step",
            step: step({ depth: 1, tiles: SHEET.tilesPerMove, runs: [] }),
          }),
          [],
        ),
      );
      // Its share of the match-4/5 bonuses, and its 0.6 of a cascade step.
      // Modelled as fractional so the average board can be expressed exactly.
      total = fold(total, {
        warmth: SHEET.matchP4 * cfg.scoring.match4Bonus + SHEET.matchP5 * cfg.scoring.match5Bonus,
        blissAdd: SHEET.cascadeSteps * cfg.scoring.blissPerCascadeStep,
        blissMult: 1,
      });
    }

    expect(total.warmth / moves).toBeCloseTo(SHEET.warmthPerMove, 9); // B49
    expect(blissOf(total)).toBeCloseTo(SHEET.roundBliss, 9); // B51

    // Rounds!G5 = warmth x bliss x skill. The sim has no skill factor — that is
    // a property of the player, not the game — so it is applied here.
    expect(roundTotal(total) * SHEET.skill).toBeCloseTo(3493.568, 6);
  });

  it("multiplies once at the end, not per match", () => {
    // The rejected model would score sum(warmth_i x bliss_i) and land lower.
    // This asserts the shape of the pipeline, not just its output.
    let total = emptyRoundScore();
    total = fold(total, { warmth: 100, blissAdd: 0, blissMult: 1 });
    total = fold(total, { warmth: 100, blissAdd: 1, blissMult: 1 });
    // Accumulate-then-multiply: (100 + 100) x (1 + 1) = 400.
    // Per-match would have been 100x1 + 100x2 = 300.
    expect(roundTotal(total)).toBe(400);
  });
});

describe("base scoring — SPEC §2 table", () => {
  it("pays warmth per distinct tile cleared", () => {
    const d = baseDelta(cfg, { kind: "step", step: step({ depth: 1, tiles: 7 }) });
    expect(d.warmthAdd).toBe(70);
  });

  it("pays the match-4 and match-5+ bonuses on top, per run", () => {
    const runs = [
      { colour: 0, size: 3 },
      { colour: 1, size: 4 },
      { colour: 2, size: 6 },
    ];
    const d = baseDelta(cfg, { kind: "step", step: step({ depth: 1, tiles: 13, runs }) });
    expect(d.warmthAdd).toBe(130 + 25 + 60); // no bonus for the 3
  });

  it("pays cascade bliss on follow-on clears only", () => {
    // Depth 1 is the player's own swap. Paying bliss there would hand every
    // move a free +0.2 and shift the whole curve.
    expect(baseDelta(cfg, { kind: "step", step: step({ depth: 1, tiles: 3 }) }).blissAdd).toBe(0);
    expect(baseDelta(cfg, { kind: "step", step: step({ depth: 2, tiles: 3 }) }).blissAdd).toBe(0.2);
    expect(baseDelta(cfg, { kind: "step", step: step({ depth: 5, tiles: 3 }) }).blissAdd).toBe(0.2);
  });

  it("scores nothing by itself at round end", () => {
    expect(baseDelta(cfg, { kind: "roundEnd" })).toEqual({});
  });

  it("starts bliss at 1.0 each round (SPEC §2)", () => {
    expect(blissOf(emptyRoundScore())).toBe(1);
    expect(roundTotal(emptyRoundScore())).toBe(0);
  });
});

describe("summariseSteps — reconciling the board's event stream", () => {
  const cell = (col: number, row: number) => ({ col, row });

  it("counts an L-shape's shared tile once, but keeps both run sizes", () => {
    // The exact shape board.ts emits for an L: two runs, one shared cell.
    const events: BoardEvent[] = [
      { type: "cascadeStep", depth: 1, runs: 2, cleared: 5 },
      {
        type: "tilesCleared",
        colour: 0,
        size: 3,
        depth: 1,
        cells: [cell(0, 2), cell(1, 2), cell(2, 2)],
      },
      {
        type: "tilesCleared",
        colour: 0,
        size: 3,
        depth: 1,
        cells: [cell(0, 2), cell(0, 3), cell(0, 4)],
      },
    ];
    const [s] = summariseSteps(events);
    expect(s!.tiles).toBe(5); // not 6
    expect(s!.runs.map((r) => r.size)).toEqual([3, 3]);
    expect(s!.tilesByColour[0]).toBe(5);

    // Per-tile warmth follows the distinct count; bonuses follow the runs.
    expect(baseDelta(cfg, { kind: "step", step: s! }).warmthAdd).toBe(50);
  });

  it("agrees with the board's own cleared count", () => {
    const events: BoardEvent[] = [
      { type: "cascadeStep", depth: 1, runs: 1, cleared: 3 },
      { type: "tilesCleared", colour: 2, size: 3, depth: 1, cells: [cell(0, 0), cell(1, 0), cell(2, 0)] },
      { type: "cascadeStep", depth: 2, runs: 1, cleared: 4 },
      {
        type: "tilesCleared",
        colour: 3,
        size: 4,
        depth: 2,
        cells: [cell(0, 1), cell(1, 1), cell(2, 1), cell(3, 1)],
      },
    ];
    const steps = summariseSteps(events);
    const counts = events.filter((e) => e.type === "cascadeStep").map((e) => e.cleared);
    expect(steps.map((s) => s.tiles)).toEqual(counts);
  });

  it("splits tiles by colour for the colour charms", () => {
    const events: BoardEvent[] = [
      { type: "cascadeStep", depth: 1, runs: 2, cleared: 7 },
      { type: "tilesCleared", colour: 0, size: 3, depth: 1, cells: [cell(0, 0), cell(1, 0), cell(2, 0)] },
      {
        type: "tilesCleared",
        colour: 3,
        size: 4,
        depth: 1,
        cells: [cell(0, 1), cell(1, 1), cell(2, 1), cell(3, 1)],
      },
    ];
    const [s] = summariseSteps(events);
    expect(s!.tilesByColour[0]).toBe(3);
    expect(s!.tilesByColour[3]).toBe(4);
    expect(s!.tilesByColour[1]).toBe(0);
  });

  it("returns nothing for a move that cleared nothing", () => {
    expect(summariseSteps([{ type: "swapped", a: cell(0, 0), b: cell(1, 0) }])).toEqual([]);
  });

  it("reconciles against real board output, L-shapes and all", () => {
    // The tests above feed hand-built events. This one plays the actual engine,
    // so the two modules' idea of "a tile cleared" has to agree in the wild —
    // including on the real L and T shapes that cascades throw up.
    let seenL = 0;
    let steps = 0;
    for (let seed = 1; seed <= 20; seed++) {
      let board = createBoard({ seed });
      let script = seed * 17;
      for (let move = 0; move < 20; move++) {
        const options: [Pos, Pos][] = [];
        for (let row = 0; row < board.rows; row++) {
          for (let col = 0; col < board.cols; col++) {
            const a = { col, row };
            const right = { col: col + 1, row };
            const down = { col, row: row + 1 };
            if (col + 1 < board.cols && swap(board, a, right)) options.push([a, right]);
            if (row + 1 < board.rows && swap(board, a, down)) options.push([a, down]);
          }
        }
        const pick = rngInt(script, options.length);
        script = pick.state;
        const [a, b] = options[pick.value]!;
        const out = resolve(swap(board, a, b)!.state);
        board = out.state;

        const summaries = summariseSteps(out.events);
        const reported = out.events.filter((e) => e.type === "cascadeStep");
        expect(summaries.map((s) => s.depth)).toEqual(reported.map((e) => e.depth));
        for (let i = 0; i < summaries.length; i++) {
          const s = summaries[i]!;
          steps++;
          // The distinct count must match what the board itself counted...
          expect(s.tiles).toBe(reported[i]!.cleared);
          // ...and the per-colour breakdown must add back up to it.
          expect(s.tilesByColour.reduce((x, y) => x + y, 0)).toBe(s.tiles);
          // Summing run sizes over-counts exactly when runs intersect.
          const runSum = s.runs.reduce((x, r) => x + r.size, 0);
          expect(runSum).toBeGreaterThanOrEqual(s.tiles);
          if (runSum > s.tiles) seenL++;
        }
      }
    }
    expect(steps).toBeGreaterThan(100);
    // If this ever hits zero the L-shape handling above is untested in practice.
    expect(seenL).toBeGreaterThan(0);
  });
});
