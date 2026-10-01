/**
 * Charms — the starter twelve from SPEC §3.
 *
 * Every charm is a pure `(ctx: ScoreContext) => ScoreDelta` (CLAUDE.md rule 4).
 * A charm never mutates board state, never reads anything outside its context,
 * and never sees another charm's output. That is what makes drafting order
 * irrelevant and stacking testable.
 *
 * ----------------------------------------------------------------------------
 * WHY THESE TWELVE, AND WHAT IS MISSING
 *
 * SPEC §3 lists 24 across six archetypes. Five of those archetypes fit the pure
 * scoring model and are represented here: flat warmth, additive bliss,
 * multiplicative bliss, economy, and conditional (seven of the twelve below
 * only pay out under a condition).
 *
 * BOARD MANIPULATION (Floating Petal, Hot Stone, Skimmer, Still Water, Bath
 * Bomb) cannot be a scoring function — those charms change what the board does.
 * Rather than bend rule 4, they carry a `board` block of plain DATA. `run.ts`
 * folds the owned set into a `BoardEffects` record and hands it to `board.ts`,
 * which is the only module that mutates a grid. The charm still computes
 * nothing, mutates nothing, and never learns a board exists.
 * ----------------------------------------------------------------------------
 */
import { NO_EFFECTS, TILE_COLOURS, type BoardEffects } from "./board";
import type { ScoreContext, ScoreDelta } from "./scoring";

export type CharmId =
  | "sun_warmed_stone"
  | "yuzu_grove"
  | "deep_soak"
  | "collector"
  | "gentle_ripple"
  | "steam_rising"
  | "compound_warmth"
  | "patient_soak"
  | "morning_bath"
  | "last_drop"
  | "risky_bather"
  | "extra_towel"
  // ── unlocked through the meta layer (Milestone 7) ──
  | "twin_springs"
  | "citrus_devotion"
  | "chain_of_petals"
  | "monochrome_mind"
  | "overflow"
  | "second_steeping"
  | "tea_break"
  | "floating_petal"
  | "hot_stone"
  | "skimmer"
  | "still_water"
  | "bath_bomb";

export type CharmArchetype = "warmth" | "bliss" | "blissMult" | "economy" | "colour" | "board";

export interface Charm {
  id: CharmId;
  name: string;
  /** The one-line description from SPEC §3, verbatim — it is the player copy. */
  text: string;
  archetype: CharmArchetype;
  /** Pure scoring hook. Omitted when a charm only changes the move budget. */
  score?: (ctx: ScoreContext) => ScoreDelta;
  /**
   * Per-round move budget change. Static data, not a board mutation — this is
   * the smallest extension that lets the economy archetype exist without a
   * charm reaching into the board.
   */
  moveBudgetDelta?: (ctx: Pick<ScoreContext, "config">) => number;
  /**
   * Draft-time powers. Declarative flags the run state machine reads; the charm
   * still computes nothing and mutates nothing.
   */
  draft?: { rerollsPerDraft?: number; canSkipForMove?: boolean };
  /**
   * Board powers, as DATA. Rule 4 forbids a charm from touching the board, so a
   * charm says what it wants and `run.ts` hands that to `board.ts`, which is the
   * only module that mutates a grid. The charm itself still computes nothing.
   */
  board?: {
    /** Skimmer: sweep one random colour off the board when a round starts. */
    skimAtRoundStart?: boolean;
    /** Hot Stone: the first clear of this colour each round takes its row too. */
    rowOnFirstColour?: "stone";
    /** Bath Bomb: every Nth match also clears a 3x3. */
    areaEveryNthMatch?: number;
    /** Floating Petal: runs this long or longer leave a wild tile. */
    wildFromRunSize?: number;
    /** Still Water: free swaps per round that need no match. */
    freeSwapsPerRound?: number;
  };
}

const YUZU = TILE_COLOURS.indexOf("yuzu");
const STONE = TILE_COLOURS.indexOf("stone");

/** Tiles of one colour cleared by this trigger, or 0 when it is not a step. */
function clearedOf(ctx: ScoreContext, colour: number): number {
  if (ctx.trigger.kind !== "step") return 0;
  return ctx.trigger.step.tilesByColour[colour] ?? 0;
}

/** True for a follow-on clear — depth 1 is the player's own swap resolving. */
function isCascade(ctx: ScoreContext): boolean {
  return ctx.trigger.kind === "step" && ctx.trigger.step.depth >= 2;
}

export const CHARMS: Record<CharmId, Charm> = {
  // ── Flat warmth ──────────────────────────────────────────────────────────
  sun_warmed_stone: {
    id: "sun_warmed_stone",
    name: "Sun-Warmed Stone",
    text: "+15 Warmth per stone tile cleared",
    archetype: "warmth",
    score: (ctx) => ({ warmthAdd: ctx.config.charmValues.sunWarmedStone * clearedOf(ctx, STONE) }),
  },

  yuzu_grove: {
    id: "yuzu_grove",
    name: "Yuzu Grove",
    text: "+12 Warmth per yuzu cleared",
    archetype: "warmth",
    score: (ctx) => ({ warmthAdd: ctx.config.charmValues.yuzuGrove * clearedOf(ctx, YUZU) }),
  },

  deep_soak: {
    id: "deep_soak",
    name: "Deep Soak",
    text: "+50 Warmth per cascade step",
    archetype: "warmth",
    score: (ctx) => (isCascade(ctx) ? { warmthAdd: ctx.config.charmValues.deepSoak } : {}),
  },

  collector: {
    id: "collector",
    name: "Collector",
    text: "+8 Warmth per unique Charm you own",
    archetype: "warmth",
    // SPEC §3 names no triggering unit for this one, unlike its neighbours
    // ("per stone tile", "per cascade step"). Paid per clear, which is the
    // reading that makes it a real charm rather than a rounding error — a flat
    // once-per-round +8 x 8 charms would be under 1% of a round's warmth.
    // Milestone 4 tunes this against the harness.
    score: (ctx) =>
      ctx.trigger.kind === "step"
        ? { warmthAdd: ctx.config.charmValues.collector * ctx.charms.length }
        : {},
  },

  // ── Additive bliss ───────────────────────────────────────────────────────
  gentle_ripple: {
    id: "gentle_ripple",
    name: "Gentle Ripple",
    text: "+0.5 Bliss per cascade step (stacks with base)",
    archetype: "bliss",
    score: (ctx) => (isCascade(ctx) ? { blissAdd: ctx.config.charmValues.gentleRipple } : {}),
  },

  steam_rising: {
    id: "steam_rising",
    name: "Steam Rising",
    text: "+0.4 Bliss per match of 4+",
    archetype: "bliss",
    score: (ctx) => {
      if (ctx.trigger.kind !== "step") return {};
      const big = ctx.trigger.step.runs.filter((r) => r.size >= 4).length;
      return big === 0 ? {} : { blissAdd: ctx.config.charmValues.steamRising * big };
    },
  },

  compound_warmth: {
    id: "compound_warmth",
    name: "Compound Warmth",
    text: "+0.3 Bliss per Charm you own",
    archetype: "bliss",
    // Bliss is a per-round quantity, so this pays once per round, not per clear.
    score: (ctx) =>
      ctx.trigger.kind === "roundEnd"
        ? { blissAdd: ctx.config.charmValues.compoundWarmth * ctx.charms.length }
        : {},
  },

  patient_soak: {
    id: "patient_soak",
    name: "Patient Soak",
    text: "+2.0 Bliss if you finish with half your moves unused",
    archetype: "bliss",
    // Only coherent because the multiply happens at round end: this Bliss lands
    // before the warmth total is multiplied, so it counts. Under a per-match
    // model it would arrive too late to do anything.
    score: (ctx) => {
      if (ctx.trigger.kind !== "roundEnd") return {};
      const needed = ctx.moveBudget * ctx.config.charmValues.patientSoakFraction;
      return ctx.movesLeft >= needed ? { blissAdd: ctx.config.charmValues.patientSoak } : {};
    },
  },

  // ── Multiplicative ───────────────────────────────────────────────────────
  morning_bath: {
    id: "morning_bath",
    name: "Morning Bath",
    text: "the first match each round scores ×3",
    archetype: "blissMult",
    // Multiplies that clear's Warmth. Bliss is round-global under this model,
    // so a per-match effect has to act on Warmth to stay local to the match.
    score: (ctx) =>
      ctx.trigger.kind === "step" && ctx.stepsThisRound === 0
        ? { warmthMult: ctx.config.charmValues.morningBath }
        : {},
  },

  last_drop: {
    id: "last_drop",
    name: "Last Drop",
    text: "the final move of the round scores ×4",
    archetype: "blissMult",
    // "Final move" is the last move the budget allows. A round can also end by
    // hitting the target early, but the player cannot know that in advance, so
    // pinning it to the budget keeps the charm predictable.
    score: (ctx) =>
      ctx.trigger.kind === "step" && ctx.movesLeft === 0
        ? { warmthMult: ctx.config.charmValues.lastDrop }
        : {},
  },

  risky_bather: {
    id: "risky_bather",
    name: "Risky Bather",
    text: "×2 Bliss, but −3 moves per round",
    archetype: "blissMult",
    score: (ctx) =>
      ctx.trigger.kind === "roundEnd"
        ? { blissMult: ctx.config.charmValues.riskyBatherMult }
        : {},
    moveBudgetDelta: (ctx) => ctx.config.charmValues.riskyBatherMoves,
  },

  // ── Board manipulation ───────────────────────────────────────────────────
  // These declare what they want; run.ts asks board.ts to do it. See the
  // BoardEffects block in board.ts for why that keeps rule 4 intact.
  floating_petal: {
    id: "floating_petal",
    name: "Floating Petal",
    text: "matches of 4 leave a wild tile behind",
    archetype: "board",
    board: { wildFromRunSize: 4 },
  },

  hot_stone: {
    id: "hot_stone",
    name: "Hot Stone",
    text: "first stone cleared each round clears its whole row",
    archetype: "board",
    board: { rowOnFirstColour: "stone" },
  },

  skimmer: {
    id: "skimmer",
    name: "Skimmer",
    text: "at round start, remove all tiles of one random colour",
    archetype: "board",
    board: { skimAtRoundStart: true },
  },

  still_water: {
    id: "still_water",
    name: "Still Water",
    text: "once per round, swap any two tiles without needing a match",
    archetype: "board",
    board: { freeSwapsPerRound: 1 },
  },

  bath_bomb: {
    id: "bath_bomb",
    name: "Bath Bomb",
    text: "every 7th match clears a 3×3 area",
    archetype: "board",
    board: { areaEveryNthMatch: 7 },
  },

  // ── Colour specialists ───────────────────────────────────────────────────
  twin_springs: {
    id: "twin_springs",
    name: "Twin Springs",
    text: "×1.5 Bliss if you cleared only two colours this round",
    archetype: "blissMult",
    score: (ctx) => {
      if (ctx.trigger.kind !== "roundEnd") return {};
      const used = ctx.clearedByColour.filter((n) => n > 0).length;
      return used === 2 ? { blissMult: ctx.config.charmValues.twinSprings } : {};
    },
  },

  citrus_devotion: {
    id: "citrus_devotion",
    name: "Citrus Devotion",
    text: "yuzu matches score ×2, all others −25%",
    archetype: "colour",
    // A single clear can span several colours, so the multiplier is weighted by
    // how many of ITS tiles were yuzu. A flat "x2 if any yuzu" would pay the
    // full bonus for one lucky tile in a five-tile clear.
    score: (ctx) => {
      if (ctx.trigger.kind !== "step") return {};
      const step = ctx.trigger.step;
      if (step.tiles === 0) return {};
      const yuzu = step.tilesByColour[YUZU] ?? 0;
      const other = step.tiles - yuzu;
      const v = ctx.config.charmValues;
      return { warmthMult: (yuzu * v.citrusYuzu + other * v.citrusOther) / step.tiles };
    },
  },

  chain_of_petals: {
    id: "chain_of_petals",
    name: "Chain of Petals",
    text: "consecutive same-colour matches: +0.5 Bliss each, resets on colour change",
    archetype: "bliss",
    // streakLength counts this clear, so the second in a row is the first payout.
    score: (ctx) =>
      ctx.trigger.kind === "step" && ctx.streakLength >= 2
        ? { blissAdd: ctx.config.charmValues.chainOfPetals }
        : {},
  },

  monochrome_mind: {
    id: "monochrome_mind",
    name: "Monochrome Mind",
    text: "×3 Bliss on any round where you clear a single colour ≥8 times",
    archetype: "blissMult",
    // "times" is matches, not tiles: eight TILES of one colour is two ordinary
    // clears and would make this unconditional.
    score: (ctx) => {
      if (ctx.trigger.kind !== "roundEnd") return {};
      const best = Math.max(0, ...ctx.matchesByColour);
      return best >= ctx.config.charmValues.monochromeMatches
        ? { blissMult: ctx.config.charmValues.monochromeMind }
        : {};
    },
  },

  // ── Economy ──────────────────────────────────────────────────────────────
  overflow: {
    id: "overflow",
    name: "Overflow",
    text: "matches of 5+ grant +1 move",
    archetype: "economy",
    score: (ctx) => {
      if (ctx.trigger.kind !== "step") return {};
      const big = ctx.trigger.step.runs.filter((r) => r.size >= 5).length;
      return big === 0 ? {} : { movesAdd: big * ctx.config.charmValues.overflowMoves };
    },
  },

  second_steeping: {
    id: "second_steeping",
    name: "Second Steeping",
    text: "one free reroll per Charm draft",
    archetype: "economy",
    draft: { rerollsPerDraft: 1 },
  },

  tea_break: {
    id: "tea_break",
    name: "Tea Break",
    text: "skip a draft to gain +1 permanent move",
    archetype: "economy",
    draft: { canSkipForMove: true },
  },

  extra_towel: {
    id: "extra_towel",
    name: "Extra Towel",
    text: "+2 moves per round",
    archetype: "economy",
    moveBudgetDelta: (ctx) => ctx.config.charmValues.extraTowel,
  },
};

/** Draft pool order. Stable — the seeded offer roll indexes into it. */
export const CHARM_IDS: readonly CharmId[] = [
  "sun_warmed_stone",
  "yuzu_grove",
  "deep_soak",
  "collector",
  "gentle_ripple",
  "steam_rising",
  "compound_warmth",
  "patient_soak",
  "morning_bath",
  "last_drop",
  "risky_bather",
  "extra_towel",
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

export const isCharmId = (x: unknown): x is CharmId =>
  typeof x === "string" && (CHARM_IDS as readonly string[]).includes(x);

/**
 * Fold a charm set into the board-effect record `resolve` reads. This is the
 * whole bridge between charms and the board: data in, data out, no charm
 * called and no grid touched.
 */
export function boardEffectsFrom(ids: readonly CharmId[]): BoardEffects {
  let fx: BoardEffects = { ...NO_EFFECTS };
  for (const id of ids) {
    const b = CHARMS[id]?.board;
    if (!b) continue;
    if (b.rowOnFirstColour === "stone") fx = { ...fx, rowOnFirstColour: STONE };
    if (b.areaEveryNthMatch) fx = { ...fx, areaEveryNthMatch: b.areaEveryNthMatch };
    if (b.wildFromRunSize) fx = { ...fx, wildFromRunSize: b.wildFromRunSize };
  }
  return fx;
}

/** Free swaps per round the set grants (Still Water). */
export const freeSwapsFrom = (ids: readonly CharmId[]): number =>
  ids.reduce((n, id) => n + (CHARMS[id]?.board?.freeSwapsPerRound ?? 0), 0);

/** Whether the set sweeps a colour at round start (Skimmer). */
export const skimsAtRoundStart = (ids: readonly CharmId[]): boolean =>
  ids.some((id) => CHARMS[id]?.board?.skimAtRoundStart === true);

/** Total rerolls a charm set grants per draft. */
export const rerollsFrom = (ids: readonly CharmId[]): number =>
  ids.reduce((n, id) => n + (CHARMS[id]?.draft?.rerollsPerDraft ?? 0), 0);

/** Whether any owned charm lets a draft be skipped for a permanent move. */
export const canSkipDraft = (ids: readonly CharmId[]): boolean =>
  ids.some((id) => CHARMS[id]?.draft?.canSkipForMove === true);

/** The scoring hooks of a charm set, in pool order. Order cannot matter (rule 4). */
export function charmScoreFns(ids: readonly CharmId[]): ((ctx: ScoreContext) => ScoreDelta)[] {
  const fns: ((ctx: ScoreContext) => ScoreDelta)[] = [];
  for (const id of ids) {
    const fn = CHARMS[id]?.score;
    if (fn) fns.push(fn);
  }
  return fns;
}
