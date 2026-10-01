/**
 * A tiny promise-based tween driven off Pixi's ticker.
 *
 * The board's animation is a sequence — swap, pop, fall, refill, next cascade —
 * so it is written as `await` steps rather than a state machine. No tween
 * library: this is ~60 lines and one dependency is enough.
 */
import { Ticker } from "pixi.js";

export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;
export const easeOut: Easing = (t) => 1 - (1 - t) ** 3;
export const easeIn: Easing = (t) => t * t * t;
export const easeInOut: Easing = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoots and settles — the squash-on-land feel. */
export const easeBack: Easing = (t) => {
  const c = 1.70158 + 1;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};
/** Fast out, small bounce at the end. Used for tiles dropping into place. */
export const easeLand: Easing = (t) => {
  if (t < 0.72) return easeIn(t / 0.72) * 1.06;
  const k = (t - 0.72) / 0.28;
  return 1.06 - 0.06 * (1 - (1 - k) ** 2);
};

let ticker: Ticker | null = null;
export function useTicker(t: Ticker): void {
  ticker = t;
}

/** Runs `apply(progress)` for `ms`, resolving when it finishes. */
export function animate(ms: number, apply: (t: number) => void, ease: Easing = linear): Promise<void> {
  if (ms <= 0 || !ticker) {
    apply(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let elapsed = 0;
    const t = ticker!;
    const step = (): void => {
      elapsed += t.deltaMS;
      const p = Math.min(1, elapsed / ms);
      apply(ease(p));
      if (p >= 1) {
        t.remove(step);
        resolve();
      }
    };
    t.add(step);
  });
}

export interface Point {
  x: number;
  y: number;
}

/** Moves an object from wherever it is to `to`. */
export function moveTo(
  obj: { x: number; y: number },
  to: Point,
  ms: number,
  ease: Easing = easeOut,
): Promise<void> {
  const from = { x: obj.x, y: obj.y };
  return animate(
    ms,
    (t) => {
      obj.x = from.x + (to.x - from.x) * t;
      obj.y = from.y + (to.y - from.y) * t;
    },
    ease,
  );
}

export const wait = (ms: number): Promise<void> => animate(ms, () => {});
