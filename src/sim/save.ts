/**
 * Save system — versioned JSON envelope, migration map, validate-and-repair.
 *
 * Ported from Emberkeep's `src/save.ts`. The envelope machinery (version field,
 * step-by-step migration, reject-the-future, never-throw) is carried over
 * unchanged; two things are deliberately different, both noted inline below:
 * the state validator is injected rather than imported, and there is no
 * offline-progress path (Emberkeep is an idler; a match-3 run does not accrue
 * anything while the tab is shut).
 *
 * Design rules:
 *  - The module stays clock-free: callers pass `nowMs` (`Date.now()` in the UI,
 *    a fixed value in tests). Determinism survives.
 *  - Every schema change bumps SAVE_VERSION and adds one migration function in
 *    the same commit. Old saves are upgraded step by step; a save from the
 *    future is rejected.
 *  - Corrupt saves return null — the caller starts a fresh run. Never throw at
 *    a player.
 */

export const SAVE_VERSION = 2;

/**
 * localStorage namespace. Rule 9: the slug `cappys-onsen` is the URL, the build
 * folder and this key at once, so it lives in exactly one place. `src/` never
 * touches storage itself — the client reads and writes under this key.
 */
export const SAVE_KEY = "cappys-onsen";

export interface SaveEnvelope<S> {
  version: number;
  savedAtMs: number;
  state: S;
}

/**
 * Structural validation + light repair of a migrated payload. Returns null when
 * the payload is unusable; clamps rather than rejecting wherever a sane value
 * can be recovered.
 *
 * Injected instead of imported (Emberkeep hard-imported `SimState`) because the
 * run state does not exist until Milestone 2, and because the envelope
 * machinery is the part worth testing on its own. Milestone 2 supplies a real
 * validator here without touching this file.
 */
export type Validator<S> = (state: unknown) => S | null;

/** A migration takes a version-N envelope and returns a version-N+1 envelope. */
export type Migration = (env: SaveEnvelope<unknown>) => SaveEnvelope<unknown>;

/**
 * Migrations: version N -> N+1. When SAVE_VERSION bumps to 2, add
 *   1: (env) => ({ ...env, version: 2, state: { ...(env.state as object), newField: default } })
 */
export const MIGRATIONS: Record<number, Migration> = {
  /**
   * v1 -> v2: the meta layer (Milestone 7).
   *
   * v1 predates petals, unlocks and décor entirely, so a v1 record simply has
   * none of those fields. Defaults are supplied rather than the save rejected:
   * a returning player keeps whatever run was in progress and starts the meta
   * layer from zero, which is exactly where they would have been anyway.
   *
   * The run itself also gained a draft pool and per-round colour tallies. Those
   * are filled by `validateRun`, which supplies defaults for anything a v1 run
   * could not have carried.
   */
  1: (env) => ({
    ...env,
    version: 2,
    state:
      typeof env.state === "object" && env.state !== null
        ? { ...(env.state as object) }
        : env.state,
  }),
};

/** True only for real, finite numbers — rejects NaN, Infinity and numeric strings. */
export function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Repair helper: pull a finite number into range, or fall back when it isn't one. */
export function clampNum(x: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNum(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

export function serializeSave<S>(state: S, nowMs: number): string {
  const env: SaveEnvelope<S> = { version: SAVE_VERSION, savedAtMs: nowMs, state };
  return JSON.stringify(env);
}

/**
 * Parse + migrate + validate. Null on anything unusable — malformed JSON, a
 * save written by a newer build, a version with no migration path, or a state
 * the validator rejects.
 */
export function parseSave<S>(
  raw: string,
  validate: Validator<S>,
  migrations: Record<number, Migration> = MIGRATIONS,
): SaveEnvelope<S> | null {
  let env: SaveEnvelope<unknown>;
  try {
    env = JSON.parse(raw) as SaveEnvelope<unknown>;
  } catch {
    return null;
  }
  if (typeof env !== "object" || env === null) return null;
  if (!isFiniteNum(env.version) || !isFiniteNum(env.savedAtMs)) return null;
  if (env.version > SAVE_VERSION) return null; // save from a newer build

  while (env.version < SAVE_VERSION) {
    const migrate = migrations[env.version];
    if (!migrate) return null;
    const before = env.version;
    env = migrate(env);
    // A migration that fails to advance the version would spin forever; a
    // corrupt save must never hang the client.
    if (!isFiniteNum(env.version) || env.version <= before) return null;
  }

  const state = validate(env.state);
  return state === null ? null : { version: env.version, savedAtMs: env.savedAtMs, state };
}

export interface LoadResult<S> {
  state: S;
  /** false when the save was missing or unusable and `fresh()` was used instead. */
  loaded: boolean;
}

/**
 * The full load path: parse -> migrate -> validate, falling back to a fresh run
 * on anything unusable, so callers can always render something.
 *
 * `raw` is nullable because that is what `localStorage.getItem` hands back on a
 * first visit.
 */
export function loadSave<S>(raw: string | null, validate: Validator<S>, fresh: () => S): LoadResult<S> {
  if (raw === null) return { state: fresh(), loaded: false };
  const env = parseSave(raw, validate);
  return env === null ? { state: fresh(), loaded: false } : { state: env.state, loaded: true };
}
