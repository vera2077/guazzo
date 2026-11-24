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

import type { PixelMask } from "./mask.ts";

export interface PathAnchor {
  x: number;
  y: number;
  /**
   * Outgoing bezier handle, RELATIVE to the anchor (Photoshop's drag gesture).
   * Zero/absent means a corner anchor. The incoming handle of the next anchor is
   * its own outgoing handle mirrored, which is how a smooth anchor behaves.
   */
  hx?: number;
  hy?: number;
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
/**
 * AI1: the drag rule for a pen anchor, as a pure function.
 *
 * A click drops a corner anchor; dragging away from it pulls its outgoing
 * handle, which is what turns the neighbouring segments into curves. The
 * threshold matters: a couple of pixels of hand wobble during a click must not
 * silently smooth an anchor the user meant to be sharp.
 */
export const PEN_DRAG_MIN = 3;

export function penHandleFor(a: PathAnchor, dx: number, dy: number): PathAnchor {
  const had = a.hx !== undefined || a.hy !== undefined;
  if (Math.hypot(dx, dy) <= PEN_DRAG_MIN) {
    // AP3: under the wobble threshold a SHAKY CLICK must not create a handle —
    // but dragging an existing handle back to its anchor must retract it.
    // Returning `a` unchanged kept the old long handle forever.
    return had ? { x: a.x, y: a.y } : a;
  }
  return { ...a, hx: dx, hy: dy };
}

export function flattenPath(
  anchors: readonly PathAnchor[], closed: boolean, steps: number = PATH_STEPS, smooth = false,
): Array<[number, number]> {
  const n = anchors.length;
  if (n === 0) return [];
  if (n === 1) return [[anchors[0]!.x, anchors[0]!.y]];
  // A dragged handle is an explicit instruction: honour it over the smoothing
  // heuristic, and treat untouched anchors as the straight corners they are.
  if (anchors.some((a) => a.hx || a.hy)) return flattenHandles(anchors, closed, steps);
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


/**
 * Cubic-bezier flattening for handle anchors. Each segment runs from anchor i to
 * i+1 with control points `i + out` and `(i+1) - out`, so dragging the handle out
 * of an anchor curves BOTH neighbouring segments — the behaviour a pen user
 * expects from a smooth point.
 */
function flattenHandles(
  anchors: readonly PathAnchor[], closed: boolean, steps: number,
): Array<[number, number]> {
  const n = anchors.length;
  const segs = closed ? n : n - 1;
  const per = Math.max(2, Math.round(steps));
  const out: Array<[number, number]> = [[anchors[0]!.x, anchors[0]!.y]];
  for (let i = 0; i < segs; i++) {
    const a = anchors[closed ? i % n : i]!;
    const b = anchors[closed ? (i + 1) % n : i + 1];
    if (!b) break;
    const ax = a.x, ay = a.y, bx = b.x, by = b.y;
    const ahx = a.hx ?? 0, ahy = a.hy ?? 0;
    const bhx = b.hx ?? 0, bhy = b.hy ?? 0;
    const c1x = ax + ahx, c1y = ay + ahy;
    const c2x = bx - bhx, c2y = by - bhy;
    for (let s = 1; s <= per; s++) {
      const t = s / per;
      const u = 1 - t;
      out.push([
        u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx,
        u * u * u * ay + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by,
      ]);
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


// --- Additive anchor-editing / selection→path API ---------------------------
// Everything above (and its behaviour) is preserved verbatim; only new
// exports are appended below.

/**
 * Edit one anchor without mutating the caller's array or its anchor objects.
 *
 * - `delete`: remove the anchor at `index`.
 * - `corner`: clear its outgoing handle (it becomes a sharp, straight corner).
 * - `smooth`: rebuild a symmetric, neighbour-derived tangent — 1/6 of the
 *   prev→next vector, the Catmull–Rom → Bézier handle for a smooth join.
 *
 * When `dx`/`dy` are supplied the edited anchor alone is moved by that delta;
 * "move" does that without rewriting handles, while "corner"/"smooth" also
 * restyle it. Its neighbours are never touched. An out-of-range (or non-integer) index
 * returns a copy unchanged. The return value is always a fresh array.
 */
export function editAnchor(
  anchors: readonly PathAnchor[],
  index: number,
  op: "delete" | "corner" | "smooth" | "move",
  dx = 0,
  dy = 0,
): PathAnchor[] {
  const out: PathAnchor[] = anchors.map((a) => ({ ...a }));
  if (!Number.isInteger(index) || index < 0 || index >= out.length) return out;

  if (op === "delete") {
    out.splice(index, 1);
    return out;
  }

  const a = out[index]!;
  if (op === "corner") {
    delete a.hx;
    delete a.hy;
  } else if (op === "smooth") {
    const n = out.length;
    if (n >= 3) {
      const prev = out[(index - 1 + n) % n]!;
      const next = out[(index + 1) % n]!;
      a.hx = (next.x - prev.x) / 6;
      a.hy = (next.y - prev.y) / 6;
    } else {
      // Fewer than three anchors has no meaningful neighbour tangent.
      delete a.hx;
      delete a.hy;
    }
  }

  a.x += dx;
  a.y += dy;
  return out;
}

type TracePt = [number, number];

/**
 * Trace the outer contour of a binary selection (alphaAt >= tolerance, default
 * 128) into a deterministic, closed, clockwise polygon of corner anchors.
 *
 * Boundary-following emits directed unit edges with the filled region kept on
 * the right (clockwise in document / y-down coordinates); the loop is walked
 * from the topmost-then-leftmost vertex and collinear runs are collapsed, so a
 * rectangle yields exactly four corners. This is deliberately simple: no
 * Bézier fitting, no antialiased contour interpolation, and no interior holes.
 * An empty mask returns []. A fully-covered mask has no interior contour,
 * so it traces the document border inset by half a pixel.
 */
export function selectionToPath(
  mask: PixelMask,
  w: number,
  h: number,
  tolerance = 128,
): PathAnchor[] {
  const on = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask.alphaAt(x, y) >= tolerance;

  // Directed boundary edges: filled region on the RIGHT ⇒ clockwise loop.
  const outgoing = new Map<string, TracePt[]>();
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const key = `${ax},${ay}`;
    const list = outgoing.get(key);
    if (list) list.push([bx, by]);
    else outgoing.set(key, [[bx, by]]);
  };

  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      filled++;
      if (!on(x, y - 1)) add(x, y, x + 1, y);           // top:    →
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);   // right:  ↓
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);   // bottom: ←
      if (!on(x - 1, y)) add(x, y + 1, x, y);           // left:   ↑
    }
  }
  // An empty mask has no contour. A fully-covered mask would otherwise emit
  // edges only along the document border, so synthesize that inset rectangle.
  if (filled === 0 || outgoing.size === 0) return [];
  if (filled === w * h) {
    if (w < 2 || h < 2) return [];
    return [
      { x: 0.5, y: 0.5 },
      { x: w - 0.5, y: 0.5 },
      { x: w - 0.5, y: h - 0.5 },
      { x: 0.5, y: h - 0.5 },
    ];
  }

  // Deterministic start vertex: smallest y, then smallest x.
  let startKey = "";
  let startX = 0, startY = 0;
  for (const key of outgoing.keys()) {
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (!startKey || y < startY || (y === startY && x < startX)) {
      startKey = key;
      startX = x;
      startY = y;
    }
  }

  // right=0, down=1, left=2, up=3 (clockwise turn order in y-down coords).
  const dirOf = (dx: number, dy: number): number => {
    if (dx > 0) return 0;
    if (dy > 0) return 1;
    if (dx < 0) return 2;
    return 3;
  };

  const loop: TracePt[] = [[startX, startY]];
  let cx = startX, cy = startY;
  let inDir = -1; // no incoming direction at the start vertex
  // A closed orthogonal polygon has at most 4*w*h unit boundary steps.
  for (let guard = 0; guard <= 4 * w * h + 4; guard++) {
    const list = outgoing.get(`${cx},${cy}`);
    if (!list || list.length === 0) break;
    let pick = 0;
    if (inDir >= 0) {
      // Prefer the sharpest right turn, then straight, then left — this keeps
      // the filled region on the right and follows the OUTER boundary.
      const order = [(inDir + 1) % 4, inDir, (inDir + 3) % 4, (inDir + 2) % 4];
      search:
      for (const d of order) {
        for (let i = 0; i < list.length; i++) {
          const edge = list[i]!;
          if (dirOf(edge[0] - cx, edge[1] - cy) === d) { pick = i; break search; }
        }
      }
    }
    const [nx, ny] = list.splice(pick, 1)[0]!;
    inDir = dirOf(nx - cx, ny - cy);
    cx = nx;
    cy = ny;
    loop.push([cx, cy]);
    if (cx === startX && cy === startY) break;
  }

  // Drop the closing duplicate and keep only true corners (direction changes).
  if (loop.length > 1) {
    const last = loop[loop.length - 1]!;
    if (last[0] === loop[0]![0] && last[1] === loop[0]![1]) loop.pop();
  }
  const n = loop.length;
  if (n < 3) return [];

  const corners: TracePt[] = [];
  for (let i = 0; i < n; i++) {
    const p = loop[i]!;
    const prev = loop[(i - 1 + n) % n]!;
    const next = loop[(i + 1) % n]!;
    if (p[0] - prev[0] !== next[0] - p[0] || p[1] - prev[1] !== next[1] - p[1]) {
      corners.push(p);
    }
  }
  return corners.map(([x, y]) => ({ x, y }));
}
