# Repo map

Cappy's Onsen — a roguelike match-3 — in its deployable form. Part of the
Capybara Club family — a game repo built to `capybara-club-game-template`'s
shape, so the template's own CLAUDE.md conventions apply here too, in
particular:

- `manifest.json`'s `id` is the single source of truth for the game's
  identifier; `scripts/build.mjs` injects it as `MANIFEST_ID`. Don't hardcode it
  in `src/`.
- Don't skip `pnpm test:conformance` before tagging.
- The `__CAPYBARA_HOST_ORIGIN__` sentinel in `release.yml` is not a real origin
  and must not be replaced with one — `capybara-club-assembler` substitutes it
  per environment at assembly time.
- Don't reshape the release pipeline. Its two-build conformance gate and its
  zip naming are what the assembler expects.

Full design in `docs/cappys_onsen_spec.md`, milestone history in
`docs/BUILD_PLAN.md`, the port in `docs/PORTING.md`, the asset record in
`docs/ASSETS.md`.

## Commands

```
pnpm test             # vitest — must pass before anything is done
pnpm typecheck        # strict tsc — must be clean
pnpm lint             # oxlint
pnpm build            # needs HOST_ORIGIN set; -> dist/
pnpm test:conformance # the boot handshake, for real
pnpm bench            # the tuning harness (numbers/board, no art) on :3002
```

The `dev` and `test:conformance` scripts use POSIX `VAR=value` syntax; run them
from a POSIX shell (Git Bash on Windows).

## Layout

```
src/sim/          the rules — pure TypeScript, no DOM, no rendering, no I/O
src/game/         Pixi renderer + Cozy UI chrome; client.ts is the run lifecycle
src/platform/     host.ts — the ONLY file that imports the SDK
src/main.ts       entry: hand control to the host, start when it says so
debug/            ugly tuning harness over the sim, with an autoplay bot
test/             vitest
docs/             spec, build plan, balance workbook, porting notes, assets
```

## This repo specifically

- The game predates this platform: it was built as a standalone vite site
  (last deployed shape: "Prepare for Vercel") and ported onto this one.
  `docs/PORTING.md` explains every difference. The spec still governs the
  rules.
- `src/platform/host.ts` is the only file that may import the SDK. Everything
  else talks to the `Host` interface it exports.
- **The host owns saves.** No `localStorage` anywhere — `test/host-save.test.ts`
  fails if it reappears. Progress arrives at boot and leaves through
  `saveProgress`, inside the sim's versioned envelope (`src/game/progress.ts`).
- **Nothing runs before boot.** `client.ts` creates no Pixi app and loads no
  texture until `startClient`.
- The three rewarded slots are behind `ADS_ENABLED`, false in every build,
  because this platform has no ad API. Don't delete the code — turning it on is
  meant to be a flag plus `Host.requestRewardedAd`.
- Analytics and the cross-promo panel were removed in the port, not stubbed.
  The pure event builders in `src/sim/analytics.ts` remain, unused by the
  client.
- `ci.yml` runs `pnpm typecheck` and `pnpm test` on top of the template's lint
  and build. Deliberate: the daily-seed contract is the thing this game is
  judged on and nothing else in the pipeline checks it.

## Architecture rules — non-negotiable

These exist because the daily-seed mode, the leaderboards, and the save system
all depend on them. Breaking any one silently breaks the product.

1. **`src/sim/` is pure.** No `Math.random`, no `Date.now`, no `localStorage`,
   no DOM, no network. Callers pass `nowMs` when time is needed.
   `test/scaffold.test.ts` enforces it.
2. **RNG state lives in the state object**, threaded through pure step functions
   (`rngNext(state) -> { value, state }`). Never a closure, never a class
   instance — it must serialize into a save and replay identically.
3. **Board refill draws in a strictly defined order**: column by column, top to
   bottom. Any ambiguity here means two players with the same daily seed get
   different boards. This is the single highest-consequence rule in the project.
4. **Charms are pure functions** `(ctx: ScoreContext) => ScoreDelta`. They never
   mutate board state and never read anything outside the context. This is what
   makes charm order irrelevant and stacking testable.
5. **Operations return events; the sim never calls out.** `swap`/`resolve`
   return event arrays and the renderer subscribes. The sim must not know a
   renderer exists.
6. **Balance constants live in `src/sim/config.ts`, mirroring the balance
   workbook.** Tune in the sheet first, then copy. Acceptance tests pin
   sheet-computed values so drift fails CI.
7. **Saves are versioned.** Any schema change bumps `SAVE_VERSION` and adds a
   migration function in the same commit. Validation repairs and clamps rather
   than throwing — never crash at a player over a bad save.
8. **Every asset URL is relative.** The game is served from inside the
   platform's iframe at whatever path the assembler chooses. Sprites are
   imported so esbuild emits them as `./assets/<name>.png`; an absolute path
   will 404.
9. **The id `cappys-onsen` is permanent** — it is the manifest id, the release
   zip's name and the save's identity on the platform at once.

## Conventions

- TypeScript strict, including `noUncheckedIndexedAccess`.
- Vitest. Tests that pin spreadsheet values are **acceptance tests** — treat
  their numbers as the contract.
- Comment the *why*, not the *what*. Especially around determinism and any
  coordinate/order convention.
- Prefer closed-form math over iteration where a formula exists (levels, costs,
  targets) — it makes offline/skip-ahead calculation trivial.
- No new dependencies without asking. Pixi and Vitest are the stack, on the
  template's esbuild + pnpm.

## Workflow

- **If a test contradicts the spec, stop and say so.** Do not weaken the test to
  make it pass, and do not silently change the spec's intent. A failing test
  that reveals a design problem is the most valuable output in the project.
- **If a decision is a design or feel judgment** (is this fun, is this target
  too harsh, does this charm feel good), stop and ask. Those belong to the
  humans, not to you.
- Work on a `dev` branch and PR to `main`, like the rest of the family.

## Asset handling

Cozy UI assets are for **chrome only** — panels, buttons, toggles, card frames,
icons, the Default/Claimed/Unlocked states. Board tiles and their animation are
custom work in `src/game/tiles.ts`; that's where match-3 lives or dies. Do not
commit asset files not covered by the pack's licence, and keep
`docs/ASSETS.md` current — the release zip serves every emitted sprite publicly.
