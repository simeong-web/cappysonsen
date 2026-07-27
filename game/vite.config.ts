import { defineConfig } from "vite";
import { dailyPages } from "./daily-pages";

// base: './' (CLAUDE.md rule 8) — this bundle is served from
// /games/cappys-onsen/, so every emitted asset URL must be relative.
// outDir mirrors that deploy path; `cappys-onsen` is permanent (rule 9).
export default defineConfig({
  base: "./",
  plugins: [dailyPages()],
  build: { outDir: "../public/games/cappys-onsen", emptyOutDir: true },
});
