/**
 * SAVE TESTS — ported from Emberkeep's save suite, retargeted at the envelope
 * machinery itself rather than at a game state that does not exist yet.
 *
 * The stand-in state below is deliberately shaped like the real one will be
 * (a round counter, a score, an rngState, an owned-charm list) so the
 * round-trip and repair cases exercise realistic payloads. Milestone 2 swaps in
 * the actual `RunState` validator; none of these tests should need rewriting.
 */
import { describe, it, expect } from "vitest";
import {
  SAVE_VERSION,
  SAVE_KEY,
  serializeSave,
  parseSave,
  loadSave,
  clampNum,
  isFiniteNum,
  type Migration,
} from "../src/save";

interface FakeState {
  round: number;
  warmth: number;
  rngState: number;
  charms: string[];
}

const KNOWN_CHARMS = ["sun_warmed_stone", "yuzu_grove", "deep_soak"];

const fresh = (): FakeState => ({ round: 1, warmth: 0, rngState: 0, charms: [] });

/** Same shape as a real validator: reject the unusable, clamp the recoverable. */
const validate = (raw: unknown): FakeState | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!isFiniteNum(s["round"]) || !isFiniteNum(s["warmth"]) || !isFiniteNum(s["rngState"])) return null;
  return {
    round: clampNum(s["round"], 1, 999, 1),
    warmth: Math.max(0, s["warmth"]),
    rngState: s["rngState"] | 0,
    charms: Array.isArray(s["charms"]) ? s["charms"].filter((c) => KNOWN_CHARMS.includes(c as string)) : [],
  };
};

const NOW = 1_800_000_000_000;

describe("save envelope", () => {
  it("round-trips a lived-in state exactly", () => {
    const s: FakeState = { round: 7, warmth: 48_320, rngState: 1831565813, charms: ["yuzu_grove"] };
    const loaded = parseSave(serializeSave(s, NOW), validate);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(SAVE_VERSION);
    expect(loaded!.savedAtMs).toBe(NOW);
    expect(loaded!.state).toEqual(s);
  });

  it("is clock-free: the timestamp is whatever the caller passed", () => {
    expect(JSON.parse(serializeSave(fresh(), 42)).savedAtMs).toBe(42);
  });

  it("rejects corrupt or hostile input without throwing", () => {
    const raws = [
      "",
      "not json",
      "[]",
      "null",
      "{}",
      '{"version":1}',
      '{"version":"1","savedAtMs":1,"state":{}}',
      '{"version":1,"savedAtMs":null,"state":{}}',
      `{"version":1,"savedAtMs":${NOW},"state":null}`,
      `{"version":1,"savedAtMs":${NOW},"state":{"round":"NaN","warmth":0,"rngState":0}}`,
      `{"version":1,"savedAtMs":${NOW},"state":{"round":1,"warmth":null,"rngState":0}}`,
    ];
    for (const raw of raws) expect(parseSave(raw, validate)).toBeNull();
  });

  it("rejects a save written by a newer build", () => {
    const raw = `{"version":${SAVE_VERSION + 1},"savedAtMs":${NOW},"state":{"round":1,"warmth":0,"rngState":0}}`;
    expect(parseSave(raw, validate)).toBeNull();
  });

  it("repairs rather than rejects where a sane value survives", () => {
    const raw = serializeSave(
      { round: 9999, warmth: -50, rngState: 12, charms: ["yuzu_grove", "hacked_charm"] } as FakeState,
      NOW,
    );
    const loaded = parseSave(raw, validate)!;
    expect(loaded.state.round).toBe(999); // clamped
    expect(loaded.state.warmth).toBe(0); // clamped
    expect(loaded.state.charms).toEqual(["yuzu_grove"]); // unknown id stripped
  });
});

describe("migrations", () => {
  // SAVE_VERSION is 1, so the only real migration step that can be driven
  // through parseSave today is an imagined v0 -> v1. That is enough to cover
  // the loop; the map itself is empty until a schema change earns an entry.
  const legacy = (state: unknown): string =>
    JSON.stringify({ version: 0, savedAtMs: NOW, state });

  it("upgrades an old save through every registered step, then validates it", () => {
    const migrations: Record<number, Migration> = {
      // v0 had no charm list — a migration supplies the default rather than
      // letting the validator reject an otherwise healthy save.
      0: (env) => ({ ...env, version: 1, state: { ...(env.state as object), charms: ["deep_soak"] } }),
      // SAVE_VERSION is 2 since the meta layer, so the chain must run twice.
      1: (env) => ({ ...env, version: 2 }),
    };
    const loaded = parseSave(legacy({ round: 4, warmth: 1200, rngState: 77 }), validate, migrations);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(SAVE_VERSION);
    expect(loaded!.state).toEqual({ round: 4, warmth: 1200, rngState: 77, charms: ["deep_soak"] });
  });

  it("passes a current-version save straight through, untouched", () => {
    const s: FakeState = { round: 4, warmth: 1200, rngState: 77, charms: ["deep_soak"] };
    const ran: number[] = [];
    const migrations: Record<number, Migration> = {
      0: (env) => {
        ran.push(0);
        return { ...env, version: 1 };
      },
      1: (env) => {
        ran.push(1);
        return { ...env, version: 2 };
      },
    };
    expect(parseSave(serializeSave(s, NOW), validate, migrations)!.state).toEqual(s);
    expect(ran).toEqual([]);
  });

  it("refuses a save whose version has no migration path", () => {
    // A gap in the map means we cannot know the old schema — unusable, not
    // repairable. The player gets a fresh run instead of a corrupted one.
    expect(parseSave(legacy({ round: 1, warmth: 0, rngState: 0 }), validate, {})).toBeNull();
  });

  it("refuses a migration that fails to advance the version instead of looping forever", () => {
    const stuck: Record<number, Migration> = { 0: (env) => env, 1: (env) => env };
    expect(parseSave(legacy({ round: 1, warmth: 0, rngState: 0 }), validate, stuck)).toBeNull();
  });

  it("still validates after migrating — a migration cannot smuggle junk through", () => {
    const bad: Record<number, Migration> = {
      0: (env) => ({ ...env, version: 1, state: { round: "x" } }),
      1: (env) => ({ ...env, version: 2 }),
    };
    expect(parseSave(legacy({ round: 1, warmth: 0, rngState: 0 }), validate, bad)).toBeNull();
  });
});

describe("loadSave", () => {
  it("returns the saved state when the payload is good", () => {
    const s: FakeState = { round: 3, warmth: 900, rngState: 5, charms: [] };
    const r = loadSave(serializeSave(s, NOW), validate, fresh);
    expect(r.loaded).toBe(true);
    expect(r.state).toEqual(s);
  });

  it("falls back to a fresh run on corrupt input rather than throwing", () => {
    const r = loadSave("garbage", validate, fresh);
    expect(r.loaded).toBe(false);
    expect(r.state).toEqual(fresh());
  });

  it("handles a first visit, where storage hands back null", () => {
    const r = loadSave(null, validate, fresh);
    expect(r.loaded).toBe(false);
    expect(r.state).toEqual(fresh());
  });
});

describe("storage namespace", () => {
  it("is the permanent slug (CLAUDE.md rule 9)", () => {
    expect(SAVE_KEY).toBe("cappys-onsen");
  });
});
