# Cappy's Onsen — design & build spec

A roguelike match-3 for Capybara Club. Working title; Cappy is already the site
mascot, and capybaras soaking in yuzu hot springs is both the iconic capybara
image and about as cozy as a premise gets.

**The pitch:** not a level-based match-3. A *run-based* one. You soak through
escalating rounds, and between each you draft one of three Charms that change
how the board behaves. Charms stack and interact, so by round eight you've built
something personal and slightly absurd. Everyone plays the same board each day
from a shared seed, and shares a spoiler-free result grid.

**Why this shape:** it kills the level treadmill (King's real moat — 10,000
hand-tuned levels — is unbeatable by two people; procedural runs sidestep it
entirely), it produces a daily-return habit and a share loop pointing at your
domain, and roughly 60% of its spine already exists in the Emberkeep codebase.

---

## 1. Core loop

**Round:** a board, a move budget, a Warmth target. Clear the target → advance.
Fail → run ends.

**Between rounds:** draft 1 of 3 Charms. Occasionally offered a shop instead
(spend Petals — the run currency — on charms, extra moves, or a reroll).

**Every 3rd round is a Long Soak** (the boss equivalent): same board, plus one
modifier that invalidates a strategy — "petals score nothing," "no cascades
count," "only 6 moves." These are what force builds to adapt rather than
snowball unchecked.

**Run ends** → score submitted, share grid generated, meta-currency awarded.

**Meta layer (persists across runs):** unlock new Charms into the draft pool,
new starting boards, cosmetic bath décor. Keep this thin at launch — the run
itself is the product.

---

## 2. Scoring — Warmth × Bliss

The single most important design decision. Every score resolves as:

```
round score = Warmth × Bliss
```

- **Warmth** — flat points. Tiles cleared, match sizes, most charms add here.
- **Bliss** — a multiplier, starts at 1.0 each round. Cascades and certain
  charms build it; a few charms *multiply* it.

This mirrors Balatro's chips×mult, and it's load-bearing for the same reason:
it makes every charm instantly legible ("adds warmth" / "adds bliss" /
"multiplies bliss"), it makes stacking feel exponential rather than linear, and
it gives you two independent tuning dials instead of one.

**Base values (tune in the sheet, not in code):**

| Event | Warmth | Bliss |
|---|---|---|
| Tile cleared | +10 | — |
| Match of 4 | +25 bonus | — |
| Match of 5+ | +60 bonus | — |
| Cascade step (each) | — | +0.2 |
| Long Soak clear | — | ×1.0 (modifier-dependent) |

Round targets escalate geometrically (start ~1.6×/round, tune for a first wall
around round 8–10, same discipline as Emberkeep's floor curve).

---

## 3. Charms — starter pool

Design rules: state each in one line, no charm reads as strictly better than
another, and at least a third should be *conditional* so drafts involve real
choices rather than picking the biggest number.

**Warmth (flat)**
1. **Sun-Warmed Stone** — +15 Warmth per stone tile cleared
2. **Yuzu Grove** — +12 Warmth per yuzu cleared
3. **Deep Soak** — +50 Warmth per cascade step
4. **Collector** — +8 Warmth per unique Charm you own

**Bliss (additive)**
5. **Gentle Ripple** — +0.5 Bliss per cascade step (stacks with base)
6. **Steam Rising** — +0.4 Bliss per match of 4+
7. **Compound Warmth** — +0.3 Bliss per Charm you own
8. **Patient Soak** — +2.0 Bliss if you finish with half your moves unused

**Bliss (multiplicative — rare, run-defining)**
9. **Twin Springs** — ×1.5 Bliss if you cleared only two colours this round
10. **Morning Bath** — the first match each round scores ×3
11. **Last Drop** — the final move of the round scores ×4
12. **Risky Bather** — ×2 Bliss, but −3 moves per round

**Board manipulation**
13. **Floating Petal** — matches of 4 leave a wild tile behind
14. **Hot Stone** — first stone cleared each round clears its whole row
15. **Skimmer** — at round start, remove all tiles of one random colour
16. **Still Water** — once per round, swap any two tiles without needing a match
17. **Bath Bomb** — every 7th match clears a 3×3 area

**Economy**
18. **Extra Towel** — +2 moves per round
19. **Overflow** — matches of 5+ grant +1 move
20. **Second Steeping** — one free reroll per Charm draft
21. **Tea Break** — skip a draft to gain +1 permanent move

**Colour specialists** (high risk, high ceiling)
22. **Citrus Devotion** — yuzu matches score ×2, all others −25%
23. **Chain of Petals** — consecutive same-colour matches: +0.5 Bliss each, resets on colour change
24. **Monochrome Mind** — ×3 Bliss on any round where you clear a single colour ≥8 times

Ship ~24, unlock maybe 12 of them through the meta layer so the pool grows.
Target ~40 by the time the game has been live three months — charm design is
your content pipeline, and it's cheap.

---

## 4. Daily mode & sharing

- **Seed = hash of the date string.** Identical board sequence *and* identical
  charm offers for every player worldwide. This only works if the sim is
  perfectly deterministic (see §5).
- **One run per day** in daily mode; **Endless mode** with a random seed for
  unlimited play (and for people who just want to keep playing — don't gate
  that away).
- **Share grid**, spoiler-free, links to the site:

```
🛁 Cappy's Onsen — Daily #142
Round 9 · 48,320 warmth
🟢🟢🟢🟡🟢🟢🔴
capybaraclub.com
```

Green = cleared comfortably, yellow = squeaked through, red = where the run
ended. No board state revealed, so it doesn't spoil the puzzle.

- SEO surface: a permanent `/daily/142` page per day. "cappy's onsen daily 142"
  becomes a searchable, compounding trail back to your domain.

---

## 5. Technical architecture

### Reuse directly from Emberkeep

- **Seeded RNG** (`rng.ts`) — mulberry32 as pure step functions over a number
  held in state. Copy verbatim. This is what makes daily seeds possible.
- **Save system** (`save.ts`) — versioned envelope, migration map, validate-and-
  repair, clock-free (callers pass `nowMs`). Copy the pattern wholesale.
- **Draft mechanic** — `rollPerkOffer` / `choosePerk` are structurally identical
  to charm drafting. Rename and reskin.
- **Sheet-first balance discipline** — a workbook is the source of truth for
  targets, base values, and charm numbers; `config.ts` mirrors it; acceptance
  tests pin sheet-computed values so drift fails CI.

### New: `@capy/match3-sim` — deterministic, renderer-agnostic

The board engine as a pure package, same as `@emberkeep/sim`:

```
BoardState { grid: TileColor[], rngState: number, movesLeft, warmth, bliss, charms }
swap(state, a, b)      -> { state, events } | null if no match results
resolve(state)         -> cascade loop until stable, emits events
refill(state)          -> deterministic top-down, left-right draw order  ← critical
hasValidMove(state)    -> boolean
shuffle(state)         -> deterministic reshuffle when stuck
```

**The one thing that must not be got wrong:** refill draws from the seeded RNG
in a strictly defined order (column by column, top to bottom). Any ambiguity
there and two players with the same daily seed get different boards — which
silently destroys the entire daily/leaderboard premise. Write the test that
replays a fixed seed through 200 moves and asserts a hash of the final state.

**Charms as pure functions.** Each charm is `(ctx: ScoreContext) => ScoreDelta`
where the context carries match size, colour, cascade depth, moves used, charms
owned. Never let a charm mutate board state directly — that way charm order
never matters, and the stacking stays predictable and testable.

**Events out, not calls out.** `swap`/`resolve` return event arrays
(`tilesCleared`, `cascadeStep`, `charmTriggered`, `roundCleared`) and the
renderer subscribes. Same one-directional flow as Emberkeep.

### Renderer

- **PixiJS**, not three.js — this is 2D sprite work and Pixi's batching handles
  hundreds of animated tiles far better. Much smaller bundle too.
- Build **tile art and tile animation yourself** — squash on land, cascade
  timing, chain-combo escalation. This is where match-3 lives or dies and no
  asset pack provides it. Use Cozy UI for the *chrome*: panels, buttons,
  toggles, card frames, the Default/Claimed/Unlocked states (perfect for the
  charm collection screen), calendar icons (daily streak), hearts, gems.
- **Vite `base: './'`** from day one so the build drops into
  `public/games/cappys-onsen/` and works from a subfolder.
- Slug is permanent: `cappys-onsen`. It's the URL, the folder, and the
  localStorage namespace.

---

## 6. Build order

1. **Sheet first** — round targets, base warmth/bliss, charm values, expected
   run length. Model rounds 1–15 before writing game code.
2. **`match3-sim` package** — board ops, cascade resolution, determinism tests.
   No rendering. This is the risky part; do it while it's cheap.
3. **Scoring + charm hooks** — warmth/bliss pipeline, ~10 charms, all tested.
4. **Debug harness** — an ugly HTML board with buttons, exactly like Emberkeep's.
   Play it. Tune the sheet. This is where you find out if the loop is fun, at
   the point where changing it is still cheap.
5. **Pixi renderer + Cozy UI chrome** — the juice pass.
6. **Daily seed, share grid, `/daily/N` pages.**
7. **Meta progression + charm unlocks.**
8. **Rewarded-ad slots** — +5 moves on a failed round, reroll a charm draft,
   double end-of-run petals. These are the natural, player-*wanted* moments.

Rough estimate for two devs: 6–8 weeks to a playable daily. The sim and draft
scaffolding being reusable is most of why.

---

## 7. Brief for Claude Code

> Build `@capy/match3-sim`, a deterministic renderer-agnostic match-3 engine in
> TypeScript, following the architecture in this spec. Port `rng.ts` and
> `save.ts` from the Emberkeep project verbatim (seeded RNG as pure step
> functions with state held in the state object; versioned save envelope with a
> migration map). Board operations: swap, cascade resolve, deterministic refill
> (strict column-by-column top-to-bottom draw order), stuck detection,
> deterministic shuffle. Scoring as Warmth × Bliss with charms implemented as
> pure `(ScoreContext) => ScoreDelta` functions that never mutate board state.
> All operations return event arrays rather than calling out to a renderer.
> Vitest throughout, including a determinism test that replays a fixed seed
> through 200 moves and asserts a hash of the resulting state. Balance constants
> live in `config.ts` mirroring the balance workbook, with acceptance tests
> pinned to sheet-computed values. No `Math.random`, no `Date.now` anywhere in
> the package.

Then, separately, point it at the Cozy UI folder for the renderer work.

---

## 8. Housekeeping

- **Verify the Cozy UI licence** permits commercial use *and* redistribution in
  a web bundle — shipping to the site means the PNGs are publicly served. Most
  itch UI kits allow this; a few don't. Worth five minutes before you get
  attached to the look.
- **Analytics before ads.** Standard events from day one (run start, round
  cleared, run end + round reached, charm picked). You need to know which charms
  get drafted and which rounds kill people; that data *is* your balance patch
  list.
- **Cross-promote** — the run-end screen should surface other Capybara Club
  games from your `games.json`. A player who just finished a run is the warmest
  lead you'll ever have for Emberkeep.
