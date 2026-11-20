/**
 * imageops.ts — document-level geometry: rotation, flips and trimming.
 *
 * These return a NEW Document (layers are re-anchored, never resampled) so the
 * caller can swap it into the tab exactly like Canvas Size does.
 */

import { Document, cloneLayerMeta } from "./document.ts";
import { TileGrid } from "./tile.ts";

/** read a whole grid, transform every pixel, write it back in one go */
/** One-shot whole-layer remap for Rotate/Flip menu commands (user-paced,
 * inherently whole-document; NOT a per-frame path — handoff-2 N rationale). */
function remapGrid(
  src: TileGrid,
  dst: TileGrid,
  map: (x: number, y: number) => [number, number],
): void {
  const w = src.width, h = src.height;
  const raw = new Uint8ClampedArray(w * h * 4);
  src.readRect(0, 0, w, h, raw);
  const out = new Uint8ClampedArray(dst.width * dst.height * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [nx, ny] = map(x, y);
      if (nx < 0 || ny < 0 || nx >= dst.width || ny >= dst.height) continue;
      const si = (y * w + x) * 4;
      const di = (ny * dst.width + nx) * 4;
      out[di] = raw[si]!;
      out[di + 1] = raw[si + 1]!;
      out[di + 2] = raw[si + 2]!;
      out[di + 3] = raw[si + 3]!;
    }
  }
  dst.writeRect(0, 0, dst.width, dst.height, out);
}

function newDocLike(src: Document, width: number, height: number): Document {
  const out = new Document(width, height);
  out.layers.length = 0;
  for (const layer of src.layers) {
    const nl = out.addLayer(layer.name);
    // every recipe field (kind/adjust/fill/clip/group…) must survive a
    // rotate/flip — cloneLayerMeta is the shared field list, kept in
    // sync with the project serializer.
    cloneLayerMeta(nl, layer);
    nl.grid = new TileGrid(width, height, out.writeHook);
  }
  return out;
}

/** rotate a whole document by 90° (dir = 1 clockwise, -1 counter-clockwise) */
export function rotate90(src: Document, dir: 1 | -1): Document {
  const w = src.height, h = src.width;
  const out = newDocLike(src, w, h);
  for (let i = 0; i < src.layers.length; i++) {
    const layer = src.layers[i]!;
    const nl = out.layers[i]!;
    remapGrid(layer.grid, nl.grid, (x, y) =>
      dir === 1 ? [src.height - 1 - y, x] : [y, src.width - 1 - x],
    );
    if (layer.mask) {
      const nm = out.attachMask(nl);
      remapGrid(layer.mask, nm, (x, y) =>
        dir === 1 ? [src.height - 1 - y, x] : [y, src.width - 1 - x],
      );
    }
    // AP5: a rotated box cannot carry a horizontal baseline, and the old remap
    // kept `wrap` at its pre-rotation width, so re-editing re-wrapped wrongly.
    // The pixels are already rotated; drop the recipe rather than lie about it.
    if (layer.textData) nl.textData = undefined;
  }
  return out;
}

/** rotate by 180°, implemented as two quarter turns (exact, no interpolation) */
export function rotate180(src: Document): Document {
  return rotate90(rotate90(src, 1), 1);
}

/** mirror horizontally or vertically */
export function flip(src: Document, axis: "horizontal" | "vertical"): Document {
  const out = newDocLike(src, src.width, src.height);
  const map = (x: number, y: number): [number, number] => [
    axis === "horizontal" ? src.width - 1 - x : x,
    axis === "vertical" ? src.height - 1 - y : y,
  ];
  for (let i = 0; i < src.layers.length; i++) {
    const layer = src.layers[i]!;
    const nl = out.layers[i]!;
    remapGrid(layer.grid, nl.grid, map);
    if (layer.mask) {
      const nm = out.attachMask(nl);
      remapGrid(layer.mask, nm, map);
    }
    // AP5: a mirror reverses the baseline; dropping is honest (see textmap.ts).
    if (layer.textData) nl.textData = undefined;
  }
  return out;
}

/**
 * Trim: find the rectangle that excludes uniform border rows/columns.
 * `pixels` is the flattened composite; a border pixel counts as "same" when it
 * is within `tolerance` of the top-left pixel (Photoshop's default behaviour).
 */
export function trimBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 0,
): { x: number; y: number; w: number; h: number } | null {
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (y * width + x) * 4;
    return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
  };
  const [br, bg, bb, ba] = at(0, 0);
  const same = (x: number, y: number): boolean => {
    const [r, g, b, a] = at(x, y);
    return (
      Math.abs(r - br) <= tolerance &&
      Math.abs(g - bg) <= tolerance &&
      Math.abs(b - bb) <= tolerance &&
      Math.abs(a - ba) <= tolerance
    );
  };
  const rowSame = (y: number): boolean => {
    for (let x = 0; x < width; x++) if (!same(x, y)) return false;
    return true;
  };
  const colSame = (x: number): boolean => {
    for (let y = 0; y < height; y++) if (!same(x, y)) return false;
    return true;
  };
  let top = 0;
  while (top < height && rowSame(top)) top++;
  if (top === height) return null; // the whole canvas is the border colour
  let bottom = height - 1;
  while (bottom > top && rowSame(bottom)) bottom--;
  let left = 0;
  while (left < width && colSame(left)) left++;
  let right = width - 1;
  while (right > left && colSame(right)) right--;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
