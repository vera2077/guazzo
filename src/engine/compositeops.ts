/**
 * compositeops.ts — document-space image compositing on sparse TileGrids.
 *
 * A bounded, deterministic primitive used by adjustment/adjust-image paths:
 * composite a source layer's straight RGBA over a base layer's straight RGBA
 * inside a rect, using one of seven separable blend modes and a scalar
 * opacity. An optional PixelMask limits coverage per pixel. `calculateMask`
 * derives the same blend/opacity math as a coverage map (0..255).
 *
 * All coordinates are document coordinates shared by both grids; the rect is
 * clipped to both grids' bounds. Straight (non-premultiplied) RGBA throughout.
 */

import { TILE, type Tile, type TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export type BlendModeName =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "difference"
  | "add"
  | "subtract";

export interface OpRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const coClamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Separable per-channel blend B(cb, cs) with both inputs normalised 0..1.
 *  Formulas match blend.ts for the shared modes; "add" is linear-add clamped. */
function coChannelBlend(mode: BlendModeName, cb: number, cs: number): number {
  switch (mode) {
    case "normal": return cs;
    case "multiply": return cb * cs;
    case "screen": return cb + cs - cb * cs;
    case "overlay": return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "difference": return Math.abs(cb - cs);
    case "add": return coClamp01(cb + cs);
    case "subtract": return coClamp01(cb - cs);
  }
}

const coLuma = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;

/**
 * W3C source-over with a separable blend. `eff` is the source alpha after
 * opacity and mask coverage (0..1); the destination's own alpha is respected.
 * When eff <= 0 (transparent source, opacity 0, or masked-out pixel) the
 * destination is left byte-for-byte untouched. out may alias dst.
 */
function coBlendPixel(
  mode: BlendModeName,
  sr: number, sg: number, sb: number, sa: number, // source 0..255
  out: Uint8ClampedArray, o: number,             // destination (read + written)
  eff: number,                                  // 0..1, already opacity*mask*sa/255
): void {
  const as = (sa / 255) * eff;
  if (as <= 0) return;
  const ab = out[o + 3]! / 255;
  const ao = as + ab * (1 - as);
  if (ao <= 0) {
    out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
    return;
  }
  const cb0 = out[o]! / 255, cb1 = out[o + 1]! / 255, cb2 = out[o + 2]! / 255;
  const cs0 = sr / 255, cs1 = sg / 255, cs2 = sb / 255;
  const br = coChannelBlend(mode, cb0, cs0);
  const bg = coChannelBlend(mode, cb1, cs1);
  const bb = coChannelBlend(mode, cb2, cs2);
  const k = 255 / ao;
  out[o] = k * ((1 - ab) * as * cs0 + ab * as * br + (1 - as) * ab * cb0);
  out[o + 1] = k * ((1 - ab) * as * cs1 + ab * as * bg + (1 - as) * ab * cb1);
  out[o + 2] = k * ((1 - ab) * as * cs2 + ab * as * bb + (1 - as) * ab * cb2);
  out[o + 3] = ao * 255;
}

/**
 * Composite `source` over `base` inside `r`, in place. Both grids share the
 * same document coordinate space; the rect is clipped to both grid bounds.
 * `opacity` (0..1) scales source alpha; transparent/ masked-out source pixels
 * leave the base untouched. Allocated base tiles have their version bumped and
 * the grid's write hook fires exactly once when anything changed.
 */
export function applyImageToGrid(
  base: TileGrid,
  source: TileGrid,
  r: OpRect,
  mode: BlendModeName,
  opacity: number,
  mask?: PixelMask | null,
): void {
  const op = coClamp01(opacity);
  if (op <= 0) return; // opacity 0: nothing changes

  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(base.width, source.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(base.height, source.height, Math.ceil(r.y + r.h));
  if (x0 >= x1 || y0 >= y1) return;
  const w = x1 - x0, h = y1 - y0;

  // Read the source region once; unallocated source tiles read transparent.
  const srcBuf = new Uint8ClampedArray(w * h * 4);
  source.readRect(x0, y0, w, h, srcBuf);

  const touched = new Set<Tile>();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const coverage = mask ? mask.alphaAt(x, y) / 255 : 1;
      if (coverage <= 0) continue;
      const si = ((y - y0) * w + (x - x0)) * 4;
      const sa = srcBuf[si + 3]!;
      if (sa === 0) continue; // transparent source leaves base untouched

      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      const tile = base.tile(tx, ty, true)!;
      const p = ((y - ty * TILE) * TILE + (x - tx * TILE)) * 4;

      coBlendPixel(
        mode,
        srcBuf[si]!, srcBuf[si + 1]!, srcBuf[si + 2]!, sa,
        tile.data, p,
        op * coverage,
      );
      touched.add(tile);
    }
  }
  if (touched.size) {
    for (const t of touched) t.version++;
    base.touch();
  }
}

/**
 * Coverage map (0..255) for `r` (length w*h, row-major), computed from the
 * chosen channel of base and source with the same separable blend and opacity.
 * For the opaque case this is `opacity*B(cb,cs) + (1-opacity)*cb`, i.e. the
 * exact channel value `applyImageToGrid` would write for that blend. Pixels
 * outside either grid's bounds are clipped to 0. Deterministic; no alpha or
 * mask is applied here (channel values are read straight, neutral 0).
 */
export function calculateMask(
  base: TileGrid,
  source: TileGrid,
  r: OpRect,
  channel: "red" | "green" | "blue" | "coLuma",
  mode: BlendModeName,
  opacity: number,
): Uint8ClampedArray {
  const w = Math.max(0, Math.floor(r.w)), h = Math.max(0, Math.floor(r.h));
  const out = new Uint8ClampedArray(w * h);
  if (!w || !h) return out;
  const op = coClamp01(opacity);
  const x0 = Math.floor(r.x), y0 = Math.floor(r.y);

  const baseBuf = new Uint8ClampedArray(w * h * 4);
  const srcBuf = new Uint8ClampedArray(w * h * 4);
  base.readRect(x0, y0, w, h, baseBuf);
  source.readRect(x0, y0, w, h, srcBuf);

  const ch = channel === "red" ? 0 : channel === "green" ? 1 : channel === "blue" ? 2 : -1;
  for (let i = 0; i < w * h; i++) {
    const gx = x0 + (i % w), gy = y0 + Math.floor(i / w);
    if (gx < 0 || gy < 0 || gx >= base.width || gy >= base.height ||
        gx < 0 || gy < 0 || gx >= source.width || gy >= source.height) {
      out[i] = 0; // clipped to both grids
      continue;
    }
    const p = i * 4;
    const cb = ch < 0
      ? coLuma(baseBuf[p]! / 255, baseBuf[p + 1]! / 255, baseBuf[p + 2]! / 255)
      : baseBuf[p + ch]! / 255;
    const cs = ch < 0
      ? coLuma(srcBuf[p]! / 255, srcBuf[p + 1]! / 255, srcBuf[p + 2]! / 255)
      : srcBuf[p + ch]! / 255;
    const blended = coChannelBlend(mode, cb, cs);
    out[i] = coClamp01((1 - op) * cb + op * blended) * 255;
  }
  return out;
}
