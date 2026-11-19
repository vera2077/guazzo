/**
 * path.ts — pen-tool geometry: anchors → flattened polyline.
 *
 * The pen tool collects anchor points; a selection needs a polygon, so this
 * module turns anchors into a polyline.
 *
 * Straight segments are the DEFAULT, and that is deliberate: Catmull–Rom through
 * four corners of a square bulges the edges outwards (a 30 px square rasterised
 * to ~1236 px² instead of 900). Photoshop's pen with no handle drag is a corner
 * anchor, so `smooth: false` is the honest translation; `smooth: true` is for
 * densely clicked curves (a 16-anchor circle) where interpolation runs between
 * needles and cannot overshoot much.
 *
 * Everything is in document coordinates; nothing here rasterises — the caller
 * hands the polyline to SelectionMask.selectPolygon(), which already does
 * antialiased coverage.
 */

export interface PathAnchor {
  x: number;
  y: number;
}

/** Points emitted per segment. 12 is smooth at 400 % zoom and cheap at 100 %. */
export const PATH_STEPS = 12;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Flatten a list of anchors into a polyline.
 *
 * Closed paths wrap the neighbour lookup, so the seam is as smooth as any other
 * join. Two anchors produce a straight line (there is no curve to interpolate),
 * which is what a user drawing a triangle expects.
 */
export function flattenPath(
  anchors: readonly PathAnchor[], closed: boolean, steps: number = PATH_STEPS, smooth = false,
): Array<[number, number]> {
  const n = anchors.length;
  if (n === 0) return [];
  if (n === 1) return [[anchors[0]!.x, anchors[0]!.y]];
  if (n === 2 || !smooth) return anchors.map((a) => [a.x, a.y] as [number, number]);
  const at = (i: number): PathAnchor => {
    if (closed) return anchors[((i % n) + n) % n]!;
    return anchors[Math.max(0, Math.min(n - 1, i))]!;
  };
  const segs = closed ? n : n - 1;
  const out: Array<[number, number]> = [[anchors[0]!.x, anchors[0]!.y]];
  const per = Math.max(2, Math.round(steps));
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 1; s <= per; s++) {
      const t = s / per;
      out.push([catmull(p0.x, p1.x, p2.x, p3.x, t), catmull(p0.y, p1.y, p2.y, p3.y, t)]);
    }
  }
  return out;
}

export interface PathBounds { x: number; y: number; w: number; h: number }

/** Integer bounding box of a polyline, expanded by one pixel for the AA edge. */
export function pathBounds(points: readonly (readonly [number, number])[]): PathBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x: Math.floor(minX) - 1,
    y: Math.floor(minY) - 1,
    w: Math.ceil(maxX) - Math.floor(minX) + 2,
    h: Math.ceil(maxY) - Math.floor(minY) + 2,
  };
}
