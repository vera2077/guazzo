/** Patch: copy pixels from a source offset into the selected region, weighted
 *  by the selection's own alpha so a feathered edge stays feathered.
 *
 *  Photoshop's Patch drags a selection onto another part of the picture and
 *  blends the destination with the sampled source. The offset is the whole
 *  model: no content-aware search, no structure tensor — the user chooses the
 *  source by dragging, and this copies it. Stated in the options bar.
 */
import type { SelectionMask } from "./mask.ts";
import type { TileGrid } from "./tile.ts";

export interface PatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Does the slice of `buf` (stride `stride`, origin `ox,oy`) hold any alpha? */
function sliceHasAlpha(
  buf: Uint8ClampedArray, stride: number, ox: number, oy: number,
  x: number, y: number, w: number, h: number,
): boolean {
  for (let yy = 0; yy < h; yy++) {
    const row = ((y + yy - oy) * stride + (x - ox)) * 4;
    for (let xx = 0; xx < w; xx++) {
      if (buf[row + xx * 4 + 3] !== 0) return true;
    }
  }
  return false;
}

/** Returns the damaged rect, or null when the drag cannot move anything (zero
 *  offset, no selection, or a source that is entirely outside the canvas). */
export function patchFromOffset(
  grid: TileGrid,
  mask: SelectionMask | null,
  dx: number,
  dy: number,
): PatchRect | null {
  if (!mask || (dx === 0 && dy === 0)) return null;
  const r = mask.bbox();
  if (!r) return null;
  const { x, y, w, h } = r;
  const dest = new Uint8ClampedArray(w * h * 4);
  grid.readRect(x, y, w, h, dest);
  const src = new Uint8ClampedArray(w * h * 4);
  grid.readRect(x + dx, y + dy, w, h, src);
  let any = false;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      const cov = mask.alphaAt(x + xx, y + yy) / 255;
      if (cov <= 0) continue;
      // A transparent source pixel is not a colour to blend; keep the
      // destination as it was rather than painting a fringe of nothing.
      const sa = (src[i + 3]! / 255) * cov;
      if (sa <= 0) continue;
      any = true;
      // Source-over, alpha included. Blending only RGB left a patch onto a
      // transparent pixel with alpha 0: a history entry and a dirty document
      // for a change nobody can see.
      const da = (dest[i + 3]! / 255) * (1 - sa);
      const oa = sa + da;
      for (let c = 0; c < 3; c++) {
        dest[i + c] = Math.round((src[i + c]! * sa + dest[i + c]! * da) / (oa || 1));
      }
      dest[i + 3] = Math.round(oa * 255);
    }
  }
  if (!any) return null;
  // Write the rect tile by tile and skip slices that are still fully
  // transparent: writeRect materialises every tile it touches, which turned a
  // patch on a large selection into a fully tiled layer.
  const TILE = 256;
  for (let ty = y; ty < y + h; ty += TILE) {
    const th = Math.min(TILE, y + h - ty);
    for (let tx = x; tx < x + w; tx += TILE) {
      const tw = Math.min(TILE, x + w - tx);
      if (!sliceHasAlpha(dest, w, x, y, tx, ty, tw, th)) continue;
      const buf = new Uint8ClampedArray(tw * th * 4);
      for (let yy2 = 0; yy2 < th; yy2++) {
        const from = ((ty + yy2 - y) * w + (tx - x)) * 4;
        buf.set(dest.subarray(from, from + tw * 4), yy2 * tw * 4);
      }
      grid.writeRect(tx, ty, tw, th, buf);
    }
  }
  return r;
}
