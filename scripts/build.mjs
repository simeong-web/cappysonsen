#!/usr/bin/env node
// No fallback on purpose: a hardcoded localhost default here once silently shipped a
// broken production build, since nothing failed loudly when it was wrong. Set via the
// "dev" script for local dev, via release.yml's `env:` for real releases.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { validateManifest } from "@mittell/capybara-club-sdk";

const hostOrigin = process.env.HOST_ORIGIN;
if (!hostOrigin) throw new Error("HOST_ORIGIN is not set");

// Fails the build locally, before a release is even cut, rather than only being
// caught later by the assembler's own copy of this same check.
const manifest = validateManifest(JSON.parse(await readFile("manifest.json", "utf8")));

// Emptied first: the chrome sprites land in dist/assets/, and a sprite deleted from
// src/ must not live on in the release zip because an old build left it there.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/main.js",
  format: "esm",
  // Pixi's renderer modules are dynamic imports. Without code splitting esbuild
  // inlines them into main.js, which is what keeps dist/ a single script next to
  // index.html rather than a folder of chunks.
  //
  // The Cozy UI sprites are imported by src/game/chrome.ts. The `file` loader copies
  // each to dist/assets/<name>.png and binds the import to "./assets/<name>.png" - a
  // URL relative to the page, which is what Pixi's Assets resolves against. Stable
  // names rather than hashed ones: the assembler serves a release as a unit, so there
  // is no cache to bust, and a reviewer can read the zip's contents at a glance.
  loader: { ".png": "file" },
  assetNames: "assets/[name]",
  // MANIFEST_ID comes from manifest.json rather than being hardcoded a second time in
  // src/main.ts - one source of truth, no risk of the two drifting out of sync.
  //
  // ADS_ENABLED gates the game's three rewarded slots (+5 moves, a draft reroll,
  // double petals). Off unless ADS=1 is set, because this platform's SDK has no ad
  // API to ask - see src/platform/host.ts. The code behind the flag is written; turning
  // it on is this line plus an implementation of Host.requestRewardedAd, not a rewrite.
  //
  // DEV_HANDLE exposes window.__onsen, the client's automation handle, for driving a
  // build from a browser script. Off unless DEV_HANDLE=1; never set in a release.
  define: {
    HOST_ORIGIN: JSON.stringify(hostOrigin),
    MANIFEST_ID: JSON.stringify(manifest.id),
    ADS_ENABLED: JSON.stringify(process.env.ADS === "1"),
    DEV_HANDLE: JSON.stringify(process.env.DEV_HANDLE === "1"),
  },
});

await cp("index.html", "dist/index.html");
await cp("manifest.json", "dist/manifest.json");
