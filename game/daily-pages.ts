/**
 * Build-time generator for the `/daily/N` permalink pages (SPEC §4).
 *
 * These exist for search, not for play: "cappy's onsen daily 142" should land
 * on a real, crawlable page that then sends the visitor into the game. They are
 * static HTML with no JavaScript, so a crawler sees the content without running
 * anything, and each one links to its neighbours so the archive is reachable by
 * following links rather than only from a sitemap.
 *
 * The window is bounded and dated at BUILD time. A build from last month will
 * not have pages for this month's dailies — the site has to be rebuilt to keep
 * the archive current. That is the price of a fully static bundle, and it is
 * why `future` exists: a fortnight of headroom means a missed rebuild does not
 * immediately produce 404s.
 */
import type { Plugin } from "vite";
import { DEFAULT_CONFIG } from "../src/config";
import { dailyNumberOf, dailyPageUrl, dateKeyOfDaily } from "../src/daily";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Options {
  /** How many past dailies to keep as an archive. */
  past?: number;
  /** How far ahead to pre-build, so a missed rebuild does not 404. */
  future?: number;
  /** Build clock. Injectable so the output is testable. */
  nowMs?: number;
}

function pageHtml(n: number, today: number, last: number): string {
  const cfg = DEFAULT_CONFIG.daily;
  const date = dateKeyOfDaily(cfg, n);
  const title = `${cfg.gameName} — Daily #${n}`;
  const desc =
    `Daily #${n} of ${cfg.gameName}, the roguelike match-3. ` +
    `Everyone plays the same board on ${date}. Soak, match, draft charms, share your grid.`;
  const isFuture = n > today;

  const prev = n > 1 ? `<a href="../${n - 1}/">← Daily #${n - 1}</a>` : "";
  const next = n < last ? `<a href="../${n + 1}/">Daily #${n + 1} →</a>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${dailyPageUrl(cfg, n)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${dailyPageUrl(cfg, n)}">
<meta name="theme-color" content="#3f8e9b">
${isFuture ? '<meta name="robots" content="noindex">\n' : ""}<style>
  :root{color-scheme:light}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#ffe6c0;color:#4a3227;
    font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;
    display:grid;place-items:center;min-height:100vh;padding:24px}
  main{max-width:34rem;text-align:center}
  h1{font-size:1.7rem;margin-bottom:.25rem}
  .date{color:#8a6a55;font-size:.9rem;margin-bottom:1.5rem}
  p{margin-bottom:1rem}
  .play{display:inline-block;background:#c0603f;color:#fff6e2;text-decoration:none;
    font-weight:700;padding:.85rem 2rem;border-radius:12px;margin:.5rem 0 1.5rem}
  .play:hover{background:#a44f33}
  nav{display:flex;justify-content:space-between;gap:1rem;font-size:.9rem;margin-top:2rem}
  a{color:#9c5a43}
</style>
</head>
<body>
  <main>
    <h1>${esc(cfg.gameName)} — Daily #${n}</h1>
    <p class="date">${date} · one board, everyone, worldwide</p>
    <a class="play" href="../../?daily=${n}">${isFuture ? "Not open yet" : `Play Daily #${n}`}</a>
    <p>A roguelike match-3. Clear the Warmth target each round, draft a Charm between
       rounds, and see how far your build gets before the water goes cold.</p>
    <p>Everyone in the world gets the same board and the same charm offers for
       Daily #${n}. Finish, then share your spoiler-free grid.</p>
    <nav><span>${prev}</span><span><a href="../../">All dailies</a></span><span>${next}</span></nav>
  </main>
</body>
</html>
`;
}

export function dailyPages(options: Options = {}): Plugin {
  const past = options.past ?? 120;
  const future = options.future ?? 14;

  return {
    name: "onsen-daily-pages",
    apply: "build",
    generateBundle() {
      const cfg = DEFAULT_CONFIG.daily;
      const now = options.nowMs ?? Date.now();
      const today = dailyNumberOf(cfg, now);
      const first = Math.max(1, today - past);
      const last = today + future;

      for (let n = first; n <= last; n++) {
        this.emitFile({
          type: "asset",
          fileName: `daily/${n}/index.html`,
          source: pageHtml(n, today, last),
        });
      }

      // A sitemap so the archive is discoverable without crawling every link.
      const urls = [];
      for (let n = first; n <= Math.min(today, last); n++) {
        urls.push(
          `  <url><loc>${dailyPageUrl(cfg, n)}</loc><lastmod>${dateKeyOfDaily(cfg, n)}</lastmod></url>`,
        );
      }
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source:
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          `  <url><loc>https://${cfg.siteUrl}${cfg.gamePath}</loc></url>\n` +
          `${urls.join("\n")}\n</urlset>\n`,
      });

      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: `User-agent: *\nAllow: /\nSitemap: https://${cfg.siteUrl}${cfg.gamePath}sitemap.xml\n`,
      });
    },
  };
}
