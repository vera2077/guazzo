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
// reusable flood stack (handoff-3 T3): quick-selection drags flood per
// pointermove dab, and a fresh Int32Array(w*h) each time was ~64 MB/event of
// GC churn at 4096². The stack is purely internal (only indices we just
// pushed are read), so a size-keyed module scratch is safe. The returned map
// is caller-visible data and deliberately stays a fresh buffer.
let floodSpans: Int32Array | null = null;

export interface RegionBBox { x: number; y: number; w: number; h: number }

export function regionMap(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  opts: RegionOptions = {},
): { map: Uint8Array; count: number; bbox: RegionBBox | null } {
  const tolerance = Math.max(0, Math.min(255, Math.round(opts.tolerance ?? 32)));
  const contiguous = opts.contiguous !== false;
  const map = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { map, count: 0, bbox: null };

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
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const mark = (i: number): void => {
    map[i] = 1;
    count++;
    const x = i % w, y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) {
      if (like(i)) mark(i);
    }
    return { map, count, bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
  }

  // Scanline flood: a stack of row spans rather than one entry per pixel.
  // At 16384² the old Int32Array(w*h) stack was ~1 GiB resident; this is
  // O(rows) in the common case and still marks every pixel exactly once.
  const start = sy * w + sx;
  if (!like(start)) return { map, count: 0, bbox: null };
  let stack = floodSpans;
  if (stack === null || stack.length < 3 * Math.max(64, Math.min(h * 2, 4096))) {
    stack = new Int32Array(3 * Math.max(64, Math.min(h * 2, 4096)));
    floodSpans = stack;
  }
  let top = 0;
  const push = (a: number, b: number, y: number): void => {
    if (top + 3 > stack!.length) {
      const grown = new Int32Array(stack!.length * 2);
      grown.set(stack!);
      stack = grown;
      floodSpans = grown;
    }
    stack![top++] = a; stack![top++] = b; stack![top++] = y;
  };
  const markRow = (x1: number, x2: number, y: number): void => {
    const row = y * w;
    for (let x = x1; x <= x2; x++) map[row + x] = 1;
    count += x2 - x1 + 1;
    if (x1 < minX) minX = x1;
    if (x2 > maxX) maxX = x2;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  // seed span: extend across the whole contiguous run on the seed row
  let l = sx, r = sx;
  while (l > 0 && like(sy * w + l - 1) && map[sy * w + l - 1] === 0) l--;
  while (r < w - 1 && like(sy * w + r + 1) && map[sy * w + r + 1] === 0) r++;
  markRow(l, r, sy);
  push(l, r, sy);
  while (top > 0) {
    const y = stack[--top]!, x2 = stack[--top]!, x1 = stack[--top]!;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let x = x1;
      while (x <= x2) {
        const i = ny * w + x;
        if (map[i] !== 0 || !like(i)) { x++; continue; }
        let nl = x, nr = x;
        while (nl > 0 && map[ny * w + nl - 1] === 0 && like(ny * w + nl - 1)) nl--;
        while (nr < w - 1 && map[ny * w + nr + 1] === 0 && like(ny * w + nr + 1)) nr++;
        markRow(nl, nr, ny);
        push(nl, nr, ny);
        x = nr + 1;
      }
    }
  }
  return { map, count, bbox: maxX < 0 ? null: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
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
  const { map, count, bbox } = regionMap(px, w, h, x, y, opts);
  if (count === 0 || !bbox) return null;
  const mask = new SelectionMask(w, h);
  const antialias = opts.antialias !== false;

  // hard core: load the map tile-wise instead of one setAlpha per pixel
  mask.fillFromMap(map, bbox, 255);
  if (antialias) {
    // one-pixel soft fringe: unmatched neighbours touching a matched pixel
    const x0 = Math.max(0, bbox.x - 1), x1 = Math.min(w - 1, bbox.x + bbox.w);
    const y0 = Math.max(0, bbox.y - 1), y1 = Math.min(h - 1, bbox.y + bbox.h);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
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
  return { mask, bbox };
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
  const { map, count, bbox } = regionMap(px, w, h, x, y, opts);
  if (count === 0 || !bbox) return null;
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
