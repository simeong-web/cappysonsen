/**
 * Warmth × Bliss scoring pipeline (SPEC §2).
 *
 * ============================================================================
 * THE SCORING MODEL — settled at the Milestone 1 gate
 * ----------------------------------------------------------------------------
 *   round score = (all the round's Warmth) × (the Bliss standing at round end)
 *
 * Warmth and Bliss both accumulate across the whole round; the multiply happens
 * ONCE, at the end. This is the literal reading of SPEC §2 and it is what
 * `docs/onsen_balance.xlsx` models (Assumptions!B52). The alternative — scoring
 * each match at the Bliss standing when it lands — was rejected because it
 * makes Patient Soak ("+2.0 Bliss if you finish with half your moves unused")
 * a dead charm: its Bliss would arrive after the last match had already scored.
 * ============================================================================
 *
 * ORDER INDEPENDENCE (CLAUDE.md rule 4) is structural, not a convention that
 * has to be remembered: every charm returns a delta, all the additive parts are
 * summed and all the multiplicative parts are multiplied, and only then are the
 * two combined. Sums and products commute, so charm order cannot matter. No
 * charm ever sees another charm's output.
 */
import type { BoardEvent, Tile } from "./board";
import type { BalanceConfig } from "./config";

/**
 * What one cascade step did, distilled from the board's event stream.
 *
 * `tiles` counts DISTINCT cells: board.ts reports an L-shape as two runs that
 * share a tile, so summing run sizes would pay twice for the shared cell.
 * Per-tile warmth comes from here; match-size bonuses come from `runs`.
 */
export interface StepSummary {
  depth: number;
  /** Distinct tiles cleared at this depth. */
  tiles: number;
  /** Distinct tiles cleared at this depth, indexed by tile colour. */
  tilesByColour: readonly number[];
  /** One entry per maximal run — the unit the match-4/5 bonuses are paid on. */
  runs: readonly { colour: Tile; size: number }[];
}

export type ScoreTrigger = { kind: "step"; step: StepSummary } | { kind: "roundEnd" };

/**
 * Everything a charm is allowed to see. Rule 4: a charm reads nothing outside
 * this object — which is why the balance config is carried in it rather than
 * imported by the charms.
 */
export interface ScoreContext {
  config: BalanceConfig;
  trigger: ScoreTrigger;
  round: number;
  isLongSoak: boolean;
  moveBudget: number;
  /** Moves spent including the one being scored. */
  movesUsed: number;
  /** Moves remaining after the one being scored. */
  movesLeft: number;
  charms: readonly string[];
  /** Cascade steps already scored this round, excluding this trigger. */
  stepsThisRound: number;
  /** Runs already scored this round, excluding this trigger. */
  matchesThisRound: number;
  /** Distinct tiles cleared this round, by colour, excluding this trigger. */
  clearedByColour: readonly number[];
  /** Runs matched this round, by colour, excluding this trigger. */
  matchesByColour: readonly number[];
  /**
   * The colour of the current unbroken run of same-coloured matches, and how
   * long it is. A step whose runs are not all one colour breaks the streak.
   */
  streakColour: number | null;
  streakLength: number;
}

/** A charm's contribution. Every field is optional; omitted means "no effect". */
export interface ScoreDelta {
  warmthAdd?: number;
  warmthMult?: number;
  blissAdd?: number;
  blissMult?: number;
  /** Extra moves granted to the round in progress (Overflow). */
  movesAdd?: number;
}

export type CharmScoreFn = (ctx: ScoreContext) => ScoreDelta;

/**
 * A round's running total. Kept as three independent accumulators rather than
 * one number so the single end-of-round multiply stays exact and inspectable.
 */
export interface RoundScore {
  /** Total Warmth banked this round. */
  warmth: number;
  /** Moves granted mid-round by charms. */
  movesAdd?: number;
  /** Summed additive Bliss. Bliss itself starts at 1.0, so bliss = 1 + this. */
  blissAdd: number;
  /** Multiplied multiplicative Bliss. */
  blissMult: number;
}

export const emptyRoundScore = (): RoundScore => ({ warmth: 0, blissAdd: 0, blissMult: 1, movesAdd: 0 });

/** Bliss starts at 1.0 each round (SPEC §2), builds additively, then scales. */
export const blissOf = (s: RoundScore): number => (1 + s.blissAdd) * s.blissMult;

/** The one multiply. */
export const roundTotal = (s: RoundScore): number => s.warmth * blissOf(s);

/**
 * Turn a board event stream into per-step summaries.
 *
 * The board reports runs and a distinct-cleared count separately; this reunites
 * them and recovers the per-colour breakdown that colour charms need, by
 * deduping the cells the runs report.
 */
export function summariseSteps(events: readonly BoardEvent[]): StepSummary[] {
  const order: number[] = [];
  const byDepth = new Map<
    number,
    { runs: { colour: Tile; size: number }[]; cells: Map<number, Tile> }
  >();
  const bucket = (depth: number) => {
    let b = byDepth.get(depth);
    if (!b) {
      b = { runs: [], cells: new Map() };
      byDepth.set(depth, b);
      order.push(depth);
    }
    return b;
  };

  for (const e of events) {
    if (e.type === "cascadeStep") {
      bucket(e.depth);
    } else if (e.type === "tilesCleared") {
      const b = bucket(e.depth);
      b.runs.push({ colour: e.colour, size: e.cells.length });
      // col * 64 + row is a unique key: board.ts caps dimensions at 32.
      for (const c of e.cells) b.cells.set(c.col * 64 + c.row, e.colour);
    }
  }

  return order.map((depth) => {
    const b = byDepth.get(depth)!;
    const tilesByColour: number[] = [];
    for (const colour of b.cells.values()) {
      tilesByColour[colour] = (tilesByColour[colour] ?? 0) + 1;
    }
    for (let i = 0; i < tilesByColour.length; i++) tilesByColour[i] ??= 0;
    return { depth, tiles: b.cells.size, tilesByColour, runs: b.runs };
  });
}

/** The board's own contribution, before any charm touches it (SPEC §2 table). */
export function baseDelta(cfg: BalanceConfig, trigger: ScoreTrigger): ScoreDelta {
  if (trigger.kind !== "step") return {};
  const { step } = trigger;
  let warmthAdd = step.tiles * cfg.scoring.warmthPerTile;
  for (const run of step.runs) {
    if (run.size >= 5) warmthAdd += cfg.scoring.match5Bonus;
    else if (run.size === 4) warmthAdd += cfg.scoring.match4Bonus;
  }
  // Cascade Bliss is for FOLLOW-ON clears only. Depth 1 is the player's own
  // swap resolving; the workbook's "cascade steps per move" counts what happens
  // AFTER that (board.ts convention 5). Paying Bliss at depth 1 would hand
  // every move a free +0.2 and silently shift the whole curve.
  const blissAdd = step.depth >= 2 ? cfg.scoring.blissPerCascadeStep : 0;
  return { warmthAdd, blissAdd };
}

/**
 * Score one trigger. Returns the increment to fold into the round total.
 *
 * Additive parts are summed and multiplicative parts multiplied BEFORE they
 * meet, which is what makes charm order irrelevant.
 */
export function scoreTrigger(ctx: ScoreContext, charms: readonly CharmScoreFn[]): RoundScore {
  const base = baseDelta(ctx.config, ctx.trigger);

  let warmthAdd = base.warmthAdd ?? 0;
  let warmthMult = base.warmthMult ?? 1;
  let blissAdd = base.blissAdd ?? 0;
  let blissMult = base.blissMult ?? 1;
  let movesAdd = 0;

  for (const charm of charms) {
    const d = charm(ctx);
    warmthAdd += d.warmthAdd ?? 0;
    warmthMult *= d.warmthMult ?? 1;
    blissAdd += d.blissAdd ?? 0;
    blissMult *= d.blissMult ?? 1;
    movesAdd += d.movesAdd ?? 0;
  }

  return { warmth: warmthAdd * warmthMult, blissAdd, blissMult, movesAdd };
}

/** Fold an increment into a round's running total. */
export function fold(total: RoundScore, inc: RoundScore): RoundScore {
  return {
    warmth: total.warmth + inc.warmth,
    blissAdd: total.blissAdd + inc.blissAdd,
    blissMult: total.blissMult * inc.blissMult,
    movesAdd: (total.movesAdd ?? 0) + (inc.movesAdd ?? 0),
  };
}
