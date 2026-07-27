import { defineConfig } from "vitest/config";

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
