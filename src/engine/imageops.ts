/**
 * imageops.ts — document-level geometry: rotation, flips and trimming.
 *
 * These return a NEW Document (layers are re-anchored, never resampled) so the
 * caller can swap it into the tab exactly like Canvas Size does.
 */

import { Document, flattenTree, rebuildTree, type Layer } from "./document.ts";
import { TileGrid, TILE } from "./tile.ts";

/** read a whole grid, transform every pixel, write it back in one go */
/**
 * One-shot whole-layer remap for Rotate/Flip menu commands (user-paced,
 * inherently whole-document; NOT a per-frame path — handoff-2 N rationale).
 *
 * Only the source tiles that exist are visited, and each writes just its own
 * mapped rect. The previous version read the whole grid and called
 * `writeRect(0, 0, w, h, …, true)`, which allocated every destination tile —
 * a 4096² document with three nodes jumped to 768 tile slots and Save then
 * refused at 512 (code-r9 #3).
 */
function remapGrid(
  src: TileGrid,
  dst: TileGrid,
  map: (x: number, y: number) => [number, number],
): void {
  const sw = src.width, sh = src.height;
  src.forEachTile((_tile, tx, ty) => {
    const x0 = tx * TILE, y0 = ty * TILE;
    const tw = Math.min(TILE, sw - x0), th = Math.min(TILE, sh - y0);
    if (tw <= 0 || th <= 0) return;
    // A 90° turn or a flip maps an axis-aligned rect to an axis-aligned rect,
    // so the destination is the bbox of the four mapped corners.
    let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
    for (const cx of [x0, x0 + tw - 1]) {
      for (const cy of [y0, y0 + th - 1]) {
        const [nx, ny] = map(cx, cy);
        if (nx < ax) ax = nx;
        if (nx > bx) bx = nx;
        if (ny < ay) ay = ny;
        if (ny > by) by = ny;
      }
    }
    const dx0 = Math.max(0, ax), dy0 = Math.max(0, ay);
    const dx1 = Math.min(dst.width - 1, bx), dy1 = Math.min(dst.height - 1, by);
    if (dx1 < dx0 || dy1 < dy0) return;
    const dw = dx1 - dx0 + 1, dh = dy1 - dy0 + 1;
    const out = new Uint8ClampedArray(dw * dh * 4);
    const raw = new Uint8ClampedArray(tw * th * 4);
    src.readRect(x0, y0, tw, th, raw);
    for (let ly = 0; ly < th; ly++) {
      for (let lx = 0; lx < tw; lx++) {
        const [nx, ny] = map(x0 + lx, y0 + ly);
        if (nx < dx0 || ny < dy0 || nx > dx1 || ny > dy1) continue;
        const si = (ly * tw + lx) * 4;
        const di = ((ny - dy0) * dw + (nx - dx0)) * 4;
        out[di] = raw[si]!;
        out[di + 1] = raw[si + 1]!;
        out[di + 2] = raw[si + 2]!;
        out[di + 3] = raw[si + 3]!;
      }
    }
    dst.writeRect(dx0, dy0, dw, dh, out);
  });
}

/**
 * Build the destination tree for a whole-document remap.
 *
 * A group is a node with children; the old loop copied only `src.layers`, so a
 * rotate/flip left every group empty. Every layer gets a grid of the new size
 * here; the caller remaps pixels into them.
 */
function newDocLike(src: Document, width: number, height: number): Document {
  const out = new Document(width, height);
  out.layers.length = 0;
  rebuildTree(src.layers, out, null, (_layer, dst) => {
    dst.grid = new TileGrid(width, height, out.writeHook);
  });
  return out;
}

/** pairs of (source, destination) in the same depth-first order */
function layerPairs(src: Document, out: Document): Array<[Layer, Layer]> {
  const a = flattenTree(src.layers), b = flattenTree(out.layers);
  return a.map((l, i) => [l, b[i]!] as [Layer, Layer]);
}

/** rotate a whole document by 90° (dir = 1 clockwise, -1 counter-clockwise) */
export function rotate90(src: Document, dir: 1 | -1): Document {
  const w = src.height, h = src.width;
  const out = newDocLike(src, w, h);
  for (const [layer, nl] of layerPairs(src, out)) {
    remapGrid(layer.grid, nl.grid, (x, y) =>
      dir === 1 ? [src.height - 1 - y, x] : [y, src.width - 1 - x],
    );
    if (layer.mask) {
      const nm = new TileGrid(w, h, out.writeHook);
      remapGrid(layer.mask, nm, (x, y) =>
        dir === 1 ? [src.height - 1 - y, x] : [y, src.width - 1 - x],
      );
      nl.mask = nm;
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
  for (const [layer, nl] of layerPairs(src, out)) {
    remapGrid(layer.grid, nl.grid, map);
    if (layer.mask) {
      const nm = new TileGrid(src.width, src.height, out.writeHook);
      remapGrid(layer.mask, nm, map);
      nl.mask = nm;
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
