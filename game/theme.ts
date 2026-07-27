/**
 * Look and layout constants for the Pixi client.
 *
 * Nine-slice insets are measured from the source PNGs: the Cozy panels have
 * ~34px rounded corners on a 281px-wide sprite, so slicing inside that keeps
 * the corner radius crisp at any panel size instead of smearing it.
 */

/**
 * Palette — an onsen at golden hour, keyed to the Cozy pack's warm tan, brown
 * and cream. The water used to be near-black, which read as cold and fought
 * the chrome; the play area stays the darkest thing on screen only so the
 * pastel tiles keep their contrast.
 */
export const COLOURS = {
  /* background gradient, top to bottom */
  skyTop: 0xffe6c0,
  skyWarm: 0xf9b998,
  waterTop: 0x8fcfcf,
  waterDeep: 0x3f8e9b,
  steam: 0xfff6e4,

  /* the tub */
  boardWell: 0x1d4d57,
  boardRim: 0xb5734f,
  boardRimDark: 0x8a5340,

  /* the pack's ink and wood */
  ink: 0x4a3227,
  inkSoft: 0x7a5136,
  cream: 0xfff6e2,
  wood: 0x9c5a43,
  woodLight: 0xd9977a,

  /* readouts — saturated enough to hold up on tan wood */
  warmth: 0xb35c0f,
  bliss: 0xb63f74,
  good: 0x3f8f5c,
  bad: 0xc0392b,
  /* the progress bar sits on a dark inset, so it wants the bright versions */
  barFill: 0xf2b544,
  barDone: 0x6cc08b,
  selection: 0xffffff,
} as const;

/** Nine-slice insets: [left, top, right, bottom]. */
export type Slice = readonly [number, number, number, number];

export const SLICES: Record<"bar" | "panel" | "panelInset" | "button" | "card" | "note", Slice> = {
  // WoodenContainer1 is 1511x384 — authored wide, so a HUD bar SHRINKS it
  // rather than stretching, and its hand-drawn edge nicks stay put.
  bar: [60, 46, 60, 56],
  // Container3 is 281x292 with decorative tabs on the top edge. Stretched wide
  // those tabs smear into steps, so it is only used near its own aspect.
  panel: [40, 40, 40, 48],
  panelInset: [34, 34, 34, 44],
  button: [30, 30, 30, 42],
  // The card's brown header band is ~96px tall in the source and must not
  // stretch, so the top inset sits below it.
  card: [30, 96, 30, 46],
  note: [60, 60, 60, 70],
};

export const LAYOUT = {
  /** The design is authored at this width and scaled to fit. */
  maxWidth: 520,
  gutter: 14,
  // The wood plank carries a thick border and a shadow lip along the bottom.
  // Bars shorter than this leave no room between them and look squashed.
  hudHeight: 104,
  footerHeight: 96,
  buildHeight: 74,
  /** Safe inset inside a wood bar: border at the top, border + lip at the base. */
  barPadTop: 14,
  barPadBottom: 26,
  tileGap: 4,
  /** Thumb-reachable: nothing interactive smaller than this on a phone. */
  minTouch: 44,
};

/** Cascade timing escalates with chain depth — deeper chains snap faster. */
export const TIMING = {
  swap: 130,
  swapBack: 110,
  /** Pop duration at depth 1; each further step shortens toward popMin. */
  pop: 180,
  popMin: 90,
  fall: 210,
  fallMin: 110,
  /** Beat between cascade steps, also shortening with depth. */
  stepGap: 70,
  stepGapMin: 20,
};

/** How much a duration shrinks by cascade depth: depth 1 = 1.0, then decaying. */
export function depthScale(depth: number): number {
  return Math.max(0.45, 1 - (depth - 1) * 0.18);
}

export const FONT = {
  family: "system-ui, -apple-system, 'Segoe UI', sans-serif",
};

export const textStyle = (size: number, colour: number, weight: "400" | "600" | "800" = "600") => ({
  fontFamily: FONT.family,
  fontSize: size,
  fontWeight: weight,
  fill: colour,
});
