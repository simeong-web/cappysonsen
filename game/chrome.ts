/**
 * Cozy UI chrome — panels, buttons, charm cards, counters.
 *
 * Pack sprites are used for the frame around the game only. Board tiles are
 * custom work in `tiles.ts` (CLAUDE.md, "Asset handling"). Source and licence
 * note: `game/assets/cozy/SOURCE.md`.
 *
 * Most of the pack's art is SCALED rather than nine-sliced — see `stretched`
 * for why slicing hand-drawn borders smears their edge nicks into notches.
 */
import {
  Assets,
  Container,
  Graphics,
  NineSliceSprite,
  Sprite,
  Text,
  type Texture,
} from "pixi.js";
import { COLOURS, LAYOUT, SLICES, textStyle, type Slice } from "./theme";
import { animate, easeOut } from "./tween";

/**
 * Static imports, deliberately.
 *
 * Vite only fingerprints and emits an asset when it can see a literal path at
 * build time. Computing the URL at runtime (`new URL(variable, import.meta.url)`)
 * works in dev — the file is served from disk — and then silently ships a
 * bundle with no images in it. Importing each one binds the emitted, hashed,
 * `base: './'`-relative URL, so the bundle is correct from any subfolder.
 */
import barUrl from "./assets/cozy/bar.png";
import panelUrl from "./assets/cozy/panel.png";
import panelInsetUrl from "./assets/cozy/panel-inset.png";
import noteUrl from "./assets/cozy/note.png";
import cardDefaultUrl from "./assets/cozy/card-default.png";
import cardClaimedUrl from "./assets/cozy/card-claimed.png";
import buttonUrl from "./assets/cozy/button.png";
import buttonPrimaryUrl from "./assets/cozy/button-primary.png";
import buttonLightUrl from "./assets/cozy/button-light.png";
import checkOnUrl from "./assets/cozy/check-on.png";
import checkOffUrl from "./assets/cozy/check-off.png";
import iconHeartUrl from "./assets/cozy/icon-heart.png";
import iconCrossUrl from "./assets/cozy/icon-cross.png";
import iconPlusUrl from "./assets/cozy/icon-plus.png";

const MANIFEST = {
  bar: barUrl,
  panel: panelUrl,
  panelInset: panelInsetUrl,
  note: noteUrl,
  cardDefault: cardDefaultUrl,
  cardClaimed: cardClaimedUrl,
  button: buttonUrl,
  buttonPrimary: buttonPrimaryUrl,
  buttonLight: buttonLightUrl,
  checkOn: checkOnUrl,
  checkOff: checkOffUrl,
  iconHeart: iconHeartUrl,
  iconCross: iconCrossUrl,
  iconPlus: iconPlusUrl,
} as const;

export type ChromeKey = keyof typeof MANIFEST;
export type ChromeTextures = Record<ChromeKey, Texture>;

export async function loadChrome(): Promise<ChromeTextures> {
  const entries = Object.entries(MANIFEST) as [ChromeKey, string][];
  const loaded = await Promise.all(
    entries.map(async ([key, url]) => [key, await Assets.load<Texture>(url)] as const),
  );
  return Object.fromEntries(loaded) as ChromeTextures;
}

/**
 * A panel drawn by scaling the whole sprite, corners and all.
 *
 * Preferred over nine-slicing for the pack's containers. Their borders are
 * hand-drawn with small nicks scattered along every edge; nine-slice pins the
 * corners and stretches the middle, so whichever nicks fall in the middle band
 * smear into long steps — the "melted panel" look. Every container here is
 * *larger* than the box it has to fill (the wood bar is 1511px wide for a
 * ~400px bar), so a straight scale stays within ~15% of uniform and simply
 * looks like the artwork, smaller.
 *
 * Buttons use this too. They distort further from the source aspect than a
 * panel does, but a slightly wide corner radius reads as a button; a smeared
 * notch reads as a bug.
 */
export function stretched(tex: Texture, w: number, h: number): Sprite {
  const s = new Sprite(tex);
  s.width = w;
  s.height = h;
  return s;
}

/**
 * Nine-sliced panel.
 *
 * The insets are shrunk when the target is smaller than the art's own corners.
 * Without this, asking for a 46px-tall bar from art with 46+56px of fixed
 * corner collapses the stretchable middle to nothing and smears the corners
 * into each other — which is exactly how a panel ends up looking melted.
 */
export function panel(tex: Texture, w: number, h: number, slice: Slice = SLICES.panel): NineSliceSprite {
  let [l, t, r, b] = slice;
  const vFit = Math.min(1, (h * 0.86) / Math.max(1, t + b));
  const hFit = Math.min(1, (w * 0.86) / Math.max(1, l + r));
  t *= vFit;
  b *= vFit;
  l *= hFit;
  r *= hFit;

  const s = new NineSliceSprite({ texture: tex, leftWidth: l, topHeight: t, rightWidth: r, bottomHeight: b });
  s.width = w;
  s.height = h;
  return s;
}

export interface ButtonOpts {
  width?: number;
  height?: number;
  variant?: "wood" | "primary" | "light";
  /** Defaults to 17. Narrow buttons need less or the label runs past the edge. */
  fontSize?: number;
  onTap: () => void;
}

/** A tappable Cozy button. Never smaller than the thumb target. */
export class Button extends Container {
  private readonly bg: Sprite;
  private readonly caption: Text;
  private enabled = true;

  constructor(tex: ChromeTextures, text: string, opts: ButtonOpts) {
    super();
    const w = Math.max(LAYOUT.minTouch * 2, opts.width ?? 180);
    const h = Math.max(LAYOUT.minTouch, opts.height ?? 52);
    const texture =
      opts.variant === "primary" ? tex.buttonPrimary : opts.variant === "light" ? tex.buttonLight : tex.button;

    // Scaled, not nine-sliced: the button art carries the same hand-drawn edge
    // nicks as the containers, and slicing smears whichever ones land in the
    // stretched middle into a notch. See `stretched` for the full reasoning.
    this.bg = stretched(texture, w, h);
    this.caption = new Text({
      text,
      style: textStyle(opts.fontSize ?? 17, opts.variant === "light" ? COLOURS.ink : COLOURS.cream, "800"),
    });
    this.caption.anchor.set(0.5);
    this.caption.x = w / 2;
    // the pack's buttons have a shadow lip along the bottom — sit text above it
    this.caption.y = h / 2 - 4;
    this.addChild(this.bg, this.caption);

    this.eventMode = "static";
    this.cursor = "pointer";
    this.on("pointerdown", () => {
      if (this.enabled) this.y += 2;
    });
    this.on("pointerupoutside", () => this.reset());
    this.on("pointerup", () => {
      if (!this.enabled) return;
      this.reset();
      opts.onTap();
    });
  }

  private baseY: number | null = null;
  private reset(): void {
    if (this.baseY === null) this.baseY = this.y;
    this.y = this.baseY;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.alpha = on ? 1 : 0.45;
    this.eventMode = on ? "static" : "none";
  }

  setText(text: string): void {
    this.caption.text = text;
  }
}

/**
 * A charm card in one of the three states the pack provides art for.
 *
 * default  — on offer, not yet taken (wood header)
 * claimed  — the one you just took (red header + tick)
 * unlocked — already owned, shown greyed in the run-end summary
 */
export type CardState = "default" | "claimed" | "unlocked";

/**
 * The card art is 281x343 with a header band across the top ~28%. Nine-slicing
 * it crushes that band the moment the card is shorter than the source, so the
 * card is drawn as a plain sprite at the art's own aspect and everything is
 * positioned as a fraction of it. Cards size by WIDTH; height follows.
 */
export const CARD_ASPECT = 343 / 281;
const HEADER_FRACTION = 96 / 343;

export const cardHeightFor = (width: number): number => width * CARD_ASPECT;

export class CharmCard extends Container {
  private readonly bg: Sprite;
  private readonly tick: Sprite;
  private state: CardState = "default";
  readonly height_: number;

  constructor(
    private readonly tex: ChromeTextures,
    name: string,
    body: string,
    readonly width_: number,
    onTap?: () => void,
  ) {
    super();
    this.height_ = cardHeightFor(width_);
    const headerH = this.height_ * HEADER_FRACTION;

    this.bg = new Sprite(tex.cardDefault);
    this.bg.width = width_;
    this.bg.height = this.height_;
    this.addChild(this.bg);

    // Title sits inside the header band, vertically centred in it.
    const titleSize = Math.max(9, Math.min(15, width_ * 0.115));
    const title = new Text({
      text: name,
      style: {
        ...textStyle(titleSize, COLOURS.cream, "800"),
        wordWrap: true,
        wordWrapWidth: width_ - 14,
        align: "center",
        lineHeight: titleSize * 1.15,
      },
    });
    title.anchor.set(0.5, 0.5);
    title.x = width_ / 2;
    title.y = headerH * 0.52;
    this.addChild(title);

    if (body) {
      const bodySize = Math.max(9, Math.min(13, width_ * 0.098));
      const text = new Text({
        text: body,
        style: {
          ...textStyle(bodySize, COLOURS.ink, "600"),
          wordWrap: true,
          wordWrapWidth: width_ - 18,
          align: "center",
          lineHeight: bodySize * 1.3,
        },
      });
      text.anchor.set(0.5, 0.5);
      text.x = width_ / 2;
      // centred in the cream body, clear of the bottom lip
      text.y = headerH + (this.height_ - headerH) * 0.44;
      this.addChild(text);
    }

    this.tick = new Sprite(tex.checkOn);
    this.tick.anchor.set(0.5);
    this.tick.width = this.tick.height = Math.min(30, width_ * 0.26);
    this.tick.x = width_ - this.tick.width * 0.6;
    this.tick.y = this.height_ - this.tick.height * 0.75;
    this.tick.visible = false;
    this.addChild(this.tick);

    if (onTap) {
      this.eventMode = "static";
      this.cursor = "pointer";
      this.on("pointertap", onTap);
    }
  }

  setState(state: CardState): void {
    this.state = state;
    this.bg.texture = state === "claimed" ? this.tex.cardClaimed : this.tex.cardDefault;
    this.tick.visible = state !== "default";
    this.alpha = state === "unlocked" ? 0.72 : 1;
  }

  getState(): CardState {
    return this.state;
  }

  async pulse(): Promise<void> {
    const from = this.scale.x;
    await animate(
      180,
      (t) => this.scale.set(from * (1 + Math.sin(t * Math.PI) * 0.06)),
      easeOut,
    );
    this.scale.set(from);
  }
}

/** Warmth/Bliss readout with a rolling number, so a big score feels big. */
export class Counter extends Container {
  private readonly value: Text;
  private shown = 0;
  private target = 0;

  constructor(label: string, colour: number, private readonly decimals = 0) {
    super();
    const cap = new Text({ text: label, style: textStyle(11, COLOURS.inkSoft, "800") });
    cap.anchor.set(0.5, 0);
    this.value = new Text({ text: "0", style: textStyle(24, colour, "800") });
    this.value.anchor.set(0.5, 0);
    this.value.y = 14;
    this.addChild(cap, this.value);
  }

  set(n: number): void {
    this.target = n;
  }

  setImmediate(n: number): void {
    this.target = this.shown = n;
    this.render();
  }

  /** Called each frame — eases the displayed number toward the real one. */
  tick(): void {
    if (Math.abs(this.target - this.shown) < 0.001) return;
    this.shown += (this.target - this.shown) * 0.22;
    if (Math.abs(this.target - this.shown) < 0.5 / 10 ** this.decimals) this.shown = this.target;
    this.render();
  }

  private render(): void {
    this.value.text =
      this.decimals > 0
        ? this.shown.toFixed(this.decimals)
        : Math.round(this.shown).toLocaleString("en-GB");
  }
}

/** Target progress. Turns green the moment the round is actually cleared. */
export class ProgressBar extends Container {
  private readonly fill = new Graphics();
  private readonly frame = new Graphics();
  private readonly caption: Text;
  private w = 200;

  constructor() {
    super();
    // The caption crosses both the bright fill and the dark track, so it
    // carries its own outline rather than relying on either for contrast.
    this.caption = new Text({
      text: "",
      style: {
        ...textStyle(12, COLOURS.cream, "800"),
        stroke: { color: 0x2c1a12, width: 3, join: "round" },
      },
    });
    this.caption.anchor.set(0.5, 0.5);
    this.addChild(this.fill, this.frame, this.caption);
  }

  resize(w: number): void {
    this.w = w;
    this.frame.clear();
    this.frame.roundRect(0, 0, w, 24, 12).stroke({ width: 2, color: 0x2c1a12, alpha: 0.35 });
    this.caption.x = w / 2;
    this.caption.y = 12;
  }

  set(score: number, target: number): void {
    const pct = target > 0 ? Math.min(1, score / target) : 0;
    const done = score >= target;
    this.fill.clear();
    // Dark inset cut into the plank, so the fill and its caption both read.
    this.fill.roundRect(0, 0, this.w, 24, 12).fill({ color: 0x3a241a, alpha: 0.55 });
    if (pct > 0) {
      this.fill
        .roundRect(2, 2, Math.max(20, (this.w - 4) * pct), 20, 10)
        .fill(done ? COLOURS.barDone : COLOURS.barFill);
    }
    this.caption.text = `${Math.round(score).toLocaleString("en-GB")} / ${Math.round(target).toLocaleString("en-GB")}`;
  }
}
