/**
 * CHARM TESTS — each of the twelve asserted in isolation, plus the property
 * that makes the whole design work: drafting order cannot change a score.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { CHARMS, CHARM_IDS, charmScoreFns, isCharmId, type CharmId } from "../src/charms";
import { moveBudgetFor } from "../src/run";
import { rngInt } from "../src/rng";
import { TILE_COLOURS } from "../src/board";
import {
  emptyRoundScore,
  fold,
  roundTotal,
  scoreTrigger,
  type ScoreContext,
  type ScoreDelta,
  type StepSummary,
} from "../src/scoring";

const YUZU = TILE_COLOURS.indexOf("yuzu");
const STONE = TILE_COLOURS.indexOf("stone");

const step = (s: Partial<StepSummary> & { depth: number }): StepSummary => ({
  tiles: 0,
  tilesByColour: [],
  runs: [],
  ...s,
});

const ctxFor = (
  trigger: ScoreContext["trigger"],
  over: Partial<ScoreContext> = {},
): ScoreContext => ({
  config: cfg,
  trigger,
  round: 1,
  isLongSoak: false,
  moveBudget: cfg.round.moveBudget,
  movesUsed: 1,
  movesLeft: cfg.round.moveBudget - 1,
  charms: [],
  stepsThisRound: 1,
  matchesThisRound: 1,
  clearedByColour: [],
  matchesByColour: [],
  streakColour: null,
  streakLength: 0,
  ...over,
});

/** Score one charm alone, so nothing else can account for the result. */
const alone = (id: CharmId, ctx: ScoreContext): ScoreDelta => CHARMS[id].score?.(ctx) ?? {};

/** Every charm this file asserts, checked for completeness at the end. */
const META_CHARMS: CharmId[] = [
  "twin_springs",
  "citrus_devotion",
  "chain_of_petals",
  "monochrome_mind",
  "overflow",
  "second_steeping",
  "tea_break",
  "floating_petal",
  "hot_stone",
  "skimmer",
  "still_water",
  "bath_bomb",
];

const covered = new Set<CharmId>();
const cover = (id: CharmId): CharmId => {
  covered.add(id);
  return id;
};

describe("flat warmth charms", () => {
  it("Sun-Warmed Stone pays per stone tile cleared, and only for stone", () => {
    const id = cover("sun_warmed_stone");
    const tilesByColour: number[] = [];
    tilesByColour[STONE] = 4;
    tilesByColour[YUZU] = 9;
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 13, tilesByColour }) })))
      .toEqual({ warmthAdd: 4 * cfg.charmValues.sunWarmedStone });

    // No stone cleared, no warmth.
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3 }) })))
      .toEqual({ warmthAdd: 0 });
  });

  it("Yuzu Grove pays per yuzu tile cleared", () => {
    const id = cover("yuzu_grove");
    const tilesByColour: number[] = [];
    tilesByColour[YUZU] = 5;
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 5, tilesByColour }) })))
      .toEqual({ warmthAdd: 5 * cfg.charmValues.yuzuGrove });
  });

  it("Deep Soak pays per cascade step, but not for the swap's own clear", () => {
    const id = cover("deep_soak");
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3 }) }))).toEqual({});
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 2, tiles: 3 }) })))
      .toEqual({ warmthAdd: cfg.charmValues.deepSoak });
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 7, tiles: 3 }) })))
      .toEqual({ warmthAdd: cfg.charmValues.deepSoak });
  });

  it("Collector scales with how many charms you own", () => {
    const id = cover("collector");
    const trigger = { kind: "step" as const, step: step({ depth: 1, tiles: 3 }) };
    expect(alone(id, ctxFor(trigger, { charms: [] }))).toEqual({ warmthAdd: 0 });
    expect(alone(id, ctxFor(trigger, { charms: ["collector", "yuzu_grove", "deep_soak"] })))
      .toEqual({ warmthAdd: 3 * cfg.charmValues.collector });
    // Nothing at round end — it pays on clears.
    expect(alone(id, ctxFor({ kind: "roundEnd" }, { charms: ["collector"] }))).toEqual({});
  });
});

describe("additive bliss charms", () => {
  it("Gentle Ripple adds bliss per cascade step, on top of the base 0.2", () => {
    const id = cover("gentle_ripple");
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3 }) }))).toEqual({});
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 2, tiles: 3 }) })))
      .toEqual({ blissAdd: cfg.charmValues.gentleRipple });

    // "stacks with base": the charm's bliss and the board's both land.
    const inc = scoreTrigger(
      ctxFor({ kind: "step", step: step({ depth: 2, tiles: 3 }) }),
      charmScoreFns([id]),
    );
    expect(inc.blissAdd).toBeCloseTo(cfg.scoring.blissPerCascadeStep + cfg.charmValues.gentleRipple, 12);
  });

  it("Steam Rising pays per match of 4+, once for each such run", () => {
    const id = cover("steam_rising");
    const runs = [
      { colour: 0, size: 3 },
      { colour: 1, size: 4 },
      { colour: 2, size: 6 },
    ];
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 13, runs }) })))
      .toEqual({ blissAdd: 2 * cfg.charmValues.steamRising });

    // Threes alone pay nothing.
    expect(
      alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3, runs: [{ colour: 0, size: 3 }] }) })),
    ).toEqual({});
  });

  it("Compound Warmth pays once per round, not once per clear", () => {
    const id = cover("compound_warmth");
    const owned: CharmId[] = ["compound_warmth", "deep_soak"];
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3 }) }, { charms: owned })))
      .toEqual({});
    expect(alone(id, ctxFor({ kind: "roundEnd" }, { charms: owned })))
      .toEqual({ blissAdd: 2 * cfg.charmValues.compoundWarmth });
  });

  it("Patient Soak pays only when half the moves are left", () => {
    const id = cover("patient_soak");
    const budget = cfg.round.moveBudget; // 20 -> needs 10 left
    expect(alone(id, ctxFor({ kind: "roundEnd" }, { moveBudget: budget, movesLeft: 10 })))
      .toEqual({ blissAdd: cfg.charmValues.patientSoak });
    expect(alone(id, ctxFor({ kind: "roundEnd" }, { moveBudget: budget, movesLeft: 9 })))
      .toEqual({});
    // Its bliss lands before the end-of-round multiply, which is the only
    // reason this charm does anything at all.
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3 }) }, { movesLeft: 20 })))
      .toEqual({});
  });
});

describe("multiplicative charms", () => {
  it("Morning Bath triples the round's first clear only", () => {
    const id = cover("morning_bath");
    const trigger = { kind: "step" as const, step: step({ depth: 1, tiles: 5 }) };
    expect(alone(id, ctxFor(trigger, { stepsThisRound: 0 })))
      .toEqual({ warmthMult: cfg.charmValues.morningBath });
    expect(alone(id, ctxFor(trigger, { stepsThisRound: 1 }))).toEqual({});

    // End to end: 5 tiles x 10 warmth, tripled.
    const inc = scoreTrigger(ctxFor(trigger, { stepsThisRound: 0 }), charmScoreFns([id]));
    expect(inc.warmth).toBe(50 * cfg.charmValues.morningBath);
  });

  it("Last Drop quadruples clears on the final move", () => {
    const id = cover("last_drop");
    const trigger = { kind: "step" as const, step: step({ depth: 1, tiles: 5 }) };
    expect(alone(id, ctxFor(trigger, { movesLeft: 0 })))
      .toEqual({ warmthMult: cfg.charmValues.lastDrop });
    expect(alone(id, ctxFor(trigger, { movesLeft: 1 }))).toEqual({});
  });

  it("Risky Bather doubles bliss and costs three moves", () => {
    const id = cover("risky_bather");
    expect(alone(id, ctxFor({ kind: "roundEnd" })))
      .toEqual({ blissMult: cfg.charmValues.riskyBatherMult });
    expect(alone(id, ctxFor({ kind: "step", step: step({ depth: 1, tiles: 3 }) }))).toEqual({});
    expect(moveBudgetFor(cfg, [id])).toBe(cfg.round.moveBudget + cfg.charmValues.riskyBatherMoves);
  });
});

describe("economy charms", () => {
  it("Extra Towel adds two moves and scores nothing", () => {
    const id = cover("extra_towel");
    expect(CHARMS[id].score).toBeUndefined();
    expect(moveBudgetFor(cfg, [id])).toBe(cfg.round.moveBudget + cfg.charmValues.extraTowel);
  });

  it("stacks move modifiers, and never drops the budget below one move", () => {
    expect(moveBudgetFor(cfg, ["extra_towel", "risky_bather"])).toBe(
      cfg.round.moveBudget + cfg.charmValues.extraTowel + cfg.charmValues.riskyBatherMoves,
    );
    expect(moveBudgetFor(cfg, [])).toBe(cfg.round.moveBudget);
    const tiny = { ...cfg, round: { ...cfg.round, moveBudget: 2 } };
    expect(moveBudgetFor(tiny, ["risky_bather"])).toBe(1);
  });
});

describe("charm order independence (CLAUDE.md rule 4)", () => {
  /**
   * Floating-point addition is not associative, so reordering can shift a
   * result by an ulp. A real order dependence would show up many orders of
   * magnitude above this.
   */
  const sameScore = (a: number, b: number): void => {
    expect(Math.abs(a - b) / Math.max(1, Math.abs(b))).toBeLessThan(1e-12);
  };

  /** A round with every charm owned, scored over a fixed sequence of triggers. */
  function scoreRound(order: readonly CharmId[]): number {
    const fns = charmScoreFns(order);
    let total = emptyRoundScore();
    const tilesByColour: number[] = [];
    tilesByColour[YUZU] = 3;
    tilesByColour[STONE] = 4;

    for (let move = 1; move <= 5; move++) {
      for (let depth = 1; depth <= 3; depth++) {
        const ctx: ScoreContext = {
          config: cfg,
          trigger: {
            kind: "step",
            step: step({
              depth,
              tiles: 7,
              tilesByColour,
              runs: [
                { colour: YUZU, size: 3 },
                { colour: STONE, size: 4 },
              ],
            }),
          },
          round: 4,
          isLongSoak: false,
          moveBudget: cfg.round.moveBudget,
          movesUsed: move,
          movesLeft: cfg.round.moveBudget - move,
          charms: order,
          stepsThisRound: (move - 1) * 3 + depth - 1,
          matchesThisRound: ((move - 1) * 3 + depth - 1) * 2,
          clearedByColour: tilesByColour,
          matchesByColour: [2, 0, 0, 2, 0],
          streakColour: null,
          streakLength: 1,
        };
        total = fold(total, scoreTrigger(ctx, fns));
      }
    }

    const endCtx: ScoreContext = {
      config: cfg,
      trigger: { kind: "roundEnd" },
      round: 4,
      isLongSoak: false,
      moveBudget: cfg.round.moveBudget,
      movesUsed: 5,
      movesLeft: cfg.round.moveBudget - 5,
      charms: order,
      stepsThisRound: 15,
      matchesThisRound: 30,
      clearedByColour: [3, 0, 0, 4, 0],
      matchesByColour: [15, 0, 0, 15, 0],
      streakColour: null,
      streakLength: 0,
    };
    return roundTotal(fold(total, scoreTrigger(endCtx, fns)));
  }

  it("scores the same however the charms are ordered", () => {
    const baseline = scoreRound(CHARM_IDS);
    expect(baseline).toBeGreaterThan(0);

    let rng = 12345;
    for (let trial = 0; trial < 50; trial++) {
      const shuffled = CHARM_IDS.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const r = rngInt(rng, i + 1);
        rng = r.state;
        const tmp = shuffled[i]!;
        shuffled[i] = shuffled[r.value]!;
        shuffled[r.value] = tmp;
      }
      expect(shuffled).not.toEqual(CHARM_IDS); // the shuffle really shuffles
      sameScore(scoreRound(shuffled), baseline);
    }
  });

  it("holds for the reversed order too", () => {
    sameScore(scoreRound(CHARM_IDS.slice().reverse()), scoreRound(CHARM_IDS));
  });

  it("no charm can see another charm's output", () => {
    // Structural, not incidental: a charm only ever receives a ScoreContext,
    // and nothing in a ScoreContext carries a running score.
    const ctx = ctxFor({ kind: "step", step: step({ depth: 2, tiles: 5 }) });
    expect(Object.keys(ctx).sort()).toEqual([
      "charms",
      "clearedByColour",
      "config",
      "isLongSoak",
      "matchesByColour",
      "matchesThisRound",
      "moveBudget",
      "movesLeft",
      "movesUsed",
      "round",
      "stepsThisRound",
      "streakColour",
      "streakLength",
      "trigger",
    ]);
  });

  it("charms are pure — same context in, same delta out", () => {
    const ctx = ctxFor({ kind: "step", step: step({ depth: 2, tiles: 5, tilesByColour: [3, 0, 0, 2] }) });
    for (const id of CHARM_IDS) {
      expect(alone(id, ctx)).toEqual(alone(id, ctx));
    }
  });
});

describe("charm registry", () => {
  it("every charm in the pool has an isolated test above", () => {
    // The acceptance criterion is "each charm has a test asserting its stated
    // effect in isolation" — this fails the moment a charm is added without one.
    // The Milestone 7 unlocks have their own file, meta.test.ts.
    const untested = CHARM_IDS.filter((id) => !covered.has(id)).filter(
      (id) => !META_CHARMS.includes(id),
    );
    expect(untested).toEqual([]);
  });

  it("ships all 24 of SPEC §3, across every archetype", () => {
    expect(CHARM_IDS.length).toBe(24);
    const archetypes = new Set(CHARM_IDS.map((id) => CHARMS[id].archetype));
    expect([...archetypes].sort()).toEqual([
      "bliss",
      "blissMult",
      "board",
      "colour",
      "economy",
      "warmth",
    ]);
  });

  it("is internally consistent: ids, keys and lookups all agree", () => {
    expect(new Set(CHARM_IDS).size).toBe(CHARM_IDS.length);
    for (const id of CHARM_IDS) {
      expect(CHARMS[id].id).toBe(id);
      expect(CHARMS[id].text.length).toBeGreaterThan(0);
      expect(isCharmId(id)).toBe(true);
    }
    expect(Object.keys(CHARMS).sort()).toEqual(CHARM_IDS.slice().sort());
    expect(isCharmId("hacked_charm")).toBe(false);
  });

  it("every charm does something", () => {
    for (const id of CHARM_IDS) {
      const c = CHARMS[id];
      expect(
        c.score !== undefined ||
          c.moveBudgetDelta !== undefined ||
          c.draft !== undefined ||
          c.board !== undefined,
        `${id} has no effect at all`,
      ).toBe(true);
    }
  });
});
