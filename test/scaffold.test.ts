/**
 * SCAFFOLD TEST — the suite's green light, doubling as a guard on CLAUDE.md
 * rule 1: `src/sim/` is pure. No RNG source but the seeded one, no clock, no
 * storage, no DOM, no network.
 *
 * A placeholder that asserts `true` would prove the runner works and nothing
 * else. This proves the runner works *and* fails the build the first time an
 * impure call sneaks into the sim — which is the failure mode that silently
 * de-syncs daily seeds, and the one hardest to spot in review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sim from "../src/sim/index";

// Read from disk. This used to be Vite's `import.meta.glob`, chosen so the
// scaffold needed no @types/node; the port brought @types/node in anyway (the
// build scripts need it), and a plain directory walk does not depend on which
// bundler the test runner happens to sit on.
const SIM_DIR = fileURLToPath(new URL("../src/sim/", import.meta.url));
const SRC: Record<string, string> = Object.fromEntries(
  readdirSync(SIM_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [`src/sim/${f}`, readFileSync(join(SIM_DIR, f), "utf8")]),
);

/**
 * Comments are stripped before scanning so that documenting the rule ("callers
 * pass Date.now()") does not trip the rule. No string literal in `src/sim/` contains
 * `//` or `/*`; if one ever does, this stripper needs to grow up.
 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const FORBIDDEN: [label: string, pattern: RegExp][] = [
  ["Math.random", /\bMath\s*\.\s*random\b/],
  ["Date.now / new Date", /\bDate\s*\.\s*now\b|\bnew\s+Date\b/],
  ["localStorage / sessionStorage", /\b(?:local|session)Storage\b/],
  ["DOM access", /\bdocument\b|\bwindow\b/],
  ["network", /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/],
  ["timers", /\bset(?:Timeout|Interval)\s*\(|\bperformance\s*\.\s*now\b/],
];

describe("scaffold", () => {
  it("finds the sim source", () => {
    // Guards the guard: a glob that silently matches nothing would make the
    // purity test below pass forever without reading a line of code.
    expect(Object.keys(SRC).length).toBeGreaterThanOrEqual(3);
  });

  it("exports the ported Emberkeep primitives", () => {
    for (const name of ["rngNext", "rngRange", "rngInt", "rngWeighted", "serializeSave", "parseSave", "loadSave"]) {
      expect(typeof (sim as Record<string, unknown>)[name]).toBe("function");
    }
    expect(sim.SAVE_VERSION).toBe(2);
  });

  it("keeps src/sim pure — no clock, no RNG source, no DOM, no I/O", () => {
    for (const [file, source] of Object.entries(SRC)) {
      const code = stripComments(source);
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(code), `${file} uses ${label} — src/sim must stay pure (CLAUDE.md rule 1)`).toBe(false);
      }
    }
  });
});
