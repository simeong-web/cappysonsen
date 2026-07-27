/**
 * RUN STATE MACHINE — round start → moves → target check → draft → next round
 * or run end, and the end-to-end determinism that daily mode depends on.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg, roundTarget } from "../src/config";
import { rngInt } from "../src/rng";
import { swap, type BoardState, type Pos } from "../src/board";
import { CHARM_IDS, type CharmId } from "../src/charms";
import { roundTotal } from "../src/scoring";
import {
  chooseCharm,
  currentRoundScore,
  draftSeed,
  moveBudgetFor,
  newRun,
  playMove,
  rollCharmOffer,
  type RunState,
} from "../src/run";

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

interface RunLog {
  state: RunState;
  drafted: CharmId[];
  offers: CharmId[][];
  moves: number;
}

/** Plays a whole run: random legal moves, random picks from each draft. */
function playRun(seed: number, scriptSeed: number, moveCap = 3000): RunLog {
  let state = newRun(cfg, seed);
  let script = scriptSeed;
  const drafted: CharmId[] = [];
  const offers: CharmId[][] = [];
  let moves = 0;

  while (state.phase !== "over" && moves < moveCap) {
    if (state.phase === "drafting") {
      const offer = state.offer!;
      offers.push(offer);
      const pick = rngInt(script, offer.length);
      script = pick.state;
      const id = offer[pick.value]!;
      drafted.push(id);
      state = chooseCharm(cfg, state, id);
      continue;
    }
    const options = legalMoves(state.board);
    expect(options.length).toBeGreaterThan(0);
    const pick = rngInt(script, options.length);
    script = pick.state;
    const [a, b] = options[pick.value]!;
    const played = playMove(cfg, state, a, b);
    expect(played, "a legal move was refused").not.toBeNull();
    state = played!.state;
    moves++;
  }
  return { state, drafted, offers, moves };
}

describe("newRun", () => {
  it("starts at round 1, playing, with the base move budget", () => {
    const s = newRun(cfg, 42);
    expect(s.round).toBe(1);
    expect(s.phase).toBe("playing");
    expect(s.moveBudget).toBe(cfg.round.moveBudget);
    expect(s.movesUsed).toBe(0);
    expect(s.charms).toEqual([]);
    expect(s.offer).toBeNull();
    expect(s.totalScore).toBe(0);
    expect(s.rounds).toEqual([]);
    expect(roundTotal(s.score)).toBe(0);
  });

  it("is a pure function of the seed", () => {
    expect(newRun(cfg, 7)).toEqual(newRun(cfg, 7));
    expect(newRun(cfg, 7).board.grid).not.toEqual(newRun(cfg, 8).board.grid);
  });

  it("gives the draft its own stream, decorrelated from the board's", () => {
    const s = newRun(cfg, 1000);
    expect(s.draftRngState).toBe(draftSeed(1000));
    expect(s.draftRngState).not.toBe(s.board.rngState);
    expect(s.draftRngState).not.toBe(1000);
  });
});

describe("playMove", () => {
  it("refuses a fruitless swap without spending a move or moving the RNG", () => {
    const s = newRun(cfg, 5);
    // Find a pair that makes no match.
    let refused: [Pos, Pos] | null = null;
    outer: for (let row = 0; row < s.board.rows; row++) {
      for (let col = 0; col + 1 < s.board.cols; col++) {
        const a = { col, row };
        const b = { col: col + 1, row };
        if (!swap(s.board, a, b)) {
          refused = [a, b];
          break outer;
        }
      }
    }
    expect(refused).not.toBeNull();
    expect(playMove(cfg, s, refused![0], refused![1])).toBeNull();
    expect(s.movesUsed).toBe(0);
    expect(s.board.rngState).toBe(newRun(cfg, 5).board.rngState);
  });

  it("refuses non-adjacent swaps", () => {
    const s = newRun(cfg, 5);
    expect(playMove(cfg, s, { col: 0, row: 0 }, { col: 3, row: 3 })).toBeNull();
  });

  it("spends a move and banks warmth on a legal swap", () => {
    const s = newRun(cfg, 5);
    const [a, b] = legalMoves(s.board)[0]!;
    const out = playMove(cfg, s, a, b)!;
    expect(out.state.movesUsed).toBe(1);
    expect(out.state.score.warmth).toBeGreaterThan(0);
    expect(out.events.some((e) => e.type === "swapped")).toBe(true);
    expect(out.events.some((e) => e.type === "tilesCleared")).toBe(true);
    expect(out.state.stepsThisRound).toBeGreaterThan(0);
  });

  it("refuses to play while a draft is pending", () => {
    let log = playRun(31, 7);
    // Re-run until we catch a drafting state.
    let s = newRun(cfg, 31);
    let script = 7;
    while (s.phase === "playing") {
      const options = legalMoves(s.board);
      const pick = rngInt(script, options.length);
      script = pick.state;
      const [a, b] = options[pick.value]!;
      s = playMove(cfg, s, a, b)!.state;
    }
    expect(s.phase).toBe("drafting");
    const [a, b] = legalMoves(s.board)[0]!;
    expect(playMove(cfg, s, a, b)).toBeNull();
    expect(log.state.phase).toBe("over");
  });
});

describe("round transitions", () => {
  it("clears the round once the target is met, and offers a draft", () => {
    let s = newRun(cfg, 31);
    let script = 7;
    while (s.phase === "playing") {
      const options = legalMoves(s.board);
      const pick = rngInt(script, options.length);
      script = pick.state;
      const [a, b] = options[pick.value]!;
      s = playMove(cfg, s, a, b)!.state;
    }
    expect(s.phase).toBe("drafting");
    expect(s.offer).toHaveLength(cfg.draft.choiceCount);
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0]!.score).toBeGreaterThanOrEqual(roundTarget(cfg, 1));
    expect(s.rounds[0]!.cleared).toBe(true);
    expect(s.rounds[0]!.moveBudget).toBe(cfg.round.moveBudget);
    expect(s.totalScore).toBe(s.rounds[0]!.score);
  });

  it("choosing a charm starts the next round with a clean slate", () => {
    let s = newRun(cfg, 31);
    let script = 7;
    while (s.phase === "playing") {
      const options = legalMoves(s.board);
      const pick = rngInt(script, options.length);
      script = pick.state;
      const [a, b] = options[pick.value]!;
      s = playMove(cfg, s, a, b)!.state;
    }
    const picked = s.offer![0]!;
    const before = s.board.grid.slice();
    const next = chooseCharm(cfg, s, picked);

    expect(next.charms).toEqual([picked]);
    expect(next.round).toBe(2);
    expect(next.phase).toBe("playing");
    expect(next.offer).toBeNull();
    expect(next.movesUsed).toBe(0);
    expect(roundTotal(next.score)).toBe(0);
    expect(next.stepsThisRound).toBe(0);
    expect(next.moveBudget).toBe(moveBudgetFor(cfg, [picked]));
    // The board carries over — a Long Soak is "same board, plus a modifier".
    expect(next.board.grid).toEqual(before);
  });

  it("refuses a charm that was not on offer", () => {
    let s = newRun(cfg, 31);
    let script = 7;
    while (s.phase === "playing") {
      const options = legalMoves(s.board);
      const pick = rngInt(script, options.length);
      script = pick.state;
      const [a, b] = options[pick.value]!;
      s = playMove(cfg, s, a, b)!.state;
    }
    const notOffered = CHARM_IDS.find((id) => !s.offer!.includes(id))!;
    expect(chooseCharm(cfg, s, notOffered)).toBe(s);
    // And nothing can be chosen while playing.
    const playing = chooseCharm(cfg, s, s.offer![0]!);
    expect(chooseCharm(cfg, playing, playing.charms[0]!)).toBe(playing);
  });

  it("ends the run when the moves run out under target, banking the round", () => {
    const log = playRun(9, 3);
    expect(log.state.phase).toBe("over");
    expect(log.state.movesUsed).toBe(log.state.moveBudget);
    expect(currentRoundScore(cfg, log.state)).toBeLessThan(roundTarget(cfg, log.state.round));
    // The failed round still scores — the workbook counts it in "score at wall".
    expect(log.state.rounds).toHaveLength(log.state.round);
    expect(log.state.rounds[log.state.rounds.length - 1]!.cleared).toBe(false);
    expect(log.state.totalScore).toBeCloseTo(
      log.state.rounds.reduce((a, r) => a + r.score, 0),
      6,
    );
  });

  it("a run reaches an end rather than running forever", () => {
    for (const seed of [1, 2, 3, 11, 77]) {
      const log = playRun(seed, seed * 13);
      expect(log.state.phase).toBe("over");
      expect(log.state.round).toBeGreaterThanOrEqual(1);
      expect(log.moves).toBeLessThan(3000);
    }
  });
});

describe("charm drafting", () => {
  it("offers distinct charms, and never one already owned", () => {
    const owned: CharmId[] = ["deep_soak", "yuzu_grove"];
    const { offer } = rollCharmOffer(cfg, 12345, owned);
    expect(offer).toHaveLength(cfg.draft.choiceCount);
    expect(new Set(offer).size).toBe(offer.length);
    for (const id of offer) expect(owned).not.toContain(id);
  });

  it("is deterministic for a given stream position", () => {
    expect(rollCharmOffer(cfg, 999, [])).toEqual(rollCharmOffer(cfg, 999, []));
    expect(rollCharmOffer(cfg, 999, []).offer).not.toEqual(rollCharmOffer(cfg, 1000, []).offer);
  });

  it("shrinks gracefully as the pool empties", () => {
    const nearlyAll = CHARM_IDS.slice(0, CHARM_IDS.length - 2);
    expect(rollCharmOffer(cfg, 5, nearlyAll).offer).toHaveLength(2);
    expect(rollCharmOffer(cfg, 5, CHARM_IDS).offer).toEqual([]);
  });

  it("advances its stream so consecutive offers differ", () => {
    const first = rollCharmOffer(cfg, 4242, []);
    const second = rollCharmOffer(cfg, first.rngState, []);
    expect(first.rngState).not.toBe(4242);
    expect(first.offer).not.toEqual(second.offer);
  });

  it("does not depend on how the board was played (SPEC §4)", () => {
    // The daily promises identical charm offers worldwide. If offers drew from
    // the board stream, the cascades a player happened to trigger would shift
    // them. Two very different playthroughs of one seed, same first offer.
    const a = playRun(20260726, 111);
    const b = playRun(20260726, 999);
    expect(a.offers.length).toBeGreaterThan(0);
    expect(b.offers.length).toBeGreaterThan(0);
    expect(a.offers[0]).toEqual(b.offers[0]);
    // Later offers legitimately diverge: the pool excludes what you already own,
    // so they depend on the player's own picks.
  });
});

describe("end-to-end determinism", () => {
  it("same seed and same choices produce the same run, drafts included", () => {
    const a = playRun(20260726, 0xc0ffee);
    const b = playRun(20260726, 0xc0ffee);

    expect(a.state).toEqual(b.state);
    expect(a.drafted).toEqual(b.drafted);
    expect(a.offers).toEqual(b.offers);
    expect(a.moves).toBe(b.moves);
    expect(a.state.totalScore).toBe(b.state.totalScore);
  });

  it("holds across many seeds", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const a = playRun(seed, seed * 31);
      const b = playRun(seed, seed * 31);
      expect(a.state, `seed ${seed}`).toEqual(b.state);
      expect(a.offers, `seed ${seed} offers`).toEqual(b.offers);
    }
  });

  it("diverges on a different seed", () => {
    const a = playRun(1, 5);
    const b = playRun(2, 5);
    expect(a.state.board.grid).not.toEqual(b.state.board.grid);
  });

  it("a run's outcome is reproducible from the seed and the choice script alone", () => {
    // No hidden state: nothing outside RunState influences the result.
    const log = playRun(555, 42);
    const replay = playRun(555, 42);
    expect(replay.state.totalScore).toBe(log.state.totalScore);
    expect(replay.state.round).toBe(log.state.round);
    expect(replay.state.charms).toEqual(log.state.charms);
    expect(replay.state.rounds).toEqual(log.state.rounds);
  });
});
