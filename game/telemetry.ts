/**
 * Analytics transport, and the rewarded-ad gate.
 *
 * ============================================================================
 * NOTHING HERE IS ON BY DEFAULT, AND THAT IS DELIBERATE
 * ----------------------------------------------------------------------------
 * capybaraclub.com's privacy page currently says, in as many words:
 *
 *   "That data never leaves your device and we never see it."
 *   "We don't use analytics, ads, or cookies to track you across sites."
 *   "If that ever changes ... this page will be updated to explain what's new
 *    BEFORE it happens."
 *
 * Milestone 8 asks for analytics and rewarded ads. Both are built and both are
 * wired, but neither sends or shows anything until a sink or an ad SDK is
 * installed by hand. Shipping this file as-is changes nothing a player can
 * observe and contradicts nothing the site promises.
 *
 * To turn analytics on: update the privacy page first, then call
 * `setAnalyticsSink()` once at boot. To turn ads on: load an SDK that provides
 * `window.capyAds`. Until then, `hasRewardedAds()` is false and every ad
 * affordance stays hidden rather than showing a dead button.
 * ============================================================================
 */
import type { AnalyticsEvent } from "../src/analytics";

export type AnalyticsSink = (event: AnalyticsEvent) => void;

/** No sink means no transport. The default really is "do nothing". */
let sink: AnalyticsSink | null = null;

/** Recent events, kept in memory only, so the debug harness can inspect them. */
const recent: AnalyticsEvent[] = [];
const RECENT_LIMIT = 500;

export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

export function track(event: AnalyticsEvent): void {
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // A broken dashboard must never take the game down with it.
  }
}

export const trackAll = (events: readonly AnalyticsEvent[]): void => {
  for (const e of events) track(e);
};

/** In-memory log. Never persisted, never sent — this is a debugging aid. */
export const recentEvents = (): readonly AnalyticsEvent[] => recent;

// ─────────────────────────────────────────────────────────── rewarded ads

/**
 * The shape an ad SDK must provide. Kept deliberately small: show a rewarded
 * video, resolve true if the player earned the reward.
 */
export interface RewardedAdSdk {
  showRewarded: (placement: RewardPlacement) => Promise<boolean>;
}

/**
 * The three slots SPEC §6 calls "the natural, player-*wanted* moments" — each
 * one is offered when the player has just lost something and would plausibly
 * choose to watch an ad rather than accept it.
 */
export type RewardPlacement =
  | "extra_moves" // +5 moves on a round that just failed
  | "reroll_draft" // another look at a draft
  | "double_petals"; // twice the run's meta currency

declare global {
  interface Window {
    capyAds?: RewardedAdSdk;
  }
}

/** False whenever no SDK is loaded, which is the shipped state. */
export const hasRewardedAds = (): boolean => typeof window.capyAds?.showRewarded === "function";

/**
 * Show a rewarded ad. Returns false — reward not earned — whenever the SDK is
 * absent, errors, or the player skips, so every caller can treat the failure
 * path and the not-installed path as the same thing.
 */
export async function showRewarded(placement: RewardPlacement): Promise<boolean> {
  const sdk = window.capyAds;
  if (!sdk?.showRewarded) return false;
  try {
    return await sdk.showRewarded(placement);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────── cross-promo

export interface PromoGame {
  id: string;
  title: string;
  description: string;
  icon: string;
}

/**
 * Other games from the site's catalog, for the run-end screen.
 *
 * NOTE: the site has no `games.json` today — `apps/site/src/config.ts` holds a
 * TypeScript registry of manifests instead. This fetches the JSON the milestone
 * describes and renders nothing if it is missing, so the game can ship before
 * the site grows one. The expected shape is `docs/games.json.example`.
 *
 * A relative URL, so it resolves under /games/cappys-onsen/ like everything
 * else (rule 8).
 */
export async function loadPromos(selfId: string, url = "../../games.json"): Promise<PromoGame[]> {
  try {
    const res = await fetch(new URL(url, window.location.href).href, { cache: "no-store" });
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    const list = Array.isArray(raw) ? raw : (raw as { games?: unknown })?.games;
    if (!Array.isArray(list)) return [];
    return list
      .filter((g): g is PromoGame => {
        if (typeof g !== "object" || g === null) return false;
        const o = g as Record<string, unknown>;
        return typeof o["id"] === "string" && typeof o["title"] === "string";
      })
      .filter((g) => g.id !== selfId)
      .map((g) => ({
        id: g.id,
        title: g.title,
        description: typeof g.description === "string" ? g.description : "",
        icon: typeof g.icon === "string" ? g.icon : "🎲",
      }));
  } catch {
    // Offline, missing file, bad JSON — the panel simply does not appear.
    return [];
  }
}
