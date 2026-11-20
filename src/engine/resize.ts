/**
 * resize.ts — Image Size (resample every layer) and Canvas Size
 * (re-anchor every layer in a bigger/smaller canvas).
 *
 * Both return a NEW Document; the caller swaps it into the tab. Undo
 * history is NOT carried across a resize (entries reference the old
 * layer objects) — the UI gives the new document a fresh History.
 *
 * Interpolation: bilinear, destination → source mapping with edge
 * clamp, so the outermost pixels extend outward (same convention as
 * the blur/sharpen kernel sampling).
 */

import { TileGrid, TILE } from "./tile.ts";
import { emptySample, readGridRGBA, samplePremul, straightRGB } from "./sample.ts";
import { Document, cloneLayerMeta, type Layer } from "./document.ts";
import { recipeAfterScale } from "./textmap.ts";

/** bilinear resample of a grid into a NEW grid of the given size */
export function resampleGrid(grid: TileGrid, newW: number, newH: number, onWrite?: () => void): TileGrid {
  const w = grid.width, h = grid.height;
  const out = new TileGrid(newW, newH, onWrite);
  if (w === newW && h === newH) {
    // identity: byte-exact copy of allocated tiles
    grid.forEachTile((t, tx, ty) => {
      out.writeRect(tx * TILE, ty * TILE, TILE, TILE, t.data);
    });
    return out;
  }
  const src = readGridRGBA(grid, w, h);
  const dst = new Uint8ClampedArray(newW * newH * 4);
  const fx = w / newW, fy = h / newH;
  const s = emptySample();
  const rgb = new Float32Array(3);
  for (let y = 0; y < newH; y++) {
    // source coords of this dest row's centre; clamped so the edge stretches
    const sy = (y + 0.5) * fy - 0.5;
    for (let x = 0; x < newW; x++) {
      const sx = (x + 0.5) * fx - 0.5;
      samplePremul(src, w, h, sx, sy, s, true);
      const d = (y * newW + x) * 4;
      straightRGB(s, rgb);
      if (s.a > 0) {
        dst[d] = rgb[0]!;
        dst[d + 1] = rgb[1]!;
        dst[d + 2] = rgb[2]!;
      }
      dst[d + 3] = s.a * 255;
    }
  }
  out.writeRect(0, 0, newW, newH, dst);
  return out;
}

function scaleText(layer: Layer, fx: number, fy: number): void {
  const m = layer.textData;
  if (!m) return;
  // AP5: wrap and boxH are pixel quantities too — scaling only w/h left a 200 %
  // enlargement re-wrapping at the old width (see engine/textmap.ts).
  layer.textData = recipeAfterScale(m, fx, fy);
}

/** Image Size: resample every layer (and scale text metadata) to newW×newH */
export function resizeDocument(doc: Document, newW: number, newH: number): Document {
  const out = new Document(newW, newH);
  const fx = newW / doc.width, fy = newH / doc.height;
  for (const l of doc.layers) {
    const layer = out.addLayer(l.name);
    layer.grid = resampleGrid(l.grid, newW, newH, out.writeHook);
    // every recipe field (kind/adjust/fill/clip/group…) survives an Image
    // Size — cloneLayerMeta is the shared list, kept in sync with the
    // project serializer. Masks resample with the same geometry.
    cloneLayerMeta(layer, l);
    if (l.mask) layer.mask = resampleGrid(l.mask, newW, newH, out.writeHook);
    if (l.textData) {
      layer.textData = { ...l.textData, lines: l.textData.lines.map(segs => segs.map(s => ({ ...s }))) };
      scaleText(layer, fx, fy);
    }
  }
  return out;
}

/** Canvas Size: keep every layer's pixels, re-anchored in a new canvas.
 *  ax/ay: 0 = left/top edge, 0.5 = center, 1 = right/bottom edge. */
export function canvasResizeDocument(doc: Document, newW: number, newH: number, ax: number, ay: number): Document {
  return reanchorDocument(doc, newW, newH, Math.round((newW - doc.width) * ax), Math.round((newH - doc.height) * ay));
}

/**
 * Crop: same machinery as Canvas Size, but the content is shifted by
 * (-x,-y) so the crop rectangle lands at the new origin. Out-of-bounds
 * pixels are clipped by writeRect.
 */
export function cropDocument(doc: Document, x: number, y: number, w: number, h: number): Document {
  const cw = Math.max(1, Math.min(doc.width - x, w));
  const ch = Math.max(1, Math.min(doc.height - y, h));
  return reanchorDocument(doc, cw, ch, -x, -y);
}

/** copy every layer's tiles into a new doc of the given size, offset by (dx,dy) */
function reanchorDocument(doc: Document, newW: number, newH: number, dx: number, dy: number): Document {
  const out = new Document(newW, newH);
  for (const l of doc.layers) {
    const layer = out.addLayer(l.name);
    layer.grid = new TileGrid(newW, newH, out.writeHook);
    // copy allocated tiles over with the anchor offset (auto-clipped)
    l.grid.forEachTile((t, tx, ty) => {
      layer.grid.writeRect(tx * TILE + dx, ty * TILE + dy, TILE, TILE, t.data);
    });
    // recipe fields (kind/adjust/fill/clip/group…) + the mask, re-anchored
    // with the same offset (Canvas Size / Crop must not drop either)
    cloneLayerMeta(layer, l);
    if (l.mask) {
      const nm = out.attachMask(layer);
      l.mask.forEachTile((t, tx, ty) => {
        nm.writeRect(tx * TILE + dx, ty * TILE + dy, TILE, TILE, t.data);
      });
    }
    if (l.textData) {
      layer.textData = { ...l.textData, x: l.textData.x + dx, y: l.textData.y + dy,
        lines: l.textData.lines.map(segs => segs.map(s => ({ ...s }))) };
    }
  }
  return out;
}
