/**
 * Persistence shapes for the client.
 *
 * Pure: this module names the keys and validates the payloads, but never
 * touches storage — `localStorage` lives in `game/` (CLAUDE.md rule 1). Both
 * records go through `save.ts`, so both are versioned and both repair rather
 * than throw.
 */
import { SAVE_KEY } from "./save";
import { validateRun, type RunState } from "./run";
export { validateMeta } from "./meta";
export type { MetaState } from "./meta";

/** Rule 9: the slug is the namespace, so every key hangs off it. */
export const KEYS = {
  daily: `${SAVE_KEY}:daily`,
  endless: `${SAVE_KEY}:endless`,
  meta: `${SAVE_KEY}:meta`,
} as const;

/**
 * Today's daily, stored so a refresh resumes rather than restarts.
 *
 * `dailyNumber` is what enforces one run per day: on load, a record from a
 * different number is simply a different puzzle and gets discarded. Storing the
 * whole run — not just a "played today" flag — means a closed tab is not a lost
 * run, which matters when there is exactly one attempt.
 */
export interface DailyProgress {
  dailyNumber: number;
  run: RunState;
}

export function validateDailyProgress(raw: unknown): DailyProgress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const n = s["dailyNumber"];
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  const run = validateRun(s["run"]);
  if (run === null) return null;
  if (run.mode !== "daily") return null;
  return { dailyNumber: n, run };
}

/** An endless run in progress. Same idea, no day to match against. */
export interface EndlessProgress {
  run: RunState;
}

export function validateEndlessProgress(raw: unknown): EndlessProgress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const run = validateRun((raw as Record<string, unknown>)["run"]);
  if (run === null || run.mode !== "endless") return null;
  return { run };
}
