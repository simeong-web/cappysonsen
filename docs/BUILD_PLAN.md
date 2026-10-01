# BUILD_PLAN.md

Milestones for Cappy's Onsen. Design lives in `docs/SPEC.md`; rules live in
`CLAUDE.md`. Work these **one at a time, in order.**

**How to use this file (humans):** start a Claude Code session with
*"Read CLAUDE.md and docs/BUILD_PLAN.md, then do Milestone N. Stop when its
acceptance criteria are met."* Review, merge, then start the next session.

**How to use this file (Claude Code):** do only the current milestone. Its
"Out of scope" list is binding — those items belong to later milestones and
building them early creates rework. Update the status line when done.

Legend: 🧍 = human decision required, cannot be delegated.

---

## Milestone 0 — Scaffold

**Status:** done — 30 tests green, `tsc --noEmit` clean, `base: './'` verified
by serving the built bundle from `/games/cappys-onsen/` on a static server.
`rng.ts` verbatim; `save.ts` ported with an injected state validator (no
`RunState` until Milestone 2) and no offline-progress path.

**Scope:** empty project that runs.

**Deliverables**
- `package.json` with the commands from CLAUDE.md; TypeScript strict +
  `noUncheckedIndexedAccess`; Vitest; Vite with `base: './'`.
- Folder skeleton: `src/`, `debug/`, `game/`, `docs/`.
- Port `rng.ts` and `save.ts` from the Emberkeep project **verbatim** (seeded
  mulberry32 as pure step functions; versioned save envelope with migration map,
  validate-and-repair, clock-free). Keep their tests.
- One placeholder test so the suite runs green.

**Acceptance:** `npm test` passes, `npx tsc --noEmit` clean, `npm run dev`
serves an empty page without errors.

**Out of scope:** board logic, scoring, any rendering.

---

## Milestone 1 — Balance workbook 🧍

**Status:** built and retuned; still awaiting the human gate on whether the
curve *feels* right. `docs/onsen_balance.xlsx` recalculates in Excel with zero
error cells; readouts are **first wall round 9**, 10.7 min, 149,083 score. Every
computed cell cross-checked against an independent model (worst relative
difference 3e-16).

**Retuned at Milestone 3:** the Bliss-timing question below was settled as
*accumulate, then multiply once*. That model is ~1.6× more generous, so the
round 1 target moved 900 → 1400 to hold the wall at round 9; the derived rows
and the moves-needed formula changed with it. Questions 2 and 3 below are still
open and still belong to you.

**Scope:** the numbers, before any game code depends on them.

**Deliverables**
- A spreadsheet (`docs/onsen_balance.xlsx`) with an Assumptions sheet of tunable
  inputs (base warmth per tile, match-4/5 bonuses, cascade bliss, round target
  base and growth, move budget, Long Soak frequency) and a Rounds sheet
  modelling rounds 1–15: target, expected warmth from an average board, implied
  difficulty, and where an average player wall lands.
- Readouts: first-wall round, expected run length in minutes, score at wall.

**Acceptance:** the sheet recalculates without errors, and the readouts show a
first wall in the **round 8–10** band.

🧍 **Human gate:** you and your friend decide whether that curve feels right
before code depends on it. "Is round 9 too harsh" is not a delegatable question.

Three things the sheet surfaced that the gate should settle:

1. ~~**SPEC §2 is ambiguous about when Bliss applies.**~~ **SETTLED** at
   Milestone 3: round score = (total Warmth) × (final Bliss), multiplied once at
   round end. The deciding argument was Patient Soak — "+2.0 Bliss if you finish
   with half your moves unused" is a dead charm under per-match scoring, because
   its Bliss arrives after the last match has already scored. Under the settled
   model every charm in SPEC §3 works. `src/scoring.ts` implements exactly this
   and the sheet was retuned to match.
2. **The wall can only land on a Long Soak round.** At a 0.75 soak penalty the
   boss spike (+33% difficulty) outweighs several rounds of target drift
   (+10%/round), so the first wall is always round 3, 6, 9, 12 or 15 — never 8
   or 10. Round 9 is in band, but the curve is not finely tunable while this
   holds. Softening the penalty toward 0.9, or widening the gap between target
   growth and charm gain, would restore per-round tuning.
3. **The whole curve hinges on one guessed number.** "Score gain per charm" is
   set to 0.45 with no data behind it. The Sensitivity sheet shows the wall at
   0.40 → round 6, 0.45 → round 9, 0.50 → round 12, and ≥0.55 → no wall inside
   15 rounds. The in-band window is roughly 0.42–0.48. Milestone 4 replaces this
   guess with measurements; until then treat round 9 as provisional.

**Out of scope:** charm values beyond the first handful — those tune later
against a playable harness.

---

## Milestone 2 — Board engine (the risky one)

**Status:** done — 69 tests green, `tsc --noEmit` clean. Determinism hash pinned
at `66d0c12e` over 200 scripted moves. Every draw-order convention was
mutation-tested: flipping refill, generation, shuffle, gravity or the swap
rejection each fails the suite. One decision is deferred to Milestone 3: an
L-shape reports two runs sharing a tile, so per-tile warmth must come from
`cascadeStep.cleared` and size bonuses from `tilesCleared` — see board.ts.

**Scope:** `src/board.ts` — deterministic match-3 mechanics, no scoring.

**Deliverables**
- `BoardState { grid, cols, rows, rngState }` with tile colours as a small enum.
- `swap(state, a, b)` → `{ state, events } | null` (null when the swap produces
  no match — the move is rejected, not consumed).
- `resolve(state)` → cascade loop until stable, emitting `tilesCleared` and
  `cascadeStep` events with match size, colour, and cascade depth.
- `refill(state)` → **column by column, top to bottom** draw order (see
  CLAUDE.md rule 3).
- `hasValidMove(state)` → boolean; `shuffle(state)` → deterministic reshuffle,
  used when stuck.
- Initial board generation that guarantees no pre-existing matches and at least
  one valid move.

**Acceptance**
- Determinism test: replay a fixed seed through 200 scripted moves, hash the
  final grid + rngState, assert the hash. **This test is the product.**
- Round-trip test: serialize mid-game via `save.ts`, deserialize, continue 100
  moves, deep-equal against a never-saved run.
- No cascade can loop forever (guard + test).
- Property test: after any `resolve`, the board has no matches remaining and
  `hasValidMove` is true (or a shuffle happened).

**Out of scope:** scoring, charms, warmth/bliss, any rendering.

---

## Milestone 3 — Scoring & charms

**Status:** done — 128 tests green, `tsc --noEmit` clean. Scoring model settled
as accumulate-then-multiply; workbook retuned and re-verified in Excel.
Order-independence, cascade-depth, multiply-once, L-shape dedup and the
separate draft stream were each mutation-tested. Two things left open on
purpose: SPEC §3's **board-manipulation charms cannot exist under rule 4** (they
need declarative flags the board reads, not scoring functions), and Long Soak
**modifiers** are unimplemented — `isLongSoak()` marks the rounds, nothing acts
on them yet.

**Scope:** `src/scoring.ts`, `src/charms.ts`, `src/run.ts`.

**Deliverables**
- Warmth × Bliss pipeline per SPEC §2, values mirrored from the workbook.
- `ScoreContext` (match size, colour, cascade depth, moves used/left, charms
  owned, round number) and `ScoreDelta` (warmth add, bliss add, bliss mult).
- **12 charms** from SPEC §3 as pure functions — pick a spread across the
  archetypes (flat warmth, additive bliss, multiplicative, board manipulation,
  economy, conditional). Not all 24 yet.
- Run state machine: round start → moves → target check → draft offer (1 of 3,
  seeded) → next round or run end. Reuse Emberkeep's offer/choose shape.

**Acceptance**
- Acceptance tests pin round targets and base scoring to workbook values.
- Charm order-independence test: apply the same charm set in shuffled orders,
  assert identical scores.
- Each charm has a test asserting its stated effect in isolation.
- Determinism holds end-to-end: same seed → same run outcome including drafts.

**Out of scope:** rendering, daily mode, meta progression, the other 12 charms.

---

## Milestone 4 — Debug harness 🧍 **THE GATE**

**Status:** built, awaiting the gate. `npm run dev` → clickable board, live
readouts, drafts, seed box, autoplay and a batch panel. 138 tests green,
`tsc --noEmit` clean. Verified end to end by driving the real UI with synthetic
clicks in headless Chrome: play a move, clear a round, take a charm, play to
death, restart, replay a seed — zero console errors. No `src/` changes.

**What the batch panel says (300 random runs, 40 greedy):**

| | random bot | greedy bot | workbook says |
|---|---|---|---|
| median wall | round 5 | round 15 | round 9 |
| median score | 23,525 | 2,751,586 | 149,083 |
| mean charms | 5.0 | 11.9 | — |
| moves to clear r1 → last | 11 → 17 | 4 → 17 | 11.5 → 20 |

Three things for the gate, beyond "is it fun":

1. **The harness cannot answer open question 2 yet.** Long Soak modifiers are
   not implemented, so rounds 3/6/9 are ordinary rounds in code. The workbook's
   0.75 penalty exists only in the sheet. Deaths spread evenly across rounds
   rather than clustering on multiples of 3 — that is the *absence* of the
   mechanic, not evidence against the concern.
2. **Skill swamps the curve.** A 3× spread in wall round between a weak and a
   strong player is far more than one 0.8 skill factor models. Round 9 sits
   between them, so the sheet is not wrong — but "the wall" is a much wider band
   than a single number suggests.
3. **The charm pool is the ceiling, not the curve.** A strong player owns all
   twelve charms by round ~13 and dies within two or three rounds of the pool
   running dry — they stop getting stronger while targets keep growing at 1.6×.
   Milestone 7's expansion to 24 moves this; at twelve it is a hard cap.

Also worth a look while playing: a competent player clears round 1 in **4 moves
of 20**. The opening rounds may be too soft to be interesting.

**Scope:** `debug/` — an ugly, functional board you can actually play.

**Deliverables**
- Clickable grid (no art — coloured squares and text are correct here).
- Live readout: warmth, bliss, moves left, target, round, charms owned.
- Charm draft as three buttons; run-end and restart.
- Seed input box so a specific board can be replayed on demand.
- Speed/skip controls for fast iteration.

**Acceptance:** you can play a full run from round 1 to death without touching
the console.

🧍 **Human gate — the most important one in this file.** Play it. Both of you.
Then answer: *is the loop fun before there is any art?* If it isn't, the fix is
in the charms and the curve, and it is enormously cheaper to fix here than after
a renderer exists. **Do not proceed to Milestone 5 on momentum.** Expect to
spend real time in the sheet↔config↔harness loop at this stage; that is the
work, not a delay.

**Out of scope:** anything that looks nice.

---

## Milestone 5 — Renderer

**Status:** done — 138 tests green, `tsc --noEmit` clean, Pixi 8.19. Verified by
driving the real client with **touch events on an emulated iPhone 13**: drag-swap,
tap-tap swap, rejected swap costing no move, cascade animation, draft, run end,
restart. Then the same again against the **production bundle served from
`/games/cappys-onsen/`** on a static server — boots, renders, plays, zero failed
requests. Also checked landscape and a 320×568 phone.

**The subfolder check earned its place.** The first build emitted **no PNGs at
all**. Asset URLs were built with `new URL(path, import.meta.url)` from a
computed path, which Vite cannot statically analyse — it works in dev, where the
file is served off disk, and ships a chrome-less bundle. Static imports fixed it;
6 assets are emitted and hashed, 7 inline as data URIs under Vite's 4 kB
threshold.

Bundle: ~700 kB on disk, ~195 kB gzipped over the wire.

**Visual pass after first review.** Two fixes, one root cause between them:

- *Panels looked melted.* The pack's containers are hand-drawn with small nicks
  along every edge. Nine-slice pins the corners and stretches the middle, so
  whichever nicks fell in the middle band smeared into long steps. Every
  container is *larger* than the box it fills (the wood plank is 1511px wide for
  a ~400px bar), so `stretched()` scales the whole sprite instead — within ~15%
  of uniform, no smearing. Nine-slice is kept only for buttons, whose art is
  near enough a plain rounded rectangle. Bar heights also grew: the plank's
  bottom shadow lip is a fixed ~28px and short bars had nothing left over.
- *Background too dark.* Was near-black teal, which read cold and fought the
  warm chrome. Now a four-stop ramp — cream, peach, shallow water, deep water —
  with soft steam blooms, and a wooden rim around the tub. The play area stays
  the darkest thing on screen only so the pastel tiles keep their contrast.

**Scope:** `game/` — PixiJS client with Cozy UI chrome.

**Deliverables**
- Pixi board: tile sprites, swap animation, clear/pop, gravity drop, cascade
  timing that escalates with chain depth.
- Custom tile art (yuzu, petal, bubble, stone, leaf) — **not** from the asset
  pack.
- Cozy UI for chrome: panels, buttons, charm cards (Default/Claimed/Unlocked
  states), warmth/bliss counters, round header, run-end screen.
- Event subscription only — the renderer computes nothing.
- Mobile-first: touch swap, safe-area padding, portrait layout, thumb-reachable
  controls. Half your traffic is phones.

**Acceptance:** playable on a phone; `npm run build:game` produces a bundle that
runs correctly when served from a subfolder (verify with a local static server,
not just `npm run game`).

**Out of scope:** daily mode, ads, meta progression.

---

## Milestone 6 — Daily mode & sharing

**Status:** done — 164 tests green, `tsc --noEmit` clean.

**Acceptance, verified:**
- *Two browsers, different profiles, same date.* Two isolated Chrome
  `--user-data-dir` profiles on Daily #142: identical seed, identical opening
  `rngState`, **byte-identical board sequence** (17 snapshots x 49 tiles across
  16 played moves) and **identical charm offers**.
- *Share text copies to clipboard on mobile.* On a 390x844 touch viewport with
  clipboard permission granted, the copy lands. Windows normalises `
` to
  `

` on the clipboard — the only difference, content otherwise byte-identical.

**Decisions worth knowing**
- **The day boundary is UTC.** Local midnight cannot give "the same board for
  every player worldwide": at 09:00 in Auckland and 21:00 the previous day in
  Los Angeles two players would be on different numbers and their grids would
  not compare. Cost: rollover lands mid-day in some regions.
- **The seed hashes the date STRING, not the day index**, so consecutive dailies
  do not open on visibly similar boards.
- **`daily.epoch` is pinned in `config.ts` and must never move** — every
  permalink, share grid and future leaderboard row is numbered from it.
- **Past dailies are replayable** via `?daily=N`; the one-run-per-day lock
  applies only to today's number. The archive pages need something to do, and
  there are no leaderboards yet to protect.
- The whole daily run is persisted, not just a "played today" flag, so a closed
  tab is not a lost attempt when there is exactly one.

**Scope:** the traffic engine.

**Deliverables**
- Seed derived from the date string; identical boards and charm offers globally.
- One run per day in Daily; Endless mode with a random seed alongside it.
- Share grid per SPEC §4 — spoiler-free, with the site URL.
- `/daily/N` permalink pages for SEO.

**Acceptance:** two browsers with different profiles, same date → byte-identical
board sequence and charm offers. Share text copies to clipboard on mobile.

**Out of scope:** leaderboards with accounts (the site has a Leaderboards
"Preview" already — coordinate before building anything server-side).

---

## Milestone 7 — Meta progression

**Status:** done — 189 tests green, `tsc --noEmit` clean.

- **Currency:** petals at run end — `sqrt(score)/4 + 3 per round cleared`, so a
  monster run pays well without making every unlock instant. Tuned by feel;
  Milestone 8's analytics should replace the guess.
- **Pool 12 → 24. All of SPEC §3 now exists**, board manipulation included.

**How the board charms got in without bending rule 4.** A charm still never
touches a grid. It carries a `board` block of plain DATA; `run.ts` folds the
owned set into a `BoardEffects` record; `board.ts` — the only module that
mutates a grid — reads it while resolving. No charm is called from inside
board.ts and nothing in board.ts knows what a charm is. Rule 4 holds as written.

- `WILD` is a new tile that substitutes for any colour (Floating Petal).
  Generation and refill never produce one, so a board without that charm
  contains no wild and behaves exactly as before — **the Milestone 2
  determinism hash still passes untouched**, and there is a test asserting
  `resolve(s)` and `resolve(s, NO_EFFECTS)` agree across 25 seeds.
- `clearCells` is the one new board primitive (Skimmer); `swap(..., {force})`
  is Still Water; Hot Stone, Bath Bomb and Floating Petal are counters `resolve`
  advances and returns.
- Wilds are consumed greedily left-to-right, so one wild serves one run.
  Arbitrary, but *deterministic*, which is the property that matters.
- **Collection screen** using all three card states, with décor below it.
- **Décor:** three cosmetic tub palettes. They only drive the background ramp
  and rim — nothing the sim can see.

**Acceptance, verified:** a meta record round-trips through `save.ts`; a genuine
v1 envelope migrates to v2 with its unlocks intact; a damaged record is repaired
rather than wiped (unknown ids dropped, negatives floored, the starter twelve
always restored). `SAVE_VERSION` is 2 with a `MIGRATIONS[1]` entry, and a test
asserts every version below the current one has a migration.

Two real bugs the tests caught: the per-round colour tallies were sparse arrays,
whose holes become `null` through JSON so a reloaded run differed from one never
saved; and `validateRun` dropped `score.movesAdd`, losing Overflow's granted
moves on reload.

**Deliverables:** run-end currency, charm unlocks expanding the draft pool from
12 → 24, a collection screen using the pack's card states, cosmetic décor.

**Acceptance:** unlocks persist across saves and survive a `SAVE_VERSION` bump
via migration.

---

## Milestone 8 — Instrumentation & ship

**Status:** built — 222 tests green, `tsc --noEmit` clean. Bundle 796 kB on
disk, ~107 kB gzipped. See `docs/SHIP.md` for the deploy runbook.

**All five events** are defined in `src/analytics.ts` as pure builders and
emitted by the client: run start, round cleared, run end (+ round reached),
charm drafted, and **charm offered-but-declined** — every charm a draft showed,
taken or not, which is the picked-over-offered ratio the balance patch list
needs. `pickRates()` aggregates it without a dashboard existing.

**All three rewarded slots** are wired as real state transitions:
`reviveWithMoves` puts the failed round back with the board, warmth and bliss
exactly as the player left them (and un-banks it so it cannot score twice);
`rerollOffer(..., {free:true})` rerolls without spending a charm's allowance;
`recordRun(..., 2)` doubles the petals and nothing else.

🧍 **TWO THINGS BLOCK THE ACCEPTANCE CRITERIA — BOTH ARE YOURS**

1. **The site promises no analytics and no ads.** `apps/site/src/pages/
   Privacy.tsx` says "That data never leaves your device and we never see it",
   "We don't use analytics, ads, or cookies to track you across sites", and that
   the page "will be updated to explain what's new BEFORE it happens".
   So everything here ships **inert**: no sink is installed, so nothing is sent;
   `window.capyAds` is absent, so `hasRewardedAds()` is false and no ad button
   renders. Enabling either means updating the privacy page first. "Analytics
   visible in the dashboard from a real session" cannot be met until you decide
   to collect anything.
2. **There is no `games.json`, and no dashboard.** The site uses a TypeScript
   manifest registry (`apps/site/src/config.ts`), not a JSON catalog. Cross-promo
   fetches `../../games.json` and renders nothing when it is missing, so the game
   ships fine either way; `docs/games.json.example` is the expected shape. The
   catalog entry is written up in `docs/SHIP.md` but not applied — it belongs to
   the site repo, and there is an open question there: every other game is a
   lazily-imported workspace package, while this one is a standalone static
   bundle at `/games/cappys-onsen/`. Those are two delivery models and one of
   them has to give.

"Game loads and saves correctly from the live site path" was verified against a
local static server at `/games/cappys-onsen/` (Milestones 5 and 6). The live
deploy itself is yours.

**Deliverables**
- Analytics events: run start, round cleared, run end (+ round reached), charm
  drafted, charm offered-but-declined. The offered-vs-picked ratio is your charm
  balance data.
- Rewarded-ad slots: +5 moves on a failed round, reroll a draft, double end-of-
  run currency. Marked clearly in code, gated behind the SDK.
- Cross-promo on the run-end screen fed from the site's `games.json`.
- Build dropped into `public/games/cappys-onsen/`, catalog entry added.

**Acceptance:** analytics visible in the dashboard from a real session; game
loads and saves correctly from the live site path.

---

## Status log

| Milestone | Status | Notes |
|---|---|---|
| 0 Scaffold | ✅ done | rng verbatim; save ported (validator injected, no offline path); vite 8 / vitest 4 |
| 1 Workbook 🧍 | retuned — awaiting gate | wall round 9, 10.7 min, 149,083; bliss model settled, 2 questions open |
| 2 Board engine | ✅ done | hash `66d0c12e`; conventions mutation-tested; L-shape scoring deferred to M3 |
| 3 Scoring & charms | ✅ done | 12 charms, order-independent by construction; board-manipulation archetype blocked by rule 4 |
| 4 Harness 🧍 | built — awaiting gate | playable; walls at r5 (weak) / r15 (strong) vs sheet's r9; Long Soak modifiers still absent |
| 5 Renderer | ✅ done | touch-verified on emulated iPhone + prod bundle from subfolder; Cozy demo assets bundled per owner decision |
| 6 Daily | ✅ done | UTC day boundary; two-profile board+offer parity verified; 15 permalink pages + sitemap |
| 7 Meta | ✅ done | petals, all 24 charms, collection + décor; SAVE_VERSION 2 with migration; board effects added without bending rule 4 |
| 8 Ship | built — 2 human gates | events + ad slots wired but INERT (site privacy page forbids both); catalog entry needs a site decision |
| Platform port | ✅ done | single esbuild package on capybara-club-game-template; host-owned saves; ads off behind `ADS_ENABLED`; analytics, cross-promo and the Vercel/SEO build removed — see `docs/PORTING.md` |
