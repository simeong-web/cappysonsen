import { defineConfig } from "vitest/config";

/**
 * The game's own test suite, carried over whole from before the port.
 *
 * It covers the sim — determinism, the refill order, charm purity, the balance
 * numbers pinned from the workbook, save migration — plus the tuning bot and
 * the client's host save. It touches neither the DOM nor Pixi nor the host, so
 * it runs here exactly as it did under Vite. The template ships no test runner,
 * which is the one deliberate addition to its shape: the daily-seed contract is
 * the part of this game most worth protecting, and `oxlint` plus the
 * conformance test say nothing about it.
 */
export default defineConfig({
  test: {
    // Several suites replay whole runs — 200 scripted moves for the determinism
    // hash, 30 seeds x 40 moves for the board invariants, full bot runs for the
    // harness. They finish in a second or two on an idle machine and blow past
    // the 5s default on a busy one, which shows up as a "failure" that is only
    // ever a timeout. The work is bounded, so the ceiling can be generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
