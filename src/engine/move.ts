/**
 * move.ts — the Move tool's pixel plumbing.
 *
 * Dragging a layer must never lose pixels: repeatedly shifting the tiles
 * would shave content off at the edges each time. So the drag takes ONE
 * snapshot of the layer before it starts and re-derives the layer from
 * that snapshot for every mouse position (absolute offset, not deltas).
 *
 * With an active selection only the selected pixels travel; the hole they
 * leave behind keeps whatever was outside the selection, which is what
 * Photoshop's Move tool does inside a single layer.
 */

import { TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export interface GridSnapshot {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** whole-layer snapshot (document-sized RGBA buffer) */
export function snapshotGrid(grid: TileGrid): GridSnapshot {
  const w = grid.width, h = grid.height;
  const data = new Uint8ClampedArray(w * h * 4);
  grid.readRect(0, 0, w, h, data);
  return { w, h, data };
}

/**
 * Rewrite the layer as `snap` translated by (dx,dy). When a mask is given,
 * pixels inside the mask move and everything else stays put.
 */
export function applyLayerMove(
  grid: TileGrid,
  snap: GridSnapshot,
  dx: number,
  dy: number,
  mask?: PixelMask | null,
): void {
  const w = snap.w, h = snap.h, src = snap.data;
  const out = new Uint8ClampedArray(w * h * 4);

  if (mask) {
    // pixels outside the selection are untouched by the drag
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask.alphaAt(x, y) === 0) {
          const p = (y * w + x) * 4;
          out[p] = src[p]!;
          out[p + 1] = src[p + 1]!;
          out[p + 2] = src[p + 2]!;
          out[p + 3] = src[p + 3]!;
        }
      }
    }
  }

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < w; x++) {
      if (mask && mask.alphaAt(x, y) === 0) continue; // stays put (copied above)
      const tx = x + dx;
      if (tx < 0 || tx >= w) continue;
      const sp = (y * w + x) * 4;
      if (src[sp + 3] === 0) continue; // nothing to carry
      const dp = (ty * w + tx) * 4;
      out[dp] = src[sp]!;
      out[dp + 1] = src[sp + 1]!;
      out[dp + 2] = src[sp + 2]!;
      out[dp + 3] = src[sp + 3]!;
    }
  }

  // the writable window is the bbox of everything that survived, so the
  // stationary pixels outside the selection are written back too
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (out[(y * w + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }

  grid.clearAllocated();
  if (x1 >= x0 && y1 >= y0) {
    grid.writeRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1, subRect(out, w, x0, y0, x1 - x0 + 1, y1 - y0 + 1));
  }
}

/** extract a w×h window from a full-document RGBA buffer */
function subRect(
  buf: Uint8ClampedArray,
  bufW: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * bufW + x) * 4;
    out.set(buf.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}
