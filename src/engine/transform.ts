/**
 * transform.ts — Free Transform engine: affine rotate/scale/translate of a
 * whole layer with bilinear sampling. Pure tile-grid code, no DOM.
 *
 * Convention: the layer content rotates and scales around its allocated-tile
 * bounding-box center, then translates by (dx, dy) in doc pixels.
 */
import { TILE, TileGrid } from "./tile.ts";
import { emptySample, samplePremul, straightRGB } from "./sample.ts";
import type { Layer } from "./document.ts";
import { recipeAfterTransform } from "./textmap.ts";

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
  const bb = gridBBox(layer.grid);
  transformGrid(layer.grid, s);
  if (layer.mask) {
    // The mask belongs to the pixels: same centre, and an empty tile means
    // "hidden" on a hide mask, so the vacated footprint must be filled with
    // 255 stored, not 0.
    transformGrid(layer.mask, s, {
      centre: bb ? { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 } : undefined,
      empty: layer.maskHide ? 255 : 0,
    });
  }
  if (layer.textData) {
    // AP5: Free Transform used to move the pixels and leave the recipe at the
    // old place. Translate/scale travel; a rotation drops it (see textmap.ts).
    const centre = bb ? { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 } : null;
    layer.textData = recipeAfterTransform(layer.textData, s, centre);
  }
}

/**
 * Transform one grid in place (shared by pixel grids and masks).
 *
 * `opts.centre` lets a mask rotate around the *pixels'* centre rather than its
 * own bbox, and `opts.empty` is the value written into the vacated footprint:
 * 0 for a pixel grid (transparent) and 255 for a hide mask (hidden).
 */
export function transformGrid(
  grid: TileGrid,
  s: TransformSpec,
  opts: {
    centre?: { x: number; y: number } | undefined;
    empty?: number;
    /** source rect to transform, when it is tighter than the tile bbox */
    bbox?: { x: number; y: number; w: number; h: number } | undefined;
  } = {},
): void {
  const bb = opts.bbox ?? gridBBox(grid);
  if (!bb || bb.w < 1 || bb.h < 1) return;
  const src = new Uint8ClampedArray(bb.w * bb.h * 4);
  grid.readRect(bb.x, bb.y, bb.w, bb.h, src);
  const rad = (s.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = opts.centre?.x ?? bb.x + bb.w / 2;
  const cy = opts.centre?.y ?? bb.y + bb.h / 2;
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
  const empty = opts.empty ?? 0;
  grid.fillRect(bb.x, bb.y, bb.w, bb.h, [empty, empty, empty, empty === 0 ? 0 : 255]);
  if (dx1 <= dx0 || dy1 <= dy0) {
    // The vacated footprint is still allocated but fully `empty`; leaving it
    // would widen gridBBox and inflate projectTileCount() toward the cap.
    grid.releaseEmptyTiles(empty);
    return;
  }

  const dw = dx1 - dx0, dh = dy1 - dy0;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const smp = emptySample();
  const rgb3 = new Float32Array(3);
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
      // outside the source is transparent, not repeated edge: no halo either way
      samplePremul(src, bb.w, bb.h, fx, fy, smp, false);
      const o = (py * dw + px) * 4;
      if (smp.a > 0) {
        straightRGB(smp, rgb3);
        out[o] = rgb3[0]!;
        out[o + 1] = rgb3[1]!;
        out[o + 2] = rgb3[2]!;
      }
      out[o + 3] = smp.a * 255;
    }
  }
  grid.writeRect(dx0, dy0, dw, dh, out);
  // fillRect + writeRect leave fully-empty tiles in the swept union (e.g. a
  // mask moved across a tile boundary). Such a tile is equivalent to an
  // unallocated one; release it so the grid stays sparse. Use the SAME `empty`
  // as the fill: 0 for pixels / reveal masks, 255 for hide masks (all-255 =
  // hidden = unallocated). Byte-visible output is unchanged — an empty tile
  // and a missing tile read identically.
  grid.releaseEmptyTiles(empty);
}
