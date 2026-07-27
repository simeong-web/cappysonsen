/**
 * The Pixi board.
 *
 * SUBSCRIBES, COMPUTES NOTHING. It is handed the event array a move produced
 * and replays it as animation; it never asks the sim what a match is worth,
 * never decides whether a swap was legal, and never touches the grid except to
 * mirror what the events said happened. The final `syncTo` is a safety net that
 * asserts the animation landed on the same grid the sim did — if the two ever
 * disagree, that is a renderer bug and it self-corrects rather than drifting.
 */
import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import { WILD, type BoardEvent, type BoardState, type Pos } from "../src/board";
import { COLOURS, LAYOUT, TIMING, depthScale } from "./theme";
import { animate, easeBack, easeInOut, easeLand, easeOut, moveTo, wait } from "./tween";
import type { TileArt } from "./tiles";

interface TileSprite extends Sprite {
  /** Identity survives falls and swaps, so a tile animates as one object. */
  tileId: number;
}

export type SwapRequest = (a: Pos, b: Pos) => void;

export class BoardView extends Container {
  private readonly well = new Graphics();
  private readonly tileLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly selectionRing = new Graphics();

  /** id -> sprite. */
  private sprites = new Map<number, TileSprite>();
  /** Grid position -> tile id, mirroring the sim's grid. */
  private ids: (number | null)[] = [];
  private nextId = 1;

  private cols = 7;
  private rows = 7;
  private cell = 48;

  private selected: Pos | null = null;
  private busy = false;

  constructor(
    private readonly art: TileArt[],
    private readonly wild: TileArt,
    private readonly spark: Texture,
    private readonly onSwap: SwapRequest,
  ) {
    super();
    this.addChild(this.well, this.tileLayer, this.selectionRing, this.fxLayer);
    this.eventMode = "static";
    this.on("pointerdown", this.onPointerDown);
    this.on("pointerup", this.onPointerUp);
    this.on("pointerupoutside", () => (this.dragFrom = null));
  }

  /** True while an animation is running — input is ignored until it settles. */
  get isBusy(): boolean {
    return this.busy;
  }

  // ─────────────────────────────────────────────────────────── layout

  /**
   * Fit the board into a width AND a height budget.
   *
   * Width alone is not enough: on a short, wide window (a desktop browser, a
   * phone in landscape) a width-sized board pushes the HUD off the top and the
   * charm strip off the bottom. Taking the smaller of the two budgets means the
   * whole column always fits and nothing has to be scaled after the fact.
   */
  resize(width: number, board: BoardState, maxHeight = Infinity): void {
    this.cols = board.cols;
    this.rows = board.rows;
    const fromWidth = (width - LAYOUT.tileGap * (board.cols - 1)) / board.cols;
    const fromHeight = (maxHeight - LAYOUT.tileGap * (board.rows - 1)) / board.rows;
    this.cell = Math.max(16, Math.floor(Math.min(fromWidth, fromHeight)));
    const w = this.boardWidth();
    const h = this.boardHeight();

    this.well.clear();
    this.well.roundRect(-6, -6, w + 12, h + 12, 18).fill({ color: COLOURS.boardWell, alpha: 0.55 });
    this.well.roundRect(-6, -6, w + 12, h + 12, 18).stroke({ width: 3, color: 0x0d2029, alpha: 0.5 });

    for (const [id, sprite] of this.sprites) {
      const at = this.findId(id);
      if (at) this.place(sprite, at);
    }
    this.drawSelection();
  }

  boardWidth(): number {
    return this.cols * this.cell + LAYOUT.tileGap * (this.cols - 1);
  }

  boardHeight(): number {
    return this.rows * this.cell + LAYOUT.tileGap * (this.rows - 1);
  }

  private xy(pos: Pos): { x: number; y: number } {
    return {
      x: pos.col * (this.cell + LAYOUT.tileGap) + this.cell / 2,
      y: pos.row * (this.cell + LAYOUT.tileGap) + this.cell / 2,
    };
  }

  private place(sprite: Sprite, pos: Pos): void {
    const p = this.xy(pos);
    sprite.x = p.x;
    sprite.y = p.y;
    sprite.width = this.cell;
    sprite.height = this.cell;
  }

  private index(pos: Pos): number {
    return pos.row * this.cols + pos.col;
  }

  /** WILD is negative, so it cannot index the colour array directly. */
  private artFor(colour: number): TileArt {
    if (colour === WILD) return this.wild;
    return this.art[colour] ?? this.art[0]!;
  }

  /** Screen coordinates of a cell's centre. Used for hints and by tests. */
  globalOf(pos: Pos): { x: number; y: number } {
    return this.toGlobal(this.xy(pos));
  }

  private findId(id: number): Pos | null {
    const i = this.ids.indexOf(id);
    return i < 0 ? null : { col: i % this.cols, row: Math.floor(i / this.cols) };
  }

  // ─────────────────────────────────────────────────────────── building

  /** Hard reset to a board state, no animation. Used on new runs and resize. */
  syncTo(board: BoardState): void {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.tileLayer.removeChildren();
    this.cols = board.cols;
    this.rows = board.rows;
    this.ids = new Array<number | null>(board.grid.length).fill(null);

    for (let i = 0; i < board.grid.length; i++) {
      const colour = board.grid[i] ?? 0;
      const pos = { col: i % board.cols, row: Math.floor(i / board.cols) };
      const sprite = this.makeSprite(colour, pos);
      this.ids[i] = sprite.tileId;
    }
    this.selected = null;
    this.drawSelection();
  }

  private makeSprite(colour: number, pos: Pos): TileSprite {
    const art = this.artFor(colour);
    const sprite = new Sprite(art.texture) as TileSprite;
    sprite.anchor.set(0.5);
    sprite.tileId = this.nextId++;
    this.place(sprite, pos);
    this.tileLayer.addChild(sprite);
    this.sprites.set(sprite.tileId, sprite);
    return sprite;
  }

  // ─────────────────────────────────────────────────────────── input

  private dragFrom: Pos | null = null;

  private hit(global: { x: number; y: number }): Pos | null {
    const local = this.toLocal(global);
    const span = this.cell + LAYOUT.tileGap;
    const col = Math.floor(local.x / span);
    const row = Math.floor(local.y / span);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    return { col, row };
  }

  private onPointerDown = (e: { global: { x: number; y: number } }): void => {
    if (this.busy) return;
    this.dragFrom = this.hit(e.global);
  };

  /**
   * One gesture handles both idioms: a drag from one tile toward a neighbour,
   * and tap-then-tap. Phones get the drag they expect; a mis-swipe that lands
   * on the same tile falls back to selection instead of doing nothing.
   */
  private onPointerUp = (e: { global: { x: number; y: number } }): void => {
    if (this.busy) return;
    const up = this.hit(e.global);
    const down = this.dragFrom;
    this.dragFrom = null;
    if (!up) return;

    if (down && !samePos(down, up) && adjacent(down, up)) {
      this.selected = null;
      this.drawSelection();
      this.onSwap(down, up);
      return;
    }
    if (this.selected && adjacent(this.selected, up)) {
      const from = this.selected;
      this.selected = null;
      this.drawSelection();
      this.onSwap(from, up);
      return;
    }
    this.selected = this.selected && samePos(this.selected, up) ? null : up;
    this.drawSelection();
  };

  private drawSelection(): void {
    this.selectionRing.clear();
    if (!this.selected) return;
    const p = this.xy(this.selected);
    const r = this.cell / 2 + 3;
    this.selectionRing
      .roundRect(p.x - r, p.y - r, r * 2, r * 2, 12)
      .stroke({ width: 3, color: COLOURS.selection, alpha: 0.9 });
  }

  // ─────────────────────────────────────────────────────────── animation

  /** A swap the sim refused: go out and come back, so the board feels alive. */
  async rejectSwap(a: Pos, b: Pos): Promise<void> {
    const idA = this.ids[this.index(a)];
    const idB = this.ids[this.index(b)];
    const sa = idA === null || idA === undefined ? null : this.sprites.get(idA);
    const sb = idB === null || idB === undefined ? null : this.sprites.get(idB);
    if (!sa || !sb) return;

    this.busy = true;
    const pa = this.xy(a);
    const pb = this.xy(b);
    const nudge = 0.42; // part-way, then back — reads as "that won't go"
    await Promise.all([
      moveTo(sa, lerp(pa, pb, nudge), TIMING.swap, easeOut),
      moveTo(sb, lerp(pb, pa, nudge), TIMING.swap, easeOut),
    ]);
    await Promise.all([
      moveTo(sa, pa, TIMING.swapBack, easeBack),
      moveTo(sb, pb, TIMING.swapBack, easeBack),
    ]);
    this.busy = false;
  }

  /**
   * Replay a move's events as animation, then reconcile against the sim's
   * final grid.
   */
  async play(events: readonly BoardEvent[], final: BoardState): Promise<void> {
    this.busy = true;
    try {
      for (const event of events) {
        switch (event.type) {
          case "swapped":
            await this.animateSwap(event.a, event.b);
            break;
          case "tilesCleared":
            // Every run at this depth pops together; the cascadeStep that
            // precedes them has already set the pace.
            await this.animateClear(event.cells, event.colour, event.depth, event.size);
            break;
          case "tilesFell":
            await this.animateFall(event.moves, event.depth);
            break;
          case "refilled":
            await this.animateRefill(event.cells, event.depth);
            break;
          case "shuffled":
            await this.animateShuffle(final);
            break;
          default:
            break; // cascadeStep and cascadeAborted carry no visual of their own
        }
      }
    } finally {
      this.reconcile(final);
      this.busy = false;
    }
  }

  private async animateSwap(a: Pos, b: Pos): Promise<void> {
    const ia = this.index(a);
    const ib = this.index(b);
    const idA = this.ids[ia] ?? null;
    const idB = this.ids[ib] ?? null;
    this.ids[ia] = idB;
    this.ids[ib] = idA;

    const sa = idA === null ? null : this.sprites.get(idA);
    const sb = idB === null ? null : this.sprites.get(idB);
    const moves: Promise<void>[] = [];
    if (sa) moves.push(moveTo(sa, this.xy(b), TIMING.swap, easeInOut));
    if (sb) moves.push(moveTo(sb, this.xy(a), TIMING.swap, easeInOut));
    await Promise.all(moves);
  }

  private async animateClear(
    cells: readonly Pos[],
    colour: number,
    depth: number,
    size: number,
  ): Promise<void> {
    const scale = depthScale(depth);
    const ms = Math.max(TIMING.popMin, TIMING.pop * scale);
    const accent = this.artFor(colour).accent;

    const popped: TileSprite[] = [];
    for (const cell of cells) {
      const i = this.index(cell);
      const id = this.ids[i];
      if (id === null || id === undefined) continue; // shared by an L — already popping
      const sprite = this.sprites.get(id);
      this.ids[i] = null;
      if (!sprite) continue;
      this.sprites.delete(id);
      popped.push(sprite);
      this.burst(sprite.x, sprite.y, accent, depth, size);
    }
    if (popped.length === 0) return;

    await animate(
      ms,
      (t) => {
        for (const sprite of popped) {
          // swell, then vanish — the swell is what makes a clear feel earned
          const s = t < 0.35 ? 1 + t * 0.9 : 1.315 * (1 - (t - 0.35) / 0.65);
          sprite.width = this.cell * Math.max(0, s);
          sprite.height = this.cell * Math.max(0, s);
          sprite.alpha = 1 - t * t;
        }
      },
      easeOut,
    );
    for (const sprite of popped) sprite.destroy();
  }

  /** Deeper chains throw more, and brighter. */
  private burst(x: number, y: number, tint: number, depth: number, size: number): void {
    const count = Math.min(14, 4 + depth * 2 + Math.max(0, size - 3) * 2);
    for (let i = 0; i < count; i++) {
      const p = new Sprite(this.spark);
      p.anchor.set(0.5);
      p.tint = tint;
      p.x = x;
      p.y = y;
      const r = this.cell * (0.22 + 0.06 * depth);
      p.width = p.height = r * 0.42;
      this.fxLayer.addChild(p);

      const a = (i / count) * Math.PI * 2 + depth;
      const dist = r * (1.1 + (i % 3) * 0.32);
      const ms = 260 + depth * 40;
      void animate(
        ms,
        (t) => {
          p.x = x + Math.cos(a) * dist * t;
          p.y = y + Math.sin(a) * dist * t + t * t * this.cell * 0.5;
          p.alpha = 1 - t;
          p.scale.set((1 - t * 0.6) * (r * 0.42) / 32);
        },
        easeOut,
      ).then(() => p.destroy());
    }
  }

  private async animateFall(
    moves: readonly { from: Pos; to: Pos }[],
    depth: number,
  ): Promise<void> {
    if (moves.length === 0) return;
    const scale = depthScale(depth);
    const ms = Math.max(TIMING.fallMin, TIMING.fall * scale);

    // Apply every id move first: reading and writing the grid in one pass would
    // let an earlier move clobber a later one's source.
    const moved: { sprite: TileSprite; to: Pos }[] = [];
    const lifted = new Map<number, number | null>();
    for (const m of moves) lifted.set(this.index(m.from), this.ids[this.index(m.from)] ?? null);
    for (const m of moves) this.ids[this.index(m.from)] = null;
    for (const m of moves) {
      const id = lifted.get(this.index(m.from)) ?? null;
      this.ids[this.index(m.to)] = id;
      const sprite = id === null ? null : this.sprites.get(id);
      if (sprite) moved.push({ sprite, to: m.to });
    }

    await Promise.all(
      moved.map(({ sprite, to }) => moveTo(sprite, this.xy(to), ms, easeLand)),
    );
    await this.squash(moved.map((m) => m.sprite), ms * 0.35);
  }

  /** Squash on land. The single cheapest thing that makes a board feel good. */
  private async squash(sprites: TileSprite[], ms: number): Promise<void> {
    if (sprites.length === 0) return;
    await animate(
      ms,
      (t) => {
        const k = Math.sin(t * Math.PI) * 0.14;
        for (const s of sprites) {
          s.width = this.cell * (1 + k);
          s.height = this.cell * (1 - k);
        }
      },
      easeOut,
    );
    for (const s of sprites) {
      s.width = this.cell;
      s.height = this.cell;
    }
  }

  private async animateRefill(
    cells: readonly { pos: Pos; colour: number }[],
    depth: number,
  ): Promise<void> {
    if (cells.length === 0) return;
    const scale = depthScale(depth);
    const ms = Math.max(TIMING.fallMin, TIMING.fall * scale);

    const dropped: TileSprite[] = [];
    for (const { pos, colour } of cells) {
      const sprite = this.makeSprite(colour, pos);
      // enter from just above the well, offset by row so a column staggers
      sprite.y = -this.cell * (1.2 + (this.rows - pos.row) * 0.35);
      this.ids[this.index(pos)] = sprite.tileId;
      dropped.push(sprite);
    }
    await Promise.all(
      cells.map((c, i) => moveTo(dropped[i]!, this.xy(c.pos), ms, easeLand)),
    );
    await this.squash(dropped, ms * 0.35);
    await wait(Math.max(TIMING.stepGapMin, TIMING.stepGap * scale));
  }

  private async animateShuffle(final: BoardState): Promise<void> {
    await animate(220, (t) => {
      this.tileLayer.alpha = 1 - t;
      this.tileLayer.y = t * 8;
    });
    this.syncTo(final);
    this.tileLayer.y = 0;
    await animate(220, (t) => (this.tileLayer.alpha = t));
  }

  /**
   * Make the view match the sim exactly. The animation above should already
   * have got here; this closes any gap rather than letting one compound.
   */
  private reconcile(board: BoardState): void {
    let drifted = false;
    for (let i = 0; i < board.grid.length; i++) {
      const id = this.ids[i];
      const sprite = id === null || id === undefined ? null : this.sprites.get(id);
      const want = board.grid[i] ?? 0;
      if (!sprite || sprite.texture !== this.artFor(want).texture) {
        drifted = true;
        break;
      }
    }
    if (drifted) {
      this.syncTo(board);
      return;
    }
    for (let i = 0; i < board.grid.length; i++) {
      const id = this.ids[i];
      const sprite = id === null || id === undefined ? null : this.sprites.get(id);
      if (sprite) this.place(sprite, { col: i % board.cols, row: Math.floor(i / board.cols) });
    }
  }

  clearSelection(): void {
    this.selected = null;
    this.drawSelection();
  }
}

const samePos = (a: Pos, b: Pos): boolean => a.col === b.col && a.row === b.row;
const adjacent = (a: Pos, b: Pos): boolean =>
  Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;
const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
