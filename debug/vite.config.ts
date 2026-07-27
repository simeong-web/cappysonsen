import { defineConfig } from "vite";

// base: './' everywhere (CLAUDE.md rule 8) — the game ships to a subfolder, not
// a site root, so absolute asset paths 404. Set it here from day one so nothing
// is ever authored against a root-relative assumption.
export default defineConfig({
  base: "./",
  build: { outDir: "../dist/debug", emptyOutDir: true },
});
