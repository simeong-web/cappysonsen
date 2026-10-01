/**
 * Analytics event shapes — definitions only, no transport.
 *
 * Pure by design and by rule 1: this module builds event objects and hands them
 * back. It opens no connection, reads no clock and knows nothing about a
 * dashboard. `game/analytics.ts` decides whether anything is ever sent, and by
 * default nothing is.
 *
 * ============================================================================
 * THE EVENT THAT MATTERS
 * ----------------------------------------------------------------------------
 * `charm_offered` fires for every charm a draft showed, and `charm_drafted` for
 * the one taken. Picked ÷ offered per charm is the balance data — it is the only
 * way to learn that a charm is never chosen, which no amount of playtesting
 * reliably surfaces. Everything else here is context for reading that ratio.
 * ============================================================================
 */
import type { CharmId } from "./charms";
import type { RunMode, RunState } from "./run";

export type AnalyticsEvent =
  | {
      name: "run_start";
      mode: RunMode;
      /** 0 for endless. */
      dailyNumber: number;
      poolSize: number;
      charmsUnlocked: number;
    }
  | {
      name: "round_cleared";
      round: number;
      movesUsed: number;
      moveBudget: number;
      score: number;
      target: number;
      charmsOwned: number;
      isLongSoak: boolean;
    }
  | {
      name: "run_end";
      mode: RunMode;
      dailyNumber: number;
      /** The round the run died on — the headline number for the curve. */
      roundReached: number;
      roundsCleared: number;
      totalScore: number;
      charms: CharmId[];
      petals: number;
    }
  | { name: "charm_drafted"; charm: CharmId; round: number }
  /** One per charm shown, taken or not. Pair with charm_drafted for the ratio. */
  | { name: "charm_offered"; charm: CharmId; round: number; taken: boolean };

export function runStart(state: RunState, dailyNumber: number, charmsUnlocked: number): AnalyticsEvent {
  return {
    name: "run_start",
    mode: state.mode,
    dailyNumber: state.mode === "daily" ? dailyNumber : 0,
    poolSize: state.pool.length,
    charmsUnlocked,
  };
}

/** Built from the round log the run just banked, so it cannot disagree with it. */
export function roundCleared(state: RunState, isLongSoak: boolean): AnalyticsEvent | null {
  const log = state.rounds[state.rounds.length - 1];
  if (!log || !log.cleared) return null;
  return {
    name: "round_cleared",
    round: log.round,
    movesUsed: log.movesUsed,
    moveBudget: log.moveBudget,
    score: log.score,
    target: log.target,
    charmsOwned: state.charms.length,
    isLongSoak,
  };
}

export function runEnd(state: RunState, dailyNumber: number, petals: number): AnalyticsEvent {
  return {
    name: "run_end",
    mode: state.mode,
    dailyNumber: state.mode === "daily" ? dailyNumber : 0,
    roundReached: state.round,
    roundsCleared: state.rounds.filter((r) => r.cleared).length,
    totalScore: state.totalScore,
    charms: [...state.charms],
    petals,
  };
}

/**
 * A whole draft, in one call: the charm taken plus every charm declined.
 *
 * Emitting the declines is the point. A charm that is offered constantly and
 * never taken is a charm to redesign, and only this ratio shows it.
 */
export function draftEvents(offer: readonly CharmId[], taken: CharmId, round: number): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = offer.map((charm) => ({
    name: "charm_offered" as const,
    charm,
    round,
    taken: charm === taken,
  }));
  events.push({ name: "charm_drafted", charm: taken, round });
  return events;
}

/**
 * Aggregate a stream of events into the pick rate per charm. Pure, so the debug
 * harness can run it over a batch of bot runs without a dashboard existing.
 */
export function pickRates(events: readonly AnalyticsEvent[]): Map<CharmId, { offered: number; taken: number }> {
  const out = new Map<CharmId, { offered: number; taken: number }>();
  for (const e of events) {
    if (e.name !== "charm_offered") continue;
    const row = out.get(e.charm) ?? { offered: 0, taken: 0 };
    row.offered++;
    if (e.taken) row.taken++;
    out.set(e.charm, row);
  }
  return out;
}
