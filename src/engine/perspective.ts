/**
 * perspective.ts — Perspective Crop (handoff backlog).
 *
 * The user drags four corners in the document; the quadrilateral is mapped to
 * an axis-aligned rectangle of the size they asked for. Sampling runs BACKWARDS
 * (destination → source) with premultiplied bilinear filtering, so transparent
 * neighbours can never bleed black halos into the result and no output pixel is
 * left unwritten.
 *
 * Pure and DOM-free: callers hand in a Document and get a new one back, which is
 * what makes the operation undoable as a single document swap.
 */
import { Document, maskAt, setMaskAt, type Layer } from "./document.ts";
import { TILE, TileGrid } from "./tile.ts";

export type Quad = [
  [number, number], [number, number], [number, number], [number, number],
];

interface Homography { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number }

/**
 * Unit square → quad projective map (Heckbert's closed form). Mapping the
 * SQUARE forward and sampling backwards means we never invert a matrix in a
 * degenerate case; a collapsed quad simply produces a degenerate map and the
 * caller's clamp keeps reads inside the grid.
 */
export function squareToQuad(q: Quad): Homography {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (det === 0) throw new Error("perspective: the crop corners are collinear");
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h,
  };
}

/** Apply a homography to unit-square coordinates. */
export function mapPoint(m: Homography, u: number, v: number): [number, number] {
  const w = m.g * u + m.h * v + 1;
  return [
    (m.a * u + m.b * v + m.c) / w,
    (m.d * u + m.e * v + m.f) / w,
  ];
}

/**
 * Same maths as `mapPoint`, writing into a caller-owned pair. `mapPoint` returns
 * a fresh tuple, and the warp calls it once per destination pixel per layer —
 * 335 million allocations for a five-layer 8192² crop, which the GC paid for.
 */
export function mapPointInto(m: Homography, u: number, v: number, out: Float64Array): void {
  const w = m.g * u + m.h * v + 1;
  out[0] = (m.a * u + m.b * v + m.c) / w;
  out[1] = (m.d * u + m.e * v + m.f) / w;
}

/** Axis-aligned size of the quad's bounding box, in whole pixels. */
export function quadSize(q: Quad): { w: number; h: number } {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return {
    w: Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs))),
    h: Math.max(1, Math.round(Math.max(...ys) - Math.min(...ys))),
  };
}

/**
 * Premultiplied bilinear sample of a float straight-RGBA buffer.
 *
 * This is the third caller of the same maths (see engine/sample.ts for the byte
 * version used by resize/transform). It stays a thin wrapper rather than
 * reading the source bytes directly: a float copy of the window only ever held
 * exact integers 0..255, so it cost 4x the memory and quantised nothing away.
 * `wsum` lets the caller divide alpha by the covered footprint, so a pixel whose
 * footprint hangs off the source does not get a full-strength alpha edge.
 */
function samplePerspective(
  px: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: Float32Array,
): void {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let wsum = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const wt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (wt <= 0) continue;
      const sx = Math.min(w - 1, Math.max(0, x0 + dx));
      const sy = Math.min(h - 1, Math.max(0, y0 + dy));
      const i = (sy * w + sx) * 4;
      const sa = px[i + 3]! / 255;
      r += px[i]! * sa * wt;
      g += px[i + 1]! * sa * wt;
      b += px[i + 2]! * sa * wt;
      a += sa * wt;
      wsum += wt;
    }
  }
  out[0] = a > 0 ? r / a : 0;
  out[1] = a > 0 ? g / a : 0;
  out[2] = a > 0 ? b / a : 0;
  out[3] = wsum > 0 ? (a / wsum) * 255 : 0;
}

export interface PerspectiveResult { doc: Document; w: number; h: number }

/**
 * Project `quad` (document coordinates, clockwise from top-left) onto a
 * `outW × outH` rectangle and return a NEW document with the same layers.
 */
export function perspectiveCrop(src: Document, quad: Quad, outW: number, outH: number): PerspectiveResult {
  const w = Math.max(1, Math.round(outW));
  const h = Math.max(1, Math.round(outH));
  // Bounding box of the quad: the source grid is sampled by absolute coords, so
  // shifting by the box origin keeps the float maths small and stable.
  const minX = Math.min(...quad.map((p) => p[0]));
  const minY = Math.min(...quad.map((p) => p[1]));
  const maxX = Math.max(...quad.map((p) => p[0]));
  const maxY = Math.max(...quad.map((p) => p[1]));
  const shifted: Quad = quad.map(([x, y]) => [x - minX, y - minY]) as Quad;
  const map = squareToQuad(shifted);

  // The projector only samples inside the quad, so keep one pixel of bilinear
  // fringe around its bbox and leave the rest of the source unread.
  const bx = Math.max(0, Math.floor(minX) - 1);
  const by = Math.max(0, Math.floor(minY) - 1);
  const bw = Math.max(0, Math.min(src.width, Math.ceil(maxX) + 1) - bx);
  const bh = Math.max(0, Math.min(src.height, Math.ceil(maxY) + 1) - by);

  const doc = new Document(w, h);
  const tmp = new Float32Array(4);
  const xy = new Float64Array(2);
  const sw = src.width;
  const sh = src.height;
  // AP3 (perf): the warp samples the source in horizontal strips. It used to
  // copy the quad's whole bounding box into a float buffer before sampling —
  // 20 bytes per source pixel, i.e. 5.4 GB for a full-canvas 16k crop. Each
  // strip now reads only the source window that strip can reach, so the working
  // set is bounded by the strip height, and the sampler reads bytes directly.
  const STRIP_ROWS = 64;
  const STRIP_PIXEL_BUDGET = 8_000_000; // source pixels one strip may read
  let stripBytes = new Uint8ClampedArray(0);
  let stripOut = new Uint8ClampedArray(0);

  for (const layer of src.layers) {
    const out = doc.addLayer(layer.name);
    out.kind = layer.kind;
    out.visible = layer.visible;
    out.opacity = layer.opacity;
    out.blendMode = layer.blendMode;
    out.locked = layer.locked;
    out.groupId = layer.groupId;
    out.clipToBelow = layer.clipToBelow;
    // polarity travels with the mask: a hide-polarity mask (maskHide) reads an
    // unallocated tile as hidden, and dropping the flag would reveal everything
    // the crop never allocated.
    out.maskHide = layer.maskHide;
    if (layer.adjust) out.adjust = JSON.parse(JSON.stringify(layer.adjust));
    if (layer.fill) out.fill = { color: [...layer.fill.color] as [number, number, number] };
    // AC2: a text recipe is an axis-aligned box + baseline; a projective warp
    // cannot be expressed in it, so the layer becomes plain pixels and stops
    // claiming to be re-editable (a stale recipe would re-render the OLD text).
    if (layer.textData) void layer.textData;
    if (layer.kind !== "pixel" || bw === 0 || bh === 0) continue;

    // The image of a destination strip is a quadrilateral, so its extremes are
    // at the mapping of the strip's four corners. Two pixels of fringe cover
    // the bilinear taps.
    const windowFor = (top: number, count: number): { x: number; y: number; w: number; h: number } => {
      const corners: Array<readonly [number, number]> = [
        [0, top],
        [w, top],
        [w, top + count],
        [0, top + count],
      ].map(([cx, cy]) => {
        mapPointInto(map, (cx! + 0.5) / w, (cy! + 0.5) / h, xy);
        return [xy[0]! + minX, xy[1]! + minY] as const;
      });
      if (!corners.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
        return { x: bx, y: by, w: bw, h: bh };
      }
      const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 2);
      const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 2);
      const x1 = Math.min(sw, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 2);
      const y1 = Math.min(sh, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 2);
      return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
    };

    const outGrid = new TileGrid(w, h, doc.writeHook);
    for (let y0 = 0; y0 < h; ) {
      let rows = Math.min(STRIP_ROWS, h - y0);
      let win = windowFor(y0, rows);
      // A pathological homography can make one strip reach the whole source;
      // halve the strip until the window fits (or the strip is one row).
      while (win.w * win.h > STRIP_PIXEL_BUDGET && rows > 1) {
        rows = Math.max(1, rows >> 1);
        win = windowFor(y0, rows);
      }
      const { x: wx, y: wy, w: ww, h: wh } = win;
      const outNeed = rows * w * 4;
      if (stripOut.length < outNeed) stripOut = new Uint8ClampedArray(outNeed);
      const dst = stripOut.subarray(0, outNeed);
      dst.fill(0);
      if (ww > 0 && wh > 0) {
        const need = ww * wh * 4;
        if (stripBytes.length < need) stripBytes = new Uint8ClampedArray(need);
        layer.grid.readRect(wx, wy, ww, wh, stripBytes.subarray(0, need));
        for (let ry = 0; ry < rows; ry++) {
          const v = (y0 + ry + 0.5) / h;
          for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w;
            mapPointInto(map, u, v, xy);
            const gx = xy[0]! + minX, gy = xy[1]! + minY;
            // AC3: a degenerate homography yields NaN, and every comparison
            // against NaN is false — so without this the loop samples NaN.
            if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
            if (gx < -1 || gy < -1 || gx > sw || gy > sh) continue;
            // Corner bboxes are exact for a convex strip; this guard only
            // catches numeric fuzz at the fringe, never a real pixel.
            if (gx < wx - 2 || gy < wy - 2 || gx > wx + ww + 1 || gy > wy + wh + 1) continue;
            samplePerspective(stripBytes, ww, wh, gx - wx - 0.5, gy - wy - 0.5, tmp);
            const i = (ry * w + x) * 4;
            dst[i] = tmp[0]!;
            dst[i + 1] = tmp[1]!;
            dst[i + 2] = tmp[2]!;
            dst[i + 3] = tmp[3]!;
          }
        }
      }
      outGrid.writeRect(0, y0, w, rows, dst);
      y0 += rows;
    }
    out.grid = outGrid;

    if (layer.mask) {
      const mask = new TileGrid(w, h, doc.writeHook);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          mapPointInto(map, (x + 0.5) / w, (y + 0.5) / h, xy);
          if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
          const gx = Math.round(xy[0]! + minX), gy = Math.round(xy[1]! + minY);
          if (gx < 0 || gy < 0 || gx >= sw || gy >= sh) continue;
          // neutral = what an unallocated tile means for THIS polarity
          const neutral = layer.maskHide ? 0 : 255;
          const cov = maskAt(layer.mask, gx, gy, neutral);
          if (cov === neutral) continue;
          // Allocating a destination tile decides the meaning of every pixel in
          // it that is not written. A fresh tile is all zeros, i.e. "reveal", so
          // under hide polarity one stray visible pixel would reveal its whole
          // 256x256 tile. Seed the tile hidden before the first write into it.
          if (layer.maskHide && !mask.tile(Math.floor(x / TILE), Math.floor(y / TILE), false)) {
            const seeded = mask.tile(Math.floor(x / TILE), Math.floor(y / TILE), true);
            if (seeded) {
              seeded.data.fill(255);
              seeded.version++;
            }
          }
          setMaskAt(mask, x, y, cov);
        }
      }
      out.mask = mask;
    }
  }
  return { doc, w, h };
}

/** Layer is only used for typing here; kept explicit so the copy list is obvious. */
export type PerspectiveLayer = Layer;
