/**
 * shapes.ts — vector-ish shape drawing for the Shape tool.
 *
 * Shapes are rasterised with 4×4 supersampling so edges are smooth at normal
 * zoom, and they honour the active selection mask. Everything goes through
 * the same source-over blend the brush uses, so the result is composable.
 */

import { TileGrid } from "./tile.ts";
import type { PixelMask } from "./mask.ts";

export type ShapeKind = "rectangle" | "rounded" | "ellipse" | "line" | "polygon" | "star";

export interface ShapeSpec {
  kind: ShapeKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill?: [number, number, number];
  fillAlpha?: number;
  stroke?: [number, number, number];
  strokeWidth?: number;
  sides?: number;
  innerRatio?: number;
  /** corner radius in document pixels, for kind "rounded" */
  radius?: number;
  mask?: PixelMask | null;
}

interface Poly {
  /** polygon points in doc space */
  pts: Array<[number, number]>;
  cx: number;
  cy: number;
}

function polygonPoints(spec: ShapeSpec): Poly {
  const cx = (spec.x0 + spec.x1) / 2;
  const cy = (spec.y0 + spec.y1) / 2;
  const rx = Math.abs(spec.x1 - spec.x0) / 2;
  const ry = Math.abs(spec.y1 - spec.y0) / 2;
  const pts: Array<[number, number]> = [];
  if (spec.kind === "polygon") {
    const n = Math.max(3, Math.round(spec.sides ?? 5));
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
  } else {
    const n = Math.max(3, Math.round(spec.sides ?? 5));
    const inner = Math.max(0.05, Math.min(0.95, spec.innerRatio ?? 0.45));
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
      const f = i % 2 === 0 ? 1 : inner;
      pts.push([cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f]);
    }
  }
  return { pts, cx, cy };
}

/** even-odd point-in-polygon at a sample point */
function inPoly(pts: Array<[number, number]>, px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** distance from a point to a segment, for stroke rendering */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** is a sample point inside a shape? used for both fill and stroke coverage */
function insideAt(spec: ShapeSpec, poly: Poly | null, px: number, py: number): boolean {
  const x0 = Math.min(spec.x0, spec.x1), x1 = Math.max(spec.x0, spec.x1);
  const y0 = Math.min(spec.y0, spec.y1), y1 = Math.max(spec.y0, spec.y1);
  switch (spec.kind) {
    case "rectangle":
      return px >= x0 && px <= x1 && py >= y0 && py <= y1;
    case "ellipse": {
      const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
      if (rx <= 0 || ry <= 0) return false;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const dx = (px - cx) / rx, dy = (py - cy) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case "rounded":
      // A rounded rectangle is a rectangle with a corner radius; the radius is
      // clamped to half the shorter side so a small drag cannot invert the shape.
      return roundedBoxDistance(spec, px, py) <= 0;
    case "line": {
      const half = Math.max(0.5, (spec.strokeWidth ?? 2) / 2);
      return distToSegment(px, py, spec.x0, spec.y0, spec.x1, spec.y1) <= half;
    }
    case "polygon":
    case "star":
      return poly ? inPoly(poly.pts, px, py) : false;
  }
}

/** signed distance to the edge of a rounded box; negative inside */
function roundedBoxDistance(spec: ShapeSpec, px: number, py: number): number {
  const rx = Math.abs(spec.x1 - spec.x0) / 2;
  const ry = Math.abs(spec.y1 - spec.y0) / 2;
  const r = Math.max(0, Math.min(spec.radius ?? 16, Math.min(rx, ry)));
  const cx = (spec.x0 + spec.x1) / 2;
  const cy = (spec.y0 + spec.y1) / 2;
  const qx = Math.abs(px - cx) - (rx - r);
  const qy = Math.abs(py - cy) - (ry - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** outline distance for stroking a filled shape */
function onOutline(spec: ShapeSpec, poly: Poly | null, px: number, py: number): boolean {
  const w = Math.max(1, spec.strokeWidth ?? 1) / 2;
  const x0 = Math.min(spec.x0, spec.x1), x1 = Math.max(spec.x0, spec.x1);
  const y0 = Math.min(spec.y0, spec.y1), y1 = Math.max(spec.y0, spec.y1);
  if (spec.kind === "line") return false;
  if (spec.kind === "rectangle") {
    const nearX = Math.abs(px - x0) <= w || Math.abs(px - x1) <= w;
    const nearY = Math.abs(py - y0) <= w || Math.abs(py - y1) <= w;
    const inBandX = px >= x0 - w && px <= x1 + w;
    const inBandY = py >= y0 - w && py <= y1 + w;
    return (nearX && inBandY) || (nearY && inBandX);
  }
  if (spec.kind === "rounded") return Math.abs(roundedBoxDistance(spec, px, py)) <= w;
  if (spec.kind === "ellipse") {
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    if (rx <= 0 || ry <= 0) return false;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
    return Math.abs(d - 1) * Math.min(rx, ry) <= w;
  }
  if (!poly) return false;
  for (let i = 0; i < poly.pts.length; i++) {
    const a = poly.pts[i]!;
    const b = poly.pts[(i + 1) % poly.pts.length]!;
    if (distToSegment(px, py, a[0], a[1], b[0], b[1]) <= w) return true;
  }
  return false;
}

const SS = 4; // supersampling grid per axis

/** draw a shape into `grid`; returns the affected rect or null */
/**
 * Outline points for polygon/star shapes, in document coordinates, so the UI
 * can preview exactly the geometry that `drawShape` will rasterise.
 * Returns null for kinds that are not polylines (rectangle, ellipse, line).
 */
export function shapePolyline(spec: ShapeSpec): Array<[number, number]> | null {
  if (spec.kind !== "polygon" && spec.kind !== "star") return null;
  return polygonPoints(spec).pts;
}

export function drawShape(grid: TileGrid, spec: ShapeSpec): { x: number; y: number; w: number; h: number } | null {
  const poly = spec.kind === "polygon" || spec.kind === "star" ? polygonPoints(spec) : null;
  const strokeW = spec.stroke ? Math.max(1, spec.strokeWidth ?? 1) : 0;
  // the line kind is drawn as a thick fill, so its half-width needs padding too
  const lineHalf = spec.kind === "line" ? Math.ceil((spec.strokeWidth ?? 2) / 2) : 0;
  const pad = Math.max(strokeW, lineHalf) + 2;
  const x0 = Math.max(0, Math.floor(Math.min(spec.x0, spec.x1) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(spec.y0, spec.y1) - pad));
  const x1 = Math.min(grid.width, Math.ceil(Math.max(spec.x0, spec.x1) + pad));
  const y1 = Math.min(grid.height, Math.ceil(Math.max(spec.y0, spec.y1) + pad));
  if (x1 <= x0 || y1 <= y0) return null;

  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  grid.readRect(x0, y0, w, h, out);
  const fill = spec.fill ?? [0, 0, 0];
  const stroke = spec.stroke ?? fill;
  // alphas stay normalised to 0..1 here; only the final write scales to bytes
  const fillAlpha = Math.max(0, Math.min(1, spec.fillAlpha ?? 1));
  const strokeAlpha = 1;

  let touched = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x0 + x, gy = y0 + y;
      let fillCov = 0, strokeCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = gx + (sx + 0.5) / SS;
          const py = gy + (sy + 0.5) / SS;
          // a stroke is centred on the outline, so the band wins over the fill
          if (strokeW > 0 && onOutline(spec, poly, px, py)) strokeCov++;
          else if (insideAt(spec, poly, px, py)) fillCov++;
        }
      }
      fillCov /= SS * SS;
      strokeCov /= SS * SS;
      if (fillCov === 0 && strokeCov === 0) continue;
      const maskA = spec.mask ? spec.mask.alphaAt(gx, gy) / 255 : 1;
      if (maskA <= 0) continue;
      const di = (y * w + x) * 4;
      let r = out[di]!, g = out[di + 1]!, b = out[di + 2]!, a = out[di + 3]! / 255;
      if (fillCov > 0) {
        const sa = fillCov * fillAlpha * maskA;
        const sr = fill[0], sg = fill[1], sb = fill[2];
        const dr = r, dg = g, db = b;
        const na = sa + a * (1 - sa);
        if (na > 0) {
          r = (sr * sa + dr * a * (1 - sa)) / na;
          g = (sg * sa + dg * a * (1 - sa)) / na;
          b = (sb * sa + db * a * (1 - sa)) / na;
          a = na;
        }
      }
      if (strokeCov > 0) {
        const sa = strokeCov * strokeAlpha * maskA;
        const sr = stroke[0], sg = stroke[1], sb = stroke[2];
        const dr = r, dg = g, db = b;
        const na = sa + a * (1 - sa);
        if (na > 0) {
          r = (sr * sa + dr * a * (1 - sa)) / na;
          g = (sg * sa + dg * a * (1 - sa)) / na;
          b = (sb * sa + db * a * (1 - sa)) / na;
          a = na;
        }
      }
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a * 255;
      touched = true;
    }
  }
  if (!touched) return null;
  grid.writeRect(x0, y0, w, h, out);
  return { x: x0, y: y0, w, h };
}

/** build a SelectionMask from the same geometry (path → selection) */
export function shapeSelection(
  width: number,
  height: number,
  spec: ShapeSpec,
  maskSink: { setAlpha(x: number, y: number, a: number): void },
): void {
  const poly = spec.kind === "polygon" || spec.kind === "star" ? polygonPoints(spec) : null;
  const pad = Math.max(2, (spec.strokeWidth ?? 1) + 1);
  const x0 = Math.max(0, Math.floor(Math.min(spec.x0, spec.x1) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(spec.y0, spec.y1) - pad));
  const x1 = Math.min(width, Math.ceil(Math.max(spec.x0, spec.x1) + pad));
  const y1 = Math.min(height, Math.ceil(Math.max(spec.y0, spec.y1) + pad));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (insideAt(spec, poly, x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) cov++;
        }
      }
      if (cov === 0) continue;
      maskSink.setAlpha(x, y, Math.round((cov / (SS * SS)) * 255));
    }
  }
}
