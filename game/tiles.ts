/**
 * Custom tile art — drawn at runtime, not from the asset pack.
 *
 * CLAUDE.md is explicit that board tiles are custom work: the pack is for
 * chrome only. Drawing them into render textures rather than shipping PNGs
 * means they stay crisp at any device pixel ratio and any board size, and the
 * repo carries no tile binaries at all.
 *
 * Each tile is distinguishable by SHAPE as well as colour. Roughly one player
 * in twelve can't reliably separate the yuzu from the leaf on hue alone, and a
 * match-3 that needs colour discrimination to play is a match-3 those players
 * cannot play.
 */
import { Graphics, type Renderer, RenderTexture, Texture } from "pixi.js";

/** Authoring size. Sprites scale from here to whatever the board needs. */
const S = 128;

export interface TileArt {
  texture: Texture;
  /** Tint for particles and the clear flash. */
  accent: number;
}

type Draw = (g: Graphics) => void;

/** Shape recipes. Kept declarative so a tweak is one line, not a redraw. */
const RECIPES: { name: string; accent: number; draw: Draw }[] = [
  {
    name: "yuzu",
    accent: 0xf6c453,
    draw: (g) => {
      g.circle(64, 70, 42).fill(0xf3b73f);
      g.circle(64, 70, 42).stroke({ width: 5, color: 0xc07f22, alignment: 0 });
      g.circle(52, 58, 13).fill({ color: 0xffe9a8, alpha: 0.85 }); // highlight
      // little leaf, so it reads as citrus and not "yellow circle"
      g.ellipse(84, 30, 18, 10).fill(0x6faa4e);
      g.moveTo(70, 38).lineTo(90, 26).stroke({ width: 4, color: 0x4d7d35 });
    },
  },
  {
    name: "petal",
    accent: 0xf58fb4,
    draw: (g) => {
      // five-petal blossom — the only radially symmetric shape in the set
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.ellipse(64 + Math.cos(a) * 26, 64 + Math.sin(a) * 26, 22, 17).fill(0xf58fb4);
      }
      g.circle(64, 64, 16).fill(0xfff1d0);
      g.circle(64, 64, 16).stroke({ width: 4, color: 0xd76a92, alignment: 0 });
    },
  },
  {
    name: "bubble",
    accent: 0x8fd4ec,
    draw: (g) => {
      g.circle(64, 64, 42).fill({ color: 0x8fd4ec, alpha: 0.95 });
      g.circle(64, 64, 42).stroke({ width: 5, color: 0x4fa3c4, alignment: 0 });
      g.circle(64, 64, 27).stroke({ width: 3, color: 0xdff4fc, alpha: 0.7 });
      g.ellipse(50, 48, 13, 9).fill({ color: 0xffffff, alpha: 0.9 });
    },
  },
  {
    name: "stone",
    accent: 0x9aa5a8,
    draw: (g) => {
      // deliberately squat and asymmetric — reads as "heavy" next to the circles
      g.roundRect(20, 40, 88, 60, 26).fill(0x98a3a8);
      g.roundRect(20, 40, 88, 60, 26).stroke({ width: 5, color: 0x6b7679, alignment: 0 });
      g.ellipse(48, 60, 16, 9).fill({ color: 0xc7d0d2, alpha: 0.8 });
      g.ellipse(84, 82, 9, 6).fill({ color: 0x7d8689, alpha: 0.8 });
    },
  },
  {
    name: "leaf",
    accent: 0x7cbf6a,
    draw: (g) => {
      // pointed both ends, tilted — nothing else in the set has a diagonal axis
      g.moveTo(26, 100)
        .bezierCurveTo(24, 46, 60, 22, 104, 26)
        .bezierCurveTo(104, 76, 74, 104, 26, 100)
        .fill(0x7cbf6a);
      g.moveTo(26, 100)
        .bezierCurveTo(24, 46, 60, 22, 104, 26)
        .bezierCurveTo(104, 76, 74, 104, 26, 100)
        .stroke({ width: 5, color: 0x4d8340, alignment: 0 });
      g.moveTo(32, 96).lineTo(96, 34).stroke({ width: 4, color: 0x4d8340, alpha: 0.85 });
    },
  },
];

/**
 * Bake every tile into a render texture once, at a resolution matched to the
 * screen. Sprites then cost nothing to draw and Pixi batches them all.
 */
export function buildTileArt(renderer: Renderer, resolution: number): TileArt[] {
  return RECIPES.map((recipe) => {
    const g = new Graphics();
    // soft contact shadow, so tiles sit in the water rather than float on it
    g.ellipse(64, 108, 38, 10).fill({ color: 0x000000, alpha: 0.16 });
    recipe.draw(g);

    const texture = RenderTexture.create({ width: S, height: S, resolution, antialias: true });
    renderer.render({ container: g, target: texture, clear: true });
    g.destroy();
    return { texture, accent: recipe.accent };
  });
}

/** A small burst used when tiles clear. Drawn once, tinted per colour. */
export function buildSparkTexture(renderer: Renderer, resolution: number): Texture {
  const g = new Graphics();
  g.circle(16, 16, 14).fill(0xffffff);
  const texture = RenderTexture.create({ width: 32, height: 32, resolution, antialias: true });
  renderer.render({ container: g, target: texture, clear: true });
  g.destroy();
  return texture;
}

/**
 * The wild tile (Floating Petal). Drawn as a bubble holding every colour, so it
 * reads as "any of these" without needing a legend. Distinct in SHAPE too — the
 * only tile in the set with a ring — for the same colourblind reason as the
 * rest.
 */
export function buildWildArt(renderer: Renderer, resolution: number): TileArt {
  const g = new Graphics();
  g.ellipse(64, 108, 38, 10).fill({ color: 0x000000, alpha: 0.16 });
  g.circle(64, 64, 44).fill(0xfff3d6);
  g.circle(64, 64, 44).stroke({ width: 5, color: 0xc9a24a, alignment: 0 });
  RECIPES.forEach((recipe, i) => {
    const a = (i / RECIPES.length) * Math.PI * 2 - Math.PI / 2;
    g.circle(64 + Math.cos(a) * 24, 64 + Math.sin(a) * 24, 10).fill(recipe.accent);
  });
  g.circle(64, 64, 27).stroke({ width: 3, color: 0xc9a24a, alpha: 0.7 });

  const texture = RenderTexture.create({ width: S, height: S, resolution, antialias: true });
  renderer.render({ container: g, target: texture, clear: true });
  g.destroy();
  return { texture, accent: 0xf6e0a0 };
}

export const TILE_NAMES = RECIPES.map((r) => r.name);
