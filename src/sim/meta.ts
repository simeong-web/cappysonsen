/**
 * Meta progression — what survives a run (SPEC §1, "keep this thin at launch").
 *
 * Petals are earned at run end and spent to unlock charms into the draft pool
 * and décor onto the tub. Everything here is pure; the client persists it
 * through `save.ts` like every other record.
 */
import { CHARMS, CHARM_IDS, type CharmId } from "./charms";
import type { RunState } from "./run";

/**
 * The twelve a new player starts with — the Milestone 3 set. The other seven
 * are unlocked with petals, which is what turns a second run into progress
 * rather than a repeat.
 */
export const STARTER_CHARMS: readonly CharmId[] = [
  "sun_warmed_stone",
  "yuzu_grove",
  "deep_soak",
  "collector",
  "gentle_ripple",
  "steam_rising",
  "compound_warmth",
  "patient_soak",
  "morning_bath",
  "last_drop",
  "risky_bather",
  "extra_towel",
];

export const LOCKED_CHARMS: readonly CharmId[] = CHARM_IDS.filter(
  (id) => !STARTER_CHARMS.includes(id),
);

/**
 * Unlock costs rise down the list, so the pool grows at a pace rather than all
 * at once after one lucky run.
 */
export const CHARM_COST: Record<string, number> = {
  overflow: 40,
  twin_springs: 60,
  chain_of_petals: 80,
  second_steeping: 110,
  citrus_devotion: 140,
  tea_break: 180,
  monochrome_mind: 240,
  // Board manipulation reads as the most exciting tier, so it sits at the top
  // of the ladder — the pool has to be nearly complete before it opens up.
  floating_petal: 200,
  hot_stone: 260,
  bath_bomb: 300,
  skimmer: 340,
  still_water: 400,
};

export type DecorId = "cedar" | "dusk" | "blossom";

export interface Decor {
  id: DecorId;
  name: string;
  /** One word, for buttons a third of a panel wide. */
  short: string;
  cost: number;
  /** Background ramp: sky, warm, shallow water, deep water. */
  palette: readonly [number, number, number, number];
  rim: number;
}

/** Cosmetic only — décor never touches a number the sim can see. */
export const DECOR: Record<DecorId, Decor> = {
  cedar: {
    id: "cedar",
    name: "Cedar Tub",
    short: "Cedar",
    cost: 0,
    palette: [0xffe6c0, 0xf9b998, 0x8fcfcf, 0x3f8e9b],
    rim: 0xb5734f,
  },
  dusk: {
    id: "dusk",
    name: "Dusk Soak",
    short: "Dusk",
    cost: 120,
    palette: [0xf7c9a0, 0xd98f8f, 0x6b7fa8, 0x2f3d5c],
    rim: 0x7d5a7a,
  },
  blossom: {
    id: "blossom",
    name: "Blossom Bath",
    short: "Blossom",
    cost: 200,
    palette: [0xffe9f0, 0xf9b8cf, 0x9fd8cf, 0x46907f],
    rim: 0xc4707f,
  },
};

export const DECOR_IDS: readonly DecorId[] = ["cedar", "dusk", "blossom"];

export interface MetaState {
  petals: number;
  /** Lifetime total, for a "petals earned" readout that spending cannot dent. */
  petalsEarned: number;
  unlockedCharms: CharmId[];
  unlockedDecor: DecorId[];
  activeDecor: DecorId;
  runsPlayed: number;
  bestRound: number;
  bestScore: number;
}

export const newMeta = (): MetaState => ({
  petals: 0,
  petalsEarned: 0,
  unlockedCharms: [...STARTER_CHARMS],
  unlockedDecor: ["cedar"],
  activeDecor: "cedar",
  runsPlayed: 0,
  bestRound: 0,
  bestScore: 0,
});

/**
 * Petals for a finished run.
 *
 * Square-rooted so a monster run pays well without making every earlier unlock
 * instant, plus a flat bonus per round cleared so a short run is still worth
 * something. Tuned by feel — Milestone 8's analytics is what should replace the
 * guess.
 */
export function petalsFor(run: Pick<RunState, "totalScore" | "rounds">): number {
  const cleared = run.rounds.filter((r) => r.cleared).length;
  return Math.floor(Math.sqrt(Math.max(0, run.totalScore)) / 4) + cleared * 3;
}

/**
 * Fold a finished run into the meta record. Pure: returns a new state.
 *
 * `multiplier` is the "double your petals" ad slot. It scales the award only —
 * best round and best score are what the player actually did.
 */
export function recordRun(meta: MetaState, run: RunState, multiplier = 1): MetaState {
  const petals = Math.floor(petalsFor(run) * Math.max(1, multiplier));
  const cleared = run.rounds.filter((r) => r.cleared).length;
  return {
    ...meta,
    petals: meta.petals + petals,
    petalsEarned: meta.petalsEarned + petals,
    runsPlayed: meta.runsPlayed + 1,
    bestRound: Math.max(meta.bestRound, cleared),
    bestScore: Math.max(meta.bestScore, run.totalScore),
  };
}

export const costOfCharm = (id: CharmId): number => CHARM_COST[id] ?? 0;

export const canUnlockCharm = (meta: MetaState, id: CharmId): boolean =>
  !meta.unlockedCharms.includes(id) && meta.petals >= costOfCharm(id);

/** Unaffordable or already-owned unlocks return the state unchanged. */
export function unlockCharm(meta: MetaState, id: CharmId): MetaState {
  if (!canUnlockCharm(meta, id)) return meta;
  return {
    ...meta,
    petals: meta.petals - costOfCharm(id),
    // Kept in CHARM_IDS order so the set is stable however it was earned.
    unlockedCharms: CHARM_IDS.filter((c) => c === id || meta.unlockedCharms.includes(c)),
  };
}

export const canUnlockDecor = (meta: MetaState, id: DecorId): boolean =>
  !meta.unlockedDecor.includes(id) && meta.petals >= DECOR[id].cost;

export function unlockDecor(meta: MetaState, id: DecorId): MetaState {
  if (!canUnlockDecor(meta, id)) return meta;
  return {
    ...meta,
    petals: meta.petals - DECOR[id].cost,
    unlockedDecor: DECOR_IDS.filter((d) => d === id || meta.unlockedDecor.includes(d)),
  };
}

export function chooseDecor(meta: MetaState, id: DecorId): MetaState {
  return meta.unlockedDecor.includes(id) ? { ...meta, activeDecor: id } : meta;
}

/** The draft pool a run should use. */
export const poolFor = (meta: MetaState): CharmId[] =>
  CHARM_IDS.filter((id) => meta.unlockedCharms.includes(id));

/**
 * Validate-and-repair (rule 7). Unlocks are the one thing a player would be
 * genuinely upset to lose, so anything recoverable is clamped rather than
 * rejected: unknown ids are dropped, negatives are floored, and the starter
 * twelve are always restored.
 */
export function validateMeta(raw: unknown): MetaState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const num = (x: unknown): number =>
    typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : 0;

  const charms = Array.isArray(s["unlockedCharms"]) ? s["unlockedCharms"] : [];
  const unlockedCharms = CHARM_IDS.filter(
    (id) => STARTER_CHARMS.includes(id) || charms.includes(id),
  );

  const decor = Array.isArray(s["unlockedDecor"]) ? s["unlockedDecor"] : [];
  const unlockedDecor = DECOR_IDS.filter((id) => id === "cedar" || decor.includes(id));

  const active = s["activeDecor"];
  const activeDecor: DecorId =
    typeof active === "string" && unlockedDecor.includes(active as DecorId)
      ? (active as DecorId)
      : "cedar";

  return {
    petals: Math.floor(num(s["petals"])),
    petalsEarned: Math.floor(num(s["petalsEarned"])),
    unlockedCharms,
    unlockedDecor,
    activeDecor,
    runsPlayed: Math.floor(num(s["runsPlayed"])),
    bestRound: Math.floor(num(s["bestRound"])),
    bestScore: num(s["bestScore"]),
  };
}

/** Display helper: every charm with whether it is unlocked and what it costs. */
export function collection(meta: MetaState): {
  id: CharmId;
  name: string;
  text: string;
  unlocked: boolean;
  cost: number;
}[] {
  return CHARM_IDS.map((id) => ({
    id,
    name: CHARMS[id].name,
    text: CHARMS[id].text,
    unlocked: meta.unlockedCharms.includes(id),
    cost: costOfCharm(id),
  }));
}
