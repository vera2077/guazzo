/**
 * historybrush.ts — History Brush dab: restore pixels from a raster snapshot
 * captured earlier in the document's life.
 *
 * A dab is a soft circular disc (the same hardness convention as paint.ts:
 * hardness 1 is a crisp edge, hardness 0 falls off across the whole radius).
 * Inside the disc, destination pixels are replaced by the snapshot's pixels,
 * blended by opacity and by selection-mask coverage — the same
 * "blend the result toward the untouched destination" rule engine filters use.
 * Purely deterministic: no noise, no dither, no randomness.
 */

import { TileGrid, TILE } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

/** A full-document, straight-RGBA copy of a grid (row-major, top-left origin). */
export interface RasterSnapshot {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const hbClamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Copy the whole grid into a deterministic, detached RGBA snapshot. */
export function captureRaster(grid: TileGrid): RasterSnapshot {
  const data = new Uint8ClampedArray(grid.width * grid.height * 4);
  // neutral 0: unallocated tiles read as fully transparent, never stale bytes
  grid.readRect(0, 0, grid.width, grid.height, data, 0);
  return { width: grid.width, height: grid.height, data };
}

/**
 * Stamp one history dab at doc coordinate (x,y). Source pixels replace
 * destination pixels; opacity and mask coverage scale that replacement.
 * Clipped to grid bounds, the snapshot's bounds and an optional rect.
 */
export function paintHistoryDab(
  grid: TileGrid,
  src: RasterSnapshot,
  x: number,
  y: number,
  radius: number,
  hardness: number,
  opacity: number,
  mask?: PixelMask | null,
  clip?: { x: number; y: number; w: number; h: number } | null,
): void {
  const op = hbClamp01(opacity);
  if (op <= 0) return; // opacity 0 is an exact no-op
  if (src.width <= 0 || src.height <= 0 || src.data.length < src.width * src.height * 4) return;

  const r = Math.max(0.5, radius);
  const hard = hbClamp01(hardness);
  const inner = r * hard; // solid core radius (hardness 1 → no falloff band)
  const band = r - inner;
  const r2 = r * r;
  const inner2 = inner * inner;

  const x0 = Math.max(0, Math.floor(x - r));
  const y0 = Math.max(0, Math.floor(y - r));
  const x1 = Math.min(grid.width, Math.ceil(x + r) + 1);
  const y1 = Math.min(grid.height, Math.ceil(y + r) + 1);
  if (x0 >= x1 || y0 >= y1) return; // fully off-canvas

  grid.forEachTileInRect(x0, y0, x1 - x0, y1 - y0, (tile, cx, cy, cw, ch, bx, by) => {
    const d = tile.data;
    let touched = false;
    for (let yy = 0; yy < ch; yy++) {
      const docY = by + cy + yy;
      for (let xx = 0; xx < cw; xx++) {
        const docX = bx + cx + xx;
        if (docX >= src.width || docY >= src.height) continue; // no source here
        if (clip && (docX < clip.x || docY < clip.y || docX >= clip.x + clip.w || docY >= clip.y + clip.h)) continue;
        const dx = docX - x, dy = docY - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue; // outside the disc

        let coverage: number;
        if (hard >= 1 || band <= 0 || d2 <= inner2) {
          coverage = 1;
        } else {
          const t = 1 - (Math.sqrt(d2) - inner) / band;
          coverage = t * t * (3 - 2 * t); // smoothstep falloff
        }
        if (coverage <= 0) continue;

        const ma = mask ? mask.alphaAt(docX, docY) : 255;
        if (ma <= 0) continue;
        const mk = ma >= 255 ? 1 : ma / 255;
        const a = coverage * op * mk;
        if (a <= 0) continue;

        const tp = ((cy + yy) * TILE + cx + xx) * 4;
        const sp = (docY * src.width + docX) * 4;
        // Straight RGBA interpolation, alpha included: opacity/mask 1 copies
        // the source byte-for-byte (including its alpha), 0 leaves dst alone.
        for (let c = 0; c < 4; c++) {
          const dv = d[tp + c]!;
          d[tp + c] = dv + (src.data[sp + c]! - dv) * a;
        }
        touched = true;
      }
    }
    if (touched) tile.version++;
  }, true);
}
