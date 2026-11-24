/** Deterministic, DOM-free patch-synthesis helpers for moving or removing a
 *  rectangular region of a flat RGBA buffer.
 *
 *  The fill is a small exemplar search: among same-sized patches in a bounded
 *  neighbourhood around the hole, pick the one whose own border best matches
 *  the pixels just outside the hole (sum of squared RGB differences). Ties are
 *  resolved by scan order (top-to-bottom, left-to-right), so the result is a
 *  pure function of the inputs. The chosen patch is blended into the vacated
 *  area with a soft feather; alpha is never touched by the fill.
 *
 *  Both entry points return a NEW buffer and never mutate their input.
 */
export interface CMRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const cmClamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Normalise a rect to integer, in-bounds coordinates. Returns null when the
 *  rect is invalid (non-finite, zero/negative size) or misses the image. */
function cmClipRect(rect: CMRect, w: number, h: number): CMRect | null {
  const { x, y, w: rw, h: rh } = rect;
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    !Number.isFinite(rw) || !Number.isFinite(rh) ||
    rw <= 0 || rh <= 0
  ) return null;
  const ix = Math.trunc(x);
  const iy = Math.trunc(y);
  const x0 = cmClamp(ix, 0, w);
  const y0 = cmClamp(iy, 0, h);
  const x1 = cmClamp(ix + Math.trunc(rw), 0, w);
  const y1 = cmClamp(iy + Math.trunc(rh), 0, h);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return null;
  return { x: x0, y: y0, w: cw, h: ch };
}

/** Squared RGB difference between two RGBA buffer indices. */
function sqDiff(px: Uint8ClampedArray, a: number, b: number): number {
  const dr = px[a]! - px[b]!;
  const dg = px[a + 1]! - px[b + 1]!;
  const db = px[a + 2]! - px[b + 2]!;
  return dr * dr + dg * dg + db * db;
}

/** Cost of using the patch at (cx,cy) to fill `hole`: compare each border
 *  pixel of the patch with the context pixel immediately outside the hole in
 *  the matching direction. Only in-bounds comparisons contribute. */
function borderCost(
  px: Uint8ClampedArray, w: number, h: number, hole: CMRect, cx: number, cy: number,
): number {
  const { x: hx, y: hy, w: hw, h: hh } = hole;
  let cost = 0;
  for (let dy = 0; dy < hh; dy++) {
    for (let dx = 0; dx < hw; dx++) {
      if (dx !== 0 && dx !== hw - 1 && dy !== 0 && dy !== hh - 1) continue;
      const pi = ((cy + dy) * w + (cx + dx)) * 4;
      if (dx === 0 && hx > 0) {
        cost += sqDiff(px, pi, ((hy + dy) * w + (hx - 1)) * 4);
      }
      if (dx === hw - 1 && hx + hw < w) {
        cost += sqDiff(px, pi, ((hy + dy) * w + (hx + hw)) * 4);
      }
      if (dy === 0 && hy > 0) {
        cost += sqDiff(px, pi, ((hy - 1) * w + (hx + dx)) * 4);
      }
      if (dy === hh - 1 && hy + hh < h) {
        cost += sqDiff(px, pi, ((hy + hh) * w + (hx + dx)) * 4);
      }
    }
  }
  return cost;
}

interface PatchChoice {
  cx: number;
  cy: number;
  cost: number;
}

/** Find the lowest-cost same-sized patch in a bounded neighbourhood of the
 *  hole. Scan order is the deterministic tie-break (strict `<` keeps the
 *  first candidate seen). Overlapping candidates are excluded. */
function findPatch(
  px: Uint8ClampedArray, w: number, h: number, hole: CMRect,
): PatchChoice | null {
  const { x: hx, y: hy, w: hw, h: hh } = hole;
  const margin = Math.max(hw, hh, 4) * 2;
  const minX = Math.max(0, hx - margin);
  const maxX = Math.min(w - hw, hx + margin);
  const minY = Math.max(0, hy - margin);
  const maxY = Math.min(h - hh, hy + margin);
  if (minX > maxX || minY > maxY) return null;

  let best: PatchChoice | null = null;
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (cx < hx + hw && cx + hw > hx && cy < hy + hh && cy + hh > hy) continue;
      const cost = borderCost(px, w, h, hole, cx, cy);
      if (best === null || cost < best.cost) best = { cx, cy, cost };
    }
  }
  return best;
}

/** Mean RGB of the context ring, used only when no candidate patch fits. */
function averageContext(
  px: Uint8ClampedArray, w: number, h: number, hole: CMRect,
): [number, number, number] {
  const { x: hx, y: hy, w: hw, h: hh } = hole;
  let sr = 0, sg = 0, sb = 0, n = 0;
  const add = (i: number): void => {
    sr += px[i]!; sg += px[i + 1]!; sb += px[i + 2]!; n++;
  };
  for (let dy = 0; dy < hh; dy++) {
    for (let dx = 0; dx < hw; dx++) {
      if (dx !== 0 && dx !== hw - 1 && dy !== 0 && dy !== hh - 1) continue;
      if (dx === 0 && hx > 0) add(((hy + dy) * w + (hx - 1)) * 4);
      if (dx === hw - 1 && hx + hw < w) add(((hy + dy) * w + (hx + hw)) * 4);
      if (dy === 0 && hy > 0) add(((hy - 1) * w + (hx + dx)) * 4);
      if (dy === hh - 1 && hy + hh < h) add(((hy + hh) * w + (hx + dx)) * 4);
    }
  }
  if (n === 0) return [128, 128, 128];
  return [sr / n, sg / n, sb / n];
}

/** Fill `hole` in `out` (a copy of `px`) with the synthesised patch, blended
 *  with the original hole content near the edges by a soft feather. Alpha of
 *  every pixel is left exactly as it was. */
function synthesisFill(
  px: Uint8ClampedArray, w: number, h: number, hole: CMRect, out: Uint8ClampedArray,
): void {
  const { x: hx, y: hy, w: hw, h: hh } = hole;
  const choice = findPatch(px, w, h, hole);
  const avg = choice ? null : averageContext(px, w, h, hole);
  const feather = Math.max(1, Math.min(2, Math.floor(Math.min(hw, hh) / 2)));

  for (let dy = 0; dy < hh; dy++) {
    for (let dx = 0; dx < hw; dx++) {
      let pr: number, pg: number, pb: number;
      if (choice) {
        const pi = ((choice.cy + dy) * w + (choice.cx + dx)) * 4;
        pr = px[pi]!; pg = px[pi + 1]!; pb = px[pi + 2]!;
      } else {
        pr = avg![0]; pg = avg![1]; pb = avg![2];
      }
      const oi = ((hy + dy) * w + (hx + dx)) * 4;
      const d = Math.min(dx, dy, hw - 1 - dx, hh - 1 - dy);
      const t = 0.7 + 0.3 * Math.min(1, d / feather);
      out[oi] = out[oi]! * (1 - t) + pr * t;
      out[oi + 1] = out[oi + 1]! * (1 - t) + pg * t;
      out[oi + 2] = out[oi + 2]! * (1 - t) + pb * t;
      // Alpha is intentionally preserved for filled pixels.
    }
  }
}

/** Copy the source rect's RGBA to (dstX,dstY), clipped to the image, and
 *  synthesise a fill for the vacated source rect. The destination receives the
 *  ORIGINAL source pixels even when destination and source overlap. */
export function contentMovePixels(
  px: Uint8ClampedArray, w: number, h: number,
  src: CMRect, dstX: number, dstY: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px);
  if (px.length < w * h * 4) return out;
  if (!Number.isFinite(dstX) || !Number.isFinite(dstY)) return out;
  const hole = cmClipRect(src, w, h);
  if (!hole) return out;

  synthesisFill(px, w, h, hole, out);

  const tx0 = Math.trunc(dstX);
  const ty0 = Math.trunc(dstY);
  for (let dy = 0; dy < hole.h; dy++) {
    const ty = ty0 + dy;
    if (ty < 0 || ty >= h) continue;
    for (let dx = 0; dx < hole.w; dx++) {
      const tx = tx0 + dx;
      if (tx < 0 || tx >= w) continue;
      const si = ((hole.y + dy) * w + (hole.x + dx)) * 4;
      const di = (ty * w + tx) * 4;
      out[di] = px[si]!;
      out[di + 1] = px[si + 1]!;
      out[di + 2] = px[si + 2]!;
      out[di + 3] = px[si + 3]!;
    }
  }
  return out;
}

/** Remove `rect` by the same patch-synthesis fill, with no destination copy. */
export function contentRemovePixels(
  px: Uint8ClampedArray, w: number, h: number, rect: CMRect,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px);
  if (px.length < w * h * 4) return out;
  const hole = cmClipRect(rect, w, h);
  if (!hole) return out;
  synthesisFill(px, w, h, hole, out);
  return out;
}
