# Shipping Cappy's Onsen

## Build

```
npm run build:game      # -> public/games/cappys-onsen/
```

The bundle is fully static and `base: './'`, so it runs from any subfolder.
It contains the game, `/daily/N/` permalink pages, `sitemap.xml` and `robots.txt`.

Copy `public/games/cappys-onsen/` to the site at the same path. Nothing else is
needed — no server, no build step on the site's side.

## Vercel

`vercel.json` is already set up. Import the repo and it builds with no further
configuration:

| Setting | Value |
|---|---|
| Build command | `npm run build:game` |
| Output directory | `public/games/cappys-onsen` |
| Install command | `npm ci` |

The output directory is served at the **root** of the Vercel domain, so the game
lands on `/` and a permalink on `/daily/5/`. That works because the bundle is
built with `base: './'` (rule 8) — every asset URL is relative, so the same
build runs from a domain root or from a subfolder without changing.

### Telling the build where it lives

The canonical URLs, the sitemap and robots.txt all have to name a real host, and
the same commit gets deployed to more than one. Two environment variables
control it; neither is required.

| Variable | Default | Use it when |
|---|---|---|
| `ONSEN_ORIGIN` | `https://capybaraclub.com` | Vercel is the real home, not a mirror |
| `ONSEN_BASE_PATH` | `/games/cappys-onsen/` | The bundle sits at the domain root — set `/` |

**If Vercel is production**, set both in the project's environment variables:

```
ONSEN_ORIGIN     = https://cappysonsen.vercel.app   (or your custom domain)
ONSEN_BASE_PATH  = /
```

**If Vercel is only a preview** and capybaraclub.com stays the real home, set
nothing. Vercel's own `VERCEL_ENV`/`VERCEL_URL` are picked up automatically:
preview deploys canonicalise to themselves, ship `robots.txt` with
`Disallow: /`, and mark every page `noindex`, so a preview can never compete
with the live site for the same content in search.

### What is not indexed

Puzzles that have not opened yet carry `noindex` and stay out of the sitemap —
the build pre-generates a fortnight ahead so a missed rebuild does not 404, and
those pages should not be in an index until their date arrives.

### Rebuild cadence

The `/daily/N` archive is generated at build time, 120 days back and 14 forward.
It does not update itself. Redeploy at least every couple of weeks, or add a
Vercel Deploy Hook on a cron so the archive keeps pace.

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
