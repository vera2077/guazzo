/**
 * smart.ts — smart-object source pixels.
 *
 * A smart object is a layer that keeps the image it was made from, plus the
 * pixels currently on screen. Scaling it re-derives those pixels from the
 * source instead of resampling what is already there, so shrinking to 25 % and
 * growing back to 100 % returns the original detail rather than four
 * generations of blur.
 *
 * What this file does NOT do: keep a transform. Once committed, the result is
 * ordinary pixels at their new size; what survives is the *source*, which is
 * what makes the next transform lossless. A rotation still samples the source
 * once, because rasterising a rotation is unavoidable.
 *
 * The source is treated as immutable: layers may share one after Duplicate, so
 * nothing in here writes into `source.data`.
 */
import { TileGrid, TILE } from "./tile.ts";
import { gridBBox, transformGrid, type TransformSpec } from "./transform.ts";
import { emptySample, samplePremul, straightRGB } from "./sample.ts";
import { MAX_DIM } from "./docmeta.ts";

export interface SmartSource {
  width: number;
  height: number;
  /** straight RGBA, width * height * 4 bytes */
  data: Uint8ClampedArray;
}

export interface SmartRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tight bounds of the pixels that actually paint something.
 *
 * `gridBBox` answers "which tiles are allocated", which is tile-aligned and
 * counts transparent padding — a smart source captured from it would be up to
 * 255 px larger than the picture in each direction, and every later scale would
 * be off by that much.
 */
export function contentBounds(grid: TileGrid): SmartRect | null {
  const bb = gridBBox(grid);
  if (!bb) return null;
  const raw = new Uint8ClampedArray(bb.w * bb.h * 4);
  grid.readRect(bb.x, bb.y, bb.w, bb.h, raw);
  let minX = bb.w, minY = bb.h, maxX = -1, maxY = -1;
  for (let y = 0; y < bb.h; y++) {
    for (let x = 0; x < bb.w; x++) {
      if (raw[(y * bb.w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: bb.x + minX, y: bb.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** capture the layer's painted pixels (tight bounds) as the smart source */
export function smartSourceFromGrid(grid: TileGrid): SmartSource | null {
  const bb = contentBounds(grid);
  if (!bb || bb.w < 1 || bb.h < 1) return null;
  const data = new Uint8ClampedArray(bb.w * bb.h * 4);
  grid.readRect(bb.x, bb.y, bb.w, bb.h, data);
  return { width: bb.w, height: bb.h, data };
}

/**
 * Render `source` into `grid` occupying `rect` (doc coords), replacing
 * whatever the grid held. `rect` is clamped to the grid; a rect smaller than the
 * source downscales, a larger one upscales, and both sample from the source —
 * never from the pixels being replaced.
 */
export function renderSmartIntoGrid(grid: TileGrid, source: SmartSource, rect: SmartRect): void {
  const old = gridBBox(grid);
  if (old) grid.fillRect(old.x, old.y, old.w, old.h, [0, 0, 0, 0]);

  const x0 = Math.round(rect.x), y0 = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  const dx0 = Math.max(0, x0), dy0 = Math.max(0, y0);
  const dx1 = Math.min(grid.width, x0 + w), dy1 = Math.min(grid.height, y0 + h);
  const dw = dx1 - dx0, dh = dy1 - dy0;
  if (dw <= 0 || dh <= 0) return;

  const out = new Uint8ClampedArray(dw * dh * 4);
  const smp = emptySample();
  const rgb3 = new Float32Array(3);
  for (let py = 0; py < dh; py++) {
    for (let px = 0; px < dw; px++) {
      // dest pixel centre → source pixel index; source pixel (i,j) centre is i+0.5
      const fx = ((dx0 + px + 0.5 - x0) / w) * source.width - 0.5;
      const fy = ((dy0 + py + 0.5 - y0) / h) * source.height - 0.5;
      samplePremul(source.data, source.width, source.height, fx, fy, smp, false);
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
}

/**
 * Apply a Free Transform to a smart layer by transforming the SOURCE.
 *
 * `spec` is the transform the user performed on the layer as it looks now, so
 * its scale is relative to the current footprint. Converted to the source's
 * own scale, that is `(current / natural) * spec.scale`; at 25 % a doubling is
 * a half-scale of the source, not a doubling of a quarter-size copy.
 */
export function transformSmartGrid(
  grid: TileGrid,
  source: SmartSource,
  spec: TransformSpec,
  currentW: number,
  currentH: number,
): void {
  // A whole source-sized grid: the transform is sampled from full-resolution
  // pixels exactly as if the user had transformed the original image.
  const temp = new TileGrid(source.width, source.height);
  temp.writeRect(0, 0, source.width, source.height, source.data);
  const fx = (currentW / source.width) * spec.scaleX;
  const fy = (currentH / source.height) * spec.scaleY;
  // The footprint is the picture (tight), not the tiles it occupies: a small
  // document is one tile wide, so a tile bbox would report the canvas.
  const old = contentBounds(grid) ?? gridBBox(grid);
  const centre = old
    ? { x: old.x + old.w / 2, y: old.y + old.h / 2 }
    : { x: grid.width / 2, y: grid.height / 2 };
  transformGrid(temp, {
    angleDeg: spec.angleDeg,
    scaleX: fx,
    scaleY: fy,
    // transformGrid translates relative to ITS bbox centre, which for the temp
    // grid is the source's own centre
    dx: centre.x + spec.dx - source.width / 2,
    dy: centre.y + spec.dy - source.height / 2,
  });
  // Free the old tiles instead of painting transparency over them: an
  // allocated-but-transparent tile still counts in gridBBox, so a transform
  // followed by another would measure the union of every position the layer
  // had ever occupied.
  grid.clearAllocated();
  const bb = contentBounds(temp);
  if (!bb) return;
  const out = new Uint8ClampedArray(bb.w * bb.h * 4);
  temp.readRect(bb.x, bb.y, bb.w, bb.h, out);
  grid.writeRect(bb.x, bb.y, bb.w, bb.h, out);
  void TILE;
}

/** is this a plausible smart source read from a project file? */
export function normalizeSmartSource(input: unknown): SmartSource | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { width?: unknown; height?: unknown; data?: unknown };
  if (typeof raw.width !== "number" || typeof raw.height !== "number") return null;
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height)) return null;
  if (raw.width < 1 || raw.height < 1) return null;
  if (raw.width > MAX_DIM || raw.height > MAX_DIM) return null;
  const data = raw.data;
  if (!(data instanceof Uint8ClampedArray)) return null;
  if (data.length !== raw.width * raw.height * 4) return null;
  return { width: raw.width, height: raw.height, data };
}
