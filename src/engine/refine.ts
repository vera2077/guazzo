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
 * True when the mask already carries partial coverage. With feather on,
 * `refineSelection` returns such a mask unchanged (the AQ2 fixed point), so the
 * UI must say so instead of offering a button that appears to run and does nothing.
 * Only allocated tiles are visited, so a rectangular 16k selection costs its edge.
 */
export function selectionHasFeather(mask: SelectionMask): boolean {
  let found = false;
  mask.forEachTile((tile) => {
    if (found) return;
    for (let i = 0; i < tile.length; i++) {
      const a = tile[i]!;
      if (a > 0 && a < 255) { found = true; return; }
    }
  });
  return found;
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

  // AQ2: feather is the step that manufactures fractional coverage, so a mask that
  // already HAS fractional coverage while feathering has been through this function
  // before. Re-running it re-derives the band from the ramp it just wrote, and the
  // band then grows by a row per pass — the period-2 limit cycle the review measured
  // (250 -> 255 -> 249 at x = 31). With feather on, refined output is a fixed point.
  if (feather > 0) {
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i]! > 0 && alpha[i]! < 1) return mask.clone();
    }
  }

  // AQ1: ONE anchor pair for the whole band, not one pair per pixel.
  //
  // Choosing the pair per pixel with a nearest tie-break is unstable whenever the
  // selection itself straddles a colour edge: both colours are "confidently
  // inside", the pair has two equally valid orientations, and the tie-break flips
  // between neighbouring pixels. A one-row marquee on a horizon then mattes to
  // zero — the step called "refine" deleted the selection (review round 8, AQ1:
  // 7 of 8 pixels erased, anything under ~3 px wide vanished).
  //
  // The pair is chosen once from confident samples across the band, so every
  // pixel is matted against the same two colours and the orientation cannot flip.
  const insSamples: number[] = [];
  const outSamples: number[] = [];
  const SAMPLE_CAP = 96;
  const step = Math.max(1, Math.floor(Math.sqrt((rw * rh) / SAMPLE_CAP)));
  for (let y = ry; y < ry2; y += step) {
    for (let x = rx; x < rx2; x += step) {
      // AQ1: sample by ALPHA confidence, not by "outside the band". The band is
      // grown by `radius`, so on a small selection every pixel is uncertain and a
      // naive "skip the band" sampler would collect nothing at all — which is how
      // the first version of this fix managed to skip matting entirely and leave a
      // blurred ramp where the review expected a snap.
      const a = alpha[idx(x, y)]! * 255;
      if (a >= inAbove) { if (insSamples.length < SAMPLE_CAP * 2) insSamples.push(x, y); }
      else if (a <= outBelow) { if (outSamples.length < SAMPLE_CAP * 2) outSamples.push(x, y); }
    }
  }
  let fAnchor: [number, number, number] | null = null;
  let bAnchor: [number, number, number] | null = null;
  let bestSep = 0;
  for (let i = 0; i < insSamples.length; i += 2) {
    const [ir, ig, ib] = at(insSamples[i]!, insSamples[i + 1]!) as [number, number, number];
    for (let j = 0; j < outSamples.length; j += 2) {
      const [or_, og, ob] = at(outSamples[j]!, outSamples[j + 1]!) as [number, number, number];
      const sep = (ir - or_) ** 2 + (ig - og) ** 2 + (ib - ob) ** 2;
      if (sep > bestSep) {
        bestSep = sep;
        fAnchor = [ir, ig, ib];
        bAnchor = [or_, og, ob];
      }
    }
  }

  const out = new Float64Array(alpha);

  if (fAnchor && bAnchor && bestSep >= 1) {
    const [fr, fg, fb] = fAnchor;
    const [br, bg, bb] = bAnchor;
    const dr = fr - br, dg = fg - bg, db = fb - bb;
    const len2 = dr * dr + dg * dg + db * db;
    for (let y = ry; y < ry2; y++) {
      for (let x = rx; x < rx2; x++) {
        const i = idx(x, y);
        if (!uncertain[i]) continue;
        // AQ2: one decision per pixel, and the decision has to stay constant or the
        // pass is not a function of its input. When feathering, a fractional pixel
        // is a ramp this function produced on an earlier pass — leave it alone, or
        // pass 2 flattens the ramp, pass 3 rebuilds it and the mask oscillates with
        // period two. When NOT feathering, a fractional pixel is the caller's soft
        // selection and matting it onto the colour edge is the whole point of the
        // tool (that is the shipped "snap a blurred ramp to the edge" behaviour).
        if (!wasHard[i] && feather > 0) continue;
        const [cr, cg, cb] = at(x, y) as [number, number, number];
        const t = ((cr - br) * dr + (cg - bg) * dg + (cb - bb) * db) / len2;
        out[i] = Math.min(1, Math.max(0, t));
      }
    }
  }

  // AQ1 coverage guards. Matting must never be *destructive*, and the hardest case
  // is a selection that straddles the colour edge: both colours are confidently
  // "inside", so nothing in the colour data says which side faces in. Matting it
  // anyway silently halves the selection — a one-row marquee on a horizon came back
  // empty in the review probe (AQ1: 7 of 8 pixels deleted).
  //
  // Two guards, both refusing rather than guessing:
  //  1. orientation is ambiguous when matting against the REVERSED pair keeps at
  //     least as many selected pixels as the forward pair — then colours carry no
  //     inside/outside signal and the selection is returned untouched;
  //  2. catastrophic loss (kept < half the selected pixels) is always a refusal.
  if (fAnchor && bAnchor) {
    const [fr2, fg2, fb2] = fAnchor;
    const [br2, bg2, bb2] = bAnchor;
    const dr2 = fr2 - br2, dg2 = fg2 - bg2, db2 = fb2 - bb2;
    const len22 = dr2 * dr2 + dg2 * dg2 + db2 * db2;
    if (len22 >= 1) {
      let selected = 0;
      let keptF = 0;
      let keptR = 0;
      let hardSelected = 0;
      let selectedOutsideBand = 0;
      for (let y = ry; y < ry2; y++) {
        for (let x = rx; x < rx2; x++) {
          const i = idx(x, y);
          if (alpha[i]! < 0.5) continue;
          selected++;
          if (wasHard[i]) hardSelected++;
          if (!uncertain[i]) selectedOutsideBand++;
          const [cr, cg, cb] = at(x, y) as [number, number, number];
          const t = ((cr - br2) * dr2 + (cg - bg2) * dg2 + (cb - bb2) * db2) / len22;
          if (t >= 0.5) keptF++;
          if (1 - t >= 0.5) keptR++;
        }
      }
      // A hard selection entirely inside the band is a thin marquee (a one-row rule
      // on a horizon): no pixel is a reliable anchor, both colours are "inside", and
      // matting it deletes it. Refuse — there is nothing to matt against.
      if (hardSelected === selected && selectedOutsideBand === 0) return mask.clone();
      if (selected > 0 && (keptR >= keptF || keptF / selected < 0.5)) return mask.clone();
    }
  }

  if (feather > 0) {
    // Every fractional pixel in the work area returned above, so what reaches
    // here is binary on the way in. Feather exactly once; a second pass must
    // not re-blur the ramp this pass wrote.
    const blurred = new Float64Array(out);
    featherBlur(blurred, rw, rh, feather);
    for (let i = 0; i < out.length; i++) {
      if (uncertain[i]) out[i] = blurred[i]!;
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
