/**
 * filter.ts — classic neighbor-pixel filters, applied in-place to a rect
 * of a TileGrid. Same calling convention as adjust.ts.
 *
 * Blur/sharpen operate on premultiplied RGBA (RGB *= A/255) so transparent
 * edges do not bleed dark halos into opaque neighbors; results are
 * unpremultiplied before writing back. Sampling clamps to the expanded
 * read-buffer bounds, so document edges extend their edge color outward.
 */

import { TileGrid, TILE } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export type FilterKind = "blur" | "sharpen" | "unsharp" | "noise" | "pixelate";

export interface FilterOptions {
  kind: FilterKind;
  /** blur: sigma 0.5..25 · sharpen: strength 0..100 · unsharp: amount 0..100 · noise: ±amount · pixelate: block size 2..64 */
  amount: number;
}

/** deterministic PRNG so noise filters are reproducible (and testable) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** premultiply an 8-bit RGBA buffer into a float buffer */
function premultiply(src: Uint8ClampedArray, dst: Float32Array): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]! / 255;
    dst[i] = src[i]! * a;
    dst[i + 1] = src[i + 1]! * a;
    dst[i + 2] = src[i + 2]! * a;
    dst[i + 3] = src[i + 3]!;
  }
}

/** unpremultiply a float buffer back into 8-bit RGBA (round to nearest) */
function unpremultiply(src: Float32Array, dst: Uint8ClampedArray): void {
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3]!;
    dst[i + 3] = a;
    if (a <= 0.001) {
      dst[i] = 0; dst[i + 1] = 0; dst[i + 2] = 0;
    } else {
      // buf rgb is premultiplied on a 0..255 scale (rgb *= a/255),
      // so recovery is rgb * 255/a — NOT rgb/a
      const s = 255 / a;
      dst[i] = src[i]! * s;
      dst[i + 1] = src[i + 1]! * s;
      dst[i + 2] = src[i + 2]! * s;
    }
  }
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum;
  return k;
}

/** separable gaussian blur over a premultiplied float buffer (in place) */
function blurFloat(buf: Float32Array, w: number, h: number, sigma: number): void {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(buf.length);

  // Pixels at least r away from an edge need no clamping. Split each pass
  // into the two edge bands and the interior so the inner loop reads the
  // weight once and indexes directly; the replicate edge semantics and the
  // per-channel addition order stay identical.
  const leftEnd = Math.min(r, w);
  const rightStart = Math.max(leftEnd, w - r);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < leftEnd; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = -r, ki = 0; i <= r; i++, ki++) {
        let sx = x + i;
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        const q = (row + sx) * 4;
        const kv = k[ki]!;
        a0 += buf[q]! * kv;
        a1 += buf[q + 1]! * kv;
        a2 += buf[q + 2]! * kv;
        a3 += buf[q + 3]! * kv;
      }
      const p = (row + x) * 4;
      tmp[p] = a0; tmp[p + 1] = a1; tmp[p + 2] = a2; tmp[p + 3] = a3;
    }
    for (let x = leftEnd; x < rightStart; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      const p = (row + x) * 4;
      let q = p - r * 4;
      for (let ki = 0; ki < k.length; ki++, q += 4) {
        const kv = k[ki]!;
        a0 += buf[q]! * kv;
        a1 += buf[q + 1]! * kv;
        a2 += buf[q + 2]! * kv;
        a3 += buf[q + 3]! * kv;
      }
      tmp[p] = a0; tmp[p + 1] = a1; tmp[p + 2] = a2; tmp[p + 3] = a3;
    }
    for (let x = rightStart; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = -r, ki = 0; i <= r; i++, ki++) {
        let sx = x + i;
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        const q = (row + sx) * 4;
        const kv = k[ki]!;
        a0 += buf[q]! * kv;
        a1 += buf[q + 1]! * kv;
        a2 += buf[q + 2]! * kv;
        a3 += buf[q + 3]! * kv;
      }
      const p = (row + x) * 4;
      tmp[p] = a0; tmp[p + 1] = a1; tmp[p + 2] = a2; tmp[p + 3] = a3;
    }
  }

  const topEnd = Math.min(r, h);
  const bottomStart = Math.max(topEnd, h - r);
  for (let y = 0; y < topEnd; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = -r, ki = 0; i <= r; i++, ki++) {
        let sy = y + i;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        const q = (sy * w + x) * 4;
        const kv = k[ki]!;
        a0 += tmp[q]! * kv;
        a1 += tmp[q + 1]! * kv;
        a2 += tmp[q + 2]! * kv;
        a3 += tmp[q + 3]! * kv;
      }
      const p = (y * w + x) * 4;
      buf[p] = a0; buf[p + 1] = a1; buf[p + 2] = a2; buf[p + 3] = a3;
    }
  }
  const rowStride = w * 4;
  for (let y = topEnd; y < bottomStart; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      const p = (y * w + x) * 4;
      let q = p - r * rowStride;
      for (let ki = 0; ki < k.length; ki++, q += rowStride) {
        const kv = k[ki]!;
        a0 += tmp[q]! * kv;
        a1 += tmp[q + 1]! * kv;
        a2 += tmp[q + 2]! * kv;
        a3 += tmp[q + 3]! * kv;
      }
      buf[p] = a0; buf[p + 1] = a1; buf[p + 2] = a2; buf[p + 3] = a3;
    }
  }
  for (let y = bottomStart; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = -r, ki = 0; i <= r; i++, ki++) {
        let sy = y + i;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        const q = (sy * w + x) * 4;
        const kv = k[ki]!;
        a0 += tmp[q]! * kv;
        a1 += tmp[q + 1]! * kv;
        a2 += tmp[q + 2]! * kv;
        a3 += tmp[q + 3]! * kv;
      }
      const p = (y * w + x) * 4;
      buf[p] = a0; buf[p + 1] = a1; buf[p + 2] = a2; buf[p + 3] = a3;
    }
  }
}

export function applyFilter(grid: TileGrid, x: number, y: number, w: number, h: number, o: FilterOptions, mask?: PixelMask): void {
  // clamp to grid
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(grid.width, x + w), y1 = Math.min(grid.height, y + h);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  if (o.kind === "noise") {
    const rand = mulberry32(0x9e3779b9);
    const amount = o.amount;
    grid.forEachTileInRect(x0, y0, rw, rh, (t, cx, cy, cw, ch, bx, by) => {
      const d = t.data;
      for (let yy = 0; yy < ch; yy++) {
        for (let xx = 0; xx < cw; xx++) {
          const docX = bx + cx + xx, docY = by + cy + yy;
          if (docX < x0 || docX >= x1 || docY < y0 || docY >= y1) continue;
          const p = ((cy + yy) * TILE + cx + xx) * 4;
          if (d[p + 3]! === 0) continue; // never disturb fully transparent pixels
          let n = Math.round((rand() * 2 - 1) * amount);
          if (mask) {
            const ma = mask.alphaAt(docX, docY);
            if (ma === 0) continue;
            n = (n * ma) / 255;
          }
          d[p] = d[p]! + n;
          d[p + 1] = d[p + 1]! + n;
          d[p + 2] = d[p + 2]! + n;
        }
      }
      t.version++;
    }, false);
    return;
  }

  if (o.kind === "pixelate") {
    const size = Math.max(2, Math.round(o.amount));
    // read rect once, mosaic it, write back
    const src = new Uint8ClampedArray(rw * rh * 4);
    grid.readRect(x0, y0, rw, rh, src);
    const dst = new Uint8ClampedArray(src.length);
    for (let by = 0; by < rh; by += size) {
      for (let bx = 0; bx < rw; bx += size) {
        // premultiplied average: transparent pixels must not drag the
        // block toward black (same convention as transform/resize)
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let yy = by; yy < Math.min(by + size, rh); yy++) {
          for (let xx = bx; xx < Math.min(bx + size, rw); xx++) {
            const p = (yy * rw + xx) * 4;
            const a = src[p + 3]!;
            sr += src[p]! * a; sg += src[p + 1]! * a; sb += src[p + 2]! * a; sa += a;
          }
        }
        const nx = Math.min(bx + size, rw) - bx, ny = Math.min(by + size, rh) - by;
        const a = sa / (nx * ny);
        const r = sa > 0 ? sr / sa : 0, g = sa > 0 ? sg / sa : 0, b = sa > 0 ? sb / sa : 0;
        for (let yy = by; yy < Math.min(by + size, rh); yy++) {
          for (let xx = bx; xx < Math.min(bx + size, rw); xx++) {
            const p = (yy * rw + xx) * 4;
            dst[p] = r; dst[p + 1] = g; dst[p + 2] = b; dst[p + 3] = a;
          }
        }
      }
    }
    // selection mask: blend mosaic blocks toward the original by mask value
    if (mask) {
      for (let yy = 0; yy < rh; yy++) {
        for (let xx = 0; xx < rw; xx++) {
          const ma = mask.alphaAt(x0 + xx, y0 + yy);
          if (ma === 255) continue;
          const k = ma / 255;
          const p = (yy * rw + xx) * 4;
          for (let c = 0; c < 4; c++) {
            dst[p + c] = src[p + c]! + (dst[p + c]! - src[p + c]!) * k;
          }
        }
      }
    }
    grid.writeRect(x0, y0, rw, rh, dst);
    return;
  }

  // blur / sharpen / unsharp: neighbor access over a premultiplied float buffer
  const sigma = o.kind === "blur" ? Math.max(0.3, o.amount) : o.kind === "unsharp" ? 1.5 : 1;
  const r = o.kind === "blur" ? Math.max(1, Math.ceil(3 * sigma)) : o.kind === "unsharp" ? 5 : 1;
  // expanded read region (clamped to grid) so the kernel has neighbors
  const ex = Math.max(0, x0 - r), ey = Math.max(0, y0 - r);
  const ex1 = Math.min(grid.width, x1 + r), ey1 = Math.min(grid.height, y1 + r);
  const ew = ex1 - ex, eh = ey1 - ey;
  const src = new Uint8ClampedArray(ew * eh * 4);
  grid.readRect(ex, ey, ew, eh, src);
  const buf = new Float32Array(ew * eh * 4);
  premultiply(src, buf);

  if (o.kind === "blur") {
    blurFloat(buf, ew, eh, sigma);
  } else if (o.kind === "unsharp") {
    // unsharp mask: orig + k·(orig − gaussian blur), the classic Photoshop
    // Amount slider. Radius fixed at σ=1.5; k = amount/50 (0..2).
    const blurred = new Float32Array(buf);
    blurFloat(blurred, ew, eh, sigma);
    const k = o.amount / 50;
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = buf[i]! + (buf[i]! - blurred[i]!) * k;
      buf[i + 1] = buf[i + 1]! + (buf[i + 1]! - blurred[i + 1]!) * k;
      buf[i + 2] = buf[i + 2]! + (buf[i + 2]! - blurred[i + 2]!) * k;
      // alpha stays: sharpening must not alter coverage
    }
  } else {
    // sharpen: 3x3 laplacian kernel scaled by strength (amount 0..100)
    const k = o.amount / 25; // 0..4
    const tmp = new Float32Array(buf.length);
    const at = (sx: number, sy: number, c: number): number => buf[(sy * ew + sx) * 4 + c]!;
    for (let y = 0; y < eh; y++) {
      for (let x = 0; x < ew; x++) {
        const xm = Math.max(0, x - 1), xp = Math.min(ew - 1, x + 1);
        const ym = Math.max(0, y - 1), yp = Math.min(eh - 1, y + 1);
        for (let c = 0; c < 3; c++) {
          const center = at(x, y, c);
          tmp[(y * ew + x) * 4 + c] = (1 + 4 * k) * center
            - k * (at(xm, y, c) + at(xp, y, c) + at(x, ym, c) + at(x, yp, c));
        }
        // alpha stays: sharpening must not alter coverage (handoff-2 N)
        tmp[(y * ew + x) * 4 + 3] = at(x, y, 3);
      }
    }
    buf.set(tmp);
  }

  // extract the target rect (still premultiplied floats)…
  const frect = new Float32Array(rw * rh * 4);
  for (let yy = 0; yy < rh; yy++) {
    const srcRow = ((yy + (y0 - ey)) * ew + (x0 - ex)) * 4;
    frect.set(buf.subarray(srcRow, srcRow + rw * 4), yy * rw * 4);
  }
  // …then unpremultiply into the 8-bit output WITHOUT passing floats
  // through a Uint8ClampedArray first (that would clamp/quantize early)
  const out = new Uint8ClampedArray(rw * rh * 4);
  unpremultiply(frect, out);
  // selection mask: blend the filtered result toward the (still unmutated)
  // original by mask value — 255 = fully filtered, 0 = untouched
  if (mask) {
    const before = new Uint8ClampedArray(rw * rh * 4);
    grid.readRect(x0, y0, rw, rh, before);
    for (let yy = 0; yy < rh; yy++) {
      for (let xx = 0; xx < rw; xx++) {
        const ma = mask.alphaAt(x0 + xx, y0 + yy);
        if (ma === 255) continue;
        const k = ma / 255;
        const p = (yy * rw + xx) * 4;
        for (let c = 0; c < 4; c++) {
          out[p + c] = before[p + c]! + (out[p + c]! - before[p + c]!) * k;
        }
      }
    }
  }
  grid.writeRect(x0, y0, rw, rh, out);
}
