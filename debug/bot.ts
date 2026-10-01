/**
 * Autoplay policies and batch simulation for the tuning harness.
 *
 * Lives in `debug/` because it is a tuning tool, not part of the game: the sim
 * has no notion of a "player". Everything here drives the sim through its
 * public API only, so a bot run is exactly a human run with the clicking
 * automated.
 *
 * The bot's own randomness is seeded and threaded, same as the sim's, so
 * "seed 42 + random policy + bot seed 7" replays identically. Tuning against a
 * bot you cannot reproduce is not tuning.
 */
import { swap, type BoardState, type Pos } from "../src/sim/board";
import { rngInt } from "../src/sim/rng";
import { roundTarget, type BalanceConfig } from "../src/sim/config";
import type { CharmId } from "../src/sim/charms";
import { chooseCharm, currentRoundScore, newRun, playMove, type RunState } from "../src/sim/run";

export type Move = [Pos, Pos];
export type Policy = "random" | "greedy";

/**
 * Every legal move, found through the public `swap` — which returns null for an
 * illegal or fruitless pair, so this cannot disagree with what the sim accepts.
 */
export function legalMoves(board: BoardState): Move[] {
  const out: Move[] = [];
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

/**
 * Pick a move. `greedy` evaluates every option by actually playing it on a
 * copy — the sim is pure, so trying a move costs nothing and commits nothing.
 * It stands in for a strong player; `random` is a floor, well below an average
 * human. The truth the workbook's 0.8 skill factor models sits between them,
 * which is the point of shipping both.
 */
export function pickMove(
  cfg: BalanceConfig,
  state: RunState,
  policy: Policy,
  rngState: number,
): { move: Move | null; rngState: number } {
  const options = legalMoves(state.board);
  if (options.length === 0) return { move: null, rngState };

  if (policy === "random") {
    const r = rngInt(rngState, options.length);
    return { move: options[r.value] ?? null, rngState: r.state };
  }

  const before = currentRoundScore(cfg, state);
  let best = options[0]!;
  let bestGain = -Infinity;
  for (const [a, b] of options) {
    const played = playMove(cfg, state, a, b);
    if (!played) continue;
    // A move that clears the round banks its score, so score the banked total
    // as well as the round-local one or clearing looks like a loss.
    const gain =
      played.state.totalScore - state.totalScore + currentRoundScore(cfg, played.state) - before;
    if (gain > bestGain) {
      bestGain = gain;
      best = [a, b];
    }
  }
  return { move: best, rngState };
}

export interface RoundRecord {
  round: number;
  cleared: boolean;
  movesUsed: number;
  moveBudget: number;
  score: number;
  target: number;
  charmsOwned: number;
}

export interface RunSummary {
  seed: number;
  /** The round the run died on. */
  wallRound: number;
  roundsCleared: number;
  totalScore: number;
  charms: CharmId[];
  moves: number;
  rounds: RoundRecord[];
}

/** Play one run to death. `moveCap` guards against a policy that stalls. */
export function simulateRun(
  cfg: BalanceConfig,
  seed: number,
  policy: Policy,
  botSeed: number,
  moveCap = 4000,
): RunSummary {
  let state = newRun(cfg, seed);
  let rng = botSeed;
  let moves = 0;
  const rounds: RoundRecord[] = [];

  /**
   * `before` is the state the move was played from, so its `round`,
   * `moveBudget` and charm count describe the round that just ended — `after`
   * may already have started the next one.
   */
  const record = (before: RunState, after: RunState, cleared: boolean, movesUsed: number): void => {
    rounds.push({
      round: before.round,
      cleared,
      movesUsed,
      moveBudget: before.moveBudget,
      score: after.rounds[after.rounds.length - 1]?.score ?? 0,
      target: roundTarget(cfg, before.round),
      charmsOwned: before.charms.length,
    });
  };

  while (state.phase !== "over" && moves < moveCap) {
    if (state.phase === "drafting") {
      const offer = state.offer ?? [];
      if (offer.length === 0) break;
      // Random pick: choosing well needs lookahead the harness does not have,
      // and pretending otherwise would flatter the charm numbers.
      const r = rngInt(rng, offer.length);
      rng = r.state;
      state = chooseCharm(cfg, state, offer[r.value]!);
      continue;
    }
    const picked = pickMove(cfg, state, policy, rng);
    rng = picked.rngState;
    if (!picked.move) break;
    const played = playMove(cfg, state, picked.move[0], picked.move[1]);
    if (!played) break;
    moves++;
    const spent = state.movesUsed + 1;
    if (played.state.phase === "drafting") {
      record(state, played.state, true, spent);
    } else if (played.state.phase === "over") {
      record(state, played.state, false, spent);
    } else if (played.state.round > state.round) {
      // Cleared, but the charm pool was empty so the run advanced straight on
      // without a draft. Recording this is what stops the per-round table from
      // silently losing every round after the pool runs dry — which is exactly
      // where a strong player spends the end of a run.
      record(state, played.state, true, spent);
    }
    state = played.state;
  }

  return {
    seed,
    wallRound: state.round,
    roundsCleared: rounds.filter((r) => r.cleared).length,
    totalScore: state.totalScore,
    charms: state.charms,
    moves,
    rounds,
  };
}

export interface PerRound {
  round: number;
  /** Runs that reached this round at all. */
  reached: number;
  cleared: number;
  /** Median moves spent, over the runs that cleared it. */
  medianMovesToClear: number;
  /** Median score / target, over every run that reached it. */
  medianScoreRatio: number;
}

export interface BatchStats {
  runs: number;
  policy: Policy;
  wallHistogram: Map<number, number>;
  medianWall: number;
  meanWall: number;
  medianScore: number;
  meanCharms: number;
  perRound: PerRound[];
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
};

/**
 * The tuning readout.
 *
 * NOTE ON WHAT IS *NOT* HERE: there is no fitted "score gain per charm" to
 * compare against Assumptions!B39, because a round ends the instant its target
 * is met — every cleared round scores just over 1x target by construction, so
 * fitting growth to round scores would only measure the stopping rule.
 * `medianMovesToClear` is the honest signal instead: if charms keep pace with
 * the target curve it stays flat round over round, and if they lag it climbs.
 * Compare it against the Rounds sheet's "Moves needed" column.
 */
export function summarise(summaries: RunSummary[], policy: Policy): BatchStats {
  const walls = summaries.map((s) => s.wallRound);
  const wallHistogram = new Map<number, number>();
  for (const w of walls) wallHistogram.set(w, (wallHistogram.get(w) ?? 0) + 1);

  const maxRound = Math.max(1, ...walls);
  const perRound: PerRound[] = [];
  for (let round = 1; round <= maxRound; round++) {
    const records = summaries
      .map((s) => s.rounds.find((r) => r.round === round))
      .filter((r): r is RoundRecord => r !== undefined);
    if (records.length === 0) continue;
    perRound.push({
      round,
      reached: records.length,
      cleared: records.filter((r) => r.cleared).length,
      medianMovesToClear: median(records.filter((r) => r.cleared).map((r) => r.movesUsed)),
      medianScoreRatio: median(records.map((r) => r.score / r.target)),
    });
  }

  return {
    runs: summaries.length,
    policy,
    wallHistogram,
    medianWall: median(walls),
    meanWall: walls.reduce((a, b) => a + b, 0) / Math.max(1, walls.length),
    medianScore: median(summaries.map((s) => s.totalScore)),
    meanCharms: summaries.reduce((a, s) => a + s.charms.length, 0) / Math.max(1, summaries.length),
    perRound,
  };
}
