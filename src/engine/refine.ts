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

/**
 * AP4: the rectangle `refineSelection` actually touches. Exported so the bound
 * is testable without measuring RSS: a 40 × 40 selection on a 16384² canvas must
 * report a small rect, not the canvas.
 */
export function refineWorkArea(
  mask: SelectionMask,
  radius: number,
  feather: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  const box = mask.bbox();
  if (!box || box.w < 1 || box.h < 1) return null;
  const pad = Math.max(1, Math.round(radius)) + Math.max(0, Math.round(feather)) + 2;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const x2 = Math.min(Math.min(width, mask.width), box.x + box.w + pad);
  const y2 = Math.min(Math.min(height, mask.height), box.y + box.h + pad);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * Refine `mask` against the image in `px` (RGBA, w × h). Returns a NEW mask.
 *
 * AP4: all work is bounded to the selection's bbox grown by `radius + feather`.
 * The first version allocated four full-canvas planes (`alpha`, `side`,
 * `uncertain`, `out`), so a 16384² document cost about a gigabyte to refine a
 * 200 × 200 selection — the cost tracked the canvas, not the selection.
 *
 * AP2: feather is applied only inside the uncertain band. Blurring the whole
 * plane moved the 50 % contour outward on every run, so refining twice crept —
 * a selection refined at 6 px twice was visibly larger than at 12 px once.
 */
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
  const next = new SelectionMask(mask.width, mask.height);

  // Work rect: the selection plus everything the band and the blur can reach.
  const area = refineWorkArea(mask, radius, feather, w, h);
  if (!area) return next;
  const rx = area.x, ry = area.y;
  const rx2 = area.x + area.w, ry2 = area.y + area.h;
  const rw = area.w, rh = area.h;
  const idx = (x: number, y: number): number => (y - ry) * rw + (x - rx);

  const alpha = new Float64Array(rw * rh);
  for (let y = ry; y < ry2; y++) {
    for (let x = rx; x < rx2; x++) alpha[idx(x, y)] = mask.alphaAt(x, y) / 255;
  }

  const at = (x: number, y: number): number[] => {
    const i = (y * width + x) * 4;
    return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
  };

  // AI4: the band comes from the mask's SHAPE, not from fractional alphas that no
  // tool writes. Every pixel whose 4-neighbourhood straddles 50 % is a boundary;
  // everything within `radius` of one is uncertain and gets re-estimated.
  const side = new Uint8Array(rw * rh);
  for (let y = ry; y < ry2; y++) {
    for (let x = rx; x < rx2; x++) side[idx(x, y)] = alpha[idx(x, y)]! * 255 >= 128 ? 1 : 0;
  }
  const uncertain = new Uint8Array(rw * rh);
  for (let y = ry; y < ry2; y++) {
    for (let x = rx; x < rx2; x++) {
      const here = side[idx(x, y)]!;
      const right = x + 1 < rx2 ? side[idx(x + 1, y)]! : here;
      const down = y + 1 < ry2 ? side[idx(x, y + 1)]! : here;
      if (here === right && here === down) continue;
      const y0 = Math.max(ry, y - radius), y1 = Math.min(ry2 - 1, y + radius);
      const x0 = Math.max(rx, x - radius), x1 = Math.min(rx2 - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) uncertain[idx(xx, yy)] = 1;
      }
    }
  }

  // AP2: feather converts a HARD step into a ramp. Applying it again to a pixel
  // that is already fractional re-blurs the same ramp and widens the 50 %
  // contour, which is why two refinements at 6 px looked larger than one at 12.
  // Matte anything in the band; feather only what was binary on the way in.
  const wasHard = new Uint8Array(rw * rh);
  for (let i = 0; i < alpha.length; i++) wasHard[i] = alpha[i] === 0 || alpha[i] === 1 ? 1 : 0;

  const out = new Float64Array(alpha);
  for (let y = ry; y < ry2; y++) {
    for (let x = rx; x < rx2; x++) {
      // Interior and exterior pixels are anchors, never edits. Pixels inside the
      // band are re-estimated even when their alpha is already 0 or 255: that is
      // exactly where a hard selection meets a soft image edge.
      if (!uncertain[idx(x, y)]) continue;
      // Anchors: collect confident samples on both sides, then pick the PAIR with
      // the greatest colour separation (tie-break: nearest). Nearest-only is wrong
      // when the mask band is wider than the colour edge — both nearest anchors can
      // then sit on the same side of the edge, which yields two identical colours
      // and no matting signal at all (that bug made a 6-px band refine to nothing).
      const ins: number[] = [];  // x, y pairs
      const outs: number[] = [];
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < ry || sy >= ry2) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < rx || sx >= rx2) continue;
          if (dx === 0 && dy === 0) continue;
          const na = alpha[idx(sx, sy)]! * 255;
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
      out[idx(x, y)] = Math.min(1, Math.max(0, t));
    }
  }

  if (feather > 0) {
    // AP2: blur a copy and keep it only where the mask was uncertain, so the
    // hard interior/exterior stay anchors across repeated refinements.
    const blurred = new Float64Array(out);
    featherBlur(blurred, rw, rh, feather);
    for (let i = 0; i < out.length; i++) {
      if (uncertain[i] && wasHard[i]) out[i] = blurred[i]!;
    }
  }

  // AP2 (cont.): the OUTPUT footprint is the input footprint. Matting is
  // colour-driven, so a uniform region just outside the selection reads as
  // "inside" on the next pass and the selection would walk outward by `radius`
  // every time it is refined. Refine therefore adjusts coverage inside the
  // selection's bounding box and never extends it — a growing selection that
  // nobody asked for is worse than one that stops at its own edge. (The work
  // area is still padded, because anchors and the blur must be able to look
  // outside the box.)
  const box = mask.bbox();
  if (!box) return next;
  const bx0 = box.x, by0 = box.y, bx1 = box.x + box.w, by1 = box.y + box.h;
  for (let y = Math.max(ry, by0); y < Math.min(ry2, by1); y++) {
    for (let x = Math.max(rx, bx0); x < Math.min(rx2, bx1); x++) {
      const v = Math.round(out[idx(x, y)]! * 255);
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
