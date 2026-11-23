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
      if (src[i + 3] === 0) continue;
      any = true;
      for (let c = 0; c < 3; c++) {
        dest[i + c] = Math.round(src[i + c]! * cov + dest[i + c]! * (1 - cov));
      }
    }
  }
  if (!any) return null;
  grid.writeRect(x, y, w, h, dest);
  return r;
}
