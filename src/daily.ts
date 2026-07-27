/**
 * Daily mode — the traffic engine (SPEC §4).
 *
 * Everything here is pure arithmetic on a caller-supplied `nowMs`. No `Date`
 * at all, not even to format a day: `new Date(ms)` would be deterministic, but
 * the purity guard in the test suite bans the identifier outright, and the
 * civil-calendar maths below is exact and about fifteen lines.
 *
 * ============================================================================
 * THE DAY BOUNDARY IS UTC
 * ----------------------------------------------------------------------------
 * SPEC §4 promises the same board "for every player worldwide". Local midnight
 * cannot deliver that: at 09:00 in Auckland and 21:00 the previous day in Los
 * Angeles, two players would be on different puzzle numbers and their share
 * grids would not compare. UTC gives one puzzle per number at every instant on
 * earth, which is also what makes a `/daily/N` permalink mean one thing.
 *
 * The cost is that rollover lands mid-day for some regions. That is the normal
 * trade and it is the one that keeps sharing honest.
 * ============================================================================
 */

const MS_PER_DAY = 86_400_000;

/** Days from 1970-01-01 to a civil date. Howard Hinnant's algorithm. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m + (m > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse: a civil date from days since 1970-01-01. */
export function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** UTC day index for a timestamp. Floor, so pre-1970 still steps correctly. */
export const utcDayOf = (nowMs: number): number => Math.floor(nowMs / MS_PER_DAY);

/** `YYYY-MM-DD` for a UTC day index. */
export function dateKeyOfDay(day: number): string {
  const { y, m, d } = civilFromDays(day);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** `YYYY-MM-DD` in UTC for a timestamp. */
export const dateKeyOf = (nowMs: number): string => dateKeyOfDay(utcDayOf(nowMs));

/** Day index for a `YYYY-MM-DD` key, or null if it is not a real date. */
export function dayOfDateKey(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const day = daysFromCivil(y, mo, d);
  // Reject dates that do not exist (31 February and friends): a round trip
  // through the calendar only survives if the input was real.
  return dateKeyOfDay(day) === key ? day : null;
}

/**
 * Seed for a date. FNV-1a over the date string, exactly as SPEC §4 describes.
 *
 * Hashing the STRING rather than the day number is deliberate: consecutive
 * days must not produce neighbouring seeds, or consecutive dailies would share
 * visibly similar opening boards. `| 0` keeps it in the int32 the RNG expects.
 */
export function dailySeed(dateKey: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 0;
}

export interface DailyConfig {
  /**
   * The date that is Daily #1, `YYYY-MM-DD` UTC.
   *
   * PIN THIS BEFORE LAUNCH AND NEVER MOVE IT. Every `/daily/N` permalink, every
   * share grid ever posted, and every leaderboard row is numbered from here —
   * changing it renumbers all of them at once.
   */
  epoch: string;
  /** Bare host, as it appears at the bottom of a share grid. */
  siteUrl: string;
  /** Absolute path the bundle is served from — rule 8's subfolder, spelled out. */
  gamePath: string;
  gameName: string;
}

/** Canonical URL of a daily's permalink page. Used by the page generator. */
export const dailyPageUrl = (cfg: DailyConfig, n: number): string =>
  `https://${cfg.siteUrl}${cfg.gamePath}daily/${n}/`;

/** Puzzle number for a UTC day index. 1-based; days before the epoch go negative. */
export function dailyNumberOfDay(cfg: DailyConfig, day: number): number {
  const epoch = dayOfDateKey(cfg.epoch);
  if (epoch === null) return 1;
  return day - epoch + 1;
}

export const dailyNumberOf = (cfg: DailyConfig, nowMs: number): number =>
  dailyNumberOfDay(cfg, utcDayOf(nowMs));

/** The date key a puzzle number refers to. Inverse of `dailyNumberOfDay`. */
export function dateKeyOfDaily(cfg: DailyConfig, n: number): string {
  const epoch = dayOfDateKey(cfg.epoch) ?? 0;
  return dateKeyOfDay(epoch + n - 1);
}

/** Seed for a puzzle number — what the client actually starts a daily run from. */
export const seedOfDaily = (cfg: DailyConfig, n: number): number =>
  dailySeed(dateKeyOfDaily(cfg, n));

// ───────────────────────────────────────────────────────── share grid

export type RoundVerdict = "green" | "yellow" | "red";

const SQUARE: Record<RoundVerdict, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

export interface RoundOutcome {
  /** Moves spent on the round. */
  movesUsed: number;
  /** The budget that round had. */
  moveBudget: number;
  cleared: boolean;
}

/**
 * SPEC §4: green cleared comfortably, yellow squeaked through, red is where the
 * run ended.
 *
 * "Comfortably" is measured in MOVES LEFT, not score. A round ends the instant
 * its target is met, so every cleared round scores about 1x target by
 * construction — score cannot tell a comfortable clear from a desperate one,
 * but the move budget can.
 */
export function verdictOf(outcome: RoundOutcome, squeakFrom = 0.85): RoundVerdict {
  if (!outcome.cleared) return "red";
  const spent = outcome.moveBudget > 0 ? outcome.movesUsed / outcome.moveBudget : 1;
  return spent >= squeakFrom ? "yellow" : "green";
}

export interface ShareInput {
  dailyNumber: number;
  /** The round the run ended on. */
  roundReached: number;
  totalScore: number;
  rounds: readonly RoundOutcome[];
}

/**
 * The share grid. Spoiler-free by construction: it carries no tile, no board
 * and no charm — only how each round went — so posting it cannot ruin the
 * puzzle for anyone who has not played it.
 */
export function shareText(cfg: DailyConfig, input: ShareInput): string {
  const grid = input.rounds.map((r) => SQUARE[verdictOf(r)]).join("");
  return [
    `🛁 ${cfg.gameName} — Daily #${input.dailyNumber}`,
    `Round ${input.roundReached} · ${Math.round(input.totalScore).toLocaleString("en-GB")} warmth`,
    grid,
    cfg.siteUrl,
  ].join("\n");
}
