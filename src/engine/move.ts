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
  /** bbox of the non-transparent pixels, or null when the layer is empty */
  bounds: { x: number; y: number; w: number; h: number } | null;
}

/** bbox of the pixels with alpha > 0, in whole pixels */
function contentBounds(data: Uint8ClampedArray, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** whole-layer snapshot (document-sized RGBA buffer) */
export function snapshotGrid(grid: TileGrid): GridSnapshot {
  const w = grid.width, h = grid.height;
  const data = new Uint8ClampedArray(w * h * 4);
  grid.readRect(0, 0, w, h, data);
  return { w, h, data, bounds: contentBounds(data, w, h) };
}

let moveScratch: Uint8ClampedArray | null = null;

/**
 * Rewrite the layer as `snap` translated by (dx,dy). When a mask is given,
 * pixels inside the mask move and everything else stays put.
 *
 * Perf: only the union of the content's old and new rectangles is touched. The
 * old version cleared and rewrote the whole canvas on every pointermove (three
 * full passes plus a full-canvas fill: ~1 GB of writes per event at 16384²) to
 * move a layer that is usually a fraction of the canvas. `clearAllocated()`
 * first, then one rectangle: everything outside the union is transparent in both
 * the source and the result, so not writing it is the same as writing zeros.
 */
export function applyLayerMove(
  grid: TileGrid,
  snap: GridSnapshot,
  dx: number,
  dy: number,
  mask?: PixelMask | null,
): void {
  const w = snap.w, h = snap.h, src = snap.data;
  const b = snap.bounds;
  grid.clearAllocated();
  if (!b) return;

  // union of "where the content was" and "where it lands", clamped to the canvas
  const x0 = Math.max(0, Math.min(b.x, b.x + dx));
  const y0 = Math.max(0, Math.min(b.y, b.y + dy));
  const x1 = Math.min(w - 1, Math.max(b.x + b.w - 1, b.x + b.w - 1 + dx));
  const y1 = Math.min(h - 1, Math.max(b.y + b.h - 1, b.y + b.h - 1 + dy));
  if (x1 < x0 || y1 < y0) return;

  const uw = x1 - x0 + 1;
  const uh = y1 - y0 + 1;
  const need = uw * uh * 4;
  // reusable scratch: a Move drag calls this per pointermove. Single UI thread,
  // never re-entrant, so a module scratch is safe (a fresh buffer per event was
  // ~67 MB at 4096² before it was hoisted).
  if (moveScratch === null || moveScratch.length < need) moveScratch = new Uint8ClampedArray(need);
  const out = moveScratch.subarray(0, need);
  out.fill(0);

  for (let gy = y0; gy <= y1; gy++) {
    const sy = gy - dy;
    const destRow = (gy - y0) * uw;
    for (let gx = x0; gx <= x1; gx++) {
      const sx = gx - dx;
      const di = (destRow + (gx - x0)) * 4;
      if (sx >= b.x && sx < b.x + b.w && sy >= b.y && sy < b.y + b.h) {
        if (!mask || mask.alphaAt(sx, sy) !== 0) {
          const sp = (sy * w + sx) * 4;
          if (src[sp + 3] !== 0) {
            out[di] = src[sp]!;
            out[di + 1] = src[sp + 1]!;
            out[di + 2] = src[sp + 2]!;
            out[di + 3] = src[sp + 3]!;
            continue;
          }
        }
      }
      // pixels outside the selection stay put; they are all inside the snapshot
      // bbox when they carry anything, which is why the union covers them
      if (mask && mask.alphaAt(gx, gy) === 0) {
        const sp = (gy * w + gx) * 4;
        out[di] = src[sp]!;
        out[di + 1] = src[sp + 1]!;
        out[di + 2] = src[sp + 2]!;
        out[di + 3] = src[sp + 3]!;
      }
    }
  }

  grid.writeRect(x0, y0, uw, uh, out);
}
