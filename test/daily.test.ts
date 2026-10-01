/**
 * DAILY MODE TESTS — the traffic engine's contract.
 *
 * Two people on opposite sides of the world must get the same board from the
 * same puzzle number, forever. That is one pure function chain — date → key →
 * seed → run — and this file pins every link in it.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/sim/config";
import {
  civilFromDays,
  dailyPageUrl,
  dailyNumberOf,
  dailyNumberOfDay,
  dailySeed,
  dateKeyOf,
  dateKeyOfDaily,
  dateKeyOfDay,
  daysFromCivil,
  dayOfDateKey,
  seedOfDaily,
  shareText,
  utcDayOf,
  verdictOf,
  type DailyConfig,
} from "../src/sim/daily";
import { chooseCharm, newRun, playMove, shareTextFor, validateRun, type RunState } from "../src/sim/run";
import { parseSave, serializeSave } from "../src/sim/save";
import { validateDailyProgress, validateEndlessProgress, KEYS } from "../src/sim/store";
import { swap, type BoardState, type Pos } from "../src/sim/board";
import { rngInt } from "../src/sim/rng";

const daily: DailyConfig = cfg.daily;

describe("civil calendar maths", () => {
  it("round-trips every day across a 40-year span", () => {
    // -3653 to ~11000 covers 1960 through 2000+30 years, leap years and all.
    for (let day = -3653; day < 11000; day += 1) {
      const { y, m, d } = civilFromDays(day);
      expect(daysFromCivil(y, m, d), `day ${day}`).toBe(day);
    }
  });

  it("agrees with known dates", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(dateKeyOfDay(0)).toBe("1970-01-01");
    expect(daysFromCivil(2000, 2, 29)).toBe(11016); // a real leap day
    expect(dateKeyOfDay(11016)).toBe("2000-02-29");
    expect(dateKeyOfDay(daysFromCivil(2026, 7, 27))).toBe("2026-07-27");
  });

  it("rejects dates that do not exist", () => {
    expect(dayOfDateKey("2026-02-31")).toBeNull();
    expect(dayOfDateKey("2025-02-29")).toBeNull(); // 2025 is not a leap year
    expect(dayOfDateKey("2026-13-01")).toBeNull();
    expect(dayOfDateKey("2026-00-10")).toBeNull();
    expect(dayOfDateKey("nonsense")).toBeNull();
    expect(dayOfDateKey("2026-2-3")).toBeNull(); // unpadded
    expect(dayOfDateKey("2024-02-29")).toBe(daysFromCivil(2024, 2, 29)); // real leap day
  });

  it("uses UTC, so the day only turns over at midnight UTC", () => {
    const midnight = Date.UTC(2026, 6, 27, 0, 0, 0);
    expect(dateKeyOf(midnight)).toBe("2026-07-27");
    expect(dateKeyOf(midnight + 86_399_999)).toBe("2026-07-27"); // 23:59:59.999
    expect(dateKeyOf(midnight + 86_400_000)).toBe("2026-07-28");
    // A local-midnight scheme would disagree here; UTC is what makes a
    // /daily/N permalink mean one puzzle everywhere at once.
    expect(utcDayOf(midnight)).toBe(utcDayOf(midnight + 43_200_000));
  });
});

describe("daily numbering", () => {
  it("makes the epoch date Daily #1", () => {
    expect(dailyNumberOfDay(daily, dayOfDateKey(daily.epoch)!)).toBe(1);
    expect(dateKeyOfDaily(daily, 1)).toBe(daily.epoch);
  });

  it("advances one per UTC day and inverts cleanly", () => {
    for (let n = 1; n <= 400; n++) {
      const key = dateKeyOfDaily(daily, n);
      expect(dailyNumberOfDay(daily, dayOfDateKey(key)!), `daily ${n}`).toBe(n);
    }
  });

  it("derives the number from a timestamp", () => {
    const epochMs = dayOfDateKey(daily.epoch)! * 86_400_000;
    expect(dailyNumberOf(daily, epochMs)).toBe(1);
    expect(dailyNumberOf(daily, epochMs + 86_400_000 * 141)).toBe(142);
  });
});

describe("daily seed", () => {
  it("is a pure function of the date string", () => {
    expect(dailySeed("2026-07-27")).toBe(dailySeed("2026-07-27"));
    expect(dailySeed("2026-07-27")).not.toBe(dailySeed("2026-07-28"));
  });

  it("is pinned — changing it reshuffles every daily ever played", () => {
    expect(dailySeed("2026-07-27")).toBe(1150819893);
    expect(dailySeed("1970-01-01")).toBe(1421751008);
    expect(seedOfDaily(daily, 1)).toBe(dailySeed(daily.epoch));
  });

  it("gives consecutive days unrelated seeds", () => {
    // Hashing the STRING rather than the day index is what buys this: adjacent
    // seeds would mean adjacent dailies opening on visibly similar boards.
    const seeds = [];
    for (let n = 1; n <= 60; n++) seeds.push(seedOfDaily(daily, n));
    for (let i = 1; i < seeds.length; i++) {
      expect(Math.abs(seeds[i]! - seeds[i - 1]!)).toBeGreaterThan(1000);
    }
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("stays inside int32, which is what the RNG contract assumes", () => {
    for (let n = 1; n <= 500; n++) {
      const seed = seedOfDaily(daily, n);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBe(seed | 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────── the promise

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

/** An independent "client": knows only the puzzle number and its own choices. */
function client(n: number, scriptSeed: number, moves: number) {
  let state = newRun(cfg, seedOfDaily(daily, n), "daily");
  const boards: string[] = [state.board.grid.join("")];
  const offers: string[] = [];
  let script = scriptSeed;
  for (let i = 0; i < moves && state.phase !== "over"; i++) {
    if (state.phase === "drafting") {
      offers.push((state.offer ?? []).join(","));
      const pick = rngInt(script, state.offer!.length);
      script = pick.state;
      state = chooseCharm(cfg, state, state.offer![pick.value]!);
      continue;
    }
    const options = legalMoves(state.board);
    if (options.length === 0) break;
    const pick = rngInt(script, options.length);
    script = pick.state;
    const [a, b] = options[pick.value]!;
    state = playMove(cfg, state, a, b)!.state;
    boards.push(state.board.grid.join(""));
  }
  return { state, boards, offers };
}

describe("the daily promise: same number, same puzzle", () => {
  it("two clients that play identically get a byte-identical board sequence", () => {
    for (const n of [1, 7, 142, 365]) {
      const a = client(n, 999, 40);
      const b = client(n, 999, 40);
      expect(a.boards, `daily ${n}`).toEqual(b.boards);
      expect(a.offers, `daily ${n} offers`).toEqual(b.offers);
      expect(a.state).toEqual(b.state);
    }
  });

  it("two clients that play DIFFERENTLY still get the same first offer", () => {
    // SPEC §4 promises identical charm offers, and the draft stream is separate
    // from the board's precisely so that how you played cannot shift them.
    const a = client(142, 11, 60);
    const b = client(142, 77, 60);
    expect(a.boards[0]).toBe(b.boards[0]);
    expect(a.offers.length).toBeGreaterThan(0);
    expect(b.offers.length).toBeGreaterThan(0);
    expect(a.offers[0]).toBe(b.offers[0]);
  });

  it("different puzzle numbers are different puzzles", () => {
    expect(client(1, 5, 5).boards[0]).not.toBe(client(2, 5, 5).boards[0]);
  });
});

// ─────────────────────────────────────────────────────────────── share grid

describe("share grid (SPEC §4)", () => {
  const budget = 20;

  it("marks a comfortable clear green and a squeaked clear yellow", () => {
    expect(verdictOf({ movesUsed: 11, moveBudget: budget, cleared: true })).toBe("green");
    expect(verdictOf({ movesUsed: 17, moveBudget: budget, cleared: true })).toBe("yellow");
    expect(verdictOf({ movesUsed: 20, moveBudget: budget, cleared: true })).toBe("yellow");
    expect(verdictOf({ movesUsed: 20, moveBudget: budget, cleared: false })).toBe("red");
  });

  it("renders the SPEC §4 shape", () => {
    const text = shareText(daily, {
      dailyNumber: 142,
      roundReached: 9,
      totalScore: 48320,
      rounds: [
        { movesUsed: 8, moveBudget: 20, cleared: true },
        { movesUsed: 9, moveBudget: 20, cleared: true },
        { movesUsed: 10, moveBudget: 20, cleared: true },
        { movesUsed: 18, moveBudget: 20, cleared: true },
        { movesUsed: 11, moveBudget: 20, cleared: true },
        { movesUsed: 12, moveBudget: 20, cleared: true },
        { movesUsed: 20, moveBudget: 20, cleared: false },
      ],
    });
    expect(text).toBe(
      "🛁 Cappy's Onsen — Daily #142\n" +
        "Round 9 · 48,320 warmth\n" +
        "🟢🟢🟢🟡🟢🟢🔴\n" +
        "capybaraclub.com",
    );
  });

  it("is spoiler-free: no tile, colour, charm or board state leaks", () => {
    const run = client(142, 3, 400).state;
    const text = shareTextFor(cfg, run, 142);
    for (const leak of ["yuzu", "petal", "bubble", "stone", "leaf"]) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
    for (const id of run.charms) expect(text.toLowerCase()).not.toContain(id.replace(/_/g, " "));
    // Only the four documented lines, and the grid is only ever the 3 squares.
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]!.replace(/[🟢🟡🔴]/gu, "")).toBe("");
  });

  it("has one square per round actually played", () => {
    const run = client(7, 21, 400).state;
    const grid = shareTextFor(cfg, run, 7).split("\n")[2]!;
    expect([...grid].length).toBe(run.rounds.length);
    // The run ended, so the last square is the red one.
    expect(grid.endsWith("🔴")).toBe(true);
  });

  it("builds a canonical permalink per puzzle", () => {
    expect(dailyPageUrl(daily, 142)).toBe("https://capybaraclub.com/games/cappys-onsen/daily/142/");
  });

  it("carries the site URL so a shared grid points home", () => {
    expect(shareTextFor(cfg, client(3, 1, 30).state, 3).endsWith(cfg.daily.siteUrl)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────── one run per day

describe("persistence", () => {
  const NOW = 1_800_000_000_000;

  it("round-trips a daily run through save.ts", () => {
    const run = client(142, 5, 25).state;
    const progress = { dailyNumber: 142, run };
    const loaded = parseSave(serializeSave(progress, NOW), validateDailyProgress);
    expect(loaded).not.toBeNull();
    expect(loaded!.state.dailyNumber).toBe(142);
    expect(loaded!.state.run).toEqual(run);
  });

  it("a resumed run continues identically to one that was never saved", () => {
    const mid = client(142, 5, 20).state;
    const revived = parseSave(serializeSave({ dailyNumber: 142, run: mid }, NOW), validateDailyProgress)!
      .state.run;
    expect(revived).toEqual(mid);

    const step = (s: RunState): RunState => {
      const options = legalMoves(s.board);
      return playMove(cfg, s, options[0]![0], options[0]![1])!.state;
    };
    expect(step(revived)).toEqual(step(mid));
  });

  it("rejects a run that is structurally broken rather than half-loading it", () => {
    const run = client(1, 1, 5).state;
    const bad: unknown[] = [
      null,
      {},
      { ...run, mode: "sideways" },
      { ...run, phase: "napping" },
      { ...run, board: null },
      { ...run, round: 0 },
      { ...run, moveBudget: 0 },
      { ...run, score: { warmth: "x", blissAdd: 0, blissMult: 1 } },
      { ...run, rounds: [{ round: 1 }] },
      { ...run, offer: 5 },
    ];
    for (const raw of bad) expect(validateRun(raw)).toBeNull();
  });

  it("strips charms it no longer recognises instead of losing the run", () => {
    const run = client(1, 1, 200).state;
    const withGhost = { ...run, charms: [...run.charms, "ghost_charm"] };
    const out = validateRun(withGhost);
    expect(out).not.toBeNull();
    expect(out!.charms).toEqual(run.charms);
  });

  it("will not load an endless run as a daily, or the reverse", () => {
    const endless = newRun(cfg, 1, "endless");
    const daily7 = newRun(cfg, 1, "daily");
    expect(validateDailyProgress({ dailyNumber: 1, run: endless })).toBeNull();
    expect(validateEndlessProgress({ run: daily7 })).toBeNull();
    expect(validateDailyProgress({ dailyNumber: 1, run: daily7 })).not.toBeNull();
    expect(validateEndlessProgress({ run: endless })).not.toBeNull();
  });

  it("namespaces its keys under the permanent slug (rule 9)", () => {
    expect(KEYS.daily.startsWith("cappys-onsen")).toBe(true);
    expect(KEYS.endless.startsWith("cappys-onsen")).toBe(true);
    expect(KEYS.daily).not.toBe(KEYS.endless);
  });
});
