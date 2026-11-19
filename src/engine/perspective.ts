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
import { TileGrid } from "./tile.ts";

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

/** Axis-aligned size of the quad's bounding box, in whole pixels. */
export function quadSize(q: Quad): { w: number; h: number } {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return {
    w: Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs))),
    h: Math.max(1, Math.round(Math.max(...ys) - Math.min(...ys))),
  };
}

/** Premultiplied bilinear sample; returns [r,g,b,a] with a in 0..255. */
function samplePremul(
  px: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array,
): void {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0, wsum = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const sx = Math.min(w - 1, Math.max(0, x0 + dx));
      const sy = Math.min(h - 1, Math.max(0, y0 + dy));
      const wt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (wt <= 0) continue;
      const i = (sy * w + sx) * 4;
      const sa = px[i + 3]!;
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
  out[3] = wsum > 0 ? a / wsum : 0;
}

/** Read a whole grid into premultiplied-friendly floats (rgb straight, a 0..255). */
function readPremul(grid: TileGrid, w: number, h: number): Float32Array {
  const bytes = new Uint8ClampedArray(w * h * 4);
  grid.readRect(0, 0, w, h, bytes);
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]!;
  return out;
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
  const shifted: Quad = quad.map(([x, y]) => [x - minX, y - minY]) as Quad;
  const map = squareToQuad(shifted);

  const doc = new Document(w, h);
  const tmp = new Float32Array(4);
  for (const layer of src.layers) {
    const out = doc.addLayer(layer.name);
    out.kind = layer.kind;
    out.visible = layer.visible;
    out.opacity = layer.opacity;
    out.blendMode = layer.blendMode;
    out.locked = layer.locked;
    out.groupId = layer.groupId;
    out.clipToBelow = layer.clipToBelow;
    if (layer.adjust) out.adjust = JSON.parse(JSON.stringify(layer.adjust));
    if (layer.fill) out.fill = { color: [...layer.fill.color] as [number, number, number] };
    // AC2: a text recipe is an axis-aligned box + baseline; a projective warp
    // cannot be expressed in it, so the layer becomes plain pixels and stops
    // claiming to be re-editable (a stale recipe would re-render the OLD text).
    if (layer.textData) void layer.textData;
    if (layer.kind !== "pixel") continue;

    const sw = src.width, sh = src.height;
    const px = readPremul(layer.grid, sw, sh);
    const dst = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const [sx, sy] = mapPoint(map, u, v);
        const gx = sx + minX, gy = sy + minY;
        // AC3: a degenerate homography yields NaN, and every comparison against
        // NaN is false — so without this the loop would sample NaN forever.
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
        if (gx < -1 || gy < -1 || gx > sw || gy > sh) continue;
        samplePremul(px, sw, sh, gx - 0.5, gy - 0.5, tmp);
        const i = (y * w + x) * 4;
        dst[i] = tmp[0]!;
        dst[i + 1] = tmp[1]!;
        dst[i + 2] = tmp[2]!;
        dst[i + 3] = tmp[3]!;
      }
    }
    out.grid = new TileGrid(w, h);
    out.grid.writeRect(0, 0, w, h, dst);

    if (layer.mask) {
      const mask = new TileGrid(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [sx, sy] = mapPoint(map, (x + 0.5) / w, (y + 0.5) / h);
          if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
          const gx = Math.round(sx + minX), gy = Math.round(sy + minY);
          if (gx < 0 || gy < 0 || gx >= sw || gy >= sh) continue;
          const cov = maskAt(layer.mask, gx, gy);
          if (cov >= 255) continue; // unallocated tile already means "reveal"
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
