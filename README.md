# Cappy's Onsen

A roguelike match-3 for Capybara Club. Soak through escalating rounds — each one
a score target on a limited move budget — and draft a charm between every
round. Charms bend the scoring, so no two runs build the same way. One daily
board, the same for everyone, with a spoiler-free grid to share.

Built to the shape of [`capybara-club-game-template`](https://github.com/mittell/capybara-club-game-template);
the host/game contract is [`capybara-club-sdk`](https://github.com/mittell/capybara-club-sdk)'s
`connectToHost`. Rendered with [PixiJS](https://pixijs.com) 8.

The game was first built as a standalone vite site, last shaped for Vercel with
its own SEO pages, and then ported onto this platform. That earlier layout is
this repo's history up to "Prepare for Vercel", and
[`docs/PORTING.md`](docs/PORTING.md) explains what changed and why. Read it
before anything here surprises you.

The design document is [`docs/cappys_onsen_spec.md`](docs/cappys_onsen_spec.md);
the milestone history and status log is [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md);
the balance numbers come from [`docs/onsen_balance.xlsx`](docs/onsen_balance.xlsx).

---

## The rule the whole game rests on

**Two players with the same daily seed must get the same game.** The sim is
pure — no `Math.random`, no clock, no DOM — its RNG state lives inside the run
state, and when matches clear, the board refills **column by column, top to
bottom**, every time. Charms are pure functions of a score context, so the order
you drafted them in cannot change a score. The charm draft draws from its own
RNG stream, so how you play cannot shift what you are offered.

All of it is pinned by tests: a 200-move scripted replay must hash to
`66d0c12e` ([`test/determinism.test.ts`](test/determinism.test.ts)), and
[`test/scaffold.test.ts`](test/scaffold.test.ts) fails the build the first time
anything impure sneaks into `src/sim/`.

## Working on it

```bash
pnpm install          # needs read access to the private SDK package
pnpm dev              # builds and serves dist on localhost:3001
pnpm bench            # the tuning harness on localhost:3002 — see below
pnpm test             # 243 tests — the sim, the balance numbers, saves, the ads gate
pnpm typecheck
pnpm lint
pnpm test:conformance # the boot handshake, for real
```

`pnpm install` needs a GitHub token with `read:packages` for
`@mittell/capybara-club-sdk`. CI has it as `SDK_PACKAGE_TOKEN`; locally, put it
in `~/.npmrc` — never in this repo's `.npmrc`, which is committed.

`pnpm bench` is where balance gets tuned: an ugly, art-free board over the real
sim, an autoplay bot (random or greedy), and batch simulation over many
seeds, so a round that walls every player or a charm nobody should draft shows
up before a player finds it.

The game waits for a host before it draws anything, so `pnpm dev` alone shows
"warming up"; `pnpm test:conformance` is the quick way to prove the handshake.
`dev` and `test:conformance` use POSIX `VAR=value` syntax — on Windows, run them
from Git Bash.

## Shipping a version

Per the template: bump `version`, `git tag vX.Y.Z && git push origin vX.Y.Z`,
and `release.yml` does the two-build conformance gate and attaches
`cappys-onsen.zip` and `cappys-onsen-test.zip` to the release. The zip is
`dist/`: `index.html`, `main.js`, `manifest.json` and the chrome sprites in
`assets/`. Adding the game to the live site is a change to `games.lock.json` in
`capybara-club-assembler`, which is not doable from here.

Don't hand-edit the `__CAPYBARA_HOST_ORIGIN__` sentinel in `release.yml` — the
assembler substitutes the real origin per environment.

Before the first release: the Cozy UI demo pack's licence is still unconfirmed
for redistribution in a publicly served bundle. See
[`docs/ASSETS.md`](docs/ASSETS.md).

## Layout

```text
src/
  main.ts          entry: hand control to the host, start when it says so
  platform/host.ts the ONLY file that imports the SDK
  game/            renderer — Pixi, Cozy UI chrome, tiles drawn at runtime
  sim/             the rules — pure, no DOM, no Math.random, no Date.now
debug/             the tuning harness and its bot, not shipped
scripts/           build.mjs (the release build), bench.mjs (the harness)
test/              vitest
docs/              spec, build plan, balance workbook, porting notes, assets
```

## Three things to know

**The rewarded slots are switched off.** +5 moves on a failed round, a draft
reroll and double petals are written and gated behind `ADS_ENABLED`, because
this platform's SDK has no ad API to ask. `scripts/build.mjs` leaves the flag
false unless `ADS=1`. See [`docs/PORTING.md`](docs/PORTING.md).

**The host owns saves.** No `localStorage` anywhere — the meta layer, today's
daily and the endless run arrive at boot and leave through `saveProgress`, as
one versioned envelope.

**There are no analytics.** The event builders in `src/sim/analytics.ts` survive
as balance tooling, but the shipped client emits nothing: the platform has no
events API, and the transport was deleted rather than stubbed.
