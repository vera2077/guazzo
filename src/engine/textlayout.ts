/**
 * textlayout.ts — deterministic, DOM-free transforms over an already-rasterised
 * text glyph buffer.
 *
 * A `Raster` is a row-major RGBA byte buffer, `cw` cells wide and `ch` cells
 * tall. Nothing here touches the DOM or performs I/O, so the browser canvas
 * controller and `node:test` can share the exact same maths. Every function
 * returns a NEW buffer and never mutates its input. Sampling is always
 * nearest-neighbour and copies the whole RGBA texel (alpha included).
 */

export interface Raster {
  rgba: Uint8ClampedArray;
  cw: number;
  ch: number;
}

/** Fresh, independent copy of a raster (used for the invalid-input fallback). */
function copyRaster(src: Raster): Raster {
  return { rgba: new Uint8ClampedArray(src.rgba), cw: src.cw, ch: src.ch };
}

/**
 * Rotate a raster by an exact quarter turn, nearest-neighbour.
 *
 * `90` is clockwise, `-90` is counter-clockwise and `180` is a half turn.
 * Quarter turns swap width/height; a half turn keeps them. The mapping is
 * destination → source so a whole source texel (including alpha) is copied
 * for every output pixel, with no interpolation.
 */
export function rotateRaster(src: Raster, degrees: 90 | -90 | 180): Raster {
  const { cw, ch, rgba } = src;
  const swap = degrees === 90 || degrees === -90;
  const outW = swap ? ch : cw;
  const outH = swap ? cw : ch;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let sx: number;
      let sy: number;
      if (degrees === 90) {
        // Clockwise: source top-left ends up at output top-right.
        // outW === ch here, so sy stays within [0, ch).
        sx = oy;
        sy = ch - 1 - ox;
      } else if (degrees === -90) {
        // Counter-clockwise: source top-left ends up at output bottom-left.
        // outH === cw here, so sx stays within [0, cw).
        sx = cw - 1 - oy;
        sy = ox;
      } else {
        // Half turn: reverse both axes.
        sx = cw - 1 - ox;
        sy = ch - 1 - oy;
      }
      const si = (sy * cw + sx) * 4;
      const di = (oy * outW + ox) * 4;
      out[di] = rgba[si]!;
      out[di + 1] = rgba[si + 1]!;
      out[di + 2] = rgba[si + 2]!;
      out[di + 3] = rgba[si + 3]!;
    }
  }
  return { rgba: out, cw: outW, ch: outH };
}

/** Closest point on segment A→B to P, with the arc-length fraction `t`. */
function closestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { t: number; cx: number; cy: number; dist2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return { t, cx, cy, dist2: ex * ex + ey * ey };
}

/**
 * Bend a glyph along a polyline.
 *
 * The anchors form a path with cumulative arc length `s`. For every output
 * pixel we find the nearest point on that path, take `u = s / spacing` and the
 * signed perpendicular offset `v`, then sample the source at
 * `(floor(u), floor(v + ch / 2))`. The glyph therefore advances one source
 * column per `spacing` units of travel and is centred on the path in `v`.
 * The output covers the path's bounding box padded by `ch` pixels. Invalid
 * anchors (fewer than two distinct finite points) or a non-positive spacing
 * yield an independent copy of `src`.
 */
export function placeRasterOnPath(
  src: Raster,
  anchors: readonly { x: number; y: number }[],
  spacing = 1,
): Raster {
  if (!Number.isFinite(spacing) || spacing <= 0 || anchors.length < 2) {
    return copyRaster(src);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of anchors) {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return copyRaster(src);
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
  }

  let total = 0;
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (!(total > 0)) return copyRaster(src); // no two distinct points

  const pad = Math.floor(src.ch / 2);
  const halfCh = src.ch / 2;
  const outW = Math.ceil(maxX - minX) + src.ch;
  const outH = Math.ceil(maxY - minY) + src.ch;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const wy = minY + oy - pad;
    for (let ox = 0; ox < outW; ox++) {
      const wx = minX + ox - pad;

      // Locate the closest path point, its arc length and its tangent.
      let bestDist2 = Infinity;
      let bestS = 0;
      let bestPx = anchors[0]!.x;
      let bestPy = anchors[0]!.y;
      let bestTx = 1;
      let bestTy = 0;
      let cumulative = 0;
      for (let i = 0; i + 1 < anchors.length; i++) {
        const a = anchors[i]!;
        const b = anchors[i + 1]!;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const q = closestOnSegment(wx, wy, a.x, a.y, b.x, b.y);
        if (q.dist2 < bestDist2) {
          bestDist2 = q.dist2;
          bestS = cumulative + q.t * segLen;
          bestPx = q.cx;
          bestPy = q.cy;
          if (segLen > 0) {
            bestTx = (b.x - a.x) / segLen;
            bestTy = (b.y - a.y) / segLen;
          }
        }
        cumulative += segLen;
      }

      const sx = Math.floor(bestS / spacing);
      // Left-hand normal of the tangent; signed distance along it is `v`.
      const nx = -bestTy;
      const ny = bestTx;
      const v = (wx - bestPx) * nx + (wy - bestPy) * ny;
      const sy = Math.floor(v + halfCh);

      if (sx < 0 || sx >= src.cw || sy < 0 || sy >= src.ch) continue;
      const si = (sy * src.cw + sx) * 4;
      const di = (oy * outW + ox) * 4;
      out[di] = src.rgba[si]!;
      out[di + 1] = src.rgba[si + 1]!;
      out[di + 2] = src.rgba[si + 2]!;
      out[di + 3] = src.rgba[si + 3]!;
    }
  }
  return { rgba: out, cw: outW, ch: outH };
}
