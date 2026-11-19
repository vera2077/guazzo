/**
 * Flood-based tools: Magic Wand (colour selection) and Paint Bucket (fill).
 *
 * Both share one primitive — a per-pixel "is this pixel part of the region?"
 * map grown either contiguously (4-neighbour flood from the seed, like
 * Photoshop's default) or globally (every similar pixel in the layer).
 */

import { type TileGrid } from "./tile.ts";
import { SelectionMask, type PixelMask } from "./mask.ts";

export interface RegionOptions {
  /** Per-channel colour distance allowed, 0..255 (Photoshop's tolerance). */
  tolerance?: number;
  /** Grow through neighbours (true, default) or match the whole layer (false). */
  contiguous?: boolean;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Read an entire layer into a w*h RGBA buffer (transparent outside the canvas). */
/** Full-document RGBA sample. Allocated once per user CLICK (wand/bucket),
 * not per pointermove — acceptable one-shot cost; the move-drag hot path
 * reuses a scratch in move.ts instead (handoff-2 N rationale). */
export function sampleGrid(grid: TileGrid, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  grid.readRect(0, 0, w, h, out);
  return out;
}

/**
 * Mark every pixel similar to the seed at (sx, sy).
 * Returns a w*h map of 0/1 plus the number of matched pixels.
 */
export function regionMap(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  opts: RegionOptions = {},
): { map: Uint8Array; count: number } {
  const tolerance = Math.max(0, Math.min(255, Math.round(opts.tolerance ?? 32)));
  const contiguous = opts.contiguous !== false;
  const map = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { map, count: 0 };

  const seed = (sy * w + sx) * 4;
  const sr = px[seed] ?? 0, sg = px[seed + 1] ?? 0, sb = px[seed + 2] ?? 0, sa = px[seed + 3] ?? 0;

  const like = (i: number): boolean => {
    const o = i * 4;
    const a = px[o + 3] ?? 0;
    // transparent pixels carry no colour: they match other transparent pixels
    if (sa === 0) return a === 0;
    if (a === 0) return false;
    if (Math.abs(a - sa) > tolerance) return false;
    return (
      Math.abs((px[o] ?? 0) - sr) <= tolerance &&
      Math.abs((px[o + 1] ?? 0) - sg) <= tolerance &&
      Math.abs((px[o + 2] ?? 0) - sb) <= tolerance
    );
  };

  let count = 0;
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) {
      if (like(i)) { map[i] = 1; count++; }
    }
    return { map, count };
  }

  const stack = new Int32Array(w * h);
  let top = 0;
  const start = sy * w + sx;
  if (!like(start)) return { map, count: 0 };
  map[start] = 1;
  stack[top++] = start;
  count = 1;
  while (top > 0) {
    const i = stack[--top]!;
    const x = i % w, y = (i - x) / w;
    // 4-neighbour flood
    if (x > 0) { const n = i - 1; if (map[n] === 0 && like(n)) { map[n] = 1; count++; stack[top++] = n; } }
    if (x < w - 1) { const n = i + 1; if (map[n] === 0 && like(n)) { map[n] = 1; count++; stack[top++] = n; } }
    if (y > 0) { const n = i - w; if (map[n] === 0 && like(n)) { map[n] = 1; count++; stack[top++] = n; } }
    if (y < h - 1) { const n = i + w; if (map[n] === 0 && like(n)) { map[n] = 1; count++; stack[top++] = n; } }
  }
  return { map, count };
}

/** Bounding box of the marked pixels in a region map. */
export function regionBBox(map: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map[y * w + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Magic Wand: turn the region under (x, y) into a selection mask.
 * `antialias` gives boundary pixels a half-selected edge so feathering and
 * marching ants look right instead of stair-stepping.
 */
export function magicWand(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  opts: RegionOptions & { antialias?: boolean } = {},
): { mask: SelectionMask; bbox: { x: number; y: number; w: number; h: number } } | null {
  const { map, count } = regionMap(px, w, h, x, y, opts);
  if (count === 0) return null;
  const mask = new SelectionMask(w, h);
  const antialias = opts.antialias !== false;

  // hard core
  for (let i = 0; i < map.length; i++) {
    if (map[i] === 1) mask.setAlpha(i % w, (i - (i % w)) / w, 255);
  }
  if (antialias) {
    // one-pixel soft fringe: unmatched neighbours touching a matched pixel
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = yy * w + xx;
        if (map[i] === 1) continue;
        const near =
          (xx > 0 && map[i - 1] === 1) ||
          (xx < w - 1 && map[i + 1] === 1) ||
          (yy > 0 && map[i - w] === 1) ||
          (yy < h - 1 && map[i + w] === 1);
        if (near) mask.setAlpha(xx, yy, 128);
      }
    }
  }
  const bbox = regionBBox(map, w, h);
  return bbox ? { mask, bbox } : null;
}

/**
 * Paint Bucket: flood the region under (x, y) on a layer and fill it with
 * `color`, blending source-over so soft selections fade instead of cutting.
 * Returns the affected rect, or null when nothing was painted.
 */
export function floodFill(
  grid: TileGrid,
  x: number,
  y: number,
  color: RGBA,
  opts: RegionOptions & { mask?: PixelMask | null } = {},
): { x: number; y: number; w: number; h: number } | null {
  const w = grid.width, h = grid.height;
  const px = sampleGrid(grid, w, h);
  const { map, count } = regionMap(px, w, h, x, y, opts);
  if (count === 0) return null;
  const mask = opts.mask ?? null;

  const out = px.slice();
  const sr = color.r, sg = color.g, sb = color.b;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      if (map[i] !== 1) continue;
      const ma = mask ? mask.alphaAt(xx, yy) : 255;
      if (ma === 0) continue;
      const as = (color.a / 255) * (ma / 255);
      if (as <= 0) continue;
      const o = i * 4;
      const ad = (out[o + 3] ?? 0) / 255;
      const ao = as + ad * (1 - as);
      const inv = ad * (1 - as);
      out[o] = ((sr * as + (out[o] ?? 0) * inv) / ao) || 0;
      out[o + 1] = ((sg * as + (out[o + 1] ?? 0) * inv) / ao) || 0;
      out[o + 2] = ((sb * as + (out[o + 2] ?? 0) * inv) / ao) || 0;
      out[o + 3] = Math.round(ao * 255);
    }
  }
  const bbox = regionBBox(map, w, h);
  if (!bbox) return null;
  grid.writeRect(bbox.x, bbox.y, bbox.w, bbox.h, writeRegion(out, w, bbox));
  return bbox;
}

/** Copy a sub-rect out of a full-canvas RGBA buffer. */
function writeRegion(src: Uint8ClampedArray, srcW: number, r: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let yy = 0; yy < r.h; yy++) {
    const from = ((r.y + yy) * srcW + r.x) * 4;
    out.set(src.subarray(from, from + r.w * 4), yy * r.w * 4);
  }
  return out;
}
