/**
 * Run state machine: round start → moves → target check → draft → next round
 * or run end (SPEC §1). Offer/choose follows Emberkeep's `rollPerkOffer` /
 * `choosePerk` shape.
 *
 * Two RNG streams, deliberately:
 *
 *   board.rngState   advances on every refill and shuffle — i.e. constantly,
 *                    and by an amount that depends on how the player played.
 *   draftRngState    advances exactly once per draft.
 *
 * They are separate because SPEC §4 requires a daily's charm offers to be the
 * same for everyone. If offers were drawn from the board stream, the number of
 * cascades a player happened to cause would shift every later offer, and two
 * people playing the same daily would be handed different charms. Keeping the
 * draft stream apart makes offer N a function of the seed and N alone.
 */
import {
  NO_EFFECTS,
  TILE_COLOURS,
  cellsOfColour,
  clearCells,
  createBoard,
  resolve,
  swap,
  validateBoard,
  type BoardEffects,
  type BoardEvent,
  type BoardState,
  type Pos,
} from "./board";
import { rngInt } from "./rng";
import { isLongSoak, roundTarget, type BalanceConfig } from "./config";
import { shareText } from "./daily";
import {
  CHARMS,
  CHARM_IDS,
  boardEffectsFrom,
  canSkipDraft,
  charmScoreFns,
  freeSwapsFrom,
  isCharmId,
  rerollsFrom,
  skimsAtRoundStart,
  type CharmId,
} from "./charms";
import {
  emptyRoundScore,
  fold,
  roundTotal,
  scoreTrigger,
  summariseSteps,
  type RoundScore,
  type ScoreContext,
} from "./scoring";

export type RunPhase = "playing" | "drafting" | "over";

/**
 * Daily runs are seeded from the date and limited to one a day; endless runs
 * take a random seed and never end. The sim treats them identically — the mode
 * only tells the client which rules to apply around the run.
 */
export type RunMode = "daily" | "endless";

export interface RunState {
  seed: number;
  mode: RunMode;
  round: number;
  phase: RunPhase;
  board: BoardState;
  /** Charm-offer stream. See the module header for why it is not the board's. */
  draftRngState: number;
  /** This round's budget, base plus every owned charm's modifier. */
  moveBudget: number;
  movesUsed: number;
  /** This round's running Warmth/Bliss accumulators. */
  score: RoundScore;
  stepsThisRound: number;
  matchesThisRound: number;
  /** Per-round colour tallies the colour charms read. */
  clearedByColour: number[];
  matchesByColour: number[];
  streakColour: number | null;
  streakLength: number;
  /** Rerolls still available on the pending draft. */
  rerollsLeft: number;
  /** Moves added for the rest of the run by skipping drafts (Tea Break). */
  permanentMoveBonus: number;
  /** Charms this run may be offered — the meta layer's unlocked set. */
  pool: CharmId[];
  /**
   * Board powers for the round in progress, folded from the owned charms and
   * handed to `resolve`. Lives here because its counters span a round.
   */
  effects: BoardEffects;
  /** Still Water: swaps left this round that need no match. */
  freeSwapsLeft: number;
  totalScore: number;
  charms: CharmId[];
  /** The pending draft, or null when not drafting. */
  offer: CharmId[] | null;
  /** One entry per round played, including the round the run died on. */
  rounds: RoundLog[];
}

/**
 * What a finished round looked like.
 *
 * `movesUsed` and `moveBudget` are recorded because the share grid needs to
 * tell a comfortable clear from a desperate one — and score cannot: a round
 * ends the instant its target is met, so every cleared round scores about 1x
 * target by construction. Milestone 8's analytics wants the same shape.
 */
export interface RoundLog {
  round: number;
  score: number;
  target: number;
  movesUsed: number;
  moveBudget: number;
  cleared: boolean;
}

/**
 * Decorrelates the draft stream from the board stream. Both derive from the one
 * run seed, so a run is still reproducible from a single number.
 */
export const draftSeed = (seed: number): number => (seed ^ 0x9e3779b9) | 0;

/** One counter per tile colour, dense so JSON cannot introduce holes. */
const zeroes = (): number[] => new Array<number>(TILE_COLOURS.length).fill(0);

/** Base budget plus every owned charm's modifier. Never drops below one move. */
export function moveBudgetFor(
  cfg: BalanceConfig,
  charms: readonly CharmId[],
  permanentBonus = 0,
): number {
  let budget = cfg.round.moveBudget + permanentBonus;
  for (const id of charms) {
    const delta = CHARMS[id]?.moveBudgetDelta;
    if (delta) budget += delta({ config: cfg });
  }
  return Math.max(1, budget);
}

function contextFor(
  cfg: BalanceConfig,
  state: RunState,
  trigger: ScoreContext["trigger"],
  movesUsed: number,
  stepsThisRound: number,
  matchesThisRound: number,
): ScoreContext {
  return {
    config: cfg,
    trigger,
    round: state.round,
    isLongSoak: isLongSoak(cfg, state.round),
    moveBudget: state.moveBudget,
    movesUsed,
    movesLeft: Math.max(0, state.moveBudget - movesUsed),
    charms: state.charms,
    stepsThisRound,
    matchesThisRound,
    clearedByColour: state.clearedByColour,
    matchesByColour: state.matchesByColour,
    streakColour: state.streakColour,
    streakLength: state.streakLength,
  };
}

/**
 * The round's score as it stands, including end-of-round charms.
 *
 * End-of-round charms are evaluated live rather than only when the round
 * finishes, so Patient Soak's Bliss can actually help clear the target. Their
 * conditions are all checkable at any moment, so there is nothing circular
 * about it.
 */
export function currentRoundScore(cfg: BalanceConfig, state: RunState): number {
  const ctx = contextFor(
    cfg,
    state,
    { kind: "roundEnd" },
    state.movesUsed,
    state.stepsThisRound,
    state.matchesThisRound,
  );
  return roundTotal(fold(state.score, scoreTrigger(ctx, charmScoreFns(state.charms))));
}

/**
 * Seeded 1-of-N charm offer, drawn without replacement from the charms the
 * player does not already own. Returns fewer than `choiceCount` only when the
 * pool is nearly exhausted.
 */
export function rollCharmOffer(
  cfg: BalanceConfig,
  rngState: number,
  owned: readonly CharmId[],
  pool: readonly CharmId[] = CHARM_IDS,
): { offer: CharmId[]; rngState: number } {
  // Pool order follows CHARM_IDS, not the unlocked set's order, so two players
  // who unlocked the same charms in a different sequence still get the same
  // offer from the same seed.
  const remaining = CHARM_IDS.filter((id) => pool.includes(id) && !owned.includes(id));
  const offer: CharmId[] = [];
  let rng = rngState;
  const n = Math.min(cfg.draft.choiceCount, remaining.length);
  for (let i = 0; i < n; i++) {
    const r = rngInt(rng, remaining.length);
    rng = r.state;
    offer.push(remaining.splice(r.value, 1)[0]!);
  }
  return { offer, rngState: rng };
}

/**
 * Begin a round. The board carries over rather than being re-dealt: SPEC §1
 * calls a Long Soak "same board, plus one modifier", and a fresh board every
 * round would throw away the position the player just worked into.
 */
function startRound(cfg: BalanceConfig, state: RunState, round: number): RunState {
  const started: RunState = {
    ...state,
    round,
    phase: "playing",
    offer: null,
    moveBudget: moveBudgetFor(cfg, state.charms, state.permanentMoveBonus),
    movesUsed: 0,
    score: emptyRoundScore(),
    stepsThisRound: 0,
    matchesThisRound: 0,
    // Dense, not sparse: a sparse array's holes become nulls through JSON, and
    // a reloaded run would then differ from one that was never saved.
    clearedByColour: zeroes(),
    matchesByColour: zeroes(),
    streakColour: null,
    streakLength: 0,
    effects: boardEffectsFrom(state.charms),
    freeSwapsLeft: freeSwapsFrom(state.charms),
  };
  return skim(cfg, started);
}

/**
 * Skimmer: sweep one random colour off the board as the round opens.
 *
 * The colour is drawn from the BOARD stream, so it is part of the same seeded
 * sequence as every refill — two players with the same seed and the same charm
 * lose the same colour.
 */
function skim(cfg: BalanceConfig, state: RunState): RunState {
  if (!skimsAtRoundStart(state.charms)) return state;
  const pick = rngInt(state.board.rngState, state.board.colours);
  const board = { ...state.board, rngState: pick.state };
  const swept = clearCells(board, cellsOfColour(board, pick.value));
  const settled = resolve(swept.state, state.effects);
  return {
    ...state,
    board: settled.state,
    effects: settled.effects ?? state.effects,
  };
}

export function newRun(
  cfg: BalanceConfig,
  seed: number,
  mode: RunMode = "endless",
  pool: readonly CharmId[] = CHARM_IDS,
): RunState {
  const state: RunState = {
    seed,
    mode,
    round: 1,
    phase: "playing",
    board: createBoard({ seed }),
    draftRngState: draftSeed(seed),
    moveBudget: cfg.round.moveBudget,
    movesUsed: 0,
    score: emptyRoundScore(),
    stepsThisRound: 0,
    matchesThisRound: 0,
    clearedByColour: zeroes(),
    matchesByColour: zeroes(),
    streakColour: null,
    streakLength: 0,
    rerollsLeft: 0,
    permanentMoveBonus: 0,
    pool: [...pool],
    effects: { ...NO_EFFECTS },
    freeSwapsLeft: 0,
    totalScore: 0,
    charms: [],
    offer: null,
    rounds: [],
  };
  return startRound(cfg, state, 1);
}

function bank(cfg: BalanceConfig, state: RunState, total: number, cleared: boolean): RunState {
  const log: RoundLog = {
    round: state.round,
    score: total,
    target: roundTarget(cfg, state.round),
    movesUsed: state.movesUsed,
    moveBudget: state.moveBudget,
    cleared,
  };
  return { ...state, totalScore: state.totalScore + total, rounds: [...state.rounds, log] };
}

function clearRound(cfg: BalanceConfig, state: RunState, total: number): RunState {
  const banked = bank(cfg, state, total, true);
  const rolled = rollCharmOffer(cfg, banked.draftRngState, banked.charms, banked.pool);
  const advanced = {
    ...banked,
    draftRngState: rolled.rngState,
    rerollsLeft: rerollsFrom(banked.charms),
  };
  // Pool exhausted: there is nothing to draft, so go straight on.
  if (rolled.offer.length === 0) return startRound(cfg, advanced, advanced.round + 1);
  return { ...advanced, offer: rolled.offer, phase: "drafting" };
}

/**
 * Play one move. Returns null when the move is refused — an illegal or
 * fruitless swap costs the player nothing, so `movesUsed` does not advance and
 * neither RNG stream moves (board.ts guarantees `swap` draws nothing).
 */
export function playMove(
  cfg: BalanceConfig,
  state: RunState,
  a: Pos,
  b: Pos,
  opts: { free?: boolean } = {},
): { state: RunState; events: BoardEvent[] } | null {
  if (state.phase !== "playing") return null;

  // Still Water spends an allowance instead of needing a match. Asking for a
  // free swap without one left falls back to the ordinary rule rather than
  // silently granting it.
  const free = opts.free === true && state.freeSwapsLeft > 0;
  const swapped = swap(state.board, a, b, { force: free });
  if (!swapped) return null;

  const resolved = resolve(swapped.state, state.effects);
  const events = [...swapped.events, ...resolved.events];

  const movesUsed = state.movesUsed + 1;
  const fns = charmScoreFns(state.charms);
  let score = state.score;
  let steps = state.stepsThisRound;
  let matches = state.matchesThisRound;
  const cleared = [...state.clearedByColour];
  const byColour = [...state.matchesByColour];
  let streakColour = state.streakColour;
  let streakLength = state.streakLength;

  for (const step of summariseSteps(resolved.events)) {
    // A clear continues the streak only when every run in it is the same
    // colour; a mixed clear breaks the chain rather than picking a winner.
    const colours = new Set(step.runs.map((r) => r.colour));
    const uniform = colours.size === 1 ? [...colours][0]! : null;
    if (uniform !== null && uniform === streakColour) streakLength++;
    else {
      streakColour = uniform;
      streakLength = uniform === null ? 0 : 1;
    }

    const ctx: ScoreContext = {
      ...contextFor(cfg, state, { kind: "step", step }, movesUsed, steps, matches),
      clearedByColour: cleared,
      matchesByColour: byColour,
      streakColour,
      streakLength,
    };
    score = fold(score, scoreTrigger(ctx, fns));

    // Tallies advance AFTER scoring, so a charm sees the round as it stood
    // before this clear — the same rule the step/match counters already follow.
    step.tilesByColour.forEach((n, colour) => {
      cleared[colour] = (cleared[colour] ?? 0) + n;
    });
    for (const run of step.runs) byColour[run.colour] = (byColour[run.colour] ?? 0) + 1;
    steps++;
    matches += step.runs.length;
  }

  let next: RunState = {
    ...state,
    board: resolved.state,
    effects: resolved.effects ?? state.effects,
    freeSwapsLeft: free ? state.freeSwapsLeft - 1 : state.freeSwapsLeft,
    movesUsed,
    score,
    stepsThisRound: steps,
    matchesThisRound: matches,
    clearedByColour: cleared,
    matchesByColour: byColour,
    streakColour,
    streakLength,
    // Overflow and friends widen the budget for the round in progress.
    moveBudget: state.moveBudget + (score.movesAdd ?? 0) - (state.score.movesAdd ?? 0),
  };

  const total = currentRoundScore(cfg, next);
  if (total >= roundTarget(cfg, next.round)) {
    next = clearRound(cfg, next, total);
  } else if (movesUsed >= next.moveBudget) {
    // Out of moves under target: the run ends, but the round still scores —
    // the workbook counts the failed round's output in "score at wall".
    next = { ...bank(cfg, next, total, false), phase: "over", offer: null };
  }

  return { state: next, events };
}

/**
 * Take a charm from the pending offer and start the next round. Anything not
 * on offer is refused by returning the state unchanged, the same way
 * Emberkeep's `choosePerk` refuses.
 */
/**
 * Reroll the pending offer, if an owned charm granted one. Draws from the same
 * draft stream, so a rerolled offer is still a pure function of the seed and how
 * many draws have happened.
 */
export function rerollOffer(
  cfg: BalanceConfig,
  state: RunState,
  opts: { free?: boolean } = {},
): RunState {
  // `free` is the rewarded-ad reroll: it costs no allowance. Everything else
  // about the draw is identical, so a paid reroll and an earned one are the
  // same code path and cannot drift apart.
  if (state.phase !== "drafting") return state;
  if (!opts.free && state.rerollsLeft <= 0) return state;
  const rolled = rollCharmOffer(cfg, state.draftRngState, state.charms, state.pool);
  if (rolled.offer.length === 0) return state;
  return {
    ...state,
    draftRngState: rolled.rngState,
    offer: rolled.offer,
    rerollsLeft: opts.free ? state.rerollsLeft : state.rerollsLeft - 1,
  };
}

/**
 * Put a dead run back on its feet with extra moves (the "+5 moves" ad slot).
 *
 * The round that just failed is un-banked rather than a new one started: the
 * board, the warmth and the bliss are all exactly as the player left them, so
 * this is a genuine second chance at the same round and not a soft restart.
 * Refuses anything that is not a run that just ran out of moves.
 */
export function reviveWithMoves(cfg: BalanceConfig, state: RunState, extraMoves: number): RunState {
  if (state.phase !== "over" || extraMoves <= 0) return state;
  const failed = state.rounds[state.rounds.length - 1];
  if (!failed || failed.cleared) return state;
  return {
    ...state,
    phase: "playing",
    moveBudget: state.moveBudget + extraMoves,
    totalScore: state.totalScore - failed.score,
    rounds: state.rounds.slice(0, -1),
  };
}

/** Tea Break: decline the draft for a permanent extra move. */
export function skipDraft(cfg: BalanceConfig, state: RunState): RunState {
  if (state.phase !== "drafting" || !canSkipDraft(state.charms)) return state;
  const bonus = state.permanentMoveBonus + cfg.charmValues.teaBreakMoves;
  return startRound(cfg, { ...state, permanentMoveBonus: bonus }, state.round + 1);
}

export function chooseCharm(cfg: BalanceConfig, state: RunState, id: CharmId): RunState {
  if (state.phase !== "drafting" || state.offer === null) return state;
  if (!state.offer.includes(id)) return state;
  return startRound(cfg, { ...state, charms: [...state.charms, id] }, state.round + 1);
}

// ---------------------------------------------------------------- share grid

/**
 * Turn a finished (or in-flight) run into the spoiler-free share grid of
 * SPEC §4. Lives here rather than in `daily.ts` so that module stays free of
 * any dependency on the run model.
 */
export function shareTextFor(cfg: BalanceConfig, state: RunState, dailyNumber: number): string {
  return shareText(cfg.daily, {
    dailyNumber,
    roundReached: state.round,
    totalScore: state.totalScore,
    rounds: state.rounds.map((r) => ({
      movesUsed: r.movesUsed,
      moveBudget: r.moveBudget,
      cleared: r.cleared,
    })),
  });
}

// ---------------------------------------------------------------- validation

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Validator for `save.ts`, so a daily run survives a refresh.
 *
 * Structural damage is rejected outright — a half-valid run would be a subtly
 * different game, which is worse than starting over. Unknown charm ids are the
 * one thing repaired rather than rejected: a save written before a charm was
 * renamed is still a legitimate run, just with one fewer charm.
 */
export function validateRun(raw: unknown): RunState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;

  if (!isNum(s["seed"]) || !isInt(s["round"]) || (s["round"] as number) < 1) return null;
  if (s["mode"] !== "daily" && s["mode"] !== "endless") return null;
  if (s["phase"] !== "playing" && s["phase"] !== "drafting" && s["phase"] !== "over") return null;

  const board = validateBoard(s["board"]);
  if (board === null) return null;

  if (!isNum(s["draftRngState"])) return null;
  if (!isInt(s["moveBudget"]) || (s["moveBudget"] as number) < 1) return null;
  if (!isInt(s["movesUsed"]) || (s["movesUsed"] as number) < 0) return null;
  if (!isInt(s["stepsThisRound"]) || !isInt(s["matchesThisRound"])) return null;
  if (!isNum(s["totalScore"])) return null;

  const rawScore = s["score"];
  if (typeof rawScore !== "object" || rawScore === null) return null;
  const sc = rawScore as Record<string, unknown>;
  if (!isNum(sc["warmth"]) || !isNum(sc["blissAdd"]) || !isNum(sc["blissMult"])) return null;

  const charms = Array.isArray(s["charms"]) ? s["charms"].filter(isCharmId) : null;
  if (charms === null) return null;

  const rawOffer = s["offer"];
  let offer: CharmId[] | null = null;
  if (rawOffer !== null && rawOffer !== undefined) {
    if (!Array.isArray(rawOffer)) return null;
    offer = rawOffer.filter(isCharmId);
  }

  if (!Array.isArray(s["rounds"])) return null;
  const rounds: RoundLog[] = [];
  for (const r of s["rounds"]) {
    if (typeof r !== "object" || r === null) return null;
    const l = r as Record<string, unknown>;
    if (!isInt(l["round"]) || !isNum(l["score"]) || !isNum(l["target"])) return null;
    if (!isInt(l["movesUsed"]) || !isInt(l["moveBudget"])) return null;
    if (typeof l["cleared"] !== "boolean") return null;
    rounds.push({
      round: l["round"] as number,
      score: l["score"] as number,
      target: l["target"] as number,
      movesUsed: l["movesUsed"] as number,
      moveBudget: l["moveBudget"] as number,
      cleared: l["cleared"] as boolean,
    });
  }

  // Fields added in Milestone 7. A v1 run has none of them, so they default
  // rather than failing the load — the migration's other half.
  const numArray = (x: unknown): number[] => {
    const out = zeroes();
    if (Array.isArray(x)) {
      x.forEach((n, i) => {
        if (i < out.length && typeof n === "number" && Number.isFinite(n)) out[i] = n;
      });
    }
    return out;
  };
  const pool = Array.isArray(s["pool"]) ? s["pool"].filter(isCharmId) : [];
  const streakColour = s["streakColour"];

  return {
    seed: s["seed"] as number,
    mode: s["mode"] as RunMode,
    round: s["round"] as number,
    phase: s["phase"] as RunPhase,
    board,
    draftRngState: s["draftRngState"] as number,
    moveBudget: s["moveBudget"] as number,
    movesUsed: s["movesUsed"] as number,
    score: {
      warmth: sc["warmth"] as number,
      blissAdd: sc["blissAdd"] as number,
      blissMult: sc["blissMult"] as number,
      movesAdd: isNum(sc["movesAdd"]) ? (sc["movesAdd"] as number) : 0,
    },
    stepsThisRound: s["stepsThisRound"] as number,
    matchesThisRound: s["matchesThisRound"] as number,
    totalScore: s["totalScore"] as number,
    charms,
    offer,
    rounds,
    clearedByColour: numArray(s["clearedByColour"]),
    matchesByColour: numArray(s["matchesByColour"]),
    streakColour: typeof streakColour === "number" ? streakColour : null,
    streakLength: isInt(s["streakLength"]) ? (s["streakLength"] as number) : 0,
    rerollsLeft: isInt(s["rerollsLeft"]) ? Math.max(0, s["rerollsLeft"] as number) : 0,
    permanentMoveBonus: isInt(s["permanentMoveBonus"])
      ? Math.max(0, s["permanentMoveBonus"] as number)
      : 0,
    pool: pool.length > 0 ? pool : [...CHARM_IDS],
    effects: validateEffects(s["effects"]),
    freeSwapsLeft: isInt(s["freeSwapsLeft"]) ? Math.max(0, s["freeSwapsLeft"] as number) : 0,
  };
}

/** Effects are recomputed from charms each round, so a bad record just resets. */
function validateEffects(raw: unknown): BoardEffects {
  if (typeof raw !== "object" || raw === null) return { ...NO_EFFECTS };
  const e = raw as Record<string, unknown>;
  const int = (x: unknown, fallback: number): number =>
    typeof x === "number" && Number.isInteger(x) ? x : fallback;
  return {
    rowOnFirstColour: int(e["rowOnFirstColour"], -1),
    rowFired: e["rowFired"] === true,
    areaEveryNthMatch: Math.max(0, int(e["areaEveryNthMatch"], 0)),
    matchesSoFar: Math.max(0, int(e["matchesSoFar"], 0)),
    wildFromRunSize: Math.max(0, int(e["wildFromRunSize"], 0)),
  };
}
