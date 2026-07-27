# CLAUDE.md

Project rules for Cappy's Onsen — a roguelike match-3 for Capybara Club.
Read this before doing anything. Full design in `docs/SPEC.md`, task breakdown
and current milestone in `docs/BUILD_PLAN.md`.

## Commands

```
npm test              # vitest — must pass before any milestone is done
npx tsc --noEmit      # strict typecheck — must be clean before any milestone is done
npm run dev           # debug harness (numbers/board, no art)
npm run game          # the Pixi client
npm run build:game    # static bundle -> deploys to public/games/cappys-onsen/
```

## Layout

```
src/        the sim — pure TypeScript, no DOM, no rendering, no I/O
debug/      ugly tuning harness over the sim
game/       Pixi renderer + Cozy UI chrome
docs/       SPEC.md (design), BUILD_PLAN.md (milestones)
```

## Architecture rules — non-negotiable

These exist because the daily-seed mode, the leaderboards, and the save system
all depend on them. Breaking any one silently breaks the product.

1. **`src/` is pure.** No `Math.random`, no `Date.now`, no `localStorage`, no
   DOM, no network. Callers pass `nowMs` when time is needed.
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
6. **Balance constants live in `config.ts`, mirroring the balance workbook.**
   Tune in the sheet first, then copy. Acceptance tests pin sheet-computed
   values so drift fails CI.
7. **Saves are versioned.** Any schema change bumps `SAVE_VERSION` and adds a
   migration function in the same commit. Validation repairs and clamps rather
   than throwing — never crash at a player over a bad save.
8. **Vite `base: './'`.** The game is served from `/games/cappys-onsen/`, not
   the site root. Absolute asset paths will 404.
9. **The slug `cappys-onsen` is permanent** — it is the URL, the folder name,
   and the localStorage namespace at once.

## Conventions

- TypeScript strict, including `noUncheckedIndexedAccess`.
- Vitest. Tests that pin spreadsheet values are **acceptance tests** — treat
  their numbers as the contract.
- Comment the *why*, not the *what*. Especially around determinism and any
  coordinate/order convention.
- Prefer closed-form math over iteration where a formula exists (levels, costs,
  targets) — it makes offline/skip-ahead calculation trivial.
- No new dependencies without asking. Pixi and Vitest are the stack.

## Workflow

- Work **one milestone at a time** from `docs/BUILD_PLAN.md`. Do not start the
  next one. Do not skip ahead to rendering because the sim is "basically done."
- Branch per milestone: `milestone/<n>-<short-name>`.
- A milestone is done only when: `npm test` passes, `npx tsc --noEmit` is clean,
  and the milestone's acceptance criteria in BUILD_PLAN.md are met.
- **If a test contradicts the spec, stop and say so.** Do not weaken the test to
  make it pass, and do not silently change the spec's intent. A failing test
  that reveals a design problem is the most valuable output in the project.
- **If a decision is a design or feel judgment** (is this fun, is this target
  too harsh, does this charm feel good), stop and ask. Those belong to the
  humans, not to you.
- Update `docs/BUILD_PLAN.md` with a one-line status when a milestone lands.

## Asset handling

Cozy UI assets are for **chrome only** — panels, buttons, toggles, card frames,
icons, the Default/Claimed/Unlocked states, calendar/streak icons. Board tiles
and their animation are custom work; that's where match-3 lives or dies.
Do not commit asset files not covered by the pack's licence.
