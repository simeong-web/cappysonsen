import type { DailyConfig } from "./daily";

/**
 * Balance constants — mirrors `docs/onsen_balance.xlsx` (CLAUDE.md rule 6).
 *
 * Tune in the sheet first, then copy here. Never the other way round: the
 * acceptance tests pin these to sheet-computed values, so drift fails CI.
 *
 * The sheet cell each constant comes from is named in a comment, because the
 * only thing worse than a magic number is a magic number that used to match a
 * spreadsheet.
 */

export interface ScoringConfig {
  /** Assumptions!B14 */
  warmthPerTile: number;
  /** Assumptions!B15 — on top of the per-tile warmth. */
  match4Bonus: number;
  /** Assumptions!B16 — on top of the per-tile warmth. */
  match5Bonus: number;
  /** Assumptions!B17 — awarded per FOLLOW-ON clear (cascade depth >= 2). */
  blissPerCascadeStep: number;
}

export interface RoundConfig {
  /** Assumptions!B20 */
  moveBudget: number;
  /** Assumptions!B30 — the round 1 target. */
  targetBase: number;
  /** Assumptions!B31 — geometric growth per round. */
  targetGrowth: number;
  /** Assumptions!B34 — every Nth round is a Long Soak. */
  longSoakEvery: number;
}

export interface DraftConfig {
  /** Charms offered between rounds. SPEC §1: draft 1 of 3. */
  choiceCount: number;
}

/**
 * Charm numbers, from SPEC §3.
 *
 * NOT YET SHEET-BACKED. Milestone 1 deliberately left charm values out of the
 * workbook ("those tune later against a playable harness"), so these are the
 * spec's opening bids. Milestone 4 is where they get measured and moved into
 * a Charms sheet; until then they are the one part of this file rule 6 does
 * not yet cover.
 */
export interface CharmValues {
  /** Warmth per stone tile cleared. */
  sunWarmedStone: number;
  /** Warmth per yuzu tile cleared. */
  yuzuGrove: number;
  /** Warmth per cascade step. */
  deepSoak: number;
  /** Warmth per charm owned. */
  collector: number;
  /** Bliss per cascade step. */
  gentleRipple: number;
  /** Bliss per match of 4+. */
  steamRising: number;
  /** Bliss per charm owned. */
  compoundWarmth: number;
  /** Bliss if the round ends with at least this fraction of moves unused. */
  patientSoak: number;
  patientSoakFraction: number;
  /** Warmth multiplier on the round's first clear. */
  morningBath: number;
  /** Warmth multiplier on the round's final move. */
  lastDrop: number;
  /** Bliss multiplier. */
  riskyBatherMult: number;
  /** Move budget change. */
  riskyBatherMoves: number;
  /** Move budget change. */
  extraTowel: number;

  // ── unlocked through the meta layer ──
  /** Bliss multiplier when exactly two colours were cleared. */
  twinSprings: number;
  /** Warmth multiplier applied to yuzu tiles / to every other tile. */
  citrusYuzu: number;
  citrusOther: number;
  /** Bliss per consecutive same-colour clear. */
  chainOfPetals: number;
  /** Bliss multiplier, and the matches of one colour needed to earn it. */
  monochromeMind: number;
  monochromeMatches: number;
  /** Moves granted per match of 5+. */
  overflowMoves: number;
  /** Moves added permanently by skipping a draft. */
  teaBreakMoves: number;
}

export interface BalanceConfig {
  scoring: ScoringConfig;
  round: RoundConfig;
  draft: DraftConfig;
  charmValues: CharmValues;
  daily: DailyConfig;
}

export const DEFAULT_CONFIG: BalanceConfig = {
  scoring: {
    warmthPerTile: 10,
    match4Bonus: 25,
    match5Bonus: 60,
    blissPerCascadeStep: 0.2,
  },
  round: {
    moveBudget: 20,
    targetBase: 1400,
    targetGrowth: 1.6,
    longSoakEvery: 3,
  },
  draft: {
    choiceCount: 3,
  },
  daily: {
    // Daily #1. Pinned here and nowhere else — see DailyConfig for why moving
    // it after launch would renumber every permalink and share grid at once.
    epoch: "2026-07-27",
    siteUrl: "capybaraclub.com",
    gamePath: "/games/cappys-onsen/",
    gameName: "Cappy's Onsen",
  },
  charmValues: {
    sunWarmedStone: 15,
    yuzuGrove: 12,
    deepSoak: 50,
    collector: 8,
    gentleRipple: 0.5,
    steamRising: 0.4,
    compoundWarmth: 0.3,
    patientSoak: 2.0,
    patientSoakFraction: 0.5,
    morningBath: 3,
    lastDrop: 4,
    riskyBatherMult: 2,
    riskyBatherMoves: -3,
    extraTowel: 2,
    twinSprings: 1.5,
    citrusYuzu: 2,
    citrusOther: 0.75,
    chainOfPetals: 0.5,
    monochromeMind: 3,
    monochromeMatches: 8,
    overflowMoves: 1,
    teaBreakMoves: 1,
  },
};

/**
 * Round target. Closed form so a round's target can be computed without
 * replaying the run (CLAUDE.md conventions) — the share grid and the
 * `/daily/N` pages both need this without a simulation.
 */
export function roundTarget(cfg: BalanceConfig, round: number): number {
  return cfg.round.targetBase * Math.pow(cfg.round.targetGrowth, round - 1);
}

/**
 * SPEC §1: every 3rd round is a Long Soak, the boss equivalent.
 *
 * The modifiers themselves ("petals score nothing", "no cascades count",
 * "only 6 moves") are NOT implemented yet — they are content decisions, and the
 * workbook models them only as an averaged score penalty. This flag exists so
 * the run knows which rounds they belong to.
 */
export function isLongSoak(cfg: BalanceConfig, round: number): boolean {
  return round % cfg.round.longSoakEvery === 0;
}
