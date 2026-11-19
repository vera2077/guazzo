// Whole-rectangle source-over fill. This is the pure-math home of Edit ▸ Fill:
// the controller used to carry its own copy of the compositing loop, which
// meant the blend maths existed twice (and only one copy had tests).
import { compositePixel, type BlendMode } from "./blend.ts";
import { TILE, type TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export interface FillColor { r: number; g: number; b: number; a: number }
export interface FillRect { x: number; y: number; w: number; h: number }

export interface FillOptions {
  /** 0..1 multiplier on the colour's own alpha (Photoshop's fill opacity) */
  opacity?: number;
  /** restrict the fill to a selection: 0 skips, 255 fills fully */
  mask?: PixelMask | null;
  /** blend the fill onto the destination instead of replacing it */
  mode?: BlendMode;
}

/**
 * Fill `rect` (clipped to the grid) with `color`, source-over.
 * Returns the number of pixels touched — 0 means the fill was a no-op, which
 * lets the caller skip pushing an empty history entry.
 */
export function fillPlane(grid: TileGrid, rect: FillRect, color: FillColor, opts: FillOptions = {}): number {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(grid.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(grid.height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return 0;

  const opacity = Math.max(0, Math.min(1, opts.opacity ?? 1));
  const mask = opts.mask ?? null;
  const mode: BlendMode = opts.mode ?? "normal";
  // compositePixel takes source alpha in 0..255 and divides internally, so keep
  // this in 0..255 units rather than pre-normalising (that produced alpha 1/255).
  const sa = color.a * opacity;
  if (sa <= 0) return 0;

  const out = new Uint8ClampedArray(4);
  let touched = 0;

  grid.forEachTileInRect(x0, y0, x1 - x0, y1 - y0, (tile, cx, cy, cw, ch, bx, by) => {
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx;
        const gy = by + cy + yy;
        const ma = mask ? mask.alphaAt(gx, gy) / 255 : 1;
        if (ma <= 0) continue;
        const s = sa * ma;
        const o = (cy + yy) * TILE * 4 + (cx + xx) * 4;
        const da = tile.data[o + 3] ?? 0;
        compositePixel(
          mode,
          color.r, color.g, color.b, s,
          tile.data[o] ?? 0, tile.data[o + 1] ?? 0, tile.data[o + 2] ?? 0, da,
          out, 0, bx + cx + xx, by + cy + yy,
        );
        tile.data[o] = out[0] ?? 0;
        tile.data[o + 1] = out[1] ?? 0;
        tile.data[o + 2] = out[2] ?? 0;
        tile.data[o + 3] = out[3] ?? 0;
        touched++;
      }
    }
    tile.version++;
  }, true);

  return touched;
}
