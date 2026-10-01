#!/usr/bin/env node
// The tuning harness: an ugly, playable board over the sim, with an autoplay bot
// and batch simulation over many seeds. Not shipped, and not part of the release
// pipeline - `scripts/build.mjs` is what produces dist/ for the assembler.
//
// It exists because the curve is the product. Every number on its screen comes out
// of src/sim, so a round that is too harsh or a charm that is never worth drafting
// shows up here, over hundreds of bot runs, before a player ever finds it.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("debug/dist", { recursive: true });
await build({
  entryPoints: ["debug/main.ts"],
  bundle: true,
  outfile: "debug/dist/main.js",
  format: "esm",
});
await cp("debug/index.html", "debug/dist/index.html");
console.log("harness built - serve debug/dist, or run `pnpm bench`");
