/**
 * refine.ts — Select-and-Mask: edge-aware refinement of a selection.
 *
 * The classic problem: a marquee or wand selection is a hard-edged guess. Where
 * the true edge runs through a semi-transparent pixel (hair, fur, a soft shadow),
 * the mask has to follow the IMAGE, not the polygon.
 *
 * Two passes, both cheap and deterministic:
 *
 *  1. Edge-aware: for every UNCERTAIN pixel find the colour-separated pair of a
 *     confidently-inside and a confidently-outside sample within `radius`, then
 *     ask where the pixel's colour sits on the line between those two colours.
 *     That is the standard matting estimate alpha = ((C-B)·(F-B)) / |F-B|²,
 *     exact for a two-colour edge and a good approximation for everything else.
 *
 *     "Uncertain" is derived from the mask's GEOMETRY (AI4): a pixel counts when
 *     it lies within `radius` of a 0/255 boundary. The earlier rule keyed off
 *     alpha being strictly between 26 and 229, which no tool ever produces — the
 *     marquee, wand, lasso and pen all write 0 or 255 — so the band was empty,
 *     only the feather ran, and the radius slider did nothing at all.
 *  2. Feather: separable box blur (two passes ≈ gaussian) so the result has no
 *     stair-stepping even when the image has none.
 *
 * Interior and exterior pixels are never touched, so refining twice is stable
 * rather than creeping.
 */

import { SelectionMask } from "./mask.ts";

/** What the caller wants back: a selection, or a mask to hang on a layer. */
export type RefineOutput = "selection" | "mask";

export interface RefineOptions {
  /** How far to look for confident samples, and how wide the band is. Default 8 px. */
  radius?: number;
  /** Softening applied after matting, in pixels. Default 0. */
  feather?: number;
  /** Below this alpha a pixel counts as "outside". */
  outBelow?: number;
  /** Above this alpha a pixel counts as "inside". */
  inAbove?: number;
}

const DEFAULT_RADIUS = 8;

/** Refine `mask` against the image in `px` (RGBA, w × h). Returns a NEW mask. */
export function refineSelection(
  mask: SelectionMask,
  px: Uint8ClampedArray | ArrayLike<number>,
  width: number,
  height: number,
  opts: RefineOptions = {},
): SelectionMask {
  const radius = Math.max(1, Math.round(opts.radius ?? DEFAULT_RADIUS));
  const feather = Math.max(0, Math.round(opts.feather ?? 0));
  const outBelow = opts.outBelow ?? 26;
  const inAbove = opts.inAbove ?? 229;

  const w = Math.min(width, mask.width);
  const h = Math.min(height, mask.height);
  const alpha = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) alpha[y * w + x] = mask.alphaAt(x, y) / 255;
  }

  const at = (x: number, y: number): number[] => {
    const i = (y * width + x) * 4;
    return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
  };

  // AI4: the band comes from the mask's SHAPE, not from fractional alphas that no
  // tool writes. Every pixel whose 4-neighbourhood straddles 50 % is a boundary;
  // everything within `radius` of one is uncertain and gets re-estimated.
  const side = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) side[i] = alpha[i]! * 255 >= 128 ? 1 : 0;
  const uncertain = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const here = side[y * w + x]!;
      const right = x + 1 < w ? side[y * w + x + 1]! : here;
      const down = y + 1 < h ? side[(y + 1) * w + x]! : here;
      if (here === right && here === down) continue;
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) uncertain[yy * w + xx] = 1;
      }
    }
  }

  const out = new Float64Array(alpha);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Interior and exterior pixels are anchors, never edits. Pixels inside the
      // band are re-estimated even when their alpha is already 0 or 255: that is
      // exactly where a hard selection meets a soft image edge.
      if (!uncertain[y * w + x]) continue;
      // Anchors: collect confident samples on both sides, then pick the PAIR with
      // the greatest colour separation (tie-break: nearest). Nearest-only is wrong
      // when the mask band is wider than the colour edge — both nearest anchors can
      // then sit on the same side of the edge, which yields two identical colours
      // and no matting signal at all (that bug made a 6-px band refine to nothing).
      const ins: number[] = [];  // x, y pairs
      const outs: number[] = [];
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= w) continue;
          if (dx === 0 && dy === 0) continue;
          const na = alpha[sy * w + sx]! * 255;
          if (na >= inAbove) { if (ins.length < 64) ins.push(sx, sy); }
          else if (na <= outBelow) { if (outs.length < 64) outs.push(sx, sy); }
        }
      }
      if (ins.length === 0 || outs.length === 0) continue;
      let fx = -1, fy = -1, bx = -1, by = -1, bestSep = 0, bestCost = Infinity;
      for (let i = 0; i < ins.length; i += 2) {
        const ix = ins[i]!, iy = ins[i + 1]!;
        const [ir, ig, ib] = at(ix, iy) as [number, number, number];
        for (let j = 0; j < outs.length; j += 2) {
          const ox = outs[j]!, oy = outs[j + 1]!;
          const [or_, og, ob] = at(ox, oy) as [number, number, number];
          const sep = (ir - or_) ** 2 + (ig - og) ** 2 + (ib - ob) ** 2;
          const cost = (ix - x) ** 2 + (iy - y) ** 2 + (ox - x) ** 2 + (oy - y) ** 2;
          if (sep > bestSep || (sep === bestSep && cost < bestCost)) {
            bestSep = sep; bestCost = cost;
            fx = ix; fy = iy; bx = ox; by = oy;
          }
        }
      }
      if (fx < 0 || bx < 0) continue;
      const [cr, cg, cb] = at(x, y) as [number, number, number];
      const [fr, fg, fb] = at(fx, fy) as [number, number, number];
      const [br, bg, bb] = at(bx, by) as [number, number, number];
      const dr = fr - br, dg = fg - bg, db = fb - bb;
      const len2 = dr * dr + dg * dg + db * db;
      if (len2 < 1) continue; // the two anchors are the same colour: no signal
      const t = ((cr - br) * dr + (cg - bg) * dg + (cb - bb) * db) / len2;
      out[y * w + x] = Math.min(1, Math.max(0, t));
    }
  }

  if (feather > 0) featherBlur(out, w, h, feather);

  const next = new SelectionMask(mask.width, mask.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(out[y * w + x]! * 255);
      if (v > 0) next.setAlpha(x, y, v);
    }
  }
  return next;
}

/** Separable box blur, two passes (≈ triangular kernel). */
function featherBlur(data: Float64Array, w: number, h: number, radius: number): void {
  const tmp = new Float64Array(data.length);
  const r = Math.max(1, radius);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let dx = -r; dx <= r; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= w) continue;
          sum += data[y * w + sx]!;
          n++;
        }
        tmp[y * w + x] = sum / n;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let sum = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= h) continue;
          sum += tmp[sy * w + x]!;
          n++;
        }
        data[y * w + x] = sum / n;
      }
    }
  }
}
