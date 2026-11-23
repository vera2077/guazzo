/**
 * colourreplace.ts — the Colour Replacement brush's engine half.
 *
 * Photoshop's tool replaces hue and saturation while keeping the pixel's
 * luminosity. Implementing that literally means an HSL round trip per pixel;
 * what actually matters to the user is that a red object becomes green at the
 * same brightness, so this keeps luma and scales the replacement colour to it.
 * The difference from a true HSL swap is visible only on saturated ramps,
 * which is stated in the options bar rather than hidden.
 */

import type { TileGrid } from "./tile.ts";
import type { BgTarget } from "./bgerase.ts";
import type { PixelMask } from "./mask.ts";

export interface ReplaceColourOptions {
  radius: number;
  /** 0 = soft feathered rim, 1 = crisp disc edge */
  hardness: number;
  /** the colour being replaced (sampled from the layer at stroke start) */
  target: BgTarget;
  /** maximum per-channel difference that still counts as the target colour */
  tolerance: number;
  /** the colour laid down in its place */
  colour: BgTarget;
  clip?: { x: number; y: number; w: number; h: number };
  mask?: PixelMask | null;
}

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Replace the target colour under one dab, keeping each pixel's luminosity.
 * Returns the touched rect, or null when nothing matched.
 */
export function replaceColourDab(
  grid: TileGrid,
  x: number,
  y: number,
  o: ReplaceColourOptions,
): { x: number; y: number; w: number; h: number } | null {
  const r = Math.max(1, o.radius);
  const x0 = Math.max(0, Math.floor(x - r));
  const y0 = Math.max(0, Math.floor(y - r));
  const x1 = Math.min(grid.width - 1, Math.ceil(x + r));
  const y1 = Math.min(grid.height - 1, Math.ceil(y + r));
  if (x1 < x0 || y1 < y0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = new Uint8ClampedArray(w * h * 4);
  grid.readRect(x0, y0, w, h, buf);
  const inner = r * Math.max(0, Math.min(1, o.hardness));
  const [tr, tg, tb] = o.target;
  const [cr, cg, cb] = o.colour;
  const targetLuma = Math.max(1, luma(cr, cg, cb));
  let touched = false;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      const a = buf[i + 3]!;
      if (a === 0) continue;
      const gx = x0 + xx, gy = y0 + yy;
      if (o.clip && (gx < o.clip.x || gy < o.clip.y || gx >= o.clip.x + o.clip.w || gy >= o.clip.y + o.clip.h)) continue;
      if (o.mask && o.mask.alphaAt(gx, gy) === 0) continue;
      const dx = gx + 0.5 - x, dy = gy + 0.5 - y;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const diff = Math.max(Math.abs(buf[i]! - tr), Math.abs(buf[i + 1]! - tg), Math.abs(buf[i + 2]! - tb));
      if (diff > o.tolerance) continue;
      const cov = d <= inner ? 1 : 1 - (d - inner) / Math.max(0.0001, r - inner);
      if (cov <= 0) continue;
      const scale = luma(buf[i]!, buf[i + 1]!, buf[i + 2]!) / targetLuma;
      const nr = Math.min(255, Math.round(cr * scale));
      const ng = Math.min(255, Math.round(cg * scale));
      const nb = Math.min(255, Math.round(cb * scale));
      buf[i] = Math.round(buf[i]! + (nr - buf[i]!) * cov);
      buf[i + 1] = Math.round(buf[i + 1]! + (ng - buf[i + 1]!) * cov);
      buf[i + 2] = Math.round(buf[i + 2]! + (nb - buf[i + 2]!) * cov);
      touched = true;
    }
  }
  if (!touched) return null;
  grid.writeRect(x0, y0, w, h, buf);
  return { x: x0, y: y0, w, h };
}
