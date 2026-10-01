/**
 * The host, and everything this game is allowed to ask of it.
 *
 * This is the ONLY file that imports `@mittell/capybara-club-sdk`. Everything
 * else in `src/` talks to the `Host` interface below, so if the SDK's shape
 * moves, one file changes and the game does not.
 *
 * `HOST_ORIGIN`, `MANIFEST_ID` and `ADS_ENABLED` are injected at build time by
 * `scripts/build.mjs`. `HOST_ORIGIN` has no fallback on purpose: a forgotten
 * value must fail the build rather than ship a broken origin.
 */
import { connectToHost, type ErrorType } from "@mittell/capybara-club-sdk";

/** The error categories a game is allowed to report. */
export type GameErrorType = Exclude<ErrorType, "protocol">;

declare const HOST_ORIGIN: string;
declare const MANIFEST_ID: string;
declare const ADS_ENABLED: boolean;

/**
 * The three slots SPEC §6 calls "the natural, player-*wanted* moments" — each
 * one is offered when the player has just lost something and would plausibly
 * choose to watch an ad rather than accept it.
 */
export type RewardPlacement =
  | "extra_moves" // +5 moves on a round that just failed
  | "reroll_draft" // another look at a draft
  | "double_petals"; // twice the run's meta currency

/** What the game may do to the outside world. Deliberately small. */
export interface Host {
  /** Final score for a finished run. */
  reportScore(score: number): void;
  /** The whole save, handed to the host — this platform owns persistence. */
  saveProgress(progress: unknown): void;
  /**
   * Something went wrong in a way worth surfacing off-box.
   *
   * `"protocol"` is reserved for the SDK's own auto-reporting and is excluded
   * here, so a game-side report can never be mistaken for a handshake fault.
   */
  reportError(message: string, errorType: GameErrorType): void;
  /**
   * A rewarded ad, for one of the three slots.
   *
   * ALWAYS FALSE TODAY. This platform's SDK has no ad API at all — no
   * rewarded break, no commercial break, nothing. The game's three rewarded
   * slots are written and switched off at `ADS_ENABLED` rather than deleted, so
   * that turning them on is this function plus a build flag rather than
   * re-deriving what a revive was supposed to do.
   *
   * When the platform grows an ad API: implement it here, flip the default of
   * `ADS_ENABLED` in `scripts/build.mjs`, and nothing else in the game has to
   * change.
   */
  requestRewardedAd(placement: RewardPlacement): Promise<boolean>;
  /** Whether the rewarded slots should be offered at all. */
  readonly adsEnabled: boolean;
}

export interface BootContext {
  /** Whatever this game last handed to `saveProgress`, or null on a first run. */
  savedProgress: unknown;
  muted: boolean;
  host: Host;
}

/**
 * Hand control to the host and start the game when it says so.
 *
 * The game does NOT start on load: the host's boot message carries the saved
 * progress, so starting early would mean opening a run and then throwing it
 * away when the save arrived.
 */
export function bootWithHost(start: (context: BootContext) => void, onMuteChange: (muted: boolean) => void): void {
  let host: Host;

  const connection = connectToHost({
    hostOrigin: HOST_ORIGIN,
    manifestId: MANIFEST_ID,
    onBoot: ({ savedProgress, muted }: { savedProgress: unknown; muted: boolean }) => {
      start({ savedProgress, muted, host });
    },
    onMuteChange: (muted: boolean) => {
      onMuteChange(muted);
    },
  });

  host = {
    reportScore: (score) => connection.reportScore(score),
    saveProgress: (progress) => connection.saveProgress(progress),
    reportError: (message, errorType) => connection.reportError(message, errorType),
    // No ad API on this platform yet. Refusing rather than pretending: the
    // caller treats false as "no reward", which is the same path a declined ad
    // would take, so nothing downstream has to special-case its absence.
    requestRewardedAd: async () => false,
    adsEnabled: ADS_ENABLED,
  };

  // An uncaught error in a game the host cannot see is a game that has simply
  // gone quiet. One report, then let it through to the console as usual.
  //
  // "script" for a thrown error and "logic" for a rejected promise. The one
  // failure that genuinely is "asset_load" — the chrome textures not arriving —
  // is caught where it happens and reported as such by the client, so it never
  // reaches these. The game makes no network calls of its own, so "network"
  // cannot be what happened.
  addEventListener("error", (e) => {
    host.reportError(String(e.message ?? "unknown error"), "script");
  });
  addEventListener("unhandledrejection", (e) => {
    host.reportError(String(e.reason ?? "unhandled rejection"), "logic");
  });
}
