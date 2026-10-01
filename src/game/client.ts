/**
 * Cappy's Onsen — Pixi client.
 *
 * Mobile-first and portrait: the board takes the width it can get, the HUD sits
 * above it and the counters below, and nothing interactive is smaller than a
 * thumb. Half the traffic is phones (SPEC §5).
 *
 * The renderer owns no game logic. It holds a RunState, hands moves to the sim,
 * and paints what comes back — score included. Anything it had to work out for
 * itself would be a second implementation of the rules, and the two would drift.
 *
 * NOTHING HERE RUNS ON IMPORT. The host owns when a game starts and what it
 * starts with, so the whole client is behind `startClient`, which the host's
 * boot message calls with the player's saved progress. Opening a run at import
 * time would mean throwing it away a moment later when the save landed.
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { DEFAULT_CONFIG as cfg, isLongSoak, roundTarget } from "../sim/config";
import { CHARMS, type CharmId } from "../sim/charms";
import { blissOf } from "../sim/scoring";
import {
  chooseCharm,
  currentRoundScore,
  newRun,
  playMove,
  rerollOffer,
  shareTextFor,
  type RunMode,
  type RunState,
} from "../sim/run";
import { dailyNumberOf, dateKeyOfDaily, seedOfDaily } from "../sim/daily";
import {
  DECOR,
  DECOR_IDS,
  canUnlockCharm,
  canUnlockDecor,
  chooseDecor,
  collection,
  petalsFor,
  poolFor,
  recordRun,
  unlockCharm,
  unlockDecor,
  type MetaState,
} from "../sim/meta";
import { reviveWithMoves } from "../sim/run";
import { swap, type Pos } from "../sim/board";
import type { BootContext, Host, RewardPlacement } from "../platform/host";
import { copyText } from "./clipboard";
import { loadHostSave, toHostSave, type Progress } from "./progress";

import { COLOURS, LAYOUT, textStyle } from "./theme";
import { buildSparkTexture, buildTileArt, buildWildArt, type TileArt } from "./tiles";
import { BoardView } from "./board-view";
import {
  Button,
  CharmCard,
  Counter,
  ProgressBar,
  CARD_ASPECT,
  cardHeightFor,
  loadChrome,
  stretched,
  type ChromeTextures,
} from "./chrome";
import { animate, easeOut, useTicker } from "./tween";

/** Moves granted by the "+5 moves" rewarded slot (SPEC §6). */
const AD_EXTRA_MOVES = 5;

/** Just under the SDK's score ceiling, which rejects `>= 1e9` outright. */
const MAX_REPORTED_SCORE = 999_999_999;

/**
 * Build-time switch for the automation handle below. Off in every build unless
 * `DEV_HANDLE=1` is set; while it is off, the one branch that reads it compiles
 * to `if (false)`. It replaces Vite's `import.meta.env.DEV`, which esbuild does
 * not provide.
 */
declare const DEV_HANDLE: boolean;

class Game {
  private state: RunState;
  private readonly root = new Container();
  private readonly bg = new Graphics();
  private readonly hudLayer = new Container();
  private readonly boardLayer = new Container();
  private readonly boardRim = new Graphics();
  private readonly overlayLayer = new Container();

  private board!: BoardView;
  private progress = new ProgressBar();
  private warmth = new Counter("WARMTH", COLOURS.warmth);
  private bliss = new Counter("BLISS", COLOURS.bliss, 2);
  private moves = new Counter("MOVES", COLOURS.ink);
  private roundLabel!: Text;
  private soakLabel!: Text;
  private hudPanel!: Container;
  private footerPanel!: Container;
  private buildPanel!: Container;
  private buildText!: Text;

  private width = 390;
  private height = 780;
  private scale = 1;
  private mode: RunMode = "endless";
  private dailyN = 0;
  private readonly todayN: number;
  private meta: MetaState;

  constructor(
    private readonly app: Application,
    private readonly tex: ChromeTextures,
    art: TileArt[],
    wild: TileArt,
    spark: ReturnType<typeof buildSparkTexture>,
    private readonly host: Host,
    private saved: Progress,
  ) {
    // Date.now() is fine here — src/sim stays clock-free, the client supplies now.
    this.todayN = dailyNumberOf(cfg.daily, Date.now());
    this.meta = saved.meta;
    this.state = newRun(cfg, seedOfDaily(cfg.daily, this.todayN), "daily");
    this.board = new BoardView(art, wild, spark, (a, b) => void this.attempt(a, b));
    this.buildHud();

    this.root.addChild(this.bg, this.boardLayer, this.hudLayer, this.overlayLayer);
    this.boardLayer.addChild(this.boardRim, this.board);
    app.stage.addChild(this.root);

    this.board.syncTo(this.state.board);
    this.layout();
    this.refresh(true);

    // Always the menu. The `?daily=N` deep link that used to route past it
    // existed for the /daily/N permalink pages, which this build does not have;
    // see docs/PORTING.md.
    this.showMenu();

    app.ticker.add(() => {
      this.warmth.tick();
      this.bliss.tick();
      this.moves.tick();
    });
    window.addEventListener("resize", () => this.layout());
  }

  // ─────────────────────────────────────────────────── modes and saving

  /**
   * Open a daily. If a stored run for the SAME puzzle number exists it is
   * resumed — including a finished one, which is what enforces one run per
   * day. A record for any other number is last week's puzzle and is discarded.
   */
  private startDaily(n: number): void {
    const saved = this.saved.daily;
    this.mode = "daily";
    this.dailyN = n;
    this.state =
      saved !== null && saved.dailyNumber === n
        ? saved.run
        : newRun(cfg, seedOfDaily(cfg.daily, n), "daily", poolFor(this.meta));
    this.afterStart();
    if (this.state.phase === "over") this.showRunEnd();
    else if (this.state.phase === "drafting") this.showDraft();
  }

  /** Endless resumes too, but a finished endless run just rolls into a new one. */
  private startEndless(fresh = false): void {
    const saved = fresh ? null : this.saved.endless;
    this.mode = "endless";
    this.dailyN = 0;
    this.state =
      saved !== null && saved.run.phase !== "over"
        ? saved.run
        : newRun(cfg, Math.floor(Math.random() * 2 ** 31), "endless", poolFor(this.meta));
    this.afterStart();
    if (this.state.phase === "drafting") this.showDraft();
  }

  private afterStart(): void {
    this.clearOverlay();
    this.board.syncTo(this.state.board);
    this.board.clearSelection();
    this.layout();
    this.refresh(true);
    this.persist();
  }

  /**
   * Bank the run's petals. `lastAwarded` guards the one case that would
   * duplicate them: a finished run reloaded from storage re-enters showRunEnd.
   */
  private awardPetals(multiplier = 1): void {
    const key = this.state.seed + ":" + this.state.round + ":" + multiplier;
    if (this.awardedFor === key) return;
    this.awardedFor = key;
    this.lastPetals = Math.floor(petalsFor(this.state) * multiplier);
    this.saveMeta(recordRun(this.meta, this.state, multiplier));
  }

  /** Written after every move, so a closed tab is never a lost daily. */
  private persist(): void {
    if (this.mode === "daily") {
      this.saved = { ...this.saved, daily: { dailyNumber: this.dailyN, run: this.state } };
    } else {
      this.saved = { ...this.saved, endless: { run: this.state } };
    }
    this.sendProgress();
  }

  /** Petals, unlocks, décor — the record that outlives any one run. */
  private saveMeta(meta: MetaState): void {
    this.meta = meta;
    this.saved = { ...this.saved, meta };
    this.sendProgress();
  }

  /**
   * One value, handed to the host whole. What used to be three localStorage
   * keys is three fields of it now — see `progress.ts`.
   */
  private sendProgress(): void {
    this.host.saveProgress(toHostSave(this.saved, Date.now()));
  }

  // ───────────────────────────────────────────────────────── chrome

  private buildHud(): void {
    this.hudPanel = new Container();
    this.footerPanel = new Container();

    this.roundLabel = new Text({ text: "Round 1", style: textStyle(20, COLOURS.ink, "800") });
    this.soakLabel = new Text({ text: "LONG SOAK", style: textStyle(11, COLOURS.bad, "800") });
    this.soakLabel.visible = false;

    this.hudPanel.addChild(this.roundLabel, this.soakLabel, this.progress);
    this.footerPanel.addChild(this.warmth, this.bliss, this.moves);

    // Your build, always visible. A roguelike where you cannot see what you
    // have built is just a match-3 with extra steps.
    this.buildPanel = new Container();
    this.buildText = new Text({
      text: "No charms yet",
      style: { ...textStyle(12, COLOURS.inkSoft, "600"), align: "center", lineHeight: 16 },
    });
    this.buildText.anchor.set(0.5, 0);
    this.buildPanel.addChild(this.buildText);

    this.hudLayer.addChild(this.hudPanel, this.footerPanel, this.buildPanel);
  }

  // ───────────────────────────────────────────────────────── layout

  private layout(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.app.renderer.resize(vw, vh);

    const safe = readSafeArea();
    this.width = Math.min(LAYOUT.maxWidth, vw - safe.left - safe.right);
    this.height = vh - safe.top - safe.bottom;

    // Warm sky at the top easing into the water below, banded rather than a
    // real gradient so it costs one Graphics and no shader. The ramp comes from
    // the equipped décor — cosmetic only, never a number the sim can see.
    const palette = DECOR[this.meta.activeDecor].palette;
    this.bg.clear();
    const bands = 48;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      this.bg.rect(0, (vh * i) / bands, vw, vh / bands + 1).fill({ color: skyAt(t, palette) });
    }
    // A few soft steam blooms so the water is not a flat wash.
    for (const [fx, fy, fr, fa] of STEAM) {
      this.bg.circle(vw * fx, vh * fy, Math.max(vw, vh) * fr).fill({ color: COLOURS.steam, alpha: fa });
    }

    const left = safe.left + (vw - safe.left - safe.right - this.width) / 2;
    this.root.x = left;
    this.root.y = safe.top;
    this.bg.x = -left;
    this.bg.y = -safe.top;

    const inner = this.width - LAYOUT.gutter * 2;

    // ── HUD ──
    if (this.hudPanel.children.length === 3) {
      this.hudPanel.addChildAt(stretched(this.tex.bar, inner, LAYOUT.hudHeight), 0);
    } else {
      const p = this.hudPanel.children[0] as { width: number; height: number };
      p.width = inner;
      p.height = LAYOUT.hudHeight;
    }
    this.hudPanel.x = LAYOUT.gutter;
    this.roundLabel.x = 22;
    this.roundLabel.y = LAYOUT.barPadTop + 2;
    this.soakLabel.anchor.set(1, 0);
    this.soakLabel.x = inner - 22;
    this.soakLabel.y = LAYOUT.barPadTop + 9;
    this.progress.resize(inner - 44);
    this.progress.x = 22;
    this.progress.y = LAYOUT.hudHeight - LAYOUT.barPadBottom - 26;

    // ── build strip height first: the board's budget depends on it ──
    this.buildText.style.wordWrap = true;
    this.buildText.style.wordWrapWidth = inner - 48;
    this.buildText.x = inner / 2;
    const buildH = Math.max(
      LAYOUT.buildHeight,
      this.buildText.height + LAYOUT.barPadTop + LAYOUT.barPadBottom + 8,
    );
    this.buildText.y = (buildH - LAYOUT.barPadBottom + LAYOUT.barPadTop) / 2 - this.buildText.height / 2;

    // ── board: the smaller of what the width allows and what is left over
    //    vertically once the three bars have taken their share ──
    const chromeH = LAYOUT.hudHeight + 12 + 12 + LAYOUT.footerHeight + 10 + buildH;
    this.board.resize(inner, this.state.board, Math.max(80, this.height - chromeH - 8));
    const boardH = this.board.boardHeight();
    const boardW = this.board.boardWidth();
    // Centre the board when the height budget made it narrower than the column.
    this.boardLayer.x = LAYOUT.gutter + (inner - boardW) / 2;

    // Wooden rim around the water, so the tub belongs to the same set as the bars.
    const rimPad = 10;
    this.boardRim.clear();
    this.boardRim
      .roundRect(-rimPad, -rimPad, boardW + rimPad * 2, boardH + rimPad * 2 + 4, 24)
      .fill(COLOURS.boardRimDark);
    this.boardRim
      .roundRect(-rimPad, -rimPad, boardW + rimPad * 2, boardH + rimPad * 2, 24)
      .fill(DECOR[this.meta.activeDecor].rim);
    this.boardRim
      .roundRect(-rimPad + 6, -rimPad + 6, boardW + rimPad * 2 - 12, boardH + rimPad * 2 - 12, 18)
      .fill(COLOURS.boardWell);

    // ── footer ──
    if (this.footerPanel.children.length === 3) {
      this.footerPanel.addChildAt(stretched(this.tex.bar, inner, LAYOUT.footerHeight), 0);
    } else {
      const p = this.footerPanel.children[0] as { width: number; height: number };
      p.width = inner;
      p.height = LAYOUT.footerHeight;
    }
    this.footerPanel.x = LAYOUT.gutter;

    // ── build strip ──
    if (this.buildPanel.children.length === 1) {
      this.buildPanel.addChildAt(stretched(this.tex.bar, inner, buildH), 0);
    } else {
      const p = this.buildPanel.children[0] as { width: number; height: number };
      p.width = inner;
      p.height = buildH;
    }
    this.buildPanel.x = LAYOUT.gutter;

    // Vertical stack, centred in whatever height the phone gives us.
    const stack = LAYOUT.hudHeight + 12 + boardH + 12 + LAYOUT.footerHeight + 10 + buildH;
    const top = Math.max(0, (this.height - stack) / 2);
    this.hudPanel.y = top;
    this.boardLayer.y = top + LAYOUT.hudHeight + 12;
    this.footerPanel.y = this.boardLayer.y + boardH + 12;
    this.buildPanel.y = this.footerPanel.y + LAYOUT.footerHeight + 10;

    const third = inner / 3;
    this.warmth.x = third * 0.5;
    this.bliss.x = third * 1.5;
    this.moves.x = third * 2.5;
    this.warmth.y = this.bliss.y = this.moves.y = LAYOUT.barPadTop + 4;

    // No global scaling: the board was fitted to the height budget above, so
    // the column cannot overflow and the overlays can trust `this.height`.
    this.scale = 1;
    this.root.scale.set(1);

    this.layoutOverlay();
  }

  // ───────────────────────────────────────────────────────── state → view

  private refresh(immediate = false): void {
    const target = roundTarget(cfg, this.state.round);
    const score = currentRoundScore(cfg, this.state);

    this.roundLabel.text = `Round ${this.state.round}`;
    this.soakLabel.visible = isLongSoak(cfg, this.state.round);
    this.progress.set(score, target);

    this.buildText.text = this.state.charms.length
      ? this.state.charms.map((c) => CHARMS[c].name).join(" · ")
      : "No charms yet — clear the round to draft one";

    const set = (c: Counter, v: number): void => (immediate ? c.setImmediate(v) : c.set(v));
    set(this.warmth, this.state.score.warmth);
    set(this.bliss, blissOf(this.state.score));
    set(this.moves, this.state.moveBudget - this.state.movesUsed);
  }

  // ───────────────────────────────────────────────────────── play

  private async attempt(a: Pos, b: Pos): Promise<void> {
    if (this.board.isBusy || this.state.phase !== "playing") return;
    const played = playMove(cfg, this.state, a, b);
    if (!played) {
      await this.board.rejectSwap(a, b);
      return;
    }
    this.state = played.state;
    this.refresh();
    await this.board.play(played.events, this.state.board);
    this.refresh();
    this.persist();

    if (this.state.phase === "drafting") {
      this.showDraft();
    } else if (this.state.phase === "over") {
      this.awardPetals();
      this.reportRunScore();
      this.showRunEnd();
    }
  }

  /**
   * The one number the host wants from a finished run: the warmth banked
   * across every round.
   *
   * Reported here — where a move ends a run — and nowhere else, so a finished
   * daily reopened from the save (which goes straight to the run-end panel)
   * cannot report the same run twice. Rounded because the host wants a plain
   * number, and capped below the SDK's plausibility ceiling (1e9, which it
   * rejects rather than clamps) so a monster endless run still lands as a
   * score instead of vanishing.
   */
  private reportRunScore(): void {
    const score = Math.max(0, Math.round(this.state.totalScore));
    this.host.reportScore(Math.min(score, MAX_REPORTED_SCORE));
  }

  // ───────────────────────────────────────────────────────── overlays

  private overlay: Container | null = null;
  private draftCards: CharmCard[] = [];
  private menuButtons: Button[] = [];
  private lastShareText = "";
  private awardedFor = "";
  private lastPetals = 0;
  private revivedThisRun = false;
  private doubledThisRun = false;

  private clearOverlay(): void {
    this.overlay?.destroy({ children: true });
    this.overlay = null;
  }

  private layoutOverlay(): void {
    if (!this.overlay) return;
    const scrim = this.overlay.children[0] as Graphics | undefined;
    scrim?.clear().rect(-4000, -4000, 9000, 9000).fill({ color: 0x14313a, alpha: 0.58 });
  }

  private makeOverlay(): Container {
    this.clearOverlay();
    this.draftCards = [];
    this.menuButtons = [];
    const layer = new Container();
    const scrim = new Graphics();
    scrim.rect(-4000, -4000, 9000, 9000).fill({ color: 0x14313a, alpha: 0.58 });
    scrim.eventMode = "static"; // swallow taps meant for the board
    layer.addChild(scrim);
    this.overlayLayer.addChild(layer);
    this.overlay = layer;
    return layer;
  }

  private showDraft(): void {
    const layer = this.makeOverlay();
    const inner = this.width - LAYOUT.gutter * 2;
    const offer = this.state.offer ?? [];

    const gap = 8;
    const cardW = Math.min(150, (inner - gap * (offer.length - 1)) / Math.max(1, offer.length));
    const cardH = cardHeightFor(cardW);
    const totalW = cardW * offer.length + gap * (offer.length - 1);

    const title = new Text({ text: "Take one", style: textStyle(22, COLOURS.cream, "800") });
    title.anchor.set(0.5, 0);

    // Measure the block, then centre it — no magic offsets to drift out of date.
    const ownedText = this.state.charms.length
      ? `Owned: ${this.state.charms.map((c) => CHARMS[c].name).join(" · ")}`
      : "";
    const owned = new Text({
      text: ownedText,
      style: {
        ...textStyle(12, COLOURS.cream, "600"),
        wordWrap: true,
        wordWrapWidth: inner,
        align: "center",
        lineHeight: 16,
      },
    });
    owned.anchor.set(0.5, 0);

    const blockH = title.height + 18 + cardH + (ownedText ? 16 + owned.height : 0);
    const top = Math.max(16, (this.height - blockH) / 2);

    title.x = this.width / 2;
    title.y = top;
    layer.addChild(title);

    const cardY = top + title.height + 18;
    const startX = (this.width - totalW) / 2;
    offer.forEach((id, i) => {
      const charm = CHARMS[id];
      const card = new CharmCard(this.tex, charm.name, charm.text, cardW, () => {
        void this.take(id, card);
      });
      card.x = startX + i * (cardW + gap);
      card.y = cardY;
      card.alpha = 0;
      layer.addChild(card);
      this.draftCards.push(card);
      void animate(
        220 + i * 70,
        (t) => {
          card.alpha = t;
          card.y = cardY + (1 - t) * 18;
        },
        easeOut,
      );
    });

    if (ownedText) {
      owned.x = this.width / 2;
      owned.y = cardY + cardH + 16;
      owned.alpha = 0.8;
      layer.addChild(owned);
    }

    // A reroll button appears for a charm-granted reroll, or for an ad when ads
    // are switched on (`ADS_ENABLED`, false in every build today). Neither
    // shows otherwise.
    const freeRerolls = this.state.rerollsLeft > 0;
    if (freeRerolls || this.adsAllowed()) {
      const w = Math.min(200, inner);
      const reroll = new Button(this.tex, freeRerolls ? "Reroll" : "Watch ad · reroll", {
        width: w,
        height: 48,
        variant: "light",
        onTap: () => {
          if (freeRerolls) {
            this.state = rerollOffer(cfg, this.state);
            this.persist();
            this.showDraft();
          } else {
            void this.adReroll(reroll);
          }
        },
      });
      reroll.x = (this.width - w) / 2;
      reroll.y = cardY + cardH + (ownedText ? 16 + owned.height : 0) + 14;
      layer.addChild(reroll);
    }
  }

  private async take(id: CharmId, card: CharmCard): Promise<void> {
    card.setState("claimed");
    await card.pulse();
    this.state = chooseCharm(cfg, this.state, id);
    this.persist();
    this.clearOverlay();
    this.board.clearSelection();
    this.layout();
    this.refresh(true);
  }

  private showRunEnd(): void {
    const layer = this.makeOverlay();
    const inner = Math.min(this.width - LAYOUT.gutter * 2, 360);
    const cleared = this.state.round - 1;
    const owned = this.state.charms;

    const title = new Text({ text: "Run over", style: textStyle(24, COLOURS.ink, "800") });
    title.anchor.set(0.5, 0);
    const body = new Text({
      text:
        `Reached round ${this.state.round}${isLongSoak(cfg, this.state.round) ? " — a Long Soak" : ""}
` +
        `${cleared} round${cleared === 1 ? "" : "s"} cleared
` +
        `${Math.round(this.state.totalScore).toLocaleString("en-GB")} warmth banked
` +
        `+${this.lastPetals} petals  (${this.meta.petals} total)`,
      style: { ...textStyle(15, COLOURS.ink, "600"), align: "center", lineHeight: 22 },
    });
    body.anchor.set(0.5, 0);

    // Owned charms in the pack's third card state, laid out to fit the panel.
    const perRow = owned.length > 0 ? Math.min(3, owned.length) : 0;
    const pad = 18;
    const gridGap = 8;
    const miniW = perRow > 0 ? Math.min(96, (inner - pad * 2 - gridGap * (perRow - 1)) / perRow) : 0;
    const miniH = perRow > 0 ? cardHeightFor(miniW) : 0;
    const gridRows = perRow > 0 ? Math.ceil(owned.length / perRow) : 0;
    const gridH = gridRows > 0 ? gridRows * miniH + (gridRows - 1) * gridGap : 0;

    const heading = new Text({
      text: owned.length ? `Your ${owned.length} charm${owned.length === 1 ? "" : "s"}` : "",
      style: textStyle(12, COLOURS.inkSoft, "800"),
    });
    heading.anchor.set(0.5, 0);

    const buttonW = Math.min(240, inner - pad * 2);
    const buttonH = 54;
    // Ad affordances only exist when ads are switched on; otherwise the panel
    // is exactly the panel it was before Milestone 8. With `ADS_ENABLED` false
    // — every build today — neither button is offered at all, rather than
    // offered and then answering "no reward this time".
    const ads = this.adsAllowed();
    const canRevive =
      ads && !this.revivedThisRun && (this.state.rounds[this.state.rounds.length - 1]?.cleared === false);
    const canDouble = ads && !this.doubledThisRun && this.lastPetals > 0;
    const buttonCount = 2 + (canRevive ? 1 : 0) + (canDouble ? 1 : 0);
    const contentH =
      pad +
      title.height +
      10 +
      body.height +
      (owned.length ? 16 + heading.height + 8 + gridH : 0) +
      18 +
      buttonH * buttonCount +
      10 * (buttonCount - 1) +
      pad;

    const boxH = Math.min(contentH, this.height - 16);
    const box = stretched(this.tex.panel, inner, boxH);
    box.x = (this.width - inner) / 2;
    box.y = Math.max(8, (this.height - boxH) / 2);
    layer.addChild(box);

    let y = box.y + pad;
    title.x = this.width / 2;
    title.y = y;
    layer.addChild(title);
    y += title.height + 10;

    body.x = this.width / 2;
    body.y = y;
    layer.addChild(body);
    y += body.height;

    if (owned.length) {
      y += 16;
      heading.x = this.width / 2;
      heading.y = y;
      layer.addChild(heading);
      y += heading.height + 8;

      owned.forEach((id, i) => {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        const inRow = Math.min(perRow, owned.length - row * perRow);
        const rowW = miniW * inRow + gridGap * (inRow - 1);
        const mini = new CharmCard(this.tex, CHARMS[id].name, "", miniW);
        mini.setState("unlocked");
        mini.x = (this.width - rowW) / 2 + col * (miniW + gridGap);
        mini.y = y + row * (miniH + gridGap);
        layer.addChild(mini);
      });
      y += gridH;
    }

    y += 18;

    // ── rewarded slots, when an SDK is present ──
    if (canRevive) {
      const revive = new Button(this.tex, `Watch ad · +${AD_EXTRA_MOVES} moves`, {
        width: buttonW,
        height: buttonH,
        variant: "light",
        onTap: () => void this.adExtraMoves(revive),
      });
      revive.x = (this.width - buttonW) / 2;
      revive.y = y;
      layer.addChild(revive);
      y += buttonH + 10;
    }
    if (canDouble) {
      const dbl = new Button(this.tex, `Watch ad · double petals`, {
        width: buttonW,
        height: buttonH,
        variant: "light",
        onTap: () => void this.adDoublePetals(dbl),
      });
      dbl.x = (this.width - buttonW) / 2;
      dbl.y = y;
      layer.addChild(dbl);
      y += buttonH + 10;
    }

    // Daily leads with the share grid — that is the loop the mode exists for.
    // Endless leads with another run, because there is nothing to share.
    const primary =
      this.mode === "daily"
        ? new Button(this.tex, "Share result", {
            width: buttonW,
            height: buttonH,
            variant: "primary",
            onTap: () => void this.share(primary),
          })
        : new Button(this.tex, "New run", {
            width: buttonW,
            height: buttonH,
            variant: "primary",
            onTap: () => this.restart(),
          });
    primary.x = (this.width - buttonW) / 2;
    primary.y = y;
    layer.addChild(primary);
    y += buttonH + 10;

    const back = new Button(this.tex, "Menu", {
      width: buttonW,
      height: buttonH,
      onTap: () => this.showMenu(),
    });
    back.x = (this.width - buttonW) / 2;
    back.y = y;
    layer.addChild(back);
    // The cross-promo line that used to sit here fetched `../../games.json` and
    // navigated the page to a sibling game. Inside the platform's iframe the
    // first is a guaranteed 404 and the second would walk the frame off the
    // host, so it is gone; the platform's own catalogue is the cross-promo now.
  }

  // ───────────────────────────────────────────── REWARDED AD SLOTS
  // SPEC §6's three "player-wanted" moments. Every one of these is hidden
  // unless ads are switched on (`adsAllowed()`), so the shipped build shows
  // none of them. See src/platform/host.ts for why that is deliberate.

  /**
   * The gate every rewarded slot asks. `host.adsEnabled` is `ADS_ENABLED`,
   * false unless the build sets `ADS=1`, because this platform's SDK has no ad
   * API. The code behind it is kept so that switching it on is a build flag
   * plus `Host.requestRewardedAd`, not a re-derivation.
   */
  private adsAllowed(): boolean {
    return this.host.adsEnabled;
  }

  /** Ask the host for a rewarded ad. False — no reward — on every failure path. */
  private async rewarded(placement: RewardPlacement): Promise<boolean> {
    if (!this.adsAllowed()) return false;
    try {
      return await this.host.requestRewardedAd(placement);
    } catch {
      return false;
    }
  }

  /** +5 moves on the round that just ended the run. */
  private async adExtraMoves(button: Button): Promise<void> {
    button.setEnabled(false);
    const earned = await this.rewarded("extra_moves");
    if (!earned) {
      button.setEnabled(true);
      return;
    }
    this.revivedThisRun = true;
    // Take the petals back: the run is not over after all.
    this.saveMeta({ ...this.meta, petals: this.meta.petals - this.lastPetals });
    this.awardedFor = "";
    this.state = reviveWithMoves(cfg, this.state, AD_EXTRA_MOVES);
    this.clearOverlay();
    this.layout();
    this.refresh(true);
    this.persist();
  }

  /** A second look at the draft, without spending a charm's allowance. */
  private async adReroll(button: Button): Promise<void> {
    button.setEnabled(false);
    if (!(await this.rewarded("reroll_draft"))) {
      button.setEnabled(true);
      return;
    }
    this.state = rerollOffer(cfg, this.state, { free: true });
    this.persist();
    this.showDraft();
  }

  /** Twice the run's petals. Once per run. */
  private async adDoublePetals(button: Button): Promise<void> {
    button.setEnabled(false);
    if (!(await this.rewarded("double_petals"))) {
      button.setEnabled(true);
      return;
    }
    this.doubledThisRun = true;
    // Undo the single award, then re-award at 2x.
    this.meta = { ...this.meta, petals: this.meta.petals - this.lastPetals };
    this.awardedFor = "";
    this.awardPetals(2);
    this.showRunEnd();
  }

  /** Copy the spoiler-free grid. The button itself is the confirmation. */
  private async share(button?: Button): Promise<boolean> {
    const text = shareTextFor(cfg, this.state, this.dailyN);
    const ok = await copyText(text);
    this.lastShareText = text;
    if (button) {
      button.setText(ok ? "Copied!" : "Copy failed");
      window.setTimeout(() => button.setText("Share result"), 1800);
    }
    return ok;
  }

  // ─────────────────────────────────────────────────────────── the menu

  private showMenu(): void {
    const layer = this.makeOverlay();
    const inner = Math.min(this.width - LAYOUT.gutter * 2, 360);
    const pad = 20;
    const buttonW = Math.min(260, inner - pad * 2);
    const buttonH = 58;

    const saved = this.saved.daily;
    const todayDone =
      saved !== null && saved.dailyNumber === this.todayN && saved.run.phase === "over";
    const todayStarted = saved !== null && saved.dailyNumber === this.todayN && !todayDone;

    const title = new Text({ text: "Cappy's Onsen", style: textStyle(28, COLOURS.ink, "800") });
    title.anchor.set(0.5, 0);
    const sub = new Text({
      text: `Daily #${this.todayN} · ${dateKeyOfDaily(cfg.daily, this.todayN)}`,
      style: textStyle(13, COLOURS.inkSoft, "600"),
    });
    sub.anchor.set(0.5, 0);

    const note = new Text({
      text: todayDone
        ? "Today's soak is done. Come back tomorrow — or play Endless."
        : todayStarted
          ? "You have a daily in progress."
          : "One soak a day. Everyone gets the same board.",
      style: {
        ...textStyle(13, COLOURS.inkSoft, "600"),
        wordWrap: true,
        wordWrapWidth: inner - pad * 2,
        align: "center",
        lineHeight: 18,
      },
    });
    note.anchor.set(0.5, 0);

    const contentH =
      pad + title.height + 4 + sub.height + 14 + note.height + 18 + buttonH * 3 + 24 + pad;
    const boxH = Math.min(contentH, this.height - 16);
    const box = stretched(this.tex.panel, inner, boxH);
    box.x = (this.width - inner) / 2;
    box.y = Math.max(8, (this.height - boxH) / 2);
    layer.addChild(box);

    let y = box.y + pad;
    for (const t of [title, sub]) {
      t.x = this.width / 2;
      t.y = y;
      layer.addChild(t);
      y += t.height + (t === title ? 4 : 14);
    }
    note.x = this.width / 2;
    note.y = y;
    layer.addChild(note);
    y += note.height + 18;

    const dailyLabel = todayDone
      ? `See Daily #${this.todayN}`
      : todayStarted
        ? `Resume Daily #${this.todayN}`
        : `Play Daily #${this.todayN}`;
    const dailyBtn = new Button(this.tex, dailyLabel, {
      width: buttonW,
      height: buttonH,
      variant: "primary",
      onTap: () => this.startDaily(this.todayN),
    });
    dailyBtn.x = (this.width - buttonW) / 2;
    dailyBtn.y = y;
    layer.addChild(dailyBtn);
    y += buttonH + 12;

    const endlessBtn = new Button(this.tex, "Endless", {
      width: buttonW,
      height: buttonH,
      onTap: () => this.startEndless(),
    });
    endlessBtn.x = (this.width - buttonW) / 2;
    endlessBtn.y = y;
    layer.addChild(endlessBtn);
    y += buttonH + 12;

    const collectionBtn = new Button(this.tex, `Collection · ${this.meta.petals} petals`, {
      width: buttonW,
      height: buttonH,
      variant: "light",
      onTap: () => this.showCollection(),
    });
    collectionBtn.x = (this.width - buttonW) / 2;
    collectionBtn.y = y;
    layer.addChild(collectionBtn);

    this.menuButtons = [dailyBtn, endlessBtn, collectionBtn];
  }

  /**
   * Dev-only handle used to drive the client from automated checks. Gated on
   * the `DEV_HANDLE` build flag, so in every normal build the only reference to
   * it sits behind `if (false)` and nothing here is reachable.
   */
  devHandle() {
    return {
      state: (): RunState => this.state,
      busy: (): boolean => this.board.isBusy,
      /** Board-space legal moves, straight from the sim's own swap rule. */
      legalMoves: (): [Pos, Pos][] => {
        const b = this.state.board;
        const out: [Pos, Pos][] = [];
        for (let row = 0; row < b.rows; row++) {
          for (let col = 0; col < b.cols; col++) {
            const a = { col, row };
            const right = { col: col + 1, row };
            const down = { col, row: row + 1 };
            if (col + 1 < b.cols && swap(b, a, right)) out.push([a, right]);
            if (row + 1 < b.rows && swap(b, a, down)) out.push([a, down]);
          }
        }
        return out;
      },
      pointOf: (pos: Pos) => this.board.globalOf(pos),
      draftPoints: () =>
        this.draftCards.map((c) => c.toGlobal({ x: c.width_ / 2, y: c.height_ / 2 })),
      overlayKind: (): "draft" | "over" | "menu" | null =>
        this.overlay === null
          ? null
          : this.menuButtons.length > 0
            ? "menu"
            : this.state.phase === "drafting"
              ? "draft"
              : "over",
      menuPoints: () => this.menuButtons.map((b) => b.toGlobal({ x: 120, y: 28 })),
      mode: (): RunMode => this.mode,
      dailyNumber: (): number => this.dailyN,
      todayNumber: (): number => this.todayN,
      shareText: (): string => shareTextFor(cfg, this.state, this.dailyN),
      lastShare: (): string => this.lastShareText,
      copyShare: (): Promise<boolean> => this.share(),
      overlayButtons: () =>
        (this.overlay?.children ?? [])
          .filter((c): c is Button => c instanceof Button)
          .map((b) => b.toGlobal({ x: 120, y: 28 })),
    };
  }

  /**
   * The collection: every charm in the pool, unlocked ones shown in the pack's
   * "unlocked" card state and locked ones dimmed with their petal price. Décor
   * sits below it — the only other thing petals buy.
   */
  private showCollection(): void {
    const layer = this.makeOverlay();
    // The collection is allowed to be wider than the play column: 24 cards four
    // abreast makes a panel three times taller than it is wide, which stretches
    // the artwork badly. Six columns on anything roomy enough keeps it closer to
    // the source's proportions; a phone still gets four.
    const inner = Math.min(this.width - LAYOUT.gutter * 2, 460);
    const pad = 14;
    const gap = 7;
    const perRow = inner >= 420 ? 6 : 4;
    const items = collection(this.meta);
    const rows = Math.ceil(items.length / perRow);

    const title = new Text({
      text: `Collection · ${this.meta.petals} petals`,
      style: textStyle(19, COLOURS.ink, "800"),
    });
    title.anchor.set(0.5, 0);
    const sub = new Text({
      text: `${items.filter((i) => i.unlocked).length} of ${items.length} charms · tap a locked charm to unlock`,
      style: {
        ...textStyle(11, COLOURS.inkSoft, "600"),
        wordWrap: true,
        wordWrapWidth: inner - pad * 2,
        align: "center",
      },
    });
    sub.anchor.set(0.5, 0);

    const decorH = 40;
    const backH = 46;
    // Everything that is NOT the grid, so the grid can be given the remainder.
    const fixed = pad + title.height + 4 + sub.height + 10 + 12 + decorH + 12 + backH + pad;
    const budget = Math.max(120, this.height - 12 - fixed);

    // Cards size by width, then shrink further if 24 of them would not fit the
    // height left over. Twenty-four cards is a tall screen by nature; deriving
    // the size from BOTH budgets is what stops the last row and the Back button
    // sliding off the bottom.
    const fromWidth = (inner - pad * 2 - gap * (perRow - 1)) / perRow;
    const fromHeight = (budget - gap * (rows - 1)) / rows / CARD_ASPECT;
    const cardW = Math.max(44, Math.min(fromWidth, fromHeight));
    const cardH = cardHeightFor(cardW);
    const gridH = rows * cardH + (rows - 1) * gap;
    const gridW = perRow * cardW + (perRow - 1) * gap;

    const boxH = Math.min(fixed + gridH, this.height - 8);
    const box = stretched(this.tex.panel, inner, boxH);
    box.x = (this.width - inner) / 2;
    box.y = Math.max(4, (this.height - boxH) / 2);
    layer.addChild(box);

    let y = box.y + pad;
    title.x = sub.x = this.width / 2;
    title.y = y;
    layer.addChild(title);
    y += title.height + 4;
    sub.y = y;
    layer.addChild(sub);
    y += sub.height + 10;

    const gridLeft = (this.width - gridW) / 2;
    const gridTop = y;
    items.forEach((item, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const card = new CharmCard(this.tex, CHARMS[item.id].name, "", cardW, () => {
        if (!item.unlocked && canUnlockCharm(this.meta, item.id)) {
          this.saveMeta(unlockCharm(this.meta, item.id));
          this.showCollection();
        }
      });
      card.setState(item.unlocked ? "unlocked" : "default");
      if (!item.unlocked) card.alpha = canUnlockCharm(this.meta, item.id) ? 0.95 : 0.45;
      card.x = gridLeft + col * (cardW + gap);
      card.y = gridTop + row * (cardH + gap);
      layer.addChild(card);

      if (!item.unlocked) {
        const price = new Text({
          text: `${item.cost}`,
          style: textStyle(Math.max(9, cardW * 0.15), COLOURS.ink, "800"),
        });
        price.anchor.set(0.5, 1);
        price.x = card.x + cardW / 2;
        price.y = card.y + cardH - 3;
        layer.addChild(price);
      }
    });
    y = gridTop + gridH + 12;

    // ── décor ──
    const decorW = (inner - pad * 2 - gap * 2) / 3;
    DECOR_IDS.forEach((id, i) => {
      const d = DECOR[id];
      const owned = this.meta.unlockedDecor.includes(id);
      const active = this.meta.activeDecor === id;
      // Short labels: the full name plus a price does not fit a third of the
      // panel, and a clipped label is worse than a terse one.
      const label = owned ? (active ? `${d.short} ✓` : d.short) : `${d.short} ${d.cost}`;
      const btn = new Button(this.tex, label, {
        width: decorW,
        height: decorH,
        fontSize: 12,
        variant: active ? "primary" : "light",
        onTap: () => {
          this.saveMeta(
            owned
              ? chooseDecor(this.meta, id)
              : canUnlockDecor(this.meta, id)
                ? chooseDecor(unlockDecor(this.meta, id), id)
                : this.meta,
          );
          this.layout();
          this.showCollection();
        },
      });
      btn.alpha = owned || canUnlockDecor(this.meta, id) ? 1 : 0.45;
      btn.x = (this.width - inner) / 2 + pad + i * (decorW + gap);
      btn.y = y;
      layer.addChild(btn);
    });
    y += decorH + 12;

    const backW = Math.min(190, inner - pad * 2);
    const back = new Button(this.tex, "Back", {
      width: backW,
      height: backH,
      onTap: () => this.showMenu(),
    });
    back.x = (this.width - backW) / 2;
    back.y = y;
    layer.addChild(back);
  }

  private restart(): void {
    if (this.mode === "daily") this.showMenu();
    else this.startEndless(true);
  }
}

// ───────────────────────────────────────────────────────── helpers

function readSafeArea(): { top: number; right: number; bottom: number; left: number } {
  const s = getComputedStyle(document.documentElement);
  const read = (name: string): number => Number.parseFloat(s.getPropertyValue(name)) || 0;
  return {
    top: read("--sat"),
    right: read("--sar"),
    bottom: read("--sab"),
    left: read("--sal"),
  };
}

/** Fixed steam blooms: [x, y, radius, alpha] as fractions of the viewport. */
const STEAM: readonly (readonly [number, number, number, number])[] = [
  [0.18, 0.1, 0.3, 0.16],
  [0.82, 0.05, 0.24, 0.13],
  [0.5, 0.26, 0.34, 0.09],
  [0.08, 0.62, 0.2, 0.05],
  [0.92, 0.78, 0.26, 0.05],
];

/** Four-stop ramp: warm cream -> peach -> shallow water -> deep water. */
function skyAt(t: number, palette: readonly [number, number, number, number]): number {
  const stops: [number, number][] = [
    [0.0, palette[0]],
    [0.26, palette[1]],
    [0.58, palette[2]],
    [1.0, palette[3]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;
    if (t <= p1) return mix(c0, c1, (t - p0) / (p1 - p0));
  }
  return palette[3];
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255;
  const br = (b >> 16) & 255,
    bg = (b >> 8) & 255,
    bb = b & 255;
  return (
    ((ar + (br - ar) * t) << 16) | (((ag + (bg - ag) * t) | 0) << 8) | ((ab + (bb - ab) * t) | 0)
  );
}

// ───────────────────────────────────────────────────────── boot

/**
 * Bring up Pixi, load the chrome, and open the game on whatever the host saved.
 *
 * The texture load is the one step with a genuine "asset_load" failure mode —
 * fourteen PNGs fetched relative to the page — so it is caught on its own and
 * reported under that category. Anything else that fails here is a script
 * fault. Either way the player sees the boot line say so, and the error is
 * handled rather than rethrown, so the global handlers in `platform/host.ts`
 * do not report it a second time.
 */
async function boot(context: BootContext): Promise<void> {
  const app = new Application();
  await app.init({
    background: COLOURS.waterDeep,
    resizeTo: window,
    antialias: true,
    // Cap the DPR: a 3x phone screen renders 9x the pixels for no visible gain
    // and a very visible frame-rate cost.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    preference: "webgl",
  });
  document.getElementById("app")?.appendChild(app.canvas);
  useTicker(app.ticker);

  let chrome: ChromeTextures;
  try {
    chrome = await loadChrome();
  } catch (err) {
    throw new BootFailure(err, "asset_load");
  }
  const art = buildTileArt(app.renderer, app.renderer.resolution);
  const wild = buildWildArt(app.renderer, app.renderer.resolution);
  const spark = buildSparkTexture(app.renderer, app.renderer.resolution);

  const game = new Game(app, chrome, art, wild, spark, context.host, loadHostSave(context.savedProgress));
  if (DEV_HANDLE) {
    (window as unknown as Record<string, unknown>)["__onsen"] = game.devHandle();
  }
  document.getElementById("boot")?.remove();
  document.body.dataset["ready"] = "1";
}

/** A boot failure, tagged with the category it should be reported under. */
class BootFailure extends Error {
  constructor(
    readonly reason: unknown,
    readonly errorType: "asset_load" | "script",
  ) {
    super(String(reason));
  }
}

let started = false;

/**
 * The host has booted us: take the save it is holding and start playing.
 *
 * Called once. Nothing above this line has run until now — there is no canvas
 * and no run — because the saved progress arrives with this call and opening a
 * run before it would mean opening one twice.
 */
export function startClient(context: BootContext): void {
  if (started) return;
  started = true;
  setMuted(context.muted);
  void boot(context).catch((err: unknown) => {
    const failure = err instanceof BootFailure ? err : new BootFailure(err, "script");
    const line = document.getElementById("boot");
    if (line) line.textContent = `Failed to start: ${failure.message}`;
    document.body.dataset["error"] = failure.message;
    console.error(failure.reason);
    context.host.reportError(`boot failed: ${failure.message}`, failure.errorType);
  });
}

/**
 * The host's mute switch.
 *
 * Cappy's Onsen has no audio, so there is nothing to mute. Kept because the
 * host sends the state on boot and on every change, and a game that ignores the
 * message entirely is a game that will not notice when it does grow a sound.
 */
export function setMuted(_muted: boolean): void {
  /* no audio to mute yet */
}
