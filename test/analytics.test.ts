/**
 * INSTRUMENTATION TESTS.
 *
 * The events are the balance patch list (SPEC §6), so the one that matters most
 * is that a draft reports every charm it SHOWED, not only the one taken —
 * picked over offered is the only signal that says a charm is dead.
 *
 * The rewarded-ad slots are tested as pure state transitions here. Whether an
 * ad ever plays is the client's problem, and on this platform it does not:
 * `ADS_ENABLED` is off in every build (see `ads.test.ts`). The builders
 * themselves outlived the port, but nothing in the shipped client emits them —
 * the platform has no events API, so the transport was deleted; see
 * docs/PORTING.md.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/sim/config";
import { CHARM_IDS, type CharmId } from "../src/sim/charms";
import {
  draftEvents,
  pickRates,
  roundCleared,
  runEnd,
  runStart,
  type AnalyticsEvent,
} from "../src/sim/analytics";
import {
  chooseCharm,
  newRun,
  playMove,
  rerollOffer,
  reviveWithMoves,
  type RunState,
} from "../src/sim/run";
import { newMeta, petalsFor, recordRun } from "../src/sim/meta";
import { swap, type BoardState, type Pos } from "../src/sim/board";
import { rngInt } from "../src/sim/rng";

function legalMoves(b: BoardState): [Pos, Pos][] {
  const out: [Pos, Pos][] = [];
  for (let row = 0; row < b.rows; row++) {
    for (let col = 0; col < b.cols; col++) {
      const a = { col, row };
      const right = { col: col + 1, row };
      const down = { col, row: row + 1 };
      if (col + 1 < b.cols && swap(b, a, right)) out.push([a, right]);
      if (row + 1 < b.rows && swap(b, a, down)) out.push([a, down]);
    }
  }
  return out;
}

/** Play to death, collecting the events a client would emit along the way. */
function playInstrumented(seed: number): { state: RunState; events: AnalyticsEvent[] } {
  let state = newRun(cfg, seed, "endless");
  const events: AnalyticsEvent[] = [runStart(state, 0, 12)];
  let script = seed * 7;

  for (let i = 0; i < 900 && state.phase !== "over"; i++) {
    if (state.phase === "drafting") {
      const offer = state.offer ?? [];
      if (offer.length === 0) break;
      const pick = rngInt(script, offer.length);
      script = pick.state;
      const taken = offer[pick.value]!;
      events.push(...draftEvents(offer, taken, state.round));
      state = chooseCharm(cfg, state, taken);
      continue;
    }
    const options = legalMoves(state.board);
    if (options.length === 0) break;
    const pick = rngInt(script, options.length);
    script = pick.state;
    const played = playMove(cfg, state, options[pick.value]![0], options[pick.value]![1])!;
    state = played.state;
    if (state.phase === "drafting") {
      const ev = roundCleared(state, false);
      if (ev) events.push(ev);
    }
  }
  events.push(runEnd(state, 0, petalsFor(state)));
  return { state, events };
}

describe("the five events the milestone asks for", () => {
  it("emits all of them across a real run", () => {
    const { events } = playInstrumented(11);
    const names = new Set(events.map((e) => e.name));
    expect(names).toContain("run_start");
    expect(names).toContain("round_cleared");
    expect(names).toContain("run_end");
    expect(names).toContain("charm_drafted");
    expect(names).toContain("charm_offered");
  });

  it("run_start describes the run about to happen", () => {
    const state = newRun(cfg, 5, "daily");
    const ev = runStart(state, 142, 19);
    expect(ev).toEqual({
      name: "run_start",
      mode: "daily",
      dailyNumber: 142,
      poolSize: state.pool.length,
      charmsUnlocked: 19,
    });
    // Endless carries no puzzle number to carry.
    expect(runStart(newRun(cfg, 5, "endless"), 142, 19)).toMatchObject({ dailyNumber: 0 });
  });

  it("round_cleared mirrors the round log exactly, and stays silent on a loss", () => {
    const { state, events } = playInstrumented(7);
    const cleared = events.filter((e) => e.name === "round_cleared");
    expect(cleared.length).toBe(state.rounds.filter((r) => r.cleared).length);
    for (const ev of cleared) {
      if (ev.name !== "round_cleared") continue;
      const log = state.rounds.find((r) => r.round === ev.round)!;
      expect(ev.movesUsed).toBe(log.movesUsed);
      expect(ev.score).toBe(log.score);
      expect(ev.target).toBe(log.target);
    }
    // The failed round never produces one.
    const dead = { ...state, rounds: state.rounds.slice(-1) };
    expect(roundCleared(dead, false)).toBeNull();
  });

  it("run_end carries the round reached, which is the headline number", () => {
    const { state } = playInstrumented(3);
    const ev = runEnd(state, 0, 42);
    expect(ev).toMatchObject({
      name: "run_end",
      roundReached: state.round,
      roundsCleared: state.rounds.filter((r) => r.cleared).length,
      totalScore: state.totalScore,
      petals: 42,
    });
  });
});

describe("offered-but-declined — the charm balance data", () => {
  it("reports every charm a draft showed, not just the one taken", () => {
    const offer: CharmId[] = ["deep_soak", "yuzu_grove", "extra_towel"];
    const events = draftEvents(offer, "yuzu_grove", 4);

    const offered = events.filter((e) => e.name === "charm_offered");
    expect(offered).toHaveLength(3);
    expect(offered.filter((e) => e.name === "charm_offered" && e.taken)).toHaveLength(1);
    // The two that were passed over are exactly what the ratio needs.
    const declined = offered.filter((e) => e.name === "charm_offered" && !e.taken);
    expect(declined.map((e) => (e.name === "charm_offered" ? e.charm : ""))).toEqual([
      "deep_soak",
      "extra_towel",
    ]);
    expect(events.filter((e) => e.name === "charm_drafted")).toHaveLength(1);
  });

  it("aggregates into a pick rate per charm", () => {
    const events = [
      ...draftEvents(["deep_soak", "yuzu_grove"], "deep_soak", 1),
      ...draftEvents(["deep_soak", "extra_towel"], "deep_soak", 2),
      ...draftEvents(["yuzu_grove", "extra_towel"], "extra_towel", 3),
    ];
    const rates = pickRates(events);
    expect(rates.get("deep_soak")).toEqual({ offered: 2, taken: 2 });
    expect(rates.get("yuzu_grove")).toEqual({ offered: 2, taken: 0 }); // never wanted
    expect(rates.get("extra_towel")).toEqual({ offered: 2, taken: 1 });
  });

  it("every offer in a real run is accounted for", () => {
    const { events } = playInstrumented(21);
    const drafted = events.filter((e) => e.name === "charm_drafted").length;
    const takenFlags = events.filter((e) => e.name === "charm_offered" && e.taken).length;
    expect(takenFlags).toBe(drafted);
    for (const [charm] of pickRates(events)) expect(CHARM_IDS).toContain(charm);
  });
});

describe("rewarded-ad slots, as state transitions", () => {
  it("+5 moves puts the failed round back, board and score intact", () => {
    const { state } = playInstrumented(9);
    expect(state.phase).toBe("over");
    const failed = state.rounds[state.rounds.length - 1]!;
    expect(failed.cleared).toBe(false);

    const revived = reviveWithMoves(cfg, state, 5);
    expect(revived.phase).toBe("playing");
    expect(revived.moveBudget).toBe(state.moveBudget + 5);
    expect(revived.round).toBe(state.round); // the SAME round, not a new one
    expect(revived.board).toBe(state.board); // same board, mid-round
    expect(revived.score).toBe(state.score); // warmth and bliss kept
    // The failed round is un-banked so it cannot be counted twice.
    expect(revived.rounds).toHaveLength(state.rounds.length - 1);
    expect(revived.totalScore).toBeCloseTo(state.totalScore - failed.score, 6);
  });

  it("refuses to revive anything that is not a run that just ran out", () => {
    const alive = newRun(cfg, 4, "endless");
    expect(reviveWithMoves(cfg, alive, 5)).toBe(alive);

    const { state } = playInstrumented(9);
    expect(reviveWithMoves(cfg, state, 0)).toBe(state);
    // A run that ended on a cleared round is not a failure to undo.
    const fudged = { ...state, rounds: [{ ...state.rounds[0]!, cleared: true }] };
    expect(reviveWithMoves(cfg, fudged, 5)).toBe(fudged);
  });

  it("the ad reroll costs no charm allowance, the charm reroll does", () => {
    let state = newRun(cfg, 21, "endless");
    state = { ...state, phase: "drafting", offer: ["deep_soak"], rerollsLeft: 0 };

    // No allowance: the ordinary reroll is refused...
    expect(rerollOffer(cfg, state)).toBe(state);
    // ...but the earned one goes through and still costs nothing.
    const free = rerollOffer(cfg, state, { free: true });
    expect(free).not.toBe(state);
    expect(free.rerollsLeft).toBe(0);
    expect(free.offer).not.toEqual(state.offer);

    // With an allowance, the ordinary reroll spends it.
    const paid = rerollOffer(cfg, { ...state, rerollsLeft: 1 });
    expect(paid.rerollsLeft).toBe(0);
  });

  it("double petals scales the award and nothing else", () => {
    const { state } = playInstrumented(13);
    const single = recordRun(newMeta(), state);
    const double = recordRun(newMeta(), state, 2);
    expect(double.petals).toBe(Math.floor(petalsFor(state) * 2));
    expect(double.petals).toBeGreaterThan(single.petals);
    // Records of what the player actually did are untouched by the multiplier.
    expect(double.bestScore).toBe(single.bestScore);
    expect(double.bestRound).toBe(single.bestRound);
    expect(double.runsPlayed).toBe(single.runsPlayed);
    // A multiplier below 1 cannot be used to shave petals.
    expect(recordRun(newMeta(), state, 0.5).petals).toBe(single.petals);
  });
});
