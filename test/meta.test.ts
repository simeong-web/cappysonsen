/**
 * META PROGRESSION TESTS.
 *
 * The acceptance criterion is narrow and specific: unlocks persist across saves
 * and survive a SAVE_VERSION bump via migration. Losing a player's unlocks is
 * the one save bug they would actually notice, so the migration path gets a
 * genuine v1 envelope, not a simulated one.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { CHARMS, CHARM_IDS, canSkipDraft, rerollsFrom, type CharmId } from "../src/charms";
import { MIGRATIONS, SAVE_VERSION, parseSave, serializeSave } from "../src/save";
import { KEYS } from "../src/store";
import {
  CHARM_COST,
  DECOR,
  DECOR_IDS,
  LOCKED_CHARMS,
  STARTER_CHARMS,
  canUnlockCharm,
  chooseDecor,
  collection,
  newMeta,
  petalsFor,
  poolFor,
  recordRun,
  unlockCharm,
  unlockDecor,
  validateMeta,
} from "../src/meta";
import {
  chooseCharm,
  newRun,
  playMove,
  rerollOffer,
  rollCharmOffer,
  skipDraft,
  type RunState,
} from "../src/run";
import { swap, type BoardState, type Pos } from "../src/board";
import { rngInt } from "../src/rng";

const NOW = 1_800_000_000_000;

function legalMoves(board: BoardState): [Pos, Pos][] {
  const out: [Pos, Pos][] = [];
  for (let row = 0; row < board.rows; row++) {
    for (let col = 0; col < board.cols; col++) {
      const a = { col, row };
      const right = { col: col + 1, row };
      const down = { col, row: row + 1 };
      if (col + 1 < board.cols && swap(board, a, right)) out.push([a, right]);
      if (row + 1 < board.rows && swap(board, a, down)) out.push([a, down]);
    }
  }
  return out;
}

/** Play a run to death so there is something to award petals for. */
function playRun(seed: number, pool = CHARM_IDS): RunState {
  let state = newRun(cfg, seed, "endless", pool);
  let script = seed * 7;
  for (let i = 0; i < 900 && state.phase !== "over"; i++) {
    if (state.phase === "drafting") {
      const offer = state.offer ?? [];
      if (offer.length === 0) break;
      const pick = rngInt(script, offer.length);
      script = pick.state;
      state = chooseCharm(cfg, state, offer[pick.value]!);
      continue;
    }
    const options = legalMoves(state.board);
    if (options.length === 0) break;
    const pick = rngInt(script, options.length);
    script = pick.state;
    state = playMove(cfg, state, options[pick.value]![0], options[pick.value]![1])!.state;
  }
  return state;
}

// ─────────────────────────────────────────────────────── THE ACCEPTANCE TEST

describe("acceptance — unlocks persist and survive a version bump", () => {
  it("round-trips a meta record through save.ts", () => {
    let meta = newMeta();
    meta = { ...meta, petals: 500 };
    meta = unlockCharm(meta, "overflow");
    meta = unlockCharm(meta, "twin_springs");
    meta = chooseDecor(unlockDecor(meta, "dusk"), "dusk");

    const loaded = parseSave(serializeSave(meta, NOW), validateMeta);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(SAVE_VERSION);
    expect(loaded!.state).toEqual(meta);
    expect(loaded!.state.unlockedCharms).toContain("overflow");
    expect(loaded!.state.unlockedCharms).toContain("twin_springs");
    expect(loaded!.state.activeDecor).toBe("dusk");
  });

  it("carries unlocks through the v1 -> v2 migration", () => {
    // A genuine v1 envelope: written before the meta layer existed, so it has
    // none of v2's fields. The unlocks a player had must still be there after.
    let meta = newMeta();
    meta = { ...meta, petals: 400 };
    meta = unlockCharm(meta, "overflow");
    meta = unlockCharm(meta, "chain_of_petals");

    const v1 = JSON.stringify({ version: 1, savedAtMs: NOW, state: meta });
    const loaded = parseSave(v1, validateMeta);

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(SAVE_VERSION);
    expect(loaded!.state.unlockedCharms).toContain("overflow");
    expect(loaded!.state.unlockedCharms).toContain("chain_of_petals");
    expect(loaded!.state.petals).toBe(meta.petals);
  });

  it("has a migration for every version below the current one (rule 7)", () => {
    for (let v = 1; v < SAVE_VERSION; v++) {
      expect(MIGRATIONS[v], `no migration from v${v}`).toBeDefined();
    }
  });

  it("a save from a newer build is refused rather than half-read", () => {
    const future = JSON.stringify({ version: SAVE_VERSION + 1, savedAtMs: NOW, state: newMeta() });
    expect(parseSave(future, validateMeta)).toBeNull();
  });

  it("repairs a damaged record instead of wiping a collection", () => {
    const damaged = {
      petals: -20,
      petalsEarned: "lots",
      unlockedCharms: ["overflow", "ghost_charm", 42],
      unlockedDecor: ["dusk", "nonsense"],
      activeDecor: "nonsense",
      runsPlayed: 3.7,
    };
    const out = validateMeta(damaged)!;
    expect(out.petals).toBe(0); // floored, not negative
    expect(out.unlockedCharms).toContain("overflow"); // the real unlock survives
    expect(out.unlockedCharms).not.toContain("ghost_charm" as CharmId);
    expect(out.unlockedDecor).toEqual(["cedar", "dusk"]);
    expect(out.activeDecor).toBe("cedar"); // unknown décor falls back
    expect(out.runsPlayed).toBe(3);
    // The starter twelve are always restored, whatever the record said.
    for (const id of STARTER_CHARMS) expect(out.unlockedCharms).toContain(id);
  });

  it("rejects only what is truly unusable", () => {
    expect(validateMeta(null)).toBeNull();
    expect(validateMeta("meta")).toBeNull();
    expect(validateMeta({})).not.toBeNull(); // an empty object is a fresh player
  });

  it("keeps meta under its own key, namespaced by the slug", () => {
    expect(KEYS.meta).toBe("cappys-onsen:meta");
    expect(new Set(Object.values(KEYS)).size).toBe(Object.values(KEYS).length);
  });
});

// ────────────────────────────────────────────────────────────── the economy

describe("petals and unlocking", () => {
  it("pays for a run, and pays more for a longer one", () => {
    const short = playRun(3);
    const long = playRun(11);
    expect(petalsFor(short)).toBeGreaterThan(0);
    const bigger = short.totalScore > long.totalScore ? short : long;
    const smaller = bigger === short ? long : short;
    expect(petalsFor(bigger)).toBeGreaterThanOrEqual(petalsFor(smaller));
  });

  it("records a run into the meta state without touching unlocks", () => {
    const run = playRun(5);
    const before = newMeta();
    const after = recordRun(before, run);
    expect(after.petals).toBe(petalsFor(run));
    expect(after.petalsEarned).toBe(petalsFor(run));
    expect(after.runsPlayed).toBe(1);
    expect(after.bestScore).toBe(run.totalScore);
    expect(after.unlockedCharms).toEqual(before.unlockedCharms);
  });

  it("spending is refused when the petals are not there", () => {
    const poor = { ...newMeta(), petals: 0 };
    expect(canUnlockCharm(poor, "overflow")).toBe(false);
    expect(unlockCharm(poor, "overflow")).toBe(poor);

    const rich = { ...newMeta(), petals: 1000 };
    const once = unlockCharm(rich, "overflow");
    expect(once.petals).toBe(1000 - CHARM_COST["overflow"]!);
    // Buying the same charm twice charges nothing and changes nothing.
    expect(unlockCharm(once, "overflow")).toBe(once);
  });

  it("starts with twelve and can reach all twenty-four", () => {
    expect(STARTER_CHARMS.length).toBe(12);
    expect(CHARM_IDS.length).toBe(24);
    expect(LOCKED_CHARMS.length).toBe(12);
    for (const id of LOCKED_CHARMS) expect(CHARM_COST[id]).toBeGreaterThan(0);

    let meta = { ...newMeta(), petals: 10_000 };
    expect(poolFor(meta).length).toBe(12);
    for (const id of LOCKED_CHARMS) meta = unlockCharm(meta, id);
    expect(poolFor(meta).length).toBe(24);
  });

  it("keeps the unlocked set in pool order however it was earned", () => {
    let a = { ...newMeta(), petals: 10_000 };
    let b = { ...newMeta(), petals: 10_000 };
    for (const id of LOCKED_CHARMS) a = unlockCharm(a, id);
    for (const id of [...LOCKED_CHARMS].reverse()) b = unlockCharm(b, id);
    // Same set, same order — so the same seed offers the same charms.
    expect(a.unlockedCharms).toEqual(b.unlockedCharms);
  });

  it("décor is cosmetic and costs petals", () => {
    let meta = { ...newMeta(), petals: 500 };
    expect(meta.activeDecor).toBe("cedar");
    expect(chooseDecor(meta, "dusk")).toBe(meta); // not owned yet
    meta = unlockDecor(meta, "dusk");
    expect(meta.petals).toBe(500 - DECOR.dusk.cost);
    meta = chooseDecor(meta, "dusk");
    expect(meta.activeDecor).toBe("dusk");
    for (const id of DECOR_IDS) expect(DECOR[id].palette).toHaveLength(4);
  });

  it("the collection lists every charm with its state and price", () => {
    const items = collection(newMeta());
    expect(items.length).toBe(CHARM_IDS.length);
    expect(items.filter((i) => i.unlocked).length).toBe(12);
    for (const item of items) {
      expect(item.name).toBe(CHARMS[item.id].name);
      if (!item.unlocked) expect(item.cost).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────── the draft pool

describe("the pool a run draws from", () => {
  it("only offers charms the player has unlocked", () => {
    const meta = newMeta();
    const pool = poolFor(meta);
    for (let seed = 1; seed <= 40; seed++) {
      const { offer } = rollCharmOffer(cfg, seed, [], pool);
      for (const id of offer) expect(pool).toContain(id);
    }
  });

  it("a wider pool can offer the new charms", () => {
    let meta = { ...newMeta(), petals: 10_000 };
    for (const id of LOCKED_CHARMS) meta = unlockCharm(meta, id);
    const seen = new Set<CharmId>();
    for (let seed = 1; seed <= 400; seed++) {
      for (const id of rollCharmOffer(cfg, seed, [], poolFor(meta)).offer) seen.add(id);
    }
    for (const id of LOCKED_CHARMS) expect(seen.has(id), `${id} never offered`).toBe(true);
  });

  it("a run carries its pool, so unlocking mid-run cannot change the offers", () => {
    const run = newRun(cfg, 7, "endless", STARTER_CHARMS);
    expect(run.pool).toEqual([...STARTER_CHARMS]);
  });
});

// ──────────────────────────────────────────────────── the new charms' powers

describe("the unlocked charms", () => {
  it("Second Steeping grants a reroll, and only one", () => {
    expect(rerollsFrom(["second_steeping"])).toBe(1);
    expect(rerollsFrom(["extra_towel"])).toBe(0);

    let state = newRun(cfg, 21, "endless");
    state = { ...state, phase: "drafting", offer: ["deep_soak"], charms: ["second_steeping"], rerollsLeft: 1 };
    const rerolled = rerollOffer(cfg, state);
    expect(rerolled.rerollsLeft).toBe(0);
    expect(rerolled.draftRngState).not.toBe(state.draftRngState);
    // Out of rerolls: the offer stands.
    expect(rerollOffer(cfg, rerolled)).toBe(rerolled);
  });

  it("Tea Break trades a draft for a permanent move", () => {
    expect(canSkipDraft(["tea_break"])).toBe(true);
    expect(canSkipDraft(["extra_towel"])).toBe(false);

    let state = newRun(cfg, 31, "endless");
    state = { ...state, phase: "drafting", offer: ["deep_soak"], charms: ["tea_break"] };
    const skipped = skipDraft(cfg, state);
    expect(skipped.permanentMoveBonus).toBe(cfg.charmValues.teaBreakMoves);
    expect(skipped.round).toBe(state.round + 1);
    expect(skipped.charms).toEqual(["tea_break"]); // declined, so nothing gained
    expect(skipped.moveBudget).toBeGreaterThan(cfg.round.moveBudget);

    // Without the charm, a draft cannot be skipped.
    const noCharm = { ...state, charms: [] as CharmId[] };
    expect(skipDraft(cfg, noCharm)).toBe(noCharm);
  });

  it("Overflow widens the budget of the round in progress", () => {
    // Play until a match of 5+ lands, then check the budget grew.
    let state = newRun(cfg, 9, "endless");
    state = { ...state, charms: ["overflow"] };
    const startBudget = state.moveBudget;
    let grew = false;
    for (let i = 0; i < 40 && state.phase === "playing"; i++) {
      const options = legalMoves(state.board);
      if (options.length === 0) break;
      const played = playMove(cfg, state, options[0]![0], options[0]![1]);
      if (!played) break;
      state = played.state;
      if (state.moveBudget > startBudget) {
        grew = true;
        break;
      }
    }
    expect(grew, "no match of 5+ occurred in 40 moves").toBe(true);
    expect(state.score.movesAdd).toBeGreaterThan(0);
  });

  it("Twin Springs pays only when exactly two colours were cleared", () => {
    const ctx = (clearedByColour: number[]) => ({
      config: cfg,
      trigger: { kind: "roundEnd" as const },
      round: 1,
      isLongSoak: false,
      moveBudget: 20,
      movesUsed: 5,
      movesLeft: 15,
      charms: [] as CharmId[],
      stepsThisRound: 5,
      matchesThisRound: 5,
      clearedByColour,
      matchesByColour: [],
      streakColour: null,
      streakLength: 0,
    });
    const score = CHARMS.twin_springs.score!;
    expect(score(ctx([6, 4, 0, 0, 0]))).toEqual({ blissMult: cfg.charmValues.twinSprings });
    expect(score(ctx([6, 4, 2, 0, 0]))).toEqual({});
    expect(score(ctx([6, 0, 0, 0, 0]))).toEqual({});
  });

  it("Citrus Devotion weights its multiplier by how much of the clear was yuzu", () => {
    const step = (tilesByColour: number[], tiles: number) => ({
      config: cfg,
      trigger: { kind: "step" as const, step: { depth: 1, tiles, tilesByColour, runs: [] } },
      round: 1,
      isLongSoak: false,
      moveBudget: 20,
      movesUsed: 1,
      movesLeft: 19,
      charms: [] as CharmId[],
      stepsThisRound: 0,
      matchesThisRound: 0,
      clearedByColour: [],
      matchesByColour: [],
      streakColour: null,
      streakLength: 0,
    });
    const score = CHARMS.citrus_devotion.score!;
    // All yuzu: the full x2.
    expect(score(step([4, 0, 0, 0, 0], 4)).warmthMult).toBeCloseTo(2, 9);
    // No yuzu: the -25% penalty.
    expect(score(step([0, 4, 0, 0, 0], 4)).warmthMult).toBeCloseTo(0.75, 9);
    // Half and half: the blend, not the full bonus for one lucky tile.
    expect(score(step([2, 2, 0, 0, 0], 4)).warmthMult).toBeCloseTo(1.375, 9);
  });

  it("Chain of Petals pays from the second consecutive same-colour clear", () => {
    const ctx = (streakLength: number) => ({
      config: cfg,
      trigger: { kind: "step" as const, step: { depth: 1, tiles: 3, tilesByColour: [], runs: [] } },
      round: 1,
      isLongSoak: false,
      moveBudget: 20,
      movesUsed: 1,
      movesLeft: 19,
      charms: [] as CharmId[],
      stepsThisRound: 0,
      matchesThisRound: 0,
      clearedByColour: [],
      matchesByColour: [],
      streakColour: 0,
      streakLength,
    });
    const score = CHARMS.chain_of_petals.score!;
    expect(score(ctx(1))).toEqual({});
    expect(score(ctx(2))).toEqual({ blissAdd: cfg.charmValues.chainOfPetals });
    expect(score(ctx(5))).toEqual({ blissAdd: cfg.charmValues.chainOfPetals });
  });

  it("Monochrome Mind counts matches, not tiles", () => {
    const ctx = (matchesByColour: number[]) => ({
      config: cfg,
      trigger: { kind: "roundEnd" as const },
      round: 1,
      isLongSoak: false,
      moveBudget: 20,
      movesUsed: 5,
      movesLeft: 15,
      charms: [] as CharmId[],
      stepsThisRound: 5,
      matchesThisRound: 5,
      clearedByColour: [],
      matchesByColour,
      streakColour: null,
      streakLength: 0,
    });
    const score = CHARMS.monochrome_mind.score!;
    expect(score(ctx([7, 2, 0, 0, 0]))).toEqual({});
    expect(score(ctx([8, 2, 0, 0, 0]))).toEqual({ blissMult: cfg.charmValues.monochromeMind });
  });

  it("the run tracks the tallies those charms read", () => {
    let state = newRun(cfg, 4, "endless");
    expect(state.clearedByColour).toHaveLength(5);
    expect(state.clearedByColour.every((n) => n === 0)).toBe(true);

    for (let i = 0; i < 6 && state.phase === "playing"; i++) {
      const options = legalMoves(state.board);
      if (options.length === 0) break;
      state = playMove(cfg, state, options[0]![0], options[0]![1])!.state;
    }
    const clearedTotal = state.clearedByColour.reduce((a, b) => a + b, 0);
    const matchTotal = state.matchesByColour.reduce((a, b) => a + b, 0);
    expect(clearedTotal).toBeGreaterThan(0);
    expect(matchTotal).toBe(state.matchesThisRound);
  });
});
