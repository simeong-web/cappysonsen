# Shipping Cappy's Onsen

## Build

```
npm run build:game      # -> public/games/cappys-onsen/
```

The bundle is fully static and `base: './'`, so it runs from any subfolder.
It contains the game, `/daily/N/` permalink pages, `sitemap.xml` and `robots.txt`.

Copy `public/games/cappys-onsen/` to the site at the same path. Nothing else is
needed — no server, no build step on the site's side.

## Catalog entry

The site (`capybara-club`) has **no `games.json`**. It uses a TypeScript
registry: `apps/site/src/config.ts` imports a `manifest` per game from
`apps/games/<id>/src/manifest.ts`. To list this game, add a manifest matching
the others:

```ts
// apps/games/cappys-onsen/src/manifest.ts
import type { GameManifest } from '@capybara-club/sdk'

export const manifest: GameManifest = {
  id: 'cappys-onsen',
  title: "Cappy's Onsen",
  description: 'Soak through escalating rounds and draft charms. New board daily.',
  icon: '🛁',
  tags: ['puzzle', 'roguelike', 'daily'],
}
```

...then register it in `apps/site/src/config.ts` with `status: 'live'`.

Note that the site's other games are workspace packages loaded lazily, while
this one is a standalone static bundle served from `/games/cappys-onsen/`. Those
are two different delivery models; the catalog entry needs to link out rather
than lazy-import, or the game needs repackaging as a workspace package. **That
is an open decision.**

## Cross-promo

The run-end screen fetches `../../games.json` — i.e. `/games/games.json` — and
shows one other game. If the file is absent the panel simply does not render, so
the game ships fine without it. `docs/games.json.example` is the expected shape.

## Analytics and ads — READ BEFORE ENABLING

Both are built and wired, and both are **off**. Nothing is sent and no ad
affordance is shown in the current build. See the header of `game/telemetry.ts`.

The site's privacy page currently states:

> "That data never leaves your device and we never see it."
> "We don't use analytics, ads, or cookies to track you across sites."
> "If that ever changes ... this page will be updated to explain what's new
> **before it happens**."

So enabling either is a two-step job, in this order:

1. Update `apps/site/src/pages/Privacy.tsx` to describe what is collected.
2. Then, in `game/main.ts`'s `boot()`, call `setAnalyticsSink(fn)` with a
   transport — and/or load an ad SDK that provides `window.capyAds`.

Until step 1 happens, leaving these off is the correct behaviour, not an
oversight.
