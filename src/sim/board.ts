/**
 * Board engine — deterministic match-3 mechanics. No scoring, no charms.
 *
 * ============================================================================
 * CONVENTIONS THAT MUST NOT DRIFT
 * ----------------------------------------------------------------------------
 * These are the daily-seed contract. Two players on the same seed get the same
 * board only because every one of these is fixed. Changing any of them changes
 * every board ever generated, so they are pinned by tests, not by convention.
 *
 * 1. GRID INDEXING is row-major: `grid[row * cols + col]`.
 *    `row 0` is the TOP of the board, `col 0` is the LEFT.
 *
 * 2. GRAVITY pulls tiles toward increasing `row` (downward, to the bottom).
 *    Holes therefore always end up at the TOP of a column after a clear.
 *
 * 3. REFILL DRAW ORDER is column by column (left to right), and within each
 *    column top to bottom — CLAUDE.md rule 3, the single highest-consequence
 *    rule in the project. `refill` draws exactly one RNG value per empty cell,
 *    in that order, and nothing else in the module draws during a refill.
 *
 * 4. RUN SCAN ORDER is all horizontal runs first (row by row, left to right),
 *    then all vertical runs (column by column, top to bottom). This fixes the
 *    order of `tilesCleared` events, which is part of the replay contract even
 *    though scoring is order-independent.
 *
 * 5. CASCADE DEPTH starts at 1 for the clear caused by the player's swap.
 *    Follow-on clears are depth 2, 3, ... Scoring in Milestone 3 must decide
 *    deliberately whether depth 1 earns cascade bliss; the workbook's
 *    "cascade steps per move" models the FOLLOW-ONS only, i.e. depth >= 2.
 * ============================================================================
 *
 * Purity: no function here mutates its argument. Scratch copies are made
 * internally and the input state is always left untouched.
 */
import { rngInt } from "./rng";

/** Tile art names, in enum order. A tile's numeric value indexes this. */
export const TILE_COLOURS = ["yuzu", "petal", "bubble", "stone", "leaf"] as const;
export type TileColourName = (typeof TILE_COLOURS)[number];

/**
 * A tile is an index into TILE_COLOURS, or EMPTY while a cascade is mid-flight.
 * Numeric rather than a string union because it has to survive JSON and be
 * compared a few hundred thousand times per determinism test.
 */
export type Tile = number;
export const EMPTY = -1;
/**
 * A wild tile matches any colour (Floating Petal). Generation and refill never
 * produce one, so a board without that charm contains no WILD and behaves
 * exactly as before — which is why the pinned determinism hash still holds.
 */
export const WILD = -2;

export const DEFAULT_COLS = 7;
export const DEFAULT_ROWS = 7;
/** 5 colours on a 7x7 board — the shape the balance workbook's match-size mix assumes. */
export const DEFAULT_COLOURS = 5;

/**
 * Cascade guard. A cascade this deep is not reachable on a real board; the cap
 * exists so that a degenerate state (a one-colour board, a corrupt save) can
 * never hang the client. Tripping it emits `cascadeAborted` — a silent cap
 * would hide exactly the bug it is meant to contain.
 */
export const MAX_CASCADE_DEPTH = 64;
export const MAX_SHUFFLE_ATTEMPTS = 64;
export const MAX_GENERATE_ATTEMPTS = 64;

export interface Pos {
  col: number;
  row: number;
}

export interface BoardState {
  cols: number;
  rows: number;
  /** How many of TILE_COLOURS are in play. */
  colours: number;
  /** Row-major, `grid[row * cols + col]`. Length is always cols * rows. */
  grid: Tile[];
  rngState: number;
}

export type BoardEvent =
  | { type: "swapped"; a: Pos; b: Pos }
  | { type: "cascadeStep"; depth: number; runs: number; cleared: number }
  | { type: "tilesCleared"; colour: Tile; size: number; depth: number; cells: Pos[] }
  | { type: "tilesFell"; depth: number; moves: { from: Pos; to: Pos }[] }
  | { type: "refilled"; depth: number; cells: { pos: Pos; colour: Tile }[] }
  | { type: "shuffled"; reason: "stuck" }
  | { type: "cascadeAborted"; depth: number };

export interface BoardResult {
  state: BoardState;
  events: BoardEvent[];
  /** Present when `resolve` ran: the effect counters, advanced. */
  effects?: BoardEffects;
}

/**
 * ============================================================================
 * BOARD EFFECTS — how the board-manipulation charms reach the board
 * ----------------------------------------------------------------------------
 * CLAUDE.md rule 4 says a charm never mutates board state, and that stays true.
 * A charm declares plain DATA; `run.ts` turns the owned set into one of these
 * records; and `board.ts` — the only module allowed to touch a grid — reads it
 * while resolving. No charm is ever called from in here, and nothing in here
 * knows what a charm is.
 *
 * The counters live in the record because they span a whole round, not one
 * cascade. `resolve` returns an updated copy rather than mutating the input, so
 * the whole thing threads through pure calls exactly like the RNG does.
 * ============================================================================
 */
export interface BoardEffects {
  /** Hot Stone: the colour whose first clear also takes its row. -1 = off. */
  rowOnFirstColour: number;
  /** Set once it has fired, so it stays once per round. */
  rowFired: boolean;
  /** Bath Bomb: clear a 3x3 on every Nth match. 0 = off. */
  areaEveryNthMatch: number;
  /** Matches counted so far this round, for the Nth-match test. */
  matchesSoFar: number;
  /** Floating Petal: runs at least this long leave a wild behind. 0 = off. */
  wildFromRunSize: number;
}

export const NO_EFFECTS: BoardEffects = {
  rowOnFirstColour: -1,
  rowFired: false,
  areaEveryNthMatch: 0,
  matchesSoFar: 0,
  wildFromRunSize: 0,
};

// ---------------------------------------------------------------- primitives

const idx = (cols: number, col: number, row: number): number => row * cols + col;

/** Out-of-range reads answer EMPTY so run scanning never walks off an edge. */
const tileAt = (grid: readonly Tile[], cols: number, col: number, row: number): Tile =>
  grid[row * cols + col] ?? EMPTY;

interface Run {
  colour: Tile;
  cells: Pos[];
}

/**
 * Maximal runs of >= 3 same-coloured tiles, horizontal then vertical.
 *
 * Runs are reported separately per axis, so an L/T shape yields two runs that
 * share a cell. That keeps "match size" unambiguous for the match-4/5 bonuses
 * in SPEC §2 — but it means the union of run cells, not the sum of run sizes,
 * is the true count of tiles cleared. `cascadeStep.cleared` carries that union;
 * scoring must take per-tile warmth from there and size bonuses from the runs.
 */
function findRuns(cols: number, rows: number, grid: readonly Tile[]): Run[] {
  const runs: Run[] = [];
  // A run is a maximal stretch of one colour, with wilds allowed to stand in
  // for it. Wilds are consumed greedily left to right: in [red red WILD blue
  // blue] the wild joins the reds and cannot also serve the blues. Greedy is
  // arbitrary but it is *deterministic*, which is the property that matters.
  const scan = (len: number, get: (i: number) => Tile, at: (i: number) => Pos): void => {
    let start = 0;
    let colour: Tile = EMPTY; // the run's real colour; EMPTY while only wilds
    const close = (end: number): void => {
      if (colour !== EMPTY && end - start >= 3) {
        const cells: Pos[] = [];
        for (let k = start; k < end; k++) cells.push(at(k));
        runs.push({ colour, cells });
      }
    };
    for (let i = 0; i <= len; i++) {
      const t = i < len ? get(i) : EMPTY;
      const fits = i < len && t !== EMPTY && (t === WILD || colour === EMPTY || t === colour);
      if (fits) {
        if (t !== WILD && colour === EMPTY) colour = t;
        continue;
      }
      close(i);
      start = i;
      colour = t === WILD ? EMPTY : t;
    }
  };
  for (let row = 0; row < rows; row++) {
    scan(cols, (c) => tileAt(grid, cols, c, row), (c) => ({ col: c, row }));
  }
  for (let col = 0; col < cols; col++) {
    scan(rows, (r) => tileAt(grid, cols, col, r), (r) => ({ col, row: r }));
  }
  return runs;
}

/**
 * Early-exit form of findRuns for the many-swaps-per-call hot paths.
 *
 * Wild tiles take the slower allocating path. They are rare — only Floating
 * Petal makes one — so the common board keeps exactly the scan it always had,
 * and the two functions cannot disagree about what counts as a match.
 */
function anyRun(cols: number, rows: number, grid: readonly Tile[]): boolean {
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === WILD) return findRuns(cols, rows, grid).length > 0;
  }
  return anyPlainRun(cols, rows, grid);
}

function anyPlainRun(cols: number, rows: number, grid: readonly Tile[]): boolean {
  for (let row = 0; row < rows; row++) {
    let n = 1;
    for (let col = 1; col < cols; col++) {
      const cur = tileAt(grid, cols, col, row);
      n = cur !== EMPTY && cur === tileAt(grid, cols, col - 1, row) ? n + 1 : 1;
      if (n >= 3) return true;
    }
  }
  for (let col = 0; col < cols; col++) {
    let n = 1;
    for (let row = 1; row < rows; row++) {
      const cur = tileAt(grid, cols, col, row);
      n = cur !== EMPTY && cur === tileAt(grid, cols, col, row - 1) ? n + 1 : 1;
      if (n >= 3) return true;
    }
  }
  return false;
}

/** True when the board currently contains at least one match. */
export function hasMatches(state: BoardState): boolean {
  return anyRun(state.cols, state.rows, state.grid);
}

const adjacent = (a: Pos, b: Pos): boolean =>
  Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;

const inBounds = (state: BoardState, p: Pos): boolean =>
  Number.isInteger(p.col) &&
  Number.isInteger(p.row) &&
  p.col >= 0 &&
  p.row >= 0 &&
  p.col < state.cols &&
  p.row < state.rows;

// ------------------------------------------------------------------- gravity

/** Compacts every column downward. Pure: returns a new grid. */
function applyGravity(
  cols: number,
  rows: number,
  grid: readonly Tile[],
): { grid: Tile[]; moves: { from: Pos; to: Pos }[] } {
  const next = grid.slice();
  const moves: { from: Pos; to: Pos }[] = [];
  for (let col = 0; col < cols; col++) {
    let write = rows - 1; // lowest free slot in this column
    for (let row = rows - 1; row >= 0; row--) {
      const tile = next[idx(cols, col, row)] ?? EMPTY;
      if (tile === EMPTY) continue;
      if (row !== write) {
        next[idx(cols, col, write)] = tile;
        next[idx(cols, col, row)] = EMPTY;
        moves.push({ from: { col, row }, to: { col, row: write } });
      }
      write--;
    }
    for (let row = write; row >= 0; row--) next[idx(cols, col, row)] = EMPTY;
  }
  return { grid: next, moves };
}

// -------------------------------------------------------------------- refill

/**
 * The one draw loop. RULE 3 lives here: column by column (left to right), top
 * to bottom within each column, exactly one RNG draw per empty cell.
 */
function drawRefill(
  cols: number,
  rows: number,
  colours: number,
  grid: readonly Tile[],
  rngState: number,
): { grid: Tile[]; rngState: number; cells: { pos: Pos; colour: Tile }[] } {
  const next = grid.slice();
  const cells: { pos: Pos; colour: Tile }[] = [];
  let rng = rngState;
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      if ((next[idx(cols, col, row)] ?? EMPTY) !== EMPTY) continue;
      const r = rngInt(rng, colours);
      rng = r.state;
      next[idx(cols, col, row)] = r.value;
      cells.push({ pos: { col, row }, colour: r.value });
    }
  }
  return { grid: next, rngState: rng, cells };
}

/** Fills every empty cell. Refilled tiles may themselves match — that is the cascade. */
export function refill(state: BoardState): BoardResult {
  const r = drawRefill(state.cols, state.rows, state.colours, state.grid, state.rngState);
  return {
    state: { ...state, grid: r.grid, rngState: r.rngState },
    events: r.cells.length === 0 ? [] : [{ type: "refilled", depth: 0, cells: r.cells }],
  };
}

// ----------------------------------------------------------------- swap/move

function swappedGrid(state: BoardState, a: Pos, b: Pos): Tile[] {
  const grid = state.grid.slice();
  const ia = idx(state.cols, a.col, a.row);
  const ib = idx(state.cols, b.col, b.row);
  const tmp = grid[ia] ?? EMPTY;
  grid[ia] = grid[ib] ?? EMPTY;
  grid[ib] = tmp;
  return grid;
}

/**
 * Exchange two adjacent tiles. Returns null when the move is illegal or makes
 * no match — the caller must treat null as "rejected, not consumed", so a
 * fruitless swap never costs the player a move.
 *
 * `swap` draws no RNG: a rejected move must leave the seed stream untouched,
 * or two players who probe different dead ends would diverge.
 */
export function swap(
  state: BoardState,
  a: Pos,
  b: Pos,
  opts: { force?: boolean } = {},
): BoardResult | null {
  if (!inBounds(state, a) || !inBounds(state, b)) return null;
  if (!adjacent(a, b)) return null;
  const grid = swappedGrid(state, a, b);
  // `force` is Still Water: the swap happens whether or not it makes a match.
  // Bounds and adjacency still apply — a free move, not a free-for-all.
  if (!opts.force && !anyRun(state.cols, state.rows, grid)) return null;
  return { state: { ...state, grid }, events: [{ type: "swapped", a, b }] };
}

/** Is there any legal swap left? Used to detect a dead board. */
export function hasValidMove(state: BoardState): boolean {
  const g = state.grid.slice(); // private scratch: the input is never touched
  const probe = (ia: number, ib: number): boolean => {
    const tmp = g[ia] ?? EMPTY;
    g[ia] = g[ib] ?? EMPTY;
    g[ib] = tmp;
    const found = anyRun(state.cols, state.rows, g);
    g[ib] = g[ia] ?? EMPTY;
    g[ia] = tmp;
    return found;
  };
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const here = idx(state.cols, col, row);
      if (col + 1 < state.cols && probe(here, idx(state.cols, col + 1, row))) return true;
      if (row + 1 < state.rows && probe(here, idx(state.cols, col, row + 1))) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------- shuffle

/**
 * Last-resort board: diagonal stripes (no runs, since neighbours always differ
 * for colours >= 2) with a legal move planted in the top-left corner. The plain
 * diagonal has NO legal move — every swap yields pairs, never triples — so the
 * plant is load-bearing, not decoration. Pinned by test.
 */
export function fallbackGrid(cols: number, rows: number, colours: number): Tile[] {
  const grid: Tile[] = new Array<Tile>(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) grid[idx(cols, col, row)] = (col + row) % colours;
  }
  // Plant: [0,0]=[1,0]=X and [2,1]=X, with [2,0]!=X. Swapping [2,0] with [2,1]
  // completes X,X,X along row 0. Needs room and a third colour to stay
  // match-free; below that size there is nothing to guarantee.
  if (cols >= 3 && rows >= 2 && colours >= 3) {
    grid[idx(cols, 0, 0)] = 0;
    grid[idx(cols, 1, 0)] = 0;
    grid[idx(cols, 2, 1)] = 0;
  }
  return grid;
}

/** Fisher-Yates over the flat grid. Descending index order is part of the contract. */
function fisherYates(grid: readonly Tile[], rngState: number): { grid: Tile[]; rngState: number } {
  const g = grid.slice();
  let rng = rngState;
  for (let i = g.length - 1; i > 0; i--) {
    const r = rngInt(rng, i + 1);
    rng = r.state;
    const j = r.value;
    const tmp = g[i] ?? EMPTY;
    g[i] = g[j] ?? EMPTY;
    g[j] = tmp;
  }
  return { grid: g, rngState: rng };
}

/**
 * Deterministic reshuffle for a stuck board. Reshuffles the tiles already on
 * the board (so the colour mix is preserved) until the result is match-free and
 * playable, then falls back to a known-good board rather than looping.
 */
export function shuffle(state: BoardState): BoardResult {
  let rng = state.rngState;
  for (let attempt = 0; attempt < MAX_SHUFFLE_ATTEMPTS; attempt++) {
    const f = fisherYates(state.grid, rng);
    rng = f.rngState;
    const candidate: BoardState = { ...state, grid: f.grid, rngState: rng };
    if (!anyRun(state.cols, state.rows, f.grid) && hasValidMove(candidate)) {
      return { state: candidate, events: [{ type: "shuffled", reason: "stuck" }] };
    }
  }
  return {
    state: { ...state, grid: fallbackGrid(state.cols, state.rows, state.colours), rngState: rng },
    events: [{ type: "shuffled", reason: "stuck" }],
  };
}

// ------------------------------------------------------------------- resolve

/**
 * Cascade until stable: clear every run, drop, refill, repeat. Then guarantee
 * the board it hands back is playable, reshuffling if the refill dealt a dead
 * board.
 */
export function resolve(state: BoardState, fx: BoardEffects = NO_EFFECTS): BoardResult {
  const events: BoardEvent[] = [];
  let effects: BoardEffects = { ...fx };
  let cols = state.cols;
  let rows = state.rows;
  let grid = state.grid.slice();
  let rng = state.rngState;
  let depth = 0;

  for (;;) {
    const runs = findRuns(cols, rows, grid);
    if (runs.length === 0) break;
    depth++;
    if (depth > MAX_CASCADE_DEPTH) {
      events.push({ type: "cascadeAborted", depth: depth - 1 });
      break;
    }

    // Union of run cells: an L-shape shares a tile between two runs and it must
    // only be counted, cleared and scored once.
    const doomed = new Set<number>();
    for (const run of runs) for (const c of run.cells) doomed.add(idx(cols, c.col, c.row));

    // ── charm-declared extras, folded in before anything is cleared ──
    if (effects.rowOnFirstColour >= 0 && !effects.rowFired) {
      const hit = runs.find((r) => r.colour === effects.rowOnFirstColour);
      if (hit) {
        const row = hit.cells[0]!.row;
        for (let col = 0; col < cols; col++) doomed.add(idx(cols, col, row));
        effects = { ...effects, rowFired: true };
      }
    }
    if (effects.areaEveryNthMatch > 0) {
      for (const run of runs) {
        const n = effects.matchesSoFar + 1;
        effects = { ...effects, matchesSoFar: n };
        if (n % effects.areaEveryNthMatch !== 0) continue;
        const centre = run.cells[Math.floor(run.cells.length / 2)]!;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const col = centre.col + dc;
            const row = centre.row + dr;
            if (col >= 0 && row >= 0 && col < cols && row < rows) doomed.add(idx(cols, col, row));
          }
        }
      }
    } else {
      effects = { ...effects, matchesSoFar: effects.matchesSoFar + runs.length };
    }

    events.push({ type: "cascadeStep", depth, runs: runs.length, cleared: doomed.size });
    for (const run of runs) {
      events.push({
        type: "tilesCleared",
        colour: run.colour,
        size: run.cells.length,
        depth,
        cells: run.cells,
      });
    }

    for (const i of doomed) grid[i] = EMPTY;

    // Floating Petal: a long run leaves a wild where its middle tile was. Set
    // after the clear so it survives into the drop instead of being swept up
    // with the rest of the run.
    if (effects.wildFromRunSize > 0) {
      for (const run of runs) {
        if (run.cells.length < effects.wildFromRunSize) continue;
        const centre = run.cells[Math.floor(run.cells.length / 2)]!;
        grid[idx(cols, centre.col, centre.row)] = WILD;
      }
    }

    const dropped = applyGravity(cols, rows, grid);
    grid = dropped.grid;
    if (dropped.moves.length > 0) events.push({ type: "tilesFell", depth, moves: dropped.moves });

    const filled = drawRefill(cols, rows, state.colours, grid, rng);
    grid = filled.grid;
    rng = filled.rngState;
    if (filled.cells.length > 0) events.push({ type: "refilled", depth, cells: filled.cells });
  }

  let next: BoardState = { cols, rows, colours: state.colours, grid, rngState: rng };
  if (!hasValidMove(next)) {
    const s = shuffle(next);
    next = s.state;
    events.push(...s.events);
  }
  return { state: next, events, effects };
}

/**
 * Clear a chosen set of cells, then settle the board. The one primitive the
 * charm-driven effects need outside a cascade (Skimmer). Cells that are already
 * empty are ignored, so the caller does not have to know what is where.
 */
export function clearCells(state: BoardState, cells: readonly Pos[]): BoardResult {
  const grid = state.grid.slice();
  const hit: Pos[] = [];
  for (const c of cells) {
    const i = idx(state.cols, c.col, c.row);
    if ((grid[i] ?? EMPTY) === EMPTY) continue;
    grid[i] = EMPTY;
    hit.push(c);
  }
  if (hit.length === 0) return { state, events: [] };

  const events: BoardEvent[] = [{ type: "cascadeStep", depth: 1, runs: 0, cleared: hit.length }];
  const dropped = applyGravity(state.cols, state.rows, grid);
  if (dropped.moves.length > 0) events.push({ type: "tilesFell", depth: 1, moves: dropped.moves });

  const filled = drawRefill(state.cols, state.rows, state.colours, dropped.grid, state.rngState);
  if (filled.cells.length > 0) events.push({ type: "refilled", depth: 1, cells: filled.cells });

  return { state: { ...state, grid: filled.grid, rngState: filled.rngState }, events };
}

/** Every cell currently holding a given colour. */
export function cellsOfColour(state: BoardState, colour: Tile): Pos[] {
  const out: Pos[] = [];
  for (let i = 0; i < state.grid.length; i++) {
    if (state.grid[i] === colour) out.push({ col: i % state.cols, row: Math.floor(i / state.cols) });
  }
  return out;
}

// ---------------------------------------------------------------- generation

/**
 * A fresh board with no pre-existing match and at least one legal move.
 *
 * Cells are filled in the SAME order as a refill (column by column, top to
 * bottom) so there is one draw order in the whole engine, and each cell picks
 * uniformly from the colours that would not complete a run. Picking from the
 * allowed set costs exactly one draw per cell — rejection sampling would
 * terminate too, but its draw count would depend on the board, which makes
 * reasoning about the seed stream much harder.
 */
export function createBoard(opts: {
  seed: number;
  cols?: number;
  rows?: number;
  colours?: number;
}): BoardState {
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;
  const colours = opts.colours ?? DEFAULT_COLOURS;
  let rng = opts.seed;

  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const grid: Tile[] = new Array<Tile>(cols * rows).fill(EMPTY);
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        // At most one colour is blocked per axis, so with 3+ colours the
        // allowed set is never empty.
        const left2 = tileAt(grid, cols, col - 1, row);
        const blockedH = left2 !== EMPTY && left2 === tileAt(grid, cols, col - 2, row) ? left2 : EMPTY;
        const up1 = tileAt(grid, cols, col, row - 1);
        const blockedV = up1 !== EMPTY && up1 === tileAt(grid, cols, col, row - 2) ? up1 : EMPTY;
        const allowed: Tile[] = [];
        for (let c = 0; c < colours; c++) if (c !== blockedH && c !== blockedV) allowed.push(c);
        const pool = allowed.length > 0 ? allowed : [0];
        const r = rngInt(rng, pool.length);
        rng = r.state;
        grid[idx(cols, col, row)] = pool[r.value] ?? 0;
      }
    }
    const candidate: BoardState = { cols, rows, colours, grid, rngState: rng };
    if (hasValidMove(candidate)) return candidate;
  }
  return { cols, rows, colours, grid: fallbackGrid(cols, rows, colours), rngState: rng };
}

// ---------------------------------------------------------------- validation

/**
 * Validator for `save.ts`. A board is either structurally intact or it is not —
 * a grid with the wrong length or an out-of-range tile cannot be repaired into
 * a fair board, so it is rejected and the caller starts fresh. Only `rngState`
 * is repaired, because JSON can widen an int32 and the engine coerces anyway.
 */
export function validateBoard(raw: unknown): BoardState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const int = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

  if (!int(s["cols"]) || !int(s["rows"]) || !int(s["colours"])) return null;
  const cols = s["cols"] as number;
  const rows = s["rows"] as number;
  const colours = s["colours"] as number;
  if (cols < 1 || rows < 1 || colours < 1 || colours > TILE_COLOURS.length) return null;
  if (cols > 32 || rows > 32) return null; // nothing legitimate is this big

  const rawGrid = s["grid"];
  if (!Array.isArray(rawGrid) || rawGrid.length !== cols * rows) return null;
  const grid: Tile[] = [];
  for (const t of rawGrid) {
    // WILD is a legitimate saved tile once Floating Petal has placed one.
    if (!int(t) || (t !== WILD && (t < 0 || t >= colours))) return null;
    grid.push(t);
  }

  const rngState = s["rngState"];
  if (typeof rngState !== "number" || !Number.isFinite(rngState)) return null;

  return { cols, rows, colours, grid, rngState: rngState | 0 };
}
