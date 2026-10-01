# Assets — Cappy's Onsen

Every file and external resource the shipped game uses, and where it comes from.
The release zip is `dist/` and nothing else, so this is also a list of what the
platform will serve on the game's behalf.

## Third-party: the Cozy UI Pack (DEMO)

Chrome sprites from the **Cozy UI Pack (DEMO)** by **dobo_ui** —
<https://dobo-ui.itch.io/>. The pack's own record, with the licence note, sits
next to the files: [`src/game/assets/cozy/SOURCE.md`](../src/game/assets/cozy/SOURCE.md).

**Licence status: not cleared.** The demo download ships no licence file — only
a developer note pointing at the itch page. Including the sprites was an
explicit owner decision made before the port, and the port did not change it.
What the port *did* change is how they are served: they are now inside the
release zip that `capybara-club-assembler` publishes, so the open question in
`SOURCE.md` — do the itch terms cover commercial use **and** redistribution in
a publicly served web bundle? — has to be answered before this game goes live
on the platform, not after.

| File (in `src/game/assets/cozy/`) | Emitted as | Used for |
|---|---|---|
| `bar.png` | `dist/assets/bar.png` | HUD, footer and build-strip bars |
| `panel.png` | `dist/assets/panel.png` | menu, run-end and collection panels |
| `card-default.png` | `dist/assets/card-default.png` | charm card — default, locked and unlocked |
| `card-claimed.png` | `dist/assets/card-claimed.png` | charm card — just drafted |
| `check-on.png` | `dist/assets/check-on.png` | the tick on an unlocked charm card |
| `button.png`, `button-primary.png`, `button-light.png` | `dist/assets/` | buttons |
| `panel-inset.png`, `note.png`, `check-off.png`, `icon-heart.png`, `icon-cross.png`, `icon-plus.png` | `dist/assets/` | loaded by `loadChrome` but drawn by nothing today — shipped because the manifest in `chrome.ts` names them |
| `button-round.png` | *not emitted* | in the repo, imported by nothing, so not in the zip |

They are imported by `src/game/chrome.ts`; esbuild's `file` loader copies each
to `dist/assets/<name>.png` and binds the import to `./assets/<name>.png`, which
Pixi's `Assets.load` resolves against the page. Fourteen requests, all
same-origin, all relative.

## Drawn by us

| Thing | Where |
|---|---|
| The five tile faces, the wild tile, the spark | `src/game/tiles.ts` — Pixi `Graphics`, rendered to textures at boot |
| Board well, wooden rim, sky-to-water background, steam | `src/game/client.ts` — `Graphics` |
| Selection ring, match and cascade effects | `src/game/board-view.ts` |
| Favicon | inline SVG data URI in `index.html` (a 🍊 glyph) |

Board tiles are deliberately not from the pack: CLAUDE.md's asset rule keeps
the pack to chrome only.

## Fonts

None bundled and none fetched. Every `Text` uses the system stack
`system-ui, -apple-system, 'Segoe UI', sans-serif` (`src/game/theme.ts`).

## Network

The game makes **no requests to any third-party origin**. The only requests are
`main.js` and the fourteen sprites above, all relative to the page. The
cross-promo panel, which used to fetch `../../games.json`, was removed in the
port — see `docs/PORTING.md`.

## Emoji

Not asset files, but not drawn by us either, so they belong in this record.
Rendered by the player's own system font.

| Glyph | Where |
|---|---|
| 🛁 | share text header (`src/sim/daily.ts`), manifest icon |
| 🟢 🟡 🔴 | share grid — cleared comfortably, squeaked through, failed |
| ✓ | equipped décor in the collection |
| 🍊 | favicon |
