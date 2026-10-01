/**
 * The host save — what used to be three localStorage records, now one value the
 * host holds for the player.
 *
 * The envelope machinery itself is pinned by `save.test.ts` and the per-record
 * validators by `daily.test.ts` and `meta.test.ts`. This file pins the layer the
 * port added on top: that the value survives a trip through the host in either
 * shape the host might hand it back in, that anything unusable starts fresh
 * rather than throwing at a player, and that one bad record does not take the
 * other two down with it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG as cfg } from "../src/sim/config";
import { newMeta, recordRun } from "../src/sim/meta";
import { newRun } from "../src/sim/run";
import { SAVE_VERSION } from "../src/sim/save";
import { emptyProgress, loadHostSave, toHostSave, type Progress } from "../src/game/progress";

/**
 * The host, as far as a save is concerned: it takes a value and gives it back.
 *
 * Twice, in two shapes — the host stores an opaque value and this game has no
 * say in whether that survives as an object or comes back stringified, so every
 * round-trip test runs through both.
 */
const asObject = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const asString = (value: unknown): unknown => JSON.stringify(value);

const daily = newRun(cfg, 1234, "daily");
const endless = newRun(cfg, 5678, "endless");

const played = (): Progress => ({
  meta: { ...recordRun(newMeta(), { ...daily, phase: "over", round: 4 }), petals: 37 },
  daily: { dailyNumber: 12, run: daily },
  endless: { run: endless },
});

describe("round trip", () => {
  it("survives a trip through the host, as an object and as a string", () => {
    const save = played();
    const stored = toHostSave(save, 1000);

    for (const carry of [asObject, asString]) {
      const loaded = loadHostSave(carry(stored));
      expect(loaded.meta.petals).toBe(37);
      expect(loaded.meta.runsPlayed).toBe(save.meta.runsPlayed);
      expect(loaded.daily?.dailyNumber).toBe(12);
      expect(loaded.daily?.run.seed).toBe(1234);
      expect(loaded.daily?.run.board).toEqual(daily.board);
      expect(loaded.endless?.run.seed).toBe(5678);
    }
  });

  it("is a versioned envelope, so an older build can refuse a newer save", () => {
    const stored = toHostSave(emptyProgress(), 42);
    expect(stored.version).toBe(SAVE_VERSION);
    expect(stored.savedAtMs).toBe(42);
  });

  it("carries both RNG cursors, so a resumed daily deals what everyone else is dealt", () => {
    const loaded = loadHostSave(asString(toHostSave(played(), 1)));
    expect(loaded.daily?.run.board.rngState).toBe(daily.board.rngState);
    expect(loaded.daily?.run.draftRngState).toBe(daily.draftRngState);
  });
});

describe("an unusable save starts fresh", () => {
  const fresh = (value: unknown): void => {
    expect(loadHostSave(value)).toEqual(emptyProgress());
  };

  it("on nothing at all — a player the host has never seen", () => {
    fresh(null);
    fresh(undefined);
  });
  it("on junk", () => fresh("not json at all"));
  it("on an empty string", () => fresh(""));
  it("on a truncated envelope", () => fresh('{"version":2,"state":'));
  it("on an envelope with no version", () => fresh({ savedAtMs: 1, state: played() }));
  it("on a save from a newer build", () =>
    fresh({ version: SAVE_VERSION + 1, savedAtMs: 1, state: played() }));
  it("on a null state", () => fresh({ version: SAVE_VERSION, savedAtMs: 1, state: null }));
  it("on something that is not a save at all", () => {
    fresh(42);
    fresh([1, 2, 3]);
    fresh(true);
  });
});

describe("one bad record does not cost the others", () => {
  const withState = (state: unknown): unknown => ({ version: SAVE_VERSION, savedAtMs: 1, state });

  it("a corrupt daily drops the daily and keeps the petals", () => {
    const loaded = loadHostSave(withState({ ...played(), daily: { dailyNumber: 12, run: { nonsense: true } } }));
    expect(loaded.daily).toBeNull();
    expect(loaded.meta.petals).toBe(37);
    expect(loaded.endless?.run.seed).toBe(5678);
  });

  it("a corrupt meta record becomes a fresh one and keeps the runs", () => {
    const loaded = loadHostSave(withState({ ...played(), meta: "garbage" }));
    expect(loaded.meta).toEqual(newMeta());
    expect(loaded.daily?.dailyNumber).toBe(12);
  });

  it("a run filed under the wrong mode is not resumed as the other one", () => {
    const loaded = loadHostSave(withState({ ...played(), endless: { run: daily } }));
    expect(loaded.endless).toBeNull();
  });
});

describe("the host owns storage", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));

  it("no file in src/ touches localStorage or sessionStorage", () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const code = readFileSync(join(SRC, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(/\b(?:local|session)Storage\b/.test(code), `${f} touches browser storage`).toBe(false);
    }
  });
});
