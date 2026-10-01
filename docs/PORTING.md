# Porting Cappy's Onsen onto the platform

What this repo is, where it came from, and the things the platform does not
have that the game was originally written against.

This is the same repo the game has always been in. The left column below is
what the commit **"Prepare for Vercel"** holds — a flat vite layout that built a
standalone static site; everything since is the right column. The sim, the
renderer, the spec, the balance workbook and the tuning harness came along with
the port, so no part of the game lives anywhere else.

---

## Where everything went

| Before the port | Now | Note |
|---|---|---|
| `src/*` | `src/sim/*` | The rules. Unchanged — pure, no DOM, no clock, no I/O. |
| `game/main.ts` | `src/game/client.ts` | No longer self-starting; see "The boot handshake". |
| `game/{board-view,chrome,theme,tiles,tween}.ts` | `src/game/*` | Unchanged but for imports (and one comment in `chrome.ts` about how sprites are emitted). |
| `game/assets/cozy/*` | `src/game/assets/cozy/*` | Same files, same `SOURCE.md`. Emitted to `dist/assets/` by esbuild. |
| `game/storage.ts` (localStorage half) | `src/game/progress.ts` | The host owns saves now; see "Persistence moved to the host". |
| `game/storage.ts` (`copyText`) | `src/game/clipboard.ts` | Unchanged. |
| `game/telemetry.ts` | *gone* | Analytics, the ad shim and cross-promo; see "What the platform does not have". |
| — | `src/platform/host.ts` | The only file that imports the SDK. |
| — | `src/main.ts` | Entry point: hand control to the host. |
| `game/index.html` | `index.html` | Script repointed at the esbuild output. |
| `game/daily-pages.ts`, `game/vite.config.ts` | *gone* | The /daily/N SEO pages, sitemap and robots.txt; see "The Vercel build". |
| `vercel.json`, `docs/SHIP.md` | *gone* | The Vercel runbook. Shipping is the template's release pipeline now. |
| `docs/games.json.example` | `manifest.json` | Different schema; rewritten, not converted. |
| `debug/` | `debug/` | The tuning harness; built by `scripts/bench.mjs` (`pnpm bench`) instead of vite. |
| `test/*` | `test/*` | Carried over whole, plus `host-save.test.ts` and `ads.test.ts`. |
| `docs/cappys_onsen_spec.md`, `BUILD_PLAN.md`, `onsen_balance.xlsx` | same | Unchanged, but for a status line in `BUILD_PLAN.md`. |
| — | `docs/ASSETS.md` | New: what the release zip contains and where it came from. |
| vite 8 + vitest 4 + npm | esbuild + pnpm + vitest 2, single package | The template's toolchain, and the Pairs port's vitest. |

## The boot handshake

The game used to start on load. It does not any more: `src/main.ts` calls
`bootWithHost`, and the client only runs when the host's boot message arrives —
because that message carries the player's saved progress, and starting earlier
would mean opening a run and throwing it away a moment later.

Everything in `client.ts` is inert until `startClient` runs: there is no Pixi
application, no canvas and no texture load before it. The page shows the
"warming up" line from `index.html` until then. The `ready` ack goes out as soon
as `onBoot` returns; Pixi's initialisation and the sprite load happen after, so
a slow texture fetch cannot make the handshake time out.

What used to be `?daily=N` / `?mode=endless` routing is gone with it. Those
query strings existed so the /daily/N permalink pages could deep-link a puzzle;
inside the platform the host decides the URL and there are no such pages, so the
game always opens on its menu.

## Persistence moved to the host

`game/storage.ts` (localStorage) is gone. The host hands the last save to
`onBoot` and takes a new one through `saveProgress`, which is what lets the
platform decide later that saves live on a server rather than in a browser.
`test/host-save.test.ts` scans `src/` and fails if `localStorage` or
`sessionStorage` reappears anywhere.

The old client kept three records under `cappys-onsen:meta`, `:daily` and
`:endless`. They are now three fields of one value, `{ meta, daily, endless }`,
inside the sim's own versioned envelope (`src/sim/save.ts`, `SAVE_VERSION` 2) —
because the host stores an opaque value and promises nothing about its shape,
so validation, versioning and migrations are still this game's problem. Each
field goes through the validator the sim already had for it, so each is
repaired or dropped on its own: a corrupt daily does not cost a player their
petals. `loadHostSave` accepts both an object and a JSON string, because whether
the value survives a round trip as one or the other is the host's business.

The whole value is sent after every move, draft and unlock — the same moments
the old client wrote to localStorage.

Nothing migrates from a player's old localStorage: the game runs on the
platform's origin now and could not read another origin's storage anyway.

## What the platform does not have

**No ad API.** The SDK exposes `reportScore`, `saveProgress`, `reportError` and
`requestExitFullscreen` — nothing for ads. The game's three rewarded slots (+5
moves on a failed round, a draft reroll, double petals) are written, and
switched off behind `ADS_ENABLED`, which `scripts/build.mjs` leaves false unless
`ADS=1`. With it off none of them is offered at all: the run-end panel shows
Share/New run and Menu only, and the draft shows a reroll button only when a
charm granted a free reroll. Before the port the same slots were gated on
`window.capyAds` existing, which it never did; the gate moved, the behaviour
did not.

Turning them on later is `Host.requestRewardedAd` in `src/platform/host.ts`
plus the flag. Nothing else in the game changes. `test/ads.test.ts` pins the
gate and that every slot goes through it.

**No analytics.** `run_start`, `round_cleared`, `run_end`, `charm_drafted` and
`charm_offered` had nowhere to go — `reportError` is the only outbound channel
besides score and progress. The transport (`game/telemetry.ts`) and every call
site are deleted rather than stubbed. Before the port nothing was sent either
(no sink was ever installed, because the site's privacy page forbade it), so no
player-visible behaviour changed.

The pure event builders in `src/sim/analytics.ts` are still there, with their
tests, because the sim came across unchanged and `pickRates` is balance tooling
in its own right. Nothing in the shipped client imports them. If the platform
grows an events API, the call sites are in this repo's history — the commit
before the port — and `attempt`, `take` and `startDaily`/`startEndless` in the
client are where they sat.

**No cross-promo feed.** The run-end panel used to fetch `../../games.json` and
offer one sibling game by navigating the page to `../../<id>/`. Inside the
platform's iframe the fetch is a guaranteed 404 and the navigation would walk
the frame off the host, so the panel is gone. The platform's own catalogue is
where cross-promotion lives now.

**No gameplay lifecycle.** The game never called a gameplay-start/stop or
commercial-break API, so nothing had to be removed there.

**What the host does hear:** `reportScore` once, when a move ends a run — the
run's banked warmth (`totalScore`), rounded and capped just under the SDK's 1e9
plausibility ceiling, which the SDK rejects rather than clamps. A finished daily
reopened from the save goes straight to its run-end panel and does not report
again. `reportError` for an uncaught error (`"script"`), an unhandled rejection
(`"logic"`), and a failed boot — `"asset_load"` when the chrome sprites fail to
load, which is the one place that category is genuinely true, `"script"` for
anything else in boot. The game has no audio, so `onMuteChange` is accepted and
does nothing.

## The Vercel build

The commit before the port built a standalone site for Vercel: the game at the
root, a pre-generated `/daily/N/` permalink page for every puzzle from 120 days
back to 14 ahead, with canonical URLs, `sitemap.xml` and `robots.txt`, with the origin taken from
`ONSEN_ORIGIN` / `VERCEL_URL`. None of that belongs in a game embedded by the
platform: the host owns the URL, the iframe is not what a crawler should index,
and the release zip should be the game and nothing else. So the generator
(`game/daily-pages.ts`), its vite plugin, `vercel.json` and the runbook are
deleted, and `public/games/cappys-onsen/` — always a build output, never
tracked — is no longer produced or ignored.

The daily mode itself is untouched: the same epoch, the same seeds, the same
share grid. `dailyPageUrl` and the `gamePath` config field in the sim describe
the old permalink scheme and are now unused by the client; they were left in
place because the sim came over unchanged. The share text still ends with
`capybaraclub.com`.

## Bundling Pixi and the sprites

esbuild bundles everything, Pixi included, into a single ESM `dist/main.js`.
Pixi's renderer modules are dynamic imports; without code splitting esbuild
inlines them, so there are no chunks. The fourteen Cozy UI sprites are imported
by `chrome.ts` and emitted by esbuild's `file` loader to `dist/assets/<name>.png`
with stable names, bound to `./assets/<name>.png` — relative to the page, which
is what Pixi's `Assets.load` resolves against. No fonts are bundled and nothing
is fetched from a third-party origin; `docs/ASSETS.md` has the full list.

The bundle is not minified, matching the template's `build.mjs`. It is about
1.9 MB on disk.

Vite's `import.meta.env.DEV` gated an automation handle (`window.__onsen`). esbuild
has no such thing, so it is a build flag now, `DEV_HANDLE`, false unless
`DEV_HANDLE=1`. In a release build the one call site is compiled to
`if (false) { ... }` — the template's build does not minify, so the dead branch
stays in the file, but it cannot run.

## What has been verified

Against the **real** SDK (`@mittell/capybara-club-sdk@0.3.1`), on this machine
(Windows, Git Bash):

- `pnpm install`, `pnpm lint`, `pnpm typecheck` clean; **243 tests** pass —
  the 222 the game had before the port, all still passing, plus 21 new ones
  for the host save and the ads gate.
- `HOST_ORIGIN=http://localhost:3000 pnpm build` emits
  `dist/{index.html,main.js,manifest.json}` and `dist/assets/` with the
  fourteen sprites, and `validateManifest` accepts `manifest.json` as written.
- **`capybara-conformance-test ./dist` passes** — *"cappys-onsen booted and
  acked ready within 8000ms"*.
- Driven through a hand-written host speaking the raw protocol across two
  origins (`localhost:3000` hosting, `localhost:4321` serving `dist/`) in
  headless Chromium:
  - the release build draws nothing before boot; after boot it acks `ready`
    with the manifest id, fills the 420×860 frame with a painted canvas (the
    menu over the board), loads all fourteen sprites from `./assets/` with
    200s, makes no other requests, sends no `error` messages, logs no console
    errors, and exposes no automation handle;
  - a `DEV_HANDLE=1` build, driven through real clicks on the canvas: Play Daily
    opens today's puzzle, a move sends `saveProgress` as a version-2 envelope
    containing the daily run; that save, doctored to the last move of round 1
    and handed back **as a JSON string**, resumes mid-round; the next move ends
    the run and sends exactly one `{type:"score"}` equal to the banked warmth;
    the run-end panel offers no ad slots; and reopening the finished daily from
    its save shows the run-end panel without a second score. 17 checks, all
    passing.

The only console output in headless Chromium was SwiftShader's
*"GPU stall due to ReadPixels"* performance note, which is the software
renderer's, not the game's.

### Still unverified

- **The assembler's half.** `__CAPYBARA_HOST_ORIGIN__` substitution, the
  provenance checks and the `games.lock.json` entry all happen outside this
  repo and cannot be exercised from here.
- **The Cozy UI pack's licence.** See `docs/ASSETS.md`: the sprites now ship
  inside the release zip, and whether the demo pack's terms allow that is still
  an open owner question.
- **`manifest.json`'s `width`/`height`** (420×860, portrait) pass validation —
  it only requires positive numbers — but nothing here knows what the host does
  with them. The layout is responsive and wants a phone-shaped frame.
- **Copy-to-clipboard inside the iframe.** `navigator.clipboard` needs the host
  to grant `clipboard-write`; without it the `execCommand` fallback runs, and
  if that is refused too the button says "Copy failed". Not exercised against
  the real host.
- **A real GPU, a real phone.** Rendering was checked in headless Chromium on
  SwiftShader only. The renderer itself did not change in the port, and it was
  touch-tested on an emulated iPhone before it (Milestone 5), but not since.
- **The ads path with `ADS=1`.** It builds, but with `requestRewardedAd`
  always false there is nothing to exercise until the platform has an ad API.
- **The local `pnpm dev` / `pnpm test:conformance` scripts on Windows.** They
  use POSIX `VAR=value cmd` syntax, inherited from the template, which cmd
  cannot run; the conformance check above was run as its two halves (`build`
  with `HOST_ORIGIN` set, then `pnpm exec capybara-conformance-test ./dist`)
  from Git Bash. Left alone rather than rewritten, since the template's script
  shape is what the release pipeline and the assembler expect.
