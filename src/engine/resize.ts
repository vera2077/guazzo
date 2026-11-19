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
import { Document, cloneLayerMeta, type Layer } from "./document.ts";

/** bilinear resample of a grid into a NEW grid of the given size */
export function resampleGrid(grid: TileGrid, newW: number, newH: number): TileGrid {
  const w = grid.width, h = grid.height;
  const out = new TileGrid(newW, newH);
  if (w === newW && h === newH) {
    // identity: byte-exact copy of allocated tiles
    grid.forEachTile((t, tx, ty) => {
      out.writeRect(tx * TILE, ty * TILE, TILE, TILE, t.data);
    });
    return out;
  }
  const src = new Uint8ClampedArray(w * h * 4);
  grid.readRect(0, 0, w, h, src);
  const dst = new Uint8ClampedArray(newW * newH * 4);
  const fx = w / newW, fy = h / newH;
  // PREMULTIPLIED bilinear: transparent texels read as (0,0,0,0), so sampling
  // straight RGBA pulls that black into every downscale and paints dark
  // fringes at alpha edges. Accumulate rgb·a, divide by the interpolated
  // alpha — the same convention as transform.ts's sampler.
  for (let y = 0; y < newH; y++) {
    // source coords of this dest row's center, clamped to valid range
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const tyv = sy - y0;
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const txv = sx - x0;
      const d = (y * newW + x) * 4;
      const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      let a = 0, r = 0, g = 0, b = 0;
      {
        const al = src[i00 + 3]! / 255, wt = (1 - txv) * (1 - tyv);
        r += wt * src[i00]! * al; g += wt * src[i00 + 1]! * al; b += wt * src[i00 + 2]! * al; a += wt * al;
      }
      {
        const al = src[i10 + 3]! / 255, wt = txv * (1 - tyv);
        r += wt * src[i10]! * al; g += wt * src[i10 + 1]! * al; b += wt * src[i10 + 2]! * al; a += wt * al;
      }
      {
        const al = src[i01 + 3]! / 255, wt = (1 - txv) * tyv;
        r += wt * src[i01]! * al; g += wt * src[i01 + 1]! * al; b += wt * src[i01 + 2]! * al; a += wt * al;
      }
      {
        const al = src[i11 + 3]! / 255, wt = txv * tyv;
        r += wt * src[i11]! * al; g += wt * src[i11 + 1]! * al; b += wt * src[i11 + 2]! * al; a += wt * al;
      }
      if (a > 0) {
        dst[d] = r / a;
        dst[d + 1] = g / a;
        dst[d + 2] = b / a;
      }
      dst[d + 3] = a * 255;
    }
  }
  out.writeRect(0, 0, newW, newH, dst);
  return out;
}

function scaleText(layer: Layer, fx: number, fy: number): void {
  const m = layer.textData;
  if (!m) return;
  m.x *= fx;
  m.y *= fy;
  m.w *= fx;
  m.h *= fy;
  m.size = Math.max(1, m.size * Math.sqrt(fx * fy));
}

/** Image Size: resample every layer (and scale text metadata) to newW×newH */
export function resizeDocument(doc: Document, newW: number, newH: number): Document {
  const out = new Document(newW, newH);
  const fx = newW / doc.width, fy = newH / doc.height;
  for (const l of doc.layers) {
    const layer = out.addLayer(l.name);
    layer.grid = resampleGrid(l.grid, newW, newH);
    // every recipe field (kind/adjust/fill/clip/group…) survives an Image
    // Size — cloneLayerMeta is the shared list, kept in sync with the
    // project serializer. Masks resample with the same geometry.
    cloneLayerMeta(layer, l);
    if (l.mask) layer.mask = resampleGrid(l.mask, newW, newH);
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
    layer.grid = new TileGrid(newW, newH);
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
