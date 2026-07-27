/**
 * DETERMINISM TESTS — this file is the product.
 *
 * Daily mode, the leaderboards and the share grid all rest on one claim: the
 * same seed produces the same board, forever, on every machine. The hash pinned
 * below is that claim made falsifiable. If it fails, do not update the constant
 * — find what changed the draw order, because every daily seed ever played has
 * just been invalidated.
 *
 * The hash pins current behaviour, which is why it is not the only guard: the
 * draw ORDER itself is checked against the documented convention in
 * board.test.ts, so a wrong order cannot simply be locked in here.
 */
import { describe, it, expect } from "vitest";
import { rngInt } from "../src/rng";
import { serializeSave, parseSave } from "../src/save";
import {
  createBoard,
  swap,
  resolve,
  hasValidMove,
  hasMatches,
  validateBoard,
  type BoardState,
  type Pos,
} from "../src/board";

/** FNV-1a over the grid and the RNG cursor: the two things replay depends on. */
function hashBoard(state: BoardState): string {
  let h = 2166136261 >>> 0;
  const feed = (n: number): void => {
    for (let b = 0; b < 4; b++) {
      h ^= (n >>> (b * 8)) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  feed(state.cols);
  feed(state.rows);
  feed(state.colours);
  for (const t of state.grid) feed(t);
  feed(state.rngState);
  return h.toString(16).padStart(8, "0");
}

/** Every legal move on the board, enumerated through the public API. */
function legalMoves(state: BoardState): [Pos, Pos][] {
  const out: [Pos, Pos][] = [];
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const a = { col, row };
      const right = { col: col + 1, row };
      const down = { col, row: row + 1 };
      if (col + 1 < state.cols && swap(state, a, right)) out.push([a, right]);
      if (row + 1 < state.rows && swap(state, a, down)) out.push([a, down]);
    }
  }
  return out;
}

/**
 * A scripted player. The move choice runs off its OWN seed stream, separate
 * from the board's: a real player's choices are not drawn from the board RNG,
 * and keeping them separate means this harness cannot accidentally mask a
 * change in the board's own draw count.
 */
function play(
  start: BoardState,
  scriptSeed: number,
  moves: number,
): { state: BoardState; script: number; cascades: number } {
  let state = start;
  let script = scriptSeed;
  let cascades = 0;
  for (let i = 0; i < moves; i++) {
    const options = legalMoves(state);
    expect(options.length, `no legal move at move ${i}`).toBeGreaterThan(0);
    const pick = rngInt(script, options.length);
    script = pick.state;
    const [a, b] = options[pick.value]!;
    const swapped = swap(state, a, b);
    expect(swapped, `enumerated move ${i} was rejected`).not.toBeNull();
    const out = resolve(swapped!.state);
    for (const e of out.events) if (e.type === "cascadeStep") cascades++;
    state = out.state;
  }
  return { state, script, cascades };
}

const SEED = 20260726;
const SCRIPT = 0xc0ffee;

describe("replay determinism", () => {
  it("replays a fixed seed through 200 moves to a pinned hash", () => {
    const a = play(createBoard({ seed: SEED }), SCRIPT, 200);
    const b = play(createBoard({ seed: SEED }), SCRIPT, 200);

    expect(hashBoard(a.state)).toBe(hashBoard(b.state));
    expect(a.state).toEqual(b.state);

    // ── The contract. See the file header before touching these. ──
    expect(hashBoard(a.state)).toBe("66d0c12e");
    expect(a.state.rngState).toBe(-1507666408);
    expect(a.state.grid.join("")).toBe("1330203133103224014320110143230201044241241201044");

    // Sanity: the run actually did something. 200 moves produced 335 cascade
    // steps, so the pinned board is the product of real cascading, not of 200
    // moves that each cleared one run and stopped.
    expect(a.cascades).toBe(335);
  });

  it("diverges on a different seed", () => {
    const a = play(createBoard({ seed: SEED }), SCRIPT, 50);
    const b = play(createBoard({ seed: SEED + 1 }), SCRIPT, 50);
    expect(hashBoard(a.state)).not.toBe(hashBoard(b.state));
  });

  it("diverges on different play, from the same board", () => {
    const a = play(createBoard({ seed: SEED }), 1, 50);
    const b = play(createBoard({ seed: SEED }), 2, 50);
    expect(hashBoard(a.state)).not.toBe(hashBoard(b.state));
  });

  it("holds across many seeds, not just the pinned one", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const a = play(createBoard({ seed }), seed * 7, 25);
      const b = play(createBoard({ seed }), seed * 7, 25);
      expect(hashBoard(a.state), `seed ${seed}`).toBe(hashBoard(b.state));
    }
  });
});

describe("save round-trip mid-game", () => {
  const NOW = 1_800_000_000_000;

  it("continues identically after a save and reload", () => {
    const mid = play(createBoard({ seed: 4242 }), 99, 100);

    // Control: never saved, just kept playing.
    const control = play(mid.state, mid.script, 100);

    // Same run, pushed through the save system at the halfway point.
    const envelope = parseSave(serializeSave(mid.state, NOW), validateBoard);
    expect(envelope).not.toBeNull();
    expect(envelope!.state).toEqual(mid.state);
    const revived = play(envelope!.state, mid.script, 100);

    expect(revived.state).toEqual(control.state);
    expect(hashBoard(revived.state)).toBe(hashBoard(control.state));
    expect(revived.cascades).toBe(control.cascades);
  });

  it("survives a JSON round-trip with no drift in the RNG cursor", () => {
    const mid = play(createBoard({ seed: 8080 }), 5, 40);
    const revived = parseSave(serializeSave(mid.state, NOW), validateBoard)!.state;
    expect(revived.rngState).toBe(mid.state.rngState);
    expect(revived.grid).toEqual(mid.state.grid);
  });
});

describe("invariants after every resolve", () => {
  it("never leaves a match on the board and never leaves it unplayable", () => {
    let shuffles = 0;
    for (let seed = 1; seed <= 30; seed++) {
      let state = createBoard({ seed });
      let script = seed * 31;
      for (let move = 0; move < 40; move++) {
        const options = legalMoves(state);
        expect(options.length).toBeGreaterThan(0);
        const pick = rngInt(script, options.length);
        script = pick.state;
        const [a, b] = options[pick.value]!;
        const out = resolve(swap(state, a, b)!.state);
        state = out.state;

        expect(hasMatches(state), `seed ${seed} move ${move}: match left on the board`).toBe(false);
        expect(hasValidMove(state), `seed ${seed} move ${move}: board left unplayable`).toBe(true);
        expect(state.grid.some((t) => t < 0)).toBe(false);
        expect(state.grid.length).toBe(state.cols * state.rows);
        expect(out.events.some((e) => e.type === "cascadeAborted")).toBe(false);
        for (const e of out.events) if (e.type === "shuffled") shuffles++;
      }
    }
    // Informational: with 5 colours on 7x7 a stuck board is rare, but the code
    // path that rescues one has to exist regardless.
    expect(shuffles).toBeGreaterThanOrEqual(0);
  });
});
