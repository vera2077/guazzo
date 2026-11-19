/**
 * Content-Aware Fill / Spot Healing — classical patch-based inpainting.
 *
 * No network, no model weights, no randomness: the same input always produces
 * the same output. Two stages:
 *
 *   1. DIFFUSE — a few Jacobi passes average known neighbours into the hole so
 *      the region starts from a plausible colour and the algorithm terminates
 *      even when the hole covers the whole canvas.
 *   2. SYNTHESIZE — patch matching. For every hole pixel we find the donor
 *      patch (from the *known* area) that best matches this pixel's known
 *      neighbours under sum-of-squared-differences, then accumulate the whole
 *      donor patch — colour-corrected by the mean difference over the overlap —
 *      into a weighted average. Copying whole patches instead of single pixels
 *      is what keeps texture coherent; the colour correction is what makes the
 *      repair blend into its surroundings (the classic "healing" trick).
 *
 * The repair is written back in ONE grid write, and pixels outside the hole are
 * byte-identical afterwards.
 */

import type { TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export interface Rect4 { x: number; y: number; w: number; h: number }

export interface FillOptions {
  /** side of the square comparison patch (odd, ≥3) */
  patch?: number;
  /** how far outside the hole donors may be taken from */
  search?: number;
  /** donor grid step; larger is faster and coarser */
  stride?: number;
  /** extra diffusion passes that smooth the result */
  smooth?: number;
  /** patch-matching passes */
  passes?: number;
  /** donation candidates considered per pixel */
  maxCandidates?: number;
}

const DEFAULTS: Required<FillOptions> = {
  patch: 7,
  search: 26,
  stride: 3,
  smooth: 6,
  passes: 2,
  maxCandidates: 400,
};

/** Above this many hole pixels, skip patch matching and just diffuse. */
const TEXTURE_LIMIT = 24000;

interface Buf {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8ClampedArray;
  /** untouched copy, so soft mask edges can be blended instead of hard-cut */
  orig: Uint8ClampedArray;
  known: Uint8Array;
  /** 1 where the pixel belongs to the hole (mirror of `holes`, for O(1) tests) */
  holeAt: Uint8Array;
  /** hole pixels, as indices into `data` divided by 4 */
  holes: number[];
}

function clampRect(grid: TileGrid, rect: Rect4): Rect4 | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(grid.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(grid.height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Hole membership is decided once, up front: mask alpha, or the whole rect. */
function makeHoleTest(mask: PixelMask | null): (x: number, y: number) => boolean {
  if (!mask) return () => true;
  // PixelMask only promises alphaAt, so nothing else is assumed about it
  // >0 rather than >=128: a soft brush edge must be repaired too, otherwise the
  // untouched fringe leaves a visible ring around every healed stroke
  return (x: number, y: number): boolean => (x < 0 || y < 0 ? false : mask.alphaAt(x, y) > 0);
}

function hasHole(mask: PixelMask, rect: Rect4): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (mask.alphaAt(x, y) >= 128) return true;
    }
  }
  return false;
}

function readBuffer(grid: TileGrid, target: Rect4, pad: number, isHole: (x: number, y: number) => boolean): Buf {
  const bx = Math.max(0, target.x - pad);
  const by = Math.max(0, target.y - pad);
  const bx1 = Math.min(grid.width, target.x + target.w + pad);
  const by1 = Math.min(grid.height, target.y + target.h + pad);
  const w = bx1 - bx;
  const h = by1 - by;
  const data = new Uint8ClampedArray(w * h * 4);
  grid.readRect(bx, by, w, h, data);
  const known = new Uint8Array(w * h);
  const holeAt = new Uint8Array(w * h);
  const holes: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const gx = bx + x;
      const gy = by + y;
      const inside = gx >= target.x && gx < target.x + target.w && gy >= target.y && gy < target.y + target.h;
      const hole = inside && isHole(gx, gy);
      if (hole) { holes.push(p); holeAt[p] = 1; }
      else known[p] = 1;
    }
  }
  return { x: bx, y: by, w, h, data, orig: data.slice(), known, holeAt, holes };
}

/** Jacobi diffusion: each hole pixel averages its known 4-neighbours. */
function diffuse(buf: Buf, passes: number): void {
  const { data, w, h } = buf;
  const isHole = buf.holeAt;
  const filled = new Uint8Array(w * h); // grows as the hole fills from the edge
  const next = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    next.set(data);
    for (const p of buf.holes) {
      if (filled[p]) continue;
      const x = p % w;
      const y = (p - x) / w;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (isHole[q] && !filled[q]) continue;
        const i = q * 4;
        r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; a += data[i + 3]!;
        n++;
      }
      if (n === 0) continue;
      const i = p * 4;
      next[i] = r / n; next[i + 1] = g / n; next[i + 2] = b / n; next[i + 3] = a / n;
      filled[p] = 1;
      changed = true;
    }
    data.set(next);
    if (!changed) break;
  }
}

interface Donor { x: number; y: number }

/** Candidate patch centres: every position whose whole patch is known. */
function donors(buf: Buf, patch: number, stride: number): Donor[] {
  const half = (patch - 1) >> 1;
  const out: Donor[] = [];
  const step = Math.max(1, stride | 0);
  for (let y = half; y < buf.h - half; y += step) {
    for (let x = half; x < buf.w - half; x += step) {
      let ok = true;
      for (let dy = -half; dy <= half && ok; dy++) {
        const row = (y + dy) * buf.w;
        for (let dx = -half; dx <= half; dx++) {
          if (!buf.known[row + x + dx]) { ok = false; break; }
        }
      }
      if (ok) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Hole pixels ordered from the boundary inwards (BFS distance to known area).
 * Filling in this order means each pixel is matched against pixels that are
 * already real, which is what preserves gradients and textures.
 */
function holeOrder(buf: Buf): number[] {
  const { w, h, holeAt } = buf;
  const dist = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (holeAt[p]) continue;
      dist[p] = 0;
      queue.push(p);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    const x = p % w;
    const y = (p - x) / w;
    const d = dist[p]!;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (dist[q] !== -1) continue;
      dist[q] = d + 1;
      queue.push(q);
    }
  }
  const holes = buf.holes.filter((p) => (dist[p] ?? -1) > 0);
  holes.sort((a, b) => dist[a]! - dist[b]!);
  return holes;
}

/**
 * Exemplar fill, onion-peel order. Each hole pixel takes its centre colour from
 * the best-matching donor patch (SSD over the already-real pixels of its
 * neighbourhood) plus that patch's mean colour offset — the "healing" trick that
 * makes a repair blend into its surroundings instead of standing out.
 */
function synthesize(buf: Buf, o: Required<FillOptions>): void {
  const patch = Math.max(3, o.patch | 1);
  const half = (patch - 1) >> 1;
  const { w, h, data } = buf;
  const pool = donors(buf, patch, o.stride);
  if (pool.length === 0) return;
  const order = holeOrder(buf);
  if (order.length === 0) return;
  const filled = new Uint8Array(buf.known); // grows as we peel inwards
  const src = new Uint8ClampedArray(data);  // donors are always pristine pixels

  // sample the donor pool down if the hole is big, so this stays interactive
  const budget = Math.max(24, Math.min(pool.length, o.maxCandidates));
  const stepC = pool.length / budget;
  const pick: Donor[] = [];
  for (let i = 0; i < budget; i++) pick.push(pool[Math.floor(i * stepC)]!);

  for (const p of order) {
    const px = p % w;
    const py = (p - px) / w;
    if (px < half || py < half || px >= w - half || py >= h - half) {
      filled[p] = 1;
      continue;
    }
    let best = -1;
    let bestErr = Infinity;
    for (let ci = 0; ci < pick.length; ci++) {
      const d = pick[ci]!;
      let err = 0;
      scan: for (let dy = -half; dy <= half; dy++) {
        const tRow = (py + dy) * w;
        const dRow = (d.y + dy) * w;
        for (let dx = -half; dx <= half; dx++) {
          const tq = tRow + px + dx;
          if (!filled[tq]) continue; // match only what is already real
          const di = (dRow + d.x + dx) * 4;
          const ti = tq * 4;
          const dr = data[ti]! - src[di]!;
          const dg = data[ti + 1]! - src[di + 1]!;
          const db = data[ti + 2]! - src[di + 2]!;
          err += dr * dr + dg * dg + db * db;
          if (err >= bestErr) break scan;
        }
      }
      if (err < bestErr) { bestErr = err; best = ci; }
    }
    if (best < 0) { filled[p] = 1; continue; }
    const donor = pick[best]!;

    // mean colour offset over the neighbourhood we can trust
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let dy = -half; dy <= half; dy++) {
      const tRow = (py + dy) * w;
      const dRow = (donor.y + dy) * w;
      for (let dx = -half; dx <= half; dx++) {
        const tq = tRow + px + dx;
        if (!filled[tq]) continue;
        const di = (dRow + donor.x + dx) * 4;
        const ti = tq * 4;
        sr += data[ti]! - src[di]!;
        sg += data[ti + 1]! - src[di + 1]!;
        sb += data[ti + 2]! - src[di + 2]!;
        n++;
      }
    }
    const offR = n > 0 ? sr / n : 0;
    const offG = n > 0 ? sg / n : 0;
    const offB = n > 0 ? sb / n : 0;

    const di = (donor.y * w + donor.x) * 4;
    const ti = p * 4;
    data[ti] = src[di]! + offR;
    data[ti + 1] = src[di + 1]! + offG;
    data[ti + 2] = src[di + 2]! + offB;
    // keep the hole's own alpha: taking the donor's (Math.max) turned a soft
    // semi-transparent fringe into a solid opaque blob
    data[ti + 3] = data[ti + 3]!;
    filled[p] = 1;
  }

  // extra smoothing rounds take the stair-stepping out of the seams
  for (let pass = 1; pass < Math.max(1, o.passes); pass++) {
    const copy = new Uint8ClampedArray(data);
    for (const p of order) {
      const px = p % w;
      const py = (p - px) / w;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const i = (ny * w + nx) * 4;
          r += copy[i]!; g += copy[i + 1]!; b += copy[i + 2]!;
          n++;
        }
      }
      if (n === 0) continue;
      const i = p * 4;
      // half original, half neighbourhood: keeps texture, kills banding
      data[i] = (copy[i]! + r / n) / 2;
      data[i + 1] = (copy[i + 1]! + g / n) / 2;
      data[i + 2] = (copy[i + 2]! + b / n) / 2;
    }
  }
}

/** Fill the hole described by `mask` inside `rect`. Returns the rect it touched. */
export function contentAwareFill(
  grid: TileGrid,
  rect: Rect4,
  mask: PixelMask | null,
  opts: FillOptions = {},
): Rect4 | null {
  const target = clampRect(grid, rect);
  if (!target) return null;
  if (mask && !hasHole(mask, target)) return null;
  const o: Required<FillOptions> = { ...DEFAULTS, ...opts };
  const isHole = makeHoleTest(mask);
  const pad = Math.max(4, o.search);
  const buf = readBuffer(grid, target, pad, isHole);
  if (buf.holes.length === 0) return null;

  // 1. a smooth starting point, and a guaranteed answer for huge holes
  diffuse(buf, Math.max(1, o.smooth));

  // 2. texture, unless the hole is so large that matching would crawl
  if (buf.holes.length <= TEXTURE_LIMIT) synthesize(buf, o);

  // 3. feather the repair by the mask so soft brushes leave no hard rim
  featherBlend(buf, mask);

  // 4. one blended write: known pixels are byte-identical to what we read
  grid.writeRect(buf.x, buf.y, buf.w, buf.h, buf.data);
  return target;
}

/**
 * Blend the repaired pixels back by mask coverage. Interior pixels (alpha 255)
 * take the fill completely; the soft rim keeps the original, which is what stops
 * a healing stroke from leaving a ring.
 */
function featherBlend(buf: Buf, mask: PixelMask | null): void {
  if (!mask) return;
  const { data, orig, w } = buf;
  for (const p of buf.holes) {
    const x = p % w;
    const y = (p - x) / w;
    const a = mask.alphaAt(buf.x + x, buf.y + y) / 255;
    if (a >= 0.999) continue;
    const i = p * 4;
    for (let c = 0; c < 4; c++) {
      data[i + c] = (orig[i + c] ?? 0) + ((data[i + c] ?? 0) - (orig[i + c] ?? 0)) * a;
    }
  }
}

/** Spot healing: the same engine tuned for small, brush-shaped blemishes. */
export function spotHeal(
  grid: TileGrid,
  rect: Rect4,
  mask: PixelMask | null,
  opts: FillOptions = {},
): Rect4 | null {
  return contentAwareFill(grid, rect, mask, {
    patch: 5,
    search: 20,
    stride: 2,
    smooth: 4,
    passes: 2,
    ...opts,
  });
}
