/**
 * Persistence: the meta layer, today's daily, and the endless run in progress.
 *
 * THE HOST OWNS STORAGE. This game does not touch `localStorage`: the host
 * hands the last save to `onBoot` as `savedProgress` and takes a new one via
 * `saveProgress`, which is what lets the platform decide later that saves live
 * on a server instead — without a line changing here.
 *
 * The sim's versioned envelope (`../sim/save.ts`) is kept on top of that,
 * because the host stores an opaque value and makes no promise about what shape
 * it is in. Validation, versioning and migrations are still this game's
 * problem, and a save written by a newer build still has to be refused by an
 * older one.
 *
 * What used to be three localStorage records under `cappys-onsen:*` is now one
 * value with three fields. Each field goes through the validator the sim
 * already had for it, so each is repaired or dropped on its own: a corrupt
 * daily never costs a player their petals.
 *
 * The rule this file exists to honour: NEVER THROW AT A PLAYER. Anything
 * unusable comes back as a fresh save.
 */
import { SAVE_VERSION, parseSave, type SaveEnvelope } from "../sim/save";
import { newMeta, validateMeta, type MetaState } from "../sim/meta";
import {
  validateDailyProgress,
  validateEndlessProgress,
  type DailyProgress,
  type EndlessProgress,
} from "../sim/store";

export interface Progress {
  meta: MetaState;
  /** Today's daily — or an older one, which the client discards on sight. */
  daily: DailyProgress | null;
  endless: EndlessProgress | null;
}

export const emptyProgress = (): Progress => ({ meta: newMeta(), daily: null, endless: null });

/**
 * Repair rather than reject. Only a payload that is not an object at all is
 * refused; inside one, a bad meta record becomes a fresh meta and a bad run
 * becomes no run.
 */
export function validateProgress(raw: unknown): Progress | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    meta: validateMeta(o["meta"]) ?? newMeta(),
    daily: o["daily"] === undefined || o["daily"] === null ? null : validateDailyProgress(o["daily"]),
    endless: o["endless"] === undefined || o["endless"] === null ? null : validateEndlessProgress(o["endless"]),
  };
}

/**
 * Read whatever the host was holding for this player.
 *
 * `savedProgress` is `unknown` by contract, and every unusable shape — absent,
 * junk, a save from a newer build — lands on the same answer: a fresh save. A
 * player is never shown an error because storage disagreed with the game.
 *
 * Both an object and a JSON string are accepted. The host round-trips the value
 * through its own storage and this game has no say in whether that preserves
 * the object or stringifies it, so it reads both rather than betting on one.
 */
export function loadHostSave(savedProgress: unknown): Progress {
  if (savedProgress === null || savedProgress === undefined) return emptyProgress();
  const raw = typeof savedProgress === "string" ? savedProgress : safeStringify(savedProgress);
  if (raw === null) return emptyProgress();
  const envelope = parseSave(raw, validateProgress);
  return envelope === null ? emptyProgress() : envelope.state;
}

/** The value to hand back to the host. Plain data — it has to survive its trip. */
export function toHostSave(progress: Progress, nowMs: number): SaveEnvelope<Progress> {
  return { version: SAVE_VERSION, savedAtMs: nowMs, state: progress };
}

/** A value with a cycle in it is not a save; it is a bug, and it is not fatal. */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
