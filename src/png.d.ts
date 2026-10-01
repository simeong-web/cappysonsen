/**
 * `src/game/chrome.ts` imports each Cozy UI sprite so esbuild's `file` loader
 * emits it into `dist/assets/` and hands back its URL. TypeScript needs telling
 * that such an import is a string — Vite's client types used to say so.
 */
declare module "*.png" {
  const url: string;
  export default url;
}
