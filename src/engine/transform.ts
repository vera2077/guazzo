/**
 * transform.ts — Free Transform engine: affine rotate/scale/translate of a
 * whole layer with bilinear sampling. Pure tile-grid code, no DOM.
 *
 * Convention: the layer content rotates and scales around its allocated-tile
 * bounding-box center, then translates by (dx, dy) in doc pixels.
 */
import { TILE, TileGrid } from "./tile.ts";
import type { Layer } from "./document.ts";

export interface TransformSpec {
  angleDeg: number;
  scaleX: number;
  scaleY: number;
  dx: number;
  dy: number;
}

/** bounding box (doc coords) covering all ALLOCATED tiles, clamped to grid */
export function gridBBox(grid: TileGrid): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  grid.forEachTile((_t, tx, ty) => {
    minX = Math.min(minX, tx * TILE);
    minY = Math.min(minY, ty * TILE);
    maxX = Math.max(maxX, Math.min((tx + 1) * TILE, grid.width));
    maxY = Math.max(maxY, Math.min((ty + 1) * TILE, grid.height));
  });
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Apply a transform to the layer IN PLACE — pixels AND layer mask:
 * clear the original bbox, then write the resampled result. A mask must
 * follow its layer or a rotated layer "loses" its mask coverage.
 */
export function transformLayer(layer: Layer, s: TransformSpec): void {
  transformGrid(layer.grid, s);
  if (layer.mask) transformGrid(layer.mask, s);
}

/** transform one grid in place (shared by pixel grids and masks) */
export function transformGrid(grid: TileGrid, s: TransformSpec): void {
  const bb = gridBBox(grid);
  if (!bb || bb.w < 1 || bb.h < 1) return;
  const src = new Uint8ClampedArray(bb.w * bb.h * 4);
  grid.readRect(bb.x, bb.y, bb.w, bb.h, src);
  const rad = (s.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
  const sx = s.scaleX === 0 ? 0.0001 : s.scaleX;
  const sy = s.scaleY === 0 ? 0.0001 : s.scaleY;

  // destination bbox: rotate the scaled corners around the center, translate
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [rx0, ry0] of [[-bb.w / 2, -bb.h / 2], [bb.w / 2, -bb.h / 2], [bb.w / 2, bb.h / 2], [-bb.w / 2, bb.h / 2]] as const) {
    const px = rx0 * sx, py = ry0 * sy;
    const wx = px * cos - py * sin + cx + s.dx;
    const wy = px * sin + py * cos + cy + s.dy;
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
  }
  const dx0 = Math.max(0, Math.floor(minX)), dy0 = Math.max(0, Math.floor(minY));
  const dx1 = Math.min(grid.width, Math.ceil(maxX)), dy1 = Math.min(grid.height, Math.ceil(maxY));

  // erase the original footprint first (fillRect writes rgba incl. alpha)
  grid.fillRect(bb.x, bb.y, bb.w, bb.h, [0, 0, 0, 0]);
  if (dx1 <= dx0 || dy1 <= dy0) return;

  const dw = dx1 - dx0, dh = dy1 - dy0;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let py = 0; py < dh; py++) {
    for (let px = 0; px < dw; px++) {
      // dest pixel center → doc coords
      const wx = dx0 + px + 0.5 - cx - s.dx;
      const wy = dy0 + py + 0.5 - cy - s.dy;
      // inverse rotate (by -rad), inverse scale
      const ux = (wx * cos + wy * sin) / sx + cx;
      const uy = (-wx * sin + wy * cos) / sy + cy;
      // bilinear sample at (ux, uy); src pixel (i,j) center sits at i+0.5
      const fx = ux - bb.x - 0.5, fy = uy - bb.y - 0.5;
      const i0 = Math.floor(fx), j0 = Math.floor(fy);
      const tx = fx - i0, ty = fy - j0;
      const i1 = i0 + 1, j1 = j0 + 1;
      const inside = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < bb.w && j < bb.h;
      const at = (i: number, j: number): number => inside(i, j) ? (j * bb.w + i) * 4 : -1;
      const p00 = at(i0, j0), p10 = at(i1, j0), p01 = at(i0, j1), p11 = at(i1, j1);
      // premultiplied bilinear (transparent black outside → no halo)
      const w00 = p00 >= 0 ? (1 - tx) * (1 - ty) : 0;
      const w10 = p10 >= 0 ? tx * (1 - ty) : 0;
      const w01 = p01 >= 0 ? (1 - tx) * ty : 0;
      const w11 = p11 >= 0 ? tx * ty : 0;
      let r = 0, g = 0, b = 0, a = 0;
      if (p00 >= 0) { const al = src[p00 + 3]! / 255; r += w00 * src[p00]! * al; g += w00 * src[p00 + 1]! * al; b += w00 * src[p00 + 2]! * al; a += w00 * al; }
      if (p10 >= 0) { const al = src[p10 + 3]! / 255; r += w10 * src[p10]! * al; g += w10 * src[p10 + 1]! * al; b += w10 * src[p10 + 2]! * al; a += w10 * al; }
      if (p01 >= 0) { const al = src[p01 + 3]! / 255; r += w01 * src[p01]! * al; g += w01 * src[p01 + 1]! * al; b += w01 * src[p01 + 2]! * al; a += w01 * al; }
      if (p11 >= 0) { const al = src[p11 + 3]! / 255; r += w11 * src[p11]! * al; g += w11 * src[p11 + 1]! * al; b += w11 * src[p11 + 2]! * al; a += w11 * al; }
      const o = (py * dw + px) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a * 255;
      }
    }
  }
  grid.writeRect(dx0, dy0, dw, dh, out);
}
