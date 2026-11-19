/**
 * adjust.ts — per-pixel adjustment operations (Image > Adjustments).
 *
 * Pure pixel math applied in place over the allocated tiles of a rect.
 * Deliberately simple: 8-bit sRGB, no ICC, alpha always preserved.
 * Non-destructive adjustment LAYERS come later (Phase 2).
 */

import { TILE, type TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export type AdjustmentKind =
  | "brightness"
  | "contrast"
  | "saturation"
  | "hue"
  | "invert"
  | "grayscale"
  | "posterize"
  | "threshold";

export interface Adjustment {
  kind: AdjustmentKind;
  /**
   * brightness: -255..255 add
   * contrast:   -100..100 (f = (100+a)/100, pivot 128; -100 → flat gray)
   * saturation: -100..100 (s = 1 + a/100; -100 → grayscale)
   * hue:        -180..180 degree rotation (achromatic pixels untouched)
   * posterize:  levels 2..255
   * threshold:  cutoff 0..255 on luminance (>= cutoff → white)
   */
  amount: number;
}

// luminance weights — matches blend.ts
const LR = 0.3, LG = 0.59, LB = 0.11;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** rgb (0..255) → hsl (h 0..360, s 0..1, l 0..1) */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const h6 = h / 360;
  return [
    hue2rgb(p, q, h6 + 1 / 3) * 255,
    hue2rgb(p, q, h6) * 255,
    hue2rgb(p, q, h6 - 1 / 3) * 255,
  ];
}

/** transform one pixel in place; d = pixel buffer, i = byte offset */
function adjustPixel(d: Uint8ClampedArray, i: number, kind: AdjustmentKind, amount: number): void {
  const r = d[i] as number, g = d[i + 1] as number, b = d[i + 2] as number;
  switch (kind) {
    case "brightness": {
      d[i] = clamp255(r + amount);
      d[i + 1] = clamp255(g + amount);
      d[i + 2] = clamp255(b + amount);
      break;
    }
    case "contrast": {
      const f = Math.max(0, (100 + amount) / 100);
      d[i] = clamp255((r - 128) * f + 128);
      d[i + 1] = clamp255((g - 128) * f + 128);
      d[i + 2] = clamp255((b - 128) * f + 128);
      break;
    }
    case "saturation": {
      const s = 1 + amount / 100;
      const lum = LR * r + LG * g + LB * b;
      d[i] = clamp255(lum + (r - lum) * s);
      d[i + 1] = clamp255(lum + (g - lum) * s);
      d[i + 2] = clamp255(lum + (b - lum) * s);
      break;
    }
    case "hue": {
      const [h, s, l] = rgbToHsl(r, g, b);
      if (s === 0) return; // achromatic stays achromatic
      const [nr, ng, nb] = hslToRgb((h + amount % 360 + 360) % 360, s, l);
      d[i] = nr;
      d[i + 1] = ng;
      d[i + 2] = nb;
      break;
    }
    case "invert": {
      d[i] = 255 - r;
      d[i + 1] = 255 - g;
      d[i + 2] = 255 - b;
      break;
    }
    case "grayscale": {
      const lum = LR * r + LG * g + LB * b;
      d[i] = lum;
      d[i + 1] = lum;
      d[i + 2] = lum;
      break;
    }
    case "posterize": {
      const levels = Math.min(255, Math.max(2, Math.round(amount)));
      const step = 255 / (levels - 1);
      d[i] = Math.round(r / step) * step;
      d[i + 1] = Math.round(g / step) * step;
      d[i + 2] = Math.round(b / step) * step;
      break;
    }
    case "threshold": {
      const v = LR * r + LG * g + LB * b >= amount ? 255 : 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      break;
    }
  }
}

/**
 * Apply an adjustment to the allocated tiles inside rect (x,y,w,h).
 * Never allocates tiles; unallocated space is untouched (stays transparent).
 * A selection mask blends each pixel between original and adjusted by its
 * value (255 = fully adjusted, 0 = untouched).
 */
export function applyAdjustment(
  grid: TileGrid,
  x: number, y: number, w: number, h: number,
  adj: Adjustment,
  mask?: PixelMask,
): void {
  grid.forEachTileInRect(x, y, w, h, (t, cx, cy, cw, ch, bx, by) => {
    const d = t.data;
    for (let yy = 0; yy < ch; yy++) {
      const row = ((cy + yy) * TILE + cx) * 4;
      for (let xx = 0; xx < cw; xx++) {
        const i = row + xx * 4;
        if (!mask) {
          adjustPixel(d, i, adj.kind, adj.amount);
          continue;
        }
        const ma = mask.alphaAt(bx + cx + xx, by + cy + yy);
        if (ma === 0) continue;
        if (ma === 255) {
          adjustPixel(d, i, adj.kind, adj.amount);
          continue;
        }
        const r0 = d[i]!, g0 = d[i + 1]!, b0 = d[i + 2]!;
        adjustPixel(d, i, adj.kind, adj.amount);
        const k = ma / 255;
        d[i] = r0 + ((d[i]! - r0) * k);
        d[i + 1] = g0 + ((d[i + 1]! - g0) * k);
        d[i + 2] = b0 + ((d[i + 2]! - b0) * k);
      }
    }
    t.version++;
  }, false);
}
